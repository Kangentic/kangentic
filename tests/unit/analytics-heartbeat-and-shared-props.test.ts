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

import { initAnalytics, trackEvent, setAnalyticsClientId, shouldEmitHeartbeat } from '../../src/main/analytics/analytics';

describe('shouldEmitHeartbeat', () => {
  it('emits when at least one session is active', () => {
    expect(shouldEmitHeartbeat({ active: 1 })).toBe(true);
    expect(shouldEmitHeartbeat({ active: 3 })).toBe(true);
  });

  it('skips when there are no active sessions', () => {
    expect(shouldEmitHeartbeat({ active: 0 })).toBe(false);
  });
});

describe('trackEvent shared props', () => {
  beforeEach(() => {
    mocks.trackEvent.mockClear();
    initAnalytics();
  });

  it('merges the client id into every tracked event once set', () => {
    setAnalyticsClientId('deadbeef');
    trackEvent('app_launch', { platform: 'win32' });

    expect(mocks.trackEvent).toHaveBeenCalledWith('app_launch', {
      clientId: 'deadbeef',
      platform: 'win32',
    });
  });

  it('lets per-call props win on key collision with shared props', () => {
    setAnalyticsClientId('deadbeef');
    trackEvent('app_launch', { clientId: 'override' });

    expect(mocks.trackEvent).toHaveBeenCalledWith('app_launch', { clientId: 'override' });
  });
});
