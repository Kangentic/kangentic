import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

const mocks = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@aptabase/electron/main', () => ({
  initialize: mocks.initialize,
  trackEvent: mocks.trackEvent,
}));

import {
  initAnalytics,
  trackEvent,
  setAnalyticsClientId,
  getAnalyticsClientId,
  shouldEmitHeartbeat,
  HEARTBEAT_INTERVAL_MS,
} from '../../src/main/analytics/analytics';

describe('shouldEmitHeartbeat', () => {
  it('emits when at least one session is active', () => {
    expect(shouldEmitHeartbeat({ active: 1 })).toBe(true);
    expect(shouldEmitHeartbeat({ active: 3 })).toBe(true);
  });

  it('skips when there are no active sessions', () => {
    expect(shouldEmitHeartbeat({ active: 0 })).toBe(false);
  });
});

describe('HEARTBEAT_INTERVAL_MS', () => {
  it('stays at least a minute inside the SDK session window, so a late tick never opens a new dashboard session', () => {
    // @aptabase/electron rotates its session id when the whole-second gap
    // since the last event is strictly greater than 3600, so an interval at
    // or above 60 minutes sits on that boundary.
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(59 * 60_000);
  });

  it('stays at or above the budget floor: shortening it back toward 30 minutes is what the event budget cannot afford', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(45 * 60_000);
  });
});

describe('app key override', () => {
  afterEach(() => {
    delete process.env.KANGENTIC_APTABASE_APP_KEY;
  });

  it('initializes the SDK with KANGENTIC_APTABASE_APP_KEY when set, so a local sink can receive the stream', () => {
    process.env.KANGENTIC_APTABASE_APP_KEY = 'A-DEV-0000000000';
    initAnalytics();
    expect(mocks.initialize).toHaveBeenLastCalledWith('A-DEV-0000000000');
  });

  it('falls back to the production key when the override is unset or blank', () => {
    process.env.KANGENTIC_APTABASE_APP_KEY = '   ';
    initAnalytics();
    expect(mocks.initialize).toHaveBeenLastCalledWith(expect.stringMatching(/^A-US-\d+$/));
  });
});

describe('trackEvent clientId scoping', () => {
  beforeEach(() => {
    mocks.trackEvent.mockClear();
    initAnalytics();
  });

  it('does not merge the client id into a generic event', () => {
    setAnalyticsClientId('deadbeef');
    trackEvent('app_heartbeat', { active: 1 });

    expect(mocks.trackEvent).toHaveBeenCalledWith('app_heartbeat', { active: 1 });
  });

  it('does not merge the client id into session_exit', () => {
    setAnalyticsClientId('deadbeef');
    trackEvent('session_exit', { exitCode: 0 });

    expect(mocks.trackEvent).toHaveBeenCalledWith('session_exit', { exitCode: 0 });
  });

  it('attaches the client id to app_launch only when the caller passes it explicitly', () => {
    setAnalyticsClientId('deadbeef');
    trackEvent('app_launch', { platform: 'win32', clientId: getAnalyticsClientId() });

    expect(mocks.trackEvent).toHaveBeenCalledWith('app_launch', {
      platform: 'win32',
      clientId: 'deadbeef',
    });
  });
});
