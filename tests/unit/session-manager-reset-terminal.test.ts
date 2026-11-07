/**
 * SessionManager.resetTerminal through a real manager and the mock PTY: the
 * repaint is two spaced resize legs and never a write, because a reset must not
 * type into the agent, and whether an agent owns the modes decides how much of
 * the stream clears. Same mock prelude as session-manager-deferred-kill.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

import * as pty from 'node-pty';
import { SessionManager, TERMINAL_REPAINT_LEG_GAP_MS } from '../../src/main/pty/session-manager';
import type { PtyHostCommand } from '../../src/main/pty/host/protocol';
import type { AgentParser } from '../../src/shared/types';

const EXIT_SEQUENCE = ['\x03', '/exit\r'];
const STUCK = '\x1b[?1049h\x1b[?1000h\x1b[?2004h';

let tmpDir: string;

function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((exitEvent: { exitCode: number }) => void) | null = null;
  const mockPty = {
    pid: 12345,
    cols: 120,
    rows: 30,
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback;
    }),
    onExit: vi.fn((callback: (exitEvent: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      mockPty.cols = cols;
      mockPty.rows = rows;
    }),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };
  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

const AGENT_PARSER = { detectFirstOutput: () => false, removeHooks: () => {}, runtime: {} } as unknown as AgentParser;

async function spawnSession(manager: SessionManager, taskId: string, agentParser?: AgentParser) {
  const mock = createMockPty();
  vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
  const session = await manager.spawn({ taskId, command: '', cwd: tmpDir, exitSequence: EXIT_SEQUENCE, agentParser });
  return { session, ...mock };
}

/** A running agent that has drawn its fullscreen frame, so main's mirror reads alt. */
async function spawnFullscreenAgent(manager: SessionManager, taskId: string) {
  const spawned = await spawnSession(manager, taskId, AGENT_PARSER);
  spawned.feedData('\x1b[?1049h');
  await vi.advanceTimersByTimeAsync(50);
  return spawned;
}

function postsOf(manager: SessionManager) {
  const host = (manager as unknown as { host: { post(command: PtyHostCommand): void } }).host;
  return vi.spyOn(host, 'post');
}

/** The parser's frame, once its write has run under the fake clock. */
async function serializedFrame(manager: SessionManager, sessionId: string): Promise<string> {
  const frame = manager.getSerializedFrame(sessionId);
  await vi.advanceTimersByTimeAsync(50);
  return frame;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-reset-terminal-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resetTerminal repaint', () => {
  it('resizes rows down and back a gap apart, and writes nothing to the PTY', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-repaint');
    const resizesBefore = mockPty.resize.mock.calls.length;
    const writesBefore = mockPty.write.mock.calls.length;

    manager.resetTerminal(session.id);
    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([[120, 29]]);

    // Two legs the child reads as one are no change, so it would not repaint.
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS - 1);
    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([[120, 29], [120, 30]]);
    expect(mockPty.write.mock.calls.slice(writesBefore)).toEqual([]);

    manager.killAll();
  });

  it('marks each leg resized, so the repaint does not read as the agent working', async () => {
    const manager = new SessionManager();
    const { session } = await spawnFullscreenAgent(manager, 'task-mark');
    const post = postsOf(manager);

    manager.resetTerminal(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    const marks = post.mock.calls.filter(([command]) => command.type === 'markResized');
    expect(marks).toHaveLength(2);
    manager.killAll();
  });

  it('starts no second jiggle on a press inside the gap, and still clears', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-double');
    const resizesBefore = mockPty.resize.mock.calls.length;
    const post = postsOf(manager);

    manager.resetTerminal(session.id);
    manager.resetTerminal(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([[120, 29], [120, 30]]);
    expect(post.mock.calls.filter(([command]) => command.type === 'resetTerminalModes')).toHaveLength(2);
    manager.killAll();
  });

  it('leaves a real resize in the gap alone', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-resized');

    manager.resetTerminal(session.id);
    manager.resize(session.id, 100, 29);
    const resizesAfterRealResize = mockPty.resize.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.length).toBe(resizesAfterRealResize);
    expect(mockPty.rows).toBe(29);
    expect(mockPty.cols).toBe(100);
    manager.killAll();
  });

  it('does not touch a PTY killed in the gap', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-killed');

    manager.resetTerminal(session.id);
    const resizesBeforeKill = mockPty.resize.mock.calls.length;
    manager.kill(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.length).toBe(resizesBeforeKill);
    manager.killAll();
  });

  it('leaves the grid alone in the normal buffer, where a short leg costs a line of history', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnSession(manager, 'task-normal-buffer', AGENT_PARSER);
    const resizesBefore = mockPty.resize.mock.calls.length;
    const post = postsOf(manager);

    manager.resetTerminal(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([]);
    expect(post.mock.calls.filter(([command]) => command.type === 'resetTerminalModes')).toHaveLength(1);
    manager.killAll();
  });

  it('repaints a bare shell leaving a stuck alt screen, so ConPTY redraws what its next output addresses', async () => {
    const manager = new SessionManager();
    const { session, mockPty, feedData } = await spawnSession(manager, 'task-stuck-alt');
    feedData('\x1b[?1049h');
    await vi.advanceTimersByTimeAsync(50);
    const resizesBefore = mockPty.resize.mock.calls.length;

    manager.resetTerminal(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([[120, 29], [120, 30]]);
    manager.killAll();
  });

  it('does nothing for a session it does not know', () => {
    const manager = new SessionManager();
    expect(() => manager.resetTerminal('no-such-session')).not.toThrow();
  });
});

