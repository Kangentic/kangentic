/**
 * `searchRelatedWork` searches the side corpora on every call, over a REAL index.
 *
 * `related-work-across.test.ts` stubs the whole store, so what it cannot see is
 * the wiring inside `searchRelatedWork`: a semantic search of the `task` corpus
 * after the `conversation` one, and one `searchLexicalPerCorpus` call whose
 * limits map covers `commit` and `task`. These spy on the real store's methods,
 * and also check that a match found only in a task record makes a ranked row.
 *
 * Red-green: iterate an empty list instead of `SIDE_CORPORA` and the task search,
 * the lexical limits and the record row all go missing; skip the lexical side
 * scan and the per-corpus spy sees no call.
 *
 * Relevance is set exactly. The query vector is [1, 0] and a chunk is embedded
 * at [c, sqrt(1 - c^2)].
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { markVecCapable } from '../../src/main/retrieval/vec-support';
import type { ChunkInput } from '../../src/main/retrieval/types';
import { openTestDatabase } from './helpers/test-database';

// The module's database helper is never reached (`getDb` is passed), but
// importing it loads the database module, which needs Electron.
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import { searchRelatedWork, type RelatedWorkNode } from '../../src/main/retrieval/related-work';

const MODEL_TAG = 'test@2';
const DIMENSIONS = 2;

const openDatabases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
});

interface DocumentSpec {
  corpus: string;
  docId: string;
  taskId: string;
  text: string;
  /** Cosine to the query vector, or null for a chunk that is not embedded. */
  cosine: number | null;
}

function vectorAt(cosine: number): Float32Array {
  return new Float32Array([cosine, Math.sqrt(1 - cosine * cosine)]);
}

function buildIndex(documents: DocumentSpec[]): Database.Database {
  const database = openTestDatabase(':memory:', { vec: true });
  openDatabases.push(database);
  markVecCapable(database);
  runProjectMigrations(database);
  const store = new RetrievalStore(database);
  store.ensureVecTable(DIMENSIONS);
  const embeddings: Array<{ chunkId: number; vector: Float32Array; contentHash: string }> = [];
  for (const document of documents) {
    const contentHash = crypto.createHash('sha1').update(`${document.docId}:${document.text}`).digest('hex');
    const input: ChunkInput = {
      seq: 0,
      text: document.text,
      contentHash,
      tokenEstimate: 20,
      role: 'user',
      tsStart: 1,
      tsEnd: 1,
      turnUuidStart: `turn-${document.docId}`,
      turnUuidEnd: `turn-${document.docId}`,
    };
    const { insertedIds } = store.upsertDocument({
      corpus: document.corpus,
      docId: document.docId,
      sessionId: `session-${document.docId}`,
      taskId: document.taskId,
      agentSessionId: null,
      metaJson: null,
    }, [input]);
    if (document.cosine !== null) embeddings.push({ chunkId: insertedIds[0], vector: vectorAt(document.cosine), contentHash });
  }
  store.writeEmbeddings(embeddings, MODEL_TAG);
  return database;
}

const embedder = { embed: vi.fn(async () => null), dimensions: DIMENSIONS, modelTag: MODEL_TAG, noiseFloor: 0 };

describe('searchRelatedWork side corpora, over a real index', () => {
  it('searches the task records by meaning and the task and commit corpora by keyword, and a task record makes a row', async () => {
    const database = buildIndex([
      { corpus: 'conversation', docId: 'conversation-doc', taskId: 'task-conversation', text: 'User: recordword in a chat', cosine: 0.8 },
      // The task's own record, reachable only by record: it has no conversation node.
      { corpus: 'task', docId: 'task-record', taskId: 'task-record', text: 'Title: recordword task\nrecordword description', cosine: 0.9 },
      { corpus: 'commit', docId: 'abc123def456', taskId: 'task-record', text: 'recordword commit message', cosine: null },
    ]);
    const nodes: RelatedWorkNode[] = [
      { docKey: 'conversation::conversation-doc', taskId: 'task-conversation', displayId: 1, title: 'Conversation task' },
    ];
    const semanticSpy = vi.spyOn(RetrievalStore.prototype, 'searchSemantic');
    const perCorpusSpy = vi.spyOn(RetrievalStore.prototype, 'searchLexicalPerCorpus');

    const work = await searchRelatedWork({
      question: 'earlier work on recordword',
      keywordText: 'recordword',
      projectId: 'project-1',
      nodes,
      recordOnlyTasks: [{ taskId: 'task-record', displayId: 7, title: 'Record task' }],
      embedder,
      queryVectors: [new Float32Array([1, 0])],
      getDb: () => database,
    });

    // One query vector: the conversation corpus first, then the task corpus.
    expect(semanticSpy.mock.calls.map((call) => call[2])).toEqual([['conversation'], ['task']]);
    // One per-corpus keyword scan whose limits cover both side corpora.
    expect(perCorpusSpy).toHaveBeenCalledTimes(1);
    expect([...perCorpusSpy.mock.calls[0][1].keys()].sort()).toEqual(['commit', 'task']);
    // The task record, with no conversation in scope, is a ranked row.
    expect(work.ranked.map((task) => task.taskId)).toContain('task-record');
  });
});
