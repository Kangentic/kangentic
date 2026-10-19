/**
 * What the repositories hand back when the stored plan approval is not one of
 * the two real values.
 *
 * Neither column has a CHECK constraint, and the value comes from places that
 * do not narrow it first: a teammate's hand-edited kangentic.json, a downgrade
 * and upgrade across builds, an agent or phone caller whose handler missed it.
 * So the READ narrows, and each repository narrows to its own safe answer:
 *   - a column (`SwimlaneRepository`) reads an unknown value as 'manual', so a
 *     plan dialog waits for the user instead of being answered by Kangentic;
 *   - a workflow (`WorkflowRepository`) reads it as null, "follow the plan
 *     columns", which is the unpicked state and never an invented pick.
 *
 * The bad values are planted with a raw UPDATE, because every write path in the
 * app is typed and would not produce them. Each case is paired with a real
 * value that must read back unchanged, so a read that returned a constant
 * would not pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { WorkflowRepository } from '../../src/main/db/repositories/workflow-repository';

describe('SwimlaneRepository reads a stored plan_approval', () => {
  let database: DatabaseType.Database;
  let repository: SwimlaneRepository;
  let swimlaneId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    repository = new SwimlaneRepository(database);
    swimlaneId = repository.create({ name: 'Plan Gate', permission_mode: 'plan' }).id;
  });

  afterEach(() => {
    database.close();
  });

  function storeRaw(value: string | null): void {
    database.prepare('UPDATE swimlanes SET plan_approval = ? WHERE id = ?').run(value, swimlaneId);
  }

  it.each([
    ['automatic', 'automatic'],
    ['manual', 'manual'],
  ])('reads the real value "%s" back as itself', (stored, expected) => {
    storeRaw(stored);

    expect(repository.getById(swimlaneId)?.plan_approval).toBe(expected);
    expect(repository.list().find((lane) => lane.id === swimlaneId)?.plan_approval).toBe(expected);
  });

  it.each([
    ['an unknown word', 'bogus'],
    ['the right word in the wrong case', 'AUTOMATIC'],
    ['an empty string', ''],
    ['a word with trailing space', 'automatic '],
  ])('reads %s as "manual"', (_label, stored) => {
    storeRaw(stored);

    expect(repository.getById(swimlaneId)?.plan_approval).toBe('manual');
    expect(repository.list().find((lane) => lane.id === swimlaneId)?.plan_approval).toBe('manual');
  });
});

describe('WorkflowRepository reads a stored plan_approval', () => {
  let database: DatabaseType.Database;
  let repository: WorkflowRepository;
  let workflowId: string;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    repository = new WorkflowRepository(database);
    workflowId = repository.create({ title: 'Usage budgets' }).id;
  });

  afterEach(() => {
    database.close();
  });

  function storeRaw(value: string | null): void {
    database.prepare('UPDATE workflows SET plan_approval = ? WHERE id = ?').run(value, workflowId);
  }

  it.each([
    ['automatic', 'automatic'],
    ['manual', 'manual'],
  ])('reads the real value "%s" back as itself', (stored, expected) => {
    storeRaw(stored);

    expect(repository.getById(workflowId)?.plan_approval).toBe(expected);
    expect(repository.listAll().find((workflow) => workflow.id === workflowId)?.plan_approval).toBe(expected);
  });

  it.each([
    ['an unknown word', 'bogus'],
    ['the right word in the wrong case', 'MANUAL'],
    ['an empty string', ''],
    ['a number stored as text', '1'],
  ])('reads %s as null, following the plan columns', (_label, stored) => {
    storeRaw(stored);

    expect(repository.getById(workflowId)?.plan_approval).toBeNull();
    expect(repository.listAll().find((workflow) => workflow.id === workflowId)?.plan_approval).toBeNull();
  });

  it('reads a real NULL as null', () => {
    storeRaw('automatic');
    storeRaw(null);

    expect(repository.getById(workflowId)?.plan_approval).toBeNull();
  });
});
