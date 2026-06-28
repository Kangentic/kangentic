/**
 * Comprehensive SessionManager unit tests covering scrollback, spawn failure,
 * shell arguments, environment filtering, data buffering, write/resize guards,
 * remove, suspendAll, killAll, query methods, and synthetic session_end.
 *
 * Follows the same mock/setup patterns as session-suspend.test.ts and
 * event-activity-derivation.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock node-pty before importing SessionManager
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (cmd: string) => cmd,
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

const claudeAdapter = new ClaudeAdapter();
import { EventType } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

let tmpDir: string;

/** Create a mock PTY with controllable onData/onExit callbacks. */
function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    // node-pty's IPty exposes the live cols/rows; track them so resize() reads
    // back the current size (the statusline kick nudges relative to it).
    cols: 120,
    rows: 30,
    onData: vi.fn((cb: (data: string) => void) => {
      dataHandler = cb;
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
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

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-session-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Scrollback
// ---------------------------------------------------------------------------

describe('Scrollback', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-scroll',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;
    return { session, ...mock };
  }

  it('truncates scrollback at 512KB limit', async () => {
    const { session, feedData } = await spawnSession();

    // Feed 600KB in one call
    const chunk = 'x'.repeat(600 * 1024);
    feedData(chunk);

    const scrollback = manager.getScrollback(session.id);
    // getScrollback() prepends \x1b[0m (4 bytes) and findSafeStartIndex
    // may trim up to 32 bytes at the truncation boundary
    expect(scrollback.startsWith('\x1b[0m')).toBe(true);
    expect(scrollback.length).toBeLessThanOrEqual(512 * 1024 + 4);
    expect(scrollback.length).toBeGreaterThan(512 * 1024 - 32);
  });

  it('preserves scrollback under the limit', async () => {
    const { session, feedData } = await spawnSession();

    const chunk = 'y'.repeat(100 * 1024);
    feedData(chunk);

    const scrollback = manager.getScrollback(session.id);
    // No truncation, so only the 4-byte SGR reset prefix is added
    expect(scrollback.startsWith('\x1b[0m')).toBe(true);
    expect(scrollback.length).toBe(100 * 1024 + 4);
  });

  it('accumulates scrollback across multiple onData calls', async () => {
    const { session, feedData } = await spawnSession();

    // 3 x 200KB = 600KB total -> should truncate to ~512KB
    const chunk = 'z'.repeat(200 * 1024);
    feedData(chunk);
    feedData(chunk);
    feedData(chunk);

    const scrollback = manager.getScrollback(session.id);
    expect(scrollback.startsWith('\x1b[0m')).toBe(true);
    expect(scrollback.length).toBeLessThanOrEqual(512 * 1024 + 4);
    expect(scrollback.length).toBeGreaterThan(512 * 1024 - 32);
  });
});

// ---------------------------------------------------------------------------
// 2. Scrollback clearing on resize (width change)
// ---------------------------------------------------------------------------

describe('Scrollback clearing on resize', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;
  // Note: the buffer manager's first resize after initSession is the "initial"
  // resize that establishes real terminal dimensions without clearing scrollback.
  // spawnSession() calls resize(120, 30) to simulate that initial resize, so
  // subsequent test resizes trigger the mid-session clearing behavior.

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-resize-scroll',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;
    // Simulate the initial resize that the renderer sends on first connect.
    // This establishes real terminal dimensions (120 cols matches PTY spawn).
    manager.resize(session.id, 120, 30);
    return { session, ...mock };
  }

  it('preserves scrollback when cols stay the same', async () => {
    const { session, feedData } = await spawnSession();

    feedData('hello world');

    // Resize with same cols as initial (120) but different rows
    const result = manager.resize(session.id, 120, 50);
    expect(result).toEqual({ colsChanged: false });

    const scrollback = manager.getScrollback(session.id);
    expect(scrollback).toContain('hello world');
  });

  it('preserves scrollback when cols change (no write-time clearing)', async () => {
    const { session, feedData } = await spawnSession();

    feedData('hello world');

    // Resize to different cols
    const result = manager.resize(session.id, 80, 24);
    expect(result).toEqual({ colsChanged: true });

    const scrollback = manager.getScrollback(session.id);
    // Scrollback is preserved on resize (KISS read-time strip approach)
    expect(scrollback).toContain('hello world');
  });

  it('tracks lastCols correctly across multiple resizes', async () => {
    const { session, feedData } = await spawnSession();

    // Resize to 80 cols
    manager.resize(session.id, 80, 24);

    // Feed new data at 80 cols
    feedData('data at 80 cols');

    // Resize to same 80 cols (should preserve)
    manager.resize(session.id, 80, 30);
    expect(manager.getScrollback(session.id)).toContain('data at 80 cols');

    // Resize to different cols - scrollback preserved (no write-time clearing)
    manager.resize(session.id, 100, 30);
    expect(manager.getScrollback(session.id)).toContain('data at 80 cols');
  });

  it('clamps cols to minimum of 2', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, 0, 24);

    // Should have been clamped to 2
    expect(mockPty.resize).toHaveBeenCalledWith(2, 24);
  });

  it('clamps rows to minimum of 1', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, 80, 0);

    expect(mockPty.resize).toHaveBeenCalledWith(80, 1);
  });

  it('clamps negative values', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, -10, -5);

    expect(mockPty.resize).toHaveBeenCalledWith(2, 1);
  });

  it('floors fractional values', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, 80.7, 24.9);

    expect(mockPty.resize).toHaveBeenCalledWith(80, 24);
  });

  it('accumulates scrollback across col changes', async () => {
    const { session, feedData } = await spawnSession();

    feedData('old data');

    // Change cols - scrollback preserved
    manager.resize(session.id, 80, 24);
    expect(manager.getScrollback(session.id)).toContain('old data');

    // New data arrives at new width
    feedData('new data');
    expect(manager.getScrollback(session.id)).toContain('new data');
    expect(manager.getScrollback(session.id)).toContain('old data');
  });
});

// ---------------------------------------------------------------------------
// 3. Remove
// ---------------------------------------------------------------------------

