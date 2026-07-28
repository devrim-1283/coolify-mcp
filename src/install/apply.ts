/**
 * Execution: run a plan's operations against the filesystem.
 *
 * Everything that decides WHAT to write lives in the adapters and the planner.
 * This module decides only WHETHER and HOW: the confidence gate, drift
 * protection, atomic writes, and the install-state bookkeeping that makes
 * uninstall safe.
 *
 * `--dry-run` is this same function with `dryRun: true`. It builds the exact
 * bytes it would have written and returns them without writing, so the diff a
 * user approves is produced by the code that then runs — not by a parallel
 * "preview" implementation that can drift from it.
 *
 * Two refusals are mechanical here, and mechanical on purpose:
 *
 *  - An adapter with `confidence: 'unverified'` is NEVER written; it is
 *    downgraded to print-only with a banner. This is not an editorial judgement
 *    about a particular client — writing a guessed config key into a user's
 *    agent config can break every other tool in that file, and "we were fairly
 *    sure" is not a good enough reason to risk it. Promotion is a code change
 *    backed by upstream documentation or a reproducible probe.
 *  - A writer that returns a `severity: 'error'` issue blocks its whole target.
 *    Targets are all-or-nothing: a half-applied plan is worse than no plan,
 *    because the user now has to work out which half.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { InstallState, Operation, ValidationIssue } from '../types.js';
import { redact } from '../shaping/redact.js';
import { unifiedDiff } from './diff.js';
import { mergeJson, removeJson } from './merge/json.js';
import type { MergeResult } from './merge/json.js';
import { mergeJsonc, removeJsonc } from './merge/jsonc.js';
import { appendTomlSection, removeTomlSection, replaceTomlSection } from './merge/toml.js';
import { mergeYaml, removeYaml } from './merge/yaml.js';
import type { Plan, TargetPlan } from './plan.js';
import {
  classifyDrift,
  driftSkipReason,
  findRecord,
  hashEntry,
  readState,
  removeRecord,
  upsertRecord,
  writeState,
} from './state.js';

const execFileAsync = promisify(execFile);

/** A native client CLI that has not answered in this long is not going to. */
const NATIVE_CLI_TIMEOUT_MS = 60_000;

export interface ApplyOptions {
  /** Produce the bytes, write nothing. */
  dryRun?: boolean;
  /** Show what would be written instead of writing it. Implies `dryRun`. */
  print?: boolean;
  /** Overwrite an entry the user has edited since we wrote it. */
  update?: boolean;
  /** Remove an entry we did not write, or one the user has edited. */
  force?: boolean;
  /**
   * Run `exec` operations — a client's own `mcp add` CLI.
   *
   * Off by default: apply() has no user in front of it, and a subprocess is the
   * one operation it cannot preview or undo. The CLI turns it on, because there
   * it is a choice a human made.
   */
  allowExec?: boolean;
  /** Where `install-state.json` lives. Defaults to the plan's home directory. */
  stateHome?: string;
  /** Injected by tests so `writtenAt` is deterministic. */
  now?: () => Date;
}

export type ApplyStatus =
  /** Written to disk. */
  | 'written'
  /** Already correct; no bytes changed. */
  | 'unchanged'
  /** Deliberately not applied — drift, or an entry we did not write. */
  | 'skipped'
  /** Content produced but intentionally not written (dry run, or unverified). */
  | 'printed'
  /** Refused: the target's own config is unusable. */
  | 'blocked'
  /** Tried and could not. */
  | 'failed';

export interface ApplyFile {
  path: string;
  before: string | null;
  /**
   * EXACT bytes that were (or would be) written.
   *
   * NOT redacted, and never displayed: this is the payload, and redacting it
   * would write `***` into a user's config. Use {@link diff} or {@link preview}
   * for anything a human sees.
   */
  after: string;
  /** Redacted unified diff. Safe to print. */
  diff: string;
  /** Redacted file content. Safe to print. */
  preview: string;
}

export interface ApplyTargetResult {
  adapterId: string;
  label: string;
  path: string;
  status: ApplyStatus;
  /** Why nothing was applied, when the status says so. */
  skipped?: string;
  /** Why applying failed. */
  error?: string;
  issues: ValidationIssue[];
  files: ApplyFile[];
  /** Native-CLI invocations the plan contained, whether or not they ran. */
  commands: string[][];
}

export interface ApplyResult {
  action: Plan['action'];
  targets: ApplyTargetResult[];
  statePath: string;
  issues: ValidationIssue[];
}

/**
 * Executes a plan target by target.
 *
 * One target failing never stops the others: a user installing into five
 * clients wants the four that work, and a broken `settings.json` in one editor
 * is not a reason to skip the rest.
 */
