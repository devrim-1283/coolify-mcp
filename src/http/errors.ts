/**
 * Coolify response -> CoolifyError mapping.
 *
 * Every piece of failure text the transport can produce lives in this file, so
 * the wording is reviewable in one place and no hint drifts out of sync with
 * another.
 *
 * The mapping keys off the `message` field, not the status code alone. Coolify
 * answers authentication failures with three different statuses and three
 * different bodies, and one of them (`API is disabled.`) carries `success: true`
 * on a 403 — a status-only mapper reads that as success-adjacent and gets it
 * wrong. Verified shapes:
 *
 *   400 {"message":"Invalid token.","docs":...}          valid signature, unusable team
 *   400 {"message":"Invalid request.","error":"Empty JSON."|"Invalid JSON."|
 *                                              "Content-Type must be application/json."}
 *   401 {"message":"Unauthenticated."}
 *   403 {"message":"Missing required permissions: write"}
 *   403 {"message":"Missing required team role."}
 *   403 {"success":true,"message":"API is disabled."}
 *   404 {"message":"Application not found."} | {"message":"Not found.","docs":...}
 *   422 {"message":"Validation failed.","errors":{"field":["..."]}}
 */

import { CoolifyError } from '../types.js';
import type { HttpMethod } from '../types.js';

/**
 * Coolify's own Sanctum ability names. `deploy` and `root` are exclusive: a
 * token carries one of them instead of, not in addition to, the others.
 */
export type CoolifyAbility = 'read' | 'read:sensitive' | 'write' | 'deploy' | 'root';

export interface HttpErrorContext {
  status: number;
  /** Parsed JSON body when the response was JSON, otherwise the raw text. */
  body: unknown;
  method: HttpMethod;
  /** Request path without the `/api/v1` prefix, e.g. `/applications/abc`. */
  path: string;
  /** Connection name, so the hint can say which credential to fix. */
  connection: string;
  /** Parsed `Retry-After`, seconds. Only meaningful on 429. */
  retryAfterSeconds?: number;
}

export interface NetworkErrorContext {
  connection: string;
  /** Origin only. The full URL is never needed to explain a transport failure. */
  origin: string;
  timeoutMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** The connection asked for insecureTLS, which we may not have been able to honour. */
  insecureTLSRequested: boolean;
}

/** Bounded so a proxy's HTML error page cannot flood the model's context. */
const MAX_SNIPPET = 200;

/** Node's TLS failure codes that mean "certificate not trusted", not "host unreachable". */
const TLS_TRUST_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const SENSITIVE_READ_PATH = /\/(logs|envs)(\/|$)/;
const DEPLOY_PATH = /^\/deploy(\/|$)/;
const MISSING_PERMISSIONS = /missing required permissions?:\s*(.+)/i;

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

/**
 * Which token ability an operation needs, inferred from the request.
 *
 * Only a fallback: when Coolify names the ability itself in a 403 we quote it
 * verbatim instead. `read:sensitive` is the one worth inferring precisely — it
 * gates environment variable *values*, passwords and logs, which is exactly the
 * set of reads that fail in confusing ways with a plain `read` token.
 */
