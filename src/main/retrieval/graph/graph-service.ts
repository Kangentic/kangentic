/**
 * Orchestrates the Knowledge Graph's projection cache, in the retrieval worker
 * (`worker/methods.ts` builds one per worker context; main reaches it through
 * `graph-facade.ts`).
 *
 * The division of labour matters and is enforced by
 * `.claude/rules/central-embedding-engine.md`'s sibling reasoning: a read may
 * only READ a cached projection and ASK for a refresh. It must never run the
 * pass inline, because a full projection is the same class of work (a long
 * scan plus vector math) that produced felt hardware spikes when embedding ran
 * in lifecycle hooks. `getSnapshotWire` is therefore always cheap, and
 * `markDirty` schedules the paced pass in the background.
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
import { CONVERSATION_CORPUS, INDEX_CORPORA } from '../corpora';
import { readIndexCounts, type SummaryCountSource } from '../index-counts';
import { aggregateCoverage, type CoverageSummary } from './coverage-aggregate';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { awaitWriteTurn } from '../write-budget';
import { createHash } from 'node:crypto';
import type {
  KnowledgeGraphBuildProgress,
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

/** The most often a first build's progress is pushed while its stage holds. A
 *  new stage is pushed at once, and the last figure follows a quiet spell. */
const BUILD_PROGRESS_INTERVAL_MS = 250;

/**
 * How long a project whose first build failed waits before another may start.
 * The failure is pushed so a reader drops the building card, and that reader's
 * re-read would otherwise ask again at once: a pass that fails every time would
 * loop push, ask, fail.
 */
const FIRST_BUILD_RETRY_MS = 60_000;

/**
 * A first build's progress as one percent: reading takes 0 to 95, placing 95 to
 * 98, naming 99. Reading each conversation's vectors from the index is nearly
 * all of a cold pass; the pass's log line prints each stage's time, which is
 * what these weights answer to. Floored, so the row never reads 100 while work
 * remains.
 */
export function buildPercent(stage: KnowledgeGraphBuildProgress['stage'], fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  if (stage === 'reading') return Math.floor(clamped * 95);
  if (stage === 'placing') return 95 + Math.floor(clamped * 3);
  return 99;
}

interface RunningPass {
  readonly signal: { aborted: boolean };
  promise: Promise<void>;
  /** The first build's progress; null for a refresh, which leaves the old map
   *  on screen. */
  progress: KnowledgeGraphBuildProgress | null;
  /** A throttled figure waiting to be pushed. */
  progressTimer: ReturnType<typeof setTimeout> | null;
}

/** Drop a pass's throttled figure: the pass ended, or was forgotten. */
function clearProgressTimer(entry: RunningPass): void {
  if (entry.progressTimer) clearTimeout(entry.progressTimer);
  entry.progressTimer = null;
}

/**
 * A first build's progress setter. It keeps the figure on the pass's entry,
 * where a read finds it, and pushes it: a new stage at once, and within a stage
 * at most every `BUILD_PROGRESS_INTERVAL_MS`, the last figure following a quiet
 * spell. Nothing is pushed once the pass is aborted.
 */
function createProgressReporter(
  entry: RunningPass,
  pass: number,
  now: () => number,
  push: (progress: KnowledgeGraphBuildProgress) => void,
): (stage: KnowledgeGraphBuildProgress['stage'], fraction: number) => void {
  let lastPushAt = Number.NEGATIVE_INFINITY;
  let pushedProgress: KnowledgeGraphBuildProgress | null = null;
  const pushLatest = (): void => {
    entry.progressTimer = null;
    if (entry.signal.aborted || !entry.progress || entry.progress === pushedProgress) return;
    pushedProgress = entry.progress;
    lastPushAt = now();
    push(entry.progress);
  };
  return (stage, fraction) => {
    const percent = buildPercent(stage, fraction);
    const previous = entry.progress;
    if (previous && previous.stage === stage && previous.percent === percent) return;
    entry.progress = { pass, stage, percent };
    if (!previous || previous.stage !== stage) {
      clearProgressTimer(entry);
      pushLatest();
      return;
    }
    if (entry.progressTimer) return;
    const waitMs = Math.max(0, lastPushAt + BUILD_PROGRESS_INTERVAL_MS - now());
    if (waitMs === 0) {
      pushLatest();
      return;
    }
    entry.progressTimer = setTimeout(pushLatest, waitMs);
    entry.progressTimer.unref?.();
  };
}

