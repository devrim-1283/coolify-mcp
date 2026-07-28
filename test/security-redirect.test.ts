/**
 * Cross-origin redirect refusal, against real HTTP servers.
 *
 * This is the highest-value token-exfiltration path in the whole system. A
 * Coolify instance sits behind whatever reverse proxy its owner set up; if any
 * of them ever answers the API with a 302, an HTTP client that followed it
 * would replay the request — Authorization header and all — against the host
 * the redirect named. One header, one hop, and a root PaaS credential is on
 * somebody else's server.
 *
 * A mocked `fetch` cannot prove this: `redirect: 'manual'` is an instruction to
 * the runtime, and asserting that we passed it is asserting on our own input.
 * So these tests run two real `node:http` servers and assert on the one thing
 * that actually matters — the second server never receives a request, and
 * therefore never receives the token.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureTransport, coolifyRequest } from '../src/http/client.js';
import { CoolifyError } from '../src/types.js';
import type { Connection } from '../src/types.js';

const TOKEN = '13|abcdefghijklmnopqrstuvwxyz0123456789ABCD';

interface Recorder {
  server: Server;
  origin: string;
  hostname: string;
  port: number;
  /** Every request the server saw, in order. */
  received: Array<{ url: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

type Responder = (request: IncomingMessage) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

async function listen(hostname: string, responder: Responder): Promise<Recorder> {
  const received: Recorder['received'] = [];

  const server = createServer((request, response) => {
    received.push({ url: request.url ?? '', authorization: request.headers.authorization });
    const reply = responder(request);
    response.writeHead(reply.status, reply.headers ?? {});
    response.end(reply.body ?? '');
  });

  await new Promise<void>((resolve) => server.listen(0, hostname, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    origin: `http://${hostname}:${port}`,
    hostname,
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function connectionTo(origin: string, overrides: Partial<Connection> = {}): Connection {
  return {
    name: 'prod',
    baseUrl: origin,
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 5_000,
    insecureTLS: false,
    resolveToken: async () => TOKEN,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<CoolifyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoolifyError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused, but it resolved');
}

const JSON_OK = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
};

// 127.0.0.1 and localhost resolve to the same interface but are different
// hostnames, which is exactly the cross-host case without needing DNS.
let instance: Recorder;
let attacker: Recorder;

beforeEach(() => {
  configureTransport({});
});

afterEach(async () => {
  configureTransport({});
  await instance?.close();
  await attacker?.close();
});

describe('cross-host redirects', () => {
  it('refuses to follow one, and the target never sees a request', async () => {
    attacker = await listen('127.0.0.1', () => JSON_OK);
    instance = await listen('localhost', () => ({
      status: 302,
      headers: { location: `${attacker.origin}/collect` },
    }));

    const error = await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        path: '/applications',
      }),
    );

    expect(error.kind).toBe('network');
    expect(error.message.toLowerCase()).toContain('cross-host redirect');
    // The assertion the whole file exists for.
    expect(attacker.received).toEqual([]);
  });

  it('sends the bearer token to the pinned origin and to nowhere else', async () => {
    // The token going to the instance is correct and expected; the test would be
    // vacuous if the request had simply never been made.
    attacker = await listen('127.0.0.1', () => JSON_OK);
    instance = await listen('localhost', () => ({
      status: 307,
      headers: { location: `${attacker.origin}/collect` },
    }));

    await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        path: '/applications',
      }),
    );

    expect(instance.received).toHaveLength(1);
    expect(instance.received[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(attacker.received.map((entry) => entry.authorization)).toEqual([]);
  });

  it.each([301, 302, 303, 307, 308])('refuses a %s the same way', async (status) => {
    attacker = await listen('127.0.0.1', () => JSON_OK);
    instance = await listen('localhost', () => ({
      status,
      headers: { location: `${attacker.origin}/collect` },
    }));

    const error = await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        path: '/applications',
      }),
    );

    expect(error.kind).toBe('network');
    expect(attacker.received).toEqual([]);
  });

  it('says the token was not sent onward, so the reader knows what to do next', async () => {
    attacker = await listen('127.0.0.1', () => JSON_OK);
    instance = await listen('localhost', () => ({
      status: 302,
      headers: { location: `${attacker.origin}/collect` },
    }));

    const error = await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        path: '/applications',
      }),
    );

    expect(error.hint).toContain('was not sent to the redirect target');
    // Neither half of the credential may appear in text that will be rendered
    // into a transcript.
    const rendered = `${error.message} ${error.hint ?? ''}`;
    expect(rendered).not.toContain(TOKEN);
    expect(rendered).not.toContain(TOKEN.slice(TOKEN.indexOf('|') + 1));
  });
});

describe('same-host origin changes', () => {
  it('refuses a redirect to a different port on the same host', async () => {
    // Same hostname is not the same origin. This is the http -> https case, and
    // the request would carry the token to a listener we never pinned.
    attacker = await listen('localhost', () => JSON_OK);
    instance = await listen('localhost', () => ({
      status: 302,
      headers: { location: `${attacker.origin}/api/v1/applications` },
    }));

    const error = await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        path: '/applications',
      }),
    );

    expect(error.kind).toBe('network');
    expect(attacker.received).toEqual([]);
  });

  it('refuses a relative redirect within the same origin', async () => {
    // Coolify's API does not redirect. Something in front of it does — a login
    // wall, an SSO proxy — and following it silently would return that page's
    // body as if it were an API response.
    instance = await listen('localhost', () => ({ status: 302, headers: { location: '/login' } }));

    const error = await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        path: '/applications',
      }),
    );

    expect(error.kind).toBe('network');
    expect(error.message.toLowerCase()).toContain('redirect');
  });

  it('refuses a 3xx with no Location header at all', async () => {
    instance = await listen('localhost', () => ({ status: 302 }));

    const error = await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        path: '/applications',
      }),
    );

    expect(error.kind).toBe('network');
  });
});

describe('the ordinary path still works', () => {
  it('completes a request the instance answers directly', async () => {
    instance = await listen('localhost', () => JSON_OK);

    const response = await coolifyRequest({
      connection: connectionTo(instance.origin),
      method: 'GET',
      path: '/applications',
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(instance.received[0]?.url).toBe('/api/v1/applications');
  });

  it('scrubs the token out of a body that echoes it back', async () => {
    // Point a base URL at a request-echo service and the response body contains
    // the Authorization header verbatim. Without scrubbing, that value flows
    // into the model's context and into every message derived from it.
    instance = await listen('localhost', (request) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ echoed: request.headers.authorization }),
    }));

    const response = await coolifyRequest({
      connection: connectionTo(instance.origin),
      method: 'GET',
      path: '/applications',
    });

    expect(JSON.stringify(response.data)).not.toContain(TOKEN);
    expect(response.data).toEqual({ echoed: 'Bearer ***' });
  });

  it('refuses a path that would leave the pinned origin before opening a socket', async () => {
    attacker = await listen('127.0.0.1', () => JSON_OK);
    instance = await listen('localhost', () => JSON_OK);

    const error = await refusal(
      coolifyRequest({
        connection: connectionTo(instance.origin),
        method: 'GET',
        // Protocol-relative: resolves to a different host under URL resolution.
        path: `//127.0.0.1:${attacker.port}/collect`,
      }),
    );

    expect(error.kind).toBe('validation');
    expect(instance.received).toEqual([]);
    expect(attacker.received).toEqual([]);
  });
});
