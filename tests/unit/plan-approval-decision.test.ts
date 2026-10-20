/**
 * Who approves a plan and the mode the session continues in:
 * `resolvePlanApprovalDecision` (main, per session) and `workflowPlanApproval`
 * (shared by main and the Workflows inspector).
 */
import { describe, it, expect } from 'vitest';
import { resolvePlanApprovalDecision, type PlanApprovalDecisionInput } from '../../src/main/plan-approval/resolve-decision';
import { workflowPlanApproval } from '../../src/shared/plan-approval';

function decide(overrides: Partial<PlanApprovalDecisionInput> = {}) {
  return resolvePlanApprovalDecision({
    agentCanApprove: true,
    automationsDisabled: false,
    bypassAvailable: false,
    column: { name: 'Planning', permission_mode: 'plan', plan_approval: 'automatic' },
    runningWorkflowValue: null,
    target: { name: 'Executing', permission_mode: 'acceptEdits' },
    taskPermissionMode: null,
    globalPermissionMode: 'default',
    ...overrides,
  });
}

describe('resolvePlanApprovalDecision', () => {
  it('approves in an Automatic plan column, continuing in the destination mode', () => {
    expect(decide()).toEqual({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
  });

  it('leaves a Manual plan column to the user', () => {
    expect(decide({ column: { name: 'Planning', permission_mode: 'plan', plan_approval: 'manual' } }).approve).toBe(false);
  });

  it('never approves for an agent that cannot approve plans', () => {
    expect(decide({ agentCanApprove: false }).approve).toBe(false);
  });

  it('reads a column that is not in plan mode as Manual, whatever it stores', () => {
    expect(decide({ column: { name: 'Executing', permission_mode: 'acceptEdits', plan_approval: 'automatic' } }).approve).toBe(false);
  });

  it('follows a running workflow over the column, both ways', () => {
    expect(decide({ runningWorkflowValue: 'manual' }).approve).toBe(false);
    expect(decide({
      column: { name: 'Planning', permission_mode: 'plan', plan_approval: 'manual' },
      runningWorkflowValue: 'automatic',
    }).approve).toBe(true);
  });

  it('holds an Automatic plan column as Manual for a task whose automations are disabled, mode and destination unchanged', () => {
    // An approval would let the After Plan Mode move advance a task the user is holding.
    expect(decide({ automationsDisabled: true })).toEqual({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
  });

  it('a running workflow still cannot approve for an incapable agent', () => {
    expect(decide({ runningWorkflowValue: 'automatic', agentCanApprove: false }).approve).toBe(false);
  });

  it('a task that stays continues in its own mode, never plan', () => {
    expect(decide({ target: null, taskPermissionMode: 'acceptEdits' })).toEqual({
      approve: true, mode: 'acceptEdits', detail: 'Stayed in Planning',
    });
  });

  it('a task that stays with no mode of its own continues in the global mode', () => {
    expect(decide({ target: null, globalPermissionMode: 'auto' }).mode).toBe('auto');
  });

  it('falls back to default when every candidate is plan', () => {
    expect(decide({ target: null, taskPermissionMode: 'plan', globalPermissionMode: 'plan' }).mode).toBe('default');
  });

  it('a move to another plan column continues outside plan mode too', () => {
    expect(decide({ target: { name: 'Review', permission_mode: 'plan' }, globalPermissionMode: 'acceptEdits' }).mode).toBe('acceptEdits');
  });

  it('continues in bypass only for a session launched with bypass available', () => {
    // Claude 2.1.302 ignores a setMode to bypassPermissions otherwise and lands
    // the session in default, where its first edit would wait for the user.
    const bypassTarget = { name: 'Executing', permission_mode: 'bypassPermissions' as const };
    expect(decide({ target: bypassTarget, bypassAvailable: true }).mode).toBe('bypassPermissions');
    expect(decide({ target: bypassTarget, bypassAvailable: false, globalPermissionMode: 'acceptEdits' }).mode).toBe('acceptEdits');
    expect(decide({ target: bypassTarget, bypassAvailable: false, taskPermissionMode: 'auto' }).mode).toBe('auto');
    expect(decide({ target: bypassTarget, bypassAvailable: false, globalPermissionMode: 'bypassPermissions' }).mode).toBe('default');
  });

  it('a destination with no mode of its own takes the task override, then the global mode', () => {
    expect(decide({ target: { name: 'Executing', permission_mode: null }, taskPermissionMode: 'auto' }).mode).toBe('auto');
    expect(decide({ target: { name: 'Executing', permission_mode: null }, globalPermissionMode: 'acceptEdits' }).mode).toBe('acceptEdits');
  });
});

describe('workflowPlanApproval', () => {
  const automatic = { planApproval: 'automatic' as const, agentCanApprove: true };
  const manual = { planApproval: 'manual' as const, agentCanApprove: true };

  it('a pick holds, whatever the columns say', () => {
    expect(workflowPlanApproval('automatic', [manual])).toBe('automatic');
    expect(workflowPlanApproval('manual', [automatic])).toBe('manual');
  });

  it('unpicked, it is Automatic only when every plan column is', () => {
    expect(workflowPlanApproval(null, [automatic, automatic])).toBe('automatic');
    expect(workflowPlanApproval(null, [automatic, manual])).toBe('manual');
  });

  it('unpicked, a plan column on an agent that cannot approve makes it Manual', () => {
    expect(workflowPlanApproval(null, [automatic, { planApproval: 'automatic', agentCanApprove: false }])).toBe('manual');
  });

  it('unpicked, a workflow with no plan columns is Manual', () => {
    expect(workflowPlanApproval(null, [])).toBe('manual');
  });
});
