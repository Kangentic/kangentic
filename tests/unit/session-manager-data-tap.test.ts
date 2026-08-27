/**
 * Unit tests for the 'data-tap' unfiltered PTY output event added to
 * SessionManager for the mobile bridge (see session-manager.ts's onFlush
 * and onDrain callbacks - data-tap has TWO feeders: the ordinary 16ms
 * flush, and the replay-drain report for bytes a desktop replay consumed
 * out of the pending buffer before they could flush). The load-bearing
 * property: 'data-tap' fires for EVERY session's output regardless of
 * renderer focus, unlike 'data' - which is gated to focusedSessionIds -
 * and it must not feed the renderer's backpressure accounting, since that
 * protocol exists only for the focused-tab drain handshake a bridge
 * subscriber never participates in.
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
  buildSpawnClearPrelude: () => '',
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
    manager.setFocusedSessions([session.id]);

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    feedData('hello from a focused session');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(dataTapListener).toHaveBeenCalledWith(session.id, 'hello from a focused session');
    expect(dataListener).toHaveBeenCalledWith(session.id, 'hello from a focused session');
  });

  it('default-closed: with no setFocusedSessions call, "data" never fires while "data-tap" does', async () => {
    // Before the renderer's first SESSION_SET_FOCUSED push, NO session's
    // output goes over IPC (the empty set used to mean "all focused" and
    // fanned every session out). Red-green: fails if the size===0 escape
    // is ever restored in session-manager.ts's gate.
    const { session, feedData } = await spawnSession('task-data-tap-default');

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    feedData('output before any focus sync');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(dataTapListener).toHaveBeenCalledWith(session.id, 'output before any focus sync');
    expect(dataListener).not.toHaveBeenCalled();
  });

  it('an explicitly empty focused set stops "data" again (Backlog view / hidden panel)', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-empty-set');
    manager.setFocusedSessions([session.id]);

    const dataListener = vi.fn();
    manager.on('data', dataListener);

    feedData('while focused');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dataListener).toHaveBeenCalledTimes(1);

    // The renderer derives [] when no terminal is visible; that must close
    // the gate, not open the floodgates for every session.
    manager.setFocusedSessions([]);
    feedData('after focus cleared');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(dataListener).toHaveBeenCalledTimes(1);
  });

  it('forwards replay-drained bytes to data-tap without emitting "data" or feeding backpressure', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-replay-drain');
    // Focused is the strong case: 'data' WOULD fire here if the drain report
    // were ever miswired into the renderer emit.
    manager.setFocusedSessions([session.id]);

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    feedData('drained before flush');
    // Sample inside the 16ms flush window: the replay's double-delivery guard
    // drains the pending bytes out of the buffer, so they never reach onFlush.
    // Before the onDrain seam existed, a phone streaming this session simply
    // lost them whenever a desktop terminal mounted the same session.
    await manager.getScrollback(session.id);

    expect(dataTapListener).toHaveBeenCalledWith(session.id, 'drained before flush');
    // The renderer emit stays suppressed: the desktop gets these bytes inside
    // the replay payload it just requested, and a second 'data' delivery is
    // exactly the duplicate the drain exists to prevent.
    expect(dataListener).not.toHaveBeenCalled();

    // The emptied flush stays silent - no second data-tap delivery either.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dataTapListener).toHaveBeenCalledTimes(1);
    expect(dataListener).not.toHaveBeenCalled();

    // Drained bytes never ride the renderer's 'data' channel, so they must
    // not enter its backpressure accounting.
    const stats = manager.getPipelineStats().find((entry) => entry.sessionId === session.id);
    expect(stats?.inFlightBytes).toBe(0);
  });

  it('feeds first-output detection off a replay drain, exactly once across both streams', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-first-output-drain');

    const firstOutputListener = vi.fn();
    manager.on('first-output', firstOutputListener);

    feedData('qualifying first output chunk');
    // Sample inside the 16ms flush window: getScrollback's pre-flush drain
    // empties the pending buffer via onDrain, so this chunk never reaches
    // onFlush. For cursor-hide adapters the ESC[?25l first-output marker can
    // arrive in exactly that first chunk (docs/agent-integration.md pins it
    // for Grok), and nothing guarantees the marker recurs - so the drain
    // stream MUST feed the latch too, or a terminal mounting onto a
    // just-spawned session strands the shimmer overlay and the resuming
    // label. The latch fires during the drain itself.
    await manager.getScrollback(session.id);

    expect(firstOutputListener).toHaveBeenCalledTimes(1);
    expect(firstOutputListener).toHaveBeenCalledWith(session.id);

    // The tracker is a one-shot latch, so the ordinary flush stream feeding
    // the SAME latch afterwards must not double-fire it.
    feedData('second chunk after the drain');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(firstOutputListener).toHaveBeenCalledTimes(1);
  });

  it('getPipelineStats reports focused: false by default and true only for the session passed to setFocusedSessions', async () => {
    // Default-closed, matching the 'data'-event gate above: getPipelineStats's
    // `focused` field must NOT fall back to "true for everyone" when the
    // focused set is empty. Red-green: fails if the `size === 0` all-focused
    // escape is ever restored to session-manager.ts's getPipelineStats.
    const { session: sessionA } = await spawnSession('task-pipeline-stats-focus-a');
    const { session: sessionB } = await spawnSession('task-pipeline-stats-focus-b');

    const statsBefore = manager.getPipelineStats();
    expect(statsBefore.find((entry) => entry.sessionId === sessionA.id)?.focused).toBe(false);
    expect(statsBefore.find((entry) => entry.sessionId === sessionB.id)?.focused).toBe(false);

    manager.setFocusedSessions([sessionA.id]);
    const statsAfter = manager.getPipelineStats();
    expect(statsAfter.find((entry) => entry.sessionId === sessionA.id)?.focused).toBe(true);
    expect(statsAfter.find((entry) => entry.sessionId === sessionB.id)?.focused).toBe(false);

    // spawnSession's afterEach cleanup only tracks the LAST spawned session;
    // suspend sessionA explicitly since this test spawned two.
    await manager.suspend(sessionA.id);
  });
});
