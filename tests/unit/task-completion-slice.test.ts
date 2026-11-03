/**
 * The Done-drop completion lifecycle in `task-completion-slice.ts`, driven through the REAL
 * board store, real project store and real toast store over a fake `window.electronAPI`.
 *
 * A Done drop hides the task, flies a card for ~700ms and persists the move (`moveTask`) only
 * when the fly ends and the move is approved. These cases pin the store-level invariants the
 * rest of the board leans on:
 *
 * - `setCompletingTask` removes the task from `tasks` and adds it to `completingTaskIds` in one
 *   write, so no frame shows it in a lane (`board-completing-task-chokepoint.md`).
 * - `setCompletingTask(null)` clears only the singular field. The id is released by the
 *   completion's own `finally`, never by a replacement.
 * - `addCompletingTaskId` / `removeCompletingTaskId` hand back the SAME Set on a redundant call,
 *   so a subscriber does not re-render for nothing.
 * - A failed move still releases the id and the gate.
 * - A second drop supersedes the first without losing either id.
 * - The move routes to the `projectId` stamped at drop time, and a success while the user is on
 *   another project does not flag that project's board (`project-scoped-ipc.md`).
 *
 * The FlyingCard is not mounted here. In the app it ends the fly (transitionend, a 700ms timer,
 * or immediately when there is no drop zone) by calling `finalizeCompletion`; these cases call
 * it themselves. The FlyingCard's own timer paths stay in
 * `tests/ui/move-to-done-completion-store.spec.ts`, and a failed move's toast stays in
 * `tests/ui/move-to-done-cross-project.spec.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBoardStore } from '../../src/renderer/stores/board-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useToastStore } from '../../src/renderer/stores/toast-store';
import type { CompletingTask } from '../../src/renderer/stores/board-store/types';
import type { Project, Swimlane, Task, TaskMoveInput } from '../../src/shared/types';

type BoardStoreHandle = ReturnType<typeof createBoardStore>;

const CREATED_AT = '2026-10-01T00:00:00.000Z';
const PROJECT_A = 'proj-completion-a';
const PROJECT_B = 'proj-completion-b';
const TASK_A = 'task-completion-a';
const TASK_B = 'task-completion-b';
const LANE_EXECUTING = 'lane-executing';
const LANE_DONE = 'lane-done';

function makeTask(id: string, title: string, position: number): Task {
  return {
    id,
    title,
    display_id: position + 1,
    description: '',
    swimlane_id: LANE_EXECUTING,
    position,
    agent: 'claude',
    session_id: null,
    worktree_path: null,
    worktree_folder: null,
    worktree_skip_reason: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    head_sha: null,
    pushed_branch: null,
    base_branch: 'main',
    use_worktree: 1,
    labels: [],
    priority: 0,
    attachment_count: 0,
    run_mode: 'column_settings',
    automations_disabled: false,
    archived_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function makeLane(id: string, name: string, position: number, role: Swimlane['role']): Swimlane {
  return {
    id,
    name,
    description: null,
    role,
    position,
    color: '#336699',
    // Null: a name outside the core icon set makes the loader await lucide's full map.
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    auto_command_mode: 'immediate',
    plan_exit_target_id: null,
    plan_approval: 'manual',
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    max_agents: null,
    created_at: CREATED_AT,
  };
}

function makeProject(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    path: `/mock/${id}`,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: CREATED_AT,
    created_at: CREATED_AT,
  };
}

interface MoveCall {
  input: TaskMoveInput;
  projectId: string | null | undefined;
}

interface Harness {
  store: BoardStoreHandle;
  moveCalls: MoveCall[];
  /** Replaces what the fake `tasks.move` does. The default archives the task, as main does. */
  setMoveBehavior: (behavior: (input: TaskMoveInput) => Promise<void>) => void;
}

/**
 * A board store holding two Executing tasks and a Done lane, over a fake IPC that answers like
 * main: `tasks.move` into the Done lane archives the task, so the reload that follows a move
 * lists the board without it. The project store starts on project A.
 */
