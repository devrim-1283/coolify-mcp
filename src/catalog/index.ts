/**
 * The single accessor for the generated catalog.
 *
 * THE INVARIANT: the searchable catalog and the registered tool surface must
 * always agree. Nothing outside this module reads `CATALOG` directly — it is
 * deliberately not re-exported. A handler that filtered the raw array itself
 * would eventually drift from what `tools/register.ts` actually registered, and
 * the failure mode is nasty: the model finds `delete-application-by-uuid`,
 * discovers there is no door for it, and stalls. Omitted beats labelled.
 */

import { CATALOG } from '../generated/catalog.js';
import { METADATA } from '../generated/meta.js';
import { SCHEMAS } from '../generated/schemas.js';
import type { CatalogOperation, HttpMethod, OperationFamily } from '../types.js';

export { METADATA };

const OPERATIONS_BY_ID: ReadonlyMap<string, CatalogOperation> = new Map(
  CATALOG.map((operation) => [operation.id, operation]),
);

// A Map, not the record itself: `SCHEMAS['constructor']` on an object literal
// returns something truthy from the prototype chain, and the id reaching this
// function came from the model.
const SCHEMAS_BY_ID: ReadonlyMap<string, unknown> = new Map(Object.entries(SCHEMAS));

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Metadata for an id that has already passed the gate. This is a lookup, not a
 * permission check — it answers "what is this operation", never "may I run it".
 * Anything deciding reachability must use `catalogView` or `isReachable`.
 */
export function getOperation(id: string): CatalogOperation | undefined {
  return OPERATIONS_BY_ID.get(id);
}

/**
 * Pruned request-body JSON Schema, or undefined when the operation takes no
 * body. Kept out of `CatalogOperation` on purpose: inlining ~60 schemas into
 * every search result would blow the context budget the catalog exists to save.
 */
export function getSchema(id: string): unknown {
  return SCHEMAS_BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface CatalogViewOptions {
  /** Global flag, or the connection's override of it. */
  allowDestructive: boolean;
  /** Refuses every write and destructive operation regardless of token scope. */
  readOnly: boolean;
}

/**
 * One predicate, so the view and any per-call re-check cannot disagree.
 * `readOnly` is the stronger constraint and is checked first: a read-only
 * connection admits nothing but `safe`, even with destructive operations
 * globally enabled.
 */
export function isReachable(operation: CatalogOperation, opts: CatalogViewOptions): boolean {
  if (opts.readOnly) return operation.danger === 'safe';
  return opts.allowDestructive || operation.danger !== 'destructive';
}

/**
 * The operations that actually have a door on this server. Rebuilt per call
 * rather than memoised — filtering ~190 rows costs nothing, and a shared cached
 * array is an aliasing hazard for a value this security-relevant.
 */
export function catalogView(opts: CatalogViewOptions): CatalogOperation[] {
  return CATALOG.filter((operation) => isReachable(operation, opts));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Free text matched against operation id, path and summary. */
  query?: string;
  family?: OperationFamily;
  method?: HttpMethod;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Noise words only. `get`, `list`, `create` and `delete` stay in — they are the
 * strongest routing signal a query carries, not filler.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'to',
  'in',
  'on',
  'is',
  'it',
  'and',
  'my',
  'me',
  'i',
  'how',
  'do',
  'can',
  'you',
  'please',
]);

/**
 * Coolify's API says `envs`; every human says "environment variables". Nothing
 * in the id, path or summary of `list-envs-by-application-uuid` contains a word
 * anyone actually types, so one of the most valuable reads on the whole surface
 * is unreachable by search without this. Deliberately not a general thesaurus —
 * only terms where Coolify's own vocabulary diverges from the question.
 */
const QUERY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['env', 'envs'],
  ['environment', 'envs'],
  ['var', 'envs'],
  ['vars', 'envs'],
  ['variable', 'envs'],
  ['variables', 'envs'],
  ['db', 'database'],
]);

// Whole-token hits outrank substring hits: "start" matching the `start` segment
// of `start-application-by-uuid` means more than "art" appearing inside it.
const SCORE_EXACT_ID = 1000;
const SCORE_ID_TOKEN = 10;
const SCORE_ID_SUBSTRING = 6;
const SCORE_PATH_TOKEN = 6;
const SCORE_PATH_SUBSTRING = 4;
const SCORE_SUMMARY_TOKEN = 4;
const SCORE_SUMMARY_SUBSTRING = 2;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

