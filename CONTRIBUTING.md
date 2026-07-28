# Contributing

Thanks for looking. This project has a small number of hard rules, and all of
them exist because breaking one costs a user something real: a leaked credential,
a corrupted config file, or a tool that lies to a language model about what it
does.

## Ground rules

- **All code comments in English.** This is a public repository.
- **Comments explain WHY, not WHAT.** Be sparing, but do explain non-obvious
  decisions and the reasoning behind them. If a reviewer would ask "why is it done
  this way", answer it in the file.
- **No native dependencies, ever.** They break `npx coolify-mcp`, which is the
  primary install path. Runtime dependencies today:
  `@modelcontextprotocol/sdk`, `zod`, `smol-toml`, `jsonc-parser`, `yaml`. Adding
  a sixth needs a good argument.
- **Never log, throw, or embed a bearer token.** Every string leaving the process
  goes through `redact()`.
- **`src/generated/` is generated.** Edit `scripts/generate-catalog.ts` and re-run
  codegen; never hand-edit the output.
- **Relative imports carry `.js`.** This is ESM with `moduleResolution: bundler`:
  `import { x } from './y.js'`, even though the source file is `y.ts`.

## Dev loop

```bash
npm install

npm run typecheck      # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run lint           # eslint
npm run format:check   # prettier --check
npm test               # vitest run
npm run build          # tsup -> dist/

npm run codegen        # regenerate src/generated/ from scripts/coolify-openapi.json
npm run codegen:check  # codegen + `git diff --exit-code src/generated` — what CI runs
```

Node ≥ 20.10. Windows, macOS and Linux are all supported and all tested in CI —
`%APPDATA%`, backslash paths, CRLF and the `npx` spawn quirk all live on Windows,
and half the target clients are Windows-heavy.

### Running the server against a real instance

```bash
export COOLIFY_BASE_URL=https://coolify.example.com
export COOLIFY_API_TOKEN='13|…'
npm run build

npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name find_resources --tool-arg query=api
```

Remember that **stdout is the JSON-RPC channel**. One stray `console.log`
desynchronises the framing and the client drops the connection with an error that
names neither the line nor the process. Diagnostics go to stderr.

### Testing the installer without touching your machine

```bash
npx coolify-mcp install --dry-run          # unified diff of every file that would change
npx coolify-mcp install --print            # the snippet, no file access
npx coolify-mcp install --client zed --dry-run
```

`--dry-run` runs the _same_ `applyPlan` call the real install runs, with `dryRun`
flipped. There is no parallel preview implementation that can drift.

## Where the security story lives

Two files. Any review should start with them, and any change to either deserves
extra scrutiny:

| File                    | Question                    |
| ----------------------- | --------------------------- |
| `src/tools/register.ts` | What tools exist at all.    |
| `src/http/client.ts`    | What may leave the process. |

See [SECURITY.md](./SECURITY.md) for the threat model.

---

# Adding a client adapter

This is the flagship contribution, and the one with the strictest rules — because
an adapter writes into a file that holds **every other MCP server on the user's
machine**. A maintainer's guess about a config key has, in the real world, taken
out every MCP server in a user's `config.toml` at once. That incident is why the
`confidence` field exists.

Four things, in order.

## 1. Implement `McpClientAdapter`

One new file, `src/install/adapters/<client>.ts`, and one line in
`src/install/adapters/index.ts`. Nothing else in the registry needs editing —
that is the point of a frozen array plus `find(a => a.supports(target))`.

```ts
import type { InstallCtx, McpClientAdapter, Operation, ServerEntry } from '../../types.js';
import {
  applyInterpolation, baseValidate, detectConfig, droppedRefNote,
  MANAGED_SERVER_NAME, mkdirOps, pathFor, readEntryAt, supportsTarget,
  type AdapterSpec,
} from './shared.js';
```

The contract, and the parts of it that are not negotiable:

