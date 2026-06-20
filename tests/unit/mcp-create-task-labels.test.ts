/**
 * Regression guard for the MCP "labels dropped on a large description" bug
 * (task #229): when kangentic_create_task / kangentic_update_task carry a
 * ~1KB+ description, the sibling `labels` argument goes missing.
 *
 * IMPORTANT: this test cannot reproduce the actual bug. The drop happens
 * upstream of Kangentic, in the MCP client's tool-call argument
 * serialization, so the request bytes never carry `labels` in the first
 * place. By the time arguments reach handleCreateTask / handleUpdateTask, a
 * missing field is indistinguishable from one the caller never set.
 *
 * What this test DOES lock is the Kangentic-side round trip: given a large
 * description AND a labels array, the handler + repository persist the label
 * names and register label colors. It passes today (the handler is correct),
 * and that passing is the evidence the drop is upstream. It guards against a
 * future Kangentic-side regression that would drop labels during normal
 * handling.
 *
 * Strategy mirrors backlog-update-delete-handlers.test.ts: mock the
 * repositories and the column resolver so no better-sqlite3 binary is needed,
 * and assert on the captured repository calls and the onLabelColorsChanged
 * spy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before the import under test
// ---------------------------------------------------------------------------

const mockTaskRepoCreate = vi.fn();
const mockTaskRepoUpdate = vi.fn();
const mockTaskRepoGetById = vi.fn();
const mockTaskRepoGetByDisplayId = vi.fn();
const mockResolveColumn = vi.fn();

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = mockTaskRepoCreate;
    update = mockTaskRepoUpdate;
    getById = mockTaskRepoGetById;
    getByDisplayId = mockTaskRepoGetByDisplayId;
  },
}));

vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  resolveColumn: (...args: unknown[]) => mockResolveColumn(...args),
}));

// Defensive: these modules are imported (directly or transitively) by
// task-commands.ts. Stub them so importing the handlers stays cheap and
// touches no real DB, filesystem, or git.
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class { add = vi.fn(); list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class { create = vi.fn(); getById = vi.fn(); update = vi.fn(); list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class { add = vi.fn(); list = vi.fn(() => []); deleteByTaskId = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPRForTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { handleCreateTask, handleUpdateTask } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    getProjectDb: vi.fn(() => ({}) as never),
    getProjectPath: vi.fn(() => '/mock/project'),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async () => {}),
    onSwimlaneUpdated: vi.fn(),
    ...overrides,
  };
}

// A description comfortably past the empirical ~1KB drop threshold.
const LARGE_DESCRIPTION = 'x'.repeat(2048);

// ---------------------------------------------------------------------------
// handleCreateTask
// ---------------------------------------------------------------------------

describe('handleCreateTask - labels survive a large description (round-trip guard)', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockResolveColumn.mockReturnValue({ swimlane: { id: 'lane-1', name: 'To Do' } });
    mockTaskRepoCreate.mockImplementation((input: { title: string }) => ({
      id: 'task-uuid-1',
      display_id: 1,
      title: input.title,
    }));
  });

  it('persists label names and registers label colors with a 2KB description and a mixed labels array', () => {
    // The exact #229 payload shape: a plain string label plus a {name, color} object.
    const result = handleCreateTask(
      {
        title: 'Fix the thing',
        description: LARGE_DESCRIPTION,
        labels: ['bug', { name: 'session-lifecycle', color: '#8b5cf6' }],
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
    expect(mockTaskRepoCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: LARGE_DESCRIPTION,
        labels: ['bug', 'session-lifecycle'],
      }),
    );
    expect(context.onLabelColorsChanged).toHaveBeenCalledWith({ 'session-lifecycle': '#8b5cf6' });
  });
});

// ---------------------------------------------------------------------------
// handleUpdateTask
// ---------------------------------------------------------------------------

describe('handleUpdateTask - labels survive a large description (round-trip guard)', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockTaskRepoGetById.mockReturnValue({ id: 'task-uuid-1', display_id: 1, title: 'Existing', labels: ['probe-a'] });
    mockTaskRepoUpdate.mockImplementation((input: Record<string, unknown>) => ({
      id: 'task-uuid-1',
      display_id: 1,
      title: 'Existing',
      labels: input.labels ?? ['probe-a'],
    }));
  });

  it('passes the new labels through to TaskRepository.update alongside a 2KB description', () => {
    const result = handleUpdateTask(
      {
        taskId: 'task-uuid-1',
        description: LARGE_DESCRIPTION,
        labels: ['probe-a-v2'],
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    expect(mockTaskRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: LARGE_DESCRIPTION,
        labels: ['probe-a-v2'],
      }),
    );
  });
});
