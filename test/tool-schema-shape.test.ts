/**
 * The published shape of every tool's input schema.
 *
 * This file exists because of a silent regression, and its job is to make that
 * class of regression loud.
 *
 * `tools/list` is the only description of this server a model ever sees. Under
 * Zod 3 the SDK converted each tool's parameter shape with `zod-to-json-schema`,
 * which stamps `additionalProperties: false` onto every object. Zod 4's own
 * converter reserves that keyword for `z.strictObject`, so the Zod 4 bump
 * dropped it from all thirteen tools that take parameters — with green tests,
 * a green type check and a passing MCP handshake, because nothing in the suite
 * looked at the schema that actually goes out on the wire.
 *
 * The consequence is not a crash. It is a model that invents a `is_secret` on
 * `set_environment_variables` or a `limit` on `get_resource`, has it silently
 * dropped, and spends a round trip working out why the call did nothing. That
 * is exactly the kind of failure the rest of this codebase spends its budget
 * avoiding.
 *
 * So these assertions run against the real conversion — an `McpServer` with the
 * tools registered on it, asked over the protocol — and not against our own
 * idea of what the conversion does.
 */

import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerTools } from '../src/tools/register.js';
import type { Connection, ConnectionRegistry, ServerConfig } from '../src/types.js';

interface ListedTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

function makeConnection(name: string, allowDestructive = false): Connection {
  return {
    name,
    baseUrl: 'https://coolify.example.com',
    readOnly: false,
    allowDestructive,
    timeoutMs: 30_000,
    insecureTLS: false,
    resolveToken: () => Promise.reject(new Error('no token should be resolved for tools/list')),
  };
}

function makeConfig(connections: Connection[]): ServerConfig {
  const registry: ConnectionRegistry = {
    connections: new Map(connections.map((connection) => [connection.name, connection])),
    source: 'env',
    shadowed: [],
  };
  if (connections.length === 1) registry.defaultName = connections[0]?.name;
  return {
    registry,
    readOnly: false,
    allowDestructive: connections.some((connection) => connection.allowDestructive),
    logLevel: 'info',
  };
}

/** Registers the tools on a real server and reads them back over the protocol. */
async function listTools(cfg: ServerConfig): Promise<ListedTool[]> {
  const server = new McpServer({ name: 'coolify-mcp', version: '0.0.0-test' });
  registerTools(server, cfg);

  const client = new Client({ name: 'schema-shape-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  await client.close();
  await server.close();

  return listed.tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
  }));
}

/** Every object node in a JSON Schema, paired with the path that reaches it. */
function objectNodes(schema: unknown, path: string): Array<[string, Record<string, unknown>]> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const node = schema as Record<string, unknown>;
  const here: Array<[string, Record<string, unknown>]> =
    node['type'] === 'object' && node['properties'] !== undefined ? [[path, node]] : [];
  return Object.entries(node).reduce(
    (acc, [key, value]) => [...acc, ...objectNodes(value, `${path}.${key}`)],
    here,
  );
}

describe('published tool input schemas', () => {
  it('closes every object node to unknown properties', async () => {
    // Both connections so the `instance` parameter is present, and destructive
    // enabled so the sixteenth tool is registered too: this must cover the
    // widest surface the server can publish, not the narrowest.
    const tools = await listTools(
      makeConfig([makeConnection('prod', true), makeConnection('staging', true)]),
    );

    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      for (const [path, node] of objectNodes(tool.inputSchema, tool.name)) {
        // `false`, not merely present: `additionalProperties: {}` is what a
        // `z.record` emits for its value schema, and that means the opposite.
        expect(
          node['additionalProperties'],
          `${path} does not close itself to unknown properties`,
        ).toBe(false);
      }
    }
  });

  it('keeps parsing lenient, so an unknown property is dropped and not refused', async () => {
    // The other half of the contract, and the reason `.meta()` is used rather
    // than `z.strictObject`. The schema tells a model not to invent properties;
    // a host that decorates arguments with its own metadata must not have its
    // calls rejected over it.
    const { z } = await import('zod');
    const schema = z.object({ uuid: z.string() }).meta({ additionalProperties: false });

    const parsed = schema.safeParse({ uuid: 'abc', invented_by_the_model: true });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ uuid: 'abc' });
  });

  it('names every tool it published, so a dropped tool cannot pass as a passing sweep', async () => {
    const tools = await listTools(makeConfig([makeConnection('prod', true)]));

    expect(tools.map((tool) => tool.name)).toContain('find_resources');
    expect(tools.map((tool) => tool.name)).toContain('set_environment_variables');
    expect(tools.map((tool) => tool.name)).toContain('execute_destructive_operation');
  });
});
