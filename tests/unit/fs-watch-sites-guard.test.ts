/**
 * Guard: every raw `fs.watch` site in the main process is accounted for.
 *
 * Background. On Windows, an `fs.watch` pointed at a DIRECTORY keeps emitting
 * `rename` forever once that directory is deleted - measured 145k to 155k
 * events/sec, roughly 85% kernel time, for a plain, a `recursive: true` and a
 * `recursive: false` watch alike. No `error` event fires, recreating the path
 * does not stop it, and only `close()` does. One such handle pins a CPU core
 * for the life of the app. (A watch on a FILE does not flood; it raises EPERM.)
 *
 * A new raw `fs.watch` is therefore a load-bearing decision, not a detail. It
 * needs ONE of:
 *   1. Route through `pty/readers/file-watcher.ts`, which carries the storm
 *      guard, the polling fallback and the re-arm; or
 *   2. Own a release path that closes the handle BEFORE anything deletes the
 *      watched directory - the way `DiffWatcher.releaseUnder` is now driven by
 *      the worktree-removing listener in `git/worktree-manager.ts`.
 *
 * This test does not judge which. It fails when the set of sites changes, so
 * the decision is made deliberately instead of by omission - the same shape as
 * esbuild-cjs-imports.test.ts and central-embedding-engine-boundary.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main');

/**
 * Known raw `fs.watch` call sites, as repo-relative POSIX paths, with the
 * number of calls in each file and why they are allowed to be raw.
 */
const ALLOWED_FS_WATCH_SITES: Record<string, { calls: number; reason: string }> = {
  'pty/readers/file-watcher.ts': {
    calls: 2,
    reason:
      'The wrapper itself: a file watch, plus the parent-directory fallback. '
      + 'Owns the storm guard, the polling fallback and the file-only re-arm.',
  },
  'git/diff-watcher.ts': {
    calls: 3,
    reason:
      'Working tree (recursive) plus the git dir and its logs/ dir. All three '
      + 'sit on paths a worktree removal destroys, so they are released ahead of '
      + 'the delete via releaseUnder, driven by setWorktreeRemovingListener.',
  },
  'mobile-bridge/dev-quick-pair.ts': {
    calls: 1,
    reason:
      'Dev-only (constructed inside __KANGENTIC_DEV__, so it is absent from a '
      + 'packaged build). Watches the repo-local mobile-dev-pairing directory, '
      + 'which the module creates itself and no cleanup path deletes.',
  },
};

function listTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      found.push(entryPath);
    }
  }
  return found;
}

/** Count `fs.watch(` calls, ignoring `fs.watchFile(` and comment lines. */
function countFsWatchCalls(source: string): number {
  let count = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    // `fs.watchFile(` cannot match: the pattern requires `(` right after
    // `watch`, so there is nothing to exclude here.
    count += (line.match(/\bfs\.watch\s*\(/g) ?? []).length;
  }
  return count;
}

describe('raw fs.watch sites in src/main', () => {
  it('matches the reviewed allowlist', () => {
    const actual: Record<string, number> = {};

    for (const filePath of listTypeScriptFiles(MAIN_DIR)) {
      const calls = countFsWatchCalls(fs.readFileSync(filePath, 'utf-8'));
      if (calls === 0) continue;
      const relativePath = path.relative(MAIN_DIR, filePath).split(path.sep).join('/');
      actual[relativePath] = calls;
    }

    const expected = Object.fromEntries(
      Object.entries(ALLOWED_FS_WATCH_SITES).map(([site, entry]) => [site, entry.calls]),
    );

    expect(
      actual,
      'A raw fs.watch site in src/main changed.\n\n'
      + 'On Windows a directory fs.watch spins a CPU core forever once its target\n'
      + 'is deleted, silently and until close(). Either route the watch through\n'
      + 'pty/readers/file-watcher.ts (which carries the storm guard, the polling\n'
      + 'fallback and the re-arm), or give it a release path that closes the handle\n'
      + 'before the directory is deleted - see DiffWatcher.releaseUnder and\n'
      + 'setWorktreeRemovingListener in git/worktree-manager.ts.\n\n'
      + 'Then update ALLOWED_FS_WATCH_SITES in this file with the reason.',
    ).toEqual(expected);
  });

  it('has no fs.watchFile usage, which has no such guard', () => {
    const offenders: string[] = [];
    for (const filePath of listTypeScriptFiles(MAIN_DIR)) {
      if (/\bfs\.watchFile\s*\(/.test(fs.readFileSync(filePath, 'utf-8'))) {
        offenders.push(path.relative(MAIN_DIR, filePath).split(path.sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
