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
const mockBacklogRepoCreate = vi.fn();

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
  BacklogRepository: class { create = mockBacklogRepoCreate; getById = vi.fn(); update = vi.fn(); list = vi.fn(() => []); },
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
import { BACKLOG_DESCRIPTION_MAX_LENGTH } from '../../src/main/agent/commands/backlog-commands';
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
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
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

  it('persists label names and registers label colors with a 2KB description and a mixed labels array', async () => {
    // The exact #229 payload shape: a plain string label plus a {name, color} object.
    const result = await handleCreateTask(
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

// ---------------------------------------------------------------------------
// TASK_DESCRIPTION_MAX_LENGTH raised to 50,000 (from the prior 10,000 cap) -
// a description in the 10,001-50,000 range must survive both the
// handleCreateTask (board path) and handleUpdateTask (full-replace) slices
// in full, not get truncated back down to the old cap.
// ---------------------------------------------------------------------------

// Comfortably past the old 10,000-character cap but well under the new
// 50,000-character cap - proves the raise, not just "not truncated to zero".
const DESCRIPTION_OVER_OLD_TASK_CAP = 'z'.repeat(BACKLOG_DESCRIPTION_MAX_LENGTH + 10_000);

describe('handleCreateTask - persists the full description up to the raised 50,000 cap', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockResolveColumn.mockReturnValue({ swimlane: { id: 'lane-1', name: 'To Do' } });
    mockTaskRepoCreate.mockImplementation((input: { title: string; description: string }) => ({
      id: 'task-uuid-1',
      display_id: 1,
      title: input.title,
      description: input.description,
    }));
  });

  it('persists a description well past the old 10,000-char cap in full (board task path, column omitted)', async () => {
    const result = await handleCreateTask(
      { title: 'Long description task', description: DESCRIPTION_OVER_OLD_TASK_CAP },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as { description: string };
    expect(createInput.description).toHaveLength(DESCRIPTION_OVER_OLD_TASK_CAP.length);
    expect(createInput.description).toBe(DESCRIPTION_OVER_OLD_TASK_CAP);
  });
});

describe('handleUpdateTask - persists the full full-replace description up to the raised 50,000 cap', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockTaskRepoGetById.mockReturnValue({ id: 'task-uuid-1', display_id: 1, title: 'Existing', description: 'old description' });
    mockTaskRepoUpdate.mockImplementation((input: { description?: string }) => ({
      id: 'task-uuid-1',
      display_id: 1,
      title: 'Existing',
      description: input.description,
    }));
  });

  it('persists a full-replace description well past the old 10,000-char cap in full', () => {
    const result = handleUpdateTask(
      { taskId: 'task-uuid-1', description: DESCRIPTION_OVER_OLD_TASK_CAP },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as { description: string };
    expect(updateInput.description).toHaveLength(DESCRIPTION_OVER_OLD_TASK_CAP.length);
    expect(updateInput.description).toBe(DESCRIPTION_OVER_OLD_TASK_CAP);
  });
});

// ---------------------------------------------------------------------------
// Backlog items keep the lower BACKLOG_DESCRIPTION_MAX_LENGTH cap even though
// board tasks were raised to 50,000. handleCreateTask must reject an
// over-cap Backlog create with a structured error rather than silently
// truncating (handleCreateBacklogTask's internal .slice() would otherwise
// mask the overflow).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// handleCreateTask - per-task agent/model/effort/permissionMode/auto_command
// overrides (the create_task param wiring added alongside the tri-state
// update_task guards in task-commands.ts). Guards the ternary spread at
// handleCreateTask lines ~167-171: reverting any one of those `? { ... } :
// {}` clauses drops that field from the taskRepo.create call and fails the
// corresponding assertion below.
// ---------------------------------------------------------------------------

describe('handleCreateTask - agent/model/effort/permissionMode/auto_command overrides persist to taskRepo.create', () => {
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

  it('forwards agentOverride/modelOverride/effortOverride/permissionMode/autoCommand to taskRepo.create', async () => {
    const result = await handleCreateTask(
      {
        title: 'Spawn with overrides',
        agentOverride: 'codex',
        // The tool layer (task-tools.ts) is responsible for friendly-name ->
        // CLI-id conversion via resolveModelSelector; handleCreateTask
        // itself just forwards whatever string it is given verbatim.
        modelOverride: 'claude-opus-4-8',
        effortOverride: 'xhigh',
        permissionMode: 'bypassPermissions',
        autoCommand: '/code-review',
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
    expect(mockTaskRepoCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_override: 'codex',
        model_override: 'claude-opus-4-8',
        effort_override: 'xhigh',
        permission_mode: 'bypassPermissions',
        auto_command: '/code-review',
      }),
    );
  });

  it('omits every override key from taskRepo.create when none are provided (no accidental null overwrite)', async () => {
    const result = await handleCreateTask({ title: 'No overrides' }, context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput).not.toHaveProperty('agent_override');
    expect(createInput).not.toHaveProperty('model_override');
    expect(createInput).not.toHaveProperty('effort_override');
    expect(createInput).not.toHaveProperty('permission_mode');
    expect(createInput).not.toHaveProperty('auto_command');
  });
});

describe('handleCreateTask - Backlog column enforces its own lower description cap', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockBacklogRepoCreate.mockImplementation((input: { title: string; description: string; priority: number; labels: string[] }) => ({
      id: 'backlog-uuid-1',
      title: input.title,
      description: input.description,
      priority: input.priority,
      labels: input.labels,
    }));
  });

  it('rejects a Backlog create whose description exceeds the backlog cap, and creates no row', async () => {
    const overBacklogCapDescription = 'x'.repeat(BACKLOG_DESCRIPTION_MAX_LENGTH + 5_000);

    const result = await handleCreateTask(
      { title: 'Too-long backlog item', description: overBacklogCapDescription, column: 'Backlog' },
      context,
    );

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain(String(BACKLOG_DESCRIPTION_MAX_LENGTH));
    expect(mockBacklogRepoCreate).not.toHaveBeenCalled();
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
  });

  it('creates a backlog item normally when the description is within the backlog cap', async () => {
    const result = await handleCreateTask(
      { title: 'Short backlog item', description: 'A short description', column: 'Backlog' },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockBacklogRepoCreate).toHaveBeenCalledOnce();
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
  });
});
