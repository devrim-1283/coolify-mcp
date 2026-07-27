/**
 * `doctor` — read-only inspection of everything between a Coolify instance and
 * an MCP client.
 *
 * This is the strongest single reason the CLI exists. Installing an MCP server
 * is a one-line JSON merge that a determined user will do by hand; finding out
 * *why* it does not work — or that a live API token has been sitting in
 * plaintext in `~/.claude.json` since the day it was pasted there — is not.
 *
 * Three properties hold everywhere in this file:
 *
 *  1. **Nothing is written.** `runDoctor` performs no mutation at all unless
 *     `fix` is set, and even then only through the narrow path described at
 *     {@link planFixes}.
 *  2. **No secret is ever emitted.** Findings record *locations*, never values —
 *     not the value, not a prefix, not a length. Everything that leaves this
 *     module additionally passes through `redact()`, which strips both the
 *     tokens this process resolved and anything with the Sanctum shape. A
 *     doctor report is the single most-pasted artefact in any bug report.
 *  3. **We say what we did not check.** Windows ACLs are not inspected, so
 *     Windows gets an honest `acl-not-checked` note rather than a silent pass.
 *
 * `--fix` writes through the same `merge/` writers the installer uses, not
 * through `apply.ts`: a fix is one key in one file, and going via the install
 * plan would drag a whole `ServerEntry` through a code path that is meant to
 * change nothing but a single literal.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_CONNECTION_NAME,
  parseConfigFile,
  readEnvValue,
  tokenEnvVar,
  type ConfigFile,
} from '../config/schema.js';
import { resolveRegistry } from '../config/resolve.js';
import { redact } from '../shaping/redact.js';
import type {
  Connection,
  ConnectionRegistry,
  Detection,
  InstallCtx,
  McpClientAdapter,
  ValidationIssue,
} from '../types.js';
import { ADAPTERS } from './adapters/index.js';
import type { MergeResult } from './merge/json.js';
import { mergeJsonc } from './merge/jsonc.js';
import { mergeYaml } from './merge/yaml.js';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

/**
 * A Coolify API token is a Laravel Sanctum token: `<numeric id>|<secret>`.
 *
 * The secret is at LEAST 40 base62 characters — do not pin it to exactly 40.
 * Sanctum's own default is 40, but Coolify generates longer ones: a token from
 * a live 4.1.2 instance carries a 48-character secret. An exact `{40}` quantifier
 * with a trailing `\b` fails to match those entirely, because the boundary never
 * lands after the 40th character when more alphanumerics follow — so the scanner
 * would silently miss the very credentials it exists to find. This detector is the
 * main reason the installer CLI is worth shipping; a false negative here is the
 * worst possible failure, and being open-ended costs nothing in precision.
 *
 * The shape is still specific enough to assert on. Forty-plus base62 characters
 * behind a pipe behind an integer does not occur in a configuration file by
 * accident, so a hit is reported as CRITICAL with no hedging — a "possible
 * credential" warning is one people learn to scroll past, and this must not be.
 */
const SANCTUM_TOKEN = /\b\d+\|[A-Za-z0-9]{40,}\b/;
const SANCTUM_TOKEN_GLOBAL = /\b\d+\|[A-Za-z0-9]{40,}\b/g;

const BEARER_HEADER = /^Bearer\s+(\S+)/i;
const SECRET_KEY_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;

/** `${VAR}`, `${env:VAR}`, `${VAR:-default}` — every reference form our clients accept. */
const ENV_REFERENCE = /\$\{[^}]+\}/;

/**
 * Values that are obviously a template rather than a credential. Kept narrow on
 * purpose: a scanner that guesses at placeholders starts excusing real secrets.
 * `YOUR_..._HERE` is the form our docs and every upstream example use, and
 * `<...>` is the other universal convention.
 */
const PLACEHOLDER = /^(YOUR[_A-Z0-9]*HERE|<[^>]*>)$/i;

/**
 * Keys whose child objects are MCP server entries. Every supported client uses
 * one of these, and the fact that they differ at all is why a single config
 * writer is impossible.
 */
const SERVER_CONTAINER_KEYS = new Set([
  'mcpServers', // Claude Code, Claude Desktop, Cursor, Kimi
  'mcp_servers', // Codex (TOML)
  'context_servers', // Zed
  'mcp', // OpenCode
]);

/** Object keys whose children are environment variables, across the client formats. */
const ENV_CONTAINER_KEYS = new Set(['env', 'environment']);

/**
 * Clients whose expansion of `${VAR}` in a config value is verified against
 * upstream documentation. `--fix` writes a reference only for these: a config
 * that references a variable the client never expands fails at spawn time, in a
 * place the user cannot see, which is strictly worse than the literal it
 * replaced. Kimi and Claude Desktop are pending verification, not excluded.
 */
const EXPANDS_ENV_REFERENCES = new Set(['claude-code', 'cursor']);

/** Guards against a pathological config blowing the stack. Real configs are ~4 deep. */
const MAX_WALK_DEPTH = 64;

/** POSIX permission bits that let someone other than the owner read the file. */
const GROUP_AND_OTHER_BITS = 0o077;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/**
 * Doctor's own severity ladder, deliberately one rung taller than
 * `ValidationIssue['severity']`.
 *
 * `critical` exists so that a credential at rest can drive exit code 2 and be
 * told apart, fleet-wide and without parsing prose, from "your Codex config has
 * a syntax error". Everything an adapter reports as `error` stays `error`.
 */
export type DoctorSeverity = 'critical' | 'error' | 'warn' | 'info';

export interface DoctorFix {
  applied: boolean;
  detail: string;
}

export interface DoctorFinding {
  /** Machine-readable, kebab-case, stable — CI pipelines will match on it. */
  code: string;
  severity: DoctorSeverity;
  message: string;
  file?: string;
  /** Location inside the file, e.g. `["mcpServers","coolify","env","COOLIFY_API_TOKEN"]`. */
  keyPath?: string[];
  /** 1-indexed. Used when a match could not be attributed to a key path. */
  lines?: number[];
  /** What to do about it. For credential findings this leads with rotation. */
  remediation: string;
  fix?: DoctorFix;
}

