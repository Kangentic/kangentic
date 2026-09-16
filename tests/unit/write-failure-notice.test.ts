import { describe, it, expect, vi, beforeEach } from 'vitest';

// reportHandledError pulls in @sentry/electron and electron; mocking it directly
// (rather than the real module + its own dependencies) keeps this suite focused on
// write-failure-notice.ts's own contract: report + notify once per failing source,
// silent until that source recovers. Matches the vi.hoisted spy pattern in
// error-reporting-switch.test.ts.
const mocks = vi.hoisted(() => ({ reportHandledErrorSpy: vi.fn() }));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mocks.reportHandledErrorSpy,
}));

import {
  reportSyncWriteFailure,
  noteSyncWriteSuccess,
  setSyncWriteFailureNotifier,
  __resetForTest,
} from '../../src/main/config/write-failure-notice';

describe('write-failure-notice', () => {
  beforeEach(() => {
    mocks.reportHandledErrorSpy.mockClear();
    __resetForTest();
  });

  it('reports to Sentry and notifies once for a newly-failing source', () => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);
    const error = new Error('EBADF: bad file descriptor, write');

    reportSyncWriteFailure(error, 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledWith(error, { source: 'config' });
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(expect.any(String));
  });

  it('stays silent on a second failure from the SAME source', () => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(new Error('first'), 'config');
    reportSyncWriteFailure(new Error('second'), 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('re-arms after noteSyncWriteSuccess for that same source', () => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(new Error('first'), 'config');
    noteSyncWriteSuccess('config');
    reportSyncWriteFailure(new Error('second'), 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(2);
    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it('does not let a DIFFERENT source recovering re-arm this one', () => {
    // The whole reason the latch is keyed by source rather than global: a
    // healthy write elsewhere must not clear an unhealthy source's latch and
    // let it re-toast on its very next failure.
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(new Error('first'), 'config');
    noteSyncWriteSuccess('browser_url');
    reportSyncWriteFailure(new Error('second'), 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('tracks each source independently, both reporting on their own first failure', () => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(new Error('a'), 'config');
    reportSyncWriteFailure(new Error('b'), 'mobile_bridge_roster');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(2);
    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it('still reports to Sentry when no notifier is registered', () => {
    reportSyncWriteFailure(new Error('a'), 'config');
    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing notifier escape, and still reports to Sentry', () => {
    // The injected notifier's body is not ours to trust: the wired one reaches a
    // BrowserWindow whose webContents can be gone even when the window itself is
    // not. A throw here must not escape reportSyncWriteFailure - safeWriteJson's
    // callers rely on it never throwing (see the comment in write-failure-notice.ts).
    const throwingNotifier = vi.fn(() => {
      throw new Error('notifier blew up (e.g. webContents destroyed)');
    });
    setSyncWriteFailureNotifier(throwingNotifier);
    const error = new Error('EBADF: bad file descriptor, write');

    expect(() => reportSyncWriteFailure(error, 'config')).not.toThrow();

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledWith(error, { source: 'config' });
    expect(throwingNotifier).toHaveBeenCalledTimes(1);
  });

  it('keeps the source latched after a throwing notifier (does not re-arm and re-report)', () => {
    // A throwing notifier must not leave the source re-armed: the latch is what
    // stops a window drag or a settings change during an outage from spamming
    // Sentry and the user on every single failure of an already-failing source.
    const throwingNotifier = vi.fn(() => {
      throw new Error('notifier blew up');
    });
    setSyncWriteFailureNotifier(throwingNotifier);

    reportSyncWriteFailure(new Error('first'), 'config');
    reportSyncWriteFailure(new Error('second'), 'config');
    reportSyncWriteFailure(new Error('third'), 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    expect(throwingNotifier).toHaveBeenCalledTimes(1);
  });
});
