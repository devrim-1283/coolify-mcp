/**
 * Shared harness for the adapter golden fixtures.
 *
 * THE FIXTURE CONVENTION
 * `__fixtures__/<adapterId>/<case>.<format>` holds the state of the client's
 * config file BEFORE coolify-mcp touches it. There are four cases and only
 * three files, because the fourth is the absence of one:
 *
 *   empty      no fixture file — the client has never written a config
 *   populated  unrelated MCP servers, plus unrelated top-level settings
 *   hostile    BOM + CRLF + tabs, and for JSONC/TOML also comments and a
 *              trailing comma
 *   conflict   a `coolify` entry that has drifted from what we wrote
 *
 * Each case is copied to `adapter.resolvePath(ctx)` inside a throwaway home and
 * project directory, so the tests exercise the real path resolution rather than
 * a path the test invented.
 *
 * WHY THE I/O TESTS RUN ON THE HOST PLATFORM
 * `planWrite`, `planRemove` and `resolvePath` are pure and take `ctx.platform`,
 * so cross-platform assertions (the `%APPDATA%` locations, the `cmd /c`
 * wrapper) are made against those directly and cost no filesystem. Anything
 * that actually writes uses `process.platform`: a win32 path arithmetic result
 * cannot be created on a Linux runner, and a fixture that passed while
 * describing an impossible path would be worse than no fixture at all.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS } from '../../../src/install/registry.js';
import { applyPlan, type ApplyOptions, type ApplyResult } from '../../../src/install/apply.js';
import { planInstall, planUninstall } from '../../../src/install/plan.js';
import { hashEntry, stateFilePath, INSTALL_STATE_SCHEMA } from '../../../src/install/state.js';
import type { InstallCtx, InstallRecord, McpClientAdapter } from '../../../src/types.js';

export const PACKAGE_SPEC = 'coolify-mcp@1.4.2';
export const MANAGED_NAME = 'coolify';

export type FixtureCase = 'empty' | 'populated' | 'hostile' | 'conflict';

export const FILE_CASES: readonly FixtureCase[] = ['populated', 'hostile', 'conflict'];
export const ALL_CASES: readonly FixtureCase[] = ['empty', ...FILE_CASES];

/**
 * Everything the harness needs that the adapter does not declare in a
 * machine-readable way: the fixture file extension, and the container key its
 * entry lives under.
 *
 * The container is written out rather than derived from `planWrite` so a change
 * of container key — `mcpServers` to `context_servers`, say — fails a test
 * instead of quietly moving every assertion with it.
 */
export interface AdapterFixtureSpec {
  id: string;
  format: 'json' | 'jsonc' | 'toml' | 'yaml';
  /** Fixture file extension. Matches `format`. */
  ext: string;
  /** Key path of the container our entry goes into. */
  container: readonly string[];
  /** Doc file under docs/clients/. Adapter `client`, so the two scopes share one. */
  doc: string;
  /** Unrelated server present in the `populated` and `hostile` fixtures. */
  sibling: string;
  /** Adapters whose confidence is 'unverified' never write anything. */
  printOnly?: boolean;
}

export const ADAPTER_FIXTURES: readonly AdapterFixtureSpec[] = [
  {
    id: 'claude-code-user',
    format: 'json',
    ext: 'json',
    container: ['mcpServers'],
    doc: 'claude-code',
    sibling: 'filesystem',
  },
  {
    id: 'claude-code-project',
    format: 'json',
    ext: 'json',
    container: ['mcpServers'],
    doc: 'claude-code',
    sibling: 'filesystem',
  },
  {
    id: 'cursor-user',
    format: 'json',
    ext: 'json',
    container: ['mcpServers'],
    doc: 'cursor',
    sibling: 'filesystem',
  },
  {
    id: 'cursor-project',
    format: 'json',
    ext: 'json',
    container: ['mcpServers'],
    doc: 'cursor',
    sibling: 'filesystem',
  },
  {
    id: 'codex-user',
    format: 'toml',
    ext: 'toml',
    container: ['mcp_servers'],
    doc: 'codex',
    sibling: 'filesystem',
  },
  {
    id: 'kimi-user',
    format: 'json',
    ext: 'json',
    container: ['mcpServers'],
    doc: 'kimi',
    sibling: 'filesystem',
  },
  {
    id: 'zed-user',
    format: 'jsonc',
    ext: 'jsonc',
    container: ['context_servers'],
    doc: 'zed',
    sibling: 'some-mcp-server',
  },
  {
    id: 'zed-project',
    format: 'jsonc',
    ext: 'jsonc',
    container: ['context_servers'],
    doc: 'zed',
    sibling: 'some-mcp-server',
  },
  {
    id: 'opencode-user',
    format: 'json',
    ext: 'json',
    container: ['mcp'],
    doc: 'opencode',
    sibling: 'filesystem',
  },
  {
    id: 'opencode-project',
    format: 'json',
    ext: 'json',
    container: ['mcp'],
    doc: 'opencode',
    sibling: 'filesystem',
  },
  {
    id: 'claude-desktop',
    format: 'json',
    ext: 'json',
    container: ['mcpServers'],
    doc: 'claude-desktop',
    sibling: 'filesystem',
  },
  {
    id: 'minimax-user',
    format: 'yaml',
    ext: 'yaml',
    container: ['mcp'],
    doc: 'minimax',
    sibling: 'none',
    printOnly: true,
  },
];

export function adapterFor(id: string): McpClientAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.id === id);
  if (adapter === undefined) throw new Error(`no adapter registered with id "${id}"`);
  return adapter;
}

