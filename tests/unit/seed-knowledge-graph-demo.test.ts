/**
 * `seedKnowledgeGraphDemo` (src/devtools/main/seed-knowledge-graph-demo.ts) registers the web demo's
 * sample install as real projects in a preview, so the Knowledge Graph the demo shows is built by
 * the shipped pipeline. It runs against a real global database and real per-project databases
 * (better-sqlite3 loads in vitest, and tests/unit/helpers/isolate-data-dir.ts points both at a
 * throwaway directory), and only `projectRepo` and the MCP server handle are read off the context.
 *
 * Two contracts. A plan that fails a check throws before the FIRST write, so nothing is registered:
 * a second seed would double every task, and a throw midway would leave a half-seeded graph. And a
 * valid plan creates each project with its tickets numbered as planned, its archived tasks
 * archived, its backlog, and one exited session row per planned session, and hands back the maps
 * the capture script uses to turn created ids back into the dataset's keys.
 *
 * In every refusal plan the FIRST project is valid and the fault sits in the SECOND. A seeder that
 * validated and wrote one project at a time would register the first before refusing the second,
 * which is the case "validates the whole plan before its first write" exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { seedKnowledgeGraphDemo } from '../../src/devtools/main/seed-knowledge-graph-demo';
import { closeAll, getProjectDb } from '../../src/main/db/database';
import { ProjectRepository } from '../../src/main/db/repositories/project-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { BacklogRepository } from '../../src/main/db/repositories/backlog-repository';
import type { DevSeedKnowledgeGraphDemoPlan, DevSeedKnowledgeGraphDemoResult } from '../../src/shared/types';

type PlannedProject = DevSeedKnowledgeGraphDemoPlan['projects'][number];

const projectRepo = new ProjectRepository();
// The seeder reads `projectRepo` and `mcpServerHandle` off the context. The graph capture never
// needs the server, so these tests run with none; the placement tests below supply one.
const context = { projectRepo, mcpServerHandle: null };

let pathCounter = 0;
/** A path no other test in this file uses. It is only a string: the seeder never touches the disk. */
function uniquePath(label: string): string {
  pathCounter += 1;
  return path.join(os.tmpdir(), 'kg-demo-seed-test', `${label}-${pathCounter}`);
}

/**
 * A valid project. Its tasks are listed out of ticket order (#2 before #1) on purpose, because the
 * seeder creates them in ticket order and the allocator numbers by creation order. A seeder that
 * created them as listed would number #2 as #1 and refuse its own plan.
 */
function buildProjectPlan(key: string, overrides: Partial<PlannedProject> = {}): PlannedProject {
  return {
    key,
    name: `Sample ${key}`,
    path: uniquePath(key),
    defaultAgent: 'claude',
    tasks: [
      { key: `${key}-open`, title: `${key} open task`, description: 'Still on the board.', labels: ['bug'], displayId: 2, done: false, archived: false },
      { key: `${key}-archived`, title: `${key} archived task`, description: 'Finished and archived.', labels: ['feature', 'infra'], displayId: 1, done: true, archived: true },
      { key: `${key}-done`, title: `${key} done task`, description: 'Finished, still in Done.', labels: [], displayId: 3, done: true, archived: false },
    ],
    backlog: [
      { title: `${key} backlog idea`, description: 'Maybe later.', priority: 2, labels: ['idea'] },
      { title: `${key} second idea`, description: '', priority: 0, labels: [] },
    ],
    sessions: [
      { key: `${key}-session-claude`, taskKey: `${key}-archived`, agent: 'claude', agentSessionId: `history-${key}-claude`, cwd: path.join(os.tmpdir(), 'kg-demo-seed-test', `${key}-claude-cwd`) },
      { key: `${key}-session-codex`, taskKey: `${key}-open`, agent: 'codex', agentSessionId: null, cwd: path.join(os.tmpdir(), 'kg-demo-seed-test', `${key}-codex-cwd`) },
    ],
    ...overrides,
  };
}

