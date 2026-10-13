import { describe, it, expect, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { retrievalHandlers, type WorkerContext } from '../../src/main/retrieval/worker/methods';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { BackgroundCallRepository } from '../../src/main/db/repositories/background-call-repository';
import { openTestDatabase } from './helpers/test-database';

/**
 * The retrieval worker's handlers, run directly on the real project schema
 * over real better-sqlite3, the driver the worker uses. The worker entry only
 * dispatches to these, so this is what the worker answers.
 */

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function openProject(): DatabaseType.Database {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  return database;
}

function contextFor(databases: Map<string, DatabaseType.Database>): WorkerContext {
  return {
    getDb: (projectId) => {
      const database = databases.get(projectId);
      if (!database) throw new Error(`unable to open database file for ${projectId}`);
      return database;
    },
    emit: () => undefined,
  };
}

describe('retrieval worker methods', () => {
  it('projects.summaries answers each project in order, and null for one whose database will not open', async () => {
    const indexed = openProject();
    const store = new RetrievalStore(indexed);
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
        return project;
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
    new record.ConversationUsageStore(project).recordTurns(
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

  // The worker opens a project's database with migrations off, so a project main
  // has not opened since the background_calls table arrived has no such table.
  // The dashboard reads every project in one pass, so this one read must answer
  // empty there, not reject and drop the whole dashboard.
  //
  // Red-green: make `hasBackgroundCallsTable` return true unconditionally. The
  // unmigrated read then throws `no such table: background_calls`.
  it('usage.read answers listBackgroundCallGroups from the ledger, and empty from a database with no table yet', async () => {
    const migrated = openProject();
    new BackgroundCallRepository(migrated).record({
      id: 'call-1',
      job: 'condition_check',
      taskId: null,
      swimlaneId: null,
      agent: 'claude',
      requestedModel: 'claude-haiku-5-5',
      effort: 'low',
      usage: { model: 'claude-haiku-5-5', inputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 35, costUsd: 0.0005 },
      durationMs: 900,
      outcome: 'succeeded',
      detail: null,
      startedAt: '2026-10-13T14:02:11.402Z',
    });
    // Never migrated: the shape of a project database main has not opened since the upgrade.
    const unmigrated = openTestDatabase();
    openDatabases.push(unmigrated);
    const handler = retrievalHandlers['usage.read'];
    const context = contextFor(new Map([['migrated', migrated], ['unmigrated', unmigrated]]));
    const fifteenMinutes = 15 * 60_000;

    const groups = await handler({ projectId: 'migrated', read: 'listBackgroundCallGroups', args: [null, null, fifteenMinutes] }, context);
    expect(groups).toEqual([expect.objectContaining({ job: 'condition_check', agent: 'claude', modelId: 'claude-haiku-5-5', calls: 1, outputTokens: 35 })]);
    expect(await handler({ projectId: 'unmigrated', read: 'listBackgroundCallGroups', args: [null, null, fifteenMinutes] }, context)).toEqual([]);
  });
});
