/**
 * The `coolify-mcp` CLI: install, doctor, uninstall, connections, check.
 *
 * A separate binary from `src/index.ts`, which is the stdio MCP server. That
 * one may write nothing but JSON-RPC to stdout; this one is an ordinary
 * terminal program, so here stdout carries the command's product (report, diff,
 * JSON) and stderr carries prompts and diagnostics. Keeping the two apart is
 * what lets `coolify-mcp doctor --json | jq` work while a confirmation prompt is
 * still visible to the human.
 *
 * Argument parsing is `node:util` `parseArgs` and nothing else. A CLI framework
 * would be a runtime dependency on the critical path of `npx coolify-mcp`, where
 * cold start is a user-visible property, in exchange for flags we can declare in
 * twenty lines.
 *
 * No shebang here — tsup prepends one, and a second `#!` on line 2 of the bundle
 * is a syntax error rather than a comment.
 *
 * INTEGRATION NOTE: `./install/apply.js` is the one import whose shape is not
 * yet fixed in the tree. This file expects `applyPlan(plan, options)` to return
 * per-target before/after content so that the same call produces the `--dry-run`
 * preview and the real write, distinguished only by `dryRun`.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import { resolveRegistry } from './config/resolve.js';
import { ConfigError } from './config/schema.js';
import { coolifyRequest } from './http/client.js';
import { redact } from './shaping/redact.js';
import {
  doctorExitCode,
  formatConnectionReports,
  formatDoctorReport,
  reportConnections,
  runDoctor,
} from './install/doctor.js';
import { planInstall, planUninstall, type Plan, type PlanOptions } from './install/plan.js';
import { applyPlan, type ApplyOptions, type ApplyResult } from './install/apply.js';
import { knownTargets } from './install/registry.js';
import { CoolifyError } from './types.js';
import type { Connection, InstallCtx, Operation, ValidationIssue } from './types.js';

const PROGRAM = 'coolify-mcp';

/** 0 success · 1 failure or warnings · 2 doctor found a credential at rest. */
const EXIT_OK = 0;
const EXIT_PROBLEM = 1;

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const USAGE = `${PROGRAM} — fleet-level MCP server for Coolify

USAGE
  ${PROGRAM} <command> [options]

COMMANDS
  install       write a coolify entry into one or more MCP client configs
  doctor        read-only health check: connections, client configs, credentials at rest
  uninstall     remove the entries this CLI wrote
  connections   list resolved connections and where each token comes from
  check         live probe: GET /api/health, then /api/v1/teams/current

  ${PROGRAM} <command> --help    per-command options
  ${PROGRAM} --version`;

const INSTALL_HELP = `${PROGRAM} install — write a coolify entry into MCP client configs

  The installer writes POINTERS only: a command, its arguments, and at most a
  connection NAME. It never writes a credential into a client config, so the
  worst outcome of a bug here is a broken MCP entry rather than a leaked token.

OPTIONS
  --client a,b           target these clients (repeatable). Default: every detected client.
  --all-detected         target every detected client; the explicit form of the default.
  --scope user|project   user config or repo-local config. Default: both, filtered by detection.
  --connection NAME      bake COOLIFY_CONNECTION=NAME into the entry.
  --pin[=VERSION]        pin an exact version. See VERSION PINNING.
  --transport stdio|http default stdio. Never written to Codex — see TRANSPORT.
  --no-native-cli        always write files; never shell out to a client's own CLI.
  --update               overwrite an existing coolify entry instead of leaving it alone.
  --dry-run              print a unified diff of every file that would change; write nothing.
  --print                print the snippet to paste by hand; write nothing.
  --yes                  do not ask for confirmation.
  --json                 machine-readable result on stdout.

VERSION PINNING
  Without --pin the entry reads coolify-mcp@latest, so every client spawn
  resolves the newest published version and may execute code that did not exist
  when you installed it. Convenient for one developer; unacceptable under most
  software supply-chain policies.

    --pin           pin the version you are running now
    --pin=1.4.2     pin an exact version

  A pinned install upgrades only when you run install again.

TRANSPORT
  stdio is the default and the only transport ever written to Codex. Older Codex
  versions drop the WHOLE config.toml — every other MCP server in it included —
  when they meet an unknown \`url\` key, and stdio parses in every version.`;

