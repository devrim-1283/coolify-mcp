/**
 * `control_resource` — start, stop and restart, for all three resource families.
 *
 * One tool rather than nine because Coolify's own surface is a cross product:
 * `start|stop|restart` x `applications|databases|services` are nine endpoints
 * with identical semantics and near-identical parameters. Nine tools would spend
 * nine schemas of context every turn to express two enums.
 *
 * On `destructiveHint: false`, and on why this tool is NOT behind
 * COOLIFY_ALLOW_DESTRUCTIVE, see the note above the export at the bottom of this
 * file. It is a judgement call and it is argued there rather than assumed.
 */

import { z } from 'zod';

import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse } from '../shaping/envelope.js';
import { redact } from '../shaping/redact.js';
import { CoolifyError } from '../types.js';
import type { Connection, ServerConfig, ToolDef, ToolExtra, ToolResult } from '../types.js';

const RESOURCE_TYPES = ['application', 'database', 'service'] as const;
const ACTIONS = ['start', 'stop', 'restart'] as const;

type ResourceType = (typeof RESOURCE_TYPES)[number];
type Action = (typeof ACTIONS)[number];

/** Resource type to the path segment Coolify uses for it. */
const FAMILY_SEGMENT: Record<ResourceType, string> = {
  application: 'applications',
  database: 'databases',
  service: 'services',
};

/**
 * Catalog operation ids, passed to the transport so its danger classifier can
 * escalate a call it disagrees with. Spelled out rather than assembled from the
 * two enums: a template would silently produce a plausible-looking id for an
 * operation that does not exist, and the transport would then classify an
 * unknown id on its baseline rules alone.
 */
const OPERATION_IDS: Record<ResourceType, Record<Action, string>> = {
  application: {
    start: 'start-application-by-uuid',
    stop: 'stop-application-by-uuid',
    restart: 'restart-application-by-uuid',
  },
  database: {
    start: 'start-database-by-uuid',
    stop: 'stop-database-by-uuid',
    restart: 'restart-database-by-uuid',
  },
  service: {
    start: 'start-service-by-uuid',
    stop: 'stop-service-by-uuid',
    restart: 'restart-service-by-uuid',
  },
};

/**
 * Which optional flags each combination actually accepts, taken from the
 * generated catalog's query parameters.
 *
 * The matrix is uneven — `force` and `instant_deploy` exist only on starting an
 * application, `latest` only on restarting a service — and Coolify ignores a
 * flag it does not read rather than rejecting it. Silently ignoring is the worst
 * outcome for a caller who asked for `force` and did not get it, so the flags
 * are checked here and a mismatch is an error that names where the flag applies.
 */
const SUPPORTED_FLAGS: Record<ResourceType, Record<Action, readonly string[]>> = {
  application: { start: ['force', 'instant_deploy'], stop: ['docker_cleanup'], restart: [] },
  database: { start: [], stop: ['docker_cleanup'], restart: [] },
  service: { start: [], stop: ['docker_cleanup'], restart: ['latest'] },
};

/** Where each flag is legal, for the error message. */
const FLAG_SCOPE: Record<string, string> = {
  force: 'start on an application',
  instant_deploy: 'start on an application',
  docker_cleanup: 'stop on any resource type',
  latest: 'restart on a service',
};

// ---------------------------------------------------------------------------
// Connection selection
// ---------------------------------------------------------------------------

/**
 * `instance` is published only when there is something to choose between, and on
 * a write tool it is REQUIRED WITH NO DEFAULT.
 *
 * The read tools default it, on the grounds that a read aimed at the wrong
 * instance costs one wasted call. That reasoning does not carry over: an omitted
 * `instance` on a defaulted `control_resource` would stop a production service
 * because a parameter was forgotten. When more than one connection exists, the
 * model names its target every time.
 */