describe('Remove', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  async function spawnSession(taskId = 'task-remove') {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
    });
    return { session, ...mock };
  }

  it('fully removes session from all internal maps', async () => {
    const { session, feedData } = await spawnSession();

    // Populate scrollback
    feedData('hello');

    manager.remove(session.id);

    expect(manager.getSession(session.id)).toBeUndefined();
    expect(manager.getScrollback(session.id)).toBe('');
    expect(manager.getEventsForSession(session.id)).toEqual([]);
    expect(manager.getUsageCache()[session.id]).toBeUndefined();
    expect(manager.getActivityCache()[session.id]).toBeUndefined();
  });

  it('remove on non-existent session does not throw', () => {
    expect(() => manager.remove('nonexistent-id')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. SuspendAll
// ---------------------------------------------------------------------------

describe('SuspendAll', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  async function spawnSession(taskId: string) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
    });
    return { session, ...mock };
  }

  it('sends exit sequence to all running sessions', async () => {
    const { mockPty: pty1 } = await spawnSession('task-sa-1');
    const { mockPty: pty2 } = await spawnSession('task-sa-2');

    await manager.suspendAll(0);

    // Default exit sequence is ['\x03'] (Ctrl+C only) when no exitSequence is provided
    expect(pty1.write).toHaveBeenCalledWith('\x03');
    expect(pty2.write).toHaveBeenCalledWith('\x03');
  });

  it('returns task IDs of all sessions', async () => {
    await spawnSession('task-sa-a');
    await spawnSession('task-sa-b');

    const taskIds = await manager.suspendAll(0);

    expect(taskIds).toContain('task-sa-a');
    expect(taskIds).toContain('task-sa-b');
  });

  it('marks running sessions as exited', async () => {
    const { session } = await spawnSession('task-sa-exit');

    await manager.suspendAll(0);

    const result = manager.getSession(session.id);
    expect(result?.status).toBe('exited');
  });

  it('includes queued sessions in returned task IDs', async () => {
    manager.setMaxConcurrent(1);

    await spawnSession('task-sa-running');

    // Second session should be queued
    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({
      taskId: 'task-sa-queued',
      command: '',
      cwd: tmpDir,
    });
    expect(queued.status).toBe('queued');

    const taskIds = await manager.suspendAll(0);

    expect(taskIds).toContain('task-sa-running');
    expect(taskIds).toContain('task-sa-queued');
  });

  it('clears session queue', async () => {
    manager.setMaxConcurrent(1);
    await spawnSession('task-sa-q1');

    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-sa-q2', command: '', cwd: tmpDir });

    expect(manager.queuedCount).toBe(1);

    await manager.suspendAll(0);

    expect(manager.queuedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. KillAll
// ---------------------------------------------------------------------------

describe('KillAll', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  async function spawnSession(taskId: string) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
    });
    return { session, ...mock };
  }

  it('removes all sessions from the manager', async () => {
    const { session: session1 } = await spawnSession('task-ka-1');
    const { session: session2 } = await spawnSession('task-ka-2');

    manager.killAll();

    expect(manager.getSession(session1.id)).toBeUndefined();
    expect(manager.getSession(session2.id)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('kills all PTY processes', async () => {
    const { mockPty: pty1 } = await spawnSession('task-ka-k1');
    const { mockPty: pty2 } = await spawnSession('task-ka-k2');

    manager.killAll();

    expect(pty1.kill).toHaveBeenCalled();
    expect(pty2.kill).toHaveBeenCalled();
  });

  it('clears session queue', async () => {
    manager.setMaxConcurrent(1);
    await spawnSession('task-ka-q1');

    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-ka-q2', command: '', cwd: tmpDir });

    expect(manager.queuedCount).toBe(1);

    manager.killAll();

    expect(manager.queuedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5b. kill() tags exits intentional (self-maintaining false-crash suppression)
// ---------------------------------------------------------------------------

describe('kill() marks deliberate teardown intentional', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-kill', command: '', cwd: tmpDir });
    return { session, ...mock };
  }

  // Every kill() is a deliberate teardown, never a crash. The force-kill exits
  // non-zero, so without the intentional tag the renderer fires a false
  // "Session crashed" notification. kill() must mark the session so onExit tags
  // the 'exit' event intentional - and it must do so unconditionally, so no
  // current or future caller (SESSION_RESET, executeCleanupWorktree, MCP
  // onTaskDeleted, ...) can forget and reintroduce the false crash.
  it('emits the exit event with intentional=true after kill()', async () => {
    const { session } = await spawnSession();
    const exitEvents: unknown[][] = [];
    manager.on('exit', (...args: unknown[]) => exitEvents.push(args));

    manager.kill(session.id);
    // The mock PTY's kill() schedules its onExit callback on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const exitCall = exitEvents.find((call) => call[0] === session.id);
    expect(exitCall).toBeDefined();
    // Positional args: (sessionId, exitCode, intentional).
    expect(exitCall![2]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. PTY Spawn Failure
// ---------------------------------------------------------------------------

describe('PTY spawn failure', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('returns dead session with exitCode -1 when PTY spawn throws', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const session = await manager.spawn({
      taskId: 'task-fail',
      command: '',
      cwd: tmpDir,
    });

    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(-1);
  });

  it('emits exit event with code -1 on spawn failure', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    await manager.spawn({
      taskId: 'task-fail-event',
      command: '',
      cwd: tmpDir,
    });

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].exitCode).toBe(-1);
  });

  it('failed session is accessible via getSession', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const session = await manager.spawn({
      taskId: 'task-fail-get',
      command: '',
      cwd: tmpDir,
    });

    const retrieved = manager.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.status).toBe('exited');
    expect(retrieved?.exitCode).toBe(-1);
  });

  it('analytics includes diagnostic properties on spawn failure', async () => {
    const { trackEvent } = await import('../../src/main/analytics/analytics');
    const errnoError = new Error('posix_spawnp failed.') as NodeJS.ErrnoException;
    errnoError.code = 'ENOENT';

    vi.mocked(pty.spawn).mockImplementation(() => {
      throw errnoError;
    });

    await manager.spawn({
      taskId: 'task-fail-diag',
      command: '',
      cwd: tmpDir,
    });

    expect(trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'pty_spawn',
      shell: expect.any(String),
      cwdExists: expect.any(String),
      shellExists: expect.any(String),
      platform: process.platform,
      arch: process.arch,
    }));
  });

  it('falls back to home directory when CWD does not exist', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const nonExistentCwd = path.join(tmpDir, 'deleted-project');

    await manager.spawn({
      taskId: 'task-fail-cwd',
      command: '',
      cwd: nonExistentCwd,
    });

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    expect(spawnCall[2]?.cwd).toBe(os.homedir());

    // Clean up
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('CWD fallback tracks separate analytics event', async () => {
    const { trackEvent } = await import('../../src/main/analytics/analytics');
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const nonExistentCwd = path.join(tmpDir, 'missing-dir');

    await manager.spawn({
      taskId: 'task-fail-cwd-track',
      command: '',
      cwd: nonExistentCwd,
    });

    expect(trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'pty_spawn_cwd_missing',
      message: 'CWD does not exist, falling back to home directory',
      platform: process.platform,
    }));

    // Clean up
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('writes diagnostic scrollback on posix_spawnp failure', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('posix_spawnp failed.');
    });

    const session = await manager.spawn({
      taskId: 'task-fail-posix',
      command: '',
      cwd: tmpDir,
    });

    const scrollback = manager.getScrollback(session.id);
    expect(scrollback).toContain('posix_spawnp');
    expect(scrollback).toContain('spawn-helper');

    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('does not write diagnostic scrollback for non-posix_spawnp errors', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const session = await manager.spawn({
      taskId: 'task-fail-nodiag',
      command: '',
      cwd: tmpDir,
    });

    const scrollback = manager.getScrollback(session.id);
    expect(scrollback).not.toContain('posix_spawnp');
    expect(scrollback).not.toContain('spawn-helper');

    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('analytics includes errno code when available', async () => {
    const { trackEvent } = await import('../../src/main/analytics/analytics');
    const errnoError = new Error('spawn EACCES') as NodeJS.ErrnoException;
    errnoError.code = 'EACCES';
    errnoError.errno = -13;

    vi.mocked(pty.spawn).mockImplementation(() => {
      throw errnoError;
    });

    await manager.spawn({
      taskId: 'task-fail-errno',
      command: '',
      cwd: tmpDir,
    });

    expect(trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'pty_spawn',
      errno: 'EACCES',
    }));
  });

  it('session record reflects fallback CWD when directory does not exist', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const nonExistentCwd = path.join(tmpDir, 'gone-project');

    const session = await manager.spawn({
      taskId: 'task-fail-cwd-record',
      command: '',
      cwd: nonExistentCwd,
    });

    expect(session.cwd).toBe(os.homedir());

    const retrieved = manager.getSession(session.id);
    expect(retrieved?.cwd).toBe(os.homedir());

    // Clean up
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

// ---------------------------------------------------------------------------
// 8. Shell Arguments
// ---------------------------------------------------------------------------

describe('Shell arguments', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    // Clean up any spawned sessions
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnWithShell(shell: string) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    manager.setShell(shell);
    await manager.spawn({
      taskId: `task-shell-${shell.replace(/\s+/g, '-')}`,
      command: '',
      cwd: tmpDir,
    });
    return vi.mocked(pty.spawn).mock.calls[vi.mocked(pty.spawn).mock.calls.length - 1];
  }

  it('WSL "wsl -d Ubuntu" → exe="wsl", args=["-d", "Ubuntu"]', async () => {
    const call = await spawnWithShell('wsl -d Ubuntu');
    expect(call[0]).toBe('wsl');
    expect(call[1]).toEqual(['-d', 'Ubuntu']);
  });

  it('cmd → args=[]', async () => {
    const call = await spawnWithShell('cmd');
    expect(call[0]).toBe('cmd');
    expect(call[1]).toEqual([]);
  });

  it('PowerShell → args=["-NoLogo"]', async () => {
    const call = await spawnWithShell('powershell');
    expect(call[0]).toBe('powershell');
    expect(call[1]).toEqual(['-NoLogo']);
  });

  it('pwsh → args=["-NoLogo"]', async () => {
    const call = await spawnWithShell('pwsh');
    expect(call[0]).toBe('pwsh');
    expect(call[1]).toEqual(['-NoLogo']);
  });

  it('fish → args=[]', async () => {
    const call = await spawnWithShell('fish');
    expect(call[0]).toBe('fish');
    expect(call[1]).toEqual([]);
  });

  it('nushell (nu) → args=[]', async () => {
    const call = await spawnWithShell('nu');
    expect(call[0]).toBe('nu');
    expect(call[1]).toEqual([]);
  });

  it('bash → args=["--login"]', async () => {
    const call = await spawnWithShell('/bin/bash');
    expect(call[0]).toBe('/bin/bash');
    expect(call[1]).toEqual(['--login']);
  });

  it('zsh → args=["--login"]', async () => {
    const call = await spawnWithShell('/bin/zsh');
    expect(call[0]).toBe('/bin/zsh');
    expect(call[1]).toEqual(['--login']);
  });
});

// ---------------------------------------------------------------------------
// 9. Environment Filtering
// ---------------------------------------------------------------------------

describe('Environment filtering', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete process.env.CLAUDECODE;
  });

  async function spawnWithEnv(inputEnv?: Record<string, string>) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-env',
      command: '',
      cwd: tmpDir,
      env: inputEnv,
    });
    const lastCall = vi.mocked(pty.spawn).mock.calls[vi.mocked(pty.spawn).mock.calls.length - 1];
    return lastCall[2]?.env as Record<string, string>;
  }

  it('strips CLAUDECODE from spawned PTY environment', async () => {
    process.env.CLAUDECODE = '1';

    const spawnedEnv = await spawnWithEnv();

    expect(spawnedEnv).not.toHaveProperty('CLAUDECODE');
  });

  it('merges input.env into spawned PTY environment', async () => {
    const spawnedEnv = await spawnWithEnv({ CUSTOM_VAR: 'hello' });

    expect(spawnedEnv.CUSTOM_VAR).toBe('hello');
  });

  it('input.env overrides process.env', async () => {
    process.env.MY_VAR = 'original';

    const spawnedEnv = await spawnWithEnv({ MY_VAR: 'overridden' });

    expect(spawnedEnv.MY_VAR).toBe('overridden');

    delete process.env.MY_VAR;
  });
});

