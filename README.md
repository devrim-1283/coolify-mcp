# coolify-mcp

**Fleet-level MCP server for Coolify — multiple instances and teams from one connection, full REST API coverage, MIT.**

[![npm](https://img.shields.io/npm/v/%40done-dynamics%2Fcoolify-mcp.svg)](https://www.npmjs.com/package/@done-dynamics/coolify-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

One MCP server that talks to every Coolify instance and every Coolify team you
have, from one connection. Search across the fleet in a single call, read logs
and environment variables, deploy, and reach all 189 catalogued REST operations
through a generic door.

---

## Quickstart (60 seconds)

Two environment variables and one command.

```bash
export COOLIFY_BASE_URL=https://coolify.example.com
export COOLIFY_API_TOKEN='13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

npx @done-dynamics/coolify-mcp install
```

PowerShell:

```powershell
$env:COOLIFY_BASE_URL = "https://coolify.example.com"
$env:COOLIFY_API_TOKEN = "13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

npx @done-dynamics/coolify-mcp install
```

Get the token from **Coolify → Keys & Tokens → API tokens**. `install` detects
the MCP clients on the machine, shows you a unified diff of every file it would
touch, and writes only after you approve.

Then verify:

```bash
npx @done-dynamics/coolify-mcp check      # is the instance reachable, and does the token work?
npx @done-dynamics/coolify-mcp doctor     # config health, and a scan for credentials at rest
```

### One thing to know before you start

**The installer writes pointer config only — never a credential.** The entry it
writes into your client config is `npx -y @done-dynamics/coolify-mcp@latest` and, at most, a
connection _name_. It never writes `COOLIFY_BASE_URL` or `COOLIFY_API_TOKEN`
into a file.

That means the two variables have to reach the server some other way:

| Client kind                                      | How the token arrives                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI clients (Claude Code, Codex, Kimi, OpenCode) | They inherit your shell environment. Export the two variables in `~/.zshrc`, `~/.bashrc`, or your PowerShell profile.                                                                                        |
| Editors (Cursor, Zed)                            | Inherit the environment of the process that launched them — which on macOS is often _not_ your shell. Add the variables to the entry's `env` block by hand, or use a [registry file](./docs/connections.md). |
| Claude Desktop                                   | Does **not** inherit the shell environment at all. Use a [registry file](./docs/connections.md) with `tokenCommand`/`tokenKeychain`, or put the values in the entry's `env` block.                           |

`npx @done-dynamics/coolify-mcp doctor` tells you which of these applies to your machine and
whether the token actually resolves.

---

## Why this exists

There are already two good ways to reach Coolify from an MCP client. This is an
honest account of both, and of the one axis where neither competes.

|                       | Coolify's built-in `/mcp`    | `@masonator/coolify-mcp` | **coolify-mcp** (this project)                                      |
| --------------------- | ---------------------------- | ------------------------ | ------------------------------------------------------------------- |
| Where it runs         | Inside your Coolify instance | Local process            | Local process, **or remote over HTTP**                              |
| Tools                 | 10                           | ~42, hand-curated        | 15 by default (16 with destructive enabled) + 189-operation catalog |
| Writes                | No — all 10 are read-only    | Yes                      | Yes, behind flags                                                   |
| Instances per process | 1                            | 1                        | **N**                                                               |
| Teams reachable       | The token's team             | The token's team         | **M — one connection per (instance, team)**                         |
| Cross-instance search | No                           | No                       | **Yes — `find_resources instance:"*"`**                             |
| API coverage          | Curated subset               | Curated subset           | **Full published surface** via `search_operations` → `execute_*`    |
| Transport             | HTTP, remote                 | stdio, local             | **stdio and HTTP**                                                  |
| Install               | Nothing to install           | npm                      | npm, an installer for 8 clients, or a container                     |
| License               | Coolify's                    | MIT                      | MIT                                                                 |

**Coolify's own `/mcp` endpoint** is the lowest-friction option by a mile:
nothing to install, nothing to configure, and it lives where the data is. It is
read-only and scoped to the token's team. Upstream
[PR #11000](https://github.com/coollabsio/coolify/pull/11000) would expand it
considerably; if it lands and you run one instance and one team, you may not
need this project at all.

Its remaining advantage over this project used to be that last clause — living
where the data is. `coolify-mcp serve --http` closes it: the same server, the
same fleet model, deployed as a container on Coolify itself and reached over
HTTP from any client on any machine. See [docs/deploy.md](./docs/deploy.md).

**[@masonator/coolify-mcp](https://github.com/StuMason/coolify-mcp)** is the
established third-party server and genuinely good — around 42 curated,
hand-shaped tools, popular for the right reasons. Its model is one instance per
process. Running three instances means running three servers, and the model
still cannot search across them in one call.

**Our axis is FLEET.** N instances × M teams from one connection, cross-instance
search, full catalog coverage. If you run one Coolify with one team, the
built-in endpoint or Mason's server may serve you better and with less setup.
If you are looking at four boxes and cannot remember which one `api-gateway`
lives on, that is what this is for.

We are not competing on tool count. See [docs/tools.md](./docs/tools.md) for why
the default surface is 15 tools and not 42.

---

## Install per client

Every snippet below is the byte-exact output of `npx @done-dynamics/coolify-mcp install` into an
empty config file. Nothing here is paraphrased, and keeping it that way is a
required check for anyone adding a client adapter — see
[CONTRIBUTING](./CONTRIBUTING.md#the-docs-parity-convention).

Prefer the installer. It merges into existing configs without disturbing other
MCP servers, preserves comments in JSONC files, refuses to write into a config
it cannot parse, and can be reversed with `npx @done-dynamics/coolify-mcp uninstall`.

### Claude Code — `~/.claude.json` or `<project>/.mcp.json`

```bash
npx @done-dynamics/coolify-mcp install --client claude-code
```

```json
{
  "mcpServers": {
    "coolify": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@done-dynamics/coolify-mcp@latest"
      ],
      "env": {}
    }
  }
}
```

Claude Code expands `${VAR}` and `${VAR:-default}` inside `env`, so you can add
`"COOLIFY_API_TOKEN": "${COOLIFY_API_TOKEN}"` yourself.
[Details →](./docs/clients/claude-code.md)

### Cursor — `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json`

```bash
npx @done-dynamics/coolify-mcp install --client cursor
```

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "@done-dynamics/coolify-mcp@latest"
      ],
      "env": {}
    }
  }
}
```

Cursor's reference syntax is `${env:NAME}`, **not** `${NAME}`. A Claude-style
reference is stored verbatim and reaches the server as literal text.
[Details →](./docs/clients/cursor.md)

### Codex CLI — `~/.codex/config.toml`

```bash
npx @done-dynamics/coolify-mcp install --client codex
```

```toml
[mcp_servers.coolify]
command = "npx"
args = [ "-y", "@done-dynamics/coolify-mcp@latest" ]
startup_timeout_sec = 60
```

Always stdio, never a `url` key — older Codex versions drop the _entire_
`config.toml` on an unknown key, taking every other MCP server in it with them.
[Details →](./docs/clients/codex.md)

### Kimi CLI — `~/.kimi/mcp.json`

```bash
npx @done-dynamics/coolify-mcp install --client kimi
```

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "@done-dynamics/coolify-mcp@latest"
      ],
      "env": {}
    }
  }
}
```

[Details →](./docs/clients/kimi.md)

### Zed — `settings.json`

```bash
npx @done-dynamics/coolify-mcp install --client zed
```

```json
{
  "context_servers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "@done-dynamics/coolify-mcp@latest"
      ],
      "env": {}
    }
  }
}
```

The key is `context_servers`, not `mcpServers` and not `agent_servers`. The file
is JSONC — the installer edits it through a JSONC writer so your comments
survive. [Details →](./docs/clients/zed.md)

### OpenCode — `opencode.json`

```bash
npx @done-dynamics/coolify-mcp install --client opencode --scope project
```

```json
{
  "mcp": {
    "coolify": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@done-dynamics/coolify-mcp@latest"
      ],
      "enabled": true,
      "environment": {}
    }
  }
}
```

Every field is spelled differently here: `command` is an array that includes the
executable, and the env key is `environment`.
[Details →](./docs/clients/opencode.md)

### Claude Desktop — `claude_desktop_config.json`

```bash
npx @done-dynamics/coolify-mcp install --client claude-desktop
```

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "@done-dynamics/coolify-mcp@latest"
      ],
      "env": {}
    }
  }
}
```

On Windows the installer emits `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "@done-dynamics/coolify-mcp@latest"]`, because Claude Desktop
spawns without a shell and `npx.cmd` cannot be executed directly. Claude Desktop
also does not inherit your shell environment — see
[details →](./docs/clients/claude-desktop.md).

### MiniMax CLI — `~/.minimax/config.yaml` — **UNVERIFIED, print only**

```bash
npx @done-dynamics/coolify-mcp install --client minimax --print
```

The key MiniMax uses for MCP servers is not known, and coolify-mcp will not
guess it: a wrong top-level key in that file would corrupt your model
configuration. The adapter is marked `confidence: 'unverified'`, which makes
`apply()` refuse to write. `--print` shows both plausible shapes plus the
procedure for settling which is correct.
[Details →](./docs/clients/minimax.md)

---

## Run it over HTTP

Everything above installs coolify-mcp as a local process your client spawns over
stdio. It also speaks Streamable HTTP, which means it can run once — on the
Coolify box, in a container — and serve every client you own.

```bash
export COOLIFY_MCP_AUTH_TOKEN="$(openssl rand -base64 32)"
npx @done-dynamics/coolify-mcp serve --http --port 3000
```

|                     | stdio                 | HTTP                        |
| ------------------- | --------------------- | --------------------------- |
| Started by          | your MCP client       | you, or a container runtime |
| Runs on             | every machine you use | one machine                 |
| Coolify token lives | on every machine      | on the server only          |
| Client needs        | the package           | a URL and a bearer token    |

The second and third rows are the point. With stdio, a laptop that talks to
Coolify is a laptop holding a live Coolify API token. Over HTTP the server holds
it and clients present an unrelated bearer token, so a compromised client
credential is not a Coolify credential and rotating one does not force rotating
the other.

Two endpoints: `POST /mcp` requires `Authorization: Bearer`, and `GET /healthz`
does not — a container health check has no token, and the endpoint reveals only
that a process is listening.

`COOLIFY_MCP_AUTH_TOKEN` is **required**, minimum 32 characters, and the server
refuses to start without it. A process that binds a port while holding a live
Coolify token and accepts anyone is not a degraded configuration.

The server binds `127.0.0.1` unless you type `--host 0.0.0.0`, and DNS rebinding
protection means the public hostname your reverse proxy serves has to be named
with `--allowed-host`. It does not terminate TLS — put a proxy in front of it;
on Coolify that is Traefik and it is already there.

[Deploying on Coolify →](./docs/deploy.md)

---

## Multiple instances and teams

A connection is `(baseUrl, token)`. That is the whole model.

A Coolify API token is bound in the database to the team that was active when it
was created, and the REST API has no team-switch parameter — no `X-Team-Id`
header, no `?team=` query. Another team's UUIDs simply return 404. So a second
team is a second token, which is a second connection, pointing at the same
`baseUrl`. N connections covers N instances × M teams uniformly, and no separate
"team" concept is needed anywhere in the server.

```bash
COOLIFY_BASE_URL_PROD=https://coolify.example.com
COOLIFY_API_TOKEN_PROD=13|...

