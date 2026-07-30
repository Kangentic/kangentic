/**
 * Unit tests for attaching/detaching files on an ALREADY-EXISTING task via
 * MCP (as opposed to attachments passed at kangentic_create_task time, which
 * mcp-create-task-labels.test.ts and existing create_task tests already
 * cover).
 *
 * Covers:
 *   handleUpdateTask (src/main/agent/commands/task-commands.ts)
 *     - attachments-only call appends via AttachmentRepository.add without
 *       calling TaskRepository.update (no gratuitous updated_at bump), and
 *       re-fetches the task so the response reflects the fresh derived
 *       attachment_count
 *     - combined scalar field + attachments call updates both
 *
 *   handleRemoveAttachment (src/main/agent/commands/task-commands.ts)
 *     - removes a board attachment by ID and notifies onTaskUpdated
 *     - falls back to the backlog attachment repo and notifies onBacklogChanged
 *     - returns a structured error when the ID matches neither surface
 *
 * Strategy mirrors mcp-create-task-labels.test.ts: mock the repositories so
 * no better-sqlite3 binary is needed, and assert on captured repository calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before the import under test
// ---------------------------------------------------------------------------

const {
  mockTaskRepoUpdate,
  mockTaskRepoGetById,
  mockTaskRepoGetByDisplayId,
  mockAttachmentRepoAdd,
  mockAttachmentRepoGetById,
  mockAttachmentRepoRemove,
  mockBacklogAttachmentRepoGetById,
  mockBacklogAttachmentRepoRemove,
  mockReadFileAsAttachment,
} = vi.hoisted(() => ({
  mockTaskRepoUpdate: vi.fn(),
  mockTaskRepoGetById: vi.fn(),
  mockTaskRepoGetByDisplayId: vi.fn(),
  mockAttachmentRepoAdd: vi.fn(),
  mockAttachmentRepoGetById: vi.fn(),
  mockAttachmentRepoRemove: vi.fn(),
  mockBacklogAttachmentRepoGetById: vi.fn(),
  mockBacklogAttachmentRepoRemove: vi.fn(),
  mockReadFileAsAttachment: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    update = mockTaskRepoUpdate;
    getById = mockTaskRepoGetById;
    getByDisplayId = mockTaskRepoGetByDisplayId;
  },
}));

vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    add = mockAttachmentRepoAdd;
    getById = mockAttachmentRepoGetById;
    remove = mockAttachmentRepoRemove;
  },
}));

vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    getById = mockBacklogAttachmentRepoGetById;
    remove = mockBacklogAttachmentRepoRemove;
  },
}));

vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: mockReadFileAsAttachment,
}));

// Defensive: transitively imported by task-commands.ts but unused by the
// handlers under test here.
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {},
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPRForTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { handleUpdateTask, handleRemoveAttachment } from '../../src/main/agent/commands/task-commands';
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
    onSwimlaneDeleted: vi.fn(),
    ...overrides,
  };
}

const EXISTING_TASK = { id: 'task-uuid-1', display_id: 1, title: 'Existing', attachment_count: 0 };

/**
 * The real kangentic_update_task tool (task-tools.ts) forwards every
 * omitted field as an explicit `null` (`title: title ?? null`, etc.), not
 * `undefined` - handleUpdateTask's `field !== null` checks depend on that.
 * Mirror that shape so calling the handler directly here matches production.
 */
