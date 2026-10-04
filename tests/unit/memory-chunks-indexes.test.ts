/**
 * The memory_chunks indexes, replayed through the real project migrations.
 *
 * The Knowledge Graph's coverage groups every conversation chunk by document
 * and counts the embedded ones. Without embedded_model in an index that count
 * read the table row by row (266 ms on 93k chunks); the covering
 * `idx_memory_chunks_doc_embedded` answers it from the index (10 ms). The old
 * `idx_memory_chunks_doc` duplicated the UNIQUE(corpus, doc_id, seq) index and
 * is dropped, so per-document reads must still seek on that unique index.
 *
 * The full-text triggers on the same table are replayed here too: the migration
 * replaces the old unconditional triggers with ones that skip the code corpus,
 * so an upgraded database must end with the new three only, and stay that way.
 *
 * Real better-sqlite3, the driver production uses, so the query plans and trigger
 * behavior asserted here are the ones that ship.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CONVERSATION_VEC_COPY_IDS_SQL, RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { buildRetrievalIndex, missingRetrievalIndexes, RETRIEVAL_INDEXES } from '../../src/main/retrieval/index-builds';

import { openTestDatabase } from './helpers/test-database';

type TestDatabase = DatabaseType.Database;

const openDatabases: TestDatabase[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

/** An empty in-memory database that records the SQL of every statement prepared. */
function openTracked(): { database: TestDatabase; prepared: string[] } {
  const prepared: string[] = [];
  const database = openTestDatabase(':memory:', { prepared });
  openDatabases.push(database);
  return { database, prepared };
}

/** A database migrated by main and opened by the retrieval worker, which
 *  builds the index's own indexes (`index-builds.ts`). */
function migrated(): { database: TestDatabase; prepared: string[] } {
  const { database, prepared } = openTracked();
  runProjectMigrations(database);
  for (const index of missingRetrievalIndexes(database)) buildRetrievalIndex(database, index);
  return { database, prepared };
}

function indexNames(database: TestDatabase): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_chunks'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function planOf(database: TestDatabase, sql: string, params: Array<string | number>): string {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(' | ');
}

/** The full-text triggers on `memory_chunks`. The ones that keep the graph's
 *  document sums honest are pinned in `retrieval-store-sql.test.ts`. */
function isFullTextTrigger(name: string): boolean {
  return !name.startsWith('trg_memory_chunks_doc_sums');
}

function triggerNames(database: TestDatabase): string[] {
  return triggerSql(database).map((row) => row.name);
}

