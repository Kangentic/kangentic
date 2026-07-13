/**
 * Pins the "live session overlay" filtering added to the USAGE_GET_DASHBOARD_STATS
 * IPC handler (src/main/ipc/handlers/usage-stats.ts). The module-local
 * `buildLiveSessionRows(sessionManager, scope)` helper is not exported, so the
 * only seam is the registered ipcMain.handle callback itself - we mock
 * `electron.ipcMain.handle` to capture it, then invoke it directly with a fake
 * SessionManager and assert exactly what `liveSessions` array reaches
 * `usageStatsService.getDashboardStats`.
 *
 * Deliberately NOT covered here (open review finding, active author decision):
 * whether a still-running session that started before the query window
 * belongs in a bounded period - that is period-window filtering of live
 * sessions, a separate behavior from the four pinned below.
 *
 * Pinned behaviors:
 *   1. Transient sessions are excluded from the overlay.
 *   2. Only `running`/`queued` sessions are included.
 *   3. Project scoping: `{ kind: 'project' }` excludes other projects'
 *      sessions; `{ kind: 'all' }` includes every project's live sessions.
 *   4. Handler-level suppression: a `drill` or `customWindow` arg forces an
 *      empty `liveSessions` array (bounded historical queries never layer
 *      live sessions on top); with both null, the overlay is built.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, SessionStatus, UsageStatsScope, UsageDayDrill, UsageCustomWindow } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted mock functions (vi.mock factories are hoisted above const
// declarations, so anything they reference must be created via vi.hoisted()).
// ---------------------------------------------------------------------------

const { mockHandle, mockGetDashboardStats } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockGetDashboardStats: vi.fn(() => ({
    kpis: null,
    perProject: [],
    series: [],
    skippedProjects: [],
  })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle },
}));

vi.mock('../../src/main/usage-stats/usage-stats-service', () => ({
  usageStatsService: { getDashboardStats: mockGetDashboardStats },
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are defined.
// ---------------------------------------------------------------------------

import { registerUsageStatsHandlers } from '../../src/main/ipc/handlers/usage-stats';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRegisteredHandler(): (...args: unknown[]) => unknown {
  const call = mockHandle.mock.calls.find(
    (registeredCall): registeredCall is [string, (...args: unknown[]) => unknown] =>
      registeredCall[0] === IPC.USAGE_GET_DASHBOARD_STATS,
  );
  if (!call) throw new Error(`No handler registered for ${IPC.USAGE_GET_DASHBOARD_STATS}`);
  return call[1];
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-default',
    taskId: 'task-default',
    projectId: 'project-a',
    pid: 1234,
    status: 'running' as SessionStatus,
    shell: '/bin/bash',
    cwd: '/mock/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    isolatedSwimlaneId: null,
    agentSessionId: null,
    ...overrides,
  };
}

function makeSessionManager(sessions: Session[]) {
  return {
    listSessions: vi.fn(() => sessions),
    getUsageCache: vi.fn(() => ({})),
    getUsageCacheForProject: vi.fn(() => ({})),
    getToolCallCount: vi.fn(() => 0),
    getSessionAgentName: vi.fn(() => null),
  };
}

function makeContext(sessions: Session[]): IpcContext {
  return {
    sessionManager: makeSessionManager(sessions),
  } as unknown as IpcContext;
}

/** Invokes the handler and returns the `liveSessions` array (5th positional
 *  arg) that reached usageStatsService.getDashboardStats. */
function invokeAndCaptureLiveSessions(
  context: IpcContext,
  scope: UsageStatsScope,
  drill: UsageDayDrill | null = null,
  customWindow: UsageCustomWindow | null = null,
): unknown[] {
  registerUsageStatsHandlers(context);
  const handler = getRegisteredHandler();
  handler(null, scope, 'today', drill, customWindow);
  const call = mockGetDashboardStats.mock.calls.at(-1);
  if (!call) throw new Error('getDashboardStats was not called');
  return call[4] as unknown[];
}

beforeEach(() => {
  mockHandle.mockClear();
  mockGetDashboardStats.mockClear();
});

