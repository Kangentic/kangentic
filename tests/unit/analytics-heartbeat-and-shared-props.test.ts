import { describe, it, expect, vi, beforeEach } from 'vitest';

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
