/**
 * An agent whose task is open is never paused for being idle (#1191). The sweep
 * paused one task four times in a day while its window was open, because nothing
 * asked whether it was.
 *
 * Runs the real sweep in a real SessionManager and SessionTelemetry, over the
 * real `DetailOwnerRegistry` a window's report reaches, with only the timers
 * faked. `register-all.ts` makes the same one-line lookup, which
 * `register-all-idempotency.test.ts` drives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import { DetailOwnerRegistry } from '../../src/main/task-detail/detail-owner-registry';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';

const PROJECT_ID = 'project-1';
const OPEN_TASK = 'task-open';
const OPEN_SESSION = 'sess-open';
const OTHER_SESSION = 'sess-other';
const MINUTE_MS = 60_000;

describe('the idle sweep and an open task', () => {
  let manager: SessionManager;
  let owners: DetailOwnerRegistry;
  let timedOut: string[];

  function seed(id: string, fields: Partial<ManagedSession>): void {
    (manager as unknown as { registry: SessionRegistry }).registry.set(id, {
      id, projectId: PROJECT_ID, pty: null, status: 'running', shell: '', cwd: '/mock/cwd',
      startedAt: new Date().toISOString(), exitCode: null, resuming: false, transient: false, exitSequence: ['\x03'],
      ...fields,
    } as ManagedSession);
    (manager as unknown as { telemetry: SessionTelemetry }).telemetry.initSession(id);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager();
    owners = new DetailOwnerRegistry();
    manager.setTaskWindowLookup((projectId, taskId) => owners.ownerOf(projectId, taskId) !== null);
    timedOut = [];
    manager.on('idle-timeout', (sessionId: string) => { timedOut.push(sessionId); });
    seed(OPEN_SESSION, { taskId: OPEN_TASK });
    seed(OTHER_SESSION, { taskId: 'task-other' });
    manager.setIdleTimeout(30);
  });

  afterEach(() => {
    manager.setIdleTimeout(0);
    vi.useRealTimers();
  });

  it.each([
    { where: 'on the board', webContentsId: 1, host: 'board' as const },
    { where: 'in the Agent Monitor', webContentsId: 1, host: 'monitor' as const },
    { where: 'in the detached Agent Monitor', webContentsId: 2, host: 'monitor' as const },
  ])('leaves a task alone while its window is open $where, and times it out after the window closes', ({ webContentsId, host }) => {
    owners.syncOwned(webContentsId, host, [{ projectId: PROJECT_ID, taskId: OPEN_TASK }]);

    vi.advanceTimersByTime(8 * 60 * MINUTE_MS);
    expect(timedOut).not.toContain(OPEN_SESSION);
    expect(timedOut).toContain(OTHER_SESSION);

    owners.syncOwned(webContentsId, host, []);
    vi.advanceTimersByTime(30 * MINUTE_MS);
    expect(timedOut).not.toContain(OPEN_SESSION);
    vi.advanceTimersByTime(3 * MINUTE_MS);
    expect(timedOut).toContain(OPEN_SESSION);
  });

  it('starts the wait over when the window goes away with its renderer', () => {
    owners.syncOwned(2, 'monitor', [{ projectId: PROJECT_ID, taskId: OPEN_TASK }]);
    vi.advanceTimersByTime(8 * 60 * MINUTE_MS);

    owners.releaseAllFor(2);
    vi.advanceTimersByTime(30 * MINUTE_MS);
    expect(timedOut).not.toContain(OPEN_SESSION);
  });

  it('leaves a task alone while a paired phone has its screen open', () => {
    let phoneShows: string | null = OPEN_SESSION;
    manager.setMobileTerminalProbe({ isSizeHeld: () => false, hasStreamSubscriber: (sessionId) => sessionId === phoneShows });

    vi.advanceTimersByTime(8 * 60 * MINUTE_MS);
    expect(timedOut).not.toContain(OPEN_SESSION);
    expect(timedOut).toContain(OTHER_SESSION);

    phoneShows = null;
    vi.advanceTimersByTime(33 * MINUTE_MS);
    expect(timedOut).toContain(OPEN_SESSION);
  });

  it('counts only the window of the session\'s own project and task', () => {
    owners.syncOwned(1, 'board', [{ projectId: 'another-project', taskId: OPEN_TASK }, { projectId: PROJECT_ID, taskId: 'another-task' }]);

    expect(manager.isTaskOpen(OPEN_SESSION)).toBe(false);
    vi.advanceTimersByTime(33 * MINUTE_MS);
    expect(timedOut).toContain(OPEN_SESSION);
  });

  it('answers no for a session with no task, and for one it does not hold', () => {
    const everythingIsOpen = { isSizeHeld: () => false, hasStreamSubscriber: () => true };
    manager.setMobileTerminalProbe(everythingIsOpen);
    seed('sess-terminal', { taskId: 'terminal-1', transient: true });
    seed('sess-workflow', { taskId: 'workflow-1', transient: true, workflowId: 'workflow-1' });

    expect(manager.isTaskOpen(OPEN_SESSION)).toBe(true);
    expect(manager.isTaskOpen('sess-terminal')).toBe(false);
    expect(manager.isTaskOpen('sess-workflow')).toBe(false);
    expect(manager.isTaskOpen('sess-unknown')).toBe(false);
  });
});
