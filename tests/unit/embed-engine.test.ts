import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';

// The real isEmbeddingModelPresent does fs.existsSync against PATHS.embeddingModelsDir;
// these tests exercise the drain loop's scheduling logic, not on-disk model presence,
// so it is stubbed to always report the model as available.
vi.mock('../../src/main/retrieval/embedder/embedding-model', () => ({
  isEmbeddingModelPresent: vi.fn(() => true),
  downloadEmbeddingModel: vi.fn(),
}));

import {
  createEmbedEngine,
  computeEmbedSleepMs,
  type EmbedStore,
  type EmbedWorkerClient,
} from '../../src/main/retrieval/embedder/embed-engine';
import { markVecCapable } from '../../src/main/retrieval/vec-support';
import { isEmbeddingModelPresent } from '../../src/main/retrieval/embedder/embedding-model';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { StoredChunk } from '../../src/main/retrieval/types';
import type { EmbeddingModelDef } from '../../src/main/retrieval/embedder/embedding-config';
import type { MemoryAcceleration } from '../../src/shared/types';

/**
 * The central embedding engine's scheduling contract: the duty-cycle pacer
 * math, dirty-set round-robin draining across projects, and crash/transient
 * resume. The embed worker and the store are both faked via the engine's DI
 * seam (createEmbedEngine's deps) rather than the real EmbedClient/
 * RetrievalStore - those are covered by embed-client.test.ts and
 * retrieval-store-sql.test.ts respectively.
 */

function makeChunk(id: number, contentHash = `hash-${id}`): StoredChunk {
  return {
    id,
    corpus: 'conversation',
    docId: 'doc',
    seq: id,
    sessionId: null,
    taskId: null,
    agentSessionId: null,
    role: 'user',
    text: `text-${id}`,
    contentHash,
    tokenEstimate: 1,
    tsStart: null,
    tsEnd: null,
    turnUuidStart: null,
    turnUuidEnd: null,
    embeddedModel: null,
  };
}

/** A minimal in-memory EmbedStore. `chunksNeedingEmbedding` records a visit
 *  (its project id) into the shared `visits` array on every call, so tests
 *  can assert the drain's round-robin ordering across projects. */
class FakeStore implements EmbedStore {
  hasVec = true;
  written: Array<{ chunkId: number; vector: Float32Array; contentHash: string }> = [];

  constructor(
    private readonly projectId: string,
    private pending: StoredChunk[],
    private readonly visits: string[],
  ) {}

  getMeta(): string | undefined {
    return undefined;
  }
  setMeta(): void {}
  resetVec(): void {}
  ensureVecTable(): void {}

  chunksNeedingEmbedding(_modelTag: string, limit: number): StoredChunk[] {
    this.visits.push(this.projectId);
    return this.pending.slice(0, limit);
  }

  writeEmbeddings(rows: Array<{ chunkId: number; vector: Float32Array; contentHash: string }>): void {
    this.written.push(...rows);
    const writtenIds = new Set(rows.map((row) => row.chunkId));
    this.pending = this.pending.filter((chunk) => !writtenIds.has(chunk.id));
  }

  get remaining(): number {
    return this.pending.length;
  }
}

function makeFakeClient(overrides?: Partial<EmbedWorkerClient>): EmbedWorkerClient {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([0.1]))),
    setWarmHold: vi.fn(),
    waitForInteractiveIdle: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
    crashed: false,
    activeDevice: 'cpu',
    dimensions: 384,
    modelTag: 'bge-base@q8-cls',
    noiseFloor: 0.4,
    ...overrides,
  };
}

function makeContext(overrides?: { currentProjectId?: string | null; semanticEnabled?: boolean }): IpcContext {
  return {
    configManager: {
      load: () => ({ memory: { semanticEnabled: overrides?.semanticEnabled ?? true } }),
    },
    currentProjectId: overrides?.currentProjectId ?? null,
  } as unknown as IpcContext;
}

const immediateDelay = (): Promise<void> => Promise.resolve();

