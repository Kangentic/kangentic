/**
 * The gates and clocks in the retrieval service's status paths.
 *
 * Four things the status poll and the map's push depend on, each of which had
 * no test that failed when it was wrong:
 *  - the poll drains a project's waiting passages only when indexing, semantic
 *    search, the model and the embed worker all allow it;
 *  - the Source code line says nothing with no project open, and reads the
 *    open project's branch size, not another project's index, while code is off;
 *  - `retryInMs` is the time left to the scheduler's retry, floored at zero, on
 *    the Settings status and on what the map's snapshot reads; and
 *  - the push to an open map is measured against what the map last read, so a
 *    pass that ends between a snapshot and the push timer still clears the
 *    "writing" the map is showing.
 *
 * Set up as in `retrieval-service-summary-every-project.test.ts`: the real
 * service and worker handlers, a fresh module per test, the stores, the
 * scheduler, the embed engine and the agent resolve stubbed. Every case has
 * project ids of its own, because the worker's status reader keeps each
 * project's totals for the life of the mocked module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';
import { waitingCorporaOf, type SummaryActivity } from '../../src/shared/index-summary';
import type { BranchSize } from '../../src/main/retrieval/code/code-status';
import { BoardEventBus } from '../../src/main/mobile-bridge/board-event-bus';

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn((projectId: string) => ({ projectId })),
}));
vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));
vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));

// Whether the selected embedding model is on disk, flipped per case.
const modelPresence = vi.hoisted(() => ({ present: true }));
vi.mock('../../src/main/retrieval/embedder/embedding-model', () => ({
  isEmbeddingModelPresent: vi.fn(() => modelPresence.present),
  downloadEmbeddingModel: vi.fn(async () => {}),
}));

const embedEngineMock = vi.hoisted(() => ({
  attach: vi.fn(),
  setOnRecordsEmbedded: vi.fn(),
  markDirty: vi.fn(),
  dispose: vi.fn(),
  getEmbedder: vi.fn(() => null),
  reconcile: vi.fn(),
  activeDevice: null as string | null,
  workerCrashed: false,
  workerCrashReason: null as string | null,
  chunksPerMinute: null as number | null,
}));
vi.mock('../../src/main/retrieval/embedder/embed-engine', () => ({ embedEngine: embedEngineMock }));

vi.mock('../../src/main/retrieval/conversation/conversation-indexer', () => ({
  ConversationIndexer: class {
    sweepProject = vi.fn(async () => undefined);
    purgeDeletedSessions = vi.fn(async () => 0);
    indexSession = vi.fn(async () => ({}));
    indexSubagentUsage = vi.fn(async () => 'indexed');
  },
}));
vi.mock('../../src/main/retrieval/task/task-indexer', () => ({ sweepTaskRecords: vi.fn(async () => ({ indexed: 0, removed: 0 })) }));
vi.mock('../../src/main/retrieval/change/change-indexer', () => ({ sweepChangeRecords: vi.fn(async () => ({ indexed: 0 })) }));
vi.mock('../../src/main/retrieval/commit/commit-indexer', () => ({
  sweepCommitRecords: vi.fn(async () => ({ indexed: 0, removed: 0, relinked: 0, deferred: false })),
}));
vi.mock('../../src/main/retrieval/code/code-indexer', () => ({
  sweepCodeRecords: vi.fn(async () => ({ indexed: 0, removed: 0, deferred: false })),
  purgeCodeRecords: vi.fn(() => false),
}));
vi.mock('../../src/main/retrieval/graph-facade', () => ({
  graphService: {
    notifyChanged: vi.fn(),
    setSummaryActivity: vi.fn(),
    setOnEmbeddingsWaiting: vi.fn(),
    setSummaryNamesOn: vi.fn(),
    requestRegionNames: vi.fn(),
    setProjectIds: vi.fn(),
  },
}));

// Git reads for the Source code line's branch size.
const branchSizesMock = vi.hoisted(() => ({
  get: vi.fn((_projectId: string, _projectPath: string, _baseBranch: string): BranchSize | null | undefined => undefined),
}));
vi.mock('../../src/main/retrieval/code/code-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/code/code-status')>()),
  createBranchSizes: () => branchSizesMock,
}));

/** Each project's index, by the id the mocked database carries. */
interface ProjectIndex {
  conversations: number;
  conversationChunks: number;
  /** Conversation passages with a vector, as the corpus totals count them. Defaults to all of them. */
  embedded?: number;
  /** Conversation passages the live read finds waiting for the selected model's vector. */
  waiting: number;
  written: number;
  finishedTasks: number;
  code?: { files: number; chunks: number; waiting?: number };
}
const indexState = vi.hoisted(() => ({ byProject: new Map<string, ProjectIndex>() }));
vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    private readonly projectId: string;
    constructor(db: { projectId: string }) {
      this.projectId = db.projectId;
    }
    private get index(): ProjectIndex | undefined {
      return indexState.byProject.get(this.projectId);
    }
    /** Its vector tables exist, so what waits is read. */
    readonly hasVec = true;
    corpusTotals() {
      const index = this.index;
      if (!index) return [];
      const rows = [{
        corpus: 'conversation',
        documents: index.conversations,
        chunks: index.conversationChunks,
        embeddedChunks: index.embedded ?? index.conversationChunks,
      }];
      if (index.code) rows.push({ corpus: 'code', documents: index.code.files, chunks: index.code.chunks, embeddedChunks: index.code.chunks });
      return rows;
    }
    countChunksNeedingEmbedding(): Map<string, number> {
      return new Map([['conversation', this.index?.waiting ?? 0], ['code', this.index?.code?.waiting ?? 0]]);
    }
    summaryCounts() {
      return { written: this.index?.written ?? 0, finishedTasks: this.index?.finishedTasks ?? 0 };
    }
    resetIndexState(): void {}
    reconcileVecOrphans(): void {}
  },
}));
vi.mock('../../src/main/retrieval/summary/summary-store', () => ({
  SummaryStore: class {
    awaitingRewrite(): number {
      return 0;
    }
    writtenWith() {
      return [];
    }
    markForRewrite(): number {
      return 0;
    }
  },
}));

