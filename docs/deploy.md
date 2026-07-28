# Deploying over HTTP

`coolify-mcp serve --http` is the same server, the same tools and the same gates
as the stdio transport, reached over a socket instead of a pipe. One process,
many clients, and it no longer has to live on the machine the client is on —
including, if you want, on the Coolify instance it manages.

This page is the deployment: the container, the secrets, the domain, and
pointing a client at the result. The transport itself is documented by
`coolify-mcp serve --help`, and the tools by [tools.md](./tools.md).

Everything below was run against the `Dockerfile` and `docker-compose.yml` in
the repository root. Status codes and messages are quoted from that run, not
from the source.

---

## Where to run it

**If you deploy this on the Coolify instance it manages, stopping that instance
takes the MCP server with it.** That is not a bug and there is no way around it:
the server is a container on the box, so it shares the fate of the box. You
notice at the worst possible moment — the instance is down, and the tool you
would have used to look at it is down too.

That is a real cost and it is usually worth paying anyway, because the
alternative is another machine to run and patch. Decide deliberately:

| Where                                   | What you get                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| On the instance it manages              | Nothing else to run. Dies with the instance, including during the incident you would want it for.  |
| On a second Coolify, or any Docker host | Survives the managed instance. One more machine, and the Coolify token now crosses a network.      |
| On a fleet's "management" instance      | The `find_resources instance:"*"` story, one deployment for N boxes. Same single point of failure. |

Nothing in the server prefers one of these. It holds `(baseUrl, token)` pairs
and does not care where it runs relative to them.

---

## 1. Generate the client auth token

There are **two** secrets in this deployment and confusing them is the most
expensive mistake available here:

- `COOLIFY_API_TOKEN` — what the **server** presents to **Coolify**. Issued by
  Coolify, never leaves the process.
- `COOLIFY_MCP_AUTH_TOKEN` — what **clients** present to **this server**. You
  invent it. It has no meaning to Coolify.

Generate the second one now. Any of these:

