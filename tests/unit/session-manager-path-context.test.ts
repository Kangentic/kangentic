/**
 * SessionManager.getSessionPathContext: what the terminal link resolver reads
 * about a session. It must hand back the session's own shell, command working
 * folder, CLI target and project, and null for an id the registry does not hold.
 *
 * Harness modelled on session-manager-remove-emit.test.ts.
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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { StoredCliTarget } from '../../src/shared/types';

describe('SessionManager.getSessionPathContext', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  function seedSession(id: string, overrides: Partial<ManagedSession>): void {
    const registryAccess = (manager as unknown as { registry: SessionRegistry }).registry;
    registryAccess.set(id, {
      id,
      taskId: 'task-path-context',
      projectId: 'project-path-context',
      pty: null,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/cwd',
      commandCwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
      ...overrides,
    } as ManagedSession);
  }

  it('returns the shell, command folder, CLI target and project of the session', () => {
    const cliTarget: StoredCliTarget = { kind: 'wsl', distro: 'Ubuntu' };
    seedSession('session-wsl', {
      shell: 'wsl',
      commandCwd: '/home/dev/project',
      cliTarget,
      projectId: 'project-wsl',
    });

    expect(manager.getSessionPathContext('session-wsl')).toEqual({
      shell: 'wsl',
      commandCwd: '/home/dev/project',
      cliTarget,
      projectId: 'project-wsl',
    });
  });

  it('reports a null CLI target for a session that has none', () => {
    seedSession('session-local', { cliTarget: undefined });
    expect(manager.getSessionPathContext('session-local')?.cliTarget).toBeNull();
  });

  it('returns null for an unknown session', () => {
    expect(manager.getSessionPathContext('no-such-session')).toBeNull();
  });
});
