/**
 * `RetrievalStore.getChunkPlacements` reads ids in batches of 500 (PLACEMENT_BATCH),
 * so a deep related-work pool stays under SQLite's bound-parameter limit. This runs
 * the REAL store over a real database and checks every id comes back across the
 * batch boundaries, each with its own placement.
 *
 * Red-green: shorten the slice to `ids.slice(start, start + PLACEMENT_BATCH - 1)`
 * and the ids at positions 499, 999 and 1199 are never read; stop after the first
 * batch and every id past 499 is missing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import type { ChunkInput } from '../../src/main/retrieval/types';
import { openTestDatabase } from './helpers/test-database';

const openDatabases: Database.Database[] = [];
afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const TOTAL = 1201;
const TASK_ID = 'task-batch';
const DOC_ID = 'doc-batch';

function storeWithChunks(count: number): { store: RetrievalStore; ids: number[] } {
  const database = openTestDatabase(':memory:');
  openDatabases.push(database);
  runProjectMigrations(database);
  const store = new RetrievalStore(database);
  const chunks: ChunkInput[] = Array.from({ length: count }, (_unused, seq) => ({
    seq,
    text: `chunk number ${seq}`,
    contentHash: `hash-${seq}`,
    tokenEstimate: 5,
    role: 'user',
    tsStart: 1_000 + seq,
    tsEnd: 1_000 + seq,
    turnUuidStart: `turn-${seq}`,
    turnUuidEnd: `turn-${seq}`,
  }));
  const { insertedIds } = store.upsertDocument({
    corpus: 'conversation',
    docId: DOC_ID,
    sessionId: 'session-batch',
    taskId: TASK_ID,
    agentSessionId: null,
    metaJson: null,
  }, chunks);
  return { store, ids: insertedIds };
}

describe('RetrievalStore.getChunkPlacements (real database)', () => {
  it('reads every batch of 500 ids, including the first and last id of each', () => {
    // 1,201 ids are three batches: positions 0 to 499, 500 to 999 and 1000 to 1200.
    const { store, ids } = storeWithChunks(TOTAL);
    expect(ids).toHaveLength(TOTAL);

    const placements = store.getChunkPlacements(ids);

    expect(placements).toHaveLength(TOTAL);
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    expect(byId.size).toBe(TOTAL);
    for (const position of [0, 499, 500, 501, 999, 1000, 1199, 1200]) {
      const placement = byId.get(ids[position]);
      expect(placement, `position ${position}`).toBeDefined();
      expect(placement).toEqual({
        id: ids[position],
        corpus: 'conversation',
        docId: DOC_ID,
        sessionId: 'session-batch',
        taskId: TASK_ID,
        tsStart: 1_000 + position,
        turnUuidStart: `turn-${position}`,
      });
    }
  });

  it('returns nothing for no ids, and skips an id that has no chunk', () => {
    const { store, ids } = storeWithChunks(3);

    expect(store.getChunkPlacements([])).toEqual([]);
    expect(store.getChunkPlacements([ids[1], 999_999]).map((placement) => placement.id)).toEqual([ids[1]]);
  });
});
