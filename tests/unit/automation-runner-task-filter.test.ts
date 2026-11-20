/**
 * A row's Task lines (#872): a row whose filter the task does not match is not
 * for that task, so the runner drops it before anything else. It records no run
 * row, spends no Frequency, and is never handed to the Condition check.
 */
import { describe, it, expect, vi } from 'vitest';
import { runAutomations } from '../../src/main/automations/automation-runner';
import { hasGuard, rowMatchesTaskFilter } from '../../src/main/automations/row-guards';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';
import type { AutomationAdapter, AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import type { AutomationRunStatus, ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

const COLUMN = { id: 'lane-review', name: 'Code Review', role: null, position: 3, auto_spawn: true } as Swimlane;

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
    final_line: null,
    filter: null,
    max_runs: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Every run row the runner wrote, whatever its status. */
function fakeRuns() {
  const rows: Array<{ automationId: string; status: AutomationRunStatus }> = [];
  const repository = {
    start: (input: { automation: { id: string } }) => { rows.push({ automationId: input.automation.id, status: 'running' }); },
    finish: (id: string, status: AutomationRunStatus) => {
      const row = rows.at(-1);
      if (row) row.status = status;
      void id;
    },
    recordSkipped: (input: { automation: { id: string } }) => { rows.push({ automationId: input.automation.id, status: 'skipped' }); },
    recordDeliveredByCaller: () => {},
    countRuns: () => 0,
  };
  return { rows, repository: repository as unknown as AutomationRunRepository };
}

function contextFor(task: Partial<Task>): Omit<AutomationContext, 'runId' | 'signal'> {
  return {
    task: { id: 'task-1', title: 'A task', session_id: 'session-1', priority: 0, labels: [], ...task } as Task,
    column: COLUMN,
    fromColumn: null,
    toColumn: null,
    trigger: 'turn_end',
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

function registryWith(execute: AutomationAdapter['execute']): AutomationRegistry {
  const registry = new AutomationRegistry();
  registry.register({ id: 'webhook', manifest: AUTOMATION_MANIFEST.webhook, describe: () => 'test', execute });
  return registry;
}

async function runFor(task: Partial<Task>, automations: ColumnAutomation[]) {
  const executed = vi.fn(async () => ({ detail: 'HTTP 204' }));
  const checkConditions = vi.fn(async (rows: ColumnAutomation[]) => ({
    ok: true as const,
    answers: new Map(rows.map((row) => [row.id, { met: true, reason: null }])),
  }));
  const { rows, repository } = fakeRuns();
  await runAutomations({
    automations,
    column: COLUMN,
    context: contextFor(task),
    runs: repository,
    signal: new AbortController().signal,
    registry: registryWith(executed),
    checkConditions,
  });
  return { executed, checkConditions, rows };
}

describe('a row with Task lines', () => {
  const urgentBugs = { priorities: [4], labels: ['bug'] };

  it('records no run and asks no Condition when the task does not match', async () => {
    const { executed, checkConditions, rows } = await runFor(
      { priority: 1, labels: ['bug'] },
      [automation({ id: 'filtered', condition: 'The review is clean', filter: urgentBugs })],
    );

    expect(executed).not.toHaveBeenCalled();
    expect(checkConditions).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it('runs when the task matches both lists', async () => {
    const { executed, rows } = await runFor(
      { priority: 4, labels: ['bug', 'ui'] },
      [automation({ id: 'filtered', filter: urgentBugs })],
    );

    expect(executed).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ automationId: 'filtered', status: 'succeeded' }]);
  });

  it('drops only the rows the task does not match, and passes the rest to the Condition check', async () => {
    const { executed, checkConditions, rows } = await runFor(
      { priority: 4, labels: [] },
      [
        automation({ id: 'wrong-label', condition: 'One', filter: urgentBugs }),
        automation({ id: 'right-priority', condition: 'Two', filter: { priorities: [4], labels: [] } }),
        automation({ id: 'no-filter', condition: 'Three' }),
      ],
    );

    expect(checkConditions).toHaveBeenCalledTimes(1);
    expect(checkConditions.mock.calls[0][0].map((row) => row.id)).toEqual(['right-priority', 'no-filter']);
    expect(executed).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.automationId)).toEqual(['right-priority', 'no-filter']);
  });

  it('runs a row with no filter for every task, including one with no labels', async () => {
    for (const task of [{ priority: 0, labels: [] }, { priority: 4, labels: ['bug'] }, { priority: 2, labels: null as unknown as string[] }]) {
      const { executed } = await runFor(task, [automation({ filter: null })]);
      expect(executed).toHaveBeenCalledTimes(1);
    }
  });
});

describe('row guards for Task lines', () => {
  it('counts a filter as a guard, and an empty one as none', () => {
    const base = { condition: null, final_line: null, trigger: 'turn_end', max_runs: null } as const;
    expect(hasGuard({ ...base, filter: { priorities: [], labels: ['bug'] } })).toBe(true);
    expect(hasGuard({ ...base, filter: { priorities: [], labels: [] } })).toBe(false);
    expect(hasGuard({ ...base, filter: null })).toBe(false);
    expect(hasGuard(base)).toBe(false);
  });

  it('matches a task against the row filter', () => {
    const row = { filter: { priorities: [3], labels: [] } };
    expect(rowMatchesTaskFilter(row, { priority: 3, labels: null })).toBe(true);
    expect(rowMatchesTaskFilter(row, { priority: 2, labels: null })).toBe(false);
    expect(rowMatchesTaskFilter({}, { priority: 2, labels: null })).toBe(true);
  });
});
