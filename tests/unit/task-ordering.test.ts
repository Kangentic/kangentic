/**
 * The ordering arithmetic behind the MCP task-placement surface
 * (`kangentic_move_task`'s `position`, `kangentic_reorder_tasks`).
 *
 * These assertions carry more weight than usual: the DB-backed MCP suites all
 * gate on `better-sqlite3`, which is compiled for Electron's Node ABI and so
 * skips under vitest everywhere, CI included. Keeping the math pure is what
 * lets it actually be covered, so this file is the real guard on slot handling.
 */
import { describe, it, expect } from 'vitest';
import {
  clampSlot,
  computeIdsWithTaskAtSlot,
  computeReorderedIds,
  resolveRawPosition,
} from '../../src/main/agent/commands/task-ordering';

describe('clampSlot', () => {
  it('passes an in-range slot through untouched', () => {
    expect(clampSlot(0, 5)).toBe(0);
    expect(clampSlot(3, 5)).toBe(3);
    expect(clampSlot(5, 5)).toBe(5);
  });

  it('clamps past the end to the last legal slot rather than failing', () => {
    expect(clampSlot(999, 5)).toBe(5);
  });

  it('clamps a negative slot to the top', () => {
    expect(clampSlot(-1, 5)).toBe(0);
    expect(clampSlot(-999, 5)).toBe(0);
  });

  it('collapses to 0 when nothing is placeable', () => {
    // An empty column, or a same-column reposition of the only card there.
    expect(clampSlot(0, 0)).toBe(0);
    expect(clampSlot(4, 0)).toBe(0);
    expect(clampSlot(2, -1)).toBe(0);
  });

  it('truncates a fractional slot and treats a non-finite one as the end', () => {
    expect(clampSlot(2.7, 5)).toBe(2);
    expect(clampSlot(Number.NaN, 5)).toBe(5);
  });
});

describe('computeReorderedIds', () => {
  const column = ['a', 'b', 'c', 'd'];

  it('sets the full order when every id is listed', () => {
    expect(computeReorderedIds(column, ['d', 'c', 'b', 'a'])).toEqual(['d', 'c', 'b', 'a']);
  });

  it('pins a subset to the top, leaving the rest in their relative order', () => {
    expect(computeReorderedIds(column, ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a single id to the top', () => {
    expect(computeReorderedIds(column, ['d'])).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is idempotent when the requested order already holds', () => {
    const once = computeReorderedIds(column, ['b', 'a']);
    expect(computeReorderedIds(once, ['b', 'a'])).toEqual(once);
  });

  it('is a no-op shape when the request matches the column exactly', () => {
    expect(computeReorderedIds(column, column)).toEqual(column);
  });

  it('keeps a task added since the agent last read the column, at the bottom', () => {
    // The whole reason for prefix rather than full-list semantics: "e" landed
    // between the read and the write and must not fail the call.
    expect(computeReorderedIds([...column, 'e'], ['d', 'c', 'b', 'a'])).toEqual(['d', 'c', 'b', 'a', 'e']);
  });

  it('returns the column unchanged for an empty request', () => {
    expect(computeReorderedIds(column, [])).toEqual(column);
  });
});

describe('computeIdsWithTaskAtSlot', () => {
  const column = ['a', 'b', 'c', 'd'];

  it('moves a task to the top', () => {
    expect(computeIdsWithTaskAtSlot(column, 'c', 0)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a task down, counting slots among the OTHER tasks', () => {
    // "a" removed leaves [b, c, d]; inserting at 2 puts it before "d".
    expect(computeIdsWithTaskAtSlot(column, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('treats the last slot as one less than the column length', () => {
    expect(computeIdsWithTaskAtSlot(column, 'a', 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(computeIdsWithTaskAtSlot(column, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('is a no-op when the task already occupies the slot', () => {
    expect(computeIdsWithTaskAtSlot(column, 'b', 1)).toEqual(column);
  });

  it('handles a single-task column', () => {
    expect(computeIdsWithTaskAtSlot(['a'], 'a', 0)).toEqual(['a']);
    expect(computeIdsWithTaskAtSlot(['a'], 'a', 7)).toEqual(['a']);
  });
});

describe('resolveRawPosition', () => {
  // A column's raw positions gap as tasks are archived (`archive()` leaves
  // `position` untouched) and because `create` takes MAX(position) + 1 over
  // archived rows. An ordinal is NOT its own raw value once that happens, which
  // is the whole reason this function exists.
  const gapped = [0, 5, 9];
  const appendPosition = 12;

  it('anchors on the raw position of the task currently in that slot', () => {
    expect(resolveRawPosition(gapped, 0, appendPosition)).toBe(0);
    expect(resolveRawPosition(gapped, 1, appendPosition)).toBe(5);
    expect(resolveRawPosition(gapped, 2, appendPosition)).toBe(9);
  });

  it('appends past the last slot', () => {
    expect(resolveRawPosition(gapped, 3, appendPosition)).toBe(appendPosition);
    expect(resolveRawPosition(gapped, 999, appendPosition)).toBe(appendPosition);
  });

  it('is the identity on a dense column', () => {
    const dense = [0, 1, 2, 3];
    expect(resolveRawPosition(dense, 0, 4)).toBe(0);
    expect(resolveRawPosition(dense, 2, 4)).toBe(2);
    expect(resolveRawPosition(dense, 4, 4)).toBe(4);
  });

  it('appends into an empty column, even one whose archived rows hold positions', () => {
    // Not 0: the append anchor counts archived rows, so a column whose live
    // tasks are all archived still appends past them rather than colliding.
    expect(resolveRawPosition([], 0, 0)).toBe(0);
    expect(resolveRawPosition([], 0, 7)).toBe(7);
  });

  it('clamps a negative ordinal to the top slot', () => {
    expect(resolveRawPosition(gapped, -3, appendPosition)).toBe(0);
  });
});
