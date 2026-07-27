/**
 * list_projects — projects and the environments inside them.
 *
 * The environments are the reason this is a promoted tool rather than something
 * left to the generic read path. Every resource-creation call in Coolify's API
 * takes an environment uuid or name, and there is nowhere else in the tool
 * surface those appear. A project list without them would answer a question
 * nobody asked.
 */

import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse, type EnvelopeMeta } from '../shaping/envelope.js';
import type { Row } from '../shaping/project.js';
import type { ToolDef } from '../types.js';
import {
  assignDefined,
  envelopeInstance,
  instanceProperty,
  isRow,
  pickString,
  resolveConnection,
  runRead,
  toRows,
} from './find-resources.js';

/** Projection allowlist, declared beside the tool so it moves when the tool moves. */
const PROJECT_FIELDS = ['uuid', 'name', 'description', 'created_at', 'updated_at'] as const;

/** Environments are never pruned — they are the payload. */
const PROJECT_PRUNABLE = ['created_at', 'updated_at', 'description'] as const;

/**
 * Environments are projected to identity only. Coolify returns the whole
 * environment model on some releases, and a project with six environments would
 * otherwise cost more than the entire rest of the list.
 */
function buildEnvironments(raw: unknown): Row[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const environments: Row[] = [];
  for (const entry of raw) {
    if (!isRow(entry)) continue;
    const row: Row = {};
    assignDefined(row, 'uuid', pickString(entry, ['uuid']));
    assignDefined(row, 'name', pickString(entry, ['name']));
    if (Object.keys(row).length > 0) environments.push(row);
  }
  return environments;
}

function buildProjectRow(raw: Row): Row {
  const row: Row = {};
  for (const field of PROJECT_FIELDS) {
    assignDefined(row, field, pickString(raw, [field]));
  }
  assignDefined(row, 'environments', buildEnvironments(raw['environments']));
  return row;
}

export const listProjects: ToolDef = {
  name: 'list_projects',
  description:
    'List the projects on a Coolify instance, each with its environments. ' +
    'Returns project uuid, name and description plus the uuid and name of every environment inside it — the identifiers Coolify requires when creating a resource. ' +
    'For the resources already inside those projects use find_resources.',
  annotations: {
    title: 'List projects',
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
        path: '/projects',
        operationId: 'list-projects',
        signal: extra.signal,
      });

      const rows = toRows(response.data).map(buildProjectRow);
      rows.sort((a, b) => String(a['name'] ?? '').localeCompare(String(b['name'] ?? '')));

      const withEnvironments = rows.filter((row) => Array.isArray(row['environments'])).length;
      const notes = [`${rows.length} project(s) on connection \`${connection.name}\`.`];
      notes.push(
        withEnvironments > 0
          ? 'Environment uuids listed here are what resource-creation calls take.'
          : // Older Coolify releases do not embed the relation in the list
            // response, so the absence is a version fact rather than an error.
            'This Coolify version does not embed environments in the project list; get-project-by-uuid returns them via execute_read_operation.',
      );

      const meta: EnvelopeMeta = {
        instance: envelopeInstance(cfg, connection.name),
        total: rows.length,
        hint: notes.join(' '),
      };
      return renderEnvelope(shapeResponse(rows, meta, { prunable: PROJECT_PRUNABLE }));
    }),
};
