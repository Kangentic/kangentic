/**
 * Orchestrates the Knowledge Graph's projection cache for the IPC layer.
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
import { SummaryStore } from '../summary/summary-store';
import { CONVERSATION_CORPUS, isEmbeddedCorpus, MEMORY_CORPORA } from '../corpora';
import { aggregateCoverage, type CoverageSummary } from './coverage-aggregate';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { createHash } from 'node:crypto';
import type {
  KnowledgeGraphGranularity,
  KnowledgeGraphIndexSummary,
  KnowledgeGraphProjection,
  KnowledgeGraphSnapshot,
  KnowledgeGraphSnapshotWire,
} from '../../../shared/types';
import {
  runProjectionPass,
  readCachedProjection,
  writeProjectionCache,
  isProjectionFresh,
} from './projection-engine';
import { LABELLER_VERSION } from './cluster-labels';
import {
  SUMMARIES_OFF,
  REGION_NAMES_KEY,
  nameRegions,
  parseStoredRegionNames,
  regionNamesCurrent,
  regionNamesUsable,
  withRegionNames,
  type StoredRegionNames,
} from './region-names';

/**
 * The snapshot IS the IPC payload (`KnowledgeGraphSnapshot` in shared/types), one
 * definition rather than an internal shape plus a wire shape. Field meanings
 * are documented there; the notable ones are `stale` (a stale projection is
 * still SERVED, because a slightly old map beats a blank one) and
 * `semanticAvailable` (false when sqlite-vec is missing, so the UI can say the
 * semantic layer is off instead of implying an empty index).
 */
export type GraphSnapshot = KnowledgeGraphSnapshot;

/**
 * Duty cycle for a project's very first projection, where no cached map exists
 * to look at while it builds. Still well under half of wall time, so it stays a
 * background task rather than a spike of the kind
 * `.claude/rules/central-embedding-engine.md` exists to prevent.
 */
const FIRST_BUILD_DUTY_CYCLE = 0.45;

/**
 * The most often a project's region names are made again while its summaries are
 * still being written, unless a pass says it has caught up. A backfill writes
 * thirty summaries every few seconds, and renaming on each would move the names
 * under the reader about twenty times in three minutes.
 */
const REGION_NAMES_INTERVAL_MS = 5 * 60_000;

interface RunningPass {
  readonly signal: { aborted: boolean };
  readonly promise: Promise<void>;
}

/** What region names read from a project's summaries. */
interface SummarySource {
  fingerprint(): string;
  all(): Map<string, { summary: string }>;
}

export interface GraphServiceDeps {
  readonly getDb?: (projectId: string) => ReturnType<typeof getProjectDb>;
  readonly onChanged?: (projectId: string) => void;
  /** A project's summaries. Injected for tests. */
  readonly summaries?: (projectId: string) => SummarySource;
  /** Epoch ms. Injected for tests. */
  readonly now?: () => number;
}

/** A project's region naming: when it last ran, and what is waiting. */
interface NamingState {
  lastRunAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  again: boolean;
  againUrgent: boolean;
}

export interface SnapshotOptions {
  /** How many finished tasks the summary scheduler passed over, which the
   *  Index row reports. Sent with the read by main, which runs the scheduler. */
  summariesSkipped?: number;
}

