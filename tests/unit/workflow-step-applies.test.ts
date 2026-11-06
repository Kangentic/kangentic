/**
 * `workflowStepApplies` (src/main/workflows/workflow-step.ts): does a task's
 * turn end get a workflow step check? It does for a task of a running workflow.
 * A task's automations switch has no say: a workflow task cannot set it, and a
 * card left held must not fall out of its workflow unnoticed.
 *
 * Real, migrated SQLite for the workflow rows (better-sqlite3).
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

  function stepTask(workflowId: string | null, workflowProjectId: string | null = 'home') {
    return { workflow_id: workflowId, workflow_project_id: workflowProjectId };
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

  it('is true for a task of a running workflow', () => {
    expect(workflowStepApplies(stepTask(addWorkflow('running')), 'home')).toBe(true);
  });

  it('is true for a task of a running workflow left with its automations switch held', () => {
    const heldTask = { ...stepTask(addWorkflow('running')), automations_disabled: true };
    expect(workflowStepApplies(heldTask, 'home')).toBe(true);
  });

  it('is false for a task of a paused workflow', () => {
    expect(workflowStepApplies(stepTask(addWorkflow('paused')), 'home')).toBe(false);
  });

  it('is false for a task in no workflow', () => {
    expect(workflowStepApplies(stepTask(null, null), 'home')).toBe(false);
  });

  it('reads a task of a workflow homed on another board from that board', () => {
    const workflows = new WorkflowRepository(harness.dbs.get('mobile') as Database.Database);
    const workflow = workflows.create({});
    workflows.setState(workflow.id, 'running');

    expect(workflowStepApplies(stepTask(workflow.id, 'mobile'), 'home')).toBe(true);
  });
});
