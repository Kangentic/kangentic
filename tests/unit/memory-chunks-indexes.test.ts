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
 * node:sqlite rather than better-sqlite3 on purpose: better-sqlite3 is compiled
 * for Electron's Node ABI, so every suite gated on it skips everywhere.
 */

import { describe, it, expect } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

type NodeDatabase = InstanceType<SqliteModule['DatabaseSync']>;

/** node:sqlite behind the slice of better-sqlite3 the migrations and store use,
 *  recording every statement prepared. Raw BEGIN/COMMIT: no nesting. */
function adaptDatabase(database: NodeDatabase, prepared: string[]): DatabaseType.Database {
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => {
      prepared.push(sql);
      return database.prepare(sql);
    },
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        database.exec('BEGIN');
        try {
          const result = body(...args);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

function migrated(): { database: NodeDatabase; adapted: DatabaseType.Database; prepared: string[] } {
  const database = new sqlite!.DatabaseSync(':memory:');
  const prepared: string[] = [];
  const adapted = adaptDatabase(database, prepared);
  runProjectMigrations(adapted);
  return { database, adapted, prepared };
}

function indexNames(database: NodeDatabase): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_chunks'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function planOf(database: NodeDatabase, sql: string, params: Array<string | number>): string {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(' | ');
}

describeWithSqlite('memory_chunks indexes', () => {
  it('carries embedded_model in a per-document index and drops the duplicate of the unique index', () => {
    const { database } = migrated();

    expect(indexNames(database)).toContain('idx_memory_chunks_doc_embedded');
    expect(indexNames(database)).not.toContain('idx_memory_chunks_doc');
    const columns = (database.prepare("PRAGMA index_info('idx_memory_chunks_doc_embedded')").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(columns).toEqual(['corpus', 'doc_id', 'embedded_model']);
  });

  it('drops the old index from a database that still has it', () => {
    const { database, adapted } = migrated();
    database.exec('CREATE INDEX idx_memory_chunks_doc ON memory_chunks(corpus, doc_id, seq)');

    runProjectMigrations(adapted);

    expect(indexNames(database)).not.toContain('idx_memory_chunks_doc');
  });

  it('answers the coverage totals from the covering index, never the table', () => {
    const { database, adapted, prepared } = migrated();

    new RetrievalStore(adapted).documentChunkTotals(['conversation']);

    const totalsSql = prepared.find((sql) => sql.includes('embeddedCount'));
    expect(totalsSql).toBeDefined();
    expect(planOf(database, totalsSql!, ['conversation'])).toContain('COVERING INDEX idx_memory_chunks_doc_embedded');
  });

  it('still reads a document\'s chunks in seq order as an index seek, with no sort', () => {
    const { database, adapted, prepared } = migrated();

    new RetrievalStore(adapted).getChunksForDoc('conversation', 'doc-1');

    const documentSql = prepared.find((sql) => sql.includes('WHERE corpus = ? AND doc_id = ? ORDER BY seq'));
    expect(documentSql).toBeDefined();
    const plan = planOf(database, documentSql!, ['conversation', 'doc-1']);
    expect(plan).toMatch(/SEARCH memory_chunks USING INDEX \S+ \(corpus=\? AND doc_id=\?\)/);
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
