/**
 * The TASK_TAKE_CONVERSATION_EXPIRED handler registered by
 * `registerTaskMoveHandlers` (src/main/ipc/handlers/task-move.ts), and the
 * `keepNoticesForLiveTasks` filter it calls
 * (src/main/ipc/helpers/pending-conversation-expired.ts).
 *
 * Main queues an expired-conversation notice before it pushes it, and the
 * renderer drains the project's queue when the push arrives and when a project
 * becomes current. The contract pinned here, through the REGISTERED handler:
 *
 *   - A take hands out the project's queued notices, oldest first, and a second
 *     take of the same project returns nothing: each notice goes out once.
 *   - Another project's notices are not returned and stay queued for that project.
 *   - A notice whose task was deleted, or archived, while it waited is dropped, and
 *     the drop is permanent (the take already removed it from the queue).
 *   - When the board cannot be read, every notice is returned: a stale toast costs
 *     less than a lost one.
 *   - An empty queue returns at once without opening the project's board.
 *   - A project id that is not a string returns an empty list and does not touch
 *     the queue.
 *
 * The queue module is REAL: `takeConversationExpired` is wrapped in a spy that
 * forwards to the real function, so a take drains the real queue and the
 * "not a string" case can observe that the queue was never consulted (the empty
 * list it returns is the same either way, since no string key matches a
 * non-string).
 *
 * Harness: the ipcMain capture and heavy-module mocks follow
 * task-move-shutdown.test.ts. `getProjectRepos` is the mocked seam that stands
 * in for the project's task repository.
 *
 * Red-green: return `notices` without the filter and the deleted and archived
 * cases fail; return `[]` from the catch in keepNoticesForLiveTasks and the
 * unreadable-board cases fail; drop the `notices.length === 0` return and the
 * empty-queue case fails (the board is opened for nothing); drop the
 * `typeof projectId !== 'string'` guard and the non-string case fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConversationExpiredNotice } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Mocks (declared before the module under test is imported)
// ---------------------------------------------------------------------------

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => undefined);
    getLatestForTask = vi.fn(() => null);
    getSummaryForTask = vi.fn(() => null);
    updateGitStats = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static scheduleBackgroundPrune = vi.fn();
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
  setShuttingDown: vi.fn(),
}));

const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({ executeTransition: vi.fn(async () => ({ failures: [] })) })),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
  reapTaskLeftovers: vi.fn(async () => {}),
}));

// The real queue, with `takeConversationExpired` wrapped so a test can see
// whether the handler consulted it. The spread keeps every other export real, and
// the spied function forwards to the real one, so the queue state is shared.
const { takeSpy } = vi.hoisted(() => ({ takeSpy: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/pending-conversation-expired', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/ipc/helpers/pending-conversation-expired')>();
  takeSpy.mockImplementation(actual.takeConversationExpired);
  return { ...actual, takeConversationExpired: takeSpy };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { registerTaskMoveHandlers } from '../../src/main/ipc/handlers/task-move';
import {
  __resetPendingConversationExpiredForTest,
  keepNoticesForLiveTasks,
  queueConversationExpired,
} from '../../src/main/ipc/helpers/pending-conversation-expired';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';

function makeNotice(taskId: string, overrides: Partial<ConversationExpiredNotice> = {}): ConversationExpiredNotice {
  return {
    projectId: PROJECT_ID,
    taskId,
    taskTitle: `Task ${taskId}`,
    lastActiveAt: '2026-07-01T09:30:00.000Z',
    ...overrides,
  };
}

type TaskRow = { archived_at: string | null };

/** Stand in for the project's task repository: a task id maps to its row, an id with no entry is a deleted task. */
function stubBoard(rowsByTaskId: Record<string, TaskRow>): void {
  mockGetProjectRepos.mockReturnValue({
    tasks: { getById: (taskId: string) => rowsByTaskId[taskId] },
  });
}

const context = { marker: 'task-take-conversation-expired-context' } as unknown as IpcContext;

