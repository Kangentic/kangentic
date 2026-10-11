/**
 * `SessionManager.endCommandTerminal` and the PTY-exit end: the one way a
 * Command Terminal leaves main, whoever ends it (the desktop's Stop, a phone's
 * stop, the agent-absence sweep under C2, or the terminal's own PTY exiting).
 *
 * The teardown order is the pty-teardown-grace one: kill, capture awaitExit
 * while the row still exists (it resolves at once for a row that is gone),
 * remove, and only after the captured exit delete the session directory. A
 * young session's kill waits out its exit-sequence grace, and deleting the
 * directory under a still-exiting Claude made its SessionEnd hook write into a
 * missing directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

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

vi.mock('../../src/main/activity-engine/session-telemetry', () => {
  class MockSessionTelemetry {
    removeSession(): void {}
    requestAgentAbsenceCheck(): void {}
  }
  return { SessionTelemetry: MockSessionTelemetry };
});

const shuttingDown = { value: false };
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => shuttingDown.value,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession } from '../../src/main/pty/session-registry';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

describe('SessionManager.endCommandTerminal', () => {
  let manager: SessionManager;
  let rmSpy: ReturnType<typeof vi.spyOn>;
  const projectRoot = path.join('mock-root', 'project');

  beforeEach(() => {
    shuttingDown.value = false;
    manager = new SessionManager();
    rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSpy.mockRestore();
  });

  function seed(overrides: Partial<ManagedSession> = {}): ManagedSession {
    const registry = (manager as unknown as { registry: { set(id: string, session: ManagedSession): void } }).registry;
    const session: ManagedSession = {
      id: 'term-1',
      taskId: 'made-up-uuid',
      projectId: 'project-1',
      pty: null,
      status: 'running',
      shell: 'pwsh',
      cwd: projectRoot,
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: true,
      commandTerminalSlot: 'slot-1',
      exitSequence: ['\x03'],
      ...overrides,
    };
    registry.set(session.id, session);
    return session;
  }

  it('kills, captures the exit, then removes, and deletes the directory only after the exit', async () => {
    seed();
    const timeline: string[] = [];
    const exit = createDeferred();
    const originalKill = manager.kill.bind(manager);
    vi.spyOn(manager, 'kill').mockImplementation((sessionId, options) => {
      timeline.push(`kill:${sessionId}`);
      originalKill(sessionId, options);
    });
    vi.spyOn(manager, 'awaitExit').mockImplementation((sessionId) => {
      timeline.push(`awaitExit:${sessionId}`);
      return exit.promise;
    });
    const originalRemove = manager.remove.bind(manager);
    vi.spyOn(manager, 'remove').mockImplementation((sessionId) => {
      timeline.push(`remove:${sessionId}`);
      originalRemove(sessionId);
    });

    expect(manager.endCommandTerminal('term-1')).toBe('ended');

    // remove() calls kill() itself on the way out; the order that matters is
    // the first three.
    expect(timeline.slice(0, 3)).toEqual(['kill:term-1', 'awaitExit:term-1', 'remove:term-1']);
    expect(manager.getSession('term-1')).toBeUndefined();
    await Promise.resolve();
    expect(rmSpy).not.toHaveBeenCalled();

    exit.resolve();
    await vi.waitFor(() => expect(rmSpy).toHaveBeenCalledTimes(1));
    expect(rmSpy).toHaveBeenCalledWith(path.join(projectRoot, '.kangentic', 'sessions', 'made-up-uuid'), { recursive: true, force: true });
  });

  it('announces the end as a removal, which closes the desktop window and ends a phone\'s feed', () => {
    seed();
    const removed: string[] = [];
    manager.on('session-removed', (id: string) => { removed.push(id); });

    manager.endCommandTerminal('term-1');

    expect(removed).toEqual(['term-1']);
  });

  it('refuses a task session and leaves it untouched', () => {
    seed({ id: 'task-session', transient: false });

    expect(manager.endCommandTerminal('task-session')).toBe('not-command-terminal');
    expect(manager.getSession('task-session')).toBeDefined();
  });

  it('reports an id with no live row as not found', () => {
    expect(manager.endCommandTerminal('ghost')).toBe('not-found');
  });

  it('passes `immediate` through to kill, for a caller that knows the agent is gone', () => {
    seed();
    const killSpy = vi.spyOn(manager, 'kill');

    manager.endCommandTerminal('term-1', { immediate: true });

    expect(killSpy).toHaveBeenNthCalledWith(1, 'term-1', { immediate: true });
  });
});

describe('a Command Terminal whose PTY exits on its own', () => {
  let manager: SessionManager;
  let rmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shuttingDown.value = false;
    manager = new SessionManager();
    rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSpy.mockRestore();
  });

  function seedRow(overrides: Partial<ManagedSession>): void {
    const registry = (manager as unknown as { registry: { set(id: string, session: ManagedSession): void } }).registry;
    registry.set(overrides.id ?? 'term-1', {
      id: 'term-1',
      taskId: 'made-up-uuid',
      projectId: 'project-1',
      pty: null,
      status: 'exited',
      shell: 'pwsh',
      cwd: path.join('mock-root', 'project'),
      startedAt: new Date().toISOString(),
      exitCode: 1,
      resuming: false,
      transient: true,
      exitSequence: ['\x03'],
      ...overrides,
    });
  }

  /** The spawn flow's hook, called after the exit has been announced. */
  function ptyExited(sessionId: string): void {
    (manager as unknown as { endCommandTerminalAfterPtyExit(id: string): void }).endCommandTerminalAfterPtyExit(sessionId);
  }

  it('ends: the row goes with a removal push and the directory is deleted', async () => {
    seedRow({});
    const removed: string[] = [];
    manager.on('session-removed', (id: string) => { removed.push(id); });

    ptyExited('term-1');

    expect(removed).toEqual(['term-1']);
    expect(manager.getSession('term-1')).toBeUndefined();
    await vi.waitFor(() => expect(rmSpy).toHaveBeenCalledTimes(1));
  });

  it('keeps a task session\'s exited row, which its resume and record still need', () => {
    seedRow({ id: 'task-session', transient: false });

    ptyExited('task-session');

    expect(manager.getSession('task-session')).toBeDefined();
  });

  it('does nothing during quit, so the bounded exit drain stays free of removals', () => {
    seedRow({});
    shuttingDown.value = true;

    ptyExited('term-1');

    expect(manager.getSession('term-1')).toBeDefined();
    expect(rmSpy).not.toHaveBeenCalled();
  });
});
