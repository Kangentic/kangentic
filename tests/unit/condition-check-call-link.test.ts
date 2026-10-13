/**
 * The runner links the run rows a Condition check left unanswered to the call
 * that ran (src/main/automations/automation-runner.ts).
 *
 * Every Condition check is one recorded background call with an id. A check
 * that answers puts that id on each row it answered. A check that ran and did
 * not answer (a timeout, an abandoned wait, an error) was still paid for, so
 * the rows it left skipped carry its id too, or the log shows a skip with no
 * cost behind it. The id reaches the runner two ways: `conditionUnavailableCallId`
 * from a caller that checked first (the turn-end group), and the `callId` of a
 * failed outcome from the `checkConditions` the runner calls itself (enter and
 * exit).
 *
 * Against the REAL run log on a migrated SQLite database, so the assertion is
 * on the stored `background_call_id`, not on a mock's arguments. The hops on
 * either side of the runner (the engine handing the id in, the turn-end pass
 * handing it to the engine) are pinned in automation-template-vars.test.ts and
 * turn-end-runner-visit-guards.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { runAutomations, type ConditionCheckResult } from '../../src/main/automations/automation-runner';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';
import type { AutomationAdapter, AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { ColumnAutomation, Swimlane, Task } from '../../src/shared/types';
import { openTestDatabase } from './helpers/test-database';

const NOT_CHECKED_REASON = 'The Automation agent did not answer in time.';
const TASK_ID = 'task-1';
const PRIOR_RUN_ID = 'prior-run';

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

interface Fixture {
  database: DatabaseType.Database;
  runs: AutomationRunRepository;
  column: Swimlane;
}

function migratedFixture(): Fixture {
  const database = openTestDatabase();
  openDatabases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  runProjectMigrations(database);
  const column = new SwimlaneRepository(database).list().find((lane) => lane.role === null)!;
  database
    .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(TASK_ID, 'A task', '', column.id, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  return { database, runs: new AutomationRunRepository(database), column };
}

function automation(column: Swimlane, overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'a1',
    swimlane_id: column.id,
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

function context(column: Swimlane, trigger: AutomationContext['trigger']): Omit<AutomationContext, 'runId' | 'signal'> {
  return {
    task: { id: TASK_ID, title: 'A task', session_id: 'session-1' } as Task,
    column,
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

function webhookRegistry(): AutomationRegistry {
  const adapter: AutomationAdapter = {
    id: 'webhook',
    manifest: AUTOMATION_MANIFEST.webhook,
    describe: () => 'test',
    execute: async () => ({ detail: 'HTTP 204' }),
  };
  const registry = new AutomationRegistry();
  registry.register(adapter);
  return registry;
}

interface StoredRun {
  automation_id: string;
  status: string;
  detail: string | null;
  background_call_id: string | null;
}

/** Every run row the group wrote, with the call it links to, by automation id. */
function storedRuns(database: DatabaseType.Database): Map<string, StoredRun> {
  // Not the run a test seeded to spend a Frequency: it predates the group.
  const rows = database
    .prepare('SELECT automation_id, status, detail, background_call_id FROM automation_runs WHERE task_id = ? AND id <> ?')
    .all(TASK_ID, PRIOR_RUN_ID) as StoredRun[];
  return new Map(rows.map((row) => [row.automation_id, row]));
}

