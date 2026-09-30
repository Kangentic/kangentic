/**
 * retrievalService.rebuildEverything - the Knowledge Graph tab's Rebuild.
 *
 * Rebuild is one action for every registered project. Each project forgets what
 * its sources were read from (`resetIndexState`, never the chunks) and has its
 * summaries written with another agent or model marked for rewriting. Only the
 * OPEN project is read again now (a sweep runs for the open project alone, so
 * the rest are read again on their next open, from the state cleared here),
 * and that read includes the source code corpus.
 *
 * The scaffolding mirrors tests/unit/retrieval-service-finalize-debounce.test.ts
 * (the real service, a fresh module per test, the electron and native-module
 * imports stubbed). The stores and every sweeper are stubs that record which
 * project each call was for, since which projects were touched is the behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';
import { BoardEventBus } from '../../src/main/mobile-bridge/board-event-bus';

const unopenableProjects = vi.hoisted(() => new Set<string>());
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn((projectId: string) => {
    if (unopenableProjects.has(projectId)) throw new Error(`cannot open ${projectId}`);
    return { projectId };
  }),
}));
vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));
// Indexing and Rebuild run in the retrieval worker; its handlers run here, in
// process, against the store and sweeper mocks below.
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

const conversationIndexerMock = vi.hoisted(() => ({ sweepProject: vi.fn(async () => undefined) }));
vi.mock('../../src/main/retrieval/conversation/conversation-indexer', () => ({
  ConversationIndexer: class {
    sweepProject = conversationIndexerMock.sweepProject;
    purgeDeletedSessions = vi.fn(async () => 0);
    indexSession = vi.fn(async () => ({}));
    indexSubagentUsage = vi.fn(async () => 'indexed');
  },
}));

const sweepers = vi.hoisted(() => ({
  sweepTaskRecords: vi.fn(async (_projectId: string) => ({ indexed: 0, removed: 0 })),
  sweepChangeRecords: vi.fn(async (_projectId: string) => ({ indexed: 0 })),
  sweepCommitRecords: vi.fn(async (_projectId: string) => ({ indexed: 0, removed: 0, relinked: 0, deferred: false })),
  sweepCodeRecords: vi.fn(async (_projectId: string) => ({ indexed: 0, removed: 0, deferred: false })),
  purgeCodeRecords: vi.fn(() => false),
}));
vi.mock('../../src/main/retrieval/task/task-indexer', () => ({ sweepTaskRecords: sweepers.sweepTaskRecords }));
vi.mock('../../src/main/retrieval/change/change-indexer', () => ({ sweepChangeRecords: sweepers.sweepChangeRecords }));
vi.mock('../../src/main/retrieval/commit/commit-indexer', () => ({ sweepCommitRecords: sweepers.sweepCommitRecords }));
vi.mock('../../src/main/retrieval/code/code-indexer', () => ({
  sweepCodeRecords: sweepers.sweepCodeRecords,
  purgeCodeRecords: sweepers.purgeCodeRecords,
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

/** What each project's stores were asked, in the order asked. */
const storeCalls = vi.hoisted(() => ({
  resets: [] as string[],
  rewrites: [] as Array<{ projectId: string; choice: { agent: string; model: string | null; effort: string | null } }>,
  /** How many summaries each project's `markForRewrite` reports marking. */
  markedByProject: new Map<string, number>(),
}));
vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    private readonly projectId: string;
    constructor(db: { projectId: string }) {
      this.projectId = db.projectId;
    }
    resetIndexState(): void {
      storeCalls.resets.push(this.projectId);
    }
    reconcileVecOrphans(): void {}
  },
}));
vi.mock('../../src/main/retrieval/summary/summary-store', () => ({
  SummaryStore: class {
    private readonly projectId: string;
    constructor(db: { projectId: string }) {
      this.projectId = db.projectId;
    }
    markForRewrite(choice: { agent: string; model: string | null; effort: string | null }): number {
      storeCalls.rewrites.push({ projectId: this.projectId, choice });
      return storeCalls.markedByProject.get(this.projectId) ?? 0;
    }
  },
}));

