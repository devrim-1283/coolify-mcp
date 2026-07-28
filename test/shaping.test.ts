import { describe, expect, it, vi } from 'vitest';

import { CoolifyError } from '../src/types.js';
import {
  assertCursorMatches,
  decodeCursor,
  encodeCursor,
  queryHash,
  renderEnvelope,
  shapeResponse,
} from '../src/shaping/envelope.js';
import { shapeLogs, stripAnsi } from '../src/shaping/logs.js';
import { project, projectOne, prune } from '../src/shaping/project.js';
import { redact, redactObject } from '../src/shaping/redact.js';

/**
 * The config layer registers every resolved bearer token in this set. Mocking
 * it keeps the suite off connection resolution while still exercising the real
 * contract: whatever is registered must never survive into output.
 */
const { REGISTERED_TOKEN, PLAIN_SECRET } = vi.hoisted(() => ({
  REGISTERED_TOKEN: '13|aB3xQ7mL9kR2tV5wY8zC1nD4fG6hJ0pS7uE2iO5r',
  PLAIN_SECRET: 'hunter2-not-a-sanctum-shape',
}));

vi.mock('../src/config/secrets.js', () => ({
  getSecrets: (): Set<string> => new Set([REGISTERED_TOKEN, PLAIN_SECRET]),
}));

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('project', () => {
  it('keeps only the listed fields, in the listed order', () => {
    const rows = [{ status: 'running', uuid: 'a1', name: 'api', fqdn: 'https://api.example.com' }];

    const out = project(rows, ['uuid', 'name']);

    expect(Object.keys(out[0] ?? {})).toEqual(['uuid', 'name']);
    expect(out[0]).toEqual({ uuid: 'a1', name: 'api' });
  });

  it('drops fields Coolify added that the allowlist does not name', () => {
    const rows = [{ uuid: 'a1', name: 'api', some_future_column: 'x'.repeat(5000) }];

    const out = project(rows, ['uuid', 'name']);

    expect(out[0]).not.toHaveProperty('some_future_column');
  });

  it('omits an absent field instead of emitting a null value', () => {
    const out = projectOne({ uuid: 'a1' }, ['uuid', 'fqdn']);

    expect('fqdn' in out).toBe(false);
  });

  it('does not mutate the input row', () => {
    const row = { uuid: 'a1', name: 'api' };

    project([row], ['uuid']);

    expect(row).toEqual({ uuid: 'a1', name: 'api' });
  });
});

describe('prune', () => {
  it('drops the named fields and keeps everything else', () => {
    const rows = [{ uuid: 'a1', name: 'api', description: 'long', git_commit_sha: 'abc' }];

    const out = prune(rows, ['description', 'git_commit_sha']);

    expect(out[0]).toEqual({ uuid: 'a1', name: 'api' });
  });
});

// ---------------------------------------------------------------------------
// Degradation ladder
// ---------------------------------------------------------------------------