function registeredProjectIds(): string[] {
  return projectRepo.list().map((project) => project.id);
}

/** Refuse `plan` with `message`, and hold that nothing was registered, the valid first project included. */
function expectRefusal(plan: DevSeedKnowledgeGraphDemoPlan, message: string): void {
  const before = registeredProjectIds();
  expect(() => seedKnowledgeGraphDemo(context, plan)).toThrow(message);
  expect(registeredProjectIds()).toEqual(before);
  const firstProjectPath = path.resolve(plan.projects[0].path);
  expect(
    projectRepo.list().some((project) => path.resolve(project.path) === firstProjectPath),
    'the valid first project was registered by a refused plan',
  ).toBe(false);
}

afterAll(() => {
  closeAll();
});

describe('seedKnowledgeGraphDemo refuses a plan before writing anything', () => {
  it('refuses a project already registered at a planned path, however the path is spelled', () => {
    const existingPath = uniquePath('existing');
    projectRepo.create({ name: 'Already here', path: existingPath });
    // A trailing separator is stripped by path.resolve, so only isSamePath sees these as one place.
    const spelledDifferently = existingPath + path.sep;
    const good = buildProjectPlan('refuse-dup-good');
    const bad = buildProjectPlan('refuse-dup-bad', { path: spelledDifferently });

    expectRefusal({ projects: [good, bad] }, `A project is already registered at ${spelledDifferently}`);
  });

  it('refuses two planned projects at one path, however the path is spelled', () => {
    const good = buildProjectPlan('refuse-shared-good');
    const sharedPath = good.path + path.sep;
    const bad = buildProjectPlan('refuse-shared-bad', { path: sharedPath });

    expectRefusal({ projects: [good, bad] }, `Sample refuse-shared-bad: the plan puts it at ${sharedPath}, where it also puts Sample refuse-shared-good`);
  });

  it('refuses a project key the plan carries twice', () => {
    const good = buildProjectPlan('refuse-project-key-good');
    const bad = buildProjectPlan('refuse-project-key-bad', { key: good.key });

    expectRefusal({ projects: [good, bad] }, 'The plan carries project refuse-project-key-good twice');
  });

  it('refuses two sessions pointing at one history, across projects', () => {
    const good = buildProjectPlan('refuse-history-good');
    const bad = buildProjectPlan('refuse-history-bad');
    bad.sessions[0] = { ...bad.sessions[0], agentSessionId: good.sessions[0].agentSessionId };

    expectRefusal({ projects: [good, bad] }, `The plan points two sessions at the history ${good.sessions[0].agentSessionId}`);
  });

  it('refuses a task key a project carries twice', () => {
    const good = buildProjectPlan('refuse-task-key-good');
    const bad = buildProjectPlan('refuse-task-key-bad');
    bad.tasks[1] = { ...bad.tasks[1], key: bad.tasks[0].key };

    expectRefusal({ projects: [good, bad] }, `Sample refuse-task-key-bad: the plan carries task ${bad.tasks[0].key} twice`);
  });

  it('refuses a session key a project carries twice', () => {
    const good = buildProjectPlan('refuse-session-key-good');
    const bad = buildProjectPlan('refuse-session-key-bad');
    bad.sessions[1] = { ...bad.sessions[1], key: bad.sessions[0].key };

    expectRefusal({ projects: [good, bad] }, `Sample refuse-session-key-bad: the plan carries session ${bad.sessions[0].key} twice`);
  });

  it('refuses a plan with no projects array, as a script could send over IPC', () => {
    const before = registeredProjectIds();
    expect(() => seedKnowledgeGraphDemo(context, {} as DevSeedKnowledgeGraphDemoPlan)).toThrow('The demo graph plan carries no projects array');
    expect(registeredProjectIds()).toEqual(before);
  });

  it('refuses an agent with no adapter', () => {
    const good = buildProjectPlan('refuse-agent-good');
    const bad = buildProjectPlan('refuse-agent-bad');
    bad.sessions[0] = { ...bad.sessions[0], agent: 'no-such-agent' };

    expectRefusal({ projects: [good, bad] }, 'No adapter is registered for agent "no-such-agent"');
  });

  it.each([
    ['a gap in the numbering', [1, 3], '1 to 2 (found #3 at position 2)'],
    ['numbering that does not start at 1', [2, 3], '1 to 2 (found #2 at position 1)'],
    ['a repeated number', [1, 1], '1 to 2 (found #1 at position 2)'],
  ])('refuses tickets that are not numbered 1 to n: %s', (_label, displayIds, expectedTail) => {
    const good = buildProjectPlan('refuse-numbering-good');
    const bad = buildProjectPlan('refuse-numbering-bad', {
      tasks: displayIds.map((displayId, index) => ({
        key: `numbered-${index}`, title: `Ticket ${index}`, description: '', labels: [], displayId, done: false, archived: false,
      })),
      sessions: [],
    });

    expectRefusal({ projects: [good, bad] }, `Sample refuse-numbering-bad: the plan's tickets are not numbered ${expectedTail}`);
  });

  it('refuses a session that names a task the plan lacks', () => {
    const good = buildProjectPlan('refuse-task-good');
    const bad = buildProjectPlan('refuse-task-bad');
    bad.sessions[1] = { ...bad.sessions[1], key: 'orphan-session', taskKey: 'task-that-is-not-in-the-plan' };

    expectRefusal(
      { projects: [good, bad] },
      'Sample refuse-task-bad: session orphan-session names task task-that-is-not-in-the-plan, which the plan does not carry',
    );
  });

  // A task placed in a column the board lacks would land in To Do, and a recorded MCP call would
  // then read a board the scene does not paint.
  it('refuses a task placed in a column the new board does not have', () => {
    const good = buildProjectPlan('refuse-lane-good');
    const bad = buildProjectPlan('refuse-lane-bad');
    bad.tasks[0] = { ...bad.tasks[0], lane: 'Staging' };

    expectRefusal({ projects: [good, bad] }, 'Sample refuse-lane-bad: the plan names a column "Staging" the new board does not have');
  });

  it('refuses an agent named on a column the new board does not have', () => {
    const good = buildProjectPlan('refuse-column-agent-good');
    const bad = buildProjectPlan('refuse-column-agent-bad', { columnAgents: { QA: 'claude' } });

    expectRefusal({ projects: [good, bad] }, 'Sample refuse-column-agent-bad: the plan names a column "QA" the new board does not have');
  });

  // Checked like a session's agent: written to agent_override, an unknown one would only fail when
  // the recorded move's auto-spawn resolved the column.
  it('refuses a column agent no adapter is registered for', () => {
    const good = buildProjectPlan('refuse-column-adapter-good');
    const bad = buildProjectPlan('refuse-column-adapter-bad', { columnAgents: { 'Code Review': 'no-such-agent' } });

    expectRefusal({ projects: [good, bad] }, 'Sample refuse-column-adapter-bad: the plan names agent "no-such-agent" on Code Review, and no adapter is registered for it');
  });
});

