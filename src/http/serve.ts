/**
 * The Streamable HTTP transport.
 *
 * A second entry point alongside `index.ts`, and deliberately nothing more than
 * that: same `buildServer`, same tools, same gates, reached over a socket
 * instead of a pipe. `server.ts` was written transport-agnostic so this file
 * could exist without touching it, and nothing here is allowed to change what
 * the server IS — only how a caller reaches it.
 *
 * What this file owns is everything that only matters once the caller is on a
 * network rather than on the other end of a pipe the OS handed us:
 *
 *   1. AUTH BEFORE BYTES. The bearer check reads one header and answers, before
 *      the body is touched. A 401 that first buffers megabytes is a denial of
 *      service wearing an access control's clothes.
 *   2. A CAP ON EVERY BODY, enforced while reading rather than after. See
 *      `readBody`.
 *   3. A FRESH SERVER PER POST. See `dispatch`.
 *
 * Diagnostics go to stderr, as in stdio mode — and not merely by habit. The
 * `no-console` rule and the `process.stdout` ban in `eslint.config.js` cover the
 * whole of `src/` precisely because the stdio entry point cannot survive a stray
 * write, and a second rule carved out for HTTP mode would be a rule to forget.
 * Docker captures both streams anyway.
 *
 * Every line this file writes passes through `note`, which redacts, flattens and
 * caps it. That is not decoration: Host, Origin and the request target are all
 * attacker-controlled, and a newline in any of them would otherwise forge a
 * second log line that reads like the server said it.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { LogLevel } from '../config/server-config.js';
import { buildServer } from '../server.js';
import { redact } from '../shaping/redact.js';
import type { ServerConfig } from '../types.js';
import { isAuthorized } from './http-auth.js';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';

/** Prefixes diagnostics, so a log holding several servers stays legible. */
const PROGRAM = 'coolify-mcp';

/** JSON-RPC 2.0's own code for a body that is not JSON. */
const RPC_PARSE_ERROR = -32700;

/**
 * The implementation-defined code the MCP SDK uses for its transport-level
 * refusals. Reused here so every refusal on `/mcp` — ours and the SDK's — reads
 * the same to a client that only knows how to parse JSON-RPC.
 */
const RPC_TRANSPORT_ERROR = -32000;

/** Bind addresses that mean "every interface", so the `Host` header is unknowable. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

/** Three spellings of one socket. A client picks whichever it likes. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Both schemes are accepted for every allowed authority. The scheme is not
 * load-bearing in an `Origin` check — an attacker who controls a name controls
 * it under both — while TLS termination in front of the server (Traefik, on
 * Coolify) makes `https://` the only origin a browser would ever send.
 */
const ORIGIN_SCHEMES = ['http', 'https'] as const;

/** RFC 9110: a client omits the port from `Host` when it is the scheme's default. */
const DEFAULT_SCHEME_PORT = 80;

/**
 * How long `close()` waits for in-flight requests before severing them.
 *
 * There has to be a deadline. An open SSE response is, by design, a request that
 * has not finished, so a shutdown that waited for one would wait forever — and a
 * test suite that hangs on teardown is worse than one that fails.
 */
const SHUTDOWN_GRACE_MS = 1_000;

/** Long enough for any real path, short enough that one cannot crowd out the line. */
const MAX_LOGGED_PATH_CHARS = 120;
const MAX_LOG_CHARS = 512;

/** Anything outside printable ASCII. Log injection and mojibake, in one pass. */
const NON_PRINTABLE = /[^\x20-\x7e]/g;

/** A base that exists only to make a relative request target parseable. */
const PARSE_BASE = 'http://request.invalid';

export interface HttpServeOptions {
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  /** Extra Host/Origin values to accept beyond `host:port`. */
  readonly allowedHosts?: readonly string[];
  readonly maxBodyBytes?: number;
}

export interface RunningHttpServer {
  /** Resolved base URL, e.g. `http://127.0.0.1:3000`. */
  readonly url: string;
  /** Resolved port — `port: 0` binds an ephemeral one, which tests need. */
  readonly port: number;
  close(): Promise<void>;
}

interface AllowList {
  /** Accepted `Host` values. Empty means the header cannot be predicted — see `buildAllowList`. */
  readonly hosts: readonly string[];
  /** Accepted `Origin` values, derived from the same authorities. */
  readonly origins: readonly string[];
}

