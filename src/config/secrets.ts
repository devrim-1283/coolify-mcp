/**
 * Token resolution and the process-wide redaction set.
 *
 * Two rules govern everything here:
 *
 * 1. No shell, ever. `tokenCommand` is an argv array handed to execFile
 *    directly — no `sh -c`, no string splitting, no interpolation. A registry
 *    file that can spawn a shell is a registry file that can run arbitrary
 *    commands from one mistyped character.
 * 2. No native modules, ever. keytar-class dependencies break `npx
 *    coolify-mcp`, which is the primary install path, so `tokenKeychain`
 *    dispatches over the platform's own CLI instead.
 *
 * Resolved tokens are cached for the process lifetime (an `op read` per tool
 * call is unusable) and never written to disk.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CoolifyError } from '../types.js';
import { DEFAULT_CONNECTION_NAME, readEnvValue, tokenEnvVar } from './schema.js';

const execFileAsync = promisify(execFile);

/**
 * Generous because secret managers prompt: `op read` can wait on Touch ID and
 * macOS `security` can raise a keychain unlock dialog. A tight timeout here
 * shows up as an unexplained auth failure the first time a user is away from
 * the keyboard.
 */
const TOKEN_COMMAND_TIMEOUT_MS = 60_000;

/** A token is ~50 bytes. This bounds a misconfigured command that dumps a file. */
const MAX_TOKEN_OUTPUT_BYTES = 64 * 1024;

/** Keep failure diagnostics useful without pasting a whole error page into the log. */
const MAX_STDERR_CHARS = 200;

/** Anything shorter is too generic to blanket-replace in output without eating unrelated text. */
const MIN_SECRET_LENGTH = 8;

/**
 * A bearer token is copied verbatim into an Authorization header, so it must be
 * printable ASCII with no spaces: that rules out a stray newline splitting the
 * header, and catches the common "my secret manager returned JSON" mistake.
 */
const INVALID_TOKEN_CHARS = /[^!-~]/;

// ---------------------------------------------------------------------------
// Redaction set
// ---------------------------------------------------------------------------

const secrets = new Set<string>();

/**
 * Registers a value the shaping/redact module must scrub from every log line,
 * error message and tool result. Called at resolution time so a token is
 * redactable before it can reach any output path.
 */
export function registerSecret(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  secrets.add(trimmed);

  // Sanctum tokens are "<id>|<secret>". The secret half alone is still a live
  // credential and can appear on its own (a truncated log line, a split header),
  // so it is registered independently rather than only as part of the whole.
  const separator = trimmed.indexOf('|');
  if (separator > 0) {
    const tail = trimmed.slice(separator + 1);
    if (tail.length >= MIN_SECRET_LENGTH) secrets.add(tail);
  }
}

/**
 * Every registered secret, longest first. The order is load-bearing for the
 * consumer: replacing "<secret>" before "<id>|<secret>" would leave the id
 * fragment behind next to a `***`, which is still a usable hint for an attacker.
 */
