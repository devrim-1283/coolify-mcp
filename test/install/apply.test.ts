/**
 * apply() — the layer that decides WHETHER and HOW, never WHAT.
 *
 * Three claims the design makes about this module are load-bearing enough to be
 * asserted rather than trusted:
 *
 *  1. `--dry-run` is the SAME code path with the write suppressed, so the bytes
 *     a user approves are produced by the code that then runs. A separate
 *     "preview" implementation that can drift from the real one is the classic
 *     way a confirmed diff turns out not to be what happened.
 *  2. A target is ALL OR NOTHING. A half-applied plan is worse than no plan,
 *     because the user now has to work out which half.
 *  3. Anything a human reads is REDACTED, and the payload is not. Those are
 *     different values on purpose: redacting the payload would write `***` into
 *     the user's config, and not redacting the diff would put somebody else's
 *     plaintext Coolify token into a terminal, an issue report or a screen share.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readState } from '../../src/install/state.js';
import {
  ADAPTER_FIXTURES,
  MANAGED_NAME,
  install,
  makeSandbox,
  onlyTarget,
  uninstall,
  type Sandbox,
} from './adapters/harness.js';

/** Claude Code user scope: plain JSON, and the file the design names as doctor's first fixture. */
const CLAUDE = ADAPTER_FIXTURES.find((spec) => spec.id === 'claude-code-user');
if (CLAUDE === undefined) throw new Error('claude-code-user is missing from the fixture table');

const CODEX = ADAPTER_FIXTURES.find((spec) => spec.id === 'codex-user');
if (CODEX === undefined) throw new Error('codex-user is missing from the fixture table');

/**
 * A live Coolify token sitting in plaintext in somebody else's MCP entry.
 * Shaped like a real Sanctum token (`<id>|<40 chars>`) because that shape is
 * what the redactor's backstop matches — this value was never resolved by this
 * process, so nothing registered it.
 */
const FOREIGN_PLAINTEXT_TOKEN = '42|zZ9yY8xX7wW6vV5uU4tT3sS2rR1qQ0pP9oO8nM4k';

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

// ---------------------------------------------------------------------------
// Dry run fidelity
// ---------------------------------------------------------------------------

describe('--dry-run', () => {
  it('writes nothing', async () => {
    const box = sandbox(CLAUDE, 'populated');

    const result = await install(box, { dryRun: true });

    expect(onlyTarget(result).status).toBe('printed');
    expect(box.read()).toBe(box.before);
  });

  it('produces exactly the bytes a real run then writes', async () => {
    // The whole point. If these two ever differ, every `--dry-run` a user has
    // ever approved was a description of something else.
    const preview = sandbox(CLAUDE, 'populated');
    const real = sandbox(CLAUDE, 'populated');

    const dry = await install(preview, { dryRun: true });
    await install(real);

    expect(onlyTarget(dry).files).toHaveLength(1);
    expect(onlyTarget(dry).files[0]?.after).toBe(real.read());
  });

  it('is implied by --print', async () => {
    const box = sandbox(CLAUDE, 'populated');

    const result = await install(box, { print: true });

    expect(onlyTarget(result).status).toBe('printed');
    expect(box.read()).toBe(box.before);
  });

  it('records no install state, so a preview cannot claim we wrote something', async () => {
    const box = sandbox(CLAUDE, 'populated');

    await install(box, { dryRun: true });

    const state = await readState(box.ctx.homeDir);
    expect(state.state.installs).toEqual([]);
  });

  it('shows the diff as a unified diff against what is on disk', async () => {
    const box = sandbox(CLAUDE, 'populated');

    const result = await install(box, { dryRun: true });
    const diff = onlyTarget(result).files[0]?.diff ?? '';

    expect(diff).toContain(box.configPath);
    expect(diff).toMatch(/^@@ /m);
    expect(diff).toMatch(new RegExp(`^\\+.*"${MANAGED_NAME}"`, 'm'));
    // Context lines around the change, so the reviewer can see where it lands.
    expect(diff).toMatch(/^ {2}/m);
  });
});

// ---------------------------------------------------------------------------
// Redaction of the display artefacts
// ---------------------------------------------------------------------------