COOLIFY_BASE_URL_ACME=https://coolify.acme.dev
COOLIFY_API_TOKEN_ACME=41|...          # acme, team "platform"

COOLIFY_BASE_URL_ACME_OPS=https://coolify.acme.dev
COOLIFY_API_TOKEN_ACME_OPS=42|...      # same instance, team "ops"

COOLIFY_CONNECTION=prod                # the default for read tools
```

With more than one connection every tool grows an `instance` parameter, typed as
an enum over the configured names. Reads may default to the designated
connection; **writes and destructive operations require an explicit `instance`
with no default** — guessing wrong on a read costs one wasted call, guessing
wrong on a deploy costs a production incident.

`find_resources` alone accepts `instance: "*"`, which queries every connection in
parallel and tags each row with the instance it came from. One unreachable box
does not take the answer down: failures land in `meta.errors[]` beside the rows
that did come back.

---

## Configuration

Three layers, in increasing order of ceremony. Full reference:
[docs/connections.md](./docs/connections.md).

**Layer 0 — two variables, no file.** The 90% case.

```
COOLIFY_BASE_URL=https://coolify.example.com
COOLIFY_API_TOKEN=13|...
```

A single connection named `default` is born. The `instance` parameter is absent
from every tool schema.

**Layer 1 — named connections, still no file.**

```
COOLIFY_BASE_URL_<NAME>  defines a connection called <name>
COOLIFY_API_TOKEN_<NAME> supplies its token by convention
COOLIFY_CONNECTION       picks the default
```

`COOLIFY_BASE_URL_ACME_OPS` defines the connection `acme-ops`: the suffix is
lowercased and `_` is read as `-`.

**Layer 2 — a registry file.** First hit wins, wholesale; there is no merging
across locations.

1. `$COOLIFY_MCP_CONFIG` (an explicit path that does not exist is an error, not a fallthrough)
2. the nearest `.coolify-mcp.json`, walking up from the working directory and stopping at a repo root or `$HOME`
3. `$XDG_CONFIG_HOME/coolify-mcp/config.json` (on Windows, `%APPDATA%\coolify-mcp\config.json`)
4. `~/.coolify-mcp/config.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/devrim-1283/coolify-mcp/main/schema/config.v1.json",
  "version": 1,
  "defaultConnection": "prod",
  "connections": {
    "prod":     { "baseUrl": "https://coolify.example.com", "readOnly": true },
    "acme":     { "baseUrl": "https://coolify.acme.dev",
                  "tokenCommand": ["op", "read", "op://Infra/coolify-acme/credential"] },
    "acme-ops": { "baseUrl": "https://coolify.acme.dev",
                  "tokenKeychain": { "service": "coolify-mcp", "account": "acme-ops" } }
  }
}
```

`acme` and `acme-ops` are the same instance and two different teams. That is all
multi-team is.

### Precedence

| Setting                                                       | Rule                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A connection name defined in both env and file                | **Env replaces the file entry WHOLE.** No field-level merge. `doctor` reports the shadowing.                                                                        |
| `COOLIFY_CONNECTION` vs `defaultConnection`                   | Env wins. `COOLIFY_CONNECTION=PROD` is accepted for `prod`.                                                                                                         |
| `COOLIFY_READ_ONLY=true` vs a file connection                 | **Tightens only.** It can close a connection the file left open; it can never re-open one the file closed.                                                          |
| `COOLIFY_ALLOW_DESTRUCTIVE` vs `allowDestructive` in the file | The file value wins for that connection when present, otherwise the env default applies. Both must admit the call for the destructive tool to be registered at all. |
| `extends` in a registry file                                  | Exactly one level. A name in both replaces the base entry whole.                                                                                                    |
| No default and several connections                            | There is **no** default. Every tool requires an explicit `instance`.                                                                                                |

Other variables: `COOLIFY_TIMEOUT_MS` (1000–120000, default 30000),
`COOLIFY_INSECURE_TLS`, `COOLIFY_LOG_LEVEL` (`error`/`warn`/`info`/`debug`).

---

## Secrets

**Do this.**

- Keep the token in an environment variable, a secret manager, or the OS keychain.
- Use `tokenCommand` for `op` / `pass` / `vault` / `gopass` — it is a shell-free argv array, so any command that prints the token works.
- Create the Coolify token with the narrowest ability set that does the job. `read` + `read:sensitive` covers everything read-only.
- Prefer `readOnly: true` on connections you do not need to write to.
- Run `npx @done-dynamics/coolify-mcp doctor` on any machine that has ever had an MCP client on it.

**Never do this.**

- Never paste a token into a client config file. `~/.claude.json`, `mcp.json` and `config.toml` are synced, backed up, screen-shared and pasted into bug reports.
- Never put a token in a registry file. The schema has **no** `token` property and `additionalProperties: false`, so it is a validation error, not a discouraged option — and the error message names the three supported sources.
- Never embed credentials in `baseUrl` (`https://user:pass@host` is rejected).
- Never commit a `.coolify-mcp.json` containing anything but pointers.

