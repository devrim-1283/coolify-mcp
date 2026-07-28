/**
 * The one envelope every tool returns, and the graded degradation ladder that
 * keeps it inside the host's context budget.
 *
 * The threat is not theoretical. Coolify's list endpoints do not paginate:
 * GET /applications returns the complete array including the full model and its
 * settings relation — comfortably past 1 MB at ~80 applications — and
 * GET /deployments embeds full build logs per row once the token carries
 * `read:sensitive`. A single get_resource can carry a `docker_compose_raw` of
 * hundreds of KB. Pagination is our problem, not upstream's, and a tool that
 * forgets to shape its payload would blow the host's cap instead of degrading.
 * Routing every return through here is what makes forgetting impossible.
 */

import { createHash } from 'node:crypto';
import {
  CoolifyError,
  type ResponseMeta,
  type ShapeOptions,
  type ToolEnvelope,
  type ToolResult,
  type TruncationKind,
} from '../types.js';
import { projectOne, pruneOne, type Row } from './project.js';
import { redact } from './redact.js';

/**
 * Sits under the ~150,000-character cap claude.ai and Claude Desktop apply,
 * with headroom for the JSON envelope and multibyte characters. Claude Code's
 * ~25k-token ceiling binds first in practice; this is the hard backstop.
 */
export const MAX_RESPONSE_BYTES = 130_000;

/**
 * Headroom held back while measuring. The truncation note and a recomputed
 * cursor are both written after the last measurement, so without a reserve a
 * payload that just fit could be pushed back over by its own explanation.
 */
const META_RESERVE = 1024;

/** Floor for the measurement budget, so an absurd `maxBytes` cannot go negative. */
const MIN_BUDGET = 1024;

/** Bounds the value-capping search; each pass is one walk plus one serialize. */
const MAX_CAP_PASSES = 8;

function valueMarker(bytes: number): string {
  return `<truncated: ${bytes} bytes — fetch in full via execute_read_operation>`;
}

/** Replacing a string shorter than the marker would grow the payload. */
const MARKER_FLOOR = Buffer.byteLength(valueMarker(0), 'utf8');

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

export interface Cursor {
  offset: number;
  queryHash: string;
}

/**
 * Opaque base64url JSON.
 *
 * Opaque rather than a raw offset for two reasons: a model handles "pass this
 * token back" far more reliably than offset arithmetic, and the embedded
 * `queryHash` lets a cursor replayed against different filters be rejected
 * instead of silently paginating through a different result set.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!isPlainObject(parsed)) throw invalidCursor();

  const { offset, queryHash } = parsed;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
    throw invalidCursor();
  if (typeof queryHash !== 'string' || queryHash.length === 0) throw invalidCursor();

  return { offset, queryHash };
}

/**
 * Stable fingerprint of the filters a page was produced under. Our pagination
 * is offset-over-refetch, so a cursor is only meaningful against the query that
 * produced it.
 */
export function queryHash(query: unknown): string {
  return createHash('sha256').update(stableStringify(query)).digest('hex').slice(0, 12);
}

export function assertCursorMatches(cursor: Cursor, hash: string): void {
  if (cursor.queryHash !== hash) {
    throw new CoolifyError(
      "Cursor does not match this query's filters.",
      'validation',
      'Re-run without cursor.',
    );
  }
}

function invalidCursor(): CoolifyError {
  return new CoolifyError(
    'Cursor is not a valid cursor value.',
    'validation',
    'Re-run without cursor.',
  );
}

/** Key order must not affect the hash, or argument order alone would invalidate a cursor. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Row)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export interface EnvelopeMeta {
  instance?: string;
  /** Overrides the derived row count, for tools whose payload is not a list. */
  count?: number;
  total?: number;
  next_cursor?: string;
  /** Factual statement of available next steps. Never a directive about model behaviour. */
  hint?: string;
  errors?: Array<{ instance: string; message: string }>;
  /**
   * Offset of `data[0]` in the full result set, plus the current query hash.
   * When the ladder drops rows, `next_cursor` is recomputed from this so the
   * dropped rows come back on the next page instead of being skipped — a
   * caller-supplied cursor was computed before shaping and would step over them.
   */
  cursor?: Cursor;
}

/**
 * Serialize, and if it does not fit, degrade in graded steps:
 *
 *   1. under budget            -> returned as is
 *   2. drop declared columns   -> truncation: 'field_prune'
 *   3. drop rows               -> truncation: 'row_limit',  truncated: <n>
 *   4. cap oversized values    -> truncation: 'field_value'
 *
 * Each step is strictly more destructive than the last, so the cheapest one
 * that fits is the one that ships.
 */
