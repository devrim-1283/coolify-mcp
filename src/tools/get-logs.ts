/**
 * get_logs — container runtime output for one application, database or service.
 *
 * THE ERROR PATH THAT MATTERS
 *
 * Log reading needs the `read:sensitive` token ability. A token without it does
 * not get a 403: Coolify answers 200 with an EMPTY BODY. Left undetected that
 * surfaces as "the logs are empty", the user concludes the tool is broken, and
 * the issue tracker fills up with reports that have nothing to do with logging.
 * So an empty body on a 200 is treated as a failure here and named explicitly.
 *
 * The honest complication is that a stopped container legitimately produces no
 * output, so the message states both possibilities rather than asserting the
 * permission problem it cannot actually confirm.
 */

import { z } from 'zod';
import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse, type EnvelopeMeta } from '../shaping/envelope.js';
import { MAX_LOG_BYTES, shapeLogs } from '../shaping/logs.js';
import { CoolifyError } from '../types.js';
import type { ToolDef } from '../types.js';
import {
  boundedInteger,
  envelopeInstance,
  instanceProperty,
  isRow,
  optionalBoolean,
  optionalString,
  requiredUuid,
  resolveConnection,
  runRead,
} from './find-resources.js';
import {
  familyOf,
  readResourceType,
  resourceTypeProperty,
  withTypeProbe,
  type ResourceRef,
  type ResourceType,
} from './get-resource.js';

const DEFAULT_LINES = 200;
const MAX_LINES = 5_000;

const LOG_OPERATION: Record<ResourceType, string> = {
  application: 'get-application-logs-by-uuid',
  database: 'get-database-logs-by-uuid',
  service: 'get-service-logs-by-uuid',
};

/**
 * Coolify wraps log output in `{"logs": "..."}`, but proxies and older releases
 * have been seen returning the bare string. Both are accepted; anything else
 * falls back to the raw JSON so an unrecognised shape is visible rather than
 * silently reported as empty.
 */
function extractLogText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!isRow(data)) return '';

  for (const key of ['logs', 'log', 'output']) {
    const value = data[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .join('\n');
    }
  }
  return Object.keys(data).length > 0 ? JSON.stringify(data) : '';
}

function emptyLogsError(type: ResourceType, uuid: string, connection: string): CoolifyError {
  return new CoolifyError(
    'Logs were empty. This Coolify API token may lack the `read:sensitive` ability, which is required to read logs.',
    'forbidden',
    `Coolify answers 200 with an empty body in that case rather than 403, so an empty result cannot be told apart from a genuinely silent container. ` +
      `A stopped or just-created ${type} also produces no output — get_resource on ${uuid} reports its status. ` +
      `Token abilities are fixed when the token is created, so a token without \`read:sensitive\` has to be replaced for connection \`${connection}\`.`,
    200,
  );
}

export const getLogs: ToolDef = {
  name: 'get_logs',
  description:
    'Tail the container runtime logs of one application, database or service. ' +
    'Returns the most recent lines with ANSI colour codes stripped, trimmed from the front to fit the response budget so the newest output always survives. ' +
    'These are the logs of the running container. For build and deploy output — why a deployment failed — use get_deployment instead.',
  annotations: {
    title: 'Get container logs',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  inputSchema: (cfg) => ({
    ...resourceTypeProperty('reading logs'),
    uuid: z.string().describe('Resource uuid, as returned by find_resources.'),
    lines: z
      .number()
      .int()
      .min(1)
      .max(MAX_LINES)
      .optional()
      .default(DEFAULT_LINES)
      .describe(
        `How many trailing lines to ask Coolify for. The output is additionally capped at ${MAX_LOG_BYTES} bytes.`,
      ),
    show_timestamps: z
      .boolean()
      .optional()
      .describe(
        'Prefix each line with the container timestamp. Off by default because timestamps roughly double the payload.',
      ),
    sub_service_name: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Names one container inside a service. Only meaningful when resource_type is "service", which can hold several containers.',
      ),
    ...instanceProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runRead(async () => {
      const type = readResourceType(args);
      const uuid = requiredUuid(args, 'uuid');
      const lines = boundedInteger(args, 'lines', {
        fallback: DEFAULT_LINES,
        min: 1,
        max: MAX_LINES,
      });
      const timestamps = optionalBoolean(args, 'show_timestamps', false);
      const subService = optionalString(args, 'sub_service_name');
      const connection = resolveConnection(cfg, args['instance']);
      const ref: ResourceRef = { connection, type, uuid, signal: extra.signal };

      const response = await withTypeProbe(ref, () =>
        coolifyRequest({
          connection,
          method: 'GET',
          path: `/${familyOf(type)}/${uuid}/logs`,
          operationId: LOG_OPERATION[type],
          // `show_timestamps` is only sent when asked for: Coolify's default is
          // off, and sending `false` explicitly is a needless difference from
          // what a plain curl would do.
          query: {
            lines,
            ...(timestamps ? { show_timestamps: true } : {}),
            ...(subService === undefined ? {} : { sub_service_name: subService }),
          },
          signal: extra.signal,
        }),
      );

      const raw = extractLogText(response.data);
      if (raw.trim() === '') throw emptyLogsError(type, uuid, connection.name);

      // Both bounds apply: `lines` is what Coolify was asked for and cannot be
      // trusted to have been honoured, and the byte cap is what a single 40 KB
      // stack trace makes necessary regardless of line count.
      const shaped = shapeLogs(raw, { maxLines: lines, maxBytes: MAX_LOG_BYTES });

      const notes = [
        shaped.truncated
          ? `Tail only: ${shaped.omittedLines} earlier lines (${shaped.omittedBytes} bytes) were dropped from the front.`
          : 'Complete output for the requested line count.',
        'Runtime logs only. Build and deployment output is in get_deployment.',
      ];

      const meta: EnvelopeMeta = {
        instance: envelopeInstance(cfg, connection.name),
        count: 1,
        hint: notes.join(' '),
      };
      return renderEnvelope(
        shapeResponse(
          {
            resource_type: type,
            uuid,
            lines_requested: lines,
            truncated: shaped.truncated,
            logs: shaped.text,
          },
          meta,
        ),
      );
    }),
};
