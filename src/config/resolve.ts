/**
 * Connection registry resolution — the single entry point that turns an
 * environment plus (optionally) a registry file into `ConnectionRegistry`.
 *
 * A connection is (baseUrl, token). A Coolify token is bound in the database to
 * the team that was active when it was created and there is no team-switch
 * parameter in the API, so a second team is a second token, which is a second
 * connection. N connections covers N instances x M teams with no extra concept.
 *
 * Three layers, in increasing order of ceremony:
 *
 *   0. COOLIFY_BASE_URL + COOLIFY_API_TOKEN                    (no file at all)
 *   1. COOLIFY_BASE_URL_<NAME> + COOLIFY_API_TOKEN_<NAME>      (no file at all)
 *   2. a registry file
 *
 * File lookup is FIRST HIT WINS WHOLESALE: the first location that has a file
 * is the config, and no other location is consulted or merged in. Cross-scope
 * merging is where configuration systems stop being explainable — "which of
 * these four files set readOnly?" has no good answer, so we never create the
 * question.
 *
 * Env and file are unioned, and on a name collision the env entry replaces the
 * file entry WHOLE. No field-level merge: a half-env, half-file connection is
 * not something a user can hold in their head. The shadowed name is recorded so
 * `doctor` can report it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Connection, ConnectionRegistry } from '../types.js';
import {
  CONNECTION_NAME_RE,
  CONNECTION_NAME_RULE,
  ConfigError,
  DEFAULT_CONNECTION_NAME,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  baseUrlEnvVar,
  baseUrlProblem,
  connectionNameFromEnvSuffix,
  normalizeBaseUrl,
  parseConfigFile,
  readEnvValue,
  tokenEnvVar,
  type ConfigFile,
  type ConnectionConfig,
} from './schema.js';
import { createTokenResolver } from './secrets.js';

const CONFIG_PATH_ENV_VAR = 'COOLIFY_MCP_CONFIG';
const PROJECT_CONFIG_FILENAME = '.coolify-mcp.json';
const CONFIG_DIR_NAME = 'coolify-mcp';
const USER_CONFIG_FILENAME = 'config.json';
const BASE_URL_PREFIX = 'COOLIFY_BASE_URL_';

export interface ResolveOptions {
  /** Injected for tests. Decides the Windows %APPDATA% config location and the keychain backend. */
  platform?: NodeJS.Platform;
}

/**
 * Builds the connection registry. Throws {@link ConfigError} when the
 * configuration is unusable — never when a *token* is merely absent: token
 * resolution is lazy so that one unreachable secret manager cannot stop the
 * server from starting and reporting the problem through a tool call.
 */
