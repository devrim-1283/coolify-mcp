/**
 * The MCP server: identity, the registered tool surface, and `instructions`.
 *
 * Transport-agnostic on purpose. `index.ts` attaches stdio; a future
 * `serve --http` attaches something else. Nothing here touches process state,
 * so the server can be built repeatedly in a test.
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, selectTools } from './tools/register.js';
import type { ServerConfig } from './types.js';

export const SERVER_NAME = 'coolify-mcp';

const API_REFERENCE = 'https://coolify.io/docs/api-reference';

/** Reported only when package.json cannot be read, which should not happen. */
const UNKNOWN_VERSION = '0.0.0';

/** Above this, listing every base URL costs more context than it returns. */
const MAX_LISTED_URLS = 5;

/**
 * The version reported in the MCP `initialize` handshake.
 *
 * Read from package.json at runtime rather than duplicated as a constant: a
 * hardcoded string drifts silently at the next release and the number the
 * client displays becomes a lie. `dist/` sits one level under the package root
 * in the published layout and `src/` does in the source tree, so the same
 * relative path serves both.
 */
function packageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export function buildServer(cfg: ServerConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Coolify', version: packageVersion() },
    { instructions: buildInstructions(cfg) },
  );
  registerTools(server, cfg);
  return server;
}

/**
 * The `instructions` string, assembled from the configuration that actually
 * shipped.
 *
 * This lands in the host's system prompt on every turn, which makes it both the
 * highest-leverage string in the server and the most expensive place to be
 * wrong: a sentence naming a tool that was not registered sends the model
 * looking for a door that does not exist, and a sentence describing a gate that
 * is not there is worse than saying nothing. So every clause is read off the
 * REGISTERED SET rather than re-derived from the flags — and the set is taken
 * from `selectTools`, the same gate `registerTools` runs, with no parameter by
 * which a caller could describe a surface that did not ship.
 *
 * Two rules hold for every sentence:
 *   - it states a FACT about this server's configuration or capability surface;
 *   - it never tells the model how to behave. `instructions` is a description
 *     channel, not a prompt. A server that used it to steer the model or to
 *     talk past the host's own system prompt is what Directory review rejects,
 *     and rightly.
 */
export function buildInstructions(cfg: ServerConfig): string {
  const tools = selectTools(cfg);
  const writable = tools.some((tool) => tool.surface !== 'read');
  const destructive = tools.some((tool) => tool.surface === 'destructive');

  const lines = [coreParagraph(cfg, writable)];

  if (!writable) {
    lines.push('This server is running read-only. No write tools are registered.');
  } else if (!destructive) {
    // Recovers, in about 25 tokens, the one fact that registration-time gating
    // would otherwise have thrown away. Suppressed under read-only above,
    // because there the sentence would be false: setting
    // COOLIFY_ALLOW_DESTRUCTIVE alone would not enable anything.
    lines.push(
      'Destructive operations (deletes) are disabled on this server. ' +
        'They can be enabled by setting COOLIFY_ALLOW_DESTRUCTIVE=true and restarting it.',
    );
  }

  const connections = connectionParagraph(cfg, writable);
  if (connections !== undefined) lines.push(connections);

  return lines.join('\n');
}

function coreParagraph(cfg: ServerConfig, writable: boolean): string {
  const several = cfg.registry.connections.size > 1;

  // No count in the plural form: several connections may point at one instance,
  // because a Coolify token is bound to a team and a second team is a second
  // connection. "3 instances" would be a claim we cannot support.
  const subject = several
    ? 'coolify-mcp exposes Coolify PaaS instances through their REST API.'
    : 'coolify-mcp exposes a Coolify PaaS instance through its REST API.';

  const loop = writable
    ? 'Dedicated tools cover the common operator loop: find, inspect, logs, environment variables, deploy, deployment status, start/stop/restart.'
    : 'Dedicated tools cover the read side of the common operator loop: find, inspect, logs, environment variables, deployment status.';

  // ASCII throughout: this string is re-encoded by every host in the chain, and
  // a smart quote is the classic thing to arrive mojibaked in a system prompt.
  const generic = writable
    ? "Everything else in Coolify's REST API is reachable via search_operations -> describe_operation -> execute_read_operation / execute_write_operation."
    : "Everything else in Coolify's REST API is reachable via search_operations -> describe_operation -> execute_read_operation.";

  return [
    subject,
    'Resource UUIDs are not guessable; find_resources locates applications, databases and services by name and returns the uuid and resource_type the other tools require.',
    loop,
    generic,
    `API reference: ${API_REFERENCE}`,
  ].join(' ');
}

/**
 * What the model would otherwise have to call a `list_instances` tool to learn.
 *
 * Stating it here saves a tool slot and a round trip, and it is the only place
 * the model can find out which names the `instance` enum will accept before it
 * has called anything.
 */
function connectionParagraph(cfg: ServerConfig, writable: boolean): string | undefined {
  const connections = [...cfg.registry.connections.values()];
  const [only] = connections;

  if (connections.length === 0) return undefined;
  if (only !== undefined && connections.length === 1) {
    // With one connection the `instance` parameter is absent from every schema,
    // so there is nothing to say about selecting one.
    return `Connected to: ${only.baseUrl}`;
  }

  const listed =
    connections.length <= MAX_LISTED_URLS
      ? connections.map((connection) => `${connection.name} (${connection.baseUrl})`)
      : connections.map((connection) => connection.name);

  const defaultName = cfg.registry.defaultName;
  const selection =
    defaultName === undefined
      ? 'No default connection is configured; every tool requires an explicit instance.'
      : writable
        ? `Reads default to ${defaultName}; write tools require an explicit instance.`
        : `Reads default to ${defaultName}.`;

  return [
    `Connections: ${listed.join(', ')}.`,
    selection,
    'find_resources accepts instance="*" to search all connections.',
  ].join(' ');
}
