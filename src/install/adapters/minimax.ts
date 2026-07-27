/**
 * MiniMax CLI — `~/.minimax/config.yaml`. TIER B: print-only.
 *
 * THE MCP KEY IS UNKNOWN AND IS NOT GUESSED HERE.
 *
 * config.yaml carries an unmistakable OpenCode / models.dev fingerprint
 * (`provider.<id>.npm`, `options.baseURL`, `models.<id>.limit.context`), which
 * makes OpenCode's `mcp:` block the obvious inference. But the fork has renamed
 * its top-level keys — `defaultModel` not `model`, `permissionMode` not
 * `permission`, `logLevel` not `log_level` — so the fingerprint proves the
 * lineage and nothing about the spelling of the MCP key. Writing the wrong
 * top-level key into a file that also holds the user's model configuration is
 * exactly the failure the Codex `url` rule exists to prevent.
 *
 * `confidence: 'unverified'` makes apply() refuse to write. planWrite() returns
 * notes and no write operations at all, so even a caller that ignored the
 * confidence flag would have nothing to execute.
 */

import { stringify as stringifyYaml } from 'yaml';

import type { InstallCtx, McpClientAdapter, Operation, ServerEntry } from '../../types.js';
import {
  applyInterpolation,
  baseValidate,
  detectConfig,
  MANAGED_SERVER_NAME,
  pathFor,
  readEntryAt,
  supportsTarget,
  type AdapterSpec,
} from './shared.js';

const SPEC: AdapterSpec = {
  id: 'minimax-user',
  client: 'minimax',
  scope: 'user',
  label: 'MiniMax CLI',
  format: 'yaml',
  confidence: 'unverified',
  aliases: ['minimax', 'minimax-cli'],
  markerPaths: (ctx) => [pathFor(ctx).join(ctx.homeDir, '.minimax')],
};

function configPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.homeDir, '.minimax', 'config.yaml');
}

/** Candidate A location is config.yaml itself; candidate B is a sibling file. */
function altJsonPath(ctx: InstallCtx): string {
  return pathFor(ctx).join(ctx.homeDir, '.minimax', 'mcp.json');
}

const CANDIDATE_A_KEY_PATH = ['mcp', MANAGED_SERVER_NAME];
const CANDIDATE_B_KEY_PATH = ['mcpServers', MANAGED_SERVER_NAME];

const VERIFICATION_PROCEDURE = [
  'How to settle which shape is correct:',
  '',
  '1. Run `minimax --help` and look for an `mcp` subcommand. If it exists, that is the definitive answer:',
  '   add a throwaway server with it (any harmless stdio server will do), then diff ~/.minimax before and',
  '   after. Whatever key appears is the real one. Remove the throwaway afterwards.',
  '2. If there is no `mcp` subcommand, grep the installed CLI bundle for the literals `mcpServers`, `"mcp"`',
  '   and `environment` near a config-schema literal. config.yaml is an OpenCode / models.dev derivative',
  '   (provider.<id>.npm, options.baseURL, models.<id>.limit.context) but renames its top-level keys',
  '   (defaultModel, permissionMode, logLevel), so the MCP key cannot be inferred from the fingerprint.',
  '3. Report the finding upstream so this adapter can be promoted to confidence: "verified" and gain a writer.',
].join('\n');

export const minimaxUserAdapter: McpClientAdapter = {
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
    const { env } = applyInterpolation(entry.env, 'none');

    const candidateA = stringifyYaml({
      mcp: {
        [entry.name]: {
          type: 'local',
          command: [entry.command, ...entry.args],
          enabled: true,
          environment: env,
        },
      },
    });

    const candidateB = JSON.stringify(
      { mcpServers: { [entry.name]: { command: entry.command, args: [...entry.args], env } } },
      null,
      2,
    );

    return [
      {
        kind: 'note',
        level: 'warn',
        message:
          'MiniMax CLI is UNVERIFIED: the key its config uses for MCP servers is not known, so coolify-mcp ' +
          'will not write to it. Both plausible shapes are printed below — apply one by hand only after ' +
          'confirming which is correct. Guessing risks corrupting the model configuration in the same file.',
      },
      {
        kind: 'note',
        level: 'info',
        message: `Candidate A (UNVERIFIED) — OpenCode-derived block, merge into ${configPath(ctx)}:\n\n${candidateA}`,
      },
      {
        kind: 'note',
        level: 'info',
        message: `Candidate B (UNVERIFIED) — Claude-compatible file at ${altJsonPath(ctx)}:\n\n${candidateB}\n`,
      },
      { kind: 'note', level: 'info', message: VERIFICATION_PROCEDURE },
    ];
  },
  planRemove: (ctx) => [
    {
      kind: 'note',
      level: 'warn',
      message:
        `coolify-mcp never writes to ${configPath(ctx)}, so there is nothing to remove automatically. ` +
        'If you applied one of the printed snippets by hand, delete that block by hand as well.',
    },
  ],
  /**
   * Probes both candidate locations. This is read-only and is the cheapest half
   * of the verification procedure: if either probe ever returns a value on a
   * real install, the key is settled.
   */
  readEntry: async (ctx: InstallCtx): Promise<unknown> => {
    const inYaml = await readEntryAt(configPath(ctx), 'yaml', CANDIDATE_A_KEY_PATH);
    if (inYaml !== null) {
      return { source: configPath(ctx), keyPath: CANDIDATE_A_KEY_PATH, value: inYaml };
    }

    const inJson = await readEntryAt(altJsonPath(ctx), 'json', CANDIDATE_B_KEY_PATH);
    if (inJson !== null) {
      return { source: altJsonPath(ctx), keyPath: CANDIDATE_B_KEY_PATH, value: inJson };
    }

    return null;
  },
  validate: (ctx) => baseValidate(SPEC, ctx, configPath(ctx), CANDIDATE_A_KEY_PATH),
};
