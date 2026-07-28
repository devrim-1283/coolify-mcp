/**
 * TOML merge writer — deliberately the most conservative of the four.
 *
 * Two rules:
 *
 * 1. ADD-ONLY BY DEFAULT. The file is parsed only to answer "is our section
 *    already there?". If it is not, our section is appended as raw text and
 *    every other byte in the file is preserved exactly. If it is, we change
 *    nothing and warn. Rewriting happens only behind an explicit update flag.
 * 2. A FILE THAT DOES NOT PARSE IS NOT WRITTEN. We return
 *    `codex-config-unparseable` with the parser's line and column instead.
 *    Appending a valid section to a broken file produces a file that is still
 *    broken, but now also longer — and the user's next move (find the syntax
 *    error) just got harder.
 *
 * Why this writer, and not the JSON one's parse/merge/serialise approach:
 *
 * `~/.codex/config.toml` holds every MCP server the user has, plus the rest of
 * their Codex configuration. An earlier tool in this space emitted a `url` key
 * into that file; Codex versions that did not know the key rejected not just
 * the entry but the ENTIRE file, taking every other MCP server down with it.
 * The blast radius of one wrong key here is "none of your tools work", and the
 * user has no reason to suspect the tool that wrote it. So this writer touches
 * as few bytes as it possibly can, and never re-emits config it did not author.
 */

import { TomlError, parse } from 'smol-toml';
import type { ValidationIssue } from '../../types.js';
import { detectEol, ensureTrailingNewline, normalizeEol, splitBom, unchanged } from './json.js';
import type { MergeResult } from './json.js';

export interface TomlDocument {
  table: Record<string, unknown>;
  issue?: ValidationIssue;
}

/**
 * Parses for inspection, converting a syntax error into the refusal issue.
 * Shared with the adapter layer so "how do we report a broken config.toml" has
 * exactly one answer.
 */
export function parseTomlDocument(source: string): TomlDocument {
  const { body } = splitBom(source);
  if (body.trim() === '') return { table: {} };

  try {
    return { table: parse(body) };
  } catch (error: unknown) {
    return { table: {}, issue: unparseable(error) };
  }
}

/** True when the dotted section already exists in the document. */
export function hasTomlSection(table: Record<string, unknown>, section: string): boolean {
  return readTomlSection(table, section) !== undefined;
}

