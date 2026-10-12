/**
 * `SessionManager.endCommandTerminal` and the PTY-exit end: the one way a
 * Command Terminal leaves main, whoever ends it (the desktop's Stop, a phone's
 * stop, the agent-absence sweep under C2, or the terminal's own PTY exiting).
 *
 * The teardown order is the pty-teardown-grace one: kill, capture awaitExit
 * while the row still exists (it resolves at once for a row that is gone),
 * remove, and only after the captured exit delete the session directory. A
 * young session's kill waits out its exit-sequence grace, and a still-exiting
 * agent's SessionEnd hook writes into that directory, so `remove()` must not
 * delete it on the way (the last describe drives that with real files).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
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
    cancelAgentAbsenceCheck(): void {}
    // The members below are what a real spawn and the exit that follows reach
    // through the spawn flow (the describe that spawns through a real manager).
    initSession(): void {}
    emitSessionEnd(): void {}
    hasAgentSessionId(): boolean { return false; }
    hasPendingPRCommand(): boolean { return false; }
    clearPendingPRCommand(): void {}
    takePendingPushedBranch(): string | null { return null; }
  }
  return { SessionTelemetry: MockSessionTelemetry };
});

const shuttingDown = { value: false };
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => shuttingDown.value,
}));

import * as pty from 'node-pty';
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

describe('a session spawned through a real SessionManager whose PTY exits', () => {
  // The two describes above reach the end through a seeded row and a direct
  // call to `endCommandTerminalAfterPtyExit`, and session-spawn-flow.test.ts
  // injects its own `onPtyExited`. Nothing else pins that SessionManager hands
  // the spawn flow that hook at all. Without it a Command Terminal whose PTY
  // died stays as an exited row: its window never closes, its slot never
  // frees, and its session directory is never deleted.
  //
  // This drives the real wiring: manager.spawn -> the in-process pty host over
  // a mocked node-pty -> the PTY's own exit callback.
  //
  // Red-green: deleting the `onPtyExited:` line in
  // SessionManager.performTrackedSpawn turns the Command Terminal test red
  // (the exit lands, but no session-removed follows and the row stays).
  //
  // Tier: Unit - the host is the in-process core over a mocked node-pty.

  let manager: SessionManager;
  let rmSpy: ReturnType<typeof vi.spyOn>;
  let projectDirectory: string;

  beforeEach(() => {
    shuttingDown.value = false;
    projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-command-terminal-exit-'));
    manager = new SessionManager();
    rmSpy = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager.killAll();
    rmSpy.mockRestore();
    fs.rmSync(projectDirectory, { recursive: true, force: true });
  });

  /** A node-pty stand-in whose exit the test fires, as the shell ending would. */
  function createMockPty() {
    let exitHandler: ((exitEvent: { exitCode: number }) => void) | null = null;
    const mockPty = {
      pid: 12345,
      cols: 120,
      rows: 30,
      onData: vi.fn(),
      onExit: vi.fn((callback: (exitEvent: { exitCode: number }) => void) => {
        exitHandler = callback;
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    return {
      mockPty,
      triggerExit: (exitCode: number) => exitHandler!({ exitCode }),
    };
  }

  /**
   * Spawn a session through the manager and record the two pushes that matter
   * to a window or a phone, in the order they were emitted.
   */
  async function spawnAndRecord(options: { taskId: string; transient: boolean }) {
    const { mockPty, triggerExit } = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: options.taskId,
      command: '',
      cwd: projectDirectory,
      transient: options.transient,
      commandTerminalSlot: options.transient ? 'slot-1' : undefined,
    });
    const timeline: string[] = [];
    manager.on('exit', (sessionId: string) => { timeline.push(`exit:${sessionId}`); });
    manager.on('session-removed', (sessionId: string) => { timeline.push(`session-removed:${sessionId}`); });
    return { session, timeline, triggerExit };
  }

  it('ends a Command Terminal: removal follows the exit, the row goes, and its directory is deleted', async () => {
    const { session, timeline, triggerExit } = await spawnAndRecord({ taskId: 'made-up-uuid', transient: true });
    expect(manager.getSession(session.id)?.status).toBe('running');

    triggerExit(1);

    await vi.waitFor(() => expect(timeline).toContain(`exit:${session.id}`));
    // The exit is announced first, so every exit listener has read the row
    // before the removal takes it.
    expect(timeline).toEqual([`exit:${session.id}`, `session-removed:${session.id}`]);
    expect(manager.getSession(session.id)).toBeUndefined();
    await vi.waitFor(() => expect(rmSpy).toHaveBeenCalledWith(
      path.join(session.cwd, '.kangentic', 'sessions', 'made-up-uuid'),
      { recursive: true, force: true },
    ));
  });

  it('keeps a task session\'s exited row, which its resume and record still need', async () => {
    const { session, timeline, triggerExit } = await spawnAndRecord({ taskId: 'task-001', transient: false });

    triggerExit(1);

    // The exit is the anchor: only once it has landed is "nothing followed it"
    // a statement about the wiring rather than about timing.
    await vi.waitFor(() => expect(timeline).toContain(`exit:${session.id}`));
    expect(timeline).toEqual([`exit:${session.id}`]);
    expect(manager.getSession(session.id)?.status).toBe('exited');
    expect(rmSpy).not.toHaveBeenCalledWith(
      path.join(session.cwd, '.kangentic', 'sessions', 'task-001'),
      expect.anything(),
    );
  });
});