describe('the run rows a Condition check left unanswered', () => {
  describe('when the caller checked first and names the call that ran (a turn-end group)', () => {
    it('links every row it could not answer to that call, and no other row', async () => {
      const { database, runs, column } = migratedFixture();
      const spent = automation(column, { id: 'spent', condition: 'Tests pass', max_runs: 1 });
      // A prior run spends the Frequency, so the row skips for that reason and is never asked about.
      runs.start({ id: PRIOR_RUN_ID, automation: spent, taskId: TASK_ID });
      runs.finish(PRIOR_RUN_ID, 'succeeded', 'HTTP 204');

      await runAutomations({
        automations: [
          automation(column, { id: 'first', condition: 'Tests pass' }),
          automation(column, { id: 'plain' }),
          spent,
          automation(column, { id: 'second', condition: 'Review is clean' }),
        ],
        column,
        context: context(column, 'turn_end'),
        runs,
        signal: new AbortController().signal,
        registry: webhookRegistry(),
        conditionAnswers: new Map(),
        conditionUnavailableReason: NOT_CHECKED_REASON,
        conditionUnavailableCallId: 'c1',
      });

      const stored = storedRuns(database);
      expect(stored.get('first')).toMatchObject({ status: 'skipped', detail: NOT_CHECKED_REASON, background_call_id: 'c1' });
      expect(stored.get('second')).toMatchObject({ status: 'skipped', detail: NOT_CHECKED_REASON, background_call_id: 'c1' });
      // A row with no Condition ran, and a row whose Frequency was spent skipped for that
      // reason: neither was waiting on the check.
      expect(stored.get('plain')).toMatchObject({ status: 'succeeded', background_call_id: null });
      expect(stored.get('spent')).toMatchObject({ status: 'skipped', detail: 'Already ran once on this task, its limit.', background_call_id: null });
    });

    it('links nothing when the caller names no call (the control)', async () => {
      const { database, runs, column } = migratedFixture();

      await runAutomations({
        automations: [automation(column, { id: 'first', condition: 'Tests pass' })],
        column,
        context: context(column, 'turn_end'),
        runs,
        signal: new AbortController().signal,
        registry: webhookRegistry(),
        conditionAnswers: new Map(),
        conditionUnavailableReason: 'Set up an Automation agent in Settings > Workflows to check this condition.',
      });

      expect(storedRuns(database).get('first')).toMatchObject({ status: 'skipped', background_call_id: null });
    });
  });

  describe.each(['enter', 'exit'] as const)('when the runner checks the %s group itself', (trigger) => {
    it('links every row the failed check left unanswered to the call the outcome names', async () => {
      const { database, runs, column } = migratedFixture();
      const checkConditions = vi.fn(async (): Promise<ConditionCheckResult> => ({ ok: false, reason: NOT_CHECKED_REASON, callId: 'c1' }));

      await runAutomations({
        automations: [
          automation(column, { id: 'first', trigger, condition: 'Tests pass' }),
          automation(column, { id: 'plain', trigger }),
          automation(column, { id: 'second', trigger, condition: 'Review is clean' }),
        ],
        column,
        context: context(column, trigger),
        runs,
        signal: new AbortController().signal,
        registry: webhookRegistry(),
        checkConditions,
      });

      // One check for the group, and its one call is on every row it left unanswered.
      expect(checkConditions).toHaveBeenCalledTimes(1);
      const stored = storedRuns(database);
      expect(stored.get('first')).toMatchObject({ status: 'skipped', detail: NOT_CHECKED_REASON, background_call_id: 'c1' });
      expect(stored.get('second')).toMatchObject({ status: 'skipped', detail: NOT_CHECKED_REASON, background_call_id: 'c1' });
      expect(stored.get('plain')).toMatchObject({ status: 'succeeded', background_call_id: null });
    });

    it('links nothing when the failed outcome names no call, since the check never started (the control)', async () => {
      const { database, runs, column } = migratedFixture();
      const checkConditions = vi.fn(async (): Promise<ConditionCheckResult> => ({
        ok: false,
        reason: 'Set up an Automation agent in Settings > Workflows to check this condition.',
      }));

      await runAutomations({
        automations: [automation(column, { id: 'first', trigger, condition: 'Tests pass' })],
        column,
        context: context(column, trigger),
        runs,
        signal: new AbortController().signal,
        registry: webhookRegistry(),
        checkConditions,
      });

      expect(storedRuns(database).get('first')).toMatchObject({ status: 'skipped', background_call_id: null });
    });
  });
});
