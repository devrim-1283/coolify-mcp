/**
 * Redaction, across the ENTIRE tool surface.
 *
 * The rule the design states: a token value is registered in the redaction set
 * the moment it is resolved, and from then on it is `***` in every log line,
 * every error and every tool result. This file is the test that rule cites.
 *
 * It is written as a sweep over `ALL_TOOLS` rather than as a handful of
 * hand-picked cases on purpose. Redaction is a property of the SYSTEM, not of
 * any one handler, and the way it breaks is that somebody adds tool number
 * seventeen with its own error rendering. A sweep fails the moment that happens;
 * three targeted tests would not.
 *
 * Three leak paths are exercised, because they are separate code:
 *
 *   1. the happy path      — the value comes back in a response body
 *   2. the error path      — the value is inside the message of a thrown error
 *   3. the process streams — anything written to stdout or stderr while a
 *                            handler runs (stdout is the MCP protocol stream,
 *                            so a token there is a token on the wire)
 *
 * TWO secrets are used, and the distinction is load-bearing. `OWN_TOKEN` is the
 * connection's own bearer token, which the HTTP client scrubs out of every
 * response before anything else sees it. `FOREIGN_TOKEN` is a second instance's
 * credential sitting in a Coolify environment variable — a completely ordinary
 * thing to find — which that scrub does NOT cover. Only `redact()` stands
 * between it and the transcript, so it is the one that actually tests the
 * redaction set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSecrets, registerSecret } from '../src/config/secrets.js';
import { configureTransport } from '../src/http/client.js';
import { ALL_TOOLS, selectTools } from '../src/tools/register.js';
import type {
  Connection,
  ConnectionRegistry,
  ServerConfig,
  ToolDef,
  ToolResult,
} from '../src/types.js';

/** This connection's bearer token. */
const OWN_TOKEN = '13|abcdefghijklmnopqrstuvwxyz0123456789ABCD';
/** Another instance's token, found inside a Coolify env var. Registered, never sent. */
const FOREIGN_TOKEN = '99|ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw';
/** Never registered anywhere: caught only by the Sanctum-shape backstop. */
const UNSEEN_TOKEN = '7|QqWwEeRrTtYyUuIiOoPpAaSsDdFfGgHhJjKkLlZz';

const ALL_SECRETS = [OWN_TOKEN, FOREIGN_TOKEN, UNSEEN_TOKEN];