describe('a Command Terminal\'s session directory on a Stop', () => {
  // A Stop returns at once and the window closes, but the agent may still be
  // exiting: a young session's kill waits out its exit-sequence grace, and its
  // SessionEnd hook writes into the session directory. So the directory must
  // outlive the shell. `remove()` used to delete it synchronously through
  // SessionFileManager.detachAndDelete, which left the hook writing into a
  // missing directory and made the deferred delete a no-op.
  //
  // The seeded rows above never register session files, so `remove()` had
  // nothing to delete there; this drives a real spawn with a real directory
  // and no `fs.promises.rm` mock.
  //
  // Red-green: removing the `detachPreservingFiles` call in endCommandTerminal
  // turns the "still there after the Stop" assertion red.
  //
  // Tier: Unit - the in-process pty host over a mocked node-pty.

  let manager: SessionManager;
  let projectDirectory: string;

  beforeEach(() => {
    shuttingDown.value = false;
    projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-command-terminal-dir-'));
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.killAll();
    fs.rmSync(projectDirectory, { recursive: true, force: true });
  });

  it('keeps the directory until the shell exits, then deletes it', async () => {
    let exitHandler: ((exitEvent: { exitCode: number }) => void) | null = null;
    vi.mocked(pty.spawn).mockReturnValue({
      pid: 23456,
      cols: 120,
      rows: 30,
      onData: vi.fn(),
      onExit: vi.fn((callback: (exitEvent: { exitCode: number }) => void) => { exitHandler = callback; }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    } as unknown as pty.IPty);
    const sessionDirectory = path.join(projectDirectory, '.kangentic', 'sessions', 'made-up-uuid');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const session = await manager.spawn({
      taskId: 'made-up-uuid',
      command: '',
      cwd: projectDirectory,
      transient: true,
      commandTerminalSlot: 'slot-1',
      statusOutputPath: path.join(sessionDirectory, 'status.json'),
      eventsOutputPath: path.join(sessionDirectory, 'activity.json'),
    });
    const timeline: string[] = [];
    manager.on('exit', (sessionId: string) => { timeline.push(`exit:${sessionId}`); });

    expect(manager.endCommandTerminal(session.id)).toBe('ended');

    // The row is gone and the window may close, but the agent's last hook
    // write still has somewhere to land.
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(fs.existsSync(sessionDirectory)).toBe(true);

    exitHandler!({ exitCode: 0 });

    // The PTY's exit still reaches the awaitExit captured before the remove,
    // so the delete follows the exit rather than its 10 s safety timeout.
    await vi.waitFor(() => expect(timeline).toEqual([`exit:${session.id}`]));
    // A real rm on a loaded Windows runner can pass waitFor's 1 s default;
    // 3 s stays under the test's own 5 s timeout and far from the 10 s one.
    await vi.waitFor(() => expect(fs.existsSync(sessionDirectory)).toBe(false), { timeout: 3_000 });
  });
});
