# Secrets

## The rule

**coolify-mcp never stores a credential in a config file, and never writes one
into yours.**

That is not advice, it is enforced in three places:

1. The registry file schema has **no `token` property** and
   `additionalProperties: false`. A literal credential there is a validation
   error at startup, and the error message names the three supported sources.
2. `baseUrl` rejects embedded credentials (`https://user:pass@host`), which is
   the one string field that could otherwise smuggle one in.
3. The installer builds **pointer config only** — a command, its arguments, and
   at most a connection _name_. When a client cannot expand a `${VAR}` reference,
   the installer **drops the variable** rather than writing its value. The worst
   outcome an adapter is allowed to produce is a missing variable, never a leaked
   credential.

## Do this

- Keep the token in an environment variable, a secret manager, or the OS keychain.
- Create the Coolify token with the narrowest ability set that does the job.
  `read` + `read:sensitive` covers everything on the read side, including logs and
  environment variable values.
- Set `readOnly: true` on any connection you do not need to write to. It refuses
  every non-GET at the HTTP client regardless of what the token is scoped to.
- Use `tokenCommand` for 1Password / `pass` / Vault / `gopass`.
- Run `npx coolify-mcp doctor` on every machine that has ever had an MCP client
  on it.
- `chmod 600` any file that holds a credential, including a Cursor `envFile`.

## Never do this

- **Never paste a token into a client config.** `~/.claude.json`, `mcp.json` and
  `config.toml` are synced to cloud drives, captured in backups, shown in screen
  shares, and pasted wholesale into bug reports.
- **Never put a token in a `.coolify-mcp.json`.** It will not even parse.
- **Never commit a config containing a credential.** Git history is forever, and
  rotation is the only remedy.
- **Never reuse a root token across connections.** One connection per
  (instance, team), one token each, scoped as narrowly as the work allows.

## Token abilities

Coolify's Sanctum abilities, and what each unlocks here:

