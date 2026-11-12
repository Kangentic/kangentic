/**
 * A session on an SSH host hears nothing while its link is down (#913): no hook file and no output
 * byte can cross. The activity watchdog read that silence as a stuck agent after 180 seconds and
 * forced idle on a turn that was still running on the host, which fired the turn-end automations
 * and, with the idle timeout on, paused the task and ended its agent when the link came back.
 *
 * These run the real `SessionTelemetry` and its engine with fake timers. `isActivityHeld` and
 * `isIdleTimeoutExempt` are what `SessionManager` answers from the hosts whose link is down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { ActivityState } from '../../src/shared/types';

const STALE_THINKING_MS = 1_000;
const SESSION_ID = 'remote-session';

interface Harness {
  telemetry: SessionTelemetry;
  activity: ActivityState[];
  idleTimeouts: string[];
  linkDown: { value: boolean };
}

function makeHarness(): Harness {
  const activity: ActivityState[] = [];
  const idleTimeouts: string[] = [];
  const linkDown = { value: false };
  const telemetry = new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: (_sessionId, next) => { activity.push(next); },
      onEvent: () => {},
      onIdleTimeout: (sessionId) => { idleTimeouts.push(sessionId); },
      onPlanExit: () => {},
      onPRCandidate: () => {},
      requestSuspend: () => {},
      isSessionRunning: () => true,
      isIdleTimeoutExempt: () => linkDown.value,
      isActivityHeld: () => linkDown.value,
    },
    {
      disableBgShellWatcher: true,
      activityEngineOptions: { staleThinkingTimeoutMs: STALE_THINKING_MS, idleStabilityWindowMs: 0 },
    },
  );
  return { telemetry, activity, idleTimeouts, linkDown };
}

describe('a session on a host whose link is down', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = makeHarness();
  });

  afterEach(() => {
    harness.telemetry.dispose();
    vi.useRealTimers();
  });

  it('is forced idle by the stale-thinking watchdog when nothing holds it (the control)', () => {
    harness.telemetry.initSession(SESSION_ID, undefined, true);
    vi.advanceTimersByTime(STALE_THINKING_MS * 2);
    expect(harness.activity.at(-1)).toBe('idle');
  });

  it('stays thinking however long the link is down', () => {
    harness.telemetry.initSession(SESSION_ID, undefined, true);
    harness.linkDown.value = true;
    vi.advanceTimersByTime(STALE_THINKING_MS * 60);
    expect(harness.activity.at(-1)).toBe('thinking');
  });

  it('is not forced idle the moment the link returns, and gets a full window from then', () => {
    harness.telemetry.initSession(SESSION_ID, undefined, true);
    harness.linkDown.value = true;
    vi.advanceTimersByTime(STALE_THINKING_MS * 60);

    harness.linkDown.value = false;
    harness.telemetry.noteLinkRestored([SESSION_ID]);
    vi.advanceTimersByTime(STALE_THINKING_MS / 2);
    expect(harness.activity.at(-1)).toBe('thinking');

    // Silence that lasts a whole window after the link is back is the watchdog's again.
    vi.advanceTimersByTime(STALE_THINKING_MS * 2);
    expect(harness.activity.at(-1)).toBe('idle');
  });

  it('is not paused by the idle timeout for the time it was down', () => {
    harness.telemetry.initSession(SESSION_ID);
    harness.telemetry.setIdleTimeout(2);
    harness.linkDown.value = true;
    vi.advanceTimersByTime(10 * 60_000);
    expect(harness.idleTimeouts).toEqual([]);

    harness.linkDown.value = false;
    harness.telemetry.noteLinkRestored([SESSION_ID]);
    vi.advanceTimersByTime(60_000);
    expect(harness.idleTimeouts).toEqual([]);

    // Idle for two real minutes with the link up is the timeout's, as it is for any session.
    vi.advanceTimersByTime(2 * 60_000);
    expect(harness.idleTimeouts).toEqual([SESSION_ID]);
  });

  it('would be paused at once without the reset when the link returns (the control)', () => {
    harness.telemetry.initSession(SESSION_ID);
    harness.telemetry.setIdleTimeout(2);
    harness.linkDown.value = true;
    vi.advanceTimersByTime(10 * 60_000);

    harness.linkDown.value = false;
    vi.advanceTimersByTime(60_000);
    expect(harness.idleTimeouts).toEqual([SESSION_ID]);
  });
});
