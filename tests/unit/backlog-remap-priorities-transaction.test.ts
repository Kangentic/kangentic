/**
 * BACKLOG_REMAP_PRIORITIES runs the backlog, task and automation remaps in ONE
 * write transaction, on a real migrated project database. If the automation
 * remap throws, the backlog and task remaps roll back: otherwise a Priority
 * line would name levels the items no longer hold. The call wiring (which
 * repository gets which mapping, the returned sum) is pinned with mocks in
 * backlog-handler-repository-scope.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(),
  getExistingProjectDb: vi.fn(),
}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  spawnAgent: vi.fn(),
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(),
  openAttachmentFile: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({}));
vi.mock('../../src/main/boards', () => ({
  boardRegistry: { requireStable: vi.fn(), get: vi.fn(() => null) },
  repoFolderAdapter: {},
  ImportSourceStore: class {},
}));
vi.mock('../../src/main/boards/adapters/asana', () => ({ registerAsanaIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/jira', () => ({ registerJiraIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/linear', () => ({ registerLinearIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/trello', () => ({ registerTrelloIpcHandlers: vi.fn() }));
vi.mock('../../src/main/boards/adapters/gitlab', () => ({ registerGitLabIpcHandlers: vi.fn() }));

import { registerBacklogHandlers } from '../../src/main/ipc/handlers/backlog';
import { getProjectDb } from '../../src/main/db/database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { BacklogRepository } from '../../src/main/db/repositories/backlog-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { matchesTaskFilter } from '../../src/shared/automation-filter';
import { IPC } from '../../src/shared/ipc-channels';
import { openTestDatabase } from './helpers/test-database';

describe('BACKLOG_REMAP_PRIORITIES transaction', () => {
  let database: Database.Database;
  let backlog: BacklogRepository;
  let tasks: TaskRepository;
  let automations: AutomationRepository;
  let todoLaneId: string;

  // PrioritiesPopover's mapping for deleting level 2 (Medium) from five levels.
  const mapping = { 2: 0, 3: 2, 4: 3 };

  function remap(): unknown {
    const handler = capturedHandlers.get(IPC.BACKLOG_REMAP_PRIORITIES);
    if (!handler) throw new Error('BACKLOG_REMAP_PRIORITIES handler not registered');
    return handler(null, mapping);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    database = openTestDatabase();
    runProjectMigrations(database);
    vi.mocked(getProjectDb).mockReturnValue(database as never);
    backlog = new BacklogRepository(database);
    tasks = new TaskRepository(database);
    automations = new AutomationRepository(database);
    todoLaneId = new SwimlaneRepository(database).list().find((lane) => lane.role === 'todo')!.id;
    mockGetProjectRepos.mockReturnValue({ tasks, automations });
    registerBacklogHandlers({ currentProjectId: 'proj-1', currentProjectPath: '/mock/project' } as never);
  });

  afterEach(() => {
    database.close();
  });

  it('remaps backlog items and tasks and returns how many changed', () => {
    const backlogItem = backlog.create({ title: 'backlog urgent', description: '', priority: 4 });
    const task = tasks.create({ title: 'task medium', description: '', swimlane_id: todoLaneId, priority: 2 });

    expect(remap()).toBe(2);

    expect(backlog.getById(backlogItem.id)?.priority).toBe(3);
    expect(tasks.getById(task.id)?.priority).toBe(0);
  });

  // The invariant the Priority line exists for: after a level is deleted, a row
  // keeps matching the tasks it matched. Real repositories, no mocked remap.
  it('moves a row\'s Priority line with the tasks, so it matches the same tasks afterwards', () => {
    const urgentTask = tasks.create({ title: 'urgent', description: '', swimlane_id: todoLaneId, priority: 4 });
    const highTask = tasks.create({ title: 'high', description: '', swimlane_id: todoLaneId, priority: 3 });
    const mediumTask = tasks.create({ title: 'medium', description: '', swimlane_id: todoLaneId, priority: 2 });
    automations.replaceForColumn(todoLaneId, [
      { name: 'Urgent only', type: 'notify', trigger: 'enter', enabled: true, config: {}, final_line: null, text_match_source: 'agent', filter: { priorities: [4], labels: [] } },
      { name: 'Deleted level', type: 'notify', trigger: 'exit', enabled: true, config: {}, final_line: null, text_match_source: 'agent', filter: { priorities: [2, 3], labels: ['bug'] } },
    ]);
    const rowFilter = (name: string) => automations.listForColumn(todoLaneId).find((row) => row.name === name)?.filter;
    const facts = (taskId: string) => {
      const task = tasks.getById(taskId)!;
      return { priority: task.priority, labels: task.labels };
    };
    expect(matchesTaskFilter(rowFilter('Urgent only'), facts(urgentTask.id))).toBe(true);

    remap();

    expect(rowFilter('Urgent only')).toEqual({ priorities: [3], labels: [] });
    expect(matchesTaskFilter(rowFilter('Urgent only'), facts(urgentTask.id))).toBe(true);
    expect(matchesTaskFilter(rowFilter('Urgent only'), facts(highTask.id))).toBe(false);
    // The deleted level folds into 0 as the tasks' own did, and the other level follows its tasks.
    expect(rowFilter('Deleted level')).toEqual({ priorities: [0, 2], labels: ['bug'] });
    expect(facts(mediumTask.id).priority).toBe(0);
    expect(facts(highTask.id).priority).toBe(2);
  });

  it('rolls the backlog and task remaps back when the automation remap throws', () => {
    const backlogItem = backlog.create({ title: 'backlog urgent', description: '', priority: 4 });
    const task = tasks.create({ title: 'task medium', description: '', swimlane_id: todoLaneId, priority: 2 });
    const failure = new Error('automation remap failed');
    vi.spyOn(automations, 'remapFilterPriorities').mockImplementation(() => { throw failure; });

    expect(() => remap()).toThrow(failure);

    // Both earlier writes ran, then were undone with the transaction.
    expect(backlog.getById(backlogItem.id)?.priority).toBe(4);
    expect(tasks.getById(task.id)?.priority).toBe(2);
  });
});
