/**
 * Task summaries in every project, and one Index for all of them.
 *
 * On a 19-project install the Knowledge Graph's All projects panel read 91% on
 * a track that never moved: five projects nobody opened, and nothing on whose
 * boards moved, had never been asked for a summary pass, and the Settings card,
 * which read the open project alone, said everything was caught up. These pin
 * the fix's main-side half:
 *  - every project whose folder exists is asked once a launch, after the
 *    launch's whole-branch-read delay, the open one first;
 *  - a writer resolved where none was (summaries switched on, an agent chosen)
 *    asks every project again, but not before that delay; and
 *  - the Settings card sums every indexed project with what the summary
 *    scheduler is doing for each, the same record the map's panel sums, while
 *    the Source code estimate reads git for the open project alone.
 *
 * Set up as in `retrieval-service-summary-backoff.test.ts`: the real
 * service and worker handlers, a fresh module per test, the stores, the
 * scheduler and the agent resolve stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';
import { BoardEventBus } from '../../src/main/mobile-bridge/board-event-bus';

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn((projectId: string) => ({ projectId })),
}));
vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));
vi.mock('../../src/main/retrieval/retrieval-client', async () => (
  (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));
vi.mock('../../src/main/retrieval/embedder/embedding-model', () => ({
  isEmbeddingModelPresent: vi.fn(() => true),
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
const branchSizesMock = vi.hoisted(() => ({ get: vi.fn(() => undefined) }));
vi.mock('../../src/main/retrieval/code/code-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/retrieval/code/code-status')>()),
  createBranchSizes: () => branchSizesMock,
}));

/** Each project's index, by the id the mocked database carries. */
interface ProjectIndex {
  conversations: number;
  conversationChunks: number;
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
      const rows = [{ corpus: 'conversation', documents: index.conversations, chunks: index.conversationChunks, embeddedChunks: index.conversationChunks }];
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

const summarySchedulerMock = vi.hoisted(() => ({
  invalidate: vi.fn(),
  request: vi.fn(),
  endBackoff: vi.fn(),
  dispose: vi.fn(),
  skipped: vi.fn((_projectId: string) => 0),
  status: vi.fn((_projectId: string) => ({ state: 'idle', retryAtMs: null as number | null })),
  writtenPerMinute: vi.fn((): number | null => null),
}));
vi.mock('../../src/main/retrieval/summary/summary-scheduler', () => ({
  createSummaryScheduler: vi.fn(() => summarySchedulerMock),
}));

const answerRunMock = vi.hoisted(() => ({ resolveAnswerRun: vi.fn() }));
vi.mock('../../src/main/retrieval/answer-run', () => ({ resolveAnswerRun: answerRunMock.resolveAnswerRun }));

const CHOICE = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };
const WRITER = { ok: true, run: { agentName: CHOICE.agent, model: CHOICE.model, effort: CHOICE.effort } };
const NO_WRITER = { ok: false, failure: { ok: false, reason: 'no agent is chosen' } };

/** What the launch waits before asking every project (`BRANCH_FULL_READ_DELAY_MS`). */
const LAUNCH_DELAY_MS = 60_000;

let scratch: string;

function folderProject(id: string): Project {
  const folder = path.join(scratch, id);
  fs.mkdirSync(folder, { recursive: true });
  return { id, name: id, path: folder } as unknown as Project;
}

function makeContext(openProjectId: string | null, projects: Project[], options: { summariesOn?: boolean; sourceCode?: boolean } = {}): IpcContext {
  const { summariesOn = true, sourceCode = true } = options;
  return {
    configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: true, enabled: true, agent: 'claude', taskSummaries: summariesOn, sourceCode } }) },
    currentProjectId: openProjectId,
    projectRepo: {
      list: () => projects,
      getById: (projectId: string) => projects.find((project) => project.id === projectId) ?? null,
    },
    sessionManager: new EventEmitter(),
    boardEvents: new BoardEventBus(),
  } as unknown as IpcContext;
}

function requestedProjects(): string[] {
  return summarySchedulerMock.request.mock.calls.map((call) => (call as unknown[])[1] as string);
}

