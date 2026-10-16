/**
 * Unit tests for the automations-switch refusal on the TASK_UPDATE IPC handler.
 *
 * A task carries a per-task `automations_disabled` switch (see `Task` in
 * src/shared/types.ts). A workflow task has no such switch: its workflow's Pause
 * is the control, and joining a workflow clears the flag. The card menu hides
 * the row, and TASK_UPDATE refuses any other caller that tries to hold a
 * workflow task (src/main/ipc/handlers/task-crud.ts), with the reason
 * `automationsSwitchRefusal` gives (`AUTOMATIONS_SWITCH_WORKFLOW_REFUSAL` in
 * src/shared/automation-manifest.ts). The MCP task tools refuse the same way and
 * are pinned in task-commands-automations-disabled.test.ts.
 *
 * Pattern mirrors task-update-pr-resolve.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly, with every dependency
 * mocked so no Electron binary or real filesystem is needed.
 *
 * Covers:
 *   - `true` on a workflow task throws the refusal and never reaches `tasks.update`
 *   - `true` on an ordinary task reaches `tasks.update`
 *   - `false` on a workflow task reaches `tasks.update` (releasing nothing is not refused)
 *   - an edit that does not touch the switch reaches `tasks.update` for a workflow task
 *   - `true` for a task the repository does not know is left to `tasks.update`
 *
 * Red-green: make `automationsSwitchRefusal` return null and the two refusal
 * tests fail with the update going through; make it refuse every task and the
 * ordinary-task `true` test fails with the refusal thrown. The tests that reach
 * `tasks.update` (`false` on a workflow task, an edit that leaves the switch
 * alone, `false` on an ordinary task, and the unknown task) cannot be turned red
 * by mocking the manifest, because the handler's own `=== true` check sits
 * before it. Each asserts the update was called, which is what a handler that
 * refused too much would break.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTOMATIONS_SWITCH_WORKFLOW_REFUSAL } from '../../src/shared/automation-manifest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {},
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {},
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    renameBranch = vi.fn(async () => null);
  },
}));

const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  notifySpawnBlocked: () => {},
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Capture handlers registered by ipcMain.handle
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTaskCrudHandlers } from '../../src/main/ipc/handlers/task-crud';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The row as it stands before the update. A workflow task is one with a `workflow_id`. */
function createExistingTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    title: 'Triage the report',
    branch_name: null,
    worktree_path: null,
    base_branch: null,
    pr_url: null,
    pr_number: null,
    pr_state: null,
    workflow_id: null,
    workflow_project_id: null,
    automations_disabled: false,
    ...overrides,
  };
}

function createMockContext(): Record<string, unknown> {
  return {
    currentProjectId: 'proj-123',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => []),
      getActivityCache: vi.fn(() => ({})),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
      getBoardProfiles: vi.fn(() => []),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-123', path: '/mock/project' })) },
  };
}

async function callUpdateHandler(
  input: Record<string, unknown>,
  projectId: string | null = 'proj-123',
): Promise<Record<string, unknown>> {
  const handler = capturedHandlers.get(IPC.TASK_UPDATE);
  if (!handler) throw new Error(`Handler for ${IPC.TASK_UPDATE} was not registered`);
  return await (handler(null, input, projectId) as Promise<Record<string, unknown>>);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TASK_UPDATE automations switch', () => {
  let mockTaskUpdate: ReturnType<typeof vi.fn>;

  /** Register the handler over a repository that holds `existing` (or no task at all). */
  function arrange(existing: Record<string, unknown> | undefined): void {
    mockTaskUpdate = vi.fn((patch: Record<string, unknown>) => ({ ...existing, ...patch }));
    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => existing), update: mockTaskUpdate },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn() },
    });
    registerTaskCrudHandlers(createMockContext() as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
  });

  describe('a workflow task', () => {
    beforeEach(() => {
      arrange(createExistingTask({ workflow_id: 'workflow-1' }));
    });

    it('refuses to be held: throws the workflow reason and never writes', async () => {
      await expect(callUpdateHandler({ id: 'task-1', automations_disabled: true }))
        .rejects.toThrow(AUTOMATIONS_SWITCH_WORKFLOW_REFUSAL);

      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    it('refuses the hold even when it rides along with other edits, and writes none of them', async () => {
      await expect(callUpdateHandler({ id: 'task-1', title: 'Renamed', automations_disabled: true }))
        .rejects.toThrow(AUTOMATIONS_SWITCH_WORKFLOW_REFUSAL);

      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    it('accepts automations_disabled: false, which holds nothing', async () => {
      const result = await callUpdateHandler({ id: 'task-1', automations_disabled: false });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', automations_disabled: false }));
      expect(result).toMatchObject({ id: 'task-1', automations_disabled: false });
    });

    it('accepts an edit that leaves the switch alone', async () => {
      await callUpdateHandler({ id: 'task-1', title: 'Renamed' });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', title: 'Renamed' }));
    });
  });

  describe('an ordinary task', () => {
    beforeEach(() => {
      arrange(createExistingTask());
    });

    it('accepts automations_disabled: true and writes it', async () => {
      const result = await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', automations_disabled: true }));
      expect(result).toMatchObject({ id: 'task-1', automations_disabled: true });
    });

    it('accepts automations_disabled: false and writes it', async () => {
      await callUpdateHandler({ id: 'task-1', automations_disabled: false });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', automations_disabled: false }));
    });
  });

  describe('a task the repository does not know', () => {
    it('leaves the hold to tasks.update rather than refusing it, since there is no workflow to read', async () => {
      arrange(undefined);

      await callUpdateHandler({ id: 'task-missing', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-missing', automations_disabled: true }));
    });
  });
});
