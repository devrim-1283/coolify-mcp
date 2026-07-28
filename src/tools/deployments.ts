/**
 * list_deployments and get_deployment — the "why did it fail" pair.
 *
 * TWO ENDPOINTS BEHIND ONE LIST TOOL
 *
 * GET /deployments returns only what is IN FLIGHT. That is the wrong answer to
 * the question people actually ask, because a deploy that failed ten minutes
 * ago is not in flight and would come back as an empty list. Coolify's history
 * lives at GET /deployments/applications/{uuid} — which is also the one and
 * only upstream endpoint that paginates (`skip`/`take`). So `application_uuid`
 * switches between them: absent means "what is running now", present means
 * "this application's history".
 *
 * BUILD LOGS ARE STRIPPED FROM THE ROWS
 *
 * With a `read:sensitive` token, every deployment row carries its complete
 * build log. A handful of rows is megabytes, and it would blow the response
 * budget on the first call every time. The projection allowlist below has no
 * `logs` entry, which is what removes them; get_deployment then returns a
 * bounded tail for the single deployment worth reading.
 */

import { z } from 'zod';
import { coolifyRequest } from '../http/client.js';
import {
  renderEnvelope,
  shapeResponse,
  encodeCursor,
  type EnvelopeMeta,
} from '../shaping/envelope.js';
import { MAX_LOG_BYTES, shapeLogs } from '../shaping/logs.js';
import type { Row } from '../shaping/project.js';
import { CoolifyError } from '../types.js';
import type { ToolDef } from '../types.js';
import {
  boundedInteger,
  copyField,
  envelopeInstance,
  instanceProperty,
  isRow,
  nextCursor,
  optionalString,
  pageHint,
  paginationProperties,
  readPage,
  requiredUuid,
  resolveConnection,
  runRead,
  toRecord,
  toRows,
} from './find-resources.js';

const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 5_000;

/**
 * Projection allowlist. `logs` is absent on purpose — see the file header. Also
 * absent: `application_id`, `destination_id` and the other internal integer ids,
 * which name nothing the API accepts back.
 */
const DEPLOYMENT_FIELDS = [
  'deployment_uuid',
  'application_uuid',
  'application_name',
  'server_name',
  'status',
  'commit',
  'commit_message',
  'pull_request_id',
  'is_webhook',
  'is_api',
  'created_at',
  'updated_at',
  'finished_at',
] as const;

/** Extra context worth carrying on a single deployment but not on every row of a list. */
const DEPLOYMENT_DETAIL_FIELDS = [
  ...DEPLOYMENT_FIELDS,
  'deployment_url',
  'git_type',
  'force_rebuild',
  'restart_only',
  'rollback',
] as const;

const DEPLOYMENT_PRUNABLE = [
  'commit_message',
  'is_api',
  'is_webhook',
  'pull_request_id',
  'updated_at',
  'server_name',
] as const;

function buildDeploymentRow(raw: Row, fields: readonly string[]): Row {
  const row: Row = {};
  // Verbatim, so `pull_request_id: 0` stays a number and `is_webhook: false`
  // stays a boolean rather than being rendered as a string.
  for (const field of fields) copyField(raw, row, field);
  return row;
}

/**
 * Coolify stores a deployment's build log as a JSON-encoded array of entries,
 * each `{output, type, timestamp, hidden, order}` — not as plain text. Rendering
 * it naively hands the model a wall of escaped JSON where a log should be.
 *
 * Both shapes are handled because the encoding has changed across releases and
 * a proxy can hand back either. Entries Coolify marks `hidden` are dropped: the
 * flag exists because those lines are not meant to be displayed, and honouring
 * it here costs nothing.
 */
function renderBuildLog(raw: unknown): string {
  if (typeof raw !== 'string') return fromEntries(raw);

  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return fromEntries(JSON.parse(trimmed));
    } catch {
      // Genuinely plain text that happens to start with a bracket.
    }
  }
  return raw;
}

