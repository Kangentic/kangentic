/**
 * The pty host core (src/main/pty/host/pty-host-core.ts) and main's client
 * (pty-host-client.ts), driven directly over a mocked node-pty.
 *
 * The host owns every PTY and the per-chunk work on its output, so these pin
 * what main and the renderers rely on it for: output reaches a renderer's port
 * only for a session that renderer shows and main only for a tapped one, a
 * renderer's keystrokes share the PTY's write queue with main's writes, the
 * scrollback answer leaves on the asking renderer's port after the output
 * before it, the utility process merges its "output happened" events instead of
 * sending one per chunk, a spawn failure hands back the carry-over, a PTY whose
 * program is the app's own executable is refused as a failed spawn, and a
 * RemotePty behaves like a dead node-pty once the host reports the exit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as nodePty from 'node-pty';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import {
  NODE_PTY_CONNECT_TIMEOUT_MS,
  PTY_OUTPUT_NOT_CONNECTED_CODE,
  ROOT_PID_POLL_MS,
  ROOT_PID_WAIT_LIMIT_MS,
  SPAWN_REQUEST_TIMEOUT_MS,
} from '../../src/main/pty/host/root-pid-gate';
import type { PtyBufferManager } from '../../src/main/pty/buffer/pty-buffer-manager';
import {
  BACKPRESSURE_HIGH_WATER,
  BACKPRESSURE_LOW_WATER,
  PENDING_HIGH_WATER,
  PENDING_LOW_WATER,
  STALE_PAUSE_CHECK_MS,
  STALE_PAUSE_MS,
} from '../../src/main/pty/buffer/backpressure-controller';
import { setSyncSpanLabelSink } from '../../src/main/diagnostics/event-loop-lag';
import { setMainExecutable } from '../../src/main/pty/host/host-exec';
import { InProcessPtyHostTransport, PtyHostClient, RemotePty, type PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostCommand, PtyHostEvent, PtyHostRawSpawnParams, PtyHostSpawnParams } from '../../src/main/pty/host/protocol';
import { HostUnavailableError } from '../../src/main/utility-process/off-main-pty';
import type { AgentParser } from '../../src/shared/types';
import type { FromPtyHostPortMessage } from '../../src/shared/pty-port-protocol';
import { createFakeRendererPort, type FakeRendererPort } from './helpers/fake-renderer-port';

/** The renderer every core here has a port for. */
const TEST_RENDERER = 1;

/** What main heard (host events) and the test renderer got (its port's messages), in one ordered list. */
type HostOutput = PtyHostEvent | FromPtyHostPortMessage;

interface FakePty {
  pty: nodePty.IPty;
  feed(data: string): void;
  exit(exitCode: number): void;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  /** Called when the host disposes its onData subscription. */
  disposeData: ReturnType<typeof vi.fn>;
  /** Called when the host disposes its onExit subscription. */
  disposeExit: ReturnType<typeof vi.fn>;
}

function createFakePty(pid = 4242): FakePty {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  const write = vi.fn();
  const kill = vi.fn();
  const disposeData = vi.fn();
  const disposeExit = vi.fn();
  const pty = {
    pid,
    cols: 120,
    rows: 30,
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
      return { dispose: () => { disposeData(); dataListener = null; } };
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => { disposeExit(); exitListener = null; } };
    },
    write,
    resize: vi.fn(),
    kill,
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as nodePty.IPty;
  return {
    pty,
    feed: (data) => dataListener?.(data),
    exit: (exitCode) => exitListener?.({ exitCode }),
    write,
    kill,
    disposeData,
    disposeExit,
  };
}

function spawnParams(overrides: Partial<PtyHostSpawnParams> = {}): PtyHostSpawnParams {
  return {
    ptyId: 1,
    sessionId: 'session-1',
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'bash',
    args: [],
    cwd: '/mock/project',
    env: {},
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
    ...overrides,
  };
}

function rawSpawnParams(overrides: Partial<PtyHostRawSpawnParams> = {}): PtyHostRawSpawnParams {
  return {
    ptyId: 9,
    file: 'claude',
    args: ['--safe-mode'],
    cwd: '/mock/scratch',
    env: {},
    cols: 120,
    rows: 40,
    name: 'xterm-256color',
    ...overrides,
  };
}

function makeCore(options: { coalesceMs?: number; agent?: AgentParser; fake?: FakePty; platform?: NodeJS.Platform } = {}) {
  const events: HostOutput[] = [];
  const fake = options.fake ?? createFakePty();
  const appended: Array<{ sessionId: string; chunk: string }> = [];
  const spawnPty = vi.fn((_file: string, _args: string[], _options: object) => fake.pty);
  const core = new PtyHostCore({
    emit: (event) => events.push(event),
    resolveAgent: () => options.agent,
    transcriptSinkFor: () => ({ appendChunk: (sessionId, chunk) => appended.push({ sessionId, chunk }) }),
    coalesceMs: options.coalesceMs ?? 0,
    spawnPty: spawnPty as unknown as typeof nodePty.spawn,
    // Linux unless a test asks, so the Windows-only paths (the post-exit
    // release) run the same on a Windows machine as on CI.
    platform: options.platform ?? 'linux',
  });
  // The renderer's own port: its output lands in `events` beside main's.
  const port: FakeRendererPort = createFakeRendererPort((message) => events.push(message));
  core.attachRendererPort(TEST_RENDERER, port.port);
  return { core, events, fake, appended, spawnPty, port };
}

