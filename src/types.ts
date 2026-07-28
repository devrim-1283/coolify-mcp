/**
 * Shared contracts for coolify-mcp.
 *
 * Every module implements against these types. They are the seam between the
 * catalog, the HTTP client, the tool layer and the installer, so changing one
 * is a cross-cutting change — prefer adding over editing.
 */

// ---------------------------------------------------------------------------
// Catalog (generated at build time from Coolify's OpenAPI spec)
// ---------------------------------------------------------------------------

/**
 * Danger class decides which generic door an operation is reachable through,
 * and whether the transport layer will let it out of the process at all.
 *
 * Computed at build time. `destructive` is NOT simply `method === 'DELETE'`:
 * POST /v1/disable turns off the Coolify API and locks the token out of its
 * own instance, which is irreversible from the token's point of view.
 */
export type DangerClass = 'safe' | 'write' | 'destructive';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type OperationFamily =
  | 'applications'
  | 'databases'
  | 'services'
  | 'servers'
  | 'projects'
  | 'deployments'
  | 'teams'
  | 'security'
  | 'destinations'
  | 'github-apps'
  | 'cloud-tokens'
  | 'hetzner'
  | 'digitalocean'
  | 'vultr'
  | 'tags'
  | 'other';

export interface CatalogOperation {
  /** Stable id from the spec's operationId, e.g. "deleteApplicationByUuid". */
  id: string;
  method: HttpMethod;
  /** Path template with `{placeholders}`, e.g. "/applications/{uuid}". */
  path: string;
  family: OperationFamily;
  summary: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  danger: DangerClass;
  /**
   * Provisions billable cloud infrastructure. Not gated (the brief says
   * everything non-destructive stays open) but surfaced in search results so
   * the model can see the consequence before calling.
   */
  costly?: boolean;
  /** Minimum Coolify version exposing this operation, when known. */
  since?: string;
}