interface RequestContext {
  readonly cfg: ServerConfig;
  readonly authToken: string;
  readonly maxBodyBytes: number;
  /** Memoised, not precomputed: with `port: 0` the real port exists only after binding. */
  readonly allowList: () => AllowList;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function serveHttp(
  cfg: ServerConfig,
  options: HttpServeOptions,
): Promise<RunningHttpServer> {
  const http = createServer();

  let allow: AllowList | undefined;
  const context: RequestContext = {
    cfg,
    authToken: options.authToken,
    maxBodyBytes: resolveMaxBodyBytes(options.maxBodyBytes),
    allowList: () =>
      (allow ??= buildAllowList(options.host, addressPort(http), options.allowedHosts ?? [])),
  };

  // Attached before `listen`, so there is no window in which a connection could
  // arrive at a server with no handler and simply hang.
  http.on('request', (req, res) => {
    logAccess(req, res, cfg.logLevel);
    // The listener signature is synchronous and an unhandled rejection would
    // take the process down with the client none the wiser, so the routing
    // promise is drained here and `route` answers every failure in-band.
    void route(req, res, context);
  });

  await listen(http, options.host, options.port);
  const port = addressPort(http);

  if (context.allowList().hosts.length === 0) {
    note(
      `bound ${options.host}:${port} with no --allowed-host: a wildcard bind cannot predict the Host header, so Host validation is off. Origin validation still refuses every browser-originated request.`,
    );
  }

  let closing: Promise<void> | undefined;
  return {
    url: `http://${formatAuthority(reachableHost(options.host), port)}`,
    port,
    close: () => (closing ??= shutdown(http)),
  };
}

function listen(http: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    http.once('error', onError);
    http.listen(port, host, () => {
      // Bind failures arrive as `error`, not as a throw; the listener has to go
      // once we are up or every later socket error would reject a settled promise.
      http.removeListener('error', onError);
      resolve();
    });
  });
}

/**
 * Stops listening, then makes sure the process can actually exit.
 *
 * `server.close()` alone does not: it waits for every open connection, and an
 * HTTP/1.1 client keeps its socket alive by default. So idle sockets are dropped
 * immediately — they have no request to lose — and anything still in flight is
 * severed once the grace period is up.
 */
function shutdown(http: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const forced = setTimeout(() => http.closeAllConnections(), SHUTDOWN_GRACE_MS);
    // Never hold the event loop open on behalf of a deadline for closing things.
    forced.unref();

    http.close((error) => {
      clearTimeout(forced);
      if (error) reject(error);
      else resolve();
    });
    http.closeIdleConnections();
  });
}

function addressPort(http: Server): number {
  const address = http.address();
  if (address === null || typeof address === 'string') {
    // A string address means a UNIX socket and `null` means not listening;
    // `serveHttp` binds TCP and awaits the bind, so neither is reachable.
    throw new Error('the HTTP server is not bound to a TCP port');
  }
  return address.port;
}

