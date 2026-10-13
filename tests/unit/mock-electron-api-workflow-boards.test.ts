/**
 * The mock bridge's workflows (tests/ui/mock-electron-api.js) read each task's OWN board.
 *
 * The mock is both the UI tier's bridge and the web demo's runtime bridge. The web demo seeds
 * three boards, each with its own To Do, route columns and Done, and tags every swimlane with a
 * `projectId`. A UI spec seeds one untagged lane set instead. `boardLanes(projectId)` hands a
 * project its tagged lanes (else the untagged ones), and `boardOf(entry, task)` names the board a
 * task sits on (`task.projectId || task.project_id || homeOf(entry)`).
 *
 * Every UI spec uses untagged lanes, so reverting any of this to "the first matching lane of any
 * project" keeps all of them green. This file closes that hole. It evaluates the real mock in a
 * `node:vm` context (the same way mock-electron-api-parity.test.ts does) and seeds TWO tagged
 * boards through the mock's own seed hooks (`__mockPreConfigure`, `__mockWorkflows`), then drives
 * the public `workflows.*` methods.
 *
 * Why every behavior runs under both lane orders. A project-blind lookup returns the first lane of
 * a role in the swimlane list, so it is wrong exactly when the OTHER board's lane is listed first.
 * Which board that is depends on the assertion: a task planned for board B needs board A's To Do
 * listed first, while a lookup on the home board needs board B's Done listed first. One order
 * cannot be the wrong one for both, so each behavior runs with the home board's lanes first and
 * with the other board's lanes first, and a project-blind revert is red in whichever order it
 * picks the wrong lane. Lane ids are unique across boards, as in the real app.
 *
 * The expected values below come from main, not from the mock: a task is created in its own
 * board's To Do (src/main/workflows/workflow-service.ts), Start moves the source task from the
 * HOME board's To Do to the HOME board's Done (supersedeSourceTask), a route is read against the
 * columns of the task's own board, and a ghost lane is skipped by todoColumn and doneColumn
 * (src/shared/workflow-route.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const MOCK_ELECTRON_API_PATH = path.resolve(__dirname, '..', 'ui', 'mock-electron-api.js');
const MOCK_SOURCE = fs.readFileSync(MOCK_ELECTRON_API_PATH, 'utf-8');

const HOME_BOARD = 'board-a';
const OTHER_BOARD = 'board-b';
const WORKFLOW_ID = 'wf-boards';
const SEEDED_AT = '2026-01-01T00:00:00.000Z';
const ROUTE_REFUSAL = 'A task visits at least one column.';
/** Main's Start refusal for a draft with no tasks (workflow-service.ts), title and all. */
const EMPTY_DRAFT_REFUSAL = '"Usage budgets" has no tasks yet. Save a plan with kangentic_save_workflow first.';
/** Each board's route columns in order, which a task's `steps` name on its own board. */
const HOME_STEP_IDS = ['a-plan', 'a-review'];
const OTHER_STEP_IDS = ['b-build', 'b-review', 'b-qa', 'b-stage', 'b-ship'];

type MockObject = Record<string, unknown>;

interface LaneSpec {
  id: string;
  name: string;
  role: 'todo' | 'done' | null;
  autoSpawn: boolean;
  ghost: boolean;
}

interface TaskRow {
  id: string;
  title: string;
  /** The board tag a task carries when it sits on a board other than its workflow's home. */
  projectId?: string;
  swimlane_id: string;
  archived_at: string | null;
  workflow_id: string | null;
  route_start_swimlane_id: string | null;
  route_last_swimlane_id: string | null;
  skipped_swimlane_ids: string[];
}

interface PlannedTask {
  key: string;
  title: string;
  project_id: string | null;
  route_start_swimlane_id: string | null;
  route_last_swimlane_id: string | null;
  skipped_swimlane_ids: string[];
}

