/**
 * Kimi CLI — `~/.kimi/mcp.json`, key path `mcpServers.coolify`.
 *
 * Do NOT write `~/.kimi/mcp-configs/mcp-servers.json`. That path shows up in
 * search results but belongs to a different tool's template; Kimi never reads
 * it, so an install there succeeds silently and produces no server.
 *
 * Whether Kimi expands `${VAR}` inside its env block is unverified, so the token
 * reference is dropped rather than written as text — see `applyInterpolation`.
 */

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

const SPEC: AdapterSpec = {
  id: 'kimi-user',
  client: 'kimi',
  scope: 'user',
  label: 'Kimi CLI',
  format: 'json',
  confidence: 'verified',
  aliases: ['kimi', 'kimi-cli'],
  markerPaths: (ctx) => [pathFor(ctx).join(ctx.homeDir, '.kimi')],
};

function configPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.homeDir, '.kimi', 'mcp.json');
}

function keyPathFor(name: string): string[] {
  return ['mcpServers', name];
}

export const kimiUserAdapter: McpClientAdapter = {
  id: SPEC.id,
  client: SPEC.client,
  scope: SPEC.scope,
  label: SPEC.label,
  format: SPEC.format,
  confidence: SPEC.confidence,
  transports: ['stdio'],
  supports: (target) => supportsTarget(SPEC, target),
  resolvePath: configPath,
  detect: (ctx) => detectConfig(SPEC, configPath(ctx), ctx),
  nativeCli: {
    bin: 'kimi',
    // The `mcp add --transport stdio <name> -- <command> <args...>` form is
    // verified. The `-e KEY=VALUE` flags mirror the Claude Code CLI that Kimi's
    // is modelled on but are not; if they are rejected the command fails
    // outright and the caller falls back to the file writer, which is a visible
    // failure rather than a server registered without its base URL.
    buildArgv: (entry: ServerEntry): string[] => {
      const { env } = applyInterpolation(entry.env, 'none');
      const envFlags = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      return [
        'mcp',
        'add',
        '--transport',
        'stdio',
        entry.name,
        ...envFlags,
        '--',
        entry.command,
        ...entry.args,
      ];
    },
  },
  planWrite: (entry: ServerEntry, ctx: InstallCtx): Operation[] => {
    const { env, dropped } = applyInterpolation(entry.env, 'none');
    return [
      ...mkdirOps(configPath(ctx), ctx),
      {
        kind: 'json-merge',
        path: configPath(ctx),
        keyPath: keyPathFor(entry.name),
        value: { command: entry.command, args: [...entry.args], env },
      },
      ...droppedRefNote(SPEC, dropped),
    ];
  },
  planRemove: (ctx) => [
    { kind: 'json-remove', path: configPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(configPath(ctx), 'json', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) => baseValidate(SPEC, ctx, configPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};