/** One event-loop turn, so a long job never holds main in one piece. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createGraphService(deps: GraphServiceDeps = {}) {
  const getDb = deps.getDb ?? getProjectDb;
  const running = new Map<string, RunningPass>();
  /**
   * Each project's last coverage, and the fingerprint it was computed at.
   * Coverage groups every chunk (about 285 ms on a large index, on main) and
   * was recomputed on every graph open and every refresh push; it only changes
   * when the index does, which the fingerprint (about 6 ms) detects.
   */
  const coverageCache = new Map<string, { fingerprint: string; coverage: CoverageSummary }>();
  /** Each project's corpus totals, and the fingerprint they were read at. */
  const corpusCache = new Map<string, {
    fingerprint: string;
    totals: ReturnType<RetrievalStore['corpusTotals']>;
    /** Text bytes of every corpus but conversations, which the map's pass sums. */
    otherTextBytes: number;
  }>();
  // Settable rather than constructor-only: the singleton is created at import
  // time but the push target (the main window) only exists once IPC registers.
  let onChanged: ((projectId: string) => void) | undefined = deps.onChanged;
  /** How many Done tasks the summary scheduler passed over, by project. Set
   *  by the retrieval service, which owns the scheduler and imports this module. */
  let summariesSkipped: ((projectId: string) => number) | undefined;
  /** Whether region names read summaries: task summaries switched on. Set by the
   *  retrieval service, which reads the config. */
  let summaryNamesOn: () => boolean = () => false;
  /** Whether a project is still registered. Set by the retrieval service, which
   *  holds the project list; until then every project counts as present. */
  let projectExists: (projectId: string) => boolean = () => true;
  const summariesFor = deps.summaries ?? ((projectId: string): SummarySource => new SummaryStore(getDb(projectId)));
  const now = deps.now ?? Date.now;
  const naming = new Map<string, NamingState>();
  /** Each project's named map as JSON, and its key (`getSnapshotWire`). */
  const projectionJson = new Map<string, { key: string; json: string }>();

  function storeFor(projectId: string): RetrievalStore {
    return new RetrievalStore(getDb(projectId));
  }

  /** What a project's region names read now: `SUMMARIES_OFF`, or its summaries'
   *  fingerprint (one small read). */
  function summaryKeyFor(projectId: string): string {
    if (!summaryNamesOn()) return SUMMARIES_OFF;
    try {
      return summariesFor(projectId).fingerprint();
    } catch {
      return SUMMARIES_OFF;
    }
  }

  /**
   * The cached map with its stored region names over it. Names made for
   * another map, another labeller or the other summary setting are not shown,
   * and new ones are asked for at once; names a few summaries behind are shown
   * while new ones wait their turn.
   */
  function named(projectId: string, store: RetrievalStore, projection: KnowledgeGraphProjection | null): KnowledgeGraphProjection | null {
    return namedWithKey(projectId, store, projection).projection;
  }

  /**
   * `named`, and the key that identifies what it returned: the map's signature
   * and the names laid over it. Two reads with one key return the same map, so
   * a caller holding it need not be sent it again.
   */
  function namedWithKey(
    projectId: string,
    store: RetrievalStore,
    projection: KnowledgeGraphProjection | null,
  ): { projection: KnowledgeGraphProjection | null; key: string | null } {
    if (!projection) return { projection, key: null };
    const summaries = summaryKeyFor(projectId);
    const rawNames = store.getMeta(REGION_NAMES_KEY);
    const stored = parseStoredRegionNames(rawNames);
    if (!regionNamesCurrent(stored, projection.signature, summaries)) {
      scheduleRegionNames(projectId, !regionNamesUsable(stored, projection.signature, summaries));
    }
    const shownNames = regionNamesUsable(stored, projection.signature, summaries) ? rawNames ?? '' : '';
    const key = createHash('sha1').update(projection.signature).update('\0').update(shownNames).digest('hex');
    return { projection: withRegionNames(projection, stored, summaries), key };
  }

  /**
   * Make a project's region names and store them. One granularity per turn:
   * all three together held main for about 63 ms on 998 conversations. Returns
   * whether anything changed.
   */
  async function makeRegionNames(projectId: string): Promise<boolean> {
    const store = storeFor(projectId);
    const projection = readCachedProjection(store);
    if (!projection) return false;
    const summaries = summaryKeyFor(projectId);
    if (regionNamesCurrent(parseStoredRegionNames(store.getMeta(REGION_NAMES_KEY)), projection.signature, summaries)) return false;
    let summaryByTask: Map<string, string> | null = null;
    if (summaries !== SUMMARIES_OFF) {
      summaryByTask = new Map([...summariesFor(projectId).all()].map(([taskId, entry]) => [taskId, entry.summary]));
    }
    const names: Partial<Record<KnowledgeGraphGranularity, Record<number, string>>> = {};
    for (const clustering of projection.clusterings) {
      names[clustering.granularity] = timeSyncWork('graph:region-names', () => nameRegions(projection, clustering.granularity, summaryByTask));
      await yieldTurn();
    }
    // A map rebuilt meanwhile has other regions, so these names are not for it.
    const latest = readCachedProjection(store);
    if (!latest || latest.signature !== projection.signature) return false;
    const stored: StoredRegionNames = { signature: projection.signature, labellerVersion: LABELLER_VERSION, summaries, names };
    store.setMeta(REGION_NAMES_KEY, JSON.stringify(stored));
    return true;
  }

  /**
   * Ask for a project's region names. Urgent runs now; otherwise it waits out
   * `REGION_NAMES_INTERVAL_MS` since the last run, and one already waiting
   * covers it.
   */
  function scheduleRegionNames(projectId: string, urgent: boolean): void {
    let state = naming.get(projectId);
    if (!state) {
      state = { lastRunAt: 0, timer: null, running: false, again: false, againUrgent: false };
      naming.set(projectId, state);
    }
    if (state.running) {
      state.again = true;
      state.againUrgent = state.againUrgent || urgent;
      return;
    }
    if (state.timer) {
      if (!urgent) return;
      clearTimeout(state.timer);
    }
    const waitMs = urgent ? 0 : Math.max(0, state.lastRunAt + REGION_NAMES_INTERVAL_MS - now());
    const owner = state;
    const timer = setTimeout(() => {
      owner.timer = null;
      void runRegionNames(projectId, owner);
    }, waitMs);
    timer.unref?.();
    state.timer = timer;
  }

  async function runRegionNames(projectId: string, state: NamingState): Promise<void> {
    // A timer can outlive its project: naming waits up to its interval, and a
    // project deleted meanwhile would get an empty database made for it again.
    if (!projectExists(projectId)) {
      naming.delete(projectId);
      return;
    }
    state.running = true;
    try {
      if (await makeRegionNames(projectId)) onChanged?.(projectId);
    } catch (error) {
      console.error('[knowledge-graph] region names failed:', error);
    } finally {
      state.running = false;
      state.lastRunAt = now();
      if (state.again) {
        const urgent = state.againUrgent;
        state.again = false;
        state.againUrgent = false;
        scheduleRegionNames(projectId, urgent);
      }
    }
  }

  function buildCoverage(store: RetrievalStore, knownDocumentIds: string[]): CoverageSummary {
    // Conversation coverage: what the map draws. The other corpora report in
    // the Index panel's own rows.
    return aggregateCoverage({
      indexState: store.listIndexState('conversation'),
      chunkTotals: store.documentChunkTotals(CONVERSATION_CORPUS),
      knownDocumentIds,
    });
  }

  /** Coverage, recomputed only when the index behind it has changed. */
  function coverageFor(projectId: string, store: RetrievalStore): CoverageSummary {
    const fingerprint = store.coverageFingerprint();
    const cached = coverageCache.get(projectId);
    if (cached && cached.fingerprint === fingerprint) return cached.coverage;
    const coverage = timeSyncWork('graph:coverage', () => buildCoverage(store, knownDocumentIds(store)));
    coverageCache.set(projectId, { fingerprint, coverage });
    return coverage;
  }

  /**
   * Everything the index holds, every corpus, for the Index panel.
   *
   * The counts are three index reads (about 15 ms on a 94k-chunk index), so
   * they are kept until the store's size moves; the fingerprint is cheaper. The
   * size adds the other corpora, text and vectors, to the conversations' size
   * the map's pass measured.
   */
  function indexSummaryFor(
    projectId: string,
    store: RetrievalStore,
    projection: GraphSnapshot['projection'],
    dimensions: number,
    summariesSkippedCount: number | undefined,
  ): KnowledgeGraphIndexSummary {
    const fingerprint = store.corpusFingerprint();
    let cached = corpusCache.get(projectId);
    if (!cached || cached.fingerprint !== fingerprint) {
      cached = timeSyncWork('graph:index-totals', () => ({
        fingerprint,
        totals: store.corpusTotals(),
        otherTextBytes: store.corpusTextBytes(MEMORY_CORPORA.filter((corpus) => corpus !== 'conversation')),
      }));
      corpusCache.set(projectId, cached);
    }
    const totals = cached.totals;
    const corpora = MEMORY_CORPORA.map((corpus) => {
      const row = totals.find((entry) => entry.corpus === corpus);
      return {
        corpus,
        documents: row?.documents ?? 0,
        chunks: row?.chunks ?? 0,
        embeddedChunks: row?.embeddedChunks ?? 0,
        embeds: isEmbeddedCorpus(corpus),
      };
    });
    const otherEmbedded = corpora
      .filter((entry) => entry.corpus !== 'conversation')
      .reduce((total, entry) => total + entry.embeddedChunks, 0);
    return {
      corpora,
      summaries: summaryCounts(projectId, store, summariesSkippedCount),
      storageBytes: (projection?.storageBytes ?? 0) + cached.otherTextBytes + otherEmbedded * dimensions * 4,
      lastIndexedAt: store.lastIndexedAt(),
    };
  }

  /** Summaries written, of the finished tasks: two small reads, never cached, so
   *  the row moves as the background backfill writes. The count passed over is
   *  the summary scheduler's, which runs on main and sends it with the read. */
  function summaryCounts(projectId: string, store: RetrievalStore, skippedCount: number | undefined): KnowledgeGraphIndexSummary['summaries'] {
    const skipped = skippedCount ?? summariesSkipped?.(projectId) ?? 0;
    try {
      return { ...store.summaryCounts(), skipped };
    } catch {
      return { written: 0, finishedTasks: 0, skipped };
    }
  }

  /** The snapshot, and the key of the map inside it (`namedWithKey`). */
  function snapshotWithKey(
    projectId: string,
    modelTag: string,
    options: SnapshotOptions,
  ): { snapshot: GraphSnapshot; key: string | null } {
    const store = storeFor(projectId);
    const coverage = coverageFor(projectId, store);
    const { projection, key } = namedWithKey(projectId, store, timeSyncWork('graph:projection', () => readCachedProjection(store)));
    const embedding = resolveEmbedding(store, modelTag, 0);
    const snapshot: GraphSnapshot = {
      projectId,
      projection,
      coverage,
      index: indexSummaryFor(projectId, store, projection, embedding.dimensions, options.summariesSkipped),
      building: running.has(projectId),
      stale: !isProjectionFresh(
        projection,
        embedding.modelTag,
        coverage.totalEmbeddedChunks,
        store.maxChunkId('conversation'),
      ),
      semanticAvailable: store.hasVec,
    };
    return { snapshot, key };
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

    /** Register where the Index reads how many tasks summaries passed over. */
    setSummariesSkipped(provider: (projectId: string) => number): void {
      summariesSkipped = provider;
    },

    /** Register whether region names read summaries (task summaries switched on). */
    setSummaryNamesOn(provider: () => boolean): void {
      summaryNamesOn = provider;
    },

    /** Register whether a project is still registered, so no timer opens a deleted one. */
    setProjectExists(provider: (projectId: string) => boolean): void {
      projectExists = provider;
    },

    /**
     * Summaries were written: make the region names again. `urgent` when the
     * backfill has caught up, so the last names land at once; otherwise at
     * most once every `REGION_NAMES_INTERVAL_MS`.
     */
    requestRegionNames(projectId: string, urgent: boolean): void {
      scheduleRegionNames(projectId, urgent);
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

    /**
     * The cached map alone, for a caller that needs no coverage or freshness:
     * Ask's task table. Coverage groups every chunk in the index, which is the
     * larger share of a snapshot read on a large project, and Ask reads one
     * map per project in scope on every question.
     */
    getProjection(projectId: string): GraphSnapshot['projection'] {
      const store = storeFor(projectId);
      // Named as the map is, so an answer names a region the way the map does.
      return named(projectId, store, timeSyncWork('graph:projection', () => readCachedProjection(store)));
    },

    /** Cheap read. Never runs the pass. */
    getSnapshot(projectId: string, modelTag: string, options: SnapshotOptions = {}): GraphSnapshot {
      return snapshotWithKey(projectId, modelTag, options).snapshot;
    },

    /**
     * The snapshot as it crosses to the renderer: the map as JSON, and only
     * when the caller does not already hold it (`knownProjectionKey`). A map is
     * about 1 MB, and an open graph re-reads its snapshot on every push, most
     * of which leave the map as it was. The JSON is kept per project, so a map
     * that did change is serialized once however many windows ask for it.
     */
    getSnapshotWire(
      projectId: string,
      modelTag: string,
      options: SnapshotOptions & { knownProjectionKey?: string | null } = {},
    ): KnowledgeGraphSnapshotWire {
      const { snapshot, key } = snapshotWithKey(projectId, modelTag, options);
      const { projection, ...rest } = snapshot;
      if (!projection || key === null) {
        projectionJson.delete(projectId);
        return { ...rest, projection: null, projectionKey: null };
      }
      if (options.knownProjectionKey === key) return { ...rest, projectionKey: key, projectionUnchanged: true };
      let cached = projectionJson.get(projectId);
      if (!cached || cached.key !== key) {
        cached = { key, json: timeSyncWork('graph:projection-json', () => JSON.stringify(projection)) };
        projectionJson.set(projectId, cached);
      }
      return { ...rest, projectionKey: key, projectionJson: cached.json };
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
          const startedAt = now();
          const result = await runProjectionPass({
            store,
            modelTag: embedding.modelTag,
            dimensions: embedding.dimensions,
            signal,
            dutyCycle: isFirstBuild ? FIRST_BUILD_DUTY_CYCLE : undefined,
          });
          if (!result || signal.aborted) return;
          writeProjectionCache(store, result.projection);
          const { counts } = result;
          console.log(
            `[knowledge-graph] map rebuilt: ${counts.documents} conversations, ${counts.documentsRead} read again `
            + `(${counts.vectorsRead} vectors) in ${now() - startedAt} ms`,
          );
          // The new map's names in the same pass, so it never shows its
          // build-time names first and then renames under the reader.
          try {
            await makeRegionNames(projectId);
            const state = naming.get(projectId);
            if (state) state.lastRunAt = now();
          } catch (error) {
            console.error('[knowledge-graph] region names failed:', error);
          }
          onChanged?.(projectId);
        } catch (error) {
          console.error('[knowledge-graph] projection pass failed:', error);
        }
      })();

      running.set(projectId, { signal, promise });
      // Cleared once the pass settles, never from inside it: a pass that exits
      // before its first await (no vec extension, a store that fails to open)
      // would run that cleanup synchronously, BEFORE the set above, and leave
      // the project marked as building forever, refusing every later pass.
      void promise.finally(() => {
        if (running.get(projectId)?.promise === promise) running.delete(projectId);
      });
    },

  };
}

export const graphService = createGraphService();
