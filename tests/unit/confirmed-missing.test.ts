/**
 * `isConfirmedMissing`: the one rule every resume verdict rests on. A path is
 * confirmed missing only when stat fails with ENOENT. A permission error, a
 * locked file, or any other failure is not proof of absence, so the answer is
 * false and the resume proceeds as it always did.
 *
 * `fs.existsSync` (what the reverted #255 guard used) answers false on every
 * one of those failures, which is how a real conversation got discarded. These
 * tests pin the narrower rule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isConfirmedMissing } from '../../src/main/agent/shared/confirmed-missing';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-confirmed-missing-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('isConfirmedMissing', () => {
  it('is true for a path that does not exist', async () => {
    await expect(isConfirmedMissing(path.join(workDir, 'no-such-file.jsonl'))).resolves.toBe(true);
  });

  it('is true when the whole parent folder is missing too', async () => {
    await expect(isConfirmedMissing(path.join(workDir, 'no-such-folder', 'no-such-file.jsonl'))).resolves.toBe(true);
  });

  it('is false for an existing file', async () => {
    const existingFile = path.join(workDir, 'present.jsonl');
    fs.writeFileSync(existingFile, '{"type":"user"}\n', 'utf8');
    await expect(isConfirmedMissing(existingFile)).resolves.toBe(false);
  });

  it('is false for an existing folder', async () => {
    await expect(isConfirmedMissing(workDir)).resolves.toBe(false);
  });

  it('is true when stat reports ENOENT, and the answer follows the error code alone', async () => {
    // The file exists on disk. Only the injected error code can make this true,
    // so the answer provably comes from the code and not from a second lookup.
    const existingFile = path.join(workDir, 'present.jsonl');
    fs.writeFileSync(existingFile, '{"type":"user"}\n', 'utf8');
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
    );
    await expect(isConfirmedMissing(existingFile)).resolves.toBe(true);
  });

  it.each(['EACCES', 'EPERM', 'EBUSY', 'EIO'])('is false when stat rejects with %s', async (errorCode) => {
    // The path does not exist. Only the error code makes the difference, which
    // is the point: a failure other than ENOENT proves nothing about absence.
    const missingPath = path.join(workDir, 'no-such-file.jsonl');
    const statSpy = vi.spyOn(fs.promises, 'stat').mockRejectedValue(
      Object.assign(new Error(`${errorCode}: simulated failure`), { code: errorCode }),
    );
    await expect(isConfirmedMissing(missingPath)).resolves.toBe(false);
    expect(statSpy).toHaveBeenCalledWith(missingPath);
  });

  it('is false when stat rejects with an error that carries no code', async () => {
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('unexpected failure'));
    await expect(isConfirmedMissing(path.join(workDir, 'no-such-file.jsonl'))).resolves.toBe(false);
  });
});