// ---------------------------------------------------------------------------
// 10. Data Buffering
// ---------------------------------------------------------------------------

describe('Data buffering', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-buffer',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;
    return { session, ...mock };
  }

  it('batches multiple onData calls into single data emission', async () => {
    const { session, feedData } = await spawnSession();

    const emissions: string[] = [];
    manager.on('data', (sessionId: string, data: string) => {
      if (sessionId === session.id) emissions.push(data);
    });

    // Three rapid onData calls within the 16ms flush window
    feedData('aaa');
    feedData('bbb');
    feedData('ccc');

    // Wait for the 16ms setTimeout to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe('aaabbbccc');
  });

  it('flush is skipped when session is removed during 16ms window', async () => {
    const { session, feedData } = await spawnSession();

    const emissions: string[] = [];
    manager.on('data', (sessionId: string, data: string) => {
      if (sessionId === session.id) emissions.push(data);
    });

    feedData('data-before-remove');
    // Remove session before the 16ms flush fires
    manager.remove(session.id);
    spawnedSessionId = null; // already removed

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emissions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Write and Resize (null guards)
// ---------------------------------------------------------------------------

describe('Write and resize', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('write to non-existent session does not throw', () => {
    expect(() => manager.write('nonexistent', 'hello')).not.toThrow();
  });

  it('resize on non-existent session returns colsChanged false', () => {
    const result = manager.resize('nonexistent', 80, 24);
    expect(result).toEqual({ colsChanged: false });
  });

  it('write no-ops after session is killed', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-write-killed',
      command: '',
      cwd: tmpDir,
    });

    manager.kill(session.id);
    mock.mockPty.write.mockClear();

    manager.write(session.id, 'should-not-arrive');

    expect(mock.mockPty.write).not.toHaveBeenCalled();
  });

  it('resize no-ops after session is killed', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-resize-killed',
      command: '',
      cwd: tmpDir,
    });

    manager.kill(session.id);
    mock.mockPty.resize.mockClear();

    manager.resize(session.id, 80, 24);

    expect(mock.mockPty.resize).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11b. Statusline repaint kick (background status.json fix)
