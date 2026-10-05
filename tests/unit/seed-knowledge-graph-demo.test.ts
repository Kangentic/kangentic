/**
 * `seedKnowledgeGraphDemo` (src/devtools/main/seed-knowledge-graph-demo.ts) registers the web demo's
 * sample install as real projects in a preview, so the Knowledge Graph the demo shows is built by
 * the shipped pipeline. It runs against a real global database and real per-project databases
 * (better-sqlite3 loads in vitest, and tests/unit/helpers/isolate-data-dir.ts points both at a
 * throwaway directory), and only `projectRepo` is read off the context.
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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
// The seeder reads `projectRepo` off the context and nothing else, so that is all this supplies.
const context = { projectRepo };

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
