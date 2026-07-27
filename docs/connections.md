# Connections, instances and teams

## A connection is `(baseUrl, token)`

That is the entire model. There is no separate "instance" object and no "team"
object anywhere in this server, and that is a deliberate consequence of how
Coolify works.

A Coolify API token is a Laravel Sanctum token whose database row carries a
`team_id`. Every request resolves the team **from the token** — there is no
`X-Team-Id` header, no `?team=` parameter, and no switch call. Ask for another
team's resource UUID and you get a 404.

So:

- A second **instance** is a second base URL, and therefore a second connection.
- A second **team** is a second token, and therefore also a second connection —
  with the *same* base URL.

N connections covers N instances × M teams uniformly. Nothing else is needed.

```
prod       https://coolify.example.com    token 13|…   team "platform"
acme       https://coolify.acme.dev       token 41|…   team "platform"
acme-ops   https://coolify.acme.dev       token 42|…   team "ops"
```

`acme` and `acme-ops` are one instance and two teams. Multi-team is just that.

## Connection names

Names are slugs: `^[a-z0-9][a-z0-9-]{0,30}$` — lowercase letters, digits and
dashes, starting with a letter or digit, 31 characters max.

They are slugs because a name has to survive a round trip through an environment
variable name:

```
acme-ops   <->   COOLIFY_BASE_URL_ACME_OPS
                 COOLIFY_API_TOKEN_ACME_OPS
```

Uppercase and `-` becomes `_` in one direction; lowercase and `_` becomes `-` in
the other. Anything outside that alphabet makes the mapping ambiguous, so it is
rejected at startup with a message naming the rule.

## Layer 0 — two variables, no file

The case this project is optimised for.

```bash
COOLIFY_BASE_URL=https://coolify.example.com
COOLIFY_API_TOKEN=13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A single connection named `default` is born, and it is its own default. Because
there is exactly one, the `instance` parameter is **absent from every tool
schema** — not optional with a default, absent. A parameter that can take one
value is pure context cost on every turn.

`COOLIFY_BASE_URL` may be written with or without the API prefix; the client
normalises `https://coolify.example.com`, `…/api` and `…/api/v1` to the same
place. Credentials embedded in the URL (`https://user:pass@host`) are rejected.

## Layer 1 — named connections, still no file

```bash
COOLIFY_BASE_URL_PROD=https://coolify.example.com
COOLIFY_API_TOKEN_PROD=13|…

COOLIFY_BASE_URL_ACME=https://coolify.acme.dev
COOLIFY_API_TOKEN_ACME=41|…

COOLIFY_BASE_URL_ACME_OPS=https://coolify.acme.dev
COOLIFY_API_TOKEN_ACME_OPS=42|…

COOLIFY_CONNECTION=prod
```

`COOLIFY_BASE_URL_<NAME>` is what **defines** a connection. The token variable
alone does nothing.

Every supported MCP client config format has an `env` block, so a three-instance
setup can live entirely inside one client config with no coolify-mcp file at all.

## Layer 2 — a registry file

Needed when you want per-connection settings (`readOnly`, `timeoutMs`) or token
sources other than environment variables (`tokenCommand`, `tokenKeychain`).

### Where it is looked for

**First hit wins, wholesale.** The first location that has a file *is* the
config; no other location is consulted and nothing is merged across them.
Cross-scope merging is where configuration systems stop being explainable —
"which of these four files set `readOnly`?" has no good answer, so the question
is never created.

1. **`$COOLIFY_MCP_CONFIG`** — an explicit path. If it points at something that
   does not exist, that is an **error**, not a reason to quietly fall through to
   a file you are not looking at. `~/` is expanded; relative paths resolve
   against the working directory.
2. **The nearest `.coolify-mcp.json`**, walking up from the working directory.
   The walk stops at a directory containing `.git` (checked *after* that
   directory's own candidate, so a repository root's config still wins) and at
   `$HOME`. That is what stops a config in a parent project — or worse, one in
   your home directory reached by accident — from silently governing an
   unrelated checkout.
