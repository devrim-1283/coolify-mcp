# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things count as breaking changes on top of the obvious ones, because both are
load-bearing for people who build on this:

- **Removing or renaming a tool, or narrowing a tool's parameters.** Adding an
  optional parameter is a minor change; making one required is not.
- **Changing the registry file schema in a way that rejects a file that used to
  validate.** New optional properties are minor.

The generated catalog tracking a new Coolify release is a **minor** change: it can
add operations that `search_operations` did not previously return.

## [Unreleased]

## [0.1.0] — 2026-07-28

Initial release.

### Added

**Streamable HTTP transport.** `coolify-mcp serve --http` runs the same server,
the same tools and the same gates over a socket instead of a pipe, so it can run
somewhere other than the machine the client is on — including as a container on
Coolify itself. `Dockerfile`, `docker-compose.yml` and
[docs/deploy.md](./docs/deploy.md) cover that deployment.

This closes the one axis where Coolify's built-in `/mcp` endpoint was ahead of
this project: living where the data is. See the comparison table in the README.

- Stateless (`sessionIdGenerator: undefined`). The registered tool set is a pure
  function of configuration decided at startup, so there is never a
  server-initiated message to push, and `deploy(wait: true)` carries its progress
  notifications on the originating request's own SSE response rather than
  needing a session. Each `POST` gets a fresh server and transport.
- `POST /mcp` requires `Authorization: Bearer`; `GET /healthz` does not, because
  a container health check holds no token and the endpoint reveals only that a
  process is listening.
- `COOLIFY_MCP_AUTH_TOKEN` is **required** — minimum 32 characters, printable
  ASCII — and the server refuses to start without it. It is compared in constant
  time over fixed-length digests, so neither its value nor its length leaks
  through timing. It is unrelated to `COOLIFY_API_TOKEN`: the server keeps the
  Coolify token and never sends it to a client, so a compromised client
  credential is not a Coolify credential and rotating either leaves the other
  alone.
- Binds `127.0.0.1` unless `--host` says otherwise. DNS rebinding protection is
  on, with `--allowed-host` — or `COOLIFY_MCP_ALLOWED_HOSTS`, comma-separated —
  for the public name a reverse proxy serves. Under a wildcard bind the derived
  allow list is empty and Host validation is skipped, because `Host: 0.0.0.0`
  is a header no client sends; the server says so on stderr at startup, and in
  a container that setting is the only thing that turns the check on at all.
  Request bodies are capped at 4 MB.
- Access log on stderr, one line per request, with a succeeding `/healthz`
  suppressed below `debug` — a health check every ten seconds otherwise buries
  every request worth reading.
- TLS is not terminated here. That is the reverse proxy's job, and on Coolify it
  is Traefik's.

**Fleet model.** A connection is `(baseUrl, token)`. Because a Coolify API token
is bound in the database to the team that was active when it was created and the
REST API has no team-switch parameter, a second team is simply a second
connection with the same base URL. N connections covers N instances × M teams
with no extra concept.

- Three configuration layers: two environment variables; named connections via
  `COOLIFY_BASE_URL_<NAME>` / `COOLIFY_API_TOKEN_<NAME>`; a registry file found by
  first-hit-wins lookup with no cross-location merging. Single-level `extends`.
- `instance` parameter emitted conditionally: absent with one connection, an enum
  over configured names with several, and **required with no default** on write
  and destructive tools.
- `find_resources` accepts `instance: "*"` — a parallel fan-out across every
  configured connection, with per-connection failures reported in `meta.errors[]`
  rather than taking the whole answer down.

**Tools.** 15 registered by default; 11 under `COOLIFY_READ_ONLY`; 16 with
`COOLIFY_ALLOW_DESTRUCTIVE=true`.

- Read: `find_resources`, `get_resource`, `get_logs`,
  `get_environment_variables`, `list_deployments`, `get_deployment`,
  `list_servers`, `list_projects`.
- Write: `deploy` (with `wait`, progress notifications and cancellation),
  `control_resource`, `set_environment_variables`.
