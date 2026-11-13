/**
 * What a user loses if these reports go quiet: a held message that is never
 * delivered, an idle agent that never pauses, a crash-resilience snapshot that
 * stops saving, artifact links that stop appearing, and a session that stalls at
 * its usage limit would each fail with nothing on screen and nothing in Sentry.
 *
 * Each case runs the real module, makes one dependency throw a code defect (a
 * TypeError), and reads the call that reached `reportHandledError`: its source
 * and its stage tag. Replaces the source-text pins in
 * error-reporting-feature-gaps.test.ts for these five sites.
 *
 * Modules are re-imported per test (`vi.resetModules`) because each reporter is
 * module-private and latches a key once per run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

/** What `getProjectDb` does: hand out the test database, or throw a defect. */
const databaseControl = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'throw',
  database: null as unknown,
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => {
    if (databaseControl.mode === 'throw') throw new TypeError('database handle is undefined');
    return databaseControl.database;
  },
}));

const pauseControl = vi.hoisted(() => ({ error: new TypeError('pause defect') }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({
  pauseTaskSession: vi.fn(async () => { throw pauseControl.error; }),
}));

const capturedSessionEventHandlers = new Map<string, (...handlerArguments: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  MessageChannelMain: class {},
  webContents: { fromId: vi.fn() },
}));

const artifactControl = vi.hoisted(() => ({ linkArtifacts: vi.fn() }));
vi.mock('../../src/main/artifacts/artifact-linking', () => ({
  linkArtifacts: artifactControl.linkArtifacts,
}));

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  artifactControl.linkArtifacts.mockReset();
  capturedSessionEventHandlers.clear();
  databaseControl.mode = 'ok';
  databaseControl.database = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The tags of the one report that was sent. */
function onlyReportTags(): Record<string, string> {
  expect(reportHandledError).toHaveBeenCalledTimes(1);
  return reportHandledError.mock.calls[0][1] as Record<string, string>;
}

