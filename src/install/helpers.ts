/**
 * The adapter factory.
 *
 * Adding a client should cost one file and one line in the registry. Everything
 * that is genuinely the same across clients — resolving a config path, deciding
 * whether the client looks installed, reading our entry back, emitting the
 * right `Operation` for the file's format — lives here exactly once, so an
 * adapter file is a description of a client rather than an implementation of a
 * writer.
 *
 * The clients differ in ways no single writer can absorb (`mcpServers` vs
 * `context_servers` vs `mcp`, `command` as a string vs an argv array, `env` vs
 * `environment`, four file formats), so every one of those differences is a
 * named field here. `planWrite` / `planRemove` / `validate` stay overridable for
 * the clients that are awkward in some way we did not anticipate — an escape
 * hatch is cheaper than a factory that tries to model every future client.
 *
 * `planWrite` and `planRemove` are PURE: they return inert `Operation` data and
 * touch nothing. That is what makes `--dry-run` a real preview instead of a
 * second code path that can drift from the one that writes.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type {
  Detection,
  InstallCtx,
  McpClientAdapter,
  Operation,
  ServerEntry,
  ValidationIssue,
} from '../types.js';
import { getAtPath, isPlainObject } from './merge/json.js';
import { parseTomlDocument, readTomlSection } from './merge/toml.js';

/** The key our entry takes in every client config unless an adapter says otherwise. */
export const DEFAULT_SERVER_NAME = 'coolify';

export type PathBase =
  /** `~` */
  | 'home'
  /** The repository the user ran the command in. */
  | 'project'
  /** `%APPDATA%` / `~/Library/Application Support` / `$XDG_CONFIG_HOME`. */
  | 'appData'
  /** `$XDG_CONFIG_HOME` (or `~/.config`) on every platform — some clients do this. */
  | 'configHome';

export interface PathSpec {
  base: PathBase;
  segments: readonly string[];
}

export interface McpClientAdapterConfig {
  /** Unique, e.g. "cursor-user". */
  id: string;
  /** The client family, e.g. "cursor". Shared by its user- and project-scope adapters. */
  client: string;
  scope: 'user' | 'project';
  label: string;
  format: 'json' | 'jsonc' | 'toml' | 'yaml';
  /**
   * `'unverified'` is a hard gate, not a hint: apply() refuses to write and
   * downgrades to printing. Promotion needs upstream documentation or a
   * reproducible probe — never a guess about a config key.
   */
  confidence: 'verified' | 'unverified';
  transports: ReadonlyArray<'stdio' | 'http'>;

  /** Where the config file lives. */
  configPath: PathSpec;
  /** Platform-specific overrides of {@link configPath}. */
  configPathByPlatform?: Partial<Record<NodeJS.Platform, PathSpec>>;

  /** Container the entry goes in, e.g. `['mcpServers']` or `['context_servers']`. */
  managedKeyPath: readonly string[];
  /** Key inside that container. Defaults to {@link DEFAULT_SERVER_NAME}. */
  serverName?: string;

  /** Extra strings `--client` accepts for this adapter. */
  aliases?: readonly string[];

  /**
   * Files or directories whose existence means "this client is installed".
   * Defaults to the config file's own directory when that is a dedicated one
   * (`~/.codex`, `~/.cursor`) — the home directory and the project root prove
   * nothing and are excluded.
   */
  installMarkers?: readonly PathSpec[];

  /** Translates a ServerEntry into this client's dialect. */
  buildEntry?: (entry: ServerEntry, ctx: InstallCtx) => unknown;

  /**
   * Wrap the command in `cmd /c` on Windows. Needed by clients that spawn
   * without a shell, where `npx` (a `.cmd` shim) is not directly executable.
   */
  windowsCmdWrapper?: boolean;

  nativeCli?: { bin: string; buildArgv(entry: ServerEntry, ctx: InstallCtx): string[] };

  // -- escape hatches. Each receives the default result so it can extend
  //    rather than reimplement.
  supports?: (target: string) => boolean;
  resolvePath?: (ctx: InstallCtx) => string;
  planWrite?: (entry: ServerEntry, ctx: InstallCtx, base: Operation[]) => Operation[];
  planRemove?: (ctx: InstallCtx, base: Operation[]) => Operation[];
  validate?: (ctx: InstallCtx, base: ValidationIssue[]) => Promise<ValidationIssue[]>;
}

/**
 * Builds a full {@link McpClientAdapter} from a declarative description.
 *
 * The common case is roughly ten fields and no functions at all.
 */
