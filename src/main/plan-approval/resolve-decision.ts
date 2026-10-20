import type { PermissionMode, PlanApproval } from '../../shared/types';
import { resolveEffectivePermissionMode } from '../transition-engine/spawn-preamble';
import type { PlanApprovalDecision } from '../agent/shared/plan-approval-hook';

/** What `readPlanApprovalDecision` gathers for one session. */
export interface PlanApprovalDecisionInput {
  agentCanApprove: boolean;
  /** The task's automations are disabled, as `canTaskRunAutomations` answers. */
  automationsDisabled: boolean;
  /** The session was launched with bypass available (`CommandOptions.bypassAvailable`). */
  bypassAvailable: boolean;
  /** The task's column, folded through its Board Profile. */
  column: { name: string; permission_mode: PermissionMode | null; plan_approval: PlanApproval };
  /** The task's workflow value, when the workflow is running; null otherwise. */
  runningWorkflowValue: PlanApproval | null;
  /** Where the plan exit sends the task (folded through its profile); null means it stays. */
  target: { name: string; permission_mode: PermissionMode | null } | null;
  taskPermissionMode: PermissionMode | null;
  globalPermissionMode: PermissionMode;
}

/**
 * Whether Kangentic approves a session's next plan, and the mode it continues
 * in. Pure over what `readPlanApprovalDecision` gathers, so the rules are
 * tested without a database.
 *
 * Which value applies:
 * - in a running workflow, the workflow's (picked, or derived from its plan
 *   columns by `workflowPlanApproval`);
 * - otherwise the column's own, and only while the column runs in plan mode;
 *   a column of any other mode is Manual.
 * Automatic approves only where the session's agent can approve plans, and
 * never for a task whose automations are disabled: an approval would let the
 * After Plan Mode move advance a task the user is holding. A workflow task
 * never carries that switch, so a workflow's value is not affected.
 *
 * The mode is the destination's, the one the session would spawn with there:
 * a plan approval keeps the live session, so whatever `setMode` sets is what
 * the agent implements under. When the task stays put, or moves to another plan
 * column, plan is not an answer (the agent would plan again), so the task's own
 * mode, then the global one, then `default`, is used instead. The same fallback
 * replaces bypassPermissions for a session launched without bypass available,
 * where Claude would ignore the switch and leave the session in `default`.
 */
export function resolvePlanApprovalDecision(input: PlanApprovalDecisionInput): PlanApprovalDecision {
  const value: PlanApproval = input.runningWorkflowValue
    ?? (input.column.permission_mode === 'plan' ? input.column.plan_approval : 'manual');
  const mode = continuingMode(input);
  return {
    approve: value === 'automatic' && input.agentCanApprove && !input.automationsDisabled,
    mode,
    detail: input.target ? `Moved to ${input.target.name}` : `Stayed in ${input.column.name}`,
  };
}

function continuingMode(input: PlanApprovalDecisionInput): PermissionMode {
  const reachable = (mode: PermissionMode | null): mode is PermissionMode =>
    mode !== null && mode !== 'plan' && (mode !== 'bypassPermissions' || input.bypassAvailable);
  const lanePermissionMode = input.target ? input.target.permission_mode : input.column.permission_mode;
  const mode = resolveEffectivePermissionMode(input.taskPermissionMode, lanePermissionMode, input.globalPermissionMode);
  if (reachable(mode)) return mode;
  for (const candidate of [input.taskPermissionMode, input.globalPermissionMode]) {
    if (reachable(candidate)) return candidate;
  }
  return 'default';
}