```bash
openssl rand -base64 32
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

The first two are the commands the server itself prints when the variable is
missing, so what you read in the error is what you can paste.

The rules the server enforces at startup, before it binds anything:

| Rule                           | Why                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Must be set                    | A port bound in front of a live Coolify token, answering whoever asks, is not a degraded configuration — it is an incident.                                                   |
| At least 32 characters         | Nothing on this path rate-limits a guess. A weak secret here is equivalent to none. `openssl rand -base64 32` gives 44.                                                       |
| Printable ASCII, no whitespace | It goes into an `Authorization` header verbatim. A trailing newline from `echo`, or a secret manager that returned JSON, would start the server and then authenticate nobody. |

Each failure is a startup refusal naming the remedy, not a warning.

---

## 2. Environment variables

| Variable                    | Required | Default | What it does                                                                                         |
| --------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `COOLIFY_BASE_URL`          | **yes**  | —       | The Coolify instance to manage. With `COOLIFY_API_TOKEN` it defines one connection, named `default`. |
| `COOLIFY_API_TOKEN`         | **yes**  | —       | Coolify API token for that instance. See [secrets.md](./secrets.md) for abilities.                   |
| `COOLIFY_MCP_AUTH_TOKEN`    | **yes**  | —       | The bearer token clients present. ≥ 32 characters. The server refuses to start without it.           |
| `COOLIFY_READ_ONLY`         | no       | `false` | `true` refuses every non-GET at the HTTP client. **Recommended `true` here** — see Security below.   |
| `COOLIFY_ALLOW_DESTRUCTIVE` | no       | `false` | `true` registers `execute_destructive_operation`. Leave it off unless you mean it.                   |
| `COOLIFY_CONNECTION`        | no       | —       | Which connection reads default to, when there is more than one.                                      |
| `COOLIFY_TIMEOUT_MS`        | no       | `30000` | Per-request timeout against Coolify, 1000–120000.                                                    |
| `COOLIFY_LOG_LEVEL`         | no       | `info`  | `error` \| `warn` \| `info` \| `debug`. stderr only; Docker captures it.                             |
| `COOLIFY_MCP_CONFIG`        | no       | —       | Path to a registry file, if you mount one. A path that does not exist is an error, not a fallback.   |

Several instances or teams work exactly as they do over stdio: use
`COOLIFY_BASE_URL_<NAME>` and `COOLIFY_API_TOKEN_<NAME>` instead of the
unsuffixed pair, one of each per connection. Nothing about the container
changes. See [connections.md](./connections.md).

`COOLIFY_MCP_AUTH_TOKEN` is a single value for the whole server. There is no
per-client token and no way to tell two clients apart — everyone holding it has
the same access. If you need to revoke one client, you rotate for all of them.

### Flags

The image's default command is
`serve --http --host 0.0.0.0 --port 3000`. `docker-compose.yml` restates it with
one flag added.

| Flag                  | Default     | Notes                                                                                        |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `--http`              | —           | Required. Not implied by `serve`, so a second transport can be added later without a rename. |
| `--host ADDR`         | `127.0.0.1` | `0.0.0.0` is correct inside a container and almost nowhere else. See below.                  |
| `--port N`            | `3000`      | `0` binds an ephemeral port and reports it. Useful in tests, not in deployment.              |
| `--allowed-host HOST` | none        | Repeatable. The public name your proxy serves. See §5.                                       |

---

## 3. Deploy on Coolify

Coolify's UI moves between releases, so what follows names the invariants rather
than pretending to be a click-path: a Docker Compose build pack, three secrets,
one domain routed to port 3000.

1. **New resource → your repository → build pack "Docker Compose".** The compose
   file is at `/docker-compose.yml` in the repository root. Coolify builds the
   `Dockerfile` beside it; there is no published image to pull yet.

2. **Set the environment variables** on the resource — not in the compose file,
   which is committed. At minimum:

   ```
   COOLIFY_BASE_URL=https://coolify.example.com
   COOLIFY_API_TOKEN=13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   COOLIFY_MCP_AUTH_TOKEN=<the value from step 1>
   COOLIFY_MCP_ALLOWED_HOSTS=mcp.example.com
   COOLIFY_READ_ONLY=true
   ```

   The compose file declares the first four as **required**, using Compose's
   `${VAR:?message}` form: with any of them missing the deploy fails during
   interpolation, naming the variable and what it is for. That is deliberate. A
   server that starts half-configured while holding a Coolify token is worse
   than one that does not start.

   That syntax is standard Compose and `docker compose config` accepts it, but
   Coolify parses compose files itself and the versions that have been tested
   here are not every version there is. If yours rejects it, replace the
   reference with the plain `${VAR}` form — or, for
   `COOLIFY_MCP_ALLOWED_HOSTS`, with the literal hostname, which is not a
   secret. Do not do that with the three credentials.

3. **Set the domain** for the `coolify-mcp` service, and route it to container
   port **3000**. This is the name that must also appear in
   `COOLIFY_MCP_ALLOWED_HOSTS` — see §5.

4. **Deploy, then watch the logs.** A healthy start prints five lines and no
   credential:

   ```
   coolify-mcp serving MCP over HTTP on http://127.0.0.1:3000
     mcp     POST http://127.0.0.1:3000/mcp
     health  GET  http://127.0.0.1:3000/healthz
     1 connection configured
     Ctrl-C, or SIGTERM, to stop.
   ```

   The banner reports loopback because `http://0.0.0.0:3000` is an honest
   description of the binding and a URL that does not resolve. It says nothing
   about where the service is reachable from outside; that is the domain from
   step 3.

5. **Confirm the container is healthy.** The image ships a `HEALTHCHECK` that
   GETs `/healthz` from inside the container every 30 seconds. Coolify shows the
   result. `/healthz` is unauthenticated on purpose — a health check holds no
   bearer token and could not be given one — and it is routed before any Host or
   Origin validation, so it stays green regardless of §5.

A succeeding health check is **not** logged below `debug`. At one line every 30
seconds it would bury the access log under the least informative event the
server has. A failing one is logged at every level.

### Do not publish the port

Behind Coolify, Traefik reaches the container over the internal network; the
compose file therefore declares `expose`, not `ports`. Publishing 3000 on the
host puts a **plaintext** endpoint holding a live Coolify credential on the
network, in front of the proxy that was going to encrypt it. The commented
`ports:` line in the compose file binds `127.0.0.1` for exactly this reason.

---

## 4. TLS

**This server never terminates TLS and never will.** It speaks plain HTTP and
expects a reverse proxy in front of it — on Coolify, Traefik. The proxy holds
the certificate, terminates the connection, and forwards to port 3000 over the
Docker network.

That is not a limitation being apologised for; it is the only sane split. The
proxy already does ACME renewals, HSTS and cipher selection, and a bearer token
crossing an unencrypted network is a bearer token you have given away — so the
one thing you must not do is expose the port without something in front of it.

Consequences worth knowing:

- The URL you give a client is `https://…`; the URL the container serves is
  `http://…`. Both are correct.
- The server has no idea it is behind TLS. It does not read
  `X-Forwarded-Proto`, does not redirect, and does not set HSTS. Those are the
  proxy's job and doing them twice is how redirect loops happen.

