/**
 * The `task` corpus: how a task's record is chunked, and how a sweep keeps the
 * index in step with the board (re-read on `updated_at`, removed when gone).
 *
 * better-sqlite3 cannot load under vitest's system Node, so the sweep runs
 * against a scripted `prepare()` that answers by SQL shape and records every
 * write, the way `retrieval-store-sql.test.ts` does.
 */

import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { taskRecordChunks, parseLabels, TASK_RECORD_VERSION } from '../../src/main/retrieval/task/task-record';
import { sweepTaskRecords, BACKLOG_DOC_PREFIX } from '../../src/main/retrieval/task/task-indexer';

const baseRecord = {
  docId: 'task-1',
  taskId: 'task-1',
  title: 'Relay reconnect after router restart',
  description: '',
  labels: [],
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-02T10:00:00.000Z',
};

describe('taskRecordChunks', () => {
  it('opens every chunk with the title and labels, so a middle passage still names its task', () => {
    const paragraph = 'The phone lost the relay whenever the router restarted. '.repeat(20).trim();
    const chunks = taskRecordChunks({
      ...baseRecord,
      labels: ['mobile', 'bug'],
      description: `${paragraph}\n\n${paragraph}\n\n${paragraph}`,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('Relay reconnect after router restart\nLabels: mobile, bug\n\n')).toBe(true);
      expect(chunk.role).toBe('record');
      expect(chunk.turnUuidStart).toBeNull();
    }
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));
  });

  it('is one chunk of the title alone when there is no description', () => {
    const chunks = taskRecordChunks(baseRecord);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Relay reconnect after router restart');
  });

  it('hard-splits a paragraph too long for one chunk, with overlap', () => {
    const chunks = taskRecordChunks({ ...baseRecord, description: 'x'.repeat(4000) });
    expect(chunks.length).toBe(3);
    const body = (text: string): string => text.slice(text.indexOf('\n\n') + 2);
    expect(body(chunks[0].text).length).toBe(1600);
    expect(body(chunks[1].text).length).toBe(1600);
  });

  it('keeps the record date on every chunk, not its last edit, so a move changes nothing', () => {
    const before = taskRecordChunks(baseRecord);
    const after = taskRecordChunks({ ...baseRecord, updatedAt: '2026-09-28T10:00:00.000Z' });
    expect(after).toEqual(before);
    expect(before[0].tsStart).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
  });

  it('reads the labels column leniently', () => {
    expect(parseLabels('["a","b",3]')).toEqual(['a', 'b']);
    expect(parseLabels('not json')).toEqual([]);
    expect(parseLabels(null)).toEqual([]);
  });
});

interface Call { sql: string; args: unknown[] }