export interface CatalogMeta {
  /** Coolify release the spec was taken from, e.g. "4.2.0". */
  coolifyVersion: string;
  specSha256: string;
  /** Operations in the raw spec, before stub stripping. */
  rawOperationCount: number;
  /** `post_required` stubs removed. See docs: they are GETs that only say "use POST". */
  strippedCount: number;
  /** Operations actually in the catalog. */
  operationCount: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Connections — a connection is (baseUrl, token)
// ---------------------------------------------------------------------------

/**
 * A Coolify API token is bound to the team that was active when it was created;
 * there is no team-switch parameter in the API. So a second team is a second
 * token, which is a second connection. N connections covers
 * N instances x M teams uniformly — no separate "team" concept is needed.
 */
export interface Connection {
  /** Slug: ^[a-z0-9][a-z0-9-]{0,30}$ */
  name: string;
  baseUrl: string;
  label?: string;
  /** Refuse every write and destructive operation regardless of token scope. */
  readOnly: boolean;
  /** Per-connection override of the global COOLIFY_ALLOW_DESTRUCTIVE flag. */
  allowDestructive: boolean;
  timeoutMs: number;
  insecureTLS: boolean;
  /** Resolves the bearer token. Cached for the process lifetime, never written to disk. */
  resolveToken: () => Promise<string>;
}

export interface ConnectionRegistry {
  connections: Map<string, Connection>;
  /** Undefined when several connections exist and none was designated. */
  defaultName?: string;
  /** Where the config came from, for `doctor` and error messages. */
  source: 'env' | 'file' | 'env+file';
  configPath?: string;
  /** Names defined in both env and file; env won. */
  shadowed: string[];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface CoolifyRequest {
  connection: Connection;
  method: HttpMethod;
  /** Concrete path with params already substituted, e.g. "/applications/abc". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Catalog operation id, when the call came from the generic path. */
  operationId?: string;
  signal?: AbortSignal;
}

export interface CoolifyResponse<T = unknown> {
  status: number;
  data: T;
  /** Parsed from X-RateLimit-* when present. Never assume 200/min — self-hosters change it. */
  rateLimit?: { limit: number; remaining: number };
}

/** Every failure the tool layer can render. Never thrown across the transport. */
export class CoolifyError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'destructive_blocked'
      | 'read_only_connection'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'validation'
      | 'rate_limited'
      | 'api_disabled'
      | 'network'
      | 'unknown',
    /** Actionable next step shown to the model. */
    readonly hint?: string,
    readonly status?: number,
    /** Laravel's `errors` map, passed through verbatim — a better hint than anything we'd synthesize. */
    readonly validationErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'CoolifyError';
  }
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

export type TruncationKind = 'field_prune' | 'row_limit' | 'field_value' | null;

export interface ResponseMeta {
  count: number;
  total?: number;
  next_cursor?: string;
  truncated: number;
  truncation: TruncationKind;
  /** Factual statement of available next steps. Never a directive about model behaviour. */
  hint?: string;
  /** Partial failures from an `instance: "*"` fan-out. */
  errors?: Array<{ instance: string; message: string }>;
}

/** Identical envelope across every tool. */
export interface ToolEnvelope<T = unknown> {
  instance?: string;
  data: T;
  meta: ResponseMeta;
}

export interface ShapeOptions {
  /** Fields kept, in order. An allowlist — a denylist rots when Coolify adds fields. */
  fields?: readonly string[];
  /** Fields dropped first when over budget, in order. */
  prunable?: readonly string[];
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Tool modules
// ---------------------------------------------------------------------------

/**
 * Annotations are mandatory per Anthropic's tool-design review criteria:
 * every tool must carry title, readOnlyHint and destructiveHint.
 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/**
 * A tool module. `build` receives the resolved config so a tool can shape its
 * schema around it — most importantly, the `instance` parameter is omitted
 * entirely when only one connection exists, rather than being optional.
 */
export interface ToolDef {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  /** Which surface this belongs to; register.ts uses it to apply the gates. */
  surface: 'read' | 'write' | 'destructive';
  /** Zod raw shape. Built per-config so `instance` can be conditional. */
  inputSchema: (cfg: ServerConfig) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    cfg: ServerConfig,
    extra: ToolExtra,
  ) => Promise<ToolResult>;
}

export interface ToolExtra {
  signal?: AbortSignal;
  /** Present when the host supports progress notifications. */
  progress?: (progress: number, total?: number, message?: string) => void;
}

/** MCP tool result. Errors are returned, never thrown across the transport. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

export interface ServerConfig {
  registry: ConnectionRegistry;
  /** Global default; a connection may override. */
  allowDestructive: boolean;
  readOnly: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

/** The MCP server entry an adapter writes into a client's config. */
export interface ServerEntry {
  /** Key under mcpServers / context_servers / mcp. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InstallCtx {
  homeDir: string;
  projectRoot: string;
  platform: NodeJS.Platform;
  /** Bake COOLIFY_CONNECTION into the env block. */
  connection?: string;
  /** "coolify-mcp@1.4.2" vs "coolify-mcp@latest". */
  packageSpec: string;
  transport: 'stdio' | 'http';
}

/** Inert data. Built purely so --dry-run is a true preview, then applied. */
export type Operation =
  | { kind: 'json-merge'; path: string; keyPath: string[]; value: unknown }
  | { kind: 'jsonc-merge'; path: string; keyPath: string[]; value: unknown }
  | { kind: 'toml-append'; path: string; section: string; text: string }
  | { kind: 'toml-replace'; path: string; section: string; text: string }
  | { kind: 'yaml-merge'; path: string; keyPath: string[]; value: unknown }
  | { kind: 'json-remove'; path: string; keyPath: string[] }
  | { kind: 'jsonc-remove'; path: string; keyPath: string[] }
  | { kind: 'toml-remove'; path: string; section: string }
  | { kind: 'yaml-remove'; path: string; keyPath: string[] }
  | { kind: 'exec'; argv: string[]; cwd?: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'note'; level: 'info' | 'warn'; message: string };

export interface ValidationIssue {
  severity: 'error' | 'warn' | 'info';
  /** Machine-readable, kebab-case, e.g. "codex-config-unparseable". */
  code: string;
  message: string;
  /** What the user should do about it. */
  fix?: string;
}

export interface Detection {
  installed: boolean;
  configExists: boolean;
  parseable: boolean;
  path: string;
}

export interface McpClientAdapter {
  /** e.g. "codex-user" */
  id: string;
  /** e.g. "codex" */
  client: string;
  scope: 'user' | 'project';
  label: string;
  format: 'json' | 'jsonc' | 'toml' | 'yaml';
  /**
   * 'unverified' makes apply() refuse to write and downgrade to --print.
   * Promotion requires a link to upstream docs or a reproducible probe.
   */
  confidence: 'verified' | 'unverified';
  transports: Array<'stdio' | 'http'>;
  supports(target: string): boolean;
  resolvePath(ctx: InstallCtx): string;
  detect(ctx: InstallCtx): Promise<Detection>;
  nativeCli?: { bin: string; buildArgv(entry: ServerEntry, ctx: InstallCtx): string[] };
  /** PURE — no I/O. */
  planWrite(entry: ServerEntry, ctx: InstallCtx): Operation[];
  /** PURE — no I/O. */
  planRemove(ctx: InstallCtx): Operation[];
  readEntry(ctx: InstallCtx): Promise<unknown | null>;
  validate(ctx: InstallCtx): Promise<ValidationIssue[]>;
}

export interface InstallRecord {
  adapterId: string;
  path: string;
  serverName: string;
  managedKeyPath: string[];
  method: 'file' | 'native-cli';
  packageSpec: string;
  writtenAt: string;
  entryHash: string;
}

export interface InstallState {
  schema: 'coolify-mcp.install.v1';
  installs: InstallRecord[];
}