/** Halves count too: the secret side of `<id>|<secret>` is a live credential alone. */
function needles(): string[] {
  return ALL_SECRETS.flatMap((token) => [token, token.slice(token.indexOf('|') + 1)]);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function makeConnection(): Connection {
  return {
    name: 'default',
    baseUrl: 'https://coolify.example.com',
    readOnly: false,
    // Open, so the sweep covers all sixteen tools including the destructive door.
    allowDestructive: true,
    timeoutMs: 5_000,
    insecureTLS: false,
    resolveToken: async () => OWN_TOKEN,
  };
}

function makeConfig(): ServerConfig {
  const connection = makeConnection();
  const registry: ConnectionRegistry = {
    connections: new Map([[connection.name, connection]]),
    defaultName: connection.name,
    source: 'env',
    shadowed: [],
  };
  return { registry, allowDestructive: true, readOnly: false, logLevel: 'debug' };
}

// ---------------------------------------------------------------------------
// Arguments that get each tool as far as the transport
// ---------------------------------------------------------------------------

const UUID = 'k8sw4c0';

const ARGS: Record<string, Record<string, unknown>> = {
  find_resources: {},
  get_resource: { resource_type: 'application', uuid: UUID },
  get_logs: { resource_type: 'application', uuid: UUID, lines: 50 },
  get_environment_variables: { resource_type: 'application', uuid: UUID, reveal: true },
  list_deployments: {},
  get_deployment: { uuid: UUID },
  list_servers: {},
  list_projects: {},
  search_operations: { query: 'application' },
  describe_operation: { operation_id: 'get-application-by-uuid' },
  execute_read_operation: { operation_id: 'list-applications', reveal: true },
  deploy: { uuid: UUID, wait: false },
  control_resource: { action: 'restart', resource_type: 'application', uuid: UUID },
  set_environment_variables: {
    resource_type: 'application',
    uuid: UUID,
    variables: [{ key: 'DATABASE_URL', value: 'postgres://localhost/app' }],
  },
  execute_write_operation: { operation_id: 'create-project', body: { name: 'demo' } },
  execute_destructive_operation: {
    operation_id: 'delete-application-by-uuid',
    path_params: { uuid: UUID },
  },
};

function argsFor(tool: ToolDef): Record<string, unknown> {
  const args = ARGS[tool.name];
  // A new tool with no entry here would otherwise be swept with `{}` and pass
  // vacuously by failing validation before it ever renders a response.
  if (args === undefined)
    throw new Error(`security-redaction.test.ts has no arguments for tool "${tool.name}"`);
  return args;
}

// ---------------------------------------------------------------------------
// A response body that leaks in every shape we can think of
// ---------------------------------------------------------------------------

function leakyRow(): Record<string, unknown> {
  return {
    uuid: UUID,
    name: 'api-gateway',
    type: 'application',
    status: 'running:healthy',
    // The Authorization header echoed back, as a request-echo service would.
    echoed_header: `Bearer ${OWN_TOKEN}`,
    // A credential-shaped key holding somebody else's token.
    value: FOREIGN_TOKEN,
    key: 'OTHER_COOLIFY_TOKEN',
    // Free text, the shape a build log takes.
    logs: `curl -H "Authorization: Bearer ${FOREIGN_TOKEN}" https://other.example.com\nexport TOKEN=${UNSEEN_TOKEN}\n`,
    message: `deploy started with ${OWN_TOKEN}`,
    deployment_uuid: UUID,
    application_uuid: UUID,
    status_message: `token ${UNSEEN_TOKEN}`,
    nested: { private_key: FOREIGN_TOKEN, note: `see ${OWN_TOKEN}` },
  };
}

function leakyBody(): string {
  // An array: Coolify list endpoints answer with a bare array and single reads
  // with an object, and `toRecord` reads element zero of an array, so one body
  // serves both.
  return JSON.stringify([leakyRow(), leakyRow()]);
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Stream capture
// ---------------------------------------------------------------------------

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

interface Captured<T> {
  value: T;
  /** Everything written to stdout, stderr or the console while `fn` ran. */
  streams: string;
}

async function capturing<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const chunks: string[] = [];
  const record = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };

  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(record);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(record);
  const consoles = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      chunks.push(parts.map((part) => String(part)).join(' '));
    }),
  );

  try {
    return { value: await fn(), streams: chunks.join('\n') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    for (const spy of consoles) spy.mockRestore();
  }
}

