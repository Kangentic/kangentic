/**
 * `Session.hasUserInput`: SessionManager marks a session used when the pty host
 * reports a human's first key or text (`userInput`; a renderer's keystrokes go to
 * the host on its own port and never cross main), and announces it once on
 * 'session-changed'. An unused Command Terminal is replaced in place when an
 * earlier conversation is resumed from it. What counts as a human's key (not
 * xterm's own replies, not injected keystrokes) is decided in the host core and
 * pinned in pty-host-core.test.ts.
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

describe('SessionManager: a session is marked used when a human uses it', () => {
  let manager: SessionManager;
  let changes: Session[];

  /** The host's event, as `handleHostEvent` receives it. */
  const hostReports = (event: { type: 'userInput'; sessionId: string }) => {
    (manager as unknown as { handleHostEvent(event: unknown): void }).handleHostEvent(event);
  };

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

  it('marks it when the host reports a human typed, and announces that once', () => {
    hostReports({ type: 'userInput', sessionId: SESSION_ID });
    hostReports({ type: 'userInput', sessionId: SESSION_ID });
    expect(changes).toHaveLength(1);
    expect(changes[0].hasUserInput).toBe(true);
    expect(manager.getSession(SESSION_ID)?.hasUserInput).toBe(true);
  });

  it('leaves it unmarked until the host reports', () => {
    expect(changes).toEqual([]);
    expect(manager.getSession(SESSION_ID)?.hasUserInput).toBeUndefined();
  });

  it('ignores a report for a session it does not hold', () => {
    hostReports({ type: 'userInput', sessionId: 'gone' });
    expect(changes).toEqual([]);
  });

  it('marks it for pasted content delivered outside the write path', () => {
    manager.markUserInput(SESSION_ID);
    manager.markUserInput(SESSION_ID);
    expect(changes).toHaveLength(1);
    expect(changes[0].hasUserInput).toBe(true);
  });
});
