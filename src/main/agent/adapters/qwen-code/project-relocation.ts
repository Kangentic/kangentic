import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { resolveForwardSlash, replacePathPrefix } from '../../../../shared/paths';
import {
  collectRelocationPairs,
  renameOrMergeDirectory,
  atomicWriteFileWithBackup,
  type RelocationPathPair,
} from '../../shared/relocation-utils';
import { qwenProjectSlug } from './session-history-parser';
import { withQwenTrustLock } from './trust-manager';
import { qwenHomeDir } from './qwen-home';

/**
 * Migrate Qwen Code's per-project data when a Kangentic project is relocated.
 *
 * Qwen Code keys three stores to the absolute project path, all OUTSIDE the
 * project folder, so a move or rename orphans them (sessions then fail to
 * resume by id):
 *
 * 1. `~/.qwen/projects/<slug>/` holds chats/, memory/, and meta.json. The slug
 *    lowercases the path on Windows then replaces every non-alphanumeric
 *    character with `-` (see `qwenProjectSlug`, verified against the bundled
 *    cli.js and real on-disk names).
 * 2. `~/.qwen/tmp/<sha256>/` holds shell history and logs, keyed by the sha256
 *    of the lowercased-on-win32 path (upstream `getProjectHash`).
 * 3. `~/.qwen/trustedFolders.json` maps absolute forward-slashed paths to a
 *    trust-level string.
 *
 * Worktrees are spawned with their own cwd, so each store holds one entry per
 * cwd. The migration reconstructs old worktree paths from the relocated folder
 * and from trustedFolders.json keys (covers worktrees deleted from disk).
 *
 * Best-effort and non-destructive: directories are renamed or merged (never
 * deleted), trustedFolders.json is backed up and written atomically, and every
 * step is independently guarded. The whole pass runs under the trust lock so
 * the key rewrite cannot race a concurrent `ensureWorktreeTrust`.
 */
export async function migrateQwenProjectData(oldProjectPath: string, newProjectPath: string): Promise<void> {
  return withQwenTrustLock(() => migrateQwenProjectDataSync(oldProjectPath, newProjectPath));
}

function migrateQwenProjectDataSync(oldProjectPath: string, newProjectPath: string): void {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const pairs = collectRelocationPairs(oldResolved, newResolved, readTrustedFolderKeys());
  migrateProjectDirectories(pairs);
  rewriteTrustedFolders(oldResolved, newResolved);
}

const qwenDir = (): string => qwenHomeDir();
const trustedFoldersPath = (): string => path.join(qwenDir(), 'trustedFolders.json');

/**
 * Compute Qwen's `~/.qwen/tmp/<hash>/` directory name: the sha256 hex of the
 * resolved path, lowercased on Windows (upstream `getProjectHash`).
 */
function qwenTmpHash(resolvedPath: string): string {
  const normalized = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function readTrustedFolderKeys(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>);
    }
  } catch {
    // Missing or unparsable: nothing to migrate from the trust file.
  }
  return [];
}

function migrateProjectDirectories(pairs: RelocationPathPair[]): void {
  const projectsRoot = path.join(qwenDir(), 'projects');
  const tmpRoot = path.join(qwenDir(), 'tmp');

  for (const pair of pairs) {
    try {
      renameOrMergeDirectory(
        path.join(projectsRoot, qwenProjectSlug(pair.oldAbsolute)),
        path.join(projectsRoot, qwenProjectSlug(pair.newAbsolute)),
      );
    } catch (err) {
      console.warn(`[QWEN_RELOCATE] Failed to migrate project dir for ${pair.oldAbsolute}:`, err);
    }
    try {
      renameOrMergeDirectory(
        path.join(tmpRoot, qwenTmpHash(pair.oldAbsolute)),
        path.join(tmpRoot, qwenTmpHash(pair.newAbsolute)),
      );
    } catch (err) {
      console.warn(`[QWEN_RELOCATE] Failed to migrate tmp dir for ${pair.oldAbsolute}:`, err);
    }
  }
}

/**
 * Rewrite `~/.qwen/trustedFolders.json` keys under the old project path to the
 * new path, re-emitting keys in the resolved forward-slash form Qwen writes.
 * No-touch when the file is missing, unparsable, or has no matching key.
 */
function rewriteTrustedFolders(oldResolved: string, newResolved: string): void {
  let entries: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    entries = parsed as Record<string, unknown>;
  } catch {
    return; // Missing or unparsable: leave it untouched.
  }

  const rewrites = new Map<string, string>();
  for (const key of Object.keys(entries)) {
    const rewritten = replacePathPrefix(key, oldResolved, newResolved);
    if (rewritten) rewrites.set(key, resolveForwardSlash(rewritten));
  }
  if (rewrites.size === 0) return;

  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    const target = rewrites.get(key);
    if (!target) {
      if (!(key in rebuilt)) rebuilt[key] = value;
      continue;
    }
    if (target in entries || target in rebuilt) continue; // Destination already present; keep it.
    rebuilt[target] = value;
  }

  atomicWriteFileWithBackup(trustedFoldersPath(), JSON.stringify(rebuilt, null, 2), { logTag: '[QWEN_RELOCATE]' });
}
