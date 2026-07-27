/**
 * The configuration precedence table, one test per row.
 *
 * Three layers, and the rules between them are the part users get wrong:
 *
 *   0. COOLIFY_BASE_URL + COOLIFY_API_TOKEN            -> connection `default`
 *   1. COOLIFY_BASE_URL_<NAME> + COOLIFY_API_TOKEN_<NAME>
 *   2. a registry file, FIRST HIT WINS WHOLESALE
 *
 * Two rules carry the whole design and both are asserted here rather than
 * inferred:
 *
 *   - File lookup never merges. The first location that has a file IS the
 *     configuration; no other location is read. "Which of these four files set
 *     readOnly?" is a question the system refuses to create.
 *   - Env replaces file BY WHOLE ENTRY on a name collision, never field by
 *     field. A half-env, half-file connection is not something a person can
 *     hold in their head, and the shadowed name is recorded so `doctor` can
 *     say so.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRegistry } from '../src/config/resolve.js';
import { ConfigError } from '../src/config/schema.js';
import type { ConnectionRegistry } from '../src/types.js';

const TOKEN = '13|abcdefghijklmnopqrstuvwxyz0123456789ABCD';

let roots: string[] = [];

interface Tree {
  root: string;
  home: string;
  cwd: string;
}

function tree(): Tree {
  const root = mkdtempSync(path.join(tmpdir(), 'coolify-mcp-config-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'home', 'work', 'repo');
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeJson(file: string, value: unknown): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/** A minimal valid registry file. */
function registryFile(connections: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { version: 1, connections, ...extra };
}

function resolve(t: Tree, env: NodeJS.ProcessEnv): Promise<ConnectionRegistry> {
  // `platform: 'linux'` pins the user-config search to the XDG locations, so the
  // same expectations hold on every CI runner.
  return resolveRegistry(env, t.cwd, t.home, { platform: 'linux' });
}