export interface DoctorRuntimeReport {
  node: string;
  packageVersion: string;
  platform: NodeJS.Platform;
  cwd: string;
}

export interface DoctorConnectionReport {
  name: string;
  baseUrl: string;
  /** Human description of where the token comes from. Never the token. */
  tokenSource: string;
  resolved: boolean;
  /** Redacted failure text when `resolved` is false. */
  error?: string;
  /** Whether the resolved value has the Sanctum shape. The value itself never leaves here. */
  wellFormed?: boolean;
  readOnly: boolean;
  allowDestructive: boolean;
  /** Defined in both the environment and the registry file; the environment won. */
  shadowsFile: boolean;
}

export interface DoctorClientReport {
  adapterId: string;
  client: string;
  scope: 'user' | 'project';
  label: string;
  path: string;
  installed: boolean;
  configExists: boolean;
  parseable: boolean;
  entryPresent: boolean;
  confidence: 'verified' | 'unverified';
  /** e.g. `coolify-mcp@1.4.2`, read back out of the installed entry. */
  packageSpec?: string;
  /** Server entries in this file that doctor did not attribute. See `allServers`. */
  unscannedEntries: number;
}

export interface DoctorReport {
  runtime: DoctorRuntimeReport;
  registrySource?: ConnectionRegistry['source'];
  registryPath?: string;
  connections: DoctorConnectionReport[];
  clients: DoctorClientReport[];
  findings: DoctorFinding[];
}

export interface DoctorOptions {
  /** Scan server entries we do not manage, not just ours. */
  allServers?: boolean;
  /** Attempt the conservative rewrites described at {@link planFixes}. */
  fix?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  packageVersion?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The literal behind a fixable finding, held here for the duration of one run
 * and never attached to the finding itself — findings get serialised to JSON and
 * printed, and a secret on one would defeat the whole point.
 */
interface FixTarget {
  value: string;
  /** The value is a `Bearer <credential>` header, so the scheme must survive the rewrite. */
  bearer: boolean;
  adapter: McpClientAdapter;
}

type FixTargets = Map<string, FixTarget>;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const packageVersion = options.packageVersion ?? 'unknown';

  const findings: DoctorFinding[] = [];
  const targets: FixTargets = new Map();

  // Connections first, and deliberately so: resolving a token registers it with
  // the redaction set, so the client scan that follows cannot print it even if
  // some future code path tries to.
  const { connections, registry } = await inspectConnections(env, cwd, homeDir, platform, findings);

  const ctx: InstallCtx = {
    homeDir,
    projectRoot: cwd,
    platform,
    packageSpec: `coolify-mcp@${packageVersion}`,
    transport: 'stdio',
  };
  const scan: ScanOptions = {
    allServers: options.allServers === true,
    targets,
    scannedFiles: new Set<string>(),
  };
  const clients = await inspectClients(ctx, scan, findings);

  reportVersionDrift(clients, packageVersion, findings);
  if (platform === 'win32' && clients.some((client) => client.configExists)) {
    findings.push(aclNotChecked());
  }

  // Deduplicated before `--fix` runs, so a literal reachable through two
  // adapters is repaired once rather than merged into the same file twice.
  const unique = dedupe(findings);
  if (options.fix === true) await applyFixes(unique, targets, env);

  const report: DoctorReport = {
    runtime: { node: process.version, packageVersion, platform, cwd },
    connections,
    clients,
    findings: unique.sort(bySeverityThenCode),
  };
  if (registry !== undefined) {
    report.registrySource = registry.source;
    if (registry.configPath !== undefined) report.registryPath = registry.configPath;
  }
  return report;
}

/** 0 clean · 1 something needs attention · 2 a credential is at rest. */
export function doctorExitCode(report: DoctorReport): number {
  if (report.findings.some((finding) => finding.severity === 'critical')) return 2;
  const actionable = report.findings.some(
    (finding) => finding.severity === 'error' || finding.severity === 'warn',
  );
  return actionable ? 1 : 0;
}

/**
 * Two adapters can describe the same file — Cursor's user and project adapters
 * collide when the working directory is the home directory — and each runs its
 * own `validate()`. Identical findings are collapsed so the report says each
 * thing once. A repeated CRITICAL is how a report loses its reader.
 */
