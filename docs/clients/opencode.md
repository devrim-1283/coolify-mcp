# OpenCode

|                      |                                                              |
| -------------------- | ------------------------------------------------------------ |
| Adapter ids          | `opencode-user`, `opencode-project`                          |
| `--client` selectors | `opencode`, `opencode-user`, `opencode-project`              |
| User config          | `~/.config/opencode/opencode.json` — **not confirmed**       |
| Project config       | `<projectRoot>/opencode.json` — confirmed                    |
| Key path             | `mcp.coolify`                                                |
| Format               | JSON                                                         |
| Transports written   | `stdio` (written as OpenCode's `type: "local"`)              |
| Confidence           | **verified** for the shape; the _global_ path is unconfirmed |
| Native CLI           | none                                                         |

## This is the adapter that makes a shared writer impossible

Every field is spelled differently from the `mcpServers` family:

|               | `mcpServers` clients  | OpenCode                        |
| ------------- | --------------------- | ------------------------------- |
| Container key | `mcpServers`          | `mcp`                           |
| Executable    | `"command": "npx"`    | included in the array           |
| Arguments     | `"args": ["-y", "…"]` | `"command": ["npx", "-y", "…"]` |
| Environment   | `"env"`               | `"environment"`                 |
| Kind          | implicit              | `"type": "local"`               |
| Enabled       | implicit              | `"enabled": true`               |

Feed a Claude-shaped entry in here and OpenCode reads a server with no command at
all.

## Install

```bash
npx @donedynamics/coolify-mcp install --client opencode --scope project   # recommended
npx @donedynamics/coolify-mcp install --client opencode --scope user
```

`--scope project` is recommended because the project path is confirmed and the
global one is not.

## What the installer writes

```json
{
  "mcp": {
    "coolify": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "-p",
        "@donedynamics/coolify-mcp@latest",
        "coolify-mcp-server"
      ],
      "enabled": true,
      "environment": {}
    }
  }
}
```

With `--connection prod`, `environment` becomes `{"COOLIFY_CONNECTION": "prod"}`.
With `--pin=1.4.2`, `command` becomes
`["npx", "-y", "@donedynamics/coolify-mcp@1.4.2"]`.

## Supplying credentials

**OpenCode's expansion of `${VAR}` inside `environment` is not verified.** The
installer treats it as a client that stores values verbatim and drops any `${…}`
reference rather than writing literal text.

OpenCode is a terminal program, so exporting the variables works:

```bash
# ~/.zshrc or ~/.bashrc
export COOLIFY_BASE_URL=https://coolify.example.com
export COOLIFY_API_TOKEN='13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

If you commit `opencode.json` to a repository — which is the point of the project
scope — keep it to pointers. A token in a committed config is a token in your
git history forever, and `doctor` will flag it as CRITICAL.

## Verify

```bash
npx @donedynamics/coolify-mcp doctor
```

When the global config is absent, doctor emits an `opencode-path-unconfirmed`
**info** finding. Unlike Zed's, this one is not platform-gated: the location is
unconfirmed on every OS, so the note appears everywhere.

### Help us close the last gap

The OpenCode docs say the config is read from "the workspace root or the home
directory". `~/.config/opencode/opencode.json` is the likely global location but
has not been confirmed against a real install, and it is not clear whether
Windows uses the same XDG-style path.

If you can confirm it, please
[open an issue](https://github.com/devrim-1283/coolify-mcp/issues). The test:
put a distinctive key in a candidate file, start OpenCode outside any workspace,
and see whether it takes effect. A link to upstream documentation is equally
good.

Until then, `--scope project` is the path we can stand behind.

## Uninstall

```bash
npx @donedynamics/coolify-mcp uninstall --client opencode
```

## Confirmed vs unconfirmed

| Item                                                                  | Status                                       |
| --------------------------------------------------------------------- | -------------------------------------------- |
| `mcp` container key                                                   | confirmed                                    |
| `type: "local"`, `command` as an argv array, `enabled`, `environment` | confirmed                                    |
| `<projectRoot>/opencode.json`                                         | confirmed                                    |
| `~/.config/opencode/opencode.json` as the global location             | **not confirmed**                            |
| The global path on Windows                                            | **not confirmed**                            |
| `${VAR}` expansion inside `environment`                               | **not verified** — treated as "no expansion" |
