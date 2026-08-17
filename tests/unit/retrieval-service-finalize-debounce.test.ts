/**
 * Unit tests for retrievalService's per-session finalize (suspend / exit)
 * debounce.
 *
 * `SessionManager.suspend` emits `session-changed` TWICE for one suspend: once
 * immediately when the status is marked, and again after `gracefulPtyShutdown`
 * - up to `gracePeriodMs` (1500) + `killPropagationMs` (1500) = 3000ms later
 * when the agent needs a force-kill. Without a per-session trailing debounce,
 * each report booked its own `ConversationIndexer.indexSession` pass over the
 * same transcript. `scheduleFinalizeIndex` (module-private in
 * retrieval-service.ts) fixes this with a per-session timer keyed in the
 * `finalizeIndexTimers` map, keeping only the LAST report - which is also the
 * more correct read, since the later a finalize runs, the more of the agent's
 * final flush it sees.
 *
 * These tests drive the real `retrievalService.attach(context)` seam (a fake
 * EventEmitter-backed sessionManager firing 'exit' / 'session-changed', under
 * `vi.useFakeTimers()`) rather than reimplementing the debounce, so they pin
 * the shipped wiring, not a parallel model of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// retrieval-service.ts's other direct imports that would otherwise drag in
// electron (vec-extension.ts) or a native module built for Electron's Node
// ABI (better-sqlite3, via db/database.ts) - neither is exercised by the
// finalize-debounce path, so both are stubbed rather than pulled in for real.
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/retrieval/vec-extension', () => ({
  lastVecLoadError: vi.fn(() => null),
  loadVecExtension: vi.fn(() => false),
}));

const conversationIndexerMock = vi.hoisted(() => ({
  indexSession: vi.fn(async () => ({})),
}));
vi.mock('../../src/main/retrieval/conversation/conversation-indexer', () => ({
  ConversationIndexer: class {
    indexSession = conversationIndexerMock.indexSession;
  },
}));

const embedEngineMock = vi.hoisted(() => ({
  attach: vi.fn(),
  markDirty: vi.fn(),
  dispose: vi.fn(),
  getEmbedder: vi.fn(() => null),
  reconcile: vi.fn(),
  activeDevice: null as string | null,
  workerCrashed: false,
}));
vi.mock('../../src/main/retrieval/embedder/embed-engine', () => ({
  embedEngine: embedEngineMock,
}));

/** Minimal fake of the SessionManager surface scheduleFinalizeIndex reads:
 *  a real EventEmitter (so `.on('exit'|'session-changed', ...)` wiring in
 *  `attach()` is exercised as written) plus the two lookups the debounced
 *  timer body performs before indexing. */
class FakeSessionManager extends EventEmitter {
  private readonly projectIdBySession = new Map<string, string>();

  registerSession(sessionId: string, projectId: string): void {
    this.projectIdBySession.set(sessionId, projectId);
  }

  getSession(_sessionId: string): { transient: boolean } {
    return { transient: false };
  }

  getSessionProjectId(sessionId: string): string | undefined {
    return this.projectIdBySession.get(sessionId);
  }
}

function makeContext(sessionManager: FakeSessionManager): IpcContext {
  return {
    sessionManager,
    configManager: { load: () => ({ memory: { indexingEnabled: true } }) },
    currentProjectId: null,
  } as unknown as IpcContext;
}

describe('retrievalService - per-session finalize debounce', () => {
  let retrievalService: typeof import('../../src/main/retrieval/retrieval-service')['retrievalService'];
  let sessionManager: FakeSessionManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // The module holds `attached` / `disposed` / `finalizeIndexTimers` as
    // singleton state with no reset hook, so each test gets a fresh module
    // instance via resetModules + a fresh dynamic import, rather than relying
    // on cross-test ordering around dispose().
    vi.resetModules();
    ({ retrievalService } = await import('../../src/main/retrieval/retrieval-service'));
    sessionManager = new FakeSessionManager();
  });

  afterEach(() => {
    retrievalService.dispose();
    vi.useRealTimers();
  });

  it('coalesces two finalize reports for the SAME session (one suspend, reported twice) into exactly one indexSession call', async () => {
    const context = makeContext(sessionManager);
    retrievalService.attach(context);
    sessionManager.registerSession('sess-1', 'proj-1');

    // First report: SessionManager.suspend's immediate `session-changed`.
    sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });

    // The worst-case gap documented on FINALIZE_DEBOUNCE_MS: gracePeriodMs
    // (1500) + killPropagationMs (1500) = up to 3000ms before the trailing
    // report arrives. Advancing to just under that proves the debounce
    // window survives it - a regression back to the old 2000ms would already
    // have fired the first timer (and called indexSession) by this point.
    await vi.advanceTimersByTimeAsync(2900);
    expect(conversationIndexerMock.indexSession).not.toHaveBeenCalled();

    // Second report: the trailing `session-changed` after gracefulPtyShutdown.
    sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });

    // Comfortably longer than the debounce window from this reset point.
    await vi.advanceTimersByTimeAsync(4000);

    expect(conversationIndexerMock.indexSession).toHaveBeenCalledTimes(1);
    expect(conversationIndexerMock.indexSession).toHaveBeenCalledWith('proj-1', 'sess-1');
    expect(embedEngineMock.markDirty).toHaveBeenCalledTimes(1);
    expect(embedEngineMock.markDirty).toHaveBeenCalledWith('proj-1');
  });

  it('debounces per session, not globally: two DIFFERENT sessions each get their own indexSession call', async () => {
    const context = makeContext(sessionManager);
    retrievalService.attach(context);
    sessionManager.registerSession('sess-a', 'proj-a');
    sessionManager.registerSession('sess-b', 'proj-b');

    // Exercises both finalize hooks attach() wires: a suspend (session-changed)
    // for one session and a clean exit for the other.
    sessionManager.emit('session-changed', 'sess-a', { status: 'suspended' });
    sessionManager.emit('exit', 'sess-b');

    await vi.advanceTimersByTimeAsync(5000);

    expect(conversationIndexerMock.indexSession).toHaveBeenCalledTimes(2);
    expect(conversationIndexerMock.indexSession).toHaveBeenCalledWith('proj-a', 'sess-a');
    expect(conversationIndexerMock.indexSession).toHaveBeenCalledWith('proj-b', 'sess-b');
  });

  it('dispose() clears pending finalize timers so no indexing pass fires afterward', async () => {
    const context = makeContext(sessionManager);
    retrievalService.attach(context);
    sessionManager.registerSession('sess-1', 'proj-1');

    sessionManager.emit('session-changed', 'sess-1', { status: 'suspended' });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    retrievalService.dispose();

    // The distinguishing assertion: the pending finalize timer must actually be
    // CLEARED (clearTimeout), not merely left to fire and no-op against the
    // `disposed` flag its own callback checks - that flag guard would mask a
    // regression that dropped dispose()'s `finalizeIndexTimers` cleanup, since
    // indexSession would still never be called either way.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10000);

    expect(conversationIndexerMock.indexSession).not.toHaveBeenCalled();
  });
});
