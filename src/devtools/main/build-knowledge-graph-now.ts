/**
 * Build a preview project's Knowledge Graph projection IMMEDIATELY, at full speed.
 *
 * Why this exists. The shipped pass is deliberately duty-cycled: even a first
 * build only takes 45% of wall time, because a projection is the same class of
 * long scan plus vector math that produced felt hardware spikes when embedding
 * ran in lifecycle hooks (see `.claude/rules/central-embedding-engine.md`). On a
 * mirrored 37k-chunk corpus that is roughly a minute of work stretched over two,
 * and a seed click in a preview therefore lands on a "Building the map" spinner
 * rather than on the thing you clicked the button to look at.
 *
 * A preview is a throwaway instance whose entire purpose is looking at this
 * surface, so there is nothing there for the throttle to protect. Running the
 * pass here at `dutyCycle: 1` (the pacer's formula makes that exactly zero sleep)
 * moves the cost into the seed click, where the user is already waiting and can
 * see it, and leaves the map ready the moment the button returns.
 *
 * This changes NOTHING about shipped behaviour: it lives under
 * `src/devtools/`, which is build-excluded via `__KANGENTIC_DEV__`, and it drives
 * the REAL engine through the real store rather than reimplementing it. A seeder
 * that computed its own layout would validate the seeder instead of the code that
 * ships.
 */

import { getProjectDb } from '../../main/db/database';
import { RetrievalStore } from '../../main/retrieval/retrieval-store';
import {
  runProjectionPass,
  writeProjectionCache,
} from '../../main/retrieval/graph/projection-engine';
import { graphService } from '../../main/retrieval/graph/graph-service';

export interface BuildKnowledgeGraphNowResult {
  nodes: number;
  edges: number;
  elapsedMs: number;
}

/**
 * Run the projection pass to completion and cache it. Returns null when the
 * project has no usable index (no sqlite-vec, or nothing embedded yet), which is
 * a legitimate state for a fresh preview rather than an error.
 *
 * The embedding width and tag come from what is actually STORED, exactly as
 * `graph-service` resolves them - config can legitimately disagree with the vec
 * table between a model switch and the re-embed finishing, and a width mismatch
 * silently projects zero nodes.
 */
export async function buildKnowledgeGraphNow(projectId: string): Promise<BuildKnowledgeGraphNowResult | null> {
  const store = new RetrievalStore(getProjectDb(projectId));
  if (!store.hasVec) return null;

  const embedding = store.storedEmbeddingSignature();
  if (!embedding) return null;

  const startedAt = Date.now();
  const result = await runProjectionPass({
    store,
    modelTag: embedding.modelTag,
    dimensions: embedding.dimensions,
    // Zero sleep: `computeProjectionSleepMs(ms, 1)` is `ms * (1/1 - 1)`.
    dutyCycle: 1,
  });
  if (!result) return null;

  writeProjectionCache(store, result.projection, result.sums);
  // Announce it, exactly as the paced pass does on completion. Writing the
  // cache silently left an OPEN Knowledge Graph showing the pre-seed state - zero
  // conversations over a freshly mirrored index - until it was closed and
  // reopened, which reads as the seed having failed.
  graphService.notifyChanged(projectId);
  return {
    nodes: result.projection.nodes.length,
    edges: result.projection.edges.length,
    elapsedMs: Date.now() - startedAt,
  };
}
