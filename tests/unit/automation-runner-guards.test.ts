/**
 * The runner's two guards and the group-ending row (#732, the Code Review loop).
 *
 * - **Frequency:** a row that has run its limit on the task is skipped, and a
 *   skip never counts toward the limit.
 * - **Condition:** the Automation agent's answer decides. A no is recorded as a
 *   skip with the reason, not a run, so the next trigger checks again; a yes
 *   rides the run row. A row whose Condition could not be checked is skipped
 *   with why. The group is checked ONCE, for every row that could run.
 * - **endsGroup:** a Move to column row that runs stops the list, because the
 *   task has left the column, and its own move must not read as the abort of
 *   the group that made it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runAutomations,
  frequencyLimitReason,
  CONDITION_CHECK_WAIT_MS,
  type ConditionCheckResult,
} from '../../src/main/automations/automation-runner';
import { hasCondition } from '../../src/main/automations/row-guards';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import type { ConditionCheckLimits } from '../../src/main/automations/condition-check/condition-check';
import { AUTOMATION_MANIFEST, EXIT_GROUP_BUDGET_MS } from '../../src/shared/automation-manifest';
import type { AutomationAdapter, AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { AutomationRunRepository, RunConditionAnswer } from '../../src/main/db/repositories/automation-run-repository';
import type { AutomationRunStatus, AutomationType, ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

const COLUMN = {
  id: 'lane-review',
  name: 'Code Review',
  role: null,
  position: 3,
  auto_spawn: true,
} as Swimlane;

function automation(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'a1',
    swimlane_id: COLUMN.id,
    name: 'Ping',
    type: 'webhook',
    trigger: 'turn_end',
    position: 0,
    enabled: true,
    config: {},
    condition: null,
    max_runs: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface RecordedRun {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  detail: string | null;
  condition: RunConditionAnswer | null;
}

/** A run log that also answers `countRuns`, from runs seeded per automation. */
function fakeRuns(priorRuns: Record<string, number> = {}) {
  const rows: RecordedRun[] = [];
  const repository = {
    start: (input: { id: string; automation: { id: string }; condition?: RunConditionAnswer }) => {
      rows.push({ id: input.id, automationId: input.automation.id, status: 'running', detail: null, condition: input.condition ?? null });
    },
    finish: (id: string, status: AutomationRunStatus, detail: string | null) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) Object.assign(row, { status, detail });
    },
    recordSkipped: (input: { id: string; automation: { id: string }; condition?: RunConditionAnswer }, reason: string) => {
      rows.push({ id: input.id, automationId: input.automation.id, status: 'skipped', detail: reason, condition: input.condition ?? null });
    },
    recordDeliveredByCaller: () => {},
    countRuns: (automationId: string) => (priorRuns[automationId] ?? 0)
      + rows.filter((row) => row.automationId === automationId && row.status !== 'skipped').length,
  };
  return { rows, repository: repository as unknown as AutomationRunRepository };
}

function context(trigger: AutomationContext['trigger'] = 'turn_end'): Omit<AutomationContext, 'runId' | 'signal'> {
  return {
    task: { id: 'task-1', title: 'A task', session_id: 'session-1' } as Task,
    column: COLUMN,
    fromColumn: null,
    toColumn: null,
    trigger,
    cwd: '/mock/worktree',
    projectId: 'project-1',
    projectPath: '/mock/project',
    projectName: 'Mock',
    templateVars: {},
    sessionHost: { getShell: async () => 'bash' },
    deliverToAgent: vi.fn(async () => {}),
    showNotification: vi.fn(),
  };
}

function adapter(id: AutomationType, execute: AutomationAdapter['execute']): AutomationAdapter {
  return { id, manifest: AUTOMATION_MANIFEST[id], describe: () => 'test', execute };
}

function registryOf(...adapters: AutomationAdapter[]): AutomationRegistry {
  const registry = new AutomationRegistry();
  for (const entry of adapters) registry.register(entry);
  return registry;
}

