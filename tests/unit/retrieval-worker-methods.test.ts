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

  // Opening a project's database is what loads sqlite-vec, so a load error exists
  // only once `status.indexAll` has opened the projects. A worker's first poll is
  // also its first open: an error read before the opens would report none for
  // exactly the poll that has one to report.
  //
  // Red-green: read `context.vecLoadError()` before `indexStatus.readAll(...)` in
  // the `status.indexAll` handler. The error is then still null, and `vecError`
  // reads null.
  it('status.indexAll reports the sqlite-vec load error that opening the projects produced', async () => {
    const project = openProject();
    let opened = false;
    const context: WorkerContext = {
      getDb: () => {
        opened = true;
        return adaptDatabase(project);
      },
      closeDb: () => undefined,
      // The worker's loader sets this on a connection's open, not before.
      vecLoadError: () => (opened ? 'the sqlite-vec extension failed to load' : null),
      emit: () => undefined,
    };

    const status = await retrievalHandlers['status.indexAll'](
      { projectIds: ['project-vec'], modelTag: 'bge@1', semantic: false, summaries: false },
      context,
    );

    expect(opened).toBe(true);
    expect(status.vecError).toBe('the sqlite-vec extension failed to load');
  });

  it('usage.read answers the usage dashboard\'s reads by name from the ledgers, and refuses an unknown name', async () => {
    const project = openProject();
    const now = Date.parse('2026-09-30T12:00:00.000Z');
    const handler = retrievalHandlers['usage.read'];
    const context = contextFor(new Map([['project-1', project]]));
    // Two turns in the ledger, the earliest at `now - 60 s`.
    const record = await import('../../src/main/retrieval/conversation/conversation-usage-store');
    new record.ConversationUsageStore(adaptDatabase(project)).recordTurns(
      { agentSessionId: null, sessionId: 'session-1', taskId: null },
      [
        { turnUuid: 'turn-1', ts: now - 60_000, model: 'model-a', usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
        { turnUuid: 'turn-2', ts: now, model: 'model-a', usage: { inputTokens: 20, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
      ],
      new Date(now).toISOString(),
    );

    expect(await handler({ projectId: 'project-1', read: 'getEarliestTurnMs', args: [] }, context)).toBe(now - 60_000);
    // A day-wide group holds both turns.
    const groups = await handler({ projectId: 'project-1', read: 'listTurnGroups', args: [null, 86_400_000, null, null, null] }, context);
    expect(groups).toEqual([expect.objectContaining({ inputTokens: 30, outputTokens: 10, turnCount: 2 })]);
    expect(() => handler({ projectId: 'project-1', read: 'constructor' as never, args: [] }, context)).toThrow(/Unknown usage read/);
  });
});
