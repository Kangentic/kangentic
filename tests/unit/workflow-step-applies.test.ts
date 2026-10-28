/**
 * `workflowStepApplies` (src/main/workflows/workflow-step.ts): does a task's
 * turn end get a workflow step check?
 *
 * It does for a task of a running workflow, and not while the task's own
 * automations are paused: a person is working that task by hand, so its workflow
 * neither judges, nudges nor moves it, and its recovery stops (the turn-end
 * runner asks this one function for all three). The switch is
 * `tasks.automations_disabled`, asked only through `canTaskRunAutomations`.
 *
 * Real, migrated SQLite for the workflow rows (better-sqlite3). Every held case
 * is the same fixture as its not-held twin with `automations_disabled` as the
 * only difference, and asserts the twin first, so a "false" cannot pass because
 * the workflow was never running or its row could not be found. The pairs are
 * also what makes the held tests read red against a `workflowStepApplies` that
 * ignores the switch: that version answers true for the held half.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  dbs: new Map<string, unknown>(),
}));
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: (projectId: string) => harness.dbs.get(projectId) ?? null,
  getProjectDb: (projectId: string) => {
    throw new Error(`The step read must never open a database it was not given: ${projectId}`);
  },
}));
// Imported by workflow-step.ts for the move and the settings it makes at a turn end; not under test.
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const { workflowStepApplies } = await import('../../src/main/workflows/workflow-step');

import { openTestDatabase } from './helpers/test-database';

describe('workflowStepApplies', () => {
  function openBoard(projectId: string): Database.Database {
    const database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    harness.dbs.set(projectId, database);
    return database;
  }

  /** A workflow in the home board's database, in the given state. Returns its id. */
  function addWorkflow(state: 'running' | 'paused' | 'done'): string {
    const workflows = new WorkflowRepository(harness.dbs.get('home') as Database.Database);
    const workflow = workflows.create({});
    workflows.setState(workflow.id, state);
    return workflow.id;
  }

  function stepTask(workflowId: string | null, automationsDisabled: boolean, workflowProjectId: string | null = 'home') {
    return { workflow_id: workflowId, workflow_project_id: workflowProjectId, automations_disabled: automationsDisabled };
  }

  beforeEach(() => {
    harness.dbs.clear();
    openBoard('home');
    openBoard('mobile');
  });

  afterEach(() => {
    for (const database of harness.dbs.values()) {
      if ((database as Database.Database).open) (database as Database.Database).close();
    }
    harness.dbs.clear();
  });

  it('is true for a task of a running workflow whose automations are on', () => {
    expect(workflowStepApplies(stepTask(addWorkflow('running'), false), 'home')).toBe(true);
  });

  it('is false for the same task once its own automations are paused', () => {
    const workflowId = addWorkflow('running');
    expect(workflowStepApplies(stepTask(workflowId, false), 'home')).toBe(true);

    expect(workflowStepApplies(stepTask(workflowId, true), 'home')).toBe(false);
  });

  it('follows the switch both ways on one workflow: paused, then resumed', () => {
    const workflowId = addWorkflow('running');
    const answers = [false, true, false].map((paused) => workflowStepApplies(stepTask(workflowId, paused), 'home'));

    expect(answers).toEqual([true, false, true]);
  });

  it('is false for a task of a paused workflow whatever its switch says, as it was', () => {
    const workflowId = addWorkflow('paused');

    expect(workflowStepApplies(stepTask(workflowId, false), 'home')).toBe(false);
    expect(workflowStepApplies(stepTask(workflowId, true), 'home')).toBe(false);
  });

  it('is false for a task in no workflow, held or not', () => {
    expect(workflowStepApplies(stepTask(null, false, null), 'home')).toBe(false);
    expect(workflowStepApplies(stepTask(null, true, null), 'home')).toBe(false);
  });

  it('reads the held task of a workflow homed on another board from that board', () => {
    const workflows = new WorkflowRepository(harness.dbs.get('mobile') as Database.Database);
    const workflow = workflows.create({});
    workflows.setState(workflow.id, 'running');

    expect(workflowStepApplies(stepTask(workflow.id, false, 'mobile'), 'home')).toBe(true);
    expect(workflowStepApplies(stepTask(workflow.id, true, 'mobile'), 'home')).toBe(false);
  });
});