**Run doctor.**

```bash
npx @done-dynamics/coolify-mcp doctor              # your entry only
npx @done-dynamics/coolify-mcp doctor --all-servers # every MCP server in every config
npx @done-dynamics/coolify-mcp doctor --json        # for CI
```

Doctor scans every client config for the Laravel Sanctum token shape
(`<id>|<40 chars>`), literal `Bearer` headers, credential-shaped env literals and
POSIX modes that let other users read the file. Exit code 2 means a credential
is sitting at rest. `--fix` is deliberately narrow: it rewrites a literal to
`${VAR}` only when `$VAR` already holds exactly that value and the client is
known to expand the reference, it never prints the value, and it always tells
you to rotate anyway. Full details: [docs/secrets.md](./docs/secrets.md).

---

## Tools

15 tools by default. 11 when the server is read-only, 16 when destructive
operations are enabled. Everything else in Coolify's API is behind
`search_operations` → `describe_operation` → `execute_*`.

| Tool                            | Class           | Coolify ability                                    |
| ------------------------------- | --------------- | -------------------------------------------------- |
| `find_resources`                | read            | `read`                                             |
| `get_resource`                  | read            | `read`                                             |
| `get_logs`                      | read            | `read:sensitive`                                   |
| `get_environment_variables`     | read            | `read:sensitive`                                   |
| `list_deployments`              | read            | `read`                                             |
| `get_deployment`                | read            | `read` (`read:sensitive` for build log content)    |
| `list_servers`                  | read            | `read`                                             |
| `list_projects`                 | read            | `read`                                             |
| `search_operations`             | read            | none — local catalog                               |
| `describe_operation`            | read            | none — local catalog                               |
| `execute_read_operation`        | read            | `read`, or `read:sensitive` on `/logs` and `/envs` |
| `deploy`                        | write           | `deploy`                                           |
| `control_resource`              | write           | `write`                                            |
| `set_environment_variables`     | write           | `write`                                            |
| `execute_write_operation`       | write           | `write`                                            |
| `execute_destructive_operation` | **destructive** | `write` (or `root`)                                |

