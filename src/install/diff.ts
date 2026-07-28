/**
 * Unified diff rendering for `--dry-run`.
 *
 * `--dry-run` is only trustworthy if it shows the bytes that would actually be
 * written, which is why the planner produces file content and this module
 * diffs that content against the disk. There is no separate "preview"
 * code path that could drift from the real one.
 *
 * Hand-rolled rather than pulled from npm: the inputs are config files, the
 * output goes to a terminal, and a diff library is a dependency in the install
 * path of a tool whose whole pitch includes "runs under npx with no native
 * modules".
 */

/** Beyond this the quadratic LCS is not worth it; the fallback is still correct. */
const MAX_LCS_CELLS = 4_000_000;

export interface DiffOptions {
  /** Left-hand label. Defaults to the path, or `/dev/null` when the file is new. */
  fromLabel?: string;
  toLabel?: string;
  /** Unchanged lines shown around each change. */
  context?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

const DEFAULT_CONTEXT = 3;

/**
 * Renders `before` -> `after` as a unified diff, or '' when they are identical.
 *
 * `null` means "the file does not exist", which is a different statement from
 * "the file is empty" and is labelled as such.
 */
export function unifiedDiff(
  before: string | null,
  after: string | null,
  options: DiffOptions = {},
): string {
  if (before === after) return '';

  const from = toLines(before ?? '');
  const to = toLines(after ?? '');
  const context = options.context ?? DEFAULT_CONTEXT;

  const ops = diffLines(from.lines, to.lines);
  const hunks = groupHunks(ops, context, from, to);

  if (hunks.length === 0) {
    // Same lines, different bytes: the only things left are line endings and a
    // BOM. Say so explicitly — an empty diff next to "would rewrite this file"
    // reads as a bug in the tool.
    return `${header(before, after, options)}${invisibleChangeNote(before ?? '', after ?? '')}\n`;
  }

  return `${header(before, after, options)}${hunks.join('')}`;
}

export function diffStats(before: string | null, after: string | null): DiffStats {
  const ops = diffLines(toLines(before ?? '').lines, toLines(after ?? '').lines);
  return {
    added: ops.filter((op) => op.type === '+').length,
    removed: ops.filter((op) => op.type === '-').length,
  };
}

// ---------------------------------------------------------------------------

interface Lines {
  lines: string[];
  endsWithNewline: boolean;
}

/**
 * Splits on `\n` and drops a trailing `\r` for display, so a CRLF file diffs
 * against an LF one on content rather than on every single line.
 */
function toLines(text: string): Lines {
  if (text === '') return { lines: [], endsWithNewline: true };
  const raw = text.split('\n');
  const endsWithNewline = raw[raw.length - 1] === '';
  if (endsWithNewline) raw.pop();
  return {
    lines: raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)),
    endsWithNewline,
  };
}

function header(before: string | null, after: string | null, options: DiffOptions): string {
  const from = options.fromLabel ?? (before === null ? '/dev/null' : 'a');
  const to = options.toLabel ?? (after === null ? '/dev/null' : 'b');
  return `--- ${from}\n+++ ${to}\n`;
}

function invisibleChangeNote(before: string, after: string): string {
  const notes: string[] = [];
  if (before.startsWith('﻿') !== after.startsWith('﻿')) notes.push('byte-order mark');
  if (before.includes('\r\n') !== after.includes('\r\n')) notes.push('line endings');
  if (notes.length === 0) notes.push('trailing whitespace');
  return `# no visible line changes; only ${notes.join(' and ')} differ`;
}

interface Op {
  type: ' ' | '-' | '+';
  text: string;
  /** 1-based line number on the side this op belongs to. */
  fromLine: number;
  toLine: number;
}

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const ops: Op[] = [];
  let fromLine = 0;
  let toLine = 0;
  const push = (type: Op['type'], text: string): void => {
    if (type !== '+') fromLine += 1;
    if (type !== '-') toLine += 1;
    ops.push({ type, text, fromLine, toLine });
  };

  for (let i = 0; i < prefix; i += 1) push(' ', a[i] ?? '');

  // Trimming the common prefix and suffix first is what keeps the usual case —
  // one MCP entry added to an otherwise untouched file — linear.
  for (const op of middleOps(midA, midB)) push(op.type, op.text);

  for (let i = a.length - suffix; i < a.length; i += 1) push(' ', a[i] ?? '');

  return ops;
}

function middleOps(
  a: readonly string[],
  b: readonly string[],
): Array<{ type: Op['type']; text: string }> {
  if (a.length === 0) return b.map((text) => ({ type: '+' as const, text }));
  if (b.length === 0) return a.map((text) => ({ type: '-' as const, text }));

  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
    // Degrade to a whole-block replacement rather than allocating a table we
    // cannot afford. Still a correct diff, just a coarser one.
    return [
      ...a.map((text) => ({ type: '-' as const, text })),
      ...b.map((text) => ({ type: '+' as const, text })),
    ];
  }

  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  const ops: Array<{ type: Op['type']; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ type: '-', text: a[i] ?? '' });
      i += 1;
    } else {
      ops.push({ type: '+', text: b[j] ?? '' });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: '-', text: a[i++] ?? '' });
  while (j < b.length) ops.push({ type: '+', text: b[j++] ?? '' });
  return ops;
}

function groupHunks(ops: readonly Op[], context: number, from: Lines, to: Lines): string[] {
  const changed = ops.reduce<number[]>((acc, op, index) => {
    if (op.type !== ' ') acc.push(index);
    return acc;
  }, []);
  if (changed.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map((range) => renderHunk(ops.slice(range.start, range.end), from, to));
}

function renderHunk(ops: readonly Op[], from: Lines, to: Lines): string {
  const fromCount = ops.filter((op) => op.type !== '+').length;
  const toCount = ops.filter((op) => op.type !== '-').length;
  const first = ops[0];
  if (first === undefined) return '';

  const fromStart =
    fromCount === 0 ? first.fromLine : (ops.find((op) => op.type !== '+')?.fromLine ?? 1);
  const toStart = toCount === 0 ? first.toLine : (ops.find((op) => op.type !== '-')?.toLine ?? 1);

  const lines = [`@@ -${fromStart},${fromCount} +${toStart},${toCount} @@`];
  for (const op of ops) {
    lines.push(`${op.type}${op.text}`);
    if (op.type !== '+' && op.fromLine === from.lines.length && !from.endsWithNewline) {
      lines.push('\\ No newline at end of file');
    } else if (op.type === '+' && op.toLine === to.lines.length && !to.endsWithNewline) {
      lines.push('\\ No newline at end of file');
    }
  }
  return `${lines.join('\n')}\n`;
}
