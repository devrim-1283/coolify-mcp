# Kimi CLI

| | |
|---|---|
| Adapter id | `kimi-user` |
| `--client` selectors | `kimi`, `kimi-cli`, `kimi-user` |
| Config | `~/.kimi/mcp.json` (Windows: `%USERPROFILE%\.kimi\mcp.json`) |
| Key path | `mcpServers.coolify` |
| Format | JSON |
| Transports written | `stdio` only |
| Confidence | **verified** for the path, the key and the `mcp add` form |
| Native CLI | `kimi mcp add`, preferred when the `kimi` binary is on PATH |

## Do not write `~/.kimi/mcp-configs/mcp-servers.json`

That path shows up in search results and in a few blog posts, but it belongs to a
different tool's template. Kimi never reads it, so an install there succeeds
silently and produces no server — the worst kind of failure, because everything
reports success.

The path Kimi actually reads is `~/.kimi/mcp.json`.

## Install

```bash
npx coolify-mcp install --client kimi
```

## What the installer writes

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": [
        "-y",
        "coolify-mcp@latest"
      ],
      "env": {}
    }
  }
}
```

With `--connection prod`, `env` becomes `{"COOLIFY_CONNECTION": "prod"}`. With
`--pin=1.4.2`, `args` becomes `["-y", "coolify-mcp@1.4.2"]`.

### Via the native CLI

When `kimi` is on PATH the installer shells out:

```bash
kimi mcp add --transport stdio coolify -- npx -y coolify-mcp@latest
```

With `--connection prod` an `-e COOLIFY_CONNECTION=prod` pair is inserted before
the `--`. Use `--no-native-cli` to force the file writer.

> The `mcp add --transport stdio <name> -- <command> <args...>` form is verified.
> The `-e KEY=VALUE` flags mirror the Claude Code CLI that Kimi's is modelled on
> and are **not** verified. If Kimi rejects them the command fails outright and
> the installer falls back to the file writer — a visible failure rather than a
> server registered without part of its configuration.

## Supplying credentials

**Whether Kimi expands `${VAR}` inside its `env` block is not verified.** Until
it is, the installer treats Kimi as a client that stores values verbatim and
drops any `${…}` reference rather than writing it as literal text.

So: export the variables in the shell Kimi runs from.

```bash
# ~/.zshrc or ~/.bashrc
export COOLIFY_BASE_URL=https://coolify.example.com
export COOLIFY_API_TOKEN='13|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

Kimi is a terminal program, so it inherits your shell environment and this works.

For multiple instances or teams, define a
[registry file](../connections.md#layer-2--a-registry-file) and select one with
`--connection`, which writes only the connection *name* into the config.

`doctor --fix` will not rewrite literals in a Kimi config, because Kimi is not on
the verified-expansion list. A config referencing a variable the client never
expands fails at spawn time, in a place you cannot see — strictly worse than the
literal it replaced.

## Verify

```bash
npx coolify-mcp doctor
kimi mcp list        # if your Kimi version has it
```

### Help us close the last gap

If you can confirm whether Kimi expands `${VAR}` in `mcpServers.<name>.env`,
please [open an issue](https://github.com/devrim-1283/coolify-mcp/issues). The
test is small:

1. Add an entry whose `env` sets `PROBE` to `${HOME}`.
2. Start a server that echoes its environment (any trivial stdio MCP server will
   do), or read the server's own stderr.
3. If `PROBE` arrives as your home directory, expansion works; if it arrives as
   the six characters `${HOME}`, it does not.

A link to upstream documentation is equally good evidence. Either promotes Kimi
to the `EXPANDS_ENV_REFERENCES` set in `src/install/doctor.ts` and lets
`--fix` repair Kimi configs.

## Uninstall

```bash
npx coolify-mcp uninstall --client kimi
```

## Confirmed vs unconfirmed

| Item | Status |
|---|---|
| `~/.kimi/mcp.json` path | confirmed |
| `mcpServers` key | confirmed |
| `kimi mcp add --transport stdio <name> -- <cmd> <args…>` | confirmed |
| `-e KEY=VALUE` flags on `kimi mcp add` | **not verified** — failure falls back to the file writer |
| `${VAR}` expansion inside `env` | **not verified** — treated as "no expansion" until proven |
