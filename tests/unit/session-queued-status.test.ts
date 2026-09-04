/**
 * Tests for queued session status behavior in SessionManager.
 *
 * Verifies that:
 * - spawn() returns status='queued' when at concurrency limit
 * - queued sessions emit 'session-changed' with queued status on creation
 * - the session ID is preserved across queue promotion
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import type { Session } from '../../src/shared/types';
import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';

function createMockPty() {
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

describe('SessionManager queued status', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    manager.setMaxConcurrent(1);
  });

  it('spawn returns queued status when at concurrency limit', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    // Second spawn should be queued (max concurrent = 1)
    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    expect(queued.status).toBe('queued');
    expect(queued.pid).toBeNull();
    expect(manager.queuedCount).toBe(1);
  });

  it('spawn emits session-changed event with queued status', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const statusEvents: Array<{ sessionId: string; status: string }> = [];
    manager.on('session-changed', (sessionId: string, session: Session) => {
      statusEvents.push({ sessionId, status: session.status });
    });

    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const queuedEvent = statusEvents.find(
      (event) => event.sessionId === queued.id && event.status === 'queued',
    );
    expect(queuedEvent).toBeDefined();
  });

  it('queued session transitions to running on promotion and preserves session ID', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    const queuedId = queued.id;

    expect(queued.status).toBe('queued');

    // Collect status events for the queued session
    const statusEvents: string[] = [];
    manager.on('session-changed', (sessionId: string, session: Session) => {
      if (sessionId === queuedId) statusEvents.push(session.status);
    });

    // Kill first session to free a slot and trigger promotion
    firstMock.triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Queued session should now be running with the same ID
    const promoted = manager.getSession(queuedId);
    expect(promoted?.status).toBe('running');
    expect(promoted?.id).toBe(queuedId);
    expect(statusEvents).toContain('running');
    expect(manager.queuedCount).toBe(0);
  });

  it('kill() on a queued session emits exit event', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    // Second spawn is queued (concurrency limit = 1)
    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(queued.status).toBe('queued');

    // Listen for exit events
    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    // Kill the queued session - should emit exit event for DB cleanup
    manager.kill(queued.id);

    const exitEvent = exitEvents.find((event) => event.sessionId === queued.id);
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.exitCode).toBe(-1);
    expect(manager.queuedCount).toBe(0);
  });

  it('killByTaskId() kills EVERY registry row for a task, not just the first match', async () => {
    // Reproduces the real registry shape while a respawn is queued behind a
    // stale suspended placeholder: the task transiently holds [suspended,
    // queued]. A first-match kill (registry.findByTaskId) picks whichever row
    // the Map iterates first - here the directly-seeded suspended placeholder,
    // inserted before the queued spawn - and would never reach the queued row,
    // leaving it to be promoted into a task the caller just tore down.
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const registryAccess = (manager as unknown as { registry: SessionRegistry }).registry;
    registryAccess.set('sess-dual-suspended', {
      id: 'sess-dual-suspended',
      taskId: 'task-dual',
      projectId: 'project-1',
      pty: null,
      status: 'suspended',
      shell: '',
      cwd: '/tmp/test',
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);

    // Concurrency is maxed by task-1, so this lands in the real SessionQueue as
    // 'queued' - the SECOND registry row for task-dual, inserted after the
    // suspended placeholder above.
    const queued = await manager.spawn({ taskId: 'task-dual', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(queued.status).toBe('queued');

    manager.killByTaskId('task-dual');

    // The queued row can only leave 'queued' via SessionQueue.remove(), which
    // killByTaskId must reach for BOTH rows, not only the suspended one a
    // first-match lookup would have found first.
    expect(manager.getSession(queued.id)?.status).toBe('exited');
    expect(manager.queuedCount).toBe(0);
  });

  it('removeByTaskId() on a queued session emits exit event', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(queued.status).toBe('queued');

    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    // removeByTaskId is the path used by handleTaskMove abort cleanup
    manager.removeByTaskId('task-2');

    const exitEvent = exitEvents.find((event) => event.sessionId === queued.id);
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.exitCode).toBe(-1);
    // Session should be fully removed from manager
    expect(manager.getSession(queued.id)).toBeUndefined();
  });

  it('removeByTaskId() removes EVERY registry row for a task, not just the first match', async () => {
    // Same [suspended, queued] shape as the killByTaskId test above, but for
    // remove(): a first-match removeByTaskId would delete only the directly-
    // seeded suspended row and leave the queued row listed in listSessions().
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const registryAccess = (manager as unknown as { registry: SessionRegistry }).registry;
    registryAccess.set('sess-dual-suspended-2', {
      id: 'sess-dual-suspended-2',
      taskId: 'task-dual-2',
      projectId: 'project-1',
      pty: null,
      status: 'suspended',
      shell: '',
      cwd: '/tmp/test',
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);

    const queued = await manager.spawn({ taskId: 'task-dual-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(queued.status).toBe('queued');

    manager.removeByTaskId('task-dual-2');

    const remaining = manager.listSessions().filter((session) => session.taskId === 'task-dual-2');
    expect(remaining).toEqual([]);
  });

  it('kill() on a running session does NOT emit exit event synchronously', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    const running = await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(running.status).toBe('running');

    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    // Kill a running session - exit event comes async from PTY onExit, not synchronously
    manager.kill(running.id);

    // No synchronous exit event (PTY hasn't exited yet)
    const syncExitEvent = exitEvents.find((event) => event.sessionId === running.id);
    expect(syncExitEvent).toBeUndefined();
  });
});
