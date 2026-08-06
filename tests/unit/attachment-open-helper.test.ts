/**
 * Unit tests for the shared attachment-open helper
 * (src/main/ipc/helpers/attachment-open.ts), used by both ATTACHMENT_OPEN
 * (src/main/ipc/handlers/board.ts) and BACKLOG_ATTACHMENT_OPEN
 * (src/main/ipc/handlers/backlog.ts).
 *
 * shell.openPath() never rejects (it always resolves - '' on success, a
 * non-empty error string on failure), so the failure modes under test are
 * a resolved error string, a resolved '' (success), and a promise that
 * never settles (the shape behind the reported "reply was never sent"
 * error: nothing previously bounded the wait on openPath).
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockShell } = vi.hoisted(() => {
  const mockShell = { openPath: vi.fn(), showItemInFolder: vi.fn() };
  return { mockShell };
});

vi.mock('electron', () => ({ shell: mockShell }));

import { openAttachmentFile, OPEN_PATH_TIMEOUT_MS } from '../../src/main/ipc/helpers/attachment-open';
import { attachmentDiskName } from '../../src/shared/attachment-filename';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-open-'));
  mockShell.openPath.mockReset();
  mockShell.showItemInFolder.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeAttachment(overrides?: Partial<{ id: string; filename: string; file_path: string }>) {
  const filePath = path.join(tmpRoot, 'stored', 'a1_report.pdf');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'contents');
  return { id: 'a1', filename: 'report.pdf', file_path: filePath, ...overrides };
}

describe('openAttachmentFile', () => {
  it('returns "" and does not fall back when openPath succeeds', async () => {
    mockShell.openPath.mockResolvedValue('');

    const result = await openAttachmentFile(makeAttachment(), { platform: 'linux', tempDirRoot: tmpRoot });

    expect(result).toBe('');
    expect(mockShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('falls back to showItemInFolder and returns the error string on a resolved failure', async () => {
    mockShell.openPath.mockResolvedValue('No application is registered for this file type');

    const result = await openAttachmentFile(makeAttachment(), { platform: 'linux', tempDirRoot: tmpRoot });

    expect(result).toBe('No application is registered for this file type');
    expect(mockShell.showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('resolves "" when openPath never settles within the timeout (the reported-bug regression case)', async () => {
    mockShell.openPath.mockReturnValue(new Promise<string>(() => { /* never settles */ }));

    const result = await openAttachmentFile(makeAttachment(), {
      platform: 'linux',
      tempDirRoot: tmpRoot,
      timeoutMs: 20,
    });

    expect(result).toBe('');
  });

  it('still reveals the file if openPath eventually reports an error after the timeout', async () => {
    let resolveOpen: (value: string) => void = () => {};
    mockShell.openPath.mockReturnValue(new Promise<string>((resolve) => { resolveOpen = resolve; }));

    const resultPromise = openAttachmentFile(makeAttachment(), {
      platform: 'linux',
      tempDirRoot: tmpRoot,
      timeoutMs: 20,
    });

    const result = await resultPromise;
    expect(result).toBe('');
    expect(mockShell.showItemInFolder).not.toHaveBeenCalled();

    resolveOpen('late error after timeout');
    // Let the late .then() microtask/macrotask run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockShell.showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('does not double-reveal when the late resolution after a timeout is also empty', async () => {
    let resolveOpen: (value: string) => void = () => {};
    mockShell.openPath.mockReturnValue(new Promise<string>((resolve) => { resolveOpen = resolve; }));

    await openAttachmentFile(makeAttachment(), { platform: 'linux', tempDirRoot: tmpRoot, timeoutMs: 20 });

    resolveOpen('');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('opens the stored file directly on linux/darwin, with no temp copy', async () => {
    mockShell.openPath.mockResolvedValue('');
    const attachment = makeAttachment();

    await openAttachmentFile(attachment, { platform: 'linux', tempDirRoot: tmpRoot });

    expect(mockShell.openPath).toHaveBeenCalledWith(attachment.file_path);
    expect(fs.existsSync(path.join(tmpRoot, 'kangentic-attachments'))).toBe(false);
  });

  it('copies into a temp dir and opens the copy on win32', async () => {
    mockShell.openPath.mockResolvedValue('');
    const attachment = makeAttachment();

    await openAttachmentFile(attachment, { platform: 'win32', tempDirRoot: tmpRoot });

    const expectedTempPath = path.join(tmpRoot, 'kangentic-attachments', attachmentDiskName(attachment.id, attachment.filename));
    expect(mockShell.openPath).toHaveBeenCalledWith(expectedTempPath);
    expect(fs.existsSync(expectedTempPath)).toBe(true);
  });

  it('sanitizes a reserved character in the filename for the win32 temp copy name', async () => {
    mockShell.openPath.mockResolvedValue('');
    const attachment = makeAttachment({ filename: 'report:v2.pdf' });

    await openAttachmentFile(attachment, { platform: 'win32', tempDirRoot: tmpRoot });

    const expectedTempPath = path.join(tmpRoot, 'kangentic-attachments', `${attachment.id}_report_v2.pdf`);
    expect(mockShell.openPath).toHaveBeenCalledWith(expectedTempPath);
    expect(fs.existsSync(expectedTempPath)).toBe(true);
  });

  it('defaults the timeout to OPEN_PATH_TIMEOUT_MS when not overridden', async () => {
    vi.useFakeTimers();
    mockShell.openPath.mockReturnValue(new Promise<string>(() => { /* never settles */ }));

    const resultPromise = openAttachmentFile(makeAttachment(), { platform: 'linux', tempDirRoot: tmpRoot });
    let settled = false;
    void resultPromise.then(() => { settled = true; });

    // One tick short of the exported default: must still be pending.
    await vi.advanceTimersByTimeAsync(OPEN_PATH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    // The final tick: the helper's own timeout, not an override, fires.
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(settled).toBe(true);
    expect(result).toBe('');
  });

  it('does not re-copy on win32 when a same-size temp copy already exists', async () => {
    mockShell.openPath.mockResolvedValue('');
    const attachment = makeAttachment();

    const tempDir = path.join(tmpRoot, 'kangentic-attachments');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, attachmentDiskName(attachment.id, attachment.filename));
    // Same content (and therefore same size) as the stored file written by makeAttachment().
    fs.writeFileSync(tempPath, 'contents');

    const copyFileSyncSpy = vi.spyOn(fs, 'copyFileSync');

    const result = await openAttachmentFile(attachment, { platform: 'win32', tempDirRoot: tmpRoot });

    expect(result).toBe('');
    expect(copyFileSyncSpy).not.toHaveBeenCalled();
    expect(mockShell.openPath).toHaveBeenCalledWith(tempPath);

    copyFileSyncSpy.mockRestore();
  });

  it('falls back to the stored file_path when the win32 temp copy fails (e.g. locked by a viewer)', async () => {
    mockShell.openPath.mockResolvedValue('');
    const attachment = makeAttachment();

    const copyFileSyncSpy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      const busyError = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
      busyError.code = 'EBUSY';
      throw busyError;
    });

    const result = await openAttachmentFile(attachment, { platform: 'win32', tempDirRoot: tmpRoot });

    expect(result).toBe('');
    expect(mockShell.openPath).toHaveBeenCalledWith(attachment.file_path);

    copyFileSyncSpy.mockRestore();
  });

  it('resolves promptly with the rejection message when openPath rejects, instead of stalling until the timeout', async () => {
    vi.useFakeTimers();
    mockShell.openPath.mockReturnValue(Promise.reject(new Error('spawn xdg-open ENOENT')));

    // A large timeoutMs with fake timers never advanced: if the rejection
    // were not handled promptly, this await would hang until the test
    // runner's own timeout instead of resolving here.
    const result = await openAttachmentFile(makeAttachment(), {
      platform: 'linux',
      tempDirRoot: tmpRoot,
      timeoutMs: 10000,
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe('spawn xdg-open ENOENT');
    // A rejection takes the same fallback as a resolved error string, which is
    // what makes the renderer's "Showing it in the file manager instead."
    // wording true on this path too.
    expect(mockShell.showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it('yields a non-empty string even when the rejected Error has an empty message, since "" is the success value', async () => {
    mockShell.openPath.mockReturnValue(Promise.reject(new Error('')));

    const result = await openAttachmentFile(makeAttachment(), { platform: 'linux', tempDirRoot: tmpRoot });

    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe('The file could not be opened.');
  });
});
