/**
 * Claude Desktop — `claude_desktop_config.json`, key path `mcpServers.coolify`.
 *
 * Two behaviours make this the odd one out among the mcpServers-shaped clients:
 *
 * 1. It spawns servers WITHOUT a shell. On Windows `npx` is `npx.cmd`, a batch
 *    script, and CreateProcess cannot execute one directly — the server dies
 *    with ENOENT before it ever speaks MCP. The fix is to invoke the shell
 *    explicitly: `cmd /c npx -y <spec>`. This is the only adapter that rewrites
 *    the command, and only on win32.
 * 2. It does not inherit the shell environment. Variables exported in a
 *    terminal (or in a shell rc file) are simply absent from the child process,
 *    so "just export COOLIFY_API_TOKEN" — the advice that works for every CLI
 *    client — does not work here. Nor is `${VAR}` expansion in this file
 *    confirmed. That combination is why the docs steer Desktop users to a
 *    coolify-mcp registry file with tokenCommand / tokenKeychain plus a
 *    COOLIFY_CONNECTION selector: the token is fetched by the server at startup
 *    from a secret manager, so nothing has to be inherited and nothing has to be
 *    written in plaintext.
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

/**
 * On by default, and only for this adapter. Every other client either spawns
 * through a shell or resolves `.cmd` shims itself; wrapping there would add a
 * process and break `command` comparisons during uninstall.
 */
const WINDOWS_SHELL_WRAPPER = true;

const SPEC: AdapterSpec = {
  id: 'claude-desktop',
  client: 'claude-desktop',
  scope: 'user',
  label: 'Claude Desktop',
  format: 'json',
  confidence: 'verified',
  aliases: ['claude-desktop', 'claudedesktop'],
  markerPaths: (ctx) => [configDir(ctx)],
  // TODO(verify): the Linux location is unconfirmed — Claude Desktop has no
  // official Linux build, so ~/.config/Claude follows the XDG convention that
  // community packages use. macOS and Windows are documented, so they say
  // nothing.
  pathUnconfirmed: (ctx) =>
    ctx.platform === 'win32' || ctx.platform === 'darwin'
      ? undefined
      : 'There is no official Linux build, so ~/.config/Claude is the XDG convention community packages use rather than a documented location.',
};

function configDir(ctx: InstallCtx): string {
  switch (ctx.platform) {
    case 'win32':
      // %APPDATA% is derived from homeDir rather than read from process.env so
      // that resolvePath stays deterministic under the golden fixtures.
      return pathFor(ctx).join(ctx.homeDir, 'AppData', 'Roaming', 'Claude');
    case 'darwin':
      return pathFor(ctx).join(ctx.homeDir, 'Library', 'Application Support', 'Claude');
    default:
      return pathFor(ctx).join(ctx.homeDir, '.config', 'Claude');
  }
}

function configPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(configDir(ctx), 'claude_desktop_config.json');
}

function keyPathFor(name: string): string[] {
  return ['mcpServers', name];
}

function spawnShape(entry: ServerEntry, ctx: InstallCtx): { command: string; args: string[] } {
  if (WINDOWS_SHELL_WRAPPER && ctx.platform === 'win32') {
    return { command: 'cmd', args: ['/c', entry.command, ...entry.args] };
  }
  return { command: entry.command, args: [...entry.args] };
}

/**
 * Names the variables left out and points at the mechanism that actually works
 * for this client. Deliberately different from the generic dropped-reference
 * note, which tells the user to export the variable — advice that is wrong here.
 */
function desktopEnvNote(dropped: readonly string[]): Operation[] {
  if (dropped.length === 0) return [];
  return [
    {
      kind: 'note',
      level: 'warn',
      message:
        `${dropped.join(', ')} was left out of the Claude Desktop entry rather than written as a literal ` +
        'value. Claude Desktop does not inherit the shell environment, so exporting the variable will not ' +
        'reach the server either. Define the connection in a coolify-mcp registry file using tokenCommand ' +
        'or tokenKeychain, then set COOLIFY_CONNECTION in this entry to select it.',
    },
  ];
}

export const claudeDesktopAdapter: McpClientAdapter = {
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
  planWrite: (entry: ServerEntry, ctx: InstallCtx): Operation[] => {
    const { env, dropped } = applyInterpolation(entry.env, 'none');
    const { command, args } = spawnShape(entry, ctx);
    return [
      ...mkdirOps(configPath(ctx), ctx),
      {
        kind: 'json-merge',
        path: configPath(ctx),
        keyPath: keyPathFor(entry.name),
        value: { command, args, env },
      },
      ...desktopEnvNote(dropped),
    ];
  },
  planRemove: (ctx) => [
    { kind: 'json-remove', path: configPath(ctx), keyPath: keyPathFor(MANAGED_SERVER_NAME) },
  ],
  readEntry: (ctx) => readEntryAt(configPath(ctx), 'json', keyPathFor(MANAGED_SERVER_NAME)),
  validate: (ctx) => baseValidate(SPEC, ctx, configPath(ctx), keyPathFor(MANAGED_SERVER_NAME)),
};
