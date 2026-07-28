/**
 * The HTTP transport's front door.
 *
 * Two behaviours live in `src/http/http-auth.ts` and they fail in opposite
 * directions, so they are tested in opposite ways.
 *
 * `resolveAuthToken` fails LOUDLY, once, at startup, in front of a human at a
 * terminal. Its message is the entire user experience of a failed
 * `serve --http`, so the assertions below are on the CONTENT of that message. A
 * test that only asserted `toThrow()` would keep passing while the text decayed
 * into "invalid configuration", and the person reading it would go looking for a
 * flag to turn the check off.
 *
 * `isAuthorized` fails SILENTLY, on every request, in front of whoever found the
 * port. Its tests are a list of things that must be answered "no" — plus the
 * different-length token, which deserves a note about what a test can and cannot
 * prove here.
 *
 * There are two ways to get that comparison wrong, and only one of them is
 * reachable from a test:
 *
 *   (a) hand `timingSafeEqual` the two raw values. It THROWS when its buffers
 *       differ in length, so this is a 500 where a 401 belongs — triggerable by
 *       any stranger with a keyboard. Caught below, by the assertions that a
 *       short token produces `false` and not an exception.
 *
 *   (b) silence (a) with an early `if (a.length !== b.length) return false`.
 *       That is functionally correct and indistinguishable from a correct
 *       implementation by any assertion in this file — it differs only in
 *       TIMING, answering a wrong-length guess in nanoseconds and a right-length
 *       one in microseconds, which hands over the expected token's length one
 *       probe at a time. Nothing here can measure that. It is prevented by
 *       construction instead: the comparison runs over fixed-width digests, so
 *       there is no length in the file to branch on. See `fingerprint`.
 *
 * So the different-length cases below are a guard against (a) and a standing
 * reminder of (b), not a proof that (b) is absent. The proof of (b) is the code.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/config/schema.js';
import {
  AUTH_TOKEN_ENV,
  MIN_AUTH_TOKEN_LENGTH,
  isAuthorized,
  resolveAuthToken,
} from '../src/http/http-auth.js';
import { redact } from '../src/shaping/redact.js';

/** Exactly {@link MIN_AUTH_TOKEN_LENGTH}, so the boundary cases sit on the boundary. */
const TOKEN = 'Nq7vRz2LxKTb4WdC1sHf6JgY0uPa3E9m';

/** Same length, no character in common — the case `===` gets right and timing does not. */
const SAME_LENGTH_WRONG = 'Xw5tBn8QjDVc7kLp1rMz4sGf6yUa0NHh';

/** What `randomBytes(32).toString('base64url')` actually produces: 43 chars, with `-` and `_`. */
const GENERATED_TOKEN = 'kR3xQ9wLmZ7vTn2sBd5hJc8yFg1pAe4uXo6iVt0N-_a';

/** One character short of the floor. */
const SHORT_TOKEN = TOKEN.slice(0, MIN_AUTH_TOKEN_LENGTH - 1);

/**
 * Used by the redaction test and NOWHERE else.
 *
 * `registerSecret` writes into a process-global set that `src/config/secrets.ts`
 * exports no way to clear, so any token this file resolves stays registered for
 * the rest of the file. A dedicated constant is what keeps that test's negative
 * control ("not masked before resolution") true no matter what ran first.
 */
const REDACTION_TOKEN = 'Uv2mHq8LdP5xKw1zBn6tRc4jYg0sFa7E';

/**
 * A fresh environment rather than `process.env`.
 *
 * The real one carries whatever the developer running the suite has exported,
 * and $COOLIFY_MCP_AUTH_TOKEN is exactly the kind of thing somebody working on
 * the HTTP transport has exported.
 */
function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [AUTH_TOKEN_ENV]: value };
}