function resolveMaxBodyBytes(value: number | undefined): number {
  // A cap of zero or a negative one would refuse every request, which is a
  // configuration mistake rather than an intent worth honouring.
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_BODY_BYTES;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  try {
    const path = pathOf(req.url);
    if (path === HEALTH_PATH) {
      handleHealth(req, res);
      return;
    }
    if (path !== MCP_PATH) {
      // No echo of the path: reflecting an attacker's string back is a habit
      // worth not having, and a 404 has nothing to say beyond its own status.
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await handleMcp(req, res, ctx);
  } catch (error) {
    fail(res, error, 'request');
  }
}

/**
 * Unauthenticated on purpose: this is what Coolify's container health check
 * calls and what a load balancer calls, and neither holds the token. It reports
 * that a process is listening and nothing else — no connection names, no
 * version, no configuration.
 */
function handleHealth(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    return;
  }
  // Node suppresses the body for a HEAD response on its own, so one path serves
  // both and a health check written either way works.
  sendJson(res, 200, { status: 'ok' });
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  if (!isAuthorized(req.headers.authorization, ctx.authToken)) {
    respondUnauthorized(res);
    return;
  }

  // Every remaining check is downstream of auth, deliberately. An anonymous
  // prober who could tell "your Host is wrong" (403) from "your method is
  // wrong" (405) apart from "your token is wrong" (401) has been handed a map
  // of the surface for free, and the 401 above is careful not to be an oracle.
  const origin = req.headers.origin;
  if (origin !== undefined && !ctx.allowList().origins.includes(origin.trim().toLowerCase())) {
    // The transport applies the same rule to POST. This one also holds when the
    // allow list is empty — where the SDK, given nothing to compare against,
    // skips the check entirely. An MCP client is not a browser and sends no
    // Origin at all, so refusing every declared one costs nothing real.
    note(`refused Origin "${origin}" on ${MCP_PATH}`);
    sendRpcError(res, 403, RPC_TRANSPORT_ERROR, 'Invalid Origin header.');
    return;
  }

  if (req.method !== 'POST') {
    // Stateless, so a GET has no stream to open and a DELETE has no session to
    // end. Both are answered here rather than by the transport, which would
    // otherwise take a fresh server's construction to say the same thing.
    sendRpcError(res, 405, RPC_TRANSPORT_ERROR, 'Method not allowed.', { allow: 'POST' });
    return;
  }

  const body = await readBody(req, ctx.maxBodyBytes);
  if (!body.ok) {
    if (body.reason === 'too_large') respondPayloadTooLarge(req, res, ctx.maxBodyBytes);
    // An aborted upload has nobody left to answer.
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    sendRpcError(res, 400, RPC_PARSE_ERROR, 'Parse error');
    return;
  }

  await dispatch(req, res, ctx, parsed);
}

/**
 * One POST, one `McpServer`, one transport, both closed when the response is.
 *
 * Not an optimisation left on the table — the SDK refuses to reuse a stateless
 * transport at all, because two callers sharing one would collide on JSON-RPC
 * message ids. Building per request is what buys complete isolation between
 * concurrent callers, and it is nearly free: `buildServer` is pure, does no I/O,
 * and costs about sixteen Zod schemas against a Coolify round trip.
 *
 * Disposal is idempotent and hangs off the response's `close`, which fires on a
 * clean finish and on a client that walked away mid-stream alike. The `finally`
 * is the belt for the paths where the response was never started at all.
 */
async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  parsed: unknown,
): Promise<void> {
  const allow = ctx.allowList();
  const server = buildServer(ctx.cfg);
  const transport = new StreamableHTTPServerTransport({
    // Stateless. Nothing here is worth a session store, an expiry policy and a
    // class of bug where a client resumes onto a server that has forgotten it:
    // the tool set is fixed at startup so `listChanged` never fires, and the one
    // thing that streams — `deploy(wait: true)` progress — rides the originating
    // request's own SSE response rather than a standalone one.
    sessionIdGenerator: undefined,
    // Which is exactly why JSON responses stay off: in that mode the SDK writes
    // only the final result, and every progress notification is dropped on the
    // floor.
    enableJsonResponse: false,
    enableDnsRebindingProtection: true,
    // Copied, so the SDK is never handed a list shared with the next request.
    allowedHosts: [...allow.hosts],
    allowedOrigins: [...allow.origins],
  });

  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposal ??= Promise.allSettled([transport.close(), server.close()]).then(() => undefined));
  res.once('close', () => void dispose());

  // The client is told only the status. The reason a Host was refused is worth
  // exactly one stderr line to the operator who has to fix it, and nothing at
  // all to whoever forged it.
  transport.onerror = (error: Error): void => {
    note(`${MCP_PATH}: ${error.message}`);
  };

  try {
    await server.connect(transport);
    // The parsed body is passed in rather than left to the transport: it has
    // already been read here, under the cap, and a second read would find an
    // exhausted stream.
    await transport.handleRequest(req, res, parsed);
  } catch (error) {
    fail(res, error, `POST ${MCP_PATH}`);
  } finally {
    await dispose();
  }
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too_large' | 'aborted' };

/**
 * Reads the body, counting as it goes and stopping the moment the cap is
 * crossed.
 *
 * Buffering the whole thing and measuring afterwards would spend exactly what
 * the cap exists to save, so the count is checked per chunk and nothing past the
 * limit is retained. `pause()` rather than `destroy()`: destroying the request
 * destroys the socket under it, and the 413 the caller is about to write would
 * never reach the client that needs to read it.
 */
function readBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.resolve({ ok: false, reason: 'too_large' });
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onFailure);
      req.removeListener('close', onFailure);
      resolve(result);
    };

    // No `setEncoding` is ever set on this stream, so every chunk is a Buffer.
    // Counted in bytes and joined at the end, because a multi-byte character
    // split across two chunks does not survive being decoded twice.
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        finish({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    }
    // `close` after a clean `end` is a no-op here; `close` without one is a
    // client that hung up mid-upload.
    function onFailure(): void {
      finish({ ok: false, reason: 'aborted' });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onFailure);
    req.on('close', onFailure);
  });
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: OutgoingHttpHeaders,
): void {
  // `id: null` per JSON-RPC 2.0: the request's id is unknowable when the request
  // itself was never understood.
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function respondUnauthorized(res: ServerResponse): void {
  if (res.writableEnded) return;
  // No body, and nothing distinguishing a missing token from a wrong one. A 401
  // that explains itself is an oracle to steer a guess by, and it tells an
  // authorised caller nothing they did not already know.
  res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-length': 0 });
  res.end();
}

function respondPayloadTooLarge(req: IncomingMessage, res: ServerResponse, limit: number): void {
  // `Connection: close`, because the rest of the body is still arriving and this
  // connection's framing is no longer something we intend to follow. A second
  // request on it would begin at an offset nobody knows.
  sendRpcError(res, 413, RPC_TRANSPORT_ERROR, `Request body exceeds ${limit} bytes.`, {
    connection: 'close',
  });

  // Lingering close, in the sense RFC 9110 asks for. Node severs the socket the
  // moment the 413 has flushed, and severing one with an unread receive queue is
  // an RST — which discards the 413 out of the client's buffer along with
  // everything else, so the caller learns nothing except that the connection
  // died. Resuming pulls the remainder off the wire and throws it away
  // unbuffered (the read listeners are already detached), which is what lets the
  // answer survive long enough to be read. Memory stays bounded either way; this
  // only decides whether the caller finds out why.
  req.resume();
}

/**
 * Answers a failure that escaped everything else.
 *
 * The client gets a status and a fixed string; the detail goes to stderr, where
 * `note` redacts it. An exception message here can carry a URL, a path or a
 * value out of the configuration, and none of that is owed to whoever sent the
 * request that produced it.
 */
function fail(res: ServerResponse, error: unknown, what: string): void {
  const detail = error instanceof Error ? error.message : String(error);
  note(`${what} failed: ${detail}`);
  if (res.headersSent) {
    // Mid-stream: the status is long gone, so all that is left is to stop.
    res.end();
    return;
  }
  sendRpcError(res, 500, RPC_TRANSPORT_ERROR, 'Internal server error.');
}

// ---------------------------------------------------------------------------
// Host and origin allow lists
// ---------------------------------------------------------------------------

/**
 * Everything the `Host` header may say, and the origins that follow from it.
 *
 * On a wildcard bind the derived set is EMPTY, and that is the considered
 * answer rather than an omission. `0.0.0.0` means the request may arrive on any
 * interface under any name — the container's service name on a compose network,
 * an internal IP, the public name Traefik terminates — and `Host: 0.0.0.0:3000`
 * is a thing no client has ever sent. Deriving a list there would produce one
 * that 403s every legitimate request, which ends with the operator switching the
 * protection off entirely. So the operator's `--allowed-host` values are the only
 * source, an empty list means the transport skips the Host check, and `serveHttp`
 * says so on stderr at startup rather than leaving it to be discovered.
 *
 * Origin validation is what carries the threat model in that case, and it is the
 * half that matters: DNS rebinding is a browser attack, a browser always sends
 * `Origin` cross-site, and `handleMcp` refuses every value not on this list —
 * including, when the list is empty, all of them.
 *
 * Declared names are taken verbatim, lowercased. Behind TLS on 443 a browser
 * sends `mcp.example.com` with no port and behind a non-default port it sends
 * one, and guessing which the operator meant would be a worse failure than
 * asking them to write what their clients actually send.
 */
function buildAllowList(host: string, port: number, declared: readonly string[]): AllowList {
  const hosts = new Set<string>();
  const bind = host.trim().toLowerCase();

  if (!WILDCARD_HOSTS.has(bind)) {
    for (const spelling of hostSpellings(bind, port)) hosts.add(spelling);
    // One socket, three names, and which one a client types is not ours to pick.
    if (LOOPBACK_HOSTS.has(bind)) {
      for (const alias of LOOPBACK_HOSTS) {
        for (const spelling of hostSpellings(alias, port)) hosts.add(spelling);
      }
    }
  }

  for (const name of declared) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed !== '') hosts.add(trimmed);
  }

  const origins = new Set<string>();
  for (const authority of hosts) {
    for (const scheme of ORIGIN_SCHEMES) origins.add(`${scheme}://${authority}`);
  }
  return { hosts: [...hosts], origins: [...origins] };
}