function fromEntries(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  if (!Array.isArray(parsed))
    return parsed === undefined || parsed === null ? '' : JSON.stringify(parsed);

  const lines: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      lines.push(entry);
      continue;
    }
    if (!isRow(entry)) continue;
    if (entry['hidden'] === true) continue;

    const output = entry['output'];
    lines.push(typeof output === 'string' ? output : JSON.stringify(entry));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// list_deployments
// ---------------------------------------------------------------------------

export const listDeployments: ToolDef = {
  name: 'list_deployments',
  description:
    "List deployments. Without application_uuid it returns the deployments currently in progress on the instance; with it, that application's deployment history, newest first. " +
    `Returns ${DEPLOYMENT_FIELDS.join(', ')} per row. ` +
    'Build logs are stripped from these rows because a single one can be megabytes — get_deployment returns a bounded log tail for one deployment.',
  annotations: {
    title: 'List deployments',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  inputSchema: (cfg) => ({
    application_uuid: z
      .string()
      .optional()
      .describe(
        'Application uuid, as returned by find_resources. Switches from "deployments running right now" to that application\'s history, which is where a finished or failed deployment is found.',
      ),
    ...paginationProperties(DEFAULT_PAGE, MAX_PAGE),
    ...instanceProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runRead(async () => {
      // Read as optional first so an empty string reads as "not given" rather
      // than as a malformed uuid.
      const application =
        optionalString(args, 'application_uuid') === undefined
          ? undefined
          : requiredUuid(args, 'application_uuid');
      const connection = resolveConnection(cfg, args['instance']);
      const page = readPage(
        args,
        { application, instance: connection.name },
        { fallback: DEFAULT_PAGE, max: MAX_PAGE },
      );

      const meta: EnvelopeMeta = { instance: envelopeInstance(cfg, connection.name) };
      const notes: string[] = [];
      let rows: Row[];

      if (application !== undefined) {
        // The one upstream endpoint with real pagination. Using it means we
        // never pull a full deployment history into memory to throw most of it
        // away, and the order Coolify returns (newest first) is preserved.
        const response = await coolifyRequest({
          connection,
          method: 'GET',
          path: `/deployments/applications/${application}`,
          operationId: 'list-deployments-by-app-uuid',
          query: { skip: page.offset, take: page.limit },
          signal: extra.signal,
        });
        rows = toRows(response.data).map((raw) => buildDeploymentRow(raw, DEPLOYMENT_FIELDS));

        notes.push(
          `Deployment history for application ${application}, newest first. Rows ${page.offset + 1}-${page.offset + rows.length}.`,
        );
        // Carried so that if the shaping ladder drops rows to fit the budget,
        // it can recompute next_cursor from what actually shipped instead of
        // stepping over the rows it discarded.
        meta.cursor = { offset: page.offset, queryHash: page.hash };
        // Upstream reports no total, so "there is more" is inferred from a full
        // page. One wasted call at the exact end of the history is the price.
        if (rows.length === page.limit) {
          meta.next_cursor = encodeCursor({
            offset: page.offset + rows.length,
            queryHash: page.hash,
          });
        }
      } else {
        const response = await coolifyRequest({
          connection,
          method: 'GET',
          path: '/deployments',
          operationId: 'list-deployments',
          signal: extra.signal,
        });
        const all = toRows(response.data).map((raw) => buildDeploymentRow(raw, DEPLOYMENT_FIELDS));
        // ISO-8601 sorts correctly as a string, and a stable tiebreak keeps
        // offset pagination coherent across the re-fetch each page performs.
        all.sort((a, b) => {
          const byDate = String(b['created_at'] ?? '').localeCompare(String(a['created_at'] ?? ''));
          return byDate !== 0
            ? byDate
            : String(a['deployment_uuid'] ?? '').localeCompare(String(b['deployment_uuid'] ?? ''));
        });

        rows = all.slice(page.offset, page.offset + page.limit);
        meta.total = all.length;
        meta.cursor = { offset: page.offset, queryHash: page.hash };
        const next = nextCursor(page, rows.length, all.length);
        if (next !== undefined) meta.next_cursor = next;

        notes.push(
          'Deployments in progress right now.',
          pageHint(page.offset, rows.length, all.length),
        );
        if (all.length === 0) {
          notes.push(
            "Nothing is deploying. Passing application_uuid returns that application's finished deployments instead.",
          );
        }
      }

      notes.push(
        'Build logs are omitted from these rows; get_deployment returns the log for one deployment_uuid.',
      );
      meta.hint = notes.join(' ');

      return renderEnvelope(shapeResponse(rows, meta, { prunable: DEPLOYMENT_PRUNABLE }));
    }),
};

// ---------------------------------------------------------------------------
// get_deployment
// ---------------------------------------------------------------------------

export const getDeployment: ToolDef = {
  name: 'get_deployment',
  description:
    'Return one deployment together with a bounded tail of its build log — the record that says why a deployment failed. ' +
    'The log is stripped of ANSI colour codes and trimmed from the front, so the failure at the end always survives. ' +
    "For the list of deployments and their uuids use list_deployments; for the running container's output use get_logs.",
  annotations: {
    title: 'Get deployment',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  inputSchema: (cfg) => ({
    uuid: z
      .string()
      .describe(
        'Deployment uuid — the deployment_uuid field from list_deployments, not the application uuid.',
      ),
    log_lines: z
      .number()
      .int()
      .min(0)
      .max(MAX_LOG_LINES)
      .optional()
      .default(DEFAULT_LOG_LINES)
      .describe(
        `Trailing build-log lines to include, ${MAX_LOG_LINES} maximum. 0 omits the log and returns the deployment record alone.`,
      ),
    ...instanceProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runRead(async () => {
      const uuid = requiredUuid(args, 'uuid');
      const logLines = boundedInteger(args, 'log_lines', {
        fallback: DEFAULT_LOG_LINES,
        min: 0,
        max: MAX_LOG_LINES,
      });
      const connection = resolveConnection(cfg, args['instance']);

      const response = await coolifyRequest({
        connection,
        method: 'GET',
        path: `/deployments/${uuid}`,
        operationId: 'get-deployment-by-uuid',
        signal: extra.signal,
      });

      const record = toRecord(response.data);
      if (record === undefined) {
        throw new CoolifyError(
          `Coolify returned no deployment record for uuid ${uuid}.`,
          'not_found',
          'list_deployments reports deployment_uuid values; an application uuid passed here answers empty.',
        );
      }

      const data = buildDeploymentRow(record, DEPLOYMENT_DETAIL_FIELDS);
      const notes: string[] = [];

      if (logLines === 0) {
        notes.push('Build log omitted: log_lines was 0.');
      } else {
        const rendered = renderBuildLog(record['logs']);
        if (rendered.trim() === '') {
          // Not fatal — a queued deployment has not written anything yet — but
          // it is also what a token without `read:sensitive` sees, and the two
          // are indistinguishable from here.
          notes.push(
            `No build log content. The deployment may not have started writing yet, or the token for connection \`${connection.name}\` may lack the \`read:sensitive\` ability that exposes logs.`,
          );
        } else {
          const shaped = shapeLogs(rendered, { maxLines: logLines, maxBytes: MAX_LOG_BYTES });
          data['logs'] = shaped.text;
          notes.push(
            shaped.truncated
              ? `Build log tail: ${shaped.omittedLines} earlier lines (${shaped.omittedBytes} bytes) were dropped from the front.`
              : 'Complete build log for the requested line count.',
          );
        }
      }

      notes.push(
        "This is build and deploy output. The running container's own logs are in get_logs.",
      );

      const meta: EnvelopeMeta = {
        instance: envelopeInstance(cfg, connection.name),
        count: 1,
        hint: notes.join(' '),
      };
      return renderEnvelope(shapeResponse(data, meta, { prunable: DEPLOYMENT_PRUNABLE }));
    }),
};
