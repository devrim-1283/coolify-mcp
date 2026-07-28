/**
 * find_resources — the door every other resource tool is reached through.
 *
 * Coolify UUIDs are short opaque strings that appear nowhere in a conversation
 * until something lists them, so without this tool the model holds a set of
 * resource tools it can never call. It is backed by GET /resources, which
 * returns applications, databases and services for the whole instance in ONE
 * request — cheaper than the three list calls it replaces, and the reason there
 * is no list_applications / list_databases / list_services.
 *
 * It is also the only tool that accepts `instance: "*"`. Fanning a read out
 * across every configured connection is what answers "which of my four boxes is
 * api-gateway on", and it is safe to do here precisely because the tool cannot
 * write. One unreachable connection must not take the answer down with it, so
 * the fan-out is Promise.allSettled and per-connection failures are reported in
 * `meta.errors[]` beside the rows that did come back.
 *
 * This module also hosts the plumbing the sibling read tools share: connection
 * resolution, the conditional `instance` property, pagination and error
 * rendering. Keeping the read surface to exactly its seven tool modules beats
 * adding an eighth file that would exist only to be imported.
 */

import { z } from 'zod';
import { coolifyRequest } from '../http/client.js';
import {
  assertCursorMatches,
  decodeCursor,
  encodeCursor,
  queryHash,
  renderEnvelope,
  shapeResponse,
  type EnvelopeMeta,
} from '../shaping/envelope.js';
import type { Row } from '../shaping/project.js';
import { redact } from '../shaping/redact.js';
import { CoolifyError } from '../types.js';
import type { Connection, ServerConfig, ToolDef, ToolResult } from '../types.js';

// ---------------------------------------------------------------------------
// Shared read-tool plumbing
// ---------------------------------------------------------------------------

/** The fleet fan-out selector. Accepted by this tool and by nothing else. */
export const ALL_INSTANCES = '*';

export interface InstanceOptions {
  allowAll?: boolean;
}

/**
 * The `instance` property — emitted only when there is a choice to make.
 *
 * With exactly one connection the property is ABSENT from the schema, not
 * optional-with-a-default. A parameter that can take one value is pure context
 * cost on every turn, and leaving it out makes the common single-instance setup
 * indistinguishable from a single-instance server.
 *
 * With several, it is a real enum over the configured names so the model cannot
 * invent one. READ tools default it: guessing wrong on a read costs one wasted
 * call. Write and destructive tools deliberately do not — that asymmetry is
 * implemented in their own modules.
 */
export function instanceProperty(
  cfg: ServerConfig,
  opts: InstanceOptions = {},
): Record<string, unknown> {
  const names = [...cfg.registry.connections.keys()];
  if (names.length < 2) return {};

  const values = opts.allowAll ? [...names, ALL_INSTANCES] : names;
  const parts = [`Which configured Coolify connection to query. Configured: ${names.join(', ')}.`];
  if (opts.allowAll) {
    parts.push(
      `"${ALL_INSTANCES}" queries every configured connection in parallel and tags each row with the instance it came from.`,
    );
  }

  const fallback = cfg.registry.defaultName;
  if (fallback === undefined) {
    parts.push('No default connection is designated, so one must be named.');
    return { instance: enumOf(values).describe(parts.join(' ')) };
  }
  parts.push(`Defaults to ${fallback}.`);
  return { instance: enumOf(values).describe(parts.join(' ')).default(fallback) };
}

/**
 * `z.enum` needs a non-empty tuple; a registry with no connections never
 * reaches here.
 *
 * The return type is inferred rather than written out. Zod 4 reparameterised
 * `ZodEnum` over `Record<string, EnumValue>` instead of v3's
 * `[string, ...string[]]` tuple, and spelling either one here would pin this
 * helper to a single major version for no gain — every caller passes the result
 * straight into an input schema shape.
 */
function enumOf(values: readonly string[]) {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('coolify-mcp: no connections configured.');
  return z.enum([first, ...rest]);
}