| Member                            | Rule                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                              | `"<client>-<scope>"`, unique. `doctor` reports a duplicate as `adapter-duplicate-id`.                                                                                                                                                                                                                                                 |
| `client`, `aliases`               | The `--client` selectors. `client` is also the prefix of every `ValidationIssue` code this adapter emits.                                                                                                                                                                                                                             |
| `format`                          | `json` \| `jsonc` \| `toml` \| `yaml`. Picks the merge writer.                                                                                                                                                                                                                                                                        |
| `confidence`                      | `'verified'` only under the rule in step 4.                                                                                                                                                                                                                                                                                           |
| `transports`                      | Declare **only what you actually write.** Advertising `'http'` and then emitting stdio lets `--transport http` be accepted and silently ignored, which is worse than refusing the flag.                                                                                                                                               |
| `resolvePath(ctx)`                | Uses `pathFor(ctx)`, never bare `node:path` — path arithmetic must follow `ctx.platform`, not the host, or a Linux CI runner emits POSIX separators for a win32 fixture. Derive `%APPDATA%` from `ctx.homeDir`; `InstallCtx` deliberately carries no environment, which is what keeps `resolvePath` deterministic under the fixtures. |
| `planWrite`, `planRemove`         | **PURE. No I/O.** They return inert `Operation` data. This is what makes `--dry-run` a real preview rather than a second code path.                                                                                                                                                                                                   |
| `detect`, `readEntry`, `validate` | May do I/O. Must not throw for an ordinary missing file.                                                                                                                                                                                                                                                                              |
| `nativeCli`                       | Optional. Prefer the client's own CLI when the argument form is **verified** — it preserves invariants we do not know about. If it is not verified, leave it out; see Codex.                                                                                                                                                          |

### Getting the entry body right

The env block is the single most dangerous field in an adapter. `applyInterpolation`
takes the canonical `${VAR}` env block and rewrites it into the target's syntax:

| Style            | Client                | Behaviour                                                                                       |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `'dollar-brace'` | Claude Code           | `${VAR}` and `${VAR:-default}` pass through unchanged.                                          |
| `'dollar-env'`   | Cursor                | Rewritten to `${env:VAR}`. A `:-default` is **discarded**, not smuggled into the variable name. |
| `'none'`         | everything unverified | The reference is **dropped** and reported through `droppedRefNote`.                             |

**When in doubt, use `'none'`.** Dropping is the whole point: the installer writes
pointer config only, so "this client cannot expand a reference" must never degrade
into "write the secret in plaintext". The worst outcome an adapter is allowed to
produce is an entry missing a variable, never one leaking a credential.

### Merge semantics per format

| Format    | Writer           | Rule                                                                                                                                                                                   |
| --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON      | `merge/json.ts`  | Deep merge under the managed key path only.                                                                                                                                            |
| **JSONC** | `merge/jsonc.ts` | **`jsonc-parser`'s `modify()` / `applyEdits()`.** A naive `JSON.parse`/`stringify` round-trip deletes every comment in the user's file. That is explicitly forbidden by this contract. |
| TOML      | `merge/toml.ts`  | **Append-only**, and **refuse to write into a file that does not parse** (`<client>-config-unparseable`). Appending to a broken config turns a five-second repair into archaeology.    |
| YAML      | `merge/yaml.ts`  | Merge under the key path.                                                                                                                                                              |

## 2. Add the four fixtures

Under `test/install/adapters/__fixtures__/<adapter-id>/`, with the extension of
the client's format:

| Fixture     | What it asserts                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `empty`     | The file does not exist → it is created correctly, with the right parent directories.                                                                  |
| `populated` | Unrelated MCP servers are already present → ours is added and **theirs are byte-identical afterwards**.                                                |
| `commented` | Comments, CRLF line endings, a BOM and trailing commas are all **preserved**. This is the JSONC and TOML contract, and it is where naive writers fail. |
| `conflict`  | A `coolify` entry already exists and has drifted → append-only skips it and warns rather than clobbering it.                                           |

And three invariants, which the shared harness applies to **every** adapter:

1. **Idempotence.** Apply twice → identical bytes.
2. **Round-trip.** install → uninstall → byte-identical to the original.
3. **Docs parity.** The snippet in `docs/clients/<x>.md` is extracted and compared
   against the writer's actual output. **Documentation cannot drift from code.**

### The docs-parity convention

The parity check needs a rule for which block to extract, so:

> **The first fenced code block under the heading `## What the installer writes`
> in `docs/clients/<x>.md` is the writer's exact output** for the default
> invocation (`coolify-mcp@latest`, empty `env`).

Any other snippet in that file — hand-edit examples, credential wiring, alternative
shapes — must sit under a different heading and be labelled as _not_ what the
installer writes. Look at [docs/clients/claude-code.md](./docs/clients/claude-code.md)
for the pattern.

Unverified adapters have no such heading, because they write nothing. See
[docs/clients/minimax.md](./docs/clients/minimax.md).

