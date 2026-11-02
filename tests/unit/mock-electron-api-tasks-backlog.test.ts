/**
 * The mock bridge's backlog and task writes (tests/ui/mock-electron-api.js) answer as the desktop
 * does, evaluated in a `node:vm` context with no browser.
 *
 * The mock is the UI tier's bridge and the web demo's runtime bridge, so a UI spec that leans on
 * one of these answers is only as true as the mock. These cases read the mock itself:
 *
 * - promoting a backlog item to the board carries its labels and priority, and demoting a board
 *   task back keeps the task's own labels and priority (main's TaskRepository and
 *   BacklogRepository do the same);
 * - renaming or deleting a label rewrites it on backlog items AND board tasks, and counts both;
 * - `tasks.update` accepts the per-task automations hold on a workflow task, as main has since
 *   #923. A mock that still refused it would hide every UI case that holds one.
 *
 * The card's label pills render in a browser, so that case stays in
 * `tests/ui/label-promotion.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import { loadMockElectronApi, plain } from './helpers/load-mock-electron-api';

interface BacklogItem {
  id: string;
  title: string;
  labels: string[];
  priority: number;
}

interface BoardTask {
  id: string;
  title: string;
  labels: string[];
  priority: number;
  automations_disabled?: boolean;
}

interface Swimlane {
  id: string;
}

interface TasksAndBacklogBridge {
  projects: { openByPath(projectPath: string): Promise<unknown> };
  swimlanes: { list(): Promise<Swimlane[]> };
  tasks: {
    list(): Promise<BoardTask[]>;
    update(input: Record<string, unknown>): Promise<BoardTask>;
  };
  backlog: {
    list(): Promise<BacklogItem[]>;
    create(input: { title: string; description: string; priority: number; labels: string[] }): Promise<BacklogItem>;
    promote(input: { backlogTaskIds: string[]; targetSwimlaneId: string }): Promise<BoardTask[]>;
    demote(input: { taskId: string }): Promise<BacklogItem>;
    renameLabel(oldName: string, newName: string): Promise<number>;
    deleteLabel(name: string): Promise<number>;
  };
}

/** A mock with one open project, so it has the default board's columns. */
async function openProject(): Promise<{ bridge: TasksAndBacklogBridge; todoLaneId: string }> {
  const { electronApi } = loadMockElectronApi<TasksAndBacklogBridge>();
  await electronApi.projects.openByPath('/mock/projects/label-test');
  const lanes = await electronApi.swimlanes.list();
  return { bridge: electronApi, todoLaneId: lanes[0].id };
}

async function createBacklogItem(
  bridge: TasksAndBacklogBridge,
  title: string,
  labels: string[],
  priority: number,
): Promise<string> {
  const item = await bridge.backlog.create({ title, description: '', priority, labels });
  return item.id;
}

describe('mock backlog: promotion and demotion', () => {
  it('a promoted backlog item carries its labels and priority to the board task', async () => {
    const { bridge, todoLaneId } = await openProject();
    const itemId = await createBacklogItem(bridge, 'Labeled task', ['bug', 'ui'], 3);

    await bridge.backlog.promote({ backlogTaskIds: [itemId], targetSwimlaneId: todoLaneId });

    const promoted = plain(await bridge.tasks.list()).find((task) => task.title === 'Labeled task');
    expect(promoted).toBeDefined();
    expect(promoted!.labels).toEqual(['bug', 'ui']);
    expect(promoted!.priority).toBe(3);
    // The item left the backlog when it became a task.
    expect(plain(await bridge.backlog.list()).map((item) => item.id)).not.toContain(itemId);
  });

  it('a demoted board task keeps its labels and priority on the backlog item', async () => {
    const { bridge, todoLaneId } = await openProject();
    const itemId = await createBacklogItem(bridge, 'Demote test', ['feature'], 2);
    await bridge.backlog.promote({ backlogTaskIds: [itemId], targetSwimlaneId: todoLaneId });
    const task = plain(await bridge.tasks.list()).find((candidate) => candidate.title === 'Demote test');
    expect(task).toBeDefined();

    // No explicit labels or priority: the task's own are used.
    await bridge.backlog.demote({ taskId: task!.id });

    const demoted = plain(await bridge.backlog.list()).find((item) => item.title === 'Demote test');
    expect(demoted).toBeDefined();
    expect(demoted!.labels).toEqual(['feature']);
    expect(demoted!.priority).toBe(2);
    expect(plain(await bridge.tasks.list()).map((candidate) => candidate.id)).not.toContain(task!.id);
  });
});