`control_resource` carries `destructiveHint: false` on purpose: stopping a
resource causes downtime but destroys no data and is undone by the `start` in the
same enum. The destructive flag is reserved for operations that cannot be undone
through the API. The reasoning is spelled out in
[docs/tools.md](./docs/tools.md), along with every parameter of every tool.

### Enabling destructive operations

`execute_destructive_operation` is **not registered** unless
`COOLIFY_ALLOW_DESTRUCTIVE=true` — it does not appear in `tools/list` at all,
rather than appearing and refusing. With it off, no tool on the server carries
`destructiveHint: true`, so a host that auto-approves non-destructive tools is
auto-approving something genuinely non-destructive.

The gate is enforced three times: at registration (what exists), at dispatch
(what each door admits) and in the HTTP client before the socket opens (what may
leave the process). The last one cannot be routed around by any tool.

---

## Enterprise

**Version pinning.** By default the installer writes `@done-dynamics/coolify-mcp@latest`, so
every client spawn resolves the newest published version and may execute code
that did not exist when you installed it. Convenient for one developer,
out of policy at most companies:

```bash
npx @done-dynamics/coolify-mcp install --all-detected --pin        # pin the version you are running now
npx @done-dynamics/coolify-mcp install --all-detected --pin=1.4.2  # pin an exact version
```

