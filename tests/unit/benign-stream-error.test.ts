/**
 * Unit tests for `isBenignStreamWriteError` - the classifier that keeps the
 * Windows npm-start stdio `write EAGAIN`/EPIPE artifact out of crash records
 * and `app_error` telemetry without swallowing genuine faults.
 */
import { describe, it, expect } from 'vitest';
import { isBenignStreamWriteError } from '../../src/main/diagnostics/benign-stream-error';

function streamError(code: string, syscall: string | undefined): NodeJS.ErrnoException {
  const error = new Error(`${syscall ?? 'op'} ${code}`) as NodeJS.ErrnoException & { syscall?: string };
  error.code = code;
  error.syscall = syscall;
  return error;
}

describe('isBenignStreamWriteError', () => {
  it('treats a stdio write EAGAIN as benign', () => {
    expect(isBenignStreamWriteError(streamError('EAGAIN', 'write'))).toBe(true);
  });

  it('treats a stdio write EPIPE as benign', () => {
    expect(isBenignStreamWriteError(streamError('EPIPE', 'write'))).toBe(true);
  });

  it('does not suppress EAGAIN from a non-write syscall', () => {
    expect(isBenignStreamWriteError(streamError('EAGAIN', 'read'))).toBe(false);
    expect(isBenignStreamWriteError(streamError('EAGAIN', 'connect'))).toBe(false);
  });

  it('does not suppress a write error with an unrelated code', () => {
    expect(isBenignStreamWriteError(streamError('ENOSPC', 'write'))).toBe(false);
    expect(isBenignStreamWriteError(streamError('EACCES', 'write'))).toBe(false);
  });

  it('does not suppress an error missing a syscall', () => {
    expect(isBenignStreamWriteError(streamError('EAGAIN', undefined))).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isBenignStreamWriteError(undefined)).toBe(false);
    expect(isBenignStreamWriteError(null)).toBe(false);
    expect(isBenignStreamWriteError('EAGAIN')).toBe(false);
    expect(isBenignStreamWriteError(new Error('plain'))).toBe(false);
  });
});
