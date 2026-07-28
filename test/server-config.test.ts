/**
 * The configuration both entry points share.
 *
 * `src/index.ts` (stdio) and `serve --http` in `src/cli.ts` must derive the same
 * `ServerConfig` from the same connections. A capability gate that quietly
 * differs between transports is the kind of bug only ever found in production,
 * on whichever transport the reviewer did not use — so the derivation lives in
 * one module and this file pins its behaviour.
 *
 * Neither entry point can be imported to test this. Both call their `main()` at
 * the top level, so importing either one launches a program: `index.ts` would
 * attach a stdio transport and take over the test runner's stdout, and `cli.ts`
 * would run whatever is in `process.argv`. That is precisely why this code was
 * moved out of them.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS_ENV,
  DEFAULT_LOG_LEVEL,
  resolveAllowedHosts,
  resolveLogLevel,
  toServerConfig,
} from '../src/config/server-config.js';
import type { Connection, ConnectionRegistry } from '../src/types.js';

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    name: 'prod',
    baseUrl: 'https://coolify.example.com',
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 30_000,
    insecureTLS: false,
    resolveToken: () => Promise.reject(new Error('no token should be resolved here')),
    ...overrides,
  };
}

function makeRegistry(connections: Connection[]): ConnectionRegistry {
  return {
    connections: new Map(connections.map((connection) => [connection.name, connection])),
    source: 'env',
    shadowed: [],
  };
}

const silent = (): void => undefined;

describe('toServerConfig', () => {
  it('is read-only only when EVERY connection is', () => {
    const mixed = toServerConfig(
      makeRegistry([
        makeConnection({ name: 'a', readOnly: true }),
        makeConnection({ name: 'b', readOnly: false }),
      ]),
      {},
      silent,
    );
    const all = toServerConfig(
      makeRegistry([
        makeConnection({ name: 'a', readOnly: true }),
        makeConnection({ name: 'b', readOnly: true }),
      ]),
      {},
      silent,
    );

    expect(mixed.readOnly).toBe(false);
    expect(all.readOnly).toBe(true);
  });

  it('does not count a read-only connection towards the destructive capability', () => {
    // A read-only connection can never destroy anything, so `allowDestructive`
    // on one grants nothing. Getting this backwards would register the
    // destructive tool on a server where no connection could use it.
    const cfg = toServerConfig(
      makeRegistry([makeConnection({ readOnly: true, allowDestructive: true })]),
      {},
      silent,
    );

    expect(cfg.allowDestructive).toBe(false);
  });

  it('grants the destructive capability when a writable connection opted in', () => {
    const cfg = toServerConfig(
      makeRegistry([
        makeConnection({ name: 'a', readOnly: true, allowDestructive: true }),
        makeConnection({ name: 'b', readOnly: false, allowDestructive: true }),
      ]),
      {},
      silent,
    );

    expect(cfg.allowDestructive).toBe(true);
  });
});

describe('resolveLogLevel', () => {
  it.each(['error', 'warn', 'info', 'debug'])('accepts %s', (level) => {
    expect(resolveLogLevel({ COOLIFY_LOG_LEVEL: level }, silent)).toBe(level);
  });

  it('is case- and whitespace-insensitive, because a config file is hand-edited', () => {
    expect(resolveLogLevel({ COOLIFY_LOG_LEVEL: '  DEBUG ' }, silent)).toBe('debug');
  });

  it('warns and carries on rather than refusing to start over a log level', () => {
    const warnings: string[] = [];

    const level = resolveLogLevel({ COOLIFY_LOG_LEVEL: 'verbose' }, (m) => warnings.push(m));

    expect(level).toBe(DEFAULT_LOG_LEVEL);
    // Not silent either, or the user watches for output that never arrives.
    expect(warnings.join('')).toContain('verbose');
  });

  it.each([undefined, '', '   '])('falls back to the default for %p', (value) => {
    const env = value === undefined ? {} : { COOLIFY_LOG_LEVEL: value };

    expect(resolveLogLevel(env, silent)).toBe(DEFAULT_LOG_LEVEL);
  });
});

describe('resolveAllowedHosts', () => {
  it('merges the flag and the environment rather than letting one win', () => {
    // Both answer the same question. An operator who set both meant both, and a
    // silent override is how the defence ends up off on the one deployment that
    // took the trouble to configure it.
    const hosts = resolveAllowedHosts(['flag.example.com'], {
      [ALLOWED_HOSTS_ENV]: 'env.example.com',
    });

    expect(hosts).toEqual(['flag.example.com', 'env.example.com']);
  });

  it('splits the environment form on commas and trims each entry', () => {
    const hosts = resolveAllowedHosts([], {
      [ALLOWED_HOSTS_ENV]: ' a.example.com ,b.example.com,  c.example.com',
    });

    expect(hosts).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
  });

  it('drops empty entries from a trailing or doubled comma', () => {
    const hosts = resolveAllowedHosts([], { [ALLOWED_HOSTS_ENV]: 'a.example.com,,b.example.com,' });

    expect(hosts).toEqual(['a.example.com', 'b.example.com']);
  });

  it('deduplicates, so naming a host twice is not a different allow list', () => {
    const hosts = resolveAllowedHosts(['a.example.com'], {
      [ALLOWED_HOSTS_ENV]: 'a.example.com,b.example.com',
    });

    expect(hosts).toEqual(['a.example.com', 'b.example.com']);
  });

  it.each([{}, { [ALLOWED_HOSTS_ENV]: '' }, { [ALLOWED_HOSTS_ENV]: '   ' }])(
    'returns nothing for %p, so the caller can omit the key entirely',
    (env) => {
      expect(resolveAllowedHosts([], env)).toEqual([]);
    },
  );
});
