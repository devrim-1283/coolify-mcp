/**
 * `deploy` — POST /deploy.
 *
 * This is the Coolify verb. Everything else in the write surface exists to
 * support the moment someone says "ship it", so this tool gets the one thing no
 * other tool needs: the ability to stay in the call until the build reaches a
 * terminal status, reporting progress while it does, and to hand back the tail
 * of the build log when it fails — so the model can diagnose the failure in the
 * same turn instead of asking for logs in the next one.
 *
 * The waiting half rests on an assumption about the POST /deploy response that
 * is documented but not confirmed. `resolveWaitTargets` states exactly what is
 * known, what is guessed, and what the guess can get wrong.
 */

import { z } from 'zod';

import { coolifyRequest } from '../http/client.js';
import { renderEnvelope, shapeResponse } from '../shaping/envelope.js';
import { shapeLogs } from '../shaping/logs.js';
import { projectOne, type Row } from '../shaping/project.js';
import { redact } from '../shaping/redact.js';
import { CoolifyError } from '../types.js';
import type { Connection, ServerConfig, ToolDef, ToolExtra, ToolResult } from '../types.js';

const DEPLOY_OPERATION_ID = 'deploy-by-tag-or-uuid';
const GET_DEPLOYMENT_OPERATION_ID = 'get-deployment-by-uuid';
const LIST_APP_DEPLOYMENTS_OPERATION_ID = 'list-deployments-by-app-uuid';

const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 900;
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * A tag deploy can queue dozens of builds, and polling all of them each interval
 * eats a rate limit shared by every connection on the same Coolify user. Past
 * this count the tool returns the queue and says so instead.
 */
const MAX_WAIT_TARGETS = 10;

/**
 * Statuses Coolify's deployment queue settles on. `skipped` is terminal but not
 * a failure: Coolify emits it when a deployment would be a no-op.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'cancelled_by_user', 'skipped']);

/** How many consecutive transient poll failures to absorb before giving up. */
const MAX_TRANSIENT_POLL_FAILURES = 4;

/**
 * Log tail returned when a deployment does not finish cleanly. A fraction of the
 * standalone log budget: a deploy result also carries the deployment records, and
 * with several targets the tails add up. The tail is where the failure is.
 */
const FAILURE_LOG_BYTES = 20_000;

/**
 * Kept from Coolify's deployment record — an allowlist, see shaping/project.ts.
 * Every field here was observed on a live 4.1.2 record.
 */
const DEPLOYMENT_FIELDS = [
  'deployment_uuid', 'status', 'application_name', 'server_name', 'commit', 'commit_message',
  'is_webhook', 'is_api', 'pull_request_id', 'created_at', 'updated_at', 'finished_at', 'deployment_url',
] as const;

// ---------------------------------------------------------------------------
// Connection selection
// ---------------------------------------------------------------------------

/**
 * `instance` is published only when there is something to choose between, and on
 * a write tool it is REQUIRED WITH NO DEFAULT.
 *
 * The asymmetry against the read tools is deliberate and safety-critical. A read
 * aimed at the wrong instance costs one wasted call and is obvious from the
 * result. A write is not recoverable that way: a defaulted `instance` on `deploy`
 * means the parameter the model forgot to pass silently ships to whichever
 * connection happened to be the default, which in practice is production.
 */
function instanceShape(cfg: ServerConfig): Record<string, unknown> {
  const names = [...cfg.registry.connections.keys()];
  if (names.length < 2) return {};

  const [first, ...rest] = names;
  if (first === undefined) return {};
  return {
    instance: z
      .enum([first, ...rest])
      .describe('Which configured Coolify connection to deploy on. Required: write tools have no default target.'),
  };
}

/**
 * The requirement is enforced here rather than only in the schema, so a client
 * that ignores the published schema still cannot get an unnamed write through.
 */
