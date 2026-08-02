# Cursor

|                      |                                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| Adapter ids          | `cursor-user`, `cursor-project`                                        |
| `--client` selectors | `cursor`, `cursor-user`, `cursor-project`                              |
| User config          | `~/.cursor/mcp.json`                                                   |
| Project config       | `<projectRoot>/.cursor/mcp.json`                                       |
| Key path             | `mcpServers.coolify`                                                   |
| Format               | JSON                                                                   |
| Transports written   | `stdio` only                                                           |
| Confidence           | **verified** — paths, key and reference syntax are documented upstream |
| Native CLI           | none                                                                   |

## The one thing that catches everyone

Cursor's file shape matches Claude Code closely enough to invite a copy-paste,
and that copy-paste is a trap:

```
Claude Code   ${COOLIFY_API_TOKEN}
Cursor        ${env:COOLIFY_API_TOKEN}
```

A Claude-style `${COOLIFY_API_TOKEN}` in a Cursor config is stored and forwarded
**verbatim**. The server receives the eleven-character reference text as its
bearer token and Coolify answers 401 — which reads as a bad credential rather
than a bad config, and costs an hour.

Cursor also has no default-value syntax, so `${VAR:-fallback}` has no Cursor
equivalent. The installer discards the default rather than smuggling it into the
variable name.

## Install

```bash
npx @done-dynamics/coolify-mcp install --client cursor
npx @done-dynamics/coolify-mcp install --client cursor --scope user
npx @done-dynamics/coolify-mcp install --client cursor --scope project
```

## What the installer writes

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@done-dynamics/coolify-mcp@latest",
        "coolify-mcp-server"
      ],
      "env": {}
    }
  }
}
```

With `--connection prod`, `env` becomes `{"COOLIFY_CONNECTION": "prod"}`. With
`--pin=1.4.2`, `args` becomes `["-y", "@done-dynamics/coolify-mcp@1.4.2"]`.

No `"type"` key: unlike the Claude Code adapter there is no native CLI to stay
byte-identical with, so the entry carries only what Cursor needs.

## Supplying credentials

**1. `envFile` — the Cursor-native answer, and the cleanest.** Cursor supports an
`envFile` pointing at a dotenv file on stdio servers, which keeps the credential
out of `mcp.json` entirely. The installer emits this as advice rather than
writing it, because pointing at a path you have not created produces a server
that fails to start.

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@done-dynamics/coolify-mcp@latest",
        "coolify-mcp-server"
      ],
      "envFile": "/absolute/path/to/coolify.env",
      "env": {}
    }
  }
}
```

```dotenv
# /absolute/path/to/coolify.env — chmod 600 this file
COOLIFY_BASE_URL=https://coolify.example.com
COOLIFY_API_TOKEN=13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**2. `${env:NAME}` references.** Mind the prefix.

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@done-dynamics/coolify-mcp@latest",
        "coolify-mcp-server"
      ],
      "env": {
        "COOLIFY_BASE_URL": "${env:COOLIFY_BASE_URL}",
        "COOLIFY_API_TOKEN": "${env:COOLIFY_API_TOKEN}"
      }
    }
  }
}
```

> Neither of these blocks is what the installer writes. Both are hand edits you
> may make afterwards.

Cursor inherits the environment of the process that launched it. On macOS, an
app started from Finder or Spotlight does **not** see variables exported in
`~/.zshrc`. If `COOLIFY_API_TOKEN` works in your terminal but not in Cursor, that
is why — use `envFile`, or a
[registry file](../connections.md#layer-2--a-registry-file) with `tokenCommand`.

## Verify

```bash
npx @done-dynamics/coolify-mcp doctor
```

Doctor knows Cursor's syntax: when it finds a literal credential in a Cursor
config, the remediation it prints uses `${env:NAME}`, and `--fix` writes that
form. Cursor is one of only two clients `--fix` will rewrite at all, precisely
because its expansion behaviour is verified.

Then, in Cursor: Settings → MCP should show `coolify` connected.

## Uninstall

```bash
npx @done-dynamics/coolify-mcp uninstall --client cursor
```

## Confirmed vs unconfirmed

| Item                                                             | Status    |
| ---------------------------------------------------------------- | --------- |
| `~/.cursor/mcp.json` user path                                   | confirmed |
| `<projectRoot>/.cursor/mcp.json` project path                    | confirmed |
| `mcpServers` key                                                 | confirmed |
| `${env:NAME}` expansion, and the absence of a default-value form | confirmed |
| `envFile` on stdio servers                                       | confirmed |

## A note on scope collision

The user adapter resolves `~/.cursor/mcp.json` and the project adapter resolves
`<projectRoot>/.cursor/mcp.json`. When you run the CLI from your home directory
those are the same file, and both adapters inspect it. Doctor deduplicates its
findings so a credential in that file is reported once rather than twice — a
repeated CRITICAL is how a report loses its reader.
