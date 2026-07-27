/**
 * The adapter registry.
 *
 * A frozen array, resolved with `find(a => a.supports(target))`. Order is load
 * bearing: for a bare client name like `cursor` the user-scope adapter is listed
 * first, so an unqualified target resolves to the scope most people mean.
 * Callers that honour `--scope` should filter on `scope` before matching.
 *
 * Tier B adapters sit at the end. `confidence: 'unverified'` is what actually
 * stops them from writing — position is only about which one a loose match
 * lands on first.
 */

import type { McpClientAdapter } from '../../types.js';

import { claudeCodeProjectAdapter, claudeCodeUserAdapter } from './claude-code.js';
import { claudeDesktopAdapter } from './claude-desktop.js';
import { codexUserAdapter } from './codex.js';
import { cursorProjectAdapter, cursorUserAdapter } from './cursor.js';
import { kimiUserAdapter } from './kimi.js';
import { minimaxUserAdapter } from './minimax.js';
import { opencodeProjectAdapter, opencodeUserAdapter } from './opencode.js';
import { zedProjectAdapter, zedUserAdapter } from './zed.js';

export const ADAPTERS: readonly McpClientAdapter[] = Object.freeze([
  // Tier A — shapes verified against upstream documentation.
  claudeCodeUserAdapter,
  claudeCodeProjectAdapter,
  cursorUserAdapter,
  cursorProjectAdapter,
  codexUserAdapter,
  kimiUserAdapter,
  zedUserAdapter,
  zedProjectAdapter,
  opencodeUserAdapter,
  opencodeProjectAdapter,
  claudeDesktopAdapter,

  // Tier B — print-only until the config key is confirmed.
  minimaxUserAdapter,
]);

export {
  claudeCodeProjectAdapter,
  claudeCodeUserAdapter,
  claudeDesktopAdapter,
  codexUserAdapter,
  cursorProjectAdapter,
  cursorUserAdapter,
  kimiUserAdapter,
  minimaxUserAdapter,
  opencodeProjectAdapter,
  opencodeUserAdapter,
  zedProjectAdapter,
  zedUserAdapter,
};