describe('shapeResponse', () => {
  it('returns the payload untouched when it fits', () => {
    const rows = [{ uuid: 'a1', name: 'api' }];

    const env = shapeResponse(rows, { instance: 'prod' });

    expect(env.data).toEqual(rows);
    expect(env.meta.truncation).toBeNull();
    expect(env.meta.truncated).toBe(0);
    expect(env.meta.count).toBe(1);
    expect(env.instance).toBe('prod');
  });

  it('applies the allowlist before measuring', () => {
    const rows = [{ uuid: 'a1', name: 'api', docker_compose_raw: 'x'.repeat(200_000) }];

    const env = shapeResponse(rows, {}, { fields: ['uuid', 'name'] });

    expect(env.data[0]).toEqual({ uuid: 'a1', name: 'api' });
    expect(env.meta.truncation).toBeNull();
  });

  it('step 1: drops declared columns before it drops rows', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      uuid: `u${i}`,
      name: `app-${i}`,
      description: 'd'.repeat(400),
    }));

    const env = shapeResponse(rows, {}, { prunable: ['description'], maxBytes: 5000 });

    expect(env.meta.truncation).toBe('field_prune');
    expect(env.meta.truncated).toBe(0);
    expect(env.data).toHaveLength(20);
    expect(env.data.every((row) => !('description' in row))).toBe(true);
    expect(env.meta.hint).toContain('description');
  });

  it('does not report a column as omitted when the payload never carried it', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ uuid: `u${i}`, blob: 'b'.repeat(400) }));

    const env = shapeResponse(rows, {}, { prunable: ['description'], maxBytes: 6000 });

    expect(env.meta.truncation).toBe('row_limit');
    expect(env.meta.hint ?? '').not.toContain('description');
  });

  it('step 2: drops rows once column pruning is not enough, and reports how many', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ uuid: `u${i}`, blob: 'b'.repeat(400) }));

    const env = shapeResponse(rows, {}, { maxBytes: 6000 });

    expect(env.meta.truncation).toBe('row_limit');
    expect(env.meta.truncated).toBeGreaterThan(0);
    expect(env.data.length + env.meta.truncated).toBe(50);
    expect(env.meta.count).toBe(env.data.length);
    // Row order is preserved: the head is kept so a cursor can continue from it.
    expect(env.data[0]?.uuid).toBe('u0');
  });

  it('step 2: moves the cursor to the last row that survived', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ uuid: `u${i}`, blob: 'b'.repeat(400) }));
    const hash = queryHash({ query: 'leads' });

    const env = shapeResponse(
      rows,
      {
        total: 187,
        cursor: { offset: 100, queryHash: hash },
        next_cursor: encodeCursor({ offset: 150, queryHash: hash }),
      },
      { maxBytes: 6000 },
    );

    // The caller's cursor was computed before shaping; honouring it would skip
    // every row the ladder dropped.
    expect(decodeCursor(env.meta.next_cursor ?? '')).toEqual({
      offset: 100 + env.data.length,
      queryHash: hash,
    });
    expect(env.meta.hint).toContain('Pass next_cursor to continue.');
  });

  it('step 3: caps one oversized value in place and leaves its siblings intact', () => {
    const rows = [
      { uuid: 'a1', name: 'api', docker_compose_raw: 'services:\n  web:\n'.repeat(3000) },
    ];

    const env = shapeResponse(rows, {}, { maxBytes: 4000 });

    expect(env.meta.truncation).toBe('field_value');
    expect(env.data[0]?.uuid).toBe('a1');
    expect(env.data[0]?.name).toBe('api');
    expect(env.data[0]?.docker_compose_raw).toMatch(
      /^<truncated: \d+ bytes — fetch in full via execute_read_operation>$/,
    );
  });

  it('descends the ladder in order, keeping each earlier step applied', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      uuid: `u${i}`,
      name: `app-${i}`,
      extra: 'e'.repeat(200),
      blob: 'b'.repeat(300),
    }));

    const env = shapeResponse(rows, {}, { prunable: ['extra'], maxBytes: 5000 });

    expect(env.meta.truncation).toBe('row_limit');
    expect(env.data.length).toBeLessThan(40);
    expect(env.data.every((row) => !('extra' in row))).toBe(true);
    expect(env.meta.hint).toContain('Fields omitted');
    expect(env.meta.hint).toContain('rows');
  });

  it('never returns an envelope larger than the budget', () => {
    const listOfManySmallRows = Array.from({ length: 5000 }, (_, i) => ({ uuid: `u${i}`, n: i }));
    const oneMonstrousRow = [{ uuid: 'a1', raw: 'z'.repeat(400_000) }];
    const singleObject = {
      uuid: 'a1',
      raw: 'z'.repeat(400_000),
      nested: { also_raw: 'y'.repeat(300_000) },
    };

    for (const payload of [listOfManySmallRows, oneMonstrousRow, singleObject]) {
      const env = shapeResponse(payload, { hint: 'Showing 50 of 187.' }, { maxBytes: 8000 });
      expect(bytes(env)).toBeLessThanOrEqual(8000);
    }
  });

  it('states facts in the hint rather than instructing the model', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ uuid: `u${i}`, blob: 'b'.repeat(400) }));

    const env = shapeResponse(
      rows,
      { hint: 'Showing 50 of 187. Pass next_cursor to continue, or narrow with query.' },
      { maxBytes: 6000 },
    );

    expect(env.meta.hint).toMatch(/^Showing 50 of 187\./);
    expect(env.meta.hint).not.toMatch(/\byou (should|must)\b/i);
  });
});

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

