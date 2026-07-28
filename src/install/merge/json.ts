/**
 * JSON merge writer — the canonical one.
 *
 * Strategy: parse, deep-merge at the managed key path, re-serialise. Plain JSON
 * carries no comments, so a full re-serialisation loses nothing a user wrote —
 * which is exactly why the JSONC writer next door may NOT use this approach.
 *
 * Two properties are load-bearing and both fall out of the no-op guard below:
 * installing twice produces byte-identical output, and a merge that changes
 * nothing never rewrites the file (so we never reformat `~/.claude.json` — a
 * file that holds a user's entire project history — just to say hello).
 *
 * This module is also where the four writers' shared vocabulary lives: the
 * {@link MergeResult} contract plus the text primitives (BOM, EOL, indent) all
 * four need. A fifth file for three functions and one interface would be worse
 * organisation than one canonical home, and this is the writer the other three
 * are specialisations of.
 */

import type { ValidationIssue } from '../../types.js';

/**
 * What every merge writer returns.
 *
 * `issues` with `severity: 'error'` is the refusal channel: apply() must not
 * write the file, and `text` is guaranteed to equal the input in that case.
 */
export interface MergeResult {
  /** The bytes to write. Identical to the input whenever `changed` is false. */
  text: string;
  changed: boolean;
  issues: ValidationIssue[];
}

export interface MergeOptions {
  /**
   * Replace the value at the managed key path outright instead of deep-merging
   * into it.
   *
   * The two halves of the contract pull in opposite directions and both matter:
   * the SURROUNDING file is always merged — sibling keys and other people's MCP
   * servers must survive — but OUR OWN entry has to be replaceable as a whole,
   * or a key from the version we are replacing (`"disabled": true`, a stale
   * `COOLIFY_CONNECTION`) outlives the update and the user has no reason to go
   * looking for it. Off by default, so an ordinary install still preserves
   * anything a user added inside our entry; `--update` is the explicit "put it
   * back the way coolify-mcp writes it" switch that turns this on.
   */
  replace?: boolean;
}

export interface RemoveOptions {
  /**
   * Delete ancestor containers that our removal left empty.
   *
   * On by default because a container holding nothing but our entry is one we
   * created — leaving `"mcpServers": {}` behind is litter we introduced. The
   * one false positive is a user who wrote an explicitly empty container before
   * we ever ran; callers that know this (from install state) pass `false`.
   */
  pruneEmpty?: boolean;
}

/** Byte-order mark. Some Windows editors add one; round-tripping it is polite. */
export const BOM = '﻿';

/** Default when the file is new or gives no signal. Portable and git-friendly. */
const DEFAULT_EOL = '\n';
const DEFAULT_TAB_SIZE = 2;

export interface IndentStyle {
  insertSpaces: boolean;
  tabSize: number;
}

const DEFAULT_INDENT: IndentStyle = { insertSpaces: true, tabSize: DEFAULT_TAB_SIZE };

// ---------------------------------------------------------------------------
// Text primitives, shared by all four writers
// ---------------------------------------------------------------------------

export function splitBom(source: string): { bom: string; body: string } {
  return source.startsWith(BOM)
    ? { bom: BOM, body: source.slice(BOM.length) }
    : { bom: '', body: source };
}

/**
 * A single CRLF anywhere decides the file: mixed endings are a pre-existing
 * mess and normalising the whole file to "fix" it would bury our one-line
 * change in a whole-file diff.
 */
export function detectEol(source: string): string {
  return source.includes('\r\n') ? '\r\n' : DEFAULT_EOL;
}

/**
 * Smallest positive indent in the file. Taking the minimum rather than the
 * first indented line means a deeply nested opening block cannot report 8-space
 * indentation for a 2-space file.
 */
export function detectIndent(source: string): IndentStyle {
  let tabs = false;
  let smallest = 0;
  for (const line of source.split('\n')) {
    const match = /^([\t ]+)\S/.exec(line);
    const lead = match?.[1];
    if (lead === undefined) continue;
    if (lead.startsWith('\t')) {
      tabs = true;
      continue;
    }
    if (smallest === 0 || lead.length < smallest) smallest = lead.length;
  }
  // Spaces win a tie: a file with both is being edited by two tools, and spaces
  // are what every client in our matrix writes by default.
  if (smallest > 0) return { insertSpaces: true, tabSize: smallest };
  if (tabs) return { insertSpaces: false, tabSize: DEFAULT_TAB_SIZE };
  return DEFAULT_INDENT;
}

/** Argument shape `JSON.stringify` wants. */
export function indentArgument(style: IndentStyle): string | number {
  return style.insertSpaces ? style.tabSize : '\t';
}

