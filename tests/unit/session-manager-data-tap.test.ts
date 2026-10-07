/**
 * Unit tests for SessionManager's focus-independent output seams.
 *
 * 'data-tap' carries a session's raw bytes regardless of renderer focus, for
 * consumers that need them (the mobile bridge's terminal stream, the paste
 * engine, the keystroke settle). The PTY lives in the pty host, which sends a
 * session's bytes to main only while someone holds a `subscribeDataTap` on it,
 * so an unwatched flood costs main nothing. It has TWO feeders: the ordinary
 * 16ms flush, and the replay-drain report for bytes a desktop replay consumed
 * out of the pending buffer before they could flush. It must not feed the
 * renderer's backpressure accounting, since that protocol exists only for the
 * focused-tab drain handshake a tap subscriber never participates in.
 *
 * 'output-seen' carries no bytes and fires for every session's output, for
 * consumers that only need to know output happened (the monitor peek, turn
 * completion).
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

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
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
import type { PtyHostClient } from '../../src/main/pty/host/pty-host-client';

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
      return { dispose: () => { dataHandler = null; } };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
      return { dispose: () => { exitHandler = null; } };
    }),
    write: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      mockPty.cols = cols;
      mockPty.rows = rows;
    }),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler?.({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
  };
}

/** Let the 16ms flush land. */
function waitForFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
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

  it('fires for a subscribed unfocused session, where "data" does not', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-unfocused');
    // Focus a DIFFERENT session, so this one is explicitly excluded.
    manager.setFocusedSessions(['some-other-session-id']);
    manager.subscribeDataTap(session.id);

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    const output = 'hello from a background session';
    feedData(output);
    await waitForFlush();

    // The third argument is the parser offset just past the chunk (here the
    // first and only output, so its length).
    expect(dataTapListener).toHaveBeenCalledWith(session.id, output, output.length);
    expect(dataListener).not.toHaveBeenCalled();
  });

  it('forwards the host\'s parser end offset as the third "data-tap" argument', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-end-offset');

    // Flush the first two feeds before the tap exists: the offset counts every
    // character the parser received, tapped or not, so the tapped chunk below
    // must report 9 + 7 + 6 = 22, not its own length. (Coalesced into one
    // flush, the tap would deliver all three feeds as one chunk instead.)
    feedData('unwatched');
    await waitForFlush();
    feedData('earlier');
    await waitForFlush();

    manager.subscribeDataTap(session.id);
    const dataTapListener = vi.fn();
    manager.on('data-tap', dataTapListener);

    feedData('tapped');
    await waitForFlush();

    expect(dataTapListener).toHaveBeenCalledTimes(1);
    expect(dataTapListener).toHaveBeenCalledWith(session.id, 'tapped', 22);
  });

  it('sends no bytes for a session nobody subscribed to, and stops when the last subscription goes', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-unsubscribed');
    const dataTapListener = vi.fn();
    manager.on('data-tap', dataTapListener);

    const unwatchedOutput = 'nobody is watching';
    feedData(unwatchedOutput);
    await waitForFlush();
    expect(dataTapListener).not.toHaveBeenCalled();

    // Two holders: the tap stays on until both release. Offsets keep counting
    // the unwatched feed above: the parser received those characters too.
    const releaseFirst = manager.subscribeDataTap(session.id);
    const releaseSecond = manager.subscribeDataTap(session.id);
    const twoHoldersOutput = 'two holders';
    feedData(twoHoldersOutput);
    await waitForFlush();
    expect(dataTapListener).toHaveBeenCalledWith(
      session.id,
      twoHoldersOutput,
      unwatchedOutput.length + twoHoldersOutput.length,
    );

    releaseFirst();
    releaseFirst(); // a second call of the same release is a no-op
    const oneHolderOutput = 'one holder left';
    feedData(oneHolderOutput);
    await waitForFlush();
    expect(dataTapListener).toHaveBeenCalledWith(
      session.id,
      oneHolderOutput,
      unwatchedOutput.length + twoHoldersOutput.length + oneHolderOutput.length,
    );

    releaseSecond();
    dataTapListener.mockClear();
    feedData('released');
    await waitForFlush();
    expect(dataTapListener).not.toHaveBeenCalled();
  });

  it('reports output on "output-seen" for every session, subscribed or not, without its bytes', async () => {
    const { session, feedData } = await spawnSession('task-output-seen');
    const outputSeenListener = vi.fn();
    manager.on('output-seen', outputSeenListener);

    feedData('anything');

    expect(outputSeenListener).toHaveBeenCalledWith(session.id);
  });

  it('does not feed the focused-session backpressure accounting for an unfocused session', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-backpressure');
    manager.setFocusedSessions(['some-other-session-id']);
    manager.subscribeDataTap(session.id);

    feedData('x'.repeat(1024));
    // Wait for the flush so this covers the flushed state, not the pre-flush
    // window where inFlightBytes would trivially still read 0.
    await waitForFlush();

    const stats = (await manager.getPipelineStats()).find((entry) => entry.sessionId === session.id);
    expect(stats?.inFlightBytes).toBe(0);
  });

  it('still fires alongside "data" for a focused session (a tap is in addition to, not instead of)', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-focused');
    manager.setFocusedSessions([session.id]);
    manager.subscribeDataTap(session.id);

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    const output = 'hello from a focused session';
    feedData(output);
    await waitForFlush();

    expect(dataTapListener).toHaveBeenCalledWith(session.id, output, output.length);
    expect(dataListener).toHaveBeenCalledWith(session.id, output);
  });

  it('default-closed: with no setFocusedSessions call, "data" never fires while a tap does', async () => {
    // Before the renderer's first SESSION_SET_FOCUSED push, NO session's
    // output goes over IPC (the empty set used to mean "all focused" and
    // fanned every session out). Red-green: fails if the size===0 escape
    // is ever restored in session-manager.ts's gate.
    const { session, feedData } = await spawnSession('task-data-tap-default');
    manager.subscribeDataTap(session.id);

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    const output = 'output before any focus sync';
    feedData(output);
    await waitForFlush();

    expect(dataTapListener).toHaveBeenCalledWith(session.id, output, output.length);
    expect(dataListener).not.toHaveBeenCalled();
  });

  it('an explicitly empty focused set stops "data" again (Backlog view / hidden panel)', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-empty-set');
    manager.setFocusedSessions([session.id]);

    const dataListener = vi.fn();
    manager.on('data', dataListener);

    feedData('while focused');
    await waitForFlush();
    expect(dataListener).toHaveBeenCalledTimes(1);

    // The renderer derives [] when no terminal is visible; that must close
    // the gate, not open the floodgates for every session.
    manager.setFocusedSessions([]);
    feedData('after focus cleared');
    await waitForFlush();

    expect(dataListener).toHaveBeenCalledTimes(1);
  });

  it('forwards replay-drained bytes to a tap without emitting "data" or feeding backpressure', async () => {
    const { session, feedData } = await spawnSession('task-data-tap-replay-drain');
    // Focused is the strong case: 'data' WOULD fire here if the drain report
    // were ever miswired into the renderer emit.
    manager.setFocusedSessions([session.id]);
    manager.subscribeDataTap(session.id);

    const dataTapListener = vi.fn();
    const dataListener = vi.fn();
    manager.on('data-tap', dataTapListener);
    manager.on('data', dataListener);

    const drainedOutput = 'drained before flush';
    feedData(drainedOutput);
    // Sample inside the 16ms flush window: the replay's double-delivery guard
    // drains the pending bytes out of the buffer, so they never reach onFlush.
    // Before the onDrain seam existed, a phone streaming this session simply
    // lost them whenever a desktop terminal mounted the same session.
    await manager.getScrollback(session.id);

    // The drain report carries its parser end offset like a flush does.
    expect(dataTapListener).toHaveBeenCalledWith(session.id, drainedOutput, drainedOutput.length);
    // The renderer emit stays suppressed: the desktop gets these bytes inside
    // the replay payload it just requested, and a second 'data' delivery is
    // exactly the duplicate the drain exists to prevent.
    expect(dataListener).not.toHaveBeenCalled();

    // The emptied flush stays silent - no second tap delivery either.
    await waitForFlush();
    expect(dataTapListener).toHaveBeenCalledTimes(1);
    expect(dataListener).not.toHaveBeenCalled();

    // Drained bytes never ride the renderer's 'data' channel, so they must
    // not enter its backpressure accounting.
    const stats = (await manager.getPipelineStats()).find((entry) => entry.sessionId === session.id);
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
    await waitForFlush();

    expect(firstOutputListener).toHaveBeenCalledTimes(1);
  });

  it('getSeedFrame asks the host to settle for a session with a live PTY and not for one without', async () => {
    // The settle waits for a SIGWINCH repaint, which only a live PTY can
    // deliver; for a suspended or unknown session it would burn its deadline
    // against a repaint that cannot come.
    const { session, feedData } = await spawnSession('task-seed-settle-flag');
    const hostClient = (manager as unknown as { host: PtyHostClient }).host;
    // Passthrough spy: the real host still answers, so the seed itself is checked too.
    const getSeedFrameSpy = vi.spyOn(hostClient, 'getSeedFrame');

    const output = 'seed me';
    feedData(output);
    const liveSeed = await manager.getSeedFrame(session.id);
    expect(getSeedFrameSpy).toHaveBeenLastCalledWith(session.id, true);
    expect(liveSeed.barrierOffset).toBe(output.length);
    expect(liveSeed.frame).toContain(output);

    // Suspend keeps the registry row but drops its PTY. Check that precondition
    // directly, so a suspend that deleted the row cannot turn this into the
    // unknown-id case below.
    await manager.suspend(session.id);
    spawnedSessionId = null;
    const registry = (manager as unknown as {
      registry: { get(sessionId: string): { pty?: unknown } | undefined };
    }).registry;
    const suspendedRow = registry.get(session.id);
    expect(suspendedRow).toBeDefined();
    expect(suspendedRow?.pty).toBeFalsy();

    await manager.getSeedFrame(session.id);
    expect(getSeedFrameSpy).toHaveBeenLastCalledWith(session.id, false);

    // A session the registry has never heard of takes the same no-settle path.
    await manager.getSeedFrame('no-such-session');
    expect(getSeedFrameSpy).toHaveBeenLastCalledWith('no-such-session', false);
  });

  it('getPipelineStats reports focused: false by default and true only for the session passed to setFocusedSessions', async () => {
    // Default-closed, matching the 'data'-event gate above: getPipelineStats's
    // `focused` field must NOT fall back to "true for everyone" when the
    // focused set is empty. Red-green: fails if the `size === 0` all-focused
    // escape is ever restored to session-manager.ts's getPipelineStats.
    const { session: sessionA } = await spawnSession('task-pipeline-stats-focus-a');
    const { session: sessionB } = await spawnSession('task-pipeline-stats-focus-b');

    const statsBefore = await manager.getPipelineStats();
    expect(statsBefore.find((entry) => entry.sessionId === sessionA.id)?.focused).toBe(false);
    expect(statsBefore.find((entry) => entry.sessionId === sessionB.id)?.focused).toBe(false);

    manager.setFocusedSessions([sessionA.id]);
    const statsAfter = await manager.getPipelineStats();
    expect(statsAfter.find((entry) => entry.sessionId === sessionA.id)?.focused).toBe(true);
    expect(statsAfter.find((entry) => entry.sessionId === sessionB.id)?.focused).toBe(false);

    // spawnSession's afterEach cleanup only tracks the LAST spawned session;
    // suspend sessionA explicitly since this test spawned two.
    await manager.suspend(sessionA.id);
  });
});
