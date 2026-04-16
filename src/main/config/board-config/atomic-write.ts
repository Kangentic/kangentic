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
 * alongside the target and rename over the original. Trailing OS-native
 * newline matches most editors' "newline at EOF" settings.
 *
 * Returns the SHA-256 of the written content so callers can update
 * their watcher-echo cache.
 *
 * Throws on I/O errors - callers decide whether to log and continue
 * or propagate.
 */
export function atomicWriteJson(filePath: string, value: unknown): string {
  const content = JSON.stringify(value, null, 2) + os.EOL;
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
  return hashString(content);
}

/**
 * Stable per-machine fingerprint used to stamp `_modifiedBy` on writes
 * so the file watcher can distinguish "we wrote this" from "a teammate
 * wrote this" when the config file changes.
 *
 * Derived from hostname + username so it's stable across restarts on
 * one machine but unique per developer.
 */
export function computeFingerprint(): string {
  return crypto.createHash('sha256')
    .update(os.hostname() + '\0' + os.userInfo().username)
    .digest('hex')
    .slice(0, 12);
}