export function normalizeEol(text: string, eol: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

export function ensureTrailingNewline(text: string, eol: string): string {
  if (text === '') return text;
  return text.endsWith(eol) ? text : `${text}${eol}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive merge of `patch` into `base`.
 *
 * Objects merge key by key; arrays and primitives REPLACE. Array replacement is
 * not a simplification — concatenating `args` would append `["-y", "coolify-mcp"]`
 * again on every re-install, and idempotency is a tested invariant.
 *
 * Key order follows `base` with new keys appended, so re-serialising a file we
 * already wrote reproduces it byte for byte.
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    out[key] = Object.prototype.hasOwnProperty.call(patch, key)
      ? deepMerge(value, patch[key])
      : value;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  }
  return out;
}

/** Structural equality, used to detect no-op writes. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

/** Reads a nested value, returning undefined rather than throwing on a gap. */
export function getAtPath(root: unknown, keyPath: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of keyPath) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

export function unchanged(source: string, issues: ValidationIssue[] = []): MergeResult {
  return { text: source, changed: false, issues };
}

// ---------------------------------------------------------------------------
// JSON writer
// ---------------------------------------------------------------------------

/**
 * Deep-merges `value` into `keyPath`, leaving every sibling key alone.
 *
 * With `options.replace` the value AT `keyPath` is swapped wholesale instead;
 * everything around it is still merged, because the point of that flag is to
 * rewrite our own entry, not the user's file.
 *
 * An empty or whitespace-only file is treated as `{}` rather than as an error:
 * a client that created the file but never wrote a server into it is a normal
 * state, not a corrupt one.
 */
export function mergeJson(
  source: string,
  keyPath: readonly string[],
  value: unknown,
  options: MergeOptions = {},
): MergeResult {
  const { bom, body } = splitBom(source);
  const parsed = parseJsonRoot(body);
  if (parsed.issue !== undefined) return unchanged(source, [parsed.issue]);

  const updated = setAtPath(parsed.root, keyPath, (existing) =>
    options.replace === true ? value : deepMerge(existing, value),
  );
  if (updated.issue !== undefined) return unchanged(source, [updated.issue]);

  return serialize(source, bom, body, parsed.root, updated.root);
}

/**
 * Deletes the subtree at `keyPath`.
 *
 * Only the managed key path is touched: everything else in the file survives
 * the round trip, which is what makes install -> uninstall byte-identical.
 */
export function removeJson(
  source: string,
  keyPath: readonly string[],
  options: RemoveOptions = {},
): MergeResult {
  const { bom, body } = splitBom(source);
  const parsed = parseJsonRoot(body);
  if (parsed.issue !== undefined) return unchanged(source, [parsed.issue]);
  if (getAtPath(parsed.root, keyPath) === undefined) return unchanged(source);

  const root = deleteAtPath(parsed.root, keyPath, options.pruneEmpty !== false);
  return serialize(source, bom, body, parsed.root, root);
}

function serialize(
  source: string,
  bom: string,
  body: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): MergeResult {
  // The no-op guard. Comparing values rather than text means a file whose
  // formatting differs from ours is left completely alone when we have nothing
  // to add, and a second install is a true byte-level no-op.
  if (deepEqual(before, after)) return unchanged(source);

  const eol = detectEol(body);
  const text = JSON.stringify(after, null, indentArgument(detectIndent(body)));
  const out = bom + ensureTrailingNewline(normalizeEol(text, eol), eol);
  return { text: out, changed: out !== source, issues: [] };
}

interface ParsedRoot {
  root: Record<string, unknown>;
  issue?: ValidationIssue;
}

function parseJsonRoot(body: string): ParsedRoot {
  if (body.trim() === '') return { root: {} };

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error: unknown) {
    return {
      root: {},
      issue: {
        severity: 'error',
        code: 'json-unparseable',
        message: `the file is not valid JSON: ${errorText(error)}`,
        fix: 'Fix the syntax error, or move the file aside and let the client recreate it. coolify-mcp will not write to a file it cannot parse — appending to a broken file hides the real problem.',
      },
    };
  }

  if (!isPlainObject(value)) {
    return {
      root: {},
      issue: {
        severity: 'error',
        code: 'json-root-not-object',
        message: `expected the file to contain a JSON object, found ${describe(value)}.`,
        fix: 'MCP client configs are objects. Check that this is the file you meant.',
      },
    };
  }
  return { root: value };
}

interface PathUpdate {
  root: Record<string, unknown>;
  issue?: ValidationIssue;
}

/**
 * Immutable set: every object on the path is copied, everything off it is
 * shared. Copying is what keeps key order (and therefore output bytes) stable.
 */
function setAtPath(
  root: Record<string, unknown>,
  keyPath: readonly string[],
  update: (existing: unknown) => unknown,
): PathUpdate {
  const head = keyPath[0];
  if (head === undefined) {
    const next = update(root);
    if (!isPlainObject(next)) {
      return {
        root,
        issue: {
          severity: 'error',
          code: 'json-root-not-object',
          message: 'refusing to replace the file root with a non-object value.',
        },
      };
    }
    return { root: next };
  }

  const existing = root[head];
  if (keyPath.length === 1) {
    return { root: { ...root, [head]: update(existing) } };
  }

  if (existing !== undefined && !isPlainObject(existing)) {
    return {
      root,
      issue: {
        severity: 'error',
        code: 'json-key-path-conflict',
        message: `"${head}" already exists and holds ${describe(existing)}, not an object.`,
        fix: `Remove or rename "${head}" so the MCP server list can live there.`,
      },
    };
  }

  const child = setAtPath(isPlainObject(existing) ? existing : {}, keyPath.slice(1), update);
  if (child.issue !== undefined) return { root, issue: child.issue };
  return { root: { ...root, [head]: child.root } };
}

/** Immutable delete, pruning ancestors the delete emptied. Never prunes the root. */
function deleteAtPath(
  root: Record<string, unknown>,
  keyPath: readonly string[],
  pruneEmpty: boolean,
): Record<string, unknown> {
  const head = keyPath[0];
  if (head === undefined) return root;

  if (keyPath.length === 1) {
    const { [head]: _dropped, ...rest } = root;
    return rest;
  }

  const existing = root[head];
  if (!isPlainObject(existing)) return root;

  const child = deleteAtPath(existing, keyPath.slice(1), pruneEmpty);
  if (pruneEmpty && Object.keys(child).length === 0) {
    const { [head]: _dropped, ...rest } = root;
    return rest;
  }
  return { ...root, [head]: child };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