/** Resolves the single connection a tool call targets. Never resolves the fan-out. */
export function resolveConnection(cfg: ServerConfig, raw: unknown): Connection {
  const { connections, defaultName } = cfg.registry;
  const names = [...connections.keys()];

  if (raw === undefined || raw === null || raw === '') {
    const chosen = defaultName ?? (names.length === 1 ? names[0] : undefined);
    const connection = chosen === undefined ? undefined : connections.get(chosen);
    if (connection === undefined) {
      throw new CoolifyError(
        'Several Coolify connections are configured and none is designated the default.',
        'validation',
        `Pass \`instance\` with one of: ${names.join(', ')}.`,
      );
    }
    return connection;
  }

  if (typeof raw !== 'string') {
    throw new CoolifyError(
      '`instance` must be a connection name.',
      'validation',
      `Configured: ${names.join(', ')}.`,
    );
  }
  const connection = connections.get(raw);
  if (connection === undefined) {
    throw new CoolifyError(
      `\`${raw}\` is not a configured Coolify connection.`,
      'validation',
      // Naming a host is never an option: tools take a connection name and never
      // a URL, which is what stops a prompt injection from pointing a bearer
      // token at an attacker-chosen instance.
      `Configured connections: ${names.join(', ')}. Connections are defined by the human running this server; a tool cannot point at a new host.`,
    );
  }
  return connection;
}

/** Set on the envelope only when there is more than one connection to disambiguate. */
export function envelopeInstance(cfg: ServerConfig, label: string): string | undefined {
  return cfg.registry.connections.size > 1 ? label : undefined;
}

/**
 * Errors are returned, never thrown across the transport. Everything is passed
 * through `redact` on the way out: an unexpected error's message can carry
 * anything, including a response body a token was echoed into.
 */
export function errorResult(error: unknown): ToolResult {
  const parts: string[] = [];
  if (error instanceof CoolifyError) {
    parts.push(error.message);
    if (error.hint) parts.push(error.hint);
    if (error.validationErrors) parts.push(JSON.stringify(error.validationErrors));
  } else if (error instanceof Error) {
    parts.push(error.message);
  } else {
    parts.push(String(error));
  }
  return { content: [{ type: 'text', text: redact(parts.join('\n\n')) }], isError: true };
}

/** Short single-line description of a failure, for `meta.errors[]`. */
export function describeFailure(error: unknown): string {
  if (error instanceof CoolifyError || error instanceof Error) return error.message;
  return String(error);
}

/** Runs a handler body, turning anything it throws into an error result. */
export async function runRead(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error);
  }
}

// ---------------------------------------------------------------------------
// Argument reading
// ---------------------------------------------------------------------------

/**
 * `args` is typed `Record<string, unknown>`, so every value is read defensively
 * even though the registrar validates against the Zod shape first. Defaults are
 * applied here as well as in the schema: a tool has to behave the same whether
 * or not something upstream ran the parser.
 */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CoolifyError(`\`${key}\` must be a string.`, 'validation');
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) throw new CoolifyError(`\`${key}\` is required.`, 'validation');
  return value;
}

/** Coolify UUIDs are opaque alphanumerics — no dots, no slashes. */
const UUID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A uuid is concatenated into a request path, so it is validated at the tool
 * boundary rather than trusted. The HTTP client refuses an unsafe path anyway;
 * catching it here names the offending parameter instead of reporting a
 * malformed URL.
 */
export function requiredUuid(args: Record<string, unknown>, key: string): string {
  const value = requiredString(args, key);
  if (!UUID_RE.test(value)) {
    throw new CoolifyError(
      `\`${key}\` is not a Coolify UUID.`,
      'validation',
      'Coolify UUIDs are short alphanumeric strings such as `k8sw4c0`. find_resources returns them.',
    );
  }
  return value;
}

export interface IntegerBounds {
  fallback: number;
  min: number;
  max: number;
}

export function boundedInteger(
  args: Record<string, unknown>,
  key: string,
  bounds: IntegerBounds,
): number {
  const value = args[key];
  if (value === undefined || value === null) return bounds.fallback;

  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new CoolifyError(`\`${key}\` must be a number.`, 'validation');
  }
  // Clamped rather than rejected: an out-of-range page size is a harmless
  // misjudgement, and failing the call over it wastes a turn to no purpose.
  return Math.min(Math.max(Math.trunc(parsed), bounds.min), bounds.max);
}