/** What region names, and the Index panel's counts, read from a project's summaries. */
interface SummarySource extends SummaryCountSource {
  fingerprint(): string;
  all(): Map<string, { summary: string }>;
}

export interface GraphServiceDeps {
  readonly getDb?: (projectId: string) => ReturnType<typeof getProjectDb>;
  readonly onChanged?: (projectId: string) => void;
  /** A first build's progress, throttled (`BUILD_PROGRESS_INTERVAL_MS`). */
  readonly onBuildProgress?: (projectId: string, progress: KnowledgeGraphBuildProgress) => void;
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

/** One event-loop turn, so a long job never holds the worker in one piece and
 *  an Ask or search is answered between its steps. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createGraphService(deps: GraphServiceDeps = {}) {
  const getDb = deps.getDb ?? getProjectDb;
  const running = new Map<string, RunningPass>();
  /**
   * Each project's last coverage, and the fingerprint it was computed at.
   * Coverage groups every chunk (about 285 ms on a large index) and was
   * recomputed on every graph open and every refresh push; it only changes
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
  const onChanged = deps.onChanged;
  /** Whether region names read summaries: task summaries switched on. Set by the
   *  worker from each read, which carries main's config. */
  let summaryNamesOn: () => boolean = () => false;
  const summariesFor = deps.summaries ?? ((projectId: string): SummarySource => new SummaryStore(getDb(projectId)));
  const now = deps.now ?? Date.now;
  const naming = new Map<string, NamingState>();
  /** Each project's named map as JSON, and its key (`getSnapshotWire`). */
  const projectionJson = new Map<string, { key: string; json: string }>();
  /** When each project's last first build failed (`FIRST_BUILD_RETRY_MS`). */
  const firstBuildFailedAt = new Map<string, number>();
  /** Tells passes apart within one worker; `now()` tells workers apart. */
  let passCounter = 0;

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
  function projectionWithNames(projectId: string, store: RetrievalStore, projection: KnowledgeGraphProjection | null): KnowledgeGraphProjection | null {
    return projectionWithNamesAndKey(projectId, store, projection).projection;
  }

