/**
 * Dev-only: seed a fully-embedded, cluster-structured conversation corpus so
 * the Knowledge Graph surface has something real to render in an ephemeral
 * `/preview`.
 *
 * Why this exists rather than reusing "Seed Embedding Backlog": that seeder
 * writes chunks and lets the REAL engine embed them, which is the right shape
 * for soak-testing the drain loop but useless here. A preview project starts
 * with zero indexed conversations, and embedding several hundred synthetic
 * documents through real ONNX inference would take many minutes before the
 * graph showed anything at all. This writes vectors DIRECTLY through
 * `RetrievalStore.writeEmbeddings`, so the surface is populated the instant the
 * button is clicked.
 *
 * The vectors are not noise. Documents are assigned to PLANTED topic clusters,
 * and each document's embedding is its cluster centroid plus bounded noise. That
 * gives the preview a known ground truth: the layout is supposed to recover
 * those clusters, so "does the map mean anything" becomes something you can
 * check by eye instead of guess at. The same planting is what
 * `tests/unit/knowledge-graph-layout.test.ts` asserts against.
 *
 * Provenance is seeded too (real tasks, real session rows, real `task_id` on
 * every chunk), because `sessions.task_id` is the graph's structural skeleton -
 * a corpus without it would exercise the semantic layer and none of the edges.
 *
 * Build-excluded from production: imported only behind `__KANGENTIC_DEV__`
 * guards (src/main/index.ts), so esbuild dead-code elimination drops this
 * module from prod bundles. See `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import crypto from 'node:crypto';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../../main/db/database';
import { RetrievalStore } from '../../main/retrieval/retrieval-store';
import { TaskRepository } from '../../main/db/repositories/task-repository';
import { SessionRepository } from '../../main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../main/db/repositories/swimlane-repository';
import { resolveEmbeddingModel } from '../../shared/embedding-models';
import {
  CLUSTER_NOISE,
  CHUNK_NOISE,
  buildClusterCentroids,
  createSeededRandom,
  jitterUnitVector,
} from './seed-knowledge-graph-vectors';
import type { ChunkInput } from '../../main/retrieval/types';
import type { DevSeedKnowledgeGraphResult } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';
import { buildKnowledgeGraphNow } from './build-knowledge-graph-now';

/** The real corpus name on purpose. The Knowledge Graph reads
 *  `memory_chunks.corpus` as its node-kind discriminator, so seeding under a
 *  'dev-seed' corpus would exercise a code path the product never takes. The
 *  '[DEV SEED]' task titles are what make these rows identifiable. */
const CORPUS = 'conversation';

/** Topic vocabularies, one per planted cluster. Chunk text is drawn from its
 *  document's cluster so LEXICAL search finds the same grouping the semantic
 *  layer does, which is what the query overlay needs in order to be testable. */
const CLUSTER_TOPICS: ReadonlyArray<{ label: string; words: string[] }> = [
  { label: 'terminal', words: ['terminal', 'pty', 'shell', 'xterm', 'scrollback', 'resize', 'conpty', 'session'] },
  { label: 'database', words: ['sqlite', 'migration', 'schema', 'repository', 'query', 'index', 'transaction', 'column'] },
  { label: 'renderer', words: ['react', 'zustand', 'render', 'component', 'hook', 'store', 'layout', 'overlay'] },
  { label: 'agent', words: ['agent', 'adapter', 'spawn', 'claude', 'prompt', 'permission', 'model', 'cli'] },
  { label: 'git', words: ['git', 'worktree', 'branch', 'commit', 'rebase', 'diff', 'merge', 'remote'] },
  { label: 'packaging', words: ['electron', 'builder', 'installer', 'notarize', 'sign', 'bundle', 'asar', 'release'] },
];

const DEFAULT_DOCUMENT_COUNT = 240;
const DEFAULT_CHUNKS_PER_DOCUMENT = 12;
const SESSIONS_PER_TASK = 3;

