/**
 * The gate that holds a new PTY's events until its spawn has been answered with
 * a real pid (src/main/pty/host/root-pid-gate.ts), driven directly over a fake
 * PTY whose pid is a plain field.
 *
 * These pin the release drain and the gate's timers. The drain runs what was
 * held in arrival order on the next macrotask, and a handler that throws must
 * not cost the ones after it, because the exit is usually last and without it
 * the PTY never leaves the host's table. Whatever way the gate settles (the pid
 * was read, the PTY exited first, the 10 s backstop ran out) it must leave no
 * timer behind, since the host builds one gate per spawn on Windows.
 *
 * They also pin the failed answer's text and the retry window for a ConPTY
 * whose output never connected (Sentry DESKTOP-23): a retry gets node-pty's
 * full connect timeout and still answers inside main's budget for the spawn.
 *
 * Fake timers drive everything. The gate arms both its timers in its
 * constructor, so each test builds its gate after the clock is installed.
 *
 * Tier: Unit.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NODE_PTY_CONNECT_TIMEOUT_MS,
  PTY_OUTPUT_NOT_CONNECTED_CODE,
  ROOT_PID_POLL_MS,
  ROOT_PID_WAIT_LIMIT_MS,
  RootPidGate,
  SPAWN_ANSWER_MARGIN_MS,
  SPAWN_REQUEST_TIMEOUT_MS,
  SPAWN_RETRY_MIN_WINDOW_MS,
  processNotStartedError,
  retryWindowMs,
} from '../../src/main/pty/host/root-pid-gate';

const requireFromTest = createRequire(import.meta.url);

/** The one field the gate reads. node-pty sets it after spawn() returns on Windows. */
function createPty(pid: number): { pid: number } {
  return { pid };
}

describe('RootPidGate release drain', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a held handler that throws without dropping the ones after it, then rethrows the first error', () => {
    const gate = new RootPidGate(createPty(4242));
    const calls: string[] = [];
    const onData = gate.gateOutput((data) => {
      calls.push(`data:${data}`);
      throw new Error(`${data} handler failed`);
    });
    const onExit = gate.gateExit((exitCode) => {
      calls.push(`exit:${exitCode}`);
    });
    onData('first');
    onData('second');
    onExit(0, undefined);
    expect(calls).toEqual([]);

    gate.release();
    // Two handlers throw, so the first error surfacing is a choice the drain
    // makes, not the only error there was.
    expect(() => vi.advanceTimersByTime(0)).toThrow('first handler failed');

    expect(calls).toEqual(['data:first', 'data:second', 'exit:0']);
  });

  it('runs held output before a held exit, in arrival order, and only on the macrotask after release()', () => {
    const gate = new RootPidGate(createPty(4242));
    const calls: string[] = [];
    const onData = gate.gateOutput((data) => {
      calls.push(`data:${data}`);
    });
    const onExit = gate.gateExit((exitCode, signal) => {
      calls.push(`exit:${exitCode}:${signal}`);
    });
    onData('a');
    onData('b');
    onExit(7, 15);

    gate.release();
    // The answer goes out first. Nothing held may run inside release() itself.
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['data:a', 'data:b', 'exit:7:15']);

    // Once drained the gate is open. A later event is handled at once, not held.
    onData('live');
    expect(calls.at(-1)).toBe('data:live');
  });

  it('keeps holding when the backstop fires, and delivers what was held once released', async () => {
    const gate = new RootPidGate(createPty(0));
    const calls: string[] = [];
    const onData = gate.gateOutput((data) => {
      calls.push(`data:${data}`);
    });
    onData('before the backstop');

    vi.advanceTimersByTime(ROOT_PID_WAIT_LIMIT_MS);
    await expect(gate.outcome).resolves.toEqual({ kind: 'timedOut' });
    // The outcome alone releases nothing. The spawn answer must go out first.
    expect(calls).toEqual([]);
    onData('after the backstop');
    expect(calls).toEqual([]);

    gate.release();
    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['data:before the backstop', 'data:after the backstop']);
  });
});

