import { DEFAULT_AGENT } from '../../shared/types';

export interface AgentResolutionInput {
  /**
   * Task-level user override (`task.agent_override`). Highest priority -
   * when set, the agent is locked for the task's lifetime and column /
   * project settings are ignored. Set only at task creation via the New
   * Task dialog's Advanced section.
   */
  taskAgentOverride?: string | null;
  /** Column-level override (swimlane.agent_override). */
  columnAgent: string | null;
  /** Task's current agent (set after first spawn). Used for handoff detection only. */
  taskAgent: string | null;
  /** Project-level default agent. */
  projectDefaultAgent: string | null;
}

export interface AgentResolution {
  /** The resolved agent name to use for spawning. */
  agent: string;
  /** Whether the task's current agent differs from the resolved agent (requires fresh spawn + context transfer). */
  isHandoff: boolean;
}

/**
 * Single source of truth for which agent should run for a task in a given column.
 *
 * Resolution priority:
 *   1. Task agent_override (user-locked at creation; supersedes everything)
 *   2. Column agent_override (per-column setting)
 *   3. Project default agent (per-project setting)
 *   4. Global fallback (DEFAULT_AGENT constant)
 *
 * task.agent is intentionally NOT in the resolution chain. It records which
 * agent last ran on the task (for resume and handoff detection), but the
 * task_override / column / project settings are the authority for which
 * agent SHOULD run. Including task.agent in the chain caused bugs where
 * tasks that previously ran Claude would always resolve to Claude even
 * when moved to a Codex column.
 *
 * Handoff detection: when task.agent is set and differs from the resolved
 * agent, a cross-agent handoff is needed (context packaging + fresh spawn).
 * When task.agent is null (fresh task, never spawned), isHandoff is false.
 * When `taskAgentOverride` is set, isHandoff goes false on subsequent
 * column moves because the resolved agent is fixed - this is the locking
 * behavior the per-task agent override provides.
 */
export function resolveTargetAgent(input: AgentResolutionInput): AgentResolution {
  const agent = input.taskAgentOverride
    ?? input.columnAgent
    ?? input.projectDefaultAgent
    ?? DEFAULT_AGENT;

  const isHandoff = input.taskAgent !== null && input.taskAgent !== agent;

  return { agent, isHandoff };
}
