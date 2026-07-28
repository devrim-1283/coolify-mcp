/**
 * Durable install state: `~/.coolify-mcp/install-state.json`.
 *
 * The installer edits files it does not own, so it has to remember what it
 * wrote. Three behaviours depend on this file and on nothing else:
 *
 *  - **Idempotent install.** A second install of the same version is a no-op
 *    rather than a rewrite.
 *  - **Drift detection.** `entryHash` is the fingerprint of the entry as we
 *    left it. If the entry on disk hashes differently, a human edited it —
 *    install warns and skips instead of reverting their change, and uninstall
 *    refuses instead of deleting it.
 *  - **Honest uninstall.** Without a record we cannot tell our entry from one
 *    the user wrote by hand under the same name, and deleting someone else's
 *    configuration is the one unrecoverable thing this tool could do.
 *
 * Nothing secret is stored here: paths, hashes, timestamps and the package
 * spec. The file is still written 0600 — its contents map a machine's tooling,
 * which is not something to publish by accident.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InstallRecord, InstallState, ValidationIssue } from '../types.js';

export const INSTALL_STATE_SCHEMA = 'coolify-mcp.install.v1';

const STATE_DIR = '.coolify-mcp';
const STATE_FILE = 'install-state.json';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function stateFilePath(homeDir: string): string {
  return path.join(homeDir, STATE_DIR, STATE_FILE);
}

export function emptyState(): InstallState {
  return { schema: INSTALL_STATE_SCHEMA, installs: [] };
}

export interface StateLoad {
  state: InstallState;
  path: string;
  /** Non-fatal: a state file we cannot read means we lose memory, not the run. */
  issues: ValidationIssue[];
}

/**
 * Reads the state file. Every failure degrades to "no state" rather than
 * aborting: install still works without memory, it just loses drift detection
 * for entries it has forgotten, and that is far better than refusing to run
 * because a bookkeeping file got corrupted.
 */
export async function readState(homeDir: string): Promise<StateLoad> {
  const filePath = stateFilePath(homeDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { state: emptyState(), path: filePath, issues: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: emptyState(),
      path: filePath,
      issues: [
        {
          severity: 'warn',
          code: 'install-state-unreadable',
          message: `${filePath} is not valid JSON; continuing without install history.`,
          fix: 'Delete the file to start fresh. Nothing in it is needed to run the MCP server.',
        },
      ],
    };
  }

  const schema = (parsed as { schema?: unknown } | null)?.schema;
  if (schema !== INSTALL_STATE_SCHEMA) {
    return {
      state: emptyState(),
      path: filePath,
      issues: [
        {
          severity: 'warn',
          code: 'install-state-schema',
          message: `${filePath} declares schema "${String(schema)}", expected "${INSTALL_STATE_SCHEMA}".`,
          fix: 'A newer coolify-mcp probably wrote it. Upgrade, or delete the file to start fresh.',
        },
      ],
    };
  }

  const installs = (parsed as { installs?: unknown }).installs;
  return {
    state: {
      schema: INSTALL_STATE_SCHEMA,
      installs: Array.isArray(installs) ? installs.filter(isRecord) : [],
    },
    path: filePath,
    issues: [],
  };
}

