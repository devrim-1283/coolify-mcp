/**
 * Regression cover for doctor reading the package spec out of a client config.
 *
 * The 0.1.0 release had to be published as `@done-dynamics/coolify-mcp`: npm's
 * similarity check strips punctuation, so `coolify-mcp` normalises to
 * `coolifymcp`, which already exists and belongs to somebody else. The command
 * this package installs is still `coolify-mcp`, so from that release onward the
 * package name and the program name are two different strings.
 *
 * Doctor reads the spec back out of every client config to answer one question:
 * do the clients on this machine agree on which version to run? The extractor
 * matched with `word === 'coolify-mcp' || word.startsWith('coolify-mcp@')`,
 * which the scoped name satisfies neither of. The rename would have turned that
 * check off — silently, with every test still green, because nothing asserted
 * on the extraction.
 *
 * The case that matters most is the mixed one. A machine that was configured
 * before the rename and again after holds one entry of each spelling, and that
 * is precisely the drift doctor exists to report.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../src/install/doctor.js';

const created: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coolify-mcp-spec-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a Claude Code user config whose coolify entry carries `spec`. */
async function scanWithSpec(spec: string) {
  const home = sandbox();
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          coolify: { command: 'npx', args: ['-y', spec], env: {} },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  // An empty cwd keeps project-scope adapters from finding this repo's own files.
  return runDoctor({
    homeDir: home,
    cwd: sandbox(),
    env: {},
    packageVersion: '1.4.2',
    packageName: '@done-dynamics/coolify-mcp',
  });
}

function coolifyClients(report: Awaited<ReturnType<typeof scanWithSpec>>) {
  return report.clients.filter((client) => client.packageSpec !== undefined);
}

describe('reading the installed spec back out of a config', () => {
  it.each([
    ['the scoped name it publishes under now', '@done-dynamics/coolify-mcp@latest'],
    ['a pinned scoped version', '@done-dynamics/coolify-mcp@1.4.2'],
    ['the unscoped name written before 0.1.0', 'coolify-mcp@latest'],
    ['an unscoped pin', 'coolify-mcp@0.9.0'],
    ['a bare name with no version at all', 'coolify-mcp'],
  ])('recognises %s', async (_why, spec) => {
    const report = await scanWithSpec(spec);

    expect(coolifyClients(report).map((client) => client.packageSpec)).toContain(spec);
  });

  it('does not claim an unrelated package as its own', async () => {
    // `coolifymcp` is the package whose existence forced the rename. It is
    // somebody else's, and an extractor loose enough to swallow it would report
    // version drift between two different projects.
    const report = await scanWithSpec('coolifymcp@2.0.1');

    expect(coolifyClients(report).map((client) => client.packageSpec)).not.toContain(
      'coolifymcp@2.0.1',
    );
  });
});