describe('what a human is shown', () => {
  function seedWithPlaintextToken(box: Sandbox): void {
    const existing = JSON.parse(readFileSync(box.configPath, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    (existing['mcpServers'] as Record<string, Record<string, unknown>>)['other-tool'] = {
      command: 'npx',
      args: ['-y', 'other-mcp'],
      env: { OTHER_API_TOKEN: FOREIGN_PLAINTEXT_TOKEN },
    };
    writeFileSync(box.configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  }

  it('redacts a plaintext credential out of the diff and the preview', async () => {
    // This is the file the design says doctor's first fixture will be: a live
    // Coolify token sitting in plaintext in ~/.claude.json. `--dry-run` output
    // ends up in terminals, issue reports and screen shares.
    const box = sandbox(CLAUDE, 'populated');
    seedWithPlaintextToken(box);

    const result = await install(box, { dryRun: true });
    const file = onlyTarget(result).files[0];

    expect(file?.diff).not.toContain(FOREIGN_PLAINTEXT_TOKEN);
    expect(file?.preview).not.toContain(FOREIGN_PLAINTEXT_TOKEN);
    expect(file?.preview).toContain('***');
  });

  it('does NOT redact the payload, because the payload is what gets written', async () => {
    // Redacting `after` would write `***` into the user's config in place of
    // another tool's working credential.
    const box = sandbox(CLAUDE, 'populated');
    seedWithPlaintextToken(box);

    const result = await install(box, { dryRun: true });

    expect(onlyTarget(result).files[0]?.after).toContain(FOREIGN_PLAINTEXT_TOKEN);
  });

  it('leaves the other tool`s credential exactly as it was on a real install', async () => {
    const box = sandbox(CLAUDE, 'populated');
    seedWithPlaintextToken(box);

    await install(box);

    expect(box.read()).toContain(FOREIGN_PLAINTEXT_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// All or nothing
// ---------------------------------------------------------------------------

describe('a target that cannot be written', () => {
  /** Seeds a file the client owns but that no parser can read. */
  function seedBroken(box: Sandbox, contents: string): void {
    mkdirSync(dirname(box.configPath), { recursive: true });
    writeFileSync(box.configPath, contents, 'utf8');
  }

  it('is blocked, and not one byte of it changes', async () => {
    // Appending a valid section to a file that already fails to parse produces a
    // file that is still broken, but longer — and the user's next move (find the
    // syntax error) just got harder.
    const box = sandbox(CODEX, 'empty');
    const broken = '# Codex\nmodel = \n\n[mcp_servers.other]\ncommand = "other"\n';
    seedBroken(box, broken);

    const result = await install(box);

    expect(onlyTarget(result).status).toBe('blocked');
    expect(onlyTarget(result).error).toBeTruthy();
    expect(box.read()).toBe(broken);
  });

  it('records no install state for a blocked target', async () => {
    const box = sandbox(CODEX, 'empty');
    seedBroken(box, 'model = \n');

    await install(box);

    const state = await readState(box.ctx.homeDir);
    expect(state.state.installs).toEqual([]);
  });

  it('reports it as blocked rather than skipped, so the exit code is non-zero', async () => {
    const box = sandbox(CODEX, 'empty');
    seedBroken(box, 'model = \n');

    const result = await install(box);

    expect(onlyTarget(result).status).not.toBe('skipped');
    expect(onlyTarget(result).issues.some((issue) => issue.severity === 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Native client CLIs
// ---------------------------------------------------------------------------

describe('exec operations', () => {
  it('are reported but never run without allowExec', async () => {
    // apply() has no human in front of it, and a subprocess is the one operation
    // it can neither preview nor undo. The CLI turns this on, because there it is
    // a choice somebody made.
    const box = sandbox(CLAUDE, 'populated');

    const result = await install(box);

    // The adapter declares a native CLI; the planner does not emit an exec
    // operation for it, so nothing can run by accident either way.
    expect(box.adapter.nativeCli?.bin).toBe('claude');
    expect(onlyTarget(result).commands).toEqual([]);
    expect(onlyTarget(result).status).toBe('written');
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

describe('install state', () => {
  it('records where the entry went and what it hashed to', async () => {
    const box = sandbox(CLAUDE, 'populated');

    await install(box);

    const record = (await readState(box.ctx.homeDir)).state.installs[0];
    expect(record?.adapterId).toBe('claude-code-user');
    expect(record?.path).toBe(box.configPath);
    expect(record?.serverName).toBe(MANAGED_NAME);
    expect(record?.managedKeyPath).toEqual(['mcpServers', MANAGED_NAME]);
    expect(record?.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.packageSpec).toBe(box.ctx.packageSpec);
  });

  it('hashes what the client will read, not what we intended to write', async () => {
    // Fingerprinting our intention would report drift on the very next run,
    // because the writers normalise.
    const box = sandbox(CLAUDE, 'populated');

    await install(box);
    const first = (await readState(box.ctx.homeDir)).state.installs[0]?.entryHash;
    await install(box);
    const second = (await readState(box.ctx.homeDir)).state.installs[0]?.entryHash;

    expect(second).toBe(first);
  });

  it('drops the record on uninstall', async () => {
    const box = sandbox(CLAUDE, 'populated');

    await install(box);
    await uninstall(box);

    expect((await readState(box.ctx.homeDir)).state.installs).toEqual([]);
  });

  it('stores nothing secret', async () => {
    const box = sandbox(CLAUDE, 'populated', { connection: 'prod' });

    await install(box);

    const raw = JSON.stringify((await readState(box.ctx.homeDir)).state);
    expect(raw).not.toMatch(/\b\d+\|[A-Za-z0-9]{40}\b/);
    expect(raw.toLowerCase()).not.toContain('token');
  });
});

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

describe('writing', () => {
  it.runIf(process.platform !== 'win32')('preserves the file mode it found', async () => {
    // ~/.claude.json is routinely 0600. Widening it during an install would be a
    // permission change the user never asked for and would not notice.
    const box = sandbox(CLAUDE, 'populated');
    chmodSync(box.configPath, 0o600);

    await install(box);

    expect(statSync(box.configPath).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', async () => {
    const box = sandbox(CLAUDE, 'populated');

    await install(box);

    const { readdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const leftovers = readdirSync(dirname(box.configPath)).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