// ---------------------------------------------------------------------------

describe('Statusline repaint kick', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  // Claude only writes status.json - the board card's live model + context % -
  // when its TUI paints. In the app's pwsh-wrapped PTY a background (never
  // opened) session never does that initial paint on its own, so status.json is
  // never written and the card stays on the spawn-time model placeholder until
  // the task is opened (which resized the PTY). On first output we now nudge the
  // PTY once - rows down then back to the spawn size - to force that first
  // paint; the settings' refreshInterval then keeps status.json fresh.
  // Regression guard for the board-card-stuck bug.
  it('nudges the PTY rows down then back after first output for a statusline agent (Claude)', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-kick',
      command: '',
      cwd: tmpDir,
      agentParser: claudeAdapter,
    });
    mock.mockPty.resize.mockClear();

    // Claude hides the cursor (ESC[?25l) when its TUI takes over - this is what
    // detectFirstOutput matches, which drives the kick.
    mock.feedData('\x1b[?25l');
    // Wait for the buffer flush (~16ms) + the nudge-back setTimeout (200ms).
    await new Promise((resolve) => setTimeout(resolve, 300));

    const resizeCalls = mock.mockPty.resize.mock.calls;
    expect(resizeCalls).toContainEqual([120, 29]);
    expect(resizeCalls).toContainEqual([120, 30]);
  });

  it('does not kick agents without a statusline pipeline (no runtime.statusFile)', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    // Stub adapter that reports first output but does NOT use the statusFile
    // pipeline (mirrors Codex/Gemini, which derive usage from native logs).
    const stub = {
      ...claudeAdapter,
      name: 'stub-no-statusfile',
      detectFirstOutput: () => true,
      removeHooks: () => {},
      runtime: { activity: claudeAdapter.runtime.activity },
    };
    await manager.spawn({
      taskId: 'task-no-kick',
      command: '',
      cwd: tmpDir,
      agentParser: stub as unknown as typeof claudeAdapter,
      agentName: 'stub-no-statusfile',
    });
    mock.mockPty.resize.mockClear();

    mock.feedData('booting...');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(mock.mockPty.resize).not.toHaveBeenCalled();
  });

  // A session whose task is already OPEN when it spawns has had its PTY fit to
  // the real terminal viewport by the renderer. The kick must nudge relative to
  // that live size, not the 120x30 spawn default -- otherwise it would leave the
  // PTY mismatched with the displayed xterm (wrong wrapping) until the next
  // renderer resize. Background sessions (never resized) still end at the spawn
  // default because that IS their current size.
  it('nudges relative to the terminal current size, preserving an open terminal dimensions', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-open-kick',
      command: '',
      cwd: tmpDir,
      agentParser: claudeAdapter,
    });
    // Renderer fits the PTY to a real, non-default viewport (task open).
    manager.resize(session.id, 150, 40);
    mock.mockPty.resize.mockClear();

    mock.feedData('\x1b[?25l');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const resizeCalls = mock.mockPty.resize.mock.calls;
    expect(resizeCalls).toContainEqual([150, 39]);
    expect(resizeCalls).toContainEqual([150, 40]);
    // Must NOT clobber the open terminal back to the spawn default.
    expect(resizeCalls).not.toContainEqual([120, 30]);
  });
});

// ---------------------------------------------------------------------------
// 12. Query Methods for Missing Sessions (consolidated)
// ---------------------------------------------------------------------------

