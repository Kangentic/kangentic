/**
 * retrievalService.reconcileEmbedWorker - what ends a summary failure backoff.
 *
 * A failed summary call waits out a backoff before it is tried again. A new
 * agent, model or effort may be what fixes the failed call, so a CHANGE of the
 * resolved summary choice ends the backoff at once. Anything else that lands in
 * `reconcileEmbedWorker` (a project open or switch, an unrelated Knowledge
 * Graph setting) leaves it in place: the same failing call would only run again
 * and fail again.
 *
 * The scaffolding mirrors tests/unit/retrieval-service-rebuild.test.ts (the real
 * service, a fresh module per test, the electron and native-module imports
 * stubbed). The summary scheduler is a stub that records `request` and
 * `endBackoff`, and `resolveAnswerRun` is a stub the test settles by hand, since
 * "after the choice refresh resolves" is part of the behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';
import { BoardEventBus } from '../../src/main/mobile-bridge/board-event-bus';

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn((projectId: string) => ({ projectId })),
}));
vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));
// Indexing runs in the retrieval worker; its handlers run here, in process,
// against the store and sweeper stubs below.
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
vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    resetIndexState(): void {}
    reconcileVecOrphans(): void {}
  },
}));
vi.mock('../../src/main/retrieval/summary/summary-store', () => ({
  SummaryStore: class {
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
  skipped: vi.fn(() => 0),
  status: vi.fn(() => ({ state: 'idle', retryAtMs: null })),
  writtenPerMinute: vi.fn(() => null),
}));
vi.mock('../../src/main/retrieval/summary/summary-scheduler', () => ({
  createSummaryScheduler: vi.fn(() => summarySchedulerMock),
}));

const answerRunMock = vi.hoisted(() => ({ resolveAnswerRun: vi.fn() }));
vi.mock('../../src/main/retrieval/answer-run', () => ({ resolveAnswerRun: answerRunMock.resolveAnswerRun }));

interface SummaryChoiceShape {
  agent: string;
  model: string | null;
  effort: string | null;
}

const CHOICE: SummaryChoiceShape = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };

/** What `resolveAnswerRun` answers for a run that resolved to `choice`. */
function resolved(choice: SummaryChoiceShape) {
  return { ok: true, run: { agentName: choice.agent, model: choice.model, effort: choice.effort } };
}

function makeProject(id: string): Project {
  return { id, name: id, path: `/mock/${id}` } as unknown as Project;
}

/** The two projects are both registered, so a switch between them is a real one. */
const PROJECTS = [makeProject('proj-a'), makeProject('proj-b')];

/** `summariesOn: false` is the Knowledge Graph's task summaries switch, which
 *  `summariesEnabled` reads (`taskSummaries: false`). */
function makeContext(openProjectId: string, options: { summariesOn?: boolean } = {}): IpcContext {
  const { summariesOn = true } = options;
  return {
    configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: true, enabled: true, agent: 'claude', taskSummaries: summariesOn } }) },
    currentProjectId: openProjectId,
    projectRepo: {
      list: () => PROJECTS,
      getById: (projectId: string) => PROJECTS.find((project) => project.id === projectId) ?? null,
    },
    sessionManager: new EventEmitter(),
    boardEvents: new BoardEventBus(),
  } as unknown as IpcContext;
}

/** What `resolveAnswerRun` answers when no writer can be resolved (the CLI is
 *  missing, no agent is chosen): `ok: false`, with the failure it reports. */
const NO_WRITER = { ok: false, failure: { ok: false, reason: 'the agent CLI was not found' } };

/**
 * Hold the NEXT `resolveAnswerRun` call until the returned function settles it,
 * so the test controls when the choice refresh resolves, and with what.
 */
function holdNextResolution(): (choice: SummaryChoiceShape) => void {
  let settle: (value: unknown) => void = () => undefined;
  const pending = new Promise<unknown>((resolve) => { settle = resolve; });
  answerRunMock.resolveAnswerRun.mockImplementationOnce(() => pending);
  return (choice) => settle(resolved(choice));
}

