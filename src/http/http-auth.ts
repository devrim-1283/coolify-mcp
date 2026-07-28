/**
 * The HTTP transport's front door.
 *
 * `serve --http` binds a port on a process that is holding a live Coolify API
 * token. Everything in this file follows from that one sentence: the endpoint is
 * reachable by anything that can route to it, and behind it sits a credential
 * that can deploy, restart and delete infrastructure.
 *
 * Two rules, and they are the whole file:
 *
 *  1. The server REFUSES TO START without $COOLIFY_MCP_AUTH_TOKEN, and refuses a
 *     short one the same way. Same fail-closed posture as the existing "no
 *     connections configured" refusal, for a stronger reason: a server that
 *     binds a port while holding a Coolify token and accepts anyone is not a
 *     degraded configuration, it is an incident.
 *
 *  2. The comparison is constant-time AND length-blind. See {@link fingerprint};
 *     the second half of that pair is the part that is usually got wrong.
 *
 * The secret a client presents is deliberately NOT the Coolify token. The server
 * holds that one and never sends it anywhere; the client presents this unrelated
 * one. So a compromised MCP client credential does not become a Coolify
 * credential, and rotating either does not force rotating the other.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { registerSecret } from '../config/secrets.js';
import { ConfigError, readEnvValue } from '../config/schema.js';

export const AUTH_TOKEN_ENV = 'COOLIFY_MCP_AUTH_TOKEN';

/**
 * Both suggested generators clear this comfortably — `openssl rand -base64 32`
 * gives 44 characters and `randomBytes(32).toString('base64url')` gives 43 — so
 * the floor refuses hand-typed passwords without ever refusing something a
 * person actually generated.
 */
export const MIN_AUTH_TOKEN_LENGTH = 32;

/**
 * Shown in both failure messages. Two of them because an operator has one or the
 * other already: `openssl` on the host, `node` in the container that is running
 * this. Neither needs anything installed and neither leaves a secret in an
 * argument list.
 */
const GENERATE_HINT = [
  '  openssl rand -base64 32',
  `  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
].join('\n');

/**
 * The same rule `config/secrets.ts` applies to a Coolify token, and the same
 * regex, because the requirement is identical: a bearer token is copied verbatim
 * into an Authorization header, so it has to be printable ASCII with no spaces.
 *
 * Kept as a separate literal rather than imported. `secrets.ts` does not export
 * it, and reaching into another module's private constant to share four
 * characters would couple two validators that are allowed to diverge — this one
 * guards a secret the operator invents, that one guards a secret Coolify issues.
 */
const INVALID_TOKEN_CHARS = /[^!-~]/;

/**
 * Reads and validates the bearer token clients must present.
 *
 * Throws {@link ConfigError}, which the CLI renders as a startup failure with a
 * written remedy. That is the entire user experience of a failed `serve --http`,
 * so the messages below name the variable, say why the rule exists, and show a
 * command that produces a value which satisfies it.
 */
export function resolveAuthToken(env: NodeJS.ProcessEnv): string {
  // `readEnvValue` rather than `env[...]`: every MCP client config format lets a
  // user leave `"COOLIFY_MCP_AUTH_TOKEN": ""` behind, and an empty value that
  // counted as "set" would bind a port guarded by a secret nobody can present —
  // failing every request with a 401 that looks like a client bug.
  const token = readEnvValue(env, AUTH_TOKEN_ENV);

  if (token === undefined) {
    throw new ConfigError(
      [
        `$${AUTH_TOKEN_ENV} is unset or empty, and \`serve --http\` will not start without it.`,
        'This endpoint is a network door in front of a live Coolify API token, so an',
        'unauthenticated one is not a degraded configuration — it is an incident.',
        '',
        'Generate a secret and export it in the environment the server starts from:',
        GENERATE_HINT,
        '',
        `$${AUTH_TOKEN_ENV} is what CLIENTS present. It is unrelated to $COOLIFY_API_TOKEN,`,
        'which the server keeps and never sends to a client — rotating either one does',
        'not force rotating the other.',
      ].join('\n'),
    );
  }

  if (token.length < MIN_AUTH_TOKEN_LENGTH) {
    // The length is the only thing about the value that is safe to print. The
    // message lands in terminals, issue reports and screen shares, and a refused
    // secret is still a secret — the user's next move is to reuse it somewhere.
    throw new ConfigError(
      [
        `$${AUTH_TOKEN_ENV} is ${token.length} characters; at least ${MIN_AUTH_TOKEN_LENGTH} are required.`,
        'A weak secret on this endpoint is equivalent to no secret at all: it is reachable',
        'by anything that can route to the port, and nothing on this path slows an attacker',
        'down between one guess and the next.',
        '',
        'Generate one rather than shortening the rule:',
        GENERATE_HINT,
      ].join('\n'),
    );
  }

  if (INVALID_TOKEN_CHARS.test(token)) {
    // Fail-closed is not enough on its own here, and that is the whole reason
    // this branch exists. A token carrying a newline or a non-ASCII character
    // starts the server perfectly and then authenticates NOBODY: it cannot be
    // put in an Authorization header, so every request 401s and the operator has
    // a working process, a correct-looking secret, and no way to tell why.
    // Refusing at startup converts a silent permanent outage into one message.
    //
    // The same rule `config/secrets.ts` applies to a Coolify token, for the same
    // reason and with the same regex. It catches the "my secret manager returned
    // JSON" mistake and a trailing newline from `echo` instead of `printf`.
    //
    // The value is deliberately not echoed: it is still a secret, and a refused
    // secret is one the user is about to reuse somewhere else.
    throw new ConfigError(
      [
        `$${AUTH_TOKEN_ENV} contains whitespace or non-printable characters, so it cannot`,
        'be sent in an Authorization header. The server would start and then refuse every',
        'request, with nothing in the logs to say why.',
        '',
        'Surrounding whitespace is trimmed before this check, so the problem is inside the',
        'value: usually a secret manager that returned JSON or a whole record rather than',
        'one field, or a multi-line paste. Select the single field that holds the token.',
        '',
        GENERATE_HINT,
      ].join('\n'),
    );
  }

  // The same registration `config/secrets.ts` performs the moment a Coolify
  // token is resolved, and needed here for a reason that is specific to this
  // token: `redact()` has a shape-based backstop for Coolify's `13|<40 chars>`
  // Sanctum tokens, but an operator-generated secret is arbitrary base64 and
  // matches no pattern anyone can write down. Registration is the ONLY thing
  // that can cover a secret whose shape is unknowable.
  //
  // It matters more in HTTP mode than anywhere else: this transport writes a log
  // line per request, and a request line is assembled from attacker-influenced
  // input next to a process that is holding this value.
  registerSecret(token);
  return token;
}