export function getSecrets(): string[] {
  return [...secrets].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

export interface TokenKeychainRef {
  service: string;
  account: string;
}

/** The token-source half of a connection — everything needed to answer "where is the token". */
export interface TokenSpec {
  name: string;
  tokenEnv?: string;
  tokenCommand?: readonly string[];
  tokenKeychain?: TokenKeychainRef;
}

export interface TokenResolverOptions {
  /** Injected for tests; the keychain path is the only platform-dependent branch. */
  platform?: NodeJS.Platform;
}

/**
 * Builds the memoised `Connection.resolveToken`. The cache holds the promise,
 * not the value, so a fan-out across connections does not spawn one `op read`
 * per concurrent call. A failed resolution is evicted: the usual cause is a
 * locked vault, and the user's fix is to unlock it and retry — which must not
 * require restarting the MCP server.
 */
export function createTokenResolver(
  spec: TokenSpec,
  env: NodeJS.ProcessEnv,
  options: TokenResolverOptions = {},
): () => Promise<string> {
  const platform = options.platform ?? process.platform;
  let cached: Promise<string> | undefined;

  return () => {
    if (cached === undefined) {
      cached = resolveToken(spec, env, platform).catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };
}

async function resolveToken(
  spec: TokenSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  const { value, source } = await readToken(spec, env, platform);
  const token = value.trim();

  if (token === '') {
    throw authError(`${source} returned an empty value for connection "${spec.name}".`);
  }
  if (INVALID_TOKEN_CHARS.test(token)) {
    // Deliberately does not echo the value: it may be a real credential in a
    // shape we did not expect.
    throw authError(
      `${source} did not return a bearer token for connection "${spec.name}" ` +
        '(the value contains whitespace or non-printable characters).',
      'If the source returns JSON or a whole record, select the single field that holds the token, ' +
        'e.g. `op read op://Infra/coolify/credential`.',
    );
  }

  registerSecret(token);
  return token;
}

async function readToken(
  spec: TokenSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ value: string; source: string }> {
  if (spec.tokenEnv !== undefined) {
    const value = readEnvValue(env, spec.tokenEnv);
    if (value === undefined) {
      throw authError(
        `connection "${spec.name}" declares tokenEnv "${spec.tokenEnv}", but $${spec.tokenEnv} is unset or empty.`,
        `Export $${spec.tokenEnv} in the environment the MCP server starts from — every supported client config has an "env" block for exactly this.`,
      );
    }
    return { value, source: `$${spec.tokenEnv}` };
  }

  if (spec.tokenCommand !== undefined) {
    return {
      value: await runTokenCommand(spec.name, spec.tokenCommand, env),
      source: `tokenCommand (${spec.tokenCommand[0] ?? ''})`,
    };
  }

  if (spec.tokenKeychain !== undefined) {
    return {
      value: await readKeychain(spec.name, spec.tokenKeychain, env, platform),
      source: 'tokenKeychain',
    };
  }

  // Convention: a connection that declares no source reads its own env var.
  // This is what makes `{"baseUrl": "..."}` a complete connection entry.
  const conventional = tokenEnvVar(spec.name);
  const byConvention = readEnvValue(env, conventional);
  if (byConvention !== undefined) return { value: byConvention, source: `$${conventional}` };

  // The unnamed single-connection case only. Any other connection falling back
  // to $COOLIFY_API_TOKEN would silently point two instances at one credential.
  if (spec.name === DEFAULT_CONNECTION_NAME) {
    const global = readEnvValue(env, 'COOLIFY_API_TOKEN');
    if (global !== undefined) return { value: global, source: '$COOLIFY_API_TOKEN' };
  }

  throw authError(
    `no API token for connection "${spec.name}".`,
    `Set $${conventional}` +
      (spec.name === DEFAULT_CONNECTION_NAME ? ' (or $COOLIFY_API_TOKEN)' : '') +
      `, or give "${spec.name}" a tokenEnv, tokenCommand or tokenKeychain in your registry file. ` +
      'Coolify tokens live under Keys & Tokens > API tokens and are bound to the team that was active when they were created.',
  );
}

// ---------------------------------------------------------------------------
// tokenCommand
// ---------------------------------------------------------------------------

async function runTokenCommand(
  name: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const [file, ...args] = argv;
  if (file === undefined) {
    throw authError(`connection "${name}" has an empty tokenCommand.`);
  }

  try {
    const { stdout } = await execFileAsync(file, args, {
      // No `shell` option: execFile without it never invokes a shell, which is
      // the entire security property of this feature.
      env: childEnv(env),
      timeout: TOKEN_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_TOKEN_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error: unknown) {
    throw authError(
      `tokenCommand failed for connection "${name}": ${commandFailure(file, error)}`,
      `Run \`${file}\` yourself in the same environment and confirm it prints the token and nothing else.`,
    );
  }
}

/**
 * The child gets the ambient environment (it needs PATH, HOME, SSH_AUTH_SOCK,
 * OP_SERVICE_ACCOUNT_TOKEN...) minus our own Coolify tokens. A helper that
 * fetches a credential has no business receiving the credentials we already
 * hold, and this is a user-configured process we do not otherwise constrain.
 */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('COOLIFY_API_TOKEN')) continue;
    copy[key] = value;
  }
  return copy;
}

interface ExecFailure {
  code?: unknown;
  killed?: boolean;
  stderr?: unknown;
  message?: unknown;
}

function commandFailure(file: string, error: unknown): string {
  const failure = (error ?? {}) as ExecFailure;

  if (failure.code === 'ENOENT') {
    return (
      `command not found: ${file}. Use an absolute path, or make sure it is on PATH for the process that ` +
      'starts the MCP server. On Windows it must be a real executable — .cmd and .bat shims cannot be ' +
      'launched without a shell, and coolify-mcp never uses one.'
    );
  }
  if (failure.killed === true) {
    return `timed out after ${TOKEN_COMMAND_TIMEOUT_MS / 1000}s (waiting on an unlock prompt?)`;
  }

  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  if (stderr !== '') {
    const firstLine = stderr.split('\n')[0] ?? '';
    return `exit ${String(failure.code ?? 'unknown')}: ${firstLine.slice(0, MAX_STDERR_CHARS)}`;
  }
  return typeof failure.message === 'string'
    ? failure.message
    : `exit ${String(failure.code ?? 'unknown')}`;
}

// ---------------------------------------------------------------------------
// tokenKeychain
// ---------------------------------------------------------------------------

async function readKeychain(
  name: string,
  ref: TokenKeychainRef,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  switch (platform) {
    case 'darwin':
      return runKeychainTool(name, 'security', [
        'find-generic-password',
        '-s',
        ref.service,
        '-a',
        ref.account,
        '-w',
      ]);
    case 'linux':
      return runKeychainTool(name, 'secret-tool', [
        'lookup',
        'service',
        ref.service,
        'account',
        ref.account,
      ]);
    case 'win32':
      return readWindowsDpapi(name, ref, env);
    default:
      throw authError(
        `tokenKeychain is not supported on ${platform} (connection "${name}").`,
        'Use tokenCommand with whatever secret tool this platform has — it is an argv array, so any command that prints the token works.',
      );
  }
}

async function runKeychainTool(name: string, file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: TOKEN_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_TOKEN_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error: unknown) {
    throw authError(
      `tokenKeychain lookup failed for connection "${name}": ${commandFailure(file, error)}`,
      file === 'secret-tool'
        ? 'Install libsecret-tools (Debian/Ubuntu: `apt install libsecret-tools`), or switch to tokenCommand.'
        : `Check the item exists: \`${file} find-generic-password -s <service> -a <account>\`.`,
    );
  }
}

