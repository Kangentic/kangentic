/**
 * How `retrievalService` (main side, `src/main/retrieval/retrieval-service.ts`)
 * schedules the transcript archive that runs in the retrieval worker.
 *
 * Two jobs, neither gated on the Knowledge Graph indexing switch, since the
 * archive keeps a conversation readable after the agent CLI deletes its file
 * and is not search:
 *  - `scheduleArchive`: one `archive.session` call per session after a turn
 *    settles (activity), a suspend (session-changed) or an exit, behind a
 *    per-session trailing debounce, never for a Command Terminal or a
 *    workflow's own agent (neither has a session record);
 *  - `scheduleArchiveSweep`: one `archive.sweep` call on project open.
 *
 * Driven through the real `retrievalService.attach` / `startForProject` seams
 * with a fake EventEmitter session manager and fake timers. The retrieval
 * client is a plain mock, so the worker's own handlers never run: these tests
 * pin what main asks the worker for, and when.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';
import { BoardEventBus } from '../../src/main/mobile-bridge/board-event-bus';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

const clientMock = vi.hoisted(() => ({
  on: vi.fn(),
  call: vi.fn(),
  notifyRunning: vi.fn(),
  closeProject: vi.fn(async () => undefined),
  unavailableReason: null as string | null,
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
  retrievalClient: clientMock,
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

/** What the debounces in retrieval-service.ts wait: after a suspend or exit, and after a turn settles. */
const FINALIZE_DEBOUNCE_MS = 3_500;
const LIVE_INDEX_DEBOUNCE_MS = 1_500;

interface FakeSessionRecord {
  transient?: boolean;
  workflowId?: string;
}

/** The SessionManager surface `scheduleArchive` reads, over a real EventEmitter so `attach` wires as written. */
class FakeSessionManager extends EventEmitter {
  private readonly projectIdBySession = new Map<string, string>();
  private readonly recordBySession = new Map<string, FakeSessionRecord>();

  registerSession(sessionId: string, projectId: string, record: FakeSessionRecord = {}): void {
    this.projectIdBySession.set(sessionId, projectId);
    this.recordBySession.set(sessionId, record);
  }

  /** A session that left the registry, as an exited one can before its timer fires. */
  unregisterSession(sessionId: string): void {
    this.projectIdBySession.delete(sessionId);
    this.recordBySession.delete(sessionId);
  }

  getSession(sessionId: string): FakeSessionRecord | undefined {
    return this.recordBySession.get(sessionId);
  }

  getSessionProjectId(sessionId: string): string | undefined {
    return this.projectIdBySession.get(sessionId);
  }
}

interface ContextOptions {
  indexingEnabled?: boolean;
  currentProjectId?: string | null;
}

function makeContext(sessionManager: FakeSessionManager, options: ContextOptions = {}): IpcContext {
  const { indexingEnabled = true, currentProjectId = null } = options;
  return {
    sessionManager,
    boardEvents: new BoardEventBus(),
    configManager: { load: () => ({ knowledgeGraph: { indexingEnabled } }) },
    currentProjectId,
    projectRepo: {
      list: () => [],
      getById: (projectId: string) => ({ id: projectId, name: projectId, path: path.join(os.tmpdir(), projectId) }),
    },
  } as unknown as IpcContext;
}

/** A project row for `startForProject`, which reads only its id and path. */
function projectNamed(projectId: string): Project {
  return { id: projectId, name: projectId, path: path.join(os.tmpdir(), 'kangentic-archive-scheduling', projectId) } as unknown as Project;
}

function callsTo(method: string): unknown[][] {
  return clientMock.call.mock.calls.filter((call) => call[0] === method);
}

function answerFor(method: string): unknown {
  switch (method) {
    case 'archive.sweep': return { archived: 0, purged: 0 };
    case 'archive.session': return { outcome: 'archived' };
    case 'transcripts.convertLegacy': return { converted: 0, bytes: 0, moved: 0 };
    default: return {};
  }
}

