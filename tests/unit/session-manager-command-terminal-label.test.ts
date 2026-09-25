/**
 * Unit tests for SessionManager.setCommandTerminalLabel.
 *
 * Main is a passive holder for the Command Terminal's auto-derived name: the
 * renderer computes it and has already applied it locally, and nothing in main
 * reads it back except `toSession`, which hands it to the next renderer that has
 * to rebuild the pairing map after a reload.
 *
 * The guards matter because the caller is a fire-and-forget IPC that no one
 * awaits: a bad sessionId, a task agent, or a second derivation must not corrupt
 * or overwrite a name the user already knows the terminal by.
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

function labelOf(manager: SessionManager, sessionId: string): string | null | undefined {
  return getRegistry(manager).get(sessionId)?.commandTerminalLabel;
}

describe('SessionManager.setCommandTerminalLabel', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  it('records the name on a transient session', () => {
    register(manager, { id: 'term-1' });
    manager.setCommandTerminalLabel('term-1', 'Fix the parser');
    expect(labelOf(manager, 'term-1')).toBe('Fix the parser');
  });

  it('keeps the first name, so a later derivation cannot rename a known terminal', () => {
    register(manager, { id: 'term-1' });
    manager.setCommandTerminalLabel('term-1', 'Fix the parser');
    manager.setCommandTerminalLabel('term-1', 'Something else entirely');
    expect(labelOf(manager, 'term-1')).toBe('Fix the parser');
  });

  it('trims, and ignores a blank name rather than storing one', () => {
    register(manager, { id: 'term-1' });
    manager.setCommandTerminalLabel('term-1', '   ');
    expect(labelOf(manager, 'term-1')).toBeUndefined();

    manager.setCommandTerminalLabel('term-1', '  Fix the parser  ');
    expect(labelOf(manager, 'term-1')).toBe('Fix the parser');
  });

  it('ignores a task agent, which has no Command Terminal name', () => {
    register(manager, { id: 'agent-1', transient: false });
    manager.setCommandTerminalLabel('agent-1', 'Fix the parser');
    expect(labelOf(manager, 'agent-1')).toBeUndefined();
  });

  it('ignores an unknown session instead of throwing', () => {
    // The caller is a fire-and-forget IPC, so a session that exited during the
    // round trip is routine rather than exceptional.
    expect(() => manager.setCommandTerminalLabel('gone', 'Fix the parser')).not.toThrow();
  });
});
