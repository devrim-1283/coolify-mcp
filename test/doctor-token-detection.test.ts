import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../src/install/doctor.js';

/**
 * Regression cover for the plaintext-credential scanner.
 *
 * The detector was originally pinned to a secret of exactly 40 characters,
 * matching Laravel Sanctum's documented default. Coolify does not use that
 * default: a token taken from a live 4.1.2 instance carries a 48-character
 * secret, and `\b\d+\|[A-Za-z0-9]{40}\b` cannot match it — the trailing word
 * boundary never lands after the 40th character when more alphanumerics follow.
 *
 * The failure mode was silent and total: doctor would report a config file
 * holding a live Coolify token as clean. Since this scanner is the main reason
 * the installer CLI is worth shipping at all, the length assumption is pinned
 * here against real-world token shapes rather than the upstream default.
 */

const created: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coolify-mcp-doctor-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a Claude Code user config carrying `token` verbatim, and scans it. */
async function scanWithToken(token: string) {
  const home = sandbox();
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          coolify: {
            command: 'npx',
            args: ['-y', 'coolify-mcp@latest'],
            env: { COOLIFY_BASE_URL: 'https://coolify.example.com', COOLIFY_API_TOKEN: token },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  // An empty cwd keeps project-scope adapters from picking up this repo's own files.
  const report = await runDoctor({ homeDir: home, cwd: sandbox(), env: {} });
  return report.findings.filter((f) => f.severity === 'critical');
}

const secret = (n: number): string => 'a1B2c3D4e5'.repeat(Math.ceil(n / 10)).slice(0, n);

describe('doctor plaintext-credential scanner', () => {
  it('detects a 48-character secret, the length Coolify actually issues', async () => {
    const critical = await scanWithToken(`6|${secret(48)}`);
    expect(critical.length).toBeGreaterThan(0);
  });

  it('still detects the 40-character Sanctum default', async () => {
    const critical = await scanWithToken(`13|${secret(40)}`);
    expect(critical.length).toBeGreaterThan(0);
  });

  it('detects a 64-character secret, in case Coolify lengthens them again', async () => {
    const critical = await scanWithToken(`204|${secret(64)}`);
    expect(critical.length).toBeGreaterThan(0);
  });

  it('does not fire on a short pipe-delimited value that is not a token', async () => {
    const critical = await scanWithToken('6|short');
    expect(critical).toHaveLength(0);
  });

  it('does not fire on an env-var reference', async () => {
    const critical = await scanWithToken('${COOLIFY_API_TOKEN}');
    expect(critical).toHaveLength(0);
  });

  it('never echoes the credential into the report', async () => {
    const token = `6|${secret(48)}`;
    const critical = await scanWithToken(token);
    expect(JSON.stringify(critical)).not.toContain(secret(48));
  });
});
