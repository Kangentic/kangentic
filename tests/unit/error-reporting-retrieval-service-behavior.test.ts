/**
 * What a user loses if these reports go quiet: an indexing job whose own code
 * throws stops the index updating for what it covered, and an embedding model
 * that never reaches disk leaves the Knowledge Graph without search by meaning.
 * Both used to leave one log line and nothing else
 * (`src/main/retrieval/retrieval-service.ts`).
 *
 * Each case runs the real service through `attach` or `startForProject`, makes
 * one dependency fail, and reads the call that reached `reportHandledError`:
 * source `retrieval_service`, its `stage`, and that no user text left with it.
 *
 * The negatives matter as much. What the retrieval worker answers is judged
 * where its reply lands (`reportFailedCall` in `retrieval-client.ts`), so a
 * refusal it threw on purpose must not be filed again from the job chain, and a
 * host that did not serve the model file is not a defect.
 *
 * The service is re-imported per test (`vi.resetModules`): its reporter latches
 * a key once per run, and its job chain and timers are module state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';
import { BoardEventBus } from '../../src/main/mobile-bridge/board-event-bus';
import { ModelDownloadUnavailableError } from '../../src/main/transcription/models/download-model';
import { reportedText as sharedReportedText } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

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

// The selected model is never on disk here, so a project open with semantic
// search on always starts the download the case scripts.
const modelDownload = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('../../src/main/retrieval/embedder/embedding-model', () => ({
  isEmbeddingModelPresent: vi.fn(() => false),
  downloadEmbeddingModel: modelDownload.download,
}));
// Not the machine's answer: the local model does not load on Intel macOS.
vi.mock('../../src/main/retrieval/embedder/embedding-runtime-support', () => ({
  isLocalEmbeddingSupported: () => true,
}));

/** A task title, in every failing value, so a report that carried the value would carry it. */
const USER_TEXT = 'Fix Acme billing';
/** What `scheduleLiveIndex` waits after a turn settles (`LIVE_INDEX_DEBOUNCE_MS`). */
const LIVE_INDEX_DEBOUNCE_MS = 1_500;
const PROJECT_ID = 'proj-1';
const SESSION_ID = 'sess-1';

/** The SessionManager surface the service reads, over a real EventEmitter so `attach` wires as written. */
class FakeSessionManager extends EventEmitter {
  getSession(_sessionId: string): { transient?: boolean; workflowId?: string } | undefined {
    return {};
  }

  getSessionProjectId(_sessionId: string): string | undefined {
    return PROJECT_ID;
  }

  remoteTranscriptSettled(_sessionId: string): Promise<void> | null {
    return null;
  }
}

function makeContext(sessionManager: FakeSessionManager, semanticOn: boolean): IpcContext {
  return {
    sessionManager,
    boardEvents: new BoardEventBus(),
    configManager: { load: () => ({ knowledgeGraph: { indexingEnabled: true, enabled: semanticOn } }) },
    currentProjectId: PROJECT_ID,
    projectRepo: {
      list: () => [],
      getById: (projectId: string) => ({ id: projectId, name: projectId, path: path.join(os.tmpdir(), projectId) }),
    },
  } as unknown as IpcContext;
}

function openProject(): Project {
  return { id: PROJECT_ID, name: PROJECT_ID, path: path.join(os.tmpdir(), 'kangentic-retrieval-report', PROJECT_ID) } as unknown as Project;
}

function answerFor(method: string): unknown {
  switch (method) {
    case 'archive.sweep': return { archived: 0, purged: 0 };
    case 'archive.session': return { outcome: 'archived' };
    case 'transcripts.convertLegacy': return { converted: 0, bytes: 0, moved: 0 };
    default: return {};
  }
}

/** Everything the reports carried, as text, so user text cannot hide in any field. */
const reportedText = (): string => sharedReportedText(reportHandledError);

/** The one report that was sent: its source and stage, and no user text. */
function expectOneReport(stage: string, errorName: string): void {
  expect(reportHandledError.mock.calls.map((call) => (call[1] as Record<string, string>).stage)).toEqual([stage]);
  expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'retrieval_service', stage, error_name: errorName });
  expect(reportedText()).not.toMatch(/acme/i);
}

/** The first argument of every `console.warn`, to prove a failure reached its handler. */
function warnedLines(): string[] {
  return vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
}

