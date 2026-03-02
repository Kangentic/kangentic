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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgnt-smmgr-'));
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

    expect(manager.getScrollback(session.id).length).toBe(512 * 1024);
  });

  it('preserves scrollback under the limit', async () => {
    const { session, feedData } = await spawnSession();

    const chunk = 'y'.repeat(100 * 1024);
    feedData(chunk);

    expect(manager.getScrollback(session.id).length).toBe(100 * 1024);
  });

  it('accumulates scrollback across multiple onData calls', async () => {
    const { session, feedData } = await spawnSession();

    // 3 x 200KB = 600KB total → should truncate to 512KB
    const chunk = 'z'.repeat(200 * 1024);
    feedData(chunk);
    feedData(chunk);
    feedData(chunk);

    expect(manager.getScrollback(session.id).length).toBe(512 * 1024);
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

  it('resize on non-existent session does not throw', () => {
    expect(() => manager.resize('nonexistent', 80, 24)).not.toThrow();
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