function takeThroughHandler(projectId: unknown): ConversationExpiredNotice[] {
  const handler = ipcHandlers.get(IPC.TASK_TAKE_CONVERSATION_EXPIRED);
  if (!handler) throw new Error('TASK_TAKE_CONVERSATION_EXPIRED was not registered');
  return handler({}, projectId) as ConversationExpiredNotice[];
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ipcHandlers.clear();
  __resetPendingConversationExpiredForTest();
  takeSpy.mockClear();
  mockGetProjectRepos.mockReset();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  registerTaskMoveHandlers(context);
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// The registered handler
// ---------------------------------------------------------------------------

describe('TASK_TAKE_CONVERSATION_EXPIRED handler', () => {
  it('is registered on its channel', () => {
    expect(ipcHandlers.has(IPC.TASK_TAKE_CONVERSATION_EXPIRED)).toBe(true);
  });

  it('hands a project its queued notices oldest first, then nothing on the next take', () => {
    const first = makeNotice('task-1');
    const second = makeNotice('task-2');
    queueConversationExpired(first);
    queueConversationExpired(second);
    stubBoard({ 'task-1': { archived_at: null }, 'task-2': { archived_at: null } });

    expect(takeThroughHandler(PROJECT_ID)).toEqual([first, second]);
    expect(takeThroughHandler(PROJECT_ID)).toEqual([]);
  });

  it('reads the board of the project it was asked about', () => {
    queueConversationExpired(makeNotice('task-1'));
    stubBoard({ 'task-1': { archived_at: null } });

    takeThroughHandler(PROJECT_ID);

    expect(mockGetProjectRepos).toHaveBeenCalledTimes(1);
    expect(mockGetProjectRepos).toHaveBeenCalledWith(context, PROJECT_ID);
  });

  it('does not return another project\'s notices, and leaves them queued for that project', () => {
    const mine = makeNotice('task-1');
    const theirs = makeNotice('task-9', { projectId: OTHER_PROJECT_ID });
    queueConversationExpired(mine);
    queueConversationExpired(theirs);
    stubBoard({ 'task-1': { archived_at: null }, 'task-9': { archived_at: null } });

    expect(takeThroughHandler(PROJECT_ID)).toEqual([mine]);
    expect(takeThroughHandler(OTHER_PROJECT_ID)).toEqual([theirs]);
  });

  it('leaves out a notice whose task was deleted while it waited', () => {
    const live = makeNotice('task-live');
    const deleted = makeNotice('task-deleted');
    queueConversationExpired(deleted);
    queueConversationExpired(live);
    // No entry for task-deleted: the repository finds no row.
    stubBoard({ 'task-live': { archived_at: null } });

    expect(takeThroughHandler(PROJECT_ID)).toEqual([live]);
  });

  it('leaves out a notice whose task was archived while it waited', () => {
    const live = makeNotice('task-live');
    const archived = makeNotice('task-archived');
    queueConversationExpired(archived);
    queueConversationExpired(live);
    stubBoard({
      'task-live': { archived_at: null },
      'task-archived': { archived_at: '2026-07-02T10:00:00.000Z' },
    });

    expect(takeThroughHandler(PROJECT_ID)).toEqual([live]);
  });

  it('drops a filtered-out notice for good: the take already removed it from the queue', () => {
    queueConversationExpired(makeNotice('task-deleted'));
    stubBoard({});

    expect(takeThroughHandler(PROJECT_ID)).toEqual([]);

    // Even with the task on the board again, the notice the first take consumed
    // does not come back.
    stubBoard({ 'task-deleted': { archived_at: null } });
    expect(takeThroughHandler(PROJECT_ID)).toEqual([]);
  });

  it('returns every notice when the project\'s board cannot be read', () => {
    const first = makeNotice('task-1');
    const second = makeNotice('task-2');
    queueConversationExpired(first);
    queueConversationExpired(second);
    mockGetProjectRepos.mockImplementation(() => {
      throw new Error('project database is closed');
    });

    expect(takeThroughHandler(PROJECT_ID)).toEqual([first, second]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list for an empty queue without opening the board', () => {
    stubBoard({});

    expect(takeThroughHandler(PROJECT_ID)).toEqual([]);

    expect(mockGetProjectRepos).not.toHaveBeenCalled();
  });

  it('returns an empty list for a project id that is not a string, and does not consult the queue', () => {
    const notice = makeNotice('task-1');
    queueConversationExpired(notice);
    stubBoard({ 'task-1': { archived_at: null } });

    for (const notAnId of [undefined, null, 42, {}, ['project-1']]) {
      expect(takeThroughHandler(notAnId)).toEqual([]);
    }

    expect(takeSpy).not.toHaveBeenCalled();
    expect(mockGetProjectRepos).not.toHaveBeenCalled();
    // Nothing was drained: the real project still gets its notice.
    expect(takeThroughHandler(PROJECT_ID)).toEqual([notice]);
  });
});

// ---------------------------------------------------------------------------
// The filter on its own
// ---------------------------------------------------------------------------

describe('keepNoticesForLiveTasks', () => {
  const live = makeNotice('task-live');
  const deleted = makeNotice('task-deleted');
  const archived = makeNotice('task-archived');

  it('keeps notices for live tasks and drops deleted and archived ones, in order', () => {
    const rows: Record<string, TaskRow> = {
      'task-live': { archived_at: null },
      'task-archived': { archived_at: '2026-07-02T10:00:00.000Z' },
    };

    const kept = keepNoticesForLiveTasks([deleted, live, archived], () => ({
      getById: (taskId: string) => rows[taskId],
    }));

    expect(kept).toEqual([live]);
  });

  it('keeps every notice when the board cannot be opened, and says so', () => {
    const notices = [live, deleted];

    const kept = keepNoticesForLiveTasks(notices, () => {
      throw new Error('project database is closed');
    });

    expect(kept).toEqual(notices);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps every notice when a lookup throws part way through', () => {
    const notices = [live, deleted];

    const kept = keepNoticesForLiveTasks(notices, () => ({
      getById: (taskId: string) => {
        if (taskId === 'task-deleted') throw new Error('statement is finalized');
        return { archived_at: null };
      },
    }));

    expect(kept).toEqual(notices);
  });

  it('returns an empty list for no notices', () => {
    expect(keepNoticesForLiveTasks([], () => ({ getById: () => undefined }))).toEqual([]);
  });
});
