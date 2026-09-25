/**
 * Unit tests for SessionManager.remove()'s 'session-removed' emit.
 *
 * The first bug (kangentic.com #80): dragging a task out of To Do and back
 * within a few seconds left the renderer holding a `running` session row for
 * a task main had fully torn down. remove() deleted the registry row and
 * emitted nothing, and the only other channel (SESSION_EXIT) is deliberately
 * suppressed for an intentional exit (App.tsx), so nothing ever corrected a
 * row resurrected by a status push landing during the kill grace.
 *
 * The first fix emitted 'session-changed' with a forced `status: 'exited'`.
 * That made the second bug (#661): the renderer's only handler for a status
 * push is an UPSERT, so for a task moved to To Do, whose rows the renderer
 * evicts optimistically the moment the move starts, the removal announcement
 * re-inserted an exited row for a PTY, worktree, and session directory that
 * no longer existed. The card opened a black terminal instead of the edit
 * form, with the dead session's usage filling the context bar.
 *
 * remove() now announces the removal on its OWN event, 'session-removed'
 * (broadcast as SESSION_REMOVED), emitted immediately before the registry
 * row is deleted, and emits no 'session-changed' at all. The renderer drops
 * the row and every per-session map entry keyed on the id. The cases below
 * pin the emit's shape, ordering, and idempotence, and that the status
 * channel stays silent.
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

const TASK_ID = 'task-remove-emit';
const PROJECT_ID = 'project-remove-emit';

describe('SessionManager.remove emit', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  function seedRunningSession(id: string, taskId: string = TASK_ID): void {
    const registryAccess = (manager as unknown as { registry: SessionRegistry }).registry;
    registryAccess.set(id, {
      id,
      taskId,
      projectId: PROJECT_ID,
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

  it('emits session-removed exactly once when removing a live registry row', () => {
    seedRunningSession('sess-remove-1');
    const emittedEvents: Array<{ sessionId: string; session: Session }> = [];
    manager.on('session-removed', (sessionId: string, session: Session) => {
      emittedEvents.push({ sessionId, session });
    });

    manager.remove('sess-remove-1');

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].sessionId).toBe('sess-remove-1');
  });

  it('the emitted session carries the row\'s taskId and projectId, so a consumer can resolve the task', () => {
    seedRunningSession('sess-remove-2');
    const emittedSessions: Session[] = [];
    manager.on('session-removed', (_sessionId: string, session: Session) => {
      emittedSessions.push(session);
    });

    manager.remove('sess-remove-2');

    expect(emittedSessions).toHaveLength(1);
    const emitted = emittedSessions[0];
    expect(emitted.id).toBe('sess-remove-2');
    expect(emitted.taskId).toBe(TASK_ID);
    expect(emitted.projectId).toBe(PROJECT_ID);
  });

  it('emits session-removed before the registry row is deleted (synchronous ordering)', () => {
    seedRunningSession('sess-remove-3');
    let rowPresentDuringEmit = false;
    manager.on('session-removed', (sessionId: string) => {
      rowPresentDuringEmit = manager.getSession(sessionId) !== undefined;
    });

    manager.remove('sess-remove-3');

    expect(rowPresentDuringEmit).toBe(true);
    expect(manager.getSession('sess-remove-3')).toBeUndefined();
  });

  it('emits no session-changed: a removal is not a status change', () => {
    // The #661 regression guard. A status push can only upsert in the
    // renderer, so announcing a removal there re-seeds the row it reports
    // gone. Reverting remove() to the forced-'exited' status emit reds this.
    seedRunningSession('sess-remove-status');
    const statusEmits: string[] = [];
    manager.on('session-changed', (sessionId: string) => {
      statusEmits.push(sessionId);
    });

    manager.remove('sess-remove-status');

    expect(statusEmits).toEqual([]);
  });

  it('emits nothing for an id that is already gone', () => {
    const emittedIds: string[] = [];
    manager.on('session-removed', (sessionId: string) => {
      emittedIds.push(sessionId);
    });

    manager.remove('sess-never-existed');

    expect(emittedIds).toHaveLength(0);
  });

  it('a second remove() of the same id (removeByTaskId re-entry) emits only once', () => {
    seedRunningSession('sess-remove-4');
    const emittedIds: string[] = [];
    manager.on('session-removed', (sessionId: string) => {
      emittedIds.push(sessionId);
    });

    manager.remove('sess-remove-4');
    manager.remove('sess-remove-4');

    expect(emittedIds).toEqual(['sess-remove-4']);
  });

  it('removeByTaskId emits once per row the task held', () => {
    // A task transiently holds two rows while a respawn is queued behind its
    // suspended predecessor; the safety-net removeByTaskId in
    // cleanupTaskSession must announce each of them.
    seedRunningSession('sess-remove-5a');
    seedRunningSession('sess-remove-5b');
    const emittedIds: string[] = [];
    manager.on('session-removed', (sessionId: string) => {
      emittedIds.push(sessionId);
    });

    manager.removeByTaskId(TASK_ID);

    expect(emittedIds.sort()).toEqual(['sess-remove-5a', 'sess-remove-5b']);
    expect(manager.getSession('sess-remove-5a')).toBeUndefined();
    expect(manager.getSession('sess-remove-5b')).toBeUndefined();
  });
});