describe('held messages', () => {
  const PROJECT_ID = 'project-held';
  const TASK_ID = 'task-held';

  async function seedHeldMessage(): Promise<void> {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    runProjectMigrations(database);
    const lane = database.prepare('SELECT id FROM swimlanes WHERE name = ?').get('Executing') as { id: string };
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO tasks (id, display_id, title, swimlane_id, position, created_at, updated_at, archived_at)
      VALUES (?, 1, 'A task', ?, 0, ?, ?, NULL)
    `).run(TASK_ID, lane.id, now, now);
    const { SentSessionMessageRepository } = await import('../../src/main/db/repositories/sent-session-message-repository');
    new SentSessionMessageRepository(database).insertHeld({
      taskId: TASK_ID,
      message: 'Lower the cap.',
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
    });
    databaseControl.database = database;
  }

  it('reports a read that fails, under source held_messages and stage read, and delivers nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    databaseControl.mode = 'throw';
    const { claimHeldMessages } = await import('../../src/main/held-messages/held-messages');

    expect(claimHeldMessages({} as never, PROJECT_ID, TASK_ID)).toBeNull();

    expect(onlyReportTags()).toMatchObject({ source: 'held_messages', stage: 'read', error_name: 'TypeError' });
  });

  it('reports a write that fails when a claim settles, under stage write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedHeldMessage();
    const { claimHeldMessages } = await import('../../src/main/held-messages/held-messages');
    const claim = claimHeldMessages({} as never, PROJECT_ID, TASK_ID);
    expect(claim).not.toBeNull();
    expect(reportHandledError).not.toHaveBeenCalled();

    databaseControl.mode = 'throw';
    claim?.commit('session-next');

    expect(onlyReportTags()).toMatchObject({ source: 'held_messages', stage: 'write' });
  });
});

describe('idle pause', () => {
  function makeSessionHandlersContext() {
    return {
      currentProjectId: 'proj-1',
      currentProjectPath: '/mock/project',
      mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
      sessionManager: new Proxy({
        getSession: vi.fn(() => ({ id: 'sess-idle', taskId: 'task-idle', status: 'running' })),
        getSessionProjectId: vi.fn(() => 'proj-1'),
        getActivityCache: vi.fn(() => ({ 'sess-idle': 'idle' })),
        getPendingDraft: vi.fn(() => null),
        getOpenWork: vi.fn(() => ({ backgroundShells: [], toolCalls: [] })),
        on: vi.fn((event: string, handler: (...handlerArguments: unknown[]) => unknown) => {
          capturedSessionEventHandlers.set(event, handler);
        }),
        off: vi.fn(),
      }, {
        // Anything registration reads that this test does not care about.
        get(target, property) {
          if (property in target) return (target as Record<string | symbol, unknown>)[property];
          return vi.fn(() => ({}));
        },
      }),
      configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
      boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
      terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), cancel: vi.fn() },
      projectRepo: { getById: vi.fn(() => ({ default_agent: 'claude', path: '/mock/project' })) },
    };
  }

  it('reports a pause that rejects, under source session_handlers and stage idle_pause', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { registerSessionHandlers } = await import('../../src/main/ipc/handlers/sessions');
    registerSessionHandlers(makeSessionHandlersContext() as never);
    const idleTimeoutHandler = capturedSessionEventHandlers.get('idle-timeout');
    if (!idleTimeoutHandler) throw new Error('idle-timeout handler was not registered');

    idleTimeoutHandler('sess-idle', 'task-idle', 5);

    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(onlyReportTags()).toMatchObject({ source: 'session_handlers', stage: 'idle_pause', error_name: 'TypeError' });
  });
});

describe('metrics snapshot timer', () => {
  it('reports a project batch that throws, under source metrics_snapshot and stage batch', async () => {
    vi.useFakeTimers();
    databaseControl.mode = 'throw';
    const { startMetricsSnapshotTimer, stopMetricsSnapshotTimer } = await import('../../src/main/ipc/handlers/metrics-snapshot-timer');
    const sessionManager = {
      listSessions: vi.fn(() => [{ id: 'session-1', taskId: 'task-1', projectId: 'project-1', status: 'running' }]),
    };

    startMetricsSnapshotTimer(sessionManager as never);
    vi.advanceTimersByTime(45_000);
    stopMetricsSnapshotTimer();

    expect(onlyReportTags()).toMatchObject({ source: 'metrics_snapshot', stage: 'batch', error_name: 'TypeError' });
  });
});

describe('artifact detection', () => {
  it('reports a link write that throws, under source artifact_detection and stage detect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    artifactControl.linkArtifacts.mockImplementation(() => { throw new TypeError('link defect'); });
    const { registerArtifactDetection } = await import('../../src/main/artifacts/artifact-detection');
    const sessionManager = new EventEmitter();
    registerArtifactDetection({ sessionManager } as never, new EventEmitter() as never);

    expect(() => sessionManager.emit('artifact-links', 'session-1', {
      urls: ['https://www.figma.com/design/AbC123xyz/My-File'],
      title: null,
      source: 'agent',
    })).not.toThrow();

    expect(onlyReportTags()).toMatchObject({ source: 'artifact_detection', stage: 'detect', error_name: 'TypeError' });
  });
});

describe('account continuation', () => {
  it('reports a continuation that throws, under source accounts and stage continuation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { AccountContinuation } = await import('../../src/main/accounts/account-continuation');
    const session = { sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1', agent: 'test-agent', accountId: 'one' };
    const accounts = ['one', 'two'].map((id, index) => ({ id, agent: 'test-agent', position: index + 1 }));
    const continuation = new AccountContinuation({
      readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: true }),
      findTaskSession: () => session,
      isUsageLimitFailure: () => true,
      ordered: () => accounts as never,
      readUsageNow: async () => { throw new TypeError('usage read defect'); },
      continueOn: async () => true,
      notifySwitched: vi.fn(),
      notifyAllFull: vi.fn(),
    });

    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');

    expect(onlyReportTags()).toMatchObject({ source: 'accounts', stage: 'continuation', error_name: 'TypeError' });
  });
});
