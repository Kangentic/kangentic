import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import type { BoardConfig } from '../../../shared/types';

/**
 * SHA-256 of a string (hex). Used for fast watcher-echo suppression -
 * the manager records the hash after every write and skips handler
 * work when the next watcher event produces the same hash.
 */
export function hashString(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * SHA-256 of a file's contents. Returns null if the file doesn't exist
 * or can't be read.
 */
export function hashFilePath(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return hashString(content);
  } catch {
    return null;
  }
}

/**
 * Check whether the on-disk file already matches `newConfig`, ignoring
 * the `_modifiedBy` fingerprint field. Used to short-circuit writes
 * that wouldn't meaningfully change the file.
 *
 * Returns the existing file's hash alongside the match result so the
 * caller can seed its watcher-echo-suppression cache without a second
 * read.
 */
export function contentMatchesFile(
  filePath: string,
  newConfig: Partial<BoardConfig>,
): { matches: boolean; contentHash: string | null } {
  try {
    const existingRaw = fs.readFileSync(filePath, 'utf-8');
    const existingConfig = JSON.parse(existingRaw) as Partial<BoardConfig>;
    const { _modifiedBy: _existingFingerprint, ...existingRest } = existingConfig as BoardConfig;
    const { _modifiedBy: _newFingerprint, ...newRest } = newConfig as BoardConfig;
    const contentHash = hashString(existingRaw);
    return { matches: JSON.stringify(existingRest) === JSON.stringify(newRest), contentHash };
  } catch {
    return { matches: false, contentHash: null };
  }
}

/**
 * Atomic JSON write: serialize `value` to a `<filePath>.tmp.<pid>`
 * alongside the target and rename over the original. The trailing newline
 * is always LF (never the OS-native CRLF on Windows): the written content
 * is hashed for watcher-echo suppression, so a byte-for-byte stable format
 * keeps that hash consistent across platforms and git line-ending
 * normalization.
 *
 * Returns the SHA-256 of the written content so callers can update
 * their watcher-echo cache.
 *
 * Throws on I/O errors - callers decide whether to log and continue
 * or propagate.
 */
export function atomicWriteJson(filePath: string, value: unknown): string {
  const content = JSON.stringify(value, null, 2) + '\n';
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
  return hashString(content);
}

/**
 * Stable per-machine fingerprint stamped into `_modifiedBy` on writes as
 * last-writer provenance (which device last wrote the file). It is NOT
 * consulted by the file watcher: the app's own writes are already suppressed
 * by the isWritingBack window and the content-hash echo check in
 * board-config-manager, so a pulled change always reconciles live (see
 * onFileChanged). The persisted value can equal a teammate's only on a
 * hostname+username collision, which is harmless now that nothing reads it.
 *
 * Derived from hostname + username so it's stable across restarts on
 * one machine but unique per developer.
 */
export function computeFingerprint(): string {
  let username: string;
  try {
    username = os.userInfo().username;
  } catch {
    // os.userInfo() throws when the current uid has no passwd entry (e.g.
    // minimal containers). The fingerprint is last-writer provenance only,
    // so a stable fallback is sufficient and must not block construction.
    username = process.env.USERNAME ?? process.env.USER ?? 'unknown';
  }
  return crypto.createHash('sha256')
    .update(os.hostname() + '\0' + username)
    .digest('hex')
    .slice(0, 12);
}