describe('Frequency', () => {
  it('skips a row that has run its limit on the task, and says so', async () => {
    const executed = vi.fn(async () => ({ detail: 'HTTP 204' }));
    const { rows, repository } = fakeRuns({ a1: 3 });
    await runAutomations({
      automations: [automation({ max_runs: 3 })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('webhook', executed)),
    });
    expect(executed).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].detail).toBe('Already ran 3 times on this task, its limit.');
  });

  it('runs a row still under its limit', async () => {
    const executed = vi.fn(async () => ({ detail: 'HTTP 204' }));
    const { rows, repository } = fakeRuns({ a1: 2 });
    await runAutomations({
      automations: [automation({ max_runs: 3 })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('webhook', executed)),
    });
    expect(executed).toHaveBeenCalledTimes(1);
    expect(rows[0].status).toBe('succeeded');
  });

  it('counts only runs, so a row with no limit and the helper agree', () => {
    const { repository } = fakeRuns({ a1: 1 });
    expect(frequencyLimitReason(automation({ max_runs: 1 }), repository, 'task-1')).toBe('Already ran once on this task, its limit.');
    expect(frequencyLimitReason(automation({ max_runs: null }), repository, 'task-1')).toBeNull();
    // A row built by hand without the column reads as no limit, never as one.
    const { max_runs: _omitted, ...withoutLimit } = automation();
    expect(frequencyLimitReason(withoutLimit as ColumnAutomation, repository, 'task-1')).toBeNull();
  });
});

