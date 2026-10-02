/**
 * `indexedConversationNodes` (src/main/retrieval/related-work.ts): the rollup
 * nodes `kangentic_search` ranks tasks over, on a real migrated database.
 *
 * Which session and task each conversation belongs to is read by grouping every
 * conversation chunk row, about 300 ms on main on a 94k-chunk index, and the
 * tool asked for it on every call, up to four times per answer. It is now kept
 * until the index changes. Two things have to hold: an unchanged index reads
 * the chunks once, and a task renamed with no index change still shows its new
 * title, because titles are read fresh rather than kept.
 *
 * node:sqlite rather than better-sqlite3 on purpose: better-sqlite3 is compiled
 * for Electron's Node ABI, so every suite gated on it skips everywhere.
 */

import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { forgetConversationOwners, indexedConversationNodes } from '../../src/main/retrieval/related-work';
import type { ChunkInput, CorpusDocumentRef } from '../../src/main/retrieval/types';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;
type NodeDatabase = InstanceType<SqliteModule['DatabaseSync']>;

import { adaptDatabase } from './helpers/node-sqlite-database';

const CREATED_AT = '2026-09-30T00:00:00.000Z';

function chunk(seq: number): ChunkInput {
  return {
    seq,
    text: `text-${seq}`,
    contentHash: `hash-${seq}`,
    tokenEstimate: 10,
    role: 'user',
    tsStart: 1,
    tsEnd: 2,
    turnUuidStart: `u${seq}`,
    turnUuidEnd: `u${seq}`,
  };
}

function conversation(docId: string, sessionId: string, taskId: string): CorpusDocumentRef {
  return { corpus: 'conversation', docId, sessionId, taskId, agentSessionId: docId, metaJson: null };
}

/** A board with one task, #7, and one indexed conversation of it. */
function project() {
  const database = new sqlite!.DatabaseSync(':memory:');
  const prepared: string[] = [];
  const db = adaptDatabase(database, prepared);
  runProjectMigrations(db);
  database.prepare("INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'To Do', 0, ?)").run(CREATED_AT);
  database
    .prepare("INSERT INTO tasks (id, title, swimlane_id, position, display_id, created_at, updated_at) VALUES ('task-1', 'Relay config', 'lane-1', 0, 7, ?, ?)")
    .run(CREATED_AT, CREATED_AT);
  const store = new RetrievalStore(db);
  store.upsertDocument(conversation('doc-1', 'session-1', 'task-1'), [chunk(0), chunk(1)]);
  /** How many times the chunk owners were read, the statement the cache saves. */
  const ownerReads = (): number => prepared.filter((sql) => sql.includes('MAX(session_id) AS sessionId') && sql.includes('GROUP BY doc_id')).length;
  return { database, db, store, ownerReads, getDb: () => db };
}

describeWithSqlite('indexedConversationNodes', () => {
  it('names each conversation with its session, task and the task\'s card number and title', () => {
    const { getDb } = project();
    expect(indexedConversationNodes('project-shape', getDb)).toEqual([{
      docKey: 'conversation::doc-1',
      taskId: 'task-1',
      displayId: 7,
      title: 'Relay config',
      sessionId: 'session-1',
    }]);
  });

  it('reads the chunk owners once while the index is unchanged, and again once it changes', () => {
    const { store, ownerReads, getDb } = project();
    indexedConversationNodes('project-reads', getDb);
    indexedConversationNodes('project-reads', getDb);
    expect(ownerReads()).toBe(1);

    store.upsertDocument(conversation('doc-2', 'session-2', 'task-1'), [chunk(0)]);
    const nodes = indexedConversationNodes('project-reads', getDb);
    expect(ownerReads()).toBe(2);
    expect(nodes.map((node) => node.docKey)).toEqual(['conversation::doc-1', 'conversation::doc-2']);
  });

  // The owners are kept per project for the life of the worker, and
  // `project.close` lets go of a deleted project's list
  // (`forgetConversationOwners`). The index below never changes, so only that
  // call can make the next read go back to the chunks.
  //
  // Red-green: make `forgetConversationOwners` do nothing (or delete another
  // key, or key it wrongly). The second read is then served from the kept list,
  // `ownerReads` stays 1, and the assertion after the forget fails. Make it
  // `clear()` the whole map and the control below fails instead.
  it('reads the chunk owners again after the project\'s owners are forgotten, though its index is unchanged', () => {
    const { ownerReads, getDb } = project();
    const before = indexedConversationNodes('project-forgotten', getDb);
    indexedConversationNodes('project-forgotten', getDb);
    expect(ownerReads()).toBe(1);

    // Another project's forget leaves this one's kept list in place.
    forgetConversationOwners('project-another');
    indexedConversationNodes('project-forgotten', getDb);
    expect(ownerReads()).toBe(1);

    forgetConversationOwners('project-forgotten');
    const after = indexedConversationNodes('project-forgotten', getDb);

    expect(ownerReads()).toBe(2);
    expect(after).toEqual(before);
  });

  it('shows a task renamed with no index change by its new title', () => {
    const { database, ownerReads, getDb } = project();
    indexedConversationNodes('project-rename', getDb);
    database.prepare("UPDATE tasks SET title = 'Relay settings' WHERE id = 'task-1'").run();

    const [node] = indexedConversationNodes('project-rename', getDb);
    expect(node.title).toBe('Relay settings');
    // Served from the kept owners: the rename moved no chunk.
    expect(ownerReads()).toBe(1);
  });
});