function untilSettled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('task summaries in every project', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-summaries-'));
    vi.clearAllMocks();
    indexState.byProject.clear();
    summarySchedulerMock.status.mockImplementation(() => ({ state: 'idle', retryAtMs: null }));
    summarySchedulerMock.skipped.mockImplementation(() => 0);
    summarySchedulerMock.writtenPerMinute.mockImplementation(() => null);
    answerRunMock.resolveAnswerRun.mockReset();
    answerRunMock.resolveAnswerRun.mockResolvedValue(WRITER);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The launch delay is measured from when the module loads, so the clock is
    // faked first. setImmediate stays real: the worker handlers run on it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe('once a launch', () => {
    // Red-green: before the fix nothing asked a project that was neither open
    // nor moved, so no request reached `other` at all.
    it('asks every project whose folder exists, the open one first, once the launch delay has passed', () => {
      const projects = [folderProject('other'), folderProject('open'), { id: 'moved', name: 'moved', path: path.join(scratch, 'moved-away') } as unknown as Project];
      const context = makeContext('open', projects);
      retrievalService.attach(context);

      vi.advanceTimersByTime(LAUNCH_DELAY_MS - 1_000);
      expect(summarySchedulerMock.request).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_000);
      // A moved folder's database is not migrated this launch; a pass there
      // would only fail and retry on the backoff all launch.
      expect(requestedProjects()).toEqual(['open', 'other']);
    });

    it('asks once, however often the service is attached again', () => {
      const context = makeContext('open', [folderProject('open')]);
      retrievalService.attach(context);
      retrievalService.attach(context);
      vi.advanceTimersByTime(LAUNCH_DELAY_MS * 3);
      expect(requestedProjects()).toEqual(['open']);
    });

    it('asks nothing while summaries are switched off', () => {
      const context = makeContext('open', [folderProject('open'), folderProject('other')], { summariesOn: false });
      retrievalService.attach(context);
      vi.advanceTimersByTime(LAUNCH_DELAY_MS);
      expect(summarySchedulerMock.request).not.toHaveBeenCalled();
    });
  });

  describe('when a writer is resolved where none was', () => {
    // Red-green: before the fix choosing the agent asked only the open project,
    // so a launch whose passes found no writer summarized nothing else until
    // the next launch.
    it('asks every project, once, after the launch delay', async () => {
      const context = makeContext('open', [folderProject('open'), folderProject('other')]);
      vi.advanceTimersByTime(LAUNCH_DELAY_MS);

      // Summaries on, but no agent chosen yet: nothing can write.
      answerRunMock.resolveAnswerRun.mockResolvedValueOnce(NO_WRITER);
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(requestedProjects()).toEqual(['open']);
      summarySchedulerMock.request.mockClear();

      // The agent is chosen: every project, after the reconcile's own request.
      retrievalService.reconcileEmbedWorker(context);
      await vi.waitFor(() => expect(requestedProjects()).toEqual(['open', 'open', 'other']));
      summarySchedulerMock.request.mockClear();

      // Another setting, the same writer: only the reconcile's own request.
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(requestedProjects()).toEqual(['open']);
    });

    it('leaves it to the launch ask before the launch delay has passed', async () => {
      const context = makeContext('open', [folderProject('open'), folderProject('other')]);
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(requestedProjects()).toEqual(['open']);
    });

    it('asks every project again when summaries are switched off and on', async () => {
      const projects = [folderProject('open'), folderProject('other')];
      vi.advanceTimersByTime(LAUNCH_DELAY_MS);
      retrievalService.reconcileEmbedWorker(makeContext('open', projects));
      await untilSettled();
      retrievalService.reconcileEmbedWorker(makeContext('open', projects, { summariesOn: false }));
      await untilSettled();
      summarySchedulerMock.request.mockClear();

      retrievalService.reconcileEmbedWorker(makeContext('open', projects));
      await vi.waitFor(() => expect(requestedProjects()).toEqual(['open', 'open', 'other']));
    });

    // The latch is "the last refresh found a writer". A refresh that finds none
    // clears it, so the writer found after that is a new one, not a settings
    // change that left the same writer in place.
    //
    // Red-green: `refreshFoundWriter = found` in
    // `noteRefreshedWriter`. Remove it and the latch never leaves false, so the
    // second reconcile (the same writer again) asks every project and fails the
    // `['open']` expectation. Make it sticky (`refreshFoundWriter ||= found`)
    // and the last reconcile, after the refresh that found none, asks only the
    // open project and fails the final expectation.
    it('asks every project again when a writer is found after a refresh that found none', async () => {
      const context = makeContext('open', [folderProject('open'), folderProject('other')]);
      vi.advanceTimersByTime(LAUNCH_DELAY_MS);

      retrievalService.reconcileEmbedWorker(context);
      await vi.waitFor(() => expect(requestedProjects()).toEqual(['open', 'open', 'other']));
      summarySchedulerMock.request.mockClear();

      // The same writer again: nothing new was found.
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(requestedProjects()).toEqual(['open']);
      summarySchedulerMock.request.mockClear();

      // A refresh that resolves with no writer.
      answerRunMock.resolveAnswerRun.mockResolvedValueOnce(NO_WRITER);
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(requestedProjects()).toEqual(['open']);
      summarySchedulerMock.request.mockClear();

      // A writer is found where the last refresh found none.
      retrievalService.reconcileEmbedWorker(context);
      await vi.waitFor(() => expect(requestedProjects()).toEqual(['open', 'open', 'other']));
    });

    // A resolve that throws found no writer either, so it must clear the latch
    // the same way.
    //
    // Red-green: `noteRefreshedWriter(context, false)`
    // in the resolve's `.catch`. Remove it and the latch stays set through the
    // failed refresh, so the writer found after it is not new and only the open
    // project is asked.
    it('asks every project again when a writer is found after a resolve that threw', async () => {
      const context = makeContext('open', [folderProject('open'), folderProject('other')]);
      vi.advanceTimersByTime(LAUNCH_DELAY_MS);

      retrievalService.reconcileEmbedWorker(context);
      await vi.waitFor(() => expect(requestedProjects()).toEqual(['open', 'open', 'other']));
      summarySchedulerMock.request.mockClear();

      answerRunMock.resolveAnswerRun.mockRejectedValueOnce(new Error('the agent could not be resolved'));
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(requestedProjects()).toEqual(['open']);
      summarySchedulerMock.request.mockClear();

      retrievalService.reconcileEmbedWorker(context);
      await vi.waitFor(() => expect(requestedProjects()).toEqual(['open', 'open', 'other']));
    });
  });

  describe('the push to an open Knowledge Graph', () => {
    async function statusChanged(): Promise<(projectId: string) => void> {
      const { createSummaryScheduler } = await import('../../src/main/retrieval/summary/summary-scheduler');
      const deps = vi.mocked(createSummaryScheduler).mock.calls.at(-1)?.[0] as { onStatusChanged?: (projectId: string) => void } | undefined;
      if (!deps?.onStatusChanged) throw new Error('the service gave the scheduler no onStatusChanged');
      return deps.onStatusChanged;
    }

    // Every board change asks for a pass, and on a caught-up board the pass is
    // writing for a few milliseconds before the fingerprint skips it. Pushing
    // each of those would re-read the snapshot twice per drag.
    it('says nothing for a pass that ended as it started, and once for a state that holds', async () => {
      const { graphService } = await import('../../src/main/retrieval/graph-facade');
      const onStatusChanged = await statusChanged();

      summarySchedulerMock.status.mockImplementation(() => ({ state: 'writing', retryAtMs: null }));
      onStatusChanged('project');
      summarySchedulerMock.status.mockImplementation(() => ({ state: 'idle', retryAtMs: null }));
      onStatusChanged('project');
      vi.advanceTimersByTime(250);
      expect(graphService.notifyChanged).not.toHaveBeenCalled();

      // A backfill: writing holds past the wait.
      summarySchedulerMock.status.mockImplementation(() => ({ state: 'writing', retryAtMs: null }));
      onStatusChanged('project');
      vi.advanceTimersByTime(250);
      expect(vi.mocked(graphService.notifyChanged).mock.calls).toEqual([['project']]);

      // It ends having passed a task over: the line changes, so it says so.
      summarySchedulerMock.status.mockImplementation(() => ({ state: 'idle', retryAtMs: null }));
      summarySchedulerMock.skipped.mockImplementation(() => 1);
      onStatusChanged('project');
      vi.advanceTimersByTime(250);
      expect(vi.mocked(graphService.notifyChanged).mock.calls).toEqual([['project'], ['project']]);
    });
  });

  describe('the drain the map\'s snapshot asks for', () => {
    /** What `attach` registered with the graph for the snapshot to call. */
    async function registeredListener(context: IpcContext) {
      retrievalService.attach(context);
      const { graphService } = await import('../../src/main/retrieval/graph-facade');
      const listener = vi.mocked(graphService.setOnEmbeddingsWaiting).mock.calls.at(-1)?.[0];
      if (!listener) throw new Error('attach registered no embeddings-waiting listener');
      return listener;
    }

    // The snapshot reads a project nobody opens, so it is the one path that
    // drains it. Nothing else here calls the listener, so a registration that did
    // nothing, or that marked everything, passes every other test.
    //
    // Red-green: `if (worthDraining(...)) embedEngine.markDirty(projectId)` in the
    // listener `attach` registers. Delete the `markDirty` and the conversation
    // case fails. Mark without the `worthDraining` test (or drop its
    // `codePlan(context) === 'index'` part) and the code-off case fails.
    it('marks the project dirty for waiting conversations, and for code only while source code is on', async () => {
      // One attach, one listener, as the app runs: switching source code on later
      // reaches the same listener through the config it reads at each call.
      let sourceCode = false;
      const context = {
        ...makeContext('snapshot-open', [folderProject('snapshot-open')]),
        configManager: {
          load: () => ({ knowledgeGraph: { indexingEnabled: true, enabled: true, agent: 'claude', taskSummaries: true, sourceCode } }),
        },
      } as unknown as IpcContext;
      const listener = await registeredListener(context);

      listener('snapshot-open', ['conversation']);
      expect(embedEngineMock.markDirty).toHaveBeenCalledWith('snapshot-open');
      embedEngineMock.markDirty.mockClear();

      // Code off: its index is cleared on the next open, so draining it first
      // would spend the drain on code the user turned off.
      listener('snapshot-open', ['code']);
      expect(embedEngineMock.markDirty).not.toHaveBeenCalled();

      // Any one corpus worth draining is enough.
      listener('snapshot-open', ['code', 'conversation']);
      expect(embedEngineMock.markDirty).toHaveBeenCalledWith('snapshot-open');
      embedEngineMock.markDirty.mockClear();

      sourceCode = true;
      listener('snapshot-open', ['code']);
      expect(embedEngineMock.markDirty).toHaveBeenCalledWith('snapshot-open');
    });
  });

  describe('the Settings card', () => {
    // The card read `currentProjectId` alone: 683 of 683, checked, while the
    // All projects panel summed 997 of 1,094. Red-green: the old status read
    // the open project only and gave 10 of 10 here.
    it('sums every indexed project\'s summaries with what the scheduler is doing for each', async () => {
      indexState.byProject.set('open', { conversations: 5, conversationChunks: 50, waiting: 0, written: 10, finishedTasks: 10 });
      indexState.byProject.set('behind', { conversations: 2, conversationChunks: 20, waiting: 0, written: 0, finishedTasks: 6 });
      // Done tasks, but no conversations: not one of the projects All projects draws.
      indexState.byProject.set('no-conversations', { conversations: 0, conversationChunks: 0, waiting: 0, written: 0, finishedTasks: 9 });
      summarySchedulerMock.status.mockImplementation((projectId: string) => (
        projectId === 'behind' ? { state: 'writing', retryAtMs: null } : { state: 'idle', retryAtMs: null }
      ));
      summarySchedulerMock.skipped.mockImplementation((projectId: string) => (projectId === 'behind' ? 1 : 0));
      summarySchedulerMock.writtenPerMinute.mockImplementation(() => 5);
      const context = makeContext('open', [folderProject('open'), folderProject('behind'), folderProject('no-conversations')]);

      const status = await retrievalService.getStatus(context);

      expect(status.summaries).toMatchObject({ written: 10, finishedTasks: 16, skipped: 1, state: 'writing' });
      // Five left to write (six behind, one skipped) at five a minute.
      expect(status.summaries?.minutesLeft).toBe(1);
      expect(status.sources?.conversations).toEqual({ count: 7, percent: null, minutesLeft: null });
    });

    it('reads idle while nothing is writing any project, so a project behind reads "N of M" there', async () => {
      indexState.byProject.set('idle-open', { conversations: 5, conversationChunks: 50, waiting: 0, written: 10, finishedTasks: 10 });
      indexState.byProject.set('idle-behind', { conversations: 2, conversationChunks: 20, waiting: 0, written: 0, finishedTasks: 6 });
      const context = makeContext('idle-open', [folderProject('idle-open'), folderProject('idle-behind')]);
      const status = await retrievalService.getStatus(context);
      expect(status.summaries).toMatchObject({ written: 10, finishedTasks: 16, state: 'idle', minutesLeft: null });
    });

    // The worker's status reader keeps each project's totals for half a minute
    // or more, and lives as long as the mocked worker module does, so each case
    // below has project ids of its own.
    it('reads the branch size for the open project only, while no project holds code', async () => {
      indexState.byProject.set('git-open', { conversations: 5, conversationChunks: 50, waiting: 0, written: 0, finishedTasks: 0 });
      indexState.byProject.set('git-other', { conversations: 2, conversationChunks: 20, waiting: 0, written: 0, finishedTasks: 0 });
      await retrievalService.getStatus(makeContext('git-open', [folderProject('git-open'), folderProject('git-other')]));
      expect(branchSizesMock.get.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['git-open']);
    });

    it('reads no branch at all once any project holds code: the index knows its size', async () => {
      indexState.byProject.set('code-open', { conversations: 5, conversationChunks: 50, waiting: 0, written: 0, finishedTasks: 0 });
      indexState.byProject.set('code-other', { conversations: 2, conversationChunks: 20, waiting: 0, written: 0, finishedTasks: 0, code: { files: 40, chunks: 400 } });
      const status = await retrievalService.getStatus(makeContext('code-open', [folderProject('code-open'), folderProject('code-other')]));
      expect(branchSizesMock.get).not.toHaveBeenCalled();
      expect(status.code).toMatchObject({ state: 'ready', files: 40, passages: 400 });
    });

    it('drains a project nobody opened when its passages wait for the selected model', async () => {
      indexState.byProject.set('drain-open', { conversations: 5, conversationChunks: 50, waiting: 0, written: 0, finishedTasks: 0 });
      indexState.byProject.set('drain-elsewhere', { conversations: 2, conversationChunks: 20, waiting: 12, written: 0, finishedTasks: 0 });
      await retrievalService.getStatus(makeContext('drain-open', [folderProject('drain-open'), folderProject('drain-elsewhere')]));
      expect(embedEngineMock.markDirty).toHaveBeenCalledWith('drain-elsewhere');
    });

    // Switched off, a project's code index is cleared on its next open; draining
    // it first would spend the embedding drain on code the user turned off.
    it('does not drain code waiting in a project while source code is switched off, and does while it is on', async () => {
      indexState.byProject.set('codeoff-open', { conversations: 5, conversationChunks: 50, waiting: 0, written: 0, finishedTasks: 0 });
      indexState.byProject.set('codeoff-other', { conversations: 2, conversationChunks: 20, waiting: 0, written: 0, finishedTasks: 0, code: { files: 4, chunks: 40, waiting: 40 } });
      const projects = [folderProject('codeoff-open'), folderProject('codeoff-other')];

      await retrievalService.getStatus(makeContext('codeoff-open', projects, { sourceCode: false }));
      expect(embedEngineMock.markDirty).not.toHaveBeenCalledWith('codeoff-other');

      await retrievalService.getStatus(makeContext('codeoff-open', projects));
      expect(embedEngineMock.markDirty).toHaveBeenCalledWith('codeoff-other');
    });
  });
});
