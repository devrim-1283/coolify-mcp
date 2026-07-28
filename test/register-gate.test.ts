/**
 * The registration gate.
 *
 * Layer 1 of three (registration -> dispatch -> transport). The transport test
 * proves nothing destructive can leave the process; this file proves the
 * weaker but far more visible property that a disabled capability is not even
 * ADVERTISED.
 *
 * That matters because tools/list is what a host's permission model is built
 * on. A destructive-hinted tool in a server that cannot destroy anything makes
 * every consent decision downstream of it wrong — the host asks the user to
 * approve a danger that does not exist, or auto-approves on a hint that no
 * longer describes the server. So the assertion is not merely "the tool
 * refuses"; it is "no registered tool carries destructiveHint: true".
 */

import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../src/server.js';
import { ALL_TOOLS, selectTools } from '../src/tools/register.js';
import type { Connection, ConnectionRegistry, ServerConfig } from '../src/types.js';

const READ_TOOLS = [
  'find_resources',
  'get_resource',
  'get_logs',
  'get_environment_variables',
  'list_deployments',
  'get_deployment',
  'list_servers',
  'list_projects',
  'search_operations',
  'describe_operation',
  'execute_read_operation',
];

const WRITE_TOOLS = [
  'deploy',
  'control_resource',
  'set_environment_variables',
  'execute_write_operation',
];

const DESTRUCTIVE_TOOL = 'execute_destructive_operation';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ConnectionOptions {
  name?: string;
  baseUrl?: string;
  readOnly?: boolean;
  allowDestructive?: boolean;
}

function makeConnection(options: ConnectionOptions = {}): Connection {
  return {
    name: options.name ?? 'default',
    baseUrl: options.baseUrl ?? 'https://coolify.example.com',
    readOnly: options.readOnly ?? false,
    allowDestructive: options.allowDestructive ?? false,
    timeoutMs: 30_000,
    insecureTLS: false,
    // Never called: registration is a pure decision over configuration, and a
    // gate that had to resolve a token to decide would be a gate with a network
    // dependency.
    resolveToken: () => Promise.reject(new Error('token must not be resolved during registration')),
  };
}

interface ConfigOptions {
  connections?: Connection[];
  defaultName?: string;
  /** Overrides the derived process-wide flags, to test them disagreeing. */
  readOnly?: boolean;
  allowDestructive?: boolean;
}

/**
 * Mirrors `toServerConfig` in src/index.ts: the process-wide flags are a
 * summary of the resolved connections, never a second parse of the
 * environment. The overrides exist only so the tests can drive the two halves
 * of the gate apart.
 */
function makeConfig(options: ConfigOptions = {}): ServerConfig {
  const connections = options.connections ?? [makeConnection()];
  const registry: ConnectionRegistry = {
    connections: new Map(connections.map((connection) => [connection.name, connection])),
    source: 'env',
    shadowed: [],
  };
  if (options.defaultName !== undefined) registry.defaultName = options.defaultName;
  else if (connections.length === 1) registry.defaultName = connections[0]?.name;

  return {
    registry,
    readOnly: options.readOnly ?? connections.every((connection) => connection.readOnly),
    allowDestructive:
      options.allowDestructive ??
      connections.some((connection) => connection.allowDestructive && !connection.readOnly),
    logLevel: 'info',
  };
}

function namesFor(cfg: ServerConfig): string[] {
  return selectTools(cfg).map((tool) => tool.name);
}

// ---------------------------------------------------------------------------
// The catalogue itself
// ---------------------------------------------------------------------------

describe('the tool surface', () => {
  it('holds 16 tools with unique names', () => {
    const names = ALL_TOOLS.map((tool) => tool.name);

    expect(ALL_TOOLS).toHaveLength(16);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS, DESTRUCTIVE_TOOL].sort());
  });

  it('gives every tool the annotations the tool contract requires', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.annotations.title, tool.name).toBeTruthy();
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.openWorldHint, tool.name).toBe('boolean');
      // Only the read surface may claim to be read-only, and only the
      // destructive surface may claim to destroy. The annotations are what a
      // host builds its permission prompts on, so they have to agree with the
      // surface the gate sorts by.
      expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.surface === 'read');
      expect(tool.annotations.destructiveHint, tool.name).toBe(tool.surface === 'destructive');
    }
  });
});

