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
  indexedCodeBranch: vi.fn(() => null),
}));
vi.mock('../../src/main/retrieval/graph-facade', () => ({
  graphService: {
    notifyChanged: vi.fn(),
    setSummariesSkipped: vi.fn(),
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

function makeContext(openProjectId: string): IpcContext {
  return {
    configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: true, enabled: true, agent: 'claude' } }) },
    currentProjectId: openProjectId,
    projectRepo: {
      list: () => PROJECTS,
      getById: (projectId: string) => PROJECTS.find((project) => project.id === projectId) ?? null,
    },
    sessionManager: new EventEmitter(),
    boardEvents: new BoardEventBus(),
  } as unknown as IpcContext;
}

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
   * Leaves the service holding CHOICE as the resolved summary choice, with the
   * scheduler's counters clear. A fresh module has no choice yet, so this first
   * reconcile is itself a change (none to some) and ends the backoff once; that
   * is cleared here, and what the tests assert is the reconcile after it.
   */
  async function settleOnChoice(context: IpcContext): Promise<void> {
    retrievalService.reconcileEmbedWorker(context);
    await vi.waitFor(() => {
      expect(summarySchedulerMock.endBackoff).toHaveBeenCalledTimes(1);
    });
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

  // These are the guard against over-correcting the two tests above: a real
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