describe('Query methods for missing sessions', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('returns empty/undefined for non-existent session ID', () => {
    expect(manager.getSession('ghost')).toBeUndefined();
    expect(manager.getEventsForSession('ghost')).toEqual([]);
    expect(manager.getScrollback('ghost')).toBe('');
  });

  it('returns empty objects when no sessions exist', () => {
    expect(manager.getUsageCache()).toEqual({});
    expect(manager.getActivityCache()).toEqual({});
    expect(manager.getEventsCache()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 13. Synthetic Session End
// ---------------------------------------------------------------------------

describe('Synthetic session_end', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  /** Append one JSONL event to the events file. */
  function appendEvent(filePath: string, event: Record<string, unknown>): void {
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }

  /** Wait for the file watcher debounce (50ms) + processing time. */
  function waitForWatcher(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function spawnWithEvents(taskId = 'task-synth') {
    const eventsPath = path.join(tmpDir, `${taskId}-events.jsonl`);
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
      eventsOutputPath: eventsPath,
      agentParser: claudeAdapter,
    });

    spawnedSessionId = session.id;
    return { session, eventsPath, ...mock };
  }

  it('suspend injects synthetic session_end into event cache', async () => {
    const { session, eventsPath } = await spawnWithEvents('task-synth-suspend');

    // Write a tool_start event so the cache has content
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    await manager.suspend(session.id);
    spawnedSessionId = null; // already suspended

    const events = manager.getEventsForSession(session.id);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe(EventType.SessionEnd);
  });

  it('suspend does not duplicate session_end if already present', async () => {
    const { session, eventsPath } = await spawnWithEvents('task-synth-nodup');

    // Write a session_end event from Claude Code's hook
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SessionEnd });
    await waitForWatcher();

    const eventsBefore = manager.getEventsForSession(session.id);
    const sessionEndCountBefore = eventsBefore.filter(
      (event) => event.type === EventType.SessionEnd
    ).length;

    await manager.suspend(session.id);
    spawnedSessionId = null;

    const eventsAfter = manager.getEventsForSession(session.id);
    const sessionEndCountAfter = eventsAfter.filter(
      (event) => event.type === EventType.SessionEnd
    ).length;

    // Should not have added another session_end
    expect(sessionEndCountAfter).toBe(sessionEndCountBefore);
  });

  it('suspend creates event cache entry if none existed', async () => {
    // Spawn without eventsOutputPath → no event watcher → no cache entry
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId: 'task-synth-nocache',
      command: '',
      cwd: tmpDir,
      // no eventsOutputPath
    });
    spawnedSessionId = session.id;

    // Verify no events cached yet
    expect(manager.getEventsForSession(session.id)).toEqual([]);

    await manager.suspend(session.id);
    spawnedSessionId = null;

    const events = manager.getEventsForSession(session.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.SessionEnd);
  });

  it('onExit emits synthetic session_end for running sessions', async () => {
    // Spawn without eventsOutputPath so there's no pre-existing event cache
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId: 'task-synth-exit',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;

    const emittedEvents: SessionEvent[] = [];
    manager.on('event', (sessionId: string, event: SessionEvent) => {
      if (sessionId === session.id) emittedEvents.push(event);
    });

    // Trigger PTY exit (simulates process ending)
    mock.triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // onExit should have injected a synthetic session_end
    const cached = manager.getEventsForSession(session.id);
    expect(cached.some((event) => event.type === EventType.SessionEnd)).toBe(true);
    expect(emittedEvents.some((event) => event.type === EventType.SessionEnd)).toBe(true);

    spawnedSessionId = null; // already exited
  });
});

// ---------------------------------------------------------------------------
// 14. Spawning Count (concurrent spawn slot reservation)
// ---------------------------------------------------------------------------

