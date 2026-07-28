/**
 * Zed — `settings.json`, top-level key `context_servers`.
 *
 * Three things that are easy to get wrong:
 *
 * - The key is `context_servers`, NOT `agent_servers`. `agent_servers` is a
 *   different feature (external agents) and an entry there is simply ignored.
 * - `command` is a plain string with sibling `args` / `env`. Older Zed took an
 *   object (`command: { path, args, env }`); writing that shape today produces
 *   a server Zed will not start.
 * - The file is JSONC. Zed ships settings.json full of explanatory comments and
 *   users add their own, so this adapter routes through the jsonc merge writer.
 *   A naive JSON.parse/stringify round-trip would silently delete all of them,
 *   which is explicitly forbidden by the adapter contract.
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

const ALIASES = ['zed'] as const;

function keyPathFor(name: string): string[] {
  return ['context_servers', name];
}

/**
 * TODO(verify): confirm the user settings location per OS before 1.0.
 * macOS/Linux `~/.config/zed/settings.json` is documented; the Windows location
 * is derived from %APPDATA% and has not been confirmed on a real install.
 *
 * %APPDATA% is derived from homeDir rather than read from process.env on
 * purpose: InstallCtx deliberately carries no environment, which keeps
 * resolvePath deterministic under the golden fixtures.
 */
function userPath(ctx: InstallCtx): string {
  if (ctx.platform === 'win32') {
    return pathFor(ctx).join(ctx.homeDir, 'AppData', 'Roaming', 'Zed', 'settings.json');
  }
  return pathFor(ctx).join(ctx.homeDir, '.config', 'zed', 'settings.json');
}

function markerPaths(ctx: InstallCtx): string[] {
  const p = pathFor(ctx);
  if (ctx.platform === 'win32') {
    return [
      p.join(ctx.homeDir, 'AppData', 'Roaming', 'Zed'),
      p.join(ctx.homeDir, 'AppData', 'Local', 'Zed'),
    ];
  }
  if (ctx.platform === 'darwin') {
    return [
      p.join(ctx.homeDir, '.config', 'zed'),
      p.join(ctx.homeDir, 'Library', 'Application Support', 'Zed'),
    ];
  }
  return [p.join(ctx.homeDir, '.config', 'zed'), p.join(ctx.homeDir, '.local', 'share', 'zed')];
}

/**
 * Recent Zed documents a `"source": "custom"` discriminator alongside these
 * fields. It is deliberately omitted: it is not part of the shape verified for
 * this adapter, and adding an unrecognized discriminator to a settings file is
 * the same class of guess that motivated the Codex `url` rule.
 * TODO(verify): check whether current Zed requires `source` and add it if so.
 */
function zedEntry(entry: ServerEntry): {
  value: Record<string, unknown>;
  dropped: string[];
} {
  const { env, dropped } = applyInterpolation(entry.env, 'none');
  return {
    value: { command: entry.command, args: [...entry.args], env },
    dropped,
  };
}

function planWriteFor(
  spec: AdapterSpec,
  path: string,
  entry: ServerEntry,
  ctx: InstallCtx,
): Operation[] {
  const { value, dropped } = zedEntry(entry);
  return [
    ...mkdirOps(path, ctx),
    { kind: 'jsonc-merge', path, keyPath: keyPathFor(entry.name), value },
    ...droppedRefNote(spec, dropped),
  ];
}

// ---------------------------------------------------------------------------
// User scope
// ---------------------------------------------------------------------------

const USER_SPEC: AdapterSpec = {
  id: 'zed-user',
  client: 'zed',
  scope: 'user',
  label: 'Zed (user)',
  format: 'jsonc',
  confidence: 'verified',
  aliases: ALIASES,
  markerPaths,
  pathUnconfirmed: (ctx) =>
    ctx.platform === 'win32'
      ? 'The macOS and Linux locations are documented; the Windows path is derived from %APPDATA% and has not been confirmed against a real install.'
      : undefined,
};

export const zedUserAdapter: McpClientAdapter = {
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
    { kind: 'jsonc-remove', path: userPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(userPath(ctx), 'jsonc', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) => baseValidate(USER_SPEC, ctx, userPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};

// ---------------------------------------------------------------------------
// Project scope — <projectRoot>/.zed/settings.json (confirmed)
// ---------------------------------------------------------------------------

const PROJECT_SPEC: AdapterSpec = {
  id: 'zed-project',
  client: 'zed',
  scope: 'project',
  label: 'Zed (project)',
  format: 'jsonc',
  confidence: 'verified',
  aliases: ALIASES,
  markerPaths,
};

function projectPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.projectRoot, '.zed', 'settings.json');
}

export const zedProjectAdapter: McpClientAdapter = {
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
    { kind: 'jsonc-remove', path: projectPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(projectPath(ctx), 'jsonc', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) =>
    baseValidate(PROJECT_SPEC, ctx, projectPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};
