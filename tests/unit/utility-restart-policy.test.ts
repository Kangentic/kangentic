import { describe, it, expect, vi, beforeEach } from 'vitest';

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
 *     while EVERY crash still increments the Aptabase counter. That split is
 *     what keeps the volume signal without an un-actionable issue.
 */

const { mockTrackEvent, mockReportHandledError } = vi.hoisted(() => ({
  mockTrackEvent: vi.fn(),
  mockReportHandledError: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mockReportHandledError,
}));

import { UtilityRestartPolicy } from '../../src/main/utility-process/restart-policy';

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

describe('UtilityRestartPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  describe('telemetry split - counter every crash, issue once per latch', () => {
    it('counts every crash in Aptabase with the service and exit code', () => {
      const { policy, clock } = makePolicy();
      policy.recordCrash(9);
      clock.advance(4_000);
      policy.recordCrash(9);

      expect(mockTrackEvent).toHaveBeenCalledTimes(2);
      expect(mockTrackEvent).toHaveBeenCalledWith('utility_worker_crashed', {
        service: 'kangentic-test-worker',
        exitCode: 9,
      });
    });

    it('reports a recoverable crash to the counter but NOT to Sentry', () => {
      const { policy } = makePolicy();
      policy.recordCrash(1);

      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      // A single self-healing crash is not actionable, so it must not become an
      // issue. This is the assertion that keeps the fix from simply relabelling
      // the three events it was meant to remove.
      expect(mockReportHandledError).not.toHaveBeenCalled();
    });

    it('reports exactly once at the latch, naming the service and exit code', () => {
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
    });

    it('does not re-report on further crashes after the latch', () => {
      const { policy, clock } = makePolicy();
      for (let index = 0; index < 6; index++) {
        policy.recordCrash(1);
        clock.advance(4_000);
      }
      expect(mockReportHandledError).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledTimes(6);
    });

    it('records a fork failure (no exit code) without throwing', () => {
      const { policy } = makePolicy();
      policy.recordCrash(null);
      expect(mockTrackEvent).toHaveBeenCalledWith('utility_worker_crashed', {
        service: 'kangentic-test-worker',
        exitCode: -1,
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
});