/**
 * Marker written to every seeded document's `meta_json`.
 *
 * These rows live under the REAL 'conversation' corpus on purpose (the graph
 * reads `memory_chunks.corpus` as its node-kind discriminator, so a 'dev-seed'
 * corpus would exercise a path the product never takes). The cost of that
 * choice is that seeded rows are otherwise indistinguishable from real history,
 * which is exactly the escape hatch `seed-embedding-backlog.ts` kept by using a
 * distinct corpus. This marker restores it: seeded documents stay filterable
 * and purgeable without changing the corpus they are indexed under.
 */
const DEV_SEED_MARKER = { devSeed: 'knowledge-graph' } as const;

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function makeChunkText(clusterIndex: number, documentIndex: number, seq: number, random: () => number): string {
  const topic = CLUSTER_TOPICS[clusterIndex % CLUSTER_TOPICS.length];
  const words: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    words.push(topic.words[Math.floor(random() * topic.words.length)]);
  }
  return `[DEV SEED] ${topic.label} conversation ${documentIndex}, chunk ${seq}. ${words.join(' ')}`;
}

export interface SeedKnowledgeGraphOptions {
  documentCount?: number;
  chunksPerDocument?: number;
}

/**
 * Seed `documentCount` fully-embedded synthetic conversations, spread across
 * `CLUSTER_TOPICS.length` planted clusters and hung off real tasks and
 * sessions. Throws when no project is open.
 */
