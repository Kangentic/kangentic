/**
 * The graph service's snapshot as it crosses to the renderer
 * (`getSnapshotWire`): the map goes as JSON, only when the reader's key does
 * not match, and is serialized once per change however many readers ask. The
 * key names the map a reader would see, so it moves with the map's signature
 * and with the region names laid over it, and with nothing else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  projection: null as null | { signature: string; nodes: unknown[]; edges: unknown[]; clusterings: unknown[] },
  regionNames: undefined as string | undefined,
  stale: false,
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));

vi.mock('../../src/main/retrieval/graph/projection-engine', () => ({
  runProjectionPass: vi.fn(),
  readCachedProjection: () => (state.projection ? structuredClone(state.projection) : null),
  writeProjectionCache: vi.fn(),
  isProjectionFresh: () => !state.stale,
}));

vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    readonly hasVec = true;
    coverageFingerprint(): string { return 'chunks:1'; }
    listIndexState(): unknown[] { return []; }
    documentChunkTotals(): unknown[] { return []; }
    knownConversationDocIds(): string[] { return []; }
    storedEmbeddingSignature(): null { return null; }
    maxChunkId(): number { return 1; }
    corpusFingerprint(): string { return 'all:1'; }
    corpusTotals(): unknown[] { return []; }
    corpusTextBytes(): number { return 0; }
    summaryCounts(): { written: number; finishedTasks: number } { return { written: 0, finishedTasks: 0 }; }
    lastIndexedAt(): null { return null; }
    getMeta(): string | undefined { return state.regionNames; }
    setMeta(): void {}
  },
}));

import { createGraphService } from '../../src/main/retrieval/graph/graph-service';
import { LABELLER_VERSION } from '../../src/main/retrieval/graph/cluster-labels';

function projection(signature: string) {
  return {
    signature,
    nodes: [{ docKey: 'conversation::a' }],
    edges: [],
    clusterings: [{ granularity: 'balanced', regions: [{ id: 0, label: 'terminal', size: 1, x: 0, y: 0, z: 0 }] }],
  };
}

function storedNames(signature: string, label: string): string {
  return JSON.stringify({ signature, labellerVersion: LABELLER_VERSION, summaries: 'off', names: { balanced: { 0: label } } });
}

describe('graph snapshot on the wire', () => {
  beforeEach(() => {
    // Naming is scheduled on timers; none of these cases lets one run.
    vi.useFakeTimers();
    state.projection = projection('sig-1');
    state.regionNames = undefined;
    state.stale = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the map as JSON with its key, and only the key once the reader holds it', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    const first = service.getSnapshotWire('project-a', 'model');
    expect(first.projection).toBeUndefined();
    expect(typeof first.projectionKey).toBe('string');
    expect(JSON.parse(first.projectionJson ?? 'null')).toEqual(state.projection);

    const again = service.getSnapshotWire('project-a', 'model', { knownProjectionKey: first.projectionKey });
    expect(again.projectionUnchanged).toBe(true);
    expect(again.projectionJson).toBeUndefined();
    expect(again.projectionKey).toBe(first.projectionKey);
    // The rest of the snapshot is fresh on every read.
    state.stale = true;
    expect(service.getSnapshotWire('project-a', 'model', { knownProjectionKey: first.projectionKey }).stale).toBe(true);
  });

  it('serializes a map once, however many readers without it ask', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    const stringify = vi.spyOn(JSON, 'stringify');
    const first = service.getSnapshotWire('project-a', 'model');
    const second = service.getSnapshotWire('project-a', 'model', { knownProjectionKey: 'another-window-key' });
    const mapStringifies = stringify.mock.calls.filter(([value]) => (value as { signature?: string } | null)?.signature === 'sig-1');
    stringify.mockRestore();
    expect(mapStringifies).toHaveLength(1);
    expect(second.projectionJson).toBe(first.projectionJson);
  });

  it('moves the key with the map, and with the region names shown over it', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    const original = service.getSnapshotWire('project-a', 'model').projectionKey;

    state.regionNames = storedNames('sig-1', 'alt screen');
    const renamed = service.getSnapshotWire('project-a', 'model', { knownProjectionKey: original });
    expect(renamed.projectionKey).not.toBe(original);
    expect(JSON.parse(renamed.projectionJson ?? 'null').clusterings[0].regions[0].label).toBe('alt screen');

    // Names made for another map are not shown, so they do not move the key.
    state.projection = projection('sig-2');
    state.regionNames = storedNames('sig-1', 'alt screen');
    const rebuilt = service.getSnapshotWire('project-a', 'model', { knownProjectionKey: renamed.projectionKey });
    state.regionNames = storedNames('sig-1', 'something else');
    const unrelatedNames = service.getSnapshotWire('project-a', 'model', { knownProjectionKey: rebuilt.projectionKey });
    expect(rebuilt.projectionKey).not.toBe(renamed.projectionKey);
    expect(unrelatedNames.projectionUnchanged).toBe(true);
  });

  it('sends no key and no map when no map is built', () => {
    state.projection = null;
    const service = createGraphService({ getDb: () => ({}) as never });
    const wire = service.getSnapshotWire('project-a', 'model', { knownProjectionKey: 'old-key' });
    expect(wire.projection).toBeNull();
    expect(wire.projectionKey).toBeNull();
    expect(wire.projectionUnchanged).toBeUndefined();
  });

  it('reports the skipped count main sent with the read', () => {
    const service = createGraphService({ getDb: () => ({}) as never });
    expect(service.getSnapshotWire('project-a', 'model', { summariesSkipped: 3 }).index.summaries.skipped).toBe(3);
  });
});