function rejection(value?: string): ConfigError {
  try {
    resolveAuthToken(env(value));
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected resolveAuthToken to reject');
}

// ---------------------------------------------------------------------------
// The suite is only meaningful if the fixtures are the lengths they claim
// ---------------------------------------------------------------------------

describe('the fixtures themselves', () => {
  it('uses a token of exactly the minimum length', () => {
    expect(TOKEN).toHaveLength(MIN_AUTH_TOKEN_LENGTH);
  });

  it('uses a wrong token of the same length that shares no character position', () => {
    expect(SAME_LENGTH_WRONG).toHaveLength(TOKEN.length);
    expect(SAME_LENGTH_WRONG).not.toBe(TOKEN);
  });

  it('uses a short token that misses the floor by exactly one character', () => {
    expect(SHORT_TOKEN).toHaveLength(MIN_AUTH_TOKEN_LENGTH - 1);
  });
});

// ---------------------------------------------------------------------------
// resolveAuthToken — what it accepts
// ---------------------------------------------------------------------------

describe('resolveAuthToken', () => {
  it('accepts a token of exactly the minimum length', () => {
    expect(resolveAuthToken(env(TOKEN))).toBe(TOKEN);
  });

  it('accepts a generated 43-character token unchanged', () => {
    expect(resolveAuthToken(env(GENERATED_TOKEN))).toBe(GENERATED_TOKEN);
  });

  it('trims a value a client config left padded', () => {
    // `"env": {"COOLIFY_MCP_AUTH_TOKEN": "<token>\n"}` is what a here-doc or a
    // copied file produces, and the padding is not part of the secret.
    expect(resolveAuthToken(env(`\n  ${TOKEN}  `))).toBe(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// resolveAuthToken — refusing to start
// ---------------------------------------------------------------------------

describe('resolveAuthToken refuses to start', () => {
  it.each([
    ['absent', undefined],
    ['the empty string every client config format can produce', ''],
    ['whitespace only', '   '],
    ['a bare newline', '\n'],
  ])('when the value is %s', (_why, value) => {
    const error = rejection(value);

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(`$${AUTH_TOKEN_ENV} is unset or empty`);
  });

  it('and says the refusal is deliberate rather than a missing default', () => {
    expect(rejection().message).toContain('will not start without it');
  });

  it('and shows two commands that generate a suitable secret', () => {
    // Without one, the next thing a user types is a password they can remember,
    // which is the exact failure the length floor below exists to catch.
    const message = rejection().message;

    expect(message).toContain('openssl rand -base64 32');
    expect(message).toContain("randomBytes(32).toString('base64url')");
  });

  it('and distinguishes this secret from the Coolify API token', () => {
    // The two are unrelated by design, and a user who assumes otherwise pastes
    // their Coolify credential into a variable clients are meant to hold.
    const message = rejection().message;

    expect(message).toContain('COOLIFY_API_TOKEN');
    expect(message).toContain('never sends to a client');
  });

  it('when the token is one character short of the minimum', () => {
    expect(rejection(SHORT_TOKEN)).toBeInstanceOf(ConfigError);
  });

  it('and reports the length it found alongside the length it wants', () => {
    const message = rejection(SHORT_TOKEN).message;

    expect(message).toContain(`is ${MIN_AUTH_TOKEN_LENGTH - 1} characters`);
    expect(message).toContain(`at least ${MIN_AUTH_TOKEN_LENGTH} are required`);
  });

  it('and explains that a weak secret here is equivalent to no secret', () => {
    expect(rejection(SHORT_TOKEN).message).toContain('equivalent to no secret');
  });

  it('and never echoes the token it just refused', () => {
    // A refused secret is still a secret: the message goes into terminals, issue
    // reports and screen shares, and the user's next move is to reuse the value.
    expect(rejection(SHORT_TOKEN).message).not.toContain(SHORT_TOKEN);
  });

  it('and counts the length after trimming, so padding cannot buy the missing characters', () => {
    const message = rejection(`   ${SHORT_TOKEN}   `).message;

    expect(message).toContain(`is ${MIN_AUTH_TOKEN_LENGTH - 1} characters`);
  });

  it.each([['a'], ['hunter2'], ['correct-horse-battery']])(
    'when the token is the hand-typed password %s',
    (value) => {
      expect(() => resolveAuthToken(env(value))).toThrow(ConfigError);
    },
  );
});

// ---------------------------------------------------------------------------
// resolveAuthToken — the redaction set
// ---------------------------------------------------------------------------

describe('resolveAuthToken registers the token for redaction', () => {
  it('masks the token in later output, which nothing about its shape could do', () => {
    // `redact()` carries a shape-based backstop for Coolify's `13|<40 chars>`
    // Sanctum tokens. An operator-generated secret is arbitrary base64 and
    // matches no pattern anyone could write, so registration at resolution time
    // is the ONLY thing standing between it and a request log line.
    const line = `GET /mcp 200 authorization=Bearer ${REDACTION_TOKEN}`;
    expect(redact(line), 'the negative control: unregistered, it goes out in the clear').toContain(
      REDACTION_TOKEN,
    );

    resolveAuthToken(env(REDACTION_TOKEN));

    expect(redact(line)).not.toContain(REDACTION_TOKEN);
    expect(redact(line)).toContain('***');
  });
});

// ---------------------------------------------------------------------------
// isAuthorized — what it accepts
// ---------------------------------------------------------------------------

describe('isAuthorized accepts', () => {
  it('the exact token behind a Bearer scheme', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([['Bearer'], ['bearer'], ['BEARER'], ['BeArEr']])(
    'the %s scheme, because RFC 9110 makes auth-scheme case-insensitive',
    (scheme) => {
      // A client sending the lowercase form is CORRECT. Refusing it would be a
      // 401 the spec says cannot happen, and no amount of re-reading a client
      // config would explain it.
      expect(isAuthorized(`${scheme} ${TOKEN}`, TOKEN)).toBe(true);
    },
  );

  it('more than one space between the scheme and the token', () => {
    // The grammar is `auth-scheme 1*SP token68`; two spaces is a legal header,
    // and accepting it widens nothing because the credentials are still
    // compared exactly.
    expect(isAuthorized(`Bearer   ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('a token drawn from the full base64url alphabet', () => {
    expect(isAuthorized(`Bearer ${GENERATED_TOKEN}`, GENERATED_TOKEN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAuthorized — what it refuses
// ---------------------------------------------------------------------------

describe('isAuthorized refuses', () => {
  it.each([
    ['an absent header', undefined],
    ['an empty header', ''],
    ['a header of whitespace only', '   '],
    ['the scheme with no credentials', 'Bearer'],
    ['the scheme and a separator with no credentials', 'Bearer '],
    ['a bare token with no scheme at all', TOKEN],
    ['the Basic scheme', `Basic ${TOKEN}`],
    ['an unrelated scheme', `Token ${TOKEN}`],
    ['a scheme that merely starts with Bearer', `Bearer2 ${TOKEN}`],
    ['a leading space before the scheme', ` Bearer ${TOKEN}`],
    ['a trailing space after the token', `Bearer ${TOKEN} `],
    ['a tab in place of the separator', `Bearer\t${TOKEN}`],
    ['a second credential after the first', `Bearer ${TOKEN} ${TOKEN}`],
    ['the token wrapped in quotes', `Bearer "${TOKEN}"`],
    ['the scheme repeated', `Bearer Bearer ${TOKEN}`],
  ])('%s', (_why, header) => {
    expect(isAuthorized(header, TOKEN)).toBe(false);
  });

  it('a wrong token of the same length', () => {
    expect(isAuthorized(`Bearer ${SAME_LENGTH_WRONG}`, TOKEN)).toBe(false);
  });

  it('a wrong token differing only in the final character', () => {
    const nearMiss = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('m') ? 'n' : 'm'}`;

    expect(isAuthorized(`Bearer ${nearMiss}`, TOKEN)).toBe(false);
  });

  it.each([
    ['a prefix of it', TOKEN.slice(0, 8)],
    ['one character shorter', TOKEN.slice(0, -1)],
    ['one character longer', `${TOKEN}x`],
    ['very much longer', `${TOKEN}${TOKEN}${TOKEN}`],
  ])('a token that is %s', (_why, wrong) => {
    // These are the probes a length oracle answers faster than the rest. This
    // assertion only pins the ANSWER — see the file header for why the timing
    // half is a property of the construction rather than of any test.
    expect(isAuthorized(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  it('a token that differs from the expected one only in case', () => {
    // The `i` flag covers the SCHEME. Folding the credentials would throw away
    // a bit per character of a base64url secret.
    expect(isAuthorized(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN.toLowerCase()}`, TOKEN)).toBe(false);
  });

  it('every header when the expected token is empty', () => {
    // No header can parse to empty credentials, so a caller who reached this
    // function with a blank secret authorizes nobody rather than everybody.
    expect(isAuthorized(`Bearer ${TOKEN}`, '')).toBe(false);
    expect(isAuthorized('Bearer ', '')).toBe(false);
    expect(isAuthorized('Bearer', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAuthorized — hostile input
// ---------------------------------------------------------------------------

describe('isAuthorized on hostile input', () => {
  const HOSTILE: Array<[string, string]> = [
    ['a one-megabyte header', `Bearer ${'A'.repeat(1_000_000)}`],
    ['a NUL after the token', `Bearer ${TOKEN}\0`],
    ['a NUL inside the token', `Bearer ${TOKEN.slice(0, 8)}\0${TOKEN.slice(9)}`],
    ['a trailing newline', `Bearer ${TOKEN}\n`],
    ['a CRLF-injected second header', `Bearer ${TOKEN}\r\nX-Admin: true`],
    // Escapes rather than literals: these are exactly the characters a reviewer
    // cannot see in a diff, which is why `\S` matching them is a hazard worth
    // testing for.
    ['a non-breaking space in place of a character', `Bearer ${TOKEN.slice(0, 31)}\u00a0`],
    ['a Unicode line separator', `Bearer ${TOKEN}\u2028`],
    ['a non-ASCII credential', `Bearer ${'é'.repeat(MIN_AUTH_TOKEN_LENGTH)}`],
    ['a lone surrogate', `Bearer ${TOKEN}\ud800`],
    ['an emoji', `Bearer 🔓${TOKEN}`],
  ];

  it.each(HOSTILE)('answers %s with false rather than an exception', (_why, header) => {
    // Both halves matter. A throw from this function is a 500 where a 401
    // belongs, and on the request path a 500 that a stranger can trigger at will
    // is a denial-of-service primitive.
    expect(() => isAuthorized(header, TOKEN)).not.toThrow();
    expect(isAuthorized(header, TOKEN)).toBe(false);
  });

  it('answers a different-length token with false rather than the exception timingSafeEqual raises', () => {
    // `timingSafeEqual` throws "Input buffers must have the same byte length" on
    // mismatched widths, so an implementation that fed it the raw values would
    // throw here — a 500 in place of a 401, on a path a stranger controls. This
    // is failure mode (a) from the file header.
    expect(() => isAuthorized('Bearer a', TOKEN)).not.toThrow();
    expect(isAuthorized('Bearer a', TOKEN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The parse boundary itself
// ---------------------------------------------------------------------------

/**
 * The one property `[!-~]` buys over `\S`, and it is invisible everywhere else
 * in this file.
 *
 * With an ordinary base64url secret, a header carrying a NUL or a `é` is refused
 * by the DIGEST COMPARISON regardless of how permissively it was parsed — so
 * every hostile-input case above passes just as well with a sloppy pattern.
 * Only a token made of the disputed characters can tell the two apart, which is
 * what these cases are.
 *
 * The rule being pinned: credentials that cannot legally appear in an HTTP field
 * value never authenticate. A header containing one arrived through a parser bug
 * or a smuggling proxy, and the answer to both is no.
 */
describe('isAuthorized on credentials that could not legally be transmitted', () => {
  it.each([
    ['non-ASCII', 'é'.repeat(MIN_AUTH_TOKEN_LENGTH)],
    ['an embedded NUL', `${TOKEN.slice(0, 8)}\0${TOKEN.slice(9)}`],
    ['an emoji', `🔓${TOKEN.slice(2)}`],
    ['an inner space', `${TOKEN.slice(0, 16)} ${TOKEN.slice(17)}`],
  ])('refuses a %s token even when the header presents it exactly', (_why, untransmittable) => {
    expect(isAuthorized(`Bearer ${untransmittable}`, untransmittable)).toBe(false);
  });

  it.each([
    ['non-ASCII', 'é'.repeat(MIN_AUTH_TOKEN_LENGTH)],
    ['an embedded NUL', `${TOKEN.slice(0, 8)}\0${TOKEN.slice(9)}`],
    ['an emoji', `🔓${TOKEN.slice(2)}`],
    ['an inner space', `${TOKEN.slice(0, 16)} ${TOKEN.slice(17)}`],
    ['an inner newline', `${TOKEN.slice(0, 16)}\n${TOKEN.slice(17)}`],
    ['a tab', `${TOKEN.slice(0, 16)}\t${TOKEN.slice(17)}`],
  ])('refuses to start on a token containing %s', (_why, untransmittable) => {
    // This is the corner that would otherwise be fail-closed WITHOUT being
    // fail-loud. Such a token cannot go in an Authorization header, so a server
    // that accepted it at startup would boot cleanly and then 401 every request
    // forever, leaving the operator with a healthy process, a secret that looks
    // right, and nothing in the logs pointing at the cause.
    expect(() => resolveAuthToken(env(untransmittable))).toThrow(ConfigError);
  });

  it('still accepts a token that is merely padded, because that is trimmed first', () => {
    // The guard is about characters INSIDE the value. Surrounding whitespace —
    // the trailing newline `echo` adds, an indented line in a compose file — is
    // trimmed by `readEnvValue` long before this check, and refusing it would be
    // refusing a token that works.
    expect(resolveAuthToken(env(`  ${TOKEN}\n`))).toBe(TOKEN);
  });

  it('names the likely cause rather than echoing the value', () => {
    // A refused secret is still a secret: the message lands in terminals, issue
    // reports and screen shares, and the user's next move is to reuse the value
    // somewhere else. So the message explains the shape of the mistake and never
    // quotes the token.
    const fromJson = `{"token":"${TOKEN}"}\n  trailing`;

    const error = rejection(fromJson);

    expect(error.message).toMatch(/JSON|one field/i);
    expect(error.message).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// The two halves together
// ---------------------------------------------------------------------------

describe('resolveAuthToken and isAuthorized', () => {
  it('authorizes a header carrying exactly the token the environment configured', () => {
    const expected = resolveAuthToken(env(GENERATED_TOKEN));

    expect(isAuthorized(`Bearer ${expected}`, expected)).toBe(true);
    expect(isAuthorized(`Bearer ${SAME_LENGTH_WRONG}`, expected)).toBe(false);
  });

  it('authorizes the untrimmed token from a padded configuration', () => {
    // The client presents the secret; the server trimmed it at startup. If those
    // two disagreed, a padded config would produce a server nobody can reach.
    const expected = resolveAuthToken(env(`  ${TOKEN}\n`));

    expect(isAuthorized(`Bearer ${TOKEN}`, expected)).toBe(true);
  });
});
