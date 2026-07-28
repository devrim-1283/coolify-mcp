/**
 * get_environment_variables — the environment of one application, database or
 * service, with `created_at` and `updated_at` per variable.
 *
 * The timestamps are not padding. "Which variable changed, and when" is what
 * connects a behaviour change to a configuration change, and it is the fastest
 * route from "this stopped working on Tuesday" to a cause. Coolify's own UI
 * does not put it in front of you; this tool does.
 *
 * Values are masked by default. Not because Coolify hides them — a root token
 * gets everything in the clear — but because a tool result is not a private
 * channel: it lands in the transcript, in whatever the host persists, and in
 * any conversation export the user later shares. `reveal` lifts the mask when
 * reading the value is genuinely the task.
 */

import { z } from 'zod';
import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse, type EnvelopeMeta } from '../shaping/envelope.js';
import type { Row } from '../shaping/project.js';
import { MASK } from '../shaping/redact.js';
import type { ToolDef } from '../types.js';
import {
  copyField,
  envelopeInstance,
  instanceProperty,
  optionalBoolean,
  requiredUuid,
  resolveConnection,
  runRead,
  toRows,
} from './find-resources.js';
import {
  familyOf,
  readResourceType,
  resourceTypeProperty,
  withTypeProbe,
  type ResourceRef,
  type ResourceType,
} from './get-resource.js';

const ENVS_OPERATION: Record<ResourceType, string> = {
  application: 'list-envs-by-application-uuid',
  database: 'list-envs-by-database-uuid',
  service: 'list-envs-by-service-uuid',
};

/**
 * Projection allowlist. Coolify returns the whole Eloquent row per variable;
 * these are the columns that answer a question. Declared here, beside the tool
 * it belongs to, so it moves when the tool moves.
 */
const ENV_FIELDS = [
  'uuid',
  'key',
  'value',
  'real_value',
  'is_build_time',
  'is_preview',
  'is_literal',
  'is_multiline',
  'is_shown_once',
  'created_at',
  'updated_at',
] as const;

/** Booleans and the resolved duplicate go first; `key`, `value` and the timestamps are the tool. */
const ENV_PRUNABLE = [
  'real_value',
  'is_shown_once',
  'is_multiline',
  'is_literal',
  'is_preview',
  'is_build_time',
] as const;

/** The two columns that carry the secret itself. */
const VALUE_FIELDS = ['value', 'real_value'] as const;

function buildEnvRow(raw: Row, reveal: boolean): Row {
  const row: Row = {};
  // Copied verbatim rather than picked: `"value": ""` has to survive. A
  // variable set to the empty string is a real configuration, and frequently
  // the bug being looked for.
  for (const field of ENV_FIELDS) copyField(raw, row, field);
  if (reveal) return row;

  for (const field of VALUE_FIELDS) {
    const value = row[field];
    // Empty stays empty: masking `""` to `***` would assert that a value exists,
    // and "the variable is set to nothing" is frequently the actual bug.
    if (typeof value === 'string' && value.length > 0) row[field] = MASK;
  }
  return row;
}

export const getEnvironmentVariables: ToolDef = {
  name: 'get_environment_variables',
  description:
    'List the environment variables of one application, database or service, including whether each is build-time or preview-only and when it was created and last changed. ' +
    'Values are masked unless reveal is set; keys, flags and timestamps are always shown. ' +
    "For the rest of a resource's configuration use get_resource.",
  annotations: {
    title: 'Get environment variables',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  inputSchema: (cfg) => ({
    ...resourceTypeProperty('reading environment variables'),
    uuid: z.string().describe('Resource uuid, as returned by find_resources.'),
    reveal: z
      .boolean()
      .optional()
      .describe(
        'Return values in clear text. Off by default because tool results land in the chat transcript and in any export of it.',
      ),
    ...instanceProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runRead(async () => {
      const type = readResourceType(args);
      const uuid = requiredUuid(args, 'uuid');
      const reveal = optionalBoolean(args, 'reveal', false);
      const connection = resolveConnection(cfg, args['instance']);
      const ref: ResourceRef = { connection, type, uuid, signal: extra.signal };

      const response = await withTypeProbe(ref, () =>
        coolifyRequest({
          connection,
          method: 'GET',
          path: `/${familyOf(type)}/${uuid}/envs`,
          operationId: ENVS_OPERATION[type],
          signal: extra.signal,
        }),
      );

      const rows = toRows(response.data).map((raw) => buildEnvRow(raw, reveal));
      // Sorted by key rather than left in insertion order: an environment is
      // read by scanning for a name, and Coolify's order is creation order.
      rows.sort((a, b) => String(a['key'] ?? '').localeCompare(String(b['key'] ?? '')));

      const notes = [
        reveal
          ? 'Values are shown in clear text.'
          : 'Values are masked; the reveal parameter returns them in clear text.',
      ];
      if (rows.length === 0) {
        // Not an error: plenty of resources genuinely have no variables. But a
        // token without `read:sensitive` also produces a thin result here, and
        // saying so costs one sentence.
        notes.push(
          `This ${type} has no environment variables set, or the token for connection \`${connection.name}\` lacks the \`read:sensitive\` ability that exposes them.`,
        );
      }

      const meta: EnvelopeMeta = {
        instance: envelopeInstance(cfg, connection.name),
        total: rows.length,
        hint: notes.join(' '),
      };
      return renderEnvelope(shapeResponse(rows, meta, { prunable: ENV_PRUNABLE }));
    }),
};
