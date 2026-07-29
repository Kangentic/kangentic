import { IPC } from '../../shared/ipc-channels';
import { withTaskLock } from '../ipc/task-lifecycle-lock';
import { readWorktreeHead, hasCommitsAheadOfBase } from '../git/worktree-head';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import {
  resolvePRForBranch,
  resolvePRByNumber,
  resolvePRByCommit,
  detectPR,
  PRResolverUnavailableError,
  PRResolverTransientError,
} from './pr-registry';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { Task, PRState, PRLinkStatus, TaskUpdateInput } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';

export interface PRLinkResult {
  status: PRLinkStatus;
  task: Task | null;
  /** Human-readable detail for `resolver-unavailable` / `transient-error`. */
  message?: string;
}

/** One-time-per-run guard so the "resolver unavailable" hint isn't logged on every move. */
let resolverUnavailableHintShown = false;

/**
 * Per-task throttle: timestamp (ms) of the last resolve. Auto triggers within
 * this window coalesce so a multi-card drag or rapid moves don't spawn a `gh`
 * storm. Manual / MCP resolves bypass it (force=true). Bounded by task count.
 */
const lastResolveAt = new Map<string, number>();
const RESOLVE_TTL_MS = 60_000;

export interface PRLinkDeps {
  tasks: TaskRepository;
  /** Repo root used as the resolver `cwd` when the task has no worktree of its own. */
  projectPath: string | null;
  /**
   * Project default base branch (from config), used to resolve the task's base
   * for the Tier-3 commits-ahead-of-base guard when `task.base_branch` is unset.
   * Falls back to 'main' when absent.
   */
  defaultBaseBranch?: string;
  /** Notify the renderer that the task changed (e.g. send TASK_UPDATED_BY_AGENT). */
  onLinked: (task: Task) => void;
  /** Optional raw PTY scrollback for the degradation fallback when the resolver is unavailable. */
  getScrollback?: () => string | undefined;
  /**
   * Bypass the TTL coalesce + terminal-state skip. Set by explicit user/agent
   * actions (kebab refresh, MCP link_pr) where a fresh check is always wanted.
   */
  force?: boolean;
}

/**
 * A PR linked to a task: the subset of `ResolvedPR` the linker persists. `state`
 * is nullable here (unlike `ResolvedPR.state`) because the scrollback degradation
 * fallback links url+number even when the PR's state cannot be confirmed.
 */
type LinkedPR = { url: string; number: number; state: PRState | null };

/**
 * The confidence ladder - resolve a task's PR via the strongest available anchor
 * first, short-circuiting on the first hit:
 *   1. pr_number  -> exact, branch-independent (best for refreshing state)
 *   2. worktree HEAD branch -> the real branch while actively worked
 *   3. commit SHA -> immutable, survives Done/worktree deletion and renames
 *   4. stored slug branch -> weak last resort when there is no worktree
 * A `PRResolverUnavailableError` from any tier propagates so the caller degrades.
 *
 * Every anchor is git state or an explicitly stored number. A PR URL written into
 * the task DESCRIPTION is deliberately not an anchor: a URL cited as background
 * ("this follows on from <that PR's url>") is textually identical to one naming
 * the task's own PR, so scraping prose stamped citations onto unrelated tasks -
 * and because that tier always produced a link, the confident-not-found clear
 * below could never fire, making the wrong link permanent. A review task
 * names its PR through the structured `pr_url` / `pr_number` fields instead (the
 * task-detail edit form, `kangentic_create_task`, or `kangentic_update_task`),
 * which lands on Tier 1.
 */
async function resolvePRViaLadder(args: {
  task: Task;
  cwd: string;
  projectPath: string | null;
  branch: string | null;
  effectiveSha: string | null;
  baseBranch: string;
}): Promise<LinkedPR | null> {
  const { task, cwd, projectPath, branch, effectiveSha, baseBranch } = args;

  if (task.pr_number != null) {
    const byNumber = await resolvePRByNumber(cwd, task.pr_number);
    if (byNumber) return byNumber;
  }
  if (task.worktree_path && branch) {
    const byBranch = await resolvePRForBranch(cwd, branch, task.base_branch ?? undefined);
    if (byBranch) return byBranch;
  }
  if (effectiveSha && (await hasCommitsAheadOfBase(projectPath ?? cwd, baseBranch, effectiveSha))) {
    // Run from the main repo (projectPath) so it works even when the worktree is
    // gone. Pass the known branch as a hint so a commit shared by several PRs
    // ties back to this task (ambiguous matches resolve to null, not a guess).
    // Only run when the commit has work of its own beyond base: a fresh worktree
    // branched from base sits on base's tip (== the last-merged PR's commit), and
    // that PR is never this task's work. This also catches the single-parent
    // commits `gh pr merge --rebase`/`--squash` produce, which a parent-count
    // merge check misses.
    const byCommit = await resolvePRByCommit(projectPath ?? cwd, effectiveSha, branch ?? undefined);
    if (byCommit) return byCommit;
  }
  if (!task.worktree_path && branch) {
    const bySlug = await resolvePRForBranch(cwd, branch, task.base_branch ?? undefined);
    if (bySlug) return bySlug;
  }
  return null;
}