describe('retrieval service reports', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];
  let sessionManager: FakeSessionManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    reportHandledError.mockReset();
    embedEngineMock.markDirty.mockReset();
    modelDownload.download.mockReset();
    modelDownload.download.mockResolvedValue(undefined);
    clientMock.call.mockReset();
    clientMock.call.mockImplementation(async (method: string) => answerFor(method));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
    sessionManager = new FakeSessionManager();
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('an indexing job on the serial chain (stage job)', () => {
    /** One settled turn: the live index job runs after its debounce, and the chain drains. */
    async function runLiveIndexJob(): Promise<void> {
      retrievalService.attach(makeContext(sessionManager, false));
      sessionManager.emit('activity', SESSION_ID, 'idle');
      await vi.advanceTimersByTimeAsync(LIVE_INDEX_DEBOUNCE_MS + 10);
    }

    function failWorkerCall(method: string, failure: Error): void {
      clientMock.call.mockImplementation(async (calledMethod: string) => {
        if (calledMethod === method) throw failure;
        return answerFor(calledMethod);
      });
    }

    // Guards the `retrievalServiceReporter.report(...)` call in `chain`'s
    // rejection handler: without it the defect leaves only the log line.
    it('reports a runtime defect thrown by main\'s own job code, after the worker answered', async () => {
      embedEngineMock.markDirty.mockImplementation(() => {
        throw new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}')`);
      });

      await runLiveIndexJob();

      // The control: the worker did answer, so the throw is main's.
      expect(clientMock.call.mock.calls.map((call) => call[0])).toContain('index.session');
      expectOneReport('job', 'TypeError');
      expect(warnedLines()).toContain('[retrieval] job failed:');
    });

    // Guards the `isRuntimeDefect(error)` check in the same handler: without it
    // the refusal, a plain `Error`, is filed as a defect. A worker that is down
    // is an expected class, so the reporter skips that one either way.
    it.each([
      ['a refusal the worker threw on purpose', new Error(`Project ${USER_TEXT} was closed for deletion`)],
      ['a worker that is down', Object.assign(new Error('The retrieval worker exited'), { name: 'RetrievalUnavailableError' })],
    ])('reports nothing for %s', async (_label, failure) => {
      failWorkerCall('index.session', failure);

      await runLiveIndexJob();

      // The control: the failure did reach the chain's handler.
      expect(warnedLines()).toContain('[retrieval] job failed:');
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('does not send a worker defect again once the reply\'s own report marked it', async () => {
      // What `reportFailedCall` leaves on a failed reply before it rejects the call.
      const { markReported } = await import('../../src/main/analytics/handled-report');
      const workerDefect = new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}')`);
      markReported(workerDefect);
      failWorkerCall('index.session', workerDefect);

      await runLiveIndexJob();

      expect(warnedLines()).toContain('[retrieval] job failed:');
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('the embedding model download (stage model_download)', () => {
    /** A project open with semantic search on and no model on disk, which starts the download. */
    async function openWithModelMissing(): Promise<void> {
      retrievalService.startForProject(makeContext(sessionManager, true), openProject());
      await vi.advanceTimersByTimeAsync(10);
    }

    // Guards the `retrievalServiceReporter.report(...)` call in
    // `ensureModelDownload`'s rejection handler.
    it('reports a file the host no longer has, and nothing of its address', async () => {
      modelDownload.download.mockRejectedValue(
        new Error('Download failed (404) for https://models.example.test/fix-acme-billing/model.onnx'),
      );

      await openWithModelMissing();

      expect(modelDownload.download).toHaveBeenCalledTimes(1);
      expectOneReport('model_download', 'Error');
      expect(warnedLines()).toContain('[retrieval] embedding model download failed:');
    });

    it('reports nothing when the host did not serve the file', async () => {
      modelDownload.download.mockRejectedValue(
        new ModelDownloadUnavailableError('Timed out downloading https://models.example.test/fix-acme-billing/model.onnx'),
      );

      await openWithModelMissing();

      // The control: the download ran and its failure reached the handler.
      expect(modelDownload.download).toHaveBeenCalledTimes(1);
      expect(warnedLines()).toContain('[retrieval] embedding model download failed:');
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports nothing when the download lands', async () => {
      await openWithModelMissing();

      expect(modelDownload.download).toHaveBeenCalledTimes(1);
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });
});
