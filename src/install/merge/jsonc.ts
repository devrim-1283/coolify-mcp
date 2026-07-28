/**
 * JSONC merge writer.
 *
 * NON-NEGOTIABLE: this writer edits text through `jsonc-parser`'s
 * `modify()` + `applyEdits()`. A `JSON.parse` / `JSON.stringify` round trip is
 * FORBIDDEN here and the adapter contract says so, because it silently deletes
 * every comment and trailing comma in the file.
 *
 * The concrete case is Zed: `settings.json` is JSONC, Zed's own default file
 * ships full of comments, and users annotate theirs. Destroying that on
 * `coolify-mcp install` is a support ticket per user, and the user has no way
 * to know we did it until they next open the file.
 *
 * `modify()` returns minimal edits, so everything outside the property we touch
 * — comments, trailing commas, blank lines, the container's other servers —
 * survives untouched. The one cosmetic exception is a sibling written on a
 * single line (`"other": { "command": "x" }`), which the formatter expands when
 * it re-emits the container on insertion. That is a whitespace change to
 * machine-written text and costs no information.
 */

import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import type { FormattingOptions, JSONPath, Node, ParseError } from 'jsonc-parser';
import type { ValidationIssue } from '../../types.js';
import {
  deepEqual,
  deepMerge,
  detectEol,
  detectIndent,
  ensureTrailingNewline,
  getAtPath,
  isPlainObject,
  splitBom,
  unchanged,
} from './json.js';
import type { MergeOptions, MergeResult, RemoveOptions } from './json.js';

/** Comments and trailing commas are the point; empty content is a fresh file. */
const PARSE_OPTIONS = {
  disallowComments: false,
  allowTrailingComma: true,
  allowEmptyContent: true,
} as const;

/**
 * Merges `value` into `keyPath`, editing text rather than rewriting the file.
 *
 * A brand-new entry goes in as one insertion. An entry that already exists is
 * updated leaf by leaf, which keeps the diff to the values that actually
 * changed and preserves comments a user put inside our own entry.
 *
 * `options.replace` overrides that: the whole property value is written as one
 * edit so no key of the entry being replaced can survive. It costs the comments
 * INSIDE our own entry, which is the trade `--update` is asking for — a comment
 * annotating a version we are deliberately overwriting is no longer true.
 */
export function mergeJsonc(
  source: string,
  keyPath: readonly string[],
  value: unknown,
  options: MergeOptions = {},
): MergeResult {
  const { bom, body } = splitBom(source);
  const guard = parseGuard(body);
  if (guard !== undefined) return unchanged(source, [guard]);

  const eol = detectEol(body);
  const formatting = formattingOptions(body, eol);
  const existing = getAtPath(readValue(body), keyPath);
  const replace = options.replace === true;
  const merged = replace ? value : deepMerge(existing, value);

  let text = body;
  if (replace || existing === undefined || !isPlainObject(merged)) {
    text = applyEdits(text, modify(text, [...keyPath], merged, { formattingOptions: formatting }));
  } else {
    // Leaf-by-leaf so an unchanged install emits zero edits and a changed one
    // rewrites only the values that moved.
    for (const [leafPath, leafValue] of leaves(merged)) {
      const fullPath = [...keyPath, ...leafPath];
      if (deepEqual(getAtPath(readValue(text), fullPath), leafValue)) continue;
      text = applyEdits(text, modify(text, fullPath, leafValue, { formattingOptions: formatting }));
    }
  }

  return finish(source, bom, body, text, eol);
}

