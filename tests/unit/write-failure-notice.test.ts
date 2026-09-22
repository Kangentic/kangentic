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

/**
 * A real `fs` failure carries the errno on `error.code`; the message is only prose.
 * The suite above deliberately uses message-only Errors (that is what it was written
 * against), so these cases build the real shape or they would assert nothing.
 */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

const LEGACY_SENTENCE =
  'Kangentic could not write to its data folder. Changes apply to this session but will not persist.';

describe('write-failure-notice cause clauses (DESKTOP-1C)', () => {
  beforeEach(() => {
    mocks.reportHandledErrorSpy.mockClear();
    __resetForTest();
  });

  it.each([
    ['ENOSPC', 'because the disk is full'],
    ['EACCES', 'because it does not have permission'],
    ['EPERM', 'because it does not have permission'],
    ['EROFS', 'because the volume is read-only'],
    // The removable-volume errno from DESKTOP-14/DESKTOP-13, the case that built this module.
    ['EBADF', 'because the drive is unavailable'],
    ['ENODEV', 'because the drive is unavailable'],
    ['ENXIO', 'because the drive is unavailable'],
    ['EIO', 'because the drive is unavailable'],
  ])('names the cause for %s', (code, expectedClause) => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(errnoError(code, `${code}: something, write`), 'config');

    expect(notifier).toHaveBeenCalledTimes(1);
    const message = notifier.mock.calls[0][0] as string;
    expect(message).toContain(expectedClause);
    // The consequence half must survive the new clause: it is what tells the user the
    // value still applies to this session.
    expect(message).toContain('Changes apply to this session but will not persist.');
  });

  it('falls back to the pre-cause sentence for an errno with no clause', () => {
    // An unmapped cause degrades to the wording that shipped before causes existed,
    // never to a wrong guess. Two UI specs also match on this sentence.
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(errnoError('EUNKNOWNTOUS', 'something else entirely'), 'config');

    expect(notifier).toHaveBeenCalledWith(LEGACY_SENTENCE);
  });

  it('falls back to the pre-cause sentence for an error carrying no code at all', () => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(new Error('ENOSPC: no space left on device, write'), 'config');

    // The errno lives on `error.code`, never parsed out of the message: a thrown string
    // that merely mentions ENOSPC is not evidence of one.
    expect(notifier).toHaveBeenCalledWith(LEGACY_SENTENCE);
  });

  it('tags the Sentry report with the errno', () => {
    const error = errnoError('ENOSPC', 'ENOSPC: no space left on device, write');

    reportSyncWriteFailure(error, 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledWith(error, { source: 'config', errno: 'ENOSPC' });
  });

  it('omits the errno tag entirely when the error carries no code', () => {
    // Not an empty-string tag: an absent errno and an errno of "" are different facts,
    // and only one of them is worth a Sentry filter.
    const error = new Error('no code on this one');

    reportSyncWriteFailure(error, 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledWith(error, { source: 'config' });
  });

  it('does NOT re-notify when the errno changes on an already-latched source', () => {
    // One outage is one notice. Making the message cause-specific reads like an
    // invitation to re-fire when the cause changes; it is not one. A settings change
    // during an outage is covered by the settings panel's own `persisted` check.
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(errnoError('ENOSPC', 'disk full'), 'config');
    reportSyncWriteFailure(errnoError('EROFS', 'read-only now'), 'config');

    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][0]).toContain('because the disk is full');
    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
  });
});
