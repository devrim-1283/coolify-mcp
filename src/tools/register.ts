/**
 * Tool registration — the gate chokepoint.
 *
 * This is layer 1 of the three-layer destructive gate (registration ->
 * dispatch -> transport). It decides WHAT EXISTS; `http/client.ts` decides what
 * may leave the process. Any security review of this codebase should start at
 * those two files, because between them they are the whole story.
 *
 * Two gates are applied here and nowhere else:
 *
 *   COOLIFY_READ_ONLY          drops every tool whose surface is 'write' or
 *                              'destructive'.
 *
 *   COOLIFY_ALLOW_DESTRUCTIVE  when it is not enabled,
 *                              `execute_destructive_operation` IS NOT
 *                              REGISTERED — absent from tools/list entirely,
 *                              not listed-and-refusing.
 *
 * That second choice is the load-bearing one, so the reasoning in full:
 *
 *  1. Every tool schema is tokens spent on EVERY turn, whether or not the tool
 *     is ever called. A tool that structurally always refuses is pure waste of
 *     the budget this entire design exists to conserve.
 *
 *  2. There is no recovery path the model can take. Enabling the capability
 *     means a human sets an environment variable and restarts the server — an
 *     action the model cannot perform and cannot retry into. A listed tool that
 *     always refuses therefore invites a call -> refusal -> rephrase -> call
 *     loop against a wall that no rephrasing moves.
 *
 *  3. With it unregistered, NO tool in the list carries `destructiveHint: true`.
 *     The host's permission model and the server's actual capability then agree
 *     exactly, so a host that auto-approves non-destructive tools is
 *     auto-approving something genuinely non-destructive. Listing a refusing
 *     tool would instead put a destructive-hinted entry in a server that cannot
 *     destroy anything, and every consent decision built on that hint would be
 *     misinformed.
 *
 * The one thing registration-time gating throws away — that the capability
 * exists at all and how to turn it on — is recovered in a single sentence of
 * `instructions` (see `server.ts`), added exactly when it is useful.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { CoolifyError } from '../types.js';
import type { ServerConfig, ToolDef, ToolExtra, ToolResult } from '../types.js';
import { redact } from '../shaping/redact.js';
import { controlResource } from './control-resource.js';
import { listDeployments, getDeployment } from './deployments.js';
import { deploy } from './deploy.js';
import { getEnvironmentVariables } from './env-vars.js';
import { findResources } from './find-resources.js';
import { genericTools } from './generic.js';
import { getLogs } from './get-logs.js';
import { getResource } from './get-resource.js';
import { listProjects } from './projects.js';
import { listServers } from './servers.js';
import { setEnvironmentVariables } from './set-env-vars.js';

type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Every tool this server knows how to build, in the order the host is offered
 * them.
 *
 * `find_resources` leads because it is the entry point: Coolify UUIDs are not
 * guessable, so almost every useful sequence starts there. The generic catalog
 * doors come last — they are the long tail behind the dedicated tools that
 * cover the loop an operator actually repeats.
 */
export const ALL_TOOLS: readonly ToolDef[] = Object.freeze([
  findResources,
  getResource,
  getLogs,
  getEnvironmentVariables,
  listDeployments,
  getDeployment,
  listServers,
  listProjects,
  deploy,
  controlResource,
  setEnvironmentVariables,
  ...genericTools,
]);

/**
 * The tools that actually exist on this server.
 *
 * The predicate is deliberately small enough to read in one breath, because a
 * reviewer has to be able to hold all of it at once:
 *
 *   read         always
 *   write        the server is not read-only, and some connection is not either
 *   destructive  write, AND the process-wide flag, AND some usable connection
 *                that opted in
 *
 * The destructive line is an AND rather than an OR on purpose. Both the
 * process-wide flag and a per-connection override have to admit the call, so
 * the door only exists when some connection could genuinely walk through it and
 * either half alone is enough to keep it shut. That is the fail-closed
 * direction, and it is the one worth having when the two disagree.
 *
 * The scan over connections is what keeps registration honest in the other
 * direction too: a registry file may set `allowDestructive` on one connection
 * and leave the rest alone, and a gate that only read the global flag would
 * either hide a capability the user configured or advertise one nothing has.
 */
export function selectTools(cfg: ServerConfig): ToolDef[] {
  const connections = [...cfg.registry.connections.values()];

  // Read-only is a ceiling, never a default: no connection can re-open it, so
  // it is checked first and nothing below can widen it.
  const writable = !cfg.readOnly && connections.some((connection) => !connection.readOnly);

  const destructive =
    writable &&
    cfg.allowDestructive &&
    connections.some((connection) => !connection.readOnly && connection.allowDestructive);

  return ALL_TOOLS.filter((tool) => {
    if (tool.surface === 'read') return true;
    if (tool.surface === 'write') return writable;
    return destructive;
  });
}

