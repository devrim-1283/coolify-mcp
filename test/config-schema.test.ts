/**
 * The registry file schema — and the one rule it exists to enforce:
 *
 *   coolify-mcp NEVER stores credentials in config files, and that is a
 *   VALIDATION ERROR rather than advice.
 *
 * `connectionSchema` has no `token` property and is `.strict()`, so a literal
 * credential cannot round-trip through the parser at all. The distinction
 * matters: a warning is something a user scrolls past on the way to a working
 * setup, and the file it would have been written into gets committed, synced to
 * a dotfiles repo, and screen-shared. A hard failure with a written remedy is
 * the only version of this rule that holds.
 *
 * The second half of the file is the parity check the published JSON Schema's
 * own `$comment` asks for: `schema/config.v1.json` is a hand-written mirror of
 * `src/config/schema.ts`, and it is what a user's editor validates against. If
 * the two drift, an editor cheerfully autocompletes a property the server then
 * rejects — or worse, stays silent about one it should have flagged.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONFIG_VERSION,
  ConfigError,
  configFileSchema,
  parseConfigFile,
} from '../src/config/schema.js';

const TOKEN = '13|abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const SOURCE = '/home/dev/.coolify-mcp/config.json';

function file(connection: Record<string, unknown>, name = 'prod'): unknown {
  return { version: CONFIG_VERSION, connections: { [name]: { baseUrl: 'https://coolify.example.com', ...connection } } };
}

function rejection(raw: unknown): ConfigError {
  try {
    parseConfigFile(raw, SOURCE);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected parseConfigFile to reject');
}

// ---------------------------------------------------------------------------
// A literal credential is an ERROR
// ---------------------------------------------------------------------------

describe('a `token` property in a connection', () => {
  it('is a validation error, not a warning', () => {
    // safeParse rather than the throwing wrapper, so this asserts the SCHEMA
    // rejects it — not merely that some caller decided to complain.
    const result = configFileSchema.safeParse(file({ token: TOKEN }));

    expect(result.success).toBe(false);
  });

  it('fails the whole file rather than dropping the key and carrying on', () => {
    const error = rejection(file({ token: TOKEN }));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('"token" is not a valid property');
  });

  it('answers with the three supported sources and the conventional variable', () => {
    // The error message IS the enforcement mechanism: it has to leave the user
    // with an obvious next action, or they will go looking for a way to disable
    // the check instead.
    const error = rejection(file({ token: TOKEN }));

    expect(error.message).toContain('coolify-mcp never stores credentials in config files');
    expect(error.message).toContain('tokenEnv | tokenCommand | tokenKeychain');
    expect(error.message).toContain('$COOLIFY_API_TOKEN_PROD');
    expect(error.message).toContain(SOURCE);
  });

  it('names the connection`s own variable, not a generic one', () => {
    const error = rejection(file({ token: TOKEN }, 'acme-ops'));

    expect(error.message).toContain('$COOLIFY_API_TOKEN_ACME_OPS');
  });

  it('never echoes the credential it just refused', () => {
    // The message ends up in terminals, issue reports and screen shares. Quoting
    // the value back would leak the very thing the rule is protecting.
    const error = rejection(file({ token: TOKEN }));

    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(TOKEN.slice(TOKEN.indexOf('|') + 1));
  });

  it.each([
    'token',
    'apiToken',
    'api_token',
    'API-TOKEN',
    'accessToken',
    'authToken',
    'apiKey',
    'key',
    'secret',
    'password',
    'bearer',
    'authorization',
  ])('treats `%s` the same way', (key) => {
    // Compared with separators stripped and case folded, so a user who guesses
    // a different spelling still gets the explanation rather than a bare
    // "unrecognized key".
    const error = rejection(file({ [key]: TOKEN }));

    expect(error.message).toContain('never stores credentials in config files');
    expect(error.message).not.toContain(TOKEN);
  });

  it('reports a plain unknown key without the credential lecture', () => {
    const error = rejection(file({ baseUrlz: 'https://typo.example.com' }));

    expect(error.message).toContain('"baseUrlz" is not a valid property');
    expect(error.message).not.toContain('never stores credentials');
    expect(error.message).toContain('Valid properties:');
  });
});

// ---------------------------------------------------------------------------
// The rest of the connection contract
// ---------------------------------------------------------------------------

describe('connection validation', () => {
  it('accepts a connection that is nothing but a baseUrl', () => {
    // The convention ($COOLIFY_API_TOKEN_<NAME>) is what makes this complete.
    expect(() => parseConfigFile(file({}), SOURCE)).not.toThrow();
  });

  it.each([
    ['tokenEnv', { tokenEnv: 'MY_TOKEN' }],
    ['tokenCommand', { tokenCommand: ['op', 'read', 'op://Infra/coolify/credential'] }],
    ['tokenKeychain', { tokenKeychain: { service: 'coolify-mcp', account: 'acme' } }],
  ])('accepts %s as the single token source', (_name, connection) => {
    expect(() => parseConfigFile(file(connection), SOURCE)).not.toThrow();
  });

  it('refuses two token sources at once', () => {
    const error = rejection(file({ tokenEnv: 'MY_TOKEN', tokenCommand: ['op', 'read', 'x'] }));

    expect(error.message).toContain('at most one of tokenEnv, tokenCommand, tokenKeychain');
  });

  it('refuses a baseUrl that embeds credentials', () => {
    const error = rejection(file({ baseUrl: 'https://user:pass@coolify.example.com' }));

    expect(error.message).toContain('never stores credentials in config files');
  });

  it.each([
    ['not a url', 'coolify.example.com'],
    ['a non-http scheme', 'ftp://coolify.example.com'],
  ])('refuses a baseUrl that is %s', (_why, baseUrl) => {
    expect(() => parseConfigFile(file({ baseUrl }), SOURCE)).toThrow(ConfigError);
  });

  it('refuses a connection name outside the slug alphabet', () => {
    // Names have to survive a round trip through an env var name
    // (acme-ops <-> COOLIFY_API_TOKEN_ACME_OPS); anything else is ambiguous.
    expect(() => parseConfigFile(file({}, 'Acme Ops'), SOURCE)).toThrow(ConfigError);
  });

  it('refuses a file with no connections at all', () => {
    const error = rejection({ version: CONFIG_VERSION, connections: {} });

    expect(error.message).toContain('define at least one connection');
  });

  it('explains a wrong version in terms of the file, not of Zod', () => {
    const error = rejection({ version: 2, connections: { prod: { baseUrl: 'https://coolify.example.com' } } });

    expect(error.message).toContain('This file is a v1 registry.');
  });

  it('allows $schema so editors can validate the file', () => {
    expect(() =>
      parseConfigFile(
        { $schema: 'https://example.com/config.v1.json', version: CONFIG_VERSION, connections: { prod: { baseUrl: 'https://a.example.com' } } },
        SOURCE,
      ),
    ).not.toThrow();
  });

  it.each([
    [999, false],
    [1_000, true],
    [120_000, true],
    [120_001, false],
    [1_500.5, false],
  ])('timeoutMs %s is accepted: %s', (timeoutMs, accepted) => {
    expect(configFileSchema.safeParse(file({ timeoutMs })).success).toBe(accepted);
  });

  it('applies the documented defaults', () => {
    const parsed = parseConfigFile(file({}), SOURCE);

    expect(parsed.connections['prod']?.readOnly).toBe(false);
    expect(parsed.connections['prod']?.insecureTLS).toBe(false);
    expect(parsed.connections['prod']?.timeoutMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Published JSON Schema parity
// ---------------------------------------------------------------------------

/**
 * The mirror is compared by CONSTRAINT rather than by running a validator: ajv
 * is not a dependency and will not become one for a test — the package's whole
 * install story is "npx, no native modules, few deps". Comparing the property
 * sets, the strictness flags and the numeric/pattern bounds catches every drift
 * a validator would, because those are the only things either schema says.
 */

