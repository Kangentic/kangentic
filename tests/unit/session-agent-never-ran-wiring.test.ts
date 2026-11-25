/**
 * Wiring for the never-ran mark (Sentry DESKTOP-2M): the session manager's
 * `launch-ended-before-agent-ran` reaches `registerSessionHandlers`, which
 * marks the record through the real `SessionRepository` on a real database.
 * The write does not depend on the session still being in the registry, and
 * a resume record that shares its id is left alone.
 *
 * Harness modeled on session-exit-startup-failure-notice.test.ts, with the
 * repository left real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

const capturedSessionEventHandlers = new Map<string, (...args: unknown[]) => unknown>();

const hoisted = vi.hoisted(() => ({
  database: null as Database.Database | null,
  shuttingDown: false,
  getProjectDb: vi.fn(),
  report: vi.fn(),
}));

vi.mock('../../src/main/analytics/handled-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/analytics/handled-report')>();
  return { ...actual, createChokepointReporter: () => ({ report: hoisted.report, reset: vi.fn() }) };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (...args: unknown[]) => hoisted.getProjectDb(...args),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => hoisted.shuttingDown,
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: vi.fn(),
  ensureTaskWorktree: vi.fn(async () => {}),
  createTransitionEngine: vi.fn(),
  resolveSpawnOverrides: vi.fn(() => ({})),
  notifySpawnBlocked: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn(async () => {}) }));

import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';
import { neverRanBaseRow, openProjectDatabase, readNeverRanAt as readNeverRanAtIn } from './helpers/never-ran-project-db';

const BASE_ROW = neverRanBaseRow('suspended');

function readNeverRanAt(id: string): string | null {
  return readNeverRanAtIn(hoisted.database!, id);
}

function registerAndFire(sessionId: string): void {
  const context = {
    currentProjectId: 'proj-test',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      listSessions: vi.fn(() => []),
      // The session left the registry before the write: nothing here is asked about it.
      getSession: vi.fn(() => undefined),
      getSessionProjectId: vi.fn(() => undefined),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        capturedSessionEventHandlers.set(event, handler);
      }),
      off: vi.fn(),
    },
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), cancel: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', path: '/mock/project' })) },
  };
  registerSessionHandlers(context as never);
  const handler = capturedSessionEventHandlers.get('launch-ended-before-agent-ran');
  if (!handler) throw new Error('launch-ended-before-agent-ran handler was not registered');
  handler(sessionId, 'proj-test', 'task-1');
}

beforeEach(() => {
  capturedSessionEventHandlers.clear();
  hoisted.shuttingDown = false;
  hoisted.report.mockClear();
  hoisted.database = openProjectDatabase();
  hoisted.getProjectDb.mockImplementation(() => hoisted.database);
});

describe('launch-ended-before-agent-ran', () => {
  it('marks the record of the fresh launch, read by the project id the event carries', () => {
    new SessionRepository(hoisted.database!).insert({ ...BASE_ROW, id: 'session-fresh' });

    registerAndFire('session-fresh');

    expect(hoisted.getProjectDb).toHaveBeenCalledWith('proj-test');
    expect(readNeverRanAt('session-fresh')).not.toBeNull();
  });

  it('leaves a resume record that shares its id unmarked', () => {
    const repository = new SessionRepository(hoisted.database!);
    repository.insert({ ...BASE_ROW, id: 'session-fresh' });
    repository.insert({ ...BASE_ROW, id: 'session-resume', started_at: '2026-01-01T00:00:05.000Z' });

    registerAndFire('session-resume');

    expect(readNeverRanAt('session-resume')).toBeNull();
  });

  it('writes nothing during a quit, which marks the record itself', () => {
    new SessionRepository(hoisted.database!).insert({ ...BASE_ROW, id: 'session-fresh' });
    hoisted.shuttingDown = true;

    registerAndFire('session-fresh');

    expect(readNeverRanAt('session-fresh')).toBeNull();
  });

  it('survives a database that cannot be opened', () => {
    hoisted.getProjectDb.mockImplementation(() => { throw new Error('closed'); });
    expect(() => registerAndFire('session-fresh')).not.toThrow();
  });

  it('reports a database that cannot be opened, tagged by its stage', () => {
    const failure = new Error('closed');
    hoisted.getProjectDb.mockImplementation(() => { throw failure; });

    registerAndFire('session-fresh');

    expect(hoisted.report).toHaveBeenCalledWith(failure, { tags: { stage: 'agent_never_ran_mark' } });
  });
});
