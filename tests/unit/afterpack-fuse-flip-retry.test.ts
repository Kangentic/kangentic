/**
 * build/afterPack.js `flipFusesWhenBinaryIdle`: the fuse flip after the load probes.
 *
 * The probes run a real process under the packaged Electron binary, and `flipFuses` then opens
 * that file for writing. On Linux that open fails with ETXTBSY while the kernel still counts a
 * process as running the file, which it can for a few milliseconds after the probe reports its
 * child's exit. The package smoke job on ubuntu-24.04-arm failed twice that way on code that had
 * passed it minutes before.
 *
 * Pins that only ETXTBSY is retried, that a binary that never becomes idle still fails the package
 * with the original error (a release gate that guarantees something fails loudly), and that every
 * other error is thrown on the first attempt.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { flipFusesWhenBinaryIdle } = require('../../build/afterPack.js') as {
  flipFusesWhenBinaryIdle: (
    binaryPath: string,
    config: Record<string, unknown>,
    options: {
      flip: (binaryPath: string, config: Record<string, unknown>) => Promise<unknown>;
      attempts?: number;
      delayMs?: number;
      sleep: (milliseconds: number) => Promise<void>;
      log: (message: string) => void;
    },
  ) => Promise<unknown>;
};

const BINARY = '/out/linux-arm64-unpacked/kangentic';
const CONFIG = { version: 1 };

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: text file is busy, open '${BINARY}'`);
  error.code = code;
  return error;
}

function harness(flip: (binaryPath: string, config: Record<string, unknown>) => Promise<unknown>) {
  const sleep = vi.fn(async () => {});
  const log = vi.fn();
  return { sleep, log, options: { flip, attempts: 5, delayMs: 250, sleep, log } };
}

describe('flipFusesWhenBinaryIdle', () => {
  it('flips at once when the binary is idle, without waiting', async () => {
    const flip = vi.fn(async () => 'flipped');
    const { options, sleep } = harness(flip);
    await expect(flipFusesWhenBinaryIdle(BINARY, CONFIG, options)).resolves.toBe('flipped');
    expect(flip).toHaveBeenCalledTimes(1);
    expect(flip).toHaveBeenCalledWith(BINARY, CONFIG);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits and tries again while the binary is busy, then flips once it is released', async () => {
    const flip = vi.fn()
      .mockRejectedValueOnce(errorWithCode('ETXTBSY'))
      .mockRejectedValueOnce(errorWithCode('ETXTBSY'))
      .mockResolvedValueOnce('flipped');
    const { options, sleep, log } = harness(flip);
    await expect(flipFusesWhenBinaryIdle(BINARY, CONFIG, options)).resolves.toBe('flipped');
    expect(flip).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('ETXTBSY');
  });

  it('throws the original ETXTBSY error when the binary never becomes idle, after exactly the attempt limit', async () => {
    const busy = errorWithCode('ETXTBSY');
    const flip = vi.fn(async () => { throw busy; });
    const { options, sleep } = harness(flip);
    await expect(flipFusesWhenBinaryIdle(BINARY, CONFIG, options)).rejects.toBe(busy);
    expect(flip).toHaveBeenCalledTimes(5);
    // No wait after the last attempt: it fails at once.
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it.each(['EACCES', 'ENOENT', 'EBUSY'])('does not retry %s', async (code) => {
    const failure = errorWithCode(code);
    const flip = vi.fn(async () => { throw failure; });
    const { options, sleep } = harness(flip);
    await expect(flipFusesWhenBinaryIdle(BINARY, CONFIG, options)).rejects.toBe(failure);
    expect(flip).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry an error with no code, such as a fuse the config does not set', async () => {
    const failure = new Error('Fuse wire has an unknown fuse');
    const flip = vi.fn(async () => { throw failure; });
    const { options, sleep } = harness(flip);
    await expect(flipFusesWhenBinaryIdle(BINARY, CONFIG, options)).rejects.toBe(failure);
    expect(flip).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
