/**
 * Unit tests for CommandBridge - the file-based command queue processor
 * that bridges the MCP server process to the Electron main process.
 *
 * Mocks the database layer (better-sqlite3 + repositories) so the tests
 * validate CommandBridge logic without loading the native SQLite module.
 * This avoids the ABI conflict between Electron (which needs better-sqlite3
 * compiled for its Node ABI) and vitest (which runs under system Node).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Task, Swimlane } from '../../src/shared/types';

// ── In-memory store for mock repositories ────────────────────────────────

let mockSwimlanes: Swimlane[] = [];
let mockTasks: Task[] = [];
let mockArchivedTasks: Task[] = [];
let taskIdCounter = 0;

function resetMockStore(): void {
  taskIdCounter = 0;
  mockSwimlanes = [
    makeSwimlane('sw-backlog', 'Backlog', 'backlog', 0),
    makeSwimlane('sw-planning', 'Planning', null, 1),
    makeSwimlane('sw-executing', 'Executing', null, 2),
    makeSwimlane('sw-codereview', 'Code Review', null, 3),
    makeSwimlane('sw-tests', 'Tests', null, 4),
    makeSwimlane('sw-shipit', 'Ship It', null, 5),
    makeSwimlane('sw-done', 'Done', 'done', 6, true),
  ];
  mockTasks = [];
  mockArchivedTasks = [];
}

function makeSwimlane(
  id: string,
  name: string,
  role: 'backlog' | 'done' | null,
  position: number,
  isArchived = false,
): Swimlane {
  return {
    id,
    name,
    role,
    position,
    color: '#888888',
    icon: null,
    is_archived: isArchived,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    plan_exit_target_id: null,
    created_at: new Date().toISOString(),
  };
}

function makeTask(overrides: Partial<Task> & { title: string; swimlane_id: string }): Task {
  taskIdCounter++;
  const now = new Date().toISOString();
  return {
    id: `task-${taskIdCounter}`,
    title: overrides.title,
    description: overrides.description ?? '',
    swimlane_id: overrides.swimlane_id,
    position: mockTasks.filter((task) => task.swimlane_id === overrides.swimlane_id).length,
    agent: null,
    session_id: null,
    worktree_path: overrides.worktree_path ?? null,
    branch_name: overrides.branch_name ?? null,
    pr_number: overrides.pr_number ?? null,
    pr_url: overrides.pr_url ?? null,
    base_branch: overrides.base_branch ?? null,
    use_worktree: overrides.use_worktree ?? null,
    attachment_count: 0,
    archived_at: overrides.archived_at ?? null,
    created_at: now,
    updated_at: now,
  };
}

// ── Module mocks ─────────────────────────────────────────────────────────

vi.mock('better-sqlite3', () => {
  return {
    default: class MockDatabase {
      prepare() {
        return {
          all: () => [],
          get: () => undefined,
          run: () => {},
        };
      }
      close() {}
    },
  };
});

vi.mock('../../src/main/db/migrations', () => ({
  runProjectMigrations: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class MockSwimlaneRepository {
    list() { return mockSwimlanes; }
    getById(id: string) { return mockSwimlanes.find((swimlane) => swimlane.id === id); }
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class MockTaskRepository {
    create(input: { title: string; description?: string; swimlane_id: string; customBranchName?: string; baseBranch?: string; useWorktree?: boolean }) {
      const task = makeTask({
        title: input.title,
        description: input.description ?? '',
        swimlane_id: input.swimlane_id,
        branch_name: input.customBranchName ?? null,
        base_branch: input.baseBranch ?? null,
        use_worktree: input.useWorktree != null ? (input.useWorktree ? 1 : 0) : null,
      });
      mockTasks.push(task);
      return task;
    }
    list(swimlaneId?: string) {
      if (swimlaneId) {
        return mockTasks.filter((task) => task.swimlane_id === swimlaneId);
      }
      return mockTasks;
    }
    getById(id: string) { return mockTasks.find((task) => task.id === id); }
    update(input: { id: string; title?: string; description?: string; branch_name?: string; pr_url?: string; pr_number?: number }) {
      const index = mockTasks.findIndex((task) => task.id === input.id);
      if (index === -1) throw new Error(`Task ${input.id} not found`);
      const updated = { ...mockTasks[index] };
      if (input.title !== undefined) updated.title = input.title;
      if (input.description !== undefined) updated.description = input.description;
      if (input.branch_name !== undefined) updated.branch_name = input.branch_name;
      if (input.pr_url !== undefined) updated.pr_url = input.pr_url;
      if (input.pr_number !== undefined) updated.pr_number = input.pr_number;
      updated.updated_at = new Date().toISOString();
      mockTasks[index] = updated;
      return updated;
    }
    listArchived() { return mockArchivedTasks; }
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class MockSessionRepository {
    getSummaryForTask() { return null; }
    listAllSummaries() { return {}; }
  },
}));

// ── Import after mocks are set up ────────────────────────────────────────

import { CommandBridge } from '../../src/main/agent/command-bridge';
import Database from 'better-sqlite3';

let tmpDir: string;
let database: ReturnType<typeof Database>;

function createBridge(overrides?: {
  onTaskCreated?: (task: Task, columnName: string, swimlaneId: string) => void;
  onTaskUpdated?: (task: Task) => void;
}): CommandBridge {
  return new CommandBridge({
    commandsPath: path.join(tmpDir, 'commands.jsonl'),
    responsesDir: path.join(tmpDir, 'responses'),
    projectId: 'test-project',
    getProjectDb: () => database,
    onTaskCreated: overrides?.onTaskCreated ?? (() => {}),
    onTaskUpdated: overrides?.onTaskUpdated ?? (() => {}),
  });
}

/** Write a command and trigger processing by calling the internal method. */
function sendCommand(bridge: CommandBridge, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const commandLine = JSON.stringify({ id: requestId, method, params, ts: Date.now() });

  // Append to commands file
  fs.appendFileSync(path.join(tmpDir, 'commands.jsonl'), commandLine + '\n');

  // Trigger processing (bypass FileWatcher for synchronous testing)
  (bridge as unknown as { processNewCommands: () => void }).processNewCommands();

  // Read response
  const responsePath = path.join(tmpDir, 'responses', `${requestId}.json`);
  if (!fs.existsSync(responsePath)) {
    throw new Error(`No response file for request ${requestId}`);
  }
  return JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
}

