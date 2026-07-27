/**
 * Adapter golden fixtures — four cases for every client.
 *
 * The installer edits files it does not own and that hold every other MCP
 * server the user has. The failure this suite exists to prevent is not "our
 * entry is wrong", it is "somebody else's entry is gone" — the incident that
 * produced the Codex `url` rule, where one bad key took a whole config.toml
 * down and with it every MCP server in it.
 *
 * So the assertions are mostly about what did NOT change:
 *
 *   empty      the right file is created, at the right path, with our entry
 *   populated  unrelated servers and unrelated top-level settings come back
 *              BYTE for byte
 *   hostile    a BOM, CRLF, tabs — and for JSONC/TOML comments and a trailing
 *              comma — all survive. This is the single most likely thing to
 *              regress, because every naive `JSON.parse`/`stringify` round trip
 *              silently destroys it
 *   conflict   an entry we wrote and the user has since edited is left alone
 *              and reported; `--update` is what replaces it
 *
 * `empty` is the absence of a fixture file rather than an empty one — see
 * harness.ts for the convention.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Operation } from '../../../src/types.js';
import {
  ADAPTER_FIXTURES,
  FILE_CASES,
  MANAGED_NAME,
  PACKAGE_SPEC,
  at,
  install,
  issueCodes,
  makeSandbox,
  onlyTarget,
  parseConfig,
  readManagedEntry,
  readSibling,
  uninstall,
  type AdapterFixtureSpec,
  type Sandbox,
} from './harness.js';

const BOM = '\uFEFF';

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

/** Text of the sibling server's block, so it can be checked for byte identity. */
function siblingBlock(text: string, sibling: string): string {
  const start = text.indexOf(`"${sibling}"`);
  if (start === -1) return '';
  // Balanced-brace scan from the value's opening brace: enough for fixtures we
  // wrote ourselves, and it fails visibly (empty string) rather than silently.
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

const WRITING = ADAPTER_FIXTURES.filter((spec) => spec.printOnly !== true);

// ---------------------------------------------------------------------------
// empty
// ---------------------------------------------------------------------------

describe.each(WRITING)('$id — empty', (spec: AdapterFixtureSpec) => {
  it('creates the config file at the path the adapter resolves', async () => {
    const box = sandbox(spec, 'empty');
    expect(box.before).toBeNull();

    const result = await install(box);

    expect(onlyTarget(result).status).toBe('written');
    expect(onlyTarget(result).path).toBe(box.configPath);
    expect(box.read()).not.toBeNull();
  });

  it('writes our entry under the container key this client uses', async () => {
    const box = sandbox(spec, 'empty');

    await install(box);

    const entry = await readManagedEntry(box, spec);
    expect(entry, `${spec.container.join('.')}.${MANAGED_NAME} missing`).toBeTypeOf('object');
    // Pointer config only: `npx -y <spec>`, never a URL and never a credential.
    expect(JSON.stringify(entry)).toContain(PACKAGE_SPEC);
  });

  it('writes no credential and no base URL into the file', async () => {
    // The strongest property the installer has: the worst bug it can ship is a
    // broken MCP entry, never a leaked secret.
    const box = sandbox(spec, 'empty', { connection: 'prod' });

    await install(box);

    const text = box.read() ?? '';
    expect(text).not.toMatch(/\bhttps?:\/\/[^\s"']*coolify/i);
    expect(text).not.toMatch(/\b\d+\|[A-Za-z0-9]{40}\b/);
    expect(text).toContain('prod');
  });
});

// ---------------------------------------------------------------------------
// populated
// ---------------------------------------------------------------------------

describe.each(WRITING)('$id — populated', (spec: AdapterFixtureSpec) => {
  it('adds our entry beside the servers that were already there', async () => {
    const box = sandbox(spec, 'populated');

    const result = await install(box);

    expect(onlyTarget(result).status).toBe('written');
    expect(await readManagedEntry(box, spec)).toBeTypeOf('object');
    expect(await readSibling(box, spec)).toBeTypeOf('object');
  });

  it("leaves the other server's bytes exactly as they were", async () => {
    const box = sandbox(spec, 'populated');
    const beforeBlock = siblingBlock(box.before ?? '', spec.sibling);

    await install(box);

    if (spec.format === 'toml') {
      // Add-only: the writer never re-emits a section it did not author, so the
      // whole pre-existing file is a prefix of the result.
      expect(box.read() ?? '').toContain(box.before ?? '');
    } else {
      expect(beforeBlock, 'fixture does not contain the sibling block').not.toBe('');
      expect(box.read() ?? '').toContain(beforeBlock);
    }
  });

  it('leaves unrelated top-level settings untouched', async () => {
    const box = sandbox(spec, 'populated');
    const before = (await parseConfig(box.before ?? '', spec.format)) as Record<string, unknown>;
    const unrelated = Object.keys(before).filter((key) => key !== spec.container[0]);

    await install(box);

    const after = (await parseConfig(box.read() ?? '', spec.format)) as Record<string, unknown>;
    for (const key of unrelated) {
      expect(after[key], key).toEqual(before[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// hostile
// ---------------------------------------------------------------------------

describe.each(WRITING)('$id — hostile', (spec: AdapterFixtureSpec) => {
  it('keeps the byte-order mark', async () => {
    const box = sandbox(spec, 'hostile');
    expect(box.before?.startsWith(BOM), 'fixture is not hostile').toBe(true);

    await install(box);

    expect(box.read()?.startsWith(BOM)).toBe(true);
  });

  it('keeps CRLF line endings and introduces no lone LF', async () => {
    const box = sandbox(spec, 'hostile');
    expect(box.before?.includes('\r\n'), 'fixture is not hostile').toBe(true);

    await install(box);

    const after = box.read() ?? '';
    expect(after).toContain('\r\n');
    expect(after.replace(/\r\n/g, ''), 'a bare LF was written into a CRLF file').not.toContain('\n');
  });

  it('keeps tab indentation', async () => {
    const box = sandbox(spec, 'hostile');
    expect(box.before?.includes('\t'), 'fixture is not hostile').toBe(true);

    await install(box);

    expect(box.read() ?? '').toContain('\t');
  });

  it('still adds our entry and still parses', async () => {
    const box = sandbox(spec, 'hostile');

    const result = await install(box);

    expect(onlyTarget(result).status).toBe('written');
    expect(await readManagedEntry(box, spec)).toBeTypeOf('object');
  });
});

/**
 * Comments and trailing commas are legal in JSONC and TOML and illegal in JSON,
 * so the contract splits: preserve them where they are legal, refuse to write
 * where they are not. Both halves matter — a JSON writer that "helpfully"
 * accepted a commented file would rewrite it without the comments.
 */
describe.each(WRITING.filter((spec) => spec.format === 'jsonc' || spec.format === 'toml'))(
  '$id — hostile (comments)',
  (spec: AdapterFixtureSpec) => {
    it('preserves every comment', async () => {
      const box = sandbox(spec, 'hostile');
      const marker = spec.format === 'toml' ? '#' : '//';
      const commentsBefore = (box.before ?? '')
        .split('\r\n')
        .filter((line) => line.includes(marker));
      expect(commentsBefore.length, 'fixture has no comments').toBeGreaterThan(0);

      await install(box);

      for (const line of commentsBefore) {
        expect(box.read() ?? '', line).toContain(line.trim());
      }
    });
  },
);

describe.each(WRITING.filter((spec) => spec.format === 'jsonc'))(
  '$id — hostile (trailing comma)',
  (spec: AdapterFixtureSpec) => {
    it('leaves the trailing comma in place', async () => {
      const box = sandbox(spec, 'hostile');
      expect(/,\s*[}\]]/.test(box.before ?? ''), 'fixture has no trailing comma').toBe(true);

      await install(box);

      expect(/,\s*[}\]]/.test(box.read() ?? '')).toBe(true);
    });
  },
);

describe.each(WRITING.filter((spec) => spec.format === 'json'))(
  '$id — a commented file is refused, not rewritten',
  (spec: AdapterFixtureSpec) => {
    it('blocks the target and changes nothing', async () => {
      // Plain JSON has no comments, so a commented file is a file we do not
      // understand. Rewriting it would delete whatever the user was doing.
      const box = sandbox(spec, 'empty');
      const broken = `{\n  // a comment this client cannot read\n  "${spec.container[0] ?? 'mcpServers'}": {}\n}\n`;
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(box.configPath), { recursive: true });
      writeFileSync(box.configPath, broken, 'utf8');

      const result = await install(box);

      expect(onlyTarget(result).status).toBe('blocked');
      expect(box.read()).toBe(broken);
    });
  },
);

// ---------------------------------------------------------------------------
// conflict
// ---------------------------------------------------------------------------

describe.each(WRITING)('$id — conflict', (spec: AdapterFixtureSpec) => {
  it('leaves an entry the user edited exactly as it is, and says why', async () => {
    const box = sandbox(spec, 'conflict', { seedStaleRecord: true });

    const result = await install(box);

    expect(onlyTarget(result).status).toBe('skipped');
    expect(issueCodes(result)).toContain('entry-drift');
    expect(box.read()).toBe(box.before);
  });

  it('replaces it under --update', async () => {
    const box = sandbox(spec, 'conflict', { seedStaleRecord: true });

    const result = await install(box, { update: true });

    expect(onlyTarget(result).status).toBe('written');
    const entry = await readManagedEntry(box, spec);
    expect(JSON.stringify(entry)).toContain(PACKAGE_SPEC);
    expect(JSON.stringify(entry)).not.toContain('coolify-mcp@0.9.0');
  });

  it('--update leaves behind no key from the entry it replaced', async () => {
    // "Replaces", not "merges with". A leftover `"disabled": true` or
    // `"enabled": false` from the drifted entry means --update produced an
    // entry that still does not work, and the user has no reason to look for
    // the key we left behind.
    const box = sandbox(spec, 'conflict', { seedStaleRecord: true });

    await install(box, { update: true });

    const entry = await readManagedEntry(box, spec);
    const rendered = JSON.stringify(entry);
    expect(rendered).not.toContain('"disabled"');
    expect(rendered).not.toContain('"enabled":false');
    expect(rendered).not.toContain('"staging"');
  });

  it('does not clobber a `coolify` entry it has no record of writing', async () => {
    // No install record: as far as this machine knows, a human wrote that
    // entry. Deleting or rewriting configuration we did not author is the one
    // genuinely unrecoverable thing the installer could do, so the design makes
    // the writers add-only and requires a warning.
    const box = sandbox(spec, 'conflict');

    const result = await install(box);

    expect(box.read()).toBe(box.before);
    expect(onlyTarget(result).issues.some((issue) => issue.severity !== 'info')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The one adapter that must never write
// ---------------------------------------------------------------------------

describe.each(ADAPTER_FIXTURES.filter((spec) => spec.printOnly === true))(
  '$id — unverified',
  (spec: AdapterFixtureSpec) => {
    it.each(['empty', ...FILE_CASES] as const)('writes nothing for the %s case', async (fixture) => {
      const box = sandbox(spec, fixture);

      const result = await install(box);

      expect(onlyTarget(result).status).toBe('printed');
      expect(box.read()).toBe(box.before);
    });

    it('refuses on confidence, not on the absence of a writer', async () => {
      const box = sandbox(spec, 'populated');

      const result = await install(box);

      expect(box.adapter.confidence).toBe('unverified');
      expect(issueCodes(result)).toContain('unverified-write-refused');
    });

    it('removes nothing on uninstall either', async () => {
      const box = sandbox(spec, 'conflict');

      await uninstall(box);

      expect(box.read()).toBe(box.before);
    });
  },
);

// ---------------------------------------------------------------------------
// Path resolution — pure, so it can be asserted for every OS from any OS
// ---------------------------------------------------------------------------

describe('config paths are resolved per platform', () => {
  const HOME = { win32: 'C:\\Users\\dev', darwin: '/Users/dev', linux: '/home/dev' } as const;

  function ctxFor(platform: 'win32' | 'darwin' | 'linux') {
    return {
      homeDir: HOME[platform],
      projectRoot: platform === 'win32' ? 'C:\\repo' : '/repo',
      platform: platform as NodeJS.Platform,
      packageSpec: PACKAGE_SPEC,
      transport: 'stdio' as const,
    };
  }

  const EXPECTED: ReadonlyArray<[string, 'win32' | 'darwin' | 'linux', string]> = [
    ['claude-code-user', 'linux', '/home/dev/.claude.json'],
    ['claude-code-user', 'win32', 'C:\\Users\\dev\\.claude.json'],
    ['claude-code-project', 'linux', '/repo/.mcp.json'],
    ['cursor-user', 'darwin', '/Users/dev/.cursor/mcp.json'],
    ['cursor-project', 'win32', 'C:\\repo\\.cursor\\mcp.json'],
    ['codex-user', 'linux', '/home/dev/.codex/config.toml'],
    ['codex-user', 'win32', 'C:\\Users\\dev\\.codex\\config.toml'],
    ['kimi-user', 'darwin', '/Users/dev/.kimi/mcp.json'],
    ['zed-user', 'linux', '/home/dev/.config/zed/settings.json'],
    ['zed-user', 'win32', 'C:\\Users\\dev\\AppData\\Roaming\\Zed\\settings.json'],
    ['zed-project', 'darwin', '/repo/.zed/settings.json'],
    ['opencode-project', 'linux', '/repo/opencode.json'],
    ['opencode-user', 'linux', '/home/dev/.config/opencode/opencode.json'],
    ['claude-desktop', 'win32', 'C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json'],
    ['claude-desktop', 'darwin', '/Users/dev/Library/Application Support/Claude/claude_desktop_config.json'],
    ['claude-desktop', 'linux', '/home/dev/.config/Claude/claude_desktop_config.json'],
    ['minimax-user', 'linux', '/home/dev/.minimax/config.yaml'],
  ];

  it.each(EXPECTED)('%s on %s resolves to %s', async (id, platform, expected) => {
    const { adapterFor } = await import('./harness.js');
    expect(adapterFor(id).resolvePath(ctxFor(platform))).toBe(expected);
  });
});

describe('Claude Desktop spawns without a shell', () => {
  it('wraps the command in cmd /c on Windows only', async () => {
    const { adapterFor } = await import('./harness.js');
    const adapter = adapterFor('claude-desktop');
    const entry = { name: MANAGED_NAME, command: 'npx', args: ['-y', PACKAGE_SPEC], env: {} };

    const base = { homeDir: 'C:\\Users\\dev', projectRoot: 'C:\\repo', packageSpec: PACKAGE_SPEC, transport: 'stdio' as const };
    const windows = adapter.planWrite(entry, { ...base, platform: 'win32' });
    const linux = adapter.planWrite(entry, {
      ...base,
      homeDir: '/home/dev',
      projectRoot: '/repo',
      platform: 'linux',
    });

    // npx on Windows is npx.cmd, which CreateProcess cannot launch directly:
    // without the wrapper the server dies with ENOENT before speaking MCP.
    const windowsValue = at(windows.find((op) => op.kind === 'json-merge'), ['value']);
    const linuxValue = at(linux.find((op) => op.kind === 'json-merge'), ['value']);
    expect(at(windowsValue, ['command'])).toBe('cmd');
    expect(at(windowsValue, ['args'])).toEqual(['/c', 'npx', '-y', PACKAGE_SPEC]);
    expect(at(linuxValue, ['command'])).toBe('npx');
    expect(at(linuxValue, ['args'])).toEqual(['-y', PACKAGE_SPEC]);
  });
});

// ---------------------------------------------------------------------------
// Interpolation dialects — the silent-failure class
// ---------------------------------------------------------------------------

describe('reference syntax per client', () => {
  const ctx = {
    homeDir: '/home/dev',
    projectRoot: '/repo',
    platform: 'linux' as NodeJS.Platform,
    packageSpec: PACKAGE_SPEC,
    transport: 'stdio' as const,
    connection: 'prod',
  };

  const entryWithReference = {
    name: MANAGED_NAME,
    command: 'npx',
    args: ['-y', PACKAGE_SPEC],
    env: { COOLIFY_CONNECTION: 'prod', COOLIFY_API_TOKEN: '${COOLIFY_API_TOKEN}' },
  };

  /** The env block out of whichever merge operation an adapter planned. */
  function envOf(operations: readonly Operation[]): unknown {
    const write = operations.find((op) => op.kind === 'json-merge' || op.kind === 'jsonc-merge');
    const value = at(write, ['value']);
    return at(value, ['env']) ?? at(value, ['environment']);
  }

  it('Claude Code keeps ${VAR} verbatim — it is the one client that expands it', async () => {
    const { adapterFor } = await import('./harness.js');
    const env = envOf(adapterFor('claude-code-user').planWrite(entryWithReference, ctx));

    expect(at(env, ['COOLIFY_API_TOKEN'])).toBe('${COOLIFY_API_TOKEN}');
  });

  it('Cursor rewrites it to ${env:VAR}', async () => {
    // One character apart from Claude Code, and the failure is silent: Cursor
    // forwards an unrecognised reference verbatim, so the server reports a 401
    // that looks like a bad token rather than a bad config.
    const { adapterFor } = await import('./harness.js');
    const env = envOf(adapterFor('cursor-user').planWrite(entryWithReference, ctx));

    expect(at(env, ['COOLIFY_API_TOKEN'])).toBe('${env:COOLIFY_API_TOKEN}');
  });

  it.each(['kimi-user', 'zed-user', 'claude-desktop'])(
    '%s drops the reference rather than writing it as literal text',
    async (id) => {
      const { adapterFor } = await import('./harness.js');
      const adapter = adapterFor(id);
      const operations = adapter.planWrite(entryWithReference, ctx);
      const env = envOf(operations);

      expect(at(env, ['COOLIFY_API_TOKEN'])).toBeUndefined();
      expect(at(env, ['COOLIFY_CONNECTION'])).toBe('prod');
      // Dropping silently would be worse than writing it: the note names the
      // variable (never a value) and points at a mechanism that works.
      expect(operations.some((op) => op.kind === 'note' && op.message.includes('COOLIFY_API_TOKEN'))).toBe(true);
    },
  );

  it('OpenCode uses a command array and an `environment` key', async () => {
    const { adapterFor } = await import('./harness.js');
    const write = adapterFor('opencode-project')
      .planWrite(entryWithReference, ctx)
      .find((op) => op.kind === 'json-merge');
    const value = at(write, ['value']);

    expect(at(value, ['command'])).toEqual(['npx', '-y', PACKAGE_SPEC]);
    expect(at(value, ['env'])).toBeUndefined();
    expect(at(value, ['environment', 'COOLIFY_CONNECTION'])).toBe('prod');
    expect(at(value, ['type'])).toBe('local');
  });

  it('Codex is always stdio and never emits a url key', async () => {
    // An entry without `command` makes older Codex versions reject the ENTIRE
    // config.toml, taking every other MCP server in it down.
    const { adapterFor } = await import('./harness.js');
    const adapter = adapterFor('codex-user');

    expect(adapter.transports).toEqual(['stdio']);
    const operations = adapter.planWrite(entryWithReference, { ...ctx, transport: 'http' });
    const append = operations.find((op) => op.kind === 'toml-append');
    const text = at(append, ['text']);

    expect(typeof text).toBe('string');
    expect(String(text)).toContain('command = "npx"');
    expect(String(text)).not.toContain('url');
  });
});