/**
 * Per-process key for {@link fingerprint}. Random, regenerated on every start,
 * never written down and never leaves this module — it is not a credential, it
 * exists only to make the compared bytes unpredictable to the caller.
 */
const COMPARISON_KEY = randomBytes(32);

/**
 * `Bearer <credentials>`, anchored, and nothing else.
 *
 * A permissive parse here is a vulnerability, so each piece is deliberate:
 *
 * `i` — RFC 9110 §11.1 defines `auth-scheme` as a case-INSENSITIVE token, so
 * `bearer`, `Bearer` and `BEARER` are the same header and a client sending the
 * lowercase form is correct. Refusing it would produce a 401 that the spec says
 * cannot happen, which no amount of re-reading a client config would explain.
 * The flag covers the scheme only. The CREDENTIALS are compared byte for byte
 * further down: a base64url secret is case-significant, and folding its case
 * would throw away a bit per character.
 *
 * ` +` — the grammar is `auth-scheme 1*SP token68`, so more than one space is
 * legal. Accepting it costs nothing, because what follows is still compared
 * exactly. Whitespace anywhere ELSE is refused: the anchors reject a leading or
 * trailing space and `[!-~]` rejects one inside the credentials.
 *
 * `[!-~]` (visible ASCII) rather than `\S` — this is where a permissive parse
 * would come from. `\S` also matches U+00A0, U+2028 and every other exotic
 * non-space, none of which may legally appear in a header field value. A NUL, CR
 * or LF in this string means it arrived through a parser bug or a request
 * smuggling attempt, and the answer to both is no rather than an attempt to
 * interpret it.
 */
const BEARER_CREDENTIALS = /^Bearer +([!-~]+)$/i;

/** Constant-time bearer check against the raw Authorization header value. */
export function isAuthorized(header: string | undefined, expected: string): boolean {
  // The runtime check earns its place despite the type. `req.headers` is a
  // loosely-typed bag; Node never gives `authorization` as an array, but a
  // caller that passed one would have it stringified by `exec` into exactly the
  // header it holds — `['Bearer <token>']` would authorize. Cheaper to refuse
  // the shape than to rely on every future call site.
  if (typeof header !== 'string') return false;

  const presented = BEARER_CREDENTIALS.exec(header)?.[1];
  // `+` in the pattern is also what makes an empty `expected` unmatchable: no
  // header can parse to empty credentials, so a caller who somehow got here with
  // a blank secret authorizes nobody.
  if (presented === undefined) return false;

  return timingSafeEqual(fingerprint(presented), fingerprint(expected));
}

/**
 * A fixed-width fingerprint of a candidate secret, so that comparing two of them
 * cannot reveal how long either one was.
 *
 * THIS IS THE POINT OF THE FILE, so the reasoning in full.
 *
 * `timingSafeEqual` THROWS when its two buffers differ in length — it can only
 * compare equal-width inputs. The obvious repair is
 *
 *     if (a.length !== b.length) return false;   // WRONG
 *
 * and it re-introduces precisely the leak `timingSafeEqual` was chosen to avoid.
 * That branch answers in nanoseconds for a wrong length and in microseconds for
 * a right one, so an attacker who can time the endpoint recovers the expected
 * token's length by sending 1, 2, 3... characters and watching for the step.
 * Length is the first thing needed to brute-force a secret and precisely the
 * thing a constant-time compare is supposed to hide, so the "fix" hands back
 * more than the naive `===` would have.
 *
 * Hashing first REMOVES the problem instead of guarding it: every input becomes
 * 32 bytes, `timingSafeEqual` can never throw, and no branch anywhere in this
 * file reads a length at all. Equal digests imply equal inputs by SHA-256's
 * collision resistance — a far stronger assumption than anything else here
 * rests on.
 *
 * HMAC under a per-process random key rather than a bare digest — the "double
 * HMAC" comparison. A bare SHA-256 of a chosen input is computable by whoever
 * chose it, so any residual signal in the comparison would be a signal about
 * bytes they can predict and search. Keyed with 32 bytes they have never seen,
 * the compared values are unpredictable to them and the comparison gives up
 * nothing even if it were not constant-time. Cost: one `randomBytes(32)` at
 * startup.
 *
 * What this does NOT hide is the time to hash the PRESENTED value, which grows
 * with its length. That is the attacker's own input, whose length they already
 * know.
 */
function fingerprint(value: string): Buffer {
  return createHmac('sha256', COMPARISON_KEY).update(value, 'utf8').digest();
}