interface WorkflowDetail {
  boardEnds: Record<string, { todo: { swimlaneId: string } | null; done: { swimlaneId: string } | null }>;
  tasks: Array<{
    key: string;
    title: string;
    projectId: string;
    planned: PlannedTask | null;
    steps: Array<{ swimlaneId: string }>;
  }>;
}

interface WorkflowSummary {
  workflow: { id: string };
  boardTasks: Record<string, { humanGateTargetId: string | null }>;
}

interface Supersession {
  sourceTaskId: string;
  workflowId: string;
}

interface WorkflowsBridge {
  list(projectId: string): Promise<WorkflowSummary[]>;
  listSupersessions(projectId: string): Promise<Supersession[]>;
  get(projectId: string, workflowId: string): Promise<WorkflowDetail>;
  start(projectId: string, workflowId: string): Promise<void>;
  addTask(projectId: string, workflowId: string, input: { title: string; projectId?: string }): Promise<string>;
  setRoute(projectId: string, workflowId: string, key: string, swimlaneIds: string[]): Promise<void>;
}

interface MockSeedState {
  projects: unknown[];
  swimlanes: unknown[];
  tasks: TaskRow[];
  DEFAULT_SWIMLANES: MockObject[];
}

type PreConfigure = (seed: (state: MockSeedState) => { currentProjectId: string }) => void;

/** One workflow entry as `window.__mockWorkflows` takes it. */
interface WorkflowSeed {
  projectId: string;
  workflow: MockObject;
}

interface ScenarioOptions {
  /** True lists the other board's lanes ahead of the home board's. */
  otherBoardFirst: boolean;
  /** True puts a ghost To Do and a ghost Done on the home board ahead of its real ones. */
  homeGhosts?: boolean;
  workflow: WorkflowSeed;
  tasks?: MockObject[];
}

interface Scenario {
  workflows: WorkflowsBridge;
  tasks: TaskRow[];
}

/**
 * The home board: To Do, two columns that start no agent (a human gate), Done. The ghost lanes,
 * when asked for, come BEFORE the real To Do and Done they shadow.
 */
function homeLaneSpecs(withGhosts: boolean): LaneSpec[] {
  const ghosts: LaneSpec[] = withGhosts
    ? [{ id: 'a-todo-ghost', name: 'To Do (ghost)', role: 'todo', autoSpawn: false, ghost: true }]
    : [];
  const doneGhosts: LaneSpec[] = withGhosts
    ? [{ id: 'a-done-ghost', name: 'Done (ghost)', role: 'done', autoSpawn: false, ghost: true }]
    : [];
  return [
    ...ghosts,
    { id: 'a-todo', name: 'To Do', role: 'todo', autoSpawn: false, ghost: false },
    { id: 'a-plan', name: 'Plan', role: null, autoSpawn: false, ghost: false },
    { id: 'a-review', name: 'Review', role: null, autoSpawn: false, ghost: false },
    ...doneGhosts,
    { id: 'a-done', name: 'Done', role: 'done', autoSpawn: false, ghost: false },
  ];
}

/** The other board: five route columns, more than the home board has, none starting an agent. */
function otherLaneSpecs(): LaneSpec[] {
  return [
    { id: 'b-todo', name: 'Backlog', role: 'todo', autoSpawn: false, ghost: false },
    { id: 'b-build', name: 'Build', role: null, autoSpawn: false, ghost: false },
    { id: 'b-review', name: 'Peer review', role: null, autoSpawn: false, ghost: false },
    { id: 'b-qa', name: 'QA', role: null, autoSpawn: false, ghost: false },
    { id: 'b-stage', name: 'Staging', role: null, autoSpawn: false, ghost: false },
    { id: 'b-ship', name: 'Ship', role: null, autoSpawn: false, ghost: false },
    { id: 'b-done', name: 'Shipped', role: 'done', autoSpawn: false, ghost: false },
  ];
}

