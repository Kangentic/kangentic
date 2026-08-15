import * as path from 'node:path';
import * as os from 'node:os';
import { createSerialLock } from '../../shared/relocation-utils';

/**
 * Shared low-level access to `~/.codex/config.toml`.
 *
 * Two features read and write the same `[projects.'<path>']` tables: the
 * trust manager (pre-approving a spawn directory) and the relocation
 * migration (rewriting those paths after a project moves). Both need
 * identical header parsing and path normalization, and Codex stores those
 * paths in several interchangeable forms:
 *
 *   [projects.'C:\Users\dev\proj']        single-quoted TOML literal
 *   [projects."C:/Users/dev/proj"]        basic string, forward slashes
 *   [projects.'\\?\C:\Users\dev\proj']    Windows long-path prefixed
 *
 * Getting that comparison wrong means a duplicate table (which makes
 * config.toml unparsable for Codex itself) or a missed match (which
 * re-prompts the user). Keeping one implementation is what stops the two
 * consumers from drifting apart on it.
 *
 * There is deliberately no TOML parser here: the file belongs to the user,
 * and a line-oriented approach preserves their comments, ordering, and
 * formatting instead of reserializing the whole document.
 */

/** Serializes every read-modify-write of config.toml across both consumers. */
export const withCodexConfigLock = createSerialLock();

/** `[projects.` + ( '...' | "..." ) + `]` with optional trailing whitespace / CR. */
const PROJECT_HEADER = /^(\s*\[projects\.)('([^']*)'|"((?:[^"\\]|\\.)*)")(\]\s*\r?)$/;

/** The Windows long-path prefix \\?\ as a literal string (four characters). */
const LONG_PATH_PREFIX = '\\\\?\\';

/**
 * Codex's config directory: `$CODEX_HOME` when set, else `~/.codex`.
 *
 * Honoring the env var is not optional. It is the documented way to relocate
 * Codex's whole config dir, and Kangentic MUST write trust to the same file
 * Codex will read: writing to `~/.codex/config.toml` while Codex reads
 * `$CODEX_HOME/config.toml` leaves the user prompted on every task with no
 * indication why. It is also what lets a test run against a throwaway config
 * instead of appending to the developer's real one.
 *
 * Read per call rather than cached, so a test (or a user) that changes the
 * variable is not shadowed by a value captured at import time.
 */
function codexHomeDir(): string {
  const override = process.env.CODEX_HOME;
  return override && override.trim().length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), '.codex');
}

export function configTomlPath(): string {
  return path.join(codexHomeDir(), 'config.toml');
}

export interface ParsedHeader {
  prefix: string;
  suffix: string;
  quote: "'" | '"';
  innerPath: string;
  hadLongPathPrefix: boolean;
}

export function parseHeaderLine(line: string): ParsedHeader | null {
  const match = PROJECT_HEADER.exec(line);
  if (!match) return null;
  const isSingle = match[3] !== undefined;
  // Single-quoted TOML strings are literal; basic (double-quoted) strings
  // unescape \\ and \" (paths never carry other escapes).
  const innerPath = isSingle ? match[3] : match[4].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return {
    prefix: match[1],
    suffix: match[5],
    quote: isSingle ? "'" : '"',
    innerPath,
    hadLongPathPrefix: innerPath.startsWith(LONG_PATH_PREFIX),
  };
}

export function stripLongPathPrefix(rawPath: string): string {
  return rawPath.startsWith(LONG_PATH_PREFIX) ? rawPath.slice(LONG_PATH_PREFIX.length) : rawPath;
}

export function applyLongPathPrefix(nativePath: string, hadPrefix: boolean): string {
  return hadPrefix ? LONG_PATH_PREFIX + nativePath : nativePath;
}

export function normalizeForCompare(raw: string): string {
  const stripped = stripLongPathPrefix(raw);
  const normalized = path.normalize(stripped).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Read the `trust_level` Codex has recorded for `targetPath`, comparing
 * paths by their normalized form so any of the stored spellings match.
 *
 * Returns the raw string ("trusted" / "untrusted" / anything else a future
 * Codex adds) or null when the project has no table or no trust_level line.
 * Scanning stops at the next table header, so a `trust_level` belonging to
 * a different project is never misattributed.
 */
export function readTrustLevel(configLines: string[], targetPath: string): string | null {
  const target = normalizeForCompare(targetPath);
  let insideTarget = false;

  for (const line of configLines) {
    const header = parseHeaderLine(line);
    if (header) {
      insideTarget = normalizeForCompare(header.innerPath) === target;
      continue;
    }
    // Any other table header ends the section we care about.
    if (!insideTarget) {
      continue;
    }
    if (/^\s*\[/.test(line)) {
      insideTarget = false;
      continue;
    }
    const trust = /^\s*trust_level\s*=\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(line);
    if (trust) return trust[1] ?? trust[2];
  }

  return null;
}
