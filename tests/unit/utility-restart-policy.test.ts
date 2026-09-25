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

import {
  UtilityRestartPolicy,
  resetUtilityCrashTelemetryForTests,
} from '../../src/main/utility-process/restart-policy';

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
});
