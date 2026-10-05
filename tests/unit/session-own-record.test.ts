/**
 * Tests for resolveOwnSessionRecord: the record a capture for a session writes
 * to. The session's own record wins over the task's newest, which can belong
 * to the task's other track; the newest is the fallback before the spawn's
 * record is inserted, and the answer when no session id is known.
 *
 * Tier: Unit. A two-method fake repository: the helper only reads.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveOwnSessionRecord } from '../../src/main/db/repositories/session-own-record';
import type { SessionRecord } from '../../src/shared/types';

function recordWithId(id: string): SessionRecord {
  return { id } as SessionRecord;
}

function makeRepository(ownRecord: SessionRecord | undefined, newestRecord: SessionRecord | undefined) {
  return {
    findByAnyId: vi.fn((_sessionId: string) => ownRecord),
    getLatestForTask: vi.fn((_taskId: string) => newestRecord),
  };
}

describe('resolveOwnSessionRecord', () => {
  it("returns the session's own record even when the task's newest record is another one", () => {
    // The newest belongs to the task's other track (an isolated swimlane's
    // session started after this one).
    const repository = makeRepository(recordWithId('own-run'), recordWithId('other-track-run'));

    expect(resolveOwnSessionRecord(repository, 'own-run', 'task-1')?.id).toBe('own-run');
    expect(repository.findByAnyId).toHaveBeenCalledWith('own-run');
    expect(repository.getLatestForTask).not.toHaveBeenCalled();
  });

  it("falls back to the task's newest record before the spawn's own record is inserted", () => {
    const repository = makeRepository(undefined, recordWithId('previous-run'));

    expect(resolveOwnSessionRecord(repository, 'not-inserted-yet', 'task-1')?.id).toBe('previous-run');
    expect(repository.getLatestForTask).toHaveBeenCalledWith('task-1');
  });

  it.each([null, undefined, ''])("goes straight to the task's newest record for a session id of %j", (sessionId) => {
    const repository = makeRepository(recordWithId('never-read'), recordWithId('newest-run'));

    expect(resolveOwnSessionRecord(repository, sessionId, 'task-1')?.id).toBe('newest-run');
    expect(repository.findByAnyId).not.toHaveBeenCalled();
  });

  it('returns undefined when the task has no record at all', () => {
    expect(resolveOwnSessionRecord(makeRepository(undefined, undefined), 'session-1', 'task-1')).toBeUndefined();
  });
});
