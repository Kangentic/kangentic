/**
 * retrievalService.getStatus - the MemoryStatus the Memory tab and the Quick
 * Find palette poll.
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
vi.mock('../../src/main/retrieval/vec-extension', () => ({
  lastVecLoadError: vi.fn(() => null),
  loadVecExtension: vi.fn(() => false),
}));
vi.mock('../../src/main/retrieval/vec-support', () => ({ hasVecSupport: vi.fn(() => true) }));
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

function makeContext(memory: { indexingEnabled?: boolean; semanticEnabled?: boolean }): IpcContext {
  return {
    configManager: { load: () => ({ memory }) },
    currentProjectId: 'proj-1',
  } as unknown as IpcContext;
}

describe('retrievalService.getStatus', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];

  beforeEach(async () => {
    vi.clearAllMocks();
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

  it('reports semantic error WITH the crash reason once the restart policy has given up', () => {
    embedEngineMock.workerCrashed = true;
    embedEngineMock.workerCrashReason = CRASH_REASON;

    const status = retrievalService.getStatus(makeContext({ indexingEnabled: true, semanticEnabled: true }));

    expect(status.semantic).toBe('error');
    expect(status.workerError).toBe(CRASH_REASON);
    // A crashed worker must not be re-fed work by the status poll.
    expect(embedEngineMock.markDirty).not.toHaveBeenCalled();
  });

  it('reports semantic error with no reason when the policy has none to give', () => {
    embedEngineMock.workerCrashed = true;

    const status = retrievalService.getStatus(makeContext({ indexingEnabled: true, semanticEnabled: true }));

    expect(status.semantic).toBe('error');
    expect(status.workerError).toBeUndefined();
  });

  it('carries no workerError while healthy (hybrid), and re-marks the project dirty as before', () => {
    embedEngineMock.activeDevice = 'dml';

    const status = retrievalService.getStatus(makeContext({ indexingEnabled: true, semanticEnabled: true }));

    expect(status.semantic).toBe('hybrid');
    expect(status.workerError).toBeUndefined();
    expect(status.activeBackend).toBe('DirectML (GPU)');
    expect(embedEngineMock.markDirty).toHaveBeenCalledWith('proj-1');
  });

  it('carries no workerError when semantic search is off, even if an old crash is on record', () => {
    embedEngineMock.workerCrashed = true;
    embedEngineMock.workerCrashReason = CRASH_REASON;

    const status = retrievalService.getStatus(makeContext({ indexingEnabled: true, semanticEnabled: false }));

    expect(status.semantic).toBe('disabled');
    expect(status.workerError).toBeUndefined();
  });
});