/**
 * Registers the surviving tools on an `McpServer`.
 *
 * There is deliberately no way to pass the tool list in. An exported function
 * that accepted one would be an exported bypass of the only gate that decides
 * what exists, and a reviewer would be right to treat it as one. `selectTools`
 * is a pure function of `cfg`, so callers that need to know the surface — such
 * as `buildInstructions` — can call it themselves and cannot get a different
 * answer.
 */
export function registerTools(server: McpServer, cfg: ServerConfig): readonly ToolDef[] {
  const tools = selectTools(cfg);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.annotations.title,
        description: tool.description,
        // Built per config: with a single connection the `instance` parameter is
        // absent from the schema entirely rather than optional-with-a-default.
        inputSchema: toInputSchema(tool.inputSchema(cfg)),
        annotations: tool.annotations,
      },
      async (args, extra) => runTool(tool, args, cfg, extra),
    );
  }
  return tools;
}

/**
 * Wraps a tool's parameter shape into the object schema the SDK advertises.
 *
 * The `.meta()` call is the whole reason this function exists, and it is
 * repairing a regression rather than adding a feature.
 *
 * Under Zod 3 the SDK converted a raw shape with `zod-to-json-schema`, which
 * emits `additionalProperties: false` for every `z.object`. Zod 4's own
 * converter does not: it reserves that keyword for `z.strictObject`, because
 * only a strict object actually rejects an unknown key. Handing the SDK a bare
 * shape under Zod 4 therefore publishes a schema that invites a model to invent
 * parameters, and every one it invents is a wasted round trip.
 *
 * Switching to `z.strictObject` would restore the keyword and change behaviour
 * with it: unknown keys would start being rejected instead of dropped, and a
 * host that decorates tool arguments with its own metadata would break on a
 * version bump it did not ask for. `.meta()` writes the keyword into the
 * published JSON Schema while parsing stays `strip`, which is exactly what
 * Zod 3 did — the advertisement and the runtime are the same pair as before.
 */
function toInputSchema(shape: Record<string, unknown>) {
  return z.object(shape as z.ZodRawShape).meta({ additionalProperties: false });
}

async function runTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  cfg: ServerConfig,
  extra: ToolCallExtra,
): Promise<CallToolResult> {
  try {
    return toCallToolResult(await tool.handler(args, cfg, toToolExtra(extra)));
  } catch (error: unknown) {
    return toCallToolResult(renderUncaught(tool.name, error));
  }
}

/**
 * Our `ToolResult` -> the SDK's `CallToolResult`.
 *
 * Structurally the same shape; the SDK's type carries an open index signature
 * for protocol extensions, which a plain interface cannot satisfy. Rebuilt
 * rather than cast, so a handler that put extra keys on its result cannot
 * carry them onto the wire.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  return { content: [...result.content], isError: result.isError };
}

/**
 * Narrows the SDK's request context to the small surface a tool handler needs.
 *
 * Handlers get a cancellation signal and, when the caller asked for it, a
 * progress callback — and nothing else. They have no business reaching the
 * session id, the auth info or the raw notification channel, and a narrow type
 * is the cheapest way to keep it that way.
 */
function toToolExtra(extra: ToolCallExtra): ToolExtra {
  const token = extra._meta?.progressToken;
  const result: ToolExtra = { signal: extra.signal };
  if (token === undefined) return result;

  // Only when the caller asked. MCP ties a progress notification to the token
  // on the originating request, so emitting one unasked is a protocol
  // violation — and `deploy(wait: true)` needs to know whether anyone is
  // listening before it narrates a five-minute poll.
  result.progress = (progress: number, total?: number, message?: string): void => {
    // Fire and forget, with the rejection swallowed on purpose: progress is
    // advisory, and a transport that has already closed must not turn a
    // successful deploy into an unhandled rejection that kills the process.
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total, message },
      })
      .catch(() => undefined);
  };
  return result;
}

/**
 * Last-resort rendering for an error that escaped a tool handler.
 *
 * Two jobs. It holds the contract that errors are RETURNED, never thrown across
 * the transport. And it runs the text through `redact()` — which matters
 * because a thrown message is the one string a tool can emit without passing
 * through `renderEnvelope`, and therefore the one remaining path by which a
 * resolved bearer token could reach the transcript.
 *
 * Stacks are dropped deliberately: they carry file paths and argument values,
 * and they give the model nothing it can act on.
 */
function renderUncaught(name: string, error: unknown): ToolResult {
  const parts: string[] = [];
  if (error instanceof CoolifyError) {
    parts.push(error.message);
    if (error.hint) parts.push(error.hint);
  } else if (error instanceof Error) {
    parts.push(`${name} failed: ${error.message}`);
  } else {
    parts.push(`${name} failed with a non-Error value.`);
  }
  return { content: [{ type: 'text', text: redact(parts.join(' ')) }], isError: true };
}