function triggerSql(database: TestDatabase): Array<{ name: string; sql: string }> {
  return (database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'memory_chunks' ORDER BY name").all() as Array<{ name: string; sql: string }>)
    .filter((row) => isFullTextTrigger(row.name));
}

function insertChunk(database: TestDatabase, corpus: string, docId: string, text: string): void {
  database
    .prepare(
      `INSERT INTO memory_chunks (corpus, doc_id, seq, role, text, content_hash, token_estimate, created_at)
       VALUES (?, ?, 0, 'user', ?, ?, 1, '2026-09-29T00:00:00.000Z')`,
    )
    .run(corpus, docId, text, `hash-${corpus}-${docId}`);
}

/** How many chunks the full-text index holds for one word. */
function fullTextHits(database: TestDatabase, word: string): number {
  return (database.prepare('SELECT COUNT(*) AS count FROM memory_chunks_fts WHERE memory_chunks_fts MATCH ?').get(word) as { count: number }).count;
}

/** A database as it was before source code had its own corpus: the three
 *  triggers unconditional, under their old names, and none under the new ones. */
function withOldTriggers(): ReturnType<typeof migrated> {
  const fixture = migrated();
  for (const name of ['trg_memory_chunks_fts_ai', 'trg_memory_chunks_fts_ad', 'trg_memory_chunks_fts_au']) {
    fixture.database.exec(`DROP TRIGGER ${name}`);
  }
  fixture.database.exec(`
    CREATE TRIGGER trg_memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(rowid, text) VALUES (new.id, new.text);
    END
  `);
  fixture.database.exec(`
    CREATE TRIGGER trg_memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END
  `);
  fixture.database.exec(`
    CREATE TRIGGER trg_memory_chunks_au AFTER UPDATE OF text ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO memory_chunks_fts(rowid, text) VALUES (new.id, new.text);
    END
  `);
  return fixture;
}

const CURRENT_TRIGGERS = ['trg_memory_chunks_fts_ad', 'trg_memory_chunks_fts_ai', 'trg_memory_chunks_fts_au'];

describe('memory_chunks full-text triggers', () => {
  it('a new database has the three code-skipping triggers, once each', () => {
    const { database } = migrated();

    expect(triggerNames(database)).toEqual(CURRENT_TRIGGERS);
  });

  it('an old database has its unconditional triggers replaced, not added to', () => {
    const { database } = withOldTriggers();
    // The fixture really is the old state: it indexes a code chunk, and lets go of it.
    expect(triggerNames(database)).toEqual(['trg_memory_chunks_ad', 'trg_memory_chunks_ai', 'trg_memory_chunks_au']);
    insertChunk(database, 'code', 'src/old.ts', 'oldstateword');
    expect(fullTextHits(database, 'oldstateword')).toBe(1);
    database.exec("DELETE FROM memory_chunks WHERE corpus = 'code'");
    expect(fullTextHits(database, 'oldstateword')).toBe(0);

    runProjectMigrations(database);

    expect(triggerNames(database)).toEqual(CURRENT_TRIGGERS);
  });

  it('after the upgrade, conversations stay searchable through insert, edit and delete, and code never enters the index', () => {
    const { database } = withOldTriggers();
    runProjectMigrations(database);

    insertChunk(database, 'conversation', 'agent-1', 'alphaword gamma');
    insertChunk(database, 'code', 'src/pacer.ts', 'zetaword gamma');
    // Exactly one entry per conversation chunk: an old trigger left beside the new would index it twice.
    expect(fullTextHits(database, 'alphaword')).toBe(1);
    expect(fullTextHits(database, 'zetaword')).toBe(0);
    expect(fullTextHits(database, 'gamma')).toBe(1);

    database.exec("UPDATE memory_chunks SET text = 'betaword gamma' WHERE corpus = 'conversation'");
    database.exec("UPDATE memory_chunks SET text = 'etaword gamma' WHERE corpus = 'code'");
    expect(fullTextHits(database, 'alphaword')).toBe(0);
    expect(fullTextHits(database, 'betaword')).toBe(1);
    expect(fullTextHits(database, 'etaword')).toBe(0);

    // A code delete must not reach the index: a 'delete' for a row it never held
    // corrupts it, and the error surfaces on the next index write (the delete below).
    database.exec("DELETE FROM memory_chunks WHERE corpus = 'code'");
    database.exec("DELETE FROM memory_chunks WHERE corpus = 'conversation'");
    expect(fullTextHits(database, 'betaword')).toBe(0);
    expect(fullTextHits(database, 'gamma')).toBe(0);
  });

  it('migrating again changes nothing', () => {
    const { database } = withOldTriggers();
    runProjectMigrations(database);
    const once = triggerSql(database);

    runProjectMigrations(database);
    runProjectMigrations(database);

    expect(triggerSql(database)).toEqual(once);
    expect(once.map((trigger) => trigger.name)).toEqual(CURRENT_TRIGGERS);
    for (const trigger of once) expect(trigger.sql, trigger.name).toMatch(/WHEN (new|old)\.corpus <> 'code'/);
    insertChunk(database, 'conversation', 'agent-1', 'deltaword');
    expect(fullTextHits(database, 'deltaword')).toBe(1);
  });
});

describe('memory_chunks indexes', () => {
  it('leaves the index\'s own indexes out of the migrations, and the worker builds each once', () => {
    // A migration runs on main, and building one of these over a full table
    // reads all of it inside a write transaction.
    const { database } = openTracked();
    runProjectMigrations(database);
    const names = RETRIEVAL_INDEXES.map((index) => index.name);
    for (const name of names) expect(indexNames(database), name).not.toContain(name);

    expect(missingRetrievalIndexes(database).map((index) => index.name)).toEqual(names);
    for (const index of missingRetrievalIndexes(database)) buildRetrievalIndex(database, index);
    for (const name of names) expect(indexNames(database), name).toContain(name);
    expect(missingRetrievalIndexes(database)).toEqual([]);
  });

  it('carries embedded_model in a per-document index and drops the duplicate of the unique index', () => {
    const { database } = migrated();

    expect(indexNames(database)).toContain('idx_memory_chunks_doc_embedded');
    expect(indexNames(database)).not.toContain('idx_memory_chunks_doc');
    const columns = (database.prepare("PRAGMA index_info('idx_memory_chunks_doc_embedded')").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(columns).toEqual(['corpus', 'doc_id', 'embedded_model']);
  });

  it('drops the old index from a database that still has it', () => {
    const { database } = migrated();
    database.exec('CREATE INDEX idx_memory_chunks_doc ON memory_chunks(corpus, doc_id, seq)');

    runProjectMigrations(database);

    expect(indexNames(database)).not.toContain('idx_memory_chunks_doc');
  });

  it('answers the coverage totals from the covering index, never the table', () => {
    const { database, prepared } = migrated();

    new RetrievalStore(database).documentChunkTotals(['conversation']);

    const totalsSql = prepared.find((sql) => sql.includes('embeddedCount'));
    expect(totalsSql).toBeDefined();
    expect(planOf(database, totalsSql!, ['conversation'])).toContain('COVERING INDEX idx_memory_chunks_doc_embedded');
  });

  it('pages the graph\'s document metadata in index order, with no sort, and loses no document', () => {
    // Ordered by doc_id alone, each page sorted every remaining group before its
    // LIMIT, so a page cost as much as the whole read (365 ms on 1,005 real
    // conversations). In the index's order a page streams and stops.
    const { database, prepared } = migrated();
    for (const docId of ['agent-c', 'agent-a', 'agent-b']) insertChunk(database, 'conversation', docId, `text of ${docId}`);
    insertChunk(database, 'task', 'task-1', 'a task record, not drawn');
    const store = new RetrievalStore(database);

    const whole = store.documentMetadata().map((row) => row.docId);
    const paged: string[] = [];
    let after = '';
    for (let page = store.documentMetadata(after, 1); page.length > 0; page = store.documentMetadata(after, 1)) {
      paged.push(...page.map((row) => row.docId));
      after = page[page.length - 1].docId;
    }

    expect(whole).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(paged).toEqual(whole);
    const metadataSql = prepared.find((sql) => sql.includes('AS outcome'));
    expect(metadataSql).toBeDefined();
    const plan = planOf(database, metadataSql!, ['', 1]);
    expect(plan).toContain('sqlite_autoindex_memory_chunks_1');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('reads one task\'s chunk ids from an index, never the whole table', () => {
    const { database, prepared } = migrated();

    new RetrievalStore(database).getChunkIdsForTask('task-1');

    const taskSql = prepared.find((sql) => sql.includes('WHERE task_id = ?'));
    expect(taskSql).toBeDefined();
    const plan = planOf(database, taskSql!, ['task-1']);
    expect(plan).toContain('idx_memory_chunks_task');
    expect(plan).not.toMatch(/SCAN memory_chunks\b(?! USING)/);
  });

  it('pages the vector copy by rowid, with no sort, before the worker\'s indexes exist and after', () => {
    // The copy runs before the indexes are built. Planned off the UNIQUE
    // (corpus, doc_id, seq) index instead, each batch of 16 sorted every
    // conversation chunk: 213 ms a batch on the upgrade dry run.
    const { database: before } = openTracked();
    runProjectMigrations(before);
    const { database: after } = migrated();

    for (const database of [before, after]) {
      const plan = planOf(database, CONVERSATION_VEC_COPY_IDS_SQL, [0, 16]);
      expect(plan).toContain('INTEGER PRIMARY KEY (rowid>?)');
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });

  it('still reads a document\'s chunks in seq order as an index seek, with no sort', () => {
    const { database, prepared } = migrated();

    new RetrievalStore(database).getChunksForDoc('conversation', 'doc-1');

    const documentSql = prepared.find((sql) => sql.includes('WHERE corpus = ? AND doc_id = ? ORDER BY seq'));
    expect(documentSql).toBeDefined();
    const plan = planOf(database, documentSql!, ['conversation', 'doc-1']);
    expect(plan).toMatch(/SEARCH memory_chunks USING INDEX \S+ \(corpus=\? AND doc_id=\?\)/);
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