const summarySchedulerMock = vi.hoisted(() => ({
  invalidate: vi.fn(),
  request: vi.fn(),
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

const CHOICE = { agent: 'claude', model: 'claude-opus-5-5', effort: 'low' };

function makeProject(id: string): Project {
  return { id, name: id, path: `/mock/${id}` } as unknown as Project;
}

interface ContextOptions {
  openProjectId: string | null;
  projects: Project[];
  knowledgeGraph?: Record<string, unknown>;
}

function makeContext(options: ContextOptions): IpcContext {
  const { openProjectId, projects, knowledgeGraph = { indexingEnabled: true, enabled: true, agent: 'claude' } } = options;
  return {
    configManager: { load: () => ({ knowledgeGraph }) },
    currentProjectId: openProjectId,
    projectRepo: {
      list: () => projects,
      getById: (projectId: string) => projects.find((project) => project.id === projectId) ?? null,
    },
    sessionManager: new EventEmitter(),
    boardEvents: new BoardEventBus(),
  } as unknown as IpcContext;
}

/** Every project id a sweeper (or the conversation sweep) was called with. */
function sweptProjects(): string[] {
  return [
    ...conversationIndexerMock.sweepProject.mock.calls.map((call) => call[0] as string),
    ...sweepers.sweepTaskRecords.mock.calls.map((call) => call[0]),
    ...sweepers.sweepChangeRecords.mock.calls.map((call) => call[0]),
    ...sweepers.sweepCommitRecords.mock.calls.map((call) => call[0]),
    ...sweepers.sweepCodeRecords.mock.calls.map((call) => call[0]),
  ];
}

/** The open project's sweep runs on the job chain and ends by flagging it for embedding. */
async function untilSweptProject(projectId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(embedEngineMock.markDirty).toHaveBeenCalledWith(projectId);
  });
}

describe('retrievalService.rebuildEverything', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    unopenableProjects.clear();
    storeCalls.resets.length = 0;
    storeCalls.rewrites.length = 0;
    storeCalls.markedByProject.clear();
    answerRunMock.resolveAnswerRun.mockResolvedValue({
      ok: true,
      run: { agentName: CHOICE.agent, model: CHOICE.model, effort: CHOICE.effort },
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The module holds `disposed` and the sweep guard as singleton state, so each
    // test gets a fresh instance.
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.restoreAllMocks();
  });

  it('forgets what every registered project was read from, not just the open one', async () => {
    const projects = [makeProject('proj-a'), makeProject('proj-b'), makeProject('proj-c')];

    await retrievalService.rebuildEverything(makeContext({ openProjectId: 'proj-b', projects }));

    expect(storeCalls.resets).toEqual(['proj-a', 'proj-b', 'proj-c']);
    // A caught-up board would fingerprint as unchanged, so each project's summary pass is told to look again.
    expect(summarySchedulerMock.invalidate.mock.calls.map((call) => call[0])).toEqual(['proj-a', 'proj-b', 'proj-c']);
  });

  it('carries on past a project that will not open', async () => {
    const projects = [makeProject('proj-a'), makeProject('proj-b'), makeProject('proj-c')];
    unopenableProjects.add('proj-b');

    await retrievalService.rebuildEverything(makeContext({ openProjectId: 'proj-a', projects }));

    expect(storeCalls.resets).toEqual(['proj-a', 'proj-c']);
    expect(summarySchedulerMock.invalidate.mock.calls.map((call) => call[0])).toEqual(['proj-a', 'proj-c']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proj-b'), expect.anything());
  });

  it('marks the stale summaries in every project for rewriting, and reports the total', async () => {
    const projects = [makeProject('proj-a'), makeProject('proj-b'), makeProject('proj-c')];
    storeCalls.markedByProject.set('proj-a', 2);
    storeCalls.markedByProject.set('proj-b', 0);
    storeCalls.markedByProject.set('proj-c', 5);

    const plan = await retrievalService.rebuildEverything(makeContext({ openProjectId: 'proj-a', projects }));

    expect(plan).toEqual({ summariesToRewrite: 7 });
    // Each is judged against what a summary would be written with now.
    expect(storeCalls.rewrites).toEqual([
      { projectId: 'proj-a', choice: CHOICE },
      { projectId: 'proj-b', choice: CHOICE },
      { projectId: 'proj-c', choice: CHOICE },
    ]);
  });

  it('still reads everything again, and rewrites nothing, while task summaries are off', async () => {
    const projects = [makeProject('proj-a'), makeProject('proj-b')];
    storeCalls.markedByProject.set('proj-a', 3);
    const knowledgeGraph = { indexingEnabled: true, enabled: true, agent: 'claude', taskSummaries: false };

    const plan = await retrievalService.rebuildEverything(makeContext({ openProjectId: 'proj-a', projects, knowledgeGraph }));

    expect(plan).toEqual({ summariesToRewrite: 0 });
    expect(storeCalls.resets).toEqual(['proj-a', 'proj-b']);
    expect(storeCalls.rewrites).toEqual([]);
  });

  it('reads only the open project again now, its source code included', async () => {
    const projects = [makeProject('proj-a'), makeProject('proj-b'), makeProject('proj-c')];

    await retrievalService.rebuildEverything(makeContext({ openProjectId: 'proj-b', projects }));
    await untilSweptProject('proj-b');

    // The chain ran to its end, so nothing more is queued for the others.
    expect(sweptProjects().length).toBeGreaterThan(0);
    expect(new Set(sweptProjects())).toEqual(new Set(['proj-b']));
    // The code corpus is among what is read again: Rebuild never clears it, it refills it.
    expect(sweepers.sweepCodeRecords).toHaveBeenCalledTimes(1);
    expect(sweepers.sweepCodeRecords.mock.calls[0]?.[0]).toBe('proj-b');
    expect(sweepers.purgeCodeRecords).not.toHaveBeenCalled();
    // And its summaries are asked for, its neighbours' are not: they wait for their next open.
    expect(summarySchedulerMock.request.mock.calls.map((call) => call[1])).toContain('proj-b');
    expect(summarySchedulerMock.request.mock.calls.map((call) => call[1])).not.toContain('proj-a');
    expect(summarySchedulerMock.request.mock.calls.map((call) => call[1])).not.toContain('proj-c');
  });

  it('starts no read when no project is open, though every project is still reset', async () => {
    const projects = [makeProject('proj-a'), makeProject('proj-b')];

    await retrievalService.rebuildEverything(makeContext({ openProjectId: null, projects }));
    // Intentional fixed wait: a read that was going to start would be scheduled
    // on the next turn of the event loop, and there is nothing to poll for.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(storeCalls.resets).toEqual(['proj-a', 'proj-b']);
    expect(sweptProjects()).toEqual([]);
  });

  it('does nothing once the service has been shut down', async () => {
    const projects = [makeProject('proj-a')];
    retrievalService.dispose();

    const plan = await retrievalService.rebuildEverything(makeContext({ openProjectId: 'proj-a', projects }));

    expect(plan).toEqual({ summariesToRewrite: 0 });
    expect(storeCalls.resets).toEqual([]);
  });
});

/**
 * A record sweep runs on the serial job chain, and a board-change or startup
 * timer can queue one for a project that is deleted before the job gets its
 * turn. Opening that project's database would create an empty one again, so the
 * job asks whether the project still exists when it RUNS, not when it was queued.
 * `refreshRecords` is the plain public way to queue one.
 */
describe('retrievalService.refreshRecords', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    vi.clearAllMocks();
    unopenableProjects.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.restoreAllMocks();
  });

  it('skips a project deleted before its queued sweep runs, and still sweeps a registered one', async () => {
    const context = makeContext({ openProjectId: 'proj-a', projects: [makeProject('proj-a')] });

    // The jobs run in order, so by the time the registered project's sweep
    // starts, the deleted project's job has already had its turn.
    retrievalService.refreshRecords(context, 'proj-deleted');
    retrievalService.refreshRecords(context, 'proj-a');
    await vi.waitFor(() => {
      expect(sweepers.sweepTaskRecords).toHaveBeenCalledWith('proj-a', expect.any(Function));
    });

    expect(sweepers.sweepTaskRecords.mock.calls.map((call) => call[0])).toEqual(['proj-a']);
    expect(sweptProjects()).not.toContain('proj-deleted');
  });

  it('still sweeps when the project repository cannot say whether the project exists', async () => {
    const context = makeContext({ openProjectId: 'proj-a', projects: [makeProject('proj-a')] });
    (context.projectRepo as unknown as { getById: () => never }).getById = () => {
      throw new Error('repository unavailable');
    };

    retrievalService.refreshRecords(context, 'proj-a');
    await vi.waitFor(() => {
      expect(sweepers.sweepTaskRecords).toHaveBeenCalledWith('proj-a', expect.any(Function));
    });
  });
});