## 3. Write `docs/clients/<x>.md`

Copy the structure of an existing one. It must contain:

- The at-a-glance table: adapter ids, `--client` selectors, every config path per
  OS, the key path, the format, transports written, confidence, native CLI.
- `## What the installer writes` — the exact snippet (see above).
- How credentials reach the server for **this** client specifically. "Just export
  the variable" is correct for terminal clients and wrong for GUI ones; say which
  this is.
- **A confirmed-vs-unconfirmed table.** Every row is either confirmed or explicitly
  marked as derived, guessed or unverified. If you are not sure, that is a row
  saying so — not a row you leave out.
- If anything is unconfirmed: how a reader could confirm it, concretely enough to
  actually do.

## 4. `confidence: 'verified'` — the one rule that matters

> **Set `confidence: 'verified'` ONLY with a link to upstream documentation, or a
> reproducible probe, in the pull request description.**

Nothing else counts. Not "every other client uses `mcpServers`". Not "the config
file has an OpenCode fingerprint so it probably has OpenCode's `mcp:` block". Not
"I have used this client for a year".

A **reproducible probe** means something a reviewer can run and get the same
answer from:

```bash
cp -r ~/.someclient /tmp/before
someclient mcp add probe -- npx -y @modelcontextprotocol/server-everything
diff -ru /tmp/before ~/.someclient      # the key that appears is the real one
```

Until you have one of those, ship the adapter as `confidence: 'unverified'`. That
is not a failure — it is a working, useful contribution:

- `apply()` **mechanically refuses to write**, so the guess cannot reach a user's
  file.
- `planWrite()` should return notes and **no write operations at all**, so even a
  caller that ignored the flag has nothing to execute.
- `--print` still gives users a snippet to apply by hand, with the candidates and
  the verification procedure spelled out.
- `readEntry()` can probe _both_ candidate locations read-only. If either ever
  returns a value on a real install, the key is settled — and that probe runs on
  every `doctor`, on every user's machine, for free.

**This single rule is what keeps unverified guesses out of users' config files.**
The whole `confidence` mechanism exists so that "I think it's this key" and "I
know it's this key" cannot produce the same bytes on disk. Please do not argue it
down in review; argue up with evidence instead.

---

# Other contributions

## Adding a tool

Before adding one, check whether the generic catalog path already covers it.
`search_operations` → `describe_operation` → `execute_*` reaches all 189
catalogued operations, and a promoted tool costs context on **every turn of every
conversation**, whether it is called or not. A tool earns its slot by covering a
loop an operator actually repeats.

If it does earn one:

- Implement `ToolDef` from `src/types.ts`. Annotations (`title`, `readOnlyHint`,
  `destructiveHint`, `openWorldHint`) are mandatory and must be **true**. A
  `destructiveHint` that is wrong in either direction corrupts the host's consent
  model for every other tool.
- `inputSchema` is built per config, so `instance` can be conditional: absent with
  one connection, an enum with several, **required with no default on writes.**
- Declare a projection allowlist **in the tool's own module**, not in a shared
  barrel. A projection only stays correct if it moves when its tool moves.
- Return errors, never throw across the transport. Use `runRead` / the module's
  error renderer.
- Descriptions state what the tool **is** and what it **returns**. They never tell
  the model when to call something — a directive embedded in a tool schema reads
  as prompt injection.
- Add it to `ALL_TOOLS` in `src/tools/register.ts` with the right `surface`.

## Changing the catalog generator

`scripts/generate-catalog.ts` asserts its input counts and **crashes loudly** on a
mismatch rather than quietly emitting a wrong catalog. Keep that. CI runs
`npm run codegen:check`, so upstream drift fails the build — which is the intended
notification, not an annoyance.

If you bump the pinned spec, update `scripts/coolify-openapi.json`, re-run
codegen, commit `src/generated/` in the same change, and update the operation
counts quoted in `README.md` and `docs/tools.md`.

## Commits and pull requests

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`,
`perf:`, `ci:`.

A pull request should say what changed, why, and how you verified it. For an
adapter, "how you verified it" is the evidence from step 4. For anything touching
`http/client.ts` or `tools/register.ts`, say explicitly which security property
you believe is preserved and why.

CI must be green: lint, typecheck, format, the 9-cell test matrix
(3 OS × Node 20/22/24), the packaging checks, the stdio smoke test, and
`codegen:check`.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Code of conduct

Be decent. Assume good faith. Review the code, not the person.
