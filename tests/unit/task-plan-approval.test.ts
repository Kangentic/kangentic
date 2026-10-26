/**
 * A workflow task's plan approval (`taskPlanApproval`, src/shared/plan-approval.ts),
 * shared by main (the decision each session's approver reads, the MCP tools)
 * and the Workflows inspector: the order it resolves in, the guard for an agent
 * that cannot approve plans, the normalization a write goes through, and the
 * sentences the inspector's tip and kangentic_get_workflow print.
 */
import { describe, it, expect } from 'vitest';
import {
  agentCannotApprovePlans,
  normalizeTaskPlanApproval,
  taskPlanApproval,
  taskPlanApprovalSentence,
  taskPlanApprovalTip,
  type WorkflowPlanColumn,
} from '../../src/shared/plan-approval';

function column(overrides: Partial<WorkflowPlanColumn> = {}): WorkflowPlanColumn {
  return { name: 'Planning', planApproval: 'automatic', agentCanApprove: true, agentName: 'Claude Code', ...overrides };
}

describe('taskPlanApproval', () => {
  it('is null for a route with no plan column: there is no plan to approve', () => {
    expect(taskPlanApproval(null, [], 'kangentic', false)).toBeNull();
    expect(taskPlanApproval('manual', [], 'kangentic', false)).toBeNull();
  });

  it('left alone, follows its plan column both ways', () => {
    expect(taskPlanApproval(null, [column()], 'kangentic', false)).toMatchObject({ set: null, value: 'automatic', columnValue: 'automatic' });
    expect(taskPlanApproval(null, [column({ planApproval: 'manual' })], 'kangentic-mobile', false))
      .toMatchObject({ set: null, value: 'manual', columnValue: 'manual', column: { name: 'Planning', boardName: 'kangentic-mobile' } });
  });

  it('a value set on the task wins over its column, both ways', () => {
    expect(taskPlanApproval('manual', [column()], 'kangentic', false)).toMatchObject({ set: 'manual', value: 'manual', columnValue: 'automatic' });
    expect(taskPlanApproval('automatic', [column({ planApproval: 'manual' })], 'kangentic-mobile', false))
      .toMatchObject({ set: 'automatic', value: 'automatic', columnValue: 'manual' });
  });

  it('left alone, is Automatic only when every plan column on its route is, and names the one that holds it', () => {
    const view = taskPlanApproval(null, [column({ name: 'Plan' }), column({ name: 'Replan', planApproval: 'manual' })], 'kangentic', false);
    expect(view).toMatchObject({ value: 'manual', columnValue: 'manual', column: { name: 'Replan', boardName: 'kangentic' } });
    expect(taskPlanApproval(null, [column({ name: 'Plan' }), column({ name: 'Replan' })], 'kangentic', false))
      .toMatchObject({ value: 'automatic', column: { name: 'Plan' } });
  });

  it('a plan column on an agent that cannot approve holds the columns\' value to Manual', () => {
    const view = taskPlanApproval(null, [column(), column({ name: 'Replan', agentCanApprove: false, agentName: 'Codex CLI' })], 'kangentic', false);
    expect(view).toMatchObject({ columnValue: 'manual', canApprove: true, agentName: null, column: { name: 'Replan' } });
  });

  it('reads Manual, whatever is set, where no plan column\'s agent can approve plans, and names that agent', () => {
    const view = taskPlanApproval('automatic', [column({ agentCanApprove: false, agentName: 'Codex CLI' })], 'kangentic', false);
    expect(view).toMatchObject({ set: 'automatic', value: 'manual', canApprove: false, agentName: 'Codex CLI' });
  });

  it('carries whether the task has passed its plan column', () => {
    expect(taskPlanApproval(null, [column()], 'kangentic', true)?.passed).toBe(true);
    expect(taskPlanApproval(null, [column()], 'kangentic', false)?.passed).toBe(false);
  });
});

