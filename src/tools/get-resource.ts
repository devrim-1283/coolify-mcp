/**
 * get_resource — the full stored configuration of one application, database or
 * service — and the `resource_type` plumbing every polymorphic tool shares.
 *
 * WHY resource_type IS REQUIRED, AND WHY THERE IS NO CACHE
 *
 * Coolify exposes the same shape under three families, and a uuid does not say
 * which one it belongs to. The obvious conveniences are both worse than asking:
 *
 *   - Auto-detection means probing up to three endpoints on every single call,
 *     paying for the ambiguity on the happy path forever.
 *   - A uuid -> type cache introduces a staleness bug class where a resource
 *     created seconds ago reads as "not found", which is the worst possible
 *     moment to be wrong.
 *
 * So the parameter is mandatory and the ERROR PATH does the ergonomic work
 * instead: on 404 the sibling families are probed ONCE and the answer names the
 * correct type. Three requests worst case, only on failure, and it converts the
 * single most likely mistake into a one-turn fix.
 */

import { z } from 'zod';
import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse, type EnvelopeMeta } from '../shaping/envelope.js';
import type { Row } from '../shaping/project.js';
import { redactObject } from '../shaping/redact.js';
import { CoolifyError } from '../types.js';
import type { Connection, ToolDef } from '../types.js';
import {
  envelopeInstance,
  instanceProperty,
  optionalString,
  requiredUuid,
  resolveConnection,
  runRead,
  toRecord,
} from './find-resources.js';

// ---------------------------------------------------------------------------
// Shared polymorphic plumbing
// ---------------------------------------------------------------------------

export const RESOURCE_TYPES = ['application', 'database', 'service'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Singular type as the model says it -> plural path segment as Coolify spells it. */
const FAMILY: Record<ResourceType, string> = {
  application: 'applications',
  database: 'databases',
  service: 'services',
};

export function familyOf(type: ResourceType): string {
  return FAMILY[type];
}

export function resourceTypeProperty(action: string): Record<string, unknown> {
  return {
    resource_type: z
      .enum(RESOURCE_TYPES)
      .describe(
        `Which family the uuid belongs to. Required — a Coolify uuid does not say which family it is in, and ${action} for the wrong one returns 404. find_resources reports the type of every resource it lists.`,
      ),
  };
}

export function readResourceType(args: Record<string, unknown>): ResourceType {
  const raw = optionalString(args, 'resource_type');
  if (raw === undefined) {
    throw new CoolifyError(
      '`resource_type` is required.',
      'validation',
      `One of: ${RESOURCE_TYPES.join(', ')}. find_resources reports the type of every resource it lists.`,
    );
  }
  if (!(RESOURCE_TYPES as readonly string[]).includes(raw)) {
    throw new CoolifyError(`\`resource_type\` must be one of: ${RESOURCE_TYPES.join(', ')}.`, 'validation');
  }
  return raw as ResourceType;
}

/** Per-family operation ids for the single-resource read, used by the 404 probe. */
const GET_OPERATION: Record<ResourceType, string> = {
  application: 'get-application-by-uuid',
  database: 'get-database-by-uuid',
  service: 'get-service-by-uuid',
};

/**
 * Asks the two families the caller did not name whether they own this uuid.
 *
 * Deliberately probes the base resource endpoint rather than the endpoint that
 * failed: a 404 on `/applications/{uuid}/logs` can mean either "no such
 * application" or "that application has no log route", and only the base
 * endpoint distinguishes them. Both probes run in parallel and neither can
 * throw — a failing probe simply means "not this one".
 */
async function probeSiblings(
  connection: Connection,
  type: ResourceType,
  uuid: string,
  signal: AbortSignal | undefined,
): Promise<ResourceType | undefined> {
  const siblings = RESOURCE_TYPES.filter((candidate) => candidate !== type);
  const settled = await Promise.allSettled(
    siblings.map(async (candidate) => {
      await coolifyRequest({
        connection,
        method: 'GET',
        path: `/${FAMILY[candidate]}/${uuid}`,
        operationId: GET_OPERATION[candidate],
        signal,
      });
      return candidate;
    }),
  );
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') return outcome.value;
  }
  return undefined;
}

