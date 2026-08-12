# Zed

|                            |                                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| Adapter ids                | `zed-user`, `zed-project`                                                      |
| `--client` selectors       | `zed`, `zed-user`, `zed-project`                                               |
| User config (macOS, Linux) | `~/.config/zed/settings.json`                                                  |
| User config (Windows)      | `%USERPROFILE%\AppData\Roaming\Zed\settings.json` — **derived, not confirmed** |
| Project config             | `<projectRoot>/.zed/settings.json`                                             |
| Key path                   | `context_servers.coolify`                                                      |
| Format                     | **JSONC** — comments and trailing commas are preserved                         |
| Transports written         | `stdio` only                                                                   |
| Confidence                 | **verified** for the key and shape; the Windows user path is derived           |
| Native CLI                 | none                                                                           |

## Three things that are easy to get wrong

**The key is `context_servers`.** Not `mcpServers`, and not `agent_servers`.
`agent_servers` is a different Zed feature (external agents) and an entry placed
there is simply ignored — no error, no server.

**`command` is a plain string with sibling `args` and `env`.** Older Zed took an
object (`command: { path, args, env }`). Writing that shape today produces a
server Zed will not start.

**The file is JSONC.** Zed ships `settings.json` full of explanatory comments and
users add their own. The installer routes through a JSONC writer
(`jsonc-parser`'s `modify`/`applyEdits`), so every byte outside the value it
changes survives. A naive `JSON.parse` / `JSON.stringify` round-trip would
silently delete every comment in the file, which the adapter contract explicitly
forbids.

## Install

```bash
npx @donedynamics/coolify-mcp install --client zed
npx @donedynamics/coolify-mcp install --client zed --scope user
npx @donedynamics/coolify-mcp install --client zed --scope project
```

## What the installer writes

```json
{
  "context_servers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@donedynamics/coolify-mcp@latest",
        "coolify-mcp-server"
      ],
      "env": {}
    }
  }
}
```

With `--connection prod`, `env` becomes `{"COOLIFY_CONNECTION": "prod"}`. With
`--pin=1.4.2`, `args` becomes `["-y", "@donedynamics/coolify-mcp@1.4.2"]`.

### About `"source": "custom"`

Recent Zed documents a `"source": "custom"` discriminator alongside these fields.
It is deliberately **omitted**: it is not part of the shape verified for this
adapter, and adding an unrecognized discriminator to a settings file is the same
class of guess that motivated the Codex `url` rule.

> **TODO(verify):** check whether current Zed requires `source`, and add it if
> so. Tracked as a `TODO(verify)` comment in `src/install/adapters/zed.ts`.

## Supplying credentials

**Zed's expansion of `${VAR}` inside a `context_servers` env block is not
verified.** The installer treats Zed as a client that stores values verbatim and
drops any `${…}` reference rather than writing it as literal text.

Zed inherits the environment of the process that launched it. Started from a
terminal it sees your exported variables; started from Finder, Spotlight or a
desktop launcher on macOS it does not. If the token works in your shell but not
in Zed, that is the reason.

The reliable route for Zed is a
[registry file](../connections.md#layer-2--a-registry-file), which needs no
environment at all:

```json
{
  "version": 1,
  "connections": {
    "prod": {
      "baseUrl": "https://coolify.example.com",
      "tokenCommand": ["op", "read", "op://Infra/coolify-prod/credential"],
      "readOnly": true
    }
  }
}
```

Save it at `~/.coolify-mcp/config.json`, then:

```bash
npx @donedynamics/coolify-mcp install --client zed --connection prod
```

The config entry then holds one string — the connection name — and the token is
fetched from your secret manager when the server starts.

## Verify

```bash
npx @donedynamics/coolify-mcp doctor
```

When the Windows user settings file is absent, doctor emits a
`zed-path-unconfirmed` **info** finding naming the derived path. That finding is
suppressed on macOS and Linux, where the location is documented — a caveat shown
to everyone is a caveat everyone learns to ignore.

In Zed itself: the Agent Panel's settings view lists context servers and their
connection status.

### Help us close the last gap

If you run Zed on Windows and can confirm where it reads user settings from,
please [open an issue](https://github.com/devrim-1283/coolify-mcp/issues). Open
the command palette and run `zed: open settings`, then check the title bar or the
file path. Same for `"source": "custom"`: if your Zed version requires it, an
entry written without it will fail to start, and that is worth knowing.

## Uninstall

```bash
npx @donedynamics/coolify-mcp uninstall --client zed
```

Removes `context_servers.coolify` through the JSONC writer, so your comments and
formatting survive the removal exactly as they survived the install. Install
followed by uninstall returns the file byte for byte to its original state — one
of the three invariants every adapter must satisfy, listed in
[CONTRIBUTING](../../CONTRIBUTING.md#2-add-the-four-fixtures).

## Confirmed vs unconfirmed

| Item                                              | Status                                       |
| ------------------------------------------------- | -------------------------------------------- |
| `context_servers` key                             | confirmed                                    |
| `command` as a string with sibling `args` / `env` | confirmed                                    |
| `~/.config/zed/settings.json` on macOS and Linux  | confirmed                                    |
| `<projectRoot>/.zed/settings.json`                | confirmed                                    |
| Settings file is JSONC                            | confirmed                                    |
| `%APPDATA%\Zed\settings.json` on Windows          | **derived from `%APPDATA%`, not confirmed**  |
| Whether `"source": "custom"` is required          | **not verified** — omitted                   |
| `${VAR}` expansion inside `env`                   | **not verified** — treated as "no expansion" |
