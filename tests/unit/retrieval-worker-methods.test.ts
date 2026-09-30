import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { retrievalHandlers, type WorkerContext } from '../../src/main/retrieval/worker/methods';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { adaptDatabase, type NodeDatabase } from './helpers/node-sqlite-database';

/**
 * The retrieval worker's handlers, run directly on the real project schema
 * over node:sqlite (better-sqlite3 cannot load under vitest's Node). The worker
 * entry only dispatches to these, so this is what the worker answers.
 */

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

function openProject(): NodeDatabase {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  const database = new sqlite.DatabaseSync(':memory:');
  runProjectMigrations(adaptDatabase(database));
  return database;
}

function contextFor(databases: Map<string, NodeDatabase>): WorkerContext {
  return {
    getDb: (projectId) => {
      const database = databases.get(projectId);
      if (!database) throw new Error(`unable to open database file for ${projectId}`);
      return adaptDatabase(database);
    },
    emit: () => undefined,
  };
}

describeWithSqlite('retrieval worker methods', () => {
  it('projects.summaries answers each project in order, and null for one whose database will not open', async () => {
    const indexed = openProject();
    const store = new RetrievalStore(adaptDatabase(indexed));
    store.upsertDocument(
      { corpus: 'conversation', docId: 'session-1', sessionId: 'session-1', taskId: null, agentSessionId: null, metaJson: null },
      [{
        seq: 0,
        text: 'The PTY session manager restarts a crashed shell.',
        contentHash: 'hash-0',
        tokenEstimate: 12,
        role: 'assistant',
        tsStart: null,
        tsEnd: null,
        turnUuidStart: 'turn-0',
        turnUuidEnd: 'turn-0',
      }],
    );
    const empty = openProject();
    const databases = new Map([['indexed', indexed], ['empty', empty]]);

    const rows = await retrievalHandlers['projects.summaries']({ projectIds: ['indexed', 'missing', 'empty'] }, contextFor(databases));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ projectId: 'indexed', conversations: 1, taskRecords: 0 });
    expect(rows[1]).toBeNull();
    expect(rows[2]).toMatchObject({ projectId: 'empty', conversations: 0, taskRecords: 0, lastIndexedAt: null });
  });
});