- Catalog: `search_operations`, `describe_operation`, `execute_read_operation`,
  `execute_write_operation`, `execute_destructive_operation`.

**Catalog.** 189 operations generated at build time from Coolify 4.2.0's OpenAPI
spec (sha256 `150e9f3c…`) and compiled into the package — no runtime spec fetch,
no network dependency, no non-determinism. 74 safe, 86 write, 29 destructive;
3 flagged as provisioning billable cloud infrastructure. `npm run codegen:check`
fails the build on upstream drift.

**Security.**

- Tools accept connection **names**, never URLs, hosts or tokens — a prompt
  injection cannot redirect the bearer token to an attacker's host.
- The HTTP client pins the request origin, rejects unsafe paths, and **refuses
  every redirect**, cross-host or otherwise.
- The registry file schema has no `token` property and `additionalProperties:
false`, so a literal credential in a config file is a validation error.
- Three-layer destructive gate: registration, dispatch, and a transport-level
  refusal that no tool can route around. `readOnly` connections refuse every
  non-GET at the same chokepoint, regardless of token scope.
- `tokenCommand` is a shell-free argv array; the child process never receives our
  tokens.
- Resolved tokens are registered with a process-wide redaction set and stripped
  from every output path, with the Laravel Sanctum shape matched as a backstop.
- Response bodies are scrubbed of the bearer token before parsing.

**Installer.** `npx @done-dynamics/coolify-mcp install` for eight clients across twelve adapters:
Claude Code (user + project), Cursor (user + project), Codex CLI, Kimi CLI, Zed
(user + project), OpenCode (user + project) and Claude Desktop — eleven verified
adapters — plus MiniMax, which is print-only and unverified.

- Writes **pointer config only** — command, arguments and at most a connection
  name. Never a credential.
- Pure planning: `--dry-run` renders a unified diff from the same call that would
  perform the write.
- JSONC configs are edited through `jsonc-parser`, so comments survive. TOML is
  append-only and refuses to merge into a file that does not parse.
- Codex is always written as stdio, never with a `url` key.
- Claude Desktop gets a `cmd /c` wrapper on Windows.
- `confidence: 'unverified'` mechanically prevents an adapter from writing.

**CLI.** `install`, `uninstall`, `doctor`, `connections`, `check`.

- `doctor` is a read-only scan of connections, client configs and credentials at
  rest, with kebab-case finding codes and exit codes 0 / 1 / 2 (2 = a credential
  was found in plaintext). `--json` for fleet-wide CI. `--fix` is deliberately
  narrow and always recommends rotation.
- `check` probes `/api/health` unauthenticated and `/api/v1/teams/current`
  authenticated, so a URL problem and a token problem cannot be confused — and it
  names the team a token belongs to.

**Response shaping.** One envelope for every tool. 130,000-byte budget, per-tool
projection allowlists, in-process pagination with a filter-hashed cursor,
ANSI-stripped and byte-budgeted logs, and graduated narrowing that always records
what it dropped in `meta.truncation`.

**Packaging.** ESM, Node ≥ 20.10, bundled with tsup for cold-start speed. No
native dependencies. Published with `npm publish --provenance` over OIDC from a
tag, gated behind a manual approval environment. Source maps are built but not
published: they were two thirds of the tarball, and every MCP client unpacks
this package through `npx` on a cold machine before it will speak a word.

### Known limitations

Documented in full in [README.md](./README.md#limitations). In short: pagination
is offset-based over a re-fetched list and is not stable under concurrent
mutations; Coolify has no API for command execution, notifications, S3 storage
CRUD, healthchecks, shared environment variables or team writes, so neither do we;
the catalog is pinned to one Coolify release, so a newer instance may expose
operations it does not list; `POST /v1/deploy`'s response shape has not been
confirmed against a live instance; and the Zed Windows path, the OpenCode global
path, the Claude Desktop Linux path and the entire MiniMax config key remain
unconfirmed.

[Unreleased]: https://github.com/devrim-1283/coolify-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/devrim-1283/coolify-mcp/releases/tag/v0.1.0
