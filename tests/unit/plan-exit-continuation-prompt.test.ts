/**
 * Tests for the `plan-exit` listener in registerSessionHandlers.
 *
 * When the user approves a plan, the listener auto-moves the task to the
 * column its lane's `plan_exit_target_id` names and hands handleTaskMove a
 * continuation prompt. When that move restarts the session (a model or effort
 * delta), the prompt is the resumed session's first message, arriving right
 * after a suspend the agent's transcript records as a user interrupt. So the
 * prompt must say why the session restarted and name the DESTINATION column,
 * never the source lane the task is leaving.
 *
 * Mock strategy mirrors session-branch-pushed-record.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    insert = vi.fn();
    updateStatus = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    insert = vi.fn();
    aggregate = vi.fn(() => []);
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = vi.fn(() => null);
  },
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(() => ({})),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(() => ({})),
  resolveSpawnOverrides: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/mock/project' })),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
  recordPushedBranchForSession: vi.fn(async () => {}),
}));

// No Board Profile: the lane routes plan exit exactly as stored.
vi.mock('../../src/main/transition-engine/column-strategy', () => ({
  applyProfileToLane: vi.fn((lane: unknown) => lane),
}));

vi.mock('../../src/main/ipc/helpers/task-profile', () => ({
  loadTaskProfile: vi.fn(() => null),
}));

import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';
import { getProjectRepos } from '../../src/main/ipc/helpers';

const PLANNING_LANE_ID = 'lane-planning';
const TARGET_LANE_ID = 'lane-target';

interface LaneStub {
  id: string;
  name: string;
  plan_exit_target_id: string | null;
}

function installBoard(lanes: LaneStub[]): void {
  const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
  vi.mocked(getProjectRepos).mockReturnValue({
    tasks: {
      getBySessionId: vi.fn(() => ({ id: 'task-1', title: 'My Task', swimlane_id: PLANNING_LANE_ID })),
      list: vi.fn(() => []),
    },
    swimlanes: {
      getById: vi.fn((id: string) => lanesById.get(id)),
      list: vi.fn(() => lanes),
    },
  } as never);
}

function createMockContext() {
  return {
    currentProjectId: 'proj-1',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      getSession: vi.fn(() => ({ transient: false })),
      getSessionTaskId: vi.fn(() => 'task-1'),
      getSessionProjectId: vi.fn(() => 'proj-1'),
      getSessionAgentName: vi.fn(() => 'claude'),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    projectRepo: {
      getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })),
    },
  };
}

async function firePlanExit(sessionId: string): Promise<void> {
  const handler = capturedSessionEventHandlers.get('plan-exit');
  if (!handler) throw new Error('plan-exit handler was not registered');
  await handler(sessionId);
}

/** The options bag is handleTaskMove's 6th positional argument. */
function continuationPromptArg(): unknown {
  const options = vi.mocked(handleTaskMove).mock.calls[0]?.[5] as { continuationPrompt?: string } | undefined;
  return options?.continuationPrompt;
}

describe('plan-exit continuation prompt names the restart and the destination column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSessionEventHandlers.clear();
    registerSessionHandlers(createMockContext() as never);
  });

  it('says the session restarted for the destination column, not the source lane', async () => {
    installBoard([
      { id: PLANNING_LANE_ID, name: 'Planning', plan_exit_target_id: TARGET_LANE_ID },
      { id: TARGET_LANE_ID, name: 'Executing', plan_exit_target_id: null },
    ]);

    await firePlanExit('sess-1');

    expect(handleTaskMove).toHaveBeenCalledTimes(1);
    expect(continuationPromptArg()).toBe(
      "The session restarted to apply the Executing column's settings. Proceed with implementing the approved plan.",
    );
    expect(continuationPromptArg()).not.toContain('Planning');
  });

  it('derives the column name from the target lane rather than hardcoding it', async () => {
    installBoard([
      { id: PLANNING_LANE_ID, name: 'Planning', plan_exit_target_id: TARGET_LANE_ID },
      { id: TARGET_LANE_ID, name: 'Code Review', plan_exit_target_id: null },
    ]);

    await firePlanExit('sess-1');

    expect(continuationPromptArg()).toBe(
      "The session restarted to apply the Code Review column's settings. Proceed with implementing the approved plan.",
    );
  });

  it('does not move the task when its lane has no plan-exit target', async () => {
    installBoard([
      { id: PLANNING_LANE_ID, name: 'Planning', plan_exit_target_id: null },
    ]);

    await firePlanExit('sess-1');

    expect(handleTaskMove).not.toHaveBeenCalled();
  });
});
