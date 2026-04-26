import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Capture a freshly-spawned Droid session UUID from the filesystem.
 *
 * Empirical layout (Droid 0.109.1, verified via probe-droid.js):
 *   `~/.factory/sessions/<cwd-slug>/<session-uuid>.jsonl`
 *
 * The cwd slug is the absolute spawn cwd with `:` replaced by `-` and
 * every path-separator (`\` on Windows, `/` on POSIX) replaced by `-`.
 * Examples:
 *   POSIX: `/home/dev/project`              -> `-home-dev-project`
 *   Win:   `C:\Users\dev\project`           -> `-C-Users-dev-project`
 *
 * Each `<uuid>.jsonl` is created synchronously when the session starts
 * (the first line is a `session_start` record), so polling for files
 * with mtime >= spawnedAt under the cwd-specific slug is a tight
 * filter -- a stale session in a different cwd never collides because
 * the directory key already disambiguates by cwd.
 *
 * Filename pattern: `<UUID>.jsonl`, where UUID is the standard 8-4-4-4-12
 * hex form. Sidecar files like `<UUID>.settings.json` are skipped by
 * the regex.
 */
const SESSION_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Convert an absolute cwd into Droid's slug form. The slug is what
 * Droid uses as the directory name under `~/.factory/sessions/`.
 *
 * Empirically Droid preserves user-provided casing in the slug (e.g.
 * `C:\Users\tyler` -> `-C-Users-tyler`), so this helper does the same
 * -- no case normalization on Windows. NTFS case-insensitivity means
 * a directory match still resolves correctly even if the spawn cwd's
 * casing varies between launches.
 */
export function cwdToSessionSlug(cwd: string): string {
  // Replace separators and the drive-letter colon, then collapse runs
  // of consecutive dashes. Empirically `C:\Users\tyler` becomes
  // `-C-Users-tyler` (single dash), not `-C--Users-tyler` -- Droid
  // collapses the colon+backslash into a single separator.
  const replaced = cwd.replace(/[:\\/]+/g, '-');
  // Ensure leading dash on POSIX (where the leading `/` already maps,
  // so this is belt-and-braces) and preserve it on Windows where the
  // first character was a drive letter.
  return replaced.startsWith('-') ? replaced : '-' + replaced;
}

/** Absolute path to `~/.factory/sessions/<cwd-slug>/`. */
function sessionsDirForCwd(cwd: string): string {
  return path.join(os.homedir(), '.factory', 'sessions', cwdToSessionSlug(cwd));
}

/**
 * Locate Droid's session JSONL file for a known UUID. Polls for up to
 * ~5 seconds (default 10 attempts at 500ms) because Droid creates the
 * file asynchronously after the spawn returns. Returns the absolute
 * path or null.
 *
 * `maxAttempts` is exposed for unit tests so the negative path can
 * fail fast; production callers should rely on the default.
 */
export async function locateSessionFile(options: {
  agentSessionId: string;
  cwd: string;
  maxAttempts?: number;
}): Promise<string | null> {
  const directory = sessionsDirForCwd(options.cwd);
  const filename = `${options.agentSessionId}.jsonl`;
  const target = path.join(directory, filename);
  const maxAttempts = options.maxAttempts ?? 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (fs.existsSync(target)) return target;
    await sleep(500);
  }
  return null;
}

/**
 * Capture the session UUID for a freshly-spawned Droid session by
 * scanning `~/.factory/sessions/<cwd-slug>/` for `<UUID>.jsonl` files
 * created at or after `spawnedAt`.
 *
 * Polls for up to ~10 seconds (20 attempts at 500ms). Returns the
 * matching UUID, or null if no candidate appears in time.
 */
export async function captureSessionIdFromFilesystem(options: {
  spawnedAt: Date;
  cwd: string;
  maxAttempts?: number;
}): Promise<string | null> {
  const spawnedAtMs = options.spawnedAt.getTime();
  // Allow 30s of clock skew on the floor; the cwd-keyed directory
  // means we will not pick up sessions from other tasks anyway.
  const mtimeFloorMs = spawnedAtMs - 30_000;
  const directory = sessionsDirForCwd(options.cwd);
  const maxAttempts = options.maxAttempts ?? 20;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      // Directory does not exist yet; wait and retry.
      await sleep(500);
      continue;
    }

    // Pick the file with the newest mtime that satisfies the floor.
    // Limitation: two Droid sessions launched concurrently in the
    // *same cwd* within `mtimeFloorMs` of each other would both match
    // the regex and the newer one would win. Kangentic's standard
    // flow uses task-scoped cwds (or per-task worktrees), so this
    // does not collide in practice -- but if a user starts a manual
    // `droid` outside Kangentic in the same cwd just before a task
    // spawn, capture could pick the wrong UUID. Worktrees are the
    // recommended mitigation. Same caveat applies to Codex's parser.
    let bestId: string | null = null;
    let bestMtime = -Infinity;
    for (const name of entries) {
      const match = name.match(SESSION_FILE_PATTERN);
      if (!match) continue;
      try {
        const stat = fs.statSync(path.join(directory, name));
        if (stat.mtimeMs < mtimeFloorMs) continue;
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestId = match[1];
        }
      } catch {
        // File vanished between readdir and stat; skip.
      }
    }
    if (bestId) return bestId;
    await sleep(500);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