const DOCTOR_HELP = `${PROGRAM} doctor — read-only health check

  Reports the runtime, every connection and its token source, every client
  adapter, and then the findings. Nothing is written unless --fix is passed.

OPTIONS
  --all-servers   also attribute MCP entries coolify-mcp does not manage.
  --fix           conservative repair; see below.
  --json          machine-readable report on stdout.

EXIT CODES
  0  clean
  1  warnings
  2  a credential was found at rest
  Suitable for a fleet-wide CI job: \`${PROGRAM} doctor --json\`.

--fix IS CONSERVATIVE BY DESIGN
  It rewrites a literal secret to \${VAR} only when $VAR is already exported with
  exactly that value and the client is known to expand the reference. It never
  invents a variable, never prints a secret to stdout, and never substitutes for
  rotating a token: a credential that has sat in plaintext should be considered
  burned no matter what happens to the file afterwards.`;

const UNINSTALL_HELP = `${PROGRAM} uninstall — remove the entries this CLI wrote

OPTIONS
  --client a,b   remove from these clients (repeatable).
  --all          consider every known client, not just the ones detected here.
  --scope user|project
  --force        remove even when the entry no longer matches what we wrote.
  --dry-run      print the diff; write nothing.
  --yes          do not ask for confirmation.
  --json         machine-readable result on stdout.

  Without --force an entry that has been hand-edited since installation is left
  alone and reported. Deleting someone's customised entry is not an uninstall.`;

const CONNECTIONS_HELP = `${PROGRAM} connections — list resolved connections

  Prints each connection, its base URL, where its token comes from, and whether
  that source actually resolves. Resolving may prompt (Touch ID, a vault
  unlock); that is the point — "the variable is set" and "the credential comes
  back" are different questions.

  No token, and no part of one, is ever printed.

OPTIONS
  --json   machine-readable output on stdout.`;

const CHECK_HELP = `${PROGRAM} check — live probe against a Coolify instance

  Two requests, in this order:
    1. GET /api/health            unauthenticated — is the instance reachable at all?
    2. GET /api/v1/teams/current  authenticated — does this token work, and for which team?

  Split on purpose. A failure at step 1 is a URL, DNS or TLS problem; a failure
  at step 2 is a token problem. Collapsing them produces the "it doesn't work"
  bug report that costs an hour.

OPTIONS
  --connection NAME   probe one connection. Default: all of them.
  --json              machine-readable output on stdout.`;

const HELP: Record<string, string> = {
  install: INSTALL_HELP,
  doctor: DOCTOR_HELP,
  uninstall: UNINSTALL_HELP,
  connections: CONNECTIONS_HELP,
  check: CHECK_HELP,
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type OptionValues = Record<string, string | boolean | string[] | undefined>;

interface OptionSpec {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
}

const COMMON_OPTIONS: Record<string, OptionSpec> = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
};

const COMMAND_OPTIONS: Record<string, Record<string, OptionSpec>> = {
  install: {
    ...COMMON_OPTIONS,
    client: { type: 'string', multiple: true },
    scope: { type: 'string' },
    connection: { type: 'string' },
    pin: { type: 'string' },
    transport: { type: 'string' },
    'dry-run': { type: 'boolean' },
    print: { type: 'boolean' },
    'all-detected': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    'no-native-cli': { type: 'boolean' },
    update: { type: 'boolean' },
  },
  doctor: { ...COMMON_OPTIONS, 'all-servers': { type: 'boolean' }, fix: { type: 'boolean' } },
  uninstall: {
    ...COMMON_OPTIONS,
    client: { type: 'string', multiple: true },
    scope: { type: 'string' },
    all: { type: 'boolean' },
    force: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  },
  connections: { ...COMMON_OPTIONS },
  check: { ...COMMON_OPTIONS, connection: { type: 'string' } },
};

/**
 * `parseArgs` has no notion of an optional value: a string option consumes the
 * next token whatever it looks like, so `--pin --dry-run` would pin the version
 * to "--dry-run". Rewriting a bare `--pin` to `--pin=` before parsing preserves
 * the documented `--pin[=version]` surface without hand-rolling a parser.
 */
function normalizeBareValueFlags(argv: string[]): string[] {
  const out: string[] = [];
  let passthrough = false;
  for (const token of argv) {
    if (token === '--') passthrough = true;
    out.push(!passthrough && token === '--pin' ? '--pin=' : token);
  }
  return out;
}