  /**
   * `projectionWithNames`, and the key that identifies what it returned: the map's signature
   * and the names laid over it. Two reads with one key return the same map, so
   * a caller holding it need not be sent it again.
   */
  function projectionWithNamesAndKey(
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
   * all three together took about 63 ms on 998 conversations, which an Ask
   * waiting in the worker would sit behind. Returns whether anything changed.
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
    // A timer can outlive its project: naming waits up to its interval. The
    // worker opens databases with `fileMustExist`, so a project deleted
    // meanwhile throws at its open below and is never made again.
    state.running = true;
    try {
      const changed = await makeRegionNames(projectId);
      // Forgotten while naming, as the projection pass checks its signal:
      // nobody is left to tell about the map.
      if (changed && naming.get(projectId) === state) onChanged?.(projectId);
    } catch (error) {
      console.error('[knowledge-graph] region names failed:', error);
    } finally {
      state.running = false;
      state.lastRunAt = now();
      const urgent = state.againUrgent;
      const again = state.again;
      state.again = false;
      state.againUrgent = false;
      // Not for a project `forget` let go of while this ran: a run asked for
      // then would recreate its state and a timer against a closed database.
      if (again && naming.get(projectId) === state) scheduleRegionNames(projectId, urgent);
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
    modelTag: string,
    dimensions: number,
  ): KnowledgeGraphIndexSummary {
    const fingerprint = store.corpusFingerprint();
    let cached = corpusCache.get(projectId);
    if (!cached || cached.fingerprint !== fingerprint) {
      cached = timeSyncWork('graph:index-totals', () => ({
        fingerprint,
        totals: store.corpusTotals(),
        otherTextBytes: store.corpusTextBytes(INDEX_CORPORA.filter((corpus) => corpus !== 'conversation')),
      }));
      corpusCache.set(projectId, cached);
    }
    const totals = cached.totals;
    // Counted as the Settings card counts them (`index-counts.ts`): only the
    // selected model's vectors are embedded, and the summaries' counts are read
    // live so the row moves as the backfill writes. What the summary scheduler
    // is doing is main's, which adds it to the snapshot (`graph-facade.ts`).
    const counts = readIndexCounts(store, summarySourceFor(projectId), totals, { modelTag, semantic: true, summaries: true });
    // Every vector takes its space, whichever model wrote it.
    const otherEmbedded = totals
      .filter((entry) => entry.corpus !== 'conversation')
      .reduce((total, entry) => total + entry.embeddedChunks, 0);
    return {
      corpora: counts.corpora,
      summaries: counts.summaries,
      storageBytes: (projection?.storageBytes ?? 0) + cached.otherTextBytes + otherEmbedded * dimensions * 4,
    };
  }

  /** A project's summaries for their counts, or none when they cannot be read. */
  function summarySourceFor(projectId: string): SummaryCountSource {
    try {
      return summariesFor(projectId);
    } catch {
      return { awaitingRewrite: () => 0, writtenWith: () => [] };
    }
  }

  /** The snapshot, and the key of the map inside it (`projectionWithNamesAndKey`). */
  function snapshotWithKey(projectId: string, modelTag: string): { snapshot: GraphSnapshot; key: string | null } {
    const store = storeFor(projectId);
    const coverage = coverageFor(projectId, store);
    const { projection, key } = projectionWithNamesAndKey(projectId, store, timeSyncWork('graph:projection', () => readCachedProjection(store)));
    const embedding = resolveEmbedding(store, modelTag, 0);
    const snapshot: GraphSnapshot = {
      projectId,
      projection,
      coverage,
      index: indexSummaryFor(projectId, store, projection, modelTag, embedding.dimensions),
      building: running.has(projectId),
      buildProgress: running.get(projectId)?.progress ?? null,
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
    /** Register whether region names read summaries (task summaries switched on). */
    setSummaryNamesOn(provider: () => boolean): void {
      summaryNamesOn = provider;
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
     * The cached map alone, for a caller that needs no coverage or freshness:
     * Ask's task table. Coverage groups every chunk in the index, which is the
     * larger share of a snapshot read on a large project, and Ask reads one
     * map per project in scope on every question.
     */
    getProjection(projectId: string): GraphSnapshot['projection'] {
      const store = storeFor(projectId);
      // Named as the map is, so an answer names a region the way the map does.
      return projectionWithNames(projectId, store, timeSyncWork('graph:projection', () => readCachedProjection(store)));
    },

    /**
     * Cheap read; never runs the pass. The snapshot as it crosses to the renderer: the map as JSON, and only
     * when the caller does not already hold it (`knownProjectionKey`). A map is
     * about 1 MB, and an open graph re-reads its snapshot on every push, most
     * of which leave the map as it was. The JSON is kept per project, so a map
     * that did change is serialized once however many windows ask for it.
     */
    getSnapshotWire(projectId: string, modelTag: string, knownProjectionKey: string | null = null): KnowledgeGraphSnapshotWire {
      const { snapshot, key } = snapshotWithKey(projectId, modelTag);
      const { projection, ...rest } = snapshot;
      if (!projection || key === null) {
        projectionJson.delete(projectId);
        return { ...rest, projection: null, projectionKey: null };
      }
      if (knownProjectionKey === key) return { ...rest, projectionKey: key, projectionUnchanged: true };
      let cached = projectionJson.get(projectId);
      if (!cached || cached.key !== key) {
        cached = { key, json: timeSyncWork('graph:projection-json', () => JSON.stringify(projection)) };
        projectionJson.set(projectId, cached);
      }
      return { ...rest, projectionKey: key, projectionJson: cached.json };
    },

    /**
     * Schedule a paced background pass unless one is already running for this
     * project. Returns at once, with the first build's progress when the
     * project has no map and one is running, or null: the renderer paints the
     * building card from that answer, so a first build never shows "No map yet"
     * for the moment before its first push.
     */
    markDirty(projectId: string, modelTag: string, dimensions: number): KnowledgeGraphBuildProgress | null {
      const current = running.get(projectId);
      if (current) return current.progress;

      let store: RetrievalStore;
      let isFirstBuild: boolean;
      let embedding: { dimensions: number; modelTag: string };
      try {
        store = storeFor(projectId);
        if (!store.hasVec) return null;
        // The FIRST build gets a higher duty cycle than a refresh. Measured on
        // the real corpus, a cold pass is ~68s of work: at the steady-state
        // 20% that is 5.6 minutes staring at an empty surface, and there is no
        // cached map to look at meanwhile. A refresh is different - the old
        // map is still on screen, so it should stay out of the way. Sampling
        // chunks per document was measured as the alternative and rejected:
        // capping at 32 agrees with the full pool's neighbours only 40% of the
        // time, because a conversation's opening chunks are not representative
        // of the whole, so it buys speed by making the map wrong.
        isFirstBuild = readCachedProjection(store) === null;
        // Read before the first figure is pushed, so a store that fails here
        // has told no reader a build started.
        embedding = resolveEmbedding(store, modelTag, dimensions);
      } catch (error) {
        console.error('[knowledge-graph] projection pass failed:', error);
        return null;
      }
      if (isFirstBuild) {
        const failedAt = firstBuildFailedAt.get(projectId);
        if (failedAt !== undefined && now() - failedAt < FIRST_BUILD_RETRY_MS) return null;
      }

      const signal = { aborted: false };
      const entry: RunningPass = { signal, promise: Promise.resolve(), progress: null, progressTimer: null };
      const pass = now() * 1000 + (passCounter++ % 1000);
      // A refresh leaves the old map on screen, so only a first build reports.
      const setProgress = isFirstBuild
        ? createProgressReporter(entry, pass, now, (progress) => deps.onBuildProgress?.(projectId, progress))
        : (): void => undefined;

      // Set before the pass starts, so the answer below already carries it.
      setProgress('reading', 0);
      const startedAt = now();
      let placingAt: number | null = null;
      entry.promise = (async () => {
        try {
          const result = await runProjectionPass({
            store,
            modelTag: embedding.modelTag,
            dimensions: embedding.dimensions,
            signal,
            dutyCycle: isFirstBuild ? FIRST_BUILD_DUTY_CYCLE : undefined,
            awaitWriteTurn: () => awaitWriteTurn(getDb(projectId)),
            onProgress: (progress) => {
              if (progress.stage === 'placing' && placingAt === null) placingAt = now();
              setProgress(progress.stage, progress.fraction);
            },
          });
          if (!result || signal.aborted) return;
          writeProjectionCache(store, result.projection);
          firstBuildFailedAt.delete(projectId);
          // The new map's names in the same pass, so it never shows its
          // build-time names first and then renames under the reader.
          const namingAt = now();
          setProgress('naming', 1);
          try {
            await makeRegionNames(projectId);
            const state = naming.get(projectId);
            if (state) state.lastRunAt = now();
          } catch (error) {
            console.error('[knowledge-graph] region names failed:', error);
          }
          const { counts } = result;
          const readingMs = (placingAt ?? namingAt) - startedAt;
          const placingMs = placingAt === null ? 0 : namingAt - placingAt;
          console.log(
            `[knowledge-graph] map rebuilt: ${counts.documents} conversations, ${counts.documentsRead} read again `
            + `(${counts.vectorsRead} vectors) in ${now() - startedAt} ms `
            + `(reading ${readingMs} ms, placing ${placingMs} ms, naming ${now() - namingAt} ms)`,
          );
          // Forgotten while naming: nobody is left to tell about the map.
          if (signal.aborted) return;
          onChanged?.(projectId);
        } catch (error) {
          console.error('[knowledge-graph] projection pass failed:', error);
          // A reader showing the building card is told it ended without a map.
          // `FIRST_BUILD_RETRY_MS` keeps its re-read from starting another at once.
          if (isFirstBuild && !signal.aborted) {
            firstBuildFailedAt.set(projectId, now());
            onChanged?.(projectId);
          }
        } finally {
          clearProgressTimer(entry);
        }
      })();

      running.set(projectId, entry);
      // Cleared once the pass settles, never from inside it, so the entry is
      // always set before its cleanup can run.
      const settled = entry.promise;
      void settled.finally(() => {
        if (running.get(projectId)?.promise === settled) running.delete(projectId);
      });
      return entry.progress;
    },

    /**
     * Let go of everything held for a project closed for deletion: its map's
     * JSON (about 1 MB), its coverage and totals, and its naming timer, which
     * would otherwise fire later against a database that is gone. A pass still
     * running stops at its next step.
     */
    forget(projectId: string): void {
      const pass = running.get(projectId);
      if (pass) {
        pass.signal.aborted = true;
        clearProgressTimer(pass);
      }
      // Let go now, not when the aborted pass unwinds: until then the project
      // read as building, and a markDirty for it was dropped. The pass's own
      // cleanup checks the entry is still its own before it removes one.
      running.delete(projectId);
      firstBuildFailedAt.delete(projectId);
      const state = naming.get(projectId);
      if (state?.timer) clearTimeout(state.timer);
      naming.delete(projectId);
      projectionJson.delete(projectId);
      coverageCache.delete(projectId);
      corpusCache.delete(projectId);
    },
  };
}
