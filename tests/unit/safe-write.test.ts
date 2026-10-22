import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// reportHandledError pulls in @sentry/electron; a spy lets the held-rename cases assert what
// would reach Sentry. Same vi.hoisted pattern as write-failure-notice.test.ts.
const mocks = vi.hoisted(() => ({ reportHandledErrorSpy: vi.fn() }));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mocks.reportHandledErrorSpy,
}));

import { safeWriteJson } from '../../src/main/safe-write';
import {
  reportSyncWriteFailure,
  setSyncWriteFailureNotifier,
  __resetForTest,
} from '../../src/main/config/write-failure-notice';

// Covers the guard at the center of .claude/rules/guarded-sync-writes.md: mkdir +
// write-to-temp + rename, all inside one try, never throwing. tmpDir writes stay under
// os.tmpdir() per .claude/rules/cross-platform-parity.md.

let tmpDir: string;
let renameSpy: MockInstance<typeof fs.renameSync> | null = null;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** The shape Node throws when a rename is refused: errno and syscall on fields, and both paths
 *  in the message. That message is what DESKTOP-1Z carried to Sentry. */
function renameError(code: string, fromPath: string, toPath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: operation not permitted, rename '${fromPath}' -> '${toPath}'`);
  error.code = code;
  error.syscall = 'rename';
  error.path = fromPath;
  return Object.assign(error, { dest: toPath });
}

/** Refuse the first `refusedAttempts` renames with `code`, then rename for real, so a write
 *  that lands is proven on disk rather than assumed. */
function holdRenames(refusedAttempts: number, code: string): MockInstance<typeof fs.renameSync> {
  const realRename = fs.renameSync;
  let attempts = 0;
  renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((fromPath, toPath) => {
    attempts += 1;
    if (attempts <= refusedAttempts) throw renameError(code, String(fromPath), String(toPath));
    realRename(fromPath, toPath);
  });
  return renameSpy;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-safe-write-'));
  mocks.reportHandledErrorSpy.mockClear();
  __resetForTest();
});

afterEach(() => {
  renameSpy?.mockRestore();
  renameSpy = null;
  setPlatform(originalPlatform);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  __resetForTest();
});

describe('safeWriteJson', () => {
  it('creates the target directory, writes the content, and returns true', () => {
    const filePath = path.join(tmpDir, 'nested', 'value.json');

    const result = safeWriteJson(filePath, { hello: 'world' }, 'test_source');

    expect(result).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ hello: 'world' });
  });

  it('leaves no `.tmp.<pid>` file behind on success', () => {
    const filePath = path.join(tmpDir, 'value.json');

    safeWriteJson(filePath, { a: 1 }, 'test_source');

    const entries = fs.readdirSync(tmpDir);
    expect(entries).toEqual(['value.json']);
  });

  it('forwards the mode option without throwing', () => {
    const filePath = path.join(tmpDir, 'secret.json');

    const result = safeWriteJson(filePath, { token: 'x' }, 'test_source', { mode: 0o600 });

    expect(result).toBe(true);
    // Exact permission bits are POSIX-only (Windows does not honor the owner/group/other
    // split the same way), matching the tolerance convention in cross-platform-parity.md.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('returns false and cleans up its temp file when the rename target cannot be replaced', () => {
    // A rename onto an existing, non-empty directory fails on every OS (EISDIR on
    // POSIX, an equivalent refusal on Windows), which is a reliable way to make the
    // write-to-temp succeed but the final rename fail, without depending on
    // permission semantics.
    const filePath = path.join(tmpDir, 'blocked.json');
    fs.mkdirSync(filePath, { recursive: true });
    fs.writeFileSync(path.join(filePath, 'occupant'), '');

    const notifier: string[] = [];
    setSyncWriteFailureNotifier((message) => notifier.push(message));

    const result = safeWriteJson(filePath, { a: 1 }, 'test_source');

    expect(result).toBe(false);
    expect(notifier).toHaveLength(1);
    // The blocking directory is untouched, and the temp file it could not
    // replace is not left behind on disk.
    expect(fs.statSync(filePath).isDirectory()).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual(['blocked.json']);
    // This is the one case where Node itself builds the error, with both paths in
    // its message, so it pins the path-free copy against the real stack shape. The
    // renameSync frame is only there when the original frames were carried over.
    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    const reported = mocks.reportHandledErrorSpy.mock.calls[0][0] as Error;
    expect(reported.message).toMatch(/^E[A-Z]+: rename failed$/);
    expect(reported.message).not.toContain(tmpDir);
    expect(reported.stack).not.toContain(tmpDir);
    expect(reported.stack).toContain('renameSync');
  });

  it('re-arms the failure latch after a later successful write to the same source', () => {
    const filePath = path.join(tmpDir, 'blocked.json');
    fs.mkdirSync(filePath, { recursive: true });
    fs.writeFileSync(path.join(filePath, 'occupant'), '');

    const notifications: string[] = [];
    setSyncWriteFailureNotifier((message) => notifications.push(message));

    expect(safeWriteJson(filePath, { a: 1 }, 'test_source')).toBe(false);
    expect(notifications).toHaveLength(1);

    // A successful write for the SAME source clears the latch.
    expect(safeWriteJson(path.join(tmpDir, 'ok.json'), { a: 1 }, 'test_source')).toBe(true);

    // So a later failure of that source reports again.
    expect(safeWriteJson(filePath, { a: 1 }, 'test_source')).toBe(false);
    expect(notifications).toHaveLength(2);
  });
});

// Sentry DESKTOP-1Z: a file-sync client held a project's `.kangentic/config.json`, Windows refused
// the rename with EPERM, and the one-shot rename dropped the user's settings change.
describe('safeWriteJson renames onto a file another program holds', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'lands the write on Windows when the first two renames are refused with %s',
    (code) => {
      setPlatform('win32');
      const filePath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(filePath, '{"previous":true}\n');
      const notifications: string[] = [];
      setSyncWriteFailureNotifier((message) => notifications.push(message));
      // Latch the source first, so the successful write below has a latch to clear.
      reportSyncWriteFailure(new Error('an earlier outage'), 'test_source');
      expect(notifications).toHaveLength(1);
      mocks.reportHandledErrorSpy.mockClear();
      const spy = holdRenames(2, code);

      const result = safeWriteJson(filePath, { fresh: true }, 'test_source');

      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ fresh: true });
      expect(fs.readdirSync(tmpDir)).toEqual(['config.json']);
      expect(mocks.reportHandledErrorSpy).not.toHaveBeenCalled();
      expect(notifications).toHaveLength(1);
      // noteSyncWriteSuccess cleared the latch, so the next failure of this source notifies again.
      reportSyncWriteFailure(new Error('a later outage'), 'test_source');
      expect(notifications).toHaveLength(2);
    },
  );

  it('fails as before, leaves the target untouched, and reports once with no path when every rename is refused', () => {
    setPlatform('win32');
    const filePath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(filePath, '{"previous":true}\n');
    const notifications: string[] = [];
    setSyncWriteFailureNotifier((message) => notifications.push(message));
    const spy = holdRenames(Number.POSITIVE_INFINITY, 'EPERM');

    const result = safeWriteJson(filePath, { fresh: true }, 'test_source');

    expect(result).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
    // No direct write onto the held target: it keeps its previous content whole.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"previous":true}\n');
    expect(fs.readdirSync(tmpDir)).toEqual(['config.json']);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('The file is in use or read-only');

    expect(mocks.reportHandledErrorSpy).toHaveBeenCalledTimes(1);
    const [reported, tags] = mocks.reportHandledErrorSpy.mock.calls[0] as [Error, Record<string, string>];
    expect(tags).toEqual({ source: 'test_source', errno: 'EPERM', syscall: 'rename' });
    expect(reported.message).toBe('EPERM: rename failed');
    // The thrown message named the temp file and the target. Both sit under tmpDir, and
    // neither may survive into what is sent.
    expect(reported.message).not.toContain(tmpDir);
    expect(reported.stack).not.toContain(tmpDir);
    expect(reported.stack).toContain('safeWriteJson');
  });

  it.each(['darwin', 'linux'] as const)('does not retry a refused rename on %s', (platform) => {
    setPlatform(platform);
    const filePath = path.join(tmpDir, 'config.json');
    const spy = holdRenames(1, 'EPERM');

    const result = safeWriteJson(filePath, { fresh: true }, 'test_source');

    // The second rename would have gone through, so a false here means there was none.
    expect(result).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('does not retry a rename Windows refuses for a reason other than a held file', () => {
    setPlatform('win32');
    const filePath = path.join(tmpDir, 'config.json');
    const spy = holdRenames(1, 'EXDEV');

    const result = safeWriteJson(filePath, { fresh: true }, 'test_source');

    expect(result).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});