function laneRow(state: MockSeedState, spec: LaneSpec, boardId: string, position: number): MockObject {
  // The mock's own default lanes carry every column field the renderer reads.
  const templateIndex = spec.role === 'todo' ? 0 : spec.role === 'done' ? 6 : 2;
  return Object.assign({}, state.DEFAULT_SWIMLANES[templateIndex], {
    id: spec.id,
    name: spec.name,
    role: spec.role,
    position,
    projectId: boardId,
    auto_spawn: spec.autoSpawn,
    is_ghost: spec.ghost,
    created_at: SEEDED_AT,
  });
}

function projectRow(boardId: string, position: number): MockObject {
  return {
    id: boardId, name: boardId, path: `/mock/${boardId}`, github_url: null, default_agent: 'claude',
    group_id: null, position, last_opened: SEEDED_AT, created_at: SEEDED_AT,
  };
}

/** A task row as the mock keeps one. `boardId` is the row's `projectId` tag, which names its board. */
function taskRow(options: {
  id: string;
  displayId: number;
  swimlaneId: string;
  boardId: string;
  workflowId?: string;
}): MockObject {
  return {
    id: options.id, display_id: options.displayId, title: `Task ${options.id}`, description: '',
    swimlane_id: options.swimlaneId, position: 0, agent: 'claude', session_id: null, worktree_path: null,
    branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null, use_worktree: 0,
    labels: [], priority: 0, attachment_count: 0, archived_at: null,
    workflow_id: options.workflowId ?? null, workflow_project_id: options.workflowId ? HOME_BOARD : null,
    projectId: options.boardId,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    canvas_x: null, canvas_y: null, created_at: SEEDED_AT, updated_at: SEEDED_AT,
  };
}

function plannedTask(key: string, title: string, boardId: string | null): MockObject {
  return {
    key, title, description: '', project_id: boardId, existing_task_id: null,
    route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
    labels: [], priority: 0, canvas_x: null, canvas_y: null,
  };
}

function draftSeed(planned: MockObject[], extras: MockObject = {}): WorkflowSeed {
  return {
    projectId: HOME_BOARD,
    workflow: { id: WORKFLOW_ID, title: 'Usage budgets', state: 'draft', color_slot: 1, draft: { tasks: planned, links: [] }, ...extras },
  };
}

function runningSeed(): WorkflowSeed {
  return {
    projectId: HOME_BOARD,
    workflow: { id: WORKFLOW_ID, title: 'Usage budgets', state: 'running', color_slot: 1, draft: null, started_at: SEEDED_AT },
  };
}

/**
 * Runs the real mock in a fresh vm context, seeds two tagged boards through its own hooks, and
 * hands back the public `workflows` bridge plus the LIVE task array (the mock pushes into it).
 * Only `workflows.*` is called afterwards: other namespaces reassign the swimlane array this seeds.
 */
function loadScenario(options: ScenarioOptions): Scenario {
  const windowObject: MockObject = {};
  windowObject.window = windowObject;
  windowObject.__mockWorkflows = [options.workflow];
  windowObject.__mockWorkflowLinks = [];
  const sandbox: MockObject = {
    window: windowObject,
    document: undefined,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(MOCK_SOURCE, sandbox, { filename: MOCK_ELECTRON_API_PATH, timeout: 5000 });

  const electronApi = windowObject.electronAPI as { workflows?: WorkflowsBridge } | undefined;
  const preConfigure = windowObject.__mockPreConfigure as PreConfigure | undefined;
  if (!electronApi?.workflows || !preConfigure) {
    throw new Error('mock-electron-api-workflow-boards: the mock no longer exposes workflows or __mockPreConfigure.');
  }

  let liveTasks: TaskRow[] = [];
  preConfigure((state) => {
    state.projects.push(projectRow(HOME_BOARD, 0), projectRow(OTHER_BOARD, 1));
    const homeSpecs = homeLaneSpecs(options.homeGhosts === true).map((spec, position) => laneRow(state, spec, HOME_BOARD, position));
    const otherSpecs = otherLaneSpecs().map((spec, position) => laneRow(state, spec, OTHER_BOARD, position));
    state.swimlanes.push(...(options.otherBoardFirst ? [...otherSpecs, ...homeSpecs] : [...homeSpecs, ...otherSpecs]));
    for (const row of options.tasks ?? []) {
      state.tasks.push(row as unknown as TaskRow);
    }
    liveTasks = state.tasks;
    return { currentProjectId: HOME_BOARD };
  });
  return { workflows: electronApi.workflows, tasks: liveTasks };
}

/** Values the mock builds live in the vm's realm; a JSON round trip hands back plain host values. */
function plain<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

/** The message a rejected call carries, read structurally because the Error is the vm's own. */
async function refusalOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (error) {
    return (error as { message?: string }).message ?? String(error);
  }
}

