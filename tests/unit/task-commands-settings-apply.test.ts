/**
 * `handleUpdateTask` hands a write that moves the task's model or effort target
 * to `onTaskSettingsChanged`, which applies it to the live session the way a
 * ContextBar pick does. Before the hook, an agent or phone setting a pin only
 * wrote the row, and a move then read the pin as the source too, so the running
 * session kept its old settings until something else restarted it.
 *
 * Mock setup mirrors task-commands-run-mode.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTaskRepoUpdate = vi.fn();
const mockTaskRepoGetById = vi.fn();

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    update = mockTaskRepoUpdate;
    getById = mockTaskRepoGetById;
    getByDisplayId = vi.fn();
  },
}));
vi.mock('../../src/main/agent/commands/column-resolver', () => ({ resolveColumn: vi.fn() }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class { add = vi.fn(); list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class { getById = vi.fn(); remove = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/attachment-utils', () => ({ readFileAsAttachment: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({ BacklogRepository: class {} }));
vi.mock('../../src/main/pr/pr-linking', () => ({ linkPRForTask: vi.fn() }));

import { handleUpdateTask } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

function makeContext(): CommandContext {
  return {
    getProjectDb: vi.fn(() => ({}) as never),
    getProjectPath: vi.fn(() => '/mock/project'),
    getBoardProfiles: vi.fn(() => [{ id: 'profile-heavy', name: 'Heavy', columns: {} }]),
    setBoardProfiles: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskSettingsChanged: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async () => {}),
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
  } as unknown as CommandContext;
}

/** The tool forwards omitted fields as null, and leaves tri-state keys off. */
function updateTaskParams(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: 'task-uuid-1',
    title: null,
    description: null,
    descriptionEdits: null,
    appendDescription: null,
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

function existingTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-uuid-1',
    display_id: 1,
    title: 'Existing',
    description: 'desc',
    attachment_count: 0,
    run_mode: 'column_settings',
    profile_id: null,
    model_override: null,
    effort_override: null,
    session_id: 'session-1',
    ...overrides,
  };
}

/** The real repository writes the column names; the mock merges them onto the row. */
function stubStoredTask(overrides: Record<string, unknown> = {}): void {
  mockTaskRepoGetById.mockReturnValue(existingTask(overrides));
  mockTaskRepoUpdate.mockImplementation((input: Record<string, unknown>) => ({ ...existingTask(overrides), ...input }));
}

describe('handleUpdateTask - live session settings', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    stubStoredTask();
  });

  it.each([
    ['an effort pin', {}, { effort: 'high' }, { model: false, effort: true }],
    ['a model pin', {}, { model: 'opus' }, { model: true, effort: false }],
    ['a cleared effort pin', { effort_override: 'high' }, { effort: null }, { model: false, effort: true }],
    ['a profile', {}, { profile: 'Heavy' }, { model: true, effort: true }],
    ['a run mode switch', {}, { runMode: 'agent_override' }, { model: true, effort: true }],
  ])('hands %s to onTaskSettingsChanged with the written row and the fields it moved', (_label, stored, fields, changed) => {
    stubStoredTask(stored);

    const result = handleUpdateTask(updateTaskParams(fields), context);

    expect(result.success).toBe(true);
    expect(context.onTaskSettingsChanged).toHaveBeenCalledOnce();
    expect(context.onTaskSettingsChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-uuid-1' }), changed);
    expect(result.message).toContain('restarts if it is not already on these settings');
  });

  // The apply reads a changed field's source from the live session, so a
  // value sent again would read a manual `/effort` as drift and restart to
  // undo it.
  it.each([
    ['the run mode it already has', {}, { runMode: 'column_settings' }],
    ['the effort pin it already has', { effort_override: 'high' }, { effort: 'high' }],
    ['the model pin it already has', { model_override: 'opus' }, { model: 'opus' }],
  ])('leaves the live session alone for a write that re-sends %s', (_label, stored, fields) => {
    stubStoredTask(stored);

    const result = handleUpdateTask(updateTaskParams(fields), context);

    expect(result.success).toBe(true);
    expect(context.onTaskSettingsChanged).not.toHaveBeenCalled();
    expect(result.message).not.toContain('restarts');
  });

  it('leaves the live session alone for a write that moves no setting', () => {
    const result = handleUpdateTask(updateTaskParams({ title: 'New title', priority: 2 }), context);

    expect(result.success).toBe(true);
    expect(context.onTaskSettingsChanged).not.toHaveBeenCalled();
    expect(result.message).not.toContain('restarts');
  });

  it('does not mention a restart for a task with no live session', () => {
    stubStoredTask({ session_id: null });

    const result = handleUpdateTask(updateTaskParams({ effort: 'high' }), context);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('restarts');
  });
});
