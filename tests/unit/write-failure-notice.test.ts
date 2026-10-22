import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    // An error with no `code` is not a Node system error, so it goes out as the same object.
    expect(mocks.reportHandledErrorSpy.mock.calls[0][0]).toBe(error);
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
function errnoError(code: string, message: string, syscall?: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  if (syscall) error.syscall = syscall;
  return error;
}

const NO_CAUSE_SENTENCE = 'It may be lost on restart.';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('write-failure-notice cause clauses (DESKTOP-1C)', () => {
  beforeEach(() => {
    mocks.reportHandledErrorSpy.mockClear();
    __resetForTest();
  });

  it.each([
    ['ENOSPC', 'The disk is full'],
    ['EACCES', 'Kangentic does not have permission'],
    ['EPERM', 'Kangentic does not have permission'],
    ['EROFS', 'The volume is read-only'],
    // The removable-volume errno from DESKTOP-14/DESKTOP-13, the case that built this module.
    ['EBADF', 'The drive is unavailable'],
    ['ENODEV', 'The drive is unavailable'],
    ['ENXIO', 'The drive is unavailable'],
    ['EIO', 'The drive is unavailable'],
  ])('names the cause for %s', (code, expectedCause) => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(errnoError(code, `${code}: something, write`), 'config');

    expect(notifier).toHaveBeenCalledTimes(1);
    // One sentence: the cause, then the consequence. The consequence is worded to hold
    // for every source, including a project override, which keeps no in-memory copy.
    expect(notifier).toHaveBeenCalledWith(`${expectedCause}, so it may be lost on restart.`);
  });

  it('falls back to the no-cause sentence for an errno with no clause', () => {
    // An unmapped cause degrades to no cause, never to a wrong guess.
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(errnoError('EUNKNOWNTOUS', 'something else entirely'), 'config');

    expect(notifier).toHaveBeenCalledWith(NO_CAUSE_SENTENCE);
  });

  it('falls back to the no-cause sentence for an error carrying no code at all', () => {
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(new Error('ENOSPC: no space left on device, write'), 'config');

    // The errno lives on `error.code`, never parsed out of the message: a thrown string
    // that merely mentions ENOSPC is not evidence of one.
    expect(notifier).toHaveBeenCalledWith(NO_CAUSE_SENTENCE);
  });

  it('tags the Sentry report with the errno', () => {
    const error = errnoError('ENOSPC', 'ENOSPC: no space left on device, write');

    reportSyncWriteFailure(error, 'config');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledWith(expect.any(Error), { source: 'config', errno: 'ENOSPC' });
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
    expect(notifier.mock.calls[0][0]).toContain('The disk is full');
    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
  ])(
    'falls back to the no-cause sentence for the Object.prototype-shaped errno %s, rather than resolving an inherited member',
    (code) => {
      // CAUSE_BY_ERRNO is a Map for exactly this reason: an errno that happens to
      // name an Object.prototype member must MISS, not resolve to an inherited value. A
      // plain object literal with bracket access (`{ ... }[code]`) would resolve
      // `code: 'constructor'` to the Object constructor function and `code: '__proto__'`
      // to Object.prototype - both truthy, so the no-cause fallback would never fire, and
      // the template literal would stringify whichever one it got straight into the
      // user's message (e.g. "function Object() { [native code] }, so it may be lost...").
      // Asserting full equality against NO_CAUSE_SENTENCE (not just a substring) is what
      // catches that splice: a `.toContain('It may be lost')` check would still pass with
      // garbage prepended to it.
      const notifier = vi.fn();
      setSyncWriteFailureNotifier(notifier);

      reportSyncWriteFailure(errnoError(code, `${code}: something, write`), 'config');

      expect(notifier).toHaveBeenCalledWith(NO_CAUSE_SENTENCE);
    },
  );
});