/** The value at a dotted section path, or undefined. */
export function readTomlSection(table: Record<string, unknown>, section: string): unknown {
  let node: unknown = table;
  for (const segment of splitDottedKey(section)) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Appends `sectionText` when `section` is absent; otherwise changes nothing.
 *
 * The no-change path is the important one: an existing section may have been
 * hand-tuned, and silently overwriting a user's `command` because we happen to
 * know a different one is how a tool loses trust.
 */
export function appendTomlSection(
  source: string,
  section: string,
  sectionText: string,
): MergeResult {
  const doc = parseTomlDocument(source);
  if (doc.issue !== undefined) return unchanged(source, [doc.issue]);

  if (hasTomlSection(doc.table, section)) {
    return unchanged(source, [
      {
        severity: 'warn',
        code: 'toml-section-exists',
        message: `[${section}] is already present; leaving it exactly as it is.`,
        fix: 'Re-run with --update to rewrite the section, or edit it by hand. This writer is add-only so it can never clobber configuration it did not write.',
      },
    ]);
  }

  const { bom, body } = splitBom(source);
  const eol = detectEol(body);
  const block = ensureTrailingNewline(normalizeEol(sectionText.trim(), eol), eol);

  let out = body;
  if (out.trim() === '') {
    out = block;
  } else {
    if (!out.endsWith('\n')) out += eol;
    // One blank line before the new section, unless the file already ends with one.
    if (!blankLineAtEnd(out)) out += eol;
    out += block;
  }

  const text = bom + out;
  return { text, changed: text !== source, issues: [] };
}

/**
 * Rewrites an existing section in place, or appends it when absent.
 *
 * Only reachable behind an explicit update flag. Everything outside the
 * section's span — including sections written by other tools — is untouched.
 */
export function replaceTomlSection(
  source: string,
  section: string,
  sectionText: string,
): MergeResult {
  const doc = parseTomlDocument(source);
  if (doc.issue !== undefined) return unchanged(source, [doc.issue]);

  const { bom, body } = splitBom(source);
  const span = findSectionSpan(body, section);
  if (span === undefined) return appendTomlSection(source, section, sectionText);

  const eol = detectEol(body);
  const block = ensureTrailingNewline(normalizeEol(sectionText.trim(), eol), eol);
  const tail = body.slice(span.end);
  // Keep the blank run that separated us from whatever follows, so an update
  // does not quietly restyle the rest of the file.
  const separator =
    span.trailingBlankLines > 0 && tail !== '' ? eol.repeat(span.trailingBlankLines) : '';

  const text = bom + body.slice(0, span.start) + block + separator + tail;
  return { text, changed: text !== source, issues: [] };
}

/** Deletes a section and its sub-tables, restoring the file to its pre-install bytes. */
export function removeTomlSection(source: string, section: string): MergeResult {
  const doc = parseTomlDocument(source);
  if (doc.issue !== undefined) return unchanged(source, [doc.issue]);

  const { bom, body } = splitBom(source);
  const span = findSectionSpan(body, section);
  if (span === undefined) return unchanged(source);

  const tail = body.slice(span.end);
  // The blank line above our header is ours when we are the last section (we
  // added it on append); between two other sections it is their separator and
  // must survive.
  const start = tail === '' ? span.blankStart : span.start;

  const text = bom + body.slice(0, start) + tail;
  return { text, changed: text !== source, issues: [] };
}

// ---------------------------------------------------------------------------
// Span scanning
// ---------------------------------------------------------------------------

interface SectionSpan {
  /** Offset of the section header line. */
  start: number;
  /** Offset of the blank run immediately above the header. */
  blankStart: number;
  /** Offset of the next unrelated header, or the end of the file. */
  end: number;
  trailingBlankLines: number;
}

interface HeaderLine {
  segments: string[];
  start: number;
  end: number;
}

/**
 * Locates `[section]` and everything belonging to it, up to the next header
 * that is neither the section nor one of its sub-tables.
 */
function findSectionSpan(body: string, section: string): SectionSpan | undefined {
  const target = splitDottedKey(section);
  const headers = scanHeaders(body);

  const index = headers.findIndex((header) => sameKey(header.segments, target));
  const header = headers[index];
  if (header === undefined) return undefined;

  let end = body.length;
  for (const next of headers.slice(index + 1)) {
    if (isDescendant(next.segments, target)) continue;
    end = next.start;
    break;
  }

  const content = body.slice(header.start, end);
  const trailing = /(?:\r?\n[ \t]*)*$/.exec(content)?.[0] ?? '';
  const trailingBlankLines = Math.max(0, (trailing.match(/\n/g)?.length ?? 0) - 1);

  return {
    start: header.start,
    blankStart: blankRunStart(body, header.start),
    end,
    trailingBlankLines,
  };
}

/**
 * Finds every table header, skipping `[` characters that are inside strings or
 * inside a multi-line array value.
 *
 * This is a scanner, not a TOML parser — but the document has already been
 * parsed successfully by the time we get here, so it only has to be right about
 * well-formed input. The two traps it exists to avoid: a `[` on its own line
 * inside a nested array literal, and a `[` inside a multi-line string.
 */
function scanHeaders(body: string): HeaderLine[] {
  const headers: HeaderLine[] = [];
  let multiline: '"""' | "'''" | undefined;
  let arrayDepth = 0;
  let offset = 0;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const lineStart = offset;
    offset += rawLine.length + 1;

    let cursor = 0;
    if (multiline !== undefined) {
      const close = line.indexOf(multiline);
      if (close === -1) continue;
      cursor = close + 3;
      multiline = undefined;
    }

    const trimmed = line.slice(cursor).trimStart();
    if (arrayDepth === 0 && trimmed.startsWith('[')) {
      const segments = parseHeader(trimmed);
      if (segments !== undefined) {
        headers.push({ segments, start: lineStart, end: lineStart + rawLine.length });
        continue;
      }
    }

    const state = scanLine(line, cursor, arrayDepth);
    arrayDepth = state.arrayDepth;
    multiline = state.multiline;
  }

  return headers;
}

