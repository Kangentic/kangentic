/**
 * Unit tests for Edit-tool-style in-place description updates on
 * kangentic_update_task: `descriptionEdits` (ordered exact-string
 * find/replace, mirroring the file Edit tool) and `appendDescription`.
 *
 * Covers:
 *   computeUpdatedDescription (src/main/agent/commands/task-commands.ts)
 *     - pure find/replace, ordered multi-edit application, append, and
 *       edits+append composition
 *     - failure semantics: absent find, non-unique find, over-cap result
 *
 *   handleUpdateTask (src/main/agent/commands/task-commands.ts)
 *     - a failing edit writes nothing (atomic - no TaskRepository.update call)
 *     - a successful edit/append persists the computed description and
 *       reports it in changedFields
 *
 * Strategy mirrors mcp-attachment-handlers.test.ts: mock the repositories so
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
} = vi.hoisted(() => ({
  mockTaskRepoUpdate: vi.fn(),
  mockTaskRepoGetById: vi.fn(),
  mockTaskRepoGetByDisplayId: vi.fn(),
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
    add = vi.fn();
    getById = vi.fn();
    remove = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/backlog-attachment-repository', () => ({
  BacklogAttachmentRepository: class {
    getById = vi.fn();
    remove = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/attachment-utils', () => ({
  readFileAsAttachment: vi.fn(),
}));

// Defensive: transitively imported by task-commands.ts but unused by the
// handler under test here.
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

import { handleUpdateTask, computeUpdatedDescription, TASK_DESCRIPTION_MAX_LENGTH } from '../../src/main/agent/commands/task-commands';
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

/**
 * The real kangentic_update_task tool (task-tools.ts) forwards every omitted
 * field as an explicit `null`, not `undefined` - handleUpdateTask's
 * `field !== null` checks depend on that. Mirror that shape.
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

const ORIGINAL_DESCRIPTION = '## Section A\nfirst section text\n\n## Section B\nsecond section text\n';

function existingTask(description: string = ORIGINAL_DESCRIPTION) {
  return { id: 'task-uuid-1', display_id: 1, title: 'Existing', description, attachment_count: 0 };
}

// ---------------------------------------------------------------------------
// TASK_DESCRIPTION_MAX_LENGTH - the description cap was raised from 10,000 to
// 50,000. Without this assertion, nothing in this suite fails if the cap
// were reverted back to 10,000 (computeUpdatedDescription's own over-cap
// tests use `TASK_DESCRIPTION_MAX_LENGTH` symbolically, so they pass either
// way).
// ---------------------------------------------------------------------------

describe('TASK_DESCRIPTION_MAX_LENGTH', () => {
  it('is 50,000 characters (raised from the prior 10,000 cap)', () => {
    expect(TASK_DESCRIPTION_MAX_LENGTH).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// computeUpdatedDescription - pure helper
// ---------------------------------------------------------------------------

describe('computeUpdatedDescription', () => {
  it('applies a single find/replace and leaves the rest of the description unchanged', () => {
    const result = computeUpdatedDescription(ORIGINAL_DESCRIPTION, {
      edits: [{ find: 'first section text', replace: 'updated first section' }],
    });

    expect(result).toEqual({
      success: true,
      text: '## Section A\nupdated first section\n\n## Section B\nsecond section text\n',
    });
  });

  it('applies multiple edits in order against the evolving text', () => {
    const result = computeUpdatedDescription('one two three', {
      edits: [
        { find: 'one', replace: 'ONE' },
        { find: 'ONE two', replace: 'ONE-TWO' },
      ],
    });

    expect(result).toEqual({ success: true, text: 'ONE-TWO three' });
  });

  it('appends to the end and preserves existing content exactly (no separator inserted)', () => {
    const result = computeUpdatedDescription('existing content', { append: '\n\n## New Section\nmore text' });

    expect(result).toEqual({ success: true, text: 'existing content\n\n## New Section\nmore text' });
  });

  it('composes edits then append', () => {
    const result = computeUpdatedDescription(ORIGINAL_DESCRIPTION, {
      edits: [{ find: 'second section text', replace: 'updated second section' }],
      append: '\n\n## Section C\nnew section',
    });

    expect(result).toEqual({
      success: true,
      text: '## Section A\nfirst section text\n\n## Section B\nupdated second section\n\n\n## Section C\nnew section',
    });
  });

  it('returns an error when find is absent from the description', () => {
    const result = computeUpdatedDescription(ORIGINAL_DESCRIPTION, {
      edits: [{ find: 'text that does not exist anywhere', replace: 'x' }],
    });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('not present');
  });

  it('returns an error when find is not unique', () => {
    const result = computeUpdatedDescription('repeat repeat repeat', {
      edits: [{ find: 'repeat', replace: 'once' }],
    });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('must be unique');
  });

  it('returns an error when the computed result exceeds the description cap', () => {
    const result = computeUpdatedDescription('short', { append: 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH) });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain(String(TASK_DESCRIPTION_MAX_LENGTH));
  });

  it('succeeds as a no-op when find and replace are identical', () => {
    const result = computeUpdatedDescription(ORIGINAL_DESCRIPTION, {
      edits: [{ find: 'first section text', replace: 'first section text' }],
    });

    expect(result).toEqual({ success: true, text: ORIGINAL_DESCRIPTION });
  });

  it('supports deletion via an empty-string replace', () => {
    const result = computeUpdatedDescription('one two three', {
      edits: [{ find: 'two ', replace: '' }],
    });

    expect(result).toEqual({ success: true, text: 'one three' });
  });

  it('accepts a result whose length lands exactly at the cap (boundary: > not >=)', () => {
    const result = computeUpdatedDescription('short', {
      append: 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH - 'short'.length),
    });

    expect(result.success).toBe(true);
    expect((result as { text: string }).text).toHaveLength(TASK_DESCRIPTION_MAX_LENGTH);
  });

  it('rejects a result that lands exactly one character past the cap', () => {
    const result = computeUpdatedDescription('short', {
      append: 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH - 'short'.length + 1),
    });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain(String(TASK_DESCRIPTION_MAX_LENGTH + 1));
  });

  it('resolves overlapping-but-not-identical find strings across sequential edits (an earlier replace can make a later find unique)', () => {
    // "section" alone appears twice (Section A / Section B headers), so it is
    // non-unique against the ORIGINAL text. The first edit narrows the
    // second edit's target to a string that only exists once in the
    // POST-first-edit text, proving edits are matched against the evolving
    // text, not the original.
    const result = computeUpdatedDescription(ORIGINAL_DESCRIPTION, {
      edits: [
        { find: '## Section A\nfirst section text', replace: '## Section A\nfirst section CHANGED' },
        { find: 'first section CHANGED', replace: 'first section FINAL' },
      ],
    });

    expect(result).toEqual({
      success: true,
      text: '## Section A\nfirst section FINAL\n\n## Section B\nsecond section text\n',
    });
  });
});

// ---------------------------------------------------------------------------
// handleUpdateTask - description edits/append (atomicity + persistence)
// ---------------------------------------------------------------------------

describe('handleUpdateTask - descriptionEdits / appendDescription', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockTaskRepoGetById.mockReturnValue(existingTask());
  });

  it('a single successful edit persists the computed description and reports it in changedFields', () => {
    mockTaskRepoUpdate.mockImplementation((input: { description?: string }) => ({ ...existingTask(), description: input.description }));

    const result = handleUpdateTask(
      updateTaskParams({ descriptionEdits: [{ find: 'first section text', replace: 'revised first section' }] }),
      context,
    );

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as { description: string };
    expect(updateInput.description).toBe('## Section A\nrevised first section\n\n## Section B\nsecond section text\n');
    expect(result.message).toContain('description');
  });

  it('appendDescription persists the current description with the append concatenated', () => {
    mockTaskRepoUpdate.mockImplementation((input: { description?: string }) => ({ ...existingTask(), description: input.description }));

    const result = handleUpdateTask(
      updateTaskParams({ appendDescription: '\n\n## Section C\nadded later' }),
      context,
    );

    expect(result.success).toBe(true);
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as { description: string };
    expect(updateInput.description).toBe(`${ORIGINAL_DESCRIPTION}\n\n## Section C\nadded later`);
    // Guards against a regression that only sets descriptionChanged on the
    // descriptionEdits path, not the append-only path.
    expect(result.message).toContain('description');
  });

  it('an absent find fails the call and writes nothing', () => {
    const result = handleUpdateTask(
      updateTaskParams({ descriptionEdits: [{ find: 'text nowhere in the description', replace: 'x' }] }),
      context,
    );

    expect(result.success).toBe(false);
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('a non-unique find fails the call and writes nothing', () => {
    mockTaskRepoGetById.mockReturnValue(existingTask('repeat repeat repeat'));

    const result = handleUpdateTask(
      updateTaskParams({ descriptionEdits: [{ find: 'repeat', replace: 'once' }] }),
      context,
    );

    expect(result.success).toBe(false);
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('a failing edit partway through a multi-edit batch writes nothing (atomic)', () => {
    const result = handleUpdateTask(
      updateTaskParams({
        descriptionEdits: [
          { find: 'first section text', replace: 'revised first section' },
          { find: 'text nowhere in the description', replace: 'x' },
        ],
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('an over-cap result fails the call and writes nothing', () => {
    const result = handleUpdateTask(
      updateTaskParams({ appendDescription: 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH) }),
      context,
    );

    expect(result.success).toBe(false);
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('composes descriptionEdits and appendDescription: edits apply first, then the append', () => {
    mockTaskRepoUpdate.mockImplementation((input: { description?: string }) => ({ ...existingTask(), description: input.description }));

    const result = handleUpdateTask(
      updateTaskParams({
        descriptionEdits: [{ find: 'second section text', replace: 'revised second section' }],
        appendDescription: '\n\n## Section C\nadded later',
      }),
      context,
    );

    expect(result.success).toBe(true);
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as { description: string };
    expect(updateInput.description).toBe(
      '## Section A\nfirst section text\n\n## Section B\nrevised second section\n\n\n## Section C\nadded later',
    );
    expect(result.message).toContain('description');
  });

  // -------------------------------------------------------------------------
  // Empty-string appendDescription / no-op descriptionEdits must NOT write.
  // The handler only sets updates.description/descriptionChanged when the
  // computed text actually moved (`editResult.text !== task.description`).
  // Red-green: reverting to an unconditional write (dropping the !== guard)
  // makes these fail by calling mockTaskRepoUpdate / reporting 'description'.
  // -------------------------------------------------------------------------

  it('an empty appendDescription alone is a no-op: writes nothing and fails with "No fields provided"', () => {
    const result = handleUpdateTask(
      updateTaskParams({ appendDescription: '' }),
      context,
    );

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('No fields provided to update');
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('a no-op descriptionEdits (find === replace) alone is a no-op: writes nothing', () => {
    const result = handleUpdateTask(
      updateTaskParams({ descriptionEdits: [{ find: 'first section text', replace: 'first section text' }] }),
      context,
    );

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('No fields provided to update');
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('a no-op appendDescription combined with a real field updates but omits description from changedFields', () => {
    mockTaskRepoUpdate.mockImplementation((input: { title?: string }) => ({ ...existingTask(), title: input.title }));

    const result = handleUpdateTask(
      updateTaskParams({ title: 'New Title', appendDescription: '' }),
      context,
    );

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateInput.description).toBeUndefined();
    expect(result.message).not.toContain('description');
    expect(result.message).toContain('title');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateTask - model/effort/permissionMode TRI-STATE (task-commands.ts
// ~line 278-284, 332-334): these three fields distinguish "not provided"
// (undefined - leave untouched) from "explicitly cleared" (null, which the
// tool layer produces from an empty-string param) from "set" (a concrete
// value) - unlike the sibling scalar fields, which collapse "omitted" and
// "clear" onto the same null sentinel.
//
// `updateTaskParams()` deliberately does NOT include model/effort/
// permissionMode keys by default, so `params.model` etc. is `undefined` via
// plain property access on any call that doesn't override them - exactly
// matching what the real tool layer forwards for an omitted optional field.
//
// Red-green: reverting any of the three `!== undefined` guards in
// task-commands.ts to an unconditional assignment (or reverting the
// tool-layer empty-string-to-null mapping tested separately in
// mcp-task-session-tools.test.ts) makes the corresponding case below fail.
// ---------------------------------------------------------------------------

describe.each([
  { param: 'model', dbKey: 'model_override', changedField: 'model', value: 'opus' },
  { param: 'effort', dbKey: 'effort_override', changedField: 'effort', value: 'high' },
  { param: 'permissionMode', dbKey: 'permission_mode', changedField: 'permissionMode', value: 'plan' },
] as const)('handleUpdateTask - $param tri-state (omitted vs cleared vs set)', ({ param, dbKey, changedField, value }) => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = makeContext();
    mockTaskRepoGetById.mockReturnValue(existingTask());
    mockTaskRepoUpdate.mockImplementation((input: Record<string, unknown>) => ({ ...existingTask(), ...input }));
  });

  it('omitted (undefined): leaves the field out of the update and out of changedFields', () => {
    const result = handleUpdateTask(updateTaskParams({ title: 'New title' }), context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateInput).not.toHaveProperty(dbKey);
    expect(result.message).not.toContain(changedField);
  });

  it('null (the tool-layer empty-string clear): sets the field to null and reports it in changedFields', () => {
    const result = handleUpdateTask(updateTaskParams({ [param]: null }), context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateInput[dbKey]).toBeNull();
    expect(result.message).toContain(changedField);
  });

  it('a concrete value: sets the field to that value and reports it in changedFields', () => {
    const result = handleUpdateTask(updateTaskParams({ [param]: value }), context);

    expect(result.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledOnce();
    const updateInput = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updateInput[dbKey]).toBe(value);
    expect(result.message).toContain(changedField);
  });
});