/**
 * The plan the MCP capture sends (scripts/lib/demo-mcp-capture.mjs): every task in its own column,
 * each column's agent, and the recorded task's branch and worktree, which `kangentic_get_current_task`
 * resolves a caller by. The result names the project's MCP URL and the server's token, which the
 * capture writes into the agent's mcp.json.
 */
describe('seedKnowledgeGraphDemo places a board for a recorded MCP session', () => {
  const plan = buildProjectPlan('placed', {
    columnAgents: { 'Code Review': 'claude', Merge: 'copilot' },
    tasks: [
      { key: 'placed-review', title: 'Placed in review', description: '', labels: [], displayId: 2, done: false, archived: false, lane: 'Code Review', branchName: 'placed-review', baseBranch: 'main', worktreePath: path.join(os.tmpdir(), 'kg-demo-seed-test', 'placed-worktree') },
      { key: 'placed-planning', title: 'Placed in planning', description: '', labels: [], displayId: 1, done: false, archived: false, lane: 'Planning' },
      { key: 'placed-unplaced', title: 'Not placed', description: '', labels: [], displayId: 3, done: false, archived: false },
      { key: 'placed-done', title: 'Done and placed', description: '', labels: [], displayId: 4, done: true, archived: true, lane: 'Merge' },
    ],
    sessions: [],
  });
  const mcpServerHandle = {
    baseUrl: 'http://127.0.0.1:4000/mcp',
    token: 'launch-token',
    urlForProject: (projectId: string) => `http://127.0.0.1:4000/mcp/${projectId}`,
    close: () => undefined,
  };
  let result: DevSeedKnowledgeGraphDemoResult;

  beforeAll(() => {
    result = seedKnowledgeGraphDemo({ projectRepo, mcpServerHandle }, { projects: [plan] });
  });

  function laneNamed(name: string): string | undefined {
    return new SwimlaneRepository(getProjectDb(result.projects[0].projectId)).list().find((lane) => lane.name === name)?.id;
  }

  function rowFor(title: string) {
    const taskRepository = new TaskRepository(getProjectDb(result.projects[0].projectId));
    return [...taskRepository.list(), ...taskRepository.listArchived()].find((task) => task.title === title);
  }

  it('puts each placed task in its column, an unplaced one in To Do, and a done one in Done', () => {
    expect(rowFor('Placed in review')?.swimlane_id).toBe(laneNamed('Code Review'));
    expect(rowFor('Placed in planning')?.swimlane_id).toBe(laneNamed('Planning'));
    expect(rowFor('Not placed')?.swimlane_id).toBe(laneNamed('To Do'));
    // Done wins over a lane: an archived task is the history, wherever the plan says it sat.
    expect(rowFor('Done and placed')?.swimlane_id).toBe(laneNamed('Done'));
  });

  it('names each planned column\'s agent and leaves the rest alone', () => {
    const lanes = new SwimlaneRepository(getProjectDb(result.projects[0].projectId)).list();
    const agentOf = (name: string) => lanes.find((lane) => lane.name === name)?.agent_override ?? null;
    expect(agentOf('Code Review')).toBe('claude');
    expect(agentOf('Merge')).toBe('copilot');
    expect(agentOf('Executing')).toBeNull();
  });

  it('gives the recorded task its branch, base and worktree, and no other task one', () => {
    const recorded = rowFor('Placed in review');
    expect(recorded?.branch_name).toBe('placed-review');
    expect(recorded?.base_branch).toBe('main');
    expect(recorded?.worktree_path).toBe(path.join(os.tmpdir(), 'kg-demo-seed-test', 'placed-worktree'));
    expect(rowFor('Placed in planning')?.worktree_path ?? null).toBeNull();
  });

  it('reports the project\'s MCP URL and the server\'s token', () => {
    expect(result.mcpToken).toBe('launch-token');
    expect(result.projects[0].mcpUrl).toBe(`http://127.0.0.1:4000/mcp/${result.projects[0].projectId}`);
  });

  it('reports no MCP URL or token when the server is off', () => {
    const offPlan = buildProjectPlan('placed-server-off', { sessions: [] });
    const offResult = seedKnowledgeGraphDemo({ projectRepo, mcpServerHandle: null }, { projects: [offPlan] });
    expect(offResult.mcpToken).toBeNull();
    expect(offResult.projects[0].mcpUrl).toBeNull();
  });
});

