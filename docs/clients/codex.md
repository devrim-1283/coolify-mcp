# Codex CLI

|                      |                                                                      |
| -------------------- | -------------------------------------------------------------------- |
| Adapter id           | `codex-user`                                                         |
| `--client` selectors | `codex`, `openai-codex`, `codex-user`                                |
| Config               | `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`) |
| Section              | `[mcp_servers.coolify]`                                              |
| Format               | TOML                                                                 |
| Transports written   | `stdio` only — **never** anything else. See below.                   |
| Confidence           | **verified**                                                         |
| Native CLI           | deliberately not used. See below.                                    |

## Two hard rules, both learned from a real incident

**1. Always stdio. Never a `url` key.**

Recent Codex versions accept HTTP transports. Older ones deserialize an entry
without `command` as a hard error and drop the **entire** `config.toml` — taking
every other MCP server in that file down with it, not just ours. The failure is
silent from the user's side: MCP simply stops working everywhere, and nothing
points at the entry that caused it.

stdio parses on every Codex version ever shipped, so it is the only thing this
adapter is allowed to emit. `--transport http` is rejected for Codex rather than
being accepted and quietly downgraded, because accepting a flag and ignoring it
is worse than refusing it.

**2. Append-only, and never into a file that does not parse.**

If `~/.codex/config.toml` does not parse as TOML, the installer refuses with
`codex-config-unparseable` and writes nothing. Appending to a broken config turns
a five-second repair into an archaeology exercise, in the one file every Codex
MCP server on the machine shares.

## Install

```bash
npx @done-dynamics/coolify-mcp install --client codex
```

## What the installer writes

```toml
[mcp_servers.coolify]
command = "npx"
args = [ "-y", "-p", "@done-dynamics/coolify-mcp@latest", "coolify-mcp-server" ]
startup_timeout_sec = 60
```

With `--connection prod` a sub-table is appended:

```toml
[mcp_servers.coolify.env]
COOLIFY_CONNECTION = "prod"
```

With `--pin=1.4.2`, `args` becomes `[ "-y", "@done-dynamics/coolify-mcp@1.4.2" ]`.

The block is produced by `smol-toml`, which owns escaping and sub-table layout —
hand-rolling TOML is how quoting bugs get shipped into a file that must never
fail to parse.

### Why `startup_timeout_sec = 60`

`npx` has to resolve, download and unpack the package before the server can speak
MCP, which routinely exceeds Codex's default startup budget on a cold machine.
The failure looks like "server did not start" rather than "still downloading".

Emitting the key is safe precisely because `command` is always present: the
version skew that poisons `config.toml` is a _missing required_ field, not an
extra one, and an unrecognized scalar is ignored.

Pinning with `--pin` also helps here: a pinned version is cached after the first
run, so subsequent spawns are fast.

### Why the native `codex mcp add` is not used

Recent Codex versions ship an `mcp add` subcommand. Its argument form has not
been verified for this adapter, and a half-right invocation would write an entry
this adapter cannot then recognize — which breaks `uninstall` and makes `doctor`
report an entry it cannot attribute. The append-only TOML writer is provably
safe, so it is the only path.

## Supplying credentials

**Codex stores `env` values verbatim.** There is no `${VAR}` expansion, so a
reference written into the file would reach the server as literal text. The
installer therefore drops any reference rather than writing it — the worst
outcome an adapter is allowed to produce is a missing variable, never a leaked
credential.

Export the variables in the shell Codex runs from:

```bash
# ~/.zshrc or ~/.bashrc
export COOLIFY_BASE_URL=https://coolify.example.com
export COOLIFY_API_TOKEN='13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

Codex is a terminal program, so this works reliably — it is the recommended
route.

If you must put values in the file, be aware they are literals at rest. Prefer a
[registry file](../connections.md#layer-2--a-registry-file) with `tokenCommand`
so the token is fetched from your secret manager at server startup and never
written anywhere:

```toml
[mcp_servers.coolify.env]
COOLIFY_CONNECTION = "prod"
```

`--fix` in `doctor` will **not** rewrite literals in `config.toml`: TOML is
written a section at a time, so there is no way to change one key without
rewriting the table around it, and reformatting the file every Codex MCP server
shares is not a repair.

## Verify

```bash
npx @done-dynamics/coolify-mcp doctor
codex mcp list          # if your Codex version has it
```

After installing, start Codex and confirm the `coolify` tools appear. If Codex
starts and _no_ MCP servers work, check whether `config.toml` still parses:

```bash
npx @done-dynamics/coolify-mcp doctor    # reports codex-config-unparseable with the offset
```

## Uninstall

```bash
npx @done-dynamics/coolify-mcp uninstall --client codex
```

Removes the `[mcp_servers.coolify]` section and its sub-tables.

## Confirmed vs unconfirmed

| Item                                                                       | Status                                 |
| -------------------------------------------------------------------------- | -------------------------------------- |
| `~/.codex/config.toml` path                                                | confirmed                              |
| `[mcp_servers.<name>]` section shape                                       | confirmed                              |
| Old versions dropping the whole file on an unknown `url` key               | confirmed (this is why rule 1 exists)  |
| `env` values stored verbatim, no `${VAR}` expansion                        | confirmed                              |
| `startup_timeout_sec` accepted and ignored by versions that do not know it | confirmed                              |
| `codex mcp add` argument form                                              | **not verified** — deliberately unused |