interface LineState {
  arrayDepth: number;
  multiline?: '"""' | "'''";
}

function scanLine(line: string, from: number, depth: number): LineState {
  let arrayDepth = depth;
  let i = from;

  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') break;

    // A triple quote that closes on the same line is an ordinary value; only an
    // unterminated one carries state into the next line.
    if (line.startsWith('"""', i)) {
      const close = line.indexOf('"""', i + 3);
      if (close === -1) return { arrayDepth, multiline: '"""' };
      i = close + 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      const close = line.indexOf("'''", i + 3);
      if (close === -1) return { arrayDepth, multiline: "'''" };
      i = close + 3;
      continue;
    }
    if (ch === '"') {
      i = skipBasicString(line, i) + 1;
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) break;
      i = close + 1;
      continue;
    }

    if (ch === '[') arrayDepth += 1;
    else if (ch === ']') arrayDepth = Math.max(0, arrayDepth - 1);
    i += 1;
  }

  return { arrayDepth };
}

/** Returns the index of the closing quote, or the last index when unterminated. */
function skipBasicString(line: string, open: number): number {
  for (let i = open + 1; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '"') return i;
  }
  return line.length;
}

/** `[a.b]` / `[[a.b]]` / `[ a."b c" ]` -> segments, or undefined when not a header. */
function parseHeader(trimmed: string): string[] | undefined {
  const match = /^\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(trimmed);
  const inner = match?.[1];
  if (inner === undefined || inner.trim() === '') return undefined;
  return splitDottedKey(inner);
}

/** Offset of the start of the blank-line run immediately above `start`. */
function blankRunStart(body: string, start: number): number {
  let index = start;
  while (index > 0) {
    // `index` always sits on a line start, so index - 1 is the newline that
    // terminated the line above it.
    const previousLineEnd = index - 1;
    if (body[previousLineEnd] !== '\n') break;
    const previousLineStart =
      previousLineEnd === 0 ? 0 : body.lastIndexOf('\n', previousLineEnd - 1) + 1;
    if (body.slice(previousLineStart, previousLineEnd).trim() !== '') break;
    index = previousLineStart;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Dotted keys
// ---------------------------------------------------------------------------

/** Splits `mcp_servers."my.server".env` into segments, honouring quoting. */
export function splitDottedKey(key: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < key.length; i += 1) {
    const ch = key[i];
    if (ch === undefined) break;

    if (quote !== undefined) {
      if (ch === '\\' && quote === '"') {
        const next = key[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
          continue;
        }
      }
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '.') {
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  segments.push(current.trim());
  return segments.filter((segment) => segment !== '');
}

function sameKey(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function isDescendant(candidate: readonly string[], ancestor: readonly string[]): boolean {
  return (
    candidate.length > ancestor.length &&
    ancestor.every((segment, index) => segment === candidate[index])
  );
}

function blankLineAtEnd(text: string): boolean {
  return /\r?\n[ \t]*\r?\n$/.test(text);
}

function unparseable(error: unknown): ValidationIssue {
  const where = error instanceof TomlError ? ` at line ${error.line}, column ${error.column}` : '';
  // smol-toml appends a source excerpt to `message`; the first line is the
  // diagnosis and the rest would just be the file echoed back at the user.
  const detail = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);

  return {
    severity: 'error',
    code: 'codex-config-unparseable',
    message: `refusing to write: the TOML file does not parse${where}. ${detail}`,
    fix: 'Fix the syntax error first. Appending a section to a file that already fails to parse leaves every MCP server in it broken and hides which edit caused it.',
  };
}
