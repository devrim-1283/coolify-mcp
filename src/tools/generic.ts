/**
 * The four generic catalog tools — the path that makes every catalogued Coolify
 * operation reachable without spending a tool slot on each one.
 *
 * THREE EXECUTE DOORS, NOT ONE
 * Anthropic's tool-design review criteria state it plainly: a single tool that
 * accepts both GET and POST/PUT/PATCH/DELETE is rejected, and documenting safe
 * versus unsafe inside one description does not satisfy the rule. A `method`
 * parameter satisfies it even less — it makes the danger class an argument the
 * model chooses. So the danger class picks the tool, and each tool carries
 * annotations that are true of everything it can run.
 *
 * THE DISPATCH GUARD
 * Every execute_* handler re-checks that the operation's danger class matches
 * the door it arrived through. That looks redundant — the tool boundary already
 * says which class it serves — but the classification is GENERATED from an
 * upstream OpenAPI spec. A regeneration against a new Coolify release can
 * misfile a DELETE into the write bucket, and the tool boundary would then be
 * enforcing nothing. A security property that holds only because a code
 * generator got it right is not a security property. (This is layer 2 of three:
 * registration decides what exists, dispatch decides what each door admits, and
 * http/client.ts refuses at the socket regardless of what either concluded.)
 *
 * BODY VALIDATION IS DELIBERATELY PERMISSIVE HERE
 * `body` is `z.record(z.unknown()).optional()`. Path parameters are validated —
 * we read those straight off the URL template, so we cannot be wrong about them
 * — and query parameter NAMES are checked, but nothing about the body is.
 *
 * This is the opposite of the usual "tight schemas prevent bad calls" advice,
 * and the justification is that tight schemas are worth it only when the schema
 * source is trustworthy. Coolify's OpenAPI document is generated from PHP
 * attributes and is known wrong in places (upstream issue #7702). A generic
 * executor that hard-validated against it would reject VALID calls with no way
 * for the model to override — a hard failure manufactured entirely by our own
 * scaffolding, on an endpoint we never hand-verified. Coolify's own validator is
 * the authority instead: its 422 body arrives as
 * `{"message":…,"errors":{"field":["…"]}}` and is passed through verbatim, which
 * turns a rejected call into a one-turn self-correction. The promoted, hand-
 * verified tools are where tight schemas belong; this is not that path.
 */

import { z } from 'zod';
import {
  METADATA,
  catalogView,
  getOperation,
  getSchema,
  isReachable,
  searchOperations,
} from '../catalog/index.js';
import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse } from '../shaping/envelope.js';
import { isSensitiveKey, redact, redactObject } from '../shaping/redact.js';
import { CoolifyError } from '../types.js';
import type {
  CatalogOperation,
  Connection,
  CoolifyResponse,
  DangerClass,
  HttpMethod,
  OperationFamily,
  ServerConfig,
  ToolDef,
  ToolExtra,
  ToolResult,
} from '../types.js';

/**
 * Cited in every description below: Directory review requires tools that accept
 * freeform API operations to point at the API's own documentation.
 */
const DOCS_URL = 'https://coolify.io/docs/api-reference';

const COSTLY_NOTE = 'provisions billable cloud infrastructure';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const MAX_NEAR_MATCHES = 3;
/** Below this the remaining allowance is worth stating; above it, it is noise on every call. */
const LOW_RATE_LIMIT_REMAINING = 10;
const MAX_ERROR_DETAIL = 300;
/** Depth bound for the sensitive-key scan, against a pathological response shape. */
const MAX_SCAN_DEPTH = 8;

// ---------------------------------------------------------------------------
// Parameter descriptions
//
// Kept together rather than inline so the whole model-facing vocabulary of this
// module can be reviewed in one screen. Every one of them states what the
// parameter is or what it returns; none tells the model when to call anything,
// because a directive embedded in a tool schema reads as prompt injection.
// ---------------------------------------------------------------------------

const SEARCH_QUERY_DESCRIPTION =
  'Free text matched against operation id, path and summary — e.g. "restart application", ' +
  '"environment variables", "backup".';

const SEARCH_LIMIT_DESCRIPTION = `Maximum rows to return. Default ${DEFAULT_SEARCH_LIMIT}, maximum ${MAX_SEARCH_LIMIT}.`;

const DESCRIBE_ID_DESCRIPTION =
  'Catalog operation id, as returned by search_operations — e.g. "get-application-by-uuid".';