3. **`$XDG_CONFIG_HOME/coolify-mcp/config.json`**. When `XDG_CONFIG_HOME` is
   unset this is `%APPDATA%\coolify-mcp\config.json` on Windows and
   `~/.config/coolify-mcp/config.json` everywhere else.
4. **`~/.coolify-mcp/config.json`**.

The file is **strict JSON**. Comments and trailing commas are not allowed; a
UTF-8 BOM is tolerated, because Windows editors write one and `JSON.parse`
rejects it with a message that says nothing about BOMs.

### The file

```json
{
  "$schema": "https://raw.githubusercontent.com/devrim-1283/coolify-mcp/main/schema/config.v1.json",
  "version": 1,
  "defaultConnection": "prod",
  "connections": {
    "prod": {
      "baseUrl": "https://coolify.example.com",
      "label": "Production (platform team)",
      "readOnly": true
    },
    "acme": {
      "baseUrl": "https://coolify.acme.dev",
      "tokenCommand": ["op", "read", "op://Infra/coolify-acme/credential"]
    },
    "acme-ops": {
      "baseUrl": "https://coolify.acme.dev",
      "tokenKeychain": { "service": "coolify-mcp", "account": "acme-ops" },
      "allowDestructive": false,
      "timeoutMs": 60000
    }
  }
}
```

`$schema` points at the published JSON Schema, which ships in the npm package —
editors validate and autocomplete against it.

### Connection properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | string | **required** | `http(s)` only. May not embed credentials. |
| `label` | string | — | 1–120 characters. Human description; not used for matching. |
| `tokenEnv` | string | — | Environment variable holding the token. |
| `tokenCommand` | string[] | — | argv array, 1–32 elements. No shell. |
| `tokenKeychain` | `{service, account}` | — | Platform keychain. See [secrets.md](./secrets.md). |
| `readOnly` | boolean | `false` | Refuses every non-GET at the HTTP client. |
| `allowDestructive` | boolean | *(env default)* | Can only narrow in practice — see the precedence table. |
| `timeoutMs` | integer | `30000` | 1000–120000. |
| `insecureTLS` | boolean | `false` | Needs the optional `undici` package to take effect. |

At most **one** of `tokenEnv` / `tokenCommand` / `tokenKeychain` may be set. Two
sources means two answers to "where is the token", and no rule for which wins.

**There is no `token` property, and `additionalProperties` is `false`.** Writing
a literal credential into this file is a schema validation error, not a
discouraged option — and the error names the three supported sources and the
environment variable that already works by convention. That is the enforcement
mechanism; see [secrets.md](./secrets.md).

If you set none of the three sources, `$COOLIFY_API_TOKEN_<NAME>` is read by
convention. That is what makes `{"baseUrl": "…"}` a complete connection entry.

### `extends`

```json
{
  "version": 1,
  "extends": "~/work/coolify-base.json",
  "connections": {
    "prod": { "baseUrl": "https://coolify.example.com", "readOnly": false }
  }
}
```

Exactly **one** level: if the base file also has an `extends`, that is an error.
A chain of config files makes the effective configuration impossible to read off
any single file.

The path resolves relative to the referring file, with `~/` expanded. A
connection name defined in both replaces the base entry **whole** — the same rule
as env-over-file, so every connection is described in exactly one place.

## Precedence

