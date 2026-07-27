import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { slugify } from '../../shared/slugify';

const execFileAsync = promisify(execFile);

/**
 * Filesystem-only git introspection helpers. No simple-git dependency
 * and no shared state - each function is a pure predicate against the
 * local filesystem or a single shelled-out git command.
 *
 * Consumers: ipc handlers (tasks, projects, system, helpers), MCP
 * project context, and WorktreeManager.
 */

/** Check whether the project path is inside a git repository. */
export function isGitRepo(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.git'));
}

/** Check whether the project path is a git worktree (has `.git` as a file, not a directory). */
export function isInsideWorktree(projectPath: string): boolean {
  const dotGit = path.join(projectPath, '.git');
  try {
    return fs.statSync(dotGit).isFile();
  } catch {
    return false;
  }
}

/**
 * Check whether the project path IS a Kangentic-managed worktree checkout.
 *
 * A preview project's path looks like `<parent>/.kangentic/worktrees/<slug>`.
 * We check that the immediate parent dir is `worktrees` and its parent is
 * `.kangentic`. This avoids false positives when the app itself runs from
 * inside a worktree (e.g. the CWD contains `.kangentic/worktrees/` early
 * in the path, but the project isn't itself a preview worktree).
 */
export function isKangenticWorktree(projectPath: string): boolean {
  // Normalize all separators to forward slashes so the check works on any OS
  const normalized = projectPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 3) return false;
  const parentSegment = segments[segments.length - 2];
  const grandparentSegment = segments[segments.length - 3];
  return parentSegment === 'worktrees' && grandparentSegment === '.kangentic';
}

/** Check whether a file is tracked by git (committed or staged). Async: this
 *  shells out to git, and its one caller (ensureGitignore) runs on the
 *  project-open path where a synchronous subprocess would block the main
 *  process event loop. */
export async function isFileTracked(projectPath: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', filePath], {
      cwd: projectPath,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a folder is tracked by SOME git repository - either its own or an ancestor's.
 *
 * `isGitRepo` only looks for `.git` in that exact folder, so a SUBDIRECTORY of a repo
 * reads as "not a repo". That distinction stops mattering the moment we initialise
 * without asking: running `git init` in a subdirectory of someone's real repository
 * silently creates a nested repo that shadows their history for everything beneath it.
 * Resolving the true toplevel is the only way to tell the two cases apart.
 */
export async function isInsideGitRepo(projectPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectPath,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the repository has at least one commit.
 *
 * A freshly `git init`-ed repo has an UNBORN HEAD: the branch exists in name only, with no
 * commit behind it. Everything that resolves a base ref fails against that - `git worktree add`
 * reports `fatal: invalid reference: main` - so this is what separates a usable repo from a
 * brand-new one.
 *
 * It matters because Kangentic initialises a repo for anyone who opens a folder that has none,
 * and the very next thing they do is move a task. Committing on their behalf is not the answer:
 * an empty first commit gives worktrees with none of their files in them, and staging the whole
 * folder means committing however many gigabytes they happened to point us at.
 */
export async function hasCommits(projectPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectPath,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Outcome of ensureGitRepo. `created` distinguishes "we ran git init" from "there was
 *  already nothing to do", which the caller needs in order to stay quiet in the latter case. */
export interface EnsureGitRepoResult {
  ok: boolean;
  created: boolean;
  error: string | null;
}

/**
 * Make sure a project folder is covered by git, initialising one if it is not.
 *
 * Kangentic runs every task on its own branch in its own worktree, so a project without
 * git is a broken project - which is why this happens without asking rather than behind a
 * prompt. It is also what keeps `.kangentic/mcp-config.json`, carrying the MCP auth token,
 * out of an un-ignorable folder: `ensureGitignore` early-returns when there is no repo, so
 * a project added to a non-repo leaves that token in a directory a later `git init` would
 * happily start tracking.
 *
 * "Ensure", not "init": a folder already covered by a repo (its own or a parent's) is
 * success with nothing done, NOT an error. Only a genuine failure returns `ok: false`, and
 * even then the caller opens the project anyway - being unable to set up git is a reason to
 * warn, never a reason to lock someone out of their own folder.
 */
export async function ensureGitRepo(projectPath: string): Promise<EnsureGitRepoResult> {
  // statSync inside the guard, not beside existsSync: a directory that exists but cannot be
  // stat'ed (Windows EPERM on a reparse point, EBUSY on a locked folder, a TOCTOU delete
  // between the two calls) would otherwise throw out of a function whose whole contract is to
  // report failure as a value. The caller invokes this from a click handler, so a throw here
  // becomes an unhandled rejection and the button silently does nothing.
  try {
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      return { ok: false, created: false, error: 'That folder no longer exists.' };
    }
  } catch {
    return { ok: false, created: false, error: 'That folder could not be read.' };
  }
  if (isGitRepo(projectPath)) {
    return { ok: true, created: false, error: null };
  }
  // A subdirectory of an existing repo is already covered; initialising here would nest.
  if (await isInsideGitRepo(projectPath)) {
    return { ok: true, created: false, error: null };
  }
  try {
    // `-b main` is not cosmetic. Without it the initial branch is whatever the machine's
    // `init.defaultBranch` says, and an unset config (still the default on plenty of installs)
    // gives `master` - while `DEFAULT_CONFIG.git.defaultBaseBranch` is the hardcoded string
    // 'main'. The mismatch surfaces on the very first task move as
    // `fatal: invalid reference: main` from `git worktree add`. tests/e2e/helpers.ts pins the
    // same flag for the same reason; this is the product path finally doing likewise.
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath, windowsHide: true });
    } catch {
      // `-b` needs git >= 2.28. On anything older, take the repo git gives us rather than
      // leaving the folder with no repo at all.
      await execFileAsync('git', ['init'], { cwd: projectPath, windowsHide: true });
    }
    return { ok: true, created: true, error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, created: false, error: `Could not set up git. ${reason}` };
  }
}

/**
 * Check whether a branch name matches the auto-generated pattern for a task.
 * Auto-generated branches are `{slug}-{shortId}` where shortId is the first 8
 * chars of the task UUID. When the task was created off a non-default base
 * branch, the name is prefixed with the base as a namespace:
 * `{baseFlat}/{slug}-{shortId}`. The slug may have been truncated by the
 * dynamic path budget, so we check that the branch slug is a valid prefix of
 * the full slug. Custom branches set by the user will not match.
 */
export function isAutoGeneratedBranch(branchName: string, taskId: string, taskTitle: string): boolean {
  const shortId = taskId.slice(0, 8);
  const suffix = `-${shortId}`;
  if (!branchName.endsWith(suffix)) return false;

  const withoutSuffix = branchName.slice(0, -suffix.length);
  const firstSlashIndex = withoutSuffix.indexOf('/');
  const branchSlug = firstSlashIndex >= 0
    ? withoutSuffix.slice(firstSlashIndex + 1)
    : withoutSuffix;

  // Our auto-generated format has at most ONE slash (between the flattened
  // base-branch prefix and the task slug). User-supplied custom branches
  // with multiple segments (e.g. 'feature/bug/login') are rejected here.
  if (branchSlug.includes('/')) return false;

  if (branchSlug === 'task') return true; // fallback slug used when budget was 0
  const fullSlug = slugify(taskTitle) || 'task';
  return fullSlug.startsWith(branchSlug) && branchSlug.length > 0;
}