| Ability          | Unlocks                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`           | Everything read-only except the sensitive set below.                                                                                                                                                            |
| `read:sensitive` | Environment variable **values**, passwords, **logs**. Without it `get_logs` returns 200 with an empty body — not a 403 — which is why this server treats an empty log body as a failure and says so explicitly. |
| `write`          | Creates, updates, starts, stops, restarts, deletes.                                                                                                                                                             |
| `deploy`         | `POST /v1/deploy`. **Exclusive**: a `deploy` token carries this _instead of_ the others.                                                                                                                        |
| `root`           | Everything. **Exclusive.** This is what a homelab install usually hands out, and it is why `get_resource` masks credential-shaped values unconditionally — Coolify itself will not redact for a root token.     |

Abilities are fixed when a token is created. A token without `read:sensitive`
cannot gain it; it has to be replaced.

Coolify additionally requires the token's owner to be `admin` or `owner` in the
team for `root` and `write` tokens. A 403 whose body says
"missing required permissions" is quoted verbatim in the error, because Coolify's
own message names the ability better than anything we could infer.

## Where the token comes from

Four sources, resolved in this order for each connection:

### 1. `tokenEnv` — an explicitly named environment variable

```json
{ "baseUrl": "https://coolify.example.com", "tokenEnv": "WORK_COOLIFY_TOKEN" }
```

### 2. `tokenCommand` — an argv array, no shell

```json
{
  "baseUrl": "https://coolify.acme.dev",
  "tokenCommand": ["op", "read", "op://Infra/coolify-acme/credential"]
}
```

stdout is trimmed and used as the token. Properties worth knowing:

- **No shell, ever.** The array goes to `execFile` directly — no `sh -c`, no
  string splitting, no interpolation, no glob expansion. A registry file that
  could spawn a shell is a registry file that can run arbitrary commands from one
  mistyped character.
- **The child does not receive our tokens.** Every `COOLIFY_API_TOKEN*` variable
  is stripped from the child's environment. A helper that fetches a credential
  has no business receiving the credentials we already hold. Everything else
  (`PATH`, `HOME`, `SSH_AUTH_SOCK`, `OP_SERVICE_ACCOUNT_TOKEN`, …) is passed
  through, because secret managers need it.
- **60-second timeout.** Generous because secret managers prompt: `op read` can
  wait on Touch ID, and `security` can raise a keychain unlock dialog. A tight
  timeout shows up as an unexplained auth failure the first time you are away
  from the keyboard.
- **64 KB output cap**, to bound a misconfigured command that dumps a file.
- **1 to 32 arguments.** A token command is `op read …`, not a script.

Works with anything that prints a token:

```json
["op",          "read", "op://Infra/coolify/credential"]
["pass",        "show", "infra/coolify"]
["vault",       "kv", "get", "-field=token", "secret/coolify"]
["gopass",      "show", "-o", "infra/coolify"]
["security",    "find-generic-password", "-s", "coolify", "-a", "prod", "-w"]
["secret-tool", "lookup", "service", "coolify", "account", "prod"]
```

> **Windows.** The command must be a real executable. `.cmd` and `.bat` shims
> cannot be launched without a shell, and coolify-mcp never uses one. Point at
> the `.exe`, or use an absolute path. The error names this case specifically
> when it fires.

### 3. `tokenKeychain` — the platform keychain

```json
{ "baseUrl": "…", "tokenKeychain": { "service": "coolify-mcp", "account": "prod" } }
```

| Platform      | Backend                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| macOS         | `security find-generic-password -s <service> -a <account> -w`                      |
| Linux         | `secret-tool lookup service <service> account <account>` (needs `libsecret-tools`) |
| Windows       | **DPAPI at rest — see below.** Not Credential Manager.                             |
| Anything else | Unsupported; use `tokenCommand`.                                                   |

No native modules are used, ever — a `keytar`-class dependency breaks
`npx coolify-mcp`, which is the primary install path. So this dispatches over the
platform's own CLI.

#### Windows: honestly, not a keychain

No first-party Windows CLI returns a generic credential's _secret_. `cmdkey`
lists entries but never prints the blob, and reading it means `CredRead()` through
P/Invoke — a native dependency this project will not take.

So the Windows backend is **DPAPI at rest**, not Credential Manager: ciphertext
produced by `ConvertFrom-SecureString` under your DPAPI key, stored at
`%LOCALAPPDATA%\coolify-mcp\credentials.dat`, decryptable only by the same
Windows user on the same machine.

**That is weaker than Keychain or libsecret** — no per-item ACL, no unlock
prompt, so any process running as that user can decrypt it. **And it is stronger
than a token sitting in a client config file.** Both halves of that sentence are
true and neither should be rounded off.

The file format (v1):

```json
{
  "version": 1,
  "entries": {
    "coolify-mcp": {
      "prod": "01000000d08c9ddf0115d1118c7a00c04fc297eb…"
    }
  }
}
```

> **Not yet writable from the CLI.** An error hint in the token resolver refers
> to `coolify-mcp secrets set`, which is **not implemented in this version**.
> Until it is, create the file yourself:
>
> ```powershell
> $token  = Read-Host -AsSecureString "Coolify API token"
> $cipher = ConvertFrom-SecureString -SecureString $token
> $dir    = Join-Path $env:LOCALAPPDATA 'coolify-mcp'
> New-Item -ItemType Directory -Force -Path $dir | Out-Null
> @{ version = 1; entries = @{ 'coolify-mcp' = @{ prod = $cipher } } } |
>   ConvertTo-Json -Depth 5 | Out-File (Join-Path $dir 'credentials.dat') -Encoding utf8
> ```
>
> The stored value must be hexadecimal — that character set is what makes it safe
> to embed in the decryption script, and a value containing anything else is
> rejected. The plaintext comes back over stdout and never touches a command
> line.

### 4. Convention — `$COOLIFY_API_TOKEN_<NAME>`

A connection that declares none of the three sources reads its own variable:

```
prod       ->  COOLIFY_API_TOKEN_PROD
acme-ops   ->  COOLIFY_API_TOKEN_ACME_OPS
```

This is what makes `{"baseUrl": "https://…"}` a complete connection entry.

`$COOLIFY_API_TOKEN` (unsuffixed) is read **only** for the implicit connection
named `default`. Any other connection falling back to it would silently point two
instances at one credential.

## What happens to a resolved token

- **It is cached for the process lifetime and never written to disk.** The cache
  holds the _promise_, so a fan-out across connections does not spawn one
  `op read` per concurrent call. A failed resolution is evicted — the usual cause
  is a locked vault, and the fix is to unlock and retry, which must not require
  restarting the server.
- **It is registered with the redaction set the moment it resolves**, before it
  can reach any output path. Both the whole token and the secret half after the
  `|` are registered, because a truncated log line can carry the second alone.
- **`redact()` runs on every string that leaves the server** — tool results,
  error messages, uncaught handler errors, doctor reports, CLI output. It also
  strips anything matching the Sanctum shape as a backstop, so a token this
  process never resolved (one sitting in a Coolify environment variable, say)
  cannot ride out either.
- **The `Authorization` header is never logged**, at any log level.
- **Response bodies are scrubbed of the bearer token before parsing.** Point a
  base URL at a request-echo service and the response body contains your
  `Authorization` header verbatim; without this it would flow into the model's
  context and every error message thereafter.
- **A token is validated on resolution**: non-empty, and printable ASCII with no
  whitespace. That rules out a stray newline splitting the header and catches the
  common "my secret manager returned JSON" mistake. The rejection deliberately
  does not echo the value — it may be a real credential in a shape we did not
  expect.

## Masking in tool output

Two different mechanisms, easy to confuse:

|                  | What it hides                                                                                            | Revealable?                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `redact()`       | **Our** bearer tokens                                                                                    | **Never.**                                                                                   |
| `redactObject()` | **Coolify's** secrets — values under keys matching `password`, `secret`, `token`, `private_key`, `*_key` | Yes, per tool: `get_environment_variables` and `execute_read_operation` take `reveal: true`. |

`get_resource` masks unconditionally with no `reveal` parameter: environment
variables have their own tool with an explicit reveal, and a homelab token is
usually a root token that Coolify itself will not redact for.

An empty string is never masked. `"password": ""` rendered as `"***"` would
assert that a password exists, and "the variable is set to nothing" is frequently
the actual bug you are hunting.

## `doctor` — the plaintext credential scanner

```bash
npx coolify-mcp doctor                 # your coolify entry only
npx coolify-mcp doctor --all-servers   # every MCP server in every client config
npx coolify-mcp doctor --json          # machine-readable
npx coolify-mcp doctor --fix           # conservative repair, see below
```

Exit codes: **0** clean · **1** warnings · **2** a credential was found at rest.

### What it looks for

| Code                         | Severity     | Rule                                                                                                                                                                                            |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plaintext-credential`       | **critical** | The Laravel Sanctum shape `\b\d+\|[A-Za-z0-9]{40}\b`. Forty base62 characters behind a pipe behind an integer does not occur in a config file by accident, so this is reported with no hedging. |
| `bearer-literal`             | warn         | A literal `Bearer <credential>` in a `headers` block that is not an env reference or an obvious placeholder.                                                                                    |
| `env-literal-secret`         | warn         | A key matching `TOKEN\|KEY\|SECRET\|PASSWORD` set to a literal value inside an `env` / `environment` block.                                                                                     |
| `world-readable-config`      | warn         | POSIX mode with any of `0o077` set.                                                                                                                                                             |
| `acl-not-checked`            | info         | **Windows only.** Permissions were _not_ checked — Windows uses ACLs, and reporting "permissions OK" would be a claim doctor has not verified.                                                  |
| `*-config-unparseable`       | error        | The file does not parse. Nothing will be written into it.                                                                                                                                       |
| `unpinned-version`           | info         | A client resolves `coolify-mcp@latest` at spawn time.                                                                                                                                           |
| `pinned-version-mismatch`    | warn/info    | Two clients disagree about which version to run.                                                                                                                                                |
| `env-var-shadows-file`       | warn         | A connection name is defined in both places; the environment won, so file settings such as `readOnly` are not in effect.                                                                        |
| `unverified-adapter-present` | warn         | An unverified client (MiniMax) is installed and will not be written to.                                                                                                                         |

