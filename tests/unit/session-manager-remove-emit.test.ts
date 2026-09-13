/**
 * Unit tests for SessionManager.remove()'s 'session-changed' emit.
 *
 * The bug: dragging a task out of To Do and back within a few seconds left
 * the renderer holding a `running` session row for a task main had fully
 * torn down. remove() deleted the registry row and emitted nothing, and the
 * only other channel (SESSION_EXIT) is deliberately suppressed for an
 * intentional exit (App.tsx), so nothing ever corrected a row resurrected by
 * a status push landing during the kill grace.
 *
 * The fix (session-manager.ts remove()) emits 'session-changed' with
 * status: 'exited' immediately before the registry row is deleted, so the
 * renderer's onStatus handler makes this row the task's only row
 * (withSessionUpserted) and the card stops painting a dead agent.
 *
 * Modelled on session-manager-placeholder-emit.test.ts.
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

import type { Session } from '../../src/shared/types';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';

describe('SessionManager.remove emit', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  function seedRunningSession(id: string): void {
    const registryAccess = (manager as unknown as { registry: SessionRegistry }).registry;
    registryAccess.set(id, {
      id,
      taskId: 'task-remove-emit',
      projectId: 'project-remove-emit',
      pty: null,
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);
  }

  it('emits session-changed exactly once when removing a live registry row', () => {
    seedRunningSession('sess-remove-1');
    const emittedEvents: Array<{ sessionId: string; session: Session }> = [];
    manager.on('session-changed', (sessionId: string, session: Session) => {
      emittedEvents.push({ sessionId, session });
    });

    manager.remove('sess-remove-1');

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].sessionId).toBe('sess-remove-1');
  });

  it('emitted session carries status exited, and the correct taskId/projectId', () => {
    seedRunningSession('sess-remove-2');
    const emittedSessions: Session[] = [];
    manager.on('session-changed', (_sessionId: string, session: Session) => {
      emittedSessions.push(session);
    });

    manager.remove('sess-remove-2');

    expect(emittedSessions).toHaveLength(1);
    const emitted = emittedSessions[0];
    expect(emitted.status).toBe('exited');
    expect(emitted.taskId).toBe('task-remove-emit');
    expect(emitted.projectId).toBe('project-remove-emit');
  });

  it('emits session-changed before the registry row is deleted (synchronous ordering)', () => {
    seedRunningSession('sess-remove-3');
    let rowPresentDuringEmit = false;
    manager.on('session-changed', (sessionId: string) => {
      rowPresentDuringEmit = manager.getSession(sessionId) !== undefined;
    });

    manager.remove('sess-remove-3');

    expect(rowPresentDuringEmit).toBe(true);
    expect(manager.getSession('sess-remove-3')).toBeUndefined();
  });

  it('emits nothing for an id that is already gone', () => {
    const emittedIds: string[] = [];
    manager.on('session-changed', (sessionId: string) => {
      emittedIds.push(sessionId);
    });

    manager.remove('sess-never-existed');

    expect(emittedIds).toHaveLength(0);
  });

  it('a second remove() of the same id (removeByTaskId re-entry) emits only once', () => {
    seedRunningSession('sess-remove-4');
    const emittedIds: string[] = [];
    manager.on('session-changed', (sessionId: string) => {
      emittedIds.push(sessionId);
    });

    manager.remove('sess-remove-4');
    manager.remove('sess-remove-4');

    expect(emittedIds).toEqual(['sess-remove-4']);
  });
});
