/**
 * Log shaping.
 *
 * Logs get a byte budget rather than a line budget, because a single line can
 * be a 40 KB stack trace: "last 200 lines" is not a bound on anything.
 */

/**
 * Deliberately well under the response budget. Logs are almost always fetched
 * alongside other context in the same turn, and the tail is where the answer
 * is — a bigger head does not buy a better answer.
 */
export const MAX_LOG_BYTES = 60_000;

/**
 * Room kept back for the omission marker, so trimming to the budget and then
 * prefixing the marker cannot put the result back over it.
 */
const MARKER_RESERVE = 96;

/**
 * CSI and OSC escape sequences. Pattern from the `ansi-regex` package (MIT);
 * inlined because this server ships zero non-essential dependencies.
 *
 * Safe to hold at module scope despite the /g flag: `String.replace` resets
 * `lastIndex`, and this regex is never used with `.test()`.
 */
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g',
);

export interface LogShapeOptions {
  maxBytes?: number;
  /** Extra cap on lines, applied before the byte budget. */
  maxLines?: number;
}

export interface ShapedLog {
  text: string;
  /** Whole lines dropped from the front. */
  omittedLines: number;
  /** Bytes dropped from the front, including any partially dropped line. */
  omittedBytes: number;
  truncated: boolean;
}

/**
 * Coolify build logs are saturated with colour codes. They carry zero
 * information for a model and cost real tokens, so stripping them is free
 * budget — several hundred bytes on a busy build line.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Strip ANSI, then trim from the FRONT to the byte budget.
 *
 * Front, not back: a build or runtime log ends with the failure, and the
 * failure is the reason anyone asked. Whole lines are kept wherever possible so
 * the result stays greppable; a single line larger than the whole budget is cut
 * mid-line on a UTF-8 code point boundary.
 */
export function shapeLogs(raw: string, opts: LogShapeOptions = {}): ShapedLog {
  const maxBytes = opts.maxBytes ?? MAX_LOG_BYTES;
  // CRLF -> LF is lossless for text and makes line accounting honest; bare \r
  // (docker progress redraws) is left alone because collapsing it would drop
  // content, not just presentation.
  const normalized = stripAnsi(raw).replace(/\r\n/g, '\n');

  let lines = normalized.split('\n');
  let omittedLines = 0;
  let omittedBytes = 0;

  if (opts.maxLines !== undefined && opts.maxLines >= 0 && lines.length > opts.maxLines) {
    const cut = lines.length - opts.maxLines;
    const dropped = lines.slice(0, cut);
    lines = lines.slice(cut);
    omittedLines += cut;
    omittedBytes += byteLength(dropped.join('\n')) + (lines.length > 0 ? 1 : 0);
  }

  let body = lines.join('\n');

  if (byteLength(body) > maxBytes) {
    const budget = Math.max(maxBytes - MARKER_RESERVE, 0);
    const before = byteLength(body);
    const keep = countTailLinesWithin(lines, budget);

    if (keep === 0) {
      // Even the last line alone busts the budget — the 40 KB stack trace case.
      const last = lines[lines.length - 1] ?? '';
      body = tailBytes(last, budget);
      omittedLines += Math.max(lines.length - 1, 0);
    } else {
      body = lines.slice(lines.length - keep).join('\n');
      omittedLines += lines.length - keep;
    }
    omittedBytes += before - byteLength(body);
  }

  if (omittedLines === 0 && omittedBytes === 0) {
    return { text: body, omittedLines: 0, omittedBytes: 0, truncated: false };
  }

  return {
    text: `${omissionMarker(omittedLines, omittedBytes)}\n${body}`,
    omittedLines,
    omittedBytes,
    truncated: true,
  };
}

function omissionMarker(lines: number, bytes: number): string {
  return lines > 0
    ? `[... ${lines} earlier lines omitted, ${bytes} bytes ...]`
    : `[... ${bytes} earlier bytes omitted ...]`;
}

/** How many trailing lines fit in `budget`, joined by newlines. */
function countTailLinesWithin(lines: readonly string[], budget: number): number {
  let used = 0;
  let kept = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = byteLength(lines[i] ?? '') + (kept > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    kept++;
  }
  return kept;
}

/**
 * Last `maxBytes` bytes of `s`, advanced past any UTF-8 continuation byte so a
 * multi-byte character is never cut in half into a replacement character.
 */
function tailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.toString('utf8', start);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