/** Let the 16ms flush run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20);
}

describe('PtyHostCore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a session\'s output to the renderer only while it shows it, and to main only while tapped', async () => {
    const { core, events, fake } = makeCore();
    core.spawn(spawnParams());

    fake.feed('unwatched');
    await flush();
    expect(events.filter((event) => event.type === 'data' || event.type === 'tap')).toEqual([]);

    core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
    fake.feed('focused');
    await flush();
    expect(events).toContainEqual({ type: 'data', sessionId: 'session-1', data: 'focused' });

    core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: [] });
    core.handleCommand({ type: 'setTapped', sessionIds: ['session-1'] });
    fake.feed('tapped');
    await flush();
    // The offset counts every character the parser received, tapped or not:
    // 'unwatched' + 'focused' + 'tapped' is 22.
    expect(events).toContainEqual({ type: 'tap', sessionId: 'session-1', data: 'tapped', endOffset: 22 });
    expect(events).not.toContainEqual({ type: 'data', sessionId: 'session-1', data: 'tapped' });
  });

  describe('a pending buffer that piles up (the flood that once grew to the string limit)', () => {
    // A PTY delivers 64 KB reads; a megabyte a tick is four times what one
    // flush slice drains.
    const READ = 'x'.repeat(64 * 1024);
    const READS_PER_TICK = 16;
    const MEGABYTE = READ.length * READS_PER_TICK;
    /** What one flush ships to a consumer (MAX_BYTES_PER_FLUSH in the buffer manager). */
    const FLUSH_SLICE_CHARS = 256 * 1024;
    const TICKS_PAST_HIGH_WATER = Math.ceil(PENDING_HIGH_WATER / (READ.length * READS_PER_TICK)) * 2;

    function feedOneTick(fake: FakePty): void {
      for (let read = 0; read < READS_PER_TICK; read++) fake.feed(READ);
    }

    it('pauses a watched PTY past the high water and resumes it once the slices are drained and acknowledged', async () => {
      const { core, events, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      // The renderer acknowledges every slice it gets, as a fast one does, so
      // in-flight never pauses it: only the pending buffer can.
      let acknowledged = 0;
      const acknowledgeDelivered = (): void => {
        const delivered = events.reduce((total, event) => total + (event.type === 'data' ? event.data.length : 0), 0);
        port.send({ type: 'ack', sessionId: 'session-1', bytes: delivered - acknowledged });
        acknowledged = delivered;
      };

      for (let tick = 0; tick < TICKS_PAST_HIGH_WATER && !vi.mocked(fake.pty.pause).mock.calls.length; tick++) {
        feedOneTick(fake);
        await flush();
        acknowledgeDelivered();
      }
      expect(fake.pty.pause).toHaveBeenCalledTimes(1);

      // Paused, the PTY delivers nothing more; the backlog drains a slice a tick.
      for (let tick = 0; tick < 40 && !vi.mocked(fake.pty.resume).mock.calls.length; tick++) {
        await flush();
        acknowledgeDelivered();
      }
      expect(fake.pty.resume).toHaveBeenCalledTimes(1);
    });

    it('drains an unwatched session whole every tick, so it never pauses', async () => {
      const { core, fake } = makeCore();
      core.spawn(spawnParams());

      for (let tick = 0; tick < TICKS_PAST_HIGH_WATER; tick++) {
        feedOneTick(fake);
        await flush();
      }

      expect(fake.pty.pause).not.toHaveBeenCalled();
      expect(core.getDiagnostics().pipeline[0].pendingBytes).toBe(0);
    });

    it('slices a tapped session\'s flush like a focused one, though no renderer shows it', async () => {
      const { core, events, fake } = makeCore();
      core.spawn(spawnParams());
      // Tapped and never focused: a phone streams it, so its taps are the only
      // consumer of the flush. A flush nobody receives drains whole (the test
      // above); one a phone receives is sliced to what one message can carry.
      core.handleCommand({ type: 'setTapped', sessionIds: ['session-1'] });

      fake.feed('x'.repeat(MEGABYTE));
      await flush();

      const taps = events.filter((event): event is Extract<PtyHostEvent, { type: 'tap' }> => event.type === 'tap');
      expect(events.filter((event) => event.type === 'data')).toEqual([]);
      expect(taps.length).toBeGreaterThan(0);
      expect(taps[0].data.length).toBeLessThanOrEqual(FLUSH_SLICE_CHARS);
      // The rest of the megabyte waits for the next tick instead of riding this one.
      const tapped = taps.reduce((total, tap) => total + tap.data.length, 0);
      const { pendingBytes } = core.getDiagnostics().pipeline[0];
      expect(pendingBytes).toBeGreaterThan(0);
      expect(pendingBytes).toBe(MEGABYTE - tapped);
    });

    it('resumes a PTY the backlog paused as soon as a replay sample drains the pending buffer', async () => {
      const { core, events, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      // The renderer acknowledges every slice it gets, so in-flight stays low and
      // only the pending buffer can have paused the PTY.
      let acknowledged = 0;
      const acknowledgeDelivered = (): void => {
        const delivered = events.reduce((total, event) => total + (event.type === 'data' ? event.data.length : 0), 0);
        port.send({ type: 'ack', sessionId: 'session-1', bytes: delivered - acknowledged });
        acknowledged = delivered;
      };
      for (let tick = 0; tick < TICKS_PAST_HIGH_WATER && !vi.mocked(fake.pty.pause).mock.calls.length; tick++) {
        feedOneTick(fake);
        await flush();
        acknowledgeDelivered();
      }
      expect(fake.pty.pause).toHaveBeenCalledTimes(1);

      // The slices alone are far from resuming it: a slice a tick, and the pending
      // buffer is still several times the low water. Only the in-flight half of the
      // resume condition is met, so the drain below is the one thing that changes.
      const beforeReplay = core.getDiagnostics().pipeline[0];
      expect(beforeReplay.paused).toBe(true);
      expect(beforeReplay.pendingBytes).toBeGreaterThan(PENDING_LOW_WATER);
      expect(beforeReplay.inFlightBytes).toBeLessThanOrEqual(BACKPRESSURE_LOW_WATER);
      expect(fake.pty.resume).not.toHaveBeenCalled();

      // The session is in the normal buffer, so this is the byte replay: it takes
      // the whole pending buffer into its reply. No timer advances after it, so
      // no flush could have been what resumed the PTY.
      await core.handleRequest('getScrollback', { sessionId: 'session-1', settle: false });

      expect(core.getDiagnostics().pipeline[0]).toMatchObject({ pendingBytes: 0, paused: false });
      expect(fake.pty.resume).toHaveBeenCalledTimes(1);
    });
  });

  describe('a pause no ack answers (a page whose terminals are gone keeps its port and its focus, task #912)', () => {
    const READ = 'x'.repeat(64 * 1024);
    const MAX_READS = Math.ceil(BACKPRESSURE_HIGH_WATER / READ.length) * 2;

    /** Feed unacked PTY reads, a flush each, until the PTY has been paused `pauses` times. */
    async function feedUntilPaused(fake: FakePty, pauses: number): Promise<void> {
      for (let read = 0; read < MAX_READS && vi.mocked(fake.pty.pause).mock.calls.length < pauses; read++) {
        fake.feed(READ);
        await flush();
      }
    }

    /** A session the test renderer shows and never acks, paused at the in-flight high water. */
    async function pausedForNobody() {
      const made = makeCore();
      made.core.spawn(spawnParams());
      made.core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      await feedUntilPaused(made.fake, 1);
      expect(made.fake.pty.pause).toHaveBeenCalledTimes(1);
      expect(made.core.getDiagnostics().pipeline[0]).toMatchObject({ paused: true });
      return made;
    }

    /**
     * Watch the stale-pause check's timer. The core owns other timers too (the
     * flush, the root-pid poll), so `vi.getTimerCount()` would count them; this
     * follows only the intervals started at the check's own period. Install it
     * before the session pauses and `restore()` it in a `finally`, inside the
     * test, so the fake `setInterval` is back on the global before the outer
     * `afterEach` turns the fake timers off.
     */
    function watchStalePauseCheck() {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const started = (): unknown[] => setIntervalSpy.mock.results
        .filter((_result, index) => setIntervalSpy.mock.calls[index][1] === STALE_PAUSE_CHECK_MS)
        .map((result) => result.value as unknown);
      return {
        /** Every check interval started, running or since cleared. */
        startedCount: (): number => started().length,
        /** The check intervals started and not yet cleared. */
        runningCount: (): number => {
          const cleared = clearIntervalSpy.mock.calls.map((call) => call[0] as unknown);
          return started().filter((handle) => !cleared.includes(handle)).length;
        },
        restore: (): void => {
          setIntervalSpy.mockRestore();
          clearIntervalSpy.mockRestore();
        },
      };
    }

    it('starts no stale-pause check while nothing is paused, however much a watched session emits', async () => {
      const watch = watchStalePauseCheck();
      try {
        const { core, fake } = makeCore();
        core.spawn(spawnParams());
        core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });

        // Unacked output on a session a renderer shows, a quarter of the high
        // water in all: the pause arms the check, the emit alone does not.
        for (let read = 0; read < 4; read++) {
          fake.feed(READ);
          await flush();
        }

        const pipeline = core.getDiagnostics().pipeline[0];
        // The output did reach the emit path, so a check armed per emit would show.
        expect(pipeline.inFlightBytes).toBeGreaterThan(0);
        expect(pipeline.paused).toBe(false);
        expect(watch.startedCount()).toBe(0);
      } finally {
        watch.restore();
      }
    });

    it('starts exactly one stale-pause check once a session pauses, and no second as it keeps emitting', async () => {
      const watch = watchStalePauseCheck();
      try {
        const { core, fake } = await pausedForNobody();
        expect(watch.startedCount()).toBe(1);
        expect(watch.runningCount()).toBe(1);

        const inFlightBefore = core.getDiagnostics().pipeline[0].inFlightBytes;
        fake.feed(READ);
        await flush();

        // More paused output reached the emit path and found the check already armed.
        expect(core.getDiagnostics().pipeline[0].inFlightBytes).toBeGreaterThan(inFlightBefore);
        expect(watch.startedCount()).toBe(1);
        expect(watch.runningCount()).toBe(1);
      } finally {
        watch.restore();
      }
    });

    it('stops the stale-pause check once its release leaves nothing paused', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const watch = watchStalePauseCheck();
      try {
        const { core, fake } = await pausedForNobody();
        expect(watch.runningCount()).toBe(1);

        // Past the stale bound plus a check period or two, as the release test below waits.
        await vi.advanceTimersByTimeAsync(STALE_PAUSE_MS + STALE_PAUSE_CHECK_MS * 2);

        expect(fake.pty.resume).toHaveBeenCalledTimes(1);
        expect(core.getDiagnostics().pipeline[0]).toMatchObject({ paused: false });
        // Nothing is paused, so the host runs no timer: cleared, and not replaced.
        expect(watch.runningCount()).toBe(0);
        expect(watch.startedCount()).toBe(1);
      } finally {
        watch.restore();
        warn.mockRestore();
      }
    });

    it('stops the stale-pause check on shutdown and starts none after it, though the session is still paused', async () => {
      const watch = watchStalePauseCheck();
      try {
        const { core, fake } = await pausedForNobody();
        expect(watch.runningCount()).toBe(1);

        core.handleCommand({ type: 'shutdown' });
        expect(watch.runningCount()).toBe(0);

        // Shutdown kills nothing, so the PTY is still paused and still emitting
        // into the flush: the emit path would re-arm the check without the guard.
        const inFlightBefore = core.getDiagnostics().pipeline[0].inFlightBytes;
        fake.feed(READ);
        await flush();

        const pipeline = core.getDiagnostics().pipeline[0];
        expect(pipeline.paused).toBe(true);
        expect(pipeline.inFlightBytes).toBeGreaterThan(inFlightBefore);
        expect(watch.startedCount()).toBe(1);
        expect(watch.runningCount()).toBe(0);
      } finally {
        watch.restore();
      }
    });

    it('resumes the PTY once nothing has acked it for the stale bound, then pauses only at the raised high water until an ack', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { core, fake, port } = await pausedForNobody();

        // Paused, the PTY reads nothing, so no flush comes along: the host's timer has to notice.
        await vi.advanceTimersByTimeAsync(STALE_PAUSE_MS - STALE_PAUSE_CHECK_MS);
        expect(fake.pty.resume).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(STALE_PAUSE_CHECK_MS * 2);
        expect(fake.pty.resume).toHaveBeenCalledTimes(1);
        expect(core.getDiagnostics().pipeline[0]).toMatchObject({ paused: false, inFlightBytes: 0 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no ack for'));

        // Released: twice the high water more, still unacked, stays under the raised cap.
        for (let read = 0; read < MAX_READS; read++) {
          fake.feed(READ);
          await flush();
        }
        expect(fake.pty.pause).toHaveBeenCalledTimes(1);

        // An ack shows a renderer consuming again, and the normal high water is back.
        port.send({ type: 'ack', sessionId: 'session-1', bytes: READ.length });
        await feedUntilPaused(fake, 2);
        expect(fake.pty.pause).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });

    it('never releases a pause its renderer keeps acking, however long it lasts', async () => {
      const { fake, port } = await pausedForNobody();
      // Three times the bound in all, an ack every 5 s, each far short of the low water.
      for (let step = 0; step < 6; step++) {
        await vi.advanceTimersByTimeAsync(STALE_PAUSE_MS / 2);
        port.send({ type: 'ack', sessionId: 'session-1', bytes: 1 });
      }
      expect(fake.pty.resume).not.toHaveBeenCalled();
    });

    it('stops looking on shutdown', async () => {
      const { core, fake } = await pausedForNobody();
      core.handleCommand({ type: 'shutdown' });
      await vi.advanceTimersByTimeAsync(STALE_PAUSE_MS * 2);
      // The timer went with the shutdown, so the session stays as main left it.
      expect(fake.pty.resume).not.toHaveBeenCalled();
    });
  });

  describe('the answer to input flushes on the next loop turn (the write command stamps the session)', () => {
    // In the alt screen, output within 250 ms of input to the session's PTY is
    // the answer someone waits on, and flushes on the next loop turn instead of
    // the 16 ms timer. PtyBufferManager pins the timing; these pin that the
    // host core's `write` command is what stamps the input.
    const dataEvents = (events: HostOutput[]) => events.filter((event): event is Extract<FromPtyHostPortMessage, { type: 'data' }> => event.type === 'data');

    /** A focused session already in the alt screen, as a fullscreen agent's is, with the enter flushed. */
    async function altScreenSession() {
      const created = makeCore();
      created.core.spawn(spawnParams());
      created.core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      created.fake.feed('\x1b[?1049h');
      await flush();
      created.events.length = 0;
      return created;
    }

    it('flushes a session\'s output on the next loop turn once input was written to its PTY, not on the 16 ms timer', async () => {
      const { core, events, fake } = await altScreenSession();

      core.handleCommand({ type: 'write', ptyId: 1, data: 'x' });
      expect(fake.write).toHaveBeenCalledWith('x');
      fake.feed('repaint for a keystroke');
      // Never synchronous: chunks read in the same loop turn still leave together.
      expect(dataEvents(events)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(dataEvents(events)).toEqual([{ type: 'data', sessionId: 'session-1', data: 'repaint for a keystroke' }]);
    });

    it('batches the same output on the 16 ms timer when no input was written before it', async () => {
      const { events, fake } = await altScreenSession();

      fake.feed('repaint with no keystroke');
      await vi.advanceTimersByTimeAsync(1);
      expect(dataEvents(events)).toEqual([]);
      await flush();

      expect(dataEvents(events)).toEqual([{ type: 'data', sessionId: 'session-1', data: 'repaint with no keystroke' }]);
    });

    it('stamps only the session whose PTY was written to: another session and a raw PTY write leave the rest on the timer', async () => {
      const first = createFakePty(4242);
      const second = createFakePty(4343);
      const raw = createFakePty(4444);
      const { core, events, spawnPty } = makeCore({ fake: first });
      core.spawn(spawnParams({ ptyId: 1, sessionId: 'session-1' }));
      spawnPty.mockReturnValueOnce(second.pty);
      core.spawn(spawnParams({ ptyId: 2, sessionId: 'session-2' }));
      spawnPty.mockReturnValueOnce(raw.pty);
      core.spawnRaw(rawSpawnParams({ ptyId: 9 }));
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1', 'session-2'] });
      first.feed('\x1b[?1049h');
      second.feed('\x1b[?1049h');
      await flush();
      events.length = 0;

      core.handleCommand({ type: 'write', ptyId: 9, data: 'probe input' });
      core.handleCommand({ type: 'write', ptyId: 2, data: 'x' });
      expect(raw.write).toHaveBeenCalledWith('probe input');
      expect(second.write).toHaveBeenCalledWith('x');
      expect(first.write).not.toHaveBeenCalled();
      first.feed('output of the session nobody typed into');
      second.feed('output of the session that got the keystroke');
      await vi.advanceTimersByTimeAsync(1);

      expect(dataEvents(events)).toEqual([{ type: 'data', sessionId: 'session-2', data: 'output of the session that got the keystroke' }]);
      await flush();
      expect(dataEvents(events).map((event) => event.sessionId)).toEqual(['session-2', 'session-1']);
    });
  });

  describe('a renderer\'s own port (keystrokes and echo never cross main)', () => {
    it('writes a keystroke from the port to the session\'s live PTY at once, and stamps it as input', async () => {
      const { core, events, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      fake.feed('\x1b[?1049h');
      await flush();
      events.length = 0;
      port.received.length = 0;

      port.send({ type: 'write', sessionId: 'session-1', data: 'x' });
      expect(fake.write).toHaveBeenCalledWith('x');
      fake.feed('echo of x');
      await vi.advanceTimersByTimeAsync(1);
      // The echo came back on the port on the next loop turn. Main heard only
      // what carries no bytes: the draft changed, a human used the session
      // (once) and output happened.
      expect(port.received).toEqual([{ type: 'data', sessionId: 'session-1', data: 'echo of x' }]);
      expect(events.filter((event) => !port.received.includes(event as FromPtyHostPortMessage)).map((event) => event.type))
        .toEqual(['promptDraft', 'userInput', 'outputSeen']);
    });

    it('sends each session\'s output only to the renderers that show it', async () => {
      const first = createFakePty(4242);
      const second = createFakePty(4343);
      const { core, fake: firstFake, spawnPty, port: firstPort } = makeCore({ fake: first });
      core.spawn(spawnParams({ ptyId: 1, sessionId: 'session-1' }));
      spawnPty.mockReturnValueOnce(second.pty);
      core.spawn(spawnParams({ ptyId: 2, sessionId: 'session-2' }));
      const secondPort = createFakeRendererPort();
      core.attachRendererPort(2, secondPort.port);
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      core.handleCommand({ type: 'setRendererFocus', rendererId: 2, sessionIds: ['session-1', 'session-2'] });

      firstFake.feed('one');
      second.feed('two');
      await flush();
      expect(firstPort.received).toEqual([{ type: 'data', sessionId: 'session-1', data: 'one' }]);
      expect(secondPort.received).toEqual(expect.arrayContaining([
        { type: 'data', sessionId: 'session-1', data: 'one' },
        { type: 'data', sessionId: 'session-2', data: 'two' },
      ]));

      // A renderer that went away gets nothing more, and its sessions stop flushing to it.
      core.handleCommand({ type: 'forgetRenderer', rendererId: 2 });
      expect(secondPort.closed).toBe(true);
      second.feed('after');
      await flush();
      expect(secondPort.received.filter((message) => message.type === 'data')).toHaveLength(2);
    });

    it('keeps a keystroke out of a paste main is still writing: one queue per PTY, in arrival order', async () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      // Over the atomic cap, so the queue writes it in 4 KB chunks across loop turns.
      const paste = `\x1b[200~${'p'.repeat(20 * 1024)}\x1b[201~`;
      core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: paste, origin: 'system' });
      expect(fake.write.mock.calls.length).toBe(1);
      port.send({ type: 'write', sessionId: 'session-1', data: 'k' });
      await vi.runAllTimersAsync();

      // In chunks, and the key only after the paste's close marker.
      const written = fake.write.mock.calls.map((call) => call[0] as string);
      expect(written.length).toBeGreaterThan(2);
      expect(written.join('')).toBe(`${paste}k`);
      await expect(core.handleRequest('drainWrites', { ptyId: 1 })).resolves.toBe(true);
    });

    it('drops a renderer\'s keystrokes once main sealed the PTY, while main\'s direct writes still reach it', () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'sealUserInput', ptyId: 1 });

      port.send({ type: 'write', sessionId: 'session-1', data: 'typed during the exit grace' });
      core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: 'queued after the seal', origin: 'system' });
      core.handleCommand({ type: 'write', ptyId: 1, data: '\x1b' });

      expect(fake.write.mock.calls.map((call) => call[0])).toEqual(['\x1b']);
    });

    it('drops a malformed port message instead of throwing on it', () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      const send = port.send as (message: unknown) => void;
      expect(() => send({ type: 'write', sessionId: 'session-1' })).not.toThrow();
      expect(() => send('not an object')).not.toThrow();
      expect(() => send({ type: 'ack', sessionId: 'session-1', bytes: 'many' })).not.toThrow();
      expect(fake.write).not.toHaveBeenCalled();
    });

    it('answers a renderer\'s scrollback on its port, after the output flushed before the sample and before what follows it', async () => {
      const { core, events, fake } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      fake.feed('flushed before ');
      await flush();
      // Pending, not flushed, when the sample is taken: it goes into the answer only.
      fake.feed('pending at the sample');
      const answer = await core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: false, rendererId: TEST_RENDERER, requestId: 7 });
      fake.feed('after the sample');
      await flush();

      expect(answer).toEqual({ sentToPort: true });
      const portMessages = events.filter((event) => event.type === 'data' || event.type === 'scrollback');
      expect(portMessages.map((message) => message.type)).toEqual(['data', 'scrollback', 'data']);
      const scrollback = portMessages[1] as Extract<FromPtyHostPortMessage, { type: 'scrollback' }>;
      expect(scrollback.requestId).toBe(7);
      expect(scrollback.data).toContain('pending at the sample');
      expect(portMessages[2]).toEqual({ type: 'data', sessionId: 'session-1', data: 'after the sample' });
    });

    it('answers main with the sample when it holds no port for that renderer', async () => {
      const { core, fake } = makeCore();
      core.spawn(spawnParams());
      fake.feed('some output');
      const answer = await core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: false, rendererId: 99, requestId: 1 });
      expect(answer).toMatchObject({ sentToPort: false });
      expect((answer as { data: string }).data).toContain('some output');
    });

    describe('a scrollback answer goes only to the port that asked, while it is still the current one', () => {
      const scrollbackMessages = (fake: FakeRendererPort) => fake.received.filter((message) => message.type === 'scrollback' || message.type === 'scrollbackFailed');

      /** Hold the next resize-repaint settle open, so the sample is still pending while the test changes ports. */
      function holdResizeSettle(core: PtyHostCore): { release(): void; fail(reason: unknown): void } {
        const bufferManager = (core as unknown as { bufferManager: PtyBufferManager }).bufferManager;
        let release: () => void = () => {};
        let fail: (reason: unknown) => void = () => {};
        const settled = new Promise<void>((resolve, reject) => {
          release = resolve;
          fail = reject;
        });
        vi.spyOn(bufferManager, 'waitForResizeRepaint').mockReturnValue(settled);
        return { release: () => release(), fail: (reason) => fail(reason) };
      }

      it('answers on the asking port once the sample settles, when no other port took its place', async () => {
        const { core, fake, port } = makeCore();
        core.spawn(spawnParams());
        fake.feed('held for the settle');
        const settle = holdResizeSettle(core);

        const pending = core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: true, rendererId: TEST_RENDERER, requestId: 11 });
        // Nothing leaves while the settle is open.
        expect(scrollbackMessages(port)).toEqual([]);
        settle.release();

        await expect(pending).resolves.toEqual({ sentToPort: true });
        expect(scrollbackMessages(port)).toEqual([expect.objectContaining({ type: 'scrollback', requestId: 11 })]);
        expect((scrollbackMessages(port)[0] as Extract<FromPtyHostPortMessage, { type: 'scrollback' }>).data).toContain('held for the settle');
      });

      it('hands the sample back to main, and posts nothing, when a reload replaced the port while the sample settled', async () => {
        const { core, fake } = makeCore();
        core.spawn(spawnParams());
        fake.feed('sampled across a reload');
        const settle = holdResizeSettle(core);

        const pending = core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: true, rendererId: TEST_RENDERER, requestId: 1 });
        // The reloaded page numbers its requests from 1 again, so an answer on its
        // port could settle ITS request 1 with this one's data. The swap closes
        // the asking port, so the new port is the only one that could receive it.
        const reloaded = createFakeRendererPort();
        core.attachRendererPort(TEST_RENDERER, reloaded.port);
        settle.release();

        const answer = await pending;
        expect(answer).toMatchObject({ sentToPort: false });
        expect((answer as { data: string }).data).toContain('sampled across a reload');
        expect(scrollbackMessages(reloaded)).toEqual([]);
      });

      it('hands the sample back to main when the asking port closed while the sample settled', async () => {
        const { core, fake, port } = makeCore();
        core.spawn(spawnParams());
        fake.feed('sampled after the page went away');
        const settle = holdResizeSettle(core);

        const pending = core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: true, rendererId: TEST_RENDERER, requestId: 2 });
        port.disconnect();
        settle.release();

        const answer = await pending;
        expect(answer).toMatchObject({ sentToPort: false });
        expect((answer as { data: string }).data).toContain('sampled after the page went away');
      });

      it('tells the asking port the sample failed, with the error\'s message, and answers main that it was sent', async () => {
        const { core, port } = makeCore();
        core.spawn(spawnParams());
        const settle = holdResizeSettle(core);

        const pending = core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: true, rendererId: TEST_RENDERER, requestId: 5 });
        settle.fail(new Error('replay sample failed'));

        await expect(pending).resolves.toEqual({ sentToPort: true });
        expect(port.received).toContainEqual({ type: 'scrollbackFailed', requestId: 5, message: 'replay sample failed' });
        expect(port.received.some((message) => message.type === 'scrollback')).toBe(false);
      });

      it('words a failure that is not an Error as its string', async () => {
        const { core, port } = makeCore();
        core.spawn(spawnParams());
        const settle = holdResizeSettle(core);

        const pending = core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: true, rendererId: TEST_RENDERER, requestId: 6 });
        settle.fail('plain failure');

        await expect(pending).resolves.toEqual({ sentToPort: true });
        expect(port.received).toContainEqual({ type: 'scrollbackFailed', requestId: 6, message: 'plain failure' });
      });

      it('rejects to main when the sample fails and no port can take the failure', async () => {
        const { core } = makeCore();
        core.spawn(spawnParams());
        const settle = holdResizeSettle(core);

        const pending = core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: true, rendererId: 99, requestId: 3 });
        settle.fail(new Error('replay sample failed'));

        await expect(pending).rejects.toThrow('replay sample failed');
      });

      it('rejects to main, and posts nothing, when a reload replaced the asking port before the sample failed', async () => {
        const { core } = makeCore();
        core.spawn(spawnParams());
        const settle = holdResizeSettle(core);

        const pending = core.handleRequest('getScrollbackForRenderer', { sessionId: 'session-1', settle: true, rendererId: TEST_RENDERER, requestId: 1 });
        const reloaded = createFakeRendererPort();
        core.attachRendererPort(TEST_RENDERER, reloaded.port);
        settle.fail(new Error('replay sample failed'));

        // The reloaded page's own request 1 must not be failed by this one's error.
        await expect(pending).rejects.toThrow('replay sample failed');
        expect(scrollbackMessages(reloaded)).toEqual([]);
      });
    });

    it('keeps the prompt draft in the order the PTY gets the bytes, and tells main each change', () => {
      const { core, events, port } = makeCore();
      core.spawn(spawnParams());
      const drafts = () => events.filter((event) => event.type === 'promptDraft').map((event) => (event as { draft: string | null }).draft);

      port.send({ type: 'write', sessionId: 'session-1', data: 'instead' });
      port.send({ type: 'write', sessionId: 'session-1', data: ' can' });
      // An injected command's text is not the user's, but its Enter submits what was typed.
      core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: '/pull-request', origin: 'system' });
      core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: '\r', origin: 'system' });

      expect(drafts()).toEqual(['instead', 'instead can', null]);
    });

    describe('tells main once that a human used the session', () => {
      const userInputs = (events: HostOutput[]) => events.filter((event) => event.type === 'userInput');

      it("never for xterm's own replies or injected keystrokes", () => {
        const { core, events, port } = makeCore();
        core.spawn(spawnParams());

        port.send({ type: 'write', sessionId: 'session-1', data: '\x1b[?1;2c' }); // device attributes reply
        port.send({ type: 'write', sessionId: 'session-1', data: '\x1b[24;80R' }); // cursor position report
        port.send({ type: 'write', sessionId: 'session-1', data: '\x1b[I' }); // focus report
        port.send({ type: 'write', sessionId: 'session-1', data: '\x1b[<0;10;5M' }); // a click into the pane
        core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: '/model sonnet\r', origin: 'system' }); // a pill's command

        expect(userInputs(events)).toEqual([]);
      });

      it('on the first typed key from a renderer port, and only that once', () => {
        const { core, events, port } = makeCore();
        core.spawn(spawnParams());

        port.send({ type: 'write', sessionId: 'session-1', data: 'h' });
        port.send({ type: 'write', sessionId: 'session-1', data: 'i' });

        expect(userInputs(events)).toEqual([{ type: 'userInput', sessionId: 'session-1', at: expect.any(Number) }]);
      });

      it('on a user write main enqueues (dictation, the phone)', () => {
        const { core, events } = makeCore();
        core.spawn(spawnParams());

        core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: 'dictated words', origin: 'user' });

        expect(userInputs(events)).toEqual([{ type: 'userInput', sessionId: 'session-1', at: expect.any(Number) }]);
      });

      // Workflow recovery reads the user as there from recent input, so the
      // host reports it again while a person keeps typing, at most every ten
      // seconds, and never for Kangentic's own writes.
      it('again while a person keeps typing, at most every ten seconds', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          const { core, events, port } = makeCore();
          core.spawn(spawnParams());

          port.send({ type: 'write', sessionId: 'session-1', data: 'a' });
          vi.advanceTimersByTime(5_000);
          port.send({ type: 'write', sessionId: 'session-1', data: 'b' });
          expect(userInputs(events)).toHaveLength(1);

          vi.advanceTimersByTime(6_000);
          port.send({ type: 'write', sessionId: 'session-1', data: 'c' });
          core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: 'a nudge', origin: 'system' });
          expect(userInputs(events)).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      });

      // An NTP step or a VM resume can move the wall clock back. A report held
      // for "less than ten seconds since the last one" would then stay held
      // until the clock caught up, and workflow recovery would read a person
      // who is typing as gone.
      it('at once when the wall clock stepped back after a report, then throttles from the new time', () => {
        const REPORTED_AT = Date.UTC(2030, 0, 1, 12, 0, 0);
        const STEPPED_BACK_TO = REPORTED_AT - 60_000;
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(REPORTED_AT);
          const { core, events, port } = makeCore();
          core.spawn(spawnParams());

          port.send({ type: 'write', sessionId: 'session-1', data: 'a' });
          expect(userInputs(events)).toEqual([{ type: 'userInput', sessionId: 'session-1', at: REPORTED_AT }]);

          // A minute back is inside no window a forward clock would hold open.
          vi.setSystemTime(STEPPED_BACK_TO);
          port.send({ type: 'write', sessionId: 'session-1', data: 'b' });
          expect(userInputs(events)).toEqual([
            { type: 'userInput', sessionId: 'session-1', at: REPORTED_AT },
            { type: 'userInput', sessionId: 'session-1', at: STEPPED_BACK_TO },
          ]);

          // The step-back report is the new baseline: the ten second throttle
          // holds from it for a clock that moves forward again.
          vi.setSystemTime(STEPPED_BACK_TO + 5_000);
          port.send({ type: 'write', sessionId: 'session-1', data: 'c' });
          expect(userInputs(events)).toHaveLength(2);

          vi.setSystemTime(STEPPED_BACK_TO + 11_000);
          port.send({ type: 'write', sessionId: 'session-1', data: 'd' });
          expect(userInputs(events)).toHaveLength(3);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('forgets a renderer\'s port when its end disconnects, but not a newer port for the same renderer', async () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      // A reload: the new page's port arrives, then the old page's end closes.
      const reloaded = createFakeRendererPort();
      core.attachRendererPort(TEST_RENDERER, reloaded.port);
      port.disconnect();

      fake.feed('to the reloaded page');
      await flush();
      expect(reloaded.received).toEqual([{ type: 'data', sessionId: 'session-1', data: 'to the reloaded page' }]);
    });

    it('closes the port a renderer\'s new port replaces, and keeps the new one open', () => {
      const { core, port } = makeCore();
      const replacement = createFakeRendererPort();

      core.attachRendererPort(TEST_RENDERER, replacement.port);

      expect(port.closed).toBe(true);
      expect(replacement.closed).toBe(false);
    });

    it('does not close a port that is attached again as itself', () => {
      const { core, port } = makeCore();

      core.attachRendererPort(TEST_RENDERER, port.port);

      expect(port.closed).toBe(false);
    });

    it('keeps a renderer\'s new port when closing the old one throws', async () => {
      const { core, fake } = makeCore();
      core.spawn(spawnParams());
      const staleRenderer = 5;
      const stale = createFakeRendererPort();
      stale.port.close = () => {
        throw new Error('already closed with its page');
      };
      core.attachRendererPort(staleRenderer, stale.port);
      const next = createFakeRendererPort();

      expect(() => core.attachRendererPort(staleRenderer, next.port)).not.toThrow();

      core.handleCommand({ type: 'setRendererFocus', rendererId: staleRenderer, sessionIds: ['session-1'] });
      fake.feed('to the new port');
      await flush();
      expect(next.received).toEqual([{ type: 'data', sessionId: 'session-1', data: 'to the new port' }]);
    });
  });

  describe('a renderer\'s acks and the output it never received (in-flight accounting)', () => {
    // Four 64 KB reads fill one flush slice, so each tick ships 256 KB.
    const READ = 'x'.repeat(64 * 1024);
    const SLICE_CHARS = READ.length * 4;
    const TICKS_PAST_HIGH_WATER = Math.ceil(BACKPRESSURE_HIGH_WATER / SLICE_CHARS) * 2;

    async function feedPastHighWater(fake: FakePty): Promise<void> {
      for (let tick = 0; tick < TICKS_PAST_HIGH_WATER; tick++) {
        for (let read = 0; read < 4; read++) fake.feed(READ);
        await flush();
      }
    }

    it('counts a flush toward backpressure when a port took it, and pauses the PTY past the high water', async () => {
      const { core, fake } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });

      await feedPastHighWater(fake);

      const [pipeline] = core.getDiagnostics().pipeline;
      expect(pipeline.inFlightBytes).toBeGreaterThanOrEqual(BACKPRESSURE_HIGH_WATER);
      expect(pipeline.paused).toBe(true);
      expect(fake.pty.pause).toHaveBeenCalledTimes(1);
    });

    it('does not count a flush no port took (a reloading page still in the focus set), so it never pauses', async () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      // The page went away: its port closed, but main has not yet changed its focus set.
      port.disconnect();

      await feedPastHighWater(fake);

      // Nothing was delivered, so nothing will ever be acknowledged. The same
      // feed with a port attached (above) is what would have paused it.
      expect(core.getDiagnostics().pipeline[0]).toMatchObject({ inFlightBytes: 0, paused: false, pendingBytes: 0 });
      expect(fake.pty.pause).not.toHaveBeenCalled();
    });

    it('drops a negative ack, so it cannot raise a session\'s in-flight count', async () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      fake.feed('x'.repeat(1000));
      await flush();
      const inFlight = () => core.getDiagnostics().pipeline[0].inFlightBytes;
      expect(inFlight()).toBe(1000);

      port.send({ type: 'ack', sessionId: 'session-1', bytes: -1_000_000 });
      expect(inFlight()).toBe(1000);

      // A bad ack that was kept would sit at a million: the next 100 KB would pause the PTY.
      fake.feed('y'.repeat(100_000));
      await flush();
      expect(inFlight()).toBe(101_000);
      expect(core.getDiagnostics().pipeline[0].paused).toBe(false);
      expect(fake.pty.pause).not.toHaveBeenCalled();
    });

    it('drops an infinite ack, so it cannot zero a session\'s in-flight count', async () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      fake.feed('x'.repeat(1000));
      await flush();

      port.send({ type: 'ack', sessionId: 'session-1', bytes: Number.POSITIVE_INFINITY });

      expect(core.getDiagnostics().pipeline[0].inFlightBytes).toBe(1000);
    });

    it('applies a fractional ack, as a count that is not a whole number of code units is still a count', async () => {
      const { core, fake, port } = makeCore();
      core.spawn(spawnParams());
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      fake.feed('x'.repeat(1000));
      await flush();

      port.send({ type: 'ack', sessionId: 'session-1', bytes: 0.5 });

      expect(core.getDiagnostics().pipeline[0].inFlightBytes).toBe(999.5);
    });
  });

  describe('the prompt draft dies with its PTY and its session, and getPromptDraft reads it live', () => {
    const DRAFT = 'half a thought';
    const drafts = (events: HostOutput[]) => events.filter((event) => event.type === 'promptDraft').map((event) => (event as { draft: string | null }).draft);
    const draftOf = async (core: PtyHostCore, sessionId = 'session-1'): Promise<string | null> => core.handleRequest('getPromptDraft', { sessionId });

    it('tells main the draft is gone when the PTY exits on its own', async () => {
      const { core, events, fake, port } = makeCore();
      core.spawn(spawnParams());
      port.send({ type: 'write', sessionId: 'session-1', data: DRAFT });
      expect(drafts(events)).toEqual([DRAFT]);

      fake.exit(0);

      expect(drafts(events)).toEqual([DRAFT, null]);
      expect(await draftOf(core)).toBeNull();
    });

    it('tells main the draft is gone when main removes the session, while its PTY is still running', async () => {
      const { core, events, port } = makeCore();
      core.spawn(spawnParams());
      port.send({ type: 'write', sessionId: 'session-1', data: DRAFT });
      expect(drafts(events)).toEqual([DRAFT]);

      core.handleCommand({ type: 'removeSession', sessionId: 'session-1' });

      expect(drafts(events)).toEqual([DRAFT, null]);
      expect(await draftOf(core)).toBeNull();
    });

    it('says nothing when a session with no draft exits', () => {
      const { core, events, fake } = makeCore();
      core.spawn(spawnParams());

      fake.exit(0);

      expect(drafts(events)).toEqual([]);
    });

    it('says nothing when a session with no draft is removed', () => {
      const { core, events } = makeCore();
      core.spawn(spawnParams());

      core.handleCommand({ type: 'removeSession', sessionId: 'session-1' });

      expect(drafts(events)).toEqual([]);
    });

    it('keeps the draft typed into a respawned session when the PTY it replaced exits late', async () => {
      const replaced = createFakePty(4242);
      const successor = createFakePty(4343);
      const { core, events, spawnPty, port } = makeCore({ fake: replaced });
      core.spawn(spawnParams({ ptyId: 1 }));
      // A respawn under the same session id: the old PTY is still exiting.
      spawnPty.mockReturnValueOnce(successor.pty);
      core.spawn(spawnParams({ ptyId: 2 }));
      port.send({ type: 'write', sessionId: 'session-1', data: DRAFT });

      replaced.exit(0);

      expect(drafts(events)).toEqual([DRAFT]);
      expect(await draftOf(core)).toBe(DRAFT);
    });

    it('answers getPromptDraft with the ledger\'s current draft, and null once the prompt looks empty', async () => {
      const { core, port } = makeCore();
      core.spawn(spawnParams());
      expect(await draftOf(core)).toBeNull();

      port.send({ type: 'write', sessionId: 'session-1', data: DRAFT });
      expect(await draftOf(core)).toBe(DRAFT);

      // Backspace edits it; Enter submits it and leaves the prompt empty.
      port.send({ type: 'write', sessionId: 'session-1', data: '\x7f' });
      expect(await draftOf(core)).toBe('half a though');
      port.send({ type: 'write', sessionId: 'session-1', data: '\r' });
      expect(await draftOf(core)).toBeNull();
    });

    it('answers getPromptDraft per session', async () => {
      const first = createFakePty(4242);
      const second = createFakePty(4343);
      const { core, spawnPty, port } = makeCore({ fake: first });
      core.spawn(spawnParams({ ptyId: 1, sessionId: 'session-1' }));
      spawnPty.mockReturnValueOnce(second.pty);
      core.spawn(spawnParams({ ptyId: 2, sessionId: 'session-2' }));

      port.send({ type: 'write', sessionId: 'session-2', data: 'for the second' });

      expect(await draftOf(core, 'session-2')).toBe('for the second');
      expect(await draftOf(core, 'session-1')).toBeNull();
    });
  });

  describe('a production host refuses the dev-only requests', () => {
    // vitest defines __KANGENTIC_DEV__ as false, so the core here is a packaged
    // build's. handleRequest is not async: the refusal is a synchronous throw
    // naming the method. The message is the core's own, because the work behind
    // `devCpuProfile` throws a different "dev-only" message of its own, and a
    // looser match would stay green with the core's guard gone.
    const devRequests: Array<[string, (core: PtyHostCore) => unknown]> = [
      ['devArmRoundTripProbe', (core) => core.handleRequest('devArmRoundTripProbe', { durationMs: 1000 })],
      ['devReadRoundTripProbe', (core) => core.handleRequest('devReadRoundTripProbe', {})],
      ['devLagReport', (core) => core.handleRequest('devLagReport', {})],
      ['devCpuProfile', (core) => core.handleRequest('devCpuProfile', { durationMs: 100 })],
    ];

    it.each(devRequests)('refuses %s', (method, request) => {
      const { core } = makeCore();
      expect(() => request(core)).toThrow(`${method} is dev-only`);
    });
  });

  describe('the host\'s spawn spans (the labels a stall report names)', () => {
    afterEach(() => setSyncSpanLabelSink(null));

    it('times a session PTY spawn as the pty:spawn span, with node-pty called inside it', () => {
      // The sink hears a span's label as it opens and null as it closes (nothing
      // encloses it here), so node-pty's call sits between the two.
      const order: Array<string | null> = [];
      setSyncSpanLabelSink((label) => order.push(label));
      const { core, fake, spawnPty } = makeCore();
      spawnPty.mockImplementationOnce(() => {
        order.push('node-pty spawn');
        return fake.pty;
      });

      core.spawn(spawnParams());

      expect(order).toEqual(['pty:spawn', 'node-pty spawn', null]);
    });
  });

  it('answers getSeedFrame with the parsed frame and the parser offset its snapshot covers', async () => {
    // The headless parser's write barrier runs on real timers.
    vi.useRealTimers();
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    fake.feed('hello ');
    fake.feed('world');
    const seed = await core.handleRequest('getSeedFrame', { sessionId: 'session-1', settle: false });
    expect(seed.barrierOffset).toBe('hello world'.length);
    expect(seed.frame).toContain('hello world');
    // No settle was asked for, so that phase is empty; the serialize is timed.
    expect(seed.settleMs).toBe(0);
    expect(seed.serializeMs).toBeGreaterThanOrEqual(0);
  });

  it('getSeedFrame passes its history depth to the serialize: 0 is the grid alone, and no depth is the full seed', async () => {
    vi.useRealTimers();
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    // 100 rows on the 30-row grid: rows 1 to 70 scroll into history.
    fake.feed(Array.from({ length: 100 }, (_, index) => `row-${String(index + 1).padStart(3, '0')}`).join('\r\n'));

    const full = await core.handleRequest('getSeedFrame', { sessionId: 'session-1', settle: false });
    const gridAlone = await core.handleRequest('getSeedFrame', { sessionId: 'session-1', settle: false, scrollbackLines: 0 });

    expect(full.frame).toContain('row-001');
    expect(gridAlone.frame).not.toContain('row-070');
    expect(gridAlone.frame).toContain('row-071');
    expect(gridAlone.frame).toContain('row-100');
  });

  it('getSeedFrame with settle waits for the resize repaint before it serializes, and times that wait', async () => {
    // Real timers: the headless parser's write barrier and the settle timing
    // both run on them.
    vi.useRealTimers();
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    fake.feed('before');

    const bufferManager = (core as unknown as { bufferManager: PtyBufferManager }).bufferManager;
    let releaseRepaint: () => void = () => {};
    const repaintSettled = new Promise<void>((resolve) => {
      releaseRepaint = resolve;
    });
    const waitSpy = vi.spyOn(bufferManager, 'waitForResizeRepaint').mockReturnValue(repaintSettled);

    const pendingSeed = core.handleRequest('getSeedFrame', { sessionId: 'session-1', settle: true });
    // The settle is still pending, so these bytes are the repaint it exists to
    // wait for. A seed serialized before the settle would barrier at 6.
    fake.feed(' repaint');
    // Hold the settle open long enough for its timing to be measurable.
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseRepaint();
    const seed = await pendingSeed;

    expect(waitSpy).toHaveBeenCalledWith('session-1');
    expect(seed.barrierOffset).toBe('before repaint'.length);
    expect(seed.frame).toContain('before repaint');
    // The settle phase is timed around the wait: ~30ms held, with slack for
    // timer granularity. Both phases are non-negative numbers.
    expect(seed.settleMs).toBeGreaterThanOrEqual(20);
    expect(seed.serializeMs).toBeGreaterThanOrEqual(0);
  });

  it('getSeedFrame without settle never waits on the resize repaint', async () => {
    vi.useRealTimers();
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    fake.feed('no settle');

    const bufferManager = (core as unknown as { bufferManager: PtyBufferManager }).bufferManager;
    const waitSpy = vi.spyOn(bufferManager, 'waitForResizeRepaint');

    const seed = await core.handleRequest('getSeedFrame', { sessionId: 'session-1', settle: false });

    expect(waitSpy).not.toHaveBeenCalled();
    expect(seed.barrierOffset).toBe('no settle'.length);
    expect(seed.settleMs).toBe(0);
  });

  it('getSeedFrame with settle holds the seed for a real post-resize repaint', async () => {
    vi.useRealTimers();
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    // An alt-screen TUI, as the agents are: its clears are not the shell
    // takeover clear, so the parser sees exactly the bytes fed here (no
    // injected scrollback erase to account for).
    const oldFrame = '\x1b[?1049h\x1b[2Jold frame at 120 cols';
    fake.feed(oldFrame);
    // The old frame must be measurably older than the resize: the settle
    // counts same-millisecond bytes as post-resize.
    await new Promise((resolve) => setTimeout(resolve, 15));
    core.handleCommand({ type: 'resizeBuffer', sessionId: 'session-1', cols: 190, rows: 30 });

    const pendingSeed = core.handleRequest('getSeedFrame', { sessionId: 'session-1', settle: true });
    // The TUI's SIGWINCH repaint lands while the seed waits. Settle ends on
    // this full-frame clear, or at its bounded deadline at the latest, and the
    // serialize then includes it.
    const repaint = '\x1b[2Jrepaint at 190 cols';
    fake.feed(repaint);
    const seed = await pendingSeed;

    expect(seed.frame).toContain('repaint at 190 cols');
    expect(seed.barrierOffset).toBe(oldFrame.length + repaint.length);
  });

  it('merges outputSeen per window in the utility process, with a leading event', async () => {
    const { core, events, fake } = makeCore({ coalesceMs: 250 });
    core.spawn(spawnParams());

    for (let chunk = 0; chunk < 10; chunk += 1) fake.feed(`chunk ${chunk}`);
    const seenNow = events.filter((event) => event.type === 'outputSeen');
    // The first chunk is reported at once; the rest wait for the window.
    expect(seenNow).toEqual([{ type: 'outputSeen', sessionId: 'session-1', chunks: 1 }]);

    await vi.advanceTimersByTimeAsync(250);
    const seenAfter = events.filter((event) => event.type === 'outputSeen');
    expect(seenAfter).toEqual([
      { type: 'outputSeen', sessionId: 'session-1', chunks: 1 },
      { type: 'outputSeen', sessionId: 'session-1', chunks: 9 },
    ]);
  });

  it('reports nothing for a session main removed while its PTY still runs, and leaves no merge window behind', async () => {
    const coalesceEntries = (core: PtyHostCore) => (core as unknown as { coalesce: Map<string, unknown> }).coalesce;
    const outputSeenEvents = (events: PtyHostEvent[]) => events.filter((event) => event.type === 'outputSeen');
    const { core, events, fake } = makeCore({ coalesceMs: 250 });
    core.spawn(spawnParams());

    // Control: while main holds the session its output is reported and a merge
    // window opens, so the silence below cannot be a dead feed.
    fake.feed('output before the removal');
    expect(outputSeenEvents(events)).toHaveLength(1);
    expect(coalesceEntries(core).has('session-1')).toBe(true);

    // main removed the row while a young agent's PTY waits out its kill grace.
    core.handleCommand({ type: 'removeSession', sessionId: 'session-1' });
    expect(coalesceEntries(core).has('session-1')).toBe(false);
    events.length = 0;

    fake.feed('exit screen painted after the removal');
    expect(outputSeenEvents(events)).toEqual([]);
    // A window opened here would never be closed: dropSession already ran.
    expect(coalesceEntries(core).has('session-1')).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(outputSeenEvents(events)).toEqual([]);
    expect(coalesceEntries(core).has('session-1')).toBe(false);
  });

  it('reports PTY activity on the leading edge of a window and once more if it continued', async () => {
    const activityAgent = {
      detectFirstOutput: () => false,
      runtime: { activity: { kind: 'pty' } },
    } as unknown as AgentParser;
    const { core, events, fake } = makeCore({ coalesceMs: 250, agent: activityAgent });
    core.spawn(spawnParams({ agentName: 'fake' }));

    fake.feed('first line');
    expect(events.filter((event) => event.type === 'ptyData')).toHaveLength(1);
    fake.feed('second line');
    fake.feed('third line');
    expect(events.filter((event) => event.type === 'ptyData')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(events.filter((event) => event.type === 'ptyData')).toHaveLength(2);
  });

  it('sends one event per chunk in-process (coalesceMs 0)', () => {
    const { core, events, fake } = makeCore({ coalesceMs: 0 });
    core.spawn(spawnParams());
    fake.feed('a');
    fake.feed('b');
    expect(events.filter((event) => event.type === 'outputSeen')).toHaveLength(2);
  });

  it('captures an agent session id from output once, then stops scanning', () => {
    const scanningAgent = {
      detectFirstOutput: () => false,
      runtime: { sessionId: { fromOutput: (text: string) => text.match(/id=(\S+)/)?.[1] ?? null } },
    } as unknown as AgentParser;
    const { core, events, fake } = makeCore({ agent: scanningAgent });
    core.spawn(spawnParams({ agentName: 'fake' }));

    fake.feed('id=first-id\n');
    fake.feed('id=second-id\n');
    expect(events.filter((event) => event.type === 'agentSessionId')).toEqual([
      { type: 'agentSessionId', sessionId: 'session-1', capturedId: 'first-id' },
    ]);
  });

  it('writes the transcript itself and flushes it before reporting the exit', () => {
    const { core, events, fake, appended } = makeCore();
    core.spawn(spawnParams());
    fake.feed('plain transcript text');

    fake.exit(0);

    expect(appended).toEqual([{ sessionId: 'session-1', chunk: 'plain transcript text' }]);
    expect(events[events.length - 1]).toEqual({ type: 'exit', ptyId: 1, sessionId: 'session-1', exitCode: 0 });
  });

  it('keeps no transcript for a Command Terminal', () => {
    const { core, fake, appended } = makeCore();
    core.spawn(spawnParams({ transient: true }));
    fake.feed('command terminal output');
    fake.exit(0);
    expect(appended).toEqual([]);
  });

  it('carries the previous ring over, and keeps the old session until main removes it', () => {
    const { core } = makeCore();
    core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'old bytes', cols: 120 });

    core.spawn(spawnParams({ carryoverFromSessionId: 'old-session' }));

    expect(core.getRawScrollback('session-1')).toBe('old bytes');
    // Kept: a spawn cancelled in the round trip must leave the old session as
    // it was, so main drops it only once it knows the spawn stands.
    expect(core.getRawScrollback('old-session')).toBe('old bytes');
    core.handleCommand({ type: 'removeSession', sessionId: 'old-session' });
    expect(core.getRawScrollback('old-session')).toBe('');
  });

  it('hands the carry-over back when the spawn throws, so main can show it with the diagnostic', () => {
    const events: PtyHostEvent[] = [];
    const core = new PtyHostCore({
      emit: (event) => events.push(event),
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      spawnPty: (() => {
        const error = new Error('spawn failed') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof nodePty.spawn,
    });
    core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'previous bytes', cols: 120 });

    const result = core.spawn(spawnParams({ carryoverFromSessionId: 'old-session' }));

    expect(result).toMatchObject({ ok: false, previousScrollback: 'previous bytes', error: { message: 'spawn failed', code: 'ENOENT' } });
  });

  describe('the agentOutput latch (the launch overlay\'s evidence that the agent is on screen)', () => {
    // The shell's prompt with the typed command, the shell's own erase-scrollback
    // clear, then the agent's first line. Each chunk gets its own flush, as the
    // reads of a real PTY do. Inlined: test files here never import fixtures
    // from each other.
    const handoffStream = ['PS C:\\Users\\dev> clear; agent\r\n', '\x1b[3J', 'AGENT READY\r\n'];

    async function feedHandoff(fake: FakePty): Promise<void> {
      for (const chunk of handoffStream) {
        fake.feed(chunk);
        await flush();
      }
    }

    const agentOutputEvents = (events: PtyHostEvent[]) => events.filter((event) => event.type === 'agentOutput');

    it('is silent for a session spawned with no agent name, and fires once for the same stream on one with an agent', async () => {
      // A bare shell types no clear prelude, so the host never scans its output
      // for a handoff.
      const bareShell = makeCore();
      bareShell.core.spawn(spawnParams({ agentName: null }));
      await feedHandoff(bareShell.fake);
      expect(agentOutputEvents(bareShell.events)).toEqual([]);

      // Control: the identical stream on an agent session reports, so the
      // silence above is the gate and not a feed that never reached the tracker.
      const agentSession = makeCore();
      agentSession.core.spawn(spawnParams({ agentName: 'fake' }));
      await feedHandoff(agentSession.fake);
      expect(agentOutputEvents(agentSession.events)).toEqual([{ type: 'agentOutput', sessionId: 'session-1' }]);

      // Once per session: later output does not report again.
      agentSession.fake.feed('more agent text');
      await flush();
      expect(agentOutputEvents(agentSession.events)).toHaveLength(1);
    });

    it('reports again for a new session spawned under the id of one the host dropped', async () => {
      const { core, events, fake, spawnPty } = makeCore();
      core.spawn(spawnParams({ agentName: 'fake' }));
      await feedHandoff(fake);
      expect(agentOutputEvents(events)).toHaveLength(1);

      // The PTY exiting does not drop the session; main's removeSession command
      // does, and that is what forgets that the latch fired.
      fake.exit(0);
      core.handleCommand({ type: 'removeSession', sessionId: 'session-1' });

      // A resume spawns a new PTY under the same session id.
      const respawnedFake = createFakePty(4343);
      spawnPty.mockReturnValueOnce(respawnedFake.pty);
      core.spawn(spawnParams({ ptyId: 2, agentName: 'fake' }));
      await feedHandoff(respawnedFake);

      expect(agentOutputEvents(events)).toEqual([
        { type: 'agentOutput', sessionId: 'session-1' },
        { type: 'agentOutput', sessionId: 'session-1' },
      ]);
    });
  });

  describe('a PTY whose program is this app\'s own executable', () => {
    // With the RunAsNode fuse off, a packaged Kangentic.exe started as a child
    // boots a second app, so the host refuses it for a PTY as it does for a
    // one-shot run. A user's shell setting (a session's program) or an agent
    // CLI path override (a probe's) is the way a request gets here. The refusal
    // is a failed spawn, never a throw out of the core, and node-pty is never
    // asked.
    const REFUSAL = 'The pty host does not launch its own executable';
    const MAIN_BINARY = '/opt/Kangentic/kangentic';
    afterEach(() => setMainExecutable(undefined));

    it('refuses a session spawn of this process\'s executable as a failed spawn, with the carry-over handed back, and never calls node-pty', () => {
      const { core, spawnPty } = makeCore();
      core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'previous bytes', cols: 120 });

      const result = core.spawn(spawnParams({ file: process.execPath, carryoverFromSessionId: 'old-session' }));

      expect(result).toMatchObject({ ok: false, error: { message: REFUSAL }, previousScrollback: 'previous bytes' });
      expect(spawnPty).not.toHaveBeenCalled();
      expect(core.livePtyCount).toBe(0);
    });

    it('refuses a raw spawn of this process\'s executable as a failed spawn and never calls node-pty', () => {
      const { core, spawnPty } = makeCore();

      const result = core.spawnRaw(rawSpawnParams({ file: process.execPath }));

      expect(result).toMatchObject({ ok: false, error: { message: REFUSAL } });
      expect(spawnPty).not.toHaveBeenCalled();
      expect(core.livePtyCount).toBe(0);
    });

    it('refuses main\'s executable, as main reported it in the init, for a raw spawn and a session spawn', () => {
      const { core, spawnPty } = makeCore();

      // Control: before main reports its executable nothing marks this path as
      // the app's, so the same spawn goes through. The refusals below are the
      // report's doing.
      expect(core.spawnRaw(rawSpawnParams({ ptyId: 1, file: MAIN_BINARY }))).toMatchObject({ ok: true });
      expect(spawnPty).toHaveBeenCalledTimes(1);

      setMainExecutable(MAIN_BINARY);
      expect(core.spawnRaw(rawSpawnParams({ ptyId: 2, file: MAIN_BINARY }))).toMatchObject({ ok: false, error: { message: REFUSAL } });
      expect(core.spawn(spawnParams({ ptyId: 3, sessionId: 'session-main-binary', file: MAIN_BINARY }))).toMatchObject({ ok: false, error: { message: REFUSAL } });
      expect(spawnPty).toHaveBeenCalledTimes(1);
    });

    it('still spawns an unrelated program, for a session and for a raw PTY, with this process\'s and main\'s executables known', () => {
      setMainExecutable(MAIN_BINARY);
      const { core, spawnPty } = makeCore();

      expect(core.spawn(spawnParams({ file: 'bash' }))).toEqual({ ok: true, pid: 4242 });
      expect(core.spawnRaw(rawSpawnParams({ file: 'claude' }))).toEqual({ ok: true, pid: 4242 });

      expect(spawnPty).toHaveBeenCalledTimes(2);
      expect(spawnPty.mock.calls.map((call) => call[0])).toEqual(['bash', 'claude']);
    });
  });

  describe('a PTY whose pid node-pty sets after spawn() returns (ConPTY on node-pty 1.2)', () => {
    /** node-pty connects the process from its conout worker, so pid reads 0 until then. */
    function latePidFake(): FakePty & { connect(pid: number): void } {
      const fake = createFakePty(0);
      return { ...fake, connect: (pid) => { (fake.pty as { pid: number }).pid = pid; } };
    }

    it('answers the spawn with the pid once it is set, not the 0 read at the spawn', async () => {
      const fake = latePidFake();
      const { core } = makeCore({ fake });
      const answer = Promise.resolve(core.handleRequest('spawn', spawnParams()));
      let answered = false;
      void answer.then(() => { answered = true; });
      await vi.advanceTimersByTimeAsync(ROOT_PID_POLL_MS * 3);
      expect(answered).toBe(false);

      fake.connect(5150);
      await vi.advanceTimersByTimeAsync(ROOT_PID_POLL_MS);
      await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });
    });

    it('sends main no event for the PTY before the answer, then everything held, in order', async () => {
      const fake = latePidFake();
      const { core, events } = makeCore({ fake });
      core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
      let eventsAtAnswer: PtyHostEvent[] | null = null;
      const answer = Promise.resolve(core.handleRequest('spawn', spawnParams())).then((result) => {
        eventsAtAnswer = [...events];
        return result;
      });

      // The pid is set when the output pipe connects, and output follows.
      fake.connect(5150);
      fake.feed('first ');
      fake.feed('output');
      await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });
      expect(eventsAtAnswer).toEqual([]);

      await flush();
      expect(events.filter((event) => event.type === 'outputSeen')).toEqual([
        { type: 'outputSeen', sessionId: 'session-1', chunks: 1 },
        { type: 'outputSeen', sessionId: 'session-1', chunks: 1 },
      ]);
      expect(events).toContainEqual({ type: 'data', sessionId: 'session-1', data: 'first output' });
    });

    it('reports an exit that came after the pid, but only after the answer', async () => {
      const fake = latePidFake();
      const { core, events } = makeCore({ fake });
      let eventsAtAnswer: PtyHostEvent[] | null = null;
      const answer = Promise.resolve(core.handleRequest('spawn', spawnParams())).then((result) => {
        eventsAtAnswer = [...events];
        return result;
      });

      fake.connect(5150);
      fake.exit(0);
      await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });
      expect(eventsAtAnswer).toEqual([]);

      await flush();
      expect(events).toContainEqual({ type: 'exit', ptyId: 1, sessionId: 'session-1', exitCode: 0 });
      expect(core.livePtyCount).toBe(0);
    });

    it('answers an exit before the pid as a failed spawn: nothing started, so no exit event', async () => {
      const fake = latePidFake();
      const { core, events } = makeCore({ fake });
      const answer = Promise.resolve(core.handleRequest('spawn', spawnParams()));

      // CreateProcessW failed (267: the directory name is invalid); node-pty
      // reports it as an exit carrying the error code.
      fake.exit(267);
      await expect(answer).resolves.toMatchObject({
        ok: false,
        error: { message: 'Cannot create process, error code: 267' },
        previousScrollback: '',
      });
      await flush();
      expect(events.filter((event) => event.type === 'exit')).toEqual([]);
      expect(core.livePtyCount).toBe(0);
    });

    it('answers without the pid, and stops holding, if neither the pid nor an exit ever arrives', async () => {
      const fake = latePidFake();
      const { core, events } = makeCore({ fake });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const answer = Promise.resolve(core.handleRequest('spawn', spawnParams()));

      await vi.advanceTimersByTimeAsync(ROOT_PID_WAIT_LIMIT_MS);
      await expect(answer).resolves.toEqual({ ok: true, pid: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reported no pid and no exit'));
      warn.mockRestore();

      await flush();
      fake.feed('late output');
      expect(events).toContainEqual({ type: 'outputSeen', sessionId: 'session-1', chunks: 1 });
    });

    it('does the same for a raw PTY: the pid in the answer, its output after it, and a failed start as a failed spawn', async () => {
      const started = latePidFake();
      const startedCore = makeCore({ fake: started });
      let eventsAtAnswer: PtyHostEvent[] | null = null;
      const answer = Promise.resolve(startedCore.core.handleRequest('spawnRaw', rawSpawnParams())).then((result) => {
        eventsAtAnswer = [...startedCore.events];
        return result;
      });
      started.connect(5150);
      started.feed('probe output');
      await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });
      expect(eventsAtAnswer).toEqual([]);
      await flush();
      expect(startedCore.events).toEqual([{ type: 'rawData', ptyId: 9, data: 'probe output' }]);

      const failed = latePidFake();
      const failedCore = makeCore({ fake: failed });
      const failedAnswer = Promise.resolve(failedCore.core.handleRequest('spawnRaw', rawSpawnParams()));
      failed.exit(2);
      await expect(failedAnswer).resolves.toMatchObject({ ok: false, error: { message: 'Cannot create process, error code: 2' } });
      await flush();
      expect(failedCore.events).toEqual([]);
      expect(failedCore.core.livePtyCount).toBe(0);
    });

    it('still reports the exit of a PTY whose first held chunk makes its agent parser throw', async () => {
      // The throw happens synchronously inside the output handler, which is how a
      // malformed chunk reaches an adapter's parser in production.
      const throwingAgent = {
        detectFirstOutput: () => false,
        runtime: {
          streamOutput: {
            createParser: () => ({
              parseTelemetry: () => {
                throw new Error('telemetry parser failed');
              },
            }),
          },
        },
      } as unknown as AgentParser;
      const fake = latePidFake();
      const { core, events } = makeCore({ fake, agent: throwingAgent });
      const answer = Promise.resolve(core.handleRequest('spawn', spawnParams({ agentName: 'fake' })));

      // Output, then the exit, both held until the answer has gone out.
      fake.connect(5150);
      fake.feed('first chunk');
      fake.exit(0);
      await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });
      expect(events).toEqual([]);

      // The drain surfaces the parser's error, as node-pty's own emitter would.
      expect(() => vi.advanceTimersByTime(0)).toThrow('telemetry parser failed');

      // The exit was not dropped with the chunk that threw. Main hears of it, after the output.
      expect(events.map((event) => event.type)).toEqual(['outputSeen', 'exit']);
      expect(events).toContainEqual({ type: 'exit', ptyId: 1, sessionId: 'session-1', exitCode: 0 });
      expect(core.livePtyCount).toBe(0);
    });

    it('drops a failed spawn\'s session state, table entry and listeners, and hands the carry-over back', async () => {
      const ptyTable = (target: PtyHostCore) => (target as unknown as { ptys: Map<number, unknown> }).ptys;
      const fake = latePidFake();
      const { core } = makeCore({ fake });
      core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'old bytes', cols: 120 });
      const answer = Promise.resolve(core.handleRequest('spawn', spawnParams({ carryoverFromSessionId: 'old-session' })));

      // As a control, the host holds all of it while the spawn is pending, so the
      // empty state below is the failure's doing.
      expect(core.getRawScrollback('session-1')).toBe('old bytes');
      expect(core.getDiagnostics().pipeline.map((entry) => entry.sessionId).sort()).toEqual(['old-session', 'session-1']);
      expect(ptyTable(core).has(1)).toBe(true);
      expect(fake.disposeData).not.toHaveBeenCalled();
      expect(fake.disposeExit).not.toHaveBeenCalled();

      // CreateProcessW failed (267), so node-pty reported the error code as an exit.
      fake.exit(267);
      await expect(answer).resolves.toMatchObject({
        ok: false,
        error: { message: 'Cannot create process, error code: 267' },
        previousScrollback: 'old bytes',
      });

      // The failed session's ring is gone. The carry-over source stays until main removes it.
      expect(core.getRawScrollback('session-1')).toBe('');
      expect(core.getDiagnostics().pipeline.map((entry) => entry.sessionId)).toEqual(['old-session']);
      expect(core.getRawScrollback('old-session')).toBe('old bytes');
      // No public read reaches the table entry (every one skips an exited PTY), so
      // it is read the way the coalesce-window test reads its private map.
      expect(ptyTable(core).has(1)).toBe(false);
      expect(fake.disposeData).toHaveBeenCalledTimes(1);
      expect(fake.disposeExit).toHaveBeenCalledTimes(1);
    });

    it('leaves the session state a newer spawn of the same session id owns when an older gated spawn of it fails', async () => {
      const ptyTable = (target: PtyHostCore) => (target as unknown as { ptys: Map<number, unknown> }).ptys;
      const olderFake = latePidFake();
      const newerFake = createFakePty(6161);
      const { core, events, spawnPty } = makeCore({ fake: olderFake });
      const olderAnswer = Promise.resolve(core.handleRequest('spawn', spawnParams({ ptyId: 1 })));

      // The same session id is spawned again while the first spawn still waits
      // for its pid. The second spawn replaces the session's row and ring, so
      // from here the session belongs to PTY 2.
      spawnPty.mockReturnValueOnce(newerFake.pty);
      expect(core.spawn(spawnParams({ ptyId: 2 }))).toEqual({ ok: true, pid: 6161 });
      newerFake.feed('newer spawn output');
      expect(core.getRawScrollback('session-1')).toBe('newer spawn output');

      // The older PTY now fails to start (CreateProcessW error 267).
      olderFake.exit(267);
      await expect(olderAnswer).resolves.toMatchObject({
        ok: false,
        error: { message: 'Cannot create process, error code: 267' },
      });

      // The failed answer went out, but it dropped only the older PTY's own entry.
      expect(ptyTable(core).has(1)).toBe(false);
      expect(ptyTable(core).has(2)).toBe(true);
      expect(core.livePtyCount).toBe(1);
      // The session is still the newer PTY's, with its ring and pipeline entry intact.
      expect(core.getRawScrollback('session-1')).toBe('newer spawn output');
      expect(core.getDiagnostics().pipeline.map((entry) => entry.sessionId)).toEqual(['session-1']);
      // Its row survives too, so the newer PTY's output is still reported.
      events.length = 0;
      newerFake.feed(' and more');
      expect(events.filter((event) => event.type === 'outputSeen')).toHaveLength(1);
    });

    it('answers a raw PTY that reports no pid and no exit within the wait with pid 0, logs it, and delivers its output', async () => {
      const fake = latePidFake();
      const { core, events } = makeCore({ fake });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const answer = Promise.resolve(core.handleRequest('spawnRaw', rawSpawnParams()));
        // Held through the wait, as the session spawn's output is.
        fake.feed('held probe output');

        await vi.advanceTimersByTimeAsync(ROOT_PID_WAIT_LIMIT_MS);
        await expect(answer).resolves.toEqual({ ok: true, pid: 0 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('raw PTY 9 reported no pid and no exit'));

        await flush();
        expect(events).toEqual([{ type: 'rawData', ptyId: 9, data: 'held probe output' }]);

        // The gate is open once released. Later output arrives as it is fed.
        fake.feed('live probe output');
        expect(events.at(-1)).toEqual({ type: 'rawData', ptyId: 9, data: 'live probe output' });
      } finally {
        warn.mockRestore();
      }
    });

    describe('a ConPTY whose output never connected (exit -1 before the pid)', () => {
      // node-pty's own 5 s connect timeout, or its conout worker's error, ends the
      // PTY before CreateProcessW runs and reports it as an exit carrying -1.
      // Nothing started, so the host spawns it once more before it answers. The
      // fake clock runs every 10 ms poll on time, so the longest stall is one poll.
      const NOT_CONNECTED_AFTER_TIMEOUT = 'Terminal output never connected after 5000 ms, longest pty host stall 10 ms (ConPTY error code: -1)';
      let warn: ReturnType<typeof vi.spyOn>;
      beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
      afterEach(() => warn.mockRestore());

      /**
       * A core whose first spawn is `first` and whose next is `second`, with a carry-over source.
       * `params` overrides the request's own, and `secondSpawn` replaces what the retry's spawn does.
       */
      function retryRig(options: { params?: Partial<PtyHostSpawnParams>; secondSpawn?: () => nodePty.IPty } = {}) {
        const first = latePidFake();
        const second = latePidFake();
        const rig = makeCore({ fake: first });
        rig.core.handleCommand({ type: 'initSession', sessionId: 'old-session', scrollback: 'old bytes', cols: 120 });
        rig.core.handleCommand({ type: 'setRendererFocus', rendererId: TEST_RENDERER, sessionIds: ['session-1'] });
        const answer = Promise.resolve(rig.core.handleRequest('spawn', spawnParams({ carryoverFromSessionId: 'old-session', ...options.params })));
        // One queue serves return values and implementations alike, so this is the retry's spawn.
        rig.spawnPty.mockImplementationOnce(options.secondSpawn ?? (() => second.pty));
        return { ...rig, first, second, answer };
      }

      /**
       * The retry has just started and its PTY never connects, so only its gate's backstop answers it:
       * not before `windowMs` after the retry began, and at it.
       */
      async function expectBackstopAnswerAt(answer: Promise<unknown>, windowMs: number): Promise<void> {
        let settled = false;
        void answer.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(windowMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        await expect(answer).resolves.toEqual({ ok: true, pid: 0 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('reported no pid and no exit within the wait'));
      }

      it('spawns it once more, and answers with the second PTY\'s pid and its output', async () => {
        const { core, events, spawnPty, first, second, answer } = retryRig();

        await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
        first.exit(-1);
        await vi.advanceTimersByTimeAsync(0);
        // The same program, arguments and options as the first attempt.
        expect(spawnPty).toHaveBeenCalledTimes(2);
        expect(spawnPty.mock.calls[1]).toEqual(spawnPty.mock.calls[0]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('output never connected after 5000 ms'));

        second.connect(5150);
        second.feed('second attempt output');
        await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });

        await flush();
        expect(events).toContainEqual({ type: 'data', sessionId: 'session-1', data: 'second attempt output' });
        // The first attempt never started, so main hears no exit for it.
        expect(events.filter((event) => event.type === 'exit')).toEqual([]);
        // The session kept its carry-over through the retry.
        expect(core.getRawScrollback('session-1')).toBe('old bytessecond attempt output');
        expect(core.livePtyCount).toBe(1);
      });

      it('answers failed, naming the attempt\'s elapsed time, when the second attempt does not connect either', async () => {
        const { core, events, spawnPty, first, second, answer } = retryRig();

        await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
        first.exit(-1);
        await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
        second.exit(-1);

        await expect(answer).resolves.toMatchObject({
          ok: false,
          error: { message: NOT_CONNECTED_AFTER_TIMEOUT, code: PTY_OUTPUT_NOT_CONNECTED_CODE },
          previousScrollback: 'old bytes',
        });
        // A third attempt would not fit inside main's spawn budget.
        expect(spawnPty).toHaveBeenCalledTimes(2);
        await flush();
        expect(events.filter((event) => event.type === 'exit')).toEqual([]);
        expect(core.livePtyCount).toBe(0);
        expect(core.getRawScrollback('session-1')).toBe('');
        expect(core.getRawScrollback('old-session')).toBe('old bytes');
      });

      it('does not spawn again once the host is shutting down, main sent a kill for the PTY, or main cancelled the spawn', async () => {
        for (const giveUp of [
          { type: 'shutdown' } as const,
          { type: 'kill', ptyId: 1 } as const,
          { type: 'cancelSpawn', sessionId: 'session-1' } as const,
        ]) {
          const { core, spawnPty, first, answer } = retryRig();
          await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
          core.handleCommand(giveUp);
          first.exit(-1);
          await vi.advanceTimersByTimeAsync(0);

          // Checked before the answer: a retry would leave it waiting on a PTY that never connects.
          expect(spawnPty).toHaveBeenCalledTimes(1);
          await expect(answer).resolves.toMatchObject({ ok: false, error: { message: NOT_CONNECTED_AFTER_TIMEOUT } });
        }
      });

      it('does not spawn again when the first attempt left too little of main\'s budget for a full second one', async () => {
        const { spawnPty, first, answer } = retryRig();

        await vi.advanceTimersByTimeAsync(8_001);
        first.exit(-1);
        await vi.advanceTimersByTimeAsync(0);

        // Checked before the answer: a retry would leave it waiting on a PTY that never connects.
        expect(spawnPty).toHaveBeenCalledTimes(1);
        await expect(answer).resolves.toMatchObject({
          ok: false,
          error: { message: 'Terminal output never connected after 8001 ms, longest pty host stall 10 ms (ConPTY error code: -1)' },
        });
      });

      it('answers failed, handing the carry-over back, when the retry\'s own spawn throws', async () => {
        const { core, events, spawnPty, first, answer } = retryRig({
          secondSpawn: () => { throw new Error('CreateProcessW could not allocate the console'); },
        });

        await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
        first.exit(-1);

        await expect(answer).resolves.toMatchObject({
          ok: false,
          error: { message: 'CreateProcessW could not allocate the console' },
          previousScrollback: 'old bytes',
        });
        // The throw came from the retry: the first attempt's spawn returned a PTY.
        expect(spawnPty).toHaveBeenCalledTimes(2);
        await flush();
        expect(events.filter((event) => event.type === 'exit')).toEqual([]);
        expect(core.livePtyCount).toBe(0);
        expect(core.getRawScrollback('session-1')).toBe('');
        expect(core.getRawScrollback('old-session')).toBe('old bytes');
      });

      it('stops listening to the dead first attempt, so what it still emits never reaches the retry', async () => {
        const { core, events, spawnPty, first, second, answer } = retryRig();

        await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
        first.exit(-1);
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnPty).toHaveBeenCalledTimes(2);
        expect(first.disposeData).toHaveBeenCalledTimes(1);
        expect(first.disposeExit).toHaveBeenCalledTimes(1);

        // The retry reuses the entry and the session's ring. A late chunk or exit
        // from the dead PTY, heard, would write into that ring or end the entry.
        first.feed('late output from the dead first attempt');
        first.exit(0);

        second.connect(5150);
        second.feed('second attempt output');
        // The gate's poll reads the pid whatever else happened to the retry's listeners.
        await vi.advanceTimersByTimeAsync(ROOT_PID_POLL_MS);
        await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });
        await flush();

        expect(events.filter((event) => event.type === 'exit')).toEqual([]);
        expect(core.livePtyCount).toBe(1);
        expect(core.getRawScrollback('session-1')).toBe('old bytessecond attempt output');
        // Disposing the first attempt's listeners left the retry's own alone.
        expect(second.disposeData).not.toHaveBeenCalled();
        expect(second.disposeExit).not.toHaveBeenCalled();

        // The entry forgot the first attempt's listeners, so the retry's own exit disposes only its own.
        second.exit(0);
        await flush();
        expect(second.disposeData).toHaveBeenCalledTimes(1);
        expect(first.disposeData).toHaveBeenCalledTimes(1);
        expect(first.disposeExit).toHaveBeenCalledTimes(1);
      });

      it('gives the retry the window main\'s budget leaves, not the 10 s default backstop', async () => {
        const { first, answer } = retryRig();

        // Straight after node-pty's own timeout: 15 s less the 1 s margin less 5 s is 9 s.
        await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
        first.exit(-1);
        await vi.advanceTimersByTimeAsync(0);

        await expectBackstopAnswerAt(answer, 9_000);
      });

      describe('the time the request waited for the host\'s loop (sentAtMs) counts against the retry window', () => {
        it('does not spawn again when that wait leaves less than a full second attempt', async () => {
          // 3.5 s waiting and 5 s for the first attempt: 8.5 s used leaves 5.5 s once the margin is kept
          // back, under the 6 s a full connect timeout and a second need.
          const { spawnPty, first, answer } = retryRig({ params: { sentAtMs: Date.now() - 3_500 } });

          await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
          first.exit(-1);
          await vi.advanceTimersByTimeAsync(0);

          // Checked before the answer: a retry would leave it waiting on a PTY that never connects.
          expect(spawnPty).toHaveBeenCalledTimes(1);
          await expect(answer).resolves.toMatchObject({
            ok: false,
            error: { message: NOT_CONNECTED_AFTER_TIMEOUT, code: PTY_OUTPUT_NOT_CONNECTED_CODE },
          });
        });

        it('spawns again when the request waited no time at all (the control for the case above)', async () => {
          const { spawnPty, first, second, answer } = retryRig({ params: { sentAtMs: Date.now() } });

          await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
          first.exit(-1);
          await vi.advanceTimersByTimeAsync(0);
          expect(spawnPty).toHaveBeenCalledTimes(2);

          second.connect(5150);
          await vi.advanceTimersByTimeAsync(ROOT_PID_POLL_MS);
          await expect(answer).resolves.toEqual({ ok: true, pid: 5150 });
        });

        it('shortens the retry\'s backstop by the wait, down to the 6 s minimum window', async () => {
          // 3 s waiting and 5 s for the first attempt: 8 s used, so 15 s less 1 s less 8 s is 6 s.
          const { spawnPty, first, answer } = retryRig({ params: { sentAtMs: Date.now() - 3_000 } });

          await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
          first.exit(-1);
          await vi.advanceTimersByTimeAsync(0);
          expect(spawnPty).toHaveBeenCalledTimes(2);

          await expectBackstopAnswerAt(answer, 6_000);
        });

        it('counts a stamp ahead of the host\'s clock (a clock that stepped back) as no wait, not as extra time', async () => {
          // Unclamped, the 4 s the stamp is ahead would read as -4 s waited and stretch the window to the 10 s cap.
          const { spawnPty, first, answer } = retryRig({ params: { sentAtMs: Date.now() + 4_000 } });

          await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
          first.exit(-1);
          await vi.advanceTimersByTimeAsync(0);
          expect(spawnPty).toHaveBeenCalledTimes(2);

          await expectBackstopAnswerAt(answer, 9_000);
        });
      });

      it('names how long the host\'s own loop was held while the attempt waited', async () => {
        // The DESKTOP-23 lead: a loop held past node-pty's timeout runs the
        // timeout before it reads the worker's ready message. A held loop runs
        // no timer, so the clock jumps with none of the gate's polls between.
        const fake = latePidFake();
        const { core } = makeCore({ fake });
        const answer = Promise.resolve(core.handleRequest('spawnRaw', rawSpawnParams()));

        await vi.advanceTimersByTimeAsync(1_000);
        vi.setSystemTime(Date.now() + 5_200);
        fake.exit(-1);

        await expect(answer).resolves.toMatchObject({
          ok: false,
          error: { message: 'Terminal output never connected after 6200 ms, longest pty host stall 5200 ms (ConPTY error code: -1)' },
        });
      });

      it('does not spawn again over a newer spawn of the same session id', async () => {
        const older = latePidFake();
        const newer = createFakePty(6161);
        const { core, spawnPty } = makeCore({ fake: older });
        const olderAnswer = Promise.resolve(core.handleRequest('spawn', spawnParams({ ptyId: 1 })));
        spawnPty.mockReturnValueOnce(newer.pty);
        expect(core.spawn(spawnParams({ ptyId: 2 }))).toEqual({ ok: true, pid: 6161 });
        newer.feed('newer spawn output');

        older.exit(-1);
        await expect(olderAnswer).resolves.toMatchObject({ ok: false, error: { code: PTY_OUTPUT_NOT_CONNECTED_CODE } });

        // The older spawn's retry would have replaced the newer one's ring.
        expect(spawnPty).toHaveBeenCalledTimes(2);
        expect(core.getRawScrollback('session-1')).toBe('newer spawn output');
        expect(core.livePtyCount).toBe(1);
      });

      it('answers a raw PTY with the same message, without spawning it again', async () => {
        const fake = latePidFake();
        const { core, spawnPty, events } = makeCore({ fake });
        const answer = Promise.resolve(core.handleRequest('spawnRaw', rawSpawnParams()));

        await vi.advanceTimersByTimeAsync(NODE_PTY_CONNECT_TIMEOUT_MS);
        fake.exit(-1);

        await expect(answer).resolves.toMatchObject({
          ok: false,
          error: { message: NOT_CONNECTED_AFTER_TIMEOUT, code: PTY_OUTPUT_NOT_CONNECTED_CODE },
        });
        expect(spawnPty).toHaveBeenCalledTimes(1);
        await flush();
        expect(events).toEqual([]);
        expect(core.livePtyCount).toBe(0);
      });
    });
  });

  describe('a PTY that exited on its own is released (node-pty frees its conout worker only in kill())', () => {
    it('kills a session PTY once after it exited on its own, on Windows', () => {
      const { core, fake } = makeCore({ platform: 'win32' });
      core.spawn(spawnParams());
      expect(fake.kill).not.toHaveBeenCalled();

      fake.exit(0);
      expect(fake.kill).toHaveBeenCalledTimes(1);
    });

    it('never kills a PTY main killed a second time', () => {
      const { core, fake } = makeCore({ platform: 'win32' });
      core.spawn(spawnParams());
      core.handleCommand({ type: 'kill', ptyId: 1 });

      fake.exit(1);
      expect(fake.kill).toHaveBeenCalledTimes(1);
    });

    it('never kills after the exit on POSIX, where the pid may name another process by then', () => {
      const { core, fake } = makeCore({ platform: 'linux' });
      core.spawn(spawnParams());

      fake.exit(0);
      expect(fake.kill).not.toHaveBeenCalled();
    });

    it('releases a raw PTY that exited on its own, and kills one it killed only once', () => {
      const natural = makeCore({ platform: 'win32' });
      natural.core.spawnRaw(rawSpawnParams());
      natural.fake.exit(0);
      expect(natural.fake.kill).toHaveBeenCalledTimes(1);

      const killed = makeCore({ platform: 'win32' });
      killed.core.spawnRaw(rawSpawnParams());
      killed.core.handleCommand({ type: 'kill', ptyId: 9 });
      killed.fake.exit(1);
      expect(killed.fake.kill).toHaveBeenCalledTimes(1);
    });
  });

  it('drops a second kill of the same PTY (a double ConPTY kill corrupts its heap)', () => {
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    core.handleCommand({ type: 'kill', ptyId: 1 });
    core.handleCommand({ type: 'kill', ptyId: 1 });
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('drops what is still queued for a PTY when main kills it, so a large write does not keep draining into a dying shell', async () => {
    const { core, fake } = makeCore();
    core.spawn(spawnParams());
    // Over one 4 KB chunk and with no paste markers: the first chunk is written at
    // once and the rest wait for later loop turns.
    core.handleCommand({ type: 'enqueueWrite', ptyId: 1, data: 'q'.repeat(20 * 1024), origin: 'system' });
    expect(fake.write).toHaveBeenCalledTimes(1);

    core.handleCommand({ type: 'kill', ptyId: 1 });
    // The kill has not produced an exit yet (a ConPTY takes up to a second), so
    // only the disposed queue keeps the rest from being written.
    await vi.runAllTimersAsync();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(fake.write).toHaveBeenCalledTimes(1);
    await expect(core.handleRequest('drainWrites', { ptyId: 1 })).resolves.toBe(true);
  });

  it('shutdown flushes the transcripts and kills nothing: main posts the kills, a young one after its grace', () => {
    const { core, fake, appended } = makeCore();
    core.spawn(spawnParams());
    fake.feed('unflushed text');

    core.handleCommand({ type: 'shutdown' });

    expect(appended).toEqual([{ sessionId: 'session-1', chunk: 'unflushed text' }]);
    expect(fake.kill).not.toHaveBeenCalled();
    expect(core.livePtyCount).toBe(1);
    fake.exit(0);
    expect(core.livePtyCount).toBe(0);
  });
});

