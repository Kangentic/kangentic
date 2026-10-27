import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoredCliTarget } from '../../../../shared/types';
import { cliPathForTarget, hostPathForTarget, placeFromStored } from '../../shared/cli-target';

/**
 * Claude Code writes each backgrounded Bash's combined output to a temp file
 * at:
 *
 *   <os.tmpdir()>/claude/<munged-cwd>/<live-session-id>/tasks/<shellId>.output
 *
 * The bg-shell watcher stats this file each poll cycle; growth (size or mtime
 * advancing) is positive liveness evidence for a NAMED shell that never got an
 * OS PID, keeping a genuinely-running shell from being reclaimed at the 5-min
 * named-shell cap (Incident B). All path-layout knowledge lives here so the
 * generic watcher stays agent-agnostic (agent-adapters-boundary).
 *
 * Verified empirically against captured sessions on 2026-06-11.
 */

/** Shell ids are short word-char/dash slugs; bound the length defensively. */
const SHELL_ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * Compute Claude's tasks-directory cwd munge: replace each of `\ / : .` with
 * `-`, leaving every other character (including `_` and `-`) intact.
 *
 * This is DELIBERATELY NOT `claudeProjectSlug` (transcript-parser.ts), which
 * replaces ALL non-alphanumerics. The `~/.claude/projects/` slug and the
 * temp `tasks/` dir use different munges; using the projects slug here would
 * mangle a cwd containing underscores. Verified against the real directory
 * name on 2026-06-11.
 */
export function claudeTasksCwdSlug(cwd: string): string {
  return cwd.replace(/[\\/:.]/g, '-');
}

/**
 * Resolve the output file for a named background shell, or null when it cannot
 * be located. The live Claude session id segment can differ from Kangentic's
 * stored `claudeSessionId` (resume forks the id), so the session-id directory
 * is globbed rather than assumed: every session dir under the munged-cwd
 * directory is probed for `tasks/<shellId>.output`, and the newest-mtime match
 * wins (shell ids are unique random slugs, so multiple hits are theoretical).
 *
 * `baseTmpDir` is injectable for tests; production passes none and uses
 * `os.tmpdir()`, or for a Claude installed in a WSL distro (`cliTarget`) the
 * distro's `/tmp` through its share, keyed by the path the distro ran in. All
 * filesystem access is wrapped so any error yields null.
 */
export function resolveBackgroundTaskOutputFile(
  options: { cwd: string; shellId: string; cliTarget?: StoredCliTarget | null },
  baseTmpDir?: string,
): string | null {
  const { cwd, shellId } = options;
  if (!SHELL_ID_PATTERN.test(shellId)) return null;

  const place = placeFromStored(options.cliTarget);
  const temporaryRoot = baseTmpDir ?? (place ? hostPathForTarget('/tmp', place) : os.tmpdir());
  const projectDir = path.join(temporaryRoot, 'claude', claudeTasksCwdSlug(place ? cliPathForTarget(cwd, place) : cwd));
  let sessionDirs: string[];
  try {
    sessionDirs = fs.readdirSync(projectDir);
  } catch {
    return null;
  }

  let bestPath: string | null = null;
  let bestMtimeMs = -Infinity;
  for (const sessionDir of sessionDirs) {
    const candidate = path.join(projectDir, sessionDir, 'tasks', `${shellId}.output`);
    try {
      const stats = fs.statSync(candidate);
      if (stats.isFile() && stats.mtimeMs > bestMtimeMs) {
        bestMtimeMs = stats.mtimeMs;
        bestPath = candidate;
      }
    } catch {
      // No file for this shell under this session dir; try the next.
    }
  }
  return bestPath;
}
