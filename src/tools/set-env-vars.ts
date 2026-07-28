/**
 * `set_environment_variables` — PATCH /{family}/{uuid}/envs/bulk.
 *
 * Bulk-first, and bulk-only. Coolify exposes a singular env endpoint too, but
 * setting five variables through it is five round trips against a rate limit
 * every connection on the same Coolify account shares, five chances to fail
 * halfway, and five turns of the model's attention. The bulk endpoint exists;
 * promoting it instead is the whole reason this tool is here.
 *
 * DELETION IS DELIBERATELY ABSENT. Removing a variable is destructive — nothing
 * in Coolify's API brings back a value it no longer stores — so it belongs on
 * the other side of the COOLIFY_ALLOW_DESTRUCTIVE gate, reachable through the
 * destructive generic door and nowhere else. A `delete: true` flag here would
 * put an irreversible operation inside a tool the gate does not cover.
 */

import { z } from 'zod';

import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse } from '../shaping/envelope.js';
import { MASK, redact } from '../shaping/redact.js';
import { CoolifyError } from '../types.js';
import type { Connection, ServerConfig, ToolDef, ToolExtra, ToolResult } from '../types.js';

const RESOURCE_TYPES = ['application', 'database', 'service'] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

const FAMILY_SEGMENT: Record<ResourceType, string> = {
  application: 'applications',
  database: 'databases',
  service: 'services',
};

const OPERATION_IDS: Record<ResourceType, string> = {
  application: 'update-envs-by-application-uuid',
  database: 'update-envs-by-database-uuid',
  service: 'update-envs-by-service-uuid',
};

const MAX_VARIABLES = 100;
const MAX_KEY_LENGTH = 255;

/** Generous: certificates and private keys legitimately live in env values. */
const MAX_VALUE_LENGTH = 65_536;

/**
 * Names Coolify uses for the plaintext value of a variable.
 *
 * A denylist, which is normally the wrong choice — see shaping/project.ts on why
 * allowlists are used everywhere else. It is right here because the goal is not
 * to bound the payload but to suppress two specific known keys, and the response
 * shape of this endpoint is not fixed enough to allowlist without dropping the
 * server's own message.
 */
const VALUE_KEYS: ReadonlySet<string> = new Set(['value', 'real_value']);

// ---------------------------------------------------------------------------
// Connection selection
// ---------------------------------------------------------------------------

/**
 * `instance` is published only when there is something to choose between, and on
 * a write tool it is REQUIRED WITH NO DEFAULT.
 *
 * The read tools default it because a read aimed at the wrong instance costs one
 * wasted call. Writes get no such forgiveness: a defaulted `instance` here means
 * a forgotten parameter overwrites production configuration with staging values
 * and reports success. When more than one connection exists, the model names its
 * target every time.
 */
function instanceShape(cfg: ServerConfig): Record<string, unknown> {
  const names = [...cfg.registry.connections.keys()];
  if (names.length < 2) return {};

  const [first, ...rest] = names;
  if (first === undefined) return {};
  return {
    instance: z
      .enum([first, ...rest])
      .describe(
        'Which configured Coolify connection to write to. Required: write tools have no default target.',
      ),
  };
}