describe('Spawning count', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('5 concurrent spawn calls with maxConcurrent=3 - exactly 3 running + 2 queued', async () => {
    manager.setMaxConcurrent(3);

    // Use a slow mock PTY that takes time to "spawn" so we can test concurrency
    const mocks: ReturnType<typeof createMockPty>[] = [];
    vi.mocked(pty.spawn).mockImplementation(() => {
      const mock = createMockPty();
      mocks.push(mock);
      return mock.mockPty as unknown as pty.IPty;
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        manager.spawn({
          taskId: `task-concurrent-${index}`,
          command: '',
          cwd: tmpDir,
        }),
      ),
    );

    const running = results.filter(session => session.status === 'running');
    const queued = results.filter(session => session.status === 'queued');

    expect(running).toHaveLength(3);
    expect(queued).toHaveLength(2);
  });

  it('failed doSpawn decrements spawningCount and promotes queued session', async () => {
    manager.setMaxConcurrent(1);

    let spawnCallCount = 0;
    vi.mocked(pty.spawn).mockImplementation(() => {
      spawnCallCount++;
      if (spawnCallCount === 1) {
        // First spawn fails
        throw new Error('spawn ENOENT');
      }
      // Subsequent spawns succeed
      const mock = createMockPty();
      return mock.mockPty as unknown as pty.IPty;
    });

    // First spawn will fail (but still occupy a slot temporarily)
    const firstSession = await manager.spawn({
      taskId: 'task-fail-slot',
      command: '',
      cwd: tmpDir,
    });
    expect(firstSession.status).toBe('exited');
    expect(firstSession.exitCode).toBe(-1);

    // Second spawn should NOT be queued since the failed spawn freed its slot
    const secondSession = await manager.spawn({
      taskId: 'task-after-fail',
      command: '',
      cwd: tmpDir,
    });
    expect(secondSession.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// 13. Caller-owned session IDs
// ---------------------------------------------------------------------------

describe('Caller-owned session IDs', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('spawn uses caller-provided id when given', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      id: 'caller-owned-id',
      taskId: 'task-caller-id',
      command: '',
      cwd: tmpDir,
    });

    expect(session.id).toBe('caller-owned-id');
    expect(session.status).toBe('running');
  });

  it('queued session preserves caller-provided id through promotion', async () => {
    manager.setMaxConcurrent(1);

    const mocks: ReturnType<typeof createMockPty>[] = [];
    vi.mocked(pty.spawn).mockImplementation(() => {
      const mock = createMockPty();
      mocks.push(mock);
      return mock.mockPty as unknown as pty.IPty;
    });

    // First spawn fills the only slot
    const firstSession = await manager.spawn({
      taskId: 'task-fill-slot',
      command: '',
      cwd: tmpDir,
    });
    expect(firstSession.status).toBe('running');

    // Second spawn gets queued with a caller-provided ID
    const queuedSession = await manager.spawn({
      id: 'stable-queued-id',
      taskId: 'task-queued',
      command: '',
      cwd: tmpDir,
    });
    expect(queuedSession.status).toBe('queued');
    expect(queuedSession.id).toBe('stable-queued-id');

    // Kill first session to free the slot and trigger queue promotion
    manager.kill(firstSession.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Promoted session should still have the same caller-provided ID
    const promotedSession = manager.getSession('stable-queued-id');
    expect(promotedSession).toBeDefined();
    expect(promotedSession!.status).toBe('running');
    expect(promotedSession!.id).toBe('stable-queued-id');
  });
});

// ---------------------------------------------------------------------------
// 14. fromFilesystem session-ID capture wiring
// ---------------------------------------------------------------------------

describe('fromFilesystem session-ID capture wiring', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('fires agent-session-id event when fromFilesystem resolves with a UUID', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const capturedIds: string[] = [];
    manager.on('agent-session-id', (_sessionId: string, _taskId: string, _projectId: string, agentReportedId: string) => {
      capturedIds.push(agentReportedId);
    });

    const expectedId = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const stubAdapter = {
      ...claudeAdapter,
      name: 'stub-fs',
      supportsCallerSessionId: false,
      detectFirstOutput: () => true,
      removeHooks: () => {},
      runtime: {
        activity: claudeAdapter.runtime.activity,
        sessionId: {
          fromFilesystem: () => Promise.resolve(expectedId),
        },
      },
    };

    await manager.spawn({
      taskId: 'task-fs-capture',
      projectId: 'project-fs',
      command: '',
      cwd: tmpDir,
      agentParser: stubAdapter as unknown as typeof claudeAdapter,
      agentName: 'stub-fs',
    });

    // fromFilesystem resolves immediately (microtask) but the callback
    // chain goes through SessionTelemetry -> SessionManager event -> here.
    // Allow one tick for the async chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedIds).toContain(expectedId);
  });

  it('does NOT fire agent-session-id when session is removed before fromFilesystem resolves', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const capturedIds: string[] = [];
    manager.on('agent-session-id', (_sessionId: string, _taskId: string, _projectId: string, agentReportedId: string) => {
      capturedIds.push(agentReportedId);
    });

    // Deferred promise that we resolve AFTER killing the session.
    let resolveCapture!: (value: string | null) => void;
    const capturePromise = new Promise<string | null>((resolve) => {
      resolveCapture = resolve;
    });

    const stubAdapter = {
      ...claudeAdapter,
      name: 'stub-fs-delayed',
      supportsCallerSessionId: false,
      detectFirstOutput: () => true,
      removeHooks: () => {},
      runtime: {
        activity: claudeAdapter.runtime.activity,
        sessionId: {
          fromFilesystem: () => capturePromise,
        },
      },
    };

    const session = await manager.spawn({
      taskId: 'task-fs-guard',
      projectId: 'project-fs-guard',
      command: '',
      cwd: tmpDir,
      agentParser: stubAdapter as unknown as typeof claudeAdapter,
      agentName: 'stub-fs-delayed',
    });

    // Fully remove the session BEFORE resolving the filesystem capture.
    // remove() deletes from the sessions Map (unlike kill which just
    // sets status=exited but keeps the entry). The guard we are testing
    // is `!this.sessions.has(id)` at session-manager.ts:565.
    manager.remove(session.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now resolve with a UUID - should be silently discarded.
    resolveCapture('bbbb2222-cccc-dddd-eeee-ffffffffffff');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedIds).not.toContain('bbbb2222-cccc-dddd-eeee-ffffffffffff');
  });
});

// ---------------------------------------------------------------------------
// 14. safeKillPty behavior (tested via observable effects on public API)
// ---------------------------------------------------------------------------

/**
 * Create a mock PTY whose .kill() throws a synthetic errno error.
 *
 * Used to exercise safeKillPty's error-swallowing logic without importing the
 * private helper directly. The factory returns the same shape as createMockPty
 * but never auto-fires the exit handler on kill - callers must trigger it
 * manually if they need the exit event, or simply observe that the public
 * method (killAll / suspend) did not throw.
 */