const PATH_PARAMS_DESCRIPTION =
  'Values for the {placeholders} in the operation path, keyed by name — e.g. {"uuid": "a1b2c3"}.';

const QUERY_DESCRIPTION =
  'Query string parameters, keyed by name. Names are checked against the catalog; values are passed through.';

const BODY_DESCRIPTION =
  'JSON request body, passed to Coolify unchanged. Coolify validates it and names the offending fields on rejection.';

const FIELDS_DESCRIPTION =
  'Dot paths to keep in the response, e.g. ["uuid","name","settings.is_static"]. Applied to every row of an ' +
  'array response; everything not named is dropped.';

const REVEAL_DESCRIPTION =
  'Return credential-shaped values (password, token, private_key, …) in the clear instead of masked. ' +
  'Defaults to false because tool output lands in the conversation transcript.';

// ---------------------------------------------------------------------------
// Enumerated filter values
// ---------------------------------------------------------------------------

/**
 * Written as a Record keyed by the union rather than as an array of strings.
 * A Record makes the compiler demand every member and reject anything that is
 * not one, so a family added to `OperationFamily` in types.ts without being
 * added here is a build error — not a value the model can never select and
 * whose absence nobody notices until a search silently under-reports.
 */
const FAMILY_KEYS: Record<OperationFamily, true> = {
  applications: true,
  databases: true,
  services: true,
  servers: true,
  projects: true,
  deployments: true,
  teams: true,
  security: true,
  destinations: true,
  'github-apps': true,
  'cloud-tokens': true,
  hetzner: true,
  digitalocean: true,
  vultr: true,
  tags: true,
  other: true,
};

const METHOD_KEYS: Record<HttpMethod, true> = {
  GET: true,
  POST: true,
  PATCH: true,
  PUT: true,
  DELETE: true,
};

const FAMILIES = Object.keys(FAMILY_KEYS) as [OperationFamily, ...OperationFamily[]];
const METHODS = Object.keys(METHOD_KEYS) as [HttpMethod, ...HttpMethod[]];

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

interface Door {
  tool: string;
  danger: DangerClass;
  /**
   * Methods this door will actually dispatch. Checked alongside the danger
   * class because the two are generated independently: a POST that arrives
   * classified `safe` would otherwise run through a tool annotated
   * `readOnlyHint: true`, which is a lie told to the host's permission model.
   */
  methods: readonly HttpMethod[];
}

const READ_DOOR: Door = { tool: 'execute_read_operation', danger: 'safe', methods: ['GET'] };
const WRITE_DOOR: Door = {
  tool: 'execute_write_operation',
  danger: 'write',
  methods: ['POST', 'PATCH', 'PUT'],
};
// POST as well as DELETE: `POST /disable` switches the API off, which locks the
// token out of its own instance and is irreversible from the token's viewpoint.
const DESTRUCTIVE_DOOR: Door = {
  tool: 'execute_destructive_operation',
  danger: 'destructive',
  methods: ['DELETE', 'POST'],
};

const DOORS: readonly Door[] = [READ_DOOR, WRITE_DOOR, DESTRUCTIVE_DOOR];

function doorFor(operation: CatalogOperation): Door | undefined {
  return DOORS.find((door) => door.danger === operation.danger);
}

const DANGER_PHRASE: Record<DangerClass, string> = {
  safe: 'read-only',
  write: 'a write operation',
  destructive: 'destructive',
};

// ---------------------------------------------------------------------------
// The catalog view
// ---------------------------------------------------------------------------

/**
 * The reachability question is answered from the server-wide flags, the same
 * two values `tools/register.ts` uses to decide which doors exist — so search
 * results and the registered surface cannot disagree.
 *
 * Per-connection `allowDestructive` overrides are deliberately NOT unioned in
 * here. Registration is a process-wide decision made once at startup; widening
 * the view because some connection is permissive would surface operations with
 * no door, which is the exact failure the catalog invariant exists to prevent.
 * Under-reporting is the safe direction: an operation we hide is one the model
 * never stalls on.
 */
function viewOptions(cfg: ServerConfig): { allowDestructive: boolean; readOnly: boolean } {
  return { allowDestructive: cfg.allowDestructive, readOnly: cfg.readOnly };
}

function view(cfg: ServerConfig): CatalogOperation[] {
  return catalogView(viewOptions(cfg));
}

/**
 * An operation id resolved against the view, never against the raw catalog.
 * `describe_operation` must not reveal what `search_operations` hides, or the
 * catalog stops being a truthful map of what this server can do.
 */
