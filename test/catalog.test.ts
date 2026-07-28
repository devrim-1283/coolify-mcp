/**
 * The generated catalog.
 *
 * Everything here is a property of code a generator emits, which is precisely
 * why it needs tests: a regeneration against a newer Coolify release can change
 * any of it, and the whole security model downstream — which generic door
 * exists, what `search_operations` will show a model, what the transport
 * refuses — is computed from these rows.
 *
 * Two properties matter more than the rest:
 *
 *  1. THE post_required STUBS ARE GONE. Coolify routes about sixteen GET paths
 *     to a controller that only answers "use POST". If any of them were in the
 *     catalog, `search_operations("restart application")` would return a GET —
 *     carrying `readOnlyHint: true` through `execute_read_operation` — that
 *     restarts an application. A read-annotated tool that changes state is the
 *     worst single failure this design can produce.
 *  2. EVERY DELETE IS DESTRUCTIVE, and so are the two operations that are not
 *     DELETEs but switch the API off. "Block the DELETEs" misses both, and
 *     losing API access locks the token out of its own instance.
 */

import { describe, expect, it } from 'vitest';

import { CATALOG } from '../src/generated/catalog.js';
import {
  METADATA,
  catalogView,
  getOperation,
  isReachable,
  searchOperations,
} from '../src/catalog/index.js';
import type { CatalogOperation, DangerClass } from '../src/types.js';

const OPEN = { allowDestructive: true, readOnly: false } as const;
const GATED = { allowDestructive: false, readOnly: false } as const;
const LOCKED = { allowDestructive: false, readOnly: true } as const;

/** The two hand-maintained overrides the transport also carries, by id. */
const API_KILL_SWITCHES = ['disable-api', 'disable-mcp'] as const;

