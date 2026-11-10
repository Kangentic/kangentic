/**
 * `restartSessionForSettingsChange` forwards the account the session comes back on (task #1057):
 * the continuation at a usage limit names the next account with room, and the respawn must run
 * on it. It rides `spawnOverrides.accountId`, which `resolveSpawnAccount` reads as the override.
 *
 * Red-green: dropping the `accountId` spread from the spawn overrides fails the first case;
 * spreading it unconditionally fails the second (an `accountId: undefined` key would still be
 * equal under toEqual, so the second case checks the key is absent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  sessionRecord: {
    id: 'rec-1',
    task_id: 'task-restart-1',
    agent_session_id: 'agent-X',
    status: 'running' as const,
    started_at: '2026-01-01T00:00:00Z',
    session_type: 'claude_agent',
    permission_mode: 'plan',
    applied_model: null,
    applied_effort: null,
    isolated_swimlane_id: null,
  },
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => undefined);
    getLatestForTask = vi.fn(() => hoisted.sessionRecord);
  },
}));
vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {},
}));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordSuspended: vi.fn(),
  markRecordExited: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/pty/session-registry', () => ({
  decideSuspendDbAction: vi.fn(() => 'suspend'),
  isLiveSession: vi.fn(() => true),
}));

const mockCreateTransitionEngine = vi.fn();
const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  resolveSpawnOverrides: () => ({ model: undefined, effort: undefined }),
}));

import { restartSessionForSettingsChange } from '../../src/main/ipc/handlers/session-reconcile';

const TASK_ID = 'task-restart-1';
const PROJECT_ID = 'proj-restart';
const PROJECT_PATH = '/mock/restart-project';

function makeTask(sessionId: string | null) {
  return { id: TASK_ID, session_id: sessionId, swimlane_id: 'lane-executing', agent: 'claude', model_override: null, effort_override: null };
}

function makeContext() {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: PROJECT_PATH,
    sessionManager: {
      drainQueue: vi.fn(),
      columnBlocks: vi.fn(() => false),
      isResuming: vi.fn(() => false),
      holdColumnSlot: vi.fn(() => () => undefined),
      suspend: vi.fn(async () => {}),
      getSession: vi.fn(() => null),
      markIdleAuthoritative: vi.fn(),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits' }, git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
      getBoardProfiles: vi.fn(() => []),
    },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, default_agent: 'claude', default_model: null, default_effort: null })) },
  };
}

async function restartWith(options: { accountId?: string }) {
  const engine = { resumeSuspendedSession: vi.fn(async () => {}) };
  mockCreateTransitionEngine.mockReturnValue(engine);
  mockGetProjectRepos.mockReturnValue({
    tasks: {
      getById: vi.fn()
        .mockReturnValueOnce(makeTask('live-session'))
        .mockReturnValueOnce(makeTask('live-session'))
        .mockReturnValue(makeTask(null)),
      update: vi.fn(),
    },
    swimlanes: { getById: vi.fn(() => ({ id: 'lane-executing', permission_mode: 'auto', model_override: null, effort_override: null })) },
    automations: {},
    automationRuns: {},
    attachments: {},
  });
  const result = await restartSessionForSettingsChange(
    makeContext() as never, PROJECT_ID, PROJECT_PATH, TASK_ID, { phase: 'switching-model', ...options },
  );
  expect(result).toEqual({ ok: true });
  return (engine.resumeSuspendedSession.mock.calls[0] as unknown[])[7] as Record<string, unknown>;
}

describe('restartSessionForSettingsChange: the account the session comes back on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards options.accountId as spawnOverrides.accountId', async () => {
    const spawnOverrides = await restartWith({ accountId: 'account-2' });

    expect(spawnOverrides.accountId).toBe('account-2');
    expect(spawnOverrides.forceFresh).toBe(false);
  });

  it('leaves the account out when none is named, so the list picks as for any spawn', async () => {
    const spawnOverrides = await restartWith({});

    expect('accountId' in spawnOverrides).toBe(false);
  });
});
