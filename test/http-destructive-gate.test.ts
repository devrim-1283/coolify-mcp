/**
 * The destructive gate at the transport layer.
 *
 * This is layer 3 of the three-layer gate (registration -> dispatch ->
 * transport). Layers 1 and 2 live at the tool boundary and can be bypassed by
 * any future tool that forgets them; this one cannot, because every code path
 * in the server reaches Coolify through `coolifyRequest`.
 *
 * The tests therefore assert on the socket, not on the return value: a refused
 * request must never reach `fetch`, and must never even resolve the bearer
 * token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoolifyError } from '../src/types.js';
import type { Connection, ConnectionRegistry, CoolifyRequest, DangerClass } from '../src/types.js';
import { configureTransport, coolifyRequest } from '../src/http/client.js';

const TOKEN = '13|abcdefghijklmnopqrstuvwxyz0123456789ABCD';

let fetchSpy: ReturnType<typeof vi.fn>;
let resolveTokenSpy: ReturnType<typeof vi.fn>;

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    name: 'prod',
    baseUrl: 'https://coolify.example.com',
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 5_000,
    insecureTLS: false,
    resolveToken: resolveTokenSpy,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<CoolifyRequest> = {}): CoolifyRequest {
  return {
    connection: makeConnection(),
    method: 'DELETE',
    path: '/applications/abc-123',
    ...overrides,
  };
}

/** Asserts the promise rejects with a CoolifyError and hands it back for inspection. */
async function refusal(promise: Promise<unknown>): Promise<CoolifyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoolifyError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused, but it resolved');
}

