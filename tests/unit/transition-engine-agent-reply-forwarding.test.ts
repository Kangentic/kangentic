/**
 * The engine hands the agent's final message to the automation runner.
 *
 * A Text match is checked in code against the last line of the agent's final
 * message, and the runner reads that message from `RunAutomationsOptions.agentReply`.
 * The only thing that puts it there is `TransitionEngine.runAutomationGroup`
 * (src/main/transition-engine/transition-engine.ts), which every way into an
 * automation group shares: `executeTransition` for a turn-end group and
 * `executeSingleAutomation` for a Run again. The runner's own tests hand it
 * `agentReply` directly, and the Run again tests mock the engine, so a forward
 * that was dropped here would fail neither: every Text match row would skip with
 * "checked only at an agent turn end" on a real turn end.
 *
 * This drives a REAL engine over a real database and reads the run rows it
 * wrote, with a cheap `notify` row (no agent, no timeout, no retry) so the only
 * thing under test is the forward. The three cases each fail on a different
 * regression: a dropped forward, a missing reply read as a turn end, and a null
 * reply coerced to "no turn end".
 *
 * Tier: Unit (real better-sqlite3, in memory).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import type { ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

const TASK_ID = 'task-final-line-1';
const FINAL_LINE = 'Verdict: Ready';

describe('TransitionEngine forwards the agent reply to the runner', () => {
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;
  let column: Swimlane;
  let task: Task;
  let textMatchRow: ColumnAutomation;
  let showNotification: ReturnType<typeof vi.fn>;
  let engine: TransitionEngine;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);

    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.name === 'Executing');
    if (!lane) throw new Error('The seeded board has no Executing column');
    column = lane;

    // automation_runs.task_id is a real foreign key, so the task row has to exist.
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(TASK_ID, 'Review the change', '', column.id, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    task = {
      id: TASK_ID,
      display_id: 7,
      title: 'Review the change',
      description: '',
      swimlane_id: column.id,
      position: 0,
      agent: 'claude',
      session_id: 'pty-1',
      worktree_path: null,
      branch_name: null,
      labels: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } as unknown as Task;

    const automations = new AutomationRepository(database);
    runs = new AutomationRunRepository(database);
    textMatchRow = automations.replaceForColumn(column.id, [{
      name: 'Ready ping',
      type: 'notify',
      trigger: 'turn_end',
      enabled: true,
      config: { title: 'Ready', body: 'The review finished' },
      final_line: FINAL_LINE,
    }])[0];

    showNotification = vi.fn();
    engine = new TransitionEngine(
      {} as never,
      {} as never,
      { getById: vi.fn(() => task) } as never,
      () => ({
        projectId: 'project-1',
        projectPath: '/mock/main-project',
        projectName: 'Mock Project',
        gitConfig: { defaultBaseBranch: 'main' },
      }) as never,
      undefined,
      { getPathsForTask: vi.fn(() => []) } as never,
      automations,
      runs,
    );
  });

  afterEach(() => {
    database.close();
  });

  function singleRunOptions(agentReply?: string | null) {
    return {
      signal: new AbortController().signal,
      deliverToAgent: async (): Promise<void> => undefined,
      showNotification,
      ...(agentReply === undefined ? {} : { agentReply }),
    };
  }

  describe('executeSingleAutomation (Run again on a turn-end row)', () => {
    it('judges the Text match against the reply it was given, and runs the row on a match', async () => {
      const summary = await engine.executeSingleAutomation(
        task,
        column,
        textMatchRow,
        singleRunOptions('The review is done.\n\nVerdict: Ready'),
      );

      expect(summary.outcomes).toHaveLength(1);
      expect(summary.outcomes[0].status).toBe('succeeded');
      expect(showNotification).toHaveBeenCalledTimes(1);
      const recorded = runs.listForTask(TASK_ID);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ status: 'succeeded', final_line_met: true });
      expect(recorded[0].final_line_reason).toContain('Verdict: Ready');
    });

    it('skips a reply whose last line does not match, so the forwarded text is the one judged', async () => {
      const summary = await engine.executeSingleAutomation(
        task,
        column,
        textMatchRow,
        singleRunOptions('Verdict: Ready\n\nOne more thing to fix.'),
      );

      expect(summary.outcomes[0].status).toBe('skipped');
      expect(showNotification).not.toHaveBeenCalled();
      expect(runs.listForTask(TASK_ID)[0]).toMatchObject({ status: 'skipped', final_line_met: false });
    });

    it('skips with the turn-end-only reason when no reply is given at all', async () => {
      const summary = await engine.executeSingleAutomation(task, column, textMatchRow, singleRunOptions());

      expect(summary.outcomes).toHaveLength(1);
      expect(summary.outcomes[0].status).toBe('skipped');
      expect(summary.outcomes[0].detail).toBe('A text match is checked only at an agent turn end.');
      expect(showNotification).not.toHaveBeenCalled();
      const recorded = runs.listForTask(TASK_ID);
      expect(recorded[0]).toMatchObject({
        status: 'skipped',
        detail: 'A text match is checked only at an agent turn end.',
        final_line_met: null,
      });
    });

    it('keeps a null reply null: a turn end with no readable message, not "no turn end"', async () => {
      // The engine leaves an absent reply undefined (enter and exit have no final
      // message) and passes null through (a turn end whose message could not be
      // read). Coercing null to undefined would read as the first and report the
      // wrong reason.
      const summary = await engine.executeSingleAutomation(task, column, textMatchRow, singleRunOptions(null));

      expect(summary.outcomes[0].status).toBe('skipped');
      expect(summary.outcomes[0].detail).toContain('The turn ended without a message Kangentic could read.');
      expect(summary.outcomes[0].detail).not.toContain('checked only at an agent turn end');
      expect(showNotification).not.toHaveBeenCalled();
      expect(runs.listForTask(TASK_ID)[0]).toMatchObject({ status: 'skipped', final_line_met: false });
    });
  });

  describe('executeTransition (the turn-end group)', () => {
    function groupOptions(agentReply?: string | null) {
      return {
        signal: new AbortController().signal,
        deliverToAgent: async (): Promise<void> => undefined,
        showNotification,
        ...(agentReply === undefined ? {} : { agentReply }),
      };
    }

    it('runs a Text match row when the turn end hands it a matching reply', async () => {
      const summary = await engine.executeTransition(task, column, 'turn_end', groupOptions('All fixed.\nVerdict: Ready'));

      expect(summary.outcomes).toHaveLength(1);
      expect(summary.outcomes[0].status).toBe('succeeded');
      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(runs.listForTask(TASK_ID)[0]).toMatchObject({ status: 'succeeded', final_line_met: true });
    });

    it('skips the row with the turn-end-only reason when the group carries no reply', async () => {
      const summary = await engine.executeTransition(task, column, 'turn_end', groupOptions());

      expect(summary.outcomes[0].status).toBe('skipped');
      expect(summary.outcomes[0].detail).toBe('A text match is checked only at an agent turn end.');
      expect(showNotification).not.toHaveBeenCalled();
    });
  });
});