/** One macrotask: the choice refresh and its follow-up are promise callbacks and
 *  no timer, so by the time this resolves they have all run. Used to assert that
 *  something did NOT happen, which cannot be polled for. */
function untilSettled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('retrievalService.reconcileEmbedWorker and the summary failure backoff', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  /**
   * Leaves the service holding CHOICE as the resolved summary choice for the
   * context's project, with the scheduler's counters clear. A fresh module has
   * no choice for the project yet, so this first reconcile is a project open,
   * not a settings change, and leaves the backoff alone; what the tests assert
   * is the reconcile after it.
   */
  async function settleOnChoice(context: IpcContext): Promise<void> {
    retrievalService.reconcileEmbedWorker(context);
    await vi.waitFor(() => {
      expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(1);
    });
    await untilSettled();
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    summarySchedulerMock.endBackoff.mockClear();
    summarySchedulerMock.request.mockClear();
    answerRunMock.resolveAnswerRun.mockClear();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    answerRunMock.resolveAnswerRun.mockReset();
    answerRunMock.resolveAnswerRun.mockResolvedValue(resolved(CHOICE));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The module holds `summaryChoice` and `disposed` as singleton state, so each
    // test gets a fresh instance.
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.restoreAllMocks();
  });

  // Red-green: before the fix every reconcile ended the backoff, so a project
  // open or an unrelated setting kept re-running a call that was still failing.
  // `sameSummaryChoice` is what keeps it in place; make it return false (or end
  // the backoff unconditionally) and `endBackoff` is called here, and the
  // `request` count below becomes 2.
  it('leaves the backoff in place when the resolved choice is the same, and still asks for a pass', async () => {
    const context = makeContext('proj-a');
    await settleOnChoice(context);
    const release = holdNextResolution();

    retrievalService.reconcileEmbedWorker(context);
    release(CHOICE);
    await untilSettled();

    // The choice WAS re-read (so the silence below is a comparison that came out
    // equal, not a refresh that never ran), and the backoff stands.
    expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(1);
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    // The reconcile's own request, for the open project, and nothing after it.
    expect(summarySchedulerMock.request.mock.calls).toEqual([[context, 'proj-a']]);
  });

  it('leaves the backoff in place for the same choice when another project becomes the open one', async () => {
    await settleOnChoice(makeContext('proj-a'));
    const switched = makeContext('proj-b');
    const release = holdNextResolution();

    retrievalService.reconcileEmbedWorker(switched);
    release(CHOICE);
    await untilSettled();

    expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(1);
    expect(answerRunMock.resolveAnswerRun.mock.calls[0][1]).toBe('proj-b');
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    expect(summarySchedulerMock.request.mock.calls).toEqual([[switched, 'proj-b']]);
  });

  // A project that has no resolved choice of its own has nothing to compare
  // with, so what another project resolved to is not a baseline for it.
  //
  // Red-green: compare against ONE global previous choice (what the code did
  // before `resolvedSummaryChoices` was keyed by project). proj-a settled on
  // CHOICE, so proj-b's first resolve to a different choice would read as a
  // change and call `endBackoff` for a project that never had a choice to
  // change. With `hasBaseline` (or the per-project map) it stays uncalled.
  it('does not end the backoff for a project whose first resolve differs from the previous project\'s choice', async () => {
    await settleOnChoice(makeContext('proj-a'));
    const switched = makeContext('proj-b');
    const release = holdNextResolution();

    retrievalService.reconcileEmbedWorker(switched);
    release({ ...CHOICE, agent: 'codex' });
    await untilSettled();

    expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(1);
    expect(answerRunMock.resolveAnswerRun.mock.calls[0][1]).toBe('proj-b');
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    expect(summarySchedulerMock.request.mock.calls).toEqual([[switched, 'proj-b']]);

    // The first resolve is now proj-b's own baseline: a later change of choice
    // for proj-b is a real change, which shows the silence above was the missing
    // baseline and not a project that can never end its backoff.
    const releaseSecond = holdNextResolution();
    retrievalService.reconcileEmbedWorker(switched);
    releaseSecond({ ...CHOICE, agent: 'gemini' });
    await vi.waitFor(() => {
      expect(summarySchedulerMock.endBackoff).toHaveBeenCalledTimes(1);
    });
    expect(summarySchedulerMock.endBackoff.mock.calls).toEqual([['proj-b']]);
  });

  // Two reconciles overlap on one project (a settings change lands while the
  // first refresh is still reading), and both resolve to the SAME choice. The
  // first reconcile was superseded: its refresh result is dropped and the
  // second reconcile makes the comparison. Neither may end the backoff.
  //
  // Red-green: this goes red only with BOTH `generation !== summaryChoiceGeneration`
  // and `summaryChoice === null` gone from the follow-up. The second reconcile
  // nulls `summaryChoice` before its refresh lands, so the first reconcile's
  // follow-up, which runs between the two releases, would compare the baseline
  // CHOICE against that null, see a difference, and call `endBackoff`. Either
  // line alone returns before the comparison, so neither is pinned by this test
  // on its own. The generation guard is pinned by the test further down (the
  // newer refresh lands first, on a new writer). The assertion between the two
  // releases is the one that goes red; it must come before the second release,
  // or the second refresh writes CHOICE first and hides the bug.
  it('ends no backoff when two overlapping reconciles on one project resolve to the same choice', async () => {
    const context = makeContext('proj-a');
    await settleOnChoice(context);
    const releaseFirst = holdNextResolution();
    retrievalService.reconcileEmbedWorker(context);
    const releaseSecond = holdNextResolution();
    retrievalService.reconcileEmbedWorker(context);

    // The first refresh resolves while the second is still reading.
    releaseFirst(CHOICE);
    await untilSettled();
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();

    releaseSecond(CHOICE);
    await untilSettled();

    expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(2);
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    // One request per reconcile and nothing after them: a wrongly ended
    // backoff asks for the pass again.
    expect(summarySchedulerMock.request.mock.calls).toEqual([[context, 'proj-a'], [context, 'proj-a']]);
  });

  // Two reconciles overlap on one project and the NEWER refresh lands first, on
  // a different writer: that reconcile's follow-up ends the backoff, once. The
  // older refresh then lands on the baseline's writer. Its result is dropped,
  // and its follow-up must not compare either: by then `summaryChoice` holds the
  // newer writer, which differs from the older reconcile's baseline, so a
  // comparison would read as a second change.
  //
  // Red-green: drop `generation !== summaryChoiceGeneration` from the follow-up.
  // The older reconcile's follow-up then runs after the newer one's, finds
  // `summaryChoice` non-null (codex) and different from its CHOICE baseline, and
  // calls `endBackoff` a second time (and `request` a fourth). The
  // `summaryChoice === null` line cannot save it here, because the newer refresh
  // has already filled `summaryChoice`. The releases are in this order for that
  // reason: newer first with the changed writer, older last.
  it('ends the backoff once when the newer of two overlapping reconciles lands first on a new writer', async () => {
    const context = makeContext('proj-a');
    await settleOnChoice(context);
    const releaseFirst = holdNextResolution();
    retrievalService.reconcileEmbedWorker(context);
    const releaseSecond = holdNextResolution();
    retrievalService.reconcileEmbedWorker(context);

    releaseSecond({ ...CHOICE, agent: 'codex' });
    await vi.waitFor(() => {
      expect(summarySchedulerMock.endBackoff).toHaveBeenCalledTimes(1);
    });
    await untilSettled();

    releaseFirst(CHOICE);
    await untilSettled();

    expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(2);
    expect(summarySchedulerMock.endBackoff.mock.calls).toEqual([['proj-a']]);
    // One request per reconcile, and the one the newer follow-up makes once its
    // backoff has ended. The superseded follow-up asks for nothing.
    expect(summarySchedulerMock.request.mock.calls).toEqual([[context, 'proj-a'], [context, 'proj-a'], [context, 'proj-a']]);
  });

  // A reconcile that ends with NO writer (summaries switched off, a refresh that
  // rejected, a resolve that returned `ok: false`) is not a new writer. Only a
  // resolved writer is a baseline, and only a resolved writer is compared with it.
  //
  // Two lines in `retrieval-service.ts` carry this, and each case below fails on
  // its own one:
  //  - `summaryChoice === null` in the follow-up of `reconcileEmbedWorker`. Drop
  //    it and the reconcile that ends with no writer compares the baseline
  //    against null, sees a difference, and ends the backoff.
  //  - `if (summaryChoice)` before `resolvedSummaryChoices.set` in
  //    `refreshSummaryChoice`. Make the write unconditional and an `ok: false`
  //    stores null as the project's baseline, so the NEXT reconcile, resolving
  //    the very writer it had before, reads as a change.
  describe('a reconcile that ends with no writer', () => {
    // Red-green: drop `summaryChoice === null` from the follow-up. The first
    // reconcile (summaries off, so nothing is resolved and `summaryChoice` stays
    // null) then ends the backoff, and the first `endBackoff` assertion fails.
    // The second half holds against the baseline being replaced while off.
    it('ends no backoff when summaries are switched off and on again with the same writer', async () => {
      const summariesOn = makeContext('proj-a');
      await settleOnChoice(summariesOn);

      retrievalService.reconcileEmbedWorker(makeContext('proj-a', { summariesOn: false }));
      await untilSettled();
      // Off, no writer is resolved at all, so the silence below is the guard on
      // a missing writer and not a resolve that came out equal.
      expect(answerRunMock.resolveAnswerRun).not.toHaveBeenCalled();
      expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();

      const release = holdNextResolution();
      retrievalService.reconcileEmbedWorker(summariesOn);
      release(CHOICE);
      await untilSettled();

      expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(1);
      expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    });

    // Red-green: drop `summaryChoice === null` from the follow-up. The rejected
    // refresh leaves `summaryChoice` null (its `catch`), which then compares
    // against the baseline CHOICE as a change, and the first assertion fails.
    it('ends no backoff when a refresh rejects, nor when the next one resolves the same writer', async () => {
      const context = makeContext('proj-a');
      await settleOnChoice(context);
      answerRunMock.resolveAnswerRun.mockRejectedValueOnce(new Error('the settings could not be read'));

      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(1);
      expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();

      // Resolves CHOICE (the suite's default): the baseline is still CHOICE.
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(2);
      expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    });

    // Red-green, two lines. Drop `summaryChoice === null` from the follow-up and
    // the first assertion fails (the `ok: false` reconcile ends the backoff).
    // Make the `resolvedSummaryChoices.set` unconditional and the SECOND fails:
    // null is stored as the baseline, and CHOICE then reads as a change.
    it('ends no backoff when a resolve returns no writer, nor when the next one resolves the same writer', async () => {
      const context = makeContext('proj-a');
      await settleOnChoice(context);
      answerRunMock.resolveAnswerRun.mockResolvedValueOnce(NO_WRITER);

      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(1);
      expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();

      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(2);
      expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    });

    // Control for the three above, so their silence is not a backoff that can
    // never end after a failure. A DIFFERENT writer after an `ok: false` is a
    // real change and ends it once, which needs the earlier baseline to have
    // survived the failure. It fails if a failed resolve deletes the baseline
    // (`hasBaseline` goes false). It passes against the code before the fix, so
    // the three tests above are the ones that pin it: what the failed reconcile
    // itself did is cleared before the reconcile this one is about.
    it('control: still ends the backoff once for a different writer after a resolve that returned none', async () => {
      const context = makeContext('proj-a');
      await settleOnChoice(context);
      answerRunMock.resolveAnswerRun.mockResolvedValueOnce(NO_WRITER);
      retrievalService.reconcileEmbedWorker(context);
      await untilSettled();
      summarySchedulerMock.endBackoff.mockClear();

      const release = holdNextResolution();
      retrievalService.reconcileEmbedWorker(context);
      release({ ...CHOICE, agent: 'codex' });
      await vi.waitFor(() => {
        expect(summarySchedulerMock.endBackoff).toHaveBeenCalledTimes(1);
      });
      await untilSettled();

      expect(summarySchedulerMock.endBackoff.mock.calls).toEqual([['proj-a']]);
    });
  });

  // Two reconciles overlap and the OLDER one's refresh lands last, with a stale
  // writer. The newer reconcile owns the choice, so that late result must change
  // neither `summaryChoice` nor the project's baseline.
  //
  // Red-green: drop `if (generation !== summaryChoiceGeneration) return;` from
  // the `then` of `refreshSummaryChoice`. The stale codex result then lands
  // after CHOICE and is stored as the baseline, so the third reconcile, which
  // resolves CHOICE again, reads as a change and ends the backoff: that last
  // `endBackoff` assertion is the one that goes red. (The guard on the follow-up
  // does not cover this: it only stops the superseded reconcile from comparing,
  // not the superseded refresh from writing.) The releases are in this order
  // for that reason: the newer refresh first, so the stale one overwrites it.
  it('does not let a stale refresh that lands late replace the writer a newer one resolved', async () => {
    const context = makeContext('proj-a');
    await settleOnChoice(context);
    const releaseFirst = holdNextResolution();
    retrievalService.reconcileEmbedWorker(context);
    const releaseSecond = holdNextResolution();
    retrievalService.reconcileEmbedWorker(context);

    releaseSecond(CHOICE);
    await untilSettled();
    releaseFirst({ ...CHOICE, agent: 'codex' });
    await untilSettled();
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();

    // A later reconcile on the same project, resolving CHOICE: the baseline it
    // is compared with is the newer refresh's CHOICE, so nothing changed.
    retrievalService.reconcileEmbedWorker(context);
    await untilSettled();

    expect(answerRunMock.resolveAnswerRun).toHaveBeenCalledTimes(3);
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    expect(summarySchedulerMock.request.mock.calls).toEqual([[context, 'proj-a'], [context, 'proj-a'], [context, 'proj-a']]);
  });

  // These are the guard against over-correcting the tests above: a real
  // change must still end the backoff. They fail if the backoff is never ended,
  // if `sameSummaryChoice` ignores a field (compare only the agent and the model
  // and effort rows stay uncalled), or if it ends before the refresh resolves
  // (the "not yet" assertion). They pass against the old end-on-every-reconcile
  // code, which is why the same-choice tests are the ones that pin the fix.
  it.each([
    ['agent', { ...CHOICE, agent: 'codex' }],
    ['model', { ...CHOICE, model: 'claude-haiku-5' }],
    ['effort', { ...CHOICE, effort: 'high' }],
  ])('ends the backoff once, after the choice refresh resolves, when the %s changed', async (_field, changed) => {
    const context = makeContext('proj-a');
    await settleOnChoice(context);
    const release = holdNextResolution();

    retrievalService.reconcileEmbedWorker(context);
    // The refresh is still reading the settings: the choice is not known to
    // have changed, so the backoff stands. The pass is asked for at once.
    await untilSettled();
    expect(summarySchedulerMock.endBackoff).not.toHaveBeenCalled();
    expect(summarySchedulerMock.request).toHaveBeenCalledTimes(1);

    release(changed);
    await vi.waitFor(() => {
      expect(summarySchedulerMock.endBackoff).toHaveBeenCalledTimes(1);
    });
    await untilSettled();

    expect(summarySchedulerMock.endBackoff.mock.calls).toEqual([['proj-a']]);
    // Asked for again once the backoff has ended, so the pass runs at once.
    expect(summarySchedulerMock.request.mock.calls).toEqual([[context, 'proj-a'], [context, 'proj-a']]);
    const [endedAt] = summarySchedulerMock.endBackoff.mock.invocationCallOrder;
    const [, askedAgainAt] = summarySchedulerMock.request.mock.invocationCallOrder;
    expect(endedAt).toBeLessThan(askedAgainAt);
  });
});