function harness(): Harness {
  const servedTasks = [makeTask(TASK_A, 'Task Alpha', 0), makeTask(TASK_B, 'Task Beta', 1)];
  const servedLanes = [
    makeLane(LANE_EXECUTING, 'Executing', 0, null),
    makeLane(LANE_DONE, 'Done', 1, 'done'),
  ];
  const moveCalls: MoveCall[] = [];
  let moveBehavior = async (input: TaskMoveInput): Promise<void> => {
    const index = servedTasks.findIndex((task) => task.id === input.taskId);
    if (index >= 0) servedTasks.splice(index, 1);
  };

  vi.stubGlobal('window', {
    electronAPI: {
      tasks: {
        list: async () => structuredClone(servedTasks),
        listArchivedPreview: async () => ({ tasks: [], totalCount: 0 }),
        move: async (input: TaskMoveInput, projectId?: string | null) => {
          moveCalls.push({ input, projectId });
          await moveBehavior(input);
        },
      },
      swimlanes: { list: async () => structuredClone(servedLanes) },
      boardConfig: {
        getShortcuts: async () => [],
        getBoardProfiles: async () => [],
      },
      automations: { list: async () => [] },
    },
  });

  useProjectStore.setState({ currentProject: makeProject(PROJECT_A) });
  useToastStore.setState({ toasts: [] });

  const store = createBoardStore();
  store.setState({
    tasks: structuredClone(servedTasks),
    swimlanes: structuredClone(servedLanes),
  });
  return {
    store,
    moveCalls,
    setMoveBehavior: (behavior) => { moveBehavior = behavior; },
  };
}