describe('computeEmbedSleepMs (duty-cycle pacer)', () => {
  it('scales the sleep proportionally to hold the duty-cycle average', () => {
    // sleep = batchMs * (1/dutyCycle - 1): a 20% duty cycle sleeps 4x the batch.
    expect(computeEmbedSleepMs(30, 0.2)).toBeCloseTo(120, 5);
    expect(computeEmbedSleepMs(800, 0.2)).toBeCloseTo(3200, 5);
  });

  it('is machine-independent: the same duty cycle holds regardless of batch duration', () => {
    expect(computeEmbedSleepMs(10, 0.2) / 10).toBeCloseTo(computeEmbedSleepMs(1000, 0.2) / 1000, 5);
  });

  it('floors at 0 and never returns a negative sleep', () => {
    expect(computeEmbedSleepMs(0, 0.2)).toBe(0);
  });

  it('returns 0 for a duty cycle of 1 (no throttling) and for a non-positive duty cycle', () => {
    expect(computeEmbedSleepMs(500, 1)).toBe(0);
    expect(computeEmbedSleepMs(500, 0)).toBe(0);
    expect(computeEmbedSleepMs(500, -1)).toBe(0);
  });
});

describe('createEmbedEngine drain loop', () => {
  it('drains each dirty project FIFO and round-robins across projects rather than draining one to completion first', async () => {
    const visits: string[] = [];
    const storeA = new FakeStore('proj-a', [makeChunk(1), makeChunk(2)], visits);
    const storeB = new FakeStore('proj-b', [makeChunk(3), makeChunk(4)], visits);
    const dbA = { __fakeProjectId: 'proj-a' } as unknown as Database.Database;
    const dbB = { __fakeProjectId: 'proj-b' } as unknown as Database.Database;
    markVecCapable(dbA);
    markVecCapable(dbB);
    const dbs = new Map<string, Database.Database>([
      ['proj-a', dbA],
      ['proj-b', dbB],
    ]);
    const stores = new Map<string, FakeStore>([
      ['proj-a', storeA],
      ['proj-b', storeB],
    ]);

    const engine = createEmbedEngine({
      getDb: (projectId) => dbs.get(projectId)!,
      createStore: (db) => stores.get((db as unknown as { __fakeProjectId: string }).__fakeProjectId)!,
      createClient: () => makeFakeClient(),
      delay: immediateDelay,
      drainBatchSize: 1,
    });

    engine.attach(makeContext({ currentProjectId: 'proj-a' }));
    engine.markDirty('proj-a');
    engine.markDirty('proj-b');

    await vi.waitFor(() => {
      expect(storeA.remaining).toBe(0);
      expect(storeB.remaining).toBe(0);
    });

    // Batch size 1, two chunks per project: a true round-robin alternates on
    // every visit. If the loop instead drained proj-a to completion before
    // ever trying proj-b, this would read ['proj-a','proj-a','proj-b','proj-b'].
    expect(visits).toEqual(['proj-a', 'proj-b', 'proj-a', 'proj-b', 'proj-a', 'proj-b']);

    engine.dispose();
  });

  it('FIFOs within a project: oldest chunk id embeds first', async () => {
    const visits: string[] = [];
    const store = new FakeStore('proj-fifo', [makeChunk(5), makeChunk(6), makeChunk(7)], visits);
    const db = { name: 'proj-fifo' } as unknown as Database.Database;
    markVecCapable(db);
    const writtenOrder: number[] = [];
    const client = makeFakeClient({
      embed: vi.fn(async (texts: string[]) => {
        writtenOrder.push(...texts.map((text) => Number(text.replace('text-', ''))));
        return texts.map(() => new Float32Array([0.1]));
      }),
    });

    const engine = createEmbedEngine({
      getDb: () => db,
      createStore: () => store,
      createClient: () => client,
      delay: immediateDelay,
      drainBatchSize: 1,
    });

    engine.attach(makeContext({ currentProjectId: 'proj-fifo' }));
    engine.markDirty('proj-fifo');

    await vi.waitFor(() => expect(store.remaining).toBe(0));
    expect(writtenOrder).toEqual([5, 6, 7]);

    engine.dispose();
  });

  it('keeps a project dirty and retries after a transient embed failure, then finishes draining (crash-resume)', async () => {
    const store = new FakeStore('proj-c', [makeChunk(10), makeChunk(11)], []);
    const db = { name: 'proj-c' } as unknown as Database.Database;
    markVecCapable(db);

    let callCount = 0;
    const client = makeFakeClient({
      embed: vi.fn(async (texts: string[]) => {
        callCount += 1;
        // First attempt simulates a transient worker hiccup (timeout / queue
        // full / mid-restart); subsequent attempts succeed.
        if (callCount === 1) return null;
        return texts.map(() => new Float32Array([0.5]));
      }),
    });

    const engine = createEmbedEngine({
      getDb: () => db,
      createStore: () => store,
      createClient: () => client,
      delay: immediateDelay,
      drainBatchSize: 2,
      transientBackoffMs: 0,
    });

    engine.attach(makeContext({ currentProjectId: 'proj-c' }));
    engine.markDirty('proj-c');

    await vi.waitFor(() => expect(store.remaining).toBe(0));
    expect(client.embed).toHaveBeenCalledTimes(2);

    engine.dispose();
  });

  it('never busy-spins against a crashed client: it parks instead of calling embed', async () => {
    const store = new FakeStore('proj-d', [makeChunk(20)], []);
    const db = { name: 'proj-d' } as unknown as Database.Database;
    markVecCapable(db);
    const client = makeFakeClient({ crashed: true });

    const engine = createEmbedEngine({
      getDb: () => db,
      createStore: () => store,
      createClient: () => client,
      delay: immediateDelay,
    });

    engine.attach(makeContext({ currentProjectId: 'proj-d' }));
    engine.markDirty('proj-d');

    // Let the loop run to the crashed branch and park; give it a generous
    // window since parking must never be observed as continued embed() calls.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.embed).not.toHaveBeenCalled();

    // dispose() must resolve the parked wake deferred synchronously so the
    // loop actually exits rather than hanging forever - this is the
    // load-bearing shutdown guarantee for a parked (crashed-client) loop.
    expect(() => engine.dispose()).not.toThrow();
  });

  it('does not embed while semantic is disabled, even with a dirty project', async () => {
    const store = new FakeStore('proj-e', [makeChunk(30)], []);
    const db = { name: 'proj-e' } as unknown as Database.Database;
    markVecCapable(db);
    const client = makeFakeClient();

    const engine = createEmbedEngine({
      getDb: () => db,
      createStore: () => store,
      createClient: () => client,
      delay: immediateDelay,
    });

    engine.attach(makeContext({ currentProjectId: 'proj-e', semanticEnabled: false }));
    engine.markDirty('proj-e');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.embed).not.toHaveBeenCalled();
    expect(store.remaining).toBe(1);

    engine.dispose();
  });
});