interface SchedulerStatus {
  state: 'idle' | 'writing' | 'retrying';
  retryAtMs: number | null;
}
const summarySchedulerMock = vi.hoisted(() => ({
  invalidate: vi.fn(),
  request: vi.fn(),
  endBackoff: vi.fn(),
  dispose: vi.fn(),
  skipped: vi.fn((_projectId: string) => 0),
  status: vi.fn((_projectId: string): SchedulerStatus => ({ state: 'idle', retryAtMs: null })),
  writtenPerMinute: vi.fn((): number | null => null),
}));
vi.mock('../../src/main/retrieval/summary/summary-scheduler', () => ({
  createSummaryScheduler: vi.fn(() => summarySchedulerMock),
}));

const answerRunMock = vi.hoisted(() => ({ resolveAnswerRun: vi.fn() }));
vi.mock('../../src/main/retrieval/answer-run', () => ({ resolveAnswerRun: answerRunMock.resolveAnswerRun }));

const WRITER = { ok: true, run: { agentName: 'claude', model: 'claude-opus-5-5', effort: 'low' } };

/** The clock every case starts at, set before the module loads. */
const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
/** How long the map's push waits for a state to hold (`SUMMARY_PUSH_DEBOUNCE_MS`). */
const PUSH_DEBOUNCE_MS = 250;

let scratch: string;

function folderProject(id: string): Project {
  const folder = path.join(scratch, id);
  fs.mkdirSync(folder, { recursive: true });
  return { id, name: id, path: folder } as unknown as Project;
}

interface ContextOptions {
  indexingEnabled?: boolean;
  /** Semantic search (`knowledgeGraph.enabled`). */
  semanticOn?: boolean;
  sourceCode?: boolean;
}