describe('seedKnowledgeGraphDemo writes a valid plan', () => {
  const first = buildProjectPlan('seed-first');
  const second = buildProjectPlan('seed-second', { defaultAgent: 'codex' });
  const planned = [first, second];
  let idsBeforeSeed: string[];
  let result: DevSeedKnowledgeGraphDemoResult;

  beforeAll(() => {
    idsBeforeSeed = registeredProjectIds();
    result = seedKnowledgeGraphDemo(context, { projects: planned });
  });

  it('registers each project at its planned name, path and default agent, and reports them in plan order', () => {
    expect(result.projects.map((project) => project.key)).toEqual([first.key, second.key]);
    const created = result.projects.map((project) => projectRepo.getById(project.projectId));
    expect(created.map((project) => project?.name)).toEqual([first.name, second.name]);
    expect(created.map((project) => project?.path)).toEqual([first.path, second.path]);
    expect(created.map((project) => project?.default_agent)).toEqual(['claude', 'codex']);
    // Exactly the two new rows: the seed registered nothing else.
    const newIds = registeredProjectIds().filter((id) => !idsBeforeSeed.includes(id)).sort();
    expect(newIds).toEqual(result.projects.map((project) => project.projectId).sort());
  });

  it('numbers every ticket as planned, in each project\'s own sequence', () => {
    for (const [index, plannedProject] of planned.entries()) {
      const taskRepository = new TaskRepository(getProjectDb(result.projects[index].projectId));
      const created = [...taskRepository.list(), ...taskRepository.listArchived()];
      expect(created, plannedProject.name).toHaveLength(plannedProject.tasks.length);
      for (const task of plannedProject.tasks) {
        const row = created.find((candidate) => candidate.title === task.title);
        expect(row?.display_id, `${plannedProject.name} / ${task.title}`).toBe(task.displayId);
        expect(row?.description, task.title).toBe(task.description);
        expect(row?.labels, task.title).toEqual(task.labels);
      }
    }
  });

  it('puts a Done task in Done and the rest in To Do, and archives exactly the archived ones', () => {
    for (const [index, plannedProject] of planned.entries()) {
      const projectDatabase = getProjectDb(result.projects[index].projectId);
      const lanes = new SwimlaneRepository(projectDatabase).list();
      const todoLaneId = lanes.find((lane) => lane.role === 'todo')?.id;
      const doneLaneId = lanes.find((lane) => lane.role === 'done')?.id;
      expect(todoLaneId, 'a new board has a To Do column').toBeTruthy();
      expect(doneLaneId, 'a new board has a Done column').toBeTruthy();

      const taskRepository = new TaskRepository(projectDatabase);
      const archivedTitles = taskRepository.listArchived().map((task) => task.title).sort();
      const onBoardTitles = taskRepository.list().map((task) => task.title).sort();
      expect(archivedTitles).toEqual(plannedProject.tasks.filter((task) => task.archived).map((task) => task.title).sort());
      expect(onBoardTitles).toEqual(plannedProject.tasks.filter((task) => !task.archived).map((task) => task.title).sort());
      // Vacuity guards: the plan has both an archived task and an on-board one.
      expect(archivedTitles.length).toBeGreaterThan(0);
      expect(onBoardTitles.length).toBeGreaterThan(0);

      const created = [...taskRepository.list(), ...taskRepository.listArchived()];
      for (const task of plannedProject.tasks) {
        const row = created.find((candidate) => candidate.title === task.title);
        expect(row?.swimlane_id, task.title).toBe(task.done ? doneLaneId : todoLaneId);
      }
    }
  });

  it('keeps the backlog, in order', () => {
    for (const [index, plannedProject] of planned.entries()) {
      const items = new BacklogRepository(getProjectDb(result.projects[index].projectId)).list();
      const asPlanned = items.map((item) => ({ title: item.title, description: item.description, priority: item.priority, labels: item.labels }));
      expect(asPlanned, plannedProject.name).toEqual(plannedProject.backlog);
    }
  });

  it('writes one exited session row per planned session, with its agent session id and cwd', () => {
    const expectedSessionType: Record<string, string> = { claude: 'claude_agent', codex: 'codex_agent' };
    for (const [index, plannedProject] of planned.entries()) {
      const { projectId, sessionKeys, taskKeys } = result.projects[index];
      const rows = new SessionRepository(getProjectDb(projectId)).listAll();
      expect(rows, plannedProject.name).toHaveLength(plannedProject.sessions.length);
      for (const plannedSession of plannedProject.sessions) {
        const row = rows.find((candidate) => sessionKeys[candidate.id] === plannedSession.key);
        expect(row, `${plannedSession.key} has a row`).toBeDefined();
        expect(row?.status, plannedSession.key).toBe('exited');
        expect(row?.exit_code, plannedSession.key).toBe(0);
        expect(row?.agent_session_id, plannedSession.key).toBe(plannedSession.agentSessionId);
        expect(row?.cwd, plannedSession.key).toBe(plannedSession.cwd);
        expect(row?.session_type, plannedSession.key).toBe(expectedSessionType[plannedSession.agent]);
        // The row hangs off the task the plan names, not just any task.
        expect(taskKeys[row?.task_id ?? ''], plannedSession.key).toBe(plannedSession.taskKey);
        // UTC instants, per the timestamp rule.
        for (const instant of [row?.started_at, row?.suspended_at, row?.exited_at]) {
          expect(new Date(instant ?? '').toISOString(), plannedSession.key).toBe(instant);
        }
      }
    }
  });

  it('maps every created task and session id back to its plan key, and no other', () => {
    for (const [index, plannedProject] of planned.entries()) {
      const { projectId, taskKeys, sessionKeys } = result.projects[index];
      const taskRepository = new TaskRepository(getProjectDb(projectId));
      expect(Object.values(taskKeys).sort()).toEqual(plannedProject.tasks.map((task) => task.key).sort());
      expect(Object.values(sessionKeys).sort()).toEqual(plannedProject.sessions.map((session) => session.key).sort());
      for (const [taskId, taskKey] of Object.entries(taskKeys)) {
        const plannedTask = plannedProject.tasks.find((task) => task.key === taskKey);
        expect(taskRepository.getById(taskId)?.title, taskKey).toBe(plannedTask?.title);
      }
    }
  });
});