// `fileURLToPath` rather than `import.meta.dirname`: the package supports Node
// >= 20.10 and `dirname` only landed in 20.11.
const FIXTURE_ROOT = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

export function fixturePath(spec: AdapterFixtureSpec, name: FixtureCase): string {
  return path.join(FIXTURE_ROOT, spec.id, `${name}.${spec.ext}`);
}

/** The bytes of a fixture, or null for `empty` (which is the absence of a file). */
export function fixtureText(spec: AdapterFixtureSpec, name: FixtureCase): string | null {
  if (name === 'empty') return null;
  return readFileSync(fixturePath(spec, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Throwaway home + project
// ---------------------------------------------------------------------------

export interface Sandbox {
  ctx: InstallCtx;
  adapter: McpClientAdapter;
  /** Where the adapter resolved its config file. */
  configPath: string;
  /** Bytes on disk before anything ran, or null when the file did not exist. */
  before: string | null;
  read(): string | null;
  dispose(): void;
}

export interface SandboxOptions {
  connection?: string;
  packageSpec?: string;
  /**
   * Seed install state claiming we wrote an entry whose hash no longer matches
   * what is on disk. This is what makes the `conflict` case *drift* rather than
   * merely "somebody else's entry".
   */
  seedStaleRecord?: boolean;
}

export function makeSandbox(
  spec: AdapterFixtureSpec,
  fixture: FixtureCase,
  options: SandboxOptions = {},
): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'coolify-mcp-fixture-'));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const ctx: InstallCtx = {
    homeDir,
    projectRoot,
    // Host platform: see the file header on why the writing tests never fake it.
    platform: process.platform,
    packageSpec: options.packageSpec ?? PACKAGE_SPEC,
    transport: 'stdio',
    ...(options.connection === undefined ? {} : { connection: options.connection }),
  };

  const adapter = adapterFor(spec.id);
  const configPath = adapter.resolvePath(ctx);

  const seed = fixtureText(spec, fixture);
  if (seed !== null) {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, seed, 'utf8');
  }

  if (options.seedStaleRecord === true) {
    writeStaleRecord(homeDir, {
      adapterId: adapter.id,
      path: configPath,
      serverName: MANAGED_NAME,
      managedKeyPath: [...spec.container, MANAGED_NAME],
      method: 'file',
      packageSpec: ctx.packageSpec,
      writtenAt: '2026-01-01T00:00:00.000Z',
      // Any hash that is not the hash of what is on disk: the point is only
      // that the two disagree, which is what "the user edited it" looks like.
      entryHash: hashEntry({ coolify: 'as coolify-mcp last left it' }),
    });
  }

  return {
    ctx,
    adapter,
    configPath,
    before: seed,
    read: () => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : null),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeStaleRecord(homeDir: string, record: InstallRecord): void {
  const statePath = stateFilePath(homeDir);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({ schema: INSTALL_STATE_SCHEMA, installs: [record] }, null, 2)}\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Running a plan
// ---------------------------------------------------------------------------

export async function install(sandbox: Sandbox, options: ApplyOptions = {}): Promise<ApplyResult> {
  const plan = await planInstall({ ctx: sandbox.ctx, clients: [sandbox.adapter.id] });
  return applyPlan(plan, options);
}

export async function uninstall(
  sandbox: Sandbox,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const plan = await planUninstall({ ctx: sandbox.ctx, clients: [sandbox.adapter.id] });
  return applyPlan(plan, options);
}

/** The single target of a single-client plan. Fails loudly rather than returning undefined. */
export function onlyTarget(result: ApplyResult): ApplyResult['targets'][number] {
  const target = result.targets[0];
  if (target === undefined) {
    throw new Error(`plan produced no target (issues: ${JSON.stringify(result.issues)})`);
  }
  return target;
}

export function issueCodes(result: ApplyResult): string[] {
  return onlyTarget(result).issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// Reading a config back
// ---------------------------------------------------------------------------

/**
 * Parses a config file in the adapter's own format.
 *
 * Deliberately a separate implementation from `src/install/adapters/shared.ts`:
 * a test that read the file back through the same parser the writer used could
 * not tell a writer bug from a parser bug.
 */
export async function parseConfig(
  text: string,
  format: AdapterFixtureSpec['format'],
): Promise<unknown> {
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') return {};
  switch (format) {
    case 'json':
      return JSON.parse(body) as unknown;
    case 'jsonc': {
      const { parse } = await import('jsonc-parser');
      return parse(body, [], { allowTrailingComma: true, disallowComments: false }) as unknown;
    }
    case 'toml': {
      const { parse } = await import('smol-toml');
      return parse(body);
    }
    case 'yaml': {
      const { parse } = await import('yaml');
      return parse(body) as unknown;
    }
  }
}

export function at(root: unknown, keyPath: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of keyPath) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Our entry, read back out of the file the adapter wrote. */
export async function readManagedEntry(
  sandbox: Sandbox,
  spec: AdapterFixtureSpec,
): Promise<unknown> {
  const text = sandbox.read();
  if (text === null) return undefined;
  return at(await parseConfig(text, spec.format), [...spec.container, MANAGED_NAME]);
}

export async function readSibling(sandbox: Sandbox, spec: AdapterFixtureSpec): Promise<unknown> {
  const text = sandbox.read();
  if (text === null) return undefined;
  return at(await parseConfig(text, spec.format), [...spec.container, spec.sibling]);
}
