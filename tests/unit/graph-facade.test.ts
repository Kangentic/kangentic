import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { EventEmitter } from 'node:events';
import type { KnowledgeGraphBuildProgress, KnowledgeGraphSnapshotWire } from '../../src/shared/types';

/**
 * Main's side of the Knowledge Graph map (`retrieval/graph-facade.ts`): the
 * worker's `event` relay (a `graph-progress` with its progress reaches the
 * build-progress listener, a `graph-changed` reaches the changed listener, and
 * neither reaches the other), the `respawned` re-read of every registered
 * project, the one-time subscription to the shared client, and the calls it
 * sends with the two settings the worker cannot read (`summaryNamesOn`,
 * `summariesSkipped`). `retrievalClient` is stubbed as a bare emitter with a
 * `call` spy, so nothing here exercises the client or the worker. The facade
 * keeps a `subscribed` latch and module-level listeners, so each test imports
 * a fresh copy of it.
 */

/** The slice of `retrievalClient` the facade touches, as the stub exposes it. */
interface FakeRetrievalClient extends EventEmitter {
  call: Mock<(method: string, params: unknown) => Promise<unknown>>;
}

vi.mock('../../src/main/retrieval/retrieval-client', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  const retrievalClient = Object.assign(new NodeEventEmitter(), { call: vi.fn() });
  return { retrievalClient };
});

const PROJECT_ID = 'project-1';
const MODEL_TAG = 'test-model';
const DIMENSIONS = 384;
const FIRST_BUILD_PROGRESS: KnowledgeGraphBuildProgress = { pass: 3, stage: 'placing', percent: 42 };

/**
 * A fresh facade over a clean client stub. The mock factory's stub outlives
 * `vi.resetModules()`, so its listeners and `call` history are cleared here,
 * which also drops the subscriptions an earlier test's facade copy left on it.
 */
async function loadFacade() {
  vi.resetModules();
  const { retrievalClient } = await import('../../src/main/retrieval/retrieval-client');
  const client = retrievalClient as unknown as FakeRetrievalClient;
  client.removeAllListeners();
  client.call.mockReset();
  const { graphService } = await import('../../src/main/retrieval/graph-facade');
  return { graphService, client };
}