/** Removes the subtree at `keyPath`, then prunes containers it emptied. */
export function removeJsonc(
  source: string,
  keyPath: readonly string[],
  options: RemoveOptions = {},
): MergeResult {
  const { bom, body } = splitBom(source);
  const guard = parseGuard(body);
  if (guard !== undefined) return unchanged(source, [guard]);
  if (getAtPath(readValue(body), keyPath) === undefined) return unchanged(source);

  const eol = detectEol(body);
  let text = removeProperty(body, keyPath);

  if (options.pruneEmpty !== false) {
    // Walk back up, stopping at the first container that still holds something.
    // The root is never pruned: an empty `{}` file is valid and expected.
    for (let depth = keyPath.length - 1; depth >= 1; depth -= 1) {
      const ancestor = keyPath.slice(0, depth);
      if (!isPrunable(text, ancestor)) break;
      text = removeProperty(text, ancestor);
    }
  }

  return finish(source, bom, body, text, eol);
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/** A half-open byte range to delete. */
interface Cut {
  start: number;
  end: number;
}

/**
 * Deletes the property at `path`, or returns the text unchanged when it is not
 * there.
 *
 * `modify(..., undefined)` is deliberately NOT used here, and this is the one
 * place the writer departs from it. Its removal range runs from the END OF THE
 * PREVIOUS SIBLING (or from the container's `{`) to the end of our property, so:
 *
 *  - any comment sitting in that gap is deleted with us. A `// add servers here`
 *    above our entry is exactly the kind of thing this writer exists to protect,
 *    and `isPrunable` below depends on that comment still being visible to
 *    decide whether the container it lives in may be dropped.
 *  - when our property is the ONLY one in the container the range stops short
 *    of a trailing comma, leaving `{ , // note }` behind. That is not valid
 *    JSONC, and a Zed `settings.json` in that state loses every setting in it,
 *    not just ours.
 *
 * So the range is computed here instead — exactly our property, exactly the one
 * comma that separates it from its neighbours, and the line it sat on when
 * nothing else shares that line — and handed to `applyEdits` as usual. The
 * comma is located with jsonc-parser's own scanner rather than by searching the
 * text, so a `,` inside a string or a comment cannot be mistaken for it.
 */
function removeProperty(text: string, path: readonly string[]): string {
  const value = nodeAt(text, path);
  const property = value?.parent;
  const container = property?.parent;
  if (property === undefined || property.type !== 'property' || container === undefined)
    return text;

  const edits = cutsFor(text, property, container).map((cut) => ({
    offset: cut.start,
    length: cut.end - cut.start,
    content: '',
  }));
  return applyEdits(text, edits);
}

function cutsFor(text: string, property: Node, container: Node): Cut[] {
  const own: Cut = { start: property.offset, end: property.offset + property.length };
  const index = container.children?.indexOf(property) ?? -1;
  const previous = index > 0 ? container.children?.[index - 1] : undefined;

  // Exactly one comma goes with us, and which one matters. Prefer the one that
  // FOLLOWS us: it is on our line, so it leaves with our line and the entries
  // either side keep their own separators. Only when there is none — we are last
  // and the file has no trailing comma — do we take the one before us instead.
  // Taking the earlier comma unconditionally would orphan ours onto a line of
  // its own whenever a comment sits between us and the previous entry.
  const comma =
    nextComma(text, own.end) ??
    (previous === undefined ? undefined : nextComma(text, previous.offset + previous.length));
  if (comma === undefined) return [expandToLine(text, own)];

  const [first, second] = comma.start < own.start ? [comma, own] : [own, comma];
  // One cut when nothing but whitespace lies between them; two when something
  // does, because that something is a comment somebody wrote.
  if (text.slice(first.end, second.start).trim() === '') {
    return [expandToLine(text, { start: first.start, end: second.end })];
  }
  return [expandToLine(text, first), expandToLine(text, second)];
}

/** The next `,` token at or after `from`, skipping whitespace and comments. */
function nextComma(text: string, from: number): Cut | undefined {
  const scanner = createScanner(text, true);
  scanner.setPosition(from);
  scanner.scan();

  // The scanner has already stepped over whitespace and comments, so whatever
  // character it stopped on identifies the token. Read it rather than comparing
  // `scanner.getToken()` to `SyntaxKind.CommaToken`: `SyntaxKind` is an ambient
  // const enum, which this package's `verbatimModuleSyntax` forbids importing
  // as a value.
  const start = scanner.getTokenOffset();
  return text[start] === ',' ? { start, end: start + 1 } : undefined;
}

/**
 * Grows a cut to swallow its whole line when the line holds nothing else.
 *
 * Without this a removal leaves an indented blank line where the entry was, so
 * install -> uninstall would not restore the original bytes — the round-trip
 * property the installer is trusted on.
 */
function expandToLine(text: string, cut: Cut): Cut {
  const lineStart = text.lastIndexOf('\n', cut.start - 1) + 1;
  if (text.slice(lineStart, cut.start).trim() !== '') return cut;

  const lineEnd = text.indexOf('\n', cut.end);
  const tail = lineEnd === -1 ? text.slice(cut.end) : text.slice(cut.end, lineEnd);
  if (tail.trim() !== '') return cut;

  return { start: lineStart, end: lineEnd === -1 ? text.length : lineEnd + 1 };
}

// ---------------------------------------------------------------------------

function finish(source: string, bom: string, body: string, text: string, eol: string): MergeResult {
  // Never hand back bytes that do not parse, mirroring the TOML writer's refusal
  // contract. `issues` is the channel apply() checks before writing, so a writer
  // that returned corrupt text with `issues: []` would get it written.
  const broken = writeGuard(text);
  if (broken !== undefined) return unchanged(source, [broken]);

  // Value-level no-op guard, matching the JSON writer: if nothing moved, the
  // file is returned untouched rather than reformatted.
  if (deepEqual(readValue(body), readValue(text))) return unchanged(source);
  const out = bom + ensureTrailingNewline(text, eol);
  return { text: out, changed: out !== source, issues: [] };
}

function readValue(text: string): unknown {
  return parse(text, [], PARSE_OPTIONS) as unknown;
}

/**
 * A container is prunable only when it is structurally empty AND holds no
 * comment. A container whose braces wrap nothing but a comment parses as empty,
 * yet deleting it would throw away something a human wrote.
 */
function isPrunable(text: string, path: readonly string[]): boolean {
  const value = getAtPath(readValue(text), path);
  if (!isPlainObject(value) || Object.keys(value).length > 0) return false;

  const node = nodeAt(text, path);
  if (node === undefined) return false;
  const inner = text.slice(node.offset, node.offset + node.length).replace(/^\{|\}$/g, '');
  return inner.trim() === '';
}

function nodeAt(text: string, path: readonly string[]): Node | undefined {
  const root = parseTree(text, [], PARSE_OPTIONS);
  if (root === undefined) return undefined;
  return findNodeAtLocation(root, [...path] as JSONPath);
}

function formattingOptions(body: string, eol: string): FormattingOptions {
  const indent = detectIndent(body);
  return { tabSize: indent.tabSize, insertSpaces: indent.insertSpaces, eol };
}

/**
 * Flattens an object into `[path, value]` pairs. Arrays and empty objects are
 * leaves: an array must be replaced wholesale (see the JSON writer on why
 * `args` may never be concatenated) and an empty object has nothing below it.
 */
function leaves(value: unknown, prefix: readonly string[] = []): Array<[string[], unknown]> {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    return [[[...prefix], value]];
  }
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...prefix, key]));
}

