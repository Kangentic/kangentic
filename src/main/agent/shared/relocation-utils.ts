import * as fs from 'node:fs';
import * as path from 'node:path';
import { toForwardSlash, replacePathPrefix } from '../../../shared/paths';

/**
 * Shared helpers for agent `onProjectRelocated` implementations.
 *
 * Several agents key per-project data (session transcripts, trust entries,
 * config tables) to the absolute project path, stored OUTSIDE the project
 * folder. When a Kangentic project is moved or renamed, that data is orphaned
 * and sessions stop resuming. Each adapter migrates its own stores in an
 * `adapters/<agent>/project-relocation.ts` module; these helpers cover the
 * mechanics every one of them shares, generalized from the Claude reference
 * implementation (`adapters/claude/project-relocation.ts`).
 *
 * Everything here is best-effort and non-destructive: directories are renamed
 * or merged (never deleted), shared files are backed up and written atomically,
 * and callers wrap each step in try/catch so a partial failure degrades to
 * today's behavior (orphaned data) rather than data loss or a failed relocation.
 */

export interface RelocationPathPair {
  oldAbsolute: string;
  newAbsolute: string;
}

/**
 * Collect every (oldAbsolute, newAbsolute) pair whose per-project data must
 * move when a project relocates: the project root, every worktree found on
 * disk under the relocated folder, and any adapter-specific old-path candidates
 * (e.g. config-file keys) that resolve under the old project path. Each
 * candidate is mapped through `replacePathPrefix`, so unrelated siblings that
 * merely share a string prefix are dropped. Deduplicated by the forward-slash
 * form of the resolved old path.
 *
 * Worktrees move with the project folder, so listing the NEW location
 * reconstructs the OLD paths via the same relative subpath. The
 * `additionalOldPathCandidates` cover worktrees deleted from disk whose config
 * keys persist.
 */
export function collectRelocationPairs(
  oldProjectPath: string,
  newProjectPath: string,
  additionalOldPathCandidates: string[] = [],
): RelocationPathPair[] {
  const oldResolved = path.resolve(oldProjectPath);
  const newResolved = path.resolve(newProjectPath);

  const pairs = new Map<string, RelocationPathPair>();
  const addPair = (oldAbsolute: string, newAbsolute: string): void => {
    const resolvedOld = path.resolve(oldAbsolute);
    // Dedup by the forward-slash form of the resolved old path, case-normalized
    // on Windows where paths are case-insensitive (a config key and the root
    // pair can differ only in case yet point at the same directory). Keep the
    // first occurrence so the canonical root/worktree pair wins over a config
    // candidate that resolves to the same directory.
    let dedupeKey = toForwardSlash(resolvedOld);
    if (process.platform === 'win32') dedupeKey = dedupeKey.toLowerCase();
    if (pairs.has(dedupeKey)) return;
    pairs.set(dedupeKey, {
      oldAbsolute: resolvedOld,
      newAbsolute: path.resolve(newAbsolute),
    });
  };

  // 1. Project root.
  addPair(oldResolved, newResolved);

  // 2. Worktrees present on disk under the relocated folder.
  try {
    const worktreesRoot = path.join(newResolved, '.kangentic', 'worktrees');
    for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addPair(
        path.join(oldResolved, '.kangentic', 'worktrees', entry.name),
        path.join(newResolved, '.kangentic', 'worktrees', entry.name),
      );
    }
  } catch {
    // No worktrees directory (or unreadable): nothing to add from disk.
  }

  // 3. Adapter-specific candidates (config keys, work-dir lists) under the old
  //    path. Exact prefix matching via replacePathPrefix, never string-prefix.
  for (const candidate of additionalOldPathCandidates) {
    const rewritten = replacePathPrefix(candidate, oldResolved, newResolved);
    if (rewritten) addPair(candidate, rewritten);
  }

  return [...pairs.values()];
}

/**
 * Rename a directory from `sourceDir` to `targetDir`, merging when the target
 * already exists. No-op when the source is missing or already equals the target.
 *
 * When the target is absent this is a plain `renameSync` (the existsSync guard
 * is load-bearing on Windows, where renaming onto an existing directory fails
 * with EPERM/ENOTEMPTY). When the target exists, entries are moved in one by
 * one; a name that already exists in the target is left in the source rather
 * than overwritten, and the source directory is removed only if it ends up
 * empty. May throw on unexpected fs errors, so callers wrap per-item.
 */
export function renameOrMergeDirectory(sourceDir: string, targetDir: string): void {
  if (sourceDir === targetDir) return;
  if (!fs.existsSync(sourceDir)) return;

  if (!fs.existsSync(targetDir)) {
    fs.renameSync(sourceDir, targetDir);
    return;
  }

  for (const entry of fs.readdirSync(sourceDir)) {
    const targetEntry = path.join(targetDir, entry);
    if (fs.existsSync(targetEntry)) continue; // Keep the existing target entry.
    fs.renameSync(path.join(sourceDir, entry), targetEntry);
  }
  // Remove the source only if everything moved out (rmdir fails if non-empty).
  try {
    fs.rmdirSync(sourceDir);
  } catch {
    // Source not empty (a colliding entry stayed behind, or a nested
    // subdirectory): leave the source directory in place.
  }
}

/**
 * Write `newContent` to `filePath`, backing the existing file up to
 * `<filePath>.kangentic-backup` first (unless `backup` is false) and writing
 * atomically via a temp file + rename. Returns true on success, false when the
 * backup or write failed (in which case the original file is left untouched).
 *
 * Content is taken verbatim, so the caller owns serialization (JSON, TOML, YAML)
 * and trailing-newline conventions.
 */
export function atomicWriteFileWithBackup(
  filePath: string,
  newContent: string,
  options: { backup?: boolean; logTag?: string } = {},
): boolean {
  const logTag = options.logTag ?? '[RELOCATE]';

  if (options.backup !== false) {
    try {
      fs.copyFileSync(filePath, `${filePath}.kangentic-backup`);
    } catch (err) {
      console.warn(`${logTag} Failed to back up ${filePath}; aborting write:`, err);
      return false; // Without a backup, do not risk the in-place rewrite.
    }
  }

  const tempPath = `${filePath}.kangentic-tmp`;
  try {
    fs.writeFileSync(tempPath, newContent, 'utf-8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    console.warn(`${logTag} Failed to write ${filePath}:`, err);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp cleanup.
    }
    return false;
  }
}

/**
 * Create a module-level serial lock: a promise-chain that runs each queued
 * operation only after the previous one settles, serializing concurrent
 * read-modify-write access to a shared file. Mirrors the `withClaudeJsonLock` /
 * `qwenTrustLock` pattern. Operations may be sync or async; `then` flattens both.
 */
export function createSerialLock(): <T>(operation: () => T | Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => T | Promise<T>): Promise<T> => {
    // report-ok: the chain holds only settled copies, so the operation runs after the last one
    // however that ended. A failed operation rejects `result`, which its own caller gets.
    const result = chain.then(operation, () => operation());
    chain = result.catch(() => {});
    return result;
  };
}