function flag(values: OptionValues, name: string): boolean {
  return values[name] === true;
}

function text(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

/** `--client a,b --client c` and `--client a --client b --client c` mean the same thing. */
function list(values: OptionValues, name: string): string[] {
  const value = values[name];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function choice<T extends string>(values: OptionValues, name: string, allowed: readonly T[]): T | undefined {
  const raw = text(values, name);
  if (raw === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new UsageError(`--${name} must be one of ${allowed.join(', ')} (got "${raw}").`);
  }
  return match;
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_PROBLEM;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    const topic = rest[0];
    process.stdout.write(`${(topic !== undefined ? HELP[topic] : undefined) ?? USAGE}\n`);
    return EXIT_OK;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT_OK;
  }

  const options = COMMAND_OPTIONS[command];
  if (options === undefined) {
    throw new UsageError(`unknown command "${command}". Run \`${PROGRAM} help\`.`);
  }

  const parsed = parseArgs({
    args: normalizeBareValueFlags(rest),
    options,
    allowPositionals: false,
    strict: true,
  });
  const values = parsed.values as OptionValues;

  if (flag(values, 'help')) {
    process.stdout.write(`${HELP[command] ?? USAGE}\n`);
    return EXIT_OK;
  }

  switch (command) {
    case 'install':
      return commandInstall(values);
    case 'doctor':
      return commandDoctor(values);
    case 'uninstall':
      return commandUninstall(values);
    case 'connections':
      return commandConnections(values);
    case 'check':
      return commandCheck(values);
    default:
      throw new UsageError(`unknown command "${command}".`);
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function commandDoctor(values: OptionValues): Promise<number> {
  const report = await runDoctor({
    allServers: flag(values, 'all-servers'),
    fix: flag(values, 'fix'),
    packageVersion: packageVersion(),
  });

  if (flag(values, 'json')) emitJson(report);
  else process.stdout.write(`${formatDoctorReport(report)}\n`);

  return doctorExitCode(report);
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

async function commandConnections(values: OptionValues): Promise<number> {
  const result = await reportConnections();

  if (flag(values, 'json')) {
    emitJson({
      source: result.registry?.source,
      configPath: result.registry?.configPath,
      defaultConnection: result.registry?.defaultName,
      connections: result.connections,
      findings: result.findings,
    });
  } else {
    const lines = formatConnectionReports(
      result.connections,
      result.registry?.source,
      result.registry?.configPath,
    );
    if (result.registry?.defaultName !== undefined) {
      lines.push(`  default connection: ${result.registry.defaultName}`);
    } else if (result.connections.length > 1) {
      // Not a defect: with several connections and none designated, the tool
      // layer demands an explicit `instance` rather than guessing which Coolify
      // a deploy was meant for. Worth saying out loud so it is not a surprise.
      lines.push('  default: none — every write tool will require an explicit instance');
    }
    process.stdout.write(`${redact(lines.join('\n'))}\n`);
  }

  const unresolved = result.connections.filter((connection) => !connection.resolved);
  return unresolved.length > 0 || result.connections.length === 0 ? EXIT_PROBLEM : EXIT_OK;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

interface ProbeResult {
  connection: string;
  baseUrl: string;
  health: ProbeOutcome;
  identity: ProbeOutcome;
}

async function commandCheck(values: OptionValues): Promise<number> {
  const registry = await resolveRegistry(process.env, process.cwd(), homedir());
  const requested = text(values, 'connection');

  let targets = [...registry.connections.values()];
  if (requested !== undefined) {
    // Names are slugs, but the matching env var is COOLIFY_BASE_URL_PROD, so
    // `--connection PROD` is the predictable mistake. `config/resolve.ts` accepts
    // it for $COOLIFY_CONNECTION; refusing it here would be an inconsistency the
    // user has no way to predict.
    const found = registry.connections.get(requested) ?? registry.connections.get(requested.toLowerCase());
    if (found === undefined) {
      throw new UsageError(
        `no connection named "${requested}". Configured: ${[...registry.connections.keys()].join(', ')}.`,
      );
    }
    targets = [found];
  }

  const results: ProbeResult[] = [];
  for (const connection of targets) results.push(await probe(connection));

  if (flag(values, 'json')) emitJson(results);
  else process.stdout.write(`${redact(formatProbes(results))}\n`);

  return results.every((result) => result.health.ok && result.identity.ok) ? EXIT_OK : EXIT_PROBLEM;
}

async function probe(connection: Connection): Promise<ProbeResult> {
  const health = await probeHealth(connection);
  // The identity probe runs even when health failed: the two can disagree (a
  // proxy that blocks /api/health but passes /api/v1 through), and a report that
  // stops at the first failure hides exactly that case.
  const identity = await probeIdentity(connection);
  return { connection: connection.name, baseUrl: connection.baseUrl, health, identity };
}

/**
 * Unauthenticated on purpose. `/api/health` needs no token, so a failure here
 * cannot be a credential problem — which is the whole reason the probe has two
 * steps instead of one.
 */
async function probeHealth(connection: Connection): Promise<ProbeOutcome> {
  try {
    const response = await fetch(healthUrl(connection.baseUrl), {
      // Never followed. A redirect is a finding, not a detail to paper over, and
      // this is the same rule the transport enforces for authenticated calls.
      redirect: 'manual',
      signal: AbortSignal.timeout(connection.timeoutMs),
      headers: { accept: 'text/plain,application/json', 'user-agent': PROGRAM },
    });
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get('location') ?? 'an unnamed target';
      return {
        ok: false,
        detail: `HTTP ${response.status} redirect to ${target} — point baseUrl at the final origin`,
      };
    }
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error: unknown) {
    return { ok: false, detail: probeFailure(error, connection.timeoutMs) };
  }
}

/**
 * Node's fetch reports every transport failure as the string "fetch failed" and
 * hides the real reason — the DNS or TLS error — on `cause`. Unwrapping it is
 * the difference between a probe that says something and one that does not.
 */
function probeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `no response within ${timeoutMs} ms`;
  }
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  return cause instanceof Error ? cause.message : errorText(error);
}

function healthUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  // Users write the base URL by hand and half of them paste in the `/api/v1`
  // the docs curl into. Health lives at the instance root either way.
  const root = url.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
  return new URL(`${url.origin}${root}/api/health`);
}

async function probeIdentity(connection: Connection): Promise<ProbeOutcome> {
  try {
    const response = await coolifyRequest<Record<string, unknown>>({
      connection,
      method: 'GET',
      path: '/teams/current',
    });
    const team = response.data ?? {};
    const name = typeof team['name'] === 'string' ? team['name'] : undefined;
    const id = team['id'];
    const label = name === undefined ? '(unnamed)' : `"${name}"`;
    return { ok: true, detail: `team ${label}${id === undefined ? '' : ` (id ${String(id)})`}` };
  } catch (error: unknown) {
    const hint = error instanceof CoolifyError && error.hint !== undefined ? ` — ${error.hint}` : '';
    return { ok: false, detail: `${errorText(error)}${hint}` };
  }
}

function formatProbes(results: ProbeResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.connection}  ${result.baseUrl}`);
    lines.push(`  health    ${result.health.ok ? 'ok  ' : 'FAIL'}  ${result.health.detail}`);
    lines.push(`  identity  ${result.identity.ok ? 'ok  ' : 'FAIL'}  ${result.identity.detail}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

async function commandInstall(values: OptionValues): Promise<number> {
  const plan = await planInstall(planOptions(values, buildCtx(values)));

  if (flag(values, 'print')) {
    process.stdout.write(`${renderSnippets(plan)}\n`);
    return planIssueExit(plan);
  }
  return runPlan(plan, values);
}

async function commandUninstall(values: OptionValues): Promise<number> {
  return runPlan(await planUninstall(planOptions(values, buildCtx(values))), values);
}

function planOptions(values: OptionValues, ctx: InstallCtx): PlanOptions {
  const options: PlanOptions = { ctx };

  // `--all` widens uninstall from "clients detected here" to "every client we
  // know about". Expressed as an explicit target list because a named selection
  // is what turns off the planner's detection filter — an uninstall must reach a
  // config file belonging to an editor that is no longer installed.
  const clients = flag(values, 'all') ? knownTargets() : list(values, 'client');
  if (clients.length > 0) options.clients = clients;

  const scope = choice(values, 'scope', ['user', 'project'] as const);
  if (scope !== undefined) options.scope = scope;
  return options;
}

function buildCtx(values: OptionValues): InstallCtx {
  const ctx: InstallCtx = {
    homeDir: homedir(),
    projectRoot: process.cwd(),
    platform: process.platform,
    packageSpec: packageSpec(values),
    transport: choice(values, 'transport', ['stdio', 'http'] as const) ?? 'stdio',
  };
  const connection = text(values, 'connection');
  if (connection !== undefined) ctx.connection = connection;
  return ctx;
}

/**
 * `coolify-mcp@latest` unless the user pinned. The install help explains why the
 * default is the loose one and why an organisation should not keep it.
 */
function packageSpec(values: OptionValues): string {
  const pin = text(values, 'pin');
  if (pin === undefined) return `${PROGRAM}@latest`;
  return `${PROGRAM}@${pin === '' ? packageVersion() : pin}`;
}

/**
 * The shared tail of install and uninstall: preview, consent, write.
 *
 * The preview comes from the very call that would do the writing, with `dryRun`
 * flipped — so the diff a user approves is produced by the same code path that
 * then runs, not by a parallel "preview" implementation that can drift from it.
 *
 * Consent is required rather than assumed because these commands edit files the
 * user did not open, files that hold every other MCP server on the machine. With
 * no terminal attached there is nobody to ask, so the command refuses instead of
 * deciding on the user's behalf; `--yes` is how a script says otherwise.
 */
async function runPlan(plan: Plan, values: OptionValues): Promise<number> {
  const json = flag(values, 'json');
  const dryRun = flag(values, 'dry-run');
  const options: ApplyOptions = {
    force: flag(values, 'force'),
    update: flag(values, 'update'),
    // A client's own CLI preserves invariants we do not know about, so it is
    // preferred and `--no-native-cli` is the opt-out. apply() defaults the other
    // way because it has no user in front of it; the choice belongs here.
    allowExec: !flag(values, 'no-native-cli'),
  };

  const preview = await applyPlan(plan, { ...options, dryRun: true });
  const diff = renderDiff(preview);

  if (dryRun) {
    if (json) emitJson(preview);
    else process.stdout.write(`${diff === '' ? summarize(preview, plan) : diff}\n`);
    return applyExitCode(preview, plan);
  }

  // Nothing to approve. Report what the preview found — "blocked" and
  // "unchanged" are both answers the user needs — and stop.
  if (diff === '') {
    if (json) emitJson(preview);
    else process.stdout.write(`${summarize(preview, plan)}\n`);
    return applyExitCode(preview, plan);
  }

  if (!json) process.stdout.write(`${diff}\n`);
  if (!flag(values, 'yes') && !(await confirm(`Apply this ${plan.action}?`))) {
    process.stderr.write(`${PROGRAM}: nothing was written.\n`);
    return EXIT_PROBLEM;
  }

  const applied = await applyPlan(plan, options);
  if (json) emitJson(applied);
  else process.stdout.write(`${summarize(applied, plan)}\n`);
  return applyExitCode(applied, plan);
}

/**
 * `ApplyFile.diff` is already redacted and is the only diff rendered anywhere;
 * `ApplyFile.after` holds the exact bytes and is deliberately never displayed.
 */
function renderDiff(result: ApplyResult): string {
  return result.targets
    .flatMap((target) => target.files.map((file) => file.diff))
    .filter((chunk) => chunk.trim() !== '')
    .join('\n');
}

function summarize(result: ApplyResult, plan: Plan): string {
  const lines = result.targets.map((target) => {
    const commands = target.commands.length === 0 ? '' : `  via ${target.commands[0]?.[0] ?? 'cli'}`;
    return `  ${target.adapterId.padEnd(22)} ${target.status.padEnd(10)}${target.path}${commands}`;
  });
  const issues = [...plan.issues, ...result.issues, ...result.targets.flatMap((t) => t.issues)];
  const body = [...lines, ...formatIssues(issues)];
  return redact(body.length === 0 ? 'nothing to do.' : body.join('\n'));
}

function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.flatMap((issue) => {
    const head = `  [${issue.severity}] ${issue.code}: ${issue.message}`;
    return issue.fix === undefined ? [head] : [head, `      ${issue.fix}`];
  });
}

