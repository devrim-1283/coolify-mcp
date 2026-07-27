/**
 * Redaction.
 *
 * Two separate jobs that are easy to confuse:
 *
 *  - {@link redact} removes OUR credentials — the bearer tokens this process
 *    resolved. Never optional, never revealable, applied to every string that
 *    leaves the server.
 *  - {@link redactObject} masks COOLIFY'S secrets — the values behind keys like
 *    `password` or `private_key`. Masked by default, revealable on explicit
 *    request, because sometimes reading the value is the whole point.
 */

import { getSecrets } from '../config/secrets.js';

export const MASK = '***';

/**
 * Values shorter than this are never masked.
 *
 * This is a correctness guard, not a security relaxation: one empty string in
 * the secret set (a token command that returned nothing) would otherwise splice
 * `***` between every character of every response. Coolify tokens are
 * `<id>|<40 chars>`, so no real credential is near this floor.
 */
const MIN_SECRET_LENGTH = 4;

/**
 * Laravel Sanctum token shape: numeric id, pipe, 40 alphanumerics. Matched as a
 * backstop because a token this process never resolved can still arrive in a
 * response body — a Coolify environment variable holding another instance's
 * credential is a completely ordinary thing to find.
 */
const SANCTUM_TOKEN = /\b\d+\|[A-Za-z0-9]{40}\b/g;

/** Key names whose value is assumed to be a credential. */
const SENSITIVE_KEY = /password|secret|token|private_key|_key$/i;

export interface RedactOptions {
  /** Return credential values in the clear. Off by default — see below. */
  reveal?: boolean;
  /** Override the registered secret set. Present for tests; production reads the registry. */
  secrets?: Iterable<string>;
}

/**
 * Replace every registered secret value with `***`.
 *
 * The secret set is populated by the config layer at token-resolution time, so
 * anything that ever became an Authorization header is covered here regardless
 * of which code path leaked it.
 */
export function redact(text: string, secrets: Iterable<string> = getSecrets()): string {
  return maskSecrets(text, sortSecrets(secrets));
}

/**
 * Mask values under credential-shaped keys, recursively.
 *
 * Masking is the default rather than an opt-in because a tool result is not a
 * private channel: it lands in the chat transcript, in whatever the host
 * persists, and in any log or conversation export the user later shares.
 * Coolify already redacts for tokens that lack `read:sensitive`, but root
 * tokens get everything — and a root token is exactly what a homelab user
 * generates.
 *
 * `reveal` only lifts the key-based mask. Registered secrets are stripped on
 * every path, so revealing Coolify's secrets can never reveal ours.
 */
export function redactObject<T>(value: T, opts: RedactOptions = {}): T {
  const secrets = sortSecrets(opts.secrets ?? getSecrets());
  const reveal = opts.reveal === true;
  // Masking maps strings to strings and preserves every key, so the shape —
  // and therefore T — survives the walk.
  return walk(value, secrets, reveal, false) as T;
}

/** True when a key name looks like it holds a credential. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function walk(node: unknown, secrets: readonly string[], reveal: boolean, sensitive: boolean): unknown {
  if (typeof node === 'string') {
    // Only non-empty strings are masked: `"password": ""` masked to `***` would
    // assert that a password exists. Numbers and booleans are left alone — they
    // carry no credential, and masking them destroys structure for nothing.
    if (sensitive && !reveal && node.length > 0) return MASK;
    return maskSecrets(node, secrets);
  }
  if (Array.isArray(node)) {
    // Sensitivity is inherited: `"secrets": ["...", "..."]` is a list of secrets.
    return node.map((item) => walk(item, secrets, reveal, sensitive));
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = walk(child, secrets, reveal, SENSITIVE_KEY.test(key));
    }
    return out;
  }
  return node;
}

function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    // split/join rather than a regex: no escaping, and a token containing regex
    // metacharacters cannot silently fail to match.
    out = out.split(secret).join(MASK);
  }
  return out.replace(SANCTUM_TOKEN, MASK);
}

/**
 * Longest first: masking a short secret that happens to be a prefix of a longer
 * one would leave the remainder of the longer one sitting in the clear.
 */
function sortSecrets(secrets: Iterable<string>): string[] {
  return [...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