---

## 5. `--allowed-host`, and what DNS rebinding has to do with it

DNS rebinding is a browser attack: a page you visit resolves its own hostname to
a private address and then talks to whatever is listening there, using **your**
network position. The defence is for the server to check that the `Host` and
`Origin` it was given are names it actually serves.

The transport derives that list from the address it bound. Inside a container it
binds `0.0.0.0`, and that derives **nothing** — `Host: 0.0.0.0:3000` is a header
no client has ever sent, and a list containing only that would refuse every real
request. So on a wildcard bind the Host check is **skipped**, and the server
says so at startup rather than leaving it to be found:

```
coolify-mcp: bound 0.0.0.0:3000 with no --allowed-host: a wildcard bind cannot predict the Host header, so Host validation is off. Origin validation still refuses every browser-originated request.
```

Read that carefully, because it cuts both ways:

- **Nothing is broken without the flag.** MCP clients send no `Origin` at all,
  so they work. The `Origin` check also still holds — with an empty list every
  declared origin is refused, which is precisely the browser case.
- **You are running with one of the two defences off.** The flag is what turns
  it back on, which is why `docker-compose.yml` requires
  `COOLIFY_MCP_ALLOWED_HOSTS` instead of leaving it to a good intention.

Set it to the name your clients send, with no scheme and no path:

```
COOLIFY_MCP_ALLOWED_HOSTS=mcp.example.com
```

Behind TLS on 443 a browser sends the hostname with no port, so no port here
either. On a non-standard port, include it — the value is compared to what
arrives, and guessing which you meant would be a worse failure than asking.

**If it is wrong, every MCP request gets a 403 and `/healthz` keeps answering 200.** The container stays healthy while every client fails, which is the
symptom to recognise:

```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32000, "message": "Invalid Host header: evil.example.net" },
  "id": null
}
```

---

## 6. Point a client at it

```json
{
  "mcpServers": {
    "coolify": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${COOLIFY_MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

The path is `/mcp`. `/` is a 404 and so is everything else.

**Whether `${COOLIFY_MCP_AUTH_TOKEN}` expands is a property of the client, not
of this server.** Claude Code expands `${VAR}`; Cursor's syntax is
`${env:NAME}`; several clients expand nothing at all and store what you typed.
The table in the [README](../README.md#one-thing-to-know-before-you-start) says
which is which.

If your client does not expand references, you have a choice to make with your
eyes open, and `doctor` will have an opinion:

```bash
npx @done-dynamics/coolify-mcp doctor --all-servers
```

A literal token in a `headers` block is reported as `bearer-literal`, because
`~/.claude.json` and `mcp.json` are synced to cloud drives, captured in backups,
shown in screen shares and pasted into bug reports. The finding is a warning
rather than a refusal — it is your machine — but it is not noise.

---

## 7. Verify it by hand

```bash
curl -sS https://mcp.example.com/healthz
```

```
{"status":"ok"}
```

Then the handshake. Both `Accept` types are required by the Streamable HTTP
transport, and omitting either is the most common way to get a confusing
failure:

```bash
curl -sS -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $COOLIFY_MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The answer is an SSE frame, not a bare JSON body — a `POST` answers its own
stream, which is how progress on a long `deploy` reaches the client without a
session:

