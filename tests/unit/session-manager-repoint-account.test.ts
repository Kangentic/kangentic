/**
 * SessionManager.repointAccount and getSessionHomeAccountId (task #1113).
 *
 * A /login inside a session replaces the login in that session's home, so the live sessions
 * spawned there now run as the new account (`accountId`), while `homeAccountId` stays the home they
 * started in. Only live rows (running, queued) follow; each change is announced on
 * 'session-changed' so the context bar draws the new account's limits.
 *
 * Modelled on session-manager-remove-emit.test.ts.
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

const HOME_A = 'account-home-a';
const HOME_B = 'account-home-b';
const TARGET = 'account-target';

describe('SessionManager.repointAccount', () => {
  let manager: SessionManager;
  let registry: SessionRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    registry = (manager as unknown as { registry: SessionRegistry }).registry;
  });

  function seed(
    id: string,
    status: string,
    homeAccountId: string | null,
    accountId: string | null = homeAccountId,
  ): void {
    registry.set(id, {
      id,
      taskId: `task-${id}`,
      projectId: 'project-repoint',
      pty: null,
      status,
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
      homeAccountId,
      accountId,
    } as unknown as ManagedSession);
  }

  function collectAnnouncements(): Array<{ sessionId: string; session: Session }> {
    const announced: Array<{ sessionId: string; session: Session }> = [];
    manager.on('session-changed', (sessionId: string, session: Session) => {
      announced.push({ sessionId, session });
    });
    return announced;
  }

  function accountOf(id: string): string | null | undefined {
    return (registry.get(id) as unknown as { accountId?: string | null }).accountId;
  }

  function homeOf(id: string): string | null | undefined {
    return (registry.get(id) as unknown as { homeAccountId?: string | null }).homeAccountId;
  }

  it('repoints running and queued rows on that home, announces each, and returns the count', () => {
    seed('running-1', 'running', HOME_A);
    seed('queued-1', 'queued', HOME_A);
    const announced = collectAnnouncements();

    const changed = manager.repointAccount(HOME_A, TARGET);

    expect(changed).toBe(2);
    expect(accountOf('running-1')).toBe(TARGET);
    expect(accountOf('queued-1')).toBe(TARGET);
    expect(announced.map((entry) => entry.sessionId).sort()).toEqual(['queued-1', 'running-1']);
    for (const entry of announced) {
      expect(entry.session.id).toBe(entry.sessionId);
      expect((entry.session as unknown as { accountId?: string | null }).accountId).toBe(TARGET);
    }
  });

  it('leaves exited and suspended rows on that home alone, and does not announce them', () => {
    seed('exited-1', 'exited', HOME_A);
    seed('suspended-1', 'suspended', HOME_A);
    const announced = collectAnnouncements();

    expect(manager.repointAccount(HOME_A, TARGET)).toBe(0);

    expect(accountOf('exited-1')).toBe(HOME_A);
    expect(accountOf('suspended-1')).toBe(HOME_A);
    expect(announced).toEqual([]);
  });

  it('leaves a row spawned in another home alone', () => {
    seed('other-home', 'running', HOME_B);
    seed('no-home', 'running', null);
    const announced = collectAnnouncements();

    expect(manager.repointAccount(HOME_A, TARGET)).toBe(0);

    expect(accountOf('other-home')).toBe(HOME_B);
    expect(accountOf('no-home')).toBeNull();
    expect(announced).toEqual([]);
  });

  it('skips and does not announce a row already on the target', () => {
    seed('already-there', 'running', HOME_A, TARGET);
    seed('follows', 'running', HOME_A);
    const announced = collectAnnouncements();

    expect(manager.repointAccount(HOME_A, TARGET)).toBe(1);

    expect(announced.map((entry) => entry.sessionId)).toEqual(['follows']);
  });

  it('never changes homeAccountId', () => {
    seed('running-2', 'running', HOME_A);

    manager.repointAccount(HOME_A, TARGET);

    expect(accountOf('running-2')).toBe(TARGET);
    expect(homeOf('running-2')).toBe(HOME_A);
    // A second repoint still finds the row by its home, not by its current account.
    expect(manager.repointAccount(HOME_A, 'account-third')).toBe(1);
    expect(homeOf('running-2')).toBe(HOME_A);
  });
});

describe('SessionManager.getSessionHomeAccountId', () => {
  it('returns the home a session was spawned in, and null for an unknown id or a row with no home', () => {
    const manager = new SessionManager();
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    const base = {
      taskId: 'task-home',
      projectId: 'project-repoint',
      pty: null,
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    };
    registry.set('with-home', { ...base, id: 'with-home', homeAccountId: HOME_A, accountId: TARGET } as unknown as ManagedSession);
    registry.set('without-home', { ...base, id: 'without-home' } as unknown as ManagedSession);

    expect(manager.getSessionHomeAccountId('with-home')).toBe(HOME_A);
    expect(manager.getSessionHomeAccountId('without-home')).toBeNull();
    expect(manager.getSessionHomeAccountId('never-existed')).toBeNull();
  });
});
