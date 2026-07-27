/**
 * Codex CLI — `~/.codex/config.toml`, section `[mcp_servers.coolify]`.
 *
 * Two hard rules, both learned from a real incident:
 *
 * 1. ALWAYS stdio, never a `url` key. Recent Codex versions accept HTTP
 *    transports; older ones deserialize an entry without `command` as a hard
 *    error and drop the *entire* config.toml — taking every other MCP server in
 *    the file down with it. stdio parses on every Codex version ever shipped, so
 *    it is the only thing this adapter is allowed to emit.
 * 2. Append-only, and never into a file that does not parse. Merging into a
 *    broken TOML file is how one bad key becomes an unrecoverable config.
 *
 * Operation convention: `toml-append.text` carries the full block *including*
 * its `[mcp_servers.<name>]` header, so the writer can append it verbatim;
 * `section` is provided separately for existence checks and removal.
 */

import { stringify as stringifyToml } from 'smol-toml';

import type { InstallCtx, McpClientAdapter, Operation, ServerEntry } from '../../types.js';
import {
  applyInterpolation,
  baseValidate,
  detectConfig,
  droppedRefNote,
  MANAGED_SERVER_NAME,
  mkdirOps,
  pathFor,
  readEntryAt,
  supportsTarget,
  type AdapterSpec,
} from './shared.js';

/**
 * npx has to resolve, download and unpack the package before the server can
 * speak MCP, which routinely exceeds Codex's default startup budget on a cold
 * machine — the failure looks like "server did not start" rather than "still
 * downloading". Emitting the key is safe precisely because `command` is always
 * present: the version skew that poisons config.toml is a *missing required*
 * field, not an extra one, and an unrecognized scalar is ignored.
 */
const STARTUP_TIMEOUT_SEC = 60;

const SPEC: AdapterSpec = {
  id: 'codex-user',
  client: 'codex',
  scope: 'user',
  label: 'Codex CLI',
  format: 'toml',
  confidence: 'verified',
  aliases: ['codex', 'openai-codex'],
  markerPaths: (ctx) => [pathFor(ctx).join(ctx.homeDir, '.codex')],
};

function configPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.homeDir, '.codex', 'config.toml');
}

/** TOML bare keys allow only `[A-Za-z0-9_-]`; anything else must be quoted. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function sectionFor(name: string): string {
  return `mcp_servers.${tomlKey(name)}`;
}

function keyPathFor(name: string): string[] {
  return ['mcp_servers', name];
}

export const codexUserAdapter: McpClientAdapter = {
  id: SPEC.id,
  client: SPEC.client,
  scope: SPEC.scope,
  label: SPEC.label,
  format: SPEC.format,
  confidence: SPEC.confidence,
  // Unlike the other adapters, this list can never widen on convenience
  // grounds: see rule 1 in the file header.
  transports: ['stdio'],
  supports: (target) => supportsTarget(SPEC, target),
  resolvePath: configPath,
  detect: (ctx) => detectConfig(SPEC, configPath(ctx), ctx),
  // No nativeCli: `codex mcp add` exists on recent versions but its argument
  // form is not verified here, and a half-right invocation would write an entry
  // this adapter cannot then recognize. The append-only file writer is provably
  // safe, so it is the only path.
  planWrite: (entry: ServerEntry, ctx: InstallCtx): Operation[] => {
    // Codex stores env values verbatim, so a `${VAR}` reference would reach the
    // server as literal text.
    const { env, dropped } = applyInterpolation(entry.env, 'none');
    const body: Record<string, unknown> = {
      command: entry.command,
      args: [...entry.args],
      startup_timeout_sec: STARTUP_TIMEOUT_SEC,
    };
    if (Object.keys(env).length > 0) body['env'] = env;

    // smol-toml owns escaping and sub-table layout; hand-rolling the block is
    // how quoting bugs get shipped into a file that must never fail to parse.
    const text = stringifyToml({ mcp_servers: { [entry.name]: body } });

    return [
      ...mkdirOps(configPath(ctx), ctx),
      { kind: 'toml-append', path: configPath(ctx), section: sectionFor(entry.name), text },
      ...droppedRefNote(SPEC, dropped),
    ];
  },
  planRemove: (ctx) => [
    { kind: 'toml-remove', path: configPath(ctx), section: sectionFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(configPath(ctx), 'toml', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) => baseValidate(SPEC, ctx, configPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};