export function shapeResponse<T>(
  data: T,
  meta: EnvelopeMeta = {},
  opts: ShapeOptions = {},
): ToolEnvelope<T> {
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const budget = Math.max(maxBytes - META_RESERVE, MIN_BUDGET);

  let payload: unknown = opts.fields ? applyProjection(data, opts.fields) : data;

  const rowsBefore = Array.isArray(payload) ? payload.length : 0;
  let droppedRows = 0;
  let prunedFields: readonly string[] = [];
  let cappedValues = 0;
  let truncation: TruncationKind = null;

  const measure = (candidate: unknown): number =>
    byteLength(serialize(provisional(candidate, meta)));
  const fits = (candidate: unknown): boolean => measure(candidate) <= budget;

  // 1. Columns. The cheapest degradation: every row survives, in order.
  if (!fits(payload)) {
    const prunable = opts.prunable ?? [];
    const present = prunable.length > 0 ? collectKeys(payload) : new Set<string>();
    for (let take = 1; take <= prunable.length; take++) {
      const dropping = prunable.slice(0, take);
      payload = applyPrune(payload, dropping);
      // Only claim a field was omitted if it was actually there. A tool's
      // prunable list is written against the newest Coolify; an older instance
      // that never sent the column must not show up in the hint as a loss.
      prunedFields = dropping.filter((field) => present.has(field));
      if (prunedFields.length > 0) truncation = 'field_prune';
      if (fits(payload)) break;
    }
  }

  // 2. Rows. Keep at least one even when it does not fit: the model still needs
  // to see the shape of a record, and step 3 cuts inside it.
  if (!fits(payload) && Array.isArray(payload)) {
    const rows: readonly unknown[] = payload;
    const keep = Math.max(1, largestFittingPrefix(rows, fits));
    if (keep < rows.length) {
      droppedRows = rows.length - keep;
      payload = rows.slice(0, keep);
      truncation = 'row_limit';
    }
  }

  // 3. Values. One `docker_compose_raw` can be the entire overage.
  if (!fits(payload)) {
    const capped = capLargeValues(payload, measure, budget);
    if (capped.count > 0) {
      payload = capped.payload;
      cappedValues = capped.count;
      truncation = 'field_value';
    }
  }

  const build = (): ToolEnvelope<T> => {
    const count =
      meta.count ??
      (Array.isArray(payload) ? payload.length : payload === null || payload === undefined ? 0 : 1);

    let nextCursor = meta.next_cursor;
    if (droppedRows > 0 && meta.cursor) {
      const kept = Array.isArray(payload) ? payload.length : 0;
      nextCursor = encodeCursor({
        offset: meta.cursor.offset + kept,
        queryHash: meta.cursor.queryHash,
      });
    }

    const responseMeta: ResponseMeta = {
      count,
      total: meta.total,
      next_cursor: nextCursor,
      truncated: droppedRows,
      truncation,
      hint: composeHint({
        base: meta.hint,
        maxBytes,
        prunedFields,
        droppedRows,
        rowsBefore,
        cappedValues,
        hasCursor: nextCursor !== undefined,
      }),
      errors: meta.errors,
    };

    return { instance: meta.instance, data: payload as T, meta: responseMeta };
  };

  let envelope = build();

  // Backstop. The reserve should cover the note and the cursor, but callers
  // rely on "never larger than maxBytes" as an invariant, so verify it rather
  // than assume it. Reaching here means structural bulk (thousands of small
  // fields) rather than one large string, which no earlier step can shrink.
  if (byteLength(serialize(envelope)) > maxBytes) {
    payload = valueMarker(byteLength(serialize(payload)));
    cappedValues = Math.max(cappedValues, 1);
    truncation = 'field_value';
    envelope = build();
  }

  return envelope;
}

/**
 * Serialize an envelope into the MCP tool result.
 *
 * The last redaction throat: every byte a tool emits passes through here, so a
 * bearer token cannot reach the transcript via a code path that forgot to
 * redact. Replacement is `***` inside an existing JSON string, so the document
 * stays valid.
 */
export function renderEnvelope(envelope: ToolEnvelope<unknown>): ToolResult {
  return { content: [{ type: 'text', text: redact(serialize(envelope)) }] };
}

// ---------------------------------------------------------------------------
// Ladder internals
// ---------------------------------------------------------------------------

function provisional(payload: unknown, meta: EnvelopeMeta): ToolEnvelope<unknown> {
  return {
    instance: meta.instance,
    data: payload,
    meta: {
      count: Array.isArray(payload) ? payload.length : 1,
      total: meta.total,
      next_cursor: meta.next_cursor,
      truncated: 0,
      truncation: null,
      hint: meta.hint,
      errors: meta.errors,
    },
  };
}

