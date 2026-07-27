/**
 * The adapter registry.
 *
 * A frozen array plus `find(a => a.supports(target))`. That is the whole
 * mechanism, and it is deliberately the whole mechanism: adding a client is one
 * new file under `adapters/` and one line in `adapters/index.ts`, with no
 * switch statement, no string-keyed map to keep in sync, and nothing in this
 * file to edit. Registries that need editing to extend are registries that grow
 * a stale branch for a client somebody removed two releases ago.
 *
 * Frozen because the array is process-global: a test or a future subcommand
 * that pushed onto it would change behaviour for everything else in the
 * process, and that bug is very hard to see.
 */

import type { McpClientAdapter, ValidationIssue } from '../types.js';
import { ADAPTERS as CLIENT_ADAPTERS } from './adapters/index.js';

export const ADAPTERS: readonly McpClientAdapter[] = Object.freeze([...CLIENT_ADAPTERS]);

/** First adapter that claims `target`. The canonical lookup. */
export function findAdapter(target: string): McpClientAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.supports(target));
}

/**
 * Every adapter that claims `target`.
 *
 * `--client cursor` legitimately means both the user-scope and the
 * project-scope adapter; only `--scope` narrows it.
 */
export function findAdapters(target: string): McpClientAdapter[] {
  return ADAPTERS.filter((adapter) => adapter.supports(target));
}

export function adapterById(id: string): McpClientAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/** Sorted, de-duplicated selectors for `--client` help text and error messages. */
export function knownTargets(): string[] {
  const targets = new Set<string>();
  for (const adapter of ADAPTERS) {
    targets.add(adapter.client);
    targets.add(adapter.id);
  }
  return [...targets].sort();
}

/**
 * Structural problems with the registry itself, surfaced by `doctor` rather
 * than thrown at import time.
 *
 * Throwing here would take down the MCP server for a mistake in the installer,
 * which is the wrong trade: the server is what the user actually runs.
 */
export function registryIssues(): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  for (const adapter of ADAPTERS) {
    if (seen.has(adapter.id)) {
      issues.push({
        severity: 'error',
        code: 'adapter-duplicate-id',
        message: `two adapters share the id "${adapter.id}"; only the first is reachable.`,
        fix: 'Give each adapter a unique id, conventionally "<client>-<scope>".',
      });
    }
    seen.add(adapter.id);
  }

  return issues;
}
