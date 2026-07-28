/**
 * Internal scaffolding shared by the MCP client adapters.
 *
 * Deliberately NOT a writer and NOT a factory: the config *shapes* differ enough
 * between clients that abstracting the entry body would hide exactly the details
 * that break installs (Cursor's `${env:NAME}`, OpenCode's `command` array,
 * Zed's `context_servers`). What is shared here is only the boring, identical
 * part — reading a file, walking a key path, and the vocabulary each adapter
 * declares itself with.
 */

import { access, readFile } from 'node:fs/promises';
import { posix as posixPath, win32 as win32Path } from 'node:path';

import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

import type { Detection, InstallCtx, Operation, ValidationIssue } from '../../types.js';

/**
 * The server key every adapter manages.
 *
 * `planRemove(ctx)` receives no ServerEntry, so the name cannot come from the
 * caller there. Uninstall of a *renamed* entry is driven by
 * `InstallRecord.managedKeyPath`, which the state file records at write time.
 */
export const MANAGED_SERVER_NAME = 'coolify';

export type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'yaml';

/**
 * Path arithmetic follows `ctx.platform`, not the host.
 *
 * In production the two are always the same. In CI they are not: the golden
 * fixtures assert the Windows `%APPDATA%` locations and the `cmd /c` wrapper
 * from a Linux runner, and plain `node:path` would emit POSIX separators for a
 * win32 context — a fixture that passes while describing a path that cannot
 * exist.
 */
export function pathFor(ctx: InstallCtx): typeof win32Path {
  return ctx.platform === 'win32' ? win32Path : posixPath;
}

/**
 * How a client expands variable references inside its MCP env block.
 *
 * This is the single most dangerous field in the file. The failure is silent:
 * paste a Claude Code `${COOLIFY_API_TOKEN}` into Cursor and the server receives
 * that reference as literal text for its bearer token, then reports a 401 that
 * looks like a bad token rather than a bad config.
 */
export type InterpolationStyle =
  /** `${VAR}` and `${VAR:-default}`, expanded anywhere in the value. */
  | 'dollar-brace'
  /** `${env:VAR}`. No default-value syntax. */
  | 'dollar-env'
  /** Client stores values verbatim — a reference would be written as text. */
  | 'none';

/** The declarative part of an adapter: identity, location class, confidence. */
export interface AdapterSpec {
  /** e.g. "codex-user" */
  id: string;
  /** e.g. "codex" — also the prefix of every ValidationIssue code. */
  client: string;
  scope: 'user' | 'project';
  label: string;
  format: ConfigFormat;
  confidence: 'verified' | 'unverified';
  /** Extra `--client` spellings accepted besides `id` and `client`. */
  aliases?: readonly string[];
  /** Absolute paths whose existence suggests the client is installed. */
  markerPaths: (ctx: InstallCtx) => readonly string[];
  /**
   * Explains why resolvePath() is a best guess, or undefined when it is
   * documented. Takes the ctx because confidence in a path is per-OS: Zed's
   * location is documented for macOS and Linux but derived on Windows, and
   * Claude Desktop's is the other way round. A flat string would warn everyone
   * about a path that is only uncertain for some of them, which trains users to
   * ignore the warning.
   */
  pathUnconfirmed?: (ctx: InstallCtx) => string | undefined;
}

// ---------------------------------------------------------------------------
// Target matching
// ---------------------------------------------------------------------------

export function supportsTarget(spec: AdapterSpec, target: string): boolean {
  const wanted = target.trim().toLowerCase();
  if (wanted.length === 0) return false;
  if (wanted === spec.id || wanted === spec.client) return true;
  return (spec.aliases ?? []).some((alias) => alias === wanted);
}

// ---------------------------------------------------------------------------
// Reading and parsing
// ---------------------------------------------------------------------------

type ReadResult =
  { kind: 'missing' } | { kind: 'unreadable'; message: string } | { kind: 'text'; text: string };

