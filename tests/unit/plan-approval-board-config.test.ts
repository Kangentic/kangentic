/**
 * `planApproval` on the kangentic.json -> DB leg (`applyBoardConfigToDb`), against
 * real in-memory SQLite.
 *
 * Plan approval is team-shared column state, and build-config omits it at its
 * default, so the file means:
 *   - `"planApproval": "automatic"` -> the column is Automatic;
 *   - the key absent -> the column is Manual. It is NOT "keep what this machine
 *     had": a teammate switching a column back to Manual removes the key, and
 *     keeping the old value would leave plans approving on every other machine;
 *   - anything else a hand-written file might carry -> Manual, the safe answer.
 * To Do and Done are never plan columns, so they apply Manual whatever the
 * file says, on the create path and on the update path alike.
 *
 * Every value is read from the raw `plan_approval` column rather than through
 * the repository, whose read narrows an unknown stored value to 'manual' and so
 * would hide a value that was written wrongly.
 *
 * board-config-parity.test.ts covers the same leg with the repositories mocked,
 * for the passthrough of 'automatic' and for the absent key on an UPDATE. What
 * it cannot reach, and this file does, is the absent key on a CREATE and the
 * To Do / Done pin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const hoisted = vi.hoisted(() => ({
  currentDb: null as unknown,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => hoisted.currentDb,
}));

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { applyBoardConfigToDb } from '../../src/main/config/board-config/apply-config';
import type { BoardColumnConfig, BoardConfig } from '../../src/shared/types';

describe('applyBoardConfigToDb: planApproval (real SQLite)', () => {
  let db: Database.Database;
  let repository: SwimlaneRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runProjectMigrations(db);
    repository = new SwimlaneRepository(db);
    hoisted.currentDb = db;
  });

  afterEach(() => {
    db?.close();
    hoisted.currentDb = null;
  });

  /** The stored value, read around the repository's narrowing. */
  function storedPlanApproval(swimlaneId: string): string {
    const row = db.prepare('SELECT plan_approval FROM swimlanes WHERE id = ?').get(swimlaneId) as { plan_approval: string };
    return row.plan_approval;
  }

  function laneNamed(name: string) {
    const lane = repository.list().find((candidate) => candidate.name === name);
    if (!lane) throw new Error(`No column named "${name}"`);
    return lane;
  }

  /** A config whose columns carry no ids: every one takes the CREATE path. */
  function configWithoutIds(columns: BoardColumnConfig[]): BoardConfig {
    return { version: 1, columns, actions: [], transitions: [] };
  }

  /** The seeded board's To Do and Done by id, so a config naming them takes the UPDATE path. */
  function seededSystemColumns(extra: Partial<BoardColumnConfig> = {}): { todo: BoardColumnConfig; done: BoardColumnConfig } {
    const todo = repository.list().find((lane) => lane.role === 'todo')!;
    const done = repository.list().find((lane) => lane.role === 'done')!;
    return {
      todo: { id: todo.id, name: todo.name, role: 'todo', ...extra },
      done: { id: done.id, name: done.name, role: 'done', ...extra },
    };
  }

  describe('a column the file introduces (the create path)', () => {
    beforeEach(() => {
      // An empty board, so every column in the config is new.
      db.exec('DELETE FROM swimlanes');
    });

    function applyNewColumn(extra: Partial<BoardColumnConfig>): string {
      const result = applyBoardConfigToDb('project-x', configWithoutIds([
        { name: 'To Do', role: 'todo' },
        { name: 'Plan Gate', permissionMode: 'plan', ...extra },
        { name: 'Done', role: 'done' },
      ]));
      expect(result.warnings).toEqual([]);
      return laneNamed('Plan Gate').id;
    }

    it('is Automatic when the file says "automatic"', () => {
      expect(storedPlanApproval(applyNewColumn({ planApproval: 'automatic' }))).toBe('automatic');
    });

    it('is Manual when the file names it Manual', () => {
      expect(storedPlanApproval(applyNewColumn({ planApproval: 'manual' }))).toBe('manual');
    });

    it('is Manual when the key is absent', () => {
      expect(storedPlanApproval(applyNewColumn({}))).toBe('manual');
    });

    it('is Manual for a value this build does not know, never the unknown value itself', () => {
      const planGateId = applyNewColumn({ planApproval: 'bogus' as unknown as BoardColumnConfig['planApproval'] });

      expect(storedPlanApproval(planGateId)).toBe('manual');
    });
  });

  describe('To Do and Done, which are never plan columns', () => {
    it('create as Manual even when the file says "automatic"', () => {
      db.exec('DELETE FROM swimlanes');

      const result = applyBoardConfigToDb('project-x', configWithoutIds([
        { name: 'To Do', role: 'todo', planApproval: 'automatic' },
        { name: 'Plan Gate', permissionMode: 'plan', planApproval: 'automatic' },
        { name: 'Done', role: 'done', planApproval: 'automatic' },
      ]));

      expect(result.warnings).toEqual([]);
      expect(storedPlanApproval(laneNamed('To Do').id)).toBe('manual');
      expect(storedPlanApproval(laneNamed('Done').id)).toBe('manual');
      // The control: a plan column in the same file keeps what it was given,
      // so the two assertions above are the pin and not a blanket Manual.
      expect(storedPlanApproval(laneNamed('Plan Gate').id)).toBe('automatic');
    });

    it('update to Manual even when the file says "automatic"', () => {
      const { todo, done } = seededSystemColumns({ planApproval: 'automatic' });
      // A prior Automatic on this machine must be pulled back too.
      db.prepare("UPDATE swimlanes SET plan_approval = 'automatic' WHERE role IN ('todo', 'done')").run();
      expect(storedPlanApproval(todo.id!)).toBe('automatic');

      const otherColumns = repository.list()
        .filter((lane) => lane.role !== 'todo' && lane.role !== 'done')
        .map((lane): BoardColumnConfig => ({
          id: lane.id,
          name: lane.name,
          ...(lane.permission_mode ? { permissionMode: lane.permission_mode } : {}),
        }));
      const planningColumn = otherColumns.find((column) => column.name === 'Planning')!;
      planningColumn.planApproval = 'automatic';

      const result = applyBoardConfigToDb('project-x', {
        version: 1,
        columns: [todo, ...otherColumns, done],
        actions: [],
        transitions: [],
      });

      expect(result.warnings).toEqual([]);
      expect(storedPlanApproval(todo.id!)).toBe('manual');
      expect(storedPlanApproval(done.id!)).toBe('manual');
      // The control: an existing custom column in the same file is updated to Automatic.
      expect(storedPlanApproval(laneNamed('Planning').id)).toBe('automatic');
    });
  });

  describe('a column that already exists (the update path)', () => {
    it('turns an Automatic column back to Manual when the file drops the key', () => {
      const planning = laneNamed('Planning');
      repository.update({ id: planning.id, plan_approval: 'automatic' });
      expect(storedPlanApproval(planning.id)).toBe('automatic');
      const { todo, done } = seededSystemColumns();
      const middle = repository.list()
        .filter((lane) => lane.role !== 'todo' && lane.role !== 'done')
        .map((lane): BoardColumnConfig => ({ id: lane.id, name: lane.name }));

      applyBoardConfigToDb('project-x', { version: 1, columns: [todo, ...middle, done], actions: [], transitions: [] });

      expect(storedPlanApproval(planning.id)).toBe('manual');
    });
  });
});