/**
 * `blocked` counts as a failure even though nothing broke: the user asked for an
 * install that did not happen, and a script that treats that as success will
 * ship a machine with no MCP entry on it.
 */
function applyExitCode(result: ApplyResult, plan: Plan): number {
  const stopped = result.targets.some(
    (target) => target.status === 'failed' || target.status === 'blocked',
  );
  const errors = [...plan.issues, ...result.issues].some((issue) => issue.severity === 'error');
  return stopped || errors ? EXIT_PROBLEM : EXIT_OK;
}

function planIssueExit(plan: Plan): number {
  return plan.issues.some((issue) => issue.severity === 'error') ? EXIT_PROBLEM : EXIT_OK;
}

// ---------------------------------------------------------------------------
// --print
// ---------------------------------------------------------------------------

/**
 * Renders the snippet to paste by hand, straight out of the same pure
 * `planWrite` operations `apply` would have executed.
 *
 * Deriving it from the plan rather than from a second hand-written template is
 * what keeps `--print` honest. A printed snippet that has drifted from what the
 * writer does is worse than no snippet at all: the user follows it and then
 * files a bug against the writer.
 *
 * Not `applyPlan({ print: true })`, whose preview is the whole resulting file:
 * a blocked target produces no file at all, and a blocked target — an
 * unverified adapter we refuse to write to — is precisely who `--print` is for.
 */