export function requiredAbility(method: HttpMethod, path: string): CoolifyAbility {
  if (method === 'GET') {
    return SENSITIVE_READ_PATH.test(path) ? 'read:sensitive' : 'read';
  }
  if (method === 'POST' && DEPLOY_PATH.test(path)) {
    return 'deploy';
  }
  return 'write';
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

interface CoolifyErrorBody {
  message?: string;
  error?: string;
  errors?: Record<string, string[]>;
}

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

function readErrorBody(body: unknown): CoolifyErrorBody {
  if (typeof body === 'string') {
    // Not JSON — a proxy error page or a plain-text gateway message.
    const text = snippet(body);
    return text ? { message: text } : {};
  }
  if (typeof body !== 'object' || body === null) return {};

  const record = body as Record<string, unknown>;
  const result: CoolifyErrorBody = {};
  if (typeof record['message'] === 'string') result.message = record['message'];
  if (typeof record['error'] === 'string') result.error = record['error'];
  const errors = readValidationErrors(record['errors']);
  if (errors) result.errors = errors;
  return result;
}

/**
 * Laravel's `errors` map, kept verbatim.
 *
 * The individual messages are never reworded: they are a better recovery hint
 * than anything we could synthesize from Coolify's OpenAPI spec, which is known
 * wrong in places. Only the container is normalized, so the type contract holds
 * when a field carries a bare string instead of an array.
 */
function readValidationErrors(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const out: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[field] = [value];
      continue;
    }
    if (!Array.isArray(value)) continue;
    const messages = value.filter((entry): entry is string => typeof entry === 'string');
    if (messages.length > 0) out[field] = messages;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Lowercased, trimmed, trailing period removed — Coolify is inconsistent about that period. */
function messageKey(message: string | undefined): string {
  return (message ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** Coolify's own words when it gave any, ours when it did not. */
function summarize(body: CoolifyErrorBody, fallback: string): string {
  const parts = [body.message, body.error].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' — ') : fallback;
}

// ---------------------------------------------------------------------------
// HTTP status mapping
// ---------------------------------------------------------------------------

export function mapHttpError(ctx: HttpErrorContext): CoolifyError {
  const body = readErrorBody(ctx.body);
  const key = messageKey(body.message);

  switch (ctx.status) {
    case 400:
      return map400(ctx, body, key);
    case 401:
      return map401(ctx, body);
    case 403:
      return map403(ctx, body, key);
    case 404:
      return map404(ctx, body);
    case 409:
      return new CoolifyError(
        summarize(body, 'Coolify reported a conflict with the current state.'),
        'validation',
        'The message states the conflicting condition; resolve it or pass the override the message names.',
        409,
      );
    case 422:
      return map422(ctx, body);
    case 429:
      return mapRateLimited(ctx, body);
    default:
      break;
  }

  if (ctx.status >= 500) {
    return new CoolifyError(
      summarize(body, `Coolify returned ${ctx.status}.`),
      'unknown',
      'This is an instance-side failure, not a request problem. Check the Coolify instance logs; 502 and 503 usually mean it is restarting.',
      ctx.status,
    );
  }
  return new CoolifyError(
    summarize(body, `Coolify returned ${ctx.status}.`),
    'unknown',
    undefined,
    ctx.status,
  );
}

function map400(ctx: HttpErrorContext, body: CoolifyErrorBody, key: string): CoolifyError {
  // A 400, not a 401: the signature verified but the token has no usable team.
  if (key === 'invalid token') {
    return new CoolifyError(
      'Coolify rejected the API token: "Invalid token."',
      'unauthenticated',
      `The signature is valid but the token is not bound to a usable team. Coolify binds every token to the team that was active when it was created — create a fresh token from the target team and update connection \`${ctx.connection}\`.`,
      400,
    );
  }

  if (key === 'invalid request') {
    return mapInvalidRequest(body);
  }

  return new CoolifyError(
    summarize(body, 'Coolify rejected the request.'),
    'validation',
    undefined,
    400,
  );
}

/** The three sub-cases of `{"message":"Invalid request.","error":...}`. */
function mapInvalidRequest(body: CoolifyErrorBody): CoolifyError {
  const detail = messageKey(body.error);
  const message = summarize(body, 'Coolify rejected the request.');

  if (detail === 'empty json') {
    return new CoolifyError(
      message,
      'validation',
      'Coolify refuses a POST/PATCH/PUT whose JSON body decodes to an empty object. Send at least one field.',
      400,
    );
  }
  if (detail === 'invalid json') {
    return new CoolifyError(
      message,
      'validation',
      'The body did not decode as JSON. coolify-mcp always sends serialized JSON, so suspect a reverse proxy in front of the instance rewriting request bodies.',
      400,
    );
  }
  if (detail === 'content-type must be application/json') {
    return new CoolifyError(
      message,
      'validation',
      'coolify-mcp sets `Content-Type: application/json` on every request that carries a body, so suspect a reverse proxy stripping the header.',
      400,
    );
  }
  return new CoolifyError(message, 'validation', undefined, 400);
}

function map401(ctx: HttpErrorContext, body: CoolifyErrorBody): CoolifyError {
  const ability = requiredAbility(ctx.method, ctx.path);
  return new CoolifyError(
    summarize(body, 'Coolify rejected the API token: "Unauthenticated."'),
    'unauthenticated',
    `The token for connection \`${ctx.connection}\` was not accepted — it may be missing, revoked, or from a different instance. It must be a Coolify API token in \`<id>|<secret>\` form, and this operation needs the \`${ability}\` ability.`,
    401,
  );
}

function map403(ctx: HttpErrorContext, body: CoolifyErrorBody, key: string): CoolifyError {
  // Coolify sends `success: true` alongside this 403. Status-only mappers miss it.
  if (key === 'api is disabled') {
    return new CoolifyError(
      'The Coolify instance has its API turned off ("API is disabled.").',
      'api_disabled',
      `Re-enable it in the Coolify UI under Settings → API on the instance behind connection \`${ctx.connection}\`.`,
      403,
    );
  }

  // Coolify names the ability itself here; quoting it beats inferring it.
  const named = MISSING_PERMISSIONS.exec(body.message ?? '');
  if (named) {
    const ability = named[1]?.trim() ?? requiredAbility(ctx.method, ctx.path);
    return new CoolifyError(
      summarize(body, 'Coolify refused the request for lack of token permissions.'),
      'forbidden',
      `The API token may lack the required ability — this operation needs \`${ability}\`. Abilities are fixed when a token is created, so issue a new token with \`${ability}\` and update connection \`${ctx.connection}\`.`,
      403,
    );
  }

  if (key === 'missing required team role') {
    return new CoolifyError(
      summarize(body, 'Coolify refused the request for lack of a team role.'),
      'forbidden',
      `The token carries the ability, but Coolify additionally requires its owner to be \`admin\` or \`owner\` in that team for write and root tokens. Ask a team owner to raise the role, or point connection \`${ctx.connection}\` at a token that belongs to an admin.`,
      403,
    );
  }

  const ability = requiredAbility(ctx.method, ctx.path);
  return new CoolifyError(
    summarize(body, 'Coolify refused the request.'),
    'forbidden',
    `The API token may lack the required ability — this operation needs \`${ability}\`.`,
    403,
  );
}

function map404(ctx: HttpErrorContext, body: CoolifyErrorBody): CoolifyError {
  return new CoolifyError(
    summarize(body, 'Coolify returned 404 for this path.'),
    'not_found',
    `Either the resource does not exist, or it belongs to another team: a Coolify token only ever sees its own team, and another team's UUID answers 404 rather than 403. Confirm the UUID with \`find_resources\` on connection \`${ctx.connection}\`, or use a connection whose token belongs to the owning team.`,
    404,
  );
}

function map422(ctx: HttpErrorContext, body: CoolifyErrorBody): CoolifyError {
  const fields = Object.keys(body.errors ?? {});
  const hint =
    fields.length > 0
      ? `Coolify rejected these fields: ${fields.join(', ')}. The per-field messages in \`validationErrors\` are authoritative — Coolify's published OpenAPI schema is wrong in places, so trust the server over the schema.`
      : 'Coolify rejected the request body. Its message is authoritative — the published OpenAPI schema is wrong in places.';

  return new CoolifyError(
    summarize(body, 'Coolify rejected the request body.'),
    'validation',
    hint,
    422,
    body.errors,
  );
}

function mapRateLimited(ctx: HttpErrorContext, body: CoolifyErrorBody): CoolifyError {
  const wait =
    ctx.retryAfterSeconds !== undefined
      ? `Retry after ${ctx.retryAfterSeconds}s (Coolify said so; one retry was already attempted or the wait was too long to sit through).`
      : 'Coolify sent no Retry-After header, so the wait is unknown.';

  return new CoolifyError(
    summarize(body, 'Coolify rate limit exceeded.'),
    'rate_limited',
    // The bucket is keyed by user id, not by token: several tokens belonging to
    // one user share it. Fleet fan-out across connections that use the same
    // Coolify account will exhaust it together.
    `${wait} The limit is per user, not per token, so every connection whose token belongs to the same Coolify user shares one bucket — stagger fleet-wide calls. Self-hosters can raise API_RATE_LIMIT on the instance.`,
    429,
  );
}

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

/** Walks the `cause` chain for a Node error code. Depth-bounded against cycles. */
function errorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return errorCode((error as { cause?: unknown }).cause, depth + 1);
}

export function mapNetworkError(cause: unknown, ctx: NetworkErrorContext): CoolifyError {
  if (ctx.cancelled) {
    return new CoolifyError(`Request to ${ctx.origin} was cancelled.`, 'network');
  }
  if (ctx.timedOut) {
    return new CoolifyError(
      `Request to ${ctx.origin} timed out after ${ctx.timeoutMs} ms.`,
      'network',
      `Raise \`timeoutMs\` for connection \`${ctx.connection}\`, or check that the instance is reachable. Coolify list endpoints return the full collection unpaginated, so large instances are genuinely slow.`,
      undefined,
    );
  }

  const code = errorCode(cause);
  if (code && TLS_TRUST_CODES.has(code)) {
    return new CoolifyError(
      `TLS certificate for ${ctx.origin} was not trusted (${code}).`,
      'network',
      ctx.insecureTLSRequested
        ? 'This connection sets `insecureTLS`, but verification could not be disabled for the request — see the warning on stderr. Point NODE_EXTRA_CA_CERTS at the instance CA certificate instead; it keeps verification on and works process-wide.'
        : 'Point NODE_EXTRA_CA_CERTS at the CA certificate for this instance. That keeps verification on, unlike `insecureTLS`.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new CoolifyError(
      `Could not resolve ${ctx.origin} (${code}).`,
      'network',
      `Check the base URL for connection \`${ctx.connection}\`. Self-hosted instances often resolve only inside a VPN or on the LAN.`,
    );
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return new CoolifyError(
      `Could not reach ${ctx.origin} (${code}).`,
      'network',
      `Nothing accepted the connection. Check that the instance is running and that the port in the base URL for connection \`${ctx.connection}\` is right.`,
    );
  }

  const detail = cause instanceof Error ? snippet(cause.message) : 'unknown transport failure';
  return new CoolifyError(`Request to ${ctx.origin} failed: ${detail}`, 'network');
}
