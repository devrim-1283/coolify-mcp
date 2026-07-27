/**
 * The single HTTP chokepoint.
 *
 * Every code path in the server — promoted tools, generic operations, and any
 * tool written after this file — reaches Coolify through `coolifyRequest`.
 * That makes this the only place where a safety property can be stated once and
 * hold for the whole system, so three of them are enforced here, all before the
 * socket opens:
 *
 *   1. Destructive gate. Layer 3 of the three-layer gate (registration ->
 *      dispatch -> transport). The first two live at the tool boundary and a
 *      future tool can forget them; this one cannot be routed around.
 *   2. Read-only gate. Refuses every non-GET on a read-only connection.
 *   3. Origin pinning. The request URL is built from the connection's own base
 *      URL, and redirects are never followed — following one would hand the
 *      bearer token to whatever host the redirect names.
 *
 * A refused request never resolves the bearer token, so a blocked call does not
 * even touch the secret store.
 */

import { CoolifyError } from '../types.js';
import type {
  Connection,
  ConnectionRegistry,
  CoolifyRequest,
  CoolifyResponse,
  DangerClass,
  HttpMethod,
} from '../types.js';
import { mapHttpError, mapNetworkError } from './errors.js';

/** Coolify serves its REST API under this prefix; `CoolifyRequest.path` is relative to it. */
const API_BASE_PATH = '/api/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest 429 wait we will sit through in-process before giving the turn back. */
const MAX_RETRY_WAIT_MS = 30_000;
const USER_AGENT = 'coolify-mcp';

/**
 * Sent as the body of a POST that has nothing to send. See `buildRequestBody`
 * for why an empty body is not an option.
 */
const EMPTY_BODY_PLACEHOLDER = { coolify_mcp_noop: true } as const;

const DANGER_RANK: Record<DangerClass, number> = { safe: 0, write: 1, destructive: 2 };

interface DestructiveOverride {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
}

/**
 * Hand-maintained, and deliberately duplicated from the catalog generator.
 *
 * Neither of these is a DELETE, so a "block the DELETEs" rule misses both. They
 * switch the API off, which locks the token out of its own instance and is
 * irreversible from the token's point of view — the enable endpoint sits behind
 * the same switch.
 *
 * Matched on the operation id *and* on method+path, so a caller cannot dodge
 * the gate by omitting the id or by renaming the operation.
 */
const DESTRUCTIVE_OVERRIDES: readonly DestructiveOverride[] = [
  { id: 'disable-api', method: 'POST', path: '/disable' },
  { id: 'disable-mcp', method: 'POST', path: '/mcp/disable' },
];

// ---------------------------------------------------------------------------
// Transport context
// ---------------------------------------------------------------------------

export interface TransportContext {
  /**
   * Danger class for a catalog operation id, wired up at startup by the module
   * that owns the generated catalog.
   *
   * Escalation only. The transport computes its own verdict first and takes
   * whichever is stricter, so a classifier that returns `safe` for a DELETE —
   * because a new Coolify release misfiled it, or because something later calls
   * this with a hostile function — cannot unlock anything. That property is why
   * an injectable seam is acceptable in the security chokepoint at all.
   */
  classifyOperation?: (operationId: string) => DangerClass | undefined;
  /**
   * Used for one thing only: naming a writable sibling connection when a
   * read-only connection refuses a write. It has no effect on any gate.
   */
  registry?: ConnectionRegistry;
}

let context: TransportContext = {};

/** Replaces the transport context wholesale. Called once, at server startup. */
export function configureTransport(next: TransportContext): void {
  context = { ...next };
}

// ---------------------------------------------------------------------------
// Danger classification
// ---------------------------------------------------------------------------

