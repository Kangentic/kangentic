import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countFileLines } from '../../src/main/git/line-count/count-lines';

/** countFileLines' bounded read/scan contract: exact counts for normal files,
 *  binary detection, and a floor (not a throw) for a file over the size cap. */
describe('countFileLines', () => {
  const tempDirs: string[] = [];

  function makeTempFile(content: Buffer | string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-count-lines-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts newlines for a file ending with a trailing newline', async () => {
    const filePath = makeTempFile('a\nb\nc\n');
    await expect(countFileLines(filePath)).resolves.toEqual({ insertions: 3, binary: false, truncated: false });
  });

  it('adds one for a final line with no trailing newline', async () => {
    const filePath = makeTempFile('a\nb\nc');
    await expect(countFileLines(filePath)).resolves.toEqual({ insertions: 3, binary: false, truncated: false });
  });

  it('reports zero insertions for an empty file', async () => {
    const filePath = makeTempFile('');
    await expect(countFileLines(filePath)).resolves.toEqual({ insertions: 0, binary: false, truncated: false });
  });

  it('detects binary content from a null byte in the first 8KB and reports zero insertions', async () => {
    const filePath = makeTempFile(Buffer.from([0x61, 0x00, 0x62, 0x0a, 0x63]));
    await expect(countFileLines(filePath)).resolves.toEqual({ insertions: 0, binary: true, truncated: false });
  });

  it('bounds the read to the size cap for a pathologically large file, reporting a floor with truncated=true', async () => {
    // One line per byte-pair well past the cap boundary, so the exact total
    // line count is knowable while only a prefix is ever read/scanned.
    const capBytes = 20 * 1024 * 1024;
    const lineCount = Math.floor(capBytes / 2) + 1000;
    const content = Buffer.from('a\n'.repeat(lineCount));
    const filePath = makeTempFile(content);

    const result = await countFileLines(filePath);
    expect(result.binary).toBe(false);
    expect(result.truncated).toBe(true);
    // Only the capped prefix was scanned, so insertions is a floor strictly
    // less than the file's true line count.
    expect(result.insertions).toBeLessThan(lineCount);
    expect(result.insertions).toBeGreaterThan(0);
  }, 20_000);

  // A single FileHandle.read is not guaranteed to fill the requested length
  // (unlike fs.readFile, there is no internal retry loop). Real temp files
  // via fs.mkdtempSync/writeFileSync always read back in one shot, so a
  // short read cannot be forced through the real filesystem - this case
  // spies on node:fs's promises.open/stat (restored immediately after) to
  // simulate handle.read() returning fewer bytes than requested, mirroring
  // the mock shape used by tests/unit/diff-service.test.ts's
  // mockUntrackedFileContent.
  it('scans only the bytes actually returned by a short FileHandle.read, not the zero-padded tail of an over-allocated buffer', async () => {
    // Real file size is 5 bytes ("a\nb\nc"), but the read only returns the
    // first 3 ("a\nb"). If the implementation scans the full requested
    // length instead of just bytesRead, the unread tail is either zero
    // bytes (old Buffer.alloc behavior -> a false binary detection, since a
    // 0x00 byte is in the scanned range) or uninitialized garbage
    // (allocUnsafe scanned past bytesRead -> a non-deterministic count).
    // Only "a\nb" (3 bytes) must be scanned: one newline plus a final
    // unterminated 'b' => 2 insertions, not binary.
    const fullContent = Buffer.from('a\nb\nc');
    const shortReadBytes = 3;

    const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: fullContent.length } as never);
    const readMock = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      // Simulate a short read: copy only `shortReadBytes`, regardless of the
      // full `length` requested, and report that truncated bytesRead. The
      // rest of the caller's buffer (whatever its allocation strategy) must
      // never be scanned.
      fullContent.copy(buffer, offset, position, position + shortReadBytes);
      return { bytesRead: shortReadBytes, buffer };
    });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const openSpy = vi.spyOn(fs.promises, 'open').mockResolvedValue({
      read: readMock,
      close: closeMock,
    } as never);

    try {
      const result = await countFileLines('/mock/short-read-fixture.txt');
      expect(result).toEqual({ insertions: 2, binary: false, truncated: false });
    } finally {
      statSpy.mockRestore();
      openSpy.mockRestore();
    }
  });
});