interface RegistryRow {
  status: string;
  /** Main's handle: its rows are its own copy, and its resize is what the manager calls. */
  pty: { resize(cols: number, rows: number): void };
}

/** The registry row, to put a live session into a status a test cannot reach by waiting. */
function registryRowOf(manager: SessionManager, sessionId: string): RegistryRow {
  const registry = (manager as unknown as { registry: { get(id: string): RegistryRow | undefined } }).registry;
  const row = registry.get(sessionId);
  if (!row) throw new Error(`no registry row for ${sessionId}`);
  return row;
}

function pendingRestoreCount(manager: SessionManager): number {
  return (manager as unknown as { terminalRepaintRestores: Map<string, unknown> }).terminalRepaintRestores.size;
}

describe('resetTerminal repaint, edge cases', () => {
  it('does not repaint a suspended session still holding its PTY, and keeps the agent input modes', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-suspending');
    registryRowOf(manager, session.id).status = 'suspended';
    const resizesBefore = mockPty.resize.mock.calls.length;
    const post = postsOf(manager);

    manager.resetTerminal(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.length).toBe(resizesBefore);
    expect(post.mock.calls.filter(([command]) => command.type === 'markResized')).toEqual([]);
    expect(post.mock.calls.filter(([command]) => command.type === 'resetTerminalModes'))
      .toEqual([[{ type: 'resetTerminalModes', sessionId: session.id, keepInputModes: true }]]);
    registryRowOf(manager, session.id).status = 'running';
    manager.killAll();
  });

  it('does not run the restore leg for a session suspended in the gap', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-suspended-in-gap');
    const resizesBefore = mockPty.resize.mock.calls.length;

    manager.resetTerminal(session.id);
    registryRowOf(manager, session.id).status = 'suspended';
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([[120, 29]]);
    registryRowOf(manager, session.id).status = 'running';
    manager.killAll();
  });

  it('still restores the rows after a desktop resize below the floor was refused in the gap', async () => {
    const manager = new SessionManager();
    manager.setMobileTerminalProbe({ isSizeHeld: () => false, hasStreamSubscriber: () => true });
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-refused');
    const resizesBefore = mockPty.resize.mock.calls.length;

    manager.resetTerminal(session.id);
    const result = manager.resize(session.id, 120, 10);
    expect(result.refused).toBe(true);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([[120, 29], [120, 30]]);
    expect(mockPty.rows).toBe(30);
    manager.killAll();
  });

  it('ends at the grid a same-grid real resize named, with no later resize', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-same-grid');

    manager.resetTerminal(session.id);
    manager.resize(session.id, 120, 30);
    const resizesAfterRealResize = mockPty.resize.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.length).toBe(resizesAfterRealResize);
    expect({ cols: mockPty.cols, rows: mockPty.rows }).toEqual({ cols: 120, rows: 30 });
    manager.killAll();
  });

  it('does not resize or mark a session already at the row floor', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-floor');
    registryRowOf(manager, session.id).pty.resize(120, 2);
    const post = postsOf(manager);
    const resizesBefore = mockPty.resize.mock.calls.length;

    manager.resetTerminal(session.id);
    // Nothing from the reset itself; anything else resizing in the gap is not its.
    expect(mockPty.resize.mock.calls.length).toBe(resizesBefore);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([]);
    expect(post.mock.calls.filter(([command]) => command.type === 'markResized')).toEqual([]);
    manager.killAll();
  });

  it('survives a throwing short leg, leaves no timer, and jiggles again on the next press', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-jiggle-throws');
    const resizesBefore = mockPty.resize.mock.calls.length;
    vi.spyOn(registryRowOf(manager, session.id).pty, 'resize').mockImplementationOnce(() => { throw new Error('conpty gone'); });

    expect(() => manager.resetTerminal(session.id)).not.toThrow();
    // No restore entry or timer: a leaked one would block the next press.
    expect(pendingRestoreCount(manager)).toBe(0);

    manager.resetTerminal(session.id);
    expect(mockPty.resize.mock.calls.slice(resizesBefore)).toEqual([[120, 29]]);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);
    expect(mockPty.rows).toBe(30);
    manager.killAll();
  });

  it('survives a throwing restore leg', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-restore-throws');

    manager.resetTerminal(session.id);
    vi.spyOn(registryRowOf(manager, session.id).pty, 'resize').mockImplementationOnce(() => { throw new Error('conpty gone'); });

    await expect(vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS)).resolves.not.toThrow();
    expect(pendingRestoreCount(manager)).toBe(0);
    manager.killAll();
  });

  it('clears its own entry, so a press after the gap gives a second short and restore pair', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-second-pair');
    const resizesBefore = mockPty.resize.mock.calls.length;

    manager.resetTerminal(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);
    manager.resetTerminal(session.id);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);

    expect(mockPty.resize.mock.calls.slice(resizesBefore))
      .toEqual([[120, 29], [120, 30], [120, 29], [120, 30]]);
    manager.killAll();
  });

  it('reports the rows the restore puts back during the gap, not the short leg', async () => {
    const manager = new SessionManager();
    const { session, mockPty } = await spawnFullscreenAgent(manager, 'task-dimensions');

    manager.resetTerminal(session.id);
    expect(mockPty.rows).toBe(29);
    expect(manager.getDimensions(session.id)).toEqual({ cols: 120, rows: 30 });

    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);
    expect(manager.getDimensions(session.id)).toEqual({ cols: 120, rows: 30 });
    manager.killAll();
  });

  it('cancels the pending restore when the session is killed', async () => {
    const manager = new SessionManager();
    const { session } = await spawnFullscreenAgent(manager, 'task-kill-cancels');

    manager.resetTerminal(session.id);
    expect(pendingRestoreCount(manager)).toBe(1);
    manager.kill(session.id);

    expect(pendingRestoreCount(manager)).toBe(0);
    await vi.advanceTimersByTimeAsync(TERMINAL_REPAINT_LEG_GAP_MS);
    manager.killAll();
  });

  it('cancels the pending restore on dispose', async () => {
    const manager = new SessionManager();
    const { session } = await spawnFullscreenAgent(manager, 'task-dispose-cancels');

    manager.resetTerminal(session.id);
    expect(pendingRestoreCount(manager)).toBe(1);
    const timersWithRestore = vi.getTimerCount();
    manager.dispose();

    expect(pendingRestoreCount(manager)).toBe(0);
    expect(vi.getTimerCount()).toBeLessThan(timersWithRestore);
    manager.killAll();
  });
});

