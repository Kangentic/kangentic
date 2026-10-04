/**
 * retrievalService.getStatus - the KnowledgeGraphStatus the Knowledge Graph settings tab
 * polls.
 *
 * Written for the `workerError` field (DESKTOP-H): when the embedding worker
 * has crashed past its restart cap, the status must carry the policy's reason
 * so the tab can say WHY semantic search is off, not only that it failed.
 * getStatus had no unit coverage before this file; the scaffolding mirrors
 * tests/unit/retrieval-service-finalize-debounce.test.ts (real module, the
 * electron / native-module imports stubbed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));

// The index's half of the status comes from the retrieval worker.
const workerStatus = vi.hoisted(() => ({
  answer: { hasVec: true, vecError: null as string | null, projects: [] } as Record<string, unknown> | null,
  unavailableReason: null as string | null,
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
  retrievalClient: {
    get unavailableReason() { return workerStatus.unavailableReason; },
    call: vi.fn(async () => {
      if (!workerStatus.answer) throw new Error('The retrieval worker exited');
      return workerStatus.answer;
    }),
  },
}));
vi.mock('../../src/main/retrieval/conversation/conversation-indexer', () => ({
  ConversationIndexer: class {
    indexSession = vi.fn(async () => ({}));
  },
}));

const embeddingModelMock = vi.hoisted(() => ({ present: true }));
vi.mock('../../src/main/retrieval/embedder/embedding-model', () => ({
  isEmbeddingModelPresent: vi.fn(() => embeddingModelMock.present),
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
}));
vi.mock('../../src/main/retrieval/embedder/embed-engine', () => ({
  embedEngine: embedEngineMock,
}));

const CRASH_REASON = "exited with code 1: Error: Cannot find module 'onnxruntime-common'";

function makeContext(knowledgeGraph: { indexingEnabled?: boolean; enabled?: boolean }): IpcContext {
  const project = { id: 'proj-1', name: 'One', path: '/mock/one' };
  return {
    configManager: { load: () => ({ knowledgeGraph }) },
    currentProjectId: 'proj-1',
    projectRepo: { list: () => [project], getById: (id: string) => (id === project.id ? project : undefined) },
  } as unknown as IpcContext;
}

describe('retrievalService.getStatus', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    vi.clearAllMocks();
    workerStatus.answer = { hasVec: true, vecError: null, projects: [] };
    workerStatus.unavailableReason = null;
    embeddingModelMock.present = true;
    embedEngineMock.workerCrashed = false;
    embedEngineMock.workerCrashReason = null;
    embedEngineMock.activeDevice = null;
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
  });

  afterEach(() => {
    retrievalService.dispose();
  });

  it('reports semantic error WITH the crash reason once the restart policy has given up', async () => {
    embedEngineMock.workerCrashed = true;
    embedEngineMock.workerCrashReason = CRASH_REASON;

    const status = await retrievalService.getStatus(makeContext({ indexingEnabled: true, enabled: true }));

    expect(status.semantic).toBe('error');
    expect(status.workerError).toBe(CRASH_REASON);
    // A crashed worker must not be re-fed work by the status poll.
    expect(embedEngineMock.markDirty).not.toHaveBeenCalled();
  });

  it('reports semantic error with no reason when the policy has none to give', async () => {
    embedEngineMock.workerCrashed = true;

    const status = await retrievalService.getStatus(makeContext({ indexingEnabled: true, enabled: true }));

    expect(status.semantic).toBe('error');
    expect(status.workerError).toBeUndefined();
  });

  it('carries no workerError while healthy (hybrid), and re-marks the project dirty as before', async () => {
    embedEngineMock.activeDevice = 'dml';

    const status = await retrievalService.getStatus(makeContext({ indexingEnabled: true, enabled: true }));

    expect(status.semantic).toBe('hybrid');
    expect(status.workerError).toBeUndefined();
    expect(status.activeBackend).toBe('DirectML (GPU)');
    expect(embedEngineMock.markDirty).toHaveBeenCalledWith('proj-1');
  });

  it('carries no workerError when semantic search is off, even if an old crash is on record', async () => {
    embedEngineMock.workerCrashed = true;
    embedEngineMock.workerCrashReason = CRASH_REASON;

    const status = await retrievalService.getStatus(makeContext({ indexingEnabled: true, enabled: false }));

    expect(status.semantic).toBe('disabled');
    expect(status.workerError).toBeUndefined();
  });

  it('reads keywords only, with the load error, when the worker\'s connection has no sqlite-vec', async () => {
    workerStatus.answer = { hasVec: false, vecError: 'vec0.dll: the specified module could not be found', projects: [] };

    const status = await retrievalService.getStatus(makeContext({ indexingEnabled: true, enabled: true }));

    expect(status.semantic).toBe('lexical');
    expect(status.vecError).toBe('vec0.dll: the specified module could not be found');
  });

  it('reads keywords only, with the worker\'s own reason, while the retrieval worker is down', async () => {
    workerStatus.answer = null;
    workerStatus.unavailableReason = 'The retrieval worker stopped (exited with code 1)';

    const status = await retrievalService.getStatus(makeContext({ indexingEnabled: true, enabled: true }));

    expect(status.semantic).toBe('lexical');
    expect(status.vecError).toBe('The retrieval worker stopped (exited with code 1)');
    expect(status.sources).toBeUndefined();
  });
});