function completing(store: BoardStoreHandle, taskId: string, projectId: string | null): CompletingTask {
  const task = store.getState().tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task not in store: ${taskId}`);
  return {
    taskId,
    targetSwimlaneId: LANE_DONE,
    targetPosition: 0,
    originSwimlaneId: task.swimlane_id,
    task,
    startRect: { left: 100, top: 100, width: 200, height: 80 },
    projectId,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({ currentProject: null });
  useToastStore.setState({ toasts: [] });
});

describe('TaskCompletionSlice state invariants', () => {
  it('setCompletingTask adds to completingTaskIds and removes from tasks in one write', () => {
    const { store } = harness();
    const writes: Array<{ inTasks: boolean; inIds: boolean }> = [];
    store.subscribe((state) => {
      writes.push({
        inTasks: state.tasks.some((task) => task.id === TASK_A),
        inIds: state.completingTaskIds.has(TASK_A),
      });
    });
    expect(store.getState().tasks.some((task) => task.id === TASK_A)).toBe(true);
    expect(store.getState().completingTaskIds.has(TASK_A)).toBe(false);

    store.getState().setCompletingTask(completing(store, TASK_A, PROJECT_A));

    const after = store.getState();
    expect(after.tasks.some((task) => task.id === TASK_A)).toBe(false);
    expect(after.completingTaskIds.has(TASK_A)).toBe(true);
    expect(after.completingTask?.taskId).toBe(TASK_A);
    // No subscriber ever saw the task in neither place or in both: it is one write.
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.inTasks).toBe(false);
      expect(write.inIds).toBe(true);
    }
    // The task that was not dropped stays on the board.
    expect(after.tasks.map((task) => task.id)).toEqual([TASK_B]);
  });

  it('setCompletingTask(null) clears completingTask but not completingTaskIds', () => {
    const { store } = harness();
    store.getState().addCompletingTaskId(TASK_A);
    expect(store.getState().completingTaskIds.has(TASK_A)).toBe(true);

    store.getState().setCompletingTask(null);

    expect(store.getState().completingTask).toBeNull();
    // Only removeCompletingTaskId (the completion's finally) releases an id.
    expect(store.getState().completingTaskIds.has(TASK_A)).toBe(true);
  });

  it('addCompletingTaskId returns the same Set when the id is already present', () => {
    const { store } = harness();
    store.getState().addCompletingTaskId(TASK_A);
    const afterFirstAdd = store.getState().completingTaskIds;
    expect(afterFirstAdd.has(TASK_A)).toBe(true);

    store.getState().addCompletingTaskId(TASK_A);

    expect(store.getState().completingTaskIds).toBe(afterFirstAdd);
    expect(store.getState().completingTaskIds.size).toBe(1);
  });

  it('removeCompletingTaskId returns the same Set when the id is not present', () => {
    const { store } = harness();
    const before = store.getState().completingTaskIds;
    expect(before.has('nonexistent-id')).toBe(false);

    store.getState().removeCompletingTaskId('nonexistent-id');

    expect(store.getState().completingTaskIds).toBe(before);
    expect(store.getState().completingTaskIds.size).toBe(0);
  });

  it('finalizeCompletion releases completingTaskIds and the gate when the move IPC rejects', async () => {
    const { store, setMoveBehavior, moveCalls } = harness();
    setMoveBehavior(async () => { throw new Error('Simulated move failure'); });
    store.getState().setCompletingTask(completing(store, TASK_A, PROJECT_A));
    expect(store.getState().completingTaskIds.has(TASK_A)).toBe(true);

    await store.getState().finalizeCompletion();

    const after = store.getState();
    expect(moveCalls).toHaveLength(1);
    expect(after.completingTaskIds.has(TASK_A)).toBe(false);
    expect(after.completionGates.has(TASK_A)).toBe(false);
    expect(after.completingTask).toBeNull();
    // A failed move reports no success.
    expect(after.recentlyArchivedId).toBeNull();
    expect(useToastStore.getState().toasts.map((toast) => toast.variant)).not.toContain('success');
  });

  it('finalizeCompletion releases completingTaskIds when moveTask itself throws', async () => {
    const { store } = harness();
    store.setState({
      moveTask: async () => { throw new Error('Unexpected throw outside the IPC call'); },
    });
    store.getState().setCompletingTask(completing(store, TASK_A, PROJECT_A));
    // The test's replacement never calls removeCompletingTaskId itself, so a release here is
    // the completion's own finally.
    expect(store.getState().completingTaskIds.has(TASK_A)).toBe(true);

    await store.getState().finalizeCompletion();

    expect(store.getState().completingTaskIds.has(TASK_A)).toBe(false);
    expect(store.getState().completionGates.has(TASK_A)).toBe(false);
    expect(store.getState().recentlyArchivedId).toBeNull();
    expect(useToastStore.getState().toasts.map((toast) => toast.variant)).toEqual(['error']);
  });

  it('a second drop persists the first and both ids are released', async () => {
    const { store, setMoveBehavior, moveCalls } = harness();
    // Hold task A's move open so both ids are in the Set at once.
    let releaseMoveOfA: () => void = () => {};
    const moveOfAHeld = new Promise<void>((resolve) => { releaseMoveOfA = resolve; });
    setMoveBehavior(async (input) => {
      if (input.taskId === TASK_A) await moveOfAHeld;
    });

    store.getState().setCompletingTask(completing(store, TASK_A, PROJECT_A));
    expect(store.getState().completingTaskIds.has(TASK_A)).toBe(true);
    // The first drop is pre-approved, and the second drop ends its fly, so A persists now.
    store.getState().setCompletingTask(completing(store, TASK_B, PROJECT_A));

    expect(moveCalls.map((call) => call.input.taskId)).toEqual([TASK_A]);
    expect([...store.getState().completingTaskIds].sort()).toEqual([TASK_A, TASK_B]);
    expect(store.getState().completingTask?.taskId).toBe(TASK_B);

    // The mounted FlyingCard would end B's fly; finalize explicitly.
    await store.getState().finalizeCompletion();
    expect(moveCalls.map((call) => call.input.taskId)).toEqual([TASK_A, TASK_B]);
    // B is done and A's move is still in flight, so only A is held.
    expect([...store.getState().completingTaskIds]).toEqual([TASK_A]);

    releaseMoveOfA();
    await vi.waitFor(() => expect(store.getState().completingTaskIds.size).toBe(0));

    expect(store.getState().completionGates.size).toBe(0);
    expect(store.getState().completingTask).toBeNull();
  });
});

describe('TaskCompletionSlice project routing', () => {
  it('a success while switched away routes to the drop-time project and does not flag recentlyArchivedId on the foreign board', async () => {
    const { store, moveCalls } = harness();
    store.getState().setCompletingTask(completing(store, TASK_A, PROJECT_A), { gated: true });
    // The user clicks over to another project while the card is in flight.
    useProjectStore.setState({ currentProject: makeProject(PROJECT_B) });

    await store.getState().finalizeCompletion();

    // The move ran against the project stamped at drop, but the user is looking at B, and
    // recentlyArchivedId is global.
    expect(moveCalls).toHaveLength(1);
    expect(moveCalls[0].projectId).toBe(PROJECT_A);
    expect(store.getState().recentlyArchivedId).toBeNull();
    expect(store.getState().completingTaskIds.size).toBe(0);
  });

  it('a same-project completion sets recentlyArchivedId and raises the success toast', async () => {
    const { store } = harness();
    store.getState().setCompletingTask(completing(store, TASK_A, PROJECT_A), { gated: true });

    await store.getState().finalizeCompletion();

    expect(store.getState().recentlyArchivedId).toBe(TASK_A);
    expect(store.getState().completingTaskIds.size).toBe(0);
    expect(useToastStore.getState().toasts.map((toast) => toast.variant)).toEqual(['success']);
  });
});