/** Writes atomically: a half-written state file would look like drift everywhere. */
export async function writeState(homeDir: string, state: InstallState): Promise<string> {
  const filePath = stateFilePath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });

  const temporary = `${filePath}.tmp-${process.pid}`;
  const body = `${JSON.stringify({ schema: INSTALL_STATE_SCHEMA, installs: state.installs }, null, 2)}\n`;

  await fs.writeFile(temporary, body, { encoding: 'utf8', mode: FILE_MODE });
  await fs.rename(temporary, filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * A record is identified by where it went, not by what it is: the same adapter
 * can legitimately manage several server names, and the same server name can
 * exist in several files.
 */
function sameTarget(
  record: InstallRecord,
  adapterId: string,
  filePath: string,
  serverName: string,
): boolean {
  return (
    record.adapterId === adapterId && record.path === filePath && record.serverName === serverName
  );
}

export function findRecord(
  state: InstallState,
  adapterId: string,
  filePath: string,
  serverName: string,
): InstallRecord | undefined {
  return state.installs.find((record) => sameTarget(record, adapterId, filePath, serverName));
}

/** Replaces the matching record, or appends. Returns a new state. */
export function upsertRecord(state: InstallState, record: InstallRecord): InstallState {
  const exists = state.installs.some((candidate) =>
    sameTarget(candidate, record.adapterId, record.path, record.serverName),
  );
  const installs = exists
    ? state.installs.map((candidate) =>
        sameTarget(candidate, record.adapterId, record.path, record.serverName)
          ? record
          : candidate,
      )
    : [...state.installs, record];

  return { schema: INSTALL_STATE_SCHEMA, installs };
}

/** Drops the matching record. Returns a new state. */
export function removeRecord(
  state: InstallState,
  adapterId: string,
  filePath: string,
  serverName: string,
): InstallState {
  return {
    schema: INSTALL_STATE_SCHEMA,
    installs: state.installs.filter(
      (record) => !sameTarget(record, adapterId, filePath, serverName),
    ),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type Drift =
  /** No record: either a first install, or someone else's entry under our name. */
  | 'unmanaged'
  /** We wrote it and it is gone — nothing to protect. */
  | 'absent'
  /** Byte-for-byte what we left behind. */
  | 'match'
  /** We wrote it and it has changed since. A human edited it. */
  | 'drift';

export function classifyDrift(record: InstallRecord | undefined, onDisk: unknown): Drift {
  if (record === undefined) return 'unmanaged';
  if (onDisk === undefined || onDisk === null) return 'absent';
  return hashEntry(onDisk) === record.entryHash ? 'match' : 'drift';
}

export interface DriftContext {
  serverName: string;
  path: string;
  /** `--update`: install may overwrite an edited entry. */
  update: boolean;
  /** `--force`: uninstall may delete an edited or unrecognised entry. */
  force: boolean;
}

export interface DriftSkip {
  /** One line, for the CLI's result table. */
  reason: string;
  issue: ValidationIssue;
}

/**
 * The drift policy, in one place so `--dry-run` and the real write can never
 * disagree about what will happen.
 *
 * The asymmetry between install and uninstall is deliberate. Install refuses to
 * overwrite an edit because the edit is probably load-bearing — a pinned
 * version, an extra env var — and `--update` puts our version back. Uninstall
 * refuses to delete anything we cannot prove we wrote, because deleting
 * configuration a user wrote by hand is the one genuinely unrecoverable thing
 * this tool could do.
 *
 * What BOTH actions refuse is touching an entry there is no record of writing.
 * An entry under our name that this machine never wrote was put there by a
 * human, and merging our idea of the entry over it is the same class of mistake
 * as deleting it: their `command`, their pinned version and their env block go
 * away, and nothing tells them it happened. Every writer is add-only for that
 * reason, and this is the gate that makes the policy hold before a writer runs.
 */
export function driftSkipReason(
  action: 'install' | 'uninstall',
  drift: Drift,
  onDisk: unknown,
  ctx: DriftContext,
): DriftSkip | undefined {
  if (action === 'install') {
    if (ctx.update) return undefined;

    if (drift === 'drift') {
      return {
        reason: 'entry was edited since install; re-run with --update',
        issue: {
          severity: 'warn',
          code: 'entry-drift',
          message: `the "${ctx.serverName}" entry in ${ctx.path} has changed since coolify-mcp wrote it; leaving it alone.`,
          fix: 'Re-run with --update to replace it with the current entry, or remove the entry by hand first.',
        },
      };
    }

    if (drift === 'unmanaged' && onDisk !== null && onDisk !== undefined) {
      return {
        reason: 'entry was not written by coolify-mcp; re-run with --update',
        issue: {
          severity: 'warn',
          code: 'entry-unmanaged',
          message: `${ctx.path} already has a "${ctx.serverName}" entry that coolify-mcp has no record of writing; leaving it exactly as it is.`,
          fix: 'Re-run with --update to replace it with the current entry, or remove the entry by hand first.',
        },
      };
    }

    return undefined;
  }

  // Nothing on disk: uninstall has nothing to protect.
  if (onDisk === null || onDisk === undefined) return undefined;
  if (ctx.force) return undefined;

  if (drift === 'unmanaged') {
    return {
      reason: 'entry was not written by coolify-mcp; re-run with --force',
      issue: {
        severity: 'warn',
        code: 'entry-unmanaged',
        message: `${ctx.path} has a "${ctx.serverName}" entry that coolify-mcp has no record of writing; leaving it alone.`,
        fix: 'Re-run with --force to remove it anyway, or delete the entry by hand.',
      },
    };
  }

  if (drift === 'drift') {
    return {
      reason: 'entry was edited since install; re-run with --force',
      issue: {
        severity: 'warn',
        code: 'entry-drift',
        message: `the "${ctx.serverName}" entry in ${ctx.path} has been edited since coolify-mcp wrote it; leaving it alone.`,
        fix: 'Re-run with --force to remove it anyway.',
      },
    };
  }

  return undefined;
}

/**
 * Fingerprint of an entry as it appears in the client's config.
 *
 * Canonical (key-sorted) JSON, so a client that rewrites its config file and
 * reorders keys — several of them do — is not mistaken for a user edit. The
 * hash covers the entry only, never the surrounding file: a user adding an
 * unrelated MCP server is not drift in ours.
 */
export function hashEntry(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

function isRecord(value: unknown): value is InstallRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InstallRecord>;
  return (
    typeof candidate.adapterId === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.serverName === 'string' &&
    typeof candidate.entryHash === 'string'
  );
}
