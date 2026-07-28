/**
 * OpenCode — `opencode.json`, top-level key `mcp`.
 *
 * This is the adapter that makes a shared writer impossible. Every field is
 * spelled differently from the mcpServers family:
 *
 * - `command` is an ARRAY that INCLUDES the executable — `["npx","-y","..."]`,
 *   not `command: "npx"` + `args: [...]`.
 * - the env key is `environment`, not `env`.
 * - the entry carries `type: "local"` and an explicit `enabled: true`.
 *
 * Feed a Claude-shaped entry in here and OpenCode reads a server with no
 * command at all.
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

const ALIASES = ['opencode'] as const;

function keyPathFor(name: string): string[] {
  return ['mcp', name];
}

function markerPaths(ctx: InstallCtx): string[] {
  return [
    pathFor(ctx).join(ctx.homeDir, '.config', 'opencode'),
    pathFor(ctx).join(ctx.homeDir, '.opencode'),
    pathFor(ctx).join(ctx.homeDir, '.local', 'share', 'opencode'),
  ];
}

function opencodeEntry(entry: ServerEntry): { value: Record<string, unknown>; dropped: string[] } {
  const { env, dropped } = applyInterpolation(entry.env, 'none');
  return {
    value: {
      type: 'local',
      command: [entry.command, ...entry.args],
      enabled: true,
      environment: env,
    },
    dropped,
  };
}

function planWriteFor(
  spec: AdapterSpec,
  path: string,
  entry: ServerEntry,
  ctx: InstallCtx,
): Operation[] {
  const { value, dropped } = opencodeEntry(entry);
  return [
    ...mkdirOps(path, ctx),
    { kind: 'json-merge', path, keyPath: keyPathFor(entry.name), value },
    ...droppedRefNote(spec, dropped),
  ];
}

// ---------------------------------------------------------------------------
// User scope
// ---------------------------------------------------------------------------

const USER_SPEC: AdapterSpec = {
  id: 'opencode-user',
  client: 'opencode',
  scope: 'user',
  label: 'OpenCode (global)',
  format: 'json',
  confidence: 'verified',
  aliases: ALIASES,
  markerPaths,
  // TODO(verify): the docs say the config is read from "the workspace root or
  // the home directory". ~/.config/opencode/opencode.json is the likely global
  // location but has not been confirmed against a real install, and it is not
  // clear whether Windows uses the same XDG-style path.
  // Unconfirmed on every OS, so this one is not platform-gated.
  pathUnconfirmed: () =>
    'The OpenCode global config location is unconfirmed — the docs say "workspace root or home directory". Prefer --scope project, which is confirmed.',
};

function userPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.homeDir, '.config', 'opencode', 'opencode.json');
}

export const opencodeUserAdapter: McpClientAdapter = {
  id: USER_SPEC.id,
  client: USER_SPEC.client,
  scope: USER_SPEC.scope,
  label: USER_SPEC.label,
  format: USER_SPEC.format,
  confidence: USER_SPEC.confidence,
  transports: ['stdio'],
  supports: (target) => supportsTarget(USER_SPEC, target),
  resolvePath: userPath,
  detect: (ctx) => detectConfig(USER_SPEC, userPath(ctx), ctx),
  planWrite: (entry, ctx) => planWriteFor(USER_SPEC, userPath(ctx), entry, ctx),
  planRemove: (ctx) => [
    { kind: 'json-remove', path: userPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(userPath(ctx), 'json', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) => baseValidate(USER_SPEC, ctx, userPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};

// ---------------------------------------------------------------------------
// Project scope — <projectRoot>/opencode.json (confirmed)
// ---------------------------------------------------------------------------

const PROJECT_SPEC: AdapterSpec = {
  id: 'opencode-project',
  client: 'opencode',
  scope: 'project',
  label: 'OpenCode (project)',
  format: 'json',
  confidence: 'verified',
  aliases: ALIASES,
  markerPaths,
};

function projectPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.projectRoot, 'opencode.json');
}

export const opencodeProjectAdapter: McpClientAdapter = {
  id: PROJECT_SPEC.id,
  client: PROJECT_SPEC.client,
  scope: PROJECT_SPEC.scope,
  label: PROJECT_SPEC.label,
  format: PROJECT_SPEC.format,
  confidence: PROJECT_SPEC.confidence,
  transports: ['stdio'],
  supports: (target) => supportsTarget(PROJECT_SPEC, target),
  resolvePath: projectPath,
  detect: (ctx) => detectConfig(PROJECT_SPEC, projectPath(ctx), ctx),
  planWrite: (entry, ctx) => planWriteFor(PROJECT_SPEC, projectPath(ctx), entry, ctx),
  planRemove: (ctx) => [
    { kind: 'json-remove', path: projectPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(projectPath(ctx), 'json', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) =>
    baseValidate(PROJECT_SPEC, ctx, projectPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};
