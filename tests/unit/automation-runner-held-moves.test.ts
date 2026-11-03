/**
 * The runner's held-move options (a running workflow's turn end with
 * background work still open).
 *
 * - `holdMoves`: a row that ends the group (Move to column), whose guards
 *   passed, is recorded skipped with the given reason and NOT run. The summary
 *   names it (`heldMoveRowId`). Rows that do not move the task still run.
 * - `releaseHeldMoves`: a row held earlier runs now without its Text match or
 *   Condition being checked again.
 */
import { describe, it, expect, vi } from 'vitest';
import { runAutomations } from '../../src/main/automations/automation-runner';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';
import type { AutomationAdapter, AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import type { AutomationRunStatus, AutomationType, ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

const COLUMN = {
  id: 'lane-review',
  name: 'Code Review',
  role: null,
  position: 3,
  auto_spawn: true,
} as Swimlane;

const HOLD_REASON = 'Background work is still open, so the move waits.';

function automation(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'a1',
    swimlane_id: COLUMN.id,
    name: 'Row',
    type: 'move_to_column',
    trigger: 'turn_end',
    position: 0,
    enabled: true,
    config: { targetColumn: 'Executing' },
    condition: null,
    final_line: null,
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
}

interface StartedRun {
  id: string;
  automation: { id: string };
}

function fakeRuns() {
  const rows: RecordedRun[] = [];
  const repository = {
    start: (input: StartedRun) => {
      rows.push({ id: input.id, automationId: input.automation.id, status: 'running', detail: null });
    },
    finish: (id: string, status: AutomationRunStatus, detail: string | null) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) Object.assign(row, { status, detail });
    },
    recordSkipped: (input: StartedRun, reason: string) => {
      rows.push({ id: input.id, automationId: input.automation.id, status: 'skipped', detail: reason });
    },
    recordDeliveredByCaller: () => {},
    countRuns: () => 0,
  };
  return { rows, repository: repository as unknown as AutomationRunRepository };
}

function context(): Omit<AutomationContext, 'runId' | 'signal'> {
  return {
    task: { id: 'task-1', title: 'A task', session_id: 'session-1' } as Task,
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

function adapter(id: AutomationType, execute: AutomationAdapter['execute']): AutomationAdapter {
  return { id, manifest: AUTOMATION_MANIFEST[id], describe: () => 'test', execute };
}

function registryOf(...adapters: AutomationAdapter[]): AutomationRegistry {
  const registry = new AutomationRegistry();
  for (const entry of adapters) registry.register(entry);
  return registry;
}

describe('holdMoves', () => {
  it('records a passing Move to column row as skipped with the reason, names it, and never moves', async () => {
    const move = vi.fn(async () => ({ detail: 'Moved to Executing.' }));
    const { rows, repository } = fakeRuns();
    const summary = await runAutomations({
      automations: [automation({ id: 'move' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('move_to_column', move)),
      holdMoves: HOLD_REASON,
    });
    expect(move).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ automationId: 'move', status: 'skipped', detail: HOLD_REASON });
    expect(summary.heldMoveRowId).toBe('move');
    expect(summary.endedGroup).toBeUndefined();
  });

  it('still runs a row that does not end the group', async () => {
    const send = vi.fn(async () => ({ detail: 'Delivered' }));
    const { rows, repository } = fakeRuns();
    const summary = await runAutomations({
      automations: [automation({ id: 'message', type: 'send_message', config: { message: 'Keep going' } })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('send_message', send)),
      holdMoves: HOLD_REASON,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ automationId: 'message', status: 'succeeded' });
    expect(summary.heldMoveRowId).toBeUndefined();
  });
});

describe('releaseHeldMoves', () => {
  const guardedMove = (): ColumnAutomation => automation({
    id: 'move',
    final_line: 'Verdict: Ready',
    condition: 'The tests pass',
  });

  it('runs a released row even when its Text match misses and its Condition answered no', async () => {
    const move = vi.fn(async () => ({ detail: 'Moved to Executing.' }));
    const { rows, repository } = fakeRuns();
    const summary = await runAutomations({
      automations: [guardedMove()],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('move_to_column', move)),
      agentReply: 'Still working on it.',
      conditionAnswers: new Map([['move', { met: false, reason: 'Tests fail.' }]]),
      releaseHeldMoves: new Set(['move']),
    });
    expect(move).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ automationId: 'move', status: 'succeeded' });
    expect(summary.endedGroup).toBe(true);
  });

  it('control: the same row not released is skipped by its Text match', async () => {
    const move = vi.fn(async () => ({ detail: 'Moved to Executing.' }));
    const { rows, repository } = fakeRuns();
    await runAutomations({
      automations: [guardedMove()],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry: registryOf(adapter('move_to_column', move)),
      agentReply: 'Still working on it.',
      conditionAnswers: new Map([['move', { met: false, reason: 'Tests fail.' }]]),
    });
    expect(move).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('skipped');
  });
});
