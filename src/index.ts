/**
 * The stdio entry point.
 *
 * STDOUT IS THE JSON-RPC CHANNEL. Nothing may be written to it that is not a
 * protocol message: one stray line of diagnostics desynchronises the framing
 * and the client drops the connection with an error naming neither the line nor
 * this process. Every human-readable byte therefore goes to stderr, which every
 * MCP client captures as the server's log.
 *
 * No shebang here — tsup prepends one, and a second `#!` on line 2 of the
 * bundle is a syntax error rather than a comment.
 */

import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveRegistry } from './config/resolve.js';
import { ConfigError } from './config/schema.js';
import { buildServer } from './server.js';
import { redact } from './shaping/redact.js';
import type { ConnectionRegistry, ServerConfig } from './types.js';

/** Prefixes diagnostics, so a client log holding several servers stays legible. */
const PROGRAM = 'coolify-mcp';

/** The server is not configured. A human has to change something. */
const EXIT_CONFIG = 1;

/**
 * Startup failed for a reason that is not the user's configuration. Split from
 * EXIT_CONFIG so the packaging smoke test can tell "nobody set the variables"
 * apart from "the build is broken" without parsing stderr.
 */
const EXIT_INTERNAL = 2;

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

async function main(): Promise<void> {
  const registry = await resolveRegistry(process.env, process.cwd(), homedir());
  const server = buildServer(toServerConfig(registry, process.env));
  await server.connect(new StdioServerTransport());
}

/**
 * The process-wide flags, derived from the resolved connections rather than
 * re-read from the environment.
 *
 * `config/resolve.ts` has already parsed COOLIFY_READ_ONLY and
 * COOLIFY_ALLOW_DESTRUCTIVE — including refusing a value it cannot read as a
 * boolean — and stamped the outcome onto every connection, where a registry
 * file may also have set them per connection. Parsing the same two variables a
 * second time here would produce a second answer that can disagree with the
 * first, and the gate in `tools/register.ts` is not a place to hold two
 * answers.
 */
function toServerConfig(registry: ConnectionRegistry, env: NodeJS.ProcessEnv): ServerConfig {
  const connections = [...registry.connections.values()];
  return {
    registry,
    readOnly: connections.every((connection) => connection.readOnly),
    // A read-only connection can never destroy anything, so it does not count
    // towards the server having the capability at all.
    allowDestructive: connections.some(
      (connection) => connection.allowDestructive && !connection.readOnly,
    ),
    logLevel: resolveLogLevel(env),
  };
}

function resolveLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env['COOLIFY_LOG_LEVEL']?.trim().toLowerCase();
  if (raw === undefined || raw === '') return DEFAULT_LOG_LEVEL;

  const match = LOG_LEVELS.find((level) => level === raw);
  if (match !== undefined) return match;

  // Not fatal — refusing to start over a log level would be absurd — but not
  // silent either, or the user watches for output that never arrives.
  note(`ignoring COOLIFY_LOG_LEVEL="${raw}"; expected one of ${LOG_LEVELS.join(', ')}. Using ${DEFAULT_LOG_LEVEL}.`);
  return DEFAULT_LOG_LEVEL;
}

/**
 * Writes one diagnostic line to stderr — never stdout, which carries JSON-RPC.
 *
 * The prefix is skipped when the message already opens with the program name:
 * the most-seen error in the product is "coolify-mcp has no connections
 * configured", and "coolify-mcp: coolify-mcp has no…" is the kind of stutter
 * that makes a first run feel unfinished.
 */
function note(message: string): void {
  const line = message.startsWith(PROGRAM) ? message : `${PROGRAM}: ${message}`;
  process.stderr.write(`${line}\n`);
}

/**
 * Reports a startup failure on stderr and exits non-zero.
 *
 * Everything is passed through `redact()`. At this point no token has usually
 * been resolved, so the registered-secret pass has nothing to do — but the
 * Sanctum-shape backstop inside `redact` catches the case that actually
 * happens: a token pasted into COOLIFY_BASE_URL by mistake, quoted straight
 * back in "…is not a valid URL". Client logs get shared in bug reports.
 */
function fail(error: unknown): never {
  if (error instanceof ConfigError) {
    // These messages are written for a human at a terminal: they name the
    // variables to set and every path that was searched. Printed verbatim.
    note(redact(error.message));
    process.exit(EXIT_CONFIG);
  }

  const detail = error instanceof Error ? error.message : String(error);
  note(`failed to start: ${redact(detail)}`);
  process.exit(EXIT_INTERNAL);
}

main().catch(fail);
