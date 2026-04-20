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

// Spy handles configured per test inside beforeEach
const mockBacklogRepoGetById = vi.fn();
const mockBacklogRepoUpdate = vi.fn();
const mockBacklogRepoDelete = vi.fn();

const mockBacklogAttachmentRepoDeleteByTaskId = vi.fn();

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
    list = vi.fn(() => []);
    add = vi.fn();
  },
}));

// Silence the attachment-utils import (not used by update/delete handlers)
vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));

// Silence the task-repository import (used by handlePromoteBacklog, not our handlers)
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));

// Silence column-resolver (used by handlePromoteBacklog, not our handlers)
vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  resolveColumn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import {
  handleUpdateBacklogItem,
  handleDeleteBacklogItem,
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

    expect(result).toEqual({ success: false, error: 'Backlog item "missing-id" not found' });
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

    expect(result).toEqual({ success: false, error: 'Backlog item "no-such-id" not found' });
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
