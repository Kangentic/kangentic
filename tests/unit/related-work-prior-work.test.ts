/**
 * The task window's prior work, ranked by `searchRelatedWork` over a REAL index.
 *
 * `related-work-across.test.ts` stubs the whole store, and `related-work.test.ts`
 * pins the pure pieces (`rollUpRelatedWork`, `selectPriorWork`,
 * `priorWorkBackground`). What neither can see is the wiring between them in
 * `searchRelatedWork`: which chunks are read for prose classification, which
 * corpora are searched, where the background comes from, and which selector
 * chooses the rows. Several of those rules are layered (a chunk that is not a
 * candidate is also dropped by the rollup, a task record is also dropped for
 * having no conversation), so a row-level assertion alone would stay green
 * with one layer removed. These therefore also spy on the real store's
 * `nonProseChunkIds`, `searchSemantic` and `searchLexicalPerCorpus`.
 *
 * Relevance is set exactly. The query vector is [1, 0] and a chunk is embedded
 * at [c, sqrt(1 - c^2)], so its L2 distance is sqrt(2 (1 - c)) and
 * `relevanceOf` (cosine = 1 - d^2 / 2, no noise floor) gives back c.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { markVecCapable } from '../../src/main/retrieval/vec-support';
import { chunkTranscript } from '../../src/main/retrieval/conversation/transcript-chunker';
import type { ChunkInput } from '../../src/main/retrieval/types';
import type { TranscriptEntry } from '../../src/shared/types';
import { openTestDatabase } from './helpers/test-database';

// The module's database helper is never reached (`getDb` is passed), but
// importing it loads the database module, which needs Electron.
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import {
  PRIOR_WORK_BACKGROUND_RANK,
  PRIOR_WORK_FLOOR,
  PRIOR_WORK_MARGIN,
  PRIOR_WORK_ROWS,
  searchRelatedWork,
  type RelatedWork,
  type RelatedWorkNode,
  type SearchRelatedWorkInput,
} from '../../src/main/retrieval/related-work';

const MODEL_TAG = 'test@2';
const DIMENSIONS = 2;
const CURRENT_TASK = 'task-current';
/** The task is created here: only turns from before it count. */
const CREATED_MS = Date.parse('2026-10-20T12:00:00.000Z');
const EARLIER = CREATED_MS - 86_400_000;
const LATER = CREATED_MS + 86_400_000;

const openDatabases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
});

/** The relevance a prior work row needs when the 100th best other chunk sits at `background`. */
function floorFor(background: number): number {
  return Math.max(PRIOR_WORK_FLOOR, background + PRIOR_WORK_MARGIN);
}

/** The background most tests use, high enough that the margin binds, not the absolute floor. */
const BACKGROUND = 0.5;
const FLOOR = floorFor(BACKGROUND);

// --- chunk text, as the indexer writes it -----------------------------------

function transcriptText(entries: TranscriptEntry[]): string {
  const chunks = chunkTranscript(entries);
  if (chunks.length !== 1) throw new Error(`expected one chunk, got ${chunks.length}`);
  return chunks[0].text;
}

/** A user turn and the agent's answer: `User: ...` then `Assistant: ...`. */
function proseText(topic: string): string {
  return transcriptText([
    { kind: 'user', uuid: `user-${topic}`, ts: 1, text: `Can we look at ${topic} again?` },
    { kind: 'assistant', uuid: `assistant-${topic}`, ts: 2, blocks: [{ type: 'text', text: `Yes, ${topic} needs a closer look before we change it.` }] },
  ]);
}

/** A tool call and its result: `Tool: Read ...` then `Tool result: ...`. */
function toolText(topic: string): string {
  return transcriptText([
    { kind: 'assistant', uuid: `call-${topic}`, ts: 1, blocks: [{ type: 'tool_use', id: `tool-${topic}`, name: 'Read', input: { file_path: `src/${topic}.ts` } }] },
    { kind: 'tool_result', uuid: `result-${topic}`, ts: 2, toolUseId: `tool-${topic}`, content: `export const ${topic} = 1;` },
  ]);
}

const PROSE = proseText('widget');
const TOOL = toolText('widget');

// --- a real index ------------------------------------------------------------

interface ChunkSpec {
  text: string;
  /** Cosine to the query vector, or null for a chunk that is not embedded. */
  cosine: number | null;
  tsStart: number | null;
}