/** A promise held open until the test settles it, to keep the job chain busy. */
function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('retrievalService archive scheduling', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];
  let sessionManager: FakeSessionManager;
  /** Methods whose call stays open until the test resolves it. */
  let held: Map<string, Promise<unknown>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    held = new Map();
    clientMock.call.mockImplementation(async (method: string) => held.get(method) ?? answerFor(method));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The module holds `attached`, `disposed` and its timer maps as singleton
    // state, so each test gets a fresh instance.
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
    sessionManager = new FakeSessionManager();
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('archiving a session', () => {
    // Red-green: the `scheduleArchive(...)` call in the 'session-changed'
    // listener of `attach`. Delete it and no archive call is made.
    it('archives a suspended session once, after the finalize debounce, with its project and no call budget', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-1', 'proj-1');

      sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS - 1);
      expect(callsTo('archive.session')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(callsTo('archive.session')).toEqual([[
        'archive.session',
        { projectId: 'proj-1', sessionId: 'sess-1', remoteTargets: expect.anything() },
        // A background job: the client's own 15 s budget would restart the worker mid-walk.
        { timeoutMs: null },
      ]]);
    });

    it('ignores a session-changed report that is not a suspend', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-1', 'proj-1');

      sessionManager.emit('session-changed', 'sess-1', { status: 'running' });
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS * 2);
      expect(callsTo('archive.session')).toHaveLength(0);

      // The control: the same wiring does archive a suspend.
      sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS);
      expect(callsTo('archive.session')).toHaveLength(1);
    });

    // Red-green: the `scheduleArchive(...)` call in the 'exit' listener.
    it('archives an exited session after the finalize debounce', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-1', 'proj-1');

      sessionManager.emit('exit', 'sess-1');
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS - 1);
      expect(callsTo('archive.session')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(callsTo('archive.session').map((call) => call[1])).toEqual([
        { projectId: 'proj-1', sessionId: 'sess-1', remoteTargets: expect.anything() },
      ]);
    });

    // Red-green: the `scheduleArchive(...)` call in the 'activity' listener.
    it('archives a session once its turn settles (idle or permission), sooner than a finalize', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-idle', 'proj-1');
      sessionManager.registerSession('sess-permission', 'proj-1');
      sessionManager.registerSession('sess-thinking', 'proj-1');

      sessionManager.emit('activity', 'sess-idle', 'idle');
      sessionManager.emit('activity', 'sess-permission', 'permission');
      sessionManager.emit('activity', 'sess-thinking', 'thinking');
      await vi.advanceTimersByTimeAsync(LIVE_INDEX_DEBOUNCE_MS - 1);
      expect(callsTo('archive.session')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      // A working agent has not finished a turn, so only the two that paused are archived.
      const archivedSessions = callsTo('archive.session').map((call) => (call[1] as { sessionId: string }).sessionId);
      expect(archivedSessions.sort()).toEqual(['sess-idle', 'sess-permission']);
    });

    // Red-green: `clearTimeout(existing)` in `scheduleArchive`. Delete it and
    // the first report's timer still fires, so two calls are made.
    it('makes one call for two reports of one session, and waits from the later one', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-1', 'proj-1');

      // One suspend reports twice, the second after the graceful PTY shutdown.
      sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });
      await vi.advanceTimersByTimeAsync(2_900);
      sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });

      // Past the first report's debounce, short of the second's.
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS - 2_900 + 100);
      expect(callsTo('archive.session')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2_900);
      expect(callsTo('archive.session')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS * 2);
      expect(callsTo('archive.session')).toHaveLength(1);
    });

    it('makes one call when a turn report and a suspend report arrive for the same session', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-1', 'proj-1');

      sessionManager.emit('activity', 'sess-1', 'idle');
      sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS * 2);

      expect(callsTo('archive.session')).toHaveLength(1);
    });

    it('debounces per session: two sessions each get their own call', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-a', 'proj-a');
      sessionManager.registerSession('sess-b', 'proj-b');

      sessionManager.emit('session-changed', 'sess-a', { status: 'suspended' });
      sessionManager.emit('exit', 'sess-b');
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS);

      const archived = callsTo('archive.session').map((call) => call[1] as { projectId: string; sessionId: string });
      expect(archived.map((params) => [params.projectId, params.sessionId]).sort()).toEqual([
        ['proj-a', 'sess-a'],
        ['proj-b', 'sess-b'],
      ]);
    });

    // Red-green: the `session?.transient || session?.workflowId` guard in
    // `scheduleArchive`. Delete it and both are archived.
    it('skips a Command Terminal and a workflow\'s own agent, which have no session record', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-terminal', 'proj-1', { transient: true });
      sessionManager.registerSession('sess-workflow', 'proj-1', { workflowId: 'workflow-1' });
      sessionManager.registerSession('sess-task', 'proj-1');

      sessionManager.emit('exit', 'sess-terminal');
      sessionManager.emit('exit', 'sess-workflow');
      sessionManager.emit('exit', 'sess-task');
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS);

      // The task's session is the control that the wiring ran.
      expect(callsTo('archive.session').map((call) => (call[1] as { sessionId: string }).sessionId)).toEqual(['sess-task']);
    });

    it('skips a session that belongs to no project', async () => {
      retrievalService.attach(makeContext(sessionManager));

      sessionManager.emit('exit', 'sess-unknown');
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS);

      expect(callsTo('archive.session')).toHaveLength(0);
    });

    // Red-green: the `getSessionProjectId` read in `scheduleArchive`. Move it
    // into the timer (an exited session has left the registry by then) and the
    // call carries no project.
    it('reads the project when it schedules, since an exited session can leave the registry before the timer fires', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-1', 'proj-1');

      sessionManager.emit('exit', 'sess-1');
      sessionManager.unregisterSession('sess-1');
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS);

      expect(callsTo('archive.session').map((call) => call[1])).toEqual([
        { projectId: 'proj-1', sessionId: 'sess-1', remoteTargets: expect.anything() },
      ]);
    });

    // Red-green: put `|| !isIndexingEnabled(context)` in front of
    // `scheduleArchive`'s early return and the archive stops with indexing off.
    it('runs with the indexing switch off, while the index itself does not', async () => {
      retrievalService.attach(makeContext(sessionManager, { indexingEnabled: false }));
      sessionManager.registerSession('sess-suspended', 'proj-1');
      sessionManager.registerSession('sess-turn', 'proj-1');

      sessionManager.emit('session-changed', 'sess-suspended', { status: 'suspended' });
      sessionManager.emit('activity', 'sess-turn', 'idle');
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS);

      const archivedSessions = callsTo('archive.session').map((call) => (call[1] as { sessionId: string }).sessionId);
      expect(archivedSessions.sort()).toEqual(['sess-suspended', 'sess-turn']);
      // The index is what the switch stops.
      expect(callsTo('index.session')).toHaveLength(0);
    });

    it('runs beside the index when indexing is on', async () => {
      retrievalService.attach(makeContext(sessionManager, { indexingEnabled: true }));
      sessionManager.registerSession('sess-1', 'proj-1');

      sessionManager.emit('exit', 'sess-1');
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS);

      expect(callsTo('archive.session')).toHaveLength(1);
      expect(callsTo('index.session')).toHaveLength(1);
    });

    // Red-green: the `if (disposed) return;` at the top of `scheduleArchive`.
    // Delete it and a report after dispose arms a timer.
    it('schedules nothing after dispose, and dispose drops a timer already armed', async () => {
      retrievalService.attach(makeContext(sessionManager));
      sessionManager.registerSession('sess-1', 'proj-1');
      sessionManager.registerSession('sess-2', 'proj-1');

      sessionManager.emit('exit', 'sess-1');
      retrievalService.dispose();
      expect(vi.getTimerCount()).toBe(0);

      sessionManager.emit('exit', 'sess-2');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(FINALIZE_DEBOUNCE_MS * 2);
      expect(callsTo('archive.session')).toHaveLength(0);
    });
  });

  describe('the project-open archive pass', () => {
    // Red-green: the `scheduleArchiveSweep(context, project.id)` in the
    // indexing-disabled branch of `startForProject`. Delete it and no sweep
    // runs with indexing off.
    it('sweeps on project open with the indexing switch off, and starts no index sweep', async () => {
      const context = makeContext(sessionManager, { indexingEnabled: false, currentProjectId: 'proj-1' });

      retrievalService.startForProject(context, projectNamed('proj-1'));
      await vi.advanceTimersByTimeAsync(10);

      expect(callsTo('archive.sweep')).toEqual([[
        'archive.sweep',
        { projectId: 'proj-1', jobId: expect.stringMatching(/^archive-\d+$/), remoteTargets: expect.anything() },
        { timeoutMs: null },
      ]]);
      // The control that the indexing-off branch ran: no index sweep did.
      expect(callsTo('index.sweep')).toHaveLength(0);
    });

    it('sweeps after the index sweep, on the same job chain, when indexing is on', async () => {
      const context = makeContext(sessionManager, { indexingEnabled: true, currentProjectId: 'proj-1' });

      retrievalService.startForProject(context, projectNamed('proj-1'));
      await vi.advanceTimersByTimeAsync(10);

      const order = clientMock.call.mock.calls
        .map((call) => call[0] as string)
        .filter((method) => method === 'index.sweep' || method === 'archive.sweep');
      expect(order).toEqual(['index.sweep', 'archive.sweep']);
    });

    it('logs what a sweep archived and purged', async () => {
      const context = makeContext(sessionManager, { indexingEnabled: false, currentProjectId: 'proj-1' });
      clientMock.call.mockImplementation(async (method: string) => (
        method === 'archive.sweep' ? { archived: 3, purged: 2 } : answerFor(method)
      ));

      retrievalService.startForProject(context, projectNamed('proj-1'));
      await vi.advanceTimersByTimeAsync(10);

      expect(vi.mocked(console.log).mock.calls.map((call) => String(call[0]))).toContain('[retrieval] archived 3 conversations, purged 2');
    });

    it('says nothing for a sweep that archived and purged nothing', async () => {
      const context = makeContext(sessionManager, { indexingEnabled: false, currentProjectId: 'proj-1' });

      retrievalService.startForProject(context, projectNamed('proj-1'));
      await vi.advanceTimersByTimeAsync(10);

      // The control: the sweep did run.
      expect(callsTo('archive.sweep')).toHaveLength(1);
      expect(vi.mocked(console.log).mock.calls.some((call) => String(call[0]).startsWith('[retrieval] archived'))).toBe(false);
    });

    // Red-green: the `context.currentProjectId !== projectId` half of the guard
    // at the top of `scheduleArchiveSweep`'s job. Delete it and the sweep runs
    // for a project the user already left.
    it('does not sweep a project the user left before the job chain reached it', async () => {
      const configState = { indexingEnabled: true };
      const context = {
        ...makeContext(sessionManager, { currentProjectId: 'proj-1' }),
        configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: configState.indexingEnabled } }) },
      } as unknown as IpcContext;

      // Keep the job chain busy with a record sweep, then open the project with
      // indexing off so its only job is the archive sweep, queued behind it.
      const recordSweep = deferred<unknown>();
      held.set('index.sweep', recordSweep.promise);
      retrievalService.refreshRecords(context, 'proj-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(callsTo('index.sweep')).toHaveLength(1);
      configState.indexingEnabled = false;
      retrievalService.startForProject(context, projectNamed('proj-1'));
      await vi.advanceTimersByTimeAsync(10);
      expect(callsTo('archive.sweep')).toHaveLength(0);

      // The user opens another project while the record sweep is still running.
      (context as { currentProjectId: string | null }).currentProjectId = 'proj-2';
      recordSweep.resolve({});
      await vi.advanceTimersByTimeAsync(10);

      expect(callsTo('archive.sweep')).toHaveLength(0);
    });

    // Red-green: the `jobId` handed to `archive.sweep`. Drop it and a project
    // switch has nothing to cancel.
    it('cancels the running archive sweep by the job id it was started with when another project opens', async () => {
      const archiveSweep = deferred<unknown>();
      held.set('archive.sweep', archiveSweep.promise);
      const context = makeContext(sessionManager, { indexingEnabled: false, currentProjectId: 'proj-1' });

      retrievalService.startForProject(context, projectNamed('proj-1'));
      await vi.advanceTimersByTimeAsync(10);
      const sweepParams = callsTo('archive.sweep')[0]?.[1] as { jobId: string } | undefined;
      expect(sweepParams?.jobId).toMatch(/^archive-\d+$/);

      (context as { currentProjectId: string | null }).currentProjectId = 'proj-2';
      retrievalService.startForProject(context, projectNamed('proj-2'));

      expect(clientMock.notifyRunning).toHaveBeenCalledWith('job.cancel', { jobId: sweepParams?.jobId });
      archiveSweep.resolve({ archived: 0, purged: 0 });
      await vi.advanceTimersByTimeAsync(10);
    });
  });
});
