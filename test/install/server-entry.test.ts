/**
 * The entry the installer writes has to START THE STDIO SERVER.
 *
 * Every other test in this directory asks whether the installer wrote the file
 * correctly — idempotently, without eating a neighbouring server, byte-identical
 * to the documented snippet. None of them asked the prior question: does the
 * argv in that entry launch an MCP server at all? It did not, and the whole
 * suite stayed green, because a wrong-but-consistent command is consistent.
 *
 * The trap is a consequence of the rename documented in
 * doctor-package-spec.test.ts. This package ships TWO bins:
 *
 *   coolify-mcp         dist/cli.js     install / doctor / check — a terminal
 *                                       program that prints usage and exits 1
 *                                       when it is given no command
 *   coolify-mcp-server  dist/index.js   the stdio MCP server
 *
 * `npx <spec>` runs the bin whose NAME MATCHES THE PACKAGE'S UNSCOPED NAME. For
 * `@done-dynamics/coolify-mcp` that is `coolify-mcp` — the CLI. So the obvious
 * `npx -y @done-dynamics/coolify-mcp@latest` spawns the CLI, which writes usage
 * to stderr and exits before speaking a single byte of JSON-RPC. The client
 * reports "failed to connect" and nothing in the config looks wrong.
 *
 * Reaching the other bin requires naming it: `npx -y -p <spec> coolify-mcp-server`.
 *
 * These assertions are deliberately made against package.json rather than
 * against a hard-coded string. A future rename of either bin has to break this
 * test — that is the entire point, since the last rename slipped through by
 * changing a name nothing asserted on.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildServerEntry } from '../../src/install/plan.js';
import type { InstallCtx } from '../../src/types.js';

interface PackageManifest {
  name: string;
  bin: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

/** `@scope/name` -> `name`; an unscoped name is returned unchanged. */
function unscopedName(name: string): string {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
}

/**
 * The bin `npx` would execute for a given argv.
 *
 * Models the one rule that matters here: `--package`/`-p` decouples "which
 * package to install" from "which command to run", and without it npx falls
 * back to matching the package's unscoped name against the bin map.
 */
function binNpxWouldRun(args: readonly string[], packageName: string): string {
  const takesValue = new Set(['-p', '--package']);
  const positionals: string[] = [];
  let sawPackageFlag = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (takesValue.has(arg)) {
      sawPackageFlag = true;
      i += 1; // skip the spec that belongs to this flag
      continue;
    }
    if (arg.startsWith('-')) continue; // bare flag, e.g. -y
    positionals.push(arg);
  }

  // With -p the remaining positional is the command; without it the sole
  // positional is the spec itself and npx matches by name.
  const [command] = positionals;
  return sawPackageFlag && command !== undefined ? command : unscopedName(packageName);
}

function ctx(overrides: Partial<InstallCtx> = {}): InstallCtx {
  return {
    homeDir: '/home/tester',
    projectRoot: '/home/tester/project',
    platform: 'linux',
    packageSpec: `${pkg.name}@latest`,
    transport: 'stdio',
    ...overrides,
  };
}

describe('the installed entry launches the stdio server', () => {
  it('names a bin this package actually ships', () => {
    const entry = buildServerEntry(ctx());

    const bin = binNpxWouldRun(entry.args, pkg.name);

    expect(Object.keys(pkg.bin)).toContain(bin);
  });

  it('resolves to the stdio server, not the CLI', () => {
    const entry = buildServerEntry(ctx());

    const bin = binNpxWouldRun(entry.args, pkg.name);

    // dist/index.js is the stdio server; dist/cli.js prints usage and exits.
    expect(pkg.bin[bin]).toBe('dist/index.js');
  });

  it('does not rely on npx matching the package name to a bin', () => {
    const entry = buildServerEntry(ctx());

    // The name-matching fallback lands on the CLI, so the entry must name its
    // command explicitly. This asserts the bug itself, not just its symptom.
    expect(pkg.bin[unscopedName(pkg.name)]).toBe('dist/cli.js');
    expect(entry.args).toContain('coolify-mcp-server');
  });

  it('keeps -y so a first run does not stall on npx install confirmation', () => {
    const entry = buildServerEntry(ctx());

    expect(entry.command).toBe('npx');
    expect(entry.args).toContain('-y');
  });

  it('carries the connection name in env and no credential anywhere', () => {
    const entry = buildServerEntry(ctx({ connection: 'prod' }));

    expect(entry.env).toEqual({ COOLIFY_CONNECTION: 'prod' });
    expect(JSON.stringify(entry)).not.toMatch(/token|password|secret/i);
  });
});