beforeEach(() => {
  resetMockStore();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-bridge-'));
  fs.mkdirSync(path.join(tmpDir, 'responses'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'commands.jsonl'), '');
  database = new Database(':memory:');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CommandBridge - create_task', () => {
  it('creates a task in backlog by default', () => {
    const createdTasks: Array<{ task: Task; column: string }> = [];
    const bridge = createBridge({
      onTaskCreated: (task, columnName) => createdTasks.push({ task, column: columnName }),
    });
    bridge.start();

    const response = sendCommand(bridge, 'create_task', {
      title: 'Fix login bug',
      description: 'Users cannot log in',
    });

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('Fix login bug');
    expect(response.message).toContain('Backlog');

    // Verify task was stored in mock
    expect(mockTasks).toHaveLength(1);
    expect(mockTasks[0].title).toBe('Fix login bug');
    expect(mockTasks[0].description).toBe('Users cannot log in');

    // Verify callback fired
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].column).toBe('Backlog');
  });

  it('creates a task in a named column (case-insensitive)', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'create_task', {
      title: 'Plan feature',
      column: 'planning',
    });

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('Planning');

    expect(mockTasks).toHaveLength(1);
    expect(mockTasks[0].title).toBe('Plan feature');
    expect(mockTasks[0].swimlane_id).toBe('sw-planning');
  });

  it('returns error for non-existent column', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'create_task', {
      title: 'Some task',
      column: 'Nonexistent',
    });

    bridge.stop();

    expect(response.success).toBe(false);
    expect(response.error).toContain('Nonexistent');
    expect(response.error).toContain('Available columns');
  });

  it('returns error for empty title', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'create_task', { title: '   ' });

    bridge.stop();

    expect(response.success).toBe(false);
    expect(response.error).toContain('title is required');
  });

  it('truncates title to 200 chars', () => {
    const bridge = createBridge();
    bridge.start();

    const longTitle = 'x'.repeat(300);
    sendCommand(bridge, 'create_task', { title: longTitle });

    bridge.stop();

    expect(mockTasks[0].title).toHaveLength(200);
  });
});

