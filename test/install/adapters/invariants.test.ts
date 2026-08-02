/**
 * The three invariants that hold across every adapter.
 *
 *   idempotency  apply twice -> byte-identical output. Without it, `args` grows
 *                by two elements on every install and the drift detector starts
 *                reporting a change the user never made.
 *   round-trip   install -> uninstall -> the file is byte-identical to the
 *                original. This is the promise that makes the installer safe to
 *                try: whatever it did, undoing it puts the file back.
 *   docs-parity  the snippet in docs/clients/<client>.md equals what the writer
 *                produces. Documentation that has drifted from the code is
 *                worse than none: a user pastes it, the client silently ignores
 *                the entry, and the bug report says "coolify-mcp doesn't work".
 *
 * These are stated once here rather than per adapter on purpose. An invariant
 * that has to be re-asserted in every new adapter file is one a new adapter
 * will eventually be merged without.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServerEntry } from '../../../src/install/plan.js';
import type { InstallCtx, Operation, ServerEntry } from '../../../src/types.js';
import {
  ADAPTER_FIXTURES,
  FILE_CASES,
  MANAGED_NAME,
  adapterFor,
  at,
  install,
  makeSandbox,
  onlyTarget,
  parseConfig,
  uninstall,
  type AdapterFixtureSpec,
  type Sandbox,
} from './harness.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'clients');

let open: Sandbox[] = [];

function sandbox(...args: Parameters<typeof makeSandbox>): Sandbox {
  const created = makeSandbox(...args);
  open.push(created);
  return created;
}

afterEach(() => {
  for (const item of open) item.dispose();
  open = [];
});

const WRITING = ADAPTER_FIXTURES.filter((spec) => spec.printOnly !== true);

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe.each(WRITING)('$id — idempotency', (spec: AdapterFixtureSpec) => {
  it.each(['empty', 'populated', 'hostile'] as const)(
    'installing twice over the %s fixture produces identical bytes',
    async (fixture) => {
      const box = sandbox(spec, fixture);

      await install(box);
      const afterFirst = box.read();
      const second = await install(box);

      expect(box.read()).toBe(afterFirst);
      // Not merely equal bytes: the second run must know it had nothing to do,
      // so a client whose config file is watched is not touched at all.
      expect(onlyTarget(second).status).toBe('unchanged');
    },
  );

  it('does not grow the args array on re-install', async () => {
    // Concatenating instead of replacing arrays is the classic merge bug, and
    // it is invisible until `npx` is handed `-y coolify-mcp -y coolify-mcp`.
    const box = sandbox(spec, 'populated');

    await install(box);
    await install(box);
    await install(box);

    const entry = await entryOf(box, spec);
    const args = at(entry, ['args']) ?? at(entry, ['command']);
    expect(Array.isArray(args)).toBe(true);
    expect((args as unknown[]).filter((item) => item === '-y')).toHaveLength(1);
  });
});

async function entryOf(box: Sandbox, spec: AdapterFixtureSpec): Promise<unknown> {
  const text = box.read();
  if (text === null) return undefined;
  return at(await parseConfig(text, spec.format), [...spec.container, MANAGED_NAME]);
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe.each(WRITING)('$id — round trip', (spec: AdapterFixtureSpec) => {
  it.each(FILE_CASES.filter((name) => name !== 'conflict'))(
    'install then uninstall restores the %s fixture byte for byte',
    async (fixture) => {
      const box = sandbox(spec, fixture);

      const installed = await install(box);
      expect(onlyTarget(installed).status).toBe('written');
      expect(box.read()).not.toBe(box.before);

      const removed = await uninstall(box);
      expect(onlyTarget(removed).status).toBe('written');
      expect(box.read()).toBe(box.before);
    },
  );

  it('leaves no configuration behind when it created the file itself', async () => {
    // The file is NOT deleted, deliberately: the writers never prune the
    // document root, because removing a client's config file outright is a
    // bigger action than the one the user asked for. What must be gone is every
    // trace of our entry, including the container we created for it.
    const box = sandbox(spec, 'empty');

    await install(box);
    await uninstall(box);

    const text = box.read();
    expect(text ?? '').not.toContain(MANAGED_NAME);
    const parsed = (await parseConfig(text ?? '', spec.format)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([]);
  });

  it('refuses to remove an entry it has no record of writing', async () => {
    const box = sandbox(spec, 'conflict');

    const result = await uninstall(box);

    expect(onlyTarget(result).status).toBe('skipped');
    expect(onlyTarget(result).issues.map((issue) => issue.code)).toContain('entry-unmanaged');
    expect(box.read()).toBe(box.before);
  });

  it('removes an unmanaged entry only under --force', async () => {
    const box = sandbox(spec, 'conflict');

    const result = await uninstall(box, { force: true });

    expect(onlyTarget(result).status).toBe('written');
    expect(await entryOf(box, spec)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Docs parity
// ---------------------------------------------------------------------------

/**
 * THE PARITY CONTRACT, so the docs and this test cannot disagree about what is
 * being compared:
 *
 *  - `docs/clients/<client>.md` MUST exist for every adapter in the registry.
 *  - It MUST contain a fenced code block that parses in the client's config
 *    format and contains the adapter's managed key path
 *    (e.g. `context_servers.coolify`).
 *  - That entry MUST agree with `planWrite` on the SHAPE: the container key,
 *    `command`, `args` (or the single combined command array), and the spelling
 *    of the env container (`env` vs `environment`).
 *  - Any `${...}` reference in the documented env block MUST use the syntax
 *    this client actually expands.
 *
 * Deliberately NOT compared: the package version, and the contents of the env
 * block. Docs legitimately show `COOLIFY_BASE_URL` and `COOLIFY_API_TOKEN`,
 * which the installer never writes — it writes pointer config only. Comparing
 * those would force the docs to be less useful than they should be.
 */

