/**
 * Unit tests for the PR fields on the MCP task handlers.
 *
 * A task names its PR through the structured pr_url / pr_number columns - a PR
 * URL in the DESCRIPTION is deliberately not an anchor, because a URL cited as
 * background reads exactly like one naming the task's own PR. Two consequences
 * are covered here:
 *
 *   handleCreateTask - accepts prUrl / prNumber so a review task can be filed
 *     already linked in one call, applied as a follow-up update because
 *     TaskRepository.create always writes the PR columns null.
 *
 *   handleUpdateTask - nulls pr_state whenever the link is re-pointed or set.
 *     The three fields must always agree (the linker writes them atomically),
 *     and a stale terminal 'merged' short-circuits every non-force resolve,
 *     freezing the task on a PR it no longer points at.
 *
 * Strategy mirrors mcp-update-task-description-edits.test.ts: mock the
 * repositories so no better-sqlite3 binary is needed, and assert on captured
 * repository calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks - must be registered before the import under test
// ---------------------------------------------------------------------------

const {
  mockTaskRepoCreate,
  mockTaskRepoUpdate,
  mockTaskRepoGetById,
  mockTaskRepoGetByDisplayId,
  mockResolveColumn,
  mockLinkPRForTask,
} = vi.hoisted(() => ({
  mockTaskRepoCreate: vi.fn(),
  mockTaskRepoUpdate: vi.fn(),
  mockTaskRepoGetById: vi.fn(),
  mockTaskRepoGetByDisplayId: vi.fn(),
  mockResolveColumn: vi.fn(),
  mockLinkPRForTask: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    create = mockTaskRepoCreate;
    update = mockTaskRepoUpdate;
    getById = mockTaskRepoGetById;
    getByDisplayId = mockTaskRepoGetByDisplayId;
  },
}));

vi.mock('../../src/main/agent/commands/column-resolver', () => ({
  resolveColumn: mockResolveColumn,
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
// handlers under test here.
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {},
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPRForTask: mockLinkPRForTask,
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { handleCreateTask, handleUpdateTask, handleLinkPr } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REVIEWED_PR_URL = 'https://github.com/owner/repo/pull/98';

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

/** The real tools forward every omitted field as an explicit `null`, not `undefined`. */
function createTaskParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Review PR #98',
    description: '',
    column: null,
    priority: null,
    labels: null,
    branchName: null,
    baseBranch: null,
    useWorktree: null,
    attachments: null,
    agentOverride: null,
    modelOverride: null,
    effortOverride: null,
    permissionMode: null,
    autoCommand: null,
    profile: null,
    runMode: null,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

function updateTaskParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/**
 * Let the fire-and-forget resolve settle before the test ends. The spy itself
 * records synchronously (`scheduleLinkTimeResolve` calls it inline), so the
 * called/not-called assertions do not need this - what needs it is the attached
 * `.catch()`, which runs a microtask later. Without the flush a rejecting
 * resolve settles after teardown, which is how a passing test still leaks a
 * stray rejection into the next one.
 */
async function flushLinkTimeResolve(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Must resolve, not return undefined: the handlers call `.catch(...)` on it.
  mockLinkPRForTask.mockResolvedValue({ status: 'unchanged', task: null });
  mockResolveColumn.mockReturnValue({ swimlane: { id: 'lane-1', name: 'Code Review' } });
  mockTaskRepoCreate.mockReturnValue({ id: 'task-uuid-1', display_id: 7, title: 'Review PR #98' });
  mockTaskRepoUpdate.mockImplementation((patch: Record<string, unknown>) => ({
    id: 'task-uuid-1', display_id: 7, title: 'Review PR #98', ...patch,
  }));
  mockTaskRepoGetById.mockReturnValue({
    id: 'task-uuid-1', display_id: 7, title: 'Existing', description: '', attachment_count: 0,
  });
});

