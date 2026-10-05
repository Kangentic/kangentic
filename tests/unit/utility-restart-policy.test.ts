import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * UtilityRestartPolicy - the backoff / decay / reporting contract shared by the
 * two utility processes Kangentic owns (kangentic-embeddings,
 * kangentic-line-count).
 *
 * The bug this exists to prevent: both clients used to re-fork immediately on
 * the next request, bounded only by a crash cap, so a worker that died on
 * startup burned its entire cap in milliseconds - three exits inside four
 * seconds - and then stayed dead for the rest of the app run with no in-app
 * signal. That is the signature that reached error reporting as three
 * un-attributable "'Utility' process exited with 'abnormal-exit'" events.
 *
 * The load-bearing assertions are therefore:
 *   - a crash burst CANNOT happen (backoff blocks the immediate respawn),
 *   - the latch is not permanent (decay), and
 *   - exactly ONE Sentry report is produced per latch, not one per crash,
 *     while Aptabase sees at most TWO events per service per app run: the
 *     first crash (installs affected) and the latch (installs whose subsystem
 *     gave up). It used to tick on every crash, which read as "71 crashes a
 *     day" when it was a handful of installs looping.
 */

const { mockTrackEvent, mockReportHandledError } = vi.hoisted(() => ({
  mockTrackEvent: vi.fn(),
  mockReportHandledError: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mockReportHandledError,
}));

import { EventEmitter } from 'node:events';
import {
  STDERR_DRAIN_BOUND_MS,
  UtilityRestartPolicy,
  resetUtilityCrashTelemetryForTests,
} from '../../src/main/utility-process/restart-policy';
import { StderrTail, captureWorkerStderr } from '../../src/main/utility-process/stderr-tail';

/** A controllable clock, so no test depends on wall time. */
function makeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makePolicy(overrides: Partial<{ maxCrashes: number; decayMs: number }> = {}) {
  const clock = makeClock();
  const policy = new UtilityRestartPolicy({
    service: 'kangentic-test-worker',
    maxCrashes: overrides.maxCrashes ?? 3,
    backoffMs: [1_000, 5_000, 15_000],
    decayMs: overrides.decayMs ?? 300_000,
    now: clock.now,
  });
  return { policy, clock };
}

/** A crash's stderr as the policy holds it: by reference, so a test can make
 *  text land AFTER the crash was recorded, the way a still-draining pipe does. */
function makeStderrSource(initial = ''): { snapshot: () => string; set: (text: string) => void } {
  let text = initial;
  return {
    snapshot: () => text,
    set: (next: string) => {
      text = next;
    },
  };
}