describe('cursors', () => {
  it('round-trips through an opaque token', () => {
    const cursor = { offset: 50, queryHash: queryHash({ query: 'leads', limit: 50 }) };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('hashes a query independently of key order', () => {
    expect(queryHash({ query: 'leads', limit: 50 })).toBe(queryHash({ limit: 50, query: 'leads' }));
    expect(queryHash({ query: 'leads' })).not.toBe(queryHash({ query: 'other' }));
  });

  it('rejects a cursor replayed against different filters', () => {
    const cursor = decodeCursor(
      encodeCursor({ offset: 50, queryHash: queryHash({ query: 'leads' }) }),
    );

    const error = captureError(() => assertCursorMatches(cursor, queryHash({ query: 'billing' })));

    expect(error).toBeInstanceOf(CoolifyError);
    expect((error as CoolifyError).message).toBe("Cursor does not match this query's filters.");
    expect((error as CoolifyError).hint).toBe('Re-run without cursor.');
    expect((error as CoolifyError).kind).toBe('validation');
  });

  it('rejects a malformed cursor', () => {
    const error = captureError(() => decodeCursor('not-a-real-cursor'));

    expect(error).toBeInstanceOf(CoolifyError);
    expect((error as CoolifyError).hint).toBe('Re-run without cursor.');
  });

  it('rejects a well-formed but nonsensical cursor', () => {
    const forged = Buffer.from(JSON.stringify({ offset: -1, queryHash: 'abc' })).toString(
      'base64url',
    );

    expect(() => decodeCursor(forged)).toThrow(CoolifyError);
  });
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

describe('log shaping', () => {
  it('strips CSI colour sequences', () => {
    expect(stripAnsi('\u001B[31mERROR\u001B[0m build failed')).toBe('ERROR build failed');
  });

  it('strips OSC hyperlink sequences', () => {
    expect(stripAnsi('\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007')).toBe('link');
  });

  it('strips ANSI even when nothing needs trimming', () => {
    const out = shapeLogs('\u001B[32m✓ done\u001B[0m');

    expect(out.text).toBe('✓ done');
    expect(out.truncated).toBe(false);
    expect(out.omittedLines).toBe(0);
  });

  it('trims from the front so the failure at the end survives', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'x'.repeat(100)}`);
    lines.push('FATAL: connection refused');

    const out = shapeLogs(lines.join('\n'), { maxBytes: 4000 });

    expect(out.truncated).toBe(true);
    expect(out.text).toContain('FATAL: connection refused');
    expect(out.text).not.toContain('line 0 ');
    expect(out.text).toMatch(/^\[\.\.\. \d+ earlier lines omitted, \d+ bytes \.\.\.\]\n/);
    expect(out.omittedLines).toBeGreaterThan(0);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(4000);
  });

  it('cuts inside a single line that is larger than the whole budget', () => {
    const out = shapeLogs(`${'A'.repeat(50_000)}TAIL`, { maxBytes: 2000 });

    expect(out.text).toContain('TAIL');
    expect(out.text).toMatch(/^\[\.\.\. \d+ earlier bytes omitted \.\.\.\]\n/);
    expect(out.omittedLines).toBe(0);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(2000);
  });

  it('never cuts a multibyte character in half', () => {
    const out = shapeLogs('é'.repeat(5000), { maxBytes: 1200 });

    expect(out.text).not.toContain('\uFFFD');
    expect(out.text.endsWith('é')).toBe(true);
  });

  it('applies maxLines before the byte budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);

    const out = shapeLogs(lines.join('\n'), { maxLines: 5 });

    expect(out.text.split('\n')).toHaveLength(6); // marker + 5 lines
    expect(out.text).toContain('line 99');
    expect(out.omittedLines).toBe(95);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('redact', () => {
  it('masks a registered secret', () => {
    expect(redact(`Authorization: Bearer ${REGISTERED_TOKEN}`)).toBe('Authorization: Bearer ***');
    expect(redact(`value=${PLAIN_SECRET};`)).toBe('value=***;');
  });

  it('masks a Sanctum-shaped token that was never registered', () => {
    const foreign = '42|zZ9yY8xX7wW6vV5uU4tT3sS2rR1qQ0pP9oO8nM4k';

    expect(redact(`env: OTHER_TOKEN=${foreign}`, [])).toBe('env: OTHER_TOKEN=***');
  });

  it('ignores secrets too short to be credentials', () => {
    // An empty entry (a token command that returned nothing) must not splice
    // the mask between every character of every response.
    expect(redact('a normal sentence', ['', 'a'])).toBe('a normal sentence');
  });

  it('keeps a registered secret out of a rendered envelope', () => {
    const env = shapeResponse({ note: `deploy used ${REGISTERED_TOKEN}` });

    const text = env && renderEnvelope(env).content[0]?.text;

    expect(text).toBeDefined();
    expect(text).not.toContain(REGISTERED_TOKEN);
    expect(text).toContain('***');
    expect(() => JSON.parse(text ?? '')).not.toThrow();
  });
});

describe('redactObject', () => {
  it('masks credential-shaped keys by default', () => {
    const out = redactObject(
      {
        name: 'api',
        password: 'hunter2',
        api_key: 'k-123',
        access_token: 't-123',
        nested: { db_secret: 's-123', private_key: 'p-123' },
        key_id: 'visible',
      },
      { secrets: [] },
    );

    expect(out.password).toBe('***');
    expect(out.api_key).toBe('***');
    expect(out.access_token).toBe('***');
    expect(out.nested.db_secret).toBe('***');
    expect(out.nested.private_key).toBe('***');
    expect(out.name).toBe('api');
    expect(out.key_id).toBe('visible');
  });

  it('masks every entry of a credential-shaped array', () => {
    const out = redactObject({ secrets: ['one', 'two'] }, { secrets: [] });

    expect(out.secrets).toEqual(['***', '***']);
  });

  it('leaves non-strings and empty strings alone', () => {
    const out = redactObject({ has_token: true, token_count: 3, password: '' }, { secrets: [] });

    expect(out.has_token).toBe(true);
    expect(out.token_count).toBe(3);
    expect(out.password).toBe('');
  });

  it('reveals Coolify secrets on request but never our own token', () => {
    const out = redactObject(
      { password: 'hunter2', build_log: `used ${REGISTERED_TOKEN}` },
      { reveal: true },
    );

    expect(out.password).toBe('hunter2');
    expect(out.build_log).not.toContain(REGISTERED_TOKEN);
    expect(out.build_log).toBe('used ***');
  });

  it('does not mutate the input object', () => {
    const input = { password: 'hunter2' };

    redactObject(input, { secrets: [] });

    expect(input.password).toBe('hunter2');
  });
});