/**
 * Resolve a task's PR and persist it - the single backbone all triggers funnel
 * through. Wrapped in `withTaskLock` because it crosses an await boundary and
 * mutates per-task state (see .claude/rules/task-lifecycle-lock.md). Writes only on change.
 *
 * Also opportunistically persists the worktree HEAD SHA so the commit anchor is
 * available later, after the worktree is reclaimed on Done.
 */
export async function linkPRForTask(taskId: string, deps: PRLinkDeps): Promise<PRLinkResult> {
  return withTaskLock(taskId, async (): Promise<PRLinkResult> => {
    const task = deps.tasks.getById(taskId);
    if (!task) return { status: 'no-anchor', task: null };

    // Auto triggers: skip terminal PRs (merged/closed can't change) and coalesce
    // rapid re-resolves. Explicit user/agent actions (force) always run fresh.
    if (!deps.force) {
      if (task.pr_state === 'merged' || task.pr_state === 'closed') {
        return { status: 'unchanged', task };
      }
      const last = lastResolveAt.get(taskId);
      if (last != null && Date.now() - last < RESOLVE_TTL_MS) {
        return { status: 'unchanged', task };
      }
    }
    const resolveNow = Date.now();
    // Prune entries past the throttle window before recording this one. An
    // entry older than RESOLVE_TTL_MS no longer coalesces anything, so the map
    // can stay bounded to tasks resolved in the last minute instead of growing
    // for the life of the process across every task ever resolved.
    for (const [id, ts] of lastResolveAt) {
      if (resolveNow - ts >= RESOLVE_TTL_MS) lastResolveAt.delete(id);
    }
    lastResolveAt.set(taskId, resolveNow);

    const cwd = task.worktree_path ?? deps.projectPath;

    // Live worktree HEAD (branch + sha) when a worktree exists.
    let worktreeBranch: string | null = null;
    let freshSha: string | null = null;
    if (task.worktree_path) {
      const head = await readWorktreeHead(task.worktree_path);
      worktreeBranch = head.branch;
      freshSha = head.sha;
    }
    const branch = worktreeBranch ?? task.branch_name;
    const effectiveSha = freshSha ?? task.head_sha;
    const baseBranch = task.base_branch ?? deps.defaultBaseBranch ?? 'main';

    // Nothing to resolve from at all. Mirrors `autoLinkPRForTask`'s gate: a task
    // with no stored number and no git state has no anchor, whatever its
    // description happens to mention.
    if (!cwd || (task.pr_number == null && !branch && !effectiveSha)) {
      // Still persist a freshly-read SHA if we have one (rare: detached HEAD worktree).
      if (freshSha && freshSha !== task.head_sha) {
        return { status: 'no-anchor', task: deps.tasks.update({ id: task.id, head_sha: freshSha }) };
      }
      return { status: 'no-anchor', task };
    }

    let next: LinkedPR | null = null;
    // When the resolver could not actually check (gh missing/unauth, or a
    // transient network/5xx/timeout), record the degraded status so we report
    // the real reason and never overwrite an existing link with "not found".
    let degradeStatus: 'resolver-unavailable' | 'transient-error' | undefined;
    let degradeMessage: string | undefined;

    try {
      const resolved = await resolvePRViaLadder({ task, cwd, projectPath: deps.projectPath, branch, effectiveSha, baseBranch });
      if (resolved) next = { url: resolved.url, number: resolved.number, state: resolved.state };
    } catch (error) {
      if (error instanceof PRResolverUnavailableError || error instanceof PRResolverTransientError) {
        degradeStatus = error instanceof PRResolverTransientError ? 'transient-error' : 'resolver-unavailable';
        degradeMessage = error.message;
        // Degrade to the scrollback scraper (url+number only; preserve a known
        // state when the URL is unchanged).
        const scraped = deps.getScrollback ? detectPR(deps.getScrollback() ?? '') : null;
        if (scraped) {
          next = { url: scraped.url, number: scraped.number, state: scraped.url === task.pr_url ? task.pr_state : null };
        }
        if (degradeStatus === 'resolver-unavailable' && !resolverUnavailableHintShown) {
          resolverUnavailableHintShown = true;
          console.warn(`[pr-linking] ${error.message}\nPR auto-linking is degraded to terminal scraping until a PR resolver is available.`);
        }
      } else {
        console.error(`[pr-linking] resolve failed for task ${taskId.slice(0, 8)}:`, error);
      }
    }

    // Build a single update for any changed PR fields and/or the freshly-read SHA.
    const patch: TaskUpdateInput = { id: task.id };
    const prChanged = next != null
      && (task.pr_url !== next.url || task.pr_number !== next.number || task.pr_state !== next.state);
    if (prChanged && next) {
      patch.pr_url = next.url;
      patch.pr_number = next.number;
      patch.pr_state = next.state;
    }
    // Confident not-found: the resolver ran cleanly (no transient / unavailable
    // degrade) and matched no PR, yet the task still carries a link. Clear it so
    // a stale `merged` (or any orphaned link) never lingers - pr_number, pr_url,
    // and pr_state always agree, written atomically in the same update below. A
    // degraded resolve never clears (the link is preserved, as before).
    const hadLink = task.pr_number != null || task.pr_url != null || task.pr_state != null;
    const prCleared = next == null && !degradeStatus && hadLink;
    if (prCleared) {
      patch.pr_url = null;
      patch.pr_number = null;
      patch.pr_state = null;
    }
    const shaChanged = freshSha != null && freshSha !== task.head_sha;
    if (shaChanged) patch.head_sha = freshSha;

    let updatedTask = task;
    if (prChanged || prCleared || shaChanged) {
      updatedTask = deps.tasks.update(patch);
    }
    if (prChanged && next) {
      console.log(`[pr-linking] Linked PR #${next.number} (${next.state ?? 'unknown'}) to "${task.title}": ${next.url}`);
      deps.onLinked(updatedTask);
    } else if (prCleared) {
      console.log(`[pr-linking] Cleared stale PR link from "${task.title}" (no PR resolves for its branch)`);
      deps.onLinked(updatedTask);
    }

    if (!next && degradeStatus) {
      return { status: degradeStatus, task: updatedTask, message: degradeMessage };
    }
    if (!next) {
      return { status: 'not-found', task: updatedTask };
    }
    return { status: prChanged ? 'linked' : 'unchanged', task: updatedTask };
  });
}

