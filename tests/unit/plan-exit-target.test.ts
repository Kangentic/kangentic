/**
 * `planExitTargetFor` (src/main/ipc/helpers/plan-exit-target.ts): where a task
 * goes when its agent leaves plan mode in a column.
 *
 * Two readers share this answer: the `plan-exit` listener moves an approved
 * plan to it, and the turn-end runner counts a later drag into it as the same
 * plan exit. The listener's own test (plan-exit-continuation-prompt.test.ts)
 * mocks `applyProfileToLane` and `loadTaskProfile` as identity, so the Board
 * Profile fold and the workflow route were never exercised. This file runs the
 * REAL fold over an in-memory board, so a lost profile lookup, a dropped
 * `columns` argument (a profile names its target by column NAME, resolved
 * against the board's columns) or a workflow task that stops following its
 * route goes red here.
 *
 * Every expected column is chosen to differ from each wrong answer: the lane's
 * own target, the profile's target and the route's next column are three
 * different columns wherever more than one of them applies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { planExitTargetFor } from '../../src/main/ipc/helpers/plan-exit-target';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import type { BoardProfile, Swimlane, Task } from '../../src/shared/types';

const PROJECT_PATH = '/mock/project';
const PROFILE_ID = 'profile-fast';

const TODO_ID = 'lane-todo';
const PLANNING_ID = 'lane-planning';
const EXECUTING_ID = 'lane-executing';
const CODE_REVIEW_ID = 'lane-code-review';
const TESTING_ID = 'lane-testing';
const DONE_ID = 'lane-done';

function lane(overrides: Partial<Swimlane> & Pick<Swimlane, 'id' | 'name' | 'position'>): Swimlane {
  return {
    description: null,
    role: null,
    color: '#888888',
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

/** Planning exits to Executing on its own. Executing has no plan exit target. */
function buildBoard(): Swimlane[] {
  return [
    lane({ id: TODO_ID, name: 'To Do', position: 0, role: 'todo' }),
    lane({ id: PLANNING_ID, name: 'Planning', position: 1, plan_exit_target_id: EXECUTING_ID }),
    lane({ id: EXECUTING_ID, name: 'Executing', position: 2 }),
    lane({ id: CODE_REVIEW_ID, name: 'Code Review', position: 3 }),
    lane({ id: TESTING_ID, name: 'Testing', position: 4 }),
    lane({ id: DONE_ID, name: 'Done', position: 5, role: 'done' }),
  ];
}

/** The two methods `planExitTargetFor` reads, over a fixed board. */
function swimlanesOver(lanes: Swimlane[]): Pick<SwimlaneRepository, 'getById' | 'list'> {
  return {
    getById: (id: string) => lanes.find((candidate) => candidate.id === id),
    list: () => [...lanes],
  };
}

type TaskFields = Pick<
  Task,
  'id' | 'profile_id' | 'workflow_id' | 'route_start_swimlane_id' | 'route_last_swimlane_id' | 'skipped_swimlane_ids'
>;

/** Only the fields the helper reads; the rest of a `Task` plays no part in the answer. */
function taskWith(overrides: Partial<TaskFields> = {}): Task {
  const fields: TaskFields = {
    id: 'task-1',
    profile_id: null,
    workflow_id: null,
    route_start_swimlane_id: null,
    route_last_swimlane_id: null,
    skipped_swimlane_ids: [],
    ...overrides,
  };
  return fields as Task;
}

/** A Board Profile that re-points Planning's plan exit to Testing, by column NAME. */
function fastProfile(): BoardProfile {
  return {
    id: PROFILE_ID,
    name: 'Fast',
    columns: { [PLANNING_ID]: { planExitTarget: 'Testing' } },
  };
}

describe('planExitTargetFor', () => {
  let getBoardProfiles: ReturnType<typeof vi.fn>;
  let context: IpcContext;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getBoardProfiles = vi.fn(() => [fastProfile()]);
    context = { boardConfigManager: { getBoardProfiles } } as unknown as IpcContext;
    // A profile id naming no known profile logs a one-time warning.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function targetFor(task: Task, fromSwimlaneId: string): Swimlane | null {
    return planExitTargetFor(context, task, fromSwimlaneId, swimlanesOver(buildBoard()), PROJECT_PATH);
  }

  describe('Board Profile fold', () => {
    it('sends a profile task to the profile\'s target, not the column\'s own', () => {
      const target = targetFor(taskWith({ profile_id: PROFILE_ID }), PLANNING_ID);

      expect(target?.id).toBe(TESTING_ID);
      expect(target?.id).not.toBe(EXECUTING_ID);
    });

    it('reads the profiles of the project the task lives in', () => {
      targetFor(taskWith({ profile_id: PROFILE_ID }), PLANNING_ID);

      expect(getBoardProfiles).toHaveBeenCalledWith(PROJECT_PATH);
    });

    it('sends a task with no profile to the column\'s own target', () => {
      const target = targetFor(taskWith({ profile_id: null }), PLANNING_ID);

      expect(target?.id).toBe(EXECUTING_ID);
    });

    it('falls back to the column\'s own target when the task\'s profile no longer exists', () => {
      const target = targetFor(taskWith({ profile_id: 'profile-deleted-by-a-teammate' }), PLANNING_ID);

      expect(target?.id).toBe(EXECUTING_ID);
    });

    it('falls back to the column\'s own target when the profiles cannot be read', () => {
      getBoardProfiles.mockImplementation(() => {
        throw new Error('kangentic.json is mid-write');
      });

      const target = targetFor(taskWith({ profile_id: PROFILE_ID }), PLANNING_ID);

      expect(target?.id).toBe(EXECUTING_ID);
    });
  });

  describe('a column with no usable plan exit target', () => {
    it('returns null', () => {
      expect(targetFor(taskWith(), EXECUTING_ID)).toBeNull();
    });

    it('returns null for a profile task whose profile has no entry for the column', () => {
      expect(targetFor(taskWith({ profile_id: PROFILE_ID }), EXECUTING_ID)).toBeNull();
    });

    it('returns null, not undefined, when the target names a column that no longer exists', () => {
      const board = buildBoard().map((candidate) => (
        candidate.id === PLANNING_ID ? { ...candidate, plan_exit_target_id: 'lane-deleted' } : candidate
      ));

      const target = planExitTargetFor(context, taskWith(), PLANNING_ID, swimlanesOver(board), PROJECT_PATH);

      expect(target).toBeNull();
    });
  });

  describe('a workflow task', () => {
    it('goes to the next column on its route, not the column\'s own or the profile\'s target', () => {
      // Route: Planning, Code Review, Testing. The next column after Planning is Code Review,
      // which is neither Planning's own target (Executing) nor the profile's (Testing).
      const task = taskWith({
        workflow_id: 'workflow-1',
        profile_id: PROFILE_ID,
        skipped_swimlane_ids: [EXECUTING_ID],
      });

      expect(targetFor(task, PLANNING_ID)?.id).toBe(CODE_REVIEW_ID);
    });

    it('goes to the next column on its route from a column with no plan exit target of its own', () => {
      const task = taskWith({ workflow_id: 'workflow-1' });

      expect(targetFor(task, EXECUTING_ID)?.id).toBe(CODE_REVIEW_ID);
    });

    it('goes to Done when nothing is left on its route', () => {
      const task = taskWith({ workflow_id: 'workflow-1' });

      expect(targetFor(task, TESTING_ID)?.id).toBe(DONE_ID);
    });
  });
});
