/**
 * isProcessAlive (src/main/shared/process-liveness.ts): the pid probe shared
 * by the shutdown exit-callback drain and the background-shell process-tree
 * probes. Tier: Unit.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isProcessAlive } from '../../src/main/shared/process-liveness';

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('isProcessAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('rejects pids that cannot name a child process', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    expect(isProcessAlive(12.5)).toBe(false);
  });

  it('treats EPERM as alive (the process exists but cannot be signalled)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeErrnoError('EPERM');
    });
    expect(isProcessAlive(4242)).toBe(true);
  });

  it('treats ESRCH as dead (terminated on Windows, reaped on POSIX)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeErrnoError('ESRCH');
    });
    expect(isProcessAlive(4242)).toBe(false);
  });
});