```
event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"coolify-mcp","title":"Coolify","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

The whole surface, so you can tell a misconfiguration from an outage:

| Request                              | Answer                                                        |
| ------------------------------------ | ------------------------------------------------------------- |
| `POST /mcp` with a valid bearer      | `200`, SSE                                                    |
| `POST /mcp` with none or a wrong one | `401`, `WWW-Authenticate: Bearer`, **no body detail**         |
| `GET` or `DELETE /mcp`               | `405` — stateless, so no stream to open and no session to end |
| `POST /mcp` from an unlisted Host    | `403`                                                         |
| `POST /mcp` accepting only JSON      | `406`                                                         |
| `POST /mcp` over 4 MB                | `413`                                                         |
| `GET /healthz`                       | `200 {"status":"ok"}`, unauthenticated                        |
| anything else                        | `404`                                                         |

The `401` says nothing about why on purpose, and every other check runs after
it. An anonymous prober who could tell "your Host is wrong" from "your method is
wrong" from "your token is wrong" has been handed a map of the surface for free.

---

## Security

**The recommended default is a read-scoped Coolify token plus
`COOLIFY_READ_ONLY=true`.** The compose file defaults `COOLIFY_READ_ONLY` to
`true` for that reason — stricter than the server's own default, because a
shared endpoint that every client you hand the token to can reach is the last
place to discover you left writes on.

They are two independent ceilings and neither relies on the other being right:

1. **The token.** `read` + `read:sensitive` covers every read tool including
   logs and environment variable values. Abilities are fixed at creation, so a
   read token cannot be escalated — only replaced.
2. **`COOLIFY_READ_ONLY`.** Refuses every non-GET at the HTTP client, before the
   socket opens, regardless of what the token is scoped to. When every
   connection is read-only the write tools are never registered at all.

Then `COOLIFY_ALLOW_DESTRUCTIVE` unset, which is the compose default: with it
off, `execute_destructive_operation` does not appear in `tools/list` at all, and
no tool on the server carries `destructiveHint: true`.

If you need writes, the honest shape is a second deployment with its own auth
token and its own Coolify connection, rather than one endpoint that can do
everything and a policy about who is told the token.

### The two secrets stay separate

The Coolify token never reaches a client. The server holds it; clients present
an unrelated value; nothing in any response contains it. That separation is the
point:

- A leaked `COOLIFY_MCP_AUTH_TOKEN` gets an attacker your MCP surface, bounded
  by the ceilings above. It does not get them a Coolify credential.
- Rotating either one does not force rotating the other. Rotating the auth
  token means one variable and a redeploy; rotating the Coolify token means
  Coolify → Keys & Tokens and one variable. Neither touches the other.

The comparison itself is constant-time **and** length-blind: both sides are
HMAC'd under a per-process random key before `timingSafeEqual`, so the endpoint
cannot be timed for the expected token's length either.

### What the logs contain

One line per request — method, path, status, duration:

```
coolify-mcp: POST /mcp 200 16ms
coolify-mcp: POST /mcp 401 0ms
coolify-mcp: POST /mcp 403 4ms
```

Never the `Authorization` header, never a body, at any log level. The auth token
is registered with the process-wide redaction set the moment it resolves, which
matters more here than anywhere else: this transport writes a log line per
request, assembled from attacker-influenced input, next to a process holding
that value.

### The container

`docker-compose.yml` ships with `read_only: true`, `cap_drop: [ALL]` and
`no-new-privileges`, and the image runs as uid 1000 with the application tree
owned by root — so the process cannot rewrite its own code. None of this is
load-bearing on its own; all of it is free, because the server keeps no state on
disk. Resolved tokens are cached in memory for the process lifetime and never
written down.

### Never expose the port without TLS in front of it

Repeated here because it is the one mistake that undoes everything above. A
bearer token crossing an unencrypted network is a bearer token you have handed
to whoever is on the path, and the whole design rests on that token being the
only thing standing in front of a Coolify credential.

---

## Troubleshooting

| Symptom                                                      | Cause                                                                           | Fix                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Deploy fails: `required variable … is missing a value`       | A required env var is unset. The message names it.                              | Set it on the resource, not in the compose file.                                    |
| Container exits at once, log names `$COOLIFY_MCP_AUTH_TOKEN` | Unset, shorter than 32 characters, or containing whitespace.                    | Regenerate it with one of the commands in §1.                                       |
| Every MCP request `403`, `/healthz` still `200`              | `COOLIFY_MCP_ALLOWED_HOSTS` does not match the `Host` your proxy forwards.      | Set it to the bare hostname. Add the port only if your clients send one.            |
| Every MCP request `401`                                      | The client is sending a different value, or not expanding `${…}` in its config. | `curl` it with the literal token to split "wrong token" from "wrong client config". |
| `406 Not Acceptable`                                         | The client did not accept both `application/json` and `text/event-stream`.      | Client-side. Both types are required by the transport.                              |
| `405` on a `GET` to `/mcp`                                   | Working as designed — the server is stateless.                                  | Nothing. Clients `POST`.                                                            |
| `404` on everything                                          | The URL is missing `/mcp`.                                                      | `https://host/mcp`, not `https://host`.                                             |
| Container marked unhealthy                                   | Nothing is listening on 3000 inside the container.                              | Check the logs for a startup refusal. `--port` and the `HEALTHCHECK` must agree.    |
| Tools are missing from `tools/list`                          | `COOLIFY_READ_ONLY=true` (no write tools) or `COOLIFY_ALLOW_DESTRUCTIVE` unset. | Intended. Change it only if you meant to.                                           |
| `deploy` or `control_resource` refused                       | Read-only, or a token without the ability. The error says which.                | [secrets.md](./secrets.md#token-abilities).                                         |

For anything that looks like a credential leaving the server — a log line, an
error message, a tool result — see [SECURITY.md](../SECURITY.md). That is a
vulnerability, not a bug.
