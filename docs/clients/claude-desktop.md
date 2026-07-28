# Claude Desktop

|                      |                                                                                |
| -------------------- | ------------------------------------------------------------------------------ |
| Adapter id           | `claude-desktop`                                                               |
| `--client` selectors | `claude-desktop`, `claudedesktop`                                              |
| Config (macOS)       | `~/Library/Application Support/Claude/claude_desktop_config.json`              |
| Config (Windows)     | `%USERPROFILE%\AppData\Roaming\Claude\claude_desktop_config.json`              |
| Config (Linux)       | `~/.config/Claude/claude_desktop_config.json` — **convention, not documented** |
| Key path             | `mcpServers.coolify`                                                           |
| Format               | JSON                                                                           |
| Transports written   | `stdio` only                                                                   |
| Confidence           | **verified** for the shape; macOS and Windows paths documented, Linux derived  |
| Native CLI           | none                                                                           |

## Two behaviours make this the odd one out

**1. It spawns servers without a shell.** On Windows `npx` is `npx.cmd`, a batch
script, and `CreateProcess` cannot execute one directly — the server dies with
`ENOENT` before it ever speaks MCP. The fix is to invoke the shell explicitly.
This is the only adapter that rewrites the command, and only on win32.

**2. It does not inherit the shell environment.** Variables exported in a
terminal, or in `~/.zshrc`, are simply absent from the child process. The advice
that works for every CLI client — "just export `COOLIFY_API_TOKEN`" — does not
work here. Nor is `${VAR}` expansion in this file confirmed.

That combination is why the recommended setup for Claude Desktop is a registry
file with `tokenCommand` or `tokenKeychain`: the token is fetched by the server
itself at startup, so nothing has to be inherited and nothing has to be written
in plaintext.

## Install

```bash
npx @done-dynamics/coolify-mcp install --client claude-desktop
```

## What the installer writes

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

On **Windows** the same install produces the shell wrapper instead:

```json
{
  "mcpServers": {
    "coolify": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@done-dynamics/coolify-mcp@latest"
      ],
      "env": {}
    }
  }
}
```

With `--connection prod`, `env` becomes `{"COOLIFY_CONNECTION": "prod"}`. With
`--pin=1.4.2`, the spec in `args` becomes `@done-dynamics/coolify-mcp@1.4.2`.

Restart Claude Desktop after any change — it reads this file at launch.

## Supplying credentials — the recommended route

Because the environment is not inherited, use a registry file. Save it at
`~/.coolify-mcp/config.json` (or `%APPDATA%\coolify-mcp\config.json` on Windows):

```json
{
  "$schema": "https://raw.githubusercontent.com/devrim-1283/coolify-mcp/main/schema/config.v1.json",
  "version": 1,
  "defaultConnection": "prod",
  "connections": {
    "prod": {
      "baseUrl": "https://coolify.example.com",
      "tokenCommand": ["op", "read", "op://Infra/coolify-prod/credential"],
      "readOnly": true
    }
  }
}
```

Then:

```bash
npx @done-dynamics/coolify-mcp install --client claude-desktop --connection prod
```

The config entry holds one string — the connection _name_ — and the token is
resolved from 1Password (or `pass`, `vault`, `gopass`, the macOS keychain,
`secret-tool`) when the server starts. `tokenCommand` is a shell-free argv array,
so any command that prints the token works.

> **macOS caveat.** `tokenCommand` inherits the environment Claude Desktop was
> launched with, which is not your shell's. If `op` is not on the PATH the app
> sees, use its absolute path: `["/usr/local/bin/op", "read", "op://…"]`.

### If you must put values in the file

Claude Desktop's `${VAR}` expansion is **not verified**, so the installer drops
any reference rather than writing literal text. If you add values by hand they
are literals at rest, in a file that syncs with your user profile.
`npx @done-dynamics/coolify-mcp doctor` will flag them, correctly, as CRITICAL. Rotate the token
if you ever do this.

## Verify

```bash
npx @done-dynamics/coolify-mcp doctor
```

On Linux, when the config is absent, doctor emits a
`claude-desktop-path-unconfirmed` **info** finding: there is no official Linux
build, so `~/.config/Claude` is the XDG convention community packages use rather
than a documented location. The note is suppressed on macOS and Windows.

In the app: Settings → Developer → the `coolify` server should show as running.
Its log is at `~/Library/Logs/Claude/mcp-server-coolify.log` on macOS and
`%APPDATA%\Claude\logs\` on Windows. coolify-mcp writes every human-readable byte
to stderr — stdout is the JSON-RPC channel — so that log is where startup errors
appear.

### Help us close the last gaps

Please [open an issue](https://github.com/devrim-1283/coolify-mcp/issues) if you
can confirm either of these:

- **Does Claude Desktop expand `${VAR}` in `mcpServers.<name>.env`?** Set
  `"PROBE": "${HOME}"` on any server and read what arrives. A link to upstream
  documentation is equally good evidence.
- **Where does a Linux community build read `claude_desktop_config.json` from?**

Confirming the first would let `doctor --fix` repair Claude Desktop configs,
which today it refuses to do.

## Uninstall

```bash
npx @done-dynamics/coolify-mcp uninstall --client claude-desktop
```

## Confirmed vs unconfirmed

| Item                                                 | Status                                       |
| ---------------------------------------------------- | -------------------------------------------- |
| `mcpServers` key and entry shape                     | confirmed                                    |
| macOS path (`~/Library/Application Support/Claude/`) | confirmed                                    |
| Windows path (`%APPDATA%\Claude\`)                   | confirmed                                    |
| `cmd /c` wrapper needed on Windows                   | confirmed                                    |
| No shell-environment inheritance                     | confirmed                                    |
| Linux path (`~/.config/Claude/`)                     | **XDG convention, not documented**           |
| `${VAR}` expansion inside `env`                      | **not verified** — treated as "no expansion" |
