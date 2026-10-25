/**
 * Unit tests for the classification TABLE VALUES in src/shared/task-move-origin.ts.
 *
 * `MOVED_BY_A_PERSON` decides two things: where a row's Frequency starts
 * counting (`AutomationRunRepository.countRuns`) and the workflow lock's move
 * by hand (`workflowMoveRefusal`, `checkWorkflowMove`).
 *
 * The `Record<TaskMoveRecordOrigin, boolean>` type guarantees EXHAUSTIVENESS
 * of the table at compile time, but a wrong value (an `unarchive` or `create`
 * flipped to true) still compiles. These tests pin the runtime values. Since
 * tests/ is not typechecked, the keys assertion is what ties this file's two
 * lists to the table, so an origin added or removed without a decision here
 * fails.
 */
import { describe, it, expect } from 'vitest';
import type { TaskMoveRecordOrigin } from '../../src/shared/types';
import { MOVED_BY_A_PERSON, isMoveByAPerson } from '../../src/shared/task-move-origin';

const MOVES_BY_A_PERSON: TaskMoveRecordOrigin[] = ['renderer', 'mobile'];

const MOVES_NO_PERSON_MADE: TaskMoveRecordOrigin[] = [
  'agent',
  'auto-move',
  'workflow',
  'automation',
  'rollback',
  'unarchive',
  'create',
];

describe('isMoveByAPerson', () => {
  it.each(MOVES_BY_A_PERSON)('is true for a %s move, a drag on the board or a move from the phone', (origin) => {
    expect(isMoveByAPerson(origin)).toBe(true);
  });

  it.each(MOVES_NO_PERSON_MADE)('is false for a %s move', (origin) => {
    expect(isMoveByAPerson(origin)).toBe(false);
  });
});

describe('MOVED_BY_A_PERSON', () => {
  it('classifies exactly the nine origins a task move can record, so a new one is decided here', () => {
    const everyOrigin: TaskMoveRecordOrigin[] = [...MOVES_BY_A_PERSON, ...MOVES_NO_PERSON_MADE];

    expect(everyOrigin).toHaveLength(9);
    expect(Object.keys(MOVED_BY_A_PERSON).sort()).toEqual([...everyOrigin].sort());
  });
});