describe('createEmbedEngine getEmbedder (resolveEmbedder)', () => {
  it('returns null when semantic search is disabled, even with a project open', () => {
    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-disabled', [], []),
      createClient: () => makeFakeClient(),
      delay: immediateDelay,
    });

    const context = makeContext({ currentProjectId: 'proj-disabled', semanticEnabled: false });
    expect(engine.getEmbedder(context)).toBeNull();
  });

  it('returns null when the selected embedding model is not present on disk', () => {
    vi.mocked(isEmbeddingModelPresent).mockReturnValueOnce(false);

    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-missing-model', [], []),
      createClient: () => makeFakeClient(),
      delay: immediateDelay,
    });

    const context = makeContext({ currentProjectId: 'proj-missing-model', semanticEnabled: true });
    expect(engine.getEmbedder(context)).toBeNull();
  });

  it('returns null when the shared client has crashed past MAX_CRASHES', () => {
    const crashedClient = makeFakeClient({ crashed: true });
    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-crashed', [], []),
      createClient: () => crashedClient,
      delay: immediateDelay,
    });

    const context = makeContext({ currentProjectId: 'proj-crashed', semanticEnabled: true });
    expect(engine.getEmbedder(context)).toBeNull();
  });

  it('returns the shared client for the interactive query path when semantic is enabled, the model is present, and the client is healthy', () => {
    const client = makeFakeClient();
    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-healthy', [], []),
      createClient: () => client,
      delay: immediateDelay,
    });

    const context = makeContext({ currentProjectId: 'proj-healthy', semanticEnabled: true });
    expect(engine.getEmbedder(context)).toBe(client);
  });
});

