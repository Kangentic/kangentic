import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { TranscriptRepository } from '../../src/main/db/repositories/transcript-repository';

// The native better-sqlite3 binding is built for Electron's ABI and cannot load
// under vitest's system Node, so repository SQL is exercised at the E2E tier.
// These tests use a fake db to lock the method's JS contract: the parameters it
// binds (a NEGATIVE substr start so SQLite returns the tail) and how it maps and
// null-coalesces the returned row.
function fakeDb(rowFor: (sql: string, args: unknown[]) => unknown): {
  db: Database.Database;
  lastSql: () => string;
  lastArgs: () => unknown[];
} {
  let capturedSql = '';
  let capturedArgs: unknown[] = [];
  const db = {
    prepare(sql: string) {
      capturedSql = sql;
      return {
        get: (...args: unknown[]) => {
          capturedArgs = args;
          return rowFor(sql, args);
        },
      };
    },
  } as unknown as Database.Database;
  return { db, lastSql: () => capturedSql, lastArgs: () => capturedArgs };
}

describe('TranscriptRepository.getTranscriptTail', () => {
  it('returns null when no row exists', () => {
    const { db } = fakeDb(() => undefined);
    expect(new TranscriptRepository(db).getTranscriptTail('s1', 100)).toBeNull();
  });

  it('binds a negative substr start (so SQLite returns the tail) and the session id', () => {
    const { db, lastSql, lastArgs } = fakeDb(() => ({
      tail: 'ghij', full_length: 10, size_bytes: 10, created_at: 'c', updated_at: 'u',
    }));
    new TranscriptRepository(db).getTranscriptTail('s1', 4);
    expect(lastSql()).toContain('substr(transcript, ?)');
    expect(lastArgs()).toEqual([-4, 's1']);
  });

  it('maps the row fields and reports full length for truncation', () => {
    const { db } = fakeDb(() => ({
      tail: 'x'.repeat(1000), full_length: 5000, size_bytes: 5000, created_at: 'c', updated_at: 'u',
    }));
    const result = new TranscriptRepository(db).getTranscriptTail('s1', 1000);
    expect(result).toEqual({
      tail: 'x'.repeat(1000),
      fullLength: 5000,
      sizeBytes: 5000,
      createdAt: 'c',
      updatedAt: 'u',
    });
  });

  it('coalesces nulls from an empty transcript row', () => {
    const { db } = fakeDb(() => ({
      tail: null, full_length: 0, size_bytes: 0, created_at: 'c', updated_at: 'u',
    }));
    const result = new TranscriptRepository(db).getTranscriptTail('s1', 100);
    expect(result?.tail).toBe('');
    expect(result?.fullLength).toBe(0);
  });

  it('clamps a negative maxChars to zero so the start is never positive', () => {
    const { db, lastArgs } = fakeDb(() => ({
      tail: '', full_length: 0, size_bytes: 0, created_at: 'c', updated_at: 'u',
    }));
    new TranscriptRepository(db).getTranscriptTail('s1', -50);
    expect(lastArgs()[0] as number).toBeLessThanOrEqual(0);
    expect(lastArgs()[1]).toBe('s1');
  });
});
