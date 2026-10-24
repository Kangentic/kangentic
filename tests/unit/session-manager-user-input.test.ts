/**
 * `Session.hasUserInput`: SessionManager marks a session used the first time a
 * write carries a key or text, and announces it once on 'session-changed'. An
 * unused Command Terminal is replaced in place when an earlier conversation is
 * resumed from it, so xterm's own replies (which also arrive as 'user' writes)
 * and injected 'system' keystrokes must never mark it.
 *
 * Harness modelled on session-manager-remove-emit.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import type { Session } from '../../src/shared/types';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';

const SESSION_ID = 'command-terminal-1';

describe('SessionManager: a session is marked used on real input only', () => {
  let manager: SessionManager;
  let changes: Session[];

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    registry.set(SESSION_ID, {
      id: SESSION_ID,
      taskId: 'transient-task',
      projectId: 'project-1',
      pty: { pid: 1, write: vi.fn() },
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: true,
      exitSequence: ['\x03'],
    } as unknown as ManagedSession);
    changes = [];
    manager.on('session-changed', (_sessionId: string, session: Session) => changes.push(session));
  });

  it("never marks it for xterm's own replies or injected keystrokes", () => {
    manager.write(SESSION_ID, '\x1b[?1;2c', 'user'); // device attributes reply
    manager.write(SESSION_ID, '\x1b[24;80R', 'user'); // cursor position report
    manager.write(SESSION_ID, '\x1b[I', 'user'); // focus report
    manager.write(SESSION_ID, '\x1b[<0;10;5M', 'user'); // a click into the pane
    manager.write(SESSION_ID, '/model sonnet\r', 'system'); // a pill's injected command
    expect(changes).toEqual([]);
    expect(manager.getSession(SESSION_ID)?.hasUserInput).toBeUndefined();
  });

  it('marks it on the first typed key and announces that once', () => {
    manager.write(SESSION_ID, 'h', 'user');
    manager.write(SESSION_ID, 'i', 'user');
    expect(changes).toHaveLength(1);
    expect(changes[0].hasUserInput).toBe(true);
    expect(manager.getSession(SESSION_ID)?.hasUserInput).toBe(true);
  });

  it('marks it for pasted content delivered outside the write path', () => {
    manager.markUserInput(SESSION_ID);
    manager.markUserInput(SESSION_ID);
    expect(changes).toHaveLength(1);
    expect(changes[0].hasUserInput).toBe(true);
  });
});