function dedupe(findings: DoctorFinding[]): DoctorFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = [finding.code, finding.file ?? '', (finding.keyPath ?? []).join('.'), finding.message].join(
      ' ',
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SEVERITY_ORDER: Record<DoctorSeverity, number> = { critical: 0, error: 1, warn: 2, info: 3 };

function bySeverityThenCode(a: DoctorFinding, b: DoctorFinding): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface ConnectionsResult {
  connections: DoctorConnectionReport[];
  registry?: ConnectionRegistry;
  /** Problems found while resolving, e.g. `env-var-shadows-file`. */
  findings: DoctorFinding[];
}

/**
 * The connection half of doctor, on its own — this is what `coolify-mcp
 * connections` prints. Shared rather than reimplemented so the two commands can
 * never disagree about where a token comes from, which is the single fact both
 * exist to report.
 */
export async function reportConnections(
  options: Pick<DoctorOptions, 'env' | 'cwd' | 'homeDir' | 'platform'> = {},
): Promise<ConnectionsResult> {
  const findings: DoctorFinding[] = [];
  const result = await inspectConnections(
    options.env ?? process.env,
    options.cwd ?? process.cwd(),
    options.homeDir ?? homedir(),
    options.platform ?? process.platform,
    findings,
  );
  return { ...result, findings };
}

async function inspectConnections(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homeDir: string,
  platform: NodeJS.Platform,
  findings: DoctorFinding[],
): Promise<Omit<ConnectionsResult, 'findings'>> {
  let registry: ConnectionRegistry;
  try {
    registry = await resolveRegistry(env, cwd, homeDir, { platform });
  } catch (error: unknown) {
    // Not fatal. A user whose connections are unconfigured still needs the
    // client scan — that is where the plaintext token they are about to be told
    // about is going to be found.
    findings.push({
      code: 'no-connections',
      severity: 'warn',
      message: 'No usable Coolify connection is configured.',
      remediation: redact(errorText(error)),
    });
    return { connections: [] };
  }

  if (registry.shadowed.length > 0) findings.push(envShadowsFile(registry));

  const fileConfig = await loadRegistryFile(registry.configPath);
  const connections: DoctorConnectionReport[] = [];
  for (const connection of registry.connections.values()) {
    connections.push(await inspectConnection(connection, registry, fileConfig, env));
  }
  return { connections, registry };
}

async function inspectConnection(
  connection: Connection,
  registry: ConnectionRegistry,
  fileConfig: ConfigFile | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DoctorConnectionReport> {
  const report: DoctorConnectionReport = {
    name: connection.name,
    baseUrl: connection.baseUrl,
    tokenSource: describeTokenSource(connection.name, fileConfig, env),
    resolved: false,
    readOnly: connection.readOnly,
    allowDestructive: connection.allowDestructive,
    shadowsFile: registry.shadowed.includes(connection.name),
  };

  try {
    // A real resolution, prompts and all: "is the variable set" answers a
    // different question from "does `op read` actually return the credential",
    // and only the second predicts whether the server will work.
    const token = await connection.resolveToken();
    report.resolved = true;
    report.wellFormed = SANCTUM_TOKEN.test(token);
  } catch (error: unknown) {
    report.error = redact(errorText(error));
  }
  return report;
}

/**
 * Describes where a connection's token comes from, without reading it.
 *
 * `Connection` intentionally exposes only `resolveToken`, so the source is
 * re-derived from the same two inputs `config/resolve.ts` used. That
 * duplication is the price of the connection object carrying no provenance, and
 * it is worth paying: "which of my four token sources is this connection
 * actually using" is a question doctor exists to answer.
 */
function describeTokenSource(
  name: string,
  fileConfig: ConfigFile | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const entry = fileConfig?.connections[name];

  if (entry?.tokenCommand !== undefined) return `tokenCommand: ${entry.tokenCommand.join(' ')}`;
  if (entry?.tokenKeychain !== undefined) {
    return `tokenKeychain: service "${entry.tokenKeychain.service}", account "${entry.tokenKeychain.account}"`;
  }
  if (entry?.tokenEnv !== undefined) return envSourceLabel(entry.tokenEnv, env, 'declared');

  const conventional = tokenEnvVar(name);
  if (readEnvValue(env, conventional) !== undefined) {
    return envSourceLabel(conventional, env, 'by convention');
  }
  if (name === DEFAULT_CONNECTION_NAME && readEnvValue(env, 'COOLIFY_API_TOKEN') !== undefined) {
    return envSourceLabel('COOLIFY_API_TOKEN', env, 'by convention');
  }
  return `$${conventional} (by convention, unset)`;
}

function envSourceLabel(variable: string, env: NodeJS.ProcessEnv, how: string): string {
  const state = readEnvValue(env, variable) === undefined ? 'unset' : 'set';
  return `$${variable} (${how}, ${state})`;
}

async function loadRegistryFile(configPath: string | undefined): Promise<ConfigFile | undefined> {
  if (configPath === undefined) return undefined;
  try {
    const text = await fs.readFile(configPath, 'utf8');
    return parseConfigFile(JSON.parse(stripBom(text)) as unknown, configPath);
  } catch {
    // resolveRegistry already succeeded on this file, so a failure here is a
    // race or a permission change. The token source degrades to "by convention"
    // rather than taking the whole report down.
    return undefined;
  }
}

function envShadowsFile(registry: ConnectionRegistry): DoctorFinding {
  const many = registry.shadowed.length > 1;
  const finding: DoctorFinding = {
    code: 'env-var-shadows-file',
    severity: 'warn',
    message:
      `Connection${many ? 's' : ''} ${registry.shadowed.join(', ')} ${many ? 'are' : 'is'} defined in both the ` +
      "environment and the registry file. The environment definition replaces the file's one WHOLE — no field is merged, " +
      'so settings such as readOnly written in the file are not in effect.',
    remediation:
      'Delete one of the two definitions. If the file entry is the one you edit, unset the matching ' +
      'COOLIFY_BASE_URL_<NAME> in whichever client config or shell profile exports it.',
  };
  if (registry.configPath !== undefined) finding.file = registry.configPath;
  return finding;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

interface ScanOptions {
  allServers: boolean;
  targets: FixTargets;
  /**
   * Files already scanned this run.
   *
   * Two adapters can resolve to the same file — Cursor's user and project
   * adapters both name `.cursor/mcp.json`, and they collide whenever the working
   * directory is the home directory. Without this, that file's credential
   * findings would be reported twice, and a duplicated CRITICAL is how a report
   * loses the reader's trust.
   */
  scannedFiles: Set<string>;
}

async function inspectClients(
  ctx: InstallCtx,
  options: ScanOptions,
  findings: DoctorFinding[],
): Promise<DoctorClientReport[]> {
  const reports: DoctorClientReport[] = [];
  for (const adapter of ADAPTERS) {
    reports.push(await inspectClient(adapter, ctx, options, findings));
  }
  return reports;
}

async function inspectClient(
  adapter: McpClientAdapter,
  ctx: InstallCtx,
  options: ScanOptions,
  findings: DoctorFinding[],
): Promise<DoctorClientReport> {
  const detection = await detectSafely(adapter, ctx);
  const entry = await readEntrySafely(adapter, ctx);
  const spec = extractPackageSpec(entry);

  const report: DoctorClientReport = {
    adapterId: adapter.id,
    client: adapter.client,
    scope: adapter.scope,
    label: adapter.label,
    path: detection.path,
    installed: detection.installed,
    configExists: detection.configExists,
    parseable: detection.parseable,
    entryPresent: entry !== null && entry !== undefined,
    confidence: adapter.confidence,
    unscannedEntries: 0,
  };
  if (spec !== undefined) report.packageSpec = spec;

  if (adapter.confidence === 'unverified' && detection.installed) {
    findings.push(unverifiedAdapter(adapter, detection.path));
  }
  const reported = new Set<string>();
  for (const issue of await validateSafely(adapter, ctx)) {
    reported.add(issue.code);
    findings.push(fromValidationIssue(issue, detection.path));
  }
  if (!detection.configExists || options.scannedFiles.has(detection.path)) return report;
  options.scannedFiles.add(detection.path);

  await checkPermissions(detection.path, ctx.platform, findings);
  report.unscannedEntries = await scanConfigFile(adapter, detection.path, options, findings, reported);
  return report;
}

/**
 * Whether an adapter already reported that its config does not parse. Adapters
 * word this per client (`codex-config-unparseable`, `claude-code-config-unparseable`),
 * so it is matched on the shape of the code rather than on a list that would go
 * stale the moment an adapter is added.
 */
function alreadyReportedParseFailure(codes: Set<string>): boolean {
  for (const code of codes) if (/unparseable|parse-failed|parse-error/.test(code)) return true;
  return false;
}

/**
 * Adapters do I/O, and a broken one must not take the whole report down: doctor
 * is the tool you reach for *because* something is wrong, so it has to survive
 * more breakage than anything else in this codebase.
 */
async function detectSafely(adapter: McpClientAdapter, ctx: InstallCtx): Promise<Detection> {
  try {
    return await adapter.detect(ctx);
  } catch {
    return {
      installed: false,
      configExists: false,
      parseable: false,
      path: resolvePathSafely(adapter, ctx),
    };
  }
}

function resolvePathSafely(adapter: McpClientAdapter, ctx: InstallCtx): string {
  try {
    return adapter.resolvePath(ctx);
  } catch {
    return `<unresolved: ${adapter.id}>`;
  }
}

async function readEntrySafely(adapter: McpClientAdapter, ctx: InstallCtx): Promise<unknown | null> {
  try {
    return await adapter.readEntry(ctx);
  } catch {
    return null;
  }
}

async function validateSafely(
  adapter: McpClientAdapter,
  ctx: InstallCtx,
): Promise<ValidationIssue[]> {
  try {
    return await adapter.validate(ctx);
  } catch (error: unknown) {
    return [
      {
        severity: 'warn',
        code: 'adapter-validate-failed',
        message: `${adapter.id} could not be validated: ${errorText(error)}`,
      },
    ];
  }
}

function fromValidationIssue(issue: ValidationIssue, file: string): DoctorFinding {
  return {
    code: issue.code,
    severity: issue.severity,
    message: redact(issue.message),
    file,
    remediation: redact(issue.fix ?? `See docs/clients/ for this client's config format.`),
  };
}

function unverifiedAdapter(adapter: McpClientAdapter, file: string): DoctorFinding {
  return {
    code: 'unverified-adapter-present',
    severity: 'warn',
    message: `${adapter.label} is installed, but its MCP config key has not been verified against upstream documentation, so coolify-mcp will not write to it.`,
    file,
    remediation:
      `Run \`coolify-mcp install --client ${adapter.client} --print\` and paste the snippet yourself. ` +
      'Writing a guessed key is how an installer corrupts an unrelated part of a user config — this refusal is what prevents that.',
  };
}

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

async function checkPermissions(
  file: string,
  platform: NodeJS.Platform,
  findings: DoctorFinding[],
): Promise<void> {
  // Node reports a synthesised mode on Windows (0o666 / 0o444) that reflects
  // only the read-only attribute, so testing it there would produce a verdict
  // about a permission model Windows does not use. See `aclNotChecked`.
  if (platform === 'win32') return;

  let mode: number;
  try {
    mode = (await fs.stat(file)).mode;
  } catch {
    return;
  }
  if ((mode & GROUP_AND_OTHER_BITS) === 0) return;

  findings.push({
    code: 'world-readable-config',
    severity: 'warn',
    message: `Mode ${(mode & 0o777).toString(8).padStart(3, '0')} — readable by users other than its owner.`,
    file,
    remediation:
      `\`chmod 600 ${file}\`. MCP client configs carry environment blocks, and on a shared box or a ` +
      'CI runner every other account can read whatever ends up in one.',
  });
}

function aclNotChecked(): DoctorFinding {
  return {
    code: 'acl-not-checked',
    severity: 'info',
    message:
      'File permissions were NOT checked. Windows uses ACLs rather than POSIX mode bits and doctor does not read ACLs, so reporting "permissions OK" here would be a claim it has not verified.',
    remediation:
      'Check by hand if this machine is shared: `icacls "%USERPROFILE%\\.claude.json"`. Files under your user profile are normally readable only by you and by Administrators.',
  };
}

// ---------------------------------------------------------------------------
// Credential scanning
// ---------------------------------------------------------------------------

interface StringNode {
  key: string;
  parentKey: string;
  keyPath: string[];
  value: string;
}

interface ParsedConfig {
  text: string;
  value: unknown;
  parseError?: string;
}

/**
 * Scans one client config. Returns the number of server entries that were
 * present but deliberately not attributed, so the caller can tell the user what
 * `--all-servers` would add.
 */
async function scanConfigFile(
  adapter: McpClientAdapter,
  file: string,
  options: ScanOptions,
  findings: DoctorFinding[],
  reported: Set<string>,
): Promise<number> {
  const parsed = await readAndParse(file, adapter.format);
  if (parsed === undefined) return 0;
  if (parsed.parseError !== undefined && !alreadyReportedParseFailure(reported)) {
    findings.push(parseFailure(adapter, file, parsed.parseError));
  }

  const entries = findServerEntries(parsed.value);
  const scanned = options.allServers ? entries : entries.filter((entry) => entry.ours);

  const nodes: StringNode[] = [];
  if (options.allServers) collectStrings(parsed.value, [], nodes, 0);
  else for (const entry of scanned) collectStrings(entry.value, entry.keyPath, nodes, 0);

  const seenTokens = new Set<string>();
  for (const node of nodes) {
    const result = classify(node, file, adapter, seenTokens);
    if (result === undefined) continue;
    findings.push(result.finding);
    if (result.literal !== undefined) {
      options.targets.set(targetKey(file, node.keyPath), { ...result.literal, adapter });
    }
  }

  // Unconditional whole-file sweep for the Sanctum shape, whatever the scan
  // scope is. Scoping the *attributed* scan keeps the report about the user's
  // own installation; staying silent about a live credential we literally read
  // would be indefensible. The leftovers are reported by line number, since by
  // definition they have no key path we walked to.
  const stray = strayTokenLines(parsed.text, seenTokens);
  if (stray.length > 0) {
    findings.push(strayCredential(file, stray, options.allServers, parsed.value !== undefined));
  }

  return entries.length - scanned.length;
}

async function readAndParse(
  file: string,
  format: McpClientAdapter['format'],
): Promise<ParsedConfig | undefined> {
  let text: string;
  try {
    text = stripBom(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }

  try {
    if (format === 'json') return { text, value: JSON.parse(text) as unknown };
    if (format === 'toml') return { text, value: parseToml(text) as unknown };
    if (format === 'yaml') return { text, value: parseYaml(text) as unknown };

    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
    const first = errors[0];
    if (first === undefined) return { text, value };
    return { text, value, parseError: `${printParseErrorCode(first.error)} at offset ${first.offset}` };
  } catch (error: unknown) {
    // The text is still returned: an unparseable config is precisely the one
    // most likely to have been hand-edited with a token pasted into it.
    return { text, value: undefined, parseError: errorText(error) };
  }
}

function parseFailure(adapter: McpClientAdapter, file: string, detail: string): DoctorFinding {
  const code =
    adapter.client === 'codex'
      ? 'codex-config-unparseable'
      : adapter.format === 'jsonc'
        ? 'jsonc-parse-failed'
        : `${adapter.format}-parse-failed`;

  return {
    code,
    severity: 'error',
    message: `Does not parse as ${adapter.format.toUpperCase()}: ${redact(detail)}`,
    file,
    remediation:
      'Fix the syntax before installing anything. coolify-mcp refuses to write into a file it cannot parse, ' +
      'because appending to a broken config turns a five-second repair into an archaeology exercise — and this ' +
      'file usually holds every other MCP server on the machine too.',
  };
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

interface ServerEntryNode {
  name: string;
  keyPath: string[];
  value: unknown;
  ours: boolean;
}

/**
 * Locates MCP server entries anywhere in a parsed config.
 *
 * Searched by container key rather than at a fixed depth: Zed nests
 * `context_servers` under a settings root, Codex uses a TOML table, and a
 * project-scoped Claude config puts `mcpServers` under a project path.
 */
function findServerEntries(root: unknown): ServerEntryNode[] {
  const found: ServerEntryNode[] = [];
  walkObjects(root, [], 0, (node, keyPath) => {
    for (const [key, child] of Object.entries(node)) {
      if (!SERVER_CONTAINER_KEYS.has(key) || !isPlainObject(child)) continue;
      for (const [name, entry] of Object.entries(child)) {
        found.push({
          name,
          keyPath: [...keyPath, key, name],
          value: entry,
          ours: isOurs(name, entry),
        });
      }
    }
  });
  return found;
}

function walkObjects(
  value: unknown,
  keyPath: string[],
  depth: number,
  visit: (node: Record<string, unknown>, keyPath: string[]) => void,
): void {
  if (depth > MAX_WALK_DEPTH || !isPlainObject(value)) return;
  visit(value, keyPath);
  for (const [key, child] of Object.entries(value)) {
    walkObjects(child, [...keyPath, key], depth + 1, visit);
  }
}

/**
 * Whether an entry is ours.
 *
 * Matched on the package name inside the entry rather than on a constant shared
 * with the installer, because the entry we most need to find is the one a user
 * added by hand before this CLI existed — and that one was never written by our
 * writer, so it carries none of our bookkeeping.
 */
function isOurs(name: string, entry: unknown): boolean {
  if (/coolify/i.test(name)) return true;
  try {
    return /coolify-mcp/i.test(JSON.stringify(entry) ?? '');
  } catch {
    return false;
  }
}

function collectStrings(value: unknown, keyPath: string[], out: StringNode[], depth: number): void {
  if (depth > MAX_WALK_DEPTH) return;

  if (typeof value === 'string') {
    out.push({
      key: keyPath[keyPath.length - 1] ?? '',
      parentKey: keyPath[keyPath.length - 2] ?? '',
      keyPath,
      value,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectStrings(item, [...keyPath, String(index)], out, depth + 1),
    );
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, [...keyPath, key], out, depth + 1);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Classification — precision order
// ---------------------------------------------------------------------------

interface Classified {
  finding: DoctorFinding;
  /** Present when `--fix` could act on this node. */
  literal?: { value: string; bearer: boolean };
}

/**
 * At most one finding per string node, most precise rule first.
 *
 * The order matters more than the individual rules do. A literal Sanctum token
 * in `headers.Authorization` satisfies all three tests, and reporting it three
 * times would bury the one that says "rotate this now" under two that say
 * "consider using a variable".
 */
function classify(
  node: StringNode,
  file: string,
  adapter: McpClientAdapter,
  seenTokens: Set<string>,
): Classified | undefined {
  const token = SANCTUM_TOKEN.exec(node.value);
  if (token !== null) {
    seenTokens.add(token[0]);
    return {
      finding: plaintextCredential(file, node, adapter),
      // Only a value that is *entirely* the token can be swapped for a
      // reference; a token embedded in a longer string needs a human.
      ...(node.value.trim() === token[0] ? { literal: { value: node.value, bearer: false } } : {}),
    };
  }

  const bearer = BEARER_HEADER.exec(node.value);
  if (bearer !== null && isHeaderNode(node)) {
    const credential = bearer[1] ?? '';
    if (!ENV_REFERENCE.test(node.value) && !PLACEHOLDER.test(credential)) {
      return {
        finding: bearerLiteral(file, node, adapter),
        literal: { value: credential, bearer: true },
      };
    }
  }

  if (
    ENV_CONTAINER_KEYS.has(node.parentKey) &&
    SECRET_KEY_NAME.test(node.key) &&
    node.value !== '' &&
    !ENV_REFERENCE.test(node.value) &&
    !PLACEHOLDER.test(node.value)
  ) {
    return {
      finding: envLiteralSecret(file, node, adapter),
      literal: { value: node.value, bearer: false },
    };
  }
  return undefined;
}

function isHeaderNode(node: StringNode): boolean {
  return node.keyPath.some((segment) => segment.toLowerCase() === 'headers');
}

/**
 * The rotation text.
 *
 * It leads with rotation and does not soften it, because the alternative
 * framing — "move this into an environment variable" — implies the credential is
 * still trustworthy once moved. It is not. It has been readable on disk by every
 * process running as this user, and by every backup, sync client, screen share
 * and support bundle that ever touched the file.
 */
function rotationRemediation(adapter: McpClientAdapter, keyPath: string[]): string {
  return [
    'ROTATE THIS TOKEN NOW. Treat it as compromised.',
    '  1. Coolify > Keys & Tokens > API tokens: revoke this token, then issue a replacement.',
    '  2. Keep the replacement in an environment variable and reference it here instead of pasting it:',
    `       ${keyPath.join('.')} = "${referenceExample(adapter)}"`,
    '     then export COOLIFY_API_TOKEN in the environment this client starts from.',
    '  3. Re-run `coolify-mcp doctor` and confirm this finding is gone.',
    'Moving the value without revoking it changes nothing about who already has it.',
  ].join('\n');
}

function plaintextCredential(
  file: string,
  node: StringNode,
  adapter: McpClientAdapter,
): DoctorFinding {
  return {
    code: 'plaintext-credential',
    severity: 'critical',
    // The file is carried in `file` and printed on the heading line; repeating
    // it in the message turns every finding into two lines of absolute path.
    message: `A Coolify API token is stored in plaintext at ${node.keyPath.join('.')} (Sanctum shape: <id>|<40+ chars>).`,
    file,
    keyPath: node.keyPath,
    remediation: rotationRemediation(adapter, node.keyPath),
  };
}

function bearerLiteral(file: string, node: StringNode, adapter: McpClientAdapter): DoctorFinding {
  return {
    code: 'bearer-literal',
    severity: 'warn',
    message: `${node.keyPath.join('.')} is a literal Bearer credential rather than an environment reference.`,
    file,
    keyPath: node.keyPath,
    remediation:
      `Replace the value with "Bearer ${referenceExample(adapter)}" and export the variable in the environment ` +
      'this client starts from. If the literal is a live credential, rotate it too — it has been at rest in a config file.',
  };
}

function envLiteralSecret(file: string, node: StringNode, adapter: McpClientAdapter): DoctorFinding {
  return {
    code: 'env-literal-secret',
    severity: 'warn',
    message: `${node.keyPath.join('.')} sets a credential-shaped variable to a literal value.`,
    file,
    keyPath: node.keyPath,
    remediation:
      `Reference the variable instead: "${node.key}": "${referenceExample(adapter, node.key)}". ` +
      'If the literal is a live credential, rotate it — a config file is not a secret store.',
  };
}

/**
 * The reference syntax this client expands. Cursor is the odd one out with
 * `${env:NAME}`; every other supported client uses `${NAME}`.
 */
function referenceExample(adapter: McpClientAdapter, variable = 'COOLIFY_API_TOKEN'): string {
  return adapter.client === 'cursor' ? `\${env:${variable}}` : `\${${variable}}`;
}

function strayTokenLines(text: string, seen: Set<string>): number[] {
  const lines: number[] = [];
  SANCTUM_TOKEN_GLOBAL.lastIndex = 0;
  for (
    let match = SANCTUM_TOKEN_GLOBAL.exec(text);
    match !== null;
    match = SANCTUM_TOKEN_GLOBAL.exec(text)
  ) {
    if (!seen.has(match[0])) lines.push(lineOf(text, match.index));
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 0x0a) line += 1;
  return line;
}

function strayCredential(
  file: string,
  lines: number[],
  allServers: boolean,
  parsed: boolean,
): DoctorFinding {
  const many = lines.length > 1;
  return {
    code: 'plaintext-credential',
    severity: 'critical',
    message:
      `${many ? `${lines.length} Coolify API tokens are` : 'A Coolify API token is'} stored in plaintext at ` +
      `line${many ? 's' : ''} ${lines.join(', ')}.`,
    file,
    lines,
    remediation: [
      `ROTATE EVERY TOKEN AT ${many ? 'THESE LINES' : 'THIS LINE'}. Treat ${many ? 'them' : 'it'} as compromised.`,
      'Revoke under Coolify > Keys & Tokens > API tokens, issue replacements, and keep the replacements in environment variables.',
      whyByLine(allServers, parsed),
    ].join('\n'),
  };
}

/** Explains why this one came with a line number instead of a key path. */
function whyByLine(allServers: boolean, parsed: boolean): string {
  if (!parsed) {
    return 'Reported by line because the file does not parse, so nothing in it could be attributed to a key. Doctor scans the raw text regardless — an unparseable config is the likeliest place for a hand-pasted token to be hiding.';
  }
  return allServers
    ? 'Reported by line because the match is not inside a server entry at all — most often a comment left behind after an edit.'
    : 'Re-run with --all-servers to find which server entry each one belongs to, or check the comments.';
}

// ---------------------------------------------------------------------------
// Version pinning
// ---------------------------------------------------------------------------

/**
 * Reads the package spec back out of an installed entry. Both `command` and
 * `args` are searched because the clients disagree on which one carries it: Zed
 * takes a command string, OpenCode takes an argv array.
 */
function extractPackageSpec(entry: unknown): string | undefined {
  if (!isPlainObject(entry)) return undefined;
  const words: string[] = [];

  const command = entry['command'];
  if (typeof command === 'string') words.push(...command.split(/\s+/));
  else if (Array.isArray(command)) for (const part of command) if (typeof part === 'string') words.push(part);

  const args = entry['args'];
  if (Array.isArray(args)) for (const arg of args) if (typeof arg === 'string') words.push(arg);

  return words.find((word) => word === 'coolify-mcp' || word.startsWith('coolify-mcp@'));
}

function reportVersionDrift(
  clients: DoctorClientReport[],
  packageVersion: string,
  findings: DoctorFinding[],
): void {
  const specs = new Set(
    clients
      .map((client) => client.packageSpec)
      .filter((spec): spec is string => spec !== undefined),
  );
  if (specs.size === 0) return;

  if (specs.size > 1) {
    findings.push({
      code: 'pinned-version-mismatch',
      severity: 'warn',
      message: `Clients disagree on which coolify-mcp to run: ${[...specs].sort().join(', ')}.`,
      remediation:
        'Reinstall with one spec everywhere — `coolify-mcp install --all-detected --pin --update` writes the version ' +
        'you are running now into every client config. Two clients on two versions means two different tool surfaces, ' +
        'and a bug report that reproduces in only one of them.',
    });
    return;
  }

  const [only] = [...specs];
  if (only === undefined) return;

  // A bare `coolify-mcp` is the locally installed binary: its version is whatever
  // the package manager put on disk, which is a pin by another name. Only an
  // explicit `@latest` re-resolves on every spawn.
  if (!only.includes('@')) return;
  const pinned = only.slice(only.indexOf('@') + 1);

  if (pinned === 'latest' || pinned === '') {
    findings.push({
      code: 'unpinned-version',
      severity: 'info',
      message: `Clients resolve coolify-mcp at spawn time (${only}), so every start may execute code published since the last one.`,
      remediation:
        'Fine for one developer, out of policy at most companies. `coolify-mcp install --all-detected --pin` writes an ' +
        `exact version (currently ${packageVersion}) into every client config, and you upgrade when you choose to.`,
    });
    return;
  }
  if (pinned !== packageVersion) {
    findings.push({
      code: 'pinned-version-mismatch',
      severity: 'info',
      message: `Clients are pinned to coolify-mcp@${pinned}, but this CLI is ${packageVersion}.`,
      remediation:
        'Expected right after upgrading the CLI itself. `coolify-mcp install --all-detected --pin --update` moves the ' +
        'pin; leave it alone if the older version is deliberate.',
    });
  }
}

// ---------------------------------------------------------------------------
// --fix
// ---------------------------------------------------------------------------

/**
 * The conservative fix.
 *
 * A literal is rewritten to `${VAR}` ONLY when `$VAR` is already exported with
 * exactly that value, and only for a client whose expansion of that syntax is
 * verified. Everything else prints instructions and changes nothing.
 *
 * Two things this deliberately does not do:
 *
 *  - It never invents a variable. Setting one durably means editing a shell
 *    profile, a launchd plist or a Windows user environment that this process
 *    cannot see, and a "fixed" config referencing a variable that is unset at
 *    spawn time is worse than the literal it replaced: it now fails inside the
 *    client, where the user has no diagnostics.
 *  - It never prints the value it matched. That would put the secret into shell
 *    history, terminal scrollback and CI logs — three places strictly worse than
 *    the config file being cleaned up.
 *
 * Rotation is recommended either way. A credential that has been at rest in
 * plaintext is burned regardless of what we do to the file now.
 */
type MergeWriter = (source: string, keyPath: readonly string[], value: unknown) => MergeResult;

interface PlannedFix {
  finding: DoctorFinding;
  file: string;
  keyPath: string[];
  /** The `${VAR}` reference that replaces the literal. */
  value: string;
  variable: string;
  write: MergeWriter;
}

async function applyFixes(
  findings: DoctorFinding[],
  targets: FixTargets,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const byFile = new Map<string, PlannedFix[]>();
  for (const fix of planFixes(findings, targets, env)) {
    const bucket = byFile.get(fix.file);
    if (bucket === undefined) byFile.set(fix.file, [fix]);
    else bucket.push(fix);
  }
  // Grouped per file rather than per finding: two literals in one config become
  // one read and one write, so nothing can crash between them.
  for (const [file, fixes] of byFile) await applyFixesToFile(file, fixes);
}

function planFixes(
  findings: DoctorFinding[],
  targets: FixTargets,
  env: NodeJS.ProcessEnv,
): PlannedFix[] {
  const planned: PlannedFix[] = [];
  for (const finding of findings) {
    if (finding.file === undefined || finding.keyPath === undefined) continue;
    const target = targets.get(targetKey(finding.file, finding.keyPath));
    if (target === undefined) continue;

    const fix = buildFix(finding, finding.file, finding.keyPath, target, env);
    if (fix !== undefined) planned.push(fix);
    else finding.fix = { applied: false, detail: NOT_FIXED };
  }
  return planned;
}

const NOT_FIXED =
  'Not fixed, by design. --fix rewrites a literal into ${VAR} only when $VAR is already exported with exactly ' +
  'that value and the client is known to expand the reference. At least one of those is false here, so nothing ' +
  'was changed — follow the remediation above by hand.';

function buildFix(
  finding: DoctorFinding,
  file: string,
  keyPath: string[],
  target: FixTarget,
  env: NodeJS.ProcessEnv,
): PlannedFix | undefined {
  if (!EXPANDS_ENV_REFERENCES.has(target.adapter.client)) return undefined;

  const write = writerFor(target.adapter.format);
  if (write === undefined) return undefined;

  const variable = variableHolding(env, target.value);
  if (variable === undefined) return undefined;

  const reference = referenceExample(target.adapter, variable);
  return {
    finding,
    file,
    keyPath,
    value: target.bearer ? `Bearer ${reference}` : reference,
    variable,
    write,
  };
}

async function applyFixesToFile(file: string, fixes: PlannedFix[]): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error: unknown) {
    for (const fix of fixes) fix.finding.fix = notApplied(errorText(error));
    return;
  }

  const staged: PlannedFix[] = [];
  for (const fix of fixes) {
    const result = fix.write(text, fix.keyPath, fix.value);
    const refusal = result.issues.find((issue) => issue.severity === 'error');
    if (refusal !== undefined) {
      fix.finding.fix = notApplied(refusal.message);
      continue;
    }
    if (!result.changed) {
      fix.finding.fix = notApplied('the writer reported nothing to change');
      continue;
    }
    text = result.text;
    staged.push(fix);
  }
  if (staged.length === 0) return;

  try {
    await writeAtomic(file, text);
  } catch (error: unknown) {
    for (const fix of staged) fix.finding.fix = notApplied(errorText(error));
    return;
  }
  for (const fix of staged) {
    fix.finding.fix = {
      applied: true,
      detail:
        `Rewritten to reference $${fix.variable}, which already held exactly this value. ` +
        "ROTATE THE TOKEN ANYWAY — the literal is in this file's history, in your backups, and in anything that ever synced it.",
    };
  }
}

function notApplied(reason: string): DoctorFix {
  return { applied: false, detail: `Not applied: ${redact(reason)}` };
}

/**
 * Writes through a sibling temp file and a rename.
 *
 * A client config holds every other MCP server on the machine, so a truncated
 * write does not break one integration, it breaks all of them. The original
 * mode is copied onto the temp file first: a tool that reports
 * `world-readable-config` must not be the thing that creates one, and plain
 * `writeFile` would apply the process umask to a file that was 0600.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.coolify-mcp-${process.pid}.tmp`;
  const mode = await fs
    .stat(file)
    .then((stats) => stats.mode & 0o777)
    .catch(() => undefined);

  await fs.writeFile(temp, text, 'utf8');
  try {
    if (mode !== undefined) await fs.chmod(temp, mode).catch(() => undefined);
    await fs.rename(temp, file);
  } catch (error: unknown) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function variableHolding(env: NodeJS.ProcessEnv, literal: string): string | undefined {
  const needle = literal.trim();
  if (needle === '') return undefined;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() === needle) return key;
  }
  return undefined;
}

/**
 * Plain JSON goes through the JSONC writer too, on purpose.
 *
 * `mergeJson` re-serialises the whole document. That is right for an install,
 * where the file is small and the entry is ours to shape, and wrong here:
 * `~/.claude.json` also carries Claude Code's own project state, so reformatting
 * hundreds of kilobytes of it to change one string is a diff nobody asked for
 * and a change to bytes doctor never inspected. `mergeJsonc` edits text through
 * `modify`/`applyEdits`, so every byte outside the value survives — and JSONC is
 * a superset of JSON, so strict JSON in stays strict JSON out.
 */
function writerFor(format: McpClientAdapter['format']): MergeWriter | undefined {
  if (format === 'json' || format === 'jsonc') return mergeJsonc;
  if (format === 'yaml') return mergeYaml;
  // TOML is written a section at a time, so there is no way to set one key
  // without rewriting the table around it. Refusing beats reformatting
  // config.toml — the one file every Codex MCP server on the machine shares.
  return undefined;
}

function targetKey(file: string, keyPath: string[]): string {
  return [file, ...keyPath].join(' ');
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<DoctorSeverity, string> = {
  critical: 'CRITICAL',
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
};

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    ...runtimeSection(report),
    '',
    ...connectionSection(report),
    '',
    ...clientSection(report),
    '',
    ...findingSection(report),
  ];
  // One chokepoint. Every string above originated in a file, an environment
  // variable or an error message, and all three can carry a token.
  return redact(lines.join('\n'));
}

function runtimeSection(report: DoctorReport): string[] {
  return [
    'RUNTIME',
    `  node          ${report.runtime.node}`,
    `  coolify-mcp   ${report.runtime.packageVersion}`,
    `  platform      ${report.runtime.platform}`,
  ];
}

function connectionSection(report: DoctorReport): string[] {
  return formatConnectionReports(report.connections, report.registrySource, report.registryPath);
}

/** Shared by `doctor` and `connections` so the two can never disagree. */
export function formatConnectionReports(
  connections: DoctorConnectionReport[],
  registrySource?: ConnectionRegistry['source'],
  registryPath?: string,
): string[] {
  const where = registryPath === undefined ? '' : `, ${registryPath}`;
  const source = registrySource === undefined ? '' : ` (${registrySource}${where})`;
  const lines = [`CONNECTIONS${source}`];

  if (connections.length === 0) {
    lines.push('  none configured');
    return lines;
  }
  for (const connection of connections) {
    const flags = [
      connection.readOnly ? 'read-only' : undefined,
      connection.allowDestructive ? 'destructive-allowed' : undefined,
      connection.shadowsFile ? 'env shadows file' : undefined,
      connection.resolved && connection.wellFormed === false ? 'token shape unexpected' : undefined,
    ].filter((flag): flag is string => flag !== undefined);

    lines.push(
      `  ${connection.name}  ${connection.baseUrl}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`,
    );
    lines.push(`      token   ${connection.tokenSource}`);
    lines.push(
      `      status  ${connection.resolved ? 'resolves' : `DOES NOT RESOLVE — ${connection.error ?? 'unknown error'}`}`,
    );
  }
  return lines;
}

function clientSection(report: DoctorReport): string[] {
  const lines = ['CLIENTS'];
  if (report.clients.length === 0) lines.push('  no adapters registered');
  for (const client of report.clients) {
    lines.push(`  ${clientMark(client)}  ${client.adapterId.padEnd(22)} ${client.path}`);
    lines.push(`         ${clientDetail(client)}`);
  }
  return lines;
}

function clientMark(client: DoctorClientReport): string {
  if (!client.configExists) return ' - ';
  if (!client.parseable) return '!!!';
  return client.entryPresent ? ' ok' : '   ';
}

function clientDetail(client: DoctorClientReport): string {
  if (!client.installed && !client.configExists) return 'client not detected';
  if (!client.configExists) return 'installed, no config file yet';
  if (!client.parseable) return 'config file does not parse';

  const parts = [
    client.entryPresent
      ? `coolify entry present (${client.packageSpec ?? 'spec not recognised'})`
      : 'no coolify entry',
  ];
  if (client.unscannedEntries > 0) {
    const plural = client.unscannedEntries === 1 ? 'y' : 'ies';
    parts.push(`${client.unscannedEntries} other server entr${plural} not scanned (--all-servers)`);
  }
  if (client.confidence === 'unverified') parts.push('adapter unverified: --print only');
  return parts.join(' · ');
}

function findingSection(report: DoctorReport): string[] {
  if (report.findings.length === 0) {
    return [
      'FINDINGS',
      '  none. No credential at rest, every config parses, every token source resolves.',
    ];
  }
  const lines = ['FINDINGS'];
  for (const finding of report.findings) {
    const where = finding.file === undefined ? '' : `  ${finding.file}`;
    lines.push(`  [${SEVERITY_LABEL[finding.severity]}] ${finding.code}${where}`);
    lines.push(indent(finding.message, 6));
    lines.push(indent(finding.remediation, 6));
    if (finding.fix !== undefined) {
      const prefix = finding.fix.applied ? '--fix applied: ' : '--fix: ';
      lines.push(indent(`${prefix}${finding.fix.detail}`, 6));
    }
    lines.push('');
  }
  return lines;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

/** Windows editors write a BOM; JSON.parse and smol-toml both choke on it. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
