/**
 * Unit tests for SessionManager.registerSuspendedPlaceholder() emit behavior.
 *
 * The bug fixed in this branch: after a rapid project switch the renderer held
 * a stale "running" session entry for a task whose PTY had already been killed.
 * When the user clicked Resume, main threw "Task already has an active session".
 *
 * The fix (session-manager.ts:758) emits 'session-changed' immediately after
 * registering the placeholder so the renderer's onStatus handler can evict the
 * stale entry without waiting for the next syncSessions() poll.
 *
 * These tests verify that the emit happens, carries the correct payload, and
 * that the returned session matches the emitted one.
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
import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { PtyBufferManager } from '../../src/main/pty/buffer/pty-buffer-manager';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { FirstOutputTracker } from '../../src/main/pty/lifecycle/first-output-tracker';

describe('SessionManager.registerSuspendedPlaceholder emit', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  it('emits session-changed exactly once when registering a suspended placeholder', () => {
    const emittedEvents: Array<{ sessionId: string; session: Session }> = [];
    manager.on('session-changed', (sessionId: string, session: Session) => {
      emittedEvents.push({ sessionId, session });
    });

    manager.registerSuspendedPlaceholder({
      taskId: 'task-placeholder-1',
      projectId: 'project-placeholder-1',
      cwd: '/mock/cwd',
    });

    expect(emittedEvents).toHaveLength(1);
  });

  it('emitted session-changed first arg matches the returned session id', () => {
    const emittedIds: string[] = [];
    manager.on('session-changed', (sessionId: string) => {
      emittedIds.push(sessionId);
    });

    const returned = manager.registerSuspendedPlaceholder({
      taskId: 'task-placeholder-2',
      projectId: 'project-placeholder-2',
      cwd: '/mock/cwd',
    });

    expect(emittedIds).toHaveLength(1);
    expect(emittedIds[0]).toBe(returned!.id);
  });

  it('emitted session payload has status suspended, correct taskId and projectId', () => {
    const emittedSessions: Session[] = [];
    manager.on('session-changed', (_sessionId: string, session: Session) => {
      emittedSessions.push(session);
    });

    manager.registerSuspendedPlaceholder({
      taskId: 'task-placeholder-3',
      projectId: 'project-placeholder-3',
      cwd: '/mock/cwd',
    });

    expect(emittedSessions).toHaveLength(1);
    const emitted = emittedSessions[0];
    expect(emitted.status).toBe('suspended');
    expect(emitted.taskId).toBe('task-placeholder-3');
    expect(emitted.projectId).toBe('project-placeholder-3');
  });

  it('returned session matches the emitted session in full', () => {
    let emittedSession: Session | null = null;
    manager.on('session-changed', (_sessionId: string, session: Session) => {
      emittedSession = session;
    });

    const returned = manager.registerSuspendedPlaceholder({
      taskId: 'task-placeholder-4',
      projectId: 'project-placeholder-4',
      cwd: '/mock/cwd',
    });

    expect(emittedSession).not.toBeNull();
    expect(returned!.id).toBe(emittedSession!.id);
    expect(returned!.status).toBe(emittedSession!.status);
    expect(returned!.taskId).toBe(emittedSession!.taskId);
    expect(returned!.projectId).toBe(emittedSession!.projectId);
  });

  it('a second call for the same task emits nothing, inserts nothing, and returns null', () => {
    // Recovery can run twice for a project in one process (an explicit open
    // during startup activation). Each pass used to add a placeholder, and the
    // spawn that eventually replaced them drained only one.
    const emittedIds: string[] = [];
    manager.on('session-changed', (sessionId: string) => {
      emittedIds.push(sessionId);
    });
    const input = { taskId: 'task-placeholder-6', projectId: 'project-placeholder-6', cwd: '/mock/cwd' };

    const first = manager.registerSuspendedPlaceholder(input);
    const second = manager.registerSuspendedPlaceholder(input);

    expect(second).toBeNull();
    expect(emittedIds).toEqual([first!.id]);
    const rowsForTask = manager.listSessions().filter((session) => session.taskId === 'task-placeholder-6');
    expect(rowsForTask.map((session) => session.id)).toEqual([first!.id]);
  });

  it('emits session-changed synchronously before registerSuspendedPlaceholder returns', () => {
    let emitFiredBeforeReturn = false;
    let returned: Session | null | undefined;

    manager.on('session-changed', () => {
      // At the moment of emit, returned is still undefined because
      // registerSuspendedPlaceholder has not returned yet.
      emitFiredBeforeReturn = returned === undefined;
    });

    returned = manager.registerSuspendedPlaceholder({
      taskId: 'task-placeholder-5',
      projectId: 'project-placeholder-5',
      cwd: '/mock/cwd',
    });

    expect(emitFiredBeforeReturn).toBe(true);
    // Returned must still be defined after the call completes.
    expect(returned).toBeDefined();
    expect(returned!.id).toBeTruthy();
  });

  it('clears the evicted exited row\'s per-session caches (buffer, telemetry, first-output tracker)', () => {
    // registerSuspendedPlaceholder replaces an exited row rather than leaving
    // it stranded (the DB record was just upgraded to suspended, so the task
    // must be resumable). The manager's eviction loop must also drop what the
    // auxiliary modules still hold for that dead id - otherwise stale
    // scrollback/usage/first-output state from the crashed session would
    // survive under an id nothing in the registry references anymore.
    const exitedSessionId = 'sess-exited-cache-test';
    const registryAccess = (manager as unknown as { registry: SessionRegistry }).registry;
    registryAccess.set(exitedSessionId, {
      id: exitedSessionId,
      taskId: 'task-exit-cache',
      projectId: 'project-exit-cache',
      pty: null,
      status: 'exited',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: 1,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);

    const privateManager = manager as unknown as {
      bufferManager: PtyBufferManager;
      telemetry: SessionTelemetry;
      firstOutputTracker: FirstOutputTracker;
    };
    const bufferRemoveSpy = vi.spyOn(privateManager.bufferManager, 'removeSession');
    const telemetryRemoveSpy = vi.spyOn(privateManager.telemetry, 'removeSession');
    const firstOutputRemoveSpy = vi.spyOn(privateManager.firstOutputTracker, 'removeSession');

    const placeholder = manager.registerSuspendedPlaceholder({
      taskId: 'task-exit-cache',
      projectId: 'project-exit-cache',
      cwd: '/mock/cwd',
    });

    expect(placeholder).not.toBeNull();
    expect(placeholder!.status).toBe('suspended');
    expect(bufferRemoveSpy).toHaveBeenCalledWith(exitedSessionId);
    expect(telemetryRemoveSpy).toHaveBeenCalledWith(exitedSessionId);
    expect(firstOutputRemoveSpy).toHaveBeenCalledWith(exitedSessionId);
  });
});