/** Serialized size is monotonic in row count, so binary search is exact. */
function largestFittingPrefix(
  rows: readonly unknown[],
  fits: (candidate: unknown) => boolean,
): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(rows.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function capLargeValues(
  payload: unknown,
  measure: (candidate: unknown) => number,
  budget: number,
): { payload: unknown; count: number } {
  const sizes = collectStringSizes(payload).sort((a, b) => b - a);
  if (sizes.length === 0) return { payload, count: 0 };

  // Analytic first guess: replacing a string of B bytes with its marker frees
  // (B - marker) bytes, so take the fewest largest strings that cover the
  // overage. JSON escaping only ever makes the real saving larger, so the guess
  // cannot overshoot — and destroying more values than necessary is the thing
  // worth avoiding here.
  const overBy = measure(payload) - budget;
  let take = 0;
  let saved = 0;
  while (take < sizes.length && saved < overBy) {
    saved += Math.max((sizes[take] ?? 0) - MARKER_FLOOR, 0);
    take++;
  }
  if (take === 0) take = 1;

  let result: { payload: unknown; count: number } = { payload, count: 0 };
  for (let pass = 0; pass < MAX_CAP_PASSES; pass++) {
    const threshold = sizes[Math.min(take, sizes.length) - 1] ?? MARKER_FLOOR + 1;
    result = replaceStringsFrom(payload, threshold);
    if (measure(result.payload) <= budget || take >= sizes.length) break;
    take = Math.min(sizes.length, take * 2);
  }
  return result;
}

function collectStringSizes(value: unknown): number[] {
  const sizes: number[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const bytes = byteLength(node);
      if (bytes > MARKER_FLOOR) sizes.push(bytes);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (isPlainObject(node)) {
      for (const child of Object.values(node)) walk(child);
    }
  };
  walk(value);
  return sizes;
}

/** Replaces every string at or above `threshold` bytes with its size marker. */
function replaceStringsFrom(
  value: unknown,
  threshold: number,
): { payload: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const bytes = byteLength(node);
      if (bytes >= threshold && bytes > MARKER_FLOOR) {
        count++;
        return valueMarker(bytes);
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) {
      const out: Row = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  const payload = walk(value);
  return { payload, count };
}

/** Union of the keys actually present, so the hint can only name real losses. */
function collectKeys(data: unknown): Set<string> {
  const keys = new Set<string>();
  const add = (row: unknown): void => {
    if (!isPlainObject(row)) return;
    for (const key of Object.keys(row)) keys.add(key);
  };
  if (Array.isArray(data)) for (const row of data) add(row);
  else add(data);
  return keys;
}

function applyProjection(data: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(data))
    return data.map((row) => (isPlainObject(row) ? projectOne(row, fields) : row));
  if (isPlainObject(data)) return projectOne(data, fields);
  return data;
}

function applyPrune(data: unknown, prunable: readonly string[]): unknown {
  if (Array.isArray(data))
    return data.map((row) => (isPlainObject(row) ? pruneOne(row, prunable) : row));
  if (isPlainObject(data)) return pruneOne(data, prunable);
  return data;
}

interface HintParts {
  base?: string;
  maxBytes: number;
  prunedFields: readonly string[];
  droppedRows: number;
  rowsBefore: number;
  cappedValues: number;
  hasCursor: boolean;
}

/**
 * Facts only. A hint that told the model what to do next would be a directive
 * embedded in tool output, which Directory review treats as prompt injection —
 * so every sentence here states what is true or what exists, never what to do.
 */
function composeHint(parts: HintParts): string | undefined {
  const notes: string[] = [];
  if (parts.base) notes.push(parts.base);
  if (parts.prunedFields.length > 0) {
    notes.push(
      `Fields omitted to fit the ${parts.maxBytes}-byte response budget: ${parts.prunedFields.join(', ')}. ` +
        'Full records are available from get_resource.',
    );
  }
  if (parts.droppedRows > 0) {
    // Phrased as a loss rather than "showing N of M": the caller's own hint
    // already reports a page position, and two different "showing" counts in
    // one string is how a reader ends up with the wrong total.
    notes.push(
      `${parts.droppedRows} of ${parts.rowsBefore} rows on this page were dropped to fit the ` +
        `${parts.maxBytes}-byte response budget.` +
        (parts.hasCursor ? ' Pass next_cursor to continue.' : ''),
    );
  }
  if (parts.cappedValues > 0) {
    notes.push(
      `${parts.cappedValues} oversized field value(s) replaced with a size marker; ` +
        'the full value is available via execute_read_operation.',
    );
  }
  return notes.length > 0 ? notes.join(' ') : undefined;
}

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