function resolveConnection(cfg: ServerConfig, instance: string | undefined): Connection {
  const { connections } = cfg.registry;
  const names = [...connections.keys()];

  if (instance !== undefined) {
    const chosen = connections.get(instance);
    if (chosen) return chosen;
    throw new CoolifyError(
      `Unknown instance \`${instance}\`.`,
      'validation',
      `Configured connections: ${names.length > 0 ? names.join(', ') : 'none'}.`,
    );
  }

  if (connections.size === 1) {
    const only = connections.values().next().value;
    if (only) return only;
  }
  throw new CoolifyError(
    'This server has more than one Coolify connection configured, so `instance` is required.',
    'validation',
    `Pass one of: ${names.join(', ')}. Write tools deliberately carry no default instance.`,
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Hand-verified and tight, unlike the generic execute_* path. The generic path
 * is permissive because Coolify's OpenAPI spec is wrong in places and a strict
 * schema built from it would reject valid calls; here the field set is small,
 * checked by hand, and stable, so strictness is a net win.
 */
const ARGS = z.object({
  // Accepted whether or not `instanceShape` published it; `resolveConnection`
  // owns the "is it required" decision.
  instance: z.string().min(1).optional(),
  uuid: z.string().min(1).max(512).optional()
    .describe('UUID of the application, database or service to deploy. Several UUIDs may be given comma-separated. Cannot be combined with `tag`.'),
  tag: z.string().min(1).max(255).optional()
    .describe('Deploy every resource carrying this Coolify tag. Cannot be combined with `uuid` or `pull_request_id`.'),
  force: z.boolean().optional()
    .describe('Rebuild without the Docker layer cache. Slower; use when a cached layer is suspected of being stale.'),
  pull_request_id: z.number().int().min(1).optional()
    .describe('Deploy the preview deployment for this pull request number instead of the production branch. Requires `uuid`.'),
  docker_tag: z.string().min(1).max(255).optional()
    .describe('For applications deployed from a registry image: the image tag to deploy, for example "v1.4.2".'),
  wait: z.boolean().default(false)
    .describe('Stay in the call until the deployment reaches a terminal status (finished, failed, cancelled_by_user, skipped). Progress is reported while waiting. When false, returns as soon as Coolify has queued the build.'),
  timeout_seconds: z.number().int().min(MIN_TIMEOUT_SECONDS).max(MAX_TIMEOUT_SECONDS).default(DEFAULT_TIMEOUT_SECONDS)
    .describe('Only used with `wait`. How long to keep polling before returning the deployment as still running.'),
});

type DeployArgs = z.infer<typeof ARGS>;

/**
 * The API rejects these combinations too, but a local error saves a round trip
 * and the constraints are structural rather than incidental: `uuid` and `tag`
 * select the deployment set two different ways, and a pull request belongs to
 * exactly one application. Neither is going to become legal in a later release.
 */
function assertCombination(args: DeployArgs): void {
  if (args.uuid !== undefined && args.tag !== undefined) {
    throw new CoolifyError(
      '`uuid` and `tag` cannot be used together.',
      'validation',
      'Pass `uuid` to deploy specific resources, or `tag` to deploy everything carrying a tag.',
    );
  }
  if (args.tag !== undefined && args.pull_request_id !== undefined) {
    throw new CoolifyError(
      '`pull_request_id` cannot be used with `tag`.',
      'validation',
      'A pull request belongs to one application, so pass that application in `uuid`.',
    );
  }
  // Checked before the "one of these is required" rule: when only
  // `pull_request_id` was given both are true, and this one names the parameter
  // that is actually missing in the context the caller had in mind.
  if (args.pull_request_id !== undefined && args.uuid === undefined) {
    throw new CoolifyError(
      '`pull_request_id` requires `uuid`.',
      'validation',
      'Name the application whose pull request should be deployed.',
    );
  }
  if (args.uuid === undefined && args.tag === undefined) {
    throw new CoolifyError(
      'One of `uuid` or `tag` is required.',
      'validation',
      'find_resources returns the UUIDs of applications, databases and services on this instance.',
    );
  }
}

// ---------------------------------------------------------------------------
// POST /deploy response
// ---------------------------------------------------------------------------

interface QueuedDeployment {
  message?: string;
  resource_uuid?: string;
  deployment_uuid?: string;
}

/**
 * Reads the queue acknowledgement out of whatever POST /deploy answered with.
 *
 * `{ deployments: [...] }` is the documented shape and the one this expects. The
 * tolerance around it is there because the body has not been seen from a live
 * instance (see `resolveWaitTargets`), so this walks the containers Coolify uses
 * elsewhere and pulls the three documented keys. An unrecognised shape yields an
 * empty list, which downgrades to the fallback — it never invents a deployment.
 */
function readQueuedDeployments(data: unknown): QueuedDeployment[] {
  const containers = [data, readField(data, 'deployments'), readField(data, 'details'), readField(data, 'data')];

  for (const container of containers) {
    if (!Array.isArray(container)) continue;
    const rows = container.map(readQueuedEntry).filter((entry): entry is QueuedDeployment => entry !== undefined);
    if (rows.length > 0) return rows;
  }

  const single = readQueuedEntry(data);
  return single === undefined ? [] : [single];
}

function readQueuedEntry(value: unknown): QueuedDeployment | undefined {
  if (!isRow(value)) return undefined;

  const entry: QueuedDeployment = {};
  const message = value['message'];
  const resourceUuid = value['resource_uuid'];
  const deploymentUuid = value['deployment_uuid'];

  if (typeof message === 'string') entry.message = message;
  if (typeof resourceUuid === 'string') entry.resource_uuid = resourceUuid;
  if (typeof deploymentUuid === 'string') entry.deployment_uuid = deploymentUuid;

  return Object.keys(entry).length > 0 ? entry : undefined;
}

// ---------------------------------------------------------------------------
// Choosing what to wait on
// ---------------------------------------------------------------------------

type MatchMode = 'reported' | 'heuristic' | 'none';

interface WaitTarget {
  deploymentUuid: string;
  resourceUuid?: string;
}

interface WaitTargets {
  targets: WaitTarget[];
  match: MatchMode;
  /** Why waiting is not possible, when `targets` is empty. */
  reason?: string;
}

/**
 * The happy path, and a fallback that is worse than it looks.
 *
 * Coolify's OpenAPI spec documents the POST /deploy response as
 * `{ deployments: [{ message, resource_uuid, deployment_uuid }] }`, described as
 * "Get deployment(s) UUID's". That is exactly what the happy path reads: we poll
 * the deployment Coolify itself told us it created.
 *
 * It has NOT been confirmed against a live instance — confirming it means
 * triggering a real deployment on somebody's infrastructure — and that matters
 * more here than it normally would, because this spec is wrong in places
 * (upstream coollabsio/coolify#7702). "The schema says so" is weak evidence
 * against a schema we already distrust enough to validate the generic path
 * loosely.
 *
 * Hence the fallback, and the fallback is RACY rather than merely approximate.
 * It picks the newest deployment row for the application and assumes it is ours.
 * A webhook, a colleague clicking deploy, or a second agent starting a build in
 * the same window produces a row that matches exactly as well as ours does, and
 * we would then report someone else's build as the outcome of this call —
 * including its failure and its logs. The `baselineUuid` check (the newest row
 * must have changed since immediately before we posted) narrows the window to
 * roughly the duration of the request but does not close it, and cannot tell two
 * deployments started inside that window apart.
 *
 * Two further limits, stated rather than papered over: the history endpoint is
 * application-only, so the fallback cannot follow a database or service
 * deployment at all, and it needs exactly one UUID, so a comma-separated or tag
 * deploy gets no fallback either.
 *
 * CONFIRM THE POST /deploy RESPONSE AGAINST A LIVE INSTANCE AND DELETE THIS
 * PATH. Until then a result produced this way is marked `match: "heuristic"` and
 * the meta hint says plainly that the deployment was identified by guesswork.
 */
async function resolveWaitTargets(
  connection: Connection,
  args: DeployArgs,
  queued: readonly QueuedDeployment[],
  baselineUuid: string | undefined,
  signal: AbortSignal | undefined,
): Promise<WaitTargets> {
  const reported: WaitTarget[] = [];
  for (const entry of queued) {
    if (entry.deployment_uuid === undefined) continue;
    const target: WaitTarget = { deploymentUuid: entry.deployment_uuid };
    if (entry.resource_uuid !== undefined) target.resourceUuid = entry.resource_uuid;
    reported.push(target);
  }
  if (reported.length > 0) return { targets: reported, match: 'reported' };

  const single = singleUuid(args.uuid);
  if (single === undefined) {
    return cannotWait('the call targeted a tag or several UUIDs at once, so no single deployment history applies.');
  }

  const latest = await latestDeployment(connection, single, signal);
  if (latest === undefined) {
    return cannotWait('no deployment history is readable for this resource. History is only exposed for applications.');
  }
  if (baselineUuid !== undefined && latest.deploymentUuid === baselineUuid) {
    return cannotWait('the newest deployment for this resource is the one that already existed before the request.');
  }
  return { targets: [latest], match: 'heuristic' };
}

/** `reason` completes the sentence "Coolify did not report a deployment UUID, and …". */
function cannotWait(reason: string): WaitTargets {
  return { targets: [], match: 'none', reason: `Coolify did not report a deployment UUID, and ${reason}` };
}

/** `undefined` unless exactly one UUID was given: the fallback cannot follow a set. */
function singleUuid(uuid: string | undefined): string | undefined {
  if (uuid === undefined) return undefined;
  const parts = uuid.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.length === 1 ? parts[0] : undefined;
}

/**
 * Newest deployment for an application. Errors are swallowed: this only ever
 * feeds the fallback, so a 404 (not an application) or a permission failure
 * should degrade waiting, not fail the deploy that already succeeded.
 */
async function latestDeployment(
  connection: Connection,
  resourceUuid: string,
  signal: AbortSignal | undefined,
): Promise<WaitTarget | undefined> {
  let data: unknown;
  try {
    const response = await coolifyRequest<unknown>({
      connection,
      method: 'GET',
      path: `/deployments/applications/${encodeURIComponent(resourceUuid)}`,
      query: { take: 1 },
      operationId: LIST_APP_DEPLOYMENTS_OPERATION_ID,
      signal,
    });
    data = response.data;
  } catch {
    return undefined;
  }

  const rows = readRows(data);
  const newest = rows[0];
  if (newest === undefined) return undefined;

  const deploymentUuid = newest['deployment_uuid'];
  if (typeof deploymentUuid !== 'string' || deploymentUuid.length === 0) return undefined;
  return { deploymentUuid, resourceUuid };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Small applications finish inside 90 seconds, so early polls are frequent
 * enough to feel immediate. A fifteen-minute image build should not spend
 * hundreds of requests out of a 200/minute budget that every connection sharing
 * a Coolify user account draws on, so the interval widens as the wait goes on.
 */
function pollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 120_000) return 5_000;
  return 10_000;
}

interface PollState {
  target: WaitTarget;
  record?: Row;
  status?: string;
  /** Set when this specific deployment could not be read at all. */
  error?: string;
}

interface WaitOutcome {
  states: PollState[];
  timedOut: boolean;
  cancelled: boolean;
  elapsedSeconds: number;
}

async function waitForDeployments(
  connection: Connection,
  targets: readonly WaitTarget[],
  timeoutSeconds: number,
  extra: ToolExtra,
): Promise<WaitOutcome> {
  const states: PollState[] = targets.map((target) => ({ target }));
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  const finish = (timedOut: boolean, cancelled: boolean): WaitOutcome =>
    ({ states, timedOut, cancelled, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
  let transientFailures = 0;

  for (;;) {
    if (extra.signal?.aborted === true) return finish(false, true);

    let transientThisRound = false;
    for (const state of states) {
      if (isTerminal(state)) continue;

      try {
        const response = await coolifyRequest<unknown>({
          connection,
          method: 'GET',
          path: `/deployments/${encodeURIComponent(state.target.deploymentUuid)}`,
          operationId: GET_DEPLOYMENT_OPERATION_ID,
          signal: extra.signal,
        });
        const record = readDeploymentRecord(response.data);
        if (record !== undefined) {
          state.record = record;
          const status = record['status'];
          state.status = typeof status === 'string' ? status : undefined;
          delete state.error;
        }
      } catch (error) {
        // A deployment row can lag its own queue entry by a moment, and a
        // dropped socket four minutes into a wait should not throw away a build
        // that is still running. Both are absorbed for a few rounds; anything
        // else — auth, rate limit, a refused gate — is real and ends the wait.
        if (!isTransientPollFailure(error)) throw error;
        transientThisRound = true;
        state.error = error instanceof Error ? error.message : 'deployment status could not be read';
      }
    }
    // Counted per round rather than per request: with several targets, one
    // healthy deployment must not keep resetting the budget for a sibling that
    // is failing on every round.
    transientFailures = transientThisRound ? transientFailures + 1 : 0;
    if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES) return finish(false, false);

    if (states.every(isTerminal)) return finish(false, false);

    const now = Date.now();
    if (now >= deadline) return finish(true, false);

    // A silent five-minute tool call is indistinguishable from a hung one, so
    // every poll reports where the build is. `total` is the timeout, which makes
    // the host's progress bar mean "how much of the allowed wait is used".
    reportProgress(extra, states, now - startedAt, timeoutSeconds);
    await sleep(Math.min(pollIntervalMs(now - startedAt), deadline - now), extra.signal);
  }
}

function isTerminal(state: PollState): boolean {
  return state.status !== undefined && TERMINAL_STATUSES.has(state.status);
}

function reportProgress(extra: ToolExtra, states: readonly PollState[], elapsedMs: number, timeoutSeconds: number): void {
  if (extra.progress === undefined) return;

  const elapsedSeconds = Math.round(elapsedMs / 1000);
  const summary = states.map((state) => `${state.target.deploymentUuid}: ${state.status ?? 'unknown'}`).join(', ');
  extra.progress(elapsedSeconds, timeoutSeconds, `${elapsedSeconds}s elapsed — ${summary}`);
}

function isTransientPollFailure(error: unknown): boolean {
  return error instanceof CoolifyError && (error.kind === 'not_found' || error.kind === 'network');
}

/**
 * Resolves on abort instead of rejecting. The loop checks `signal.aborted`
 * immediately afterwards and returns what it has, which beats an exception: a
 * cancelled wait still knows the deployment UUID and its last observed status,
 * and the build keeps running on the server either way.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Deployment records and logs
// ---------------------------------------------------------------------------

function readDeploymentRecord(data: unknown): Row | undefined {
  if (isRow(data)) {
    // GET /deployments/{uuid} returns the record unwrapped, with `status` and
    // `deployment_uuid` at the top level — confirmed live. The unwrapping below
    // is tolerance for a wrapper, applied only when the outer object carries
    // neither field itself.
    if (typeof data['status'] === 'string' || typeof data['deployment_uuid'] === 'string') return data;
    const inner = data['data'];
    if (isRow(inner)) return inner;
    return data;
  }
  const rows = readRows(data);
  return rows[0];
}

/**
 * Coolify stores a build log in the deployment row's `logs` column as a JSON
 * string holding an array of `{ command, output, type, timestamp, hidden, batch }`
 * — confirmed against a live 4.1.2 instance, where a routine build produced 106
 * entries and 60 KB. Only `output` is kept; the rest is bookkeeping that would
 * cost tokens and answer nothing.
 *
 * Older rows hold plain text, and anything unparseable is passed through rather
 * than dropped: a log we cannot decompose is still the only evidence of why a
 * build failed.
 */
function extractLogText(record: Row): string | undefined {
  const raw = record['logs'];
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed)) return raw;

  const lines = parsed
    .map((entry) => (isRow(entry) ? entry['output'] : entry))
    .filter((line): line is string => typeof line === 'string');
  return lines.length > 0 ? lines.join('\n') : raw;
}