async function failure(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected resolveRegistry to reject');
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

// ---------------------------------------------------------------------------
// Row: env only
// ---------------------------------------------------------------------------

describe('env only', () => {
  it('layer 0: two variables produce one connection named `default`', async () => {
    const t = tree();

    const registry = await resolve(t, { COOLIFY_BASE_URL: 'https://coolify.example.com', COOLIFY_API_TOKEN: TOKEN });

    expect(registry.source).toBe('env');
    expect([...registry.connections.keys()]).toEqual(['default']);
    expect(registry.defaultName).toBe('default');
    expect(registry.configPath).toBeUndefined();
    expect(registry.shadowed).toEqual([]);
  });

  it('layer 1: COOLIFY_BASE_URL_<NAME> defines a connection, with _ read as -', async () => {
    const t = tree();

    const registry = await resolve(t, {
      COOLIFY_BASE_URL_PROD: 'https://coolify.example.com',
      COOLIFY_API_TOKEN_PROD: TOKEN,
      COOLIFY_BASE_URL_ACME_OPS: 'https://coolify.acme.dev',
      COOLIFY_API_TOKEN_ACME_OPS: TOKEN,
    });

    // Sorted, so error messages and `doctor` output are stable run to run.
    expect([...registry.connections.keys()]).toEqual(['acme-ops', 'prod']);
    expect(registry.source).toBe('env');
  });

  it('reads the token from the variable the connection name implies', async () => {
    const t = tree();
    const registry = await resolve(t, {
      COOLIFY_BASE_URL_ACME_OPS: 'https://coolify.acme.dev',
      COOLIFY_API_TOKEN_ACME_OPS: TOKEN,
    });

    await expect(registry.connections.get('acme-ops')?.resolveToken()).resolves.toBe(TOKEN);
  });

  it('strips a trailing slash so paths never come out as //v1', async () => {
    const t = tree();

    const registry = await resolve(t, { COOLIFY_BASE_URL: 'https://coolify.example.com///', COOLIFY_API_TOKEN: TOKEN });

    expect(registry.connections.get('default')?.baseUrl).toBe('https://coolify.example.com');
  });

  it('treats an empty variable as unset rather than as a connection', async () => {
    // Every client config format lets a user leave `"COOLIFY_BASE_URL": ""`
    // behind; counting that as configured produces a 401 instead of the
    // "not configured" message that says what to do.
    const t = tree();

    const error = await failure(resolve(t, { COOLIFY_BASE_URL: '   ', COOLIFY_API_TOKEN: TOKEN }));

    expect(error.message).toContain('no connections configured');
  });

  it('refuses a base URL that embeds credentials', async () => {
    const t = tree();

    const error = await failure(resolve(t, { COOLIFY_BASE_URL: 'https://u:p@coolify.example.com' }));

    expect(error.message).toContain('never stores credentials in config files');
  });
});

// ---------------------------------------------------------------------------
// Row: file only
// ---------------------------------------------------------------------------

describe('file only', () => {
  it('reports the file as the source and names the path it used', async () => {
    const t = tree();
    const file = writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({ prod: { baseUrl: 'https://coolify.example.com' } }),
    );

    const registry = await resolve(t, {});

    expect(registry.source).toBe('file');
    expect(registry.configPath).toBe(file);
    expect([...registry.connections.keys()]).toEqual(['prod']);
    expect(registry.shadowed).toEqual([]);
  });

  it('carries the per-connection settings the file declared', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({
        prod: { baseUrl: 'https://coolify.example.com', label: 'Production', readOnly: true, timeoutMs: 5_000 },
      }),
    );

    const registry = await resolve(t, {});
    const prod = registry.connections.get('prod');

    expect(prod?.label).toBe('Production');
    expect(prod?.readOnly).toBe(true);
    expect(prod?.timeoutMs).toBe(5_000);
  });

  it('lets two connections share a base URL — that is what a second team is', async () => {
    // A Coolify token is bound to the team that was active when it was created
    // and there is no team-switch parameter, so the same instance with a second
    // token is the entire multi-team mechanism.
    const t = tree();
    writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({
        acme: { baseUrl: 'https://coolify.acme.dev' },
        'acme-ops': { baseUrl: 'https://coolify.acme.dev' },
      }),
    );

    const registry = await resolve(t, {});

    expect(registry.connections.get('acme')?.baseUrl).toBe(registry.connections.get('acme-ops')?.baseUrl);
    expect(registry.connections.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Row: file lookup order — first hit wins WHOLESALE
// ---------------------------------------------------------------------------

describe('file lookup order', () => {
  it('$COOLIFY_MCP_CONFIG beats every other location', async () => {
    const t = tree();
    const explicit = writeJson(
      path.join(t.root, 'explicit.json'),
      registryFile({ chosen: { baseUrl: 'https://chosen.example.com' } }),
    );
    writeJson(path.join(t.cwd, '.coolify-mcp.json'), registryFile({ project: { baseUrl: 'https://project.example.com' } }));
    writeJson(path.join(t.home, '.coolify-mcp', 'config.json'), registryFile({ user: { baseUrl: 'https://user.example.com' } }));

    const registry = await resolve(t, { COOLIFY_MCP_CONFIG: explicit });

    expect([...registry.connections.keys()]).toEqual(['chosen']);
    expect(registry.configPath).toBe(explicit);
  });

  it('refuses an explicit pointer that resolves to nothing', async () => {
    // Falling through to a different file the user is not looking at is how a
    // config problem becomes an hour of confusion.
    const t = tree();
    writeJson(path.join(t.home, '.coolify-mcp', 'config.json'), registryFile({ user: { baseUrl: 'https://user.example.com' } }));

    const error = await failure(resolve(t, { COOLIFY_MCP_CONFIG: path.join(t.root, 'nope.json') }));

    expect(error.message).toContain('which does not exist');
  });

  it('the nearest .coolify-mcp.json beats the user config, and nothing is merged', async () => {
    const t = tree();
    writeJson(path.join(t.cwd, '.coolify-mcp.json'), registryFile({ project: { baseUrl: 'https://project.example.com' } }));
    writeJson(path.join(t.home, '.coolify-mcp', 'config.json'), registryFile({ user: { baseUrl: 'https://user.example.com' } }));

    const registry = await resolve(t, {});

    expect([...registry.connections.keys()]).toEqual(['project']);
  });

  it('walks up from cwd to find a project config', async () => {
    const t = tree();
    const parent = path.dirname(t.cwd);
    writeJson(path.join(parent, '.coolify-mcp.json'), registryFile({ parent: { baseUrl: 'https://parent.example.com' } }));

    const registry = await resolve(t, {});

    expect([...registry.connections.keys()]).toEqual(['parent']);
  });

  it('stops the walk at a repository root', async () => {
    // A config above the repo governs an unrelated checkout, which is exactly
    // the surprise the boundary exists to prevent.
    const t = tree();
    writeFileSync(path.join(t.cwd, '.git'), 'gitdir: ../.git/worktrees/x\n', 'utf8');
    writeJson(path.join(path.dirname(t.cwd), '.coolify-mcp.json'), registryFile({ outside: { baseUrl: 'https://outside.example.com' } }));
    writeJson(path.join(t.home, '.coolify-mcp', 'config.json'), registryFile({ user: { baseUrl: 'https://user.example.com' } }));

    const registry = await resolve(t, {});

    expect([...registry.connections.keys()]).toEqual(['user']);
  });

  it('$XDG_CONFIG_HOME beats ~/.coolify-mcp', async () => {
    const t = tree();
    const xdg = path.join(t.root, 'xdg');
    writeJson(path.join(xdg, 'coolify-mcp', 'config.json'), registryFile({ xdg: { baseUrl: 'https://xdg.example.com' } }));
    writeJson(path.join(t.home, '.coolify-mcp', 'config.json'), registryFile({ dotdir: { baseUrl: 'https://dotdir.example.com' } }));

    const registry = await resolve(t, { XDG_CONFIG_HOME: xdg });

    expect([...registry.connections.keys()]).toEqual(['xdg']);
  });
});

// ---------------------------------------------------------------------------
// Row: env + file, disjoint names -> union
// ---------------------------------------------------------------------------

describe('env and file together', () => {
  it('unions disjoint names and reports both sources', async () => {
    const t = tree();
    writeJson(path.join(t.home, '.coolify-mcp', 'config.json'), registryFile({ acme: { baseUrl: 'https://coolify.acme.dev' } }));

    const registry = await resolve(t, {
      COOLIFY_BASE_URL_PROD: 'https://coolify.example.com',
      COOLIFY_API_TOKEN_PROD: TOKEN,
    });

    expect([...registry.connections.keys()]).toEqual(['acme', 'prod']);
    expect(registry.source).toBe('env+file');
    expect(registry.shadowed).toEqual([]);
  });

  it('env replaces a colliding file entry WHOLE, and records the shadowing', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({
        prod: {
          baseUrl: 'https://file.example.com',
          label: 'From the file',
          readOnly: true,
          timeoutMs: 5_000,
          insecureTLS: true,
        },
      }),
    );

    const registry = await resolve(t, {
      COOLIFY_BASE_URL_PROD: 'https://env.example.com',
      COOLIFY_API_TOKEN_PROD: TOKEN,
    });
    const prod = registry.connections.get('prod');

    expect(prod?.baseUrl).toBe('https://env.example.com');
    // Every one of these came from the file entry that lost. Field-level
    // merging would leave a connection nobody can describe from one place.
    expect(prod?.label).toBeUndefined();
    expect(prod?.readOnly).toBe(false);
    expect(prod?.insecureTLS).toBe(false);
    expect(prod?.timeoutMs).toBe(30_000);
    expect(registry.shadowed).toEqual(['prod']);
    expect(registry.source).toBe('env+file');
  });

  it('COOLIFY_READ_ONLY tightens a file connection but can never re-open one', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({ open: { baseUrl: 'https://a.example.com' }, closed: { baseUrl: 'https://b.example.com', readOnly: true } }),
    );

    const tightened = await resolve(t, { COOLIFY_READ_ONLY: 'true' });
    expect(tightened.connections.get('open')?.readOnly).toBe(true);

    // Read-only is a kill switch: an env var that could clear it would make the
    // switch depend on nobody having set the wrong variable.
    const loosened = await resolve(t, { COOLIFY_READ_ONLY: 'false' });
    expect(loosened.connections.get('closed')?.readOnly).toBe(true);
    expect(loosened.connections.get('open')?.readOnly).toBe(false);
  });

  it('refuses a boolean env var it cannot read rather than defaulting it to false', async () => {
    const t = tree();

    const error = await failure(
      resolve(t, { COOLIFY_BASE_URL: 'https://coolify.example.com', COOLIFY_ALLOW_DESTRUCTIVE: 'ture' }),
    );

    expect(error.message).toContain('COOLIFY_ALLOW_DESTRUCTIVE');
  });
});

