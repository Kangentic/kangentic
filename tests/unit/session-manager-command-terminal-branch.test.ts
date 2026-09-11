/**
 * Unit tests for SessionManager.setCommandTerminalBranch.
 *
 * Main is a passive holder for the branch a Command Terminal's checkout is on:
 * the renderer re-derives it from live HEAD and has already applied it locally;
 * main keeps it so the Monitor row and a post-reload adopt name the same branch.
 *
 * The one deliberate difference from the label: LAST write wins. HEAD moves,
 * and the newest reading is the true one, so the label's first-write guard
 * would pin the row to whatever branch the terminal happened to spawn on.
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
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';

/** Reach the private registry the same way the sibling suites reach telemetry. */
function getRegistry(manager: SessionManager): SessionRegistry {
  return (manager as unknown as { registry: SessionRegistry }).registry;
}

function register(manager: SessionManager, overrides: Partial<ManagedSession> & { id: string }): void {
  getRegistry(manager).set(overrides.id, {
    taskId: 'task-1',
    projectId: 'project-1',
    pty: null,
    status: 'running',
    shell: '/bin/bash',
    cwd: '/mock/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: true,
    exitSequence: ['\x03'],
    ...overrides,
  });
}

function branchOf(manager: SessionManager, sessionId: string): string | null | undefined {
  return getRegistry(manager).get(sessionId)?.commandTerminalBranch;
}

describe('SessionManager.setCommandTerminalBranch', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  it('records the branch on a transient session', () => {
    register(manager, { id: 'term-1' });
    manager.setCommandTerminalBranch('term-1', 'feature/auth');
    expect(branchOf(manager, 'term-1')).toBe('feature/auth');
  });

  it('replaces the spawn-time branch: the newest reading of HEAD wins', () => {
    register(manager, { id: 'term-1', commandTerminalBranch: 'main' });
    manager.setCommandTerminalBranch('term-1', 'feature/auth');
    manager.setCommandTerminalBranch('term-1', 'develop');
    expect(branchOf(manager, 'term-1')).toBe('develop');
  });

  it('trims, and ignores a blank value rather than storing one', () => {
    register(manager, { id: 'term-1', commandTerminalBranch: 'main' });
    manager.setCommandTerminalBranch('term-1', '   ');
    expect(branchOf(manager, 'term-1')).toBe('main');

    manager.setCommandTerminalBranch('term-1', '  feature/auth  ');
    expect(branchOf(manager, 'term-1')).toBe('feature/auth');
  });

  it('ignores a task agent, which has no Command Terminal branch', () => {
    register(manager, { id: 'agent-1', transient: false });
    manager.setCommandTerminalBranch('agent-1', 'feature/auth');
    expect(branchOf(manager, 'agent-1')).toBeUndefined();
  });

  it('ignores an unknown session instead of throwing', () => {
    expect(() => manager.setCommandTerminalBranch('gone', 'feature/auth')).not.toThrow();
  });
});