function makeContext(openProjectId: string | null, projects: Project[], options: ContextOptions = {}): IpcContext {
  const { indexingEnabled = true, semanticOn = true, sourceCode = true } = options;
  return {
    configManager: {
      load: () => ({ knowledgeGraph: { indexingEnabled, enabled: semanticOn, agent: 'claude', taskSummaries: false, sourceCode } }),
    },
    currentProjectId: openProjectId,
    projectRepo: {
      list: () => projects,
      getById: (projectId: string) => projects.find((project) => project.id === projectId) ?? null,
    },
    sessionManager: new EventEmitter(),
    boardEvents: new BoardEventBus(),
  } as unknown as IpcContext;
}

/** A project with conversations indexed, all of them embedded, and nothing else. */
function caughtUp(): ProjectIndex {
  return { conversations: 5, conversationChunks: 50, waiting: 0, written: 0, finishedTasks: 0 };
}

describe('the retrieval service status paths', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-status-gates-'));
    vi.clearAllMocks();
    indexState.byProject.clear();
    modelPresence.present = true;
    embedEngineMock.workerCrashed = false;
    embedEngineMock.workerCrashReason = null;
    branchSizesMock.get.mockImplementation(() => undefined);
    summarySchedulerMock.status.mockImplementation(() => ({ state: 'idle', retryAtMs: null }));
    summarySchedulerMock.skipped.mockImplementation(() => 0);
    summarySchedulerMock.writtenPerMinute.mockImplementation(() => null);
    answerRunMock.resolveAnswerRun.mockReset();
    answerRunMock.resolveAnswerRun.mockResolvedValue(WRITER);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The clock is faked and pinned before the module loads, so its launch
    // delay and every `Date.now()` below are measured from NOW_MS.
    // setImmediate stays real: the worker handlers run on it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW_MS);
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    embedEngineMock.workerCrashed = false;
    embedEngineMock.workerCrashReason = null;
    modelPresence.present = true;
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe('draining a project the poll finds with passages waiting', () => {
    // The open project is marked dirty by its own block in getStatus, so every
    // case here looks at a project nobody opened: only the all-projects loop
    // can mark that one.
    function waitingIdOf(label: string): string {
      return `${label}-waiting`;
    }

    async function markedDirtyAfterPoll(label: string, options: ContextOptions = {}): Promise<string[]> {
      const openId = `${label}-open`;
      const waitingId = waitingIdOf(label);
      indexState.byProject.set(openId, caughtUp());
      // 8 of 20 passages have a vector: 12 wait. `embedded` is what the totals
      // count, so the project still reads as waiting when the live read is off.
      indexState.byProject.set(waitingId, { conversations: 2, conversationChunks: 20, embedded: 8, waiting: 12, written: 0, finishedTasks: 0 });
      await retrievalService.getStatus(makeContext(openId, [folderProject(openId), folderProject(waitingId)], options));
      return embedEngineMock.markDirty.mock.calls.map((call) => (call as unknown[])[0] as string);
    }

    // Red-green: the loop in getStatus (`for (const read of index.projects)`) is
    // what marks it; with the loop gone, no call names this project.
    it('marks it dirty when indexing, semantic search, the model and the embed worker all allow it', async () => {
      expect(await markedDirtyAfterPoll('gate-open')).toContain(waitingIdOf('gate-open'));
    });

    // Red-green: dropping `modelPresent` from the loop's condition marks it.
    it('marks nothing while the selected model is absent', async () => {
      modelPresence.present = false;
      expect(await markedDirtyAfterPoll('gate-model')).not.toContain(waitingIdOf('gate-model'));
    });

    // Red-green: dropping `!embedEngine.workerCrashed` from the loop's condition marks it.
    it('marks nothing once the embed worker has crashed past its restart cap', async () => {
      embedEngineMock.workerCrashed = true;
      embedEngineMock.workerCrashReason = 'gave up after 3 restarts';
      expect(await markedDirtyAfterPoll('gate-crash')).not.toContain(waitingIdOf('gate-crash'));
    });

    // Red-green: dropping `semanticOn` from the loop's condition marks it. The
    // totals still count the passages as waiting, so only this gate stops it.
    it('marks nothing while semantic search is off', async () => {
      expect(await markedDirtyAfterPoll('gate-semantic', { semanticOn: false })).not.toContain(waitingIdOf('gate-semantic'));
    });

    // Guards the case above against passing for nothing: with semantic search
    // off the worker skips the live waiting read, and this project must still
    // read as waiting from the totals alone.
    it('reads the project as waiting from the totals alone while the live read is off', async () => {
      const { retrievalClient } = await import('../../src/main/retrieval/retrieval-client');
      indexState.byProject.set('fixture-waiting', { conversations: 2, conversationChunks: 20, embedded: 8, waiting: 12, written: 0, finishedTasks: 0 });

      const index = await retrievalClient.call('status.indexAll', { projectIds: ['fixture-waiting'], modelTag: 'any-model', semantic: false, summaries: false });

      expect(index.projects.map((read) => waitingCorporaOf(read.corpora))).toEqual([['conversation']]);
    });

    // Two lines guard this, so no single revert turns it red: the poll skips the
    // worker when indexing is off (`if (indexingEnabled && projectIds.length > 0)`,
    // so `index` stays null), and the loop's own condition names `indexingEnabled`
    // too. Reverting only the first still leaves the second blocking, and the
    // other way round. Reverting both makes it red.
    it('marks nothing while indexing is off', async () => {
      expect(await markedDirtyAfterPoll('gate-indexing', { indexingEnabled: false })).not.toContain(waitingIdOf('gate-indexing'));
    });
  });

  describe('the Source code line', () => {
    // Red-green: the early return in codeStatusFor
    // (`progress.documents === 0 && (!projectId || !projectPath)`). Without it
    // the line falls through to codeStatus with code on and no branch size,
    // which reads { state: 'reading' } instead of nothing.
    it('says nothing with no project open and no code indexed anywhere', async () => {
      indexState.byProject.set('nocode-a', caughtUp());
      indexState.byProject.set('nocode-b', caughtUp());

      const status = await retrievalService.getStatus(makeContext(null, [folderProject('nocode-a'), folderProject('nocode-b')]));

      expect(status.code).toBeUndefined();
      // No project to size, so git is not read at all.
      expect(branchSizesMock.get).not.toHaveBeenCalled();
    });

    it('says nothing when the open project is not in the registry', async () => {
      indexState.byProject.set('ghost-known', caughtUp());

      const status = await retrievalService.getStatus(makeContext('ghost-unregistered', [folderProject('ghost-known')]));

      expect(status.code).toBeUndefined();
      expect(branchSizesMock.get).not.toHaveBeenCalled();
    });

    // The contrast for the two cases above: the same index with a project open
    // has a line to show (it is on, and waits on the first branch reading).
    it('reads "reading" once a project is open and nothing has been indexed or sized yet', async () => {
      indexState.byProject.set('reading-open', caughtUp());

      const status = await retrievalService.getStatus(makeContext('reading-open', [folderProject('reading-open')]));

      expect(status.code).toMatchObject({ state: 'reading', files: 0, passages: 0 });
      expect(branchSizesMock.get).toHaveBeenCalledTimes(1);
    });

    // Red-green: `const code = on ? summed?.corpora.find(...) : undefined`. With
    // the `on ?` gone, the other project's 40 files are read as this card's
    // progress, so the open project's branch is never sized (git is read only
    // while nothing is indexed) and the line reads nothing at all instead of
    // the estimate. Passing `on: true` to codeStatus instead gives
    // { state: 'reading' } with the branch's size, which fails the same assertion.
    it('sizes the open project\'s branch, not another project\'s index, while code is switched off', async () => {
      indexState.byProject.set('off-open', caughtUp());
      indexState.byProject.set('off-other', { ...caughtUp(), code: { files: 40, chunks: 400 } });
      branchSizesMock.get.mockImplementation(() => ({ branch: 'main', files: 12, passages: 34 }));
      const projects = [folderProject('off-open'), folderProject('off-other')];

      const status = await retrievalService.getStatus(makeContext('off-open', projects, { sourceCode: false }));

      expect(status.code).toEqual({ state: 'estimate', files: 12, passages: 34, embedded: 0, minutesLeft: null });
      // The open project's branch only, never the project that holds code.
      expect(branchSizesMock.get).toHaveBeenCalledTimes(1);
      expect(branchSizesMock.get.mock.calls[0]?.slice(0, 2)).toEqual(['off-open', projects[0].path]);
    });
  });

  // The Task summaries and Source code lines are read on the status poll only
  // while indexing AND semantic search are on, and only from an answer the
  // worker gave. Each case has a populated index and an open project, so a line
  // that was read would have something to say. `status.sources` is the control:
  // it is defined in the first case, which shows the worker answered and the
  // index was summed, so the missing lines come from their gates and not from a
  // poll that never ran.
  describe('the summaries and code lines when their gates are shut', () => {
    const BRANCH: BranchSize = { branch: 'main', files: 12, passages: 34 };

    // Red-green: `summaries: semanticOn && summed ? ...` and `code: indexingEnabled
    // && semanticOn && summed ? ...` in getStatus. Drop `semanticOn &&` from the
    // summaries line and `status.summaries` reads a status (zero written, zero
    // finished tasks) instead of undefined. Drop it from the code line and
    // `status.code` reads the open project's branch estimate and the branch size
    // is read from git, so both the value and the call assertion fail.
    it('reads neither while semantic search is off, with a populated index and a project open', async () => {
      indexState.byProject.set('semoff-open', { ...caughtUp(), written: 7, finishedTasks: 9 });
      branchSizesMock.get.mockImplementation(() => BRANCH);

      const status = await retrievalService.getStatus(makeContext('semoff-open', [folderProject('semoff-open')], { semanticOn: false }));

      expect(status.semantic).toBe('disabled');
      // The worker answered and the index was summed.
      expect(status.sources?.conversations.count).toBe(5);
      expect(status.summaries).toBeUndefined();
      expect(status.code).toBeUndefined();
      expect(branchSizesMock.get).not.toHaveBeenCalled();
    });

    // Two lines guard this, so no single revert turns it red, as with "marks
    // nothing while indexing is off" above: the poll skips the worker when
    // indexing is off (`index` and so `summed` stay null), and the code line's
    // own condition names `indexingEnabled` too. Reverting only the first still
    // leaves the second blocking, and the other way round. Reverting both reads
    // the open project's branch estimate, and this goes red.
    it('reads no code line while indexing is off', async () => {
      indexState.byProject.set('idxoff-open', caughtUp());
      branchSizesMock.get.mockImplementation(() => BRANCH);

      const status = await retrievalService.getStatus(makeContext('idxoff-open', [folderProject('idxoff-open')], { indexingEnabled: false }));

      expect(status.indexingEnabled).toBe(false);
      expect(status.code).toBeUndefined();
      expect(branchSizesMock.get).not.toHaveBeenCalled();
    });

    // The worker being down is the reported case: the poll's call rejects, so
    // there is no index to sum. Before `&& summed` the code line was read from
    // an empty sum and said { state: 'reading' } for a project nobody had read,
    // with a git read to size its branch, on every poll while the worker
    // restarted. The control above says what a line reads with the worker up
    // ("reads reading once a project is open", in the Source code line cases).
    //
    // Red-green: drop `&& summed` from the code line and pass an empty sum in
    // its place (`summed ?? sumIndex([])`): the line reads { state: 'reading' }
    // and the branch size is read. Dropping `&& summed` alone does not turn this
    // red: `codeStatusFor` reads `summed.corpora`, throws on null, and its own
    // catch answers undefined.
    it('reads no code line while the worker is down, with indexing, semantic search and source code on', async () => {
      const { retrievalClient } = await import('../../src/main/retrieval/retrieval-client');
      vi.mocked(retrievalClient.call).mockRejectedValueOnce(new Error('the retrieval worker is restarting'));
      indexState.byProject.set('down-open', caughtUp());
      branchSizesMock.get.mockImplementation(() => BRANCH);

      const status = await retrievalService.getStatus(makeContext('down-open', [folderProject('down-open')]));

      // The poll did ask the worker, and the rejection is what left it with no index.
      expect(retrievalClient.call).toHaveBeenCalledWith('status.indexAll', expect.objectContaining({ projectIds: ['down-open'], semantic: true }));
      expect(status.semantic).toBe('lexical');
      expect(status.sources).toBeUndefined();
      expect(status.summaries).toBeUndefined();
      expect(status.code).toBeUndefined();
      expect(branchSizesMock.get).not.toHaveBeenCalled();
    });
  });

  describe('retryInMs', () => {
    const CASES: ReadonlyArray<{ name: string; scheduler: SchedulerStatus; retryInMs: number | null }> = [
      { name: 'a retry still ahead', scheduler: { state: 'retrying', retryAtMs: NOW_MS + 90_000 }, retryInMs: 90_000 },
      { name: 'a retry due this instant', scheduler: { state: 'retrying', retryAtMs: NOW_MS }, retryInMs: 0 },
      { name: 'a retry already past', scheduler: { state: 'retrying', retryAtMs: NOW_MS - 5_000 }, retryInMs: 0 },
      { name: 'an idle scheduler', scheduler: { state: 'idle', retryAtMs: null }, retryInMs: null },
      { name: 'a scheduler writing', scheduler: { state: 'writing', retryAtMs: null }, retryInMs: null },
    ];

    // The scheduler has no retry time unless it is retrying, so null is the
    // answer for every other state.
    describe.each(CASES.map((entry, position) => ({ ...entry, position })))('with $name', ({ scheduler, retryInMs, position }) => {
      // Red-green: `Math.max(0, scheduler.retryAtMs - Date.now())` in
      // summaryActivityFor. Dropping the floor fails the already-past case
      // (-5000 for 0); the due-this-instant case is 0 either way and pins the
      // boundary. Returning `retryAtMs` as it is, or always null, fails the
      // ahead case. On the Settings status the null for idle and writing also
      // comes from `sumSummaryCounts`, so only the map rows discriminate the
      // `retryAtMs === null` branch.
      it('reports it on the Settings status', async () => {
        const projectId = `retry-settings-${position}`;
        indexState.byProject.set(projectId, caughtUp());
        summarySchedulerMock.status.mockImplementation(() => scheduler);

        const status = await retrievalService.getStatus(makeContext(projectId, [folderProject(projectId)]));

        expect(status.summaries?.state).toBe(scheduler.state);
        expect(status.summaries?.retryInMs).toBe(retryInMs);
      });

      it('reports it on what the map\'s snapshot reads', async () => {
        const { graphService } = await import('../../src/main/retrieval/graph-facade');
        retrievalService.attach(makeContext(`retry-map-${position}`, [folderProject(`retry-map-${position}`)]));
        const provider = vi.mocked(graphService.setSummaryActivity).mock.calls.at(-1)?.[0] as ((projectId: string) => SummaryActivity) | undefined;
        if (!provider) throw new Error('attach gave the graph no summary activity provider');
        summarySchedulerMock.status.mockImplementation(() => scheduler);

        const activity = provider(`retry-map-${position}`);

        expect(activity.state).toBe(scheduler.state);
        expect(activity.retryInMs).toBe(retryInMs);
      });
    });

    // The time left is measured at each read, not fixed when the scheduler
    // reported it.
    it('counts down as the clock moves, and is zero once it passes', async () => {
      const { graphService } = await import('../../src/main/retrieval/graph-facade');
      retrievalService.attach(makeContext('countdown', [folderProject('countdown')]));
      const provider = vi.mocked(graphService.setSummaryActivity).mock.calls.at(-1)?.[0] as ((projectId: string) => SummaryActivity) | undefined;
      if (!provider) throw new Error('attach gave the graph no summary activity provider');
      summarySchedulerMock.status.mockImplementation(() => ({ state: 'retrying', retryAtMs: NOW_MS + 60_000 }));

      expect(provider('countdown').retryInMs).toBe(60_000);
      vi.setSystemTime(NOW_MS + 45_000);
      expect(provider('countdown').retryInMs).toBe(15_000);
      vi.setSystemTime(NOW_MS + 61_000);
      expect(provider('countdown').retryInMs).toBe(0);
    });
  });

  describe('the push to an open Knowledge Graph, measured against what the map last read', () => {
    const PROJECT = 'push-project';

    async function statusChanged(): Promise<(projectId: string) => void> {
      const { createSummaryScheduler } = await import('../../src/main/retrieval/summary/summary-scheduler');
      const deps = vi.mocked(createSummaryScheduler).mock.calls.at(-1)?.[0] as { onStatusChanged?: (projectId: string) => void } | undefined;
      if (!deps?.onStatusChanged) throw new Error('the service gave the scheduler no onStatusChanged');
      return deps.onStatusChanged;
    }

    /** Attach the service, and take the activity provider the map's snapshot reads through. */
    async function attachedGraph() {
      const { graphService } = await import('../../src/main/retrieval/graph-facade');
      retrievalService.attach(makeContext(PROJECT, [folderProject(PROJECT)]));
      const provider = vi.mocked(graphService.setSummaryActivity).mock.calls.at(-1)?.[0] as ((projectId: string) => SummaryActivity) | undefined;
      if (!provider) throw new Error('attach gave the graph no summary activity provider');
      vi.mocked(graphService.notifyChanged).mockClear();
      return { graphService, provider };
    }

    function schedulerIs(state: SchedulerStatus['state']): void {
      summarySchedulerMock.status.mockImplementation(() => ({ state, retryAtMs: null }));
    }

    // Red-green: `shownSummaryActivity.set(...)` inside the setSummaryActivity
    // wrapper in `attach`. Without it the map's read leaves nothing behind, the
    // timer compares idle with the idle default of a project never read, and
    // returns without pushing: the map keeps showing "writing" for a pass that
    // has ended.
    it('pushes when the pass ends after the map read it writing and before the push timer', async () => {
      const { graphService, provider } = await attachedGraph();
      const onStatusChanged = await statusChanged();

      schedulerIs('writing');
      onStatusChanged(PROJECT);
      // The map reads a snapshot mid-pass.
      expect(provider(PROJECT).state).toBe('writing');
      schedulerIs('idle');
      vi.advanceTimersByTime(PUSH_DEBOUNCE_MS);

      expect(vi.mocked(graphService.notifyChanged).mock.calls).toEqual([[PROJECT]]);

      // The push recorded what it told the map: the same idle state again is not a change.
      onStatusChanged(PROJECT);
      vi.advanceTimersByTime(PUSH_DEBOUNCE_MS);
      expect(vi.mocked(graphService.notifyChanged).mock.calls).toEqual([[PROJECT]]);
    });

    // The control: with no snapshot read in between, a pass that ended as it
    // started is nothing to tell the map.
    it('says nothing for a pass that ends before the push timer when the map read nothing', async () => {
      const { graphService } = await attachedGraph();
      const onStatusChanged = await statusChanged();

      schedulerIs('writing');
      onStatusChanged(PROJECT);
      schedulerIs('idle');
      vi.advanceTimersByTime(PUSH_DEBOUNCE_MS);

      expect(graphService.notifyChanged).not.toHaveBeenCalled();
    });

    // Red-green: the same line. Without it the map's read is forgotten, and the
    // timer takes "writing" for news against the idle default and pushes a
    // snapshot the map already carries.
    it('says nothing when the state at the push timer is the one the map already read', async () => {
      const { graphService, provider } = await attachedGraph();
      const onStatusChanged = await statusChanged();

      schedulerIs('writing');
      onStatusChanged(PROJECT);
      expect(provider(PROJECT).state).toBe('writing');
      vi.advanceTimersByTime(PUSH_DEBOUNCE_MS);

      expect(graphService.notifyChanged).not.toHaveBeenCalled();
    });
  });
});