interface DocumentSpec {
  corpus?: string;
  docId: string;
  taskId: string | null;
  chunks: ChunkSpec[];
}

const prose = (cosine: number, tsStart: number | null = EARLIER): ChunkSpec => ({ text: PROSE, cosine, tsStart });
const tool = (cosine: number, tsStart: number | null = EARLIER): ChunkSpec => ({ text: TOOL, cosine, tsStart });

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function vectorAt(cosine: number): Float32Array {
  return new Float32Array([cosine, Math.sqrt(1 - cosine * cosine)]);
}

/** `count` earlier prose chunks of one task nobody asks about, all at `cosine`. */
function fillers(cosine: number, count: number = PRIOR_WORK_BACKGROUND_RANK): DocumentSpec {
  return { docId: 'filler-doc', taskId: 'task-filler', chunks: Array.from({ length: count }, () => prose(cosine)) };
}

/** A real project database holding `documents`, chunks embedded at their cosines. */
function buildIndex(documents: DocumentSpec[]): { database: Database.Database; chunkIds: Map<string, number[]> } {
  const database = openTestDatabase(':memory:', { vec: true });
  openDatabases.push(database);
  markVecCapable(database);
  runProjectMigrations(database);
  const store = new RetrievalStore(database);
  store.ensureVecTable(DIMENSIONS);
  const chunkIds = new Map<string, number[]>();
  const embeddings: Array<{ chunkId: number; vector: Float32Array; contentHash: string }> = [];
  for (const document of documents) {
    const inputs: ChunkInput[] = document.chunks.map((chunk, seq) => ({
      seq,
      text: chunk.text,
      contentHash: sha1(`${document.docId}:${seq}:${chunk.text}`),
      tokenEstimate: 20,
      role: 'user',
      tsStart: chunk.tsStart,
      tsEnd: chunk.tsStart,
      turnUuidStart: `turn-${document.docId}-${seq}`,
      turnUuidEnd: `turn-${document.docId}-${seq}`,
    }));
    const { insertedIds } = store.upsertDocument({
      corpus: document.corpus ?? 'conversation',
      docId: document.docId,
      sessionId: `session-${document.docId}`,
      taskId: document.taskId,
      agentSessionId: null,
      metaJson: null,
    }, inputs);
    chunkIds.set(document.docId, insertedIds);
    insertedIds.forEach((chunkId, index) => {
      const cosine = document.chunks[index].cosine;
      if (cosine !== null) embeddings.push({ chunkId, vector: vectorAt(cosine), contentHash: inputs[index].contentHash });
    });
  }
  store.writeEmbeddings(embeddings, MODEL_TAG);
  return { database, chunkIds };
}

function conversationNode(docId: string, taskId: string, displayId: number): RelatedWorkNode {
  return { docKey: `conversation::${docId}`, taskId, displayId, title: `Title ${docId}` };
}

const embedder = { embed: vi.fn(async () => null), dimensions: DIMENSIONS, modelTag: MODEL_TAG, noiseFloor: 0 };

/** Prior work for the current task by default; pass `priorWork: undefined` for the ordinary path. */
function search(
  database: Database.Database,
  nodes: RelatedWorkNode[],
  overrides: Partial<SearchRelatedWorkInput> = {},
): Promise<RelatedWork> {
  return searchRelatedWork({
    question: 'earlier work on the widget',
    // No document says this, so the keyword side finds nothing unless a test wants it to.
    keywordText: 'nomatchzzz',
    projectId: 'project-1',
    nodes,
    embedder,
    queryVectors: [new Float32Array([1, 0])],
    getDb: () => database,
    priorWork: { before: CREATED_MS, taskId: CURRENT_TASK },
    ...overrides,
  });
}

const keysOf = (rows: ReadonlyArray<{ key: string }>): string[] => rows.map((row) => row.key);

describe('the chunk text these tests index', () => {
  // The format `transcript-chunker.ts` `renderEntry` writes: the labels the
  // prose test reads. If the chunker's output changes, the fixtures stop
  // standing for what the indexer stores and this fails first.
  it('opens a prose chunk on a User turn and a tool chunk on a Tool call', () => {
    expect(PROSE).toMatch(/^User: .*\nAssistant: /s);
    expect(TOOL).toMatch(/^Tool: Read .*\nTool result: /s);
  });
});

