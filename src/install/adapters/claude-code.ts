/**
 * Claude Code — `~/.claude.json` (user scope) and `<projectRoot>/.mcp.json`
 * (project scope). Same file shape, different location and CLI scope flag.
 *
 * Reference syntax: `${VAR}` and `${VAR:-default}`, expanded in `command`,
 * `args`, `env`, `url` and `headers`. This is the one client where the canonical
 * entry needs no rewriting at all.
 */

import type { InstallCtx, McpClientAdapter, Operation, ServerEntry } from '../../types.js';
import {
  applyInterpolation,
  baseValidate,
  detectConfig,
  MANAGED_SERVER_NAME,
  mkdirOps,
  pathFor,
  readEntryAt,
  supportsTarget,
  type AdapterSpec,
} from './shared.js';

const ALIASES = ['claude-code', 'claudecode'] as const;

function keyPathFor(name: string): string[] {
  return ['mcpServers', name];
}

/**
 * `type: "stdio"` is optional — stdio is the default when `command` is present.
 * It is emitted anyway so the file writer produces byte-identical output to
 * `claude mcp add-json`, which keeps the native-CLI and fallback paths
 * idempotent with each other.
 */
function claudeCodeEntry(entry: ServerEntry): Record<string, unknown> {
  const { env } = applyInterpolation(entry.env, 'dollar-brace');
  return { type: 'stdio', command: entry.command, args: [...entry.args], env };
}

function planWriteFor(path: string, entry: ServerEntry, ctx: InstallCtx): Operation[] {
  return [
    ...mkdirOps(path, ctx),
    { kind: 'json-merge', path, keyPath: keyPathFor(entry.name), value: claudeCodeEntry(entry) },
  ];
}

// ---------------------------------------------------------------------------
// User scope — ~/.claude.json
// ---------------------------------------------------------------------------

const USER_SPEC: AdapterSpec = {
  id: 'claude-code-user',
  client: 'claude-code',
  scope: 'user',
  label: 'Claude Code (user)',
  format: 'json',
  confidence: 'verified',
  aliases: ALIASES,
  markerPaths: (ctx) => [
    pathFor(ctx).join(ctx.homeDir, '.claude'),
    pathFor(ctx).join(ctx.homeDir, '.claude.json'),
  ],
};

function userPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.homeDir, '.claude.json');
}

export const claudeCodeUserAdapter: McpClientAdapter = {
  id: USER_SPEC.id,
  client: USER_SPEC.client,
  scope: USER_SPEC.scope,
  label: USER_SPEC.label,
  format: USER_SPEC.format,
  confidence: USER_SPEC.confidence,
  // Only stdio is declared because only stdio is written. Advertising 'http'
  // would let `--transport http` be accepted and then silently produce a stdio
  // entry, which is worse than refusing the flag.
  transports: ['stdio'],
  supports: (target) => supportsTarget(USER_SPEC, target),
  resolvePath: userPath,
  detect: (ctx) => detectConfig(USER_SPEC, userPath(ctx), ctx),
  nativeCli: {
    bin: 'claude',
    buildArgv: (entry) => [
      'mcp',
      'add-json',
      entry.name,
      JSON.stringify(claudeCodeEntry(entry)),
      '--scope',
      'user',
    ],
  },
  planWrite: (entry, ctx) => planWriteFor(userPath(ctx), entry, ctx),
  planRemove: (ctx) => [
    { kind: 'json-remove', path: userPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(userPath(ctx), 'json', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) => baseValidate(USER_SPEC, ctx, userPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};

// ---------------------------------------------------------------------------
// Project scope — <projectRoot>/.mcp.json
// ---------------------------------------------------------------------------

const PROJECT_SPEC: AdapterSpec = {
  id: 'claude-code-project',
  client: 'claude-code',
  scope: 'project',
  label: 'Claude Code (project)',
  format: 'json',
  confidence: 'verified',
  aliases: ALIASES,
  // A project checkout says nothing about whether the client is installed, so
  // installation is judged from the user-scope footprint either way.
  markerPaths: (ctx) => [
    pathFor(ctx).join(ctx.homeDir, '.claude'),
    pathFor(ctx).join(ctx.homeDir, '.claude.json'),
  ],
};

function projectPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.projectRoot, '.mcp.json');
}

export const claudeCodeProjectAdapter: McpClientAdapter = {
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
  nativeCli: {
    bin: 'claude',
    // `--scope project` writes .mcp.json relative to the working directory, so
    // the exec operation must run with cwd = ctx.projectRoot.
    buildArgv: (entry) => [
      'mcp',
      'add-json',
      entry.name,
      JSON.stringify(claudeCodeEntry(entry)),
      '--scope',
      'project',
    ],
  },
  planWrite: (entry, ctx) => planWriteFor(projectPath(ctx), entry, ctx),
  planRemove: (ctx) => [
    { kind: 'json-remove', path: projectPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(projectPath(ctx), 'json', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) =>
    baseValidate(PROJECT_SPEC, ctx, projectPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};
