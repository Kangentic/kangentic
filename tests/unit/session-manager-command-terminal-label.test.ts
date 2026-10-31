/**
 * Unit tests for SessionManager.setCommandTerminalLabel.
 *
 * Main derives a Command Terminal's name (`CommandTerminalNamer`) and records it
 * here; an applied name is announced on 'session-changed', which is how the
 * renderer's window title, the Agent Monitor and a phone's board feed learn it.
 *
 * The guards matter because the namer is fire-and-forget: a session that ended
 * during the summarize, a task agent, or a second derivation must not corrupt
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
    // The namer is fire-and-forget, so a session that exited during the
    // summarize is routine rather than exceptional.
    expect(() => manager.setCommandTerminalLabel('gone', 'Fix the parser')).not.toThrow();
    expect(manager.setCommandTerminalLabel('gone', 'Fix the parser')).toBe(false);
  });

  it('announces an applied name once on session-changed, carrying it on the row', () => {
    register(manager, { id: 'term-1' });
    const announced: Array<{ id: string; label: string | null | undefined }> = [];
    manager.on('session-changed', (id: string, session: { commandTerminalLabel?: string | null }) => {
      announced.push({ id, label: session.commandTerminalLabel });
    });

    expect(manager.setCommandTerminalLabel('term-1', 'Fix the parser')).toBe(true);
    // First write wins, and a refused write announces nothing.
    expect(manager.setCommandTerminalLabel('term-1', 'Another name')).toBe(false);
    manager.setCommandTerminalLabel('term-1', '   ');

    expect(announced).toEqual([{ id: 'term-1', label: 'Fix the parser' }]);
  });

  it('refuses a terminal the user renamed, so a naming call in flight cannot override it', () => {
    register(manager, { id: 'term-1', commandTerminalSlot: 'slot-1' });
    manager.renameCommandTerminal('term-1', 'Auth refactor');
    expect(manager.setCommandTerminalLabel('term-1', 'Derived name')).toBe(false);
    expect(labelOf(manager, 'term-1')).toBe('Auth refactor');
  });

  it('refuses a terminal whose name the user cleared, so the namer stays off', () => {
    register(manager, { id: 'term-1', commandTerminalSlot: 'slot-1' });
    manager.renameCommandTerminal('term-1', '');
    expect(manager.setCommandTerminalLabel('term-1', 'Derived name')).toBe(false);
    expect(labelOf(manager, 'term-1')).toBeNull();
  });
});

describe('SessionManager.renameCommandTerminal', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  function namedByUser(sessionId: string): boolean | undefined {
    return getRegistry(manager).get(sessionId)?.commandTerminalNamedByUser;
  }

  it('replaces a derived name, unlike the first-write-wins setter', () => {
    register(manager, { id: 'term-1', commandTerminalSlot: 'slot-2' });
    manager.setCommandTerminalLabel('term-1', 'Derived name');
    expect(manager.renameCommandTerminal('term-1', 'Auth refactor')).toBe(true);
    expect(labelOf(manager, 'term-1')).toBe('Auth refactor');
    expect(namedByUser('term-1')).toBe(true);
    expect(manager.renameCommandTerminal('term-1', 'DB migration review')).toBe(true);
    expect(labelOf(manager, 'term-1')).toBe('DB migration review');
  });

  it('puts the name on one line, trimmed, and cuts it to 64 characters', () => {
    register(manager, { id: 'term-1', commandTerminalSlot: 'slot-2' });
    manager.renameCommandTerminal('term-1', '  Fix\n the   parser\t ');
    expect(labelOf(manager, 'term-1')).toBe('Fix the parser');
    manager.renameCommandTerminal('term-1', 'x'.repeat(80));
    expect(labelOf(manager, 'term-1')).toBe('x'.repeat(64));
  });

  it('clears the name for an empty entry, null, or the slot\'s own title', () => {
    register(manager, { id: 'term-1', commandTerminalSlot: 'slot-2' });
    manager.renameCommandTerminal('term-1', 'Auth refactor');
    expect(manager.renameCommandTerminal('term-1', '   ')).toBe(true);
    expect(labelOf(manager, 'term-1')).toBeNull();
    expect(namedByUser('term-1')).toBe(true);

    manager.renameCommandTerminal('term-1', 'Auth refactor');
    manager.renameCommandTerminal('term-1', null);
    expect(labelOf(manager, 'term-1')).toBeNull();

    manager.renameCommandTerminal('term-1', 'Auth refactor');
    manager.renameCommandTerminal('term-1', 'Command Terminal 2');
    expect(labelOf(manager, 'term-1')).toBeNull();
  });

  it('announces once per change and nothing for a rename that changes nothing', () => {
    register(manager, { id: 'term-1', commandTerminalSlot: 'slot-1' });
    const announced: Array<{ label: string | null | undefined; namedByUser: boolean | undefined }> = [];
    manager.on('session-changed', (_id: string, session: { commandTerminalLabel?: string | null; commandTerminalNamedByUser?: boolean }) => {
      announced.push({ label: session.commandTerminalLabel, namedByUser: session.commandTerminalNamedByUser });
    });

    expect(manager.renameCommandTerminal('term-1', 'Auth refactor')).toBe(true);
    expect(manager.renameCommandTerminal('term-1', '  Auth refactor ')).toBe(false);

    expect(announced).toEqual([{ label: 'Auth refactor', namedByUser: true }]);
  });

  it('marks an unnamed terminal named by the user even when the name stays the fallback', () => {
    // Clearing a terminal that never had a name changes no text, but it is
    // still the user's choice, and the namer must stand down after it.
    register(manager, { id: 'term-1', commandTerminalSlot: 'slot-1' });
    expect(manager.renameCommandTerminal('term-1', '')).toBe(false);
    expect(namedByUser('term-1')).toBe(true);
  });

  it('refuses a task agent, a workflow agent and an unknown session', () => {
    register(manager, { id: 'agent-1', transient: false });
    register(manager, { id: 'workflow-1', workflowId: 'workflow-a' });
    expect(manager.renameCommandTerminal('agent-1', 'Name')).toBe(false);
    expect(manager.renameCommandTerminal('workflow-1', 'Name')).toBe(false);
    expect(manager.renameCommandTerminal('gone', 'Name')).toBe(false);
    expect(labelOf(manager, 'agent-1')).toBeUndefined();
    expect(labelOf(manager, 'workflow-1')).toBeUndefined();
  });
});
