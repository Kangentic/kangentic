import type { PermissionMode } from '../../shared/types';

/**
 * What the two spawn chokepoints tell the plan approval writer, and ask it,
 * with no imports of their own so neither picks up the writer's dependencies.
 *
 * - The session's directory, exactly as the spawn built it (the hook's decision
 *   path is derived from that same directory), so the writer never recomputes
 *   it from the project row and points the hook at a file it will not find.
 * - Whether the session was launched with bypass available. Claude applies a
 *   plan approval's `setMode` to bypassPermissions only then (probed on
 *   2.1.302: without it the session lands in `default`), so a decision for a
 *   session launched without it must not name bypass.
 * - Before a plan session launches, which mode an automatic approval would
 *   continue in, so the spawn can make bypass available when that is it.
 */

interface SpawnedSession {
  sessionDir: string;
  bypassAvailable: boolean;
}

const spawned = new Map<string, SpawnedSession>();

let resolveContinuingMode: ((projectId: string, taskId: string) => PermissionMode | null) | null = null;

/**
 * Recorded by a spawn chokepoint once its command is built, so the record lives
 * exactly as long as the command's hold: `releaseCommandHold`, which every path
 * that never spawns the command calls, and the PTY's exit and suspend, forget it.
 */
export function notePlanApprovalSpawn(ptySessionId: string, session: SpawnedSession): void {
  spawned.set(ptySessionId, session);
}

/**
 * Whether a spawn launches with bypass available (`CommandOptions.bypassAvailable`):
 * a plan session, on an agent whose plans Kangentic can approve, whose next plan
 * Kangentic would approve into bypassPermissions.
 */
export function planSpawnNeedsBypass(input: {
  permissionMode: PermissionMode | null | undefined;
  agentApprovesPlans: boolean;
  projectId: string;
  taskId: string;
}): boolean {
  return input.permissionMode === 'plan'
    && input.agentApprovesPlans
    && planApprovalModeForSpawn(input.projectId, input.taskId) === 'bypassPermissions';
}

export function spawnedSessionFor(ptySessionId: string): SpawnedSession | undefined {
  return spawned.get(ptySessionId);
}

export function forgetPlanApprovalSpawn(ptySessionId: string): void {
  spawned.delete(ptySessionId);
}

/** Registered by the writer when it starts. */
export function setPlanApprovalModeResolver(resolver: ((projectId: string, taskId: string) => PermissionMode | null) | null): void {
  resolveContinuingMode = resolver;
}

/**
 * The mode the task's next plan continues in when Kangentic approves it, or
 * null when Kangentic will not approve it. Never throws: a spawn must not fail
 * over a question about a plan that has not been written yet.
 */
export function planApprovalModeForSpawn(projectId: string, taskId: string): PermissionMode | null {
  try {
    return resolveContinuingMode?.(projectId, taskId) ?? null;
  } catch (error) {
    console.warn(`[plan-approval] Could not resolve the plan exit mode for task ${taskId.slice(0, 8)}:`, error);
    return null;
  }
}
