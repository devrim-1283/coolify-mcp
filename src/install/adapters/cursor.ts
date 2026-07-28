/**
 * Cursor — `~/.cursor/mcp.json` (user) and `<projectRoot>/.cursor/mcp.json`
 * (project).
 *
 * The file shape matches Claude Code closely enough to invite a copy-paste, and
 * that copy-paste is a trap: Cursor interpolates `${env:NAME}`, not `${NAME}`.
 * A Claude-style `${COOLIFY_API_TOKEN}` is stored and forwarded verbatim, so the
 * server receives the reference text as its bearer token and reports a 401 that
 * looks like a bad credential rather than a bad config. That single character
 * difference is why this adapter exists separately.
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

const ALIASES = ['cursor'] as const;

function keyPathFor(name: string): string[] {
  return ['mcpServers', name];
}

function markerPaths(ctx: InstallCtx): string[] {
  return [pathFor(ctx).join(ctx.homeDir, '.cursor')];
}

/**
 * `envFile` is Cursor's own answer for stdio servers and keeps secrets out of
 * the config entirely. It is surfaced as advice rather than written, because
 * pointing at a dotenv path the user has not created would produce a server
 * that fails to start.
 */
const ENV_FILE_NOTE: Operation = {
  kind: 'note',
  level: 'info',
  message:
    'Cursor also supports `"envFile": "/absolute/path/to/.env"` on stdio servers, which is the cleanest ' +
    'Cursor-native way to supply COOLIFY_API_TOKEN: add it to the coolify entry and keep the token in that ' +
    'file instead of in mcp.json.',
};

function planWriteFor(
  spec: AdapterSpec,
  path: string,
  entry: ServerEntry,
  ctx: InstallCtx,
): Operation[] {
  const { env, dropped } = applyInterpolation(entry.env, 'dollar-env');
  return [
    ...mkdirOps(path, ctx),
    {
      kind: 'json-merge',
      path,
      keyPath: keyPathFor(entry.name),
      value: { command: entry.command, args: [...entry.args], env },
    },
    ...droppedRefNote(spec, dropped),
    ENV_FILE_NOTE,
  ];
}

// ---------------------------------------------------------------------------
// User scope — ~/.cursor/mcp.json
// ---------------------------------------------------------------------------

const USER_SPEC: AdapterSpec = {
  id: 'cursor-user',
  client: 'cursor',
  scope: 'user',
  label: 'Cursor (user)',
  format: 'json',
  confidence: 'verified',
  aliases: ALIASES,
  markerPaths,
};

function userPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.homeDir, '.cursor', 'mcp.json');
}

export const cursorUserAdapter: McpClientAdapter = {
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
// Project scope — <projectRoot>/.cursor/mcp.json
// ---------------------------------------------------------------------------

const PROJECT_SPEC: AdapterSpec = {
  id: 'cursor-project',
  client: 'cursor',
  scope: 'project',
  label: 'Cursor (project)',
  format: 'json',
  confidence: 'verified',
  aliases: ALIASES,
  markerPaths,
};

function projectPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.projectRoot, '.cursor', 'mcp.json');
}

export const cursorProjectAdapter: McpClientAdapter = {
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