function findOperation(cfg: ServerConfig, id: string): CatalogOperation | undefined {
  const operation = getOperation(id);
  if (operation === undefined) return undefined;
  return isReachable(operation, viewOptions(cfg)) ? operation : undefined;
}

function catalogProvenance(): string {
  return (
    `Catalog built from Coolify ${METADATA.coolifyVersion} ` +
    `(sha ${METADATA.specSha256.slice(0, 8)}, ${METADATA.generatedAt.slice(0, 10)}) ` +
    `covering ${METADATA.operationCount} operations.`
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function connectionNames(cfg: ServerConfig): string[] {
  return [...cfg.registry.connections.keys()];
}

/**
 * The `instance` field, emitted conditionally.
 *
 * With one connection the parameter is absent from the schema entirely — not
 * optional-with-a-default, absent. That is the common case, and a parameter
 * nobody can meaningfully vary is pure token cost on every turn.
 *
 * With several, the default is asymmetric: reads may fall back to the
 * designated connection, writes and deletes may not. Guessing wrong on a read
 * costs one wasted call; guessing wrong on a write deploys to production.
 */
function instanceField(cfg: ServerConfig, mayDefault: boolean): Record<string, unknown> {
  const names = connectionNames(cfg);
  if (names.length <= 1) return {};

  const values = z.enum(names as [string, ...string[]]);
  const defaultName = cfg.registry.defaultName;
  if (mayDefault && defaultName !== undefined) {
    return {
      instance: values
        .default(defaultName)
        .describe(`Connection to read from. Defaults to \`${defaultName}\`.`),
    };
  }
  return { instance: values.describe('Connection to act on. No default — name the target explicitly.') };
}

function resolveConnection(cfg: ServerConfig, args: Args, mayDefault: boolean): Connection {
  const { connections, defaultName } = cfg.registry;
  const requested = readString(args, 'instance');

  if (requested !== undefined) {
    const connection = connections.get(requested);
    if (connection === undefined) {
      throw new CoolifyError(
        `\`${requested}\` is not a configured connection.`,
        'validation',
        `Configured connections: ${connectionNames(cfg).join(', ')}.`,
      );
    }
    return connection;
  }

  // Single connection: the schema omits `instance`, so there is nothing to name.
  if (connections.size === 1) {
    const only = connections.values().next().value;
    if (only !== undefined) return only;
  }
  if (mayDefault && defaultName !== undefined) {
    const fallback = connections.get(defaultName);
    if (fallback !== undefined) return fallback;
  }

  throw new CoolifyError(
    mayDefault
      ? 'No connection was named and this server has no default connection.'
      : 'No connection was named. Operations that change state never fall back to a default connection.',
    'validation',
    `Pass \`instance\` with one of: ${connectionNames(cfg).join(', ')}.`,
  );
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/**
 * Substitutes `{placeholders}` in the operation's path template.
 *
 * Path parameters are the one part of the generic call we validate strictly:
 * they come from the URL template itself, not from the spec's parameter
 * annotations, so the catalog cannot be wrong about them the way it can be
 * wrong about a body schema.
 */
function buildPath(operation: CatalogOperation, raw: Args | undefined): string {
  const provided = new Map<string, string>();
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue;
    provided.set(key, String(value));
  }

  const unexpected = [...provided.keys()].filter((key) => !operation.pathParams.includes(key));
  if (unexpected.length > 0) {
    throw new CoolifyError(
      `\`${operation.id}\` has no path parameter ${quoteList(unexpected)}.`,
      'validation',
      `Its path is ${operation.path}, so it takes ${describeNames(operation.pathParams)}.`,
    );
  }

  let path = operation.path;
  for (const name of operation.pathParams) {
    const value = provided.get(name);
    if (value === undefined || value.trim() === '') {
      throw new CoolifyError(
        `\`${operation.id}\` needs path parameter \`${name}\`.`,
        'validation',
        `Its path is ${operation.path}. Pass every placeholder in \`path_params\`.`,
      );
    }
    // Encoded because the transport refuses paths carrying `?`, `#`, backslashes
    // or whitespace — a UUID never trips that, but a name-or-uuid segment can.
    path = path.split(`{${name}}`).join(encodeURIComponent(value.trim()));
  }

  // Tripwire: a leftover placeholder means the path template carries a segment
  // the generated `pathParams` list does not name. Sending `{uuid}` literally
  // would produce an unreadable 404, so refuse and name the real problem.
  if (/[{}]/.test(path)) {
    throw new CoolifyError(
      `The path template for \`${operation.id}\` has a placeholder the catalog does not list (${operation.path}).`,
      'validation',
      'This is an inconsistency in the generated catalog; please report it against coolify-mcp.',
    );
  }
  return path;
}

type QueryValue = string | number | boolean;

/**
 * Names are checked against the catalog; values are not touched. A wrong name
 * is silently dropped by Coolify and the caller never learns why the filter did
 * nothing, which is worth a refusal. A wrong *type* is something Coolify itself
 * reports far better than a stale spec could.
 */
function buildQuery(operation: CatalogOperation, raw: Args | undefined): Record<string, QueryValue> | undefined {
  const entries = Object.entries(raw ?? {}).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return undefined;

  const unexpected = entries.map(([key]) => key).filter((key) => !operation.queryParams.includes(key));
  if (unexpected.length > 0) {
    throw new CoolifyError(
      `\`${operation.id}\` has no query parameter ${quoteList(unexpected)}.`,
      'validation',
      `It accepts ${describeNames(operation.queryParams)}. Parameter names come from the OpenAPI spec of ` +
        `Coolify ${METADATA.coolifyVersion}; a newer instance may accept more than this catalog knows about.`,
    );
  }

  const query: Record<string, QueryValue> = {};
  for (const [key, value] of entries) {
    query[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : String(value);
  }
  return query;
}

// ---------------------------------------------------------------------------
// Field projection (read path only)
// ---------------------------------------------------------------------------

interface FieldNode {
  /** A path ends here: keep the whole subtree, ignoring any deeper selections. */
  leaf: boolean;
  children: Map<string, FieldNode>;
}

/**
 * Dot-path allowlist, the escape hatch for responses we cannot pre-project.
 *
 * The promoted tools declare a projection each, because their response shape is
 * known. The generic executor has no idea what comes back, so the caller
 * supplies the allowlist instead — and it has to be dot-pathed, since the
 * interesting field of an unpaginated Coolify record is usually nested.
 */
function buildFieldTree(paths: readonly string[]): FieldNode {
  const root: FieldNode = { leaf: false, children: new Map() };

  for (const path of paths) {
    const segments = path.split('.');
    if (segments.some((segment) => segment.trim() === '')) {
      throw new CoolifyError(
        `\`fields\` entry "${path}" has an empty path segment.`,
        'validation',
        'Each entry is a dot path over the response, e.g. `uuid` or `settings.is_static`.',
      );
    }

    let node = root;
    for (const segment of segments) {
      const key = segment.trim();
      let child = node.children.get(key);
      if (child === undefined) {
        child = { leaf: false, children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.leaf = true;
  }
  return root;
}

/** Arrays are mapped, so one path selects the same field out of every row. */
function applyFieldTree(value: unknown, node: FieldNode): unknown {
  if (Array.isArray(value)) return value.map((item) => applyFieldTree(item, node));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of node.children) {
    const selected = value[key];
    // Absent stays absent: emitting `"field": null` for a column this Coolify
    // version does not have asserts that the value is null, which is a
    // different and wrong claim.
    if (selected === undefined) continue;
    out[key] = child.leaf ? selected : applyFieldTree(selected, child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/** Every error carries a next step; the text is redacted like any other output. */
function toolError(message: string, nextStep: string, details?: readonly string[]): ToolResult {
  const lines = [`Error: ${message}`, ...(details ?? []), `Next step: ${nextStep}`];
  return { isError: true, content: [{ type: 'text', text: redact(lines.join('\n')) }] };
}

/**
 * The single catch-all. Nothing is thrown across the transport: a thrown error
 * becomes a protocol-level failure the model cannot read, whereas an isError
 * result is text it can act on.
 */
function renderError(error: unknown, fallbackNextStep: string): ToolResult {
  if (error instanceof CoolifyError) {
    const details: string[] = [];
    for (const [field, messages] of Object.entries(error.validationErrors ?? {})) {
      // Verbatim. Coolify's per-field message beats anything we could synthesize
      // from a spec that is wrong in places.
      details.push(`  ${field}: ${messages.join(' ')}`);
    }
    return toolError(
      error.message,
      error.hint ?? fallbackNextStep,
      details.length > 0 ? ['Coolify rejected these fields:', ...details] : undefined,
    );
  }

  const detail = error instanceof Error ? error.message : String(error);
  return toolError(`Unexpected failure: ${truncate(detail, MAX_ERROR_DETAIL)}`, fallbackNextStep);
}

function unknownOperation(cfg: ServerConfig, id: string): ToolResult {
  const near = searchOperations(view(cfg), { query: id, limit: MAX_NEAR_MATCHES }).map((row) => row.id);
  const nextStep =
    near.length > 0
      ? `Closest ids in this catalog: ${near.join(', ')}. ${catalogProvenance()}`
      : `search_operations lists every operation this server can run. ${catalogProvenance()}`;
  return toolError(`No operation with id "${id}" is available on this server.`, nextStep);
}

// ---------------------------------------------------------------------------
// search_operations
// ---------------------------------------------------------------------------

interface SearchRow {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  family: OperationFamily;
  danger: DangerClass;
  /** Present only where the consequence is not visible from the summary. */
  note?: string;
}

function toSearchRow(operation: CatalogOperation): SearchRow {
  const row: SearchRow = {
    id: operation.id,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    family: operation.family,
    danger: operation.danger,
  };
  if (operation.costly === true) row.note = COSTLY_NOTE;
  return row;
}

function searchHandler(args: Args, cfg: ServerConfig): ToolResult {
  const limit = readNumber(args, 'limit') ?? DEFAULT_SEARCH_LIMIT;
  const rows = searchOperations(view(cfg), {
    query: readString(args, 'query'),
    family: readEnum(args, 'family', FAMILY_KEYS),
    method: readEnum(args, 'method', METHOD_KEYS),
    limit,
  }).map(toSearchRow);

  const notes: string[] = [];
  if (rows.length === 0) {
    // Provenance, not an apology: the single most likely cause of a miss on a
    // self-hosted PaaS is an instance newer than the catalog we shipped.
    notes.push(
      `No operations matched. ${catalogProvenance()} ` +
        'If your instance is newer, the endpoint may not be in this catalog.',
    );
  } else {
    notes.push('Full path, query and body schemas for one operation are available from describe_operation.');
    if (rows.length >= limit) {
      notes.push(`The result was cut at limit ${limit}; more operations may match.`);
    }
  }

  const envelope = shapeResponse(
    rows,
    { hint: notes.join(' ') },
    // Under budget pressure the summary is the one column a row can lose and
    // still be actionable — the id is what gets called.
    { prunable: ['summary'] },
  );
  return renderEnvelope(envelope);
}

// ---------------------------------------------------------------------------
// describe_operation
// ---------------------------------------------------------------------------

function describeHandler(args: Args, cfg: ServerConfig): ToolResult {
  const id = (readString(args, 'operation_id') ?? '').trim();
  if (id === '') {
    return toolError('`operation_id` is required.', 'search_operations returns the ids this server accepts.');
  }

  const operation = findOperation(cfg, id);
  if (operation === undefined) return unknownOperation(cfg, id);

  const schema = getSchema(operation.id);
  const detail = {
    id: operation.id,
    method: operation.method,
    path: operation.path,
    family: operation.family,
    summary: operation.summary,
    danger: operation.danger,
    ...(operation.costly === true ? { note: COSTLY_NOTE } : {}),
    ...(operation.since !== undefined ? { since: operation.since } : {}),
    path_params: operation.pathParams,
    query_params: operation.queryParams,
    request_body: schema ?? null,
    /** Which generic door runs it — a fact about this server, not a suggestion. */
    runs_through: doorFor(operation)?.tool ?? null,
  };

  const notes: string[] = [];
  if (operation.hasBody && schema === undefined) {
    notes.push(
      'The operation declares a request body but the published spec carries no schema for it; ' +
        "Coolify's own validation errors name the fields it wants.",
    );
  }
  if (operation.method === 'PATCH' || operation.method === 'PUT') {
    notes.push('Coolify refuses a PATCH or PUT whose body decodes to nothing, so `body` needs at least one field.');
  }

  const envelope = shapeResponse(detail, {
    count: 1,
    ...(notes.length > 0 ? { hint: notes.join(' ') } : {}),
  });
  return renderEnvelope(envelope);
}

// ---------------------------------------------------------------------------
// execute_* — shared dispatch
// ---------------------------------------------------------------------------

interface ExecuteShape {
  door: Door;
  /** Projection is offered only where responses are unbounded, i.e. on reads. */
  fields: boolean;
  /** No catalogued destructive operation declares a request body. */
  body: boolean;
  /** Credential-shaped values can come back from reads and from creates. */
  reveal: boolean;
}

const READ_SHAPE: ExecuteShape = { door: READ_DOOR, fields: true, body: false, reveal: true };
const WRITE_SHAPE: ExecuteShape = { door: WRITE_DOOR, fields: false, body: true, reveal: true };
const DESTRUCTIVE_SHAPE: ExecuteShape = {
  door: DESTRUCTIVE_DOOR,
  fields: false,
  body: false,
  reveal: false,
};

/**
 * Layer 2 of the three-layer gate. See the file header: the danger
 * classification is generated, so the door an operation arrived through is
 * evidence of intent, never proof of class.
 */
function guardDoor(operation: CatalogOperation, door: Door): ToolResult | undefined {
  if (operation.danger === door.danger && door.methods.includes(operation.method)) return undefined;

  if (operation.danger !== door.danger) {
    const correct = doorFor(operation);
    return toolError(
      `Operation "${operation.id}" is ${DANGER_PHRASE[operation.danger]} and cannot be run through ${door.tool}.`,
      correct === undefined
        ? 'No tool on this server runs operations of that class.'
        : `It runs through ${correct.tool}.`,
    );
  }

  // Class matches but the verb does not: the generated catalog contradicts
  // itself. Refusing beats guessing which half is right.
  return toolError(
    `Operation "${operation.id}" is classified ${operation.danger} but uses HTTP ${operation.method}, ` +
      `which ${door.tool} does not run.`,
    'This is an inconsistency in the generated catalog; please report it against coolify-mcp.',
  );
}

async function executeHandler(
  shape: ExecuteShape,
  args: Args,
  cfg: ServerConfig,
  extra: ToolExtra,
): Promise<ToolResult> {
  const id = (readString(args, 'operation_id') ?? '').trim();
  try {
    if (id === '') {
      return toolError('`operation_id` is required.', `search_operations returns ids that ${shape.door.tool} accepts.`);
    }

    const operation = findOperation(cfg, id);
    if (operation === undefined) return unknownOperation(cfg, id);

    const refusal = guardDoor(operation, shape.door);
    if (refusal !== undefined) return refusal;

    return await runOperation(shape, operation, args, cfg, extra);
  } catch (error) {
    return renderError(
      error,
      id === ''
        ? `search_operations returns ids that ${shape.door.tool} accepts.`
        : `describe_operation returns the full parameter contract for \`${id}\`.`,
    );
  }
}

async function runOperation(
  shape: ExecuteShape,
  operation: CatalogOperation,
  args: Args,
  cfg: ServerConfig,
  extra: ToolExtra,
): Promise<ToolResult> {
  const connection = resolveConnection(cfg, args, shape.door.danger === 'safe');
  const path = buildPath(operation, readRecord(args, 'path_params'));
  const query = buildQuery(operation, readRecord(args, 'query'));
  const body = shape.body ? readRecord(args, 'body') : undefined;
  const fields = shape.fields ? readStringArray(args, 'fields') : undefined;
  const reveal = shape.reveal && readBoolean(args, 'reveal') === true;

  // Built before the request so a malformed `fields` fails without spending a
  // call against the instance's rate-limit bucket.
  const tree = fields !== undefined && fields.length > 0 ? buildFieldTree(fields) : undefined;

  const response = await coolifyRequest({
    connection,
    method: operation.method,
    path,
    query,
    body,
    operationId: operation.id,
    signal: extra.signal,
  });

  const projected = tree === undefined ? response.data : applyFieldTree(response.data, tree);
  const masked = !reveal && hasSensitiveValue(projected, 0);
  const data = redactObject(projected, { reveal });

  const envelope = shapeResponse(data, {
    instance: connection.name,
    hint: executeHint(response, { projected: tree !== undefined, masked }),
  });
  return renderEnvelope(envelope);
}

function executeHint(
  response: CoolifyResponse,
  flags: { projected: boolean; masked: boolean },
): string | undefined {
  const notes: string[] = [];
  if (response.data === null) {
    // Otherwise `data: null` reads as a failure when it is an ordinary 201/204.
    notes.push(`Coolify returned HTTP ${response.status} with an empty body.`);
  }
  if (flags.projected) {
    notes.push('Only the requested `fields` are present; omitting `fields` returns the full record.');
  }
  if (flags.masked) {
    notes.push('Credential-shaped values are masked; `reveal: true` returns them in the clear.');
  }
  const rateLimit = response.rateLimit;
  if (rateLimit !== undefined && rateLimit.remaining <= LOW_RATE_LIMIT_REMAINING) {
    notes.push(
      `Rate limit: ${rateLimit.remaining} of ${rateLimit.limit} requests left in the current window ` +
        '(the bucket is per Coolify user, shared by every token that user owns).',
    );
  }
  return notes.length > 0 ? notes.join(' ') : undefined;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Wraps a synchronous catalog handler so nothing reaches the transport as a throw. */
function guarded(
  run: (args: Args, cfg: ServerConfig) => ToolResult,
  fallbackNextStep: string,
): ToolDef['handler'] {
  return async (args, cfg) => {
    try {
      return run(args, cfg);
    } catch (error) {
      return renderError(error, fallbackNextStep);
    }
  };
}

const searchTool: ToolDef = {
  name: 'search_operations',
  description:
    'Search the catalog of Coolify REST API operations by keyword, resource family or HTTP method. ' +
    'Returns compact rows — operation id, method, path, summary, family and danger class — for the operations ' +
    'this server can actually run; anything with no available door is omitted rather than listed. Operations ' +
    'that provision billable cloud infrastructure carry a note saying so. The catalog is generated from ' +
    `Coolify's published OpenAPI spec; the endpoints it covers are documented at ${DOCS_URL}.`,
  annotations: {
    title: 'Search Coolify API operations',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // The catalog is compiled into the package: no network, no external entity,
    // a fixed and fully known domain.
    openWorldHint: false,
  },
  surface: 'read',
  inputSchema: () => ({
    query: z.string().optional().describe(SEARCH_QUERY_DESCRIPTION),
    family: z.enum(FAMILIES).optional().describe('Restrict results to one resource family.'),
    method: z.enum(METHODS).optional().describe('Restrict results to one HTTP method.'),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe(SEARCH_LIMIT_DESCRIPTION),
  }),
  handler: guarded(searchHandler, 'Re-run with a different query, family or method.'),
};

const describeTool: ToolDef = {
  name: 'describe_operation',
  description:
    'Return the full calling contract for one Coolify API operation: its HTTP method and path, the path and ' +
    'query parameters it takes, the JSON Schema of its request body, its danger class, and which execute_* ' +
    'tool runs it. Schemas are returned one operation at a time because they are large enough that returning ' +
    `them for a page of search results would crowd out everything else. Reference documentation: ${DOCS_URL}.`,
  annotations: {
    title: 'Describe a Coolify API operation',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  surface: 'read',
  inputSchema: () => ({
    operation_id: z.string().describe(DESCRIBE_ID_DESCRIPTION),
  }),
  handler: guarded(describeHandler, 'search_operations returns the ids this server accepts.'),
};

/**
 * The three execute doors differ only in which danger class they admit, what
 * they say about themselves, and which optional fields make sense. Building
 * them from one factory is what keeps that true: a parameter added to the read
 * door cannot quietly fail to appear on the write door, and the schema can
 * never drift from the `ExecuteShape` the dispatcher enforces.
 */
interface ExecuteToolSpec {
  shape: ExecuteShape;
  name: string;
  title: string;
  description: string;
  surface: ToolDef['surface'];
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  /** Example ids, so the model can see the id vocabulary without a round trip. */
  idExamples: string;
}

function executeTool(spec: ExecuteToolSpec): ToolDef {
  const { shape } = spec;
  const mayDefaultInstance = shape.door.danger === 'safe';

  return {
    name: spec.name,
    description: spec.description,
    annotations: {
      title: spec.title,
      readOnlyHint: spec.readOnlyHint,
      destructiveHint: spec.destructiveHint,
      ...(spec.idempotentHint === undefined ? {} : { idempotentHint: spec.idempotentHint }),
      openWorldHint: true,
    },
    surface: spec.surface,
    inputSchema: (cfg) => ({
      ...instanceField(cfg, mayDefaultInstance),
      operation_id: z.string().describe(`Catalog operation id — e.g. ${spec.idExamples}.`),
      path_params: pathParamsField(),
      query: queryField(),
      ...(shape.body ? { body: bodyField() } : {}),
      ...(shape.fields ? { fields: fieldsField() } : {}),
      ...(shape.reveal ? { reveal: revealField() } : {}),
    }),
    handler: (args, cfg, extra) => executeHandler(shape, args, cfg, extra),
  };
}

const readTool = executeTool({
  shape: READ_SHAPE,
  name: 'execute_read_operation',
  title: 'Run a Coolify read operation',
  surface: 'read',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  idExamples: '"list-applications", "get-deployment-by-uuid"',
  description:
    'Run a read-only Coolify API operation (GET) from the catalog by id and return the response. Nothing is ' +
    'created, changed or deleted; ids classified as write or destructive are refused here. Optional `fields` ' +
    'keeps only the dot paths you name — Coolify list endpoints are unpaginated and return complete records, ' +
    'so a bare list of applications can be megabytes. Credential-shaped values are masked unless `reveal` is ' +
    `set. Operations, paths and parameters are documented at ${DOCS_URL}.`,
});

const writeTool = executeTool({
  shape: WRITE_SHAPE,
  name: 'execute_write_operation',
  title: 'Run a Coolify write operation',
  surface: 'write',
  readOnlyHint: false,
  // Creating, updating and stopping are reversible and lose no data; a stopped
  // resource starts again. Deletion is a different tool.
  destructiveHint: false,
  idExamples: '"create-project", "update-application-by-uuid", "restart-application-by-uuid"',
  description:
    'Run a Coolify API operation that creates or updates state (POST, PATCH, PUT) from the catalog by id. ' +
    'Nothing is deleted and no resource is destroyed; ids classified as destructive are refused here and run ' +
    'through execute_destructive_operation instead. The request body is passed to Coolify unchanged — field ' +
    "names and types are not pre-validated, and Coolify's own per-field validation errors come back verbatim. " +
    `Operations and their request bodies are documented at ${DOCS_URL}.`,
});

const destructiveTool = executeTool({
  shape: DESTRUCTIVE_SHAPE,
  name: 'execute_destructive_operation',
  title: 'Run a destructive Coolify operation',
  surface: 'destructive',
  readOnlyHint: false,
  destructiveHint: true,
  idExamples: '"delete-application-by-uuid", "delete-database-by-uuid"',
  description:
    'Run a Coolify API operation that destroys state — deleting an application, database, service, server, ' +
    'project or key, or switching the instance API off. These are irreversible: a deleted resource cannot be ' +
    'recovered through the API, and disabling the API locks this token out of the instance until a human turns ' +
    'it back on in the Coolify UI. Only ids classified as destructive are accepted. Operations and their ' +
    `parameters are documented at ${DOCS_URL}.`,
});

/**
 * `execute_destructive_operation` is exported like the rest; whether it is
 * registered at all is `tools/register.ts`'s decision (layer 1 of the gate).
 */
export const genericTools: ToolDef[] = [searchTool, describeTool, readTool, writeTool, destructiveTool];


// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

function pathParamsField(): z.ZodTypeAny {
  return z.record(z.union([z.string(), z.number()])).optional().describe(PATH_PARAMS_DESCRIPTION);
}

function queryField(): z.ZodTypeAny {
  return z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe(QUERY_DESCRIPTION);
}

/** See the file header for why this is a bare record and not a generated schema. */
function bodyField(): z.ZodTypeAny {
  return z.record(z.unknown()).optional().describe(BODY_DESCRIPTION);
}

function fieldsField(): z.ZodTypeAny {
  return z.array(z.string()).optional().describe(FIELDS_DESCRIPTION);
}

function revealField(): z.ZodTypeAny {
  return z.boolean().optional().describe(REVEAL_DESCRIPTION);
}

// ---------------------------------------------------------------------------
// Argument readers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function isRecord(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRecord(args: Args, key: string): Args | undefined {
  const value = args[key];
  return isRecord(value) ? value : undefined;
}

function readStringArray(args: Args, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Membership is tested with `hasOwnProperty`, not `key in allowed`: the value
 * arrives from the model, and `"constructor"` answers a plain `in` check from
 * the prototype chain.
 */
function readEnum<T extends string>(args: Args, key: string, allowed: Record<T, true>): T | undefined {
  const value = readString(args, key);
  if (value === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(allowed, value)) {
    throw new CoolifyError(
      `\`${key}\` must be one of: ${Object.keys(allowed).join(', ')} (got "${value}").`,
      'validation',
    );
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function quoteList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(', ');
}

function describeNames(names: readonly string[]): string {
  return names.length === 0 ? 'none' : quoteList(names);
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Whether anything in the payload would actually be masked. Used only to decide
 * whether the hint is worth its tokens — an unconditional "values are masked"
 * note on every response is noise, and noise on every response is how a real
 * signal gets ignored.
 */
function hasSensitiveValue(value: unknown, depth: number): boolean {
  if (depth > MAX_SCAN_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => hasSensitiveValue(item, depth + 1));
  if (!isRecord(value)) return false;

  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key) && typeof child === 'string' && child.length > 0) return true;
    if (hasSensitiveValue(child, depth + 1)) return true;
  }
  return false;
}
