/**
 * YAML merge writer.
 *
 * Uses the `yaml` package's Document round trip rather than `parse` +
 * `stringify`. A plain object round trip is lossy in ways YAML users notice
 * immediately: comments vanish, anchors and aliases are expanded into duplicated
 * literals, and block scalars are re-folded. The Document keeps the original CST
 * for everything it was not asked to change, so our edit shows up as our edit.
 *
 * `lineWidth: 0` disables line folding on output — without it a long `args`
 * entry gets wrapped across lines, which is valid YAML nobody wants to read in
 * a diff.
 */

import { parseDocument } from 'yaml';
import type { ValidationIssue } from '../../types.js';
import {
  deepEqual,
  detectEol,
  ensureTrailingNewline,
  getAtPath,
  isPlainObject,
  normalizeEol,
  splitBom,
  unchanged,
} from './json.js';
import type { MergeOptions, MergeResult, RemoveOptions } from './json.js';

/** Folding turns one long value into an unreviewable multi-line diff. */
const STRINGIFY = { lineWidth: 0 } as const;

/**
 * Merges `value` into `keyPath`, leaf by leaf so untouched keys keep their
 * formatting.
 *
 * `options.replace` sets the whole node instead, so no key of the entry being
 * replaced survives. See {@link MergeOptions} on why that is right for our own
 * entry and wrong for the file around it.
 */
export function mergeYaml(
  source: string,
  keyPath: readonly string[],
  value: unknown,
  options: MergeOptions = {},
): MergeResult {
  const { bom, body } = splitBom(source);
  const doc = parseDocument(body);

  const issue = parseGuard(doc.errors);
  if (issue !== undefined) return unchanged(source, [issue]);

  const before = doc.toJS({ maxAliasCount: -1 }) as unknown;
  if (options.replace === true) {
    if (!deepEqual(getAtPath(before, keyPath), value)) doc.setIn([...keyPath], value);
  } else {
    // Leaf paths are pairwise disjoint, so one `setIn` never invalidates another
    // leaf's comparison — the snapshot taken above stays valid for the whole loop.
    for (const [leafPath, leafValue] of leaves(value)) {
      const fullPath = [...keyPath, ...leafPath];
      if (deepEqual(getAtPath(before, fullPath), leafValue)) continue;
      doc.setIn(fullPath, leafValue);
    }
  }

  return finish(
    source,
    bom,
    body,
    doc.toString(STRINGIFY),
    before,
    doc.toJS({ maxAliasCount: -1 }),
  );
}

/** Deletes the subtree at `keyPath`, then prunes maps the delete emptied. */
export function removeYaml(
  source: string,
  keyPath: readonly string[],
  options: RemoveOptions = {},
): MergeResult {
  const { bom, body } = splitBom(source);
  const doc = parseDocument(body);

  const issue = parseGuard(doc.errors);
  if (issue !== undefined) return unchanged(source, [issue]);

  const before = doc.toJS({ maxAliasCount: -1 }) as unknown;
  if (getAtPath(before, keyPath) === undefined) return unchanged(source);

  doc.deleteIn([...keyPath]);

  if (options.pruneEmpty !== false) {
    // Stop at the first ancestor that still holds something, and never touch
    // the document root — an empty top-level map is a valid config file.
    for (let depth = keyPath.length - 1; depth >= 1; depth -= 1) {
      const ancestor = keyPath.slice(0, depth);
      const node = getAtPath(doc.toJS({ maxAliasCount: -1 }) as unknown, ancestor);
      if (!isPlainObject(node) || Object.keys(node).length > 0) break;
      doc.deleteIn([...ancestor]);
    }
  }

  return finish(
    source,
    bom,
    body,
    doc.toString(STRINGIFY),
    before,
    doc.toJS({ maxAliasCount: -1 }),
  );
}

// ---------------------------------------------------------------------------

function finish(
  source: string,
  bom: string,
  body: string,
  rendered: string,
  before: unknown,
  after: unknown,
): MergeResult {
  // Same no-op guard as the other three writers: nothing moved, nothing is
  // rewritten, so a second install cannot produce different bytes.
  if (deepEqual(before, after)) return unchanged(source);

  const eol = detectEol(body);
  const text = bom + ensureTrailingNewline(normalizeEol(rendered, eol), eol);
  return { text, changed: text !== source, issues: [] };
}

/**
 * Flattens into `[path, value]` pairs. Arrays and empty maps are leaves —
 * `setIn` on an array path replaces it wholesale, which is what we want, since
 * appending to `args` on every install would break idempotency.
 */
function leaves(value: unknown, prefix: readonly string[] = []): Array<[string[], unknown]> {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    return [[[...prefix], value]];
  }
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...prefix, key]));
}

interface YamlErrorLike {
  message: string;
  linePos?: ReadonlyArray<{ line: number; col: number }>;
}

function parseGuard(errors: readonly YamlErrorLike[]): ValidationIssue | undefined {
  const first = errors[0];
  if (first === undefined) return undefined;

  const at = first.linePos?.[0];
  const where = at === undefined ? '' : ` at line ${at.line}, column ${at.col}`;
  return {
    severity: 'error',
    code: 'yaml-unparseable',
    message: `refusing to write: the YAML file does not parse${where}. ${first.message.split('\n')[0] ?? ''}`,
    fix: 'Fix the syntax error before installing. Writing into a file that already fails to parse leaves the client unable to read any of it.',
  };
}