describe('graphService worker event relay', () => {
  it('delivers a graph-progress event with its progress to the build-progress listener as (projectId, progress)', async () => {
    const { graphService, client } = await loadFacade();
    const onBuildProgress = vi.fn<(projectId: string, progress: KnowledgeGraphBuildProgress) => void>();
    graphService.setOnBuildProgress(onBuildProgress);

    client.emit('event', 'graph-progress', PROJECT_ID, FIRST_BUILD_PROGRESS);

    expect(onBuildProgress).toHaveBeenCalledTimes(1);
    expect(onBuildProgress).toHaveBeenCalledWith(PROJECT_ID, FIRST_BUILD_PROGRESS);
  });

  it('does not call the changed listener for a graph-progress event', async () => {
    const { graphService, client } = await loadFacade();
    const onChanged = vi.fn<(projectId: string) => void>();
    const onBuildProgress = vi.fn<(projectId: string, progress: KnowledgeGraphBuildProgress) => void>();
    graphService.setOnChanged(onChanged);
    graphService.setOnBuildProgress(onBuildProgress);

    client.emit('event', 'graph-progress', PROJECT_ID, FIRST_BUILD_PROGRESS);

    expect(onBuildProgress).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('ignores a graph-progress event that carries no progress', async () => {
    const { graphService, client } = await loadFacade();
    const onChanged = vi.fn<(projectId: string) => void>();
    const onBuildProgress = vi.fn<(projectId: string, progress: KnowledgeGraphBuildProgress) => void>();
    graphService.setOnChanged(onChanged);
    graphService.setOnBuildProgress(onBuildProgress);

    client.emit('event', 'graph-progress', PROJECT_ID);
    client.emit('event', 'graph-progress', PROJECT_ID, undefined);

    expect(onBuildProgress).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('delivers a graph-changed event to the changed listener and not to the build-progress listener', async () => {
    const { graphService, client } = await loadFacade();
    const onChanged = vi.fn<(projectId: string) => void>();
    const onBuildProgress = vi.fn<(projectId: string, progress: KnowledgeGraphBuildProgress) => void>();
    graphService.setOnChanged(onChanged);
    graphService.setOnBuildProgress(onBuildProgress);

    client.emit('event', 'graph-changed', PROJECT_ID);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(PROJECT_ID);
    expect(onBuildProgress).not.toHaveBeenCalled();
  });

  it('ignores a worker event while no listener is registered for it', async () => {
    const { graphService, client } = await loadFacade();
    const onChanged = vi.fn<(projectId: string) => void>();
    graphService.setOnChanged(onChanged);

    expect(() => client.emit('event', 'graph-progress', PROJECT_ID, FIRST_BUILD_PROGRESS)).not.toThrow();

    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('graphService subscription to the retrieval client', () => {
  it('subscribes once when both setters register, so one event is delivered once', async () => {
    const { graphService, client } = await loadFacade();
    const onChanged = vi.fn<(projectId: string) => void>();
    const onBuildProgress = vi.fn<(projectId: string, progress: KnowledgeGraphBuildProgress) => void>();

    graphService.setOnBuildProgress(onBuildProgress);
    graphService.setOnChanged(onChanged);

    expect(client.listenerCount('event')).toBe(1);
    expect(client.listenerCount('respawned')).toBe(1);
    client.emit('event', 'graph-changed', PROJECT_ID);
    client.emit('event', 'graph-progress', PROJECT_ID, FIRST_BUILD_PROGRESS);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onBuildProgress).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe until a listener is registered', async () => {
    const { client } = await loadFacade();

    expect(client.listenerCount('event')).toBe(0);
    expect(client.listenerCount('respawned')).toBe(0);
  });

  it('replaces the previous listener when a setter is called again (last writer wins)', async () => {
    const { graphService, client } = await loadFacade();
    const staleOnChanged = vi.fn<(projectId: string) => void>();
    const currentOnChanged = vi.fn<(projectId: string) => void>();

    graphService.setOnChanged(staleOnChanged);
    graphService.setOnChanged(currentOnChanged);
    client.emit('event', 'graph-changed', PROJECT_ID);

    expect(staleOnChanged).not.toHaveBeenCalled();
    expect(currentOnChanged).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('event')).toBe(1);
  });

  it('re-reads every registered project when the worker respawns', async () => {
    const { graphService, client } = await loadFacade();
    const onChanged = vi.fn<(projectId: string) => void>();
    graphService.setProjectIds(() => ['project-a', 'project-b']);
    graphService.setOnChanged(onChanged);

    client.emit('respawned');

    expect(onChanged.mock.calls).toEqual([['project-a'], ['project-b']]);
  });
});

describe('graphService.notifyChanged', () => {
  it('announces the project to the changed listener without a worker event', async () => {
    const { graphService, client } = await loadFacade();
    const onChanged = vi.fn<(projectId: string) => void>();
    graphService.setOnChanged(onChanged);

    graphService.notifyChanged(PROJECT_ID);

    expect(onChanged).toHaveBeenCalledWith(PROJECT_ID);
    expect(client.call).not.toHaveBeenCalled();
  });
});

describe('graphService.markDirty', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves to the first build progress the worker answers with', async () => {
    const { graphService, client } = await loadFacade();
    client.call.mockResolvedValue(FIRST_BUILD_PROGRESS);

    const progress = await graphService.markDirty(PROJECT_ID, MODEL_TAG, DIMENSIONS);

    expect(progress).toEqual(FIRST_BUILD_PROGRESS);
  });

  it('resolves to null when the worker answers null (no first build runs)', async () => {
    const { graphService, client } = await loadFacade();
    client.call.mockResolvedValue(null);

    const progress = await graphService.markDirty(PROJECT_ID, MODEL_TAG, DIMENSIONS);

    expect(progress).toBeNull();
  });

  it('resolves to null, and does not reject, when the call rejects', async () => {
    const { graphService, client } = await loadFacade();
    client.call.mockRejectedValue(new Error('The retrieval worker is restarting'));

    await expect(graphService.markDirty(PROJECT_ID, MODEL_TAG, DIMENSIONS)).resolves.toBeNull();

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('sends graph.refresh with the project, model tag, dimensions and summaryNamesOn false by default', async () => {
    const { graphService, client } = await loadFacade();
    client.call.mockResolvedValue(null);

    await graphService.markDirty(PROJECT_ID, MODEL_TAG, DIMENSIONS);

    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith('graph.refresh', {
      projectId: PROJECT_ID,
      modelTag: MODEL_TAG,
      dimensions: DIMENSIONS,
      summaryNamesOn: false,
    });
  });

  it('sends summaryNamesOn as the provider reads it at call time', async () => {
    const { graphService, client } = await loadFacade();
    client.call.mockResolvedValue(null);
    let summariesOn = false;
    graphService.setSummaryNamesOn(() => summariesOn);

    await graphService.markDirty(PROJECT_ID, MODEL_TAG, DIMENSIONS);
    summariesOn = true;
    await graphService.markDirty(PROJECT_ID, MODEL_TAG, DIMENSIONS);

    const sentFlags = client.call.mock.calls.map(([, params]) => (params as { summaryNamesOn: boolean }).summaryNamesOn);
    expect(sentFlags).toEqual([false, true]);
  });
});

describe('graphService worker calls', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the snapshot request with both main-side settings and the caller key, and returns the worker answer', async () => {
    const { graphService, client } = await loadFacade();
    const wire = { projectId: PROJECT_ID } as unknown as KnowledgeGraphSnapshotWire;
    client.call.mockResolvedValue(wire);
    graphService.setSummaryNamesOn(() => true);
    graphService.setSummariesSkipped((projectId) => (projectId === PROJECT_ID ? 7 : 0));

    const result = await graphService.getSnapshotWire(PROJECT_ID, MODEL_TAG, 'key-1');

    expect(result).toBe(wire);
    expect(client.call).toHaveBeenCalledWith('graph.snapshot', {
      projectId: PROJECT_ID,
      modelTag: MODEL_TAG,
      summaryNamesOn: true,
      summariesSkipped: 7,
      knownProjectionKey: 'key-1',
    });
  });

  it('rejects the snapshot request while the worker cannot answer, so the renderer keeps its map', async () => {
    const { graphService, client } = await loadFacade();
    client.call.mockRejectedValue(new Error('The retrieval worker is restarting'));

    await expect(graphService.getSnapshotWire(PROJECT_ID, MODEL_TAG, null)).rejects.toThrow('restarting');
  });

  it('sends the region-name request with urgency and summaryNamesOn, and swallows a rejected call', async () => {
    const { graphService, client } = await loadFacade();
    client.call.mockRejectedValue(new Error('The retrieval worker is restarting'));
    graphService.setSummaryNamesOn(() => true);

    expect(() => graphService.requestRegionNames(PROJECT_ID, true)).not.toThrow();

    expect(client.call).toHaveBeenCalledWith('graph.requestRegionNames', {
      projectId: PROJECT_ID,
      urgent: true,
      summaryNamesOn: true,
    });
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1));
  });
});