describe('searchRelatedWork with priorWork, over a real index', () => {
  describe('which chunks count', () => {
    // Red-green, each by the one condition in `searchRelatedWork`'s candidate
    // filter: drop `startsBefore` and the later, at-cutoff and untimed chunks are
    // read; drop `nodesByDocKey.has` and the chunk of a task outside the scope is
    // read; drop `>= floor` and the chunk under the floor is read. Drop the
    // `nonProse` exclusion and the tool chunk wins its task a row.
    it('reads only earlier, in-scope chunks at the floor for prose, and shows the prose one', async () => {
      const { database, chunkIds } = buildIndex([
        fillers(BACKGROUND),
        // The row: an earlier prose chunk at the floor, and a far closer one from after the task.
        { docId: 'prose-doc', taskId: 'task-prose', chunks: [prose(FLOOR + 0.1), prose(0.95, LATER)] },
        // Exactly at the cutoff, and with no time: neither is before it.
        { docId: 'edge-doc', taskId: 'task-edge', chunks: [prose(FLOOR + 0.1, CREATED_MS), prose(FLOOR + 0.1, null)] },
        { docId: 'tool-doc', taskId: 'task-tool', chunks: [tool(FLOOR + 0.1)] },
        { docId: 'under-doc', taskId: 'task-under', chunks: [prose(FLOOR - 0.05)] },
        { docId: 'later-doc', taskId: 'task-later', chunks: [prose(FLOOR + 0.1, LATER)] },
        // A task the caller left out of the scope.
        { docId: 'unscoped-doc', taskId: 'task-unscoped', chunks: [prose(FLOOR + 0.1)] },
      ]);
      const nonProseSpy = vi.spyOn(RetrievalStore.prototype, 'nonProseChunkIds');

      const work = await search(database, [
        conversationNode('prose-doc', 'task-prose', 1),
        conversationNode('edge-doc', 'task-edge', 2),
        conversationNode('tool-doc', 'task-tool', 3),
        conversationNode('under-doc', 'task-under', 4),
        conversationNode('later-doc', 'task-later', 5),
      ]);

      // Read once, and only the two chunks that are earlier, in scope and at the floor.
      expect(nonProseSpy).toHaveBeenCalledTimes(1);
      expect(new Set(nonProseSpy.mock.calls[0][0])).toEqual(new Set([chunkIds.get('prose-doc')![0], chunkIds.get('tool-doc')![0]]));

      // One row, on its earlier chunk: the later 0.95 chunk of the same task never counted.
      expect(keysOf(work.ranked)).toEqual(['task-prose']);
      expect(keysOf(work.handed)).toEqual(['task-prose']);
      expect(work.handed[0].relevance).toBeCloseTo(FLOOR + 0.1, 3);
      expect(work.handed[0].bestChunkId).toBe(chunkIds.get('prose-doc')![0]);
      expect(work.handed[0].matches).toBe(1);
      expect(work.handed[0].sessionId).toBe('session-prose-doc');
    });

    it('does not let a chunk of tool calls and results win a row, whatever its relevance', async () => {
      const { database, chunkIds } = buildIndex([
        fillers(BACKGROUND),
        // A task with both: the tool chunk is the closest match, the prose chunk the one that counts.
        { docId: 'mixed-doc', taskId: 'task-mixed', chunks: [tool(0.9), prose(FLOOR + 0.05)] },
        // A task with nothing but tool output at the top of the pool.
        { docId: 'tool-only-doc', taskId: 'task-tool-only', chunks: [tool(0.9)] },
      ]);
      const nonProseSpy = vi.spyOn(RetrievalStore.prototype, 'nonProseChunkIds');

      const work = await search(database, [
        conversationNode('mixed-doc', 'task-mixed', 1),
        conversationNode('tool-only-doc', 'task-tool-only', 2),
      ]);

      // All three are earlier, in scope and above the floor, so all three were classified.
      expect(new Set(nonProseSpy.mock.calls[0][0])).toEqual(new Set([
        ...chunkIds.get('mixed-doc')!, ...chunkIds.get('tool-only-doc')!,
      ]));
      expect(keysOf(work.ranked)).toEqual(['task-mixed']);
      expect(keysOf(work.handed)).toEqual(['task-mixed']);
      expect(work.handed[0].relevance).toBeCloseTo(FLOOR + 0.05, 3);
      expect(work.handed[0].bestChunkId).toBe(chunkIds.get('mixed-doc')![1]);
      expect(work.passages.get(work.handed[0].bestChunkId!)).toMatch(/^User: /);
    });

    // Red-green: drop `(relevanceByChunk.get(chunkId) ?? 0) >= floor` from the
    // candidates and this chunk, which only the keyword search found, is
    // counted.
    it('counts nothing a keyword matched alone, though the chunk is earlier prose', async () => {
      const keywordChunk: ChunkSpec = {
        text: transcriptText([
          { kind: 'user', uuid: 'user-zebra', ts: 1, text: 'zebracrossing needs a closer look' },
          { kind: 'assistant', uuid: 'assistant-zebra', ts: 2, blocks: [{ type: 'text', text: 'Yes, zebracrossing needs work.' }] },
        ]),
        // Under the relevance cutoff: the semantic search does not rank it at all.
        cosine: 0.1,
        tsStart: EARLIER,
      };
      const { database } = buildIndex([
        fillers(BACKGROUND),
        { docId: 'keyword-doc', taskId: 'task-keyword', chunks: [keywordChunk] },
      ]);
      const nodes = [conversationNode('keyword-doc', 'task-keyword', 1)];

      // The control: without prior work the keyword match is a row of its own.
      const ordinary = await search(database, nodes, { keywordText: 'zebracrossing', priorWork: undefined });
      expect(keysOf(ordinary.ranked)).toEqual(['task-keyword']);

      const work = await search(database, nodes, { keywordText: 'zebracrossing' });
      expect(work.ranked).toEqual([]);
      expect(work.handed).toEqual([]);
    });
  });

  describe('the floor', () => {
    // The floor is `max(PRIOR_WORK_FLOOR, background + PRIOR_WORK_MARGIN)`. The
    // 100 other chunks sit at the background, so a chunk 0.015 under the floor
    // is not read and one 0.015 over it is, and shows.
    //
    // Red-green: `background + PRIOR_WORK_MARGIN` alone fails the 0.25 case (the
    // chunk under PRIOR_WORK_FLOOR is read); `PRIOR_WORK_FLOOR` alone fails the
    // 0.45 and 0.55 cases (the chunk under the margin is read).
    it.each([
      { background: 0.25, binds: 'the absolute floor' },
      { background: 0.45, binds: 'the margin' },
      { background: 0.55, binds: 'the margin' },
    ])('is $binds when the 100th best other chunk is at $background', async ({ background, binds }) => {
      const floor = floorFor(background);
      if (binds === 'the margin') expect(floor).toBeGreaterThan(PRIOR_WORK_FLOOR);
      else expect(floor).toBe(PRIOR_WORK_FLOOR);

      const { database, chunkIds } = buildIndex([
        fillers(background),
        { docId: 'over-doc', taskId: 'task-over', chunks: [prose(floor + 0.015)] },
        { docId: 'under-doc', taskId: 'task-under', chunks: [prose(floor - 0.015)] },
      ]);
      const nonProseSpy = vi.spyOn(RetrievalStore.prototype, 'nonProseChunkIds');

      const work = await search(database, [conversationNode('over-doc', 'task-over', 1), conversationNode('under-doc', 'task-under', 2)]);

      expect(new Set(nonProseSpy.mock.calls[0][0])).toEqual(new Set(chunkIds.get('over-doc')));
      expect(keysOf(work.handed)).toEqual(['task-over']);
      expect(keysOf(work.ranked)).toEqual(['task-over']);
    });
  });

  describe('the background', () => {
    // Red-green: count only the chunks that can show (earlier, in scope, prose)
    // in `priorWorkBackground`'s pool and the 100 chunks below stop being 100.
    it('is the 100th best chunk of other tasks across the whole pool, later and tool output included', async () => {
      // Exactly 100 chunks of other tasks, 99 of them at the background:
      // later ones in scope, tool output in scope, and chunks of a task the
      // caller left out of the scope. Take any group away and there are fewer.
      const { database } = buildIndex([
        { docId: 'target-doc', taskId: 'task-target', chunks: [prose(0.8)] },
        { docId: 'later-doc', taskId: 'task-later', chunks: Array.from({ length: 33 }, () => prose(BACKGROUND, LATER)) },
        { docId: 'tool-doc', taskId: 'task-tool', chunks: Array.from({ length: 33 }, () => tool(BACKGROUND)) },
        { docId: 'unscoped-doc', taskId: 'task-unscoped', chunks: Array.from({ length: 33 }, () => prose(BACKGROUND)) },
      ]);

      const work = await search(database, [
        conversationNode('target-doc', 'task-target', 1),
        conversationNode('later-doc', 'task-later', 2),
        conversationNode('tool-doc', 'task-tool', 3),
      ]);

      expect(keysOf(work.handed)).toEqual(['task-target']);
    });

    // Red-green: drop the `taskId` filter in `priorWorkBackground` and the five
    // current-task chunks make it 104, so the 100th exists and the target shows.
    it('leaves out the current task\'s own chunks, and with fewer than 100 others there is no background', async () => {
      // 98 fillers and the target are 99 chunks of other tasks. The task's own
      // five, which match its text best, would make 104 if they counted.
      const { database } = buildIndex([
        fillers(BACKGROUND, PRIOR_WORK_BACKGROUND_RANK - 2),
        { docId: 'target-doc', taskId: 'task-target', chunks: [prose(0.8)] },
        { docId: 'own-doc', taskId: CURRENT_TASK, chunks: Array.from({ length: 5 }, () => prose(0.95, LATER)) },
      ]);
      const nonProseSpy = vi.spyOn(RetrievalStore.prototype, 'nonProseChunkIds');

      const work = await search(database, [conversationNode('target-doc', 'task-target', 1)]);

      expect(work.handed).toEqual([]);
      // Nothing is a candidate without a floor, so nothing is read, and nothing ranks.
      expect(nonProseSpy).not.toHaveBeenCalled();
      expect(work.ranked).toEqual([]);
    });

    it('shows the same target once a 100th chunk of another task exists', async () => {
      // The control for the case above: one more filler, and the target shows.
      const { database } = buildIndex([
        fillers(BACKGROUND, PRIOR_WORK_BACKGROUND_RANK - 1),
        { docId: 'target-doc', taskId: 'task-target', chunks: [prose(0.8)] },
        { docId: 'own-doc', taskId: CURRENT_TASK, chunks: Array.from({ length: 5 }, () => prose(0.95, LATER)) },
      ]);

      const work = await search(database, [conversationNode('target-doc', 'task-target', 1)]);

      expect(keysOf(work.handed)).toEqual(['task-target']);
    });
  });

  describe('the rows', () => {
    // Seven tasks reach the floor. `task-many` has fifteen matching chunks, so
    // the rollup ranks it first on score, though `task-single`'s one chunk is
    // closer. Prior work orders by relevance and stops at PRIOR_WORK_ROWS.
    //
    // Red-green: choose `handed` with `selectHandedTasks` for prior work as
    // well and all seven come back, `task-many` first.
    it('shows the best passage first, at most PRIOR_WORK_ROWS', async () => {
      const offsets: Array<[taskId: string, offset: number, chunkCount: number]> = [
        ['task-single', 0.12, 1],
        ['task-many', 0.08, 15],
        ['task-third', 0.07, 1],
        ['task-fourth', 0.06, 1],
        ['task-fifth', 0.05, 1],
        ['task-sixth', 0.04, 1],
        ['task-seventh', 0.03, 1],
      ];
      const { database } = buildIndex([
        fillers(BACKGROUND),
        ...offsets.map(([taskId, offset, chunkCount]): DocumentSpec => ({
          docId: `${taskId}-doc`,
          taskId,
          chunks: Array.from({ length: chunkCount }, () => prose(FLOOR + offset)),
        })),
      ]);

      const work = await search(database, offsets.map(([taskId], index) => conversationNode(`${taskId}-doc`, taskId, index + 1)));

      // The fixture discriminates only if the rollup's own order differs.
      expect(work.ranked).toHaveLength(7);
      expect(work.ranked[0].key).toBe('task-many');
      expect(PRIOR_WORK_ROWS).toBeLessThan(7);
      expect(keysOf(work.handed)).toEqual(['task-single', 'task-many', 'task-third', 'task-fourth', 'task-fifth']);
      expect(work.handed[0].sessionId).toBe('session-task-single-doc');
    });
  });

  describe('the corpora searched', () => {
    /** One project with an earlier conversation, a task record and a commit that all say "recordword". */
    function recordWorld() {
      return buildIndex([
        fillers(BACKGROUND),
        { docId: 'conversation-doc', taskId: 'task-conversation', chunks: [prose(FLOOR + 0.1)] },
        // The task's own record, closer than any conversation, and a commit it wrote.
        {
          corpus: 'task',
          docId: 'task-record',
          taskId: 'task-record',
          chunks: [{ text: 'Title: recordword task\nrecordword description', cosine: 0.9, tsStart: EARLIER }],
        },
        {
          corpus: 'commit',
          docId: 'abc123def456',
          taskId: 'task-record',
          chunks: [{ text: 'recordword commit message', cosine: null, tsStart: EARLIER }],
        },
      ]);
    }
    const recordOnlyTasks = [{ taskId: 'task-record', displayId: 7, title: 'Record task' }];
    const nodes = [conversationNode('conversation-doc', 'task-conversation', 1)];

    // Red-green: `const sideCorpora = priorWork ? [] : SIDE_CORPORA` as plain
    // `SIDE_CORPORA` and the task corpus is searched by meaning and both side
    // corpora by keyword. The row assertions stay green with that change, since
    // a record chunk is also left out of the rollup, so the spies are what pin it.
    it('searches neither the task records nor the commits, by meaning or by keyword', async () => {
      const { database } = recordWorld();
      const semanticSpy = vi.spyOn(RetrievalStore.prototype, 'searchSemantic');
      const lexicalSpy = vi.spyOn(RetrievalStore.prototype, 'searchLexical');
      const perCorpusSpy = vi.spyOn(RetrievalStore.prototype, 'searchLexicalPerCorpus');

      const work = await search(database, nodes, { keywordText: 'recordword', recordOnlyTasks });

      // One query vector, one conversation search; the keyword search ran, on conversations only.
      expect(semanticSpy.mock.calls.map((call) => call[2])).toEqual([['conversation']]);
      expect(lexicalSpy.mock.calls.map((call) => call[2])).toEqual([['conversation']]);
      expect(perCorpusSpy).not.toHaveBeenCalled();
      // A match only in a task record is no row, though the task is reachable by record.
      expect(work.ranked.map((task) => task.taskId)).not.toContain('task-record');
      expect(keysOf(work.handed)).toEqual(['task-conversation']);
    });

    it('searches both without prior work, and the task record makes a row', async () => {
      const { database } = recordWorld();
      const semanticSpy = vi.spyOn(RetrievalStore.prototype, 'searchSemantic');
      const perCorpusSpy = vi.spyOn(RetrievalStore.prototype, 'searchLexicalPerCorpus');

      const work = await search(database, nodes, { keywordText: 'recordword', recordOnlyTasks, priorWork: undefined });

      expect(semanticSpy.mock.calls.map((call) => call[2])).toEqual([['conversation'], ['task']]);
      expect(perCorpusSpy).toHaveBeenCalledTimes(1);
      expect([...(perCorpusSpy.mock.calls[0][1].keys())].sort()).toEqual(['commit', 'task']);
      expect(work.ranked.map((task) => task.taskId)).toContain('task-record');
    });
  });

  describe('without priorWork', () => {
    // The ordinary path is untouched: every chunk counts whenever it happened and
    // whatever it holds, the handed set is the relative floor clamped to
    // MIN_HANDED, and no chunk is read for prose.
    it('counts later chunks, tool output and chunks under the floor, and reads no chunk for prose', async () => {
      const { database } = buildIndex([
        fillers(BACKGROUND),
        { docId: 'prose-doc', taskId: 'task-prose', chunks: [prose(FLOOR + 0.1)] },
        { docId: 'tool-doc', taskId: 'task-tool', chunks: [tool(0.9)] },
        { docId: 'later-doc', taskId: 'task-later', chunks: [prose(0.9, LATER)] },
        { docId: 'under-doc', taskId: 'task-under', chunks: [prose(FLOOR - 0.05)] },
      ]);
      const nonProseSpy = vi.spyOn(RetrievalStore.prototype, 'nonProseChunkIds');
      const nodes = [
        conversationNode('prose-doc', 'task-prose', 1),
        conversationNode('tool-doc', 'task-tool', 2),
        conversationNode('later-doc', 'task-later', 3),
        conversationNode('under-doc', 'task-under', 4),
      ];

      const work = await search(database, nodes, { priorWork: undefined });

      expect(nonProseSpy).not.toHaveBeenCalled();
      expect([...keysOf(work.ranked)].sort()).toEqual(['task-later', 'task-prose', 'task-tool', 'task-under']);
      // Four tasks are well under MIN_HANDED, so all four are handed, strongest first.
      expect(keysOf(work.handed)).toEqual(keysOf(work.ranked));
      expect(work.handed).toHaveLength(4);
    });
  });
});