describe('Condition', () => {
  it('runs a row whose Condition the agent answered yes, and records the answer', async () => {
    const executed = vi.fn(async () => ({ detail: 'HTTP 204' }));
    const { rows, repository } = fakeRuns();
    await runAutomations({
      automations: [automation({ condition: 'The review is clean' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('webhook', executed)),
      conditionAnswers: new Map([['a1', { met: true, reason: 'No findings were left.' }]]),
    });
    expect(executed).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', condition: { met: true, reason: 'No findings were left.' } });
  });

  it('skips a row whose Condition the agent answered no, with the reason, and it is not a run', async () => {
    const executed = vi.fn(async () => ({ detail: 'HTTP 204' }));
    const { rows, repository } = fakeRuns();
    await runAutomations({
      automations: [automation({ condition: 'The review is clean', max_runs: 1 })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('webhook', executed)),
      conditionAnswers: new Map([['a1', { met: false, reason: 'Two findings need a decision.' }]]),
    });
    expect(executed).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      status: 'skipped',
      detail: 'Condition not met: Two findings need a decision.',
      condition: { met: false },
    });
    // A no spends nothing of the Frequency.
    expect(repository.countRuns('a1', 'task-1')).toBe(0);
  });

  it('checks the group once, only for rows that could run', async () => {
    const checkConditions = vi.fn(async (rows: ColumnAutomation[]) => ({
      ok: true as const,
      answers: new Map(rows.map((row) => [row.id, { met: true, reason: null }])),
    }));
    const { repository } = fakeRuns({ spent: 1 });
    await runAutomations({
      automations: [
        automation({ id: 'first', condition: 'One' }),
        automation({ id: 'plain' }),
        automation({ id: 'spent', condition: 'Two', max_runs: 1 }),
        automation({ id: 'second', condition: 'Three' }),
      ],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('webhook', async () => ({ detail: 'ok' }))),
      checkConditions,
    });
    expect(checkConditions).toHaveBeenCalledTimes(1);
    expect(checkConditions.mock.calls[0][0].map((row) => row.id)).toEqual(['first', 'second']);
  });

  it('skips a row with a Condition that could not be checked, and runs the others', async () => {
    const executed = vi.fn(async () => ({ detail: 'ok' }));
    const { rows, repository } = fakeRuns();
    await runAutomations({
      automations: [automation({ id: 'guarded', condition: 'Tests pass' }), automation({ id: 'plain' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('webhook', executed)),
      checkConditions: async () => ({ ok: false, reason: 'Set up an Automation agent in Settings > Workflows to check this condition.' }),
    });
    expect(executed).toHaveBeenCalledTimes(1);
    expect(rows.find((row) => row.automationId === 'guarded')).toMatchObject({
      status: 'skipped',
      detail: 'Set up an Automation agent in Settings > Workflows to check this condition.',
    });
    expect(rows.find((row) => row.automationId === 'plain')?.status).toBe('succeeded');
  });

  it('treats a blank or missing Condition as none', () => {
    expect(hasCondition({ condition: null })).toBe(false);
    expect(hasCondition({ condition: '   ' })).toBe(false);
    expect(hasCondition({} as { condition: string | null })).toBe(false);
    expect(hasCondition({ condition: 'Tests pass' })).toBe(true);
  });
});

// Enter and exit groups run inside the move's task lock, so the one Condition
// check they make is bounded: the group's own budget, else
// CONDITION_CHECK_WAIT_MS, and the move's own abort. Without the bound a slow
// Automation agent, or a queue of turn-end checks ahead of it, held that
// task's lock for minutes.
describe('the bound on a group Condition check', () => {
  /** Run one group with a guarded row and return the limits its single check was given. */
  async function limitsGiven(
    trigger: 'enter' | 'exit',
    options: { groupBudgetMs?: number; signal?: AbortSignal } = {},
  ): Promise<ConditionCheckLimits> {
    const checkConditions = vi.fn(async (rows: ColumnAutomation[], _limits: ConditionCheckLimits): Promise<ConditionCheckResult> => ({
      ok: true,
      answers: new Map(rows.map((row) => [row.id, { met: true, reason: null }])),
    }));
    const { repository } = fakeRuns();
    await runAutomations({
      automations: [automation({ id: 'guarded', trigger, condition: 'Tests pass' })],
      column: COLUMN,
      context: context(trigger),
      runs: repository,
      signal: options.signal ?? new AbortController().signal,
      groupBudgetMs: options.groupBudgetMs,
      registry: registryOf(adapter('webhook', async () => ({ detail: 'ok' }))),
      checkConditions,
    });
    expect(checkConditions).toHaveBeenCalledTimes(1);
    return checkConditions.mock.calls[0][1];
  }

  it('gives an exit group no more than its group budget', async () => {
    const limits = await limitsGiven('exit');

    expect(limits.timeoutMs).toBeGreaterThan(0);
    expect(limits.timeoutMs).toBeLessThanOrEqual(EXIT_GROUP_BUDGET_MS);
    expect(limits.timeoutMs).toBeLessThanOrEqual(CONDITION_CHECK_WAIT_MS);
  });

  it('gives a group the time left of a tighter budget it was handed', async () => {
    const limits = await limitsGiven('exit', { groupBudgetMs: 10_000 });

    expect(limits.timeoutMs).toBeGreaterThan(9_000);
    expect(limits.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  // EXIT_GROUP_BUDGET_MS and CONDITION_CHECK_WAIT_MS are both 60 s today, so a
  // budget that is looser than either is the case that tells the two caps apart.
  it.each(['enter', 'exit'] as const)('caps a %s group at CONDITION_CHECK_WAIT_MS however loose its budget', async (trigger) => {
    const limits = await limitsGiven(trigger, { groupBudgetMs: 120_000 });

    expect(limits.timeoutMs).toBe(CONDITION_CHECK_WAIT_MS);
  });

  it('gives an enter group with no budget of its own CONDITION_CHECK_WAIT_MS', async () => {
    const limits = await limitsGiven('enter');

    expect(limits.timeoutMs).toBe(CONDITION_CHECK_WAIT_MS);
  });

  it('hands the check the group\'s own signal, so a superseded move stops the wait', async () => {
    const groupController = new AbortController();

    const limits = await limitsGiven('enter', { signal: groupController.signal });

    expect(limits.signal).toBe(groupController.signal);
  });
});

describe('a row that ends its group', () => {
  it('stops the list after a Move to column row runs, even when its own move aborted the signal', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const { rows, repository } = fakeRuns();
    const summary = await runAutomations({
      automations: [
        automation({ id: 'notify-first', type: 'notify' }),
        automation({ id: 'move', type: 'move_to_column', config: { targetColumn: 'Executing' } }),
        automation({ id: 'after', type: 'webhook' }),
      ],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: controller.signal,
      registry: registryOf(
        adapter('notify', async () => { order.push('notify'); return { detail: 'Shown' }; }),
        adapter('move_to_column', async () => {
          order.push('move');
          // The move a row makes supersedes the group's other work; the runner
          // must still record this row as having run and stop cleanly.
          controller.abort();
          return { detail: 'Moved to Executing.' };
        }),
        adapter('webhook', async () => { order.push('webhook'); return { detail: 'HTTP 204' }; }),
      ),
    });
    expect(order).toEqual(['notify', 'move']);
    expect(summary.endedGroup).toBe(true);
    expect(rows.map((row) => [row.automationId, row.status])).toEqual([
      ['notify-first', 'succeeded'],
      ['move', 'succeeded'],
    ]);
  });
});
