# Streamable HTTP transport

Date: 2026-07-28
Status: approved, in implementation

## Why this and not something else

The README's own comparison table is the argument. Against Coolify's built-in
`/mcp` and `@masonator/coolify-mcp`, this server already wins two axes outright
— N instances against their 1, M teams against their 1 — and matches or beats
them on tools and API coverage.

It loses exactly one axis: Coolify's `/mcp` runs **inside the instance**, so
there is nothing to install and it lives where the data is. Every other
difference is decoration next to that, because it is the only one that decides
where the server can run rather than what it can do.

A Streamable HTTP transport closes it. Nothing else on the shortlist changes
which server a person picks:

- **Resources / Prompts / `outputSchema`** complete the MCP surface, which is
  worth doing, but nobody chooses an MCP server for having Prompts.
- **Registry listing and one-click bundles** are distribution, and distribution
  of an unshipped package is marketing.

`src/server.ts` was written for this. Its header already reads: _"Transport-
agnostic on purpose. `index.ts` attaches stdio; a future `serve --http` attaches
something else."_ This spec is that future, spelled out.

## What is being built

`coolify-mcp serve --http` — the same server, the same 15 tools, the same gate,
reachable over HTTP instead of a pipe. Plus the container and compose files that
let it be deployed **on Coolify itself**.

## Non-goals

- **OAuth 2.1 / the MCP authorization spec.** A bearer token set on the server
  is the model Coolify's own API already uses, and it is what this ships with.
  OAuth is a separate piece of work with an authorization server in it.
- **Session state, resumability, server-initiated messages.** See "Session
  model" below — this server has nothing to send unprompted.
- **CORS.** An MCP client is not a browser.
- **TLS termination.** That is the reverse proxy's job, and on Coolify it is
  Traefik's. The server speaks plain HTTP behind it.

## Session model: stateless

`sessionIdGenerator: undefined`.

The transport supports both modes. Stateful buys session IDs, a standalone `GET`
stream for server-initiated messages, and event replay. This server needs none
of it:

- It declares `tools.listChanged: true`, but the registered set is a pure
  function of configuration decided once at startup. The list never changes
  while the process runs, so there is never a notification to push.
- `deploy(wait: true)` does emit progress, and progress is the one thing that
  looks like it needs a stream. It does not need a _session_: MCP ties a
  progress notification to the token on the originating request, and Streamable
  HTTP carries those on that request's own SSE response. A `POST` answers its
  own progress.

So stateless costs nothing and removes a session store, an expiry policy, and a
class of bug where a client resumes onto a server that has forgotten it.

Each `POST` gets a fresh `McpServer` and transport. `buildServer` is pure and
does no I/O, so the cost is building ~16 Zod schemas — irrelevant beside a
Coolify round trip, and it buys complete isolation between concurrent callers.

## Surface

| Path          | Method          | Auth             | Behaviour                                                              |
| ------------- | --------------- | ---------------- | ---------------------------------------------------------------------- |
| `/mcp`        | `POST`          | Bearer, required | MCP JSON-RPC                                                           |
| `/mcp`        | `GET`, `DELETE` | Bearer, required | `405` — stateless, so there is no stream to open and no session to end |
| `/healthz`    | `GET`           | **exempt**       | `200 {"status":"ok"}`                                                  |
| anything else | any             | —                | `404`                                                                  |

`/healthz` is unauthenticated on purpose: it is what Coolify's container health
check calls, it is what a load balancer calls, and neither holds the token. It
reveals only that a process is listening — it does not report connection names,
versions, or configuration.

## Authentication

`COOLIFY_MCP_AUTH_TOKEN`, required.

**The server refuses to start without it.** This is the same fail-closed posture
as the existing "no connections configured" refusal, and for a stronger reason:
a server that binds a port while holding a live Coolify token and accepts
anyone is not a degraded configuration, it is an incident. A token shorter than
32 characters is refused the same way — a weak secret on this endpoint is
equivalent to none.

- Compared with `timingSafeEqual`, never `===`.
- Compared over a fixed-length digest of each side, so the comparison cannot
  leak the expected token's length through timing or through an early
  length check.
- Missing or wrong → `401` with `WWW-Authenticate: Bearer`. No body detail. A
  401 that explains _why_ is an oracle.

**The Coolify token never reaches the client.** The server holds it; the client
presents an unrelated secret. That separation is the point of the design: a
compromised MCP client credential does not become a Coolify credential, and
rotating one does not force rotating the other.

## Network hardening

- **Binds `127.0.0.1` by default.** `--host 0.0.0.0` has to be typed. Inside the
  container it is typed, because there the network boundary is the container.
- **DNS rebinding protection on**, via the transport's own
  `enableDnsRebindingProtection`. `allowedHosts` is derived from the resolved
  host and port; `--allowed-host` adds the public name the reverse proxy serves.
- **`Origin` validated** against the same list.
- **Request bodies capped** (4 MB default). An unbounded body on an
  unauthenticated-until-parsed endpoint is a memory exhaustion primitive.

## Logging

stderr, as in stdio mode — and not merely by habit: `no-console` and the
`process.stdout` ban in `eslint.config.js` cover `src/` precisely because the
stdio entry point cannot survive a stray write, and a second rule for HTTP mode
would be a rule to forget. Docker captures both streams anyway.

One line per request: method, path, status, duration. Never the Authorization
header, never the body, everything through `redact()`.

## Interfaces

Fixed here so the pieces can be built independently and still compose.

```ts
// src/http/http-auth.ts
export const AUTH_TOKEN_ENV = 'COOLIFY_MCP_AUTH_TOKEN';
export const MIN_AUTH_TOKEN_LENGTH = 32;

/** Reads and validates the bearer token. Throws ConfigError naming the remedy. */
export function resolveAuthToken(env: NodeJS.ProcessEnv): string;

/** Constant-time bearer check against the raw Authorization header value. */
export function isAuthorized(header: string | undefined, expected: string): boolean;
```

```ts
// src/http/serve.ts
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';

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

export function serveHttp(
  cfg: ServerConfig,
  options: HttpServeOptions,
): Promise<RunningHttpServer>;
```

`port: 0` binding an ephemeral port is not a convenience — it is what lets the
integration tests run in parallel without picking a port and hoping.

## CLI

```
coolify-mcp serve --http [--port 3000] [--host 127.0.0.1] [--allowed-host HOST]...
```

`--http` is explicit rather than implied by `serve`, matching the note already
in `server.ts` and leaving room for a second transport without a breaking
rename.

## Deployment

- **Dockerfile**, multi-stage, non-root, `HEALTHCHECK` against `/healthz`.
- **docker-compose.yml** consumable by Coolify.
- **docs/deploy.md** — env vars, reverse proxy, token generation, the read-only
  posture recommended as the default.

## Testing

- **Unit** — token resolution (absent, short, valid), constant-time comparison,
  header parsing (missing, malformed, wrong scheme, right scheme wrong value).
- **Integration** — a real server on an ephemeral port, a real
  `StreamableHTTPClientTransport` client: `initialize`, `tools/list`, one tool
  call, `/healthz`, `405` on `GET /mcp`, `404` elsewhere.
- **Security** — unauthenticated request refused before anything is parsed; a
  forged `Host` refused; an oversized body refused; and an assertion that no
  emitted log line contains the token.
- **CI** — a second smoke step that boots `--http` and completes a handshake
  over it, so the published artefact is proven on both transports.
