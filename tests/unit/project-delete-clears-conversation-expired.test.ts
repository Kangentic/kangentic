/**
 * Deleting a project drops the expired-conversation notices main still holds for
 * it. `cleanupProject` (src/main/ipc/handlers/projects.ts) calls
 * `clearConversationExpired(projectId)`: a notice queued for a project that no
 * longer exists would otherwise sit in main for the rest of the run, and a
 * project re-added under the same id would toast tasks of a board that is gone.
 *
 * The queue module is REAL here, so the assertion reads the queue itself:
 * a notice goes in, `cleanupProject` runs, and `takeConversationExpired` finds
 * nothing. Both branches of `cleanupProject` are driven, because the clear sits
 * ahead of the "project folder is gone" early return and a refactor could move it
 * into only one of them:
 *
 *   - the project folder no longer exists (the early return), and
 *   - the project folder exists (the full teardown).
 *
 * Another project's queue is left alone, which also proves the queue was really
 * populated (a clear that ignored its argument would empty it).
 *
 * Harness: the heavy-module mocks follow project-open-lifecycle.test.ts, which
 * drives the same function. A new file instead of an extension of that one, so
 * this stays small and independent of its recovery-order state.
 *
 * Red-green: delete the `clearConversationExpired(projectId)` line in
 * `cleanupProject` and every case here fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const state = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => state.existingPaths.has(target)),
    unlinkSync: vi.fn(() => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  },
}));

vi.mock('../../src/main/ipc/handlers/project-relocate', () => ({
  relocateProject: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => {}),
  autoSpawnTasks: vi.fn(async () => {}),
}));

vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async () => {}),
  pruneOrphanedWorktreeTasks: vi.fn(async () => 0),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static clearQueue = vi.fn();
  },
}));

vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => false),
  isInsideWorktree: vi.fn(() => false),
  isKangenticWorktree: vi.fn(() => false),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => []),
    get: vi.fn(),
    getOrThrow: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  getExistingProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(),
}));

vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  ensureGitignore: vi.fn(async () => {}),
  reapTaskLeftovers: vi.fn(async () => {}),
  leftoverSweepOptions: vi.fn(() => ({ stoppingEnabled: () => true, onReport: () => {} })),
}));

vi.mock('../../src/main/ipc/helpers/project-entry-search', () => ({
  searchProjectEntries: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

vi.mock('../../src/main/pr/pr-refresh-scheduler', () => ({
  prRefreshScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/git/git-fetch-scheduler', () => ({
  gitFetchScheduler: { startForProject: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { startForProject: vi.fn(), stop: vi.fn(), reconcileEmbedWorker: vi.fn() },
}));

vi.mock('../../src/main/retrieval/retrieval-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/retrieval-client')>()),
  retrievalClient: {
    call: vi.fn(async () => ({ breakdowns: {}, unreadable: [] })),
    closeProject: vi.fn(async () => undefined),
  },
}));

vi.mock('../../src/main/ipc/helpers/tool-breakdown-repair', () => ({
  repairToolBreakdownDurations: vi.fn(async () => ({ completed: true, scanned: 0, repaired: 0, unreadable: 0 })),
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = () => [];
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = () => [];
    listArchived = () => [];
    countAll = () => 0;
  },
}));

vi.mock('../../src/main/workflows/workflow-project-delete', () => ({
  detachProjectFromWorkflows: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-agent')>()),
  endWorkflowAgentsOfProject: vi.fn(async () => {}),
}));

import { cleanupProject } from '../../src/main/ipc/handlers/projects';
import {
  __resetPendingConversationExpiredForTest,
  queueConversationExpired,
  takeConversationExpired,
} from '../../src/main/ipc/helpers/pending-conversation-expired';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { ConversationExpiredNotice } from '../../src/shared/types';

const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';
const PROJECT_PATH = path.resolve(path.join('/', 'mock', 'project-delete-clears-conversation-expired'));

function makeNotice(projectId: string, taskId: string): ConversationExpiredNotice {
  return {
    projectId,
    taskId,
    taskTitle: `Task ${taskId}`,
    lastActiveAt: '2026-07-01T09:30:00.000Z',
    messageDropped: false,
  };
}

function makeContext(): IpcContext {
  return {
    boardConfigManager: { detach: vi.fn() },
    sessionManager: {
      closeProjectInPtyHost: vi.fn(async () => undefined),
      kill: vi.fn(),
      awaitExit: vi.fn(async () => {}),
      remove: vi.fn(),
      removeByTaskId: vi.fn(async () => {}),
    },
    currentProjectId: null,
    currentProjectPath: null,
    recoveredProjects: new Set<string>(),
    snapshottedProjects: new Set<string>(),
  } as unknown as IpcContext;
}

const consoleSpies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  __resetPendingConversationExpiredForTest();
  state.existingPaths.clear();
  // cleanupProject logs its progress and the "folder is gone" warning.
  consoleSpies.push(
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

describe('cleanupProject and the expired-conversation queue', () => {
  it('drops the project\'s queued notices when its folder is gone', async () => {
    queueConversationExpired(makeNotice(PROJECT_ID, 'task-1'));
    queueConversationExpired(makeNotice(PROJECT_ID, 'task-2'));
    // PROJECT_PATH is not in existingPaths: the early-return branch.

    await cleanupProject(makeContext(), PROJECT_ID, PROJECT_PATH);

    expect(takeConversationExpired(PROJECT_ID)).toEqual([]);
  });

  it('drops the project\'s queued notices when its folder exists and the full teardown runs', async () => {
    queueConversationExpired(makeNotice(PROJECT_ID, 'task-1'));
    state.existingPaths.add(PROJECT_PATH);

    await cleanupProject(makeContext(), PROJECT_ID, PROJECT_PATH);

    expect(takeConversationExpired(PROJECT_ID)).toEqual([]);
  });

  it('leaves another project\'s queued notices alone', async () => {
    const otherNotice = makeNotice(OTHER_PROJECT_ID, 'task-9');
    queueConversationExpired(makeNotice(PROJECT_ID, 'task-1'));
    queueConversationExpired(otherNotice);

    await cleanupProject(makeContext(), PROJECT_ID, PROJECT_PATH);

    expect(takeConversationExpired(PROJECT_ID)).toEqual([]);
    expect(takeConversationExpired(OTHER_PROJECT_ID)).toEqual([otherNotice]);
  });
});