export function seedKnowledgeGraph(
  context: IpcContext,
  options: SeedKnowledgeGraphOptions = {},
): DevSeedKnowledgeGraphResult {
  const projectId = context.currentProjectId;
  const projectPath = context.currentProjectPath;
  if (!projectId || !projectPath) throw new Error('Open a project first to seed the knowledge graph');

  const documentCount = options.documentCount ?? DEFAULT_DOCUMENT_COUNT;
  const chunksPerDocument = options.chunksPerDocument ?? DEFAULT_CHUNKS_PER_DOCUMENT;

  const model = resolveEmbeddingModel(context.configManager.load().knowledgeGraph?.localModel);
  const db = getProjectDb(projectId);
  const store = new RetrievalStore(db);

  // The vec table is normally created by the embedding path (it alone knows the
  // model's width). Nothing has embedded yet in a fresh preview, so create it
  // here at the SELECTED model's dimension - never a hardcoded width.
  store.ensureVecTable(model.dimensions);
  if (!store.hasVec) {
    throw new Error('sqlite-vec is unavailable, so embeddings cannot be seeded (lexical-only build)');
  }
  store.setMeta('vec_dims', String(model.dimensions));

  const todoSwimlane = new SwimlaneRepository(db).list().find((lane) => lane.role === 'todo');
  if (!todoSwimlane) throw new Error('No To Do column to seed knowledge-graph tasks into');

  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);
  const random = createSeededRandom(0x9e3779b9);

  const clusterCount = CLUSTER_TOPICS.length;
  const centroids = buildClusterCentroids(clusterCount, model.dimensions, random);

  const taskCount = Math.max(1, Math.ceil(documentCount / SESSIONS_PER_TASK));
  const taskIds: string[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const topic = CLUSTER_TOPICS[index % clusterCount];
    const task = taskRepo.create({
      title: `[DEV SEED] ${topic.label} work ${index + 1}`,
      description: 'Throwaway task backing seeded Knowledge Graph conversations. Created by the '
        + 'Test Harness "Seed Knowledge Graph" button.',
      swimlane_id: todoSwimlane.id,
      labels: [topic.label, index % 2 === 0 ? 'backend' : 'frontend'],
    });
    taskIds.push(task.id);
  }

  const now = new Date().toISOString();
  let embeddedChunks = 0;

  for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
    // A document's topic comes from its TASK, not from its own index. Keying
    // the two separately made a task titled "terminal work" host conversations
    // about the database, so a search for "terminal" surfaced cards labelled
    // "renderer work" - the hits were right and the preview looked broken.
    // Real tasks have topically coherent conversations; this matches that.
    const taskIndex = Math.floor(documentIndex / SESSIONS_PER_TASK) % taskIds.length;
    const clusterIndex = taskIndex % clusterCount;
    const taskId = taskIds[taskIndex];
    const sessionId = crypto.randomUUID();
    const agentSessionId = crypto.randomUUID();

    sessionRepo.insert({
      id: sessionId,
      task_id: taskId,
      session_type: 'claude_agent',
      isolated_swimlane_id: null,
      agent_session_id: agentSessionId,
      command: '',
      cwd: projectPath,
      permission_mode: null,
      prompt: null,
      status: 'exited',
      exit_code: 0,
      started_at: now,
      suspended_at: now,
      exited_at: now,
      suspended_by: null,
    });

    const documentVector = jitterUnitVector(centroids[clusterIndex], CLUSTER_NOISE, random);
    const chunks: ChunkInput[] = [];
    for (let seq = 0; seq < chunksPerDocument; seq += 1) {
      const text = makeChunkText(clusterIndex, documentIndex, seq, random);
      chunks.push({
        seq,
        text,
        contentHash: sha1(text),
        tokenEstimate: Math.ceil(text.length / 4),
        role: seq % 2 === 0 ? 'user' : 'assistant',
        tsStart: null,
        tsEnd: null,
        turnUuidStart: null,
        turnUuidEnd: null,
      });
    }

    // Same write path real conversation indexing uses, so the seeded rows are
    // indistinguishable from real ones downstream.
    // docId is the AGENT session id, matching the real conversation indexer.
    // Verified against the live corpus: joining `memory_chunks.doc_id` to
    // `sessions.id` matches 0 rows, to `sessions.agent_session_id` matches all
    // of them. Seeding under the Kangentic session id instead would leave the
    // preview exercising a doc-to-session join shape production never takes.
    store.upsertDocument(
      {
        corpus: CORPUS,
        docId: agentSessionId,
        sessionId,
        taskId,
        agentSessionId,
        metaJson: JSON.stringify({ ...DEV_SEED_MARKER, cluster: CLUSTER_TOPICS[clusterIndex].label }),
      },
      chunks,
    );

    // Read the rowids back and write vectors directly. This is the one step
    // that departs from the real pipeline, and it is the whole point: no ONNX
    // inference, so a populated graph is one click away instead of many
    // minutes.
    const stored = store.getChunksForDoc(CORPUS, agentSessionId);
    store.writeEmbeddings(
      stored.map((chunk) => ({
        chunkId: chunk.id,
        vector: jitterUnitVector(documentVector, CHUNK_NOISE, random),
        contentHash: chunk.contentHash,
      })),
      model.modelTag,
    );
    embeddedChunks += stored.length;

    store.setIndexState({
      corpus: CORPUS,
      docId: agentSessionId,
      sessionId,
      sourcePath: null,
      sourceMtimeMs: null,
      sourceSize: null,
      entryCount: chunksPerDocument,
      chunkCount: stored.length,
      status: 'ok',
      indexedAt: now,
    });
  }

  return {
    documents: documentCount,
    chunks: embeddedChunks,
    clusters: clusterCount,
    tasks: taskIds.length,
    dimensions: model.dimensions,
    modelTag: model.modelTag,
  };
}

let devIpcRegistered = false;

/** Register the dev-only IPC behind the TestHarness "Seed Knowledge Graph" button.
 *  Idempotent. */
export function registerSeedKnowledgeGraphDevIpc(getContext: () => IpcContext | null): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(
    IPC.DEV_SEED_KNOWLEDGE_GRAPH,
    async (_event, options: SeedKnowledgeGraphOptions): Promise<DevSeedKnowledgeGraphResult> => {
      const context = getContext();
      if (!context) throw new Error('IPC not initialized');
      const seeded = seedKnowledgeGraph(context, options ?? {});
      // Build the map before returning, so the click lands on the surface rather
      // than on a "Building the map" spinner. See `build-knowledge-graph-now.ts` for
      // why this is safe to run unthrottled here and nowhere else.
      if (context.currentProjectId) await buildKnowledgeGraphNow(context.currentProjectId);
      return seeded;
    },
  );
}