describe('resetTerminal scope', () => {
  it('keeps the alt screen and input modes under a running agent', async () => {
    const manager = new SessionManager();
    const { session, feedData } = await spawnSession(manager, 'task-agent', AGENT_PARSER);
    feedData(STUCK);

    manager.resetTerminal(session.id);

    const frame = await serializedFrame(manager, session.id);
    expect(frame).toContain('\x1b[?1049h');
    expect(frame).toContain('\x1b[?2004h');
    manager.killAll();
  });

  it('clears everything in a bare shell, where nothing owns the modes', async () => {
    const manager = new SessionManager();
    const { session, feedData } = await spawnSession(manager, 'task-shell');
    feedData(STUCK);

    manager.resetTerminal(session.id);

    const frame = await serializedFrame(manager, session.id);
    expect(frame).not.toContain('\x1b[?1049h');
    expect(frame).not.toContain('\x1b[?2004h');
    manager.killAll();
  });

  it('clears everything once the agent has exited, with no PTY to resize', async () => {
    const manager = new SessionManager();
    const { session, feedData, triggerExit, mockPty } = await spawnSession(manager, 'task-exited', AGENT_PARSER);
    feedData(STUCK);
    triggerExit();
    await vi.advanceTimersByTimeAsync(0);
    const resizesAfterExit = mockPty.resize.mock.calls.length;

    manager.resetTerminal(session.id);

    const frame = await serializedFrame(manager, session.id);
    expect(frame).not.toContain('\x1b[?1049h');
    expect(frame).not.toContain('\x1b[?2004h');
    expect(mockPty.resize.mock.calls.length).toBe(resizesAfterExit);
    manager.killAll();
  });
});