function buildDeploymentResult(state: PollState, includeLogs: boolean): Row {
  const result: Row = {
    deployment_uuid: state.target.deploymentUuid,
    ...(state.record === undefined ? {} : projectOne(state.record, DEPLOYMENT_FIELDS)),
  };
  if (state.target.resourceUuid !== undefined) result['resource_uuid'] = state.target.resourceUuid;
  if (state.status !== undefined) result['status'] = state.status;
  if (state.error !== undefined) result['status_error'] = state.error;

  if (includeLogs && state.record !== undefined) {
    const logs = extractLogText(state.record);
    if (logs !== undefined) {
      const shaped = shapeLogs(logs, { maxBytes: FAILURE_LOG_BYTES });
      result['logs_tail'] = shaped.text;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(rawArgs: Record<string, unknown>, cfg: ServerConfig, extra: ToolExtra): Promise<ToolResult> {
  try {
    const args = parseArgs(rawArgs);
    assertCombination(args);
    const connection = resolveConnection(cfg, args.instance);

    // Taken before the deploy, because after it there is nothing left to compare
    // against: this is what lets the fallback tell "the deployment that was
    // already there" from "the one this call started". It costs one GET on every
    // waiting deploy, including the ones that turn out not to need it — the
    // response that would make it unnecessary only arrives after the point where
    // the baseline had to be taken. One request ahead of a multi-minute build is
    // the cheaper side of that trade.
    const baselineUuid = args.wait ? await baselineDeploymentUuid(connection, args.uuid, extra.signal) : undefined;

    const response = await coolifyRequest<unknown>({
      connection,
      method: 'POST',
      // Coolify reads this endpoint's arguments from the query string and
      // declares no request body; the HTTP client supplies the placeholder body
      // that Coolify's "Empty JSON." check demands.
      path: '/deploy',
      query: {
        uuid: args.uuid,
        tag: args.tag,
        force: args.force,
        // The spec also lists a shorter `pr` alias for the same value. Only the
        // long spelling is sent: both appear in the same catalog version, so the
        // instance that accepts one accepts the other.
        pull_request_id: args.pull_request_id,
        docker_tag: args.docker_tag,
      },
      operationId: DEPLOY_OPERATION_ID,
      signal: extra.signal,
    });

    const queued = readQueuedDeployments(response.data);
    if (!args.wait) {
      return ok({ queued, waited: false }, {
        instance: connection.name,
        count: queued.length,
        hint: 'The deployment was queued. Its outcome is not known yet; get_deployment or deploy with wait=true report the terminal status.',
      });
    }

    return await waitAndRender(connection, args, queued, baselineUuid, extra);
  } catch (error) {
    return errorResult(error);
  }
}

async function baselineDeploymentUuid(
  connection: Connection,
  uuid: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const single = singleUuid(uuid);
  if (single === undefined) return undefined;
  const latest = await latestDeployment(connection, single, signal);
  return latest?.deploymentUuid;
}

async function waitAndRender(
  connection: Connection,
  args: DeployArgs,
  queued: readonly QueuedDeployment[],
  baselineUuid: string | undefined,
  extra: ToolExtra,
): Promise<ToolResult> {
  const resolved = await resolveWaitTargets(connection, args, queued, baselineUuid, extra.signal);
  const queuedOnly = (hint: string): ToolResult =>
    ok({ queued, waited: false, match: resolved.match }, { instance: connection.name, count: queued.length, hint });

  if (resolved.targets.length === 0) {
    return queuedOnly(
      `${resolved.reason ?? 'The deployment could not be identified.'} The deployment itself was queued and is running; list_deployments shows what is currently in flight.`,
    );
  }
  if (resolved.targets.length > MAX_WAIT_TARGETS) {
    return queuedOnly(
      `This call queued ${resolved.targets.length} deployments, above the ${MAX_WAIT_TARGETS} that this tool will poll in one turn. All of them are running; list_deployments shows their status.`,
    );
  }

  let outcome: WaitOutcome;
  try {
    outcome = await waitForDeployments(connection, resolved.targets, args.timeout_seconds, extra);
  } catch (error) {
    // The deployment was accepted and is running; only our observation of it
    // failed — a rate limit, a revoked token, a dropped network. Returning an
    // error result here would read as "the deploy failed", which is both untrue
    // and the more expensive of the two mistakes to make, so the queue receipt
    // goes back with the reason the watch stopped.
    return queuedOnly(`The deployment was queued, but watching it stopped early: ${describeError(error)}`);
  }

  // Logs accompany anything that did not finish cleanly, including a timeout —
  // the tail of a build that is still going says which step it is on, which is
  // the same question the model would otherwise ask next.
  const deployments = outcome.states.map((state) => buildDeploymentResult(state, state.status !== 'finished'));

  return ok(
    { queued, waited: true, match: resolved.match, timed_out: outcome.timedOut, cancelled: outcome.cancelled, deployments },
    {
      instance: connection.name,
      count: deployments.length,
      hint: composeWaitHint(resolved.match, outcome, args.timeout_seconds),
    },
  );
}

/** Facts about what happened. Never an instruction about what to do next. */
function composeWaitHint(match: MatchMode, outcome: WaitOutcome, timeoutSeconds: number): string {
  const notes: string[] = [];

  if (outcome.cancelled) {
    notes.push(`Waiting was cancelled after ${outcome.elapsedSeconds}s. The deployment itself is unaffected and continues on the server.`);
  } else if (outcome.timedOut) {
    notes.push(`The deployment had not reached a terminal status after ${timeoutSeconds}s, so polling stopped. The build continues on the server.`);
  } else {
    notes.push(`Reached a terminal status after ${outcome.elapsedSeconds}s.`);
  }

  if (match === 'heuristic') {
    notes.push(
      'Coolify did not report a deployment UUID for this request, so the deployment reported here was identified as the newest deployment for the resource that was not present immediately before the call. A deployment started by another actor in the same window would match the same way.',
    );
  }
  return notes.join(' ');
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function parseArgs(raw: Record<string, unknown>): DeployArgs {
  const parsed = ARGS.safeParse(raw);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new CoolifyError(`Invalid arguments: ${detail}`, 'validation');
}

function ok(
  data: unknown,
  meta: { instance: string; count: number; hint: string },
): ToolResult {
  return renderEnvelope(shapeResponse(data, meta));
}

/** Message, hint and any per-field validation detail, in the order a reader wants them. */
function describeError(error: unknown): string {
  if (error instanceof CoolifyError) {
    const parts = [error.message];
    if (error.hint) parts.push(error.hint);
    for (const [field, messages] of Object.entries(error.validationErrors ?? {})) {
      parts.push(`${field}: ${messages.join('; ')}`);
    }
    return parts.join('\n');
  }
  return error instanceof Error ? error.message : 'The request failed for an unknown reason.';
}

/**
 * Errors are returned, never thrown across the transport: a thrown error is a
 * protocol failure the model cannot read, a returned one is text it can act on.
 * Re-redacted because this is the last point before the transcript.
 */
function errorResult(error: unknown): ToolResult {
  return { content: [{ type: 'text', text: redact(describeError(error)) }], isError: true };
}

function readField(value: unknown, key: string): unknown {
  return isRow(value) ? value[key] : undefined;
}

/**
 * Rows out of a bare array or any of the containers Coolify wraps lists in.
 * GET /deployments/applications/{uuid} answers `{ count, deployments: [...] }`
 * — confirmed live; the other spellings are tolerance.
 */
function readRows(data: unknown): Row[] {
  const containers = [data, readField(data, 'deployments'), readField(data, 'data')];
  for (const container of containers) {
    if (Array.isArray(container)) return container.filter(isRow);
  }
  return [];
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const deploy: ToolDef = {
  name: 'deploy',
  description:
    'Deploy applications, databases and services on Coolify. Target one or more resources by UUID, or every resource carrying a tag. With wait=true the call stays open until the deployment finishes, reports progress while it runs, and returns the tail of the build log when it does not succeed.',
  annotations: {
    title: 'Deploy',
    readOnlyHint: false,
    destructiveHint: false,
    // Two calls start two builds, and with `force` they are two full rebuilds.
    idempotentHint: false,
    openWorldHint: true,
  },
  surface: 'write',
  inputSchema: (cfg: ServerConfig): Record<string, unknown> => ({
    ...instanceShape(cfg),
    uuid: ARGS.shape.uuid,
    tag: ARGS.shape.tag,
    force: ARGS.shape.force,
    pull_request_id: ARGS.shape.pull_request_id,
    docker_tag: ARGS.shape.docker_tag,
    wait: ARGS.shape.wait,
    timeout_seconds: ARGS.shape.timeout_seconds,
  }),
  handler,
};
