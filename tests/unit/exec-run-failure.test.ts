/**
 * `execRunFailureOf` says how a rejected `execAsync` or `execFileAsync` run
 * ended, as one fixed word a report can carry (Sentry DESKTOP-4E: a failed
 * `claude -p /usage` run was reported with nothing to tell a timeout from an
 * exit or a CLI that would not start).
 *
 * Real children through the real drop-in. With no executor registered that is
 * the local `promisify` path, and the host's copy of a rejection carries the
 * same fields (`toError` in off-main-exec.ts), so one reader serves both.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, execRunFailureOf } from '../../src/main/utility-process/off-main-exec';
import { PtyHostExitedError, PtyHostTimeoutError } from '../../src/main/pty/host/pty-host-request-errors';

/** What `run` rejected with, or a failure when it did not. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('the run did not fail');
}

describe('execRunFailureOf', () => {
  it('reads a non-zero exit, with its code', async () => {
    const rejection = await rejectionOf(execFileAsync(process.execPath, ['-e', 'process.exit(3)']));
    expect(execRunFailureOf(rejection)).toEqual({ kind: 'exit_code', exitCode: 3 });
  });

  it('reads a run stopped at its timeout, which has a signal too', async () => {
    const rejection = await rejectionOf(execFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 300 }));
    expect(execRunFailureOf(rejection)).toEqual({ kind: 'timeout', exitCode: null });
  });

  it('reads a program that could not start', async () => {
    const rejection = await rejectionOf(execFileAsync(path.join(os.tmpdir(), 'kangentic-no-such-program'), []));
    expect(execRunFailureOf(rejection)).toEqual({ kind: 'spawn_error', exitCode: null });
  });

  // Node kills a child whose output passes the cap and sets `killed`, as it does at a timeout.
  it('reads an output past its cap as other, not as a timeout', async () => {
    const rejection = await rejectionOf(
      execFileAsync(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { maxBuffer: 1024 }),
    );
    expect(execRunFailureOf(rejection)).toEqual({ kind: 'other', exitCode: null });
  });

  it('reads a signal that ended the run', () => {
    const rejection = Object.assign(new Error('Command failed'), { killed: false, signal: 'SIGKILL', code: null });
    expect(execRunFailureOf(rejection)).toEqual({ kind: 'signal', exitCode: null });
  });

  it('reads a pty host that gave no answer by its error type', () => {
    expect(execRunFailureOf(new PtyHostTimeoutError('exec'))).toEqual({ kind: 'host_unavailable', exitCode: null });
    expect(execRunFailureOf(new PtyHostExitedError())).toEqual({ kind: 'host_unavailable', exitCode: null });
  });

  it('reads anything else as other', () => {
    expect(execRunFailureOf(new Error('takes plain arguments only'))).toEqual({ kind: 'other', exitCode: null });
    expect(execRunFailureOf('not an error')).toEqual({ kind: 'other', exitCode: null });
  });
});