export function createMcpClientAdapter(config: McpClientAdapterConfig): McpClientAdapter {
  const serverName = config.serverName ?? DEFAULT_SERVER_NAME;
  const keyPath = [...config.managedKeyPath, serverName];
  const section = keyPath.map(tomlKey).join('.');
  const targets = supportedTargets(config);

  const resolvePath = (ctx: InstallCtx): string =>
    config.resolvePath?.(ctx) ?? resolveConfigPath(pathSpecFor(config, ctx.platform), ctx);

  const buildValue = (entry: ServerEntry, ctx: InstallCtx): unknown => {
    const effective =
      config.windowsCmdWrapper === true && ctx.platform === 'win32'
        ? wrapForWindowsCmd(entry)
        : entry;
    return config.buildEntry?.(effective, ctx) ?? defaultEntryValue(effective);
  };

  const adapter: McpClientAdapter = {
    id: config.id,
    client: config.client,
    scope: config.scope,
    label: config.label,
    format: config.format,
    confidence: config.confidence,
    transports: [...config.transports],

    supports: (target: string) => config.supports?.(target) ?? targets.has(normalizeTarget(target)),

    resolvePath,

    planWrite(entry, ctx) {
      const filePath = resolvePath(ctx);
      const base: Operation[] = [];

      if (!config.transports.includes(ctx.transport)) {
        // Not fatal: the caller still gets a working stdio entry. Codex is the
        // reason this is a warning rather than a silent downgrade — writing an
        // http `url` key there has historically broken the whole file.
        base.push({
          kind: 'note',
          level: 'warn',
          message: `${config.label} does not support the ${ctx.transport} transport; writing a stdio entry instead.`,
        });
      }

      base.push({ kind: 'mkdir', path: path.dirname(filePath) });
      const value = buildValue(entry, ctx);

      switch (config.format) {
        case 'json':
          base.push({ kind: 'json-merge', path: filePath, keyPath, value });
          break;
        case 'jsonc':
          base.push({ kind: 'jsonc-merge', path: filePath, keyPath, value });
          break;
        case 'yaml':
          base.push({ kind: 'yaml-merge', path: filePath, keyPath, value });
          break;
        case 'toml':
          base.push({
            kind: 'toml-append',
            path: filePath,
            section,
            text: renderTomlSection(section, value),
          });
          break;
      }

      return config.planWrite?.(entry, ctx, base) ?? base;
    },

    planRemove(ctx) {
      const filePath = resolvePath(ctx);
      const base: Operation[] = [removeOperation(config.format, filePath, keyPath, section)];
      return config.planRemove?.(ctx, base) ?? base;
    },

    async detect(ctx): Promise<Detection> {
      const filePath = resolvePath(ctx);
      const read = await readConfigFile(filePath, config.format);
      const markers = (config.installMarkers ?? []).map((spec) => resolveConfigPath(spec, ctx));
      const fallback = defaultInstallMarkers(ctx, filePath);

      const installed = !read.missing || (await anyExists(markers.length > 0 ? markers : fallback));

      return {
        installed,
        configExists: !read.missing,
        parseable: read.issue === undefined,
        path: filePath,
      };
    },

    async readEntry(ctx): Promise<unknown | null> {
      const read = await readConfigFile(resolvePath(ctx), config.format);
      if (read.value === undefined) return null;
      const value =
        config.format === 'toml'
          ? readTomlSection(read.value as Record<string, unknown>, section)
          : getAtPath(read.value, keyPath);
      return value ?? null;
    },

    async validate(ctx): Promise<ValidationIssue[]> {
      const base: ValidationIssue[] = [];

      if (config.confidence === 'unverified') {
        base.push({
          severity: 'warn',
          code: 'adapter-unverified',
          message: `the ${config.label} config layout has not been verified against upstream documentation.`,
          fix: 'coolify-mcp will print the entry instead of writing it. Paste it in yourself, and please open an issue with the correct key so the adapter can be promoted.',
        });
      }

      const read = await readConfigFile(resolvePath(ctx), config.format);
      if (read.issue !== undefined) base.push(read.issue);

      return (await config.validate?.(ctx, base)) ?? base;
    },
  };

  if (config.nativeCli !== undefined) adapter.nativeCli = config.nativeCli;
  return adapter;
}

// ---------------------------------------------------------------------------
// Entry shaping
// ---------------------------------------------------------------------------

/** The `mcpServers` dialect: `{ command, args, env }`, env omitted when empty. */
export function defaultEntryValue(entry: ServerEntry): Record<string, unknown> {
  const value: Record<string, unknown> = { command: entry.command, args: [...entry.args] };
  if (Object.keys(entry.env).length > 0) value.env = { ...entry.env };
  return value;
}

/**
 * `npx` on Windows is `npx.cmd`, which `CreateProcess` cannot launch directly.
 * Clients that spawn without a shell therefore need the `cmd /c` wrapper; the
 * ones that use a shell must NOT have it, which is why this is opt-in per
 * adapter rather than applied globally.
 */
export function wrapForWindowsCmd(entry: ServerEntry): ServerEntry {
  if (entry.command === 'cmd') return entry;
  return { ...entry, command: 'cmd', args: ['/c', entry.command, ...entry.args] };
}

/**
 * Renders one TOML table (plus its sub-tables) as text.
 *
 * Only the table itself is emitted — never its parents. Re-declaring
 * `[mcp_servers]` when the file already has `[mcp_servers.other]` is a
 * duplicate-table error that would take the user's whole config down.
 */