const SCHEMA_PATH = fileURLToPath(new URL('../schema/config.v1.json', import.meta.url));
const PUBLISHED = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;

function node(...keyPath: string[]): Record<string, unknown> {
  let cursor: unknown = PUBLISHED;
  for (const key of keyPath) {
    cursor = (cursor as Record<string, unknown> | undefined)?.[key];
  }
  if (typeof cursor !== 'object' || cursor === null) {
    throw new Error(`schema/config.v1.json has no ${keyPath.join('.')}`);
  }
  return cursor as Record<string, unknown>;
}

/**
 * Property names the Zod schema accepts, read out of its own error message.
 *
 * Black box on purpose: reaching into `_def` would let the two drift while the
 * test kept passing, which is the exact failure mode this suite exists to stop.
 */
function zodConnectionKeys(): string[] {
  const error = rejection(file({ definitely_not_a_property: 1 }));
  const line = error.message.split('\n').find((text) => text.startsWith('Valid properties:'));
  if (line === undefined) throw new Error('the error message no longer lists the valid properties');
  return line.replace('Valid properties:', '').replace(/\.$/, '').split(',').map((key) => key.trim());
}

describe('schema/config.v1.json mirrors src/config/schema.ts', () => {
  it('has no token property, and forbids additional ones', () => {
    const connection = node('$defs', 'connection');

    expect(Object.keys(connection['properties'] as object)).not.toContain('token');
    expect(connection['additionalProperties']).toBe(false);
  });

  it('declares exactly the connection properties the parser accepts', () => {
    const declared = Object.keys(node('$defs', 'connection', 'properties')).sort();

    expect(declared).toEqual(zodConnectionKeys().sort());
  });

  it('declares exactly the top-level properties the parser accepts', () => {
    const error = rejection({ version: CONFIG_VERSION, connections: { prod: { baseUrl: 'https://a.example.com' } }, nope: 1 });
    expect(error.message).toContain('"nope" is not a valid property');

    expect(Object.keys(node('properties')).sort()).toEqual(
      ['$schema', 'connections', 'defaultConnection', 'extends', 'version'].sort(),
    );
    expect(PUBLISHED['additionalProperties']).toBe(false);
  });

  it('agrees on the version literal', () => {
    expect(node('properties', 'version')['const']).toBe(CONFIG_VERSION);
  });

  it('agrees on the connection name pattern', () => {
    const pattern = node('$defs', 'connectionName')['pattern'];

    expect(pattern).toBe('^[a-z0-9][a-z0-9-]{0,30}$');
    expect(new RegExp(String(pattern)).test('acme-ops')).toBe(true);
    expect(new RegExp(String(pattern)).test('Acme Ops')).toBe(false);
  });

  it('agrees on the timeout bounds and default', () => {
    const timeout = node('$defs', 'connection', 'properties', 'timeoutMs');

    expect(timeout['minimum']).toBe(1_000);
    expect(timeout['maximum']).toBe(120_000);
    expect(timeout['default']).toBe(30_000);
  });

  it('agrees on the tokenCommand bounds', () => {
    const command = node('$defs', 'connection', 'properties', 'tokenCommand');

    expect(command['minItems']).toBe(1);
    expect(command['maxItems']).toBe(32);
  });

  it('agrees on the tokenEnv pattern', () => {
    expect(node('$defs', 'connection', 'properties', 'tokenEnv')['pattern']).toBe('^[A-Za-z_][A-Za-z0-9_]*$');
  });

  it('encodes the at-most-one-token-source rule', () => {
    // Three `not: {required: [a, b]}` clauses, one per pair. Without them an
    // editor would autocomplete a second source the server then refuses.
    const clauses = node('$defs', 'connection')['allOf'] as Array<{ not?: { required?: string[] } }>;
    const pairs = clauses.map((clause) => [...(clause.not?.required ?? [])].sort().join('+')).sort();

    expect(pairs).toEqual(['tokenCommand+tokenEnv', 'tokenCommand+tokenKeychain', 'tokenEnv+tokenKeychain']);
  });

  it('ships an example the parser actually accepts', () => {
    const examples = PUBLISHED['examples'] as unknown[];

    expect(Array.isArray(examples) && examples.length > 0).toBe(true);
    for (const example of examples) {
      expect(() => parseConfigFile(example, SCHEMA_PATH)).not.toThrow();
    }
  });
});