A pinned install upgrades only when you run `install` again. `doctor` reports
`unpinned-version` when it finds `@latest`, and `pinned-version-mismatch` when
two clients on one machine disagree about which version to run.

**Read-only connections.** `readOnly: true` on a connection — or
`COOLIFY_READ_ONLY=true` process-wide — refuses every non-GET at the HTTP client,
regardless of what the token is scoped to. When every connection is read-only,
the write and destructive tools are never registered, so the model is not holding
tools it cannot use. Read-only is a ceiling: no per-connection setting can widen
it.

**npm provenance.** Releases are published from GitHub Actions with
`npm publish --provenance` over OIDC, gated behind a manual approval environment,
from a tag matching `^v[0-9]+\.[0-9]+\.[0-9]+$`. Every workflow action is pinned
to a full commit SHA. The provenance attestation is verifiable on npm.

**What `doctor --json` gives a platform team.** A stable, machine-readable
report with kebab-case finding codes suitable for matching in a pipeline:

```jsonc
{
  "runtime":     { "node": "v22.11.0", "packageVersion": "0.1.0", "platform": "darwin", "cwd": "…" },
  "connections": [{ "name": "prod", "baseUrl": "…", "tokenSource": "$COOLIFY_API_TOKEN_PROD (by convention, set)",
                    "resolved": true, "wellFormed": true, "readOnly": true,
                    "allowDestructive": false, "shadowsFile": false }],
  "clients":     [{ "adapterId": "claude-code-user", "path": "…", "configExists": true,
                    "entryPresent": true, "packageSpec": "@done-dynamics/coolify-mcp@1.4.2",
                    "confidence": "verified", "unscannedEntries": 3 }],
  "findings":    [{ "code": "plaintext-credential", "severity": "critical",
                    "file": "…", "keyPath": ["mcpServers","other","env","API_TOKEN"],
                    "remediation": "ROTATE THIS TOKEN NOW. …" }]
}
```