function renderResult(result: ToolResult): string {
  return JSON.stringify(result);
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registerSecret(OWN_TOKEN);
  registerSecret(FOREIGN_TOKEN);
  fetchSpy = vi.fn(async () => jsonResponse(leakyBody()));
  vi.stubGlobal('fetch', fetchSpy);
  configureTransport({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureTransport({});
});

// ---------------------------------------------------------------------------
// The suite is only meaningful if the fixtures really do carry the secrets
// ---------------------------------------------------------------------------

describe('the fixtures themselves', () => {
  it('registers the two secrets that were resolved', () => {
    const secrets = getSecrets();

    expect(secrets).toContain(OWN_TOKEN);
    expect(secrets).toContain(FOREIGN_TOKEN);
    expect(secrets, 'a token nobody resolved must not be in the set').not.toContain(UNSEEN_TOKEN);
  });

  it('puts every secret in the response body, so a pass cannot be vacuous', () => {
    const body = leakyBody();

    for (const secret of ALL_SECRETS) expect(body).toContain(secret);
  });

  it('covers every registered tool', () => {
    // A tool added without an entry in ARGS would silently drop out of the
    // sweep, which is the one way this file can stop protecting anything.
    for (const tool of ALL_TOOLS) expect(Object.keys(ARGS), tool.name).toContain(tool.name);
    expect(selectTools(makeConfig())).toHaveLength(ALL_TOOLS.length);
  });
});

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

describe.each(ALL_TOOLS.map((tool) => [tool.name, tool] as const))(
  '%s — a response body carrying credentials',
  (_name, tool) => {
    it('returns no secret and writes none to stdout or stderr', async () => {
      const captured = await capturing(() => tool.handler(argsFor(tool), makeConfig(), {}));

      const surface = `${renderResult(captured.value)}\n${captured.streams}`;
      for (const needle of needles()) {
        expect(surface, `${tool.name} leaked a credential`).not.toContain(needle);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// 2. The error path
// ---------------------------------------------------------------------------

describe.each(ALL_TOOLS.map((tool) => [tool.name, tool] as const))(
  '%s — an error whose message carries credentials',
  (_name, tool) => {
    it('returns no secret and writes none to stdout or stderr', async () => {
      // A thrown message is the one string a handler can emit without passing
      // through the envelope renderer, so it is the remaining path by which a
      // resolved token could reach the transcript.
      fetchSpy.mockRejectedValue(
        new Error(`connect ECONNREFUSED while sending Bearer ${FOREIGN_TOKEN}`),
      );

      const captured = await capturing(() => tool.handler(argsFor(tool), makeConfig(), {}));

      const surface = `${renderResult(captured.value)}\n${captured.streams}`;
      for (const needle of needles()) {
        expect(surface, `${tool.name} leaked a credential on the error path`).not.toContain(needle);
      }
    });

    it('returns the failure rather than throwing it across the transport', async () => {
      fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:443'));

      await expect(tool.handler(argsFor(tool), makeConfig(), {})).resolves.toBeDefined();
    });
  },
);

// ---------------------------------------------------------------------------
// 3. Coolify's own secrets, and the positive control
// ---------------------------------------------------------------------------

describe('what redaction actually did', () => {
  it('replaced the credentials rather than dropping the fields', async () => {
    // The positive control. Without it, a handler that returned an empty result
    // for every call would pass every assertion above.
    const results = await Promise.all(
      ALL_TOOLS.map(async (tool) =>
        renderResult(await tool.handler(argsFor(tool), makeConfig(), {})),
      ),
    );

    expect(results.filter((text) => text.includes('***')).length).toBeGreaterThan(0);
  });

  it('masks a credential-shaped Coolify value even when `reveal` is set', async () => {
    // `reveal` lifts the mask on COOLIFY's secrets. It has never lifted the mask
    // on ours, and a token belonging to another instance is ours to redact the
    // moment it was registered.
    const envVars = ALL_TOOLS.find((tool) => tool.name === 'get_environment_variables');
    expect(envVars).toBeDefined();

    const result = await envVars?.handler(
      { resource_type: 'application', uuid: UUID, reveal: true },
      makeConfig(),
      {},
    );

    expect(renderResult(result ?? { content: [] })).not.toContain(FOREIGN_TOKEN);
  });

  it('masks a Sanctum-shaped token that was never registered anywhere', async () => {
    const read = ALL_TOOLS.find((tool) => tool.name === 'execute_read_operation');
    fetchSpy.mockResolvedValue(
      jsonResponse(JSON.stringify([{ uuid: UUID, note: `leftover ${UNSEEN_TOKEN}` }])),
    );

    const result = await read?.handler({ operation_id: 'list-applications' }, makeConfig(), {});

    expect(renderResult(result ?? { content: [] })).not.toContain(UNSEEN_TOKEN);
  });

  it('never puts the Authorization header on a stream, even at debug level', async () => {
    const captured = await capturing(async () => {
      for (const tool of ALL_TOOLS) await tool.handler(argsFor(tool), makeConfig(), {});
    });

    expect(captured.streams.toLowerCase()).not.toContain('authorization');
    expect(captured.streams).not.toContain('Bearer ');
  });
});
