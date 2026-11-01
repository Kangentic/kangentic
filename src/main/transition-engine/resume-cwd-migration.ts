import * as path from 'node:path';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { CliPlace } from '../agent/shared/cli-target';

/**
 * Migrate an agent's per-cwd session history when a task's worktree was renamed
 * out from under a resumable session.
 *
 * cwd-keyed agents (Claude, Gemini, Qwen, Kimi, Droid) store conversation
 * history in a directory derived from the cwd - Claude at
 * `~/.claude/projects/<slug(cwd)>/<agentSessionId>.jsonl`. On a worktree made
 * before numeric folders, renaming a task's branch later recreated its worktree
 * directory at a NEW path (the folder followed the branch). The re-spawned
 * agent then runs with the new worktree as cwd, so `--resume <id>` looks under
 * the new slug, finds
 * nothing, and silently starts an empty session ("No conversation found with
 * session ID"). The transcript is intact, just orphaned under the old slug.
 *
 * A worktree rename is a per-cwd relocation, which every adapter already handles
 * via `onProjectRelocated(oldPath, newPath)` (the same hook used for whole-project
 * moves). This helper detects the rename and reuses that hook to move the history
 * to the new cwd's slug BEFORE the resume command is built, with zero new
 * per-adapter code: cwd-keyed agents migrate; agents whose resume finds the file
 * regardless of cwd no-op (Codex and OpenCode find it by id). The skip check is
 * the adapter's `locateResumeHistoryFile` when it declares one, because an
 * adapter can read a history from more places than its CLI resumes from.
 * Worktree folders no longer move at all (`WorktreeManager.createWorktree`), so
 * the rename this was built for reaches it only from an older install.
 *
 * Best-effort and non-destructive. On any failure it returns silently and the
 * spawn proceeds with the same `--resume <id>`, degrading to today's exact
 * behavior (a visible "No conversation found"), never to silent conversation
 * loss. This is deliberately NOT the `canResumeSession` transcript-presence guard
 * that was built and reverted in #255 (see docs/integrations/agents/session-history.md): it
 * never downgrades resume -> fresh, and it early-returns when `oldCwd === newCwd`
 * (the mocked E2E resume specs keep cwd identical across spawns, so they never
 * reach the migration).
 */
export async function migrateResumeCwdIfRenamed(params: {
  adapter: AgentAdapter;
  agentSessionId: string | null;
  canResume: boolean;
  /** The cwd the resumed session originally ran in (the matched record's cwd). */
  oldCwd: string | null;
  /** The cwd the agent is about to be (re)spawned in (the task's current worktree). */
  newCwd: string;
  projectPath: string | null | undefined;
  /**
   * Where the CLI runs when it is not this machine (a WSL distro). The check
   * looks in the distro's home; a history the rename orphaned there is not
   * moved (`onProjectRelocated` moves this machine's), so that resume reports
   * "No conversation found", as any unmigrated resume does.
   */
  place?: CliPlace | null;
}): Promise<void> {
  const { adapter, agentSessionId, canResume, oldCwd, newCwd, projectPath } = params;
  const place = params.place ?? null;

  if (!canResume || !agentSessionId || !projectPath || !oldCwd) return;

  // Same directory? Nothing was renamed. The filesystem is case-insensitive on
  // Windows, so compare case-insensitively there (matching collectRelocationPairs).
  const resolvedOldCwd = path.resolve(oldCwd);
  const resolvedNewCwd = path.resolve(newCwd);
  const sameDirectory = process.platform === 'win32'
    ? resolvedOldCwd.toLowerCase() === resolvedNewCwd.toLowerCase()
    : resolvedOldCwd === resolvedNewCwd;
  if (sameDirectory) return;

  // Only migrate a dedicated per-task worktree cwd - a DIRECT child of the
  // worktrees root. This guard is load-bearing: the enable-worktree flow resumes
  // a session whose oldCwd is the SHARED project root, and relocating that would
  // move the whole `~/.claude/projects/<root-slug>/` directory (every
  // project-root-cwd session, across all tasks) under the new worktree slug,
  // orphaning unrelated tasks. Requiring a single path segment also rejects a
  // sub-directory inside a worktree, whose slug differs from the worktree root's.
  const worktreesRoot = path.join(path.resolve(projectPath), '.kangentic', 'worktrees');
  const relativeToWorktrees = path.relative(worktreesRoot, resolvedOldCwd);
  const isDedicatedWorktree =
    relativeToWorktrees !== '' &&
    !relativeToWorktrees.startsWith('..') &&
    !path.isAbsolute(relativeToWorktrees) &&
    !relativeToWorktrees.includes(path.sep);
  if (!isDedicatedWorktree) return;

  // Migrate best-effort. Both adapter calls are wrapped: the documented contract
  // is "on any failure, return silently and let the resume proceed unchanged", so
  // a throwing locator must not escape into the spawn path either.
  try {
    // Already reachable from the new cwd? Then nothing was orphaned (or a prior
    // migration already ran). A positive skip-check, never a gate on resume.
    const reachable = adapter.locateResumeHistoryFile
      ? await adapter.locateResumeHistoryFile(agentSessionId, newCwd, place)
      : await adapter.locateSessionHistoryFile(agentSessionId, newCwd, place);
    if (reachable) return;
    if (place) {
      console.warn(`[RESUME_MIGRATE] Session history ${oldCwd} -> ${newCwd} is in WSL distro ${place.distro}; not migrated`);
      return;
    }

    await adapter.onProjectRelocated?.(oldCwd, newCwd);
  } catch (error) {
    console.warn(
      `[RESUME_MIGRATE] Failed to migrate session history ${oldCwd} -> ${newCwd}:`,
      error,
    );
  }
}