/** Strips the optional `/api/v1` prefix and any trailing slash, for override matching. */
function normalizeOverridePath(path: string): string {
  const withoutPrefix = path.startsWith(API_BASE_PATH) ? path.slice(API_BASE_PATH.length) : path;
  const trimmed = withoutPrefix.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function matchesDestructiveOverride(req: CoolifyRequest): boolean {
  const path = normalizeOverridePath(req.path);
  return DESTRUCTIVE_OVERRIDES.some(
    (override) =>
      override.id === req.operationId || (override.method === req.method && override.path === path),
  );
}

/**
 * What the transport can work out on its own, with no catalog and no tool layer.
 * This is the floor: the classification can be raised from here, never lowered.
 */
function baselineDanger(req: CoolifyRequest): DangerClass {
  if (matchesDestructiveOverride(req)) return 'destructive';
  if (req.method === 'DELETE') return 'destructive';
  return req.method === 'GET' ? 'safe' : 'write';
}

function classifyDanger(req: CoolifyRequest): DangerClass {
  const baseline = baselineDanger(req);
  if (!req.operationId || !context.classifyOperation) return baseline;

  let fromCatalog: DangerClass | undefined;
  try {
    fromCatalog = context.classifyOperation(req.operationId);
  } catch {
    // A broken catalog must not open the gate, and must not break the request
    // either: the baseline already covers every DELETE and every override.
    return baseline;
  }
  if (!fromCatalog) return baseline;
  return DANGER_RANK[fromCatalog] > DANGER_RANK[baseline] ? fromCatalog : baseline;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function destructiveBlocked(req: CoolifyRequest): CoolifyError {
  const { connection } = req;
  const what = req.operationId ? `\`${req.operationId}\`` : `${req.method} ${req.path}`;
  return new CoolifyError(
    `Refused ${what}: it is a destructive operation and connection \`${connection.name}\` does not allow those.`,
    'destructive_blocked',
    // Named so the human reading the transcript knows the exact knob. The model
    // cannot set an environment variable or restart the server, so this hint is
    // addressed past it, on purpose.
    `Destructive operations are off for this connection. A human can enable them with COOLIFY_ALLOW_DESTRUCTIVE=true (or \`allowDestructive\` on connection \`${connection.name}\` in the config file) and a server restart. The block is enforced in the HTTP client, so no tool can work around it.`,
  );
}

function writableSibling(connection: Connection): string | undefined {
  const registry = context.registry;
  if (!registry) return undefined;
  for (const [name, candidate] of registry.connections) {
    if (name !== connection.name && !candidate.readOnly) return name;
  }
  return undefined;
}

function readOnlyBlocked(req: CoolifyRequest): CoolifyError {
  const { connection } = req;
  const sibling = writableSibling(connection);
  return new CoolifyError(
    `Refused ${req.method} ${req.path}: connection \`${connection.name}\` is read-only.`,
    'read_only_connection',
    sibling
      ? `Connection \`${sibling}\` is configured for writes — retry there if it targets the intended instance and team.`
      : `Every configured connection that could run this is read-only. A human can clear \`readOnly\` for \`${connection.name}\` and restart the server.`,
  );
}

// ---------------------------------------------------------------------------
// URL construction and origin pinning
// ---------------------------------------------------------------------------

/** Query strings, fragments, whitespace and backslashes. */
const UNSAFE_PATH_CHARS = /[?#\\\s]/;

/** Control characters, checked by code point so no literal ever lands in this source file. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function invalidRequest(message: string, hint?: string): CoolifyError {
  return new CoolifyError(message, 'validation', hint);
}

function assertSafePath(path: string): void {
  if (!path.startsWith('/')) {
    throw invalidRequest(`Request path must start with "/", got "${path}".`);
  }
  if (path.startsWith('//')) {
    // A protocol-relative path resolves to a different host under URL
    // resolution rules. It never reaches the socket, but it must not survive
    // long enough to reach a future refactor that uses `new URL(path, base)`.
    throw invalidRequest(`Request path "${path}" is protocol-relative and would leave the connection host.`);
  }
  if (UNSAFE_PATH_CHARS.test(path) || hasControlCharacter(path)) {
    throw invalidRequest(
      `Request path "${path}" contains a query string, fragment or control character.`,
      'Put query parameters in the `query` object instead of the path, and URL-encode path parameters.',
    );
  }
}

/**
 * The connection's base URL with the API prefix applied exactly once.
 *
 * Users write the base URL by hand, and half of them include `/api/v1` because
 * that is what the docs curl into. Both spellings resolve here rather than
 * producing a 404 nobody can read.
 */
function normalizeBaseUrl(connection: Connection): URL {
  let base: URL;
  try {
    base = new URL(connection.baseUrl);
  } catch {
    throw new CoolifyError(
      `Connection \`${connection.name}\` has an unparseable base URL.`,
      'unknown',
      'Set it to the instance root, e.g. https://coolify.example.com.',
    );
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new CoolifyError(
      `Connection \`${connection.name}\` uses an unsupported URL scheme (${base.protocol}).`,
      'unknown',
      'Only http and https base URLs are accepted.',
    );
  }

  const pathname = base.pathname.replace(/\/+$/, '');
  const suffix = pathname.endsWith(API_BASE_PATH) ? '' : pathname.endsWith('/api') ? '/v1' : API_BASE_PATH;
  return new URL(`${base.origin}${pathname}${suffix}`);
}

function buildUrl(base: URL, req: CoolifyRequest): URL {
  assertSafePath(req.path);

  // Built by concatenation onto the pinned origin rather than by resolving the
  // path against the base, so no path value can ever change the host.
  const url = new URL(`${base.origin}${base.pathname}${req.path}`);

  // Redundant by construction. Kept as a tripwire: if this ever fires, someone
  // changed the line above to URL resolution and reopened the exfiltration path.
  if (url.origin !== base.origin) {
    throw invalidRequest(`Refused: the request URL left the origin of connection \`${req.connection.name}\`.`);
  }
  // `..` segments, including percent-encoded ones, normalize during parsing.
  // This catches anything that climbed above the API prefix.
  if (url.pathname !== base.pathname && !url.pathname.startsWith(`${base.pathname}/`)) {
    throw invalidRequest(`Refused: request path "${req.path}" escapes ${base.pathname}.`);
  }

  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

async function resolveBearerToken(connection: Connection): Promise<string> {
  let token: string;
  try {
    token = await connection.resolveToken();
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message.slice(0, 200)}` : '';
    throw new CoolifyError(
      `Could not resolve the API token for connection \`${connection.name}\`.${detail}`,
      'unauthenticated',
      'Check the token source for this connection (tokenEnv, tokenCommand or tokenKeychain). `coolify-mcp doctor` reports which one is configured and whether it resolves.',
    );
  }
  const trimmed = token.trim();
  if (!trimmed) {
    throw new CoolifyError(
      `The token source for connection \`${connection.name}\` resolved to an empty value.`,
      'unauthenticated',
      'A Coolify API token looks like `<id>|<secret>`. Check that the environment variable or command actually produces one.',
    );
  }
  return trimmed;
}

/**
 * Removes the bearer token from anything the server sent back.
 *
 * Not paranoia: point a base URL at a request-echo service and the response body
 * contains the Authorization header verbatim. Without this, that value would
 * flow into the model's context and into every error message from there on.
 */
function scrubToken(text: string, token: string): string {
  const needles = [token];
  const pipe = token.indexOf('|');
  // The secret half alone, when it is long enough to be unambiguous.
  if (pipe > 0 && token.length - pipe - 1 >= 20) needles.push(token.slice(pipe + 1));

  let scrubbed = text;
  for (const needle of needles) {
    if (scrubbed.includes(needle)) scrubbed = scrubbed.replaceAll(needle, '***');
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/** Anything Coolify's `Empty JSON.` check would consider nothing. */
function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (Array.isArray(body)) return body.length === 0;
  return typeof body === 'object' && Object.keys(body as object).length === 0;
}

function serializeBody(body: unknown): string | undefined {
  try {
    // Undefined for values JSON cannot represent, e.g. a function.
    return JSON.stringify(body);
  } catch {
    throw invalidRequest(
      'The request body could not be serialized as JSON.',
      'Pass a plain JSON object; circular references and non-JSON values cannot be sent.',
    );
  }
}

/**
 * Serializes the request body, working around Coolify's empty-body rule.
 *
 * Coolify answers a POST whose JSON body decodes to nothing with
 * `400 {"message":"Invalid request.","error":"Empty JSON."}` — and `{}` decodes
 * to nothing, so it fails the same way. The action endpoints (start, stop,
 * restart, deploy, cancel) declare no request body at all: 25 of Coolify's 63
 * POST operations take their arguments from the query string. So they must be
 * POSTed with at least one field that nothing reads.
 *
 * The GET spellings of those routes are not an escape hatch: they are
 * `post_required` stubs that only answer "use POST".
 *
 * The placeholder key is deliberately unmistakable. On the handful of endpoints
 * that reject unknown keys outright, Coolify echoes it back — an error naming
 * `coolify_mcp_noop` says "this operation wanted a real body and got none",
 * which is a far better trail than a mystery 422.
 *
 * PATCH and PUT get no placeholder. All 22 PATCH and all 3 PUT operations
 * declare a request body, so a bodiless one is always a caller mistake; filling
 * it in would turn that mistake into a silent no-op instead of an error.
 */
function buildRequestBody(req: CoolifyRequest): string | undefined {
  // fetch throws on a GET with a body, and Coolify's DELETEs take none.
  if (req.method === 'GET') return undefined;

  if (!isEmptyBody(req.body)) {
    const serialized = serializeBody(req.body);
    if (serialized !== undefined) return serialized;
  }
  if (req.method === 'DELETE') return undefined;

  if (req.method === 'PATCH' || req.method === 'PUT') {
    throw invalidRequest(
      `${req.method} ${req.path} was called with no body.`,
      'Every Coolify PATCH and PUT expects a request body. Supply at least the one field you mean to change.',
    );
  }
  return JSON.stringify(EMPTY_BODY_PLACEHOLDER);
}

// ---------------------------------------------------------------------------
// insecureTLS
// ---------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // stderr, never stdout: stdout is the MCP protocol stream.
  process.stderr.write(`coolify-mcp: ${message}\n`);
}

let dispatcherPromise: Promise<unknown> | undefined;

/**
 * Per-request TLS verification cannot be turned off in Node's fetch. The only
 * hook is undici's `dispatcher` option, and undici is not a dependency of this
 * package (no native modules, and nothing that would slow a cold `npx` start).
 * So it is loaded opportunistically: present in the user's tree, `insecureTLS`
 * works; absent, we say so loudly rather than pretending the flag took effect.
 *
 * The specifier is held in a variable on purpose — a literal would make the
 * bundler try to resolve a package that is not installed.
 */
async function loadInsecureDispatcher(): Promise<unknown> {
  const specifier = 'undici';
  try {
    const undici = (await import(specifier)) as { Agent?: new (options: unknown) => unknown };
    if (typeof undici.Agent !== 'function') throw new Error('undici has no Agent export');
    return new undici.Agent({ connect: { rejectUnauthorized: false } });
  } catch {
    return undefined;
  }
}

async function insecureDispatcher(connection: Connection): Promise<unknown> {
  if (!dispatcherPromise) dispatcherPromise = loadInsecureDispatcher();
  const dispatcher = await dispatcherPromise;

  // Keyed per connection: with several connections in play, a warning naming
  // only the first one to fire would point at the wrong instance.
  if (dispatcher) {
    warnOnce(
      `insecure-tls-active:${connection.name}`,
      `connection \`${connection.name}\` has insecureTLS set: TLS certificates are NOT verified for it. Anyone on the network path can read the API token in transit.`,
    );
  } else {
    warnOnce(
      `insecure-tls-unavailable:${connection.name}`,
      `connection \`${connection.name}\` sets insecureTLS, but TLS verification cannot be disabled without the optional \`undici\` package, so requests are still verified. Prefer NODE_EXTRA_CA_CERTS=/path/to/ca.pem — it fixes the trust chain without switching verification off. Installing \`undici\` also enables the flag.`,
    );
  }
  return dispatcher;
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

function parseRateLimit(headers: Headers): { limit: number; remaining: number } | undefined {
  // Read from the headers, never hardcoded: the documented default is 200/min
  // but self-hosters change API_RATE_LIMIT, and the bucket is keyed by user id.
  const rawLimit = headers.get('x-ratelimit-limit');
  const rawRemaining = headers.get('x-ratelimit-remaining');
  if (rawLimit === null || rawRemaining === null) return undefined;

  const limit = Number(rawLimit);
  const remaining = Number(rawRemaining);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return undefined;
  return { limit, remaining };
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are legal. */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

function redirectRefused(location: string | null, url: URL, connection: Connection): CoolifyError {
  if (!location) {
    return new CoolifyError(
      `Refused to follow a redirect from ${url.origin}.`,
      'network',
      `The instance behind connection \`${connection.name}\` answered the API with a redirect. Coolify's API does not redirect; something in front of it does.`,
    );
  }

  let target: URL | undefined;
  try {
    target = new URL(location, url);
  } catch {
    target = undefined;
  }

  if (target && target.hostname === url.hostname) {
    return new CoolifyError(
      `Refused to follow a redirect from ${url.origin} to ${target.origin}${target.pathname}.`,
      'network',
      `Same host, different origin or path — usually an http base URL on an https-only instance. Point connection \`${connection.name}\` at ${target.origin} directly.`,
    );
  }
  return new CoolifyError(
    `Refused to follow a cross-host redirect from ${url.hostname}${target ? ` to ${target.hostname}` : ''}.`,
    'network',
    // The token was sent to the pinned host, which is fine. Following the
    // redirect is what would hand it to the next one, so we never do.
    `The bearer token was not sent to the redirect target. If connection \`${connection.name}\` genuinely moved, change its base URL rather than letting the transport follow a redirect.`,
  );
}

function parseResponseData<T>(text: string, headers: Headers, url: URL): T {
  if (!text.trim()) return null as T;

  const contentType = headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    // Coolify answers JSON everywhere. Anything else means the request was
    // answered by something that is not Coolify.
    throw new CoolifyError(
      `${url.origin} answered with ${contentType || 'no content type'} instead of JSON.`,
      'unknown',
      'Check that the base URL points at a Coolify instance and that no login page or proxy sits in front of the API.',
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CoolifyError(`${url.origin} returned a malformed JSON body.`, 'unknown');
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

interface Attempt {
  status: number;
  headers: Headers;
  /** Already scrubbed of the bearer token. */
  text: string;
}

interface PreparedRequest {
  init: RequestInit;
  timeoutSignal: AbortSignal;
  signal: AbortSignal;
  timeoutMs: number;
}

async function buildRequestInit(req: CoolifyRequest, token: string, body: string | undefined): Promise<PreparedRequest> {
  const { connection } = req;

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const timeoutMs =
    Number.isFinite(connection.timeoutMs) && connection.timeoutMs > 0 ? connection.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // Composed, so a host cancelling the tool call and our own deadline both abort
  // the same in-flight request.
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

  const init: RequestInit = {
    method: req.method,
    headers,
    // Never `follow`: a redirect would carry the Authorization header to the
    // target host. Every 3xx is inspected and refused instead.
    redirect: 'manual',
    signal,
    ...(body === undefined ? {} : { body }),
  };

  const dispatcher = connection.insecureTLS ? await insecureDispatcher(connection) : undefined;
  if (dispatcher === undefined) return { init, timeoutSignal, signal, timeoutMs };

  // `dispatcher` is an undici extension that not every @types/node version declares.
  const withDispatcher = { ...init, dispatcher } as unknown as RequestInit;
  return { init: withDispatcher, timeoutSignal, signal, timeoutMs };
}

export async function coolifyRequest<T = unknown>(req: CoolifyRequest): Promise<CoolifyResponse<T>> {
  const { connection } = req;

  // Gate 1 — destructive. Before anything else, including the URL and the token.
  if (classifyDanger(req) === 'destructive' && !connection.allowDestructive) {
    throw destructiveBlocked(req);
  }

  // Gate 2 — read-only. A refusal here is actionable (another connection may be
  // writable), which is why it lives at call time rather than at registration.
  if (connection.readOnly && req.method !== 'GET') {
    throw readOnlyBlocked(req);
  }

  // Gate 3 — origin pinning.
  const base = normalizeBaseUrl(connection);
  const url = buildUrl(base, req);
  const body = buildRequestBody(req);

  // Only now is the secret worth resolving: a blocked call never touches the
  // secret store, so it cannot trigger a keychain prompt or a vault read.
  const token = await resolveBearerToken(connection);
  const { init, ...sent } = await buildRequestInit(req, token, body);

  const attempt = await sendWithRateLimitRetry(url, init, { req, token, ...sent });

  if (attempt.status >= 300 && attempt.status < 400) {
    throw redirectRefused(attempt.headers.get('location'), url, connection);
  }
  const rateLimit = parseRateLimit(attempt.headers);
  if (attempt.status >= 400) {
    throw mapHttpError({
      status: attempt.status,
      body: safeJson(attempt.text),
      method: req.method,
      path: req.path,
      connection: connection.name,
      retryAfterSeconds: retryAfterSecondsOf(attempt),
    });
  }
  return {
    status: attempt.status,
    data: parseResponseData<T>(attempt.text, attempt.headers, url),
    rateLimit,
  };
}

interface SendContext {
  req: CoolifyRequest;
  token: string;
  timeoutSignal: AbortSignal;
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * One request, plus a single bounded retry on 429.
 *
 * One retry, not a backoff loop: the rate-limit bucket is keyed by *user id*,
 * so every connection whose token belongs to the same Coolify account draws on
 * the same allowance. Retrying harder inside one tool call just starves the
 * other calls in a fleet fan-out. If the wait is longer than we are willing to
 * hold the turn for, the error names it and the caller decides.
 */
async function sendWithRateLimitRetry(url: URL, init: RequestInit, ctx: SendContext): Promise<Attempt> {
  const first = await sendOnce(url, init, ctx);
  if (first.status !== 429) return first;

  const waitMs = retryAfterMs(first.headers);
  if (waitMs === undefined || waitMs > MAX_RETRY_WAIT_MS) return first;

  try {
    await delay(waitMs, ctx.signal);
  } catch (error) {
    throw toTransportError(error, url, ctx);
  }
  return sendOnce(url, init, ctx);
}

async function sendOnce(url: URL, init: RequestInit, ctx: SendContext): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw toTransportError(error, url, ctx);
  }

  let text: string;
  try {
    // Always drained, including on 3xx and 4xx, so the connection is released
    // even on the paths that end in a throw.
    text = await response.text();
  } catch (error) {
    throw toTransportError(error, url, ctx);
  }
  return { status: response.status, headers: response.headers, text: scrubToken(text, ctx.token) };
}

function toTransportError(error: unknown, url: URL, ctx: SendContext): CoolifyError {
  if (error instanceof CoolifyError) return error;
  return mapNetworkError(error, {
    connection: ctx.req.connection.name,
    origin: url.origin,
    timeoutMs: ctx.timeoutMs,
    // Caller cancellation is checked first: when both fired, the caller's intent
    // is the more useful thing to report.
    cancelled: ctx.req.signal?.aborted === true,
    timedOut: ctx.req.signal?.aborted !== true && ctx.timeoutSignal.aborted,
    insecureTLSRequested: ctx.req.connection.insecureTLS,
  });
}

function retryAfterSecondsOf(attempt: Attempt): number | undefined {
  if (attempt.status !== 429) return undefined;
  const ms = retryAfterMs(attempt.headers);
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

/** Error bodies are handed to the mapper as JSON when they parse, as text when they do not. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