async function readConfigFile(path: string): Promise<ReadResult> {
  try {
    return { kind: 'text', text: await readFile(path, 'utf8') };
  } catch (error: unknown) {
    // ENOENT is the ordinary "not installed yet" case; anything else (EACCES on
    // a root-owned dotfile, EISDIR on a mis-resolved path) is a real problem the
    // user has to see, so the two are not collapsed into one null.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  }
}

type ParseResult = { ok: true; value: unknown } | { ok: false; message: string };

export function parseConfig(raw: string, format: ConfigFormat): ParseResult {
  // Editors and PowerShell redirection leave a BOM; every parser below chokes
  // on it. Stripping affects reading only — the merge writers own byte fidelity.
  const text = raw.replace(/^\uFEFF/, '');

  // A touched-but-empty config is normal and should not read as corrupt.
  if (text.trim().length === 0) return { ok: true, value: {} };

  try {
    switch (format) {
      case 'json':
        return { ok: true, value: JSON.parse(text) };
      case 'jsonc': {
        const errors: ParseError[] = [];
        const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
        const first = errors[0];
        if (first) {
          return {
            ok: false,
            message: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
          };
        }
        return { ok: true, value };
      }
      case 'toml':
        return { ok: true, value: parseToml(text) };
      case 'yaml':
        return { ok: true, value: parseYaml(text) };
    }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks a key path, returning null rather than throwing on any miss. */
export function readAtKeyPath(root: unknown, keyPath: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of keyPath) {
    if (!isRecord(cursor)) return null;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return null;
    cursor = cursor[key];
  }
  return cursor ?? null;
}

// ---------------------------------------------------------------------------
// McpClientAdapter method bodies that are genuinely identical everywhere
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectConfig(
  spec: AdapterSpec,
  path: string,
  ctx: InstallCtx,
): Promise<Detection> {
  const read = await readConfigFile(path);
  const configExists = read.kind === 'text';

  // Nothing to fail on when there is no file — `parseable: false` is reserved
  // for a file that exists and is broken, which is what blocks a merge.
  let parseable = true;
  if (read.kind === 'text') parseable = parseConfig(read.text, spec.format).ok;
  else if (read.kind === 'unreadable') parseable = false;

  const markers = await Promise.all(spec.markerPaths(ctx).map(pathExists));
  return { installed: configExists || markers.includes(true), configExists, parseable, path };
}

export async function readEntryAt(
  path: string,
  format: ConfigFormat,
  keyPath: readonly string[],
): Promise<unknown> {
  const read = await readConfigFile(path);
  if (read.kind !== 'text') return null;
  const parsed = parseConfig(read.text, format);
  if (!parsed.ok) return null;
  return readAtKeyPath(parsed.value, keyPath);
}

export async function baseValidate(
  spec: AdapterSpec,
  ctx: InstallCtx,
  path: string,
  keyPath: readonly string[],
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  if (spec.confidence === 'unverified') {
    issues.push({
      severity: 'warn',
      code: `${spec.client}-unverified`,
      message: `The ${spec.label} config shape has not been verified against upstream documentation, so this adapter will not write.`,
      fix:
        'Run `coolify-mcp install --client ' +
        spec.client +
        ' --print` and apply the snippet by hand after confirming the key.',
    });
  }

  const read = await readConfigFile(path);

  if (read.kind === 'unreadable') {
    issues.push({
      severity: 'error',
      code: `${spec.client}-config-unreadable`,
      message: `${path} exists but could not be read: ${read.message}`,
      fix: 'Check file ownership and permissions, then re-run.',
    });
    return issues;
  }

  if (read.kind === 'missing') {
    // Only worth saying when the file is absent: if it is there, the path was
    // right and the caveat is noise.
    const caveat = spec.pathUnconfirmed?.(ctx);
    if (caveat) {
      issues.push({
        severity: 'info',
        code: `${spec.client}-path-unconfirmed`,
        message: `No config found at ${path}. ${caveat}`,
        fix: 'Confirm the location this client uses on your OS and report it upstream so the adapter can be corrected.',
      });
    }
    return issues;
  }

  const parsed = parseConfig(read.text, spec.format);
  if (!parsed.ok) {
    issues.push({
      severity: 'error',
      code: `${spec.client}-config-unparseable`,
      message: `${path} is not valid ${spec.format.toUpperCase()}: ${parsed.message}`,
      // Appending to a file we cannot parse is how one bad key takes out every
      // other MCP server in it. Refusing early keeps the damage at zero.
      fix: 'Repair or restore the file first — coolify-mcp refuses to merge into a config it cannot parse.',
    });
    return issues;
  }

  if (readAtKeyPath(parsed.value, keyPath) !== null) {
    issues.push({
      severity: 'info',
      code: `${spec.client}-entry-exists`,
      message: `${keyPath.join('.')} already exists in ${path}.`,
      fix: 'Installing again replaces the managed entry; run `coolify-mcp uninstall` first to remove it cleanly.',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Entry-body plumbing
// ---------------------------------------------------------------------------

/** Whole-value reference, e.g. `${COOLIFY_API_TOKEN}` or `${PORT:-8000}`. */
const WHOLE_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;
const ANY_PLACEHOLDER = /\$\{/;

export interface InterpolationResult {
  env: Record<string, string>;
  /** Keys dropped because the client would have stored the reference as text. */
  dropped: string[];
}

/**
 * Rewrites the canonical `${VAR}` env block into the target client's syntax,
 * dropping any reference the client cannot expand.
 *
 * Dropping is the whole point: the installer writes *pointer* config only, so
 * "client cannot expand this" must never degrade into "write the secret in
 * plaintext". The worst outcome an adapter is allowed to produce is an entry
 * that is missing a variable, never one that leaks a credential.
 */
export function applyInterpolation(
  env: Readonly<Record<string, string>>,
  style: InterpolationStyle,
): InterpolationResult {
  // Claude Code expands references anywhere inside a value, so the canonical
  // entry is already correct and rewriting could only corrupt it.
  if (style === 'dollar-brace') return { env: { ...env }, dropped: [] };

  const out: Record<string, string> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (!ANY_PLACEHOLDER.test(value)) {
      out[key] = value;
      continue;
    }

    const match = style === 'dollar-env' ? WHOLE_PLACEHOLDER.exec(value) : null;
    const name = match?.[1];
    if (name) {
      // Cursor has no default-value syntax, so a `${VAR:-default}` default is
      // discarded rather than smuggled into the variable name.
      out[key] = `\${env:${name}}`;
      continue;
    }

    dropped.push(key);
  }

  return { env: out, dropped };
}

/**
 * Explains a dropped reference. Only ever names the *variable*, never a value,
 * so this text is safe on any stream.
 */
export function droppedRefNote(spec: AdapterSpec, dropped: readonly string[]): Operation[] {
  if (dropped.length === 0) return [];
  return [
    {
      kind: 'note',
      level: 'warn',
      message:
        `${spec.label} is not confirmed to expand \${VAR} references inside its MCP env block, so ` +
        `${dropped.join(', ')} was left out of the entry instead of being written as a literal value. ` +
        `Export the variable in the environment ${spec.label} inherits, or define the connection in a ` +
        `coolify-mcp registry file (tokenEnv / tokenCommand / tokenKeychain) and select it with COOLIFY_CONNECTION.`,
    },
  ];
}

/**
 * mkdir for configs that live in their own directory.
 *
 * Skipped when the file sits directly in $HOME or the project root: those always
 * exist, and a no-op line in `--dry-run` output is noise the user has to read.
 */
export function mkdirOps(configPath: string, ctx: InstallCtx): Operation[] {
  const dir = pathFor(ctx).dirname(configPath);
  if (dir === ctx.homeDir || dir === ctx.projectRoot) return [];
  return [{ kind: 'mkdir', path: dir }];
}