function ids(rows: readonly CatalogOperation[]): string[] {
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// post_required stub stripping
// ---------------------------------------------------------------------------

describe('post_required stubs', () => {
  it('leaves no GET whose path ends in /start, /restart or /stop', () => {
    const survivors = CATALOG.filter(
      (operation) => operation.method === 'GET' && /\/(start|restart|stop)$/.test(operation.path),
    );

    expect(ids(survivors)).toEqual([]);
  });

  it('leaves no GET on the other action routes either', () => {
    // Same controller, same failure: a GET that acts. /validate, /enable,
    // /disable and /deploy all route to post_required.
    const survivors = CATALOG.filter(
      (operation) =>
        operation.method === 'GET' && /\/(validate|enable|disable|deploy)$/.test(operation.path),
    );

    expect(ids(survivors)).toEqual([]);
  });

  it('keeps the POST spellings of those routes', () => {
    // The stripping must be pattern-based on the stub, not on the path: removing
    // the POSTs too would make start/stop/restart unreachable entirely.
    const actions = CATALOG.filter(
      (operation) => /\/(start|restart|stop)$/.test(operation.path) && operation.method === 'POST',
    );

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((operation) => operation.danger === 'write')).toBe(true);
  });

  it('says nothing survives that only answers "use POST"', () => {
    const stubs = CATALOG.filter((operation) => /post_required/i.test(operation.summary));

    expect(ids(stubs)).toEqual([]);
  });

  it('reports arithmetic that adds up', () => {
    expect(METADATA.rawOperationCount - METADATA.strippedCount).toBe(METADATA.operationCount);
    expect(METADATA.operationCount).toBe(CATALOG.length);
  });

  it('every GET in the catalog is classified safe', () => {
    // The converse of stub stripping: if a GET were left classified `write` or
    // `destructive` it would have no door at all, since the read door only
    // dispatches GET.
    const misfiled = CATALOG.filter(
      (operation) => operation.method === 'GET' && operation.danger !== 'safe',
    );

    expect(ids(misfiled)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Danger classification
// ---------------------------------------------------------------------------

describe('danger classification', () => {
  it('files every DELETE as destructive', () => {
    const deletes = CATALOG.filter((operation) => operation.method === 'DELETE');

    expect(deletes.length).toBeGreaterThan(0);
    expect(ids(deletes.filter((operation) => operation.danger !== 'destructive'))).toEqual([]);
  });

  it.each(API_KILL_SWITCHES)('files %s as destructive even though it is a POST', (id) => {
    // Turning the API off is irreversible from the token's point of view: the
    // enable endpoint sits behind the same switch.
    const operation = getOperation(id);

    expect(operation, `${id} is not in the catalog`).toBeDefined();
    expect(operation?.method).toBe('POST');
    expect(operation?.danger).toBe('destructive');
  });

  it('files nothing else as destructive without being a DELETE', () => {
    // A widening here is a real change to the tool surface, so it should have to
    // be made deliberately rather than arriving with a regeneration.
    const unexpected = CATALOG.filter(
      (operation) =>
        operation.danger === 'destructive' &&
        operation.method !== 'DELETE' &&
        !(API_KILL_SWITCHES as readonly string[]).includes(operation.id),
    );

    expect(ids(unexpected)).toEqual([]);
  });

  it('leaves the enable counterparts as ordinary writes', () => {
    // Turning the API back on destroys nothing; classifying it destructive would
    // put recovery behind the same flag as the thing you are recovering from.
    for (const id of ['enable-api', 'enable-mcp']) {
      expect(getOperation(id)?.danger, id).toBe('write');
    }
  });

  it('flags cloud provisioning as costly without gating it', () => {
    const costly = CATALOG.filter((operation) => operation.costly === true);

    expect(costly.length).toBeGreaterThan(0);
    for (const operation of costly) {
      expect(operation.method, operation.id).toBe('POST');
      expect(operation.danger, operation.id).not.toBe('destructive');
      expect(operation.path, operation.id).toMatch(/hetzner|vultr|digitalocean/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural sanity of the generated rows
// ---------------------------------------------------------------------------

describe('catalog rows', () => {
  it('have unique ids', () => {
    const seen = new Set(ids(CATALOG));

    expect(seen.size).toBe(CATALOG.length);
  });

  it('list every placeholder their path template contains', () => {
    // The generic executor substitutes from `pathParams`; a placeholder missing
    // from the list would be sent literally and produce an unreadable 404.
    for (const operation of CATALOG) {
      const placeholders = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      expect([...placeholders].sort(), operation.id).toEqual([...operation.pathParams].sort());
    }
  });

  it('start every path with a slash and carry no query string', () => {
    for (const operation of CATALOG) {
      expect(operation.path.startsWith('/'), operation.id).toBe(true);
      expect(operation.path, operation.id).not.toMatch(/[?#]/);
    }
  });

  it('give every operation a summary', () => {
    for (const operation of CATALOG) {
      expect(operation.summary.trim().length, operation.id).toBeGreaterThan(0);
    }
  });

  it('declare no request body on a GET', () => {
    for (const operation of CATALOG.filter((row) => row.method === 'GET')) {
      expect(operation.hasBody, operation.id).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The view — searchable surface must equal the reachable surface
// ---------------------------------------------------------------------------

describe('catalogView', () => {
  it('hides destructive operations entirely when the flag is off', () => {
    // Omitted, never labelled: a model that finds `delete-application-by-uuid`
    // and then discovers there is no door for it stalls, and the server looks
    // like it is withholding a capability.
    const view = catalogView(GATED);

    expect(view.some((operation) => operation.danger === 'destructive')).toBe(false);
    expect(view.length).toBeLessThan(CATALOG.length);
  });

  it('shows them when the flag is on', () => {
    expect(catalogView(OPEN)).toHaveLength(CATALOG.length);
  });

  it('admits nothing but reads on a read-only server, flag or no flag', () => {
    const view = catalogView(LOCKED);

    expect(view.every((operation) => operation.danger === 'safe')).toBe(true);
    expect(catalogView({ allowDestructive: true, readOnly: true })).toEqual(view);
  });

  it('agrees with isReachable row by row', () => {
    // One predicate for both, so a per-call re-check and the view can never
    // disagree about the same operation.
    for (const options of [OPEN, GATED, LOCKED]) {
      const view = new Set(ids(catalogView(options)));
      for (const operation of CATALOG) {
        expect(view.has(operation.id), `${operation.id} @ ${JSON.stringify(options)}`).toBe(
          isReachable(operation, options),
        );
      }
    }
  });

  it('gives every reachable operation a door to run through', () => {
    // safe -> execute_read_operation, write -> execute_write_operation,
    // destructive -> execute_destructive_operation. A fourth class would be an
    // operation nothing can run.
    const classes = new Set<DangerClass>(CATALOG.map((operation) => operation.danger));

    expect([...classes].sort()).toEqual(['destructive', 'safe', 'write']);
  });
});

// ---------------------------------------------------------------------------
// Search never widens the view it was given
// ---------------------------------------------------------------------------

describe('searchOperations', () => {
  it('cannot return an operation the view excluded', () => {
    const results = searchOperations(catalogView(GATED), {
      query: 'delete application',
      limit: 100,
    });

    expect(results.every((operation) => operation.danger !== 'destructive')).toBe(true);
  });

  it('finds the delete once the flag is on', () => {
    const results = searchOperations(catalogView(OPEN), { query: 'delete application', limit: 20 });

    expect(ids(results)).toContain('delete-application-by-uuid');
  });

  it('resolves an id typed verbatim to that exact operation', () => {
    const results = searchOperations(catalogView(OPEN), { query: 'get-application-by-uuid' });

    expect(results[0]?.id).toBe('get-application-by-uuid');
  });

  it('finds environment variables, which Coolify calls `envs`', () => {
    // Nothing in the id, path or summary of `list-envs-by-application-uuid`
    // contains a word anybody types, so without the alias one of the most
    // valuable reads on the surface is unreachable by search.
    const results = searchOperations(catalogView(GATED), {
      query: 'environment variables',
      limit: 20,
    });

    expect(ids(results)).toContain('list-envs-by-application-uuid');
  });

  it('browses a family with no query rather than returning nothing', () => {
    const results = searchOperations(catalogView(GATED), { family: 'databases', limit: 100 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((operation) => operation.family === 'databases')).toBe(true);
  });

  it('carries the danger class and the costly note on every row', () => {
    const results = searchOperations(catalogView(OPEN), { query: 'hetzner', limit: 20 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((operation) => typeof operation.danger === 'string')).toBe(true);
    expect(results.some((operation) => operation.costly === true)).toBe(true);
  });

  it('never returns more rows than the limit allows', () => {
    expect(searchOperations(catalogView(OPEN), { limit: 3 })).toHaveLength(3);
    // Clamped rather than rejected: an over-large limit is a misjudgement, not
    // a reason to spend a turn on an error.
    expect(searchOperations(catalogView(OPEN), { limit: 10_000 }).length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('catalog metadata', () => {
  it('records the spec it was built from', () => {
    // Surfaced on a zero-result search: on a self-hosted PaaS the likeliest
    // cause of a miss is an instance newer than the catalog we shipped.
    expect(METADATA.coolifyVersion).toMatch(/^\d+\.\d+/);
    expect(METADATA.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(METADATA.generatedAt))).toBe(false);
  });
});