function instanceShape(cfg: ServerConfig): Record<string, unknown> {
  const names = [...cfg.registry.connections.keys()];
  if (names.length < 2) return {};

  const [first, ...rest] = names;
  if (first === undefined) return {};
  return {
    instance: z
      .enum([first, ...rest])
      .describe('Which configured Coolify connection to act on. Required: write tools have no default target.'),
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

const ARGS = z.object({
  instance: z.string().min(1).optional(),
  action: z
    .enum(ACTIONS)
    .describe(
      'start brings a stopped resource up; stop takes it down (reversible with start); restart recreates the running containers without rebuilding.',
    ),
  resource_type: z
    .enum(RESOURCE_TYPES)
    .describe('Which Coolify family the UUID belongs to. find_resources reports the type alongside each UUID.'),
  uuid: z.string().min(1).max(255).describe('UUID of the application, database or service to act on.'),
  force: z
    .boolean()
    .optional()
    .describe('Only on start of an application: start even when Coolify considers the resource already running.'),
  instant_deploy: z
    .boolean()
    .optional()
    .describe('Only on start of an application: skip the deployment queue and start immediately.'),
  docker_cleanup: z
    .boolean()
    .optional()
    .describe('Only on stop: run Docker cleanup on the host afterwards, reclaiming space from unused images and volumes.'),
  latest: z
    .boolean()
    .optional()
    .describe('Only on restart of a service: pull the latest image tags before restarting instead of reusing the current ones.'),
});

type ControlArgs = z.infer<typeof ARGS>;

const FLAG_NAMES = ['force', 'instant_deploy', 'docker_cleanup', 'latest'] as const;

/**
 * Builds the query for this combination, rejecting flags the combination does
 * not accept. Local rejection saves a round trip, and — unlike Coolify's own
 * behaviour of ignoring the flag — it tells the caller the request it made is
 * not the request that would have run.
 */
function buildQuery(args: ControlArgs): Record<string, boolean | undefined> {
  const supported = new Set(SUPPORTED_FLAGS[args.resource_type][args.action]);
  const query: Record<string, boolean | undefined> = {};

  for (const flag of FLAG_NAMES) {
    const value = args[flag];
    if (value === undefined) continue;
    if (!supported.has(flag)) {
      throw new CoolifyError(
        `\`${flag}\` is not accepted for ${args.action} on a ${args.resource_type}.`,
        'validation',
        `Coolify accepts \`${flag}\` on ${FLAG_SCOPE[flag] ?? 'a different combination'}. It would have been ignored rather than rejected, so the call was stopped here instead.`,
      );
    }
    query[flag] = value;
  }
  return query;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(rawArgs: Record<string, unknown>, cfg: ServerConfig, extra: ToolExtra): Promise<ToolResult> {
  try {
    const args = parseArgs(rawArgs);
    const connection = resolveConnection(cfg, args.instance);
    const query = buildQuery(args);

    const response = await coolifyRequest<unknown>({
      connection,
      method: 'POST',
      path: `/${FAMILY_SEGMENT[args.resource_type]}/${encodeURIComponent(args.uuid)}/${args.action}`,
      query,
      // These endpoints declare no request body, and Coolify answers a POST whose
      // JSON body decodes to nothing with `400 Empty JSON.` — including for `{}`.
      // No body is sent from here: the HTTP client owns that workaround for every
      // caller, and a second placeholder invented locally would be one more thing
      // to keep in step with it.
      operationId: OPERATION_IDS[args.resource_type][args.action],
      signal: extra.signal,
    });

    const envelope = shapeResponse(
      {
        action: args.action,
        resource_type: args.resource_type,
        uuid: args.uuid,
        result: response.data,
      },
      {
        instance: connection.name,
        count: 1,
        hint: HINTS[args.action],
      },
    );
    return renderEnvelope(envelope);
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Facts about what the call set in motion, not instructions. All three actions
 * are queued asynchronously by Coolify, so a 200 here means "accepted", not
 * "running" — saying so prevents a follow-up read that reports the old state
 * being read as a failure.
 */
const HINTS: Record<Action, string> = {
  start:
    'Coolify queued the start. The resource may take a moment to report as running; get_resource shows its current status.',
  stop: 'Coolify queued the stop. The resource stays defined and can be brought back with action="start".',
  restart:
    'Coolify queued the restart. Containers are recreated from the current image; no rebuild happens, so code changes need deploy instead.',
};

function parseArgs(raw: Record<string, unknown>): ControlArgs {
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
 * on. Re-redacted because this is the last point before the transcript.
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

/**
 * `destructiveHint: false`, and deliberately NOT behind COOLIFY_ALLOW_DESTRUCTIVE.
 *
 * A reviewer will question this, so the reasoning is here rather than implied.
 * Stopping production causes downtime, and downtime is not nothing. But the flag
 * answers a narrower question: "can this server destroy something I cannot get
 * back?" A stop destroys no data, removes no configuration, and is undone by the
 * `start` sitting in the same enum of the same tool. Coolify's own destructive
 * operations — the DELETEs, and `POST /disable`, which locks the API token out
 * of its own instance — are what the flag exists for.
 *
 * Putting stop behind the flag would change what the flag means. It would stop
 * being "can I destroy data" and become "can I do anything useful", because
 * start, stop, restart and deploy are the whole point of a Coolify MCP server.
 * Users would then set it as a matter of course during setup, and by the time
 * they reached a real DELETE the flag would be long since on and would signify
 * nothing. A safety switch that everyone turns on immediately protects no one —
 * it just adds a step and teaches people that the warnings are noise.
 *
 * The mitigations that do apply are the honest ones: `readOnly` connections
 * refuse this tool outright at the transport, `instance` is required with no
 * default so a production stop cannot happen through an omitted parameter, and
 * `destructiveHint: false` is truthful, which keeps the host's own confirmation
 * prompts meaningful for the operations that genuinely are destructive.
 */
export const controlResource: ToolDef = {
  name: 'control_resource',
  description:
    'Start, stop or restart an application, database or service on Coolify. Stopping causes downtime but destroys no data and is reversed by starting the same resource. Restart recreates containers from the current image without rebuilding — use deploy to pick up code changes.',
  annotations: {
    title: 'Start, stop or restart a resource',
    readOnlyHint: false,
    // No data is lost and every action is reversed by another action in this
    // same tool. See the note above for the full argument.
    destructiveHint: false,
    // Coolify queues each action, and a start can trigger a deployment, so
    // repeating a call is not guaranteed to be a no-op.
    idempotentHint: false,
    openWorldHint: true,
  },
  surface: 'write',
  inputSchema: (cfg: ServerConfig): Record<string, unknown> => ({
    ...instanceShape(cfg),
    action: ARGS.shape.action,
    resource_type: ARGS.shape.resource_type,
    uuid: ARGS.shape.uuid,
    force: ARGS.shape.force,
    instant_deploy: ARGS.shape.instant_deploy,
    docker_cleanup: ARGS.shape.docker_cleanup,
    latest: ARGS.shape.latest,
  }),
  handler,
};
