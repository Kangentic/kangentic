/**
 * Unit tests for src/main/db/sqlite-error.ts.
 *
 * The only existing coverage was indirect: global-db-degradation.test.ts asserts
 * the dialog copy contains "disk I/O error (SQLITE_IOERR)", which reaches only
 * the isSqliteError-true branch and the first return of describeSqliteFailure.
 * This file pins every branch directly, including the duck-typing decision
 * itself: isSqliteError checks `instanceof Error` before it looks at `code`, so
 * a plain object carrying a SQLITE_* code is deliberately rejected.
 *
 * The module imports nothing, so no mocks are needed here.
 */

import { describe, it, expect } from 'vitest';
import { isSqliteError, describeSqliteFailure } from '../../src/main/db/sqlite-error';

describe('isSqliteError', () => {
  it('is true for an Error carrying a SQLITE_* code', () => {
    const error = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    expect(isSqliteError(error)).toBe(true);
  });

  it('is false for a plain Error with no code', () => {
    expect(isSqliteError(new Error('boom'))).toBe(false);
  });

  it('is false when code is not a string', () => {
    const error = Object.assign(new Error('boom'), { code: 14 });
    expect(isSqliteError(error)).toBe(false);
  });

  it('is false when code is a string that does not start with SQLITE_', () => {
    const error = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(isSqliteError(error)).toBe(false);
  });

  it('is false for a non-Error object that merely has a SQLITE_* code', () => {
    // The load-bearing half of the duck-typing decision: this object has the
    // exact shape better-sqlite3 throws, but it is rejected on the
    // `instanceof Error` guard alone, before `code` is even read.
    const notAnError = { message: 'disk I/O error', code: 'SQLITE_IOERR' };
    expect(isSqliteError(notAnError)).toBe(false);
  });

  it('is false for null', () => {
    expect(isSqliteError(null)).toBe(false);
  });

  it('is false for a plain string', () => {
    expect(isSqliteError('disk I/O error')).toBe(false);
  });
});

describe('describeSqliteFailure', () => {
  it('returns "<message> (<code>)" for a SQLite error', () => {
    const error = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    expect(describeSqliteFailure(error)).toBe('disk I/O error (SQLITE_IOERR)');
  });

  it('falls back to the message for a plain Error', () => {
    // The documented real case: a NODE_MODULE_VERSION ABI mismatch throws a
    // plain Error, not a SqliteError, and the user still needs a line.
    const error = new Error(
      "The module 'better_sqlite3.node' was compiled against a different Node.js version",
    );
    expect(describeSqliteFailure(error)).toBe(error.message);
  });

  it('falls back to String(error) for a non-Error value', () => {
    expect(describeSqliteFailure('disk I/O error')).toBe('disk I/O error');
  });

  it('falls back to String(error) for an Error with an empty message', () => {
    // `error instanceof Error && error.message` requires a truthy message, so
    // an empty string falls through to the String(error) branch rather than
    // returning ''.
    const error = new Error('');
    expect(describeSqliteFailure(error)).toBe(String(error));
  });
});