/** Enforced here as well as in the schema, so a client that ignores the schema gains nothing. */
function resolveConnection(cfg: ServerConfig, instance: string | undefined): Connection {
  const { connections } = cfg.registry;
  const names = [...connections.keys()];

  if (instance !== undefined) {
    const chosen = connections.get(instance);
    if (chosen) return chosen;
    throw new CoolifyError(
      `Unknown instance \`${instance}\`.`,
      'validation',
      `Configured connections: ${names.length > 0 ? names.join(', ') : 'none'}.`,
    );
  }

  if (connections.size === 1) {
    const only = connections.values().next().value;
    if (only) return only;
  }
  throw new CoolifyError(
    'This server has more than one Coolify connection configured, so `instance` is required.',
    'validation',
    `Pass one of: ${names.join(', ')}. Write tools deliberately carry no default instance.`,
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * `is_build_time` is not in Coolify's published OpenAPI schema for this endpoint,
 * but the underlying model carries it and the spec is known wrong in places
 * (upstream coollabsio/coolify#7702). It is offered here and sent ONLY when the
 * caller sets it explicitly: the common call is then byte-identical to what the
 * spec describes, and a caller who does ask for it gets either the behaviour or
 * Coolify's own error, which is a better guide than our guess either way.
 */
const VARIABLE = z
  .object({
    key: z
      .string()
      .min(1)
      .max(MAX_KEY_LENGTH)
      // No whitespace and no `=`: both make the variable unusable in the container
      // the moment it is exported, and Coolify does not reject them for you.
      .regex(/^[^\s=]+$/, 'must not contain whitespace or "="')
      .describe('Variable name, for example DATABASE_URL.'),
    value: z
      .string()
      .max(MAX_VALUE_LENGTH)
      .describe('Value to set. An empty string sets the variable to empty; it does not remove it.'),
    is_preview: z
      .boolean()
      .optional()
      .describe(
        'Apply to preview (pull request) deployments instead of the production environment.',
      ),
    is_build_time: z
      .boolean()
      .optional()
      .describe(
        'Expose the variable to the build as well as the running container. Needed by build-time frameworks such as Next.js and Vite.',
      ),
    is_literal: z
      .boolean()
      .optional()
      .describe(
        'Treat the value literally, with no escaping or variable expansion. Use for values containing $ or backslashes.',
      ),
    is_multiline: z
      .boolean()
      .optional()
      .describe('The value spans multiple lines, for example a PEM certificate or private key.'),
  })
  // The one nested object in the whole tool surface, and so the one place the
  // top-level wrapper in `tools/register.ts` cannot reach. Same reasoning as
  // there: Zod 4 stopped emitting `additionalProperties: false` for a
  // non-strict object, and the published schema should keep telling a model
  // that `is_secret` — the field an LLM most often assumes exists here — is not
  // one of the six that do. Parsing still strips rather than rejects.
  .meta({ additionalProperties: false });

type Variable = z.infer<typeof VARIABLE>;

const ARGS = z.object({
  instance: z.string().min(1).optional(),
  resource_type: z
    .enum(RESOURCE_TYPES)
    .describe(
      'Which Coolify family the UUID belongs to. find_resources reports the type alongside each UUID.',
    ),
  uuid: z
    .string()
    .min(1)
    .max(255)
    .describe('UUID of the application, database or service whose variables to set.'),
  variables: z
    .array(VARIABLE)
    .min(1)
    .max(MAX_VARIABLES)
    .describe(
      'Variables to set, in one request. Existing keys are updated in place; keys not listed are left untouched.',
    ),
});

type SetEnvArgs = z.infer<typeof ARGS>;

/**
 * Two variables with the same key in one request make the outcome depend on the
 * order Coolify happens to apply them, which is not a promise anyone should rely
 * on. Rejected locally rather than sent.
 */
function assertUniqueKeys(variables: readonly Variable[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const variable of variables) {
    if (seen.has(variable.key)) duplicates.add(variable.key);
    seen.add(variable.key);
  }
  if (duplicates.size > 0) {
    throw new CoolifyError(
      `The same key appears more than once: ${[...duplicates].join(', ')}.`,
      'validation',
      'Each key may be set once per request; the last value would otherwise win by accident of ordering.',
    );
  }
}

/**
 * One request entry per variable, carrying only the flags the caller actually
 * set. Coolify rejects unknown fields on several endpoints, so an omitted flag
 * is omitted rather than sent as `false` — and sending `false` would also be a
 * silent claim about a flag the caller never mentioned.
 */
function toRequestEntry(variable: Variable): Record<string, string | boolean> {
  const entry: Record<string, string | boolean> = { key: variable.key, value: variable.value };
  if (variable.is_preview !== undefined) entry['is_preview'] = variable.is_preview;
  if (variable.is_build_time !== undefined) entry['is_build_time'] = variable.is_build_time;
  if (variable.is_literal !== undefined) entry['is_literal'] = variable.is_literal;
  if (variable.is_multiline !== undefined) entry['is_multiline'] = variable.is_multiline;
  return entry;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Masks variable values anywhere in Coolify's reply.
 *
 * The caller already knows the values it just sent, so echoing them back buys
 * nothing and costs something real: every copy is another place the credential
 * sits in the transcript, in the host's history, and in whatever the user later
 * exports or pastes. `get_environment_variables` is where values are read, on
 * purpose and with its own masking.
 */
function maskValues(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(maskValues);
  if (typeof node !== 'object' || node === null) return node;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (VALUE_KEYS.has(key) && typeof child === 'string' && child.length > 0) {
      out[key] = MASK;
      continue;
    }
    out[key] = maskValues(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(
  rawArgs: Record<string, unknown>,
  cfg: ServerConfig,
  extra: ToolExtra,
): Promise<ToolResult> {
  try {
    const args = parseArgs(rawArgs);
    assertUniqueKeys(args.variables);
    const connection = resolveConnection(cfg, args.instance);

    const response = await coolifyRequest<unknown>({
      connection,
      method: 'PATCH',
      path: `/${FAMILY_SEGMENT[args.resource_type]}/${encodeURIComponent(args.uuid)}/envs/bulk`,
      body: { data: args.variables.map(toRequestEntry) },
      operationId: OPERATION_IDS[args.resource_type],
      signal: extra.signal,
    });

    const envelope = shapeResponse(
      {
        resource_type: args.resource_type,
        uuid: args.uuid,
        // Keys only. The values went to Coolify; they do not need to come back
        // through the transcript as well.
        keys_set: args.variables.map((variable) => variable.key),
        result: maskValues(response.data),
      },
      {
        instance: connection.name,
        count: args.variables.length,
        hint: RESULT_HINTS[args.resource_type],
      },
    );
    return renderEnvelope(envelope);
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Facts, not directives.
 *
 * The application note is the one that stops a wrong conclusion: setting a
 * variable changes stored configuration and nothing else. The container keeps
 * running with the old environment until the next deployment, so a log line
 * showing the old value right after a successful write is expected rather than
 * evidence that the write failed.
 */
const RESULT_HINTS: Record<ResourceType, string> = {
  application:
    'Values are stored immediately. The running container keeps its current environment until the next deployment, so deploy is what makes a changed variable take effect. If Coolify reports a key as not found, it does not yet exist on this resource; the singular create endpoint is reachable through execute_write_operation.',
  database:
    'Values are stored immediately. The running container keeps its current environment until it is restarted. If Coolify reports a key as not found, it does not yet exist on this resource; the singular create endpoint is reachable through execute_write_operation.',
  service:
    'Values are stored immediately. Running containers keep their current environment until the service is restarted. If Coolify reports a key as not found, it does not yet exist on this resource; the singular create endpoint is reachable through execute_write_operation.',
};

function parseArgs(raw: Record<string, unknown>): SetEnvArgs {
  const parsed = ARGS.safeParse(raw);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new CoolifyError(`Invalid arguments: ${detail}`, 'validation');
}

/**
 * Errors are returned, never thrown across the transport: a thrown error becomes
 * a protocol failure the model cannot read, a returned one is text it can act
 * on. Re-redacted because this is the last point before the transcript — and on
 * this tool in particular, a validation error can quote the request.
 */
function errorResult(error: unknown): ToolResult {
  const parts: string[] = [];

  if (error instanceof CoolifyError) {
    parts.push(error.message);
    if (error.hint) parts.push(error.hint);
    for (const [field, messages] of Object.entries(error.validationErrors ?? {})) {
      parts.push(`${field}: ${messages.join('; ')}`);
    }
  } else if (error instanceof Error) {
    parts.push(error.message);
  } else {
    parts.push('The request failed for an unknown reason.');
  }

  return { content: [{ type: 'text', text: redact(parts.join('\n')) }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const setEnvironmentVariables: ToolDef = {
  name: 'set_environment_variables',
  description:
    'Set environment variables on a Coolify application, database or service in one request. Existing keys are updated in place and keys not listed are left untouched. Does not delete — deletion is a destructive operation. For applications the new values take effect on the next deployment, not immediately.',
  annotations: {
    title: 'Set environment variables',
    readOnlyHint: false,
    // Overwrites configuration, but stores exactly what it was given: no data
    // is removed and the previous value can be written back the same way.
    destructiveHint: false,
    // Setting the same variables twice leaves the same state, but Coolify may
    // create rows on the first call and update them on the second, so this is
    // not claimed as strictly idempotent.
    idempotentHint: false,
    openWorldHint: true,
  },
  surface: 'write',
  inputSchema: (cfg: ServerConfig): Record<string, unknown> => ({
    ...instanceShape(cfg),
    resource_type: ARGS.shape.resource_type,
    uuid: ARGS.shape.uuid,
    variables: ARGS.shape.variables,
  }),
  handler,
};