export function renderTomlSection(section: string, value: unknown): string {
  if (!isPlainObject(value)) return `[${section}]\n`;

  const scalars: Record<string, unknown> = {};
  const tables: Array<[string, Record<string, unknown>]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (isPlainObject(item)) tables.push([key, item]);
    else scalars[key] = item;
  }

  const blocks = [`[${section}]\n${stringifyToml(scalars)}`];
  for (const [key, table] of tables) {
    blocks.push(renderTomlSection(`${section}.${tomlKey(key)}`, table));
  }
  return blocks.join('\n');
}

/** Bare keys where TOML allows them, quoted otherwise. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function removeOperation(
  format: 'json' | 'jsonc' | 'toml' | 'yaml',
  filePath: string,
  keyPath: string[],
  section: string,
): Operation {
  switch (format) {
    case 'json':
      return { kind: 'json-remove', path: filePath, keyPath };
    case 'jsonc':
      return { kind: 'jsonc-remove', path: filePath, keyPath };
    case 'yaml':
      return { kind: 'yaml-remove', path: filePath, keyPath };
    case 'toml':
      return { kind: 'toml-remove', path: filePath, section };
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function resolveConfigPath(
  spec: PathSpec,
  ctx: InstallCtx,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveBase(spec.base, ctx, env), ...spec.segments);
}

function resolveBase(base: PathBase, ctx: InstallCtx, env: NodeJS.ProcessEnv): string {
  switch (base) {
    case 'home':
      return ctx.homeDir;
    case 'project':
      return ctx.projectRoot;
    case 'configHome':
      return xdgConfigHome(ctx, env);
    case 'appData':
      if (ctx.platform === 'win32') {
        const appData = env.APPDATA?.trim();
        return appData !== undefined && appData !== ''
          ? appData
          : path.join(ctx.homeDir, 'AppData', 'Roaming');
      }
      if (ctx.platform === 'darwin')
        return path.join(ctx.homeDir, 'Library', 'Application Support');
      return xdgConfigHome(ctx, env);
  }
}

function xdgConfigHome(ctx: InstallCtx, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg !== undefined && xdg !== '' ? xdg : path.join(ctx.homeDir, '.config');
}

function pathSpecFor(config: McpClientAdapterConfig, platform: NodeJS.Platform): PathSpec {
  return config.configPathByPlatform?.[platform] ?? config.configPath;
}

/**
 * A dedicated config directory is evidence the client exists. The home
 * directory and the project root are not — every machine has both.
 */
function defaultInstallMarkers(ctx: InstallCtx, filePath: string): string[] {
  const dir = path.dirname(filePath);
  return dir === ctx.homeDir || dir === ctx.projectRoot ? [] : [dir];
}

async function anyExists(paths: readonly string[]): Promise<boolean> {
  for (const candidate of paths) {
    try {
      await fs.stat(candidate);
      return true;
    } catch {
      // Missing is the expected answer for most clients on most machines.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ConfigFileRead {
  /** Parsed contents, or undefined when the file is missing or unparseable. */
  value?: unknown;
  missing?: boolean;
  issue?: ValidationIssue;
}

/** Reads and parses a client config, mapping every failure to a ValidationIssue. */
export async function readConfigFile(
  filePath: string,
  format: 'json' | 'jsonc' | 'toml' | 'yaml',
): Promise<ConfigFileRead> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { missing: true };
  }

  if (raw.trim() === '') return { value: {} };

  switch (format) {
    case 'toml': {
      const doc = parseTomlDocument(raw);
      return doc.issue !== undefined ? { issue: doc.issue } : { value: doc.table };
    }
    case 'yaml':
      try {
        return { value: parseYaml(raw) as unknown };
      } catch (error: unknown) {
        return { issue: parseIssue('yaml-unparseable', filePath, error) };
      }
    case 'json':
    case 'jsonc': {
      // jsonc-parser reads plain JSON too, and reports the position of the
      // first error instead of throwing a message with no location in it.
      const errors: ParseError[] = [];
      const value = parseJsonc(raw, errors, {
        allowTrailingComma: true,
        allowEmptyContent: true,
        disallowComments: format === 'json',
      }) as unknown;
      const first = errors[0];
      if (first !== undefined) {
        return {
          issue: {
            severity: 'error',
            code: `${format}-unparseable`,
            message: `${filePath} is not valid ${format.toUpperCase()} (first problem at offset ${first.offset}).`,
            fix: 'Fix the syntax error before installing. coolify-mcp will not write to a file it cannot parse.',
          },
        };
      }
      return { value };
    }
  }
}

function parseIssue(code: string, filePath: string, error: unknown): ValidationIssue {
  const detail = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
  return {
    severity: 'error',
    code,
    message: `${filePath} does not parse: ${detail}`,
    fix: 'Fix the syntax error before installing. coolify-mcp will not write to a file it cannot parse.',
  };
}

// ---------------------------------------------------------------------------
// Target matching
// ---------------------------------------------------------------------------

function supportedTargets(config: McpClientAdapterConfig): Set<string> {
  return new Set(
    [
      config.id,
      config.client,
      `${config.client}-${config.scope}`,
      `${config.client}:${config.scope}`,
      ...(config.aliases ?? []),
    ].map(normalizeTarget),
  );
}

function normalizeTarget(target: string): string {
  return target.trim().toLowerCase();
}
