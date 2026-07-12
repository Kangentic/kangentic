/**
 * Unit tests for the 'data-tap' unfiltered PTY output event added to
 * SessionManager for the mobile bridge (see session-manager.ts's onFlush
 * callback). The load-bearing property: 'data-tap' fires for EVERY
 * session's output regardless of renderer focus, unlike 'data' - which is
 * gated to focusedSessionIds - and it must not feed the renderer's
 * backpressure accounting, since that protocol exists only for the
 * focused-tab drain handshake a bridge subscriber never participates in.
 *
 * Follows the same mock-pty harness as session-manager.test.ts.
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-session-data-tap-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionManager data-tap', () => {
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

  async function spawnSession(taskId: string) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId, command: '', cwd: tmpDir });
    spawnedSessionId = session.id;
    return { session, ...mock };
  }

  it('fires for an unfocused session, where "data" does not', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-unfocused');
    // Focus a DIFFERENT session, so this one is explicitly excluded.
    manager.setFocusedSessions(['some-other-session-id']);

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    feedData('hello from a background session');
    // PtyBufferManager flushes on a 16ms timer, not synchronously on onData.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(dataTapListener).toHaveBeenCalledWith(session.id, 'hello from a background session');
    expect(dataListener).not.toHaveBeenCalled();
  });

  it('does not feed the focused-session backpressure accounting for an unfocused session', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-backpressure');
    manager.setFocusedSessions(['some-other-session-id']);

    feedData('x'.repeat(1024));
    // PtyBufferManager flushes on a 16ms timer; wait for it to actually run
    // so this assertion covers the flushed state, not just the pre-flush
    // window where inFlightBytes would trivially still read 0.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stats = manager.getPipelineStats().find((entry) => entry.sessionId === session.id);
    expect(stats?.inFlightBytes).toBe(0);
  });

  it('still fires alongside "data" for a focused session (unfiltered means "in addition to", not "instead of")', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-focused');
    // Empty set means "all focused" (session-manager.ts's documented default),
    // so no explicit setFocusedSessions call is needed here.

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    feedData('hello from a focused session');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(dataTapListener).toHaveBeenCalledWith(session.id, 'hello from a focused session');
    expect(dataListener).toHaveBeenCalledWith(session.id, 'hello from a focused session');
  });
});