describe('RootPidGate timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arms a poll interval and a backstop, so a zero timer count below means something', () => {
    new RootPidGate(createPty(0));
    expect(vi.getTimerCount()).toBe(2);
  });

  it('leaves no timer pending once the pid is read', async () => {
    const pty = createPty(0);
    const gate = new RootPidGate(pty);

    pty.pid = 4242;
    vi.advanceTimersByTime(ROOT_PID_POLL_MS);

    await expect(gate.outcome).resolves.toEqual({ kind: 'started' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending once the PTY exits before it has a pid', async () => {
    const gate = new RootPidGate(createPty(0));
    const onExit = gate.gateExit(() => undefined);

    onExit(267, undefined);

    await expect(gate.outcome).resolves.toEqual({ kind: 'failed', exitCode: 267 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending once the backstop has run out', async () => {
    const gate = new RootPidGate(createPty(0));

    vi.advanceTimersByTime(ROOT_PID_WAIT_LIMIT_MS);

    await expect(gate.outcome).resolves.toEqual({ kind: 'timedOut' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs out at the limit a retry passes, not before and not at the default', async () => {
    const gate = new RootPidGate(createPty(0), 9_000);
    let settled = false;
    void gate.outcome.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(8_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(gate.outcome).resolves.toEqual({ kind: 'timedOut' });
  });
});

describe('RootPidGate stall measure', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads one poll interval while the loop runs every poll on time', async () => {
    const gate = new RootPidGate(createPty(0));

    await vi.advanceTimersByTimeAsync(2_000);

    expect(gate.longestStallMs).toBe(ROOT_PID_POLL_MS);
  });

  it('reads the gap a held loop left between two polls', async () => {
    const gate = new RootPidGate(createPty(0));
    await vi.advanceTimersByTimeAsync(500);

    // A held loop runs no timer: the clock moves with no poll between.
    vi.setSystemTime(Date.now() + 5_200);
    await vi.advanceTimersByTimeAsync(ROOT_PID_POLL_MS);

    expect(gate.longestStallMs).toBe(5_200 + ROOT_PID_POLL_MS);
  });

  it('counts the gap that ends in the exit, which can run before the next poll', async () => {
    const gate = new RootPidGate(createPty(0));
    const onExit = gate.gateExit(() => undefined);
    await vi.advanceTimersByTimeAsync(500);

    vi.setSystemTime(Date.now() + 5_200);
    onExit(-1, undefined);

    await expect(gate.outcome).resolves.toEqual({ kind: 'failed', exitCode: -1 });
    expect(gate.longestStallMs).toBe(5_200);
  });
});

describe('processNotStartedError', () => {
  it('names an output connection that never came up, with the attempt\'s time, the host\'s longest stall and its own code', () => {
    const error = processNotStartedError(-1, 5012, 4870) as NodeJS.ErrnoException;
    expect(error.message).toBe('Terminal output never connected after 5012 ms, longest pty host stall 4870 ms (ConPTY error code: -1)');
    expect(error.code).toBe(PTY_OUTPUT_NOT_CONNECTED_CODE);
  });

  it('keeps node-pty 1.1.0\'s text, and no code, for a CreateProcessW failure', () => {
    const error = processNotStartedError(267, 40, 10) as NodeJS.ErrnoException;
    expect(error.message).toBe('Cannot create process, error code: 267');
    expect(error.code).toBeUndefined();
  });
});

describe('the retry window for a ConPTY whose output never connected', () => {
  it('leaves a first attempt that ran node-pty\'s full timeout a full second one', () => {
    const windowMs = retryWindowMs(NODE_PTY_CONNECT_TIMEOUT_MS);
    expect(windowMs).toBe(9_000);
    expect(windowMs).toBeGreaterThanOrEqual(NODE_PTY_CONNECT_TIMEOUT_MS);
  });

  it('ends every retry before main stops waiting for the answer', () => {
    for (let elapsedMs = 0; elapsedMs <= SPAWN_REQUEST_TIMEOUT_MS; elapsedMs += 250) {
      const windowMs = retryWindowMs(elapsedMs);
      if (windowMs === null) continue;
      expect(elapsedMs + windowMs + SPAWN_ANSWER_MARGIN_MS).toBeLessThanOrEqual(SPAWN_REQUEST_TIMEOUT_MS);
      expect(windowMs).toBeLessThanOrEqual(ROOT_PID_WAIT_LIMIT_MS);
    }
  });

  it('gives no retry once too little is left for node-pty\'s full timeout', () => {
    expect(retryWindowMs(8_000)).toBe(SPAWN_RETRY_MIN_WINDOW_MS);
    expect(retryWindowMs(8_001)).toBeNull();
  });

  it('never fits a third attempt: two timed-out attempts leave no window', () => {
    expect(retryWindowMs(2 * NODE_PTY_CONNECT_TIMEOUT_MS)).toBeNull();
  });

  it('matches node-pty\'s own connect timeout, so a node-pty bump that moves it fails here', () => {
    const agentSource = fs.readFileSync(requireFromTest.resolve('node-pty/lib/windowsPtyAgent.js'), 'utf8');
    expect(agentSource).toMatch(new RegExp(`\\bCONNECTION_TIMEOUT = ${NODE_PTY_CONNECT_TIMEOUT_MS};`));
  });
});