// Sentry DESKTOP-1Z: a file-sync client held a project's `.kangentic/config.json`, Windows
// refused the rename with EPERM, and the notice blamed permissions.
describe('write-failure-notice held-file renames (DESKTOP-1Z)', () => {
  beforeEach(() => {
    mocks.reportHandledErrorSpy.mockClear();
    __resetForTest();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'says the file is in use or read-only for a rename refused with %s on Windows',
    (code) => {
      setPlatform('win32');
      const notifier = vi.fn();
      setSyncWriteFailureNotifier(notifier);

      reportSyncWriteFailure(errnoError(code, `${code}: refused, rename`, 'rename'), 'config_project_override');

      expect(notifier).toHaveBeenCalledWith('The file is in use or read-only, so it may be lost on restart.');
    },
  );

  it('keeps the permission clause for a refused rename on Linux, where an open file never blocks one', () => {
    setPlatform('linux');
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(errnoError('EACCES', 'EACCES: permission denied, rename', 'rename'), 'config');

    expect(notifier.mock.calls[0][0]).toContain('Kangentic does not have permission');
  });

  it('keeps the permission clause for an EPERM from a syscall other than rename on Windows', () => {
    setPlatform('win32');
    const notifier = vi.fn();
    setSyncWriteFailureNotifier(notifier);

    reportSyncWriteFailure(errnoError('EPERM', 'EPERM: operation not permitted, open', 'open'), 'config');

    expect(notifier.mock.calls[0][0]).toContain('Kangentic does not have permission');
  });
});

describe('write-failure-notice path-free Sentry report (DESKTOP-1Z)', () => {
  // Fixture paths only: a project on a second drive, which the home-directory redaction
  // in redact-event-paths.ts cannot rewrite.
  const TEMP_PATH = 'D:\\Sync\\demo-project\\.kangentic\\config.json.tmp.4242';
  const TARGET_PATH = 'D:\\Sync\\demo-project\\.kangentic\\config.json';

  beforeEach(() => {
    mocks.reportHandledErrorSpy.mockClear();
    __resetForTest();
  });

  function nodeRenameError(): NodeJS.ErrnoException {
    const error = errnoError(
      'EPERM',
      `EPERM: operation not permitted, rename '${TEMP_PATH}' -> '${TARGET_PATH}'`,
      'rename',
    );
    error.path = TEMP_PATH;
    return Object.assign(error, { dest: TARGET_PATH });
  }

  it('sends a copy built from the errno and syscall, with neither path in its message or stack', () => {
    const error = nodeRenameError();

    reportSyncWriteFailure(error, 'config_project_override');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    const [reported, tags] = mocks.reportHandledErrorSpy.mock.calls[0] as [Error, Record<string, string>];
    expect(reported).not.toBe(error);
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('EPERM: rename failed');
    expect(tags).toEqual({ source: 'config_project_override', errno: 'EPERM', syscall: 'rename' });
    for (const text of [reported.message, reported.stack ?? '']) {
      expect(text).not.toContain(TEMP_PATH);
      expect(text).not.toContain(TARGET_PATH);
    }
    expect(reported).not.toHaveProperty('path');
    expect(reported).not.toHaveProperty('dest');
    expect(reported.cause).toBeUndefined();
  });

  it('keeps the original frames under the new header, so the trace and grouping survive', () => {
    const error = nodeRenameError();
    const originalFrames = (error.stack ?? '').slice((error.stack ?? '').indexOf('\n'));
    expect(originalFrames).toContain('    at ');

    reportSyncWriteFailure(error, 'config_project_override');

    const reported = mocks.reportHandledErrorSpy.mock.calls[0][0] as Error;
    expect(reported.stack).toBe(`Error: EPERM: rename failed${originalFrames}`);
  });

  // `EPERM` is a prefix of the stack's path-bearing first line. A guard that only checked
  // `startsWith` took it for a match, sliced mid-line, and sent both paths.
  it.each(['rename refused', 'EPERM'])(
    'keeps its own frames when the message is changed to %s after the stack was captured',
    (replacementMessage) => {
      const error = nodeRenameError();
      // Reading the stack materializes it with the original header, so line 1 holds both
      // paths from here on, whatever the message becomes.
      const stackBeforeEdit = error.stack ?? '';
      error.message = replacementMessage;
      // Preconditions: without them this case passes just as well when the stack is no
      // longer the one the message used to head.
      expect(stackBeforeEdit).toContain(TARGET_PATH);
      expect(stackBeforeEdit.split('\n')[0]).not.toBe(`${error.name}: ${error.message}`);

      reportSyncWriteFailure(error, 'config_project_override');

      expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
      const reported = mocks.reportHandledErrorSpy.mock.calls[0][0] as Error;
      expect(reported.message).toBe('EPERM: rename failed');
      expect(reported.stack).not.toContain(TARGET_PATH);
      expect(reported.stack).not.toContain(TEMP_PATH);
    },
  );

  it('builds the message from the errno alone when the error names no syscall', () => {
    reportSyncWriteFailure(errnoError('ENOSPC', `ENOSPC: no space left on device, write '${TARGET_PATH}'`), 'config');

    const [reported, tags] = mocks.reportHandledErrorSpy.mock.calls[0] as [Error, Record<string, string>];
    expect(reported.message).toBe('ENOSPC');
    expect(reported.stack).not.toContain(TARGET_PATH);
    expect(tags).toEqual({ source: 'config', errno: 'ENOSPC' });
  });
});
