/**
 * #1211 in the mock bridge (tests/ui/mock-electron-api.js), which is the UI tier's bridge and the
 * web demo's runtime bridge: a board task outside a workflow joins it where it is, in To Do or
 * already started, and a task in Done, archived, or in a workflow cannot.
 *
 * The expected texts and rules come from main (src/main/workflows/workflow-service.ts and
 * src/shared/workflow-refusals.ts), which the mock must answer the same way. Loaded through
 * helpers/load-mock-electron-api.ts, one fresh mock per case.
 */
import { describe, expect, it } from 'vitest';
import { loadMockElectronApi, plain } from './helpers/load-mock-electron-api';
import type { MockObject, MockSeedState } from './helpers/load-mock-electron-api';

const BOARD = 'board-a';
const WORKFLOW_ID = 'wf-join';
const SEEDED_AT = '2026-01-01T00:00:00.000Z';

interface JoinCandidate {
  taskId: string;
  displayId: number;
  place: string;
}

interface WorkflowDetail {
  tasks: Array<{ key: string; planned: { existing_task_id: string | null } | null }>;
}

interface WorkflowsBridge {
  start(projectId: string, workflowId: string): Promise<void>;
  get(projectId: string, workflowId: string): Promise<WorkflowDetail>;
  listJoinCandidates(projectId: string, workflowId: string, boardProjectId: string): Promise<JoinCandidate[]>;
  addCardBlocker(projectId: string, workflowId: string, blockedKey: string, cardProjectId: string, cardTaskId: string): Promise<void>;
}

function lane(state: MockSeedState, templateIndex: number, id: string, name: string, role: 'todo' | 'done' | null, position: number): MockObject {
  return Object.assign({}, state.DEFAULT_SWIMLANES[templateIndex], {
    id, name, role, position, projectId: BOARD, auto_spawn: false, is_ghost: false, created_at: SEEDED_AT,
  });
}

function taskRow(id: string, displayId: number, swimlaneId: string, extra: MockObject = {}): MockObject {
  return {
    id, display_id: displayId, title: `Task ${id}`, description: '', swimlane_id: swimlaneId, position: 0,
    agent: 'claude', session_id: null, worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
    pr_state: null, base_branch: null, use_worktree: 0, labels: [], priority: 0, attachment_count: 0,
    archived_at: null, workflow_id: null, workflow_project_id: null, projectId: BOARD,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    canvas_x: null, canvas_y: null, created_at: SEEDED_AT, updated_at: SEEDED_AT,
    ...extra,
  };
}

function plannedTask(key: string, title: string, existingTaskId: string | null): MockObject {
  return {
    key, title, description: '', project_id: null, existing_task_id: existingTaskId,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    labels: [], priority: 0, canvas_x: null, canvas_y: null,
  };
}

/** The mock with one board (To Do, Executing, Done), a workflow in the given state, and the given task rows. */
function scenario(state: 'draft' | 'running', draftTasks: MockObject[], rows: MockObject[], links: MockObject[] = []) {
  const { electronApi, preConfigure } = loadMockElectronApi<{ workflows: WorkflowsBridge }>({
    __mockWorkflows: [{
      projectId: BOARD,
      workflow: {
        id: WORKFLOW_ID, title: 'Release', state, color_slot: 1, started_at: state === 'running' ? SEEDED_AT : null,
        draft: state === 'draft' ? { tasks: draftTasks, links } : null,
      },
    }],
    __mockWorkflowLinks: [],
  });
  const liveRows: MockObject[] = [];
  preConfigure((seed) => {
    seed.projects.push({
      id: BOARD, name: BOARD, path: `/mock/${BOARD}`, github_url: null, default_agent: 'claude',
      group_id: null, position: 0, last_opened: SEEDED_AT, created_at: SEEDED_AT,
    });
    seed.swimlanes.push(
      lane(seed, 0, 'a-todo', 'To Do', 'todo', 0),
      lane(seed, 2, 'a-exec', 'Executing', null, 1),
      lane(seed, 6, 'a-done', 'Done', 'done', 2),
    );
    seed.tasks.length = 0;
    seed.tasks.push(...rows);
    liveRows.push(...seed.tasks);
    return { currentProjectId: BOARD };
  });
  return { workflows: electronApi.workflows, rows: liveRows };
}

async function refusalOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (error) {
    return (error as { message?: string }).message ?? String(error);
  }
}

describe('the mock bridge joining a board task where it is', () => {
  it('starts a draft whose planned task takes in a started task, which keeps its column and gains the workflow', async () => {
    const { workflows, rows } = scenario('draft', [plannedTask('flight', 'In flight', 'flying')], [taskRow('flying', 1, 'a-exec')]);

    expect(await refusalOf(workflows.start(BOARD, WORKFLOW_ID))).toBeNull();

    const flying = rows.find((row) => row.id === 'flying')!;
    expect(flying.swimlane_id).toBe('a-exec');
    expect(flying.workflow_id).toBe(WORKFLOW_ID);
  });

  it('refuses to start a draft whose taken-in task is in Done, with main\'s text, and joins nothing', async () => {
    const { workflows, rows } = scenario('draft', [plannedTask('landed', 'Landed', 'shipped')], [taskRow('shipped', 4, 'a-done')]);

    const refusal = await refusalOf(workflows.start(BOARD, WORKFLOW_ID));

    expect(refusal).toContain('#4 is done. Only a task not yet in Done can join a workflow.');
    expect(rows.find((row) => row.id === 'shipped')!.workflow_id).toBeNull();
  });

  it('offers a task in To Do and a started one, newest first, and not one in Done, archived, or in a workflow', async () => {
    const { workflows } = scenario('running', [], [
      taskRow('todo', 1, 'a-todo'),
      taskRow('flying', 2, 'a-exec'),
      taskRow('shipped', 3, 'a-done'),
      taskRow('archived', 4, 'a-exec', { archived_at: SEEDED_AT }),
      taskRow('taken', 5, 'a-exec', { workflow_id: 'wf-other', workflow_project_id: BOARD }),
    ]);

    const candidates = plain(await workflows.listJoinCandidates(BOARD, WORKFLOW_ID, BOARD));

    expect(candidates.map((candidate) => [candidate.taskId, candidate.place])).toEqual([['flying', 'working'], ['todo', 'todo']]);
  });

  it('adds the same card as a blocker once before Start, and refuses it the second time', async () => {
    const { workflows } = scenario('draft', [plannedTask('other', 'Other', null)], [taskRow('card', 7, 'a-todo')]);

    await workflows.addCardBlocker(BOARD, WORKFLOW_ID, 'other', BOARD, 'card');
    const refusal = await refusalOf(workflows.addCardBlocker(BOARD, WORKFLOW_ID, 'other', BOARD, 'card'));

    expect(refusal).toMatch(/already in this plan/);
    const detail = plain(await workflows.get(BOARD, WORKFLOW_ID));
    expect(detail.tasks.filter((task) => task.planned?.existing_task_id === 'card')).toHaveLength(1);
  });
});