function renderSnippets(plan: Plan): string {
  const blocks: string[] = [];
  for (const target of plan.targets) {
    const body = target.operations
      .map(renderOperation)
      .filter((part): part is string => part !== undefined);
    if (body.length === 0) continue;
    blocks.push(`# ${target.adapter.label}\n# ${target.path}\n${body.join('\n')}`);
  }
  const issues = formatIssues(plan.issues);
  if (blocks.length === 0 && issues.length === 0) return 'nothing to print.';
  return redact([...blocks, ...issues].join('\n\n'));
}

function renderOperation(operation: Operation): string | undefined {
  switch (operation.kind) {
    case 'json-merge':
    case 'jsonc-merge':
      return JSON.stringify(nest(operation.keyPath, operation.value), null, 2);
    case 'yaml-merge':
      return stringifyYaml(nest(operation.keyPath, operation.value)).trimEnd();
    case 'toml-append':
    case 'toml-replace':
      return operation.text.trimEnd();
    case 'note':
      return `# ${operation.message}`;
    default:
      // Removals, mkdir and exec describe how a file gets edited, not anything a
      // user would type. Skipped rather than rendered as noise.
      return undefined;
  }
}

function nest(keyPath: readonly string[], value: unknown): unknown {
  return keyPath.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/**
 * Confirmation is read from the terminal and written to stderr, so a piped
 * stdout stays machine-readable while the prompt stays visible to the human.
 */
async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      `${PROGRAM}: stdin is not a terminal, so there is nobody to confirm with. Re-run with --yes, or --dry-run to preview.\n`,
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Serialise, then redact the serialised text — in that order on purpose.
 * Redacting the object first would have to walk every value and would still miss
 * a token spliced into the middle of a message string. `redact` also strips
 * anything with the Sanctum shape, so a token this process never resolved (one
 * found sitting in a client config) cannot ride out on a JSON report either.
 */
function emitJson(value: unknown): void {
  process.stdout.write(`${redact(JSON.stringify(value, null, 2))}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The published version, read from the package manifest at runtime rather than
 * inlined at build time so `--version` cannot disagree with what npm installed.
 * Resolves identically from `dist/cli.js` and from `src/cli.ts` under tsx.
 */
function packageVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------

function fail(error: unknown): number {
  if (error instanceof UsageError) {
    process.stderr.write(`${PROGRAM}: ${error.message}\n`);
    return EXIT_PROBLEM;
  }
  if (error instanceof ConfigError) {
    // Written for a human at a terminal: these name the variables to set and
    // every path that was searched. Printed verbatim.
    process.stderr.write(`${redact(error.message)}\n`);
    return EXIT_PROBLEM;
  }
  process.stderr.write(`${PROGRAM}: ${redact(errorText(error))}\n`);
  return EXIT_PROBLEM;
}

// `process.exitCode` rather than `process.exit`, so buffered stdout is flushed
// before the process goes away — a truncated report is the one output a
// diagnostic tool must never produce.
main(process.argv.slice(2))
  .catch(fail)
  .then((code) => {
    process.exitCode = code;
  });