function hostSpellings(name: string, port: number): string[] {
  const authority = formatAuthority(name, port);
  // On :80 both spellings are legitimate, and a check that knew only one would
  // 403 an ordinary request for a reason nobody would find.
  return port === DEFAULT_SCHEME_PORT ? [authority, bracketed(name)] : [authority];
}

function formatAuthority(name: string, port: number): string {
  return `${bracketed(name)}:${port}`;
}

/** An IPv6 literal is bracketed inside an authority; a name or an IPv4 address is not. */
function bracketed(name: string): string {
  return name.includes(':') && !name.startsWith('[') ? `[${name}]` : name;
}

/**
 * The host to put in the reported URL.
 *
 * A wildcard bind is reported as its loopback equivalent: `http://0.0.0.0:3000`
 * is an honest description of the binding and a URL that does not resolve on
 * Windows, and the returned `url` exists to be printed and dereferenced.
 */
function reachableHost(host: string): string {
  const bind = host.trim().toLowerCase();
  if (bind === '::') return '::1';
  return WILDCARD_HOSTS.has(bind) ? DEFAULT_HTTP_HOST : bind;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * One line per request: method, path, status, duration.
 *
 * Hung off `close` rather than `finish` because `close` is the only event that
 * fires on every ending — a clean response, a client that hung up, a stream that
 * was severed at shutdown — and it fires exactly once. For an SSE response the
 * duration therefore covers the whole stream, which is the honest reading of how
 * long the request occupied the server.
 *
 * Never the Authorization header and never the body. The status reads `-` rather
 * than `200` when nothing was ever sent, because `res.statusCode` defaults to 200
 * and a log that reports a status the client never saw is worse than none.
 *
 * A SUCCEEDING health check is the one thing not logged below `debug`. Coolify's
 * container health check runs every ten to thirty seconds forever, and at one
 * line each it buries the access log under the single least informative event
 * this server has — leaving an operator to grep past a day of `GET /healthz 200`
 * to find the request that actually failed. A FAILING health check is still
 * logged at every level, because that one is news.
 */
function logAccess(req: IncomingMessage, res: ServerResponse, logLevel: LogLevel): void {
  const startedAt = performance.now();
  res.once('close', () => {
    const ms = Math.round(performance.now() - startedAt);
    const status = res.headersSent ? String(res.statusCode) : '-';
    const path = loggablePath(req.url);
    if (path === HEALTH_PATH && res.statusCode < 400 && logLevel !== 'debug') return;
    note(`${req.method ?? '-'} ${path} ${status} ${ms}ms`);
  });
}

function pathOf(target: string | undefined): string {
  if (target === undefined) return '/';
  try {
    // Parsed rather than split on `?`: this also normalises `..` and percent
    // escapes, so a target cannot reach `/mcp` by a spelling the router misses.
    return new URL(target, PARSE_BASE).pathname;
  } catch {
    return '/';
  }
}

function loggablePath(target: string | undefined): string {
  const path = pathOf(target);
  return path.length > MAX_LOGGED_PATH_CHARS ? `${path.slice(0, MAX_LOGGED_PATH_CHARS)}...` : path;
}

/**
 * Writes one diagnostic line to stderr — never stdout, which carries JSON-RPC in
 * the other transport and is banned across `src/` for that reason.
 *
 * Redaction runs first and truncation second: cutting the string before masking
 * could leave the tail of a token that `redact` would otherwise have matched
 * whole.
 */
function note(message: string): void {
  const masked = redact(message).replace(NON_PRINTABLE, '?');
  const line = masked.length > MAX_LOG_CHARS ? `${masked.slice(0, MAX_LOG_CHARS)}...` : masked;
  process.stderr.write(`${PROGRAM}: ${line}\n`);
}
