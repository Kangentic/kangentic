/**
 * Covers safeWriteJson's cleanup-failure path (src/main/safe-write.ts): when the
 * write/rename itself fails AND the best-effort `fs.unlinkSync(tmpPath)` cleanup
 * also fails, safeWriteJson must still return false, must not throw, and must
 * report the ORIGINAL write/rename error to the write-failure-notice latch, not
 * the cleanup error that would otherwise mask it inside the nested try/catch.
 *
 * A real cleanup failure is not portably forceable across Windows and Linux
 * (this repo's CI is Linux, the team dogfoods Windows - see
 * .claude/rules/cross-platform-parity.md), so node:fs is mocked here rather than
 * relying on real filesystem permissions. This is a SEPARATE file from
 * tests/unit/safe-write.test.ts on purpose: that file uses REAL fs (mkdtempSync,
 * a real blocking directory) for its happy-path and blocked-directory cases, and
 * mocking node:fs at the top of this file would silently break those.
 *
 * reportHandledError (src/main/analytics/error-reporting) is mocked so the error
 * object actually forwarded to Sentry can be inspected directly - the same
 * vi.hoisted spy pattern as tests/unit/write-failure-notice.test.ts.
 * write-failure-notice.ts itself is NOT mocked, so this exercises the real path
 * from safeWriteJson's catch through to the latch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const errorReportingMocks = vi.hoisted(() => ({ reportHandledErrorSpy: vi.fn() }));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: errorReportingMocks.reportHandledErrorSpy,
}));

const fsMocks = vi.hoisted(() => ({
  mkdirSyncSpy: vi.fn(),
  writeFileSyncSpy: vi.fn(),
  renameSyncSpy: vi.fn(),
  unlinkSyncSpy: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: fsMocks.mkdirSyncSpy,
      writeFileSync: fsMocks.writeFileSyncSpy,
      renameSync: fsMocks.renameSyncSpy,
      unlinkSync: fsMocks.unlinkSyncSpy,
    },
    mkdirSync: fsMocks.mkdirSyncSpy,
    writeFileSync: fsMocks.writeFileSyncSpy,
    renameSync: fsMocks.renameSyncSpy,
    unlinkSync: fsMocks.unlinkSyncSpy,
  };
});

import { safeWriteJson } from '../../src/main/safe-write';
import { __resetForTest, setSyncWriteFailureNotifier } from '../../src/main/config/write-failure-notice';

beforeEach(() => {
  errorReportingMocks.reportHandledErrorSpy.mockClear();
  fsMocks.mkdirSyncSpy.mockReset();
  fsMocks.writeFileSyncSpy.mockReset();
  fsMocks.renameSyncSpy.mockReset();
  fsMocks.unlinkSyncSpy.mockReset();
  __resetForTest();
});

describe('safeWriteJson cleanup-failure path', () => {
  it('returns false, does not throw, and reports the ORIGINAL write error when the cleanup unlink also fails', () => {
    fsMocks.mkdirSyncSpy.mockImplementation(() => undefined);
    const originalWriteError = new Error('ENOSPC: no space left on device, write');
    fsMocks.writeFileSyncSpy.mockImplementation(() => {
      throw originalWriteError;
    });
    fsMocks.unlinkSyncSpy.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory, unlink');
    });

    const notifications: string[] = [];
    setSyncWriteFailureNotifier((message) => notifications.push(message));

    let result: boolean | undefined;
    expect(() => {
      result = safeWriteJson('/mock/config/value.json', { a: 1 }, 'cleanup_fail_source');
    }).not.toThrow();

    expect(result).toBe(false);
    expect(fsMocks.unlinkSyncSpy).toHaveBeenCalledTimes(1);
    // The Sentry report must carry the ORIGINAL write error, not the cleanup
    // error that follows it - a deep-equal check on the arguments distinguishes
    // the two since their messages differ.
    expect(errorReportingMocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    expect(errorReportingMocks.reportHandledErrorSpy).toHaveBeenCalledWith(
      originalWriteError,
      { source: 'cleanup_fail_source' },
    );
    expect(notifications).toHaveLength(1);
  });

  it('returns false and reports the original rename error, with the cleanup unlink failing, when the write itself succeeds but the rename fails', () => {
    fsMocks.mkdirSyncSpy.mockImplementation(() => undefined);
    fsMocks.writeFileSyncSpy.mockImplementation(() => undefined);
    const originalRenameError = new Error('EPERM: operation not permitted, rename');
    fsMocks.renameSyncSpy.mockImplementation(() => {
      throw originalRenameError;
    });
    fsMocks.unlinkSyncSpy.mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked, unlink');
    });

    const result = safeWriteJson('/mock/config/value2.json', { a: 1 }, 'cleanup_fail_rename_source');

    expect(result).toBe(false);
    expect(errorReportingMocks.reportHandledErrorSpy).toHaveBeenCalledWith(
      originalRenameError,
      { source: 'cleanup_fail_rename_source' },
    );
  });

  it('baseline: still reports the original error when cleanup SUCCEEDS (cleanup failure is not what selects the error)', () => {
    fsMocks.mkdirSyncSpy.mockImplementation(() => undefined);
    const originalWriteError = new Error('EACCES: permission denied, write');
    fsMocks.writeFileSyncSpy.mockImplementation(() => {
      throw originalWriteError;
    });
    fsMocks.unlinkSyncSpy.mockImplementation(() => undefined);

    const result = safeWriteJson('/mock/config/value3.json', { a: 1 }, 'cleanup_ok_source');

    expect(result).toBe(false);
    expect(errorReportingMocks.reportHandledErrorSpy).toHaveBeenCalledWith(
      originalWriteError,
      { source: 'cleanup_ok_source' },
    );
  });
});
