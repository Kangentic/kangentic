/**
 * Dev-only: seed a realistic embedding backlog into the current project so
 * the central embedding engine's drain loop can be exercised under sustained
 * real-worker load without needing that many real agent turns.
 *
 * The engine only cares about `memory_chunks.embedded_model IS NULL` - it has
 * no notion of where a chunk came from. So this writes synthetic chunks
 * through the SAME `RetrievalStore.upsertDocument` path real conversation
 * indexing uses (a distinct 'dev-seed' corpus, clearly labeled text), then
 * flags the project dirty exactly the way `scheduleFinalizeIndex` /
 * `scheduleLiveIndex` / `startForProject` do. From there the real drain loop,
 * real EmbedClient, and real duty-cycle pacing take over - this seeds data,
 * it does not shortcut the embedding path itself.
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
import { embedEngine } from '../../main/retrieval/embedder/embed-engine';
import type { ChunkInput } from '../../main/retrieval/types';
import type { DevSeedEmbeddingBacklogResult } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';

/** Distinct from the real 'conversation' corpus so seeded rows are easy to
 *  identify (and, if ever needed, purge) without touching real history. */
const CORPUS = 'dev-seed';

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

// Module state; resets when the main process restarts. Each click uses a
// fresh index so re-clicks land a new, non-colliding synthetic document.
let seedRunIndex = 0;

function makeSyntheticChunks(count: number, runIndex: number): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  for (let seq = 0; seq < count; seq += 1) {
    const text =
      `[DEV SEED #${runIndex}] Synthetic embedding-backlog stress-test chunk ${seq + 1} of ${count}. ` +
      'Throwaway text from the Test Harness "Seed Embedding Backlog" button - exercises the ' +
      'background embedding engine\'s drain loop under a realistic backlog size, without needing ' +
      'that many real agent turns to produce it.';
    chunks.push({
      seq,
      text,
      contentHash: sha1(text),
      tokenEstimate: Math.ceil(text.length / 4),
      role: 'user',
      tsStart: null,
      tsEnd: null,
      turnUuidStart: null,
      turnUuidEnd: null,
    });
  }
  return chunks;
}

/** Seed `count` synthetic pending chunks into the current project and flag it
 *  dirty. Throws when no project is open. */
export function seedEmbeddingBacklog(context: IpcContext, count: number): DevSeedEmbeddingBacklogResult {
  const projectId = context.currentProjectId;
  if (!projectId) throw new Error('Open a project first to seed an embedding backlog');

  seedRunIndex += 1;
  const runIndex = seedRunIndex;
  const docId = `dev-seed-embedding-backlog-${runIndex}`;

  const db = getProjectDb(projectId);
  const store = new RetrievalStore(db);
  store.upsertDocument(
    { corpus: CORPUS, docId, sessionId: null, taskId: null, agentSessionId: null, metaJson: null },
    makeSyntheticChunks(count, runIndex),
  );

  // Flag the project dirty exactly the way a real chunk producer would - the
  // engine's own drain loop, real EmbedClient, and duty-cycle pacer do
  // everything else from here.
  embedEngine.markDirty(projectId);

  return { seeded: count, docId };
}

let devIpcRegistered = false;

/** Register the dev-only IPC behind the TestHarness "Seed Embedding Backlog"
 *  button. Idempotent. */
export function registerSeedEmbeddingBacklogDevIpc(getContext: () => IpcContext | null): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(IPC.DEV_SEED_EMBEDDING_BACKLOG, (_event, count: number): DevSeedEmbeddingBacklogResult => {
    const context = getContext();
    if (!context) throw new Error('IPC not initialized');
    return seedEmbeddingBacklog(context, count);
  });
}