export async function resolveRegistry(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homedir: string,
  options: ResolveOptions = {},
): Promise<ConnectionRegistry> {
  const platform = options.platform ?? process.platform;

  const envSpecs = collectEnvConnections(env);
  const located = await locateConfigFile(env, cwd, homedir, platform);
  const file = located === undefined ? undefined : await loadConfigFile(located, homedir);

  const specs = new Map<string, ConnectionSpec>();
  const shadowed: string[] = [];

  if (file !== undefined) {
    for (const [name, config] of Object.entries(file.config.connections)) {
      specs.set(name, fromFile(name, config, env));
    }
  }
  for (const [name, spec] of envSpecs) {
    if (specs.has(name)) shadowed.push(name);
    specs.set(name, spec);
  }

  if (specs.size === 0) throw new ConfigError(notConfiguredMessage(env, cwd, homedir, platform));

  const connections = new Map<string, Connection>();
  for (const [name, spec] of [...specs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    connections.set(name, toConnection(spec, env, platform));
  }

  const registry: ConnectionRegistry = {
    connections,
    source: envSpecs.size > 0 ? (file === undefined ? 'env' : 'env+file') : 'file',
    shadowed: shadowed.sort(),
  };
  if (file !== undefined) registry.configPath = file.path;

  const defaultName = selectDefault(env, connections, file?.config.defaultConnection);
  if (defaultName !== undefined) registry.defaultName = defaultName;

  return registry;
}

// ---------------------------------------------------------------------------
// Normalised connection spec — file and env entries meet here
// ---------------------------------------------------------------------------

interface ConnectionSpec {
  name: string;
  baseUrl: string;
  label?: string;
  tokenEnv?: string;
  tokenCommand?: string[];
  tokenKeychain?: { service: string; account: string };
  readOnly: boolean;
  allowDestructive: boolean;
  timeoutMs: number;
  insecureTLS: boolean;
}

function fromFile(name: string, config: ConnectionConfig, env: NodeJS.ProcessEnv): ConnectionSpec {
  const spec: ConnectionSpec = {
    name,
    baseUrl: normalizeBaseUrl(config.baseUrl),
    // A global env flag may TIGHTEN a file connection, never loosen it. Read-only
    // is a kill switch, so `COOLIFY_READ_ONLY=true` has to reach connections the
    // file already described; the reverse would let an env var re-open a
    // connection the file deliberately closed.
    readOnly: config.readOnly || booleanEnv(env, 'COOLIFY_READ_ONLY', false),
    allowDestructive:
      config.allowDestructive ?? booleanEnv(env, 'COOLIFY_ALLOW_DESTRUCTIVE', false),
    timeoutMs: config.timeoutMs,
    insecureTLS: config.insecureTLS,
  };
  if (config.label !== undefined) spec.label = config.label;
  if (config.tokenEnv !== undefined) spec.tokenEnv = config.tokenEnv;
  if (config.tokenCommand !== undefined) spec.tokenCommand = config.tokenCommand;
  if (config.tokenKeychain !== undefined) spec.tokenKeychain = config.tokenKeychain;
  return spec;
}

function toConnection(
  spec: ConnectionSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Connection {
  const tokenSpec = {
    name: spec.name,
    ...(spec.tokenEnv !== undefined ? { tokenEnv: spec.tokenEnv } : {}),
    ...(spec.tokenCommand !== undefined ? { tokenCommand: spec.tokenCommand } : {}),
    ...(spec.tokenKeychain !== undefined ? { tokenKeychain: spec.tokenKeychain } : {}),
  };

  const connection: Connection = {
    name: spec.name,
    baseUrl: spec.baseUrl,
    readOnly: spec.readOnly,
    allowDestructive: spec.allowDestructive,
    timeoutMs: spec.timeoutMs,
    insecureTLS: spec.insecureTLS,
    resolveToken: createTokenResolver(tokenSpec, env, { platform }),
  };
  if (spec.label !== undefined) connection.label = spec.label;
  return connection;
}

// ---------------------------------------------------------------------------
// Layer 0 and 1 — connections defined entirely by environment
// ---------------------------------------------------------------------------

function collectEnvConnections(env: NodeJS.ProcessEnv): Map<string, ConnectionSpec> {
  const found = new Map<string, ConnectionSpec>();

  const bare = readEnvValue(env, 'COOLIFY_BASE_URL');
  if (bare !== undefined) {
    found.set(
      DEFAULT_CONNECTION_NAME,
      envSpec(DEFAULT_CONNECTION_NAME, bare, 'COOLIFY_BASE_URL', env),
    );
  }

  // Sorted so that a malformed variable always reports the same one first.
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith(BASE_URL_PREFIX)) continue;
    const value = readEnvValue(env, key);
    if (value === undefined) continue;

    const name = connectionNameFromEnvSuffix(key.slice(BASE_URL_PREFIX.length));
    if (!CONNECTION_NAME_RE.test(name)) {
      throw new ConfigError(
        `$${key} does not name a valid connection: "${name}" must be ${CONNECTION_NAME_RULE}.\n` +
          'The variable name after COOLIFY_BASE_URL_ becomes the connection name, lowercased, with _ read as -.',
      );
    }
    found.set(name, envSpec(name, value, key, env));
  }

  return found;
}

