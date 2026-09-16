/**
 * Unit tests for SessionManager.announceSessionEnded().
 *
 * The renderer's SESSION_EXIT handler ignores an intentional exit (it cannot
 * tell a suspend from a hard end without racing the suspended status push),
 * so a caller that ends a session with `kill()` + `awaitExit()` and KEEPS the
 * row - the cleanup_worktree transition action - left the renderer's replica
 * at 'running' for a session main knew was finished. `announceSessionEnded`
 * re-emits the row on 'session-changed' with its resolved status. These cases
 * pin the emit, the stamp for a row the natural exit never reached, and that
 * a suspended row is announced as it is.
 *
 * Modelled on session-manager-remove-emit.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// node-pty must be mocked before importing SessionManager
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

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

import type { Session, SessionStatus } from '../../src/shared/types';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';

describe('SessionManager.announceSessionEnded', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  function seedSession(id: string, status: SessionStatus, exitCode: number | null): void {
    const registryAccess = (manager as unknown as { registry: SessionRegistry }).registry;
    registryAccess.set(id, {
      id,
      taskId: 'task-announce',
      projectId: 'project-announce',
      pty: null,
      status,
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);
  }

  function captureStatusEmits(): Session[] {
    const emitted: Session[] = [];
    manager.on('session-changed', (_sessionId: string, session: Session) => {
      emitted.push(session);
    });
    return emitted;
  }

  it('emits session-changed once, carrying the exited status the natural exit stamped', () => {
    seedSession('sess-announce-1', 'exited', 0);
    const emitted = captureStatusEmits();

    manager.announceSessionEnded('sess-announce-1');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe('sess-announce-1');
    expect(emitted[0].status).toBe('exited');
    expect(emitted[0].exitCode).toBe(0);
    expect(emitted[0].taskId).toBe('task-announce');
  });

  it('stamps a row the natural exit never reached (still running after awaitExit) as exited', () => {
    seedSession('sess-announce-2', 'running', null);
    const emitted = captureStatusEmits();

    manager.announceSessionEnded('sess-announce-2');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].status).toBe('exited');
    expect(emitted[0].exitCode).toBe(-1);
    expect(manager.getSession('sess-announce-2')?.status).toBe('exited');
  });

  it('announces a suspended row as suspended: that is already a resolved status', () => {
    seedSession('sess-announce-3', 'suspended', null);
    const emitted = captureStatusEmits();

    manager.announceSessionEnded('sess-announce-3');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].status).toBe('suspended');
  });

  it('emits nothing for an id the registry does not hold', () => {
    const emitted = captureStatusEmits();

    manager.announceSessionEnded('sess-never-existed');

    expect(emitted).toHaveLength(0);
  });

  it('never emits session-removed: the row stays', () => {
    seedSession('sess-announce-4', 'exited', 1);
    const removed: string[] = [];
    manager.on('session-removed', (sessionId: string) => {
      removed.push(sessionId);
    });

    manager.announceSessionEnded('sess-announce-4');

    expect(removed).toEqual([]);
    expect(manager.getSession('sess-announce-4')).toBeDefined();
  });
});