function rowByTitle(scenario: Scenario, title: string): TaskRow {
  const row = scenario.tasks.find((candidate) => candidate.title === title);
  if (!row) throw new Error(`No task titled "${title}" was created.`);
  return row;
}

function rowById(scenario: Scenario, taskId: string): TaskRow {
  const row = scenario.tasks.find((candidate) => candidate.id === taskId);
  if (!row) throw new Error(`No task with id "${taskId}".`);
  return row;
}

function entryByTitle(detail: WorkflowDetail, title: string): WorkflowDetail['tasks'][number] {
  const entry = detail.tasks.find((candidate) => candidate.title === title);
  if (!entry) throw new Error(`The workflow detail has no task titled "${title}".`);
  return entry;
}

function stepIdsOf(entry: WorkflowDetail['tasks'][number]): string[] {
  return entry.steps.map((step) => step.swimlaneId);
}

const LANE_ORDERS = [
  { name: 'home board lanes listed first', otherBoardFirst: false },
  { name: 'other board lanes listed first', otherBoardFirst: true },
];

describe.each(LANE_ORDERS)('workflows on a mock with two tagged boards, $name', ({ otherBoardFirst }) => {
  describe('Start on a draft', () => {
    it('creates a task planned for the other board in that board\'s To Do, and an unassigned one in the home board\'s To Do', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: draftSeed([
          plannedTask('task-1', 'Phone alert', OTHER_BOARD),
          plannedTask('task-2', 'Server budget', null),
        ]),
      });

      await scenario.workflows.start(HOME_BOARD, WORKFLOW_ID);

      expect(rowByTitle(scenario, 'Phone alert').swimlane_id).toBe('b-todo');
      expect(rowByTitle(scenario, 'Server budget').swimlane_id).toBe('a-todo');
    });

    it('moves a source task from the home board\'s To Do to the home board\'s Done, archives it, and reports the supersession', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: draftSeed([plannedTask('task-1', 'Server budget', null)], { source_task_id: 'src-task' }),
        tasks: [taskRow({ id: 'src-task', displayId: 7, swimlaneId: 'a-todo', boardId: HOME_BOARD })],
      });

      await scenario.workflows.start(HOME_BOARD, WORKFLOW_ID);

      const source = rowById(scenario, 'src-task');
      expect(source.swimlane_id).toBe('a-done');
      expect(typeof source.archived_at).toBe('string');
      const supersessions = plain(await scenario.workflows.listSupersessions(HOME_BOARD));
      expect(supersessions.map((entry) => [entry.sourceTaskId, entry.workflowId])).toEqual([['src-task', WORKFLOW_ID]]);
    });

    it('refuses a draft with no tasks with main\'s full message, and creates nothing', async () => {
      const scenario = loadScenario({ otherBoardFirst, workflow: draftSeed([]) });

      const refusal = await refusalOf(scenario.workflows.start(HOME_BOARD, WORKFLOW_ID));

      expect(refusal).toBe(EMPTY_DRAFT_REFUSAL);
      expect(scenario.tasks).toHaveLength(0);
    });
  });

  describe('the board a created task sits on', () => {
    it('is tagged on a task Start creates for the other board, and left untagged on a home board task', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: draftSeed([
          plannedTask('task-1', 'Phone alert', OTHER_BOARD),
          plannedTask('task-2', 'Server budget', null),
        ]),
      });

      await scenario.workflows.start(HOME_BOARD, WORKFLOW_ID);

      const detail = plain(await scenario.workflows.get(HOME_BOARD, WORKFLOW_ID));
      const onOtherBoard = entryByTitle(detail, 'Phone alert');
      const onHomeBoard = entryByTitle(detail, 'Server budget');
      expect(onOtherBoard.projectId).toBe(OTHER_BOARD);
      expect(stepIdsOf(onOtherBoard)).toEqual(OTHER_STEP_IDS);
      expect(onHomeBoard.projectId).toBe(HOME_BOARD);
      expect(stepIdsOf(onHomeBoard)).toEqual(HOME_STEP_IDS);
      expect(rowByTitle(scenario, 'Phone alert').projectId).toBe(OTHER_BOARD);
      expect(rowByTitle(scenario, 'Server budget').projectId).toBeUndefined();
    });

    it('is tagged on a task addTask creates for the other board, and left untagged on a home board task', async () => {
      const scenario = loadScenario({ otherBoardFirst, workflow: runningSeed() });

      await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Phone alert', projectId: OTHER_BOARD });
      await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Server budget' });
      await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Budget docs', projectId: HOME_BOARD });

      const detail = plain(await scenario.workflows.get(HOME_BOARD, WORKFLOW_ID));
      const onOtherBoard = entryByTitle(detail, 'Phone alert');
      expect(onOtherBoard.projectId).toBe(OTHER_BOARD);
      expect(stepIdsOf(onOtherBoard)).toEqual(OTHER_STEP_IDS);
      for (const title of ['Server budget', 'Budget docs']) {
        const onHomeBoard = entryByTitle(detail, title);
        expect(onHomeBoard.projectId).toBe(HOME_BOARD);
        expect(stepIdsOf(onHomeBoard)).toEqual(HOME_STEP_IDS);
      }
      expect(rowByTitle(scenario, 'Phone alert').projectId).toBe(OTHER_BOARD);
      expect(rowByTitle(scenario, 'Server budget').projectId).toBeUndefined();
      expect(rowByTitle(scenario, 'Budget docs').projectId).toBeUndefined();
    });

    it('carries through to a later setRoute on a task Start created for the other board', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: draftSeed([plannedTask('task-1', 'Phone alert', OTHER_BOARD)]),
      });
      await scenario.workflows.start(HOME_BOARD, WORKFLOW_ID);
      const created = rowByTitle(scenario, 'Phone alert');

      await scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, created.id, ['b-review', 'b-stage']);

      expect(created.route_start_swimlane_id).toBe('b-review');
      expect(created.route_last_swimlane_id).toBe('b-stage');
      expect(plain(created.skipped_swimlane_ids)).toEqual(['b-qa']);
    });

    it('carries through to a later setRoute on a task addTask created for the other board', async () => {
      const scenario = loadScenario({ otherBoardFirst, workflow: runningSeed() });
      const taskId = await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Phone alert', projectId: OTHER_BOARD });

      await scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, taskId, ['b-review', 'b-stage']);

      const created = rowById(scenario, taskId);
      expect(created.route_start_swimlane_id).toBe('b-review');
      expect(created.route_last_swimlane_id).toBe('b-stage');
      expect(plain(created.skipped_swimlane_ids)).toEqual(['b-qa']);
    });
  });

  describe('addTask on a running workflow', () => {
    it('creates the task in the To Do of the board the input names, and in the home board\'s without one', async () => {
      const scenario = loadScenario({ otherBoardFirst, workflow: runningSeed() });

      const onOtherBoard = await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Phone alert', projectId: OTHER_BOARD });
      const unassigned = await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Server budget' });
      const onHomeBoard = await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Budget docs', projectId: HOME_BOARD });

      expect(rowById(scenario, onOtherBoard).swimlane_id).toBe('b-todo');
      expect(rowById(scenario, unassigned).swimlane_id).toBe('a-todo');
      expect(rowById(scenario, onHomeBoard).swimlane_id).toBe('a-todo');
      expect(rowById(scenario, onOtherBoard).workflow_id).toBe(WORKFLOW_ID);
    });
  });

  describe('setRoute', () => {
    it('stores a started task\'s route against the columns of the board it sits on', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: runningSeed(),
        tasks: [
          taskRow({ id: 'task-b', displayId: 1, swimlaneId: 'b-build', boardId: OTHER_BOARD, workflowId: WORKFLOW_ID }),
          taskRow({ id: 'task-a', displayId: 2, swimlaneId: 'a-plan', boardId: HOME_BOARD, workflowId: WORKFLOW_ID }),
        ],
      });

      // The other board's route columns are build, peer review, QA, staging, ship. Review and
      // staging with QA left out leaves a start, a last and one skipped column all set.
      await scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, 'task-b', ['b-review', 'b-stage']);
      const otherRow = rowById(scenario, 'task-b');
      expect(otherRow.route_start_swimlane_id).toBe('b-review');
      expect(otherRow.route_last_swimlane_id).toBe('b-stage');
      expect(plain(otherRow.skipped_swimlane_ids)).toEqual(['b-qa']);

      // The home board's route columns are plan and review: review alone starts there, runs to the end.
      await scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, 'task-a', ['a-review']);
      const homeRow = rowById(scenario, 'task-a');
      expect(homeRow.route_start_swimlane_id).toBe('a-review');
      expect(homeRow.route_last_swimlane_id).toBeNull();
      expect(plain(homeRow.skipped_swimlane_ids)).toEqual([]);
    });

    it('refuses the home board\'s column ids for a task that sits on the other board, and writes nothing', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: runningSeed(),
        tasks: [taskRow({ id: 'task-b', displayId: 1, swimlaneId: 'b-build', boardId: OTHER_BOARD, workflowId: WORKFLOW_ID })],
      });

      const refusal = await refusalOf(scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, 'task-b', ['a-plan', 'a-review']));

      expect(refusal).toBe(ROUTE_REFUSAL);
      expect(rowById(scenario, 'task-b').route_start_swimlane_id).toBeNull();
    });

    it('reads a planned task\'s route against the board it is planned for', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: draftSeed([plannedTask('task-1', 'Phone alert', OTHER_BOARD), plannedTask('task-2', 'Server budget', null)]),
      });

      await scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, 'task-1', ['b-review', 'b-stage']);
      const refusal = await refusalOf(scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, 'task-1', ['a-plan']));
      await scenario.workflows.setRoute(HOME_BOARD, WORKFLOW_ID, 'task-2', ['a-review']);

      expect(refusal).toBe(ROUTE_REFUSAL);
      const detail = plain(await scenario.workflows.get(HOME_BOARD, WORKFLOW_ID));
      const planned = (key: string) => detail.tasks.find((entry) => entry.key === key)?.planned;
      expect(planned('task-1')?.route_start_swimlane_id).toBe('b-review');
      expect(planned('task-1')?.route_last_swimlane_id).toBe('b-stage');
      expect(planned('task-1')?.skipped_swimlane_ids).toEqual(['b-qa']);
      expect(planned('task-2')?.route_start_swimlane_id).toBe('a-review');
    });
  });

  describe('the board summary\'s human gate', () => {
    it('targets the next route column on the task\'s own board, or that board\'s Done after the last', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: runningSeed(),
        tasks: [
          taskRow({ id: 'task-b-build', displayId: 1, swimlaneId: 'b-build', boardId: OTHER_BOARD, workflowId: WORKFLOW_ID }),
          taskRow({ id: 'task-b-ship', displayId: 2, swimlaneId: 'b-ship', boardId: OTHER_BOARD, workflowId: WORKFLOW_ID }),
          taskRow({ id: 'task-a-plan', displayId: 3, swimlaneId: 'a-plan', boardId: HOME_BOARD, workflowId: WORKFLOW_ID }),
          taskRow({ id: 'task-a-review', displayId: 4, swimlaneId: 'a-review', boardId: HOME_BOARD, workflowId: WORKFLOW_ID }),
        ],
      });

      const summaries = plain(await scenario.workflows.list(HOME_BOARD));
      const summary = summaries.find((entry) => entry.workflow.id === WORKFLOW_ID);
      const gateOf = (taskId: string) => summary?.boardTasks[taskId]?.humanGateTargetId;

      expect(gateOf('task-b-build')).toBe('b-review');
      expect(gateOf('task-b-ship')).toBe('b-done');
      expect(gateOf('task-a-plan')).toBe('a-review');
      expect(gateOf('task-a-review')).toBe('a-done');
    });
  });

  describe('the workflow detail\'s board ends', () => {
    it('names each board\'s own To Do and Done', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        workflow: draftSeed([plannedTask('task-1', 'Phone alert', OTHER_BOARD), plannedTask('task-2', 'Server budget', null)]),
      });

      const detail = plain(await scenario.workflows.get(HOME_BOARD, WORKFLOW_ID));

      expect(detail.boardEnds[HOME_BOARD]?.todo?.swimlaneId).toBe('a-todo');
      expect(detail.boardEnds[HOME_BOARD]?.done?.swimlaneId).toBe('a-done');
      expect(detail.boardEnds[OTHER_BOARD]?.todo?.swimlaneId).toBe('b-todo');
      expect(detail.boardEnds[OTHER_BOARD]?.done?.swimlaneId).toBe('b-done');
    });
  });

  describe('a ghost lane on the home board, listed ahead of the real To Do and Done', () => {
    it('is skipped by Start when it places a task in To Do', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        homeGhosts: true,
        workflow: draftSeed([plannedTask('task-1', 'Server budget', null)]),
      });

      await scenario.workflows.start(HOME_BOARD, WORKFLOW_ID);

      expect(rowByTitle(scenario, 'Server budget').swimlane_id).toBe('a-todo');
    });

    it('is skipped by addTask when it places a task in To Do', async () => {
      const scenario = loadScenario({ otherBoardFirst, homeGhosts: true, workflow: runningSeed() });

      const taskId = await scenario.workflows.addTask(HOME_BOARD, WORKFLOW_ID, { title: 'Server budget' });

      expect(rowById(scenario, taskId).swimlane_id).toBe('a-todo');
    });

    it('is skipped when Start moves a source task to Done', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        homeGhosts: true,
        workflow: draftSeed([plannedTask('task-1', 'Server budget', null)], { source_task_id: 'src-task' }),
        tasks: [taskRow({ id: 'src-task', displayId: 7, swimlaneId: 'a-todo', boardId: HOME_BOARD })],
      });

      await scenario.workflows.start(HOME_BOARD, WORKFLOW_ID);

      expect(rowById(scenario, 'src-task').swimlane_id).toBe('a-done');
    });

    it('is not named by the workflow detail as the board\'s To Do or Done', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        homeGhosts: true,
        workflow: draftSeed([plannedTask('task-1', 'Phone alert', OTHER_BOARD)]),
      });

      const detail = plain(await scenario.workflows.get(HOME_BOARD, WORKFLOW_ID));

      expect(detail.boardEnds[HOME_BOARD]?.todo?.swimlaneId).toBe('a-todo');
      expect(detail.boardEnds[HOME_BOARD]?.done?.swimlaneId).toBe('a-done');
    });

    it('is not the human gate target after the last route column', async () => {
      const scenario = loadScenario({
        otherBoardFirst,
        homeGhosts: true,
        workflow: runningSeed(),
        tasks: [taskRow({ id: 'task-a-review', displayId: 4, swimlaneId: 'a-review', boardId: HOME_BOARD, workflowId: WORKFLOW_ID })],
      });

      const summaries = plain(await scenario.workflows.list(HOME_BOARD));
      const summary = summaries.find((entry) => entry.workflow.id === WORKFLOW_ID);

      expect(summary?.boardTasks['task-a-review']?.humanGateTargetId).toBe('a-done');
    });
  });
});
