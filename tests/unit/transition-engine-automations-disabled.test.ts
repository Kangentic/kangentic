/**
 * `TransitionEngine.executeTransition` and a task whose automations the user
 * disabled (src/main/transition-engine/transition-engine.ts).
 *
 * The task switch is the one gate every group shares: On task enter, On agent
 * turn end and On task exit all reach the runner through `executeTransition`. A
 * disabled task gets one skipped run record per row, with the reason, and the
 * runner is never entered: no adapter executes, no agent starts, no message is
 * delivered. The gate reads the task FRESH from the repository rather than from
 * the object the caller holds, because a turn end's object predates its paint
 * wait and its Condition check, and a move out of Done clears the switch after
 * the caller read the task.
 *
 * `executeSingleAutomation` (Run again) is deliberately NOT gated: pressing Run
 * again on a row is an explicit act, and it is the way a user runs one row of a
 * held task. The runner itself stays ungated for the same reason
 * (.claude/rules/automation-adapters.md).
 *
 * Drives a REAL engine over a real database with real repositories, so the run
 * rows asserted here are what the run log would show. `notify` rows are the
 * cheap rows that execute (no agent, no timeout, no retry); a `send_message`
 * row on a task with no session is the one that makes the runner call
 * `startAgent`, which is what gives "no agent starts" its teeth.
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
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import { SENT_WITH_THE_MOVE } from '../../src/main/automations/automation-runner';
import { AUTOMATIONS_DISABLED_REASON } from '../../src/shared/automation-manifest';
import type { AutomationTrigger, ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

describe('TransitionEngine and a task with its automations disabled', () => {
  let database: DatabaseType.Database;
  let tasks: TaskRepository;
  let runs: AutomationRunRepository;
  let automations: AutomationRepository;
  let column: Swimlane;
  let emptyColumn: Swimlane;
  let rowsByTrigger: Record<AutomationTrigger, ColumnAutomation[]>;
  let engine: TransitionEngine;
  let showNotification: ReturnType<typeof vi.fn>;
  let deliverToAgent: ReturnType<typeof vi.fn>;
  let startAgent: ReturnType<typeof vi.fn>;
  let legacySpawnAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);

    const lanes = new SwimlaneRepository(database).list();
    const executing = lanes.find((lane) => lane.name === 'Executing');
    if (!executing) throw new Error('The seeded board has no Executing column');
    column = executing;
    // A column with no automations at all: the empty-group early return.
    emptyColumn = lanes.find((lane) => lane.role === null && lane.id !== column.id)!;

    tasks = new TaskRepository(database);
    runs = new AutomationRunRepository(database);
    automations = new AutomationRepository(database);

    // Two rows on every trigger, so "one skip per row" can be told from "one
    // skip per group". The send_message rows are the ones that make the runner
    // call `startAgent` (enter) for a task with no session.
    const written = automations.replaceForColumn(column.id, [
      { name: 'Enter ping', type: 'notify', trigger: 'enter', enabled: true, config: { title: 'Entered', body: 'In the column' } },
      { name: 'Enter message', type: 'send_message', trigger: 'enter', enabled: true, config: { message: 'Start on this', mode: 'immediate' } },
      { name: 'Turn end ping', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'Turn ended', body: 'Done' } },
      { name: 'Turn end ping two', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'Turn ended again', body: 'Done' } },
      { name: 'Exit ping', type: 'notify', trigger: 'exit', enabled: true, config: { title: 'Leaving', body: 'Out of the column' } },
      { name: 'Exit ping two', type: 'notify', trigger: 'exit', enabled: true, config: { title: 'Leaving again', body: 'Out of the column' } },
    ]);
    rowsByTrigger = {
      enter: written.filter((row) => row.trigger === 'enter'),
      turn_end: written.filter((row) => row.trigger === 'turn_end'),
      exit: written.filter((row) => row.trigger === 'exit'),
    };

    showNotification = vi.fn();
    deliverToAgent = vi.fn(async (): Promise<void> => undefined);
    startAgent = vi.fn(async (): Promise<void> => undefined);
    legacySpawnAgent = vi.fn(async (): Promise<void> => undefined);
    engine = new TransitionEngine(
      {} as never,
      {} as never,
      tasks,
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

  /** A task in the Executing column with no session, optionally with its automations disabled. */
  function createTask(automationsDisabled: boolean): Task {
    return tasks.create({
      title: 'Hold this one',
      description: '',
      swimlane_id: column.id,
      ...(automationsDisabled ? { automations_disabled: true } : {}),
    });
  }

  function groupOptions(extra: { onlyIds?: ReadonlySet<string>; alreadyDelivered?: ReadonlySet<string> } = {}) {
    return {
      signal: new AbortController().signal,
      startAgent,
      deliverToAgent,
      legacySpawnAgent,
      showNotification,
      ...extra,
    };
  }

  describe.each(['enter', 'turn_end', 'exit'] as const)('the %s group of a disabled task', (trigger) => {
    it('records exactly one skip per row with the reason, and reports every outcome as skipped', async () => {
      const task = createTask(true);
      const rows = rowsByTrigger[trigger];
      expect(rows).toHaveLength(2);

      const summary = await engine.executeTransition(task, column, trigger, groupOptions());

      expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'skipped']);
      expect(summary.outcomes.map((outcome) => outcome.detail)).toEqual([AUTOMATIONS_DISABLED_REASON, AUTOMATIONS_DISABLED_REASON]);
      expect(summary.outcomes.map((outcome) => outcome.automationId)).toEqual(rows.map((row) => row.id));
      expect(summary.outcomes.map((outcome) => outcome.name)).toEqual(rows.map((row) => row.name));
      expect(summary.outcomes.every((outcome) => outcome.columnName === column.name)).toBe(true);
      expect(summary.failures).toEqual([]);
      expect(summary.startedAgent).toBe(false);

      // The run log, read back: one record per row, none succeeded.
      const recorded = runs.listForTask(task.id);
      expect(recorded).toHaveLength(2);
      expect(recorded.every((run) => run.status === 'skipped')).toBe(true);
      expect(recorded.every((run) => run.detail === AUTOMATIONS_DISABLED_REASON)).toBe(true);
      expect(recorded.every((run) => run.trigger === trigger)).toBe(true);
      expect(recorded.map((run) => run.automation_id).sort()).toEqual(rows.map((row) => row.id).sort());
    });

    it('runs no adapter, starts no agent and delivers no message', async () => {
      const task = createTask(true);

      await engine.executeTransition(task, column, trigger, groupOptions());

      expect(showNotification).not.toHaveBeenCalled();
      expect(deliverToAgent).not.toHaveBeenCalled();
      expect(startAgent).not.toHaveBeenCalled();
      expect(legacySpawnAgent).not.toHaveBeenCalled();
    });

    it('records only the rows it is told to run when the caller narrows the group', async () => {
      const task = createTask(true);
      const [firstRow, secondRow] = rowsByTrigger[trigger];

      const summary = await engine.executeTransition(task, column, trigger, groupOptions({ onlyIds: new Set([secondRow.id]) }));

      expect(summary.outcomes.map((outcome) => outcome.automationId)).toEqual([secondRow.id]);
      const recorded = runs.listForTask(task.id);
      expect(recorded.map((run) => run.automation_id)).toEqual([secondRow.id]);
      expect(recorded.some((run) => run.automation_id === firstRow.id)).toBe(false);
    });
  });

  // A warm move types the column's message into the live session BEFORE it hands
  // the enter group to the engine (the move names that row `alreadyDelivered`),
  // and the user can have thrown the switch in between. That message went out, so
  // its run record says it was sent, the way the runner records it, rather than
  // claiming a skip for a message the agent already received. Every other row of
  // the group is still held.
  describe('the enter group of a disabled task whose move already typed a row', () => {
    /** The persisted run for one row, looked up by automation id (two runs can share a timestamp). */
    function recordedRunFor(taskId: string, automationId: string) {
      const matching = runs.listForTask(taskId).filter((run) => run.automation_id === automationId);
      expect(matching).toHaveLength(1);
      return matching[0];
    }

    it.each([
      { label: 'the first row', deliveredIndex: 0, heldIndex: 1 },
      { label: 'the second row', deliveredIndex: 1, heldIndex: 0 },
    ])('records $label as sent with the move and the other as skipped with the reason', async ({ deliveredIndex, heldIndex }) => {
      const task = createTask(true);
      const rows = rowsByTrigger.enter;
      expect(rows).toHaveLength(2);
      const delivered = rows[deliveredIndex];
      const held = rows[heldIndex];

      const summary = await engine.executeTransition(task, column, 'enter', groupOptions({ alreadyDelivered: new Set([delivered.id]) }));

      // The outcomes, in the group's order.
      expect(summary.outcomes.map((outcome) => outcome.automationId)).toEqual(rows.map((row) => row.id));
      const deliveredOutcome = summary.outcomes.find((outcome) => outcome.automationId === delivered.id)!;
      const heldOutcome = summary.outcomes.find((outcome) => outcome.automationId === held.id)!;
      expect(deliveredOutcome).toMatchObject({ status: 'succeeded', detail: SENT_WITH_THE_MOVE, columnName: column.name });
      expect(heldOutcome).toMatchObject({ status: 'skipped', detail: AUTOMATIONS_DISABLED_REASON, columnName: column.name });
      expect(summary.failures).toEqual([]);
      expect(summary.startedAgent).toBe(false);

      // The run log, read back: one record per row, matching its outcome.
      expect(runs.listForTask(task.id)).toHaveLength(2);
      const deliveredRun = recordedRunFor(task.id, delivered.id);
      const heldRun = recordedRunFor(task.id, held.id);
      expect(deliveredRun).toMatchObject({ id: deliveredOutcome.runId, status: 'succeeded', detail: SENT_WITH_THE_MOVE, attempts: 1, trigger: 'enter' });
      expect(heldRun).toMatchObject({ id: heldOutcome.runId, status: 'skipped', detail: AUTOMATIONS_DISABLED_REASON, attempts: 0, trigger: 'enter' });

      // Held means held: no adapter ran for either row, so the delivered row is
      // not typed a second time and the other one never ran.
      expect(showNotification).not.toHaveBeenCalled();
      expect(deliverToAgent).not.toHaveBeenCalled();
      expect(startAgent).not.toHaveBeenCalled();
      expect(legacySpawnAgent).not.toHaveBeenCalled();
    });

    it('records every row as skipped when the move delivered none', async () => {
      const task = createTask(true);

      const summary = await engine.executeTransition(task, column, 'enter', groupOptions({ alreadyDelivered: new Set<string>() }));

      expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'skipped']);
      expect(runs.listForTask(task.id).every((run) => run.detail === AUTOMATIONS_DISABLED_REASON)).toBe(true);
    });

    it('ignores an id that names no row of the group', async () => {
      const task = createTask(true);

      const summary = await engine.executeTransition(task, column, 'enter', groupOptions({ alreadyDelivered: new Set(['not-a-row-of-this-group']) }));

      expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'skipped']);
      expect(runs.listForTask(task.id).some((run) => run.detail === SENT_WITH_THE_MOVE)).toBe(false);
    });
  });

  describe('the enabled controls', () => {
    // Each gate test above is only meaningful if the same group does run for an
    // enabled task. These are the paired halves.
    it.each(['turn_end', 'exit'] as const)('runs both %s rows for an enabled task', async (trigger) => {
      const task = createTask(false);

      const summary = await engine.executeTransition(task, column, trigger, groupOptions());

      expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['succeeded', 'succeeded']);
      expect(showNotification).toHaveBeenCalledTimes(2);
      expect(runs.listForTask(task.id).every((run) => run.status === 'succeeded')).toBe(true);
    });

    it('starts the agent for an enabled task whose enter group has a message row and no session', async () => {
      const task = createTask(false);

      const summary = await engine.executeTransition(task, column, 'enter', groupOptions());

      expect(startAgent).toHaveBeenCalledTimes(1);
      expect(summary.startedAgent).toBe(true);
      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(runs.listForTask(task.id).some((run) => run.detail === AUTOMATIONS_DISABLED_REASON)).toBe(false);
    });
  });

  describe('a column with nothing to run', () => {
    it('records nothing for a disabled task, since there is no row to skip', async () => {
      const task = createTask(true);

      const summary = await engine.executeTransition(task, emptyColumn, 'enter', groupOptions());

      expect(summary.outcomes).toEqual([]);
      expect(runs.listForTask(task.id)).toEqual([]);
    });
  });

  describe('the gate reads the task fresh', () => {
    it('skips the group when the caller\'s object says enabled but the stored row says disabled', async () => {
      const task = createTask(false);
      tasks.update({ id: task.id, automations_disabled: true });
      // What a turn end holds: read before the user threw the switch.
      const staleEnabled: Task = { ...task, automations_disabled: false };
      expect(staleEnabled.automations_disabled).toBe(false);
      expect(tasks.getById(task.id)!.automations_disabled).toBe(true);

      const summary = await engine.executeTransition(staleEnabled, column, 'exit', groupOptions());

      expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'skipped']);
      expect(summary.outcomes.map((outcome) => outcome.detail)).toEqual([AUTOMATIONS_DISABLED_REASON, AUTOMATIONS_DISABLED_REASON]);
      expect(showNotification).not.toHaveBeenCalled();
      expect(runs.listForTask(task.id)).toHaveLength(2);
    });

    it('runs the group when the caller\'s object says disabled but the stored row says enabled', async () => {
      // A move out of Done cleared the switch after the caller read the task.
      const task = createTask(true);
      const staleDisabled: Task = { ...task };
      tasks.update({ id: task.id, automations_disabled: false });
      expect(staleDisabled.automations_disabled).toBe(true);
      expect(tasks.getById(task.id)!.automations_disabled).toBe(false);

      const summary = await engine.executeTransition(staleDisabled, column, 'exit', groupOptions());

      expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['succeeded', 'succeeded']);
      expect(showNotification).toHaveBeenCalledTimes(2);
      expect(runs.listForTask(task.id).some((run) => run.detail === AUTOMATIONS_DISABLED_REASON)).toBe(false);
    });

    it('picks up a switch thrown between two groups for the same task', async () => {
      const task = createTask(false);

      const before = await engine.executeTransition(task, column, 'turn_end', groupOptions());
      tasks.update({ id: task.id, automations_disabled: true });
      const after = await engine.executeTransition(task, column, 'exit', groupOptions());

      expect(before.outcomes.map((outcome) => outcome.status)).toEqual(['succeeded', 'succeeded']);
      expect(after.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'skipped']);
    });

    // Off, then on, then a move. The switch turned back on anywhere on the board
    // takes effect at the next move's On task enter rows.
    it('runs the enter group on the next move after the switch is turned back on', async () => {
      const task = createTask(true);

      const whileOff = await engine.executeTransition(task, column, 'enter', groupOptions());
      tasks.update({ id: task.id, automations_disabled: false });
      // The next move into the column, still holding the object it read while off.
      const afterOn = await engine.executeTransition(task, column, 'enter', groupOptions());

      expect(whileOff.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'skipped']);
      expect(afterOn.outcomes.some((outcome) => outcome.detail === AUTOMATIONS_DISABLED_REASON)).toBe(false);
      expect(afterOn.startedAgent).toBe(true);
      expect(startAgent).toHaveBeenCalledTimes(1);
      expect(showNotification).toHaveBeenCalledTimes(1);
    });

    it('runs a row limited to one run on that move, because the skip from the off period spent none of its Frequency', async () => {
      const [limitedRow] = automations.replaceForColumn(column.id, [
        { name: 'Enter once', type: 'notify', trigger: 'enter', enabled: true, config: { title: 'Entered', body: 'Once' }, max_runs: 1 },
      ]);
      const task = createTask(true);

      await engine.executeTransition(task, column, 'enter', groupOptions());
      tasks.update({ id: task.id, automations_disabled: false });
      const afterOn = await engine.executeTransition(task, column, 'enter', groupOptions());

      expect(afterOn.outcomes.map((outcome) => outcome.status)).toEqual(['succeeded']);
      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(runs.countRuns(limitedRow.id, task.id)).toBe(1);
    });
  });

  describe('executeSingleAutomation (Run again) is not gated', () => {
    it('still runs a row for a task that is disabled in the caller\'s object and in the stored row', async () => {
      const task = createTask(true);
      expect(tasks.getById(task.id)!.automations_disabled).toBe(true);
      const [exitRow] = rowsByTrigger.exit;

      const summary = await engine.executeSingleAutomation(task, column, exitRow, {
        signal: new AbortController().signal,
        deliverToAgent,
        showNotification,
      });

      expect(summary.outcomes).toHaveLength(1);
      expect(summary.outcomes[0].status).toBe('succeeded');
      expect(showNotification).toHaveBeenCalledTimes(1);
      const recorded = runs.listForTask(task.id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ status: 'succeeded', automation_id: exitRow.id });
      expect(recorded[0].detail).not.toBe(AUTOMATIONS_DISABLED_REASON);
    });
  });
});