function envSpec(
  name: string,
  rawBaseUrl: string,
  variable: string,
  env: NodeJS.ProcessEnv,
): ConnectionSpec {
  const problem = baseUrlProblem(rawBaseUrl);
  if (problem) throw new ConfigError(`$${variable} ${problem}.`);

  // Env-defined connections have no file to state their own settings, so the
  // process-wide knobs are their defaults. File connections are configured by
  // the file (except for the read-only kill switch — see fromFile).
  return {
    name,
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    readOnly: booleanEnv(env, 'COOLIFY_READ_ONLY', false),
    allowDestructive: booleanEnv(env, 'COOLIFY_ALLOW_DESTRUCTIVE', false),
    timeoutMs: timeoutEnv(env),
    insecureTLS: booleanEnv(env, 'COOLIFY_INSECURE_TLS', false),
  };
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function booleanEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnvValue(env, key);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  // Loud rather than lenient: silently reading "COOLIFY_ALLOW_DESTRUCTIVE=ture"
  // as false is the kind of thing a user only discovers mid-incident.
  throw new ConfigError(`$${key} must be true or false (got "${raw}").`);
}

function timeoutEnv(env: NodeJS.ProcessEnv): number {
  const raw = readEnvValue(env, 'COOLIFY_TIMEOUT_MS');
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `$COOLIFY_TIMEOUT_MS must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (got "${raw}").`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Layer 2 — the registry file
// ---------------------------------------------------------------------------

interface LocatedConfig {
  path: string;
  config: ConfigFile;
}

async function locateConfigFile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homedir: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const explicit = readEnvValue(env, CONFIG_PATH_ENV_VAR);
  if (explicit !== undefined) {
    const resolved = expandPath(explicit, cwd, homedir);
    // An explicit pointer that resolves to nothing is a mistake, not a reason
    // to quietly fall through to a different file the user is not looking at.
    if (!(await exists(resolved))) {
      throw new ConfigError(`$${CONFIG_PATH_ENV_VAR} points at ${resolved}, which does not exist.`);
    }
    return resolved;
  }

  const project = await findProjectConfig(cwd, homedir);
  if (project !== undefined) return project;

  for (const candidate of userConfigPaths(env, homedir, platform)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Nearest `.coolify-mcp.json`, walking up from cwd. The walk stops at a
 * repository root or at $HOME so that a config in a parent project — or worse,
 * one in the user's home directory reached by accident — cannot silently
 * govern an unrelated checkout.
 */
async function findProjectConfig(cwd: string, homedir: string): Promise<string | undefined> {
  const home = path.resolve(homedir);
  let dir = path.resolve(cwd);

  for (;;) {
    const candidate = path.join(dir, PROJECT_CONFIG_FILENAME);
    if (await exists(candidate)) return candidate;

    // Checked after the candidate so a repository root's own config still wins.
    // `.git` may be a file, not a directory, in worktrees and submodules.
    if (await exists(path.join(dir, '.git'))) return undefined;
    if (dir === home) return undefined;

    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function userConfigPaths(
  env: NodeJS.ProcessEnv,
  homedir: string,
  platform: NodeJS.Platform,
): string[] {
  const xdg = readEnvValue(env, 'XDG_CONFIG_HOME');
  const appData = readEnvValue(env, 'APPDATA');
  const configDir =
    xdg ??
    (platform === 'win32' && appData !== undefined ? appData : path.join(homedir, '.config'));

  return [
    path.join(configDir, CONFIG_DIR_NAME, USER_CONFIG_FILENAME),
    path.join(homedir, `.${CONFIG_DIR_NAME}`, USER_CONFIG_FILENAME),
  ];
}

async function loadConfigFile(filePath: string, homedir: string): Promise<LocatedConfig> {
  const config = await readAndParse(filePath);
  if (config.extends === undefined) return { path: filePath, config };

  const basePath = expandPath(config.extends, path.dirname(filePath), homedir);
  const base = await readAndParse(basePath);
  if (base.extends !== undefined) {
    throw new ConfigError(
      `${basePath} also has an "extends" key, and coolify-mcp resolves only one level.\n` +
        'A chain of config files makes the effective configuration impossible to read off any single file. Inline what you need.',
    );
  }

  // Same rule as env-over-file: a name defined in both replaces the base entry
  // WHOLE, so every connection is described in exactly one place.
  return {
    path: filePath,
    config: {
      ...config,
      connections: { ...base.connections, ...config.connections },
      ...(config.defaultConnection === undefined && base.defaultConnection !== undefined
        ? { defaultConnection: base.defaultConnection }
        : {}),
    },
  };
}

async function readAndParse(filePath: string): Promise<ConfigFile> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    throw new ConfigError(`cannot read config file ${filePath}: ${errorMessage(error)}`);
  }

  let raw: unknown;
  try {
    // Windows editors happily write a BOM, which JSON.parse rejects with a
    // message that says nothing about a BOM.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error: unknown) {
    throw new ConfigError(
      `${filePath} is not valid JSON: ${errorMessage(error)}\n` +
        'coolify-mcp reads strict JSON — comments and trailing commas are not allowed.',
    );
  }

  return parseConfigFile(raw, filePath);
}

// ---------------------------------------------------------------------------
// Default selection
// ---------------------------------------------------------------------------

function selectDefault(
  env: NodeJS.ProcessEnv,
  connections: Map<string, Connection>,
  fileDefault: string | undefined,
): string | undefined {
  const requested = readEnvValue(env, 'COOLIFY_CONNECTION');
  if (requested !== undefined) {
    // Accept COOLIFY_CONNECTION=PROD: the matching variable is spelled
    // COOLIFY_BASE_URL_PROD, so uppercase here is the predictable mistake and
    // failing on it teaches nothing.
    const match = connections.has(requested) ? requested : requested.toLowerCase();
    if (!connections.has(match)) {
      throw new ConfigError(
        `$COOLIFY_CONNECTION selects "${requested}", which is not a configured connection.\n` +
          `Configured: ${[...connections.keys()].join(', ')}.`,
      );
    }
    return match;
  }

  if (fileDefault !== undefined) {
    if (!connections.has(fileDefault)) {
      throw new ConfigError(
        `defaultConnection is "${fileDefault}", which is not one of the configured connections: ${[...connections.keys()].join(', ')}.`,
      );
    }
    return fileDefault;
  }

  // Exactly one connection is its own default; the `instance` parameter is
  // dropped from every tool schema in that case. With several and no
  // designation there is NO default: the tool layer then demands an explicit
  // instance and lists the names, which is better than guessing which Coolify
  // instance a deploy was meant for.
  if (connections.size === 1) return [...connections.keys()][0];
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Resolves `~/…` and relative paths. JSON has no shell to expand a tilde. */
function expandPath(value: string, base: string, homedir: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homedir, trimmed.slice(2));
  }
  return path.resolve(base, trimmed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notConfiguredMessage(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homedir: string,
  platform: NodeJS.Platform,
): string {
  const explicit = readEnvValue(env, CONFIG_PATH_ENV_VAR);
  const searched = [
    `  $${CONFIG_PATH_ENV_VAR}${explicit === undefined ? ' (unset)' : `: ${explicit}`}`,
    `  ${PROJECT_CONFIG_FILENAME} in ${cwd} and its parents`,
    ...userConfigPaths(env, homedir, platform).map((candidate) => `  ${candidate}`),
  ];

  return [
    'coolify-mcp has no connections configured.',
    '',
    'Set two environment variables:',
    '  COOLIFY_BASE_URL=https://coolify.example.com',
    '  COOLIFY_API_TOKEN=<Keys & Tokens > API tokens>',
    '',
    'For several instances or teams, name each one:',
    `  ${baseUrlEnvVar('prod')}=... + ${tokenEnvVar('prod')}=...`,
    `  ${baseUrlEnvVar('acme')}=... + ${tokenEnvVar('acme')}=...`,
    '  COOLIFY_CONNECTION=prod',
    '',
    'A registry file works too. Looked for:',
    ...searched,
  ].join('\n');
}