export interface ResourceRef {
  connection: Connection;
  type: ResourceType;
  uuid: string;
  signal: AbortSignal | undefined;
}

/**
 * Runs a family-scoped request and, if it 404s, spends two extra requests
 * naming the family that does own the uuid. Any other failure passes straight
 * through: the transport's own hints are already better than anything a probe
 * would add.
 */
export async function withTypeProbe<T>(ref: ResourceRef, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof CoolifyError) || error.kind !== 'not_found') throw error;

    const owner = await probeSiblings(ref.connection, ref.type, ref.uuid, ref.signal);
    if (owner === undefined) throw error;

    throw new CoolifyError(
      `No ${ref.type} with uuid ${ref.uuid} on connection \`${ref.connection.name}\`.`,
      'not_found',
      `A ${owner} with that uuid exists — retry with resource_type="${owner}".`,
      404,
    );
  }
}

// ---------------------------------------------------------------------------
// get_resource
// ---------------------------------------------------------------------------

/**
 * No projection: "the full configuration" is the point of this tool, and a
 * record the model cannot see all of would send it straight to
 * execute_read_operation anyway.
 *
 * What is declared instead is the order in which the giants are sacrificed when
 * one record still busts the response budget. A `docker_compose_raw` alone can
 * be hundreds of KB, and losing it is a far better outcome than losing the
 * ninety scalar fields that describe how the resource is wired up.
 */
const RESOURCE_PRUNABLE = [
  'docker_compose_pr_raw',
  'docker_compose_pr',
  'docker_compose_raw',
  'docker_compose',
  'dockerfile',
  'custom_nginx_configuration',
  'description',
] as const;

export const getResource: ToolDef = {
  name: 'get_resource',
  description:
    'Return the complete stored configuration of one application, database or service: build settings, domains, ports, health checks, git source, server placement and timestamps. ' +
    'Values under credential-shaped keys are masked. ' +
    'For a filtered list of resources and their uuids use find_resources; for container output use get_logs; for environment variables use get_environment_variables.',
  annotations: {
    title: 'Get resource',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  inputSchema: (cfg) => ({
    ...resourceTypeProperty('reading'),
    uuid: z.string().describe('Resource uuid, as returned by find_resources.'),
    ...instanceProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runRead(async () => {
      const type = readResourceType(args);
      const uuid = requiredUuid(args, 'uuid');
      const connection = resolveConnection(cfg, args['instance']);
      const ref: ResourceRef = { connection, type, uuid, signal: extra.signal };

      const response = await withTypeProbe(ref, () =>
        coolifyRequest({
          connection,
          method: 'GET',
          path: `/${familyOf(type)}/${uuid}`,
          operationId: GET_OPERATION[type],
          signal: extra.signal,
        }),
      );

      const record = toRecord(response.data);
      if (record === undefined) {
        throw new CoolifyError(
          `Coolify returned no ${type} record for uuid ${uuid}.`,
          'not_found',
          'The request succeeded but the body was empty, which usually means a proxy answered instead of Coolify.',
        );
      }

      // Masked unconditionally: a tool result lands in the chat transcript and
      // in every export of it, and a homelab token is usually a root token that
      // Coolify itself will not redact for. Environment variable values have
      // their own tool with an explicit reveal.
      const masked = redactObject<Row>(record);

      const meta: EnvelopeMeta = {
        instance: envelopeInstance(cfg, connection.name),
        count: 1,
        hint: 'Values under credential-shaped keys are masked. Environment variables are not included here; get_environment_variables returns them.',
      };
      return renderEnvelope(shapeResponse(masked, meta, { prunable: RESOURCE_PRUNABLE }));
    }),
};
