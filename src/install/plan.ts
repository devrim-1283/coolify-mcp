/**
 * Planning: turn "install into these clients" into inert data.
 *
 * The plan is built entirely from `adapter.planWrite` / `adapter.planRemove`,
 * which are pure. Nothing here decides how a file is written — it decides only
 * WHAT would be written, as a list of `Operation` values that apply() then
 * executes. `--dry-run` and a real install therefore run the same planner over
 * the same inputs and differ in exactly one place: whether apply() calls
 * `writeFile`.
 *
 * The one thing this module does touch the disk for is selection: with no
 * `--client` we have to look at the machine to decide which clients are there.
 * That is detection, not planning, and it is skippable.
 */

import type {
  Detection,
  InstallCtx,
  McpClientAdapter,
  Operation,
  ServerEntry,
  ValidationIssue,
} from '../types.js';
import { DEFAULT_SERVER_NAME } from './helpers.js';
import { splitDottedKey } from './merge/toml.js';
import { ADAPTERS, findAdapters, knownTargets } from './registry.js';

export type PlanAction = 'install' | 'uninstall';

export interface TargetPlan {
  adapter: McpClientAdapter;
  /** The config file this target writes to. */
  path: string;
  /** Key our entry occupies, e.g. `['mcpServers', 'coolify']`. */
  managedKeyPath: string[];
  serverName: string;
  /** Undefined for uninstall. */
  entry?: ServerEntry;
  operations: Operation[];
  issues: ValidationIssue[];
  detection: Detection;
  /**
   * apply() will not write this target. Either the adapter is unverified, or
   * validation produced an error.
   */
  blocked: boolean;
}

export interface Plan {
  action: PlanAction;
  ctx: InstallCtx;
  targets: TargetPlan[];
  /** `--client` values that matched no adapter. */
  unknownTargets: string[];
  issues: ValidationIssue[];
}

export interface PlanOptions {
  ctx: InstallCtx;
  /** `--client` selectors. Empty or absent means "whatever is on this machine". */
  clients?: readonly string[];
  scope?: 'user' | 'project';
}

/**
 * The entry every adapter receives.
 *
 * POINTER CONFIG ONLY. `command`, `args`, and at most a connection NAME — never
 * a base URL, never a token, never anything resolved from a secret store. The
 * worst outcome of a bug in the installer is then a broken MCP entry, not a
 * credential written into a file that gets committed, synced or screen-shared.
 * Credentials reach the server through the environment, which is why every
 * client config format in the matrix has an `env` block.
 */
export function buildServerEntry(ctx: InstallCtx): ServerEntry {
  const env: Record<string, string> = {};
  if (ctx.connection !== undefined && ctx.connection.trim() !== '') {
    env.COOLIFY_CONNECTION = ctx.connection.trim();
  }

  return {
    name: DEFAULT_SERVER_NAME,
    command: 'npx',
    // `-y` so a first run does not stall on npx's install prompt with no
    // terminal attached — the client would just see a server that never speaks.
    args: ['-y', ctx.packageSpec],
    env,
  };
}

export async function planInstall(options: PlanOptions): Promise<Plan> {
  const entry = buildServerEntry(options.ctx);
  return buildPlan('install', options, (adapter, ctx) => adapter.planWrite(entry, ctx), entry);
}

export async function planUninstall(options: PlanOptions): Promise<Plan> {
  return buildPlan('uninstall', options, (adapter, ctx) => adapter.planRemove(ctx));
}

// ---------------------------------------------------------------------------

async function buildPlan(
  action: PlanAction,
  options: PlanOptions,
  planOperations: (adapter: McpClientAdapter, ctx: InstallCtx) => Operation[],
  entry?: ServerEntry,
): Promise<Plan> {
  const { ctx } = options;
  const selection = selectAdapters(options.clients, options.scope);
  const issues: ValidationIssue[] = [];

  for (const target of selection.unknown) {
    issues.push({
      severity: 'error',
      code: 'unknown-client',
      message: `no adapter for "${target}".`,
      fix: `Known clients: ${knownTargets().join(', ')}.`,
    });
  }

  const targets: TargetPlan[] = [];
  for (const adapter of selection.adapters) {
    const detection = await adapter.detect(ctx);

    // Auto-selection only picks clients that are actually here and whose layout
    // we have verified. An explicit --client overrides both: the user may be
    // installing a client we cannot see, and printing an unverified entry for
    // them to paste is still useful.
    if (selection.automatic && !(detection.installed && adapter.confidence === 'verified')) continue;
    if (action === 'uninstall' && !detection.configExists) continue;

    const adapterIssues = await adapter.validate(ctx);
    const operations = planOperations(adapter, ctx);
    const managedKeyPath = managedKeyPathOf(operations);

    targets.push({
      adapter,
      path: detection.path,
      managedKeyPath,
      serverName: managedKeyPath[managedKeyPath.length - 1] ?? DEFAULT_SERVER_NAME,
      entry,
      operations,
      issues: adapterIssues,
      detection,
      blocked:
        adapter.confidence === 'unverified' ||
        adapterIssues.some((issue) => issue.severity === 'error'),
    });
  }

  if (targets.length === 0 && selection.unknown.length === 0) {
    issues.push({
      severity: 'warn',
      code: 'no-targets',
      message:
        action === 'install'
          ? 'no supported MCP client was detected on this machine.'
          : 'no client config contains a coolify-mcp entry.',
      fix:
        action === 'install'
          ? `Name one explicitly with --client (one of: ${knownTargets().join(', ')}), or use --print to get an entry you can paste yourself.`
          : 'Nothing to do.',
    });
  }

  return { action, ctx, targets, unknownTargets: selection.unknown, issues };
}

interface Selection {
  adapters: McpClientAdapter[];
  unknown: string[];
  /** True when nothing was named and we picked by detection. */
  automatic: boolean;
}

function selectAdapters(
  clients: readonly string[] | undefined,
  scope: 'user' | 'project' | undefined,
): Selection {
  const inScope = (adapter: McpClientAdapter): boolean => scope === undefined || adapter.scope === scope;

  const named = (clients ?? []).map((client) => client.trim()).filter((client) => client !== '');
  if (named.length === 0) {
    return { adapters: ADAPTERS.filter(inScope), unknown: [], automatic: true };
  }

  const adapters: McpClientAdapter[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const target of named) {
    const matches = findAdapters(target).filter(inScope);
    if (matches.length === 0) {
      unknown.push(target);
      continue;
    }
    for (const adapter of matches) {
      if (seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      adapters.push(adapter);
    }
  }

  return { adapters, unknown, automatic: false };
}

/**
 * Recovers the managed key path from the planned operations.
 *
 * Reading it back out of the plan rather than asking the adapter keeps a single
 * source of truth: whatever the adapter actually writes is what install state
 * records and what uninstall later removes. An adapter cannot drift from its
 * own bookkeeping.
 */
export function managedKeyPathOf(operations: readonly Operation[]): string[] {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'json-merge':
      case 'jsonc-merge':
      case 'yaml-merge':
      case 'json-remove':
      case 'jsonc-remove':
      case 'yaml-remove':
        return [...operation.keyPath];
      case 'toml-append':
      case 'toml-replace':
      case 'toml-remove':
        return splitDottedKey(operation.section);
      default:
        continue;
    }
  }
  return [DEFAULT_SERVER_NAME];
}
