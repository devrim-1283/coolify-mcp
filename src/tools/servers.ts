/**
 * list_servers — the machines behind one Coolify connection.
 *
 * The columns that decide whether anything else will work — `is_reachable` and
 * `is_usable` — do not live on the server row. Coolify keeps them on the
 * `settings` relation, so a naive projection returns a tidy list of servers with
 * no indication that half of them are unreachable. They are lifted onto the row
 * here; that flattening is the whole reason this tool exists rather than
 * leaving servers to the generic read path.
 */

import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse, type EnvelopeMeta } from '../shaping/envelope.js';
import type { Row } from '../shaping/project.js';
import type { ToolDef } from '../types.js';
import {
  assignDefined,
  envelopeInstance,
  instanceProperty,
  pickScalar,
  resolveConnection,
  runRead,
  toRows,
} from './find-resources.js';

/**
 * Projection allowlist, each entry (output column, source paths in preference
 * order). Declared beside the tool so it moves when the tool moves.
 *
 * Deliberately absent: `private_key_id`, the proxy configuration blob and the
 * notification bookkeeping columns. None of them answer a question anyone asks
 * of a server list, and the proxy blob alone is most of the row.
 */
const SERVER_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['uuid', ['uuid']],
  ['name', ['name']],
  ['description', ['description']],
  ['ip', ['ip']],
  ['port', ['port']],
  ['user', ['user']],
  ['is_reachable', ['is_reachable', 'settings.is_reachable']],
  ['is_usable', ['is_usable', 'settings.is_usable']],
  ['is_build_server', ['is_build_server', 'settings.is_build_server']],
  ['is_swarm_manager', ['is_swarm_manager', 'settings.is_swarm_manager']],
  ['created_at', ['created_at']],
  ['updated_at', ['updated_at']],
];

const SERVER_COLUMNS = SERVER_FIELDS.map(([column]) => column);

/** Health first, ssh details last: a server list is read to find what is broken. */
const SERVER_PRUNABLE = ['created_at', 'updated_at', 'description', 'user', 'port', 'is_swarm_manager'] as const;

function buildServerRow(raw: Row): Row {
  const row: Row = {};
  for (const [column, paths] of SERVER_FIELDS) {
    assignDefined(row, column, pickScalar(raw, paths));
  }
  return row;
}

export const listServers: ToolDef = {
  name: 'list_servers',
  description:
    `List the servers this Coolify connection manages. Returns ${SERVER_COLUMNS.join(', ')} for each one, ` +
    'with the reachability and usability flags lifted out of the settings relation so a broken server is visible at a glance. ' +
    'For the resources running on those servers use find_resources.',
  annotations: {
    title: 'List servers',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  surface: 'read',
  inputSchema: (cfg) => ({
    ...instanceProperty(cfg),
  }),
  handler: async (args, cfg, extra) =>
    runRead(async () => {
      const connection = resolveConnection(cfg, args['instance']);

      const response = await coolifyRequest({
        connection,
        method: 'GET',
        path: '/servers',
        operationId: 'list-servers',
        signal: extra.signal,
      });

      const rows = toRows(response.data).map(buildServerRow);
      rows.sort((a, b) => String(a['name'] ?? '').localeCompare(String(b['name'] ?? '')));

      const unreachable = rows.filter((row) => row['is_reachable'] === false).length;
      const notes = [`${rows.length} server(s) on connection \`${connection.name}\`.`];
      if (unreachable > 0) {
        notes.push(`is_reachable=false on ${unreachable} of them; resources on those servers will not respond.`);
      }

      const meta: EnvelopeMeta = {
        instance: envelopeInstance(cfg, connection.name),
        total: rows.length,
        hint: notes.join(' '),
      };
      return renderEnvelope(shapeResponse(rows, meta, { prunable: SERVER_PRUNABLE }));
    }),
};
