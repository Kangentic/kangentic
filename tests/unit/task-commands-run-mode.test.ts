/**
 * Unit tests for the `run_mode` handling inside handleCreateTask /
 * handleUpdateTask (src/main/agent/commands/task-commands.ts).
 *
 * Nothing else in the suite reaches this code directly:
 *   - tests/unit/mcp-task-tools-run-mode-wiring.test.ts mocks `callHandler`
 *     itself (and mocks task-commands.ts's `handleMoveTaskToProject` export),
 *     so it only proves task-tools.ts FORWARDS `runMode` into the payload -
 *     it never invokes the real handleCreateTask / handleUpdateTask.
 *   - tests/unit/task-repository.test.ts covers `applyProfileExclusivity`
 *     inside TaskRepository, one layer below this.
 *
 * The two handlers use genuinely different semantics for the same field:
 *   - handleCreateTask spreads `run_mode` on TRUTHINESS
 *     (`runMode ? { run_mode: runMode } : {}`) - there is no "clear" case for
 *     create, only "set" or "omit".
 *   - handleUpdateTask gates on `!== undefined` (a real tri-state boundary,
 *     matching its model/effort/permissionMode siblings), and also has to
 *     echo the mode back in the response - read from the value TaskRepository
 *     actually persisted, not the raw request param, since a pin or a profile
 *     in the same write can flip the mode via applyProfileExclusivity without
 *     the caller naming it.
 *
 * Strategy mirrors mcp-update-task-description-edits.test.ts and
 * mcp-create-task-labels.test.ts: mock the repositories/column-resolver so no
 * better-sqlite3 binary is needed, and assert on the captured repository call
 * inputs and the handler's returned response shape.
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

// Defensive: transitively imported by task-commands.ts but unused by the
// handlers under test here.
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class { add = vi.fn(); list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class { getById = vi.fn(); remove = vi.fn(); },
}));
vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));
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

/**
 * The real kangentic_update_task tool (task-tools.ts) forwards every omitted
 * field as an explicit `null` (or, for the tri-state fields, leaves the key
 * off the object entirely so plain property access yields `undefined`) -
 * handleUpdateTask depends on that distinction. Mirror the tri-state shape
 * used by the model/effort/permissionMode tests in
 * mcp-update-task-description-edits.test.ts: `runMode` is deliberately absent
 * by default so `params.runMode` is `undefined` unless a test overrides it.
 */
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleCreateTask - run_mode is spread on TRUTHINESS, not `!== undefined`
// ---------------------------------------------------------------------------

describe('handleCreateTask - run_mode', () => {
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

  it('a truthy runMode is spread into the TaskRepository.create input', () => {
    const result = handleCreateTask({ title: 'T', runMode: 'agent_override' }, context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput.run_mode).toBe('agent_override');
  });

  it('an omitted runMode leaves run_mode OUT of the create input entirely (not merely undefined)', () => {
    const result = handleCreateTask({ title: 'T' }, context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoCreate).toHaveBeenCalledOnce();
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as Record<string, unknown>;
    // toHaveProperty (not toBeUndefined) is the point: it distinguishes the
    // conditional spread (`...(runMode ? {...} : {})`) from an unconditional
    // assignment of an explicit `undefined`, which a later regression to
    // `run_mode: runMode` (dropping the truthiness guard) would still pass if
    // this only checked `.run_mode === undefined`.
    expect(createInput).not.toHaveProperty('run_mode');
  });

  it('the default value "column_settings" is truthy, so it IS spread even though it is the default', () => {
    // Distinguishes the create-side truthiness guard from a hypothetical
    // "only send non-default values" guard - runMode is either present (any
    // truthy string) or fully omitted, with no special-casing of the
    // "column_settings" string itself.
    const result = handleCreateTask({ title: 'T', runMode: 'column_settings' }, context);

    expect(result.success).toBe(true);
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput.run_mode).toBe('column_settings');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateTask - run_mode is a real tri-state (`!== undefined`), and the
// response echo must read the PERSISTED value, not the request param.
// ---------------------------------------------------------------------------

describe('handleUpdateTask - run_mode', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockTaskRepoGetById.mockReturnValue(existingTask());
  });

  it('omitted (undefined): leaves run_mode out of the update input and out of changedFields', () => {
    mockTaskRepoUpdate.mockImplementation((input: Record<string, unknown>) => ({ ...existingTask(), ...input }));

    const result = handleUpdateTask(updateTaskParams({ title: 'New title' }), context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateInput).not.toHaveProperty('run_mode');
    expect(result.message).not.toContain('runMode');
  });

  it('a runMode-only update is a real scalar change: it reaches TaskRepository.update, not the "No fields provided" guard', () => {
    // Guards against a reorder that computes `hasScalarChange` before the
    // `run_mode` assignment above it - the likeliest way this silently breaks.
    mockTaskRepoUpdate.mockImplementation((input: Record<string, unknown>) => ({ ...existingTask(), ...input }));

    const result = handleUpdateTask(updateTaskParams({ runMode: 'agent_override' }), context);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateInput.run_mode).toBe('agent_override');
    expect(result.message).toContain('runMode');
  });

  it('the data.runMode echo reads the value TaskRepository actually persisted, not the requested param', () => {
    // applyProfileExclusivity (TaskRepository) can flip run_mode as a side
    // effect of a pin/profile in the same write, independent of what this
    // request asked for. Simulate that by having the mocked update return a
    // DIFFERENT run_mode than what was requested - a regression to echoing
    // the raw `newRunMode` param instead of `updated.run_mode` would report
    // the wrong (stale) value here.
    mockTaskRepoUpdate.mockReturnValue(existingTask({ run_mode: 'agent_override' }));

    const result = handleUpdateTask(updateTaskParams({ runMode: 'column_settings' }), context);

    expect(result.success).toBe(true);
    expect((result.data as { runMode: string }).runMode).toBe('agent_override');
  });
});