describe('PtyHostClient and RemotePty', () => {
  it('spawns through the transport and routes the exit to the PTY\'s own listener', async () => {
    const fake = createFakePty(555);
    const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
    // Spawn through the core's injected factory: replace it for this test.
    (transport.core as unknown as { spawnPty: unknown }).spawnPty = () => fake.pty;
    const client = new PtyHostClient(transport);

    const outcome = await client.spawn({
      sessionId: 'session-1',
      projectId: 'project-1',
      agentName: null,
      transient: false,
      file: 'bash',
      args: [],
      cwd: '/mock/project',
      env: {},
      cols: 100,
      rows: 40,
      carryoverFromSessionId: null,
      agentSessionIdKnown: false,
    });
    if (!outcome.ok) throw new Error('spawn failed');
    const remote = outcome.pty;
    expect(remote.pid).toBe(555);
    expect(remote.cols).toBe(100);

    remote.write('hello');
    expect(fake.write).toHaveBeenCalledWith('hello');

    const exitListener = vi.fn();
    client.onPtyExit(remote.ptyId, exitListener);
    fake.exit(3);
    expect(exitListener).toHaveBeenCalledWith(3);
    expect(remote.hasExited).toBe(true);
  });

  it('a RemotePty throws ESRCH on kill and refuses a resize once the host reported the exit, like node-pty', () => {
    const transport = { post: vi.fn() } as unknown as InProcessPtyHostTransport;
    const remote = new RemotePty(1, 99, 80, 24, transport);

    remote.resize(100, 30);
    expect(remote.cols).toBe(100);
    remote.kill();
    expect(transport.post).toHaveBeenCalledWith({ type: 'kill', ptyId: 1 });

    remote.markExited();
    expect(() => remote.kill()).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => remote.resize(80, 24)).toThrow();
    // A write to a dead PTY is dropped, never sent.
    vi.mocked(transport.post).mockClear();
    remote.write('ignored');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('runs a probe\'s raw PTY in the host: raw output, write and kill by ptyId, and one exit', async () => {
    const fake = createFakePty(777);
    const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
    (transport.core as unknown as { spawnPty: unknown }).spawnPty = () => fake.pty;
    const client = new PtyHostClient(transport);

    const raw = await client.spawnRaw('claude', ['--safe-mode'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/mock/scratch', env: {} });
    expect(raw.pid).toBe(777);
    const output: string[] = [];
    raw.onData((data) => output.push(data));
    const exitListener = vi.fn();
    raw.onExit(exitListener);

    // Raw: every chunk as it came, with none of the session pipeline's merging.
    fake.feed('❯ ');
    fake.feed('Select model');
    expect(output).toEqual(['❯ ', 'Select model']);
    raw.write('/model');
    expect(fake.write).toHaveBeenCalledWith('/model');
    raw.kill();
    raw.kill();
    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(transport.core.livePtyCount).toBe(1);

    fake.exit(0);
    expect(exitListener).toHaveBeenCalledWith({ exitCode: 0 });
    expect(transport.core.livePtyCount).toBe(0);
  });

  it('a raw spawn that throws in the host rejects with that error, not as an unreachable host', async () => {
    const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
    (transport.core as unknown as { spawnPty: unknown }).spawnPty = () => {
      throw Object.assign(new Error('File not found: agy'), { code: 'ENOENT' });
    };
    const client = new PtyHostClient(transport);
    const { HostUnavailableError } = await import('../../src/main/utility-process/off-main-pty');
    const failure = client.spawnRaw('agy', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/mock', env: {} });
    await expect(failure).rejects.toMatchObject({ message: 'File not found: agy', code: 'ENOENT' });
    await expect(failure).rejects.not.toBeInstanceOf(HostUnavailableError);
  });

  /** A transport whose host never answers a request: it exited, or timed out. */
  function unansweredTransport(cause: unknown) {
    const posted: PtyHostCommand[] = [];
    const requestedPtyIds: number[] = [];
    const transport: PtyHostTransport = {
      post: (command) => { posted.push(command); },
      request: ((_method: string, params: { ptyId: number }) => {
        requestedPtyIds.push(params.ptyId);
        return Promise.reject(cause);
      }) as unknown as PtyHostTransport['request'],
      setEventListener: () => undefined,
      hostPid: null,
      shutdown: () => undefined,
    };
    return { transport, posted, requestedPtyIds };
  }

  const spawnInput = {
    sessionId: 'session-1',
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'bash',
    args: [] as string[],
    cwd: '/mock/project',
    env: {},
    cols: 100,
    rows: 40,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
  };

  it('a spawn the host never answers resolves as a failed spawn, and kills the PTY it may still start', async () => {
    const { transport, posted, requestedPtyIds } = unansweredTransport(new Error('The pty host exited'));
    const client = new PtyHostClient(transport);

    // Resolves, never throws: a throw skipped the session's spawn-failure path
    // and left a promoted queue row `queued` for good.
    const outcome = await client.spawn(spawnInput);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a failed spawn');
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe('The pty host exited');
    expect(outcome.previousScrollback).toBe('');
    // The kill names the very ptyId the request carried, so a host that runs
    // the request late finds that PTY and ends it.
    expect(requestedPtyIds).toHaveLength(1);
    expect(posted).toEqual([{ type: 'kill', ptyId: requestedPtyIds[0] }]);

    // The next attempt uses a fresh id, and is killed under that one.
    await client.spawn(spawnInput);
    expect(requestedPtyIds[1]).not.toBe(requestedPtyIds[0]);
    expect(posted[1]).toEqual({ type: 'kill', ptyId: requestedPtyIds[1] });
  });

  it('wraps a spawn rejection that is not an Error, so the failure path always gets one', async () => {
    const { transport } = unansweredTransport('request timed out');
    const client = new PtyHostClient(transport);

    const outcome = await client.spawn(spawnInput);

    if (outcome.ok) throw new Error('expected a failed spawn');
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe('request timed out');
  });

  it('a raw spawn the host never answers rejects as an unreachable host, and kills the PTY it may still start', async () => {
    const { transport, posted, requestedPtyIds } = unansweredTransport(new Error('The pty host did not answer spawnRaw in time'));
    const client = new PtyHostClient(transport);

    const failure = client.spawnRaw('agy', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/mock', env: {} });

    // HostUnavailableError is the signal for the caller to spawn locally.
    await expect(failure).rejects.toBeInstanceOf(HostUnavailableError);
    await expect(failure).rejects.toThrow('The pty host did not answer spawnRaw in time');
    expect(requestedPtyIds).toHaveLength(1);
    expect(posted).toEqual([{ type: 'kill', ptyId: requestedPtyIds[0] }]);
  });

  it('asks the host to await the tasks\' agent exit with the caller\'s budget, and hands back the host\'s answer', async () => {
    const hostAnswer = { found: ['claude.exe'], stillRunning: [], waitedMs: 1200 };
    const request = vi.fn(async () => hostAnswer);
    const transport: PtyHostTransport = {
      post: () => undefined,
      request: request as unknown as PtyHostTransport['request'],
      setEventListener: () => undefined,
      hostPid: null,
      shutdown: () => undefined,
    };
    const client = new PtyHostClient(transport);

    const answer = await client.awaitAgentExit(['task-a', 'task-b'], 13_000);

    expect(request).toHaveBeenCalledTimes(1);
    // The caller's budget rides along in the options; without it the transport falls back to its own default.
    expect(request).toHaveBeenCalledWith('awaitAgentExit', { taskIds: ['task-a', 'task-b'] }, { timeoutMs: 13_000 });
    expect(answer).toBe(hostAnswer);
  });

  it('gives a spawn and a raw spawn the budget the host\'s retry window is sized against', async () => {
    const request = vi.fn(async () => ({ ok: true, pid: 4242 }));
    const transport: PtyHostTransport = {
      post: () => undefined,
      request: request as unknown as PtyHostTransport['request'],
      setEventListener: () => undefined,
      hostPid: null,
      shutdown: () => undefined,
    };
    const client = new PtyHostClient(transport);

    await client.spawn(spawnInput);
    await client.spawnRaw('claude', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/mock', env: {} });

    expect(request.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['spawn', { timeoutMs: SPAWN_REQUEST_TIMEOUT_MS }],
      ['spawnRaw', { timeoutMs: SPAWN_REQUEST_TIMEOUT_MS }],
    ]);
  });

  it('stamps each spawn with main\'s clock as it is sent, whatever stamp the caller passes', async () => {
    const request = vi.fn(async (_method: string, _params: { sentAtMs?: number }) => ({ ok: true, pid: 4242 }));
    const transport: PtyHostTransport = {
      post: () => undefined,
      request: request as unknown as PtyHostTransport['request'],
      setEventListener: () => undefined,
      hostPid: null,
      shutdown: () => undefined,
    };
    const client = new PtyHostClient(transport);
    // The host reads the stamp against its own clock to learn how long the request waited.
    const FIRST_SEND_MS = 1_900_000_000_000;
    const withStaleStamp = { ...spawnInput, sentAtMs: 1 };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(FIRST_SEND_MS);
      await client.spawn(spawnInput);
      // A later send reads the clock again, and a caller cannot stamp over it.
      vi.setSystemTime(FIRST_SEND_MS + 7_000);
      await client.spawn(withStaleStamp);
    } finally {
      vi.useRealTimers();
    }

    expect(request.mock.calls.map((call) => [call[0], call[1].sentAtMs])).toEqual([
      ['spawn', FIRST_SEND_MS],
      ['spawn', FIRST_SEND_MS + 7_000],
    ]);
  });
});