| Question | Answer |
|---|---|
| A name is defined in both the environment and the file | **The environment replaces the file entry WHOLE.** No field-level merge — a half-env, half-file connection is not something anyone can hold in their head. `doctor` reports it as `env-var-shadows-file`. |
| Which file wins | The first location that has one. No merging across locations. |
| `COOLIFY_CONNECTION` vs `defaultConnection` | `COOLIFY_CONNECTION` wins. `COOLIFY_CONNECTION=PROD` resolves to `prod`, because the matching variable is spelled `COOLIFY_BASE_URL_PROD` and failing on that would teach nothing. Naming a connection that does not exist is an error that lists the ones that do. |
| `COOLIFY_READ_ONLY=true` vs a file connection | **Tightens only.** It is OR-ed into every file connection's `readOnly`, so it can close a connection the file left open and can never re-open one the file closed. Read-only is a kill switch; a kill switch that an environment variable can undo is not one. |
| `COOLIFY_ALLOW_DESTRUCTIVE` vs `allowDestructive` in the file | The file value wins for that connection when present; otherwise the env value is the default. In practice this can only narrow: the destructive tool is registered from the process-wide flag, so `true` in the file without the env flag grants nothing, while `false` keeps one connection protected on a server where the flag is on. |
| `COOLIFY_TIMEOUT_MS`, `COOLIFY_INSECURE_TLS` | Apply to **env-defined connections only**. A file connection takes `timeoutMs` and `insecureTLS` from the file, or their defaults. |
| Several connections and no designated default | There is **no** default. Every tool requires an explicit `instance`, and the error lists the configured names. Better than guessing which Coolify a deploy was meant for. |
| Exactly one connection | It is its own default, and `instance` is absent from every schema. |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`, case-insensitively.
Anything else is a startup error rather than a silent `false` —
`COOLIFY_ALLOW_DESTRUCTIVE=ture` is the kind of thing you otherwise discover
mid-incident.

## The `instance` parameter

| Connections | Behaviour |
|---|---|
| 1 | `instance` is **absent** from every tool schema. |
| >1, read tools | An enum over the configured names, defaulting to the designated connection when there is one. |
| >1, write and destructive tools | An enum over the configured names, **required, no default.** |

The asymmetry is deliberate. Guessing wrong on a read costs one wasted call.
Guessing wrong on a write deploys to production. An `instance` with a default on
`deploy` means a forgotten parameter silently ships to prod.

The enum is over configured names only. **Tools never accept a URL, a host or a
token** — see [SECURITY.md](../SECURITY.md).

### `instance: "*"` — fleet fan-out

`find_resources` alone accepts `"*"`:

```json
{ "query": "api-gateway", "instance": "*" }
```

It queries every configured connection in parallel (`GET /resources`, one request
each), tags every row with the instance it came from, and sorts by instance then
name so the result groups by box.

Safe to fan out precisely because the tool cannot write. One unreachable
connection does not take the answer down — failures land in `meta.errors[]`
beside the rows that did come back. When *every* connection fails, the result is
marked `isError` and says so, because an empty list would read as "no resources"
rather than "nothing answered".

Mind the rate limit: Coolify's bucket is keyed by **user id**, so several
connections whose tokens belong to the same Coolify account share one allowance.

## Inspecting what you have

```bash
npx coolify-mcp connections          # every connection, its token source, whether it resolves
npx coolify-mcp connections --json
```

Resolving may prompt — Touch ID, a vault unlock. That is the point: "the variable
is set" and "the credential actually comes back" are different questions, and
only the second predicts whether the server will work. No token, and no part of
one, is ever printed.

```bash
npx coolify-mcp check                      # live probe, every connection
npx coolify-mcp check --connection prod
```

`check` makes two requests, in this order:

1. `GET /api/health` — **unauthenticated**. Is the instance reachable at all?
2. `GET /api/v1/teams/current` — **authenticated**. Does this token work, and for
   which team?

Split on purpose. A failure at step 1 is a URL, DNS or TLS problem; a failure at
step 2 is a token problem. Collapsing them produces the "it doesn't work" bug
report that costs an hour. Step 2 runs even when step 1 failed, because the two
can genuinely disagree — a proxy that blocks `/api/health` but passes `/api/v1`
through.

Step 2 also tells you **which team** a token belongs to, which is the fastest way
to confirm a multi-team setup is wired up the way you think it is.

## Troubleshooting

**"coolify-mcp has no connections configured."** The startup error lists every
path that was searched and the two variables to set. It is printed verbatim to
stderr, which every MCP client captures as the server's log.

**A connection resolves but every call 404s.** The token probably belongs to a
different team than the resources you are asking about. `coolify-mcp check` names
the team.

**`env-var-shadows-file`.** A name is defined in both places and the environment
won — which means the `readOnly` you wrote in the file is not in effect. Delete
one of the two definitions.

**Reads work, writes are refused.** Either the connection is `readOnly`, or
`COOLIFY_READ_ONLY` is set, or the token lacks the `write` ability. The refusal
message distinguishes them and names a writable sibling connection if there is
one.