beforeEach(() => {
  resolveTokenSpy = vi.fn(async () => TOKEN);
  fetchSpy = vi.fn(
    async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  configureTransport({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureTransport({});
});

describe('destructive gate (transport layer)', () => {
  it('refuses a DELETE when the connection does not allow destructive operations', async () => {
    const error = await refusal(coolifyRequest(makeRequest()));

    expect(error.kind).toBe('destructive_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a DELETE that arrives through a generic catalog operation id', async () => {
    // The promoted tools are not the only door: `execute_write_operation` can
    // name any catalog operation. The gate must not depend on which tool called.
    const error = await refusal(
      coolifyRequest(makeRequest({ operationId: 'delete-application-by-uuid' })),
    );

    expect(error.kind).toBe('destructive_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses POST /disable, which is destructive without being a DELETE', async () => {
    // Turning the API off locks the token out of its own instance. "Block the
    // DELETEs" would miss it, so the override list is matched by method+path...
    const byPath = await refusal(coolifyRequest(makeRequest({ method: 'POST', path: '/disable' })));
    // ...and by operation id, so a caller cannot dodge it by rewriting the path.
    const byId = await refusal(
      coolifyRequest(
        makeRequest({ method: 'POST', path: '/something-else', operationId: 'disable-api' }),
      ),
    );

    expect(byPath.kind).toBe('destructive_blocked');
    expect(byId.kind).toBe('destructive_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses POST /mcp/disable', async () => {
    const error = await refusal(
      coolifyRequest(makeRequest({ method: 'POST', path: '/mcp/disable' })),
    );

    expect(error.kind).toBe('destructive_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tolerates the /api/v1 prefix when matching the override list', async () => {
    const error = await refusal(
      coolifyRequest(makeRequest({ method: 'POST', path: '/api/v1/disable' })),
    );

    expect(error.kind).toBe('destructive_blocked');
  });

  it('never resolves the bearer token for a refused request', async () => {
    // A blocked call must not touch the secret store at all — no `op read`,
    // no keychain prompt, nothing to leak into a crash dump.
    await refusal(coolifyRequest(makeRequest()));

    expect(resolveTokenSpy).not.toHaveBeenCalled();
  });

  it('names the flag that unblocks it, without echoing the token', async () => {
    const error = await refusal(coolifyRequest(makeRequest()));

    expect(error.hint).toContain('COOLIFY_ALLOW_DESTRUCTIVE');
    expect(JSON.stringify({ message: error.message, hint: error.hint })).not.toContain(TOKEN);
  });

  it('lets the DELETE through when the connection allows destructive operations', async () => {
    // Proves the gate is the only thing standing in the way: same request,
    // one flag flipped, and it reaches the socket.
    const response = await coolifyRequest(
      makeRequest({ connection: makeConnection({ allowDestructive: true }) }),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://coolify.example.com/api/v1/applications/abc-123');
    expect(init.method).toBe('DELETE');
  });
});

describe('destructive classification cannot be weakened', () => {
  it('ignores a catalog classifier that calls a DELETE safe', async () => {
    // The catalog is generated code. A new Coolify release could misfile an
    // operation, so the catalog may only escalate the transport's own verdict.
    configureTransport({ classifyOperation: (): DangerClass => 'safe' });

    const error = await refusal(
      coolifyRequest(makeRequest({ operationId: 'delete-application-by-uuid' })),
    );

    expect(error.kind).toBe('destructive_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours a catalog classifier that escalates a POST to destructive', async () => {
    configureTransport({ classifyOperation: (): DangerClass => 'destructive' });

    const error = await refusal(
      coolifyRequest(
        makeRequest({
          method: 'POST',
          path: '/applications/abc-123/wipe',
          operationId: 'wipe-application',
          body: { confirm: true },
        }),
      ),
    );

    expect(error.kind).toBe('destructive_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the method rule when the classifier throws', async () => {
    configureTransport({
      classifyOperation: () => {
        throw new Error('catalog module exploded');
      },
    });

    const error = await refusal(
      coolifyRequest(makeRequest({ operationId: 'delete-application-by-uuid' })),
    );

    expect(error.kind).toBe('destructive_blocked');
  });
});

describe('gate ordering and the adjacent transport gates', () => {
  it('reports a DELETE on a read-only connection as destructive, not read-only', async () => {
    // Ordering matters for the hint the model gets: telling it to use a
    // writable connection would be wrong advice for an operation that is
    // blocked everywhere.
    const error = await refusal(
      coolifyRequest(makeRequest({ connection: makeConnection({ readOnly: true }) })),
    );

    expect(error.kind).toBe('destructive_blocked');
  });

  it('refuses a write on a read-only connection before the socket opens', async () => {
    const error = await refusal(
      coolifyRequest(
        makeRequest({
          method: 'POST',
          path: '/applications/abc-123/restart',
          connection: makeConnection({ readOnly: true }),
        }),
      ),
    );

    expect(error.kind).toBe('read_only_connection');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolveTokenSpy).not.toHaveBeenCalled();
  });

  it('names a writable sibling connection in the read-only refusal', async () => {
    const readOnly = makeConnection({ name: 'prod', readOnly: true });
    const writable = makeConnection({ name: 'staging', baseUrl: 'https://staging.example.com' });
    const registry: ConnectionRegistry = {
      connections: new Map([
        ['prod', readOnly],
        ['staging', writable],
      ]),
      defaultName: 'prod',
      source: 'env',
      shadowed: [],
    };
    configureTransport({ registry });

    const error = await refusal(
      coolifyRequest(
        makeRequest({
          method: 'POST',
          path: '/applications/abc-123/restart',
          connection: readOnly,
        }),
      ),
    );

    expect(error.hint).toContain('staging');
  });

  it('allows reads on a read-only connection', async () => {
    const response = await coolifyRequest(
      makeRequest({
        method: 'GET',
        path: '/applications',
        connection: makeConnection({ readOnly: true }),
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses to follow a redirect to another host', async () => {
    // Following it would hand the bearer token to the redirect target. This is
    // the highest-value token-exfiltration path in the system.
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://attacker.tld/collect' } }),
    );

    const error = await refusal(
      coolifyRequest(makeRequest({ method: 'GET', path: '/applications' })),
    );

    expect(error.kind).toBe('network');
    expect(error.message.toLowerCase()).toContain('redirect');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(init.redirect).toBe('manual');
  });

  it('refuses a path that tries to escape the connection origin', async () => {
    const error = await refusal(
      coolifyRequest(makeRequest({ method: 'GET', path: '//attacker.tld/applications' })),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error.kind).toBe('validation');
  });
});
