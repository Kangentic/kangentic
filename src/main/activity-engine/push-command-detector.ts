import { EventType, AgentTool } from '../../shared/types';
import type { SessionEvent } from '../../shared/types';
import { parsePushedBranch, HOOK_DETAIL_CAP } from '../git/push-command';

/**
 * Detects the agent's own `git push` so the task can record the branch its
 * work was pushed to. That branch is the PR ladder's Tier 5 anchor, and for a
 * task with no worktree it is the ONLY anchor: every other one is written from
 * a worktree read, and the shared checkout's HEAD is not per task.
 *
 * Mirrors `PRCommandDetector`: the command string is only on the Bash
 * `tool_start` (the bridge does not forward it on `tool_end`), so the parsed
 * branch is remembered at start and reported when that call ends. Keyed on
 * `toolId` when both events carry one, because a subagent's or a parallel Bash
 * call can end first and would otherwise report the push before it finished.
 * An `Interrupted` turn clears the entry without reporting: an interrupted push
 * is ambiguous, and not recording is the safe side.
 *
 * Success versus failure is deliberately not distinguished. A push that was
 * rejected records a branch no PR resolves from, which the ladder treats as
 * not-found, and `recordPushedBranchForSession` refuses the one name that could
 * link wrongly (the task's base branch).
 */
export class PushCommandDetector {
  private pending = new Map<string, { toolId?: string; branch: string }>();

  detect(sessionId: string, event: SessionEvent): { pushedBranch: string | null } {
    if (event.type === EventType.ToolStart && event.tool === AgentTool.Bash && event.detail) {
      const branch = parsePushedBranch(event.detail, {
        possiblyTruncated: event.detail.length >= HOOK_DETAIL_CAP,
      });
      if (branch) this.pending.set(sessionId, { toolId: event.toolId, branch });
      return { pushedBranch: null };
    }
    if (event.type === EventType.Interrupted) {
      this.pending.delete(sessionId);
      return { pushedBranch: null };
    }
    if (event.type === EventType.ToolEnd && event.tool === AgentTool.Bash) {
      const entry = this.pending.get(sessionId);
      if (!entry) return { pushedBranch: null };
      if (entry.toolId && event.toolId && entry.toolId !== event.toolId) return { pushedBranch: null };
      this.pending.delete(sessionId);
      return { pushedBranch: entry.branch };
    }
    return { pushedBranch: null };
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /**
   * The remembered branch, cleared on read. For the exit-time fallback: a push
   * whose `tool_end` never arrived still names the branch the work went to.
   */
  takePending(sessionId: string): string | null {
    const entry = this.pending.get(sessionId);
    if (!entry) return null;
    this.pending.delete(sessionId);
    return entry.branch;
  }

  removeSession(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