describe('mock backlog: label rewrites reach backlog items and board tasks', () => {
  it('renameLabel renames on both', async () => {
    const { bridge, todoLaneId } = await openProject();
    await createBacklogItem(bridge, 'Backlog task', ['old-label'], 0);
    const promoteItemId = await createBacklogItem(bridge, 'Board task', ['old-label'], 1);
    await bridge.backlog.promote({ backlogTaskIds: [promoteItemId], targetSwimlaneId: todoLaneId });

    await bridge.backlog.renameLabel('old-label', 'new-label');

    const backlogTask = plain(await bridge.backlog.list()).find((item) => item.title === 'Backlog task');
    expect(backlogTask!.labels).toEqual(['new-label']);
    const boardTask = plain(await bridge.tasks.list()).find((task) => task.title === 'Board task');
    expect(boardTask!.labels).toEqual(['new-label']);
  });

  it('deleteLabel removes it from both and keeps the other labels', async () => {
    const { bridge, todoLaneId } = await openProject();
    await createBacklogItem(bridge, 'Backlog task', ['keep', 'remove'], 0);
    const promoteItemId = await createBacklogItem(bridge, 'Board task', ['keep', 'remove'], 0);
    await bridge.backlog.promote({ backlogTaskIds: [promoteItemId], targetSwimlaneId: todoLaneId });

    await bridge.backlog.deleteLabel('remove');

    const backlogTask = plain(await bridge.backlog.list()).find((item) => item.title === 'Backlog task');
    expect(backlogTask!.labels).toEqual(['keep']);
    const boardTask = plain(await bridge.tasks.list()).find((task) => task.title === 'Board task');
    expect(boardTask!.labels).toEqual(['keep']);
  });
});

describe('mock tasks.update: the per-task automations hold', () => {
  const WORKFLOW_ID = 'wf-hold';
  const PROJECT_ID = 'proj-hold';
  const WORKFLOW_TASK_ID = 'task-hold-workflow';
  const ORDINARY_TASK_ID = 'task-hold-ordinary';

  function holdScenario(): TasksAndBacklogBridge {
    const timestamp = '2026-10-01T00:00:00.000Z';
    const { electronApi, preConfigure } = loadMockElectronApi<TasksAndBacklogBridge>({
      __mockWorkflows: [{
        workflow: { id: WORKFLOW_ID, title: 'Refusal', state: 'running', draft: null, color_slot: 5, source_task_id: null },
      }],
      __mockWorkflowLinks: [],
    });
    preConfigure((state) => {
      state.projects.push({
        id: PROJECT_ID, name: 'Hold project', path: '/mock/hold-project', github_url: null,
        default_agent: 'claude', group_id: null, position: 0, last_opened: timestamp, created_at: timestamp,
      });
      state.DEFAULT_SWIMLANES.forEach((swimlane, index) => {
        state.swimlanes.push({ ...swimlane, id: `lane-hold-${index}`, position: index, created_at: timestamp });
      });
      const executingLane = state.swimlanes.find((swimlane) => swimlane.name === 'Executing');
      const todoLane = state.swimlanes.find((swimlane) => swimlane.name === 'To Do');
      const baseRow = {
        description: '', position: 0, agent: null, session_id: null, worktree_path: null, branch_name: null,
        pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0, labels: [],
        priority: 0, attachment_count: 0, archived_at: null, automations_disabled: false,
        route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
        canvas_x: null, canvas_y: null, created_at: timestamp, updated_at: timestamp,
      };
      state.tasks.push(
        {
          ...baseRow, id: WORKFLOW_TASK_ID, display_id: 35, title: 'Task inside a workflow',
          swimlane_id: executingLane!.id, workflow_id: WORKFLOW_ID, workflow_project_id: PROJECT_ID,
        },
        {
          ...baseRow, id: ORDINARY_TASK_ID, display_id: 36, title: 'Ordinary task',
          swimlane_id: todoLane!.id, workflow_id: null, workflow_project_id: null,
        },
      );
      return { currentProjectId: PROJECT_ID };
    });
    return electronApi;
  }

  async function holdOf(bridge: TasksAndBacklogBridge, taskId: string, held: boolean): Promise<boolean | undefined> {
    const task = await bridge.tasks.update({ id: taskId, automations_disabled: held });
    return task.automations_disabled;
  }

  it('holds and releases a workflow task, and holds an ordinary task', async () => {
    const bridge = holdScenario();

    expect(await holdOf(bridge, WORKFLOW_TASK_ID, true)).toBe(true);
    expect(await holdOf(bridge, WORKFLOW_TASK_ID, false)).toBe(false);
    expect(await holdOf(bridge, ORDINARY_TASK_ID, true)).toBe(true);

    // The write is on the stored row, not only on the returned copy.
    const stored = plain(await bridge.tasks.list());
    expect(stored.find((task) => task.id === WORKFLOW_TASK_ID)?.automations_disabled).toBe(false);
    expect(stored.find((task) => task.id === ORDINARY_TASK_ID)?.automations_disabled).toBe(true);
  });
});
