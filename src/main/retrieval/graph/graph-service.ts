/**
 * Orchestrates the Memory Graph's projection cache for the IPC layer.
 *
 * The division of labour matters and is enforced by
 * `.claude/rules/central-embedding-engine.md`'s sibling reasoning: an IPC
 * handler may only READ a cached projection and ASK for a refresh. It must
 * never run the pass inline, because a full projection is the same class of
 * work (a long scan plus vector math) that produced felt hardware spikes when
 * embedding ran in lifecycle hooks. `getSnapshot` is therefore always cheap,
 * and `markDirty` schedules the paced pass in the background.
 *
 * One pass runs at a time per project. A pass is deliberately NOT cancelled on
 * a project switch: it captures its model tag up front and records it in the
 * cache signature, so the worst case is that it finishes and writes a correct
 * cache for a project the user has navigated away from - which is work already
 * paid for and useful the moment they navigate back. The `signal` plumbing
 * exists for a caller that genuinely needs to stop one; nothing needs to today,
 * so no cancel API is exposed rather than leaving a method with no caller.
 */

import { getProjectDb } from '../../db/database';
import { RetrievalStore } from '../retrieval-store';
import { aggregateCoverage, type CoverageSummary } from './coverage-aggregate';
import type { MemoryGraphSnapshot } from '../../../shared/types';
import {
  runProjectionPass,
  readCachedProjection,
  writeProjectionCache,
  isProjectionFresh,
} from './projection-engine';

/**
 * The snapshot IS the IPC payload (`MemoryGraphSnapshot` in shared/types), one
 * definition rather than an internal shape plus a wire shape. Field meanings
 * are documented there; the notable ones are `stale` (a stale projection is
 * still SERVED, because a slightly old map beats a blank one) and
 * `semanticAvailable` (false when sqlite-vec is missing, so the UI can say the
 * semantic layer is off instead of implying an empty index).
 */
export type GraphSnapshot = MemoryGraphSnapshot;

/**
 * Duty cycle for a project's very first projection, where no cached map exists
 * to look at while it builds. Still well under half of wall time, so it stays a
 * background task rather than a spike of the kind
 * `.claude/rules/central-embedding-engine.md` exists to prevent.
 */
const FIRST_BUILD_DUTY_CYCLE = 0.45;

interface RunningPass {
  readonly signal: { aborted: boolean };
  readonly promise: Promise<void>;
}

export interface GraphServiceDeps {
  readonly getDb?: (projectId: string) => ReturnType<typeof getProjectDb>;
  readonly onChanged?: (projectId: string) => void;
}

export function createGraphService(deps: GraphServiceDeps = {}) {
  const getDb = deps.getDb ?? getProjectDb;
  const running = new Map<string, RunningPass>();
  // Settable rather than constructor-only: the singleton is created at import
  // time but the push target (the main window) only exists once IPC registers.
  let onChanged: ((projectId: string) => void) | undefined = deps.onChanged;

  function storeFor(projectId: string): RetrievalStore {
    return new RetrievalStore(getDb(projectId));
  }

  function buildCoverage(store: RetrievalStore, knownDocumentIds: string[]): CoverageSummary {
    return aggregateCoverage({
      indexState: store.listIndexState(),
      chunkTotals: store.documentChunkTotals(),
      knownDocumentIds,
    });
  }

  /**
   * Doc ids for the conversation corpus are the agent CLI's transcript ids, NOT
   * `sessions.id`. Verified against the live corpus: joining `doc_id` to
   * `sessions.id` matches zero rows, so passing session ids here would report
   * every document as un-indexed.
   */
  function knownDocumentIds(store: RetrievalStore): string[] {
    return store.knownConversationDocIds();
  }

  /**
   * The embedding width and tag the projection must use.
   *
   * Read from the DB, with the configured model only as a fallback for an
   * empty index. Trusting config instead is a real bug: the vec table is
   * fixed-width and rebuilt only by the embedding path, so config and storage
   * disagree between a model switch and the re-embed completing - and every
   * vector would be rejected as the wrong width, producing an empty map with
   * no error. (Found exactly this way: a 1024-dim corpus read under a
   * 768-dim config projected zero nodes.)
   */
  function resolveEmbedding(
    store: RetrievalStore,
    fallbackModelTag: string,
    fallbackDimensions: number,
  ): { dimensions: number; modelTag: string } {
    return store.storedEmbeddingSignature() ?? { dimensions: fallbackDimensions, modelTag: fallbackModelTag };
  }

  return {
    /** Register the push emitter. Idempotent; last writer wins, which is
     *  correct across a dev-mode IPC re-registration. */
    setOnChanged(listener: (projectId: string) => void): void {
      onChanged = listener;
    },

    /**
     * Announce that this project's cached projection changed.
     *
     * The paced pass fires this itself on completion. It is exposed because a
     * caller can legitimately write the cache WITHOUT running that pass - the
     * dev seeders build at full speed and write directly - and a cache that
     * changed with no push leaves every open surface rendering the previous
     * state until something unrelated triggers a reload.
     */
    notifyChanged(projectId: string): void {
      onChanged?.(projectId);
    },

    /** Cheap read. Never runs the pass. */
    getSnapshot(projectId: string, modelTag: string): GraphSnapshot {
      const store = storeFor(projectId);
      const coverage = buildCoverage(store, knownDocumentIds(store));
      const projection = readCachedProjection(store);
      const embedding = resolveEmbedding(store, modelTag, 0);
      return {
        projectId,
        projection,
        coverage,
        building: running.has(projectId),
        stale: !isProjectionFresh(
          projection,
          embedding.modelTag,
          coverage.totalEmbeddedChunks,
          store.maxChunkId(),
        ),
        semanticAvailable: store.hasVec,
      };
    },

    /** Schedule a paced background pass unless one is already running for this
     *  project. Returns immediately. */
    markDirty(projectId: string, modelTag: string, dimensions: number): void {
      if (running.has(projectId)) return;

      const signal = { aborted: false };
      const promise = (async () => {
        try {
          const store = storeFor(projectId);
          if (!store.hasVec) return;

          // The FIRST build gets a higher duty cycle than a refresh. Measured on
          // the real corpus, a cold pass is ~68s of work: at the steady-state
          // 20% that is 5.6 minutes staring at an empty surface, and there is no
          // cached map to look at meanwhile. A refresh is different - the old
          // map is still on screen, so it should stay out of the way. Sampling
          // chunks per document was measured as the alternative and rejected:
          // capping at 32 agrees with the full pool's neighbours only 40% of the
          // time, because a conversation's opening chunks are not representative
          // of the whole, so it buys speed by making the map wrong.
          const isFirstBuild = readCachedProjection(store) === null;
          const embedding = resolveEmbedding(store, modelTag, dimensions);
          const result = await runProjectionPass({
            store,
            modelTag: embedding.modelTag,
            dimensions: embedding.dimensions,
            signal,
            dutyCycle: isFirstBuild ? FIRST_BUILD_DUTY_CYCLE : undefined,
          });
          if (!result || signal.aborted) return;
          writeProjectionCache(store, result.projection, result.sums);
          onChanged?.(projectId);
        } catch (error) {
          console.error('[memory-graph] projection pass failed:', error);
        } finally {
          running.delete(projectId);
        }
      })();

      running.set(projectId, { signal, promise });
    },

  };
}

export const graphService = createGraphService();