Exit codes: `0` clean, `1` warnings, `2` a credential was found at rest. Findings
never contain a secret value — not the value, not a prefix, not a length — and
everything that leaves the module passes through `redact()`. Run
`coolify-mcp doctor --all-servers --json` fleet-wide and alert on
`severity == "critical"`.

**Security posture we recommend as the default:** a read-scoped Coolify token
(`read` + `read:sensitive`) plus `readOnly: true`, and a second, explicitly named
connection for the writes you actually need. See [SECURITY.md](./SECURITY.md)
for the threat model.

---

## Limitations

This section is here so you find out now rather than at 2am.

**Pagination is ours, and it is not stable under concurrent mutation.** Coolify
does not paginate: `/applications`, `/databases`, `/services`, `/resources` and
`/deployments` each return the complete array (on an instance with 80
applications, `/applications` exceeds 1 MB). So we fetch the whole list, filter,
sort and slice it in-process. `meta.next_cursor` is an opaque offset plus a hash
of the filters it was produced under — replaying a cursor against different
filters is refused, but a resource created or deleted between page 1 and page 2
will shift the rows. This is offset pagination over a re-fetched list, not a
snapshot. The one exception is
`GET /deployments/applications/{uuid}?skip&take`, which upstream really does
paginate, and which `list_deployments` uses when given an `application_uuid`.