export function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CoolifyError(`\`${key}\` must be true or false.`, 'validation');
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coolify list endpoints answer with a bare array; single reads with an object. */
export function toRows(data: unknown): Row[] {
  if (Array.isArray(data)) return data.filter(isRow);
  return isRow(data) ? [data] : [];
}

export function toRecord(data: unknown): Row | undefined {
  if (Array.isArray(data)) {
    const first = data[0];
    return isRow(first) ? first : undefined;
  }
  return isRow(data) ? data : undefined;
}

function readPath(row: Row, path: string): unknown {
  let node: unknown = row;
  for (const segment of path.split('.')) {
    if (!isRow(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * First non-empty value at any of `paths`, as a string.
 *
 * Coolify sometimes flattens a relation onto the row (`server_name`) and
 * sometimes returns the relation itself (`destination.server.name`), depending
 * on the endpoint and the release. Reading both spellings costs nothing and is
 * the difference between a populated column and an empty one.
 */
export function pickString(row: Row, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(row, path);
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Same path walk as {@link pickString}, but the value keeps its JSON type.
 *
 * Used wherever a column is not a string: a server `port` rendered as `"22"`
 * and a `pull_request_id` rendered as `"0"` are both quietly wrong, and the
 * model has no way to tell that the quotes came from us rather than from
 * Coolify.
 */
export function pickScalar(
  row: Row,
  paths: readonly string[],
): string | number | boolean | undefined {
  for (const path of paths) {
    const value = readPath(row, path);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Copies an allowlisted field straight off a flat upstream row, preserving its
 * type and — unlike the path pickers — an empty string. `"": ""` on an
 * environment variable is a real, frequently load-bearing value.
 */
export function copyField(source: Row, target: Row, field: string): void {
  const value = source[field];
  if (value === undefined || value === null) return;
  target[field] = value;
}

/** Assigns only defined values, so an absent upstream column stays absent. */
export function assignDefined(row: Row, key: string, value: unknown): void {
  if (value !== undefined) row[key] = value;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function paginationProperties(fallback: number, max: number): Record<string, unknown> {
  return {
    limit: z
      .number()
      .int()
      .min(1)
      .max(max)
      .optional()
      .default(fallback)
      .describe(`Rows to return, ${max} maximum.`),
    cursor: z
      .string()
      .optional()
      .describe("Opaque cursor from a previous call's meta.next_cursor."),
  };
}

export interface PageRequest {
  offset: number;
  limit: number;
  hash: string;
}

/**
 * Coolify does not paginate, so pagination is ours: fetch, filter, sort, slice.
 * The cursor carries a hash of the filters it was produced under, so replaying
 * it against a different query is rejected rather than silently walking a
 * different result set.
 */
export function readPage(
  args: Record<string, unknown>,
  filters: unknown,
  bounds: { fallback: number; max: number },
): PageRequest {
  const limit = boundedInteger(args, 'limit', {
    fallback: bounds.fallback,
    min: 1,
    max: bounds.max,
  });
  const hash = queryHash(filters);
  const raw = optionalString(args, 'cursor');
  if (raw === undefined) return { offset: 0, limit, hash };

  const cursor = decodeCursor(raw);
  assertCursorMatches(cursor, hash);
  return { offset: cursor.offset, limit, hash };
}

export function pageHint(offset: number, shown: number, total: number): string {
  if (shown === 0)
    return total === 0 ? 'Nothing matched.' : `No rows at offset ${offset} of ${total}.`;
  return `Rows ${offset + 1}-${offset + shown} of ${total}.`;
}

/** `next_cursor`, present only when there is a next page. */
export function nextCursor(page: PageRequest, shown: number, total: number): string | undefined {
  const consumed = page.offset + shown;
  return consumed < total ? encodeCursor({ offset: consumed, queryHash: page.hash }) : undefined;
}

// ---------------------------------------------------------------------------
// find_resources
// ---------------------------------------------------------------------------

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const RESOURCE_KINDS = ['application', 'database', 'service'] as const;
type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * The projection allowlist: nine fields out of the ~80 Coolify returns per row.
 *
 * It lives beside the handler rather than in a shared shaping barrel because a
 * projection only stays correct if it moves when its tool moves, and a shared
 * constants file is exactly where that stops happening. An allowlist rather
 * than a denylist because a denylist starts leaking every column a future
 * Coolify release adds, regressing the budget on someone else's schedule.
 *
 * Each entry is (output column, source paths in preference order) so the
 * allowlist and the row builder cannot drift apart.
 */
const RESOURCE_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['uuid', ['uuid']],
  ['name', ['name']],
  ['type', ['type']],
  ['status', ['status']],
  ['fqdn', ['fqdn']],
  ['project_name', ['project_name', 'environment.project.name']],
  ['environment_name', ['environment_name', 'environment.name']],
  ['server_name', ['server_name', 'destination.server.name', 'server.name']],
  ['updated_at', ['updated_at']],
];

const RESOURCE_COLUMNS = RESOURCE_FIELDS.map(([column]) => column);

/** Sacrificed in this order when a page still does not fit. Identity first, location last. */
const RESOURCE_PRUNABLE = ['updated_at', 'environment_name', 'project_name', 'fqdn'] as const;

/** Fields the free-text query is matched against, read off the raw upstream row. */
const SEARCH_PATHS = [
  'name',
  'uuid',
  'fqdn',
  'description',
  'project_name',
  'environment.project.name',
  'environment_name',
  'environment.name',
  'server_name',
  'destination.server.name',
] as const;

/**
 * Coolify labels databases by engine (`standalone-postgresql`), never by the
 * word "database", so the three-way filter a person actually thinks in has to
 * be derived rather than compared.
 */
function classifyKind(type: string | undefined): ResourceKind | undefined {
  if (type === undefined) return undefined;
  const value = type.toLowerCase();
  if (value === 'application') return 'application';
  if (value === 'service') return 'service';
  if (value.startsWith('standalone-') || value.includes('database')) return 'database';
  return undefined;
}

function buildResourceRow(raw: Row, instance: string | undefined): Row {
  const row: Row = {};
  // First column, so a fleet result reads as "instance / name" left to right.
  if (instance !== undefined) row['instance'] = instance;

  for (const [column, paths] of RESOURCE_FIELDS) {
    assignDefined(row, column, pickString(raw, paths));
  }
  return row;
}

interface Filters {
  query?: string;
  status?: string;
  kind?: ResourceKind;
}

function matchesQuery(raw: Row, needle: string): boolean {
  for (const path of SEARCH_PATHS) {
    const value = pickString(raw, [path]);
    if (value !== undefined && value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function matches(raw: Row, filters: Filters): boolean {
  if (filters.query !== undefined && !matchesQuery(raw, filters.query)) return false;
  if (filters.status !== undefined) {
    const value = pickString(raw, ['status']);
    if (value === undefined || !value.toLowerCase().includes(filters.status)) return false;
  }
  if (filters.kind !== undefined && classifyKind(pickString(raw, ['type'])) !== filters.kind)
    return false;
  return true;
}

/**
 * Deterministic order, because offset pagination over a re-fetched list is only
 * coherent if the list comes back the same way each time. Instance first so a
 * fleet result groups by box rather than interleaving four instances by name.
 */
function sortKey(row: Row): string {
  return [
    String(row['instance'] ?? ''),
    String(row['name'] ?? '').toLowerCase(),
    String(row['uuid'] ?? ''),
  ].join(' ');
}

interface Collected {
  rows: Row[];
  errors: Array<{ instance: string; message: string }>;
}

/**
 * One GET /resources per target, in parallel, with the origin attached while
 * the results are still separated — the instance a row came from cannot be
 * recovered once the arrays are flattened.
 */
async function collect(
  targets: readonly Connection[],
  filters: Filters,
  tag: boolean,
  signal: AbortSignal | undefined,
): Promise<Collected> {
  const settled = await Promise.allSettled(
    targets.map(async (connection) => {
      const response = await coolifyRequest({
        connection,
        method: 'GET',
        path: '/resources',
        operationId: 'list-resources',
        signal,
      });
      return toRows(response.data)
        .filter((raw) => matches(raw, filters))
        .map((raw) => buildResourceRow(raw, tag ? connection.name : undefined));
    }),
  );

  const rows: Row[] = [];
  const errors: Array<{ instance: string; message: string }> = [];
  settled.forEach((outcome, index) => {
    const connection = targets[index];
    if (connection === undefined) return;
    if (outcome.status === 'rejected') {
      // A single unreachable box must not take the whole answer down: this is
      // the difference between "prod is down" and "find_resources is broken".
      errors.push({ instance: connection.name, message: describeFailure(outcome.reason) });
      return;
    }
    rows.push(...outcome.value);
  });
  return { rows, errors };
}

export const findResources: ToolDef = {
  name: 'find_resources',
  description:
    'Search the applications, databases and services on a Coolify instance in one call, filtering by free text, kind and status. ' +
    `Returns ${RESOURCE_COLUMNS.join(', ')} for each match. ` +
    'This is where resource UUIDs come from — get_resource, get_logs, get_environment_variables and list_deployments all take one. ' +
    'For the full stored configuration of a single resource use get_resource.',
  annotations: {
    title: 'Find resources',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  inputSchema: (cfg) => ({
    query: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Case-insensitive substring, matched against name, uuid, fqdn, description and the project, environment and server names. Omit to list everything.',
      ),
    resource_type: z
      .enum(RESOURCE_KINDS)
      .optional()
      .describe(
        'Keep only resources of this kind. Coolify types databases by engine, so every standalone-* type counts as "database".',
      ),
    status: z
      .string()
      .max(60)
      .optional()
      .describe(
        'Case-insensitive substring matched against the status string, e.g. "running", "exited", "degraded".',
      ),
    ...paginationProperties(DEFAULT_PAGE, MAX_PAGE),
    ...instanceProperty(cfg, { allowAll: true }),
  }),
  handler: async (args, cfg, extra) =>
    runRead(async () => {
      const kind = optionalString(args, 'resource_type');
      if (kind !== undefined && !(RESOURCE_KINDS as readonly string[]).includes(kind)) {
        throw new CoolifyError(
          `\`resource_type\` must be one of: ${RESOURCE_KINDS.join(', ')}.`,
          'validation',
        );
      }
      const filters: Filters = {
        query: optionalString(args, 'query')?.toLowerCase(),
        status: optionalString(args, 'status')?.toLowerCase(),
        kind: kind as ResourceKind | undefined,
      };

      const requested = args['instance'];
      const fanOut = requested === ALL_INSTANCES;
      const targets = fanOut
        ? [...cfg.registry.connections.values()]
        : [resolveConnection(cfg, requested)];
      const label = fanOut ? ALL_INSTANCES : (targets[0]?.name ?? ALL_INSTANCES);

      const page = readPage(
        args,
        { ...filters, instance: label },
        { fallback: DEFAULT_PAGE, max: MAX_PAGE },
      );
      const { rows, errors } = await collect(targets, filters, fanOut, extra.signal);

      rows.sort((a, b) => {
        const left = sortKey(a);
        const right = sortKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });

      const total = rows.length;
      const shown = rows.slice(page.offset, page.offset + page.limit);
      const allFailed = errors.length === targets.length && targets.length > 0;

      // "Nothing matched" would be a lie when nothing was even reached, and it
      // is the one wrong answer here that reads as a confident one.
      const notes = allFailed
        ? [
            `No connection answered; every one of the ${targets.length} queried failed. See meta.errors.`,
          ]
        : [pageHint(page.offset, shown.length, total)];
      if (fanOut && !allFailed) {
        notes.push(
          `Queried ${targets.length} connections in parallel; each row carries its origin in "instance".`,
        );
      }
      notes.push(
        'These fields are a projection; get_resource returns the full record for one resource.',
      );

      const meta: EnvelopeMeta = {
        instance: envelopeInstance(cfg, label),
        total,
        hint: notes.join(' '),
        cursor: { offset: page.offset, queryHash: page.hash },
      };
      const next = nextCursor(page, shown.length, total);
      if (next !== undefined) meta.next_cursor = next;
      if (errors.length > 0) meta.errors = errors;

      const result = renderEnvelope(shapeResponse(shown, meta, { prunable: RESOURCE_PRUNABLE }));

      // Every target failed: an empty list is not an answer here, it is the
      // absence of one, and saying so beats letting it read as "no resources".
      return allFailed ? { ...result, isError: true } : result;
    }),
};