/** A board and an index, answered by SQL shape. */
function fakeProject(board: {
  tasks: Array<{ id: string; title: string; updatedAt: string }>;
  backlog?: Array<{ id: string; title: string; updatedAt: string }>;
  signatures?: Array<{ docId: string; sourcePath: string; sourceMtimeMs: number }>;
  indexedDocIds?: string[];
}): { db: Database.Database; calls: Call[] } {
  const calls: Call[] = [];
  const recordRow = (row: { id: string; title: string; updatedAt: string }) => ({
    id: row.id, title: row.title, description: 'Body text.', labels: '[]', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: row.updatedAt,
  });
  const db = {
    prepare(sql: string) {
      const answer = (args: unknown[]): unknown[] => {
        calls.push({ sql, args });
        if (sql.includes('FROM tasks')) return board.tasks.map(recordRow);
        if (sql.includes('FROM backlog_tasks')) return (board.backlog ?? []).map(recordRow);
        if (sql.includes('FROM memory_index_state WHERE corpus = ?')) return board.signatures ?? [];
        if (sql.includes('SELECT DISTINCT doc_id')) return (board.indexedDocIds ?? []).map((docId) => ({ docId }));
        return [];
      };
      return {
        all: (...args: unknown[]) => answer(args),
        get: (...args: unknown[]) => answer(args)[0],
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
          return { changes: 1, lastInsertRowid: 1 };
        },
      };
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
  return { db, calls };
}

const deps = (db: Database.Database) => ({
  getDb: () => db,
  now: () => '2026-09-28T00:00:00.000Z',
  yieldToEventLoop: async () => undefined,
});

const inserts = (calls: Call[]) => calls.filter((call) => call.sql.includes('INSERT INTO memory_chunks'));
const stateWrites = (calls: Call[]) => calls.filter((call) => call.sql.includes('INSERT INTO memory_index_state'));

describe('sweepTaskRecords', () => {
  it('indexes every task and backlog item on the first sweep, each under its own document', async () => {
    const { db, calls } = fakeProject({
      tasks: [{ id: 'task-1', title: 'One', updatedAt: '2026-09-02T00:00:00.000Z' }],
      backlog: [{ id: 'item-1', title: 'Later', updatedAt: '2026-09-03T00:00:00.000Z' }],
    });

    const result = await sweepTaskRecords('project', () => true, deps(db));

    expect(result).toEqual({ indexed: 2, removed: 0 });
    // corpus, doc_id, seq, session_id, task_id
    expect(inserts(calls).map((call) => call.args.slice(0, 5))).toEqual([
      ['task', 'task-1', 0, null, 'task-1'],
      ['task', `${BACKLOG_DOC_PREFIX}item-1`, 0, null, null],
    ]);
    // The state row records the version and the edit time it was read at.
    expect(stateWrites(calls)[0].args.slice(0, 5)).toEqual([
      'task', 'task-1', null, `task-record-v${TASK_RECORD_VERSION}`, Date.parse('2026-09-02T00:00:00.000Z'),
    ]);
  });

  it('writes nothing when no record has changed since it was read', async () => {
    const { db, calls } = fakeProject({
      tasks: [{ id: 'task-1', title: 'One', updatedAt: '2026-09-02T00:00:00.000Z' }],
      signatures: [{ docId: 'task-1', sourcePath: `task-record-v${TASK_RECORD_VERSION}`, sourceMtimeMs: Date.parse('2026-09-02T00:00:00.000Z') }],
      indexedDocIds: ['task-1'],
    });

    const result = await sweepTaskRecords('project', () => true, deps(db));

    expect(result).toEqual({ indexed: 0, removed: 0 });
    expect(calls.some((call) => /INSERT|DELETE|UPDATE/.test(call.sql))).toBe(false);
  });

  it('re-reads a record whose task was edited, and one read under an older format', async () => {
    const { db, calls } = fakeProject({
      tasks: [
        { id: 'task-1', title: 'Edited', updatedAt: '2026-09-05T00:00:00.000Z' },
        { id: 'task-2', title: 'Old format', updatedAt: '2026-09-02T00:00:00.000Z' },
      ],
      signatures: [
        { docId: 'task-1', sourcePath: `task-record-v${TASK_RECORD_VERSION}`, sourceMtimeMs: Date.parse('2026-09-02T00:00:00.000Z') },
        { docId: 'task-2', sourcePath: 'task-record-v0', sourceMtimeMs: Date.parse('2026-09-02T00:00:00.000Z') },
      ],
      indexedDocIds: ['task-1', 'task-2'],
    });

    const result = await sweepTaskRecords('project', () => true, deps(db));

    expect(result.indexed).toBe(2);
  });

  it('removes the record of a task that is gone, and of a promoted backlog item', async () => {
    const { db, calls } = fakeProject({
      tasks: [{ id: 'task-1', title: 'One', updatedAt: '2026-09-02T00:00:00.000Z' }],
      signatures: [
        { docId: 'task-1', sourcePath: `task-record-v${TASK_RECORD_VERSION}`, sourceMtimeMs: Date.parse('2026-09-02T00:00:00.000Z') },
        { docId: 'task-deleted', sourcePath: `task-record-v${TASK_RECORD_VERSION}`, sourceMtimeMs: 1 },
      ],
      indexedDocIds: ['task-1', 'task-deleted', `${BACKLOG_DOC_PREFIX}promoted`],
    });

    const result = await sweepTaskRecords('project', () => true, deps(db));

    expect(result).toEqual({ indexed: 0, removed: 2 });
    const removedDocs = calls
      .filter((call) => call.sql.startsWith('DELETE FROM memory_chunks WHERE corpus = ? AND doc_id = ?'))
      .map((call) => call.args[1]);
    expect(removedDocs).toEqual(['task-deleted', `${BACKLOG_DOC_PREFIX}promoted`]);
  });

  it('stops at a project switch without finishing the sweep', async () => {
    const { db, calls } = fakeProject({
      tasks: [{ id: 'task-1', title: 'One', updatedAt: '2026-09-02T00:00:00.000Z' }],
    });

    const result = await sweepTaskRecords('project', () => false, deps(db));

    expect(result).toEqual({ indexed: 0, removed: 0 });
    expect(inserts(calls)).toHaveLength(0);
  });
});