**Things Coolify's API cannot do, so neither can we.** No command execution
(Coolify's web terminal is a websocket, not REST). No notification API. No S3
storage CRUD. No healthcheck endpoint — healthchecks are roughly fifteen fields
on `PATCH /applications/{uuid}`. No shared environment variables. No team writes.
We will not ship a tool that pretends otherwise.

**The catalog is generated from a pinned spec.** It is built at release time from
Coolify **4.2.0** (spec sha `150e9f3c…`), covering **189 operations** — 74 read,
86 write, 29 destructive, 3 flagged as provisioning billable cloud
infrastructure. An instance newer than the catalog may expose operations we do
not list; `search_operations` says so explicitly when nothing matches, naming the
spec version and date. CI fails the build when `npm run codegen` produces a diff,
so upstream drift is loud rather than silent.

**Generic body validation is deliberately permissive.** Coolify's OpenAPI
document is generated from PHP attributes and is wrong in places
([upstream #7702](https://github.com/coollabsio/coolify/issues/7702)). A generic
executor that hard-validated against it would reject _valid_ calls with no way to
override. So `execute_write_operation` passes `body` through unchanged and lets
Coolify's own per-field validation errors come back verbatim. Path parameters
_are_ validated strictly — those come from the URL template, which cannot be
wrong.

**The rate-limit bucket is per Coolify user, not per token.** Five tokens
belonging to one account share one allowance (documented default 200/min, read
from `X-RateLimit-Limit` because self-hosters change it). Fleet fan-out across
connections owned by the same user draws on the same bucket. The client retries a
429 exactly once, and only when `Retry-After` is under 30 seconds.

**Coolify silently drops around 22 fields on PATCH.** `removeUnnecessaryFields`
strips them server-side. That is a no-op, not an error, and there is nothing we
can do about it other than tell you.

**`deploy(wait: true)` polls, and the queue response shape is not fully
verified.** `POST /v1/deploy`'s body has not been confirmed against a live
instance; the handler reads the documented `{ deployments: [...] }` shape,
tolerates the containers Coolify uses elsewhere, and falls back to matching on
the application's deployment history when it cannot find a `deployment_uuid`.
The fallback is timestamp-based and therefore racy under concurrent deploys.

**`insecureTLS` needs an optional package.** Node's `fetch` has no per-request
TLS switch; the only hook is undici's dispatcher, and undici is not a dependency
(no native modules, fast cold start). Without `undici` present in your tree the
flag warns on stderr and requests stay verified. Prefer
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`, which fixes the trust chain instead of
switching verification off.

**Client paths that are not fully confirmed.** Zed on Windows (derived from
`%APPDATA%`), the OpenCode _global_ config location, and the Claude Desktop Linux
path (there is no official Linux build). Each is flagged by `doctor` with a
`*-path-unconfirmed` finding when the file is absent. MiniMax is unverified
end-to-end and is print-only. See [docs/clients/](./docs/clients/).

---

## Commands

```
npx @done-dynamics/coolify-mcp install [--client a,b] [--scope user|project] [--connection NAME]
                        [--pin[=VERSION]] [--transport stdio|http] [--no-native-cli]
                        [--update] [--dry-run] [--print] [--yes] [--json]
npx @done-dynamics/coolify-mcp doctor  [--all-servers] [--fix] [--json]
npx @done-dynamics/coolify-mcp uninstall [--client a,b] [--all] [--scope user|project] [--force]
                          [--dry-run] [--yes] [--json]
npx @done-dynamics/coolify-mcp connections [--json]
npx @done-dynamics/coolify-mcp check [--connection NAME] [--json]
npx @done-dynamics/coolify-mcp serve --http [--port N] [--host ADDR] [--allowed-host HOST]
```

`coolify-mcp <command> --help` for per-command options.

---

## Documentation

|                                              |                                                                |
| -------------------------------------------- | -------------------------------------------------------------- |
| [docs/connections.md](./docs/connections.md) | Connections, instances, teams, the registry file, precedence   |
| [docs/secrets.md](./docs/secrets.md)         | Token sources, doctor, rotation                                |
| [docs/tools.md](./docs/tools.md)             | Every tool, every parameter, the danger gate, response shaping |
| [docs/deploy.md](./docs/deploy.md)           | Running it over HTTP, in a container, on Coolify itself        |
| [docs/clients/](./docs/clients/)             | One page per client: exact file, exact snippet, what to verify |
| [SECURITY.md](./SECURITY.md)                 | Threat model and disclosure                                    |
| [CONTRIBUTING.md](./CONTRIBUTING.md)         | Dev loop, and how to add a client adapter                      |

## Requirements

Node.js ≥ 20.10. No native dependencies, ever — that is what keeps
`npx @done-dynamics/coolify-mcp` working everywhere. Runtime dependencies are
`@modelcontextprotocol/sdk`, `zod`, `smol-toml`, `jsonc-parser` and `yaml`.

## License

MIT © Devrim Tuncer. Not affiliated with or endorsed by Coollabs or the Coolify
project.