// ---------------------------------------------------------------------------
// Row: default selection order
// ---------------------------------------------------------------------------

describe('default connection selection', () => {
  it('a single connection is its own default', async () => {
    const t = tree();

    const registry = await resolve(t, { COOLIFY_BASE_URL: 'https://coolify.example.com', COOLIFY_API_TOKEN: TOKEN });

    expect(registry.defaultName).toBe('default');
  });

  it('several connections with none designated have NO default', async () => {
    // Guessing which Coolify instance a deploy was meant for is the one thing
    // this layer must never do; the tool layer demands an explicit instance.
    const t = tree();

    const registry = await resolve(t, {
      COOLIFY_BASE_URL_PROD: 'https://a.example.com',
      COOLIFY_BASE_URL_ACME: 'https://b.example.com',
    });

    expect(registry.defaultName).toBeUndefined();
  });

  it('the file`s defaultConnection is used when the env does not choose', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({ prod: { baseUrl: 'https://a.example.com' }, acme: { baseUrl: 'https://b.example.com' } }, { defaultConnection: 'acme' }),
    );

    const registry = await resolve(t, {});

    expect(registry.defaultName).toBe('acme');
  });

  it('COOLIFY_CONNECTION outranks the file`s defaultConnection', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({ prod: { baseUrl: 'https://a.example.com' }, acme: { baseUrl: 'https://b.example.com' } }, { defaultConnection: 'acme' }),
    );

    const registry = await resolve(t, { COOLIFY_CONNECTION: 'prod' });

    expect(registry.defaultName).toBe('prod');
  });

  it('accepts COOLIFY_CONNECTION=PROD, because the matching variable is spelled that way', async () => {
    const t = tree();

    const registry = await resolve(t, {
      COOLIFY_BASE_URL_PROD: 'https://a.example.com',
      COOLIFY_BASE_URL_ACME: 'https://b.example.com',
      COOLIFY_CONNECTION: 'PROD',
    });

    expect(registry.defaultName).toBe('prod');
  });

  it('refuses a COOLIFY_CONNECTION that names nothing, and lists what there is', async () => {
    const t = tree();

    const error = await failure(
      resolve(t, { COOLIFY_BASE_URL_PROD: 'https://a.example.com', COOLIFY_CONNECTION: 'staging' }),
    );

    expect(error.message).toContain('staging');
    expect(error.message).toContain('prod');
  });

  it('refuses a defaultConnection that names nothing', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.coolify-mcp', 'config.json'),
      registryFile({ prod: { baseUrl: 'https://a.example.com' } }, { defaultConnection: 'acme' }),
    );

    const error = await failure(resolve(t, {}));

    expect(error.message).toContain('defaultConnection');
  });
});

// ---------------------------------------------------------------------------
// Nothing configured at all
// ---------------------------------------------------------------------------

describe('nothing configured', () => {
  it('names both env variables and every location it searched', async () => {
    const t = tree();

    const error = await failure(resolve(t, {}));

    expect(error.message).toContain('COOLIFY_BASE_URL=');
    expect(error.message).toContain('COOLIFY_API_TOKEN=');
    expect(error.message).toContain('.coolify-mcp.json');
    expect(error.message).toContain(path.join(t.home, '.coolify-mcp', 'config.json'));
  });
});