At most **one** finding is emitted per string, most precise rule first: a literal
Sanctum token in `headers.Authorization` satisfies all three credential rules, and
reporting it three times would bury "rotate this now" under two "consider using a
variable"s.

The Sanctum sweep runs over the **raw text** of every config file regardless of
scan scope, so a token in a comment or in an unparseable file is still found —
those are reported by line number, since there is no key path to attribute them
to.

### What it never does

Findings record **locations, never values** — not the value, not a prefix, not a
length. Everything leaving the module passes through `redact()` on top of that. A
doctor report is the single most-pasted artefact in any bug report, so it has to
be safe to paste.

### `--fix` is conservative by design

It rewrites a literal to `${VAR}` **only when all of these hold**:

- `$VAR` is already exported in the current environment with **exactly** that value;
- the client's expansion of that syntax is **verified** — today that means Claude
  Code and Cursor only;
- the file format supports a surgical edit (JSON and JSONC through
  `modify`/`applyEdits`, YAML; **never TOML**, because a TOML section cannot be
  edited one key at a time without rewriting the table around it, and
  reformatting the file every Codex MCP server shares is not a repair).

It **never** invents a variable. Setting one durably means editing a shell
profile, a launchd plist or a Windows user environment this process cannot see,
and a "fixed" config referencing a variable that is unset at spawn time is _worse_
than the literal it replaced: it now fails inside the client, where you have no
diagnostics.

It **never** prints the value it matched — that would put the secret into shell
history, terminal scrollback and CI logs, three places strictly worse than the
config file being cleaned up.

Writes go through a sibling temp file and a rename, copying the original mode
first: a tool that reports `world-readable-config` must not be the thing that
creates one.

Every applied fix still says: **rotate the token anyway.**

## Rotation

If a token has been at rest in plaintext, it is burned. Moving the value without
revoking it changes nothing about who already has it — it has been readable on
disk by every process running as that user, and by every backup, sync client,
screen share and support bundle that ever touched the file.

1. **Coolify → Keys & Tokens → API tokens**: revoke the token, then issue a
   replacement with the narrowest abilities that do the job.
2. Put the replacement in an environment variable or a secret manager. Reference
   it; do not paste it.
3. Re-run `npx coolify-mcp doctor` and confirm the finding is gone.

## Reporting a leak in coolify-mcp itself

If you find a path by which this server emits a credential — a log line, an error
message, a tool result, a doctor report — treat it as a security issue and follow
[SECURITY.md](../SECURITY.md). Do not open a public issue with the token in it.