describe('CommandBridge - list_columns', () => {
  it('returns all non-archived columns with task counts', () => {
    // Seed some tasks
    const taskA = makeTask({ title: 'Task 1', swimlane_id: 'sw-backlog' });
    const taskB = makeTask({ title: 'Task 2', swimlane_id: 'sw-backlog' });
    mockTasks.push(taskA, taskB);

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'list_columns');

    bridge.stop();

    expect(response.success).toBe(true);
    const columns = response.data as Array<{ name: string; role: string; taskCount: number }>;
    // 6 non-archived columns (Done is archived)
    expect(columns).toHaveLength(6);

    const backlogColumn = columns.find((column) => column.name === 'Backlog');
    expect(backlogColumn?.taskCount).toBe(2);
    expect(backlogColumn?.role).toBe('backlog');
  });
});

describe('CommandBridge - list_tasks', () => {
  it('returns all tasks when no column specified', () => {
    mockTasks.push(
      makeTask({ title: 'Task A', swimlane_id: 'sw-backlog' }),
      makeTask({ title: 'Task B', swimlane_id: 'sw-planning' }),
    );

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'list_tasks', {});

    bridge.stop();

    expect(response.success).toBe(true);
    const tasks = response.data as Array<{ title: string; column: string }>;
    expect(tasks).toHaveLength(2);
  });

  it('filters tasks by column name', () => {
    mockTasks.push(
      makeTask({ title: 'Backlog Task', swimlane_id: 'sw-backlog' }),
      makeTask({ title: 'Planning Task', swimlane_id: 'sw-planning' }),
    );

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'list_tasks', { column: 'Planning' });

    bridge.stop();

    expect(response.success).toBe(true);
    const tasks = response.data as Array<{ title: string; column: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Planning Task');
    expect(tasks[0].column).toBe('Planning');
  });
});

describe('CommandBridge - update_task', () => {
  it('updates task title and description', () => {
    const task = makeTask({ title: 'Old Title', swimlane_id: 'sw-backlog', description: 'Old desc' });
    mockTasks.push(task);

    const updatedTasks: Task[] = [];
    const bridge = createBridge({
      onTaskUpdated: (updatedTask) => updatedTasks.push(updatedTask),
    });
    bridge.start();

    const response = sendCommand(bridge, 'update_task', {
      taskId: task.id,
      title: 'New Title',
      description: 'New description',
    });

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('title');
    expect(response.message).toContain('description');

    // Verify mock was updated
    expect(mockTasks[0].title).toBe('New Title');
    expect(mockTasks[0].description).toBe('New description');

    // Verify callback fired
    expect(updatedTasks).toHaveLength(1);
    expect(updatedTasks[0].title).toBe('New Title');
  });

  it('updates task prUrl and prNumber', () => {
    const task = makeTask({ title: 'PR Task', swimlane_id: 'sw-backlog' });
    mockTasks.push(task);

    const updatedTasks: Task[] = [];
    const bridge = createBridge({
      onTaskUpdated: (updatedTask) => updatedTasks.push(updatedTask),
    });
    bridge.start();

    const response = sendCommand(bridge, 'update_task', {
      taskId: task.id,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
    });

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('prUrl');
    expect(response.message).toContain('prNumber');

    expect(mockTasks.find((t) => t.id === task.id)?.pr_url).toBe('https://github.com/owner/repo/pull/42');
    expect(mockTasks.find((t) => t.id === task.id)?.pr_number).toBe(42);

    expect(response.data.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(response.data.prNumber).toBe(42);
  });

  it('returns error for non-existent task', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'update_task', {
      taskId: 'non-existent-id',
      title: 'New Title',
    });

    bridge.stop();

    expect(response.success).toBe(false);
    expect(response.error).toContain('not found');
  });
});

describe('CommandBridge - unknown command', () => {
  it('returns error for unknown method', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'delete_everything', {});

    bridge.stop();

    expect(response.success).toBe(false);
    expect(response.error).toContain('Unknown command');
  });
});