describe('createEmbedEngine reconcile', () => {
  it('holds the existing client warm without disposing it when semantic is enabled and a project is open', () => {
    const client = makeFakeClient();
    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-warm', [], []),
      createClient: () => client,
      delay: immediateDelay,
    });

    const context = makeContext({ currentProjectId: 'proj-warm', semanticEnabled: true });
    // Seed the shared client via the query path first, so there is something
    // for reconcile to hold warm. attach() is deliberately NOT called here:
    // the warm-hold/dispose branch of reconcile is synchronous and does not
    // depend on the drain loop being started.
    engine.getEmbedder(context);
    client.setWarmHold.mockClear();
    client.dispose.mockClear();

    engine.reconcile(context);

    expect(client.setWarmHold).toHaveBeenCalledWith(true);
    expect(client.dispose).not.toHaveBeenCalled();
  });

  it('disposes the cached client and drops it when semantic becomes disabled', () => {
    const client = makeFakeClient();
    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-cold', [], []),
      createClient: () => client,
      delay: immediateDelay,
    });

    const enabledContext = makeContext({ currentProjectId: 'proj-cold', semanticEnabled: true });
    engine.getEmbedder(enabledContext);
    expect(client.dispose).not.toHaveBeenCalled();

    const disabledContext = makeContext({ currentProjectId: 'proj-cold', semanticEnabled: false });
    engine.reconcile(disabledContext);

    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the cached client and drops it when no project is open, even with semantic enabled', () => {
    const client = makeFakeClient();
    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-none', [], []),
      createClient: () => client,
      delay: immediateDelay,
    });

    const openContext = makeContext({ currentProjectId: 'proj-none', semanticEnabled: true });
    engine.getEmbedder(openContext);
    expect(client.dispose).not.toHaveBeenCalled();

    const noProjectContext = makeContext({ currentProjectId: null, semanticEnabled: true });
    engine.reconcile(noProjectContext);

    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('marks the current project dirty on reconcile itself (not just via markDirty) when semantic is enabled and the model is present, so a drain picks it up', async () => {
    const visits: string[] = [];
    const store = new FakeStore('proj-reconcile-dirty', [makeChunk(50)], visits);
    const db = { name: 'proj-reconcile-dirty' } as unknown as Database.Database;
    markVecCapable(db);
    const client = makeFakeClient();

    const engine = createEmbedEngine({
      getDb: () => db,
      createStore: () => store,
      createClient: () => client,
      delay: immediateDelay,
    });

    const context = makeContext({ currentProjectId: 'proj-reconcile-dirty', semanticEnabled: true });
    engine.attach(context);

    // No markDirty call here -- reconcile itself is what must flag the project.
    engine.reconcile(context);

    await vi.waitFor(() => expect(store.remaining).toBe(0));
    expect(visits).toContain('proj-reconcile-dirty');

    engine.dispose();
  });
});

describe('createEmbedEngine getClientFor model/acceleration switch', () => {
  function makeMutableContext(initial: {
    currentProjectId?: string | null;
    semanticEnabled?: boolean;
    embeddingModel?: string;
    acceleration?: MemoryAcceleration;
  }): { context: IpcContext; state: typeof initial } {
    const state = { ...initial };
    const context = {
      configManager: {
        load: () => ({
          memory: {
            semanticEnabled: state.semanticEnabled ?? true,
            embeddingModel: state.embeddingModel,
            acceleration: state.acceleration,
          },
        }),
      },
      get currentProjectId() {
        return state.currentProjectId ?? null;
      },
    } as unknown as IpcContext;
    return { context, state };
  }

  it('disposes the old client and creates a fresh one when the selected model changes', () => {
    const createdClients: EmbedWorkerClient[] = [];
    const createClient = vi.fn((model: EmbeddingModelDef, _acceleration: MemoryAcceleration): EmbedWorkerClient => {
      const instance = makeFakeClient({ modelTag: model.modelTag, dimensions: model.dimensions });
      createdClients.push(instance);
      return instance;
    });

    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-model-switch', [], []),
      createClient,
      delay: immediateDelay,
    });

    const { context, state } = makeMutableContext({
      currentProjectId: 'proj-model-switch',
      embeddingModel: 'bge-small',
    });

    const first = engine.getEmbedder(context);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(first).toBe(createdClients[0]);

    state.embeddingModel = 'bge-large';
    const second = engine.getEmbedder(context);

    expect(createdClients[0].dispose).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(second).toBe(createdClients[1]);
    expect(second).not.toBe(first);
  });

  it('disposes the old client and creates a fresh one when the acceleration preference changes', () => {
    const createdClients: EmbedWorkerClient[] = [];
    const createClient = vi.fn((_model: EmbeddingModelDef, _acceleration: MemoryAcceleration): EmbedWorkerClient => {
      const instance = makeFakeClient();
      createdClients.push(instance);
      return instance;
    });

    const engine = createEmbedEngine({
      getDb: () => ({}) as unknown as Database.Database,
      createStore: () => new FakeStore('proj-accel-switch', [], []),
      createClient,
      delay: immediateDelay,
    });

    const { context, state } = makeMutableContext({
      currentProjectId: 'proj-accel-switch',
      acceleration: 'cpu',
    });

    const first = engine.getEmbedder(context);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(first).toBe(createdClients[0]);

    state.acceleration = 'gpu';
    const second = engine.getEmbedder(context);

    expect(createdClients[0].dispose).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(second).toBe(createdClients[1]);
    expect(second).not.toBe(first);
  });
});