const DOC_TARGETS = [...new Map(ADAPTER_FIXTURES.map((spec) => [spec.doc, spec])).values()];

interface DocBlock {
  language: string;
  body: string;
}

function fencedBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const fence = /^```([A-Za-z0-9_-]*)\r?\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null = fence.exec(markdown);
  while (match !== null) {
    blocks.push({ language: (match[1] ?? '').toLowerCase(), body: match[2] ?? '' });
    match = fence.exec(markdown);
  }
  return blocks;
}

/** Strips the version so a release does not have to touch every doc page. */
function normalizeSpec(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/coolify-mcp@[^"'\s\]]+/g, 'coolify-mcp@X');
  if (Array.isArray(value)) return value.map(normalizeSpec);
  return value;
}

function envKeyOf(entry: unknown): string | undefined {
  if (at(entry, ['environment']) !== undefined) return 'environment';
  if (at(entry, ['env']) !== undefined) return 'env';
  return undefined;
}

const DOC_CTX: InstallCtx = {
  homeDir: '/home/dev',
  projectRoot: '/repo',
  platform: 'linux',
  packageSpec: '@done-dynamics/coolify-mcp@latest',
  transport: 'stdio',
  connection: 'prod',
};

/**
 * BUILT BY THE INSTALLER, never restated here.
 *
 * This was a hand-written literal that mirrored `buildServerEntry`, and it could
 * therefore never fail. When the installer's argv named the wrong bin, the copy
 * named the wrong bin too, so docs-parity compared two copies of one mistake and
 * stayed green while every documented snippet was unusable. Deriving it means a
 * change to the real argv surfaces here as a documentation diff, which is the
 * only thing this invariant was ever for.
 */
const DOC_ENTRY: ServerEntry = buildServerEntry(DOC_CTX);

/**
 * The entry the installer would produce, read back out of its own plan.
 *
 * Print-only adapters plan no write at all — their output is the candidate
 * snippet they print for the user to paste — so the snippet is dug out of the
 * note. That is exactly the text the docs must not diverge from.
 */
async function plannedEntry(spec: AdapterFixtureSpec): Promise<unknown> {
  const operations: Operation[] = adapterFor(spec.id).planWrite(DOC_ENTRY, DOC_CTX);
  const keyPath = [...spec.container, MANAGED_NAME];

  const write = operations.find(
    (op) => op.kind === 'json-merge' || op.kind === 'jsonc-merge' || op.kind === 'yaml-merge',
  );
  if (write !== undefined) return at(write, ['value']);

  // TOML carries rendered text rather than a value; parse it back so the
  // comparison is structural for every format.
  const append = operations.find((op) => op.kind === 'toml-append');
  if (append !== undefined) {
    return at(await parseConfig(String(at(append, ['text'])), 'toml'), keyPath);
  }

  for (const operation of operations) {
    if (operation.kind !== 'note') continue;
    const candidate = await entryInText(operation.message, spec.format, keyPath);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/** First parse of `text` in `format` that actually defines `keyPath`. */
async function entryInText(
  text: string,
  format: AdapterFixtureSpec['format'],
  keyPath: readonly string[],
): Promise<unknown> {
  try {
    return at(await parseConfig(text, format), keyPath);
  } catch {
    return undefined;
  }
}

interface DocumentedEntry {
  block: DocBlock;
  value: unknown;
}

/** The first fenced block in the page that defines our entry. */
async function documentedEntry(
  markdown: string,
  spec: AdapterFixtureSpec,
): Promise<DocumentedEntry | undefined> {
  const keyPath = [...spec.container, MANAGED_NAME];
  for (const block of fencedBlocks(markdown)) {
    const value = await entryInText(block.body, spec.format, keyPath);
    if (value !== undefined) return { block, value };
  }
  return undefined;
}

describe.each(DOC_TARGETS)('docs parity — $doc', (spec: AdapterFixtureSpec) => {
  const docPath = path.join(DOCS_DIR, `${spec.doc}.md`);

  it('has a documentation page', () => {
    // A missing page is a failure, never a skip: a silently skipped parity test
    // is how documentation drifts in the first place.
    expect(existsSync(docPath), `${docPath} is missing`).toBe(true);
  });

  it('documents the same entry the writer produces', async () => {
    expect(existsSync(docPath), `${docPath} is missing`).toBe(true);
    const keyPath = [...spec.container, MANAGED_NAME];

    const documented = await documentedEntry(readFileSync(docPath, 'utf8'), spec);
    expect(
      documented,
      `no fenced ${spec.format} block in ${docPath} defines ${keyPath.join('.')}`,
    ).toBeDefined();

    const expected = await plannedEntry(spec);
    expect(expected, `${spec.id} planned no entry to compare against`).toBeDefined();

    expect(normalizeSpec(at(documented?.value, ['command']))).toEqual(
      normalizeSpec(at(expected, ['command'])),
    );
    expect(normalizeSpec(at(documented?.value, ['args']))).toEqual(
      normalizeSpec(at(expected, ['args'])),
    );
    // `env` vs `environment` is a silent failure: the client reads no
    // environment at all and the server reports a missing token.
    expect(envKeyOf(documented?.value) ?? envKeyOf(expected)).toBe(
      envKeyOf(expected) ?? envKeyOf(documented?.value),
    );
  });

  it('uses the reference syntax this client actually expands', async () => {
    expect(existsSync(docPath), `${docPath} is missing`).toBe(true);

    // Only inside the config block — prose that explains "this client may not
    // expand ${VAR}" is exactly what these pages should say.
    const documented = await documentedEntry(readFileSync(docPath, 'utf8'), spec);
    const references = (documented?.block.body ?? '').match(/\$\{[^}]*\}/g) ?? [];

    for (const reference of references) {
      if (spec.doc === 'cursor') {
        // Cursor expands `${env:NAME}` and forwards `${NAME}` verbatim, which
        // reaches the server as the literal text of a bearer token.
        expect(reference, `${docPath} shows Claude Code syntax for Cursor`).toMatch(
          /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/,
        );
      } else if (spec.doc === 'claude-code') {
        expect(reference, `${docPath} shows a reference Claude Code does not expand`).toMatch(
          /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/,
        );
      } else {
        // Every other client in the matrix is unconfirmed on expansion, so the
        // installer drops references rather than writing them. A pasteable
        // snippet that shows one tells the user to do what the writer refuses.
        expect(
          reference,
          `${docPath} puts a \${...} reference in a pasteable snippet for a client that may not expand it`,
        ).toBe('');
      }
    }
  });
});
