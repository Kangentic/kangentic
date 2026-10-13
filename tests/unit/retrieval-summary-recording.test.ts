/**
 * retrieval-service.ts: each task-summary batch is one recorded background call.
 *
 * The Knowledge Graph's summary scheduler asks the service for a writer
 * (`resolveWriter`), and the writer's `write(prompt)` runs one batch on the
 * resolved answer agent. That `write` wraps the batch in `startRecordedCall`, so
 * the batch lands in the project's `background_calls` ledger as a `task_summary`
 * call, with the usage the agent reported.
 *
 * The scheduler is a stub whose dependencies the test reads back, the way
 * retrieval-service-status-gates.test.ts and -every-project.test.ts read
 * `onStatusChanged`. That reaches the real `resolveWriter` and `write` closures
 * without running a pass. The scaffolding otherwise mirrors
 * retrieval-service-summary-backoff.test.ts (the real service, a fresh module
 * per test, the electron and native-module imports stubbed). The ledger sink is
 * a spy: the sink's deleted-project skip is pinned in background-calls.test.ts,
 * and agent-summarize-handler.test.ts runs the real sink.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { AgentCallUsage, Project } from '../../src/shared/types';
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

// The ledger write. The service builds one sink per writer from its context;
// the spy takes what the sink would write.
const ledgerMock = vi.hoisted(() => ({ write: vi.fn(), backgroundCallSink: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/background-call-sink', () => ({ backgroundCallSink: ledgerMock.backgroundCallSink }));

/** The slice of the scheduler's dependencies this file drives. */
interface SummaryWriterShape {
  agent: string;
  model: string | null;
  effort: string | null;
  write: (prompt: string) => Promise<string>;
}
interface SchedulerDepsShape {
  resolveWriter: (context: IpcContext, projectId: string) => Promise<SummaryWriterShape | null>;
}

const REPORTED_USAGE: AgentCallUsage = {
  model: 'claude-opus-5-5',
  inputTokens: 16000,
  cacheCreationInputTokens: 2000,
  cacheReadInputTokens: 5000,
  outputTokens: 1500,
  costUsd: 0.074,
};

const PROJECTS = [
  { id: 'proj-a', name: 'proj-a', path: '/mock/proj-a' },
  { id: 'proj-b', name: 'proj-b', path: '/mock/proj-b' },
] as unknown as Project[];

function makeContext(openProjectId: string): IpcContext {
  return {
    configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: true, enabled: true, agent: 'claude', taskSummaries: true } }) },
    currentProjectId: openProjectId,
    projectRepo: {
      list: () => PROJECTS,
      getById: (projectId: string) => PROJECTS.find((project) => project.id === projectId) ?? null,
    },
    sessionManager: new EventEmitter(),
    boardEvents: new BoardEventBus(),
  } as unknown as IpcContext;
}

describe('retrievalService task-summary batches in the background-call ledger', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];
  let schedulerDeps: SchedulerDepsShape;
  let answerFromContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    answerFromContext = vi.fn(async (_prompt: string, _cliPath: string, _answerHome: string, _model: string | null, options: { onUsage: (usage: AgentCallUsage) => void }) => {
      // What an adapter does when its CLI reports a cost.
      options.onUsage(REPORTED_USAGE);
      return 'summaries';
    });
    answerRunMock.resolveAnswerRun.mockReset();
    answerRunMock.resolveAnswerRun.mockResolvedValue({
      ok: true,
      run: {
        agentName: 'claude',
        model: 'claude-opus-5-5',
        effort: 'low',
        cliPath: '/usr/bin/claude',
        answerHome: '/mock/answer-home',
        answerFromContext,
      },
    });
    ledgerMock.write.mockReset();
    ledgerMock.backgroundCallSink.mockReset();
    ledgerMock.backgroundCallSink.mockReturnValue(ledgerMock.write);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The module builds its scheduler at load, so each test gets a fresh one.
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
    const { createSummaryScheduler } = await import('../../src/main/retrieval/summary/summary-scheduler');
    const deps = vi.mocked(createSummaryScheduler).mock.calls.at(-1)?.[0] as unknown as SchedulerDepsShape | undefined;
    if (!deps) throw new Error('retrieval-service did not create its summary scheduler');
    schedulerDeps = deps;
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.restoreAllMocks();
  });

  it('records a batch as one task_summary call in its project\'s ledger, with the usage the agent reported', async () => {
    const context = makeContext('proj-a');
    const writer = await schedulerDeps.resolveWriter(context, 'proj-a');
    if (!writer) throw new Error('no writer resolved');

    await expect(writer.write('the batch prompt')).resolves.toBe('summaries');

    // The sink is built from the context the writer was resolved for.
    expect(ledgerMock.backgroundCallSink).toHaveBeenCalledWith(context);
    expect(ledgerMock.write).toHaveBeenCalledTimes(1);
    const [projectId, record] = ledgerMock.write.mock.calls[0] as [string, Record<string, unknown>];
    expect(projectId).toBe('proj-a');
    expect(record).toMatchObject({
      job: 'task_summary',
      // A batch covers about ten tasks, so the call names none.
      taskId: null,
      swimlaneId: null,
      agent: 'claude',
      requestedModel: 'claude-opus-5-5',
      effort: 'low',
      usage: REPORTED_USAGE,
      outcome: 'succeeded',
    });
  });

  it('hands the agent a usage sink and a run directory with the batch prompt', async () => {
    const writer = await schedulerDeps.resolveWriter(makeContext('proj-a'), 'proj-a');
    if (!writer) throw new Error('no writer resolved');

    await writer.write('the batch prompt');

    expect(answerFromContext).toHaveBeenCalledTimes(1);
    const [prompt, cliPath, answerHome, model, options] = answerFromContext.mock.calls[0] as [string, string, string, string, Record<string, unknown>];
    expect(prompt).toBe('the batch prompt');
    expect(cliPath).toBe('/usr/bin/claude');
    expect(answerHome).toBe('/mock/answer-home');
    expect(model).toBe('claude-opus-5-5');
    expect(options.effort).toBe('low');
    expect(typeof options.runDirectory).toBe('string');
    expect(typeof options.onUsage).toBe('function');
  });

  it('records against the project the writer was resolved for, not the open one', async () => {
    // proj-a is the open project; the pass is for proj-b.
    const writer = await schedulerDeps.resolveWriter(makeContext('proj-a'), 'proj-b');
    if (!writer) throw new Error('no writer resolved');

    await writer.write('the batch prompt');

    expect(ledgerMock.write).toHaveBeenCalledTimes(1);
    expect(ledgerMock.write.mock.calls[0][0]).toBe('proj-b');
  });

  it('leaves the usage null when the agent reports none, and records a failed batch as failed', async () => {
    answerFromContext.mockImplementationOnce(async () => 'summaries');
    answerFromContext.mockImplementationOnce(async () => { throw new Error('the agent exited 1'); });
    const writer = await schedulerDeps.resolveWriter(makeContext('proj-a'), 'proj-a');
    if (!writer) throw new Error('no writer resolved');

    await writer.write('first batch');
    await expect(writer.write('second batch')).rejects.toThrow('the agent exited 1');

    expect(ledgerMock.write).toHaveBeenCalledTimes(2);
    expect(ledgerMock.write.mock.calls[0][1]).toMatchObject({ job: 'task_summary', usage: null, outcome: 'succeeded' });
    expect(ledgerMock.write.mock.calls[1][1]).toMatchObject({ job: 'task_summary', usage: null, outcome: 'failed', detail: 'the agent exited 1' });
  });
});