describe('a route mixing plan columns whose agents can and cannot approve plans', () => {
  const planning = column({ name: 'Planning' });
  const replan = column({ name: 'Replan', agentCanApprove: false, agentName: 'Codex CLI' });
  const mixedRoute = [planning, replan];

  it('Automatic set on the task still reads Automatic, and names the agent whose plans still wait', () => {
    expect(taskPlanApproval('automatic', mixedRoute, 'kangentic', false)).toMatchObject({
      set: 'automatic',
      value: 'automatic',
      columnValue: 'manual',
      canApprove: true,
      agentName: null,
      waitingAgentName: 'Codex CLI',
      column: { name: 'Replan', boardName: 'kangentic' },
    });
  });

  it('the tip and the sentence say that agent\'s plans still wait for the user', () => {
    const view = taskPlanApproval('automatic', mixedRoute, 'kangentic', false)!;

    expect(taskPlanApprovalTip(view))
      .toBe('Automatic, set for this task (kangentic\'s Replan column is Manual), but Codex CLI\'s plans still wait for you.');
    expect(taskPlanApprovalSentence(view))
      .toBe('Plan approval: Automatic, set for this task (its Replan column is Manual), but Codex CLI\'s plans still wait for you.');
  });

  it('names no waiting agent, and adds no clause, when every plan column\'s agent can approve', () => {
    const capableRoute = [column({ name: 'Planning', planApproval: 'manual' }), column({ name: 'Replan' })];
    const view = taskPlanApproval('automatic', capableRoute, 'kangentic', false)!;

    expect(view).toMatchObject({ value: 'automatic', canApprove: true, agentName: null, waitingAgentName: null });
    expect(taskPlanApprovalTip(view)).toBe('Automatic, set for this task (kangentic\'s Planning column is Manual).');
    expect(taskPlanApprovalSentence(view)).toBe('Plan approval: Automatic, set for this task (its Planning column is Manual).');
  });

  it('adds no clause when the task is Manual, whether it was set or follows its columns', () => {
    const setManual = taskPlanApproval('manual', mixedRoute, 'kangentic', false)!;
    const followsColumns = taskPlanApproval(null, mixedRoute, 'kangentic', false)!;

    expect(setManual).toMatchObject({ value: 'manual', set: 'manual' });
    expect(taskPlanApprovalTip(setManual)).toBe('Manual, set for this task (kangentic\'s Replan column is Manual).');
    expect(taskPlanApprovalSentence(setManual)).toBe('Plan approval: Manual, set for this task (its Replan column is Manual).');

    expect(followsColumns).toMatchObject({ value: 'manual', set: null });
    expect(taskPlanApprovalTip(followsColumns)).toBe('Manual, from kangentic\'s Replan column.');
    expect(taskPlanApprovalSentence(followsColumns)).toBe('Plan approval: Manual, from kangentic\'s Replan column.');
  });
});

describe('normalizeTaskPlanApproval', () => {
  it('stores the columns\' own value as nothing, so the task keeps following them', () => {
    expect(normalizeTaskPlanApproval('automatic', 'automatic')).toBeNull();
    expect(normalizeTaskPlanApproval('manual', 'manual')).toBeNull();
  });

  it('stores a value that differs from the columns\', and null as null', () => {
    expect(normalizeTaskPlanApproval('manual', 'automatic')).toBe('manual');
    expect(normalizeTaskPlanApproval('automatic', 'manual')).toBe('automatic');
    expect(normalizeTaskPlanApproval(null, 'automatic')).toBeNull();
  });
});

describe('the sentences', () => {
  const leftAlone = taskPlanApproval(null, [column()], 'kangentic', false)!;
  const setManual = taskPlanApproval('manual', [column()], 'kangentic', false)!;
  const setAutomatic = taskPlanApproval('automatic', [column({ planApproval: 'manual' })], 'kangentic-mobile', false)!;
  const cannotApprove = taskPlanApproval(null, [column({ agentCanApprove: false, agentName: 'Codex CLI' })], 'kangentic', false)!;

  it('the inspector\'s tip names the column a task follows, or says it was set and what the column gives', () => {
    expect(taskPlanApprovalTip(leftAlone)).toBe('Automatic, from kangentic\'s Planning column.');
    expect(taskPlanApprovalTip(setManual)).toBe('Manual, set for this task (kangentic\'s Planning column is Automatic).');
    expect(taskPlanApprovalTip(setAutomatic)).toBe('Automatic, set for this task (kangentic-mobile\'s Planning column is Manual).');
    expect(taskPlanApprovalTip(cannotApprove)).toBe('Manual, because Kangentic can\'t approve Codex CLI\'s plans.');
  });

  it('kangentic_get_workflow says the value and where it comes from', () => {
    expect(taskPlanApprovalSentence(null)).toBe('Plan approval: none, no plan column on its route.');
    expect(taskPlanApprovalSentence(leftAlone)).toBe('Plan approval: Automatic, from kangentic\'s Planning column.');
    expect(taskPlanApprovalSentence(setManual)).toBe('Plan approval: Manual, set for this task (its Planning column is Automatic).');
    expect(taskPlanApprovalSentence(cannotApprove))
      .toBe('Plan approval: Manual, because Kangentic can\'t approve Codex CLI\'s plans (its Planning column is Manual).');
  });

  it('kangentic_get_workflow says when a task has passed its plan column', () => {
    const passed = taskPlanApproval('manual', [column()], 'kangentic', true);
    expect(taskPlanApprovalSentence(passed))
      .toBe('Plan approval: Manual, set for this task (its Planning column is Automatic). It has passed Planning, so it can no longer change.');
  });

  it('the reason Automatic is off is one sentence for every surface that offers it', () => {
    expect(agentCannotApprovePlans('Codex CLI')).toBe('Kangentic can\'t approve Codex CLI\'s plans, so they wait for you.');
  });
});
