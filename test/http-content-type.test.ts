/**
 * Coolify answers JSON everywhere except `GET /version` and `GET /health`,
 * which return a bare string under `text/html`. Those must come back as data,
 * while a real HTML page — a proxy login wall in front of the API — must still
 * be refused.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { coolifyRequest } from '../src/http/client.js';
import { CoolifyError } from '../src/types.js';
import type { Connection } from '../src/types.js';

let server: Server | undefined;

async function serve(body: string): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function connectionTo(origin: string): Connection {
  return {
    name: 'prod',
    baseUrl: origin,
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 5_000,
    insecureTLS: false,
    resolveToken: async () => '13|abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('non-JSON responses', () => {
  it('returns the bare version string Coolify serves as text/html', async () => {
    const origin = await serve('4.4.6');
    const response = await coolifyRequest<string>({
      connection: connectionTo(origin),
      method: 'GET',
      path: '/version',
    });
    expect(response.data).toBe('4.4.6');
  });

  it('refuses an HTML page answering in place of the API', async () => {
    const origin = await serve('<!DOCTYPE html><html><body>Sign in</body></html>');
    const request = coolifyRequest({
      connection: connectionTo(origin),
      method: 'GET',
      path: '/applications',
    });
    await expect(request).rejects.toBeInstanceOf(CoolifyError);
    await expect(request).rejects.toThrow(/instead of JSON/);
  });
});
