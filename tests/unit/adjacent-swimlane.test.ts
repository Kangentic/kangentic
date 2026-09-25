/**
 * Unit tests for adjacentSwimlane (src/renderer/components/dialogs/task-detail/
 * adjacent-swimlane.ts), the pure step function behind the
 * taskDetail.moveColumnLeft/Right hotkeys.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect } from 'vitest';
import { adjacentSwimlane } from '../../src/renderer/components/dialogs/task-detail/adjacent-swimlane';
import type { Swimlane } from '../../src/shared/types';

/** Minimal swimlane fixture; only the fields adjacentSwimlane reads are real. */
function lane(overrides: Partial<Swimlane> & { id: string; position: number }): Swimlane {
  return {
    name: overrides.id,
    description: null,
    role: null,
    color: '#000000',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    auto_command_mode: 'immediate',
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// A five-column board: To Do, Planning, Executing, Code Review, Done (archived).
const TODO = lane({ id: 'todo', position: 0 });
const PLANNING = lane({ id: 'planning', position: 1 });
const EXECUTING = lane({ id: 'executing', position: 2 });
const CODE_REVIEW = lane({ id: 'code-review', position: 3 });
const DONE = lane({ id: 'done', position: 4, is_archived: true, role: 'done' });
const BOARD = [TODO, PLANNING, EXECUTING, CODE_REVIEW, DONE];

describe('adjacentSwimlane', () => {
  it('steps right to the next column', () => {
    expect(adjacentSwimlane(BOARD, EXECUTING.id, 'right')?.id).toBe('code-review');
  });

  it('steps left to the previous column', () => {
    expect(adjacentSwimlane(BOARD, EXECUTING.id, 'left')?.id).toBe('planning');
  });

  it('stops at the left edge with no wraparound', () => {
    expect(adjacentSwimlane(BOARD, TODO.id, 'left')).toBeNull();
  });

  it('stops at the last board column stepping right, never reaching an archived Done', () => {
    expect(adjacentSwimlane(BOARD, CODE_REVIEW.id, 'right')).toBeNull();
  });

  it('never targets a Done-role lane even when it is not archived', () => {
    // Every write path persists Done as archived, but nothing in the schema
    // enforces the coupling; the role check is what keeps the hotkey out of Done.
    const unarchivedDone = lane({ id: 'done', position: 4, is_archived: false, role: 'done' });
    const board = [TODO, PLANNING, EXECUTING, CODE_REVIEW, unarchivedDone];
    expect(adjacentSwimlane(board, CODE_REVIEW.id, 'right')).toBeNull();
  });

  it('skips an archived lane adjacent to the current one', () => {
    // A user-configured second archived lane sits between Code Review and Done.
    const archivedMiddle = lane({ id: 'archived-middle', position: 4, is_archived: true });
    const shiftedDone = lane({ id: 'done', position: 5, is_archived: true, role: 'done' });
    const board = [TODO, PLANNING, EXECUTING, CODE_REVIEW, archivedMiddle, shiftedDone];
    expect(adjacentSwimlane(board, CODE_REVIEW.id, 'right')).toBeNull();
  });

  it('skips a ghost lane several positions away', () => {
    const ghost = lane({ id: 'ghost', position: 3, is_ghost: true });
    const reReview = lane({ id: 'code-review', position: 4 });
    const board = [TODO, PLANNING, EXECUTING, ghost, reReview];
    expect(adjacentSwimlane(board, EXECUTING.id, 'right')?.id).toBe('code-review');
  });

  it('steps out of a ghost current lane to the nearest real neighbour', () => {
    const ghost = lane({ id: 'ghost', position: 2, is_ghost: true });
    const board = [TODO, PLANNING, ghost, CODE_REVIEW];
    expect(adjacentSwimlane(board, ghost.id, 'right')?.id).toBe('code-review');
    expect(adjacentSwimlane(board, ghost.id, 'left')?.id).toBe('planning');
  });

  it('returns null for an unknown current swimlane id', () => {
    expect(adjacentSwimlane(BOARD, 'not-a-real-lane', 'right')).toBeNull();
  });

  it('orders an unsorted input list by position before stepping', () => {
    const shuffled = [CODE_REVIEW, TODO, DONE, EXECUTING, PLANNING];
    expect(adjacentSwimlane(shuffled, EXECUTING.id, 'right')?.id).toBe('code-review');
    expect(adjacentSwimlane(shuffled, EXECUTING.id, 'left')?.id).toBe('planning');
  });
});