describe('UtilityRestartPolicy', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // The Aptabase phase latches are per RUN (module scope), not per policy.
    resetUtilityCrashTelemetryForTests();
    // Every crash logs its stderr; keep that out of the test output.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('backoff - the crash-burst guard', () => {
    it('allows the first spawn with no waiting', () => {
      const { policy } = makePolicy();
      expect(policy.maySpawn()).toBe(true);
    });

    it('refuses an immediate respawn after a crash, and allows it once the delay elapses', () => {
      const { policy, clock } = makePolicy();
      policy.recordCrash(1);

      // This is the assertion that fails against the old immediate-refork code.
      expect(policy.maySpawn()).toBe(false);

      clock.advance(999);
      expect(policy.maySpawn()).toBe(false);

      clock.advance(1);
      expect(policy.maySpawn()).toBe(true);
    });

    it('grows the delay with each successive crash', () => {
      const { policy, clock } = makePolicy();

      policy.recordCrash(1);
      clock.advance(1_000);
      expect(policy.maySpawn()).toBe(true);

      policy.recordCrash(1);
      clock.advance(1_000);
      // The second crash waits 5000ms, so 1000 is no longer enough.
      expect(policy.maySpawn()).toBe(false);
      clock.advance(4_000);
      expect(policy.maySpawn()).toBe(true);
    });

    it('cannot reach the cap inside the four-second window the real incident showed', () => {
      const { policy, clock } = makePolicy();
      // Drive it exactly as a crash-looping worker would: try, crash, retry
      // the instant the caller next asks. Four seconds of that must not
      // exhaust a 3-crash cap, which it did before backoff existed.
      let crashes = 0;
      for (let elapsed = 0; elapsed < 4_000; elapsed += 100) {
        if (policy.maySpawn()) {
          policy.recordCrash(1);
          crashes += 1;
        }
        clock.advance(100);
      }
      expect(crashes).toBeLessThan(3);
      expect(policy.exhausted).toBe(false);
    });
  });

  describe('the cap', () => {
    it('exhausts after maxCrashes and refuses further spawns', () => {
      const { policy, clock } = makePolicy();
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      expect(policy.exhausted).toBe(true);
      expect(policy.maySpawn()).toBe(false);
    });

    it('is not exhausted before the cap is reached', () => {
      const { policy, clock } = makePolicy();
      policy.recordCrash(1);
      clock.advance(4_000);
      policy.recordCrash(1);
      expect(policy.exhausted).toBe(false);
    });
  });

  describe('decay - the latch must not be permanent', () => {
    it('clears the crash count after a quiet period, so the subsystem recovers', () => {
      const { policy, clock } = makePolicy({ decayMs: 300_000 });
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      expect(policy.exhausted).toBe(true);

      clock.advance(300_000);

      // Without decay this stayed true for the rest of the app run - which for
      // the line-count client (a module singleton nothing replaces) meant the
      // feature was gone until restart.
      expect(policy.exhausted).toBe(false);
      expect(policy.maySpawn()).toBe(true);
    });

    it('measures the quiet window from the LAST crash, not the first', () => {
      const { policy, clock } = makePolicy({ decayMs: 300_000 });
      // Three crashes spread over 200s. Total elapsed already exceeds nothing
      // relevant: what matters is the gap since the most recent one.
      policy.recordCrash(1);
      clock.advance(100_000);
      policy.recordCrash(1);
      clock.advance(100_000);
      policy.recordCrash(1);
      expect(policy.exhausted).toBe(true);

      clock.advance(299_999);
      expect(policy.exhausted).toBe(true);

      clock.advance(1);
      expect(policy.exhausted).toBe(false);
    });

    it('re-arms the latch report after a decay, so a second latch is reported again', () => {
      const { policy, clock } = makePolicy({ decayMs: 300_000 });
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      expect(mockReportHandledError).toHaveBeenCalledTimes(1);

      clock.advance(300_000);
      expect(policy.exhausted).toBe(false);

      for (let index = 0; index < 3; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      expect(mockReportHandledError).toHaveBeenCalledTimes(2);
    });
  });

  describe('telemetry split - two Aptabase events per service per run, issue once per latch', () => {
    it('sends the first crash once, with the service, exit code, and phase, and not the second', () => {
      const { policy, clock } = makePolicy();
      policy.recordCrash(9);
      clock.advance(4_000);
      policy.recordCrash(9);

      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith('utility_worker_crashed', {
        service: 'kangentic-test-worker',
        exitCode: 9,
        phase: 'first',
      });
    });

    it('reports a recoverable crash to Aptabase but NOT to Sentry', () => {
      const { policy } = makePolicy();
      policy.recordCrash(1);

      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      // A single self-healing crash is not actionable, so it must not become an
      // issue. This is the assertion that keeps the fix from simply relabelling
      // the three events it was meant to remove.
      expect(mockReportHandledError).not.toHaveBeenCalled();
    });

    it('reports exactly once at the latch, naming the service and exit code, and sends the latched phase at the same moment', () => {
      const { policy, clock } = makePolicy();
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(137);
        clock.advance(4_000);
      }

      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      const [error, tags] = mockReportHandledError.mock.calls[0];
      expect(error).toBeInstanceOf(Error);
      // The acceptance criterion: the report names the service and its exit code.
      expect((error as Error).message).toContain('kangentic-test-worker');
      expect((error as Error).message).toContain('137');
      expect(tags).toEqual({
        source: 'utility_process',
        service: 'kangentic-test-worker',
        exitCode: '137',
        crashCount: '3',
      });

      // The Aptabase side: `first` on crash one, `latched` on crash three, and
      // nothing for crash two. The crash count is not on the event because it
      // is a constant per phase; the Sentry tag above carries it.
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
      expect(mockTrackEvent).toHaveBeenLastCalledWith('utility_worker_crashed', {
        service: 'kangentic-test-worker',
        exitCode: 137,
        phase: 'latched',
      });
    });

    it('does not re-report on further crashes after the latch, on either surface', () => {
      const { policy, clock } = makePolicy();
      for (let index = 0; index < 6; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    });

    it('records a fork failure (no exit code) without throwing', () => {
      const { policy } = makePolicy();
      policy.recordCrash(null);
      expect(mockTrackEvent).toHaveBeenCalledWith('utility_worker_crashed', {
        service: 'kangentic-test-worker',
        exitCode: -1,
        phase: 'first',
      });
    });

    it('a decay re-arms the Sentry latch but never the Aptabase phases: the cap is per run, not per window', () => {
      // Without this, a worker that crashes once every ten minutes would send
      // a "first crash" every ten minutes, which is the tick the reshape
      // exists to remove.
      const { policy, clock } = makePolicy({ decayMs: 300_000 });
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      clock.advance(300_000);
      expect(policy.exhausted).toBe(false);
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }

      expect(mockReportHandledError).toHaveBeenCalledTimes(2);
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
    });

    it('two policy instances for the same service share the per-run cap; a different service does not', () => {
      // The embed client builds a fresh policy on every model change and
      // project switch, so a per-instance latch would re-fire on each one.
      const first = makePolicy();
      first.policy.recordCrash(1);
      const second = makePolicy();
      second.policy.recordCrash(1);
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);

      const other = new UtilityRestartPolicy({ service: 'kangentic-other-worker', maxCrashes: 3 });
      other.recordCrash(1);
      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
      expect(mockTrackEvent).toHaveBeenLastCalledWith('utility_worker_crashed', {
        service: 'kangentic-other-worker',
        exitCode: 1,
        phase: 'first',
      });
    });
  });

  describe('reset', () => {
    it('forgets the crash history and re-arms reporting', () => {
      const { policy, clock } = makePolicy();
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      expect(policy.exhausted).toBe(true);

      policy.reset();

      expect(policy.exhausted).toBe(false);
      expect(policy.maySpawn()).toBe(true);
    });
  });

  describe('stderr capture - what turns "exit code 1" into a diagnosis', () => {
    // DESKTOP-H: fourteen reports of `kangentic-embeddings worker exited
    // repeatedly (exit code 1)` and not one of them could say why, because the
    // worker's stderr was inherited into a GUI process with no console. The
    // tail now rides along as a Sentry CONTEXT (content), while the tags,
    // which drive grouping, stay exactly as they were.
    it('attaches the newest non-empty stderr to the latch report as a context, leaving the tags untouched', () => {
      const { policy, clock } = makePolicy();
      policy.recordCrash(1, makeStderrSource("Error: Cannot find module 'sharp'"));
      clock.advance(4_000);
      policy.recordCrash(1, makeStderrSource(''));
      clock.advance(4_000);
      policy.recordCrash(1, makeStderrSource(''));

      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      const [, tags, contexts] = mockReportHandledError.mock.calls[0];
      expect(tags).toEqual({
        source: 'utility_process',
        service: 'kangentic-test-worker',
        exitCode: '1',
        crashCount: '3',
      });
      expect(contexts).toEqual({
        utility_process: {
          service: 'kangentic-test-worker',
          exitCode: 1,
          crashCount: 3,
          stderrTail: "Error: Cannot find module 'sharp'",
        },
      });
    });

    it('reads the tail at report time, so bytes that land after the exit event still reach the report', () => {
      // UtilityProcess has no 'close' event; its stderr pipe can still be
      // draining when 'exit' fires. The latch report comes two backoffs later,
      // so reading the source THEN, not at recordCrash, is what makes the
      // capture race-free.
      const { policy, clock } = makePolicy();
      const lateSource = makeStderrSource('');
      policy.recordCrash(1, lateSource);
      clock.advance(4_000);
      lateSource.set('late text');
      policy.recordCrash(1, makeStderrSource(''));
      clock.advance(4_000);
      policy.recordCrash(1, makeStderrSource(''));

      const [, , contexts] = mockReportHandledError.mock.calls[0];
      expect(contexts.utility_process.stderrTail).toBe('late text');
    });

    it('reports a placeholder when no tail was ever captured (the fork-failure path)', () => {
      const { policy, clock } = makePolicy();
      for (let index = 0; index < 3; index++) {
        policy.recordCrash(null);
        clock.advance(4_000);
      }

      const [, , contexts] = mockReportHandledError.mock.calls[0];
      expect(contexts.utility_process).toEqual({
        service: 'kangentic-test-worker',
        exitCode: null,
        crashCount: 3,
        stderrTail: '(no stderr captured)',
      });
    });

    it('logs every crash with its stderr to console.warn, so the project log has the text even with reporting off', () => {
      const { policy } = makePolicy();
      policy.recordCrash(9, makeStderrSource('boom'));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('kangentic-test-worker exited with code 9'),
        expect.stringContaining('boom'),
      );
    });

    it('describes the newest crash for the in-app signal, and forgets it on reset', () => {
      const { policy } = makePolicy();
      expect(policy.lastCrashDescription).toBeNull();

      policy.recordCrash(
        1,
        makeStderrSource("node:internal/modules/cjs/loader:1228\n  throw err;\n\nError: Cannot find module 'sharp'\nRequire stack:"),
      );
      expect(policy.lastCrashDescription).toBe("exited with code 1: Error: Cannot find module 'sharp'");

      policy.reset();
      expect(policy.lastCrashDescription).toBeNull();
    });

    it('drops the description once the quiet window has decayed, along with the count', () => {
      const { policy, clock } = makePolicy({ decayMs: 60_000 });
      policy.recordCrash(1, makeStderrSource('Error: boom'));
      clock.advance(60_000);

      expect(policy.lastCrashDescription).toBeNull();
    });

    it('describes a crash with no stderr by its exit code alone', () => {
      const { policy } = makePolicy();
      policy.recordCrash(137);
      expect(policy.lastCrashDescription).toBe('exited with code 137');
    });
  });

  // Electron 44.5.0 drains a utility process's stderr after `exit` (electron/electron#54278), so
  // the dying exception can land a few milliseconds after recordCrash ran. Logging at once printed
  // "(no stderr captured)" for exactly the crash whose text was on its way.
  describe('waiting for the dying worker\'s stderr to drain', () => {
    function attachedTail(): { tail: StderrTail; stream: EventEmitter } {
      const stream = new EventEmitter();
      const tail = new StderrTail(8 * 1024, '/home/dev', false);
      captureWorkerStderr({ stderr: stream as unknown as NodeJS.ReadableStream }, tail, false);
      return { tail, stream };
    }

    async function flushMicrotasks(): Promise<void> {
      for (let index = 0; index < 5; index++) await Promise.resolve();
    }

    it('logs the text that arrives after the exit, once the pipe ends', async () => {
      const { policy } = makePolicy();
      const { tail, stream } = attachedTail();

      policy.recordCrash(1, tail);
      expect(warnSpy).not.toHaveBeenCalled();

      stream.emit('data', "Error: Cannot find module 'sharp'\n");
      stream.emit('end');
      await flushMicrotasks();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('kangentic-test-worker exited with code 1 (crash 1 of 3)'),
        expect.stringContaining("Cannot find module 'sharp'"),
      );
    });

    it('keeps counting, backoff and telemetry synchronous while the log waits', async () => {
      const { policy } = makePolicy();
      const { tail, stream } = attachedTail();

      policy.recordCrash(1, tail);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(policy.maySpawn()).toBe(false);
      expect(policy.lastCrashDescription).toBe('exited with code 1');
      expect(mockTrackEvent).toHaveBeenCalledWith('utility_worker_crashed', {
        service: 'kangentic-test-worker',
        exitCode: 1,
        phase: 'first',
      });

      // End the pipe so the pending log does not outlive this test.
      stream.emit('end');
      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('logs at the bound when the pipe never ends', async () => {
      vi.useFakeTimers();
      try {
        const { policy } = makePolicy();
        const { tail } = attachedTail();

        policy.recordCrash(1, tail);
        await vi.advanceTimersByTimeAsync(STDERR_DRAIN_BOUND_MS - 1);
        expect(warnSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.any(String), '(no stderr captured)');
      } finally {
        vi.useRealTimers();
      }
    });

    it('decides the latch at once, and sends the report with the late text once the pipe ends', async () => {
      const { policy, clock } = makePolicy();
      policy.recordCrash(1, makeStderrSource(''));
      clock.advance(4_000);
      policy.recordCrash(1, makeStderrSource(''));
      clock.advance(4_000);
      const { tail, stream } = attachedTail();
      policy.recordCrash(137, tail);

      // The latch is decided now: the subsystem is exhausted and Aptabase already has it.
      expect(policy.exhausted).toBe(true);
      expect(mockTrackEvent).toHaveBeenLastCalledWith('utility_worker_crashed', {
        service: 'kangentic-test-worker',
        exitCode: 137,
        phase: 'latched',
      });
      expect(mockReportHandledError).not.toHaveBeenCalled();

      stream.emit('data', 'Fatal: out of memory in onnxruntime\n');
      stream.emit('end');
      await flushMicrotasks();

      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      const [, tags, contexts] = mockReportHandledError.mock.calls[0];
      expect(tags.crashCount).toBe('3');
      expect(contexts.utility_process.stderrTail).toBe('Fatal: out of memory in onnxruntime');

      // A crash after the latch still waits, and still does not re-report.
      const next = attachedTail();
      policy.recordCrash(137, next.tail);
      next.stream.emit('end');
      await flushMicrotasks();
      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
    });

    it('labels each deferred log line with the crash number from when it was recorded, not the count at emit time', async () => {
      // Fake timers, deliberately: nothing may reach the 500 ms bound while two
      // crashes are pending, or a slow run would release the first waiter early
      // and let a regression pass. Promises are not faked, so the drain still
      // resolves through the microtask queue.
      vi.useFakeTimers();
      try {
        const { policy, clock } = makePolicy();
        const first = attachedTail();
        const second = attachedTail();

        policy.recordCrash(1, first.tail);
        clock.advance(1_000);
        // The second crash lands while the first one's pipe is still open, so
        // the policy's live count is 2 by the time the first line is printed.
        policy.recordCrash(1, second.tail);
        // Both crashes took the deferred path: nothing has been logged yet.
        expect(warnSpy).not.toHaveBeenCalled();

        first.stream.emit('data', 'first crash text\n');
        first.stream.emit('end');
        await flushMicrotasks();

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [firstLine] = warnSpy.mock.calls[0] as [string, string];
        expect(firstLine).toContain('(crash 1 of 3)');
        expect(firstLine).not.toContain('(crash 2 of 3)');

        second.stream.emit('data', 'second crash text\n');
        second.stream.emit('end');
        await flushMicrotasks();

        expect(warnSpy).toHaveBeenCalledTimes(2);
        const [secondLine] = warnSpy.mock.calls[1] as [string, string];
        expect(secondLine).toContain('(crash 2 of 3)');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports the latching crash as crash 3 even when a later crash is recorded before its pipe ends', async () => {
      // Same fake-timer reasoning as above. recordCrash has no exhausted guard,
      // so a crash after the latch is a real input (the test just before this
      // one records one), and it moves the live count past the cap while the
      // latching crash's report is still waiting.
      vi.useFakeTimers();
      try {
        const { policy, clock } = makePolicy();
        policy.recordCrash(1, makeStderrSource(''));
        clock.advance(4_000);
        policy.recordCrash(1, makeStderrSource(''));
        clock.advance(4_000);
        const latching = attachedTail();
        policy.recordCrash(137, latching.tail);
        clock.advance(1_000);
        const afterLatch = attachedTail();
        policy.recordCrash(137, afterLatch.tail);

        // The latch was decided at crash 3 and the report is held for its pipe.
        expect(policy.exhausted).toBe(true);
        expect(mockReportHandledError).not.toHaveBeenCalled();

        latching.stream.emit('data', 'Fatal: out of memory in onnxruntime\n');
        latching.stream.emit('end');
        await flushMicrotasks();

        expect(mockReportHandledError).toHaveBeenCalledTimes(1);
        const [, tags, contexts] = mockReportHandledError.mock.calls[0];
        expect(tags.crashCount).toBe('3');
        expect(contexts.utility_process.crashCount).toBe(3);

        // The crash after the latch finishes draining and still does not re-report.
        afterLatch.stream.emit('end');
        await flushMicrotasks();
        expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('logs to console.error, and leaks no unhandled rejection, when the deferred emit throws', async () => {
      // Real timers are fine here: whether the pipe ends or the bound releases
      // the waiter, the same emit runs and throws, so the outcome is identical.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const unhandledReasons: unknown[] = [];
      const recordUnhandled = (reason: unknown): void => {
        unhandledReasons.push(reason);
      };
      process.on('unhandledRejection', recordUnhandled);
      try {
        const reportFailure = new Error('error reporting transport is down');
        mockReportHandledError.mockImplementationOnce(() => {
          throw reportFailure;
        });

        const { policy, clock } = makePolicy();
        policy.recordCrash(1, makeStderrSource(''));
        clock.advance(4_000);
        policy.recordCrash(1, makeStderrSource(''));
        clock.advance(4_000);
        const { tail, stream } = attachedTail();
        policy.recordCrash(137, tail);

        // The latch report is deferred behind the open pipe, so nothing threw yet.
        expect(mockReportHandledError).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        stream.emit('data', 'Fatal: out of memory in onnxruntime\n');
        stream.emit('end');
        await flushMicrotasks();

        expect(mockReportHandledError).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(
          '[utility-process] could not log a worker crash:',
          reportFailure,
        );

        // Node raises 'unhandledRejection' only once the microtask queue has
        // drained, which the awaits above never allow. A macrotask boundary
        // makes the empty-list assertion below mean something.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandledReasons).toEqual([]);
      } finally {
        process.off('unhandledRejection', recordUnhandled);
        errorSpy.mockRestore();
        // clearAllMocks in beforeEach does not drop an unconsumed once-implementation.
        mockReportHandledError.mockReset();
      }
    });
  });
});