describe('USAGE_GET_DASHBOARD_STATS: live session overlay filtering', () => {
  it('excludes transient sessions from the overlay', () => {
    const sessions = [
      makeSession({ id: 'normal-1', status: 'running', transient: false, projectId: 'project-a' }),
      makeSession({ id: 'transient-1', status: 'running', transient: true, projectId: 'project-a' }),
    ];
    const context = makeContext(sessions);

    const liveSessions = invokeAndCaptureLiveSessions(context, { kind: 'project', projectId: 'project-a' });

    const ids = liveSessions.map((row) => (row as { sessionRecordId: string }).sessionRecordId);
    expect(ids).toContain('normal-1');
    expect(ids).not.toContain('transient-1');
  });

  it('includes only running/queued sessions, excluding exited and suspended', () => {
    const sessions = [
      makeSession({ id: 'running-1', status: 'running', projectId: 'project-a' }),
      makeSession({ id: 'queued-1', status: 'queued', projectId: 'project-a' }),
      makeSession({ id: 'exited-1', status: 'exited', projectId: 'project-a' }),
      makeSession({ id: 'suspended-1', status: 'suspended', projectId: 'project-a' }),
    ];
    const context = makeContext(sessions);

    const liveSessions = invokeAndCaptureLiveSessions(context, { kind: 'project', projectId: 'project-a' });

    const ids = liveSessions.map((row) => (row as { sessionRecordId: string }).sessionRecordId).sort();
    expect(ids).toEqual(['queued-1', 'running-1']);
  });

  it('scopes to a single project when scope.kind is "project"', () => {
    const sessions = [
      makeSession({ id: 'in-scope', status: 'running', projectId: 'project-a' }),
      makeSession({ id: 'other-project', status: 'running', projectId: 'project-b' }),
    ];
    const context = makeContext(sessions);

    const liveSessions = invokeAndCaptureLiveSessions(context, { kind: 'project', projectId: 'project-a' });

    const ids = liveSessions.map((row) => (row as { sessionRecordId: string }).sessionRecordId);
    expect(ids).toContain('in-scope');
    expect(ids).not.toContain('other-project');
  });

  it('includes every project\'s live sessions when scope.kind is "all"', () => {
    const sessions = [
      makeSession({ id: 'proj-a-session', status: 'running', projectId: 'project-a' }),
      makeSession({ id: 'proj-b-session', status: 'queued', projectId: 'project-b' }),
    ];
    const context = makeContext(sessions);

    const liveSessions = invokeAndCaptureLiveSessions(context, { kind: 'all' });

    const ids = liveSessions.map((row) => (row as { sessionRecordId: string }).sessionRecordId).sort();
    expect(ids).toEqual(['proj-a-session', 'proj-b-session']);
  });

  it('suppresses the overlay (passes an empty array) when a drill is present', () => {
    const sessions = [makeSession({ id: 'live-1', status: 'running', projectId: 'project-a' })];
    const context = makeContext(sessions);

    const liveSessions = invokeAndCaptureLiveSessions(
      context,
      { kind: 'project', projectId: 'project-a' },
      { dayStartMs: Date.now() },
      null,
    );

    expect(liveSessions).toEqual([]);
  });

  it('suppresses the overlay (passes an empty array) when a customWindow is present', () => {
    const sessions = [makeSession({ id: 'live-1', status: 'running', projectId: 'project-a' })];
    const context = makeContext(sessions);

    const liveSessions = invokeAndCaptureLiveSessions(
      context,
      { kind: 'project', projectId: 'project-a' },
      null,
      { sinceMs: Date.now() - 86_400_000, untilMs: Date.now() },
    );

    expect(liveSessions).toEqual([]);
  });

  it('builds the overlay from live sessions when both drill and customWindow are null', () => {
    const sessions = [makeSession({ id: 'live-1', status: 'running', projectId: 'project-a' })];
    const context = makeContext(sessions);

    const liveSessions = invokeAndCaptureLiveSessions(context, { kind: 'project', projectId: 'project-a' }, null, null);

    const ids = liveSessions.map((row) => (row as { sessionRecordId: string }).sessionRecordId);
    expect(ids).toEqual(['live-1']);
  });
});