// ---------------------------------------------------------------------------
// handleCreateTask - filing a review task already linked to its PR
// ---------------------------------------------------------------------------

describe('handleCreateTask PR fields', () => {
  it('applies prUrl / prNumber as a follow-up update, keeping create PR-column-free', () => {
    const response = handleCreateTask(
      createTaskParams({ prUrl: REVIEWED_PR_URL, prNumber: 98 }),
      makeContext(),
    );

    expect(response.success).toBe(true);
    // The create input never carries PR columns: TaskRepository.create always
    // writes them null, and keeping that invariant means one create shape.
    const createInput = mockTaskRepoCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput).not.toHaveProperty('pr_url');
    expect(createInput).not.toHaveProperty('pr_number');
    // pr_state is deliberately left alone (null from create); the next resolve
    // fills it in from the PR itself.
    expect(mockTaskRepoUpdate).toHaveBeenCalledWith({
      id: 'task-uuid-1',
      pr_url: REVIEWED_PR_URL,
      pr_number: 98,
    });
  });

  it('links by prNumber alone, with no prUrl to derive it from', () => {
    // Mirrors handleUpdateTask's "nulls pr_state when only the PR number is set"
    // - the schema admits prNumber with no prUrl (mcp-task-tools-pr-fields-schema
    // asserts this), so a caller who already knows the number but not the full
    // URL is a reachable call shape on create too.
    handleCreateTask(createTaskParams({ prNumber: 98 }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith({ id: 'task-uuid-1', pr_number: 98 });
  });

  it('derives pr_number from prUrl when only the URL is passed', () => {
    // A URL already encodes its number, so passing prUrl alone is the natural
    // call. Without the derivation the row gets a pr_url and no pr_number, and
    // the ladder anchors on pr_number - so the task shows a PR badge that no
    // resolve can ever reach (the no-anchor gate never inspects pr_url).
    handleCreateTask(createTaskParams({ prUrl: REVIEWED_PR_URL }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith({
      id: 'task-uuid-1',
      pr_url: REVIEWED_PR_URL,
      pr_number: 98,
    });
  });

  it('omits pr_number when the URL names no PR number', () => {
    // z.string().url() admits any URL, not just a /pull/<n> one. Writing no
    // number is right here: a wrong number is worse than none, since Tier 1
    // would treat it as authoritative.
    handleCreateTask(createTaskParams({ prUrl: 'https://example.com/not-a-pr' }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith({
      id: 'task-uuid-1',
      pr_url: 'https://example.com/not-a-pr',
    });
  });

  it('does not touch the PR columns when neither field is passed', () => {
    const response = handleCreateTask(createTaskParams(), makeContext());

    expect(response.success).toBe(true);
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('treats omitted PR keys the same as the explicit nulls the tool layer forwards', () => {
    // The MCP tool always forwards `?? null`, but a direct handler call (and
    // several existing suites) pass neither key. `undefined !== null`, so
    // reading them raw would fire a pointless follow-up update on every create.
    const response = handleCreateTask({ title: 'Plain task', description: '' }, makeContext());

    expect(response.success).toBe(true);
    expect(mockTaskRepoUpdate).not.toHaveBeenCalled();
  });

  it('reports the updated task, so the linked row is what the caller is told about', () => {
    const context = makeContext();
    handleCreateTask(createTaskParams({ prUrl: REVIEWED_PR_URL, prNumber: 98 }), context);

    expect(context.onTaskCreated).toHaveBeenCalledWith(
      expect.objectContaining({ pr_url: REVIEWED_PR_URL, pr_number: 98 }),
      'Code Review',
      'lane-1',
    );
  });
});

// ---------------------------------------------------------------------------
// handleUpdateTask - re-pointing a link must not strand the old state
// ---------------------------------------------------------------------------

describe('handleUpdateTask PR fields', () => {
  it('nulls pr_state when the PR URL is set, so a stale merged never lingers', () => {
    handleUpdateTask(updateTaskParams({ prUrl: REVIEWED_PR_URL }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pr_url: REVIEWED_PR_URL, pr_state: null }),
    );
  });

  it('nulls pr_state when only the PR number is set', () => {
    handleUpdateTask(updateTaskParams({ prNumber: 98 }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 98, pr_state: null }),
    );
  });

  it('re-points pr_number along with the URL, so the old number cannot revert the link', () => {
    // The silent-revert path: writing only pr_url leaves the OLD pr_number in
    // the row, and the next non-force resolve takes that stale number as
    // authoritative (Tier 1) and overwrites pr_url back to the previous PR. The
    // caller's edit disappears with no error, so both fields move together.
    handleUpdateTask(updateTaskParams({ prUrl: REVIEWED_PR_URL }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pr_url: REVIEWED_PR_URL, pr_number: 98, pr_state: null }),
    );
  });

  it('nulls a stale pr_number when the new URL names no PR number', () => {
    handleUpdateTask(updateTaskParams({ prUrl: 'https://example.com/not-a-pr' }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pr_url: 'https://example.com/not-a-pr', pr_number: null }),
    );
  });

  it('lets an explicit prNumber win over the one the URL names', () => {
    handleUpdateTask(updateTaskParams({ prUrl: REVIEWED_PR_URL, prNumber: 12 }), makeContext());

    expect(mockTaskRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pr_url: REVIEWED_PR_URL, pr_number: 12 }),
    );
  });

  it('leaves pr_state alone on an update that does not touch the PR', () => {
    handleUpdateTask(updateTaskParams({ title: 'Renamed' }), makeContext());

    const patch = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('pr_state');
  });

  it('treats omitted PR keys the same as the explicit nulls the tool layer forwards', () => {
    // The MCP tool always forwards `?? null`, but a direct handler call and a
    // mobile-bridge payload can omit the keys entirely. `undefined !== null`, so
    // reading them raw wrote the literal string 'undefined' into pr_url and
    // Number(undefined) - NaN - into pr_number, clobbering a real link. Mirrors
    // the same normalization handleCreateTask has always had.
    handleUpdateTask({ taskId: 'task-uuid-1', title: 'Renamed' }, makeContext());

    const patch = mockTaskRepoUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('pr_url');
    expect(patch).not.toHaveProperty('pr_number');
    expect(patch).not.toHaveProperty('pr_state');
  });
});

// ---------------------------------------------------------------------------
// Link-time resolve - the write leaves pr_state null on purpose, so something
// has to refill it before the sweep or the card shows a stateless PR pill.
// ---------------------------------------------------------------------------

describe('link-time PR resolve', () => {
  it('resolves right after update_task writes a link, forced past the throttle', async () => {
    // Non-force would be swallowed by the 60s per-task coalesce, which is
    // exactly the window a PR-creating flow lands in (a move or idle trigger
    // just armed it). preserveLinkOnNotFound so the resolve cannot undo the
    // write that triggered it.
    handleUpdateTask(updateTaskParams({ prUrl: REVIEWED_PR_URL }), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).toHaveBeenCalledWith(
      'task-uuid-1',
      expect.objectContaining({ force: true, preserveLinkOnNotFound: true }),
    );
  });

  it('resolves right after create_task writes a link', async () => {
    handleCreateTask(createTaskParams({ prUrl: REVIEWED_PR_URL, prNumber: 98 }), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).toHaveBeenCalledWith(
      'task-uuid-1',
      expect.objectContaining({ force: true, preserveLinkOnNotFound: true }),
    );
  });

  it('resolves after the create notification, so auto-spawn is not parked behind a gh call', async () => {
    // onTaskCreated kicks autoSpawnForTask, which takes the same per-task lock
    // linkPRForTask does. Resolving first would hold the spawn for a full gh
    // round-trip.
    const order: string[] = [];
    const context = makeContext({ onTaskCreated: vi.fn(() => { order.push('onTaskCreated'); }) });
    mockLinkPRForTask.mockImplementation(async () => {
      order.push('linkPRForTask');
      return { status: 'unchanged', task: null };
    });

    handleCreateTask(createTaskParams({ prUrl: REVIEWED_PR_URL }), context);
    await flushLinkTimeResolve();

    expect(order).toEqual(['onTaskCreated', 'linkPRForTask']);
  });

  it('keeps the write and succeeds when the resolver is unavailable', async () => {
    // gh missing / unauthenticated must never fail the tool call or clear the
    // link: the row keeps pr_url + pr_number with pr_state null, exactly as the
    // write left it, and a later sweep fills the state in.
    mockLinkPRForTask.mockRejectedValue(new Error('gh not found'));

    const response = handleUpdateTask(updateTaskParams({ prUrl: REVIEWED_PR_URL }), makeContext());
    await flushLinkTimeResolve();

    expect(response.success).toBe(true);
    expect(mockTaskRepoUpdate).toHaveBeenCalledTimes(1);
    expect(mockTaskRepoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pr_url: REVIEWED_PR_URL, pr_number: 98, pr_state: null }),
    );
  });

  it('does not resolve on an update that leaves the PR fields alone', async () => {
    handleUpdateTask(updateTaskParams({ title: 'Renamed' }), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).not.toHaveBeenCalled();
  });

  it('does not resolve on a create with no PR fields', async () => {
    handleCreateTask(createTaskParams(), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).not.toHaveBeenCalled();
  });

  it('does not resolve when the PR URL is empty, which writes no usable anchor', async () => {
    // `prUrl: ''` passes the handler's `!== null` gate but names no PR, so a
    // resolve would have nothing to anchor on and would fall through to the
    // branch/commit tiers.
    handleUpdateTask(updateTaskParams({ prUrl: '' }), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).not.toHaveBeenCalled();
  });

  it('does not resolve on a create with an empty PR URL either', async () => {
    // The create path carries its own copy of the gate, so the update-path test
    // above cannot cover it: `prUrl: ''` clears `!== null` there too, and only
    // the `.trim() !== ''` half of `linksPR` keeps a create with no real anchor
    // from firing a forced resolve.
    handleCreateTask(createTaskParams({ prUrl: '' }), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).not.toHaveBeenCalled();
  });

  it('leaves link_pr clearing a stale link, since it is an explicit refresh', async () => {
    // The suppression is scoped to resolves fired BY a write. An explicit
    // "resolve now" must still clear a link that resolves to nothing.
    await handleLinkPr({ taskId: 'task-uuid-1' }, makeContext());

    expect(mockLinkPRForTask).toHaveBeenCalledWith(
      'task-uuid-1',
      expect.not.objectContaining({ preserveLinkOnNotFound: true }),
    );
  });

  it('does not resolve on update when prNumber is non-numeric and no prUrl anchors it', async () => {
    // The MCP tool's zod schema already validates a positive int, but this
    // handler is also reachable from the mobile bridge, which hands it raw
    // wire params with no validation. `Number('not-a-number')` is NaN, and
    // `Number.isFinite` is what keeps that NaN from firing a pointless forced
    // resolve (it would fall through to the ladder's branch/commit tiers with
    // nothing useful to anchor on).
    handleUpdateTask(updateTaskParams({ prNumber: 'not-a-number' }), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).not.toHaveBeenCalled();
  });

  it('does not resolve on create when prNumber is non-numeric and no prUrl anchors it', async () => {
    // Same guard, create path's own copy of it (`Number.isFinite(linkedPrNumber)`).
    handleCreateTask(createTaskParams({ prNumber: 'not-a-number' }), makeContext());
    await flushLinkTimeResolve();

    expect(mockLinkPRForTask).not.toHaveBeenCalled();
  });
});
