/**
 * The retrieval worker's task-keyed transcript handlers hand the registry's
 * task id to `resolveTaskTranscript` (GitHub #822). After a restart a paused
 * task's registry row is a placeholder with a fresh session id and no row in
 * the `sessions` table, so the resolver can only anchor on the task through
 * the id main sends. A handler that drops it reads nothing for that task.
 *
 * The handlers are driven directly; the resolver is the one thing replaced.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';

const { resolveTaskTranscriptMock } = vi.hoisted(() => ({ resolveTaskTranscriptMock: vi.fn() }));

vi.mock('../../src/main/agent/transcript-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/transcript-service')>();
  return { ...actual, resolveTaskTranscript: resolveTaskTranscriptMock };
});

import { transcriptHandlers } from '../../src/main/retrieval/worker/transcript-methods';

const fakeDb = {} as unknown as Database.Database;

const context: WorkerContext = {
  getDb: () => fakeDb,
  closeDb: () => undefined,
  vecLoadError: () => null,
  emit: () => undefined,
};

beforeEach(() => {
  resolveTaskTranscriptMock.mockReset();
  resolveTaskTranscriptMock.mockResolvedValue(null);
});

describe('worker transcript handlers pass the task id to the resolver', () => {
  it('transcript.task', async () => {
    await transcriptHandlers['transcript.task']({
      projectId: 'project-1', sessionId: 'session-1', taskId: 'task-x', remoteTargets: [],
    }, context);

    expect(resolveTaskTranscriptMock).toHaveBeenCalledWith(fakeDb, 'session-1', 'task-x');
  });

  it('transcript.window', async () => {
    await transcriptHandlers['transcript.window']({
      projectId: 'project-1', sessionId: 'session-1', taskId: 'task-x', limit: 10, remoteTargets: [],
    }, context);

    expect(resolveTaskTranscriptMock).toHaveBeenCalledWith(fakeDb, 'session-1', 'task-x');
  });

  it('transcript.mobileSync', async () => {
    await transcriptHandlers['transcript.mobileSync']({
      syncId: 'sync-task-id', projectId: 'project-1', sessionId: 'session-1', taskId: 'task-x', mode: 'seed', remoteTargets: [],
    }, context);

    expect(resolveTaskTranscriptMock).toHaveBeenCalledWith(fakeDb, 'session-1', 'task-x');
  });
});
