# MiniMax CLI — **UNVERIFIED**

> **coolify-mcp will not write to this client.** The key MiniMax uses for MCP
> servers is not known, and it is not guessed. Everything below is print-only
> until someone confirms it.

|                      |                                                            |
| -------------------- | ---------------------------------------------------------- |
| Adapter id           | `minimax-user`                                             |
| `--client` selectors | `minimax`, `minimax-cli`, `minimax-user`                   |
| Config               | `~/.minimax/config.yaml`                                   |
| Key path             | **UNKNOWN** — two candidates below                         |
| Format               | YAML                                                       |
| Confidence           | **`unverified`** — `apply()` mechanically refuses to write |
| Native CLI           | unknown; possibly `minimax mcp`                            |

## Why this is not just guessed

`~/.minimax/config.yaml` carries an unmistakable OpenCode / models.dev
fingerprint: `provider.<id>.npm`, `options.baseURL`, `models.<id>.limit.context`.
The obvious inference is that MiniMax also inherited OpenCode's `mcp:` block.

But the fork has renamed its top-level keys — `defaultModel` not `model`,
`permissionMode` not `permission`, `logLevel` not `log_level`. The fingerprint
proves the lineage and says **nothing** about the spelling of the MCP key.

Writing a wrong top-level key into a file that also holds your model
configuration is exactly the failure the [Codex `url` rule](./codex.md) exists to
prevent: a maintainer's guess breaking every user's config at once. So this
adapter carries `confidence: 'unverified'`, which makes `apply()` refuse to
write, and its `planWrite()` returns notes and **no write operations at all** —
even a caller that ignored the confidence flag would have nothing to execute.

## Getting the snippet

```bash
npx @done-dynamics/coolify-mcp install --client minimax --print
```

`--print` works for unverified adapters precisely because they are who it is for.
`install` without `--print` reports the target as `blocked` and writes nothing.

## Candidate A (UNVERIFIED) — OpenCode-derived block in `~/.minimax/config.yaml`

```yaml
mcp:
  coolify:
    type: local
    command:
      - npx
      - -y
      - -p
      - "@done-dynamics/coolify-mcp@latest"
      - coolify-mcp-server
    enabled: true
    environment: {}
```

Merge this into the existing `config.yaml`. Do not replace the file.

## Candidate B (UNVERIFIED) — Claude-compatible file at `~/.minimax/mcp.json`

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

This is a sibling file, not an edit to `config.yaml`, so it is the lower-risk of
the two to try: if MiniMax does not read it, nothing happens.

## Verification procedure

This is the exact procedure printed by `--print`, reproduced so you can follow it
without running anything.

**1. Look for an `mcp` subcommand — this is the definitive answer.**

```bash
minimax --help
```

If `mcp` exists, add a throwaway server with it (any harmless stdio server will
do), then diff `~/.minimax` before and after:

```bash
cp -r ~/.minimax /tmp/minimax-before
minimax mcp add probe -- npx -y @modelcontextprotocol/server-everything
diff -ru /tmp/minimax-before ~/.minimax
```

Whatever key appears is the real one. Remove the throwaway afterwards.

**2. If there is no `mcp` subcommand, grep the installed CLI bundle.**

Look for the literals `mcpServers`, `"mcp"` and `environment` near a
config-schema literal:

```bash
grep -rn 'mcpServers\|"mcp"\|environment' "$(dirname "$(readlink -f "$(command -v minimax)")")" | head -40
```

Remember that the fingerprint alone is not proof — the fork renames keys.

**3. Report the finding.**

[Open an issue](https://github.com/devrim-1283/coolify-mcp/issues) with either a
link to upstream documentation or the reproducible probe from step 1. That is the
bar for promoting the adapter to `confidence: 'verified'` and giving it a writer.
See [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-client-adapter) — that
single rule is what keeps unverified guesses out of users' config files.

## What the adapter does do today

- **`detect`** — reports whether `~/.minimax/` exists, so `doctor` can tell you
  MiniMax is installed and unwritable.
- **`readEntry`** — probes _both_ candidates read-only: `mcp.coolify` in
  `config.yaml`, then `mcpServers.coolify` in `~/.minimax/mcp.json`. If either
  ever returns a value on a real install, the key is settled and the probe
  reports which file and key path it came from. This is the cheapest half of the
  verification procedure and it runs on every `doctor`.
- **`validate`** — emits a `minimax-unverified` **warn** finding.
- **`planRemove`** — a note, not a removal: coolify-mcp never wrote anything, so
  there is nothing to remove automatically. If you applied a snippet by hand,
  delete that block by hand as well.

## Confirmed vs unconfirmed

| Item                                            | Status                                  |
| ----------------------------------------------- | --------------------------------------- |
| `~/.minimax/config.yaml` exists and is YAML     | confirmed                               |
| OpenCode / models.dev lineage of the file       | confirmed                               |
| Top-level keys are renamed relative to OpenCode | confirmed                               |
| The MCP container key                           | **UNKNOWN** — this is the blocker       |
| Whether `~/.minimax/mcp.json` is read at all    | **UNKNOWN**                             |
| Existence of a `minimax mcp` subcommand         | **UNKNOWN**                             |
| `${VAR}` expansion                              | **UNKNOWN** — treated as "no expansion" |