// ---------------------------------------------------------------------------
// The destructive gate
// ---------------------------------------------------------------------------

describe('the destructive gate', () => {
  it('registers 15 tools by default and omits execute_destructive_operation entirely', () => {
    const names = namesFor(makeConfig());

    expect(names).toHaveLength(15);
    expect(names).not.toContain(DESTRUCTIVE_TOOL);
    expect([...names].sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it('leaves no tool carrying destructiveHint when the flag is off', () => {
    // The whole point of gating at registration rather than at call time: with
    // the door removed, the hint disappears from the list with it, and the
    // host's permission model matches the server's real capability exactly.
    for (const tool of selectTools(makeConfig())) {
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });

  it('registers 16 tools when the flag is on, and only that one is destructive', () => {
    const cfg = makeConfig({ connections: [makeConnection({ allowDestructive: true })] });
    const tools = selectTools(cfg);

    expect(tools).toHaveLength(16);
    expect(tools.map((tool) => tool.name)).toContain(DESTRUCTIVE_TOOL);
    expect(
      tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name),
    ).toEqual([DESTRUCTIVE_TOOL]);
  });

  it('keeps the door shut when only the process-wide flag is on', () => {
    // COOLIFY_ALLOW_DESTRUCTIVE=true while every connection opted out: nothing
    // could be destroyed, so advertising the tool would be a lie.
    const cfg = makeConfig({
      connections: [makeConnection({ allowDestructive: false })],
      allowDestructive: true,
    });

    expect(namesFor(cfg)).not.toContain(DESTRUCTIVE_TOOL);
  });

  it('keeps the door shut when only a connection opted in', () => {
    const cfg = makeConfig({
      connections: [makeConnection({ allowDestructive: true })],
      allowDestructive: false,
    });

    expect(namesFor(cfg)).not.toContain(DESTRUCTIVE_TOOL);
  });

  it('keeps the door shut on a read-only server even with the flag on', () => {
    // Read-only is a ceiling: it is checked before anything that could widen it.
    const cfg = makeConfig({
      connections: [makeConnection({ readOnly: true, allowDestructive: true })],
      allowDestructive: true,
    });

    expect(namesFor(cfg)).not.toContain(DESTRUCTIVE_TOOL);
  });

  it('registers the door when one connection of several opted in', () => {
    const cfg = makeConfig({
      connections: [
        makeConnection({ name: 'prod' }),
        makeConnection({ name: 'lab', allowDestructive: true }),
      ],
      defaultName: 'prod',
    });

    expect(namesFor(cfg)).toContain(DESTRUCTIVE_TOOL);
  });
});

// ---------------------------------------------------------------------------
// The read-only gate
// ---------------------------------------------------------------------------

describe('the read-only gate', () => {
  it('registers exactly the 11 read tools', () => {
    const cfg = makeConfig({ connections: [makeConnection({ readOnly: true })] });
    const tools = selectTools(cfg);

    expect(tools).toHaveLength(11);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.surface, tool.name).toBe('read');
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });

  it('drops the write tools when the process-wide flag is set', () => {
    // COOLIFY_READ_ONLY tightens every connection in config/resolve.ts, but the
    // gate must hold on the flag alone: it is a kill switch, and a kill switch
    // that depends on another layer having done its job is not one.
    const cfg = makeConfig({ readOnly: true });
    const names = namesFor(cfg);

    expect(names).toHaveLength(11);
    for (const write of [...WRITE_TOOLS, DESTRUCTIVE_TOOL]) {
      expect(names).not.toContain(write);
    }
  });

  it('keeps the write tools while any connection can still write', () => {
    const cfg = makeConfig({
      connections: [
        makeConnection({ name: 'prod', readOnly: true }),
        makeConnection({ name: 'lab' }),
      ],
      defaultName: 'prod',
    });

    expect(namesFor(cfg)).toHaveLength(15);
  });

  it('drops the write tools when every connection is read-only', () => {
    const cfg = makeConfig({
      connections: [
        makeConnection({ name: 'prod', readOnly: true }),
        makeConnection({ name: 'lab', readOnly: true }),
      ],
      defaultName: 'prod',
    });

    expect(namesFor(cfg)).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// Instructions — the surface described must be the surface registered
// ---------------------------------------------------------------------------

describe('instructions', () => {
  it('states how to enable destructive operations exactly when they are disabled', () => {
    const disabled = buildInstructions(makeConfig());
    const enabled = buildInstructions(
      makeConfig({ connections: [makeConnection({ allowDestructive: true })] }),
    );

    expect(disabled).toContain('COOLIFY_ALLOW_DESTRUCTIVE=true');
    expect(enabled).not.toContain('COOLIFY_ALLOW_DESTRUCTIVE');
  });

  it('says nothing about enabling destructive operations on a read-only server', () => {
    // Setting COOLIFY_ALLOW_DESTRUCTIVE would not enable anything here, so the
    // sentence would be false — and a false sentence in the system prompt costs
    // more than the missing one.
    const text = buildInstructions(
      makeConfig({ connections: [makeConnection({ readOnly: true })] }),
    );

    expect(text).toContain('read-only');
    expect(text).not.toContain('COOLIFY_ALLOW_DESTRUCTIVE');
  });

  it('names no tool it did not register', () => {
    const cfg = makeConfig({ connections: [makeConnection({ readOnly: true })] });
    const registered = new Set(namesFor(cfg));
    const text = buildInstructions(cfg);

    for (const name of [...READ_TOOLS, ...WRITE_TOOLS, DESTRUCTIVE_TOOL]) {
      if (registered.has(name)) continue;
      // Word-bounded: the read-only text legitimately says "deployment status",
      // and a bare substring check would read that as naming the `deploy` tool.
      expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('gives the base URL and no instance guidance for a single connection', () => {
    // With one connection the `instance` parameter is absent from every schema,
    // so there is nothing to select and nothing to say about selecting it.
    const text = buildInstructions(makeConfig());

    expect(text).toContain('Connected to: https://coolify.example.com');
    expect(text).not.toContain('Connections:');
    expect(text).not.toContain('instance="*"');
    expect(text).not.toContain('explicit instance');
  });

  it('names every connection with its URL up to five of them', () => {
    const cfg = makeConfig({
      connections: [
        makeConnection({ name: 'prod', baseUrl: 'https://coolify.example.com' }),
        makeConnection({ name: 'acme', baseUrl: 'https://coolify.acme.dev' }),
      ],
      defaultName: 'prod',
    });
    const text = buildInstructions(cfg);

    expect(text).toContain('prod (https://coolify.example.com)');
    expect(text).toContain('acme (https://coolify.acme.dev)');
    expect(text).toContain('Reads default to prod');
    expect(text).toContain('write tools require an explicit instance');
    expect(text).toContain('instance="*"');
  });

  it('drops the URLs past five connections', () => {
    const connections = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
      makeConnection({ name, baseUrl: `https://${name}.example.com` }),
    );
    const text = buildInstructions(makeConfig({ connections, defaultName: 'a' }));

    expect(text).toContain('Connections: a, b, c, d, e, f.');
    expect(text).not.toContain('https://a.example.com');
  });

  it('says every tool needs an explicit instance when no default was designated', () => {
    const cfg = makeConfig({
      connections: [makeConnection({ name: 'prod' }), makeConnection({ name: 'acme' })],
    });
    const text = buildInstructions(cfg);

    expect(text).toContain('No default connection is configured');
    expect(text).not.toContain('Reads default to');
  });

  it('never tells the model what to do', () => {
    // Directory review treats an instructions block that steers the model — or
    // talks past the host's system prompt — as prompt injection. Every sentence
    // must be a fact about this server.
    const text = buildInstructions(makeConfig()).toLowerCase();

    for (const directive of ['you must', 'you should', 'always call', 'never call', 'do not use']) {
      expect(text, directive).not.toContain(directive);
    }
  });
});
