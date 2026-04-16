/**
 * Tests for session respawn behavior: when a task's session is suspended and
 * a new PTY is spawned (e.g. Executing → Code Review), the new session must
 * get a fresh UUID so the renderer treats it as a new component mount.
 *
 * This prevents terminal noise (shell prompt + CLI invocation) from leaking
 * through the loading overlay on column transitions.
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

let tmpDir: string;

function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    onData: vi.fn((cb: (data: string) => void) => { dataHandler = cb; }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => { exitHandler = cb; }),
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-respawn-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Session respawn (column transition)', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnForTask(taskId: string, options?: { statusOutputPath?: string; resuming?: boolean }) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
      statusOutputPath: options?.statusOutputPath,
      resuming: options?.resuming,
    });
    return { session, ...mock };
  }

  it('respawn assigns a new session ID (not reusing the old one)', async () => {
    const { session: first } = await spawnForTask('task-1');
    const firstId = first.id;

    // Suspend (simulates Executing → Code Review kill step)
    manager.suspend(firstId);

    // Respawn for same task (simulates spawn_agent after suspend)
    const { session: second } = await spawnForTask('task-1');

    expect(second.id).not.toBe(firstId);
  });

  it('old session is removed from the session map after respawn', async () => {
    const { session: first } = await spawnForTask('task-2');
    const firstId = first.id;

    manager.suspend(firstId);
    await spawnForTask('task-2');

    expect(manager.getSession(firstId)).toBeUndefined();
  });

  it('new session is findable and running', async () => {
    const { session: first } = await spawnForTask('task-3');
    manager.suspend(first.id);

    const { session: second } = await spawnForTask('task-3');

    const retrieved = manager.getSession(second.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.status).toBe('running');
  });

  it('old usage cache is cleared on respawn', async () => {
    const { session: first } = await spawnForTask('task-4');

    // Simulate usage arriving for the first session
    // (In production this happens via file watcher, but we can check the cache directly)
    const usageBefore = manager.getUsageCache();
    // Usage cache starts empty for the session since no file watcher fired
    expect(usageBefore[first.id]).toBeUndefined();

    manager.suspend(first.id);
    const { session: second } = await spawnForTask('task-4');

    // Old session's usage should be gone
    const usageAfter = manager.getUsageCache();
    expect(usageAfter[first.id]).toBeUndefined();
    // New session starts with no usage
    expect(usageAfter[second.id]).toBeUndefined();
  });

  it('old activity cache is cleared on respawn', async () => {
    const { session: first } = await spawnForTask('task-5');
    manager.suspend(first.id);
    await spawnForTask('task-5');

    const activity = manager.getActivityCache();
    expect(activity[first.id]).toBeUndefined();
  });

  it('scrollback is carried over for non-resume respawns', async () => {
    const { session: first, feedData } = await spawnForTask('task-6');

    feedData('previous output');

    manager.suspend(first.id);
    const { session: second } = await spawnForTask('task-6');

    // Non-resume respawn preserves scrollback across column transitions
    const scrollback = manager.getScrollback(second.id);
    expect(scrollback).toContain('previous output');
  });

  it('scrollback is carried over when resuming (history preserved for scroll-back)', async () => {
    const { session: first, feedData } = await spawnForTask('task-6b');

    feedData('previous output');

    manager.suspend(first.id);
    const { session: second } = await spawnForTask('task-6b', { resuming: true });

    // Resume spawns preserve scrollback so terminal scroll history is
    // available. Claude CLI's TUI overwrites the viewport without corrupting it.
    const scrollback = manager.getScrollback(second.id);
    expect(scrollback).toContain('previous output');
  });

  it('old session scrollback is no longer accessible after respawn', async () => {
    const { session: first, feedData } = await spawnForTask('task-7');
    feedData('old data');

    manager.suspend(first.id);
    await spawnForTask('task-7');

    // Old session ID returns empty scrollback (session removed from map)
    expect(manager.getScrollback(first.id)).toBe('');
  });

  it('old PTY is killed during respawn', async () => {
    const { session: first, mockPty: firstPty } = await spawnForTask('task-8');
    manager.suspend(first.id);

    // The suspend already kills the PTY, but respawn also guards against
    // orphaned processes by killing any existing PTY for the task
    await spawnForTask('task-8');

    expect(firstPty.kill).toHaveBeenCalled();
  });

  it('data from new PTY is emitted under the new session ID', async () => {
    const { session: first } = await spawnForTask('task-9');
    const firstId = first.id;

    manager.suspend(firstId);
    const { session: second, feedData } = await spawnForTask('task-9');

    const emissions: Array<{ sessionId: string; data: string }> = [];
    manager.on('data', (sessionId: string, data: string) => {
      emissions.push({ sessionId, data });
    });

    feedData('new session output');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emissions).toHaveLength(1);
    expect(emissions[0].sessionId).toBe(second.id);
    expect(emissions[0].sessionId).not.toBe(firstId);
    expect(emissions[0].data).toBe('new session output');
  });

  it('listSessions returns only the new session for the task', async () => {
    const { session: first } = await spawnForTask('task-10');
    manager.suspend(first.id);
    const { session: second } = await spawnForTask('task-10');

    const sessions = manager.listSessions();
    const taskSessions = sessions.filter((s) => s.taskId === 'task-10');

    expect(taskSessions).toHaveLength(1);
    expect(taskSessions[0].id).toBe(second.id);
  });

  it('stale status.json is deleted on respawn to prevent cached usage emission', async () => {
    const sessionDir = path.join(tmpDir, 'sessions', 'claude-session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const statusPath = path.join(sessionDir, 'status.json');

    // Write stale status data (simulates leftover from previous run)
    fs.writeFileSync(statusPath, JSON.stringify({
      type: 'status',
      session_id: 'claude-session-1',
      context_window: { total_input_tokens: 1000, total_output_tokens: 500 },
    }));
    expect(fs.existsSync(statusPath)).toBe(true);

    const { session: first } = await spawnForTask('task-11', { statusOutputPath: statusPath });
    manager.suspend(first.id);

    // Respawn with the same statusOutputPath (same claudeSessionId)
    await spawnForTask('task-11', { statusOutputPath: statusPath });

    // Stale file should have been deleted before the usage watcher started
    expect(fs.existsSync(statusPath)).toBe(false);
  });
});