function updateTaskParams(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: 'task-uuid-1',
    title: null,
    description: null,
    prUrl: null,
    prNumber: null,
    agent: null,
    priority: null,
    labels: null,
    baseBranch: null,
    useWorktree: null,
    attachments: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleUpdateTask - attachments
// ---------------------------------------------------------------------------

describe('handleUpdateTask - attachments (append to an existing task)', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockTaskRepoGetById.mockReturnValue(EXISTING_TASK);
    mockReadFileAsAttachment.mockReturnValue({
      filename: 'screenshot.png',
      base64Data: 'ZmFrZS1kYXRh',
      mediaType: 'image/png',
    });
  });

  it('attachments-only call does not touch TaskRepository.update, but attaches and re-fetches the task', () => {
    mockTaskRepoGetById.mockReturnValueOnce(EXISTING_TASK).mockReturnValueOnce({ ...EXISTING_TASK, attachment_count: 1 });

    const result = handleUpdateTask(
      updateTaskParams({ attachments: [{ filePath: 'C:/mock/screenshot.png' }] }),
      context,
    );

    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
    expect(mockAttachmentRepoAdd).toHaveBeenCalledOnce();
    expect(mockAttachmentRepoAdd).toHaveBeenCalledWith(
      '/mock/project', 'task-uuid-1', 'screenshot.png', 'ZmFrZS1kYXRh', 'image/png',
    );
    expect(context.onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ attachment_count: 1 }));
    expect(result.success).toBe(true);
    expect(result.message).toContain('attachments');
    expect(result.data).toMatchObject({ attachmentCount: 1, attachmentsAdded: 1 });
  });

  it('combined title + attachments call updates both', () => {
    mockTaskRepoUpdate.mockReturnValue({ ...EXISTING_TASK, title: 'New title' });
    mockTaskRepoGetById.mockReturnValueOnce(EXISTING_TASK).mockReturnValueOnce({ ...EXISTING_TASK, title: 'New title', attachment_count: 1 });

    const result = handleUpdateTask(
      updateTaskParams({
        title: 'New title',
        attachments: [{ filePath: 'C:/mock/screenshot.png' }],
      }),
      context,
    );

    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    expect(mockAttachmentRepoAdd).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.message).toContain('title');
    expect(result.message).toContain('attachments');
  });

  it('a scalar-only update (no attachments field) omits attachmentCount/attachmentsAdded from the response', () => {
    mockTaskRepoUpdate.mockReturnValue({ ...EXISTING_TASK, title: 'New title' });

    const result = handleUpdateTask(updateTaskParams({ title: 'New title' }), context);

    expect(mockAttachmentRepoAdd).not.toHaveBeenCalled();
    expect(result.data).not.toHaveProperty('attachmentCount');
    expect(result.data).not.toHaveProperty('attachmentsAdded');
  });

  it('attachments-only call where every readFileAsAttachment throws returns a structured error and touches nothing else', () => {
    mockReadFileAsAttachment.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = handleUpdateTask(
      updateTaskParams({ attachments: [{ filePath: 'C:/mock/missing.png' }] }),
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Failed to attach any of the 1 requested file(s); no other fields were updated.',
    });
    expect(mockAttachmentRepoAdd).not.toHaveBeenCalled();
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
    expect(context.onTaskUpdated).not.toHaveBeenCalled();
  });

  it('attachments call with attachments: [] and no other field returns "No fields provided to update"', () => {
    const result = handleUpdateTask(updateTaskParams({ attachments: [] }), context);

    expect(result).toEqual({ success: false, error: 'No fields provided to update' });
    expect(mockAttachmentRepoAdd).not.toHaveBeenCalled();
    expect(context.onTaskUpdated).not.toHaveBeenCalled();
  });

  it('partial attachment failure: continues past a throwing entry and attaches the rest', () => {
    mockReadFileAsAttachment
      .mockImplementationOnce(() => {
        throw new Error('ENOENT');
      })
      .mockImplementationOnce(() => ({
        filename: 'good.png',
        base64Data: 'Z29vZC1kYXRh',
        mediaType: 'image/png',
      }));
    mockTaskRepoGetById.mockReturnValueOnce(EXISTING_TASK).mockReturnValueOnce({ ...EXISTING_TASK, attachment_count: 1 });

    const result = handleUpdateTask(
      updateTaskParams({
        attachments: [{ filePath: 'C:/mock/bad.png' }, { filePath: 'C:/mock/good.png' }],
      }),
      context,
    );

    expect(mockAttachmentRepoAdd).toHaveBeenCalledOnce();
    expect(mockAttachmentRepoAdd).toHaveBeenCalledWith(
      '/mock/project', 'task-uuid-1', 'good.png', 'Z29vZC1kYXRh', 'image/png',
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('attachments');
    expect(result.data).toMatchObject({ attachmentsAdded: 1 });
  });
});

// ---------------------------------------------------------------------------
// handleRemoveAttachment
// ---------------------------------------------------------------------------

describe('handleRemoveAttachment', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
  });

  it('returns structured error when attachmentId is missing', () => {
    const result = handleRemoveAttachment({}, context);

    expect(result).toEqual({ success: false, error: 'attachmentId is required' });
    expect(mockAttachmentRepoGetById).not.toHaveBeenCalled();
  });

  it('removes a board attachment and notifies onTaskUpdated with the refreshed task', () => {
    mockAttachmentRepoGetById.mockReturnValue({ id: 'att-1', task_id: 'task-uuid-1', filename: 'shot.png' });
    mockTaskRepoGetById.mockReturnValue({ ...EXISTING_TASK, attachment_count: 0 });

    const result = handleRemoveAttachment({ attachmentId: 'att-1' }, context);

    expect(mockAttachmentRepoRemove).toHaveBeenCalledWith('att-1');
    expect(mockBacklogAttachmentRepoGetById).not.toHaveBeenCalled();
    expect(context.onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-uuid-1' }));
    expect(result).toEqual({
      success: true,
      message: 'Removed attachment "shot.png" from task "Existing" (#1).',
      data: { attachmentId: 'att-1', taskId: 'task-uuid-1', filename: 'shot.png' },
    });
  });

  it('falls back to the backlog attachment repo and notifies onBacklogChanged', () => {
    mockAttachmentRepoGetById.mockReturnValue(undefined);
    mockBacklogAttachmentRepoGetById.mockReturnValue({ id: 'att-2', backlog_task_id: 'item-001', filename: 'notes.txt' });

    const result = handleRemoveAttachment({ attachmentId: 'att-2' }, context);

    expect(mockAttachmentRepoRemove).not.toHaveBeenCalled();
    expect(mockBacklogAttachmentRepoRemove).toHaveBeenCalledWith('att-2');
    expect(context.onBacklogChanged).toHaveBeenCalledOnce();
    expect(context.onTaskUpdated).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      message: 'Removed attachment "notes.txt" from backlog item item-001.',
      data: { attachmentId: 'att-2', backlogItemId: 'item-001', filename: 'notes.txt' },
    });
  });

  it('returns a structured error when the ID matches neither surface', () => {
    mockAttachmentRepoGetById.mockReturnValue(undefined);
    mockBacklogAttachmentRepoGetById.mockReturnValue(undefined);

    const result = handleRemoveAttachment({ attachmentId: 'missing-id' }, context);

    expect(result).toEqual({ success: false, error: 'Attachment "missing-id" not found' });
    expect(context.onTaskUpdated).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });
});