/**
 * Refuses output that does not parse.
 *
 * Reaching this means a bug in the editing above, not a bad input file — the
 * input was already checked by {@link parseGuard}. Reporting it as an error
 * still beats writing it: the file on disk stays valid, and the user gets a
 * report instead of a client that silently loads none of its MCP servers.
 */
function writeGuard(text: string): ValidationIssue | undefined {
  const errors: ParseError[] = [];
  parse(text, errors, PARSE_OPTIONS);

  const first = errors[0];
  if (first === undefined) return undefined;

  const at = position(text, first.offset);
  return {
    severity: 'error',
    code: 'jsonc-write-unparseable',
    message: `refusing to write: the edit would produce JSONC that does not parse (${printParseErrorCode(first.error)} at line ${at.line}, column ${at.column}).`,
    fix: 'Nothing was written, so the file on disk is still the one you started with. This is a coolify-mcp bug — please report it with the config that triggered it.',
  };
}

function parseGuard(body: string): ValidationIssue | undefined {
  const errors: ParseError[] = [];
  const value = parse(body, errors, PARSE_OPTIONS) as unknown;

  const first = errors[0];
  if (first !== undefined) {
    const at = position(body, first.offset);
    return {
      severity: 'error',
      code: 'jsonc-unparseable',
      message: `the file is not valid JSONC: ${printParseErrorCode(first.error)} at line ${at.line}, column ${at.column}.`,
      fix: 'Fix the syntax error before installing. coolify-mcp will not edit a file it cannot parse — a partial write on top of a broken file makes the original mistake much harder to find.',
    };
  }

  if (body.trim() !== '' && !isPlainObject(value)) {
    return {
      severity: 'error',
      code: 'jsonc-root-not-object',
      message: 'expected the file to contain a JSON object.',
      fix: 'MCP client configs are objects. Check that this is the file you meant.',
    };
  }
  return undefined;
}

/** 1-based line/column, because that is what editors show. */
function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineBreaks = before.split('\n');
  return { line: lineBreaks.length, column: (lineBreaks[lineBreaks.length - 1] ?? '').length + 1 };
}
