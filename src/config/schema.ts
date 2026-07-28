/**
 * The registry file format — and the one place where "coolify-mcp never stores
 * credentials in config files" is enforced rather than merely recommended.
 *
 * `connectionSchema` has no `token` property and is `.strict()`, so a literal
 * credential cannot round-trip through this parser. The rejection is the
 * feature: `formatConfigError` turns it into a message that names the three
 * supported token sources and the env var that already works by convention,
 * so the user's next action is obvious from the error alone.
 */
import { z } from 'zod';

export const CONFIG_VERSION = 1;

/** The implicit connection born from bare COOLIFY_BASE_URL + COOLIFY_API_TOKEN. */
export const DEFAULT_CONNECTION_NAME = 'default';

/**
 * Connection names are slugs because they must survive a round trip through an
 * env var name: `acme-ops` <-> COOLIFY_API_TOKEN_ACME_OPS. Anything outside
 * this alphabet makes that mapping ambiguous.
 */
export const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const CONNECTION_NAME_RULE =
  'lowercase letters, digits and dashes, starting with a letter or digit, 31 characters max';

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Longest argv we will hand to execFile — a token command is `op read ...`, not a script. */
const MAX_TOKEN_COMMAND_ARGS = 32;

/** Config errors are startup failures with a written remedy, not runtime API failures. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Name <-> env var mapping
// ---------------------------------------------------------------------------

/** `acme-ops` -> `ACME_OPS`. */
export function envSuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/** `ACME_OPS` -> `acme-ops`. The inverse of {@link envSuffix}. */
export function connectionNameFromEnvSuffix(suffix: string): string {
  return suffix.toLowerCase().replace(/_/g, '-');
}

export function tokenEnvVar(name: string): string {
  return `COOLIFY_API_TOKEN_${envSuffix(name)}`;
}

export function baseUrlEnvVar(name: string): string {
  return `COOLIFY_BASE_URL_${envSuffix(name)}`;
}

/**
 * Reads an env var as "set to something", trimmed. Every MCP client config
 * format lets a user leave an empty string behind (`"COOLIFY_API_TOKEN": ""`),
 * and an empty value that counts as "set" produces a 401 instead of the
 * "not configured" message that would have told them what to do.
 */
export function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// baseUrl
// ---------------------------------------------------------------------------

/**
 * Returns a human problem statement, or undefined when the URL is usable.
 * Shared by the Zod schema and the env layer so a bad URL reads the same way
 * whether it came from a file or from COOLIFY_BASE_URL_PROD.
 */
export function baseUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `must be an absolute URL such as "https://coolify.example.com" (got "${value}")`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `must be http(s) (got "${url.protocol}//")`;
  }
  // https://user:pass@host would smuggle a credential into the config file
  // through the one string field that is allowed to be there.
  if (url.username !== '' || url.password !== '') {
    return 'must not embed credentials — coolify-mcp never stores credentials in config files';
  }
  return undefined;
}

/** Trailing slashes make the client build `//v1/...`; normalise once, here. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const connectionNameSchema = z
  .string()
  .regex(CONNECTION_NAME_RE, `connection names must be ${CONNECTION_NAME_RULE}`);

const baseUrlSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const problem = baseUrlProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `baseUrl ${problem}` });
  });

const tokenKeychainSchema = z
  .object({
    service: z.string().trim().min(1),
    account: z.string().trim().min(1),
  })
  .strict();

/**
 * Kept separate from the exported schema so `.shape` survives — the error
 * formatter lists the valid property names, and hardcoding that list twice is
 * exactly how it would drift.
 */
const connectionObject = z
  .object({
    baseUrl: baseUrlSchema,
    label: z.string().trim().min(1).max(120).optional(),

    // Three token *sources*. There is no `token` — see the file header.
    tokenEnv: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'tokenEnv must be an environment variable name')
      .optional(),
    tokenCommand: z.array(z.string().min(1)).min(1).max(MAX_TOKEN_COMMAND_ARGS).optional(),
    tokenKeychain: tokenKeychainSchema.optional(),

    readOnly: z.boolean().default(false),
    /**
     * Present because types.ts documents Connection.allowDestructive as a
     * per-connection override of COOLIFY_ALLOW_DESTRUCTIVE. It can only narrow
     * in practice: the destructive tool is registered from the global flag, so
     * `true` here without the global flag grants nothing, while `false` keeps
     * one connection protected on a server where the flag is on.
     */
    allowDestructive: z.boolean().optional(),
    timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    insecureTLS: z.boolean().default(false),
  })
  .strict();