/**
 * Windows keychain path — honestly, not a keychain.
 *
 * No first-party Windows CLI returns a generic credential's *secret*: `cmdkey`
 * lists entries but never prints the blob, and reading it means CredRead()
 * through P/Invoke, which is a native dependency this project will not take
 * (it kills the `npx coolify-mcp` install story).
 *
 * So this is DPAPI-at-rest instead of Credential Manager: ciphertext produced
 * by ConvertFrom-SecureString under the user's DPAPI key, stored at
 * %LOCALAPPDATA%\coolify-mcp\credentials.dat, decryptable only by the same
 * Windows user on the same machine. That is weaker than Keychain or libsecret
 * — no per-item ACL, no unlock prompt, so any process running as that user can
 * decrypt it — and stronger than a token sitting in a client config file. The
 * docs must say exactly this and must not imply parity.
 *
 * File format (v1). Written by the CLI, only read here:
 *   { "version": 1, "entries": { "<service>": { "<account>": "<hex ciphertext>" } } }
 */
const CREDENTIAL_STORE_DIR = 'coolify-mcp';
const CREDENTIAL_STORE_FILE = 'credentials.dat';
const HEX_ONLY = /^[0-9a-fA-F]+$/;

interface CredentialStore {
  version?: unknown;
  entries?: Record<string, Record<string, unknown> | undefined>;
}

async function readWindowsDpapi(
  name: string,
  ref: TokenKeychainRef,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const localAppData = readEnvValue(env, 'LOCALAPPDATA');
  if (localAppData === undefined) {
    throw authError(
      `cannot resolve tokenKeychain for connection "${name}": %LOCALAPPDATA% is not set.`,
    );
  }
  const storePath = path.join(localAppData, CREDENTIAL_STORE_DIR, CREDENTIAL_STORE_FILE);
  const setupHint =
    `Store it with \`npx coolify-mcp secrets set --service ${ref.service} --account ${ref.account}\`, ` +
    'or switch the connection to tokenCommand.';

  let contents: string;
  try {
    contents = await fs.readFile(storePath, 'utf8');
  } catch {
    throw authError(`no credential store at ${storePath} for connection "${name}".`, setupHint);
  }

  let store: CredentialStore;
  try {
    store = JSON.parse(contents) as CredentialStore;
  } catch {
    throw authError(`credential store ${storePath} is not valid JSON.`, setupHint);
  }

  const ciphertext = store.entries?.[ref.service]?.[ref.account];
  if (typeof ciphertext !== 'string' || !HEX_ONLY.test(ciphertext)) {
    throw authError(
      `credential store ${storePath} has no usable entry for service "${ref.service}" account "${ref.account}".`,
      setupHint,
    );
  }

  // The hex charset check above is what makes embedding the ciphertext in the
  // script text safe: no character is left that could close the quote. The
  // plaintext comes back over stdout and never touches a command line.
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$secure = ConvertTo-SecureString -String '${ciphertext}';`,
    '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);',
    'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }',
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }',
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: TOKEN_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_TOKEN_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
    );
    return stdout;
  } catch (error: unknown) {
    throw authError(
      `DPAPI decryption failed for connection "${name}": ${commandFailure('powershell.exe', error)}`,
      `${storePath} can only be decrypted by the Windows user that wrote it, on the same machine. If the profile changed, store the token again.`,
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * Token resolution failures surface through the same envelope as a rejected
 * request: from the caller's side "no token" and "bad token" are the same
 * problem, and CoolifyError is what the tool layer already renders with a hint.
 */
function authError(message: string, hint?: string): CoolifyError {
  return new CoolifyError(message, 'unauthenticated', hint);
}
