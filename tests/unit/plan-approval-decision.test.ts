/**
 * Who approves a plan and the mode the session continues in:
 * `resolvePlanApprovalDecision` (main, per session). A workflow task's own
 * value is resolved by `taskPlanApproval`, tested in task-plan-approval.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { resolvePlanApprovalDecision, type PlanApprovalDecisionInput } from '../../src/main/plan-approval/resolve-decision';

function decide(overrides: Partial<PlanApprovalDecisionInput> = {}) {
  return resolvePlanApprovalDecision({
    agentCanApprove: true,
    automationsDisabled: false,
    bypassAvailable: false,
    column: { name: 'Planning', permission_mode: 'plan', plan_approval: 'automatic' },
    workflowTaskValue: null,
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

  it('follows a workflow task\'s own value over the column, both ways', () => {
    expect(decide({ workflowTaskValue: 'manual' }).approve).toBe(false);
    expect(decide({
      column: { name: 'Planning', permission_mode: 'plan', plan_approval: 'manual' },
      workflowTaskValue: 'automatic',
    }).approve).toBe(true);
  });

  it('holds an Automatic plan column as Manual for a task whose automations are disabled, mode and destination unchanged', () => {
    // An approval would let the After Plan Mode move advance a task the user is holding.
    expect(decide({ automationsDisabled: true })).toEqual({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
  });

  it('a workflow task\'s Automatic still cannot approve for an incapable agent', () => {
    expect(decide({ workflowTaskValue: 'automatic', agentCanApprove: false }).approve).toBe(false);
  });

  it('a workflow task\'s Automatic is held as Manual if its automations were ever disabled', () => {
    // A workflow member never carries the switch (the repository forces it
    // off), but the decision still checks it rather than trusting that.
    expect(decide({ workflowTaskValue: 'automatic', automationsDisabled: true }).approve).toBe(false);
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