const CONNECTION_KEYS = Object.keys(connectionObject.shape);

export const connectionSchema = connectionObject.superRefine((value, ctx) => {
  const sources = (['tokenEnv', 'tokenCommand', 'tokenKeychain'] as const).filter(
    (key) => value[key] !== undefined,
  );
  if (sources.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `at most one of tokenEnv, tokenCommand, tokenKeychain may be set (found ${sources.join(' and ')}). ` +
        'Two sources means two answers to "where is the token", and no rule for which wins',
    });
  }
});

const configObject = z
  .object({
    /** Editors resolve schema/config.v1.json from here; it is not a setting. */
    $schema: z.string().optional(),
    version: z.literal(CONFIG_VERSION),
    defaultConnection: connectionNameSchema.optional(),
    /** Single level only — resolved relative to the referring file. */
    extends: z.string().trim().min(1).optional(),
    connections: z.record(connectionNameSchema, connectionSchema),
  })
  .strict();

export const configFileSchema = configObject.superRefine((value, ctx) => {
  if (Object.keys(value.connections).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connections'],
      message: 'define at least one connection',
    });
  }
});

export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const MAX_REPORTED_ISSUES = 10;

/**
 * Property names that mean "a credential is sitting in this file". Compared
 * with separators stripped so `api_token`, `apiToken` and `API-TOKEN` all land
 * on the same explanation.
 */
const CREDENTIAL_KEYS = new Set([
  'token',
  'apitoken',
  'accesstoken',
  'authtoken',
  'apikey',
  'key',
  'secret',
  'password',
  'bearer',
  'authorization',
]);

function looksLikeCredential(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

function formatPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return '<root>';
  return path.reduce<string>(
    (acc, segment) =>
      typeof segment === 'number'
        ? `${acc}[${segment}]`
        : acc === ''
          ? segment
          : `${acc}.${segment}`,
    '',
  );
}

/** The connection name for a path like ['connections', 'prod', ...]. */
function connectionNameAt(path: ReadonlyArray<string | number>): string | undefined {
  const [head, name] = path;
  return head === 'connections' && typeof name === 'string' ? name : undefined;
}

function credentialKeyBlock(path: ReadonlyArray<string | number>, key: string): string {
  const name = connectionNameAt(path);
  const variable = name === undefined ? 'COOLIFY_API_TOKEN' : tokenEnvVar(name);
  return [
    `config error at ${formatPath(path)}: "${key}" is not a valid property.`,
    'coolify-mcp never stores credentials in config files.',
    'Use tokenEnv | tokenCommand | tokenKeychain, or omit all three and',
    `$${variable} is read by convention.`,
  ].join('\n');
}

function unknownKeyBlock(path: ReadonlyArray<string | number>, key: string): string {
  const valid = connectionNameAt(path) === undefined ? undefined : CONNECTION_KEYS.join(', ');
  const lines = [`config error at ${formatPath(path)}: "${key}" is not a valid property.`];
  if (valid) lines.push(`Valid properties: ${valid}.`);
  return lines.join('\n');
}

function describeIssue(issue: z.ZodIssue): string[] {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((key) =>
      looksLikeCredential(key)
        ? credentialKeyBlock(issue.path, key)
        : unknownKeyBlock(issue.path, key),
    );
  }
  if (issue.code === z.ZodIssueCode.invalid_literal && issue.path.join('.') === 'version') {
    return [`config error at version: must be ${CONFIG_VERSION}. This file is a v1 registry.`];
  }
  return [`config error at ${formatPath(issue.path)}: ${issue.message}`];
}

export function formatConfigError(error: z.ZodError, sourcePath: string): string {
  const blocks = error.issues.flatMap(describeIssue);
  const shown = blocks.slice(0, MAX_REPORTED_ISSUES);
  if (blocks.length > shown.length) {
    shown.push(`(${blocks.length - shown.length} further problems not shown)`);
  }
  return [`invalid coolify-mcp config: ${sourcePath}`, ...shown].join('\n\n');
}

/** Parses and validates one registry file. Throws {@link ConfigError} on any problem. */
export function parseConfigFile(raw: unknown, sourcePath: string): ConfigFile {
  const result = configFileSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(formatConfigError(result.error, sourcePath));
  return result.data;
}