interface SearchIndexEntry {
  id: string;
  path: string;
  summary: string;
  idTokens: ReadonlySet<string>;
  pathTokens: ReadonlySet<string>;
  summaryTokens: ReadonlySet<string>;
}

// Derived once from immutable data. Cold start is a UX property here — every
// MCP client spawns this process fresh — but 190 splits at load beat redoing
// them on every search call.
const SEARCH_INDEX: ReadonlyMap<string, SearchIndexEntry> = new Map(
  CATALOG.map((operation) => {
    const id = operation.id.toLowerCase();
    const path = operation.path.toLowerCase();
    const summary = operation.summary.toLowerCase();
    return [
      operation.id,
      {
        id,
        path,
        summary,
        idTokens: new Set(tokenize(id)),
        pathTokens: new Set(tokenize(path)),
        summaryTokens: new Set(tokenize(summary)),
      },
    ];
  }),
);

function fieldScore(
  token: string,
  tokens: ReadonlySet<string>,
  haystack: string,
  tokenScore: number,
  substringScore: number,
): number {
  if (tokens.has(token)) return tokenScore;
  return haystack.includes(token) ? substringScore : 0;
}

/** Fields are summed: a term present in id, path and summary is a stronger hit. */
function scoreToken(token: string, entry: SearchIndexEntry): number {
  return (
    fieldScore(token, entry.idTokens, entry.id, SCORE_ID_TOKEN, SCORE_ID_SUBSTRING) +
    fieldScore(token, entry.pathTokens, entry.path, SCORE_PATH_TOKEN, SCORE_PATH_SUBSTRING) +
    fieldScore(
      token,
      entry.summaryTokens,
      entry.summary,
      SCORE_SUMMARY_TOKEN,
      SCORE_SUMMARY_SUBSTRING,
    )
  );
}

interface ScoredOperation {
  operation: CatalogOperation;
  /** How many query tokens hit anything. Ranks above raw score. */
  matched: number;
  score: number;
}

function scoreOperation(operation: CatalogOperation, tokens: readonly string[]): ScoredOperation {
  const entry = SEARCH_INDEX.get(operation.id);
  if (entry === undefined) return { operation, matched: 0, score: 0 };

  let matched = 0;
  let score = 0;
  for (const token of tokens) {
    // A Map again: `tokenize` happily yields "constructor", and an object
    // literal would answer that lookup from its prototype.
    const alias = QUERY_ALIASES.get(token);
    const hit = Math.max(
      scoreToken(token, entry),
      alias === undefined ? 0 : scoreToken(alias, entry),
    );
    if (hit > 0) {
      matched += 1;
      score += hit;
    }
  }
  return { operation, matched, score };
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function matchesFilters(operation: CatalogOperation, opts: SearchOptions): boolean {
  if (opts.family !== undefined && operation.family !== opts.family) return false;
  if (opts.method !== undefined && operation.method !== opts.method) return false;
  return true;
}

/**
 * Relevance search over a view produced by `catalogView`. Takes the view as an
 * argument rather than reaching for `CATALOG` so that a caller physically
 * cannot search a surface wider than the one it registered.
 *
 * Returned rows are whole `CatalogOperation`s, so every result carries its
 * `danger` and any `costly` flag — the model can pick the right generic door on
 * the first try instead of guessing and being refused.
 */
export function searchOperations(
  view: readonly CatalogOperation[],
  opts: SearchOptions = {},
): CatalogOperation[] {
  const limit = resolveLimit(opts.limit);
  const filtered = view.filter((operation) => matchesFilters(operation, opts));

  const normalizedQuery = (opts.query ?? '').trim().toLowerCase();
  const tokens = tokenize(normalizedQuery);
  // Browsing, not searching: `family: 'databases'` with no query is a legitimate
  // "show me what is here", so return the filtered set rather than nothing.
  if (tokens.length === 0) return filtered.slice(0, limit);

  const scored: ScoredOperation[] = [];
  for (const operation of filtered) {
    // An id typed verbatim is an unambiguous request, not a relevance question.
    if (operation.id.toLowerCase() === normalizedQuery) {
      scored.push({ operation, matched: tokens.length, score: SCORE_EXACT_ID });
      continue;
    }
    const row = scoreOperation(operation, tokens);
    if (row.matched > 0) scored.push(row);
  }

  scored.sort(
    (a, b) =>
      b.matched - a.matched || b.score - a.score || a.operation.id.localeCompare(b.operation.id),
  );
  return scored.slice(0, limit).map((row) => row.operation);
}
