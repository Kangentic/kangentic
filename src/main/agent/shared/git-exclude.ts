import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childProcessEnv } from '../../shared/child-env';

/**
 * Hide Kangentic-written agent runtime files from git.
 *
 * Several agent CLIs have no per-spawn settings flag, so their event hooks
 * and MCP wiring (sometimes carrying the per-launch `X-Kangentic-Token`)
 * must live in the WORKSPACE (`.agents/`, `.gemini/`, `.qwen/`, `.factory/`,
 * `.grok/`, ...). During a live session those files show up as untracked in
 * `git status` - polluting the Changes pane and, far worse, riding along
 * with any `git add -A` an agent runs, which would land the token in git
 * history.
 *
 * `.git/info/exclude` is the local, never-committed ignore file, and for a
 * worktree it resolves to the repository's COMMON git dir, so one seeding
 * covers every worktree of the repo. Ignore rules only affect UNTRACKED
 * files, which gives exactly the wanted semantics: files Kangentic created
 * vanish from status and `add -A`, while a user's own TRACKED files keep
 * their normal git visibility. The created-by-us carve-out for shared-name
 * files (a settings file the user may own and commit) is caller-side
 * policy: an adapter excludes such a file only when Kangentic is about to
 * create it, checked with `fs.existsSync` BEFORE its write.
 *
 * `settingsBaseDirectory` is the worktree side of that carve-out: it asks git
 * whether a settings file is the branch's own or one Kangentic wrote.
 */

const EXCLUDE_MARKER = '# kangentic: agent runtime files (local ignore, safe to remove)';

// Any prior Kangentic marker line (including the legacy adapter-branded
// "# kangentic: antigravity adapter runtime files ..." one) counts as
// "marker already present", so re-seeding never stacks a second marker.
const EXCLUDE_MARKER_PREFIX = '# kangentic:';

/**
 * Resolve the directory whose `info/exclude` this checkout reads, following
 * the worktree indirection: a worktree's `.git` is a FILE with a
 * `gitdir: <path>` line, and that gitdir's `commondir` file points at the
 * repository's shared `.git`. Returns null when `directory` is not a git
 * checkout (spawns outside a repo simply skip the exclude seeding).
 */
export function resolveGitCommonDir(directory: string): string | null {
  const dotGit = path.join(directory, '.git');
  let gitDir: string;
  try {
    const stats = fs.statSync(dotGit);
    if (stats.isDirectory()) {
      gitDir = dotGit;
    } else {
      const match = fs.readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)\s*$/m);
      if (!match) return null;
      gitDir = path.resolve(directory, match[1].trim());
    }
  } catch {
    return null;
  }

  try {
    const commonDirPointer = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirPointer)) {
      const pointer = fs.readFileSync(commonDirPointer, 'utf-8').trim();
      return path.resolve(gitDir, pointer);
    }
  } catch {
    // Unreadable pointer - fall through to the gitdir itself.
  }
  return gitDir;
}

/** How long a spawn waits on git, on main, before it gives up on the tracked check. */
const TRACKED_CHECK_TIMEOUT_MS = 1000;

/** The exit status of `git ls-files --error-unmatch` for a path the index does not hold. */
const UNTRACKED_EXIT_STATUS = 1;

/** Git's exit status for a fatal error: no repository, or a repository it refused. */
const GIT_FATAL_EXIT_STATUS = 128;

/**
 * The folder whose `<settingsFolder>/settings.json` a session's merged settings
 * start from, for an agent with no per-spawn settings flag, which writes the
 * merge over the file in `cwd`.
 *
 * In a worktree the merge writes the worktree's copy, so a copy git tracks is
 * the branch's own and starts the merge. Starting from the project root instead
 * replaces it with the root's, and `removeHooks` strips only Kangentic's
 * entries, so the root's content stays in the branch's working tree where
 * `git add -A` can commit it. A copy git does not track is what an earlier
 * spawn wrote, so the merge starts from the root, which keeps a root edit
 * reaching the worktree. Existence cannot separate the two: after a first spawn
 * the file is always there.
 *
 * Synchronous because a command build is, so it blocks main for the length of
 * one `git ls-files`, bounded by the timeout. A worktree with the file present
 * pays, whether its checkout brought the file or an earlier spawn wrote it. A
 * main-repo spawn never does.
 *
 * The root is chosen only when nothing tracks the file: exit 1, git's own
 * answer, or exit 128 from a folder that is no git checkout. Everything else
 * keeps the worktree's copy, because the root there is the overwrite this exists
 * to stop. Exit 128 from a checkout is git refusing it (dubious ownership, a
 * corrupt index), not an answer about the file, and a timeout or a git that will
 * not start has no exit status at all. Keeping the copy costs only a root edit
 * that reaches the worktree later.
 */
export function settingsBaseDirectory(cwd: string, projectRoot: string, settingsFolder: string): string {
  if (cwd === projectRoot || !fs.existsSync(path.join(cwd, settingsFolder, 'settings.json'))) return projectRoot;
  try {
    // A git pathspec is forward-slashed on every platform.
    execFileSync('git', ['ls-files', '--error-unmatch', '--', `${settingsFolder}/settings.json`], {
      cwd,
      env: childProcessEnv(),
      stdio: 'ignore',
      timeout: TRACKED_CHECK_TIMEOUT_MS,
      windowsHide: true,
    });
    return cwd;
  } catch (error) {
    const exitStatus = typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
    const notACheckout = exitStatus === GIT_FATAL_EXIT_STATUS && resolveGitCommonDir(cwd) === null;
    return exitStatus === UNTRACKED_EXIT_STATUS || notACheckout ? projectRoot : cwd;
  }
}

/**
 * Append `patterns` to the checkout's `.git/info/exclude` under a marker
 * comment, skipping ones already present. Best-effort and never throws: a
 * failure only means the runtime files stay visible in git status, exactly
 * the pre-seeding behavior.
 */
export function ensureLocalGitExcludes(directory: string, patterns: string[]): void {
  try {
    const commonDir = resolveGitCommonDir(directory);
    if (!commonDir) return;

    const excludePath = path.join(commonDir, 'info', 'exclude');
    let existing = '';
    try {
      existing = fs.readFileSync(excludePath, 'utf-8');
    } catch {
      // No exclude file yet.
    }

    const existingLines = new Set(existing.split('\n').map((line) => line.trim()));
    const missing = patterns.filter((pattern) => !existingLines.has(pattern));
    if (missing.length === 0) return;

    const hasMarker = [...existingLines].some((line) => line.startsWith(EXCLUDE_MARKER_PREFIX));
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const needsNewline = existing.length > 0 && !existing.endsWith('\n');
    const block = (hasMarker ? [] : [EXCLUDE_MARKER])
      .concat(missing)
      .join('\n');
    fs.appendFileSync(excludePath, `${needsNewline ? '\n' : ''}${block}\n`);
  } catch (error) {
    console.error('[git-exclude] Failed to seed .git/info/exclude', error);
  }
}