interface LinkPROptions {
  projectId?: string | null;
  taskId?: string;
  sessionId?: string;
  branchName?: string;
  scrollback?: string;
  /** Bypass the TTL coalesce + terminal-skip (explicit user/agent refresh). */
  force?: boolean;
}

/**
 * IPC-side wrapper around `linkPRForTask`: resolves the project + task (by id,
 * else live session, else branch name) and wires the renderer notification.
 * Mapping by branch/session means exited or suspended sessions and human-created
 * PRs still link.
 */
export async function linkPR(context: IpcContext, options: LinkPROptions): Promise<PRLinkResult> {
  const projectId = options.projectId
    ?? (options.sessionId ? context.sessionManager.getSessionProjectId(options.sessionId) : null)
    ?? context.currentProjectId;
  if (!projectId) return { status: 'no-anchor', task: null };

  let repos: ReturnType<typeof getProjectRepos>;
  try {
    repos = getProjectRepos(context, projectId);
  } catch {
    return { status: 'no-anchor', task: null };
  }
  const { tasks } = repos;

  const task = options.taskId ? tasks.getById(options.taskId)
    : options.sessionId ? tasks.getBySessionId(options.sessionId)
    : options.branchName ? tasks.getByBranchName(options.branchName)
    : undefined;
  if (!task) return { status: 'no-anchor', task: null };

  const projectPath = context.projectRepo.getById(projectId)?.path ?? null;
  let defaultBaseBranch: string | undefined;
  try {
    defaultBaseBranch = projectPath ? context.configManager.getEffectiveConfig(projectPath).git.defaultBaseBranch : undefined;
  } catch {
    defaultBaseBranch = undefined;
  }

  return linkPRForTask(task.id, {
    tasks,
    projectPath,
    defaultBaseBranch,
    force: options.force,
    getScrollback: options.scrollback != null ? () => options.scrollback : undefined,
    onLinked: (linked) => {
      if (!context.mainWindow.isDestroyed()) {
        context.mainWindow.webContents.send(IPC.TASK_UPDATED_BY_AGENT, linked.id, linked.title, projectId);
      }
      context.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [linked.id] });
    },
  });
}

/**
 * Fire-and-forget best-effort auto-resolve of a task's PR, gated on the task
 * being in a post-To Do lane (To Do resets the task, so there is no PR to link
 * there). Keeps platform logic in the connector; here we only gate on having a
 * branch/worktree and a non-To Do lane.
 *
 * The shared auto-link entry point for every implicit trigger: a task-move
 * (called AFTER `handleTaskMove` returns, outside the move's task lock), the
 * plan-exit auto-move, and a session going idle (a PR was likely just created).
 * All run NON-force, so the per-task 60s throttle in `linkPRForTask` coalesces
 * them.
 */
export function autoLinkPRForTask(context: IpcContext, taskId: string, projectId: string | null): void {
  try {
    const { tasks, swimlanes } = getProjectRepos(context, projectId);
    const task = tasks.getById(taskId);
    if (!task || (!task.branch_name && !task.worktree_path && !task.head_sha && task.pr_number == null)) return;
    const lane = swimlanes.getById(task.swimlane_id);
    if (!lane || lane.role === 'todo') return;
    void linkPR(context, { projectId, taskId }).catch((error) => {
      console.error(`[pr-linking] post-move resolve failed for task ${taskId.slice(0, 8)}:`, error);
    });
  } catch {
    // Best-effort; never block a move on PR resolution.
  }
}
