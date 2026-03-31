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

vi.mock('../../src/main/pty/shell-resolver', () => {
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
import { EventType } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

let tmpDir: string;

/** Create a mock PTY with controllable onData/onExit callbacks. */
function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    onData: vi.fn((cb: (data: string) => void) => {
      dataHandler = cb;
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
    }),
    write: vi.fn(),
    resize: vi.fn(),
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
      manager.suspend(spawnedSessionId);
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

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      manager.suspend(spawnedSessionId);
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

  it('clears scrollback when cols change', async () => {
    const { session, feedData } = await spawnSession();

    feedData('hello world');

    // Resize to different cols
    const result = manager.resize(session.id, 80, 24);
    expect(result).toEqual({ colsChanged: true });

    const scrollback = manager.getScrollback(session.id);
    // getScrollback returns '' for empty scrollback
    expect(scrollback).toBe('');
  });

  it('tracks lastCols correctly across multiple resizes', async () => {
    const { session, feedData } = await spawnSession();

    // Resize to 80 cols (clears scrollback from initial 120)
    manager.resize(session.id, 80, 24);

    // Feed new data at 80 cols
    feedData('data at 80 cols');

    // Resize to same 80 cols (should preserve)
    manager.resize(session.id, 80, 30);
    expect(manager.getScrollback(session.id)).toContain('data at 80 cols');

    // Resize to different cols (should clear)
    manager.resize(session.id, 100, 30);
    expect(manager.getScrollback(session.id)).toBe('');
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

  it('accumulates new scrollback after clearing', async () => {
    const { session, feedData } = await spawnSession();

    feedData('old data');

    // Change cols to clear
    manager.resize(session.id, 80, 24);
    expect(manager.getScrollback(session.id)).toBe('');

    // New data arrives at 80 cols
    feedData('new data');
    expect(manager.getScrollback(session.id)).toContain('new data');
    expect(manager.getScrollback(session.id)).not.toContain('old data');
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

  it('sends ctrl-C and /exit to all running sessions', async () => {
    const { mockPty: pty1 } = await spawnSession('task-sa-1');
    const { mockPty: pty2 } = await spawnSession('task-sa-2');

    await manager.suspendAll(0);

    expect(pty1.write).toHaveBeenCalledWith('\x03');
    expect(pty1.write).toHaveBeenCalledWith('/exit\r');
    expect(pty2.write).toHaveBeenCalledWith('\x03');
    expect(pty2.write).toHaveBeenCalledWith('/exit\r');
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
      manager.suspend(spawnedSessionId);
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
      manager.suspend(spawnedSessionId);
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
    });

    spawnedSessionId = session.id;
    return { session, eventsPath, ...mock };
  }

  it('suspend injects synthetic session_end into event cache', async () => {
    const { session, eventsPath } = await spawnWithEvents('task-synth-suspend');

    // Write a tool_start event so the cache has content
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    manager.suspend(session.id);
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

    manager.suspend(session.id);
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

    manager.suspend(session.id);
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