export async function applyPlan(plan: Plan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const stateHome = options.stateHome ?? plan.ctx.homeDir;
  const load = await readState(stateHome);

  let state = load.state;
  let dirty = false;
  const targets: ApplyTargetResult[] = [];

  for (const target of plan.targets) {
    const outcome = await applyTarget(plan, target, options, state);
    targets.push(outcome.result);
    if (outcome.state !== undefined) {
      state = outcome.state;
      dirty = true;
    }
  }

  let statePath = load.path;
  if (dirty) statePath = await writeState(stateHome, state);

  return { action: plan.action, targets, statePath, issues: load.issues };
}

// ---------------------------------------------------------------------------

interface TargetOutcome {
  result: ApplyTargetResult;
  /** Present only when install state changed. */
  state?: InstallState;
}

async function applyTarget(
  plan: Plan,
  target: TargetPlan,
  options: ApplyOptions,
  state: InstallState,
): Promise<TargetOutcome> {
  const issues: ValidationIssue[] = [...target.issues];
  const identity = {
    adapterId: target.adapter.id,
    label: target.adapter.label,
    path: target.path,
  };

  // --- the confidence gate -------------------------------------------------
  const unverified = target.adapter.confidence === 'unverified';
  if (unverified) {
    issues.push({
      severity: 'warn',
      code: 'unverified-write-refused',
      message: `${target.adapter.label}'s config layout is not verified, so nothing will be written to it.`,
      fix: `The entry is shown below for you to paste in yourself. Confirming the config key against upstream documentation is what promotes ${target.adapter.client} to a normal install.`,
    });
  }
  const dryRun = unverified || options.print === true || options.dryRun === true;

  // A validation error means the target's own file is unusable — unparseable,
  // or not the shape a client config has. Reported as `blocked` rather than
  // skipped so the exit code is non-zero and the user finds out.
  const fatal = issues.find((issue) => issue.severity === 'error');
  if (fatal !== undefined) {
    return {
      result: {
        ...identity,
        status: 'blocked',
        error: fatal.message,
        issues,
        files: [],
        commands: [],
      },
    };
  }

  // --- drift protection ----------------------------------------------------
  const onDisk = await target.adapter.readEntry(plan.ctx).catch(() => null);
  const record = findRecord(state, target.adapter.id, target.path, target.serverName);
  // An unverified target is never written, so drift has nothing to protect here
  // and reporting one as `skipped` would hide the real reason it was not
  // applied — the confidence gate above, which is what the user has to act on.
  const skip = unverified
    ? undefined
    : driftSkipReason(plan.action, classifyDrift(record, onDisk), onDisk, {
        serverName: target.serverName,
        path: target.path,
        update: options.update === true,
        force: options.force === true,
      });
  if (skip !== undefined) {
    issues.push(skip.issue);
    return {
      result: {
        ...identity,
        status: 'skipped',
        skipped: skip.reason,
        issues,
        files: [],
        commands: [],
      },
    };
  }

  // --- run the operations --------------------------------------------------
  const files = new Map<string, { before: string | null; after: string }>();
  const directories: string[] = [];
  const commands: string[][] = [];

  for (const operation of target.operations) {
    if (operation.kind === 'note') {
      issues.push({
        severity: operation.level === 'warn' ? 'warn' : 'info',
        code: 'adapter-note',
        message: operation.message,
      });
      continue;
    }
    if (operation.kind === 'mkdir') {
      directories.push(operation.path);
      continue;
    }
    if (operation.kind === 'exec') {
      commands.push([...operation.argv]);
      continue;
    }

    const file = await loadFile(files, operation.path);
    const merged = runWriter(operation, file.after, options);
    issues.push(...merged.issues);
    file.after = merged.text;
  }

  const writerError = issues.find((issue) => issue.severity === 'error');
  if (writerError !== undefined) {
    return {
      result: {
        ...identity,
        status: 'blocked',
        error: writerError.message,
        issues,
        files: [],
        commands,
      },
    };
  }

  const changed: ApplyFile[] = [...files.entries()]
    .filter(([, file]) => file.after !== (file.before ?? ''))
    .map(([filePath, file]) => renderFile(filePath, file));

  const useNativeCli = commands.length > 0 && options.allowExec === true;

  // Unverified targets report `printed` even when they produced no file content
  // at all. `unchanged` would be technically true and actively misleading: the
  // user asked for an install and needs to see that this one is print-only.
  if (unverified) {
    return {
      result: {
        ...identity,
        status: 'printed',
        skipped: 'unverified target — printed, never written',
        issues,
        files: changed,
        commands,
      },
    };
  }

  if (changed.length === 0 && !useNativeCli) {
    return { result: { ...identity, status: 'unchanged', issues, files: [], commands } };
  }

  if (dryRun) {
    return { result: { ...identity, status: 'printed', issues, files: changed, commands } };
  }

  // --- write ---------------------------------------------------------------
  try {
    for (const directory of directories) {
      await fs.mkdir(directory, { recursive: true });
    }
    for (const file of changed) {
      await writeAtomic(file.path, file.after);
    }
    if (useNativeCli) {
      for (const argv of commands) await runCommand(argv);
    }
  } catch (error: unknown) {
    return {
      result: {
        ...identity,
        status: 'failed',
        error: redact(`could not update ${target.path}: ${errorText(error)}`),
        issues,
        files: changed,
        commands,
      },
    };
  }

  const method = useNativeCli ? 'native-cli' : 'file';
  const nextState = await recordOutcome(plan, target, state, options, method);
  return {
    result: { ...identity, status: 'written', issues, files: changed, commands },
    state: nextState,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function runWriter(operation: Operation, current: string, options: ApplyOptions): MergeResult {
  // `--update` means "put our entry back the way coolify-mcp writes it", so the
  // managed entry is REPLACED rather than deep-merged: otherwise a key from the
  // entry we are replacing (`"disabled": true`, a stale connection name) quietly
  // outlives the update and the user has no reason to go looking for it. Only
  // our own entry is affected — the file around it is merged either way, which
  // is what keeps other people's MCP servers intact. The TOML writer below makes
  // the same distinction, and has done since the incident merge/toml.ts records.
  const merge = { replace: options.update === true };

  switch (operation.kind) {
    case 'json-merge':
      return mergeJson(current, operation.keyPath, operation.value, merge);
    case 'json-remove':
      return removeJson(current, operation.keyPath);
    case 'jsonc-merge':
      return mergeJsonc(current, operation.keyPath, operation.value, merge);
    case 'jsonc-remove':
      return removeJsonc(current, operation.keyPath);
    case 'yaml-merge':
      return mergeYaml(current, operation.keyPath, operation.value, merge);
    case 'yaml-remove':
      return removeYaml(current, operation.keyPath);
    case 'toml-append':
      // `--update` is the only thing that turns the add-only TOML writer into
      // one that rewrites a section it did not author. merge/toml.ts explains
      // why the default is this conservative.
      return options.update === true
        ? replaceTomlSection(current, operation.section, operation.text)
        : appendTomlSection(current, operation.section, operation.text);
    case 'toml-replace':
      return replaceTomlSection(current, operation.section, operation.text);
    case 'toml-remove':
      return removeTomlSection(current, operation.section);
    default:
      return { text: current, changed: false, issues: [] };
  }
}

async function loadFile(
  files: Map<string, { before: string | null; after: string }>,
  filePath: string,
): Promise<{ before: string | null; after: string }> {
  const cached = files.get(filePath);
  if (cached !== undefined) return cached;

  let before: string | null = null;
  try {
    before = await fs.readFile(filePath, 'utf8');
  } catch {
    before = null;
  }

  const entry = { before, after: before ?? '' };
  files.set(filePath, entry);
  return entry;
}

/**
 * `diff` and `preview` are display artefacts and are redacted here rather than
 * at the call site. The file we merge into can hold somebody else's plaintext
 * Coolify token, and `--dry-run` output ends up in terminals, issue reports and
 * screen shares — so the redaction has to be a property of the value, not a
 * step a caller has to remember.
 */
function renderFile(filePath: string, file: { before: string | null; after: string }): ApplyFile {
  return {
    path: filePath,
    before: file.before,
    after: file.after,
    diff: redact(unifiedDiff(file.before, file.after, { fromLabel: filePath, toLabel: filePath })),
    preview: redact(file.after),
  };
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const mode = await existingMode(filePath);
  const temporary = `${filePath}.coolify-mcp-${process.pid}.tmp`;

  await fs.writeFile(temporary, contents, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  try {
    // rename is atomic within a filesystem, so an interrupted install can never
    // leave a client with a truncated config and therefore no MCP servers at all.
    await fs.rename(temporary, filePath);
  } catch (error: unknown) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mode & 0o777;
  } catch {
    return undefined;
  }
}

async function runCommand(argv: string[]): Promise<void> {
  const [file, ...args] = argv;
  if (file === undefined) return;
  // No shell. The argv comes from an adapter, and a shell here would turn any
  // future adapter bug into command injection.
  await execFileAsync(file, args, { timeout: NATIVE_CLI_TIMEOUT_MS, windowsHide: true });
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

async function recordOutcome(
  plan: Plan,
  target: TargetPlan,
  state: InstallState,
  options: ApplyOptions,
  method: 'file' | 'native-cli',
): Promise<InstallState> {
  if (plan.action === 'uninstall') {
    return removeRecord(state, target.adapter.id, target.path, target.serverName);
  }

  // Hash what the client will actually read, not what we intended to write: the
  // writers normalise, and a fingerprint of our intention would report drift on
  // the very next run.
  const written = await target.adapter.readEntry(plan.ctx).catch(() => null);
  const now = options.now?.() ?? new Date();

  return upsertRecord(state, {
    adapterId: target.adapter.id,
    path: target.path,
    serverName: target.serverName,
    managedKeyPath: [...target.managedKeyPath],
    method,
    packageSpec: plan.ctx.packageSpec,
    writtenAt: now.toISOString(),
    entryHash: hashEntry(written),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