/**
 * Two checks can only run once a project is written: the new board's columns, and the number the
 * allocator hands each task. Neither fails on a real board today, so each is forced through a spy
 * on the real repository. Both throw rather than seed a graph that disagrees with the dataset, and
 * the file header documents that what was already written stays.
 */
describe('seedKnowledgeGraphDemo refuses after its first write', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function isRegistered(projectPath: string): boolean {
    return projectRepo.list().some((project) => path.resolve(project.path) === path.resolve(projectPath));
  }

  it('refuses a new board with no To Do column, leaving the project it registered', () => {
    const plan = buildProjectPlan('no-todo-lane');
    const realList = SwimlaneRepository.prototype.list;
    vi.spyOn(SwimlaneRepository.prototype, 'list').mockImplementation(function (this: SwimlaneRepository) {
      return realList.call(this).filter((lane) => lane.role !== 'todo');
    });

    expect(() => seedKnowledgeGraphDemo(context, { projects: [plan] })).toThrow('Sample no-todo-lane: the new board has no To Do or Done column');
    expect(isRegistered(plan.path)).toBe(true);
  });

  it('refuses a task the allocator numbers other than the plan does', () => {
    const plan = buildProjectPlan('renumbered');
    const realCreate = TaskRepository.prototype.create;
    vi.spyOn(TaskRepository.prototype, 'create').mockImplementation(function (this: TaskRepository, input) {
      const created = realCreate.call(this, input);
      return { ...created, display_id: created.display_id + 10 };
    });

    // Tasks are created in ticket order, so ticket #1 (the archived task) is the first refused.
    expect(() => seedKnowledgeGraphDemo(context, { projects: [plan] })).toThrow('Sample renumbered: "renumbered archived task" was numbered #11, the dataset says #1');
    expect(isRegistered(plan.path)).toBe(true);
  });
});
