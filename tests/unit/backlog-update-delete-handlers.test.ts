/**
 * Unit tests for handleUpdateBacklogItem and handleDeleteBacklogItem in
 * src/main/agent/commands/backlog-commands.ts.
 *
 * Strategy: mock BacklogRepository and BacklogAttachmentRepository so no
 * ABI-compiled better-sqlite3 binary is needed. The context stub provides
 * vi.fn() spies for onBacklogChanged and onLabelColorsChanged so we can
 * assert call counts and arguments.
 *
 * Covers:
 *   handleUpdateBacklogItem
 *     - missing itemId returns structured error
 *     - itemId not found in DB returns structured error
 *     - priority out of range (< 0 or > 4) returns structured error
 *     - no fields provided returns "No fields provided to update" error
 *     - happy path: updates title only, fires onBacklogChanged, returns record
 *     - labels as {name, color} objects: normalizes to name array, fires
 *       onLabelColorsChanged with the color map
 *     - labels as plain strings: does NOT fire onLabelColorsChanged
 *
 *   handleDeleteBacklogItem
 *     - missing itemId returns structured error
 *     - itemId not found returns structured error (deleteByTaskId never called)
 *     - happy path: calls deleteByTaskId then backlogRepo.delete, fires
 *       onBacklogChanged, returns id + title in data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before any import under test
// ---------------------------------------------------------------------------

// Spy handles configured per test inside beforeEach. Wrapped in vi.hoisted
// because vi.mock factories below reference them directly - vi.mock calls
// are hoisted above plain top-level statements, so an un-hoisted const would
// hit a TDZ ReferenceError the moment a factory is invoked.
const {
  mockBacklogRepoGetById,
  mockBacklogRepoUpdate,
  mockBacklogRepoDelete,
  mockBacklogAttachmentRepoDeleteByTaskId,
  mockBacklogAttachmentRepoList,
  mockBacklogAttachmentRepoAdd,
  mockReadFileAsAttachment,
  mockTaskRepoCreate,
} = vi.hoisted(() => ({
  mockBacklogRepoGetById: vi.fn(),
  mockBacklogRepoUpdate: vi.fn(),
  mockBacklogRepoDelete: vi.fn(),
  mockBacklogAttachmentRepoDeleteByTaskId: vi.fn(),
  mockBacklogAttachmentRepoList: vi.fn(() => []),
  mockBacklogAttachmentRepoAdd: vi.fn(),
  mockReadFileAsAttachment: vi.fn(),
  // Used by handlePromoteBacklog to create the promoted board task.
  mockTaskRepoCreate: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    getById = mockBacklogRepoGetById;
    update = mockBacklogRepoUpdate;
    delete = mockBacklogRepoDelete;
    list = vi.fn(() => []);
    create = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    deleteByTaskId = mockBacklogAttachmentRepoDeleteByTaskId;
    list = mockBacklogAttachmentRepoList;
    add = mockBacklogAttachmentRepoAdd;
  },
}));

vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: mockReadFileAsAttachment,
}));

// Task repository - used by handlePromoteBacklog to create the promoted board task.
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = mockTaskRepoCreate;
  },
}));

// Attachment repository - used by handlePromoteBacklog attachment copy path.
// list() returning [] prevents any fs.readFileSync calls in these tests.
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {
    list = vi.fn(() => []);
    add = vi.fn();
  },
}));

// Silence column-resolver (used by handlePromoteBacklog, not our handlers)
const mockResolveColumn = vi.fn();
vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  resolveColumn: (...args: unknown[]) => mockResolveColumn(...args),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import {
  handleUpdateBacklogItem,
  handleDeleteBacklogItem,
  handlePromoteBacklog,
} from '../../src/main/agent/commands/backlog-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockBacklogItem {
  id: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
}

function makeBacklogItem(overrides: Partial<MockBacklogItem> = {}): MockBacklogItem {
  return {
    id: 'item-001',
    title: 'My backlog item',
    description: 'Some description',
    priority: 1,
    labels: [],
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------------
// handleUpdateBacklogItem
// ---------------------------------------------------------------------------

describe('handleUpdateBacklogItem', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
  });

  it('returns structured error when itemId is missing', () => {
    const result = handleUpdateBacklogItem({ title: 'New title' }, context);

    expect(result).toEqual({ success: false, error: 'itemId is required' });
    expect(mockBacklogRepoGetById).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('returns structured error when itemId is an empty string', () => {
    const result = handleUpdateBacklogItem({ itemId: '', title: 'New title' }, context);

    expect(result).toEqual({ success: false, error: 'itemId is required' });
    expect(mockBacklogRepoGetById).not.toHaveBeenCalled();
  });

  it('returns structured error when priority is below 0', () => {
    const result = handleUpdateBacklogItem(
      { itemId: 'item-001', priority: -1 },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Priority must be 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent)',
    });
    expect(mockBacklogRepoGetById).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('returns structured error when priority is above 4', () => {
    const result = handleUpdateBacklogItem(
      { itemId: 'item-001', priority: 5 },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Priority must be 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent)',
    });
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('returns structured error when itemId is not found in DB', () => {
    mockBacklogRepoGetById.mockReturnValue(undefined);

    const result = handleUpdateBacklogItem(
      { itemId: 'missing-id', title: 'New title' },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Backlog item "missing-id" not found\./);
    expect(result.error).toContain('kangentic_search_tasks');
    expect(mockBacklogRepoUpdate).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('returns structured error when no update fields are provided', () => {
    mockBacklogRepoGetById.mockReturnValue(makeBacklogItem());

    const result = handleUpdateBacklogItem({ itemId: 'item-001' }, context);

    expect(result).toEqual({ success: false, error: 'No fields provided to update' });
    expect(mockBacklogRepoUpdate).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('updates title only, fires onBacklogChanged, returns updated record', () => {
    const existing = makeBacklogItem({ id: 'item-001', title: 'Old title', priority: 2 });
    const updated = { ...existing, title: 'New title' };

    mockBacklogRepoGetById.mockReturnValue(existing);
    mockBacklogRepoUpdate.mockReturnValue(updated);

    const result = handleUpdateBacklogItem(
      { itemId: 'item-001', title: 'New title' },
      context,
    );

    expect(mockBacklogRepoUpdate).toHaveBeenCalledOnce();
    expect(mockBacklogRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-001', title: 'New title' }),
    );
    expect(context.onBacklogChanged).toHaveBeenCalledOnce();
    expect(context.onLabelColorsChanged).not.toHaveBeenCalled();

    expect(result).toEqual({
      success: true,
      message: 'Updated title for "New title".',
      data: {
        id: 'item-001',
        title: 'New title',
        description: 'Some description',
        priority: 2,
        priorityLabel: 'Medium',
        labels: [],
      },
    });
  });

  it('attachments-only call does not touch BacklogRepository.update, but attaches and reports attachmentsAdded', () => {
    const existing = makeBacklogItem({ id: 'item-001' });
    mockBacklogRepoGetById.mockReturnValue(existing);
    mockReadFileAsAttachment.mockReturnValue({
      filename: 'notes.txt',
      base64Data: 'ZmFrZS1kYXRh',
      mediaType: 'text/plain',
    });

    const result = handleUpdateBacklogItem(
      { itemId: 'item-001', attachments: [{ filePath: 'C:/mock/notes.txt' }] },
      context,
    );

    expect(mockBacklogRepoUpdate).not.toHaveBeenCalled();
    expect(mockBacklogAttachmentRepoAdd).toHaveBeenCalledOnce();
    expect(mockBacklogAttachmentRepoAdd).toHaveBeenCalledWith(
      '/mock/project', 'item-001', 'notes.txt', 'ZmFrZS1kYXRh', 'text/plain',
    );
    expect(context.onBacklogChanged).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.message).toContain('attachments');
    expect(result.data).toMatchObject({ attachmentsAdded: 1 });
  });

  it('combined title + attachments call updates both', () => {
    const existing = makeBacklogItem({ id: 'item-001', title: 'Old title' });
    mockBacklogRepoGetById.mockReturnValue(existing);
    mockBacklogRepoUpdate.mockReturnValue({ ...existing, title: 'New title' });
    mockReadFileAsAttachment.mockReturnValue({
      filename: 'notes.txt',
      base64Data: 'ZmFrZS1kYXRh',
      mediaType: 'text/plain',
    });

    const result = handleUpdateBacklogItem(
      { itemId: 'item-001', title: 'New title', attachments: [{ filePath: 'C:/mock/notes.txt' }] },
      context,
    );

    expect(mockBacklogRepoUpdate).toHaveBeenCalledOnce();
    expect(mockBacklogAttachmentRepoAdd).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.message).toContain('title');
    expect(result.message).toContain('attachments');
  });

  it('attachments-only call where every readFileAsAttachment throws returns a structured error and touches nothing else', () => {
    const existing = makeBacklogItem({ id: 'item-001' });
    mockBacklogRepoGetById.mockReturnValue(existing);
    mockReadFileAsAttachment.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = handleUpdateBacklogItem(
      { itemId: 'item-001', attachments: [{ filePath: 'C:/mock/missing.txt' }] },
      context,
    );

    expect(result).toEqual({
      success: false,
      error: 'Failed to attach any of the 1 requested file(s); no other fields were updated.',
    });
    expect(mockBacklogAttachmentRepoAdd).not.toHaveBeenCalled();
    expect(mockBacklogRepoUpdate).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('partial attachment failure: continues past a throwing entry and attaches the rest', () => {
    const existing = makeBacklogItem({ id: 'item-001' });
    mockBacklogRepoGetById.mockReturnValue(existing);
    mockReadFileAsAttachment
      .mockImplementationOnce(() => {
        throw new Error('ENOENT');
      })
      .mockImplementationOnce(() => ({
        filename: 'good.txt',
        base64Data: 'Z29vZC1kYXRh',
        mediaType: 'text/plain',
      }));

    const result = handleUpdateBacklogItem(
      {
        itemId: 'item-001',
        attachments: [{ filePath: 'C:/mock/bad.txt' }, { filePath: 'C:/mock/good.txt' }],
      },
      context,
    );

    expect(mockBacklogAttachmentRepoAdd).toHaveBeenCalledOnce();
    expect(mockBacklogAttachmentRepoAdd).toHaveBeenCalledWith(
      '/mock/project', 'item-001', 'good.txt', 'Z29vZC1kYXRh', 'text/plain',
    );
    expect(context.onBacklogChanged).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.message).toContain('attachments');
    expect(result.data).toMatchObject({ attachmentsAdded: 1 });
  });

  it('fires onLabelColorsChanged with extracted color map when labels have {name, color} objects', () => {
    const existing = makeBacklogItem({ id: 'item-002' });
    const updatedItem = { ...existing, labels: ['bug', 'urgent'] };

    mockBacklogRepoGetById.mockReturnValue(existing);
    mockBacklogRepoUpdate.mockReturnValue(updatedItem);

    const result = handleUpdateBacklogItem(
      {
        itemId: 'item-002',
        labels: [
          { name: 'bug', color: '#ff0000' },
          { name: 'urgent', color: '#ff6600' },
        ],
      },
      context,
    );

    // Should call update with normalized label names (not objects)
    expect(mockBacklogRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['bug', 'urgent'] }),
    );

    // Color map must be passed to onLabelColorsChanged
    expect(context.onLabelColorsChanged).toHaveBeenCalledOnce();
    expect(context.onLabelColorsChanged).toHaveBeenCalledWith({
      bug: '#ff0000',
      urgent: '#ff6600',
    });

    expect(context.onBacklogChanged).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true });
  });

  it('does NOT fire onLabelColorsChanged when labels are plain strings', () => {
    const existing = makeBacklogItem({ id: 'item-003' });
    const updatedItem = { ...existing, labels: ['feature', 'v2'] };

    mockBacklogRepoGetById.mockReturnValue(existing);
    mockBacklogRepoUpdate.mockReturnValue(updatedItem);

    const result = handleUpdateBacklogItem(
      { itemId: 'item-003', labels: ['feature', 'v2'] },
      context,
    );

    expect(mockBacklogRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['feature', 'v2'] }),
    );
    expect(context.onLabelColorsChanged).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true });
  });
});

// ---------------------------------------------------------------------------
// handleDeleteBacklogItem
// ---------------------------------------------------------------------------

describe('handleDeleteBacklogItem', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
  });

  it('returns structured error when itemId is missing', () => {
    const result = handleDeleteBacklogItem({}, context);

    expect(result).toEqual({ success: false, error: 'itemId is required' });
    expect(mockBacklogRepoGetById).not.toHaveBeenCalled();
    expect(mockBacklogAttachmentRepoDeleteByTaskId).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('returns structured error when itemId is empty string', () => {
    const result = handleDeleteBacklogItem({ itemId: '' }, context);

    expect(result).toEqual({ success: false, error: 'itemId is required' });
    expect(mockBacklogRepoGetById).not.toHaveBeenCalled();
    expect(mockBacklogAttachmentRepoDeleteByTaskId).not.toHaveBeenCalled();
  });

  it('returns structured error when itemId is not found (attachment repo never called)', () => {
    mockBacklogRepoGetById.mockReturnValue(undefined);

    const result = handleDeleteBacklogItem({ itemId: 'no-such-id' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Backlog item "no-such-id" not found\./);
    expect(result.error).toContain('kangentic_search_tasks');
    // The handler must return early without touching the attachment repo
    expect(mockBacklogAttachmentRepoDeleteByTaskId).not.toHaveBeenCalled();
    expect(mockBacklogRepoDelete).not.toHaveBeenCalled();
    expect(context.onBacklogChanged).not.toHaveBeenCalled();
  });

  it('calls deleteByTaskId then backlogRepo.delete, fires onBacklogChanged, returns data', () => {
    const item = makeBacklogItem({ id: 'item-to-delete', title: 'Delete me' });
    mockBacklogRepoGetById.mockReturnValue(item);

    const result = handleDeleteBacklogItem({ itemId: 'item-to-delete' }, context);

    // Attachment cleanup must happen before the item itself is deleted
    expect(mockBacklogAttachmentRepoDeleteByTaskId).toHaveBeenCalledOnce();
    expect(mockBacklogAttachmentRepoDeleteByTaskId).toHaveBeenCalledWith('item-to-delete');

    expect(mockBacklogRepoDelete).toHaveBeenCalledOnce();
    expect(mockBacklogRepoDelete).toHaveBeenCalledWith('item-to-delete');

    expect(context.onBacklogChanged).toHaveBeenCalledOnce();

    expect(result).toEqual({
      success: true,
      message: 'Deleted backlog item "Delete me".',
      data: { id: 'item-to-delete', title: 'Delete me' },
    });
  });
});

// ---------------------------------------------------------------------------
// handlePromoteBacklog
// ---------------------------------------------------------------------------

describe('handlePromoteBacklog', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    // Configure resolveColumn to succeed with a stub "To Do" swimlane so the
    // item-lookup loop always runs. Tests that want a column-resolution failure
    // can override this mock.
    mockResolveColumn.mockReturnValue({
      swimlane: { id: 'lane-todo', name: 'To Do', role: 'todo', is_archived: 0, display_order: 0 },
      allSwimlanes: [],
    });
    // By default, no backlog items are found
    mockBacklogRepoGetById.mockReturnValue(undefined);
  });

  it('returns structured error with kangentic_search_tasks hint when all IDs are not found', () => {
    // This exercises the promoted.length === 0 branch (backlog-commands.ts ~line 320).
    // The new error message added in this branch points the agent at kangentic_search_tasks
    // to look up stale IDs that were valid before a prior promotion.
    const result = handlePromoteBacklog(
      { itemIds: ['ghost-id-1', 'ghost-id-2'] },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^No backlog tasks found for the provided IDs\./);
    expect(result.error).toContain('kangentic_search_tasks');
    // onBacklogChanged is called even in the all-not-found path because the loop
    // ran (and potentially processed partial results). This is the existing behavior.
    expect(context.onBacklogChanged).toHaveBeenCalledOnce();
  });

  it('returns structured error with kangentic_search_tasks hint when the single ID is not found', () => {
    const result = handlePromoteBacklog(
      { itemIds: ['stale-id'] },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^No backlog tasks found for the provided IDs\./);
    expect(result.error).toContain('kangentic_search_tasks');
  });

  it('carries external_id/source/url from the backlog item into the created board task', () => {
    // Regression guard: the MCP promote path (handlePromoteBacklog in
    // backlog-commands.ts) must pass external origin onto taskRepo.create so
    // that findByExternalIds can match the promoted task on a re-import.
    mockBacklogRepoGetById.mockReturnValue({
      id: 'backlog-gh-1',
      title: 'GitHub issue',
      description: 'desc',
      labels: ['bug'],
      priority: 2,
      external_id: '42',
      external_source: 'github_issues',
      external_url: 'https://github.com/acme/repo/issues/42',
    });
    mockTaskRepoCreate.mockReturnValue({
      id: 'task-promoted',
      title: 'GitHub issue',
      swimlane_id: 'lane-todo',
    });

    const result = handlePromoteBacklog({ itemIds: ['backlog-gh-1'] }, context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: '42',
        externalSource: 'github_issues',
        externalUrl: 'https://github.com/acme/repo/issues/42',
      }),
    );
  });

  it('leaves external fields undefined when the backlog item has no origin', () => {
    // Regression guard: a hand-written backlog item (no external_* columns)
    // must not cause handlePromoteBacklog to pass undefined vs null incorrectly.
    mockBacklogRepoGetById.mockReturnValue({
      id: 'backlog-manual-1',
      title: 'Hand-written item',
      description: 'desc',
      labels: [],
      priority: 0,
      external_id: null,
      external_source: null,
      external_url: null,
    });
    mockTaskRepoCreate.mockReturnValue({
      id: 'task-promoted-2',
      title: 'Hand-written item',
      swimlane_id: 'lane-todo',
    });

    const result = handlePromoteBacklog({ itemIds: ['backlog-manual-1'] }, context);

    expect(result.success).toBe(true);
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput.externalId).toBeUndefined();
    expect(createInput.externalSource).toBeUndefined();
    expect(createInput.externalUrl).toBeUndefined();
  });
});