function createAlreadyDeadPty(errnoCode: string) {
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;

  const killError = new Error(`kill ESRCH`) as NodeJS.ErrnoException;
  killError.code = errnoCode;
  killError.syscall = 'kill';

  const mockPty = {
    pid: 99999,
    onData: vi.fn((_cb: (data: string) => void) => {}),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      throw killError;
    }),
  };

  return {
    mockPty,
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

describe('safeKillPty behavior', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  // -- killAll surface tests (EACCES, ESRCH, EPERM) -------------------------

  it('killAll does not throw when PTY.kill() raises EACCES (already dead - Windows)', async () => {
    const dead = createAlreadyDeadPty('EACCES');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-eacces', command: '', cwd: tmpDir });

    // If safeKillPty propagated the error, killAll() would throw here.
    expect(() => manager.killAll()).not.toThrow();
  });

  it('killAll does not throw when PTY.kill() raises ESRCH (already dead - POSIX)', async () => {
    const dead = createAlreadyDeadPty('ESRCH');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-esrch', command: '', cwd: tmpDir });

    expect(() => manager.killAll()).not.toThrow();
  });

  it('killAll does not throw on unexpected errno (EPERM) but emits console.warn', async () => {
    const dead = createAlreadyDeadPty('EPERM');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-eperm', command: '', cwd: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => manager.killAll()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SESSION]'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('killAll does NOT emit console.warn for EACCES (expected errno)', async () => {
    const dead = createAlreadyDeadPty('EACCES');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-eacces-quiet', command: '', cwd: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      manager.killAll();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('killAll does NOT emit console.warn for ESRCH (expected errno)', async () => {
    const dead = createAlreadyDeadPty('ESRCH');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-esrch-quiet', command: '', cwd: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      manager.killAll();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // -- suspend() skips 1500ms post-kill wait when kill returns false --------

  /**
   * The regression this test locks in:
   *
   * suspend() sends the exit sequence, waits up to 1500ms for a natural exit,
   * then force-kills. If the PTY is already dead (EACCES/ESRCH), safeKillPty
   * returns false and the second 1500ms wait must be SKIPPED entirely.
   * Without the `if (killLanded)` guard, suspend() would burn a full 1500ms
   * on every shutdown operation involving an already-dead process.
   *
   * We verify this by measuring wall-clock time: if the wait is skipped,
   * suspend() resolves well under 200ms. If the wait is not skipped it would
   * take at least 1500ms - a 7x difference that is not attributable to
   * timer jitter.
   */
  /**
   * Authoritative timing test using fake timers.
   *
   * Sequence of events inside suspend() after the PTY's exit sequence is sent:
   *  T+0ms    natural-exit wait starts (1500ms timeout)
   *  T+1500ms timeout fires, exitedNaturally=false
   *  T+1500ms force-kill attempted: PTY.kill() throws EACCES -> killLanded=false
   *  T+1500ms `if (killLanded)` is false -> second wait SKIPPED -> suspend() returns
   *
   * With real timers: suspend() resolves at T+1500ms.
   * With fake timers advanced by 1500ms: suspend() resolves immediately after
   *   the advance, with no further timer pending.
   *
   * We advance fake time by 1500ms and then confirm suspend() has settled.
   * If the second wait were NOT skipped, a further 1500ms advance would be
   * required - the test would hang waiting on the unresolved promise.
   */
  it('suspend() skips 1500ms post-kill wait when PTY.kill() throws EACCES (killLanded=false)', async () => {
    vi.useFakeTimers();
    try {
      const dead = createAlreadyDeadPty('EACCES');
      vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

      const freshManager = new SessionManager();

      const session = await freshManager.spawn({ taskId: 'task-kill-skip-eacces', command: '', cwd: tmpDir });

      // Start suspend() - it will block on the natural-exit wait (1500ms timer).
      // Do NOT emit the 'exit' event - we want exitedNaturally=false so the
      // force-kill path runs.
      let settled = false;
      const suspendPromise = freshManager.suspend(session.id).then(() => { settled = true; });

      // Advance past the natural-exit timeout only. If killLanded=false correctly
      // skips the second 1500ms wait, the promise resolves after this advance.
      await vi.advanceTimersByTimeAsync(1500);

      // Flush any queued microtasks.
      await Promise.resolve();

      expect(settled).toBe(true);

      // Advance another 1500ms to confirm no second wait is pending.
      await vi.advanceTimersByTimeAsync(1500);
      await suspendPromise;

      freshManager.killAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suspend() skips 1500ms post-kill wait when PTY.kill() throws ESRCH (killLanded=false)', async () => {
    vi.useFakeTimers();
    try {
      const dead = createAlreadyDeadPty('ESRCH');
      vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

      const freshManager = new SessionManager();

      const session = await freshManager.spawn({ taskId: 'task-kill-skip-esrch', command: '', cwd: tmpDir });

      let settled = false;
      const suspendPromise = freshManager.suspend(session.id).then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(1500);
      await Promise.resolve();

      expect(settled).toBe(true);

      await vi.advanceTimersByTimeAsync(1500);
      await suspendPromise;

      freshManager.killAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 15. attachSession dispatch contract
// ---------------------------------------------------------------------------

describe('attachSession dispatch contract', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnWithAdapter(
    taskId: string,
    adapter: import('../../src/shared/types').AgentParser & {
      attachSession?(context: import('../../src/shared/types').SessionContext): import('../../src/shared/types').SessionAttachment | void;
    },
  ) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      projectId: 'project-attach-test',
      command: '',
      cwd: tmpDir,
      agentParser: adapter as unknown as Parameters<typeof manager.spawn>[0]['agentParser'],
    });
    return { session, ...mock };
  }

  it('calls attachSession with a SessionContext whose sessionId matches the spawned session', async () => {
    const capturedContexts: import('../../src/shared/types').SessionContext[] = [];

    const adapter = {
      ...claudeAdapter,
      attachSession(context: import('../../src/shared/types').SessionContext) {
        capturedContexts.push(context);
        return { dispose: vi.fn() };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-context', adapter);

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0].sessionId).toBe(session.id);
    expect(typeof capturedContexts[0].applyUsage).toBe('function');
  });

  it('stores the returned attachment on the session (dispose called when session exits via onExit)', async () => {
    const disposeSpy = vi.fn();

    const adapter = {
      ...claudeAdapter,
      attachSession() {
        return { dispose: disposeSpy };
      },
    };

    const { triggerExit } = await spawnWithAdapter('task-attach-dispose-exit', adapter);

    expect(disposeSpy).not.toHaveBeenCalled();

    triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('applyUsage inside the context calls usageTracker.setSessionUsage and emits usage event', async () => {
    let capturedContext: import('../../src/shared/types').SessionContext | null = null;

    const adapter = {
      ...claudeAdapter,
      attachSession(context: import('../../src/shared/types').SessionContext) {
        capturedContext = context;
        return { dispose: vi.fn() };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-apply-usage', adapter);

    const usageEvents: Array<{ sessionId: string; usage: Partial<import('../../src/shared/types').SessionUsage> }> = [];
    manager.on('usage', (sessionId: string, usage: import('../../src/shared/types').SessionUsage) => {
      usageEvents.push({ sessionId, usage });
    });

    expect(capturedContext).not.toBeNull();

    capturedContext!.applyUsage({ model: { id: 'cursor-small', displayName: 'Cursor Small' } });

    // SessionTelemetry.setSessionUsage triggers the onUsageChange callback which emits 'usage'
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(usageEvents.some((e) => e.sessionId === session.id)).toBe(true);
    const usageCache = manager.getUsageCache();
    expect(usageCache[session.id]?.model?.id).toBe('cursor-small');
  });

  it('applyUsage is a no-op once the session has been removed (torn-down guard)', async () => {
    let capturedContext: import('../../src/shared/types').SessionContext | null = null;

    const adapter = {
      ...claudeAdapter,
      attachSession(context: import('../../src/shared/types').SessionContext) {
        capturedContext = context;
        return { dispose: vi.fn() };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-noop-after-remove', adapter);

    manager.remove(session.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // This should not throw and should not write to any tracker
    expect(() => capturedContext!.applyUsage({ model: { id: 'zombie', displayName: 'Zombie' } })).not.toThrow();

    // Session is gone - usage cache entry must not exist
    expect(manager.getUsageCache()['zombie']).toBeUndefined();
  });

  it('adapterAttachment.dispose called on remove()', async () => {
    const disposeSpy = vi.fn();

    const adapter = {
      ...claudeAdapter,
      attachSession() {
        return { dispose: disposeSpy };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-dispose-remove', adapter);

    expect(disposeSpy).not.toHaveBeenCalled();

    manager.remove(session.id);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('adapterAttachment.dispose called on respawn (replace-existing path) before second attachSession fires', async () => {
    const callOrder: string[] = [];
    const disposeFirstSpy = vi.fn(() => { callOrder.push('dispose-first'); });

    let attachCallCount = 0;
    const adapter = {
      ...claudeAdapter,
      attachSession() {
        attachCallCount++;
        if (attachCallCount === 1) {
          callOrder.push('attach-first');
          return { dispose: disposeFirstSpy };
        }
        callOrder.push('attach-second');
        return { dispose: vi.fn() };
      },
    };

    // First spawn
    const { session: firstSession } = await spawnWithAdapter('task-attach-respawn', adapter);
    expect(firstSession.taskId).toBe('task-attach-respawn');
    expect(attachCallCount).toBe(1);

    // Respawn (same taskId, triggers replace-existing path)
    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-attach-respawn',
      projectId: 'project-attach-test',
      command: '',
      cwd: tmpDir,
      agentParser: adapter as unknown as Parameters<typeof manager.spawn>[0]['agentParser'],
    });

    expect(attachCallCount).toBe(2);
    // dispose must have been called before the second attachSession fires
    const disposeIdx = callOrder.indexOf('dispose-first');
    const attachSecondIdx = callOrder.indexOf('attach-second');
    expect(disposeFirstSpy).toHaveBeenCalledTimes(1);
    expect(disposeIdx).toBeLessThan(attachSecondIdx);
  });

  it('adapter WITHOUT attachSession method spawns without error (optional-chain regression guard)', async () => {
    // Use a minimal adapter that explicitly has no attachSession property
    const adapterWithoutAttach = {
      ...claudeAdapter,
      attachSession: undefined,
    };

    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    let spawnError: unknown = null;
    try {
      await manager.spawn({
        taskId: 'task-no-attach',
        projectId: 'project-no-attach',
        command: '',
        cwd: tmpDir,
        agentParser: adapterWithoutAttach as unknown as Parameters<typeof manager.spawn>[0]['agentParser'],
      });
    } catch (error) {
      spawnError = error;
    }

    expect(spawnError).toBeNull();
    // Session should be running
    const sessions = manager.listSessions();
    const spawnedSession = sessions.find((s) => s.taskId === 'task-no-attach');
    expect(spawnedSession?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// 15b. getFirstOutputCache() wrapper
//
// Contract:
//  - Empty object when no session has emitted first output.
//  - { [sessionId]: true } for every session that has produced first output.
//  - Reflects remove(): a removed session no longer appears.
// ---------------------------------------------------------------------------

describe('getFirstOutputCache', () => {
  let manager: SessionManager;
  // Track sessions that need cleanup in afterEach.
  const spawnedIds: string[] = [];

  beforeEach(() => {
    manager = new SessionManager();
    spawnedIds.length = 0;
  });

  afterEach(async () => {
    // Kill any lingering PTYs created during the test.
    for (const sessionId of spawnedIds) {
      manager.kill(sessionId);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('returns an empty object when no session has emitted first output', () => {
    expect(manager.getFirstOutputCache()).toEqual({});
  });

  it('includes a session ID once the session emits a qualifying PTY chunk', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-first-output-1',
      command: '',
      cwd: tmpDir,
    });
    spawnedIds.push(session.id);

    // Before any data - not in cache.
    expect(manager.getFirstOutputCache()[session.id]).toBeUndefined();

    // Feed a qualifying chunk (non-empty, no custom detector).
    mock.feedData('hello from PTY');

    // Allow the 16ms flush debounce to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const cache = manager.getFirstOutputCache();
    expect(cache[session.id]).toBe(true);
    expect(Object.keys(cache)).toEqual([session.id]);
  });

  it('returns true for each of multiple sessions that have emitted', async () => {
    const mock1 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock1.mockPty as unknown as pty.IPty);
    const session1 = await manager.spawn({
      taskId: 'task-first-output-multi-1',
      command: '',
      cwd: tmpDir,
    });
    spawnedIds.push(session1.id);

    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    const session2 = await manager.spawn({
      taskId: 'task-first-output-multi-2',
      command: '',
      cwd: tmpDir,
    });
    spawnedIds.push(session2.id);

    mock1.feedData('output-from-session-1');
    mock2.feedData('output-from-session-2');

    await new Promise((resolve) => setTimeout(resolve, 50));

    const cache = manager.getFirstOutputCache();
    expect(cache[session1.id]).toBe(true);
    expect(cache[session2.id]).toBe(true);
    expect(Object.keys(cache).sort()).toEqual([session1.id, session2.id].sort());
  });

  it('removes a session from the cache after remove() is called', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-first-output-remove',
      command: '',
      cwd: tmpDir,
    });
    // Do NOT push to spawnedIds: we call remove() explicitly in the test.

    mock.feedData('data');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.getFirstOutputCache()[session.id]).toBe(true);

    manager.remove(session.id);

    expect(manager.getFirstOutputCache()[session.id]).toBeUndefined();
    expect(manager.getFirstOutputCache()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 16. findLiveSessionByTaskId delegate
// ---------------------------------------------------------------------------

describe('findLiveSessionByTaskId delegate', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('forwards the call to the registry and passes through the return value', async () => {
    // Spawn a running session so the registry has a live entry for the task.
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId: 'task-delegate-live',
      command: '',
      cwd: tmpDir,
    });

    // The delegate must return the same session DTO as querying by id directly.
    const result = manager.findLiveSessionByTaskId('task-delegate-live');

    expect(result).toBeDefined();
    expect(result!.id).toBe(session.id);
    expect(result!.taskId).toBe('task-delegate-live');
    expect(result!.status).toBe('running');
    // Confirm the DTO does not expose internal ManagedSession fields.
    expect('pty' in result!).toBe(false);
  });

  it('returns undefined when no live session exists for the taskId', () => {
    // Empty registry - delegate must pass through undefined without throwing.
    const result = manager.findLiveSessionByTaskId('task-delegate-missing');
    expect(result).toBeUndefined();
  });
});