describe('CommandBridge - board_summary', () => {
  it('returns board summary with column counts and metrics', () => {
    mockTasks.push(
      makeTask({ title: 'Task 1', swimlane_id: 'sw-backlog' }),
      makeTask({ title: 'Task 2', swimlane_id: 'sw-planning' }),
    );

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'board_summary');

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('Board Summary');
    expect(response.message).toContain('Active tasks: 2');

    const data = response.data as { totalActiveTasks: number; columns: Array<{ name: string }> };
    expect(data.totalActiveTasks).toBe(2);
    expect(data.columns).toHaveLength(6);
  });
});

describe('CommandBridge - search_tasks', () => {
  it('finds tasks matching query in title', () => {
    mockTasks.push(
      makeTask({ title: 'Fix login bug', swimlane_id: 'sw-backlog' }),
      makeTask({ title: 'Add signup flow', swimlane_id: 'sw-planning' }),
    );

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'search_tasks', { query: 'login' });

    bridge.stop();

    expect(response.success).toBe(true);
    const data = response.data as { tasks: Array<{ title: string }>; totalActive: number };
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].title).toBe('Fix login bug');
    expect(data.totalActive).toBe(1);
  });

  it('finds tasks matching query in description', () => {
    mockTasks.push(
      makeTask({ title: 'Task A', swimlane_id: 'sw-backlog', description: 'OAuth integration needed' }),
    );

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'search_tasks', { query: 'oauth' });

    bridge.stop();

    expect(response.success).toBe(true);
    const data = response.data as { tasks: Array<{ title: string }> };
    expect(data.tasks).toHaveLength(1);
  });

  it('returns empty when no tasks match', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'search_tasks', { query: 'nonexistent' });

    bridge.stop();

    expect(response.success).toBe(true);
    const data = response.data as { tasks: Array<unknown> };
    expect(data.tasks).toHaveLength(0);
  });

  it('returns error for empty query', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'search_tasks', { query: '   ' });

    bridge.stop();

    expect(response.success).toBe(false);
    expect(response.error).toContain('required');
  });
});

describe('CommandBridge - find_task', () => {
  it('finds task by branch name', () => {
    const task = makeTask({ title: 'Feature X', swimlane_id: 'sw-backlog', branch_name: 'feature/x-abc123' });
    mockTasks.push(task);

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'find_task', { branch: 'feature/x' });

    bridge.stop();

    expect(response.success).toBe(true);
    const data = response.data as Array<{ title: string; branchName: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Feature X');
    expect(data[0].branchName).toBe('feature/x-abc123');
  });

  it('finds task by title keyword', () => {
    mockTasks.push(
      makeTask({ title: 'Refactor auth module', swimlane_id: 'sw-backlog' }),
      makeTask({ title: 'Add logging', swimlane_id: 'sw-backlog' }),
    );

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'find_task', { title: 'auth' });

    bridge.stop();

    expect(response.success).toBe(true);
    const data = response.data as Array<{ title: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Refactor auth module');
  });

  it('returns empty when no match found', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'find_task', { branch: 'nonexistent' });

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('No tasks found');
  });
});

describe('CommandBridge - get_column_detail', () => {
  it('returns column configuration details', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'get_column_detail', { column: 'Backlog' });

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('Backlog');
    expect(response.message).toContain('Role: backlog');

    const data = response.data as { name: string; role: string; autoSpawn: boolean };
    expect(data.name).toBe('Backlog');
    expect(data.role).toBe('backlog');
    expect(data.autoSpawn).toBe(false);
  });

  it('returns error for non-existent column', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'get_column_detail', { column: 'Nonexistent' });

    bridge.stop();

    expect(response.success).toBe(false);
    expect(response.error).toContain('not found');
  });
});

describe('CommandBridge - get_session_history', () => {
  it('returns empty history for task with no sessions', () => {
    const task = makeTask({ title: 'No sessions', swimlane_id: 'sw-backlog' });
    mockTasks.push(task);

    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'get_session_history', { taskId: task.id });

    bridge.stop();

    expect(response.success).toBe(true);
    expect(response.message).toContain('No session history');
    const data = response.data as Array<unknown>;
    expect(data).toHaveLength(0);
  });

  it('returns error for non-existent task', () => {
    const bridge = createBridge();
    bridge.start();

    const response = sendCommand(bridge, 'get_session_history', { taskId: 'non-existent' });

    bridge.stop();

    expect(response.success).toBe(false);
    expect(response.error).toContain('not found');
  });
});
