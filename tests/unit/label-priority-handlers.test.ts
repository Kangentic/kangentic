/**
 * Without these tests, an agent that sends `labels: "bug"` (a string, not a
 * list) silently splits it into the labels b, u, g or wipes a task's labels,
 * a project that renamed or extended its priority scale gets "Low"/"P5" in
 * the wrong places or has its sixth level refused, a label color can be saved
 * from a malformed value, and the board summary's label list overflows its
 * wrap width or loses the colors that tell an agent which labels are taken.
 *
 * Strategy: mock the repositories (no better-sqlite3 binary needed) in the
 * style of mcp-create-task-labels.test.ts and backlog-update-delete-handlers.test.ts,
 * and assert on the captured repository calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockTaskRepoCreate,
  mockTaskRepoUpdate,
  mockTaskRepoGetById,
  mockTaskRepoGetByDisplayId,
  mockBacklogRepoCreate,
  mockBacklogRepoUpdate,
  mockBacklogRepoGetById,
  mockBacklogRepoList,
  mockResolveColumn,
} = vi.hoisted(() => ({
  mockTaskRepoCreate: vi.fn(),
  mockTaskRepoUpdate: vi.fn(),
  mockTaskRepoGetById: vi.fn(),
  mockTaskRepoGetByDisplayId: vi.fn(),
  mockBacklogRepoCreate: vi.fn(),
  mockBacklogRepoUpdate: vi.fn(),
  mockBacklogRepoGetById: vi.fn(),
  mockBacklogRepoList: vi.fn(),
  mockResolveColumn: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = mockTaskRepoCreate;
    update = mockTaskRepoUpdate;
    getById = mockTaskRepoGetById;
    getByDisplayId = mockTaskRepoGetByDisplayId;
  },
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    create = mockBacklogRepoCreate;
    update = mockBacklogRepoUpdate;
    getById = mockBacklogRepoGetById;
    list = mockBacklogRepoList;
  },
}));
vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  resolveColumn: (...args: unknown[]) => mockResolveColumn(...args),
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class { add = vi.fn(); list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
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

import { handleCreateTask, handleUpdateTask } from '../../src/main/agent/commands/task-commands';
import {
  handleCreateBacklogTask,
  handleListBacklog,
  handleUpdateBacklogItem,
} from '../../src/main/agent/commands/backlog-commands';
import { BOARD_SUMMARY_LABEL_WRAP_COLUMNS, formatLabelVocabulary } from '../../src/main/agent/commands/analytics-commands';
import { isLabelListOrAbsent, LABELS_NOT_A_LIST } from '../../src/main/agent/commands/label-and-priority';
import { LABEL_ENTRY_SCHEMA, PRIORITY_SCHEMA } from '../../src/main/agent/mcp-http/label-priority-schema';
import type { CommandContext } from '../../src/main/agent/commands/types';

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

const CUSTOM_SCALE = [
  { label: 'Someday', color: '#6b7280' },
  { label: 'Soon', color: '#3b82f6' },
  { label: 'Now', color: '#ef4444' },
  { label: 'Today', color: '#f97316' },
  { label: 'Fire', color: '#ec4899' },
  { label: 'Blocker', color: '#8b5cf6' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveColumn.mockReturnValue({ swimlane: { id: 'lane-1', name: 'To Do' } });
  mockTaskRepoGetById.mockReturnValue({ id: 'task-1', display_id: 1, title: 'Existing', labels: ['keep'] });
});

describe('isLabelListOrAbsent', () => {
  it.each([[undefined], [null], [[]], [['a']]])('accepts %j', (value) => {
    expect(isLabelListOrAbsent(value)).toBe(true);
  });

  it.each([['bug'], [5], [{}]])('refuses %j', (value) => {
    expect(isLabelListOrAbsent(value)).toBe(false);
  });
});

describe('a labels value that is not a list is refused and nothing is written', () => {
  it('handleUpdateTask', () => {
    const context = makeContext();
    const result = handleUpdateTask({ taskId: 'task-1', labels: 'bug' }, context);

    expect(result).toEqual({ success: false, error: LABELS_NOT_A_LIST });
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
    expect(context.onLabelColorsChanged).not.toHaveBeenCalled();
  });

  it('handleCreateTask', async () => {
    const result = await handleCreateTask({ title: 'x', labels: 'bug' }, makeContext());

    expect(result).toEqual({ success: false, error: LABELS_NOT_A_LIST });
    expect(mockTaskRepoCreate).not.toHaveBeenCalled();
  });

  it('handleCreateBacklogTask', () => {
    const result = handleCreateBacklogTask({ title: 'x', labels: 5 }, makeContext());

    expect(result).toEqual({ success: false, error: LABELS_NOT_A_LIST });
    expect(mockBacklogRepoCreate).not.toHaveBeenCalled();
  });

  it('handleUpdateBacklogItem', () => {
    mockBacklogRepoGetById.mockReturnValue({ id: 'item-1', title: 'Item', priority: 0, labels: ['keep'] });
    const result = handleUpdateBacklogItem({ itemId: 'item-1', labels: 'bug' }, makeContext());

    expect(result).toEqual({ success: false, error: LABELS_NOT_A_LIST });
    expect(mockBacklogRepoUpdate).not.toHaveBeenCalled();
  });
});

describe('a custom priority scale names and bounds priorities', () => {
  const makeCustomContext = () =>
    makeContext({ getBacklogDisplayConfig: () => ({ priorities: CUSTOM_SCALE, labelColors: {} }) });

  it('handleListBacklog names a priority from the project scale', () => {
    mockBacklogRepoList.mockReturnValue([
      { id: 'item-1', title: 'Item', description: '', priority: 1, labels: [], created_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const result = handleListBacklog({}, makeCustomContext());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject([{ priority: 1, priorityLabel: 'Soon' }]);
    expect(result.message).toContain('(Soon)');
  });

  it('handleUpdateBacklogItem accepts the sixth level and names it', () => {
    const existing = { id: 'item-1', title: 'Item', description: '', priority: 0, labels: [] };
    mockBacklogRepoGetById.mockReturnValue(existing);
    mockBacklogRepoUpdate.mockReturnValue({ ...existing, priority: 5 });

    const result = handleUpdateBacklogItem({ itemId: 'item-1', priority: 5 }, makeCustomContext());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ priority: 5, priorityLabel: 'Blocker' });
  });

  it('handleCreateBacklogTask accepts the sixth level', () => {
    mockBacklogRepoCreate.mockImplementation((input: { title: string; priority: number; labels: string[] }) => ({
      id: 'item-new',
      title: input.title,
      priority: input.priority,
      labels: input.labels,
    }));

    const result = handleCreateBacklogTask({ title: 'Top', priority: 5 }, makeCustomContext());

    expect(result.success).toBe(true);
    expect(mockBacklogRepoCreate).toHaveBeenCalledWith(expect.objectContaining({ priority: 5 }));
  });
});

describe('MCP schemas', () => {
  it('LABEL_ENTRY_SCHEMA accepts a name and a palette-hex entry', () => {
    expect(LABEL_ENTRY_SCHEMA.safeParse('ui').success).toBe(true);
    expect(LABEL_ENTRY_SCHEMA.safeParse({ name: 'x', color: '#f97316' }).success).toBe(true);
  });

  it('LABEL_ENTRY_SCHEMA rejects a color name and a 3-digit hex', () => {
    expect(LABEL_ENTRY_SCHEMA.safeParse({ name: 'x', color: 'orange' }).success).toBe(false);
    expect(LABEL_ENTRY_SCHEMA.safeParse({ name: 'x', color: '#fff' }).success).toBe(false);
  });

  it('PRIORITY_SCHEMA accepts any non-negative integer and rejects the rest', () => {
    expect(PRIORITY_SCHEMA.safeParse(0).success).toBe(true);
    expect(PRIORITY_SCHEMA.safeParse(7).success).toBe(true);
    expect(PRIORITY_SCHEMA.safeParse(-1).success).toBe(false);
    expect(PRIORITY_SCHEMA.safeParse(1.5).success).toBe(false);
  });
});

describe('formatLabelVocabulary colors', () => {
  it('prints a colored label with its hex and an uncolored one without', () => {
    const counts = new Map([['regression', 4], ['ui', 2]]);
    const lines = formatLabelVocabulary(counts, 5, { regression: '#f97316' });

    expect(lines.join('\n')).toContain('regression #f97316 (4),');
    expect(lines.join('\n')).toContain('ui (2)');
    expect(lines.join('\n')).not.toContain('ui #');
  });

  it('wraps long colored entries so no line passes the wrap width', () => {
    const wrapColumns = BOARD_SUMMARY_LABEL_WRAP_COLUMNS;
    const counts = new Map<string, number>();
    const colors: Record<string, string> = {};
    for (let index = 0; index < 12; index++) {
      const name = `a-fairly-long-label-name-${String(index).padStart(2, '0')}`;
      counts.set(name, 20 - index);
      colors[name] = '#8b5cf6';
    }

    const lines = formatLabelVocabulary(counts, 12, colors);
    const entryLines = lines.slice(1);

    expect(entryLines.length).toBeGreaterThan(1);
    for (const line of entryLines) {
      expect(line.startsWith('  ')).toBe(true);
      expect(line.slice(2).length).toBeLessThanOrEqual(wrapColumns);
    }
  });
});
