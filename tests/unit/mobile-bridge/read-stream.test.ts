import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

// `resumable` reads the paused session's task and column. Defaults: a task in
// a custom column, not archived (resumable when suspended).
const taskGetByIdMock = vi.fn();
const swimlaneGetByIdMock = vi.fn();
vi.mock('../../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    tasks: { getById: (...args: unknown[]) => taskGetByIdMock(...args) },
    swimlanes: { getById: (...args: unknown[]) => swimlaneGetByIdMock(...args) },
  })),
}));

const resolveTaskTranscriptMock = vi.fn();
vi.mock('../../../src/main/agent/transcript-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/agent/transcript-service')>()),
  resolveTaskTranscript: (...args: unknown[]) => resolveTaskTranscriptMock(...args),
}));

// The transcript diff and window run in the retrieval worker; this runs the
// worker's own handlers in-process, over the stub above.
vi.mock('../../../src/main/retrieval/retrieval-client', async () => (
  (await import('../helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
));

import { isBridgeEvent, MAX_DECODED_LENGTH, MAX_FRAME_LENGTH, parseActivityEventPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue } from '@kangentic/protocol';
import type { BrowserWindow } from 'electron';
import { SERIALIZED_SCROLLBACK_LINES } from '../../../src/main/pty/host/protocol';
import { handleReadStream, terminalStreamKeyFor } from '../../../src/main/mobile-bridge/handlers/read-stream';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';
import { createProgressCallback, emitSpawnProgress, __resetSpawnProgressForTest } from '../../../src/main/transition-engine/spawn-progress';

function fakeWindow(): BrowserWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
}

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'read-stream', payload };
}

function fakeSession(): BridgeSession {
  return { deviceId: 'device-1', isEstablished: true, sendMessage: vi.fn() } as unknown as BridgeSession;
}

const usageFixture = {
  contextWindow: { usedPercentage: 10, usedTokens: 100, cacheTokens: 50, totalInputTokens: 150, totalOutputTokens: 20, contextWindowSize: 200000 },
  cost: { totalCostUsd: 0.5, totalDurationMs: 1000 },
  model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
};

// Authored fixture mirroring the numbered permission dialog Claude Code
// paints (box border + ❯ marker), for the option-label probe.
const permissionDialogFrame = [
  'Do you want to proceed?',
  '│ ❯ 1. Yes                                        │',
  "│   2. Yes, and don't ask again for this command  │",
  '│   3. No, and tell Claude what to do differently │',
].join('\r\n');
const permissionDialogOptions = ['Yes', "Yes, and don't ask again for this command", 'No, and tell Claude what to do differently'];

/** Let the async option-label probe inside the permission push settle. */
function flushProbe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeSessionManager extends EventEmitter {
  getSession = vi.fn((id: string): { id: string; taskId: string; status: string; resuming: boolean; transient?: boolean } | undefined => (
    { id, taskId: 'task-1', status: 'running', resuming: false }
  ));
  getSessionTaskId = vi.fn((id: string): string | undefined => (id === 'sess-1' ? 'task-1' : undefined));
  /** The registry's rows: by default only the row getSession answers for 'sess-1'. */
  listSessions = vi.fn(() => {
    const row = this.getSession('sess-1');
    return row ? [row] : [];
  });
  getScrollback = vi.fn(() => Promise.resolve('scrollback-content'));
  // The mobile seed uses the parsed-grid serialized frame, not the raw replay.
  // `scrollbackLines` is how much history the frame carries (undefined = full depth).
  getSerializedFrame = vi.fn((_sessionId: string, _scrollbackLines?: number): Promise<string> => Promise.resolve('serialized-frame'));
  /** Parser offset the seed snapshot covers (see getSeedFrame). */
  seedBarrierOffset = 0;
  /** Runs while the seed request is in flight, after the barrier, to emit racing tap bytes. */
  duringSeed: (() => void) | null = null;
  getSeedFrame = vi.fn(async (sessionId: string, scrollbackLines?: number) => {
    const frame = await this.getSerializedFrame(sessionId, scrollbackLines);
    this.duringSeed?.();
    return { frame, barrierOffset: this.seedBarrierOffset, settleMs: 12, serializeMs: 3 };
  });
  getActivityCache = vi.fn(() => ({ 'sess-1': 'thinking' }));
  getActivityReason = vi.fn(() => ({ kind: 'turn-active' }));
  getUsageCache = vi.fn(() => ({ 'sess-1': usageFixture }));
  getActivityStatsSnapshot = vi.fn(() => ({ permissionPending: false, permissionAwaitedToolId: null }));
  getSessionProjectId = vi.fn(() => 'proj-1');
  getDimensions = vi.fn((): { cols: number; rows: number } | null => ({ cols: 120, rows: 30 }));
  parkRestingGridForMobileSubscriber = vi.fn();
  isSessionTeardownInFlight = vi.fn(() => false);
  /** Raw-output subscriptions held, by session (the pty host forwards a
   *  session's bytes only while one is held). */
  readonly tapSubscriptions = new Map<string, number>();
  subscribeDataTap = vi.fn((sessionId: string) => {
    this.tapSubscriptions.set(sessionId, (this.tapSubscriptions.get(sessionId) ?? 0) + 1);
    return () => {
      const remaining = (this.tapSubscriptions.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.tapSubscriptions.set(sessionId, remaining);
      else this.tapSubscriptions.delete(sessionId);
    };
  });
}

describe('handleReadStream', () => {
  let sessionManager: FakeSessionManager;

  beforeEach(() => {
    sessionManager = new FakeSessionManager();
    resolveTaskTranscriptMock.mockReset();
    taskGetByIdMock.mockReset().mockReturnValue({ id: 'task-1', swimlane_id: 'lane-review', archived_at: null });
    swimlaneGetByIdMock.mockReset().mockReturnValue({ id: 'lane-review', role: null });
    // getInFlightSpawnProgress() reads a module-level singleton keyed by
    // taskId, and every fixture here uses 'task-1' - without this reset, a
    // label left behind by one test would leak into another's session-ended
    // assertions.
    __resetSpawnProgressForTest();
  });

  it('subscribes to a live session with no owning project without opening a database', async () => {
    // A Command Terminal session carries no project. The subscription used to
    // open the database named '', which creates a stray `projects/.db` file.
    const { getProjectDb } = await import('../../../src/main/db/database');
    vi.mocked(getProjectDb).mockClear();
    sessionManager.getSessionProjectId.mockReturnValue(undefined as never);
    const context = { sessionManager, projectRepo: { list: () => [] } } as unknown as IpcContext;

    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    await flushProbe();

    expect(response.ok).toBe(true);
    expect(getProjectDb).not.toHaveBeenCalled();
    expect(resolveTaskTranscriptMock).not.toHaveBeenCalled();
  });

  it('rejects when the session does not exist', async () => {
    sessionManager.getSession.mockReturnValueOnce(undefined as never);
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect(response.ok).toBe(false);
  });

  it('returns the initial snapshot including the awaited prompt id when a permission prompt is pending', async () => {
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

    expect(response.ok).toBe(true);
    const payload = response.payload as { scrollback: string; awaitedPromptId: string | null; awaitedPromptOptions?: string[] | null; ptyDimensions?: unknown };
    expect(payload.scrollback).toBe('serialized-frame');
    expect(payload.awaitedPromptId).toBe('sess-1:tool-9');
    // The frame shows no numbered dialog, so the option labels are unknown.
    expect(payload.awaitedPromptOptions).toBeNull();
    expect(payload.ptyDimensions).toEqual({ cols: 120, rows: 30 });
  });

  it('the snapshot carries the parsed option labels when the pending dialog is in the frame', async () => {
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
    sessionManager.getSerializedFrame.mockResolvedValue(permissionDialogFrame);
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

    const payload = response.payload as { awaitedPromptId: string | null; awaitedPromptOptions?: string[] | null };
    expect(payload.awaitedPromptId).toBe('sess-1:tool-9');
    expect(payload.awaitedPromptOptions).toEqual(permissionDialogOptions);
  });

  it('parks an unheld session for a terminal subscriber BEFORE serializing the seed', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

    // Park first, then serialize: the one seed already carries the resting
    // grid instead of the strip the last desktop surface left behind (plus a
    // second reflow-and-reseed when the debounced park fired later).
    expect(sessionManager.parkRestingGridForMobileSubscriber).toHaveBeenCalledWith('sess-1');
    const parkOrder = sessionManager.parkRestingGridForMobileSubscriber.mock.invocationCallOrder[0];
    const serializeOrder = sessionManager.getSerializedFrame.mock.invocationCallOrder[0];
    expect(parkOrder).toBeLessThan(serializeOrder);
  });

  it('never parks for a list-only subscriber (terminal:false)', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, new SubscriptionRegistry());

    expect(sessionManager.parkRestingGridForMobileSubscriber).not.toHaveBeenCalled();
  });

  it('omits awaitedPromptOptions entirely when no prompt is pending', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect('awaitedPromptOptions' in (response.payload as Record<string, unknown>)).toBe(false);
  });

  it('omits ptyDimensions from the snapshot when the grid is unknowable', async () => {
    sessionManager.getDimensions.mockReturnValue(null);
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect('ptyDimensions' in (response.payload as Record<string, unknown>)).toBe(false);
  });

  it('awaitedPromptId is null when no permission is pending', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    const payload = response.payload as { awaitedPromptId: string | null };
    expect(payload.awaitedPromptId).toBeNull();
  });

  /**
   * The terminal MARKER key answers "is a phone watching this TERMINAL",
   * which the resting park and the panel's placeholder both gate on. The
   * bare stream key cannot: the phone holds a list-only stream subscription
   * for EVERY live session the moment it connects, and gating the park on it
   * made every unheld session park - sessions no phone terminal ever opened
   * were reshaped, and their later panel reveals replayed mis-wrapped
   * (observed live 2026-08-02).
   */
  it('a terminal subscribe registers the terminal marker; a list-only one never does', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);
    expect(subscriptions.has(terminalStreamKeyFor('sess-1'))).toBe(true);

    const listOnly = new SubscriptionRegistry();
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, listOnly);
    expect(listOnly.has(terminalStreamKeyFor('sess-1'))).toBe(false);
  });

  it('a list-only re-subscribe clears the terminal marker the previous subscribe left', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);
    expect(subscriptions.has(terminalStreamKeyFor('sess-1'))).toBe(true);

    // The phone closed its terminal: the task screen re-subscribes list-only.
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, subscriptions);
    expect(subscriptions.has(terminalStreamKeyFor('sess-1'))).toBe(false);
  });

  /**
   * Exactly-once terminal bytes around the seed. The pty host stamps every tap
   * chunk with its cumulative parser offset (`endOffset`) and the seed with the
   * offset its snapshot covers (`barrierOffset`). Bytes at or before the
   * barrier are already in the seed; bytes after it are new. Before this, the
   * tap was attached only after the seed, so output produced while the seed
   * was taken was in neither, and pending bytes flushed after it were in both.
   */
  describe('terminal bytes around the seed', () => {
    function terminalDataSent(session: BridgeSession): string {
      const sendMessage = session.sendMessage as unknown as ReturnType<typeof vi.fn>;
      return sendMessage.mock.calls
        .map(([message]) => message as { type: string; event?: { kind: string; payload: { data?: string } } })
        .filter((message) => message.type === 'event' && message.event?.kind === 'terminal')
        .map((message) => message.event?.payload.data ?? '')
        .join('');
    }

    it('delivers output that raced the seed, after the seed, and drops what the seed already holds', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;
      sessionManager.getSerializedFrame.mockImplementation(async () => {
        // The host forwarded these while the snapshot was being taken.
        sessionManager.emit('data-tap', 'sess-1', 'AAAA', 98);
        sessionManager.emit('data-tap', 'sess-1', 'BBBB', 102);
        return 'serialized-frame';
      });

      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      // Nothing may reach the phone ahead of the seed response the caller sends next.
      expect(terminalDataSent(session)).toBe('');
      sessionManager.emit('data-tap', 'sess-1', 'CCCC', 106);
      await flushProbe();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(terminalDataSent(session)).toBe('BBCCCC');
    });

    it('drops pre-barrier bytes a late flush delivers after the seed', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;

      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      sessionManager.emit('data-tap', 'sess-1', 'AAAA', 98);
      sessionManager.emit('data-tap', 'sess-1', 'BBBB', 102);
      sessionManager.emit('data-tap', 'sess-1', 'CCCC', 106);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(terminalDataSent(session)).toBe('BBCCCC');
    });

    /** Lets the 16 ms coalesce timer a replayed raced chunk rides on fire. */
    function settleCoalesceTimer(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, 30));
    }

    it('output emitted after the snapshot was taken, before the seed returns, is replayed whole and only after the seed', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;
      // duringSeed runs once the snapshot (and its barrier) exist and the seed
      // request is still in flight, which is when the host keeps forwarding.
      sessionManager.duringSeed = () => {
        sessionManager.emit('data-tap', 'sess-1', 'PRE', 98); // already in the snapshot
        sessionManager.emit('data-tap', 'sess-1', 'POST', 104); // wholly past the barrier
      };

      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      // The seed response is sent after this handler returns: nothing may beat it.
      expect(terminalDataSent(session)).toBe('');
      await settleCoalesceTimer();

      expect(terminalDataSent(session)).toBe('POST');
    });

    it('a straddling chunk delivers its tail and retires the filter, so a later chunk with lower offsets is delivered whole', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      // Offsets 98..102: the first two bytes are in the seed, the tail is new.
      sessionManager.emit('data-tap', 'sess-1', 'AAAA', 102);
      expect(terminalDataSent(session)).toBe('AA');
      // Everything after the first chunk past the barrier is new. A filter that
      // stayed armed would take this chunk (offset 5, below the barrier) for
      // pre-seed bytes and silence it.
      sessionManager.emit('data-tap', 'sess-1', 'BBB', 5);
      expect(terminalDataSent(session)).toBe('AABBB');
    });

    it('a raced chunk that straddles the barrier retires the filter for the live chunks that follow', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;
      sessionManager.duringSeed = () => sessionManager.emit('data-tap', 'sess-1', 'AAAA', 102);

      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      expect(terminalDataSent(session)).toBe('');
      // The replay already crossed the barrier, so this lower offset is new output.
      sessionManager.emit('data-tap', 'sess-1', 'BBB', 5);

      expect(terminalDataSent(session)).toBe('AABBB');
    });

    it('a chunk with no endOffset passes through whole and does not retire the barrier for the chunks that follow', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      // A test double or an older host stamps no offset: the bytes cannot be
      // placed against the barrier, so they pass whole...
      sessionManager.emit('data-tap', 'sess-1', 'NOOFFSET');
      expect(terminalDataSent(session)).toBe('NOOFFSET');
      // ...and they prove nothing about where the stream is, so a stamped chunk
      // the seed already holds is still dropped, and the first one past the
      // barrier still gets through.
      sessionManager.emit('data-tap', 'sess-1', 'OLD', 50);
      sessionManager.emit('data-tap', 'sess-1', 'NEW', 103);
      expect(terminalDataSent(session)).toBe('NOOFFSETNEW');
    });

    it('a raced chunk with no endOffset is replayed whole', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;
      sessionManager.duringSeed = () => sessionManager.emit('data-tap', 'sess-1', 'NOOFFSET');

      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      await settleCoalesceTimer();

      expect(terminalDataSent(session)).toBe('NOOFFSET');
    });

    it.each([
      ['is not in flight, the chunk is replayed', false, 'RACED'],
      ['is in flight, the chunk is dropped', true, ''],
    ])('when the session teardown %s', async (_label, teardownInFlight, expectedData) => {
      // The raced bytes of a session already tearing down are its own exit
      // sequence, not agent output a live viewer should see. The first row is
      // the control: the same chunk does arrive when no teardown is under way.
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      sessionManager.seedBarrierOffset = 100;
      sessionManager.isSessionTeardownInFlight.mockReturnValue(teardownInFlight);
      sessionManager.duringSeed = () => sessionManager.emit('data-tap', 'sess-1', 'RACED', 105);

      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      // Intentional fixed wait: a replay that should NOT happen cannot be polled
      // for, so give the 16 ms coalesce timer time to fire if it was wrongly armed.
      await settleCoalesceTimer();

      expect(terminalDataSent(session)).toBe(expectedData);
    });

    /**
     * handleReadStream takes a seed tap and a capture listener, and sets the
     * terminal marker, BEFORE it awaits the seed. Every exit must give those
     * back, a throw included; only the marker of a subscribe that completed
     * survives, because subscribeReadStream re-registers it as the live
     * stream's own teardown.
     */
    describe('the seed capture is always released', () => {
      /** What the seed capture takes on 'sess-1', and what a completed subscribe leaves registered. */
      function captureSeedHolds(subscriptions: SubscriptionRegistry): {
        dataTapListeners: number;
        tapRefs: number;
        terminalMarker: boolean;
        streamSubscribed: boolean;
      } {
        return {
          dataTapListeners: sessionManager.listenerCount('data-tap'),
          tapRefs: sessionManager.tapSubscriptions.get('sess-1') ?? 0,
          terminalMarker: subscriptions.has(terminalStreamKeyFor('sess-1')),
          streamSubscribed: subscriptions.has('stream:sess-1'),
        };
      }

      /** Someone else's tap listener and tap on the session: a failed subscribe must give back only its own. */
      function holdBystanderTap(): void {
        sessionManager.on('data-tap', () => undefined);
        sessionManager.subscribeDataTap('sess-1');
      }

      it('a seed that rejects rejects the request and leaves no capture listener, seed tap, or marker behind', async () => {
        const context = { sessionManager } as unknown as IpcContext;
        const subscriptions = new SubscriptionRegistry();
        holdBystanderTap();
        const before = captureSeedHolds(subscriptions);
        expect(before).toEqual({ dataTapListeners: 1, tapRefs: 1, terminalMarker: false, streamSubscribed: false });
        let heldDuringSeed: ReturnType<typeof captureSeedHolds> | null = null;
        sessionManager.getSeedFrame.mockImplementationOnce(async () => {
          heldDuringSeed = captureSeedHolds(subscriptions);
          throw new Error('pty host gone');
        });

        await expect(
          handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions),
        ).rejects.toThrow('pty host gone');

        // The capture really was up while the seed was in flight...
        expect(heldDuringSeed).toEqual({ dataTapListeners: 2, tapRefs: 2, terminalMarker: true, streamSubscribed: false });
        // ...and is fully given back, with the bystander's holds untouched.
        expect(captureSeedHolds(subscriptions)).toEqual(before);
        expect(sessionManager.listenerCount('exit')).toBe(0);
      });

      it.each([
        ['getActivityReason', () => {
          sessionManager.getActivityReason.mockImplementationOnce(() => {
            throw new Error('activity reason unavailable');
          });
        }],
        ['getDimensions', () => {
          sessionManager.getDimensions.mockImplementationOnce(() => {
            throw new Error('dimensions unavailable');
          });
        }],
      ])('a %s that throws AFTER the seed rejects the request and releases the capture, tap, and marker', async (_label, armThrow) => {
        const context = { sessionManager } as unknown as IpcContext;
        const subscriptions = new SubscriptionRegistry();
        holdBystanderTap();
        const before = captureSeedHolds(subscriptions);
        armThrow();

        await expect(
          handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions),
        ).rejects.toThrow(/unavailable/);

        // The seed was taken, so the capture had been up; the throw came after it.
        expect(sessionManager.getSeedFrame).toHaveBeenCalledTimes(1);
        expect(captureSeedHolds(subscriptions)).toEqual(before);
        // The throw came before any stream listener was registered.
        expect(sessionManager.listenerCount('exit')).toBe(0);
      });

      it('a failed terminal re-subscribe over a live terminal stream leaves that stream, its tap, and the marker in place', async () => {
        const context = { sessionManager } as unknown as IpcContext;
        const subscriptions = new SubscriptionRegistry();
        const session = fakeSession();
        await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);
        const liveStream = captureSeedHolds(subscriptions);
        expect(liveStream).toEqual({ dataTapListeners: 1, tapRefs: 1, terminalMarker: true, streamSubscribed: true });

        // The phone asks again (a reconnect, a reopened terminal) and the seed fails.
        sessionManager.getSeedFrame.mockRejectedValueOnce(new Error('pty host gone'));
        await expect(
          handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions),
        ).rejects.toThrow('pty host gone');

        // The failed call gave back only its own capture and seed tap. The first
        // stream is still the live one, so the marker that says "a phone is
        // watching this terminal" must still be up.
        expect(captureSeedHolds(subscriptions)).toEqual(liveStream);
        expect(sessionManager.listenerCount('exit')).toBe(1);
        sessionManager.emit('data-tap', 'sess-1', 'still live');
        expect(terminalDataSent(session)).toBe('still live');
      });

      it('a successful terminal subscribe keeps the terminal marker and the live stream, and live output still reaches the phone', async () => {
        const context = { sessionManager } as unknown as IpcContext;
        const subscriptions = new SubscriptionRegistry();
        const session = fakeSession();

        const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

        expect(response.ok).toBe(true);
        // subscribeReadStream re-registered the marker as the live stream's own;
        // the failure-path cleanup must not take it.
        expect(captureSeedHolds(subscriptions)).toEqual({
          // The seed capture is gone; this one is the stream's own listener and tap.
          dataTapListeners: 1,
          tapRefs: 1,
          terminalMarker: true,
          streamSubscribed: true,
        });
        sessionManager.emit('data-tap', 'sess-1', 'live output');
        expect(terminalDataSent(session)).toBe('live output');
      });

      /**
       * A phone always gets a terminal. A seed whose response would be over the
       * protocol's frame caps is shrunk (history scaled down, then the grid
       * alone, then no seed) and answered ok, never refused. A refused
       * subscribe reads to the phone as the session being gone. The check and
       * the re-takes happen BEFORE subscribing, because subscribeReadStream's
       * set() runs the prior teardown on the key.
       */
      describe('a response over the frame caps', () => {
        /** Over MAX_DECODED_LENGTH (4 MiB) of JSON, so the encode fails before any deflate. */
        const overCapSeed = 'x'.repeat(4.5 * 1024 * 1024);
        const historyLinesFor = (scrollbackLines: number): string => 'x'.repeat(scrollbackLines * 1000);
        let warnSpy: MockInstance<typeof console.warn>;

        beforeEach(() => {
          warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        });

        afterEach(() => {
          warnSpy.mockRestore();
        });

        function warnLines(): string[] {
          return warnSpy.mock.calls.map((call) => String(call[0]));
        }

        function activityEventsSent(session: BridgeSession): number {
          const sendMessage = session.sendMessage as unknown as ReturnType<typeof vi.fn>;
          return sendMessage.mock.calls
            .map(([message]) => message as { type: string; event?: { kind: string } })
            .filter((message) => message.type === 'event' && message.event?.kind === 'activity').length;
        }

        /** Pseudo-random text over a 64-symbol alphabet from a fixed seed: deflate keeps about three quarters of it. */
        function seededNoise(length: number): string {
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          let seed = 0x2545f491;
          const symbols = new Array<string>(length);
          for (let index = 0; index < length; index++) {
            seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
            symbols[index] = alphabet[(seed >>> 16) & 63];
          }
          return symbols.join('');
        }

        /** The 0.8 keep-margin and 1.25 overshoot floor the shrink scales by (read-stream.ts). */
        const SHRINK_FIT_MARGIN = 0.8;
        const SHRINK_MIN_OVERSHOOT = 1.25;

        /**
         * The history depth the first re-take should ask for, worked out from the
         * wire sizes rather than read off the handler. `sentResponse` is the
         * response that was returned (it carries `sentFrame`); the response the
         * shrink measured differs from it only in that field, so its size is the
         * sent size with the sent frame's JSON swapped for the full frame's.
         * `refusingCap` is the cap that response overshot, named by each test.
         */
        function expectedFirstRetakeDepth(
          sentResponse: CapabilityResponseMessage,
          fullFrame: string,
          sentFrame: string,
          refusingCap: number,
        ): number {
          const fullResponseBytes = Buffer.byteLength(JSON.stringify(sentResponse), 'utf8')
            - Buffer.byteLength(JSON.stringify(sentFrame), 'utf8')
            + Buffer.byteLength(JSON.stringify(fullFrame), 'utf8');
          const overshoot = Math.max(fullResponseBytes / refusingCap, SHRINK_MIN_OVERSHOOT);
          return Math.floor((SERIALIZED_SCROLLBACK_LINES * SHRINK_FIT_MARGIN) / overshoot);
        }

        it('answers ok with a shorter seed and registers the subscription, scaling the history by the overshoot', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          const subscriptions = new SubscriptionRegistry();
          const session = fakeSession();
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) =>
            scrollbackLines === undefined ? overCapSeed : historyLinesFor(scrollbackLines));

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

          expect(response.ok).toBe(true);
          // 4.5 MiB against the 4 MiB cap is 1.125x, floored at 1.25x: 500 lines at 0.8 / 1.25.
          expect(sessionManager.getSeedFrame.mock.calls).toEqual([['sess-1'], ['sess-1', 320]]);
          expect((response.payload as { scrollback: string }).scrollback).toBe(historyLinesFor(320));
          expect(captureSeedHolds(subscriptions)).toEqual({ dataTapListeners: 1, tapRefs: 1, terminalMarker: true, streamSubscribed: true });
          sessionManager.emit('data-tap', 'sess-1', 'live output');
          expect(terminalDataSent(session)).toBe('live output');
          expect(warnLines()).toEqual([
            '[mobile-bridge] read-stream/subscribe req-1 from device-1 shrank its terminal seed to fit the wire: 4608k chars to 313k chars (sent 320 history lines)',
          ]);
        });

        it('notes a "seed shrink" span for the slow-request line when a shrink ran, after the seed\'s own span', async () => {
          const { takeRequestSpans, resetRequestSpansForTests } = await import('../../../src/main/mobile-bridge/request-spans');
          resetRequestSpansForTests();
          const context = { sessionManager } as unknown as IpcContext;
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) =>
            scrollbackLines === undefined ? overCapSeed : historyLinesFor(scrollbackLines));

          await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

          const spans = takeRequestSpans('device-1', 'req-1');
          expect(spans).toHaveLength(2);
          expect(spans[0]).toMatch(/^seed \d+ ms \(settle 12 ms, serialize 3 ms\), 4608k chars$/);
          expect(spans[1]).toMatch(/^seed shrink \d+ ms$/);
        });

        it('a list-only subscribe never takes a seed, so it never shrinks or warns', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          const subscriptions = new SubscriptionRegistry();
          // Would be over the caps if anything asked for it.
          sessionManager.getSerializedFrame.mockResolvedValue(overCapSeed);

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, subscriptions);

          expect(response.ok).toBe(true);
          expect((response.payload as { scrollback: string }).scrollback).toBe('');
          expect(sessionManager.getSeedFrame).not.toHaveBeenCalled();
          expect(subscriptions.has('stream:sess-1')).toBe(true);
          expect(warnLines()).toEqual([]);
        });

        it('sends the grid alone when the scaled history still does not fit', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          const subscriptions = new SubscriptionRegistry();
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) =>
            scrollbackLines === 0 ? 'GRID' : overCapSeed);

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);

          expect(response.ok).toBe(true);
          expect(sessionManager.getSeedFrame.mock.calls).toEqual([['sess-1'], ['sess-1', 320], ['sess-1', 0]]);
          expect((response.payload as { scrollback: string }).scrollback).toBe('GRID');
          expect(subscriptions.has('stream:sess-1')).toBe(true);
          expect(warnLines()).toEqual([
            '[mobile-bridge] read-stream/subscribe req-1 from device-1 shrank its terminal seed to fit the wire: 4608k chars to 0k chars (sent the grid alone)',
          ]);
        });

        it('sends an empty seed when even the grid does not fit, and still registers the subscription', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          const subscriptions = new SubscriptionRegistry();
          const session = fakeSession();
          sessionManager.getSerializedFrame.mockResolvedValue(overCapSeed);

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

          expect(response.ok).toBe(true);
          expect((response.payload as { scrollback: string }).scrollback).toBe('');
          expect(captureSeedHolds(subscriptions)).toEqual({ dataTapListeners: 1, tapRefs: 1, terminalMarker: true, streamSubscribed: true });
          sessionManager.emit('data-tap', 'sess-1', 'live output');
          expect(terminalDataSent(session)).toBe('live output');
          expect(warnLines()).toEqual([
            '[mobile-bridge] read-stream/subscribe req-1 from device-1 shrank its terminal seed to fit the wire: 4608k chars to 0k chars (sent an empty seed)',
          ]);
        });

        it('filters the tap by the last re-take\'s barrier when it sends an empty seed', async () => {
          const session = fakeSession();
          const context = { sessionManager } as unknown as IpcContext;
          sessionManager.seedBarrierOffset = 100;
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) => {
            // The grid-alone re-take is the last snapshot; it moves the barrier forward.
            if (scrollbackLines === 0) {
              sessionManager.seedBarrierOffset = 200;
              sessionManager.emit('data-tap', 'sess-1', 'OLD', 150);
              sessionManager.emit('data-tap', 'sess-1', 'NEW', 205);
            }
            return overCapSeed;
          });

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

          expect(response.ok).toBe(true);
          expect((response.payload as { scrollback: string }).scrollback).toBe('');
          // Nothing may reach the phone ahead of the response the caller sends next.
          expect(terminalDataSent(session)).toBe('');
          await settleCoalesceTimer();

          // OLD is inside the last snapshot (its barrier is 200, not the first one's 100); NEW is past it.
          expect(terminalDataSent(session)).toBe('NEW');
        });

        it('filters the tap by the barrier of the frame that is sent, not the first one taken', async () => {
          const session = fakeSession();
          const context = { sessionManager } as unknown as IpcContext;
          sessionManager.seedBarrierOffset = 100;
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) => {
            if (scrollbackLines === undefined) {
              // Past the first snapshot's barrier, but inside the re-take's.
              sessionManager.emit('data-tap', 'sess-1', 'FIRST', 120);
              return overCapSeed;
            }
            sessionManager.seedBarrierOffset = 200;
            sessionManager.emit('data-tap', 'sess-1', 'OLD', 150);
            sessionManager.emit('data-tap', 'sess-1', 'MID', 203);
            return historyLinesFor(scrollbackLines);
          });

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
          expect(response.ok).toBe(true);
          // Nothing may reach the phone ahead of the response the caller sends next.
          expect(terminalDataSent(session)).toBe('');
          await settleCoalesceTimer();

          // FIRST and OLD are in the frame that was sent; MID is new output.
          expect(terminalDataSent(session)).toBe('MID');
        });

        it('reads the pending prompt options from the first, full frame, not the shrunk one that is sent', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
          // Over the 1 MiB wire cap even after deflate; the dialog is at the bottom.
          const fullFrame = `${seededNoise(1_800_000)}\r\n${permissionDialogFrame}`;
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) =>
            scrollbackLines === undefined ? fullFrame : 'shrunk, no dialog here');

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

          const payload = response.payload as { scrollback: string; awaitedPromptId: string | null; awaitedPromptOptions?: string[] | null };
          expect(response.ok).toBe(true);
          expect(payload.scrollback).toBe('shrunk, no dialog here');
          expect(payload.awaitedPromptId).toBe('sess-1:tool-9');
          expect(payload.awaitedPromptOptions).toEqual(permissionDialogOptions);

          // The raw JSON is between the two caps (over 1 MiB, under 4 MiB), so
          // the overshoot is measured against the wire cap, not the decoded one.
          const expectedDepth = expectedFirstRetakeDepth(response, fullFrame, 'shrunk, no dialog here', MAX_FRAME_LENGTH);
          // Measured against the 4 MiB cap it would floor at 1.25x and ask for 320.
          expect(expectedDepth).toBeLessThan(320);
          expect(sessionManager.getSeedFrame.mock.calls).toEqual([['sess-1'], ['sess-1', expectedDepth]]);
        });

        it('scales the re-take by the overshoot of the decoded cap when the raw JSON is far over it', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          // 8 MiB of frame against the 4 MiB cap is about 2.0x, above the 1.25x floor.
          const fullFrame = 'x'.repeat(8 * 1024 * 1024);
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) =>
            scrollbackLines === undefined ? fullFrame : historyLinesFor(scrollbackLines));

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

          expect(response.ok).toBe(true);
          const sentFrame = (response.payload as { scrollback: string }).scrollback;
          const expectedDepth = expectedFirstRetakeDepth(response, fullFrame, sentFrame, MAX_DECODED_LENGTH);
          // Roughly 500 * 0.8 / 2.0, and not the 320 a barely-over frame gets.
          expect(expectedDepth).toBeLessThan(320);
          expect(sessionManager.getSeedFrame.mock.calls).toEqual([['sess-1'], ['sess-1', expectedDepth]]);
          expect(sentFrame).toBe(historyLinesFor(expectedDepth));
        });

        it('reads the prompt options from the re-take when the prompt rose during the shrink', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          // No prompt when the full frame is taken, so that frame is not probed.
          const dialogAtBottom = `${'x'.repeat(1000)}\r\n${permissionDialogFrame}`;
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) => {
            if (scrollbackLines === undefined) return overCapSeed;
            // The prompt rises while the re-take is being taken, and its dialog is in that frame.
            sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
            return dialogAtBottom;
          });

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());

          const payload = response.payload as { scrollback: string; awaitedPromptId: string | null; awaitedPromptOptions?: string[] | null };
          expect(response.ok).toBe(true);
          expect(payload.scrollback).toBe(dialogAtBottom);
          expect(payload.awaitedPromptId).toBe('sess-1:tool-9');
          expect(payload.awaitedPromptOptions).toEqual(permissionDialogOptions);
        });

        it('leaves a phone with a feed throughout: an over-cap terminal upgrade replaces the list-only feed with the terminal stream', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          const subscriptions = new SubscriptionRegistry();
          const session = fakeSession();
          await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);
          expect(captureSeedHolds(subscriptions)).toEqual({ dataTapListeners: 0, tapRefs: 0, terminalMarker: false, streamSubscribed: true });
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) =>
            scrollbackLines === undefined ? overCapSeed : historyLinesFor(scrollbackLines));

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

          expect(response.ok).toBe(true);
          expect(captureSeedHolds(subscriptions)).toEqual({ dataTapListeners: 1, tapRefs: 1, terminalMarker: true, streamSubscribed: true });
          const activityBefore = activityEventsSent(session);
          sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'turn-ended' });
          expect(activityEventsSent(session)).toBe(activityBefore + 1);
        });

        it('an over-cap re-subscribe over a live terminal stream leaves exactly one stream, tap, and marker', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          const subscriptions = new SubscriptionRegistry();
          const session = fakeSession();
          await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) =>
            scrollbackLines === undefined ? overCapSeed : historyLinesFor(scrollbackLines));

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

          expect(response.ok).toBe(true);
          expect(captureSeedHolds(subscriptions)).toEqual({ dataTapListeners: 1, tapRefs: 1, terminalMarker: true, streamSubscribed: true });
          expect(sessionManager.listenerCount('exit')).toBe(1);
        });

        it('a session that ends during a re-take answers "No such session" and gives everything back', async () => {
          const context = { sessionManager } as unknown as IpcContext;
          const subscriptions = new SubscriptionRegistry();
          holdBystanderTap();
          const before = captureSeedHolds(subscriptions);
          sessionManager.getSerializedFrame.mockImplementation(async (_sessionId, scrollbackLines) => {
            if (scrollbackLines === undefined) return overCapSeed;
            sessionManager.getSession.mockReturnValue(undefined);
            return historyLinesFor(scrollbackLines);
          });

          const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);

          expect(response).toEqual({ type: 'capability-response', requestId: 'req-1', ok: false, error: 'No such session: sess-1' });
          expect(captureSeedHolds(subscriptions)).toEqual(before);
          expect(sessionManager.listenerCount('exit')).toBe(0);
        });
      });
    });
  });

  it('records the seed\'s own span against the request for the slow-request line, and none for a list-only subscribe', async () => {
    const { takeRequestSpans, resetRequestSpansForTests } = await import('../../../src/main/mobile-bridge/request-spans');
    resetRequestSpansForTests();
    const context = { sessionManager } as unknown as IpcContext;
    sessionManager.getSerializedFrame.mockResolvedValue('x'.repeat(4096));

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    const spans = takeRequestSpans('device-1', 'req-1');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatch(/^seed \d+ ms \(settle 12 ms, serialize 3 ms\), 4k chars$/);

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, new SubscriptionRegistry());
    expect(takeRequestSpans('device-1', 'req-1')).toEqual([]);
  });

  it('registers the terminal marker BEFORE the awaited seed serialize, so the resize floor is armed inside the settle window', async () => {
    // The park fires, then the handler awaits the repaint settle (20-400ms).
    // A desktop fit landing inside that window consults the floor refusal,
    // which reads the marker - registered only after the await, the floor
    // was inert exactly when the seed's grid was decided.
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    let markerPresentAtSerialize: boolean | null = null;
    sessionManager.getSerializedFrame.mockImplementation(() => {
      markerPresentAtSerialize = subscriptions.has(terminalStreamKeyFor('sess-1'));
      return Promise.resolve('serialized-frame');
    });

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);

    expect(markerPresentAtSerialize).toBe(true);
  });

  it('a session that exits during the seed serialize is not subscribed post-mortem', async () => {
    // The exit teardown for the would-be listeners has already fired for
    // everyone else; registering after it means listeners and the marker
    // leak until the device disconnects, and the dead id rides the
    // terminal-streamed set into the renderer indefinitely.
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    sessionManager.getSerializedFrame.mockImplementation(() => {
      sessionManager.getSession.mockReturnValue(undefined as never);
      return Promise.resolve('serialized-frame');
    });

    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);

    expect(response.ok).toBe(false);
    expect(subscriptions.has(terminalStreamKeyFor('sess-1'))).toBe(false);
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    expect(sessionManager.tapSubscriptions.size).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
  });

  it('unsubscribe and session exit both clear the terminal marker', async () => {
    const context = { sessionManager } as unknown as IpcContext;

    const unsubscribed = new SubscriptionRegistry();
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, unsubscribed);
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'unsubscribe' }), fakeSession(), context, unsubscribed);
    expect(unsubscribed.has(terminalStreamKeyFor('sess-1'))).toBe(false);

    const exited = new SubscriptionRegistry();
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, exited);
    sessionManager.emit('exit', 'sess-1', 0, true);
    expect(exited.has(terminalStreamKeyFor('sess-1'))).toBe(false);
  });

  it('subscribe registers session-manager listeners; unsubscribe removes them', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);
    expect(sessionManager.listenerCount('data-tap')).toBe(1);
    // The pty host forwards the session's raw bytes only while a tap is held.
    expect(sessionManager.tapSubscriptions.get('sess-1')).toBe(1);
    expect(sessionManager.listenerCount('pty-resize')).toBe(1);
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('usage')).toBe(1);
    expect(sessionManager.listenerCount('event')).toBe(1);

    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'unsubscribe' }), fakeSession(), context, subscriptions);
    expect(response.ok).toBe(true);
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    expect(sessionManager.tapSubscriptions.has('sess-1')).toBe(false);
    expect(sessionManager.listenerCount('pty-resize')).toBe(0);
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('usage')).toBe(0);
    expect(sessionManager.listenerCount('event')).toBe(0);
  });

  /**
   * A phone showing its session list needs activity, permission and
   * transcript pushes, but discards PTY bytes on arrival. Measured live, that
   * discard cost roughly 13MB an hour of relay traffic for a feed with no
   * terminal open, plus a full serialized frame per session on every cold
   * start. `terminal: false` subscribes to everything except the bytes.
   */
  it('a list-only subscribe attaches no terminal taps and returns no scrollback', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    const response = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }),
      fakeSession(),
      context,
      subscriptions,
    );

    expect((response.payload as { scrollback: string }).scrollback).toBe('');
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    // No tap, so the pty host never sends this session's bytes to main.
    expect(sessionManager.tapSubscriptions.size).toBe(0);
    expect(sessionManager.listenerCount('pty-resize')).toBe(0);
    // Everything the list actually renders still flows.
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('usage')).toBe(1);
    expect(sessionManager.listenerCount('event')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);
  });

  it('an omitted terminal flag keeps the full stream, so an older phone is unaffected', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    const response = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }),
      fakeSession(),
      context,
      subscriptions,
    );

    expect((response.payload as { scrollback: string }).scrollback).toBe('serialized-frame');
    expect(sessionManager.listenerCount('data-tap')).toBe(1);
    expect(sessionManager.listenerCount('pty-resize')).toBe(1);
  });

  it('a list-only subscriber receives no terminal events when the pty produces output', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    const session = fakeSession();

    await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }),
      session,
      context,
      subscriptions,
    );
    sessionManager.emit('data-tap', 'sess-1', 'output the phone would have discarded');
    sessionManager.emit('pty-resize', 'sess-1', 100, 40);

    const sent = vi.mocked(session.sendMessage).mock.calls.map((call) => call[0] as { event?: { kind?: string } });
    expect(sent.some((message) => message?.event?.kind === 'terminal')).toBe(false);
    expect(sent.some((message) => message?.event?.kind === 'terminal-resize')).toBe(false);
  });

  /**
   * Usage ticks on essentially every token but renders as a percentage bar.
   * Measured live, unthrottled pushes were the largest ONGOING cost once the
   * terminal stream was removed - roughly 1MB an hour to animate one bar.
   */
  it('coalesces a usage burst into one push carrying the newest value', async () => {
    vi.useFakeTimers();
    try {
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      const session = fakeSession();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);
      const before = vi.mocked(session.sendMessage).mock.calls.length;

      for (let tick = 1; tick <= 20; tick += 1) {
        sessionManager.emit('usage', 'sess-1', { ...usageFixture, contextWindow: { ...usageFixture.contextWindow, usedTokens: tick } });
      }
      // Nothing on the wire yet: the whole burst is parked on one timer.
      expect(vi.mocked(session.sendMessage).mock.calls.length).toBe(before);

      await vi.advanceTimersByTimeAsync(2100);

      const usagePushes = vi
        .mocked(session.sendMessage)
        .mock.calls.slice(before)
        .map((call) => call[0] as { event?: { payload?: { type?: string; usage?: { contextWindow?: { usedTokens?: number } } } } })
        .filter((message) => message?.event?.payload?.type === 'usage');
      expect(usagePushes).toHaveLength(1);
      // The NEWEST value, not the first of the burst.
      expect(usagePushes[0].event?.payload?.usage?.contextWindow?.usedTokens).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the pending usage when the session exits, so the final count is not lost', async () => {
    vi.useFakeTimers();
    try {
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      const session = fakeSession();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

      sessionManager.emit('usage', 'sess-1', usageFixture);
      sessionManager.emit('exit', 'sess-1', 0, true);

      const sent = vi
        .mocked(session.sendMessage)
        .mock.calls.map((call) => call[0] as { event?: { payload?: { type?: string } } })
        .filter((message) => message?.event?.payload?.type === 'usage');
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears its own subscription down when the streamed session exits (no listener leak)', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, subscriptions);
    expect(sessionManager.listenerCount('data-tap')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);

    // Exiting a DIFFERENT session leaves this subscription intact.
    sessionManager.emit('exit', 'sess-OTHER', 0, false);
    expect(sessionManager.listenerCount('data-tap')).toBe(1);

    // Exiting the streamed session removes EVERY listener it registered, so a
    // long-lived phone connection does not leak listeners per streamed session.
    sessionManager.emit('exit', 'sess-1', 0, false);
    expect(sessionManager.listenerCount('data-tap')).toBe(0);
    expect(sessionManager.listenerCount('pty-resize')).toBe(0);
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('usage')).toBe(0);
    expect(sessionManager.listenerCount('event')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
    expect(sessionManager.listenerCount('session-changed')).toBe(0);
    expect(sessionManager.listenerCount('session-removed')).toBe(0);
    expect(subscriptions.has('stream:sess-1')).toBe(false);
  });

  it('pushes a session-ended activity event (with the intentional flag) before tearing down on exit', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

    sessionManager.emit('data-tap', 'sess-1', 'y'.repeat(300)); // parked on the coalesce timer
    sessionManager.emit('exit', 'sess-1', 0, true);

    const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    // The pending old-grid output flushes FIRST, then session-ended is the feed's last word.
    expect((calls[calls.length - 2][0] as { event: { kind: string } }).event.kind).toBe('terminal');
    expect(calls[calls.length - 1][0]).toEqual({
      type: 'event',
      event: { kind: 'activity', sessionId: 'sess-1', taskId: 'task-1', payload: { type: 'session-ended', intentional: true } },
    });
    expect(subscriptions.has('stream:sess-1')).toBe(false);
  });

  it('a crash exit (and the flag-less spawn-failure emit) reports intentional false', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
    sessionManager.emit('exit', 'sess-1', -1); // spawn-failure path emits no intentional flag
    const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[calls.length - 1][0] as { event: { payload: unknown } }).event.payload).toEqual({
      type: 'session-ended',
      intentional: false,
    });
  });

  it('a respawn (an in-flight spawn-progress label for the task) attaches spawnProgressLabel to session-ended', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    // Mirrors suspendLiveSessionForRespawn (task-move.ts): the label is
    // emitted BEFORE the suspend that produces this exit.
    emitSpawnProgress(fakeWindow(), 'task-1', 'switching-model');
    sessionManager.emit('exit', 'sess-1', 0, true);

    const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[calls.length - 1][0] as { event: { payload: unknown } }).event.payload).toEqual({
      type: 'session-ended',
      intentional: true,
      spawnProgressLabel: 'Switching model...',
    });
  });

  it('session-ended carries the label sanitized: a raw git progress line loses its escape codes and carriage return', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    // createProgressCallback passes an unknown phase (a raw git line) through.
    createProgressCallback(fakeWindow(), 'task-1')('\u001b[32mReceiving objects:\u001b[0m 45%\r');
    sessionManager.emit('exit', 'sess-1', 0, true);

    const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[calls.length - 1][0] as { event: { payload: unknown } }).event.payload).toEqual({
      type: 'session-ended',
      intentional: true,
      spawnProgressLabel: 'Receiving objects: 45%',
    });
  });

  it('a genuine park (no in-flight spawn-progress label) omits spawnProgressLabel entirely', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    sessionManager.emit('exit', 'sess-1', 0, true);

    const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const payload = (calls[calls.length - 1][0] as { event: { payload: object } }).event.payload;
    expect('spawnProgressLabel' in payload).toBe(false);
  });

  it('the subscribe snapshot carries the live session status', async () => {
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect((response.payload as { sessionStatus?: string }).sessionStatus).toBe('running');
  });

  it('subscribing a suspended-but-registered session reports its suspended status', async () => {
    sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect(response.ok).toBe(true);
    expect((response.payload as { sessionStatus?: string }).sessionStatus).toBe('suspended');
  });

  describe('resuming, live status, and the successor hop', () => {
    /** Every activity event (envelope included) this bridge session was sent, in order. */
    function sentActivityEvents(session: BridgeSession): Array<{ kind: string; sessionId: string; taskId: string; payload: Record<string, unknown> }> {
      return vi
        .mocked(session.sendMessage)
        .mock.calls.map((call) => call[0] as { event?: { kind: string; sessionId: string; taskId: string; payload: Record<string, unknown> } })
        .filter((message) => message.event?.kind === 'activity')
        .map((message) => message.event as { kind: string; sessionId: string; taskId: string; payload: Record<string, unknown> });
    }

    /** Every activity payload this bridge session was sent, in order. */
    function sentActivityPayloads(session: BridgeSession): Array<Record<string, unknown>> {
      return sentActivityEvents(session).map((event) => event.payload);
    }

    /**
     * The producer-to-parser round trip: what the phone's feed router does with
     * each event the desktop sent. The envelope must pass `isBridgeEvent` (a
     * false return drops the event on the phone), and narrowing the payload
     * must give back exactly what was sent, so a field the desktop emits but
     * the parser does not copy (or the reverse) fails here instead of vanishing
     * on a phone.
     */
    function expectPhoneAcceptsEveryActivityEvent(session: BridgeSession): void {
      const events = sentActivityEvents(session);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(isBridgeEvent(event)).toBe(true);
        expect(parseActivityEventPayload(event.payload as JsonValue)).toEqual(event.payload);
      }
    }

    it('the snapshot carries resumable true for a paused session the desktop would offer Resume for', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'suspended', resuming: false });
      const context = { sessionManager } as unknown as IpcContext;
      const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, new SubscriptionRegistry());

      expect((response.payload as { resumable?: boolean }).resumable).toBe(true);
      expect(taskGetByIdMock).toHaveBeenCalledWith('task-1');
      expect(swimlaneGetByIdMock).toHaveBeenCalledWith('lane-review');
    });

    it.each([
      ['a running session', { status: 'running' }, {}, {}],
      ['a paused task in Done', { status: 'suspended' }, {}, { role: 'done' }],
      ['a paused task in To Do', { status: 'suspended' }, {}, { role: 'todo' }],
      ['a paused archived task', { status: 'suspended' }, { archived_at: '2026-10-01T00:00:00.000Z' }, {}],
      ['a paused Command Terminal session', { status: 'suspended', transient: true }, {}, {}],
      ['a paused session whose task is gone', { status: 'suspended' }, null, {}],
    ])('the snapshot carries resumable false for %s', async (_label, sessionOverrides, taskOverrides, laneOverrides) => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'running', resuming: false, ...sessionOverrides });
      if (taskOverrides === null) {
        taskGetByIdMock.mockReturnValue(undefined);
      } else {
        taskGetByIdMock.mockReturnValue({ id: 'task-1', swimlane_id: 'lane-review', archived_at: null, ...taskOverrides });
      }
      swimlaneGetByIdMock.mockReturnValue({ id: 'lane-review', role: null, ...laneOverrides });
      const context = { sessionManager } as unknown as IpcContext;
      const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, new SubscriptionRegistry());

      expect((response.payload as { resumable?: boolean }).resumable).toBe(false);
    });

    it('the snapshot carries resumable false for a paused row whose task already holds a queued successor', async () => {
      // A respawn queued behind the concurrency limit: the desktop shows the
      // queued session and offers no Resume, and start-session answers `live`.
      const pausedRow = { id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'suspended', resuming: false };
      sessionManager.getSession.mockReturnValue(pausedRow);
      sessionManager.listSessions.mockReturnValue([
        pausedRow,
        { id: 'sess-2', taskId: 'task-1', projectId: 'proj-1', status: 'queued', resuming: true },
      ]);
      const context = { sessionManager } as unknown as IpcContext;
      const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, new SubscriptionRegistry());

      expect(response.ok).toBe(true);
      expect((response.payload as { resumable?: boolean }).resumable).toBe(false);
    });

    it('the snapshot carries resumable false, with no task lookup, for a paused session that has no owning project', async () => {
      // The row is a normal paused task session in every other respect (task id
      // set, suspended, not transient), so only the missing project can be what
      // answers false. The repo mock ignores its project argument, so without
      // the guard the lookup would find the task and answer true.
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      const context = { sessionManager } as unknown as IpcContext;
      const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, new SubscriptionRegistry());

      expect(response.ok).toBe(true);
      expect((response.payload as { resumable?: boolean }).resumable).toBe(false);
      expect(taskGetByIdMock).not.toHaveBeenCalled();
    });

    it('a paused session whose task cannot be read still subscribes, with resumable false', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'suspended', resuming: false });
      taskGetByIdMock.mockImplementation(() => {
        throw new Error('database is locked');
      });
      const subscriptions = new SubscriptionRegistry();
      const context = { sessionManager } as unknown as IpcContext;
      const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), fakeSession(), context, subscriptions);

      expect(response.ok).toBe(true);
      expect((response.payload as { resumable?: boolean }).resumable).toBe(false);
      // The lookup was attempted, so the false came from the failed read and
      // not from an earlier guard; the feed is still registered.
      expect(taskGetByIdMock).toHaveBeenCalledWith('task-1');
      expect(subscriptions.has('stream:sess-1')).toBe(true);
    });

    it('a suspend pushes status with resumable true, and a move to Done while paused pushes resumable false on the next edge', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'running', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, new SubscriptionRegistry());

      // A queued row suspended: no PTY, so no exit, and the feed stays. The
      // registry holds the suspended row by the time it announces it.
      const suspendedRow = { id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'suspended', resuming: false };
      sessionManager.getSession.mockReturnValue(suspendedRow);
      sessionManager.emit('session-changed', 'sess-1', suspendedRow);
      expect(sentActivityPayloads(session)).toEqual([{ type: 'status', status: 'suspended', resuming: false, resumable: true }]);

      // The status itself does not change, but the column now refuses Resume:
      // the next edge carries the new resumable alone.
      swimlaneGetByIdMock.mockReturnValue({ id: 'lane-review', role: 'done' });
      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'suspended', resuming: false });
      expect(sentActivityPayloads(session)).toEqual([
        { type: 'status', status: 'suspended', resuming: false, resumable: true },
        { type: 'status', status: 'suspended', resuming: false, resumable: false },
      ]);
      expectPhoneAcceptsEveryActivityEvent(session);
    });

    it('the snapshot carries resuming from the session row', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'running', resuming: true });
      const context = { sessionManager } as unknown as IpcContext;
      const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), fakeSession(), context, new SubscriptionRegistry());
      expect((response.payload as { resuming?: boolean }).resuming).toBe(true);
    });

    it('status and resuming come from the row read AFTER the frame serialize, not the one read before it', async () => {
      // A queue promotion inside the serialize await replaces the registry row:
      // the pre-await read says queued, the post-await read says running.
      sessionManager.getSession
        .mockReturnValueOnce({ id: 'sess-1', taskId: 'task-1', status: 'queued', resuming: false })
        .mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'running', resuming: true });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      const payload = response.payload as { sessionStatus?: string; resuming?: boolean };
      expect(payload.sessionStatus).toBe('running');
      expect(payload.resuming).toBe(true);
      // The post-await row is also the dedupe baseline: re-announcing it pushes nothing.
      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'running', resuming: true });
      expect(sentActivityPayloads(session).filter((payload) => payload.type === 'status')).toHaveLength(0);
    });

    it('pushes one status event per real change and none on a repeat or for another session', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'queued', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, new SubscriptionRegistry());

      // A session-changed with no status change (an agent session id captured).
      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'queued', resuming: false });
      // Another task's session.
      sessionManager.emit('session-changed', 'sess-9', { id: 'sess-9', taskId: 'task-9', status: 'running', resuming: false });
      expect(sentActivityPayloads(session)).toEqual([]);

      // The queue promotes it.
      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'running', resuming: false });
      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'running', resuming: false });
      expect(sentActivityPayloads(session)).toEqual([{ type: 'status', status: 'running', resuming: false, resumable: false }]);
      expectPhoneAcceptsEveryActivityEvent(session);
    });

    it('a resuming-only flip (status unchanged) pushes exactly one status event, and a repeat pushes none', async () => {
      // The row stays 'running'; only `resuming` goes false -> true, as it does
      // when a resumed session's agent is still replaying its transcript.
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'running', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, new SubscriptionRegistry());

      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'running', resuming: true });
      expect(sentActivityPayloads(session)).toEqual([{ type: 'status', status: 'running', resuming: true, resumable: false }]);

      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'running', resuming: true });
      expect(sentActivityPayloads(session)).toHaveLength(1);
      expectPhoneAcceptsEveryActivityEvent(session);
    });

    it('running -> suspended pushes status before the exit\'s session-ended, then tears down', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

      // SessionManager.suspend(): status flip and session-changed, then the PTY exit.
      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      sessionManager.emit('exit', 'sess-1', 0, true);

      expect(sentActivityPayloads(session)).toEqual([
        { type: 'status', status: 'suspended', resuming: false, resumable: false },
        { type: 'session-ended', intentional: true },
      ]);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
      expectPhoneAcceptsEveryActivityEvent(session);
    });

    it('an exited status (the agent-absence sweep) is pushed without tearing the feed down; the exit that follows ends it', async () => {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

      sessionManager.emit('session-changed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'exited', resuming: false });
      expect(subscriptions.has('stream:sess-1')).toBe(true);
      sessionManager.emit('exit', 'sess-1', 0, true);

      expect(sentActivityPayloads(session)).toEqual([
        { type: 'status', status: 'exited', resuming: false, resumable: false },
        { type: 'session-ended', intentional: true },
      ]);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
    });

    it('a resume that replaces the paused row ends the old feed naming the successor', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);

      // The spawn flow drops the paused row with no event, then announces the
      // new session, which carries a fresh id.
      sessionManager.getSession.mockImplementation((id: string) => (
        id === 'sess-2' ? { id, taskId: 'task-1', status: 'running', resuming: true } : undefined
      ));
      sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: 'task-1', status: 'running', resuming: true });

      expect(sentActivityPayloads(session)).toEqual([
        { type: 'session-ended', intentional: true, successorSessionId: 'sess-2' },
      ]);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
      expect(sessionManager.listenerCount('session-changed')).toBe(0);
      expectPhoneAcceptsEveryActivityEvent(session);
    });

    it('a resume whose label is still in flight ends the old feed with BOTH the label and the successor', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);

      // resumeTaskSession labels the task 'resuming' before its git phase and
      // releases that claim only in its `finally`, which runs after the spawn
      // flow has dropped the paused row and announced the successor. So the
      // label is still up when the feed ends.
      emitSpawnProgress(fakeWindow(), 'task-1', 'resuming');
      sessionManager.getSession.mockImplementation((id: string) => (
        id === 'sess-2' ? { id, taskId: 'task-1', status: 'running', resuming: true } : undefined
      ));
      sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: 'task-1', status: 'running', resuming: true });

      expect(sentActivityPayloads(session)).toEqual([
        { type: 'session-ended', intentional: true, spawnProgressLabel: 'Resuming session...', successorSessionId: 'sess-2' },
      ]);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
      expectPhoneAcceptsEveryActivityEvent(session);
    });

    it('a successor that appears while the paused row still exists (queue full) sends nothing until the row is dropped', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);

      // Queued behind the concurrency limit: the paused row is still registered.
      sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: 'task-1', status: 'queued', resuming: true });
      expect(sentActivityPayloads(session)).toEqual([]);
      expect(subscriptions.has('stream:sess-1')).toBe(true);

      // Promotion drops the paused row, then announces the successor running.
      sessionManager.getSession.mockImplementation((id: string) => (
        id === 'sess-2' ? { id, taskId: 'task-1', status: 'running', resuming: true } : undefined
      ));
      sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: 'task-1', status: 'running', resuming: true });
      expect(sentActivityPayloads(session)).toEqual([
        { type: 'session-ended', intentional: true, successorSessionId: 'sess-2' },
      ]);
      expectPhoneAcceptsEveryActivityEvent(session);
    });

    it('a removed paused row ends the feed with no successor', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);

      sessionManager.emit('session-removed', 'sess-OTHER', { id: 'sess-OTHER', taskId: 'task-9', status: 'exited', resuming: false });
      expect(subscriptions.has('stream:sess-1')).toBe(true);
      sessionManager.emit('session-removed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });

      expect(sentActivityPayloads(session)).toEqual([{ type: 'session-ended', intentional: true }]);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
    });

    it('a removed RUNNING session flushes its parked terminal bytes, ends the feed, and its later exit sends nothing more', async () => {
      // remove() lands BEFORE the PTY's asynchronous 'exit', so a feed on a
      // running session is ended by the removal itself, not only a paused row's.
      vi.useFakeTimers();
      try {
        const session = fakeSession();
        const context = { sessionManager } as unknown as IpcContext;
        const subscriptions = new SubscriptionRegistry();
        await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: true }), session, context, subscriptions);
        expect(sessionManager.tapSubscriptions.get('sess-1')).toBe(1);

        // Past TERMINAL_IMMEDIATE_FLUSH_CHARS, so the bytes park on the
        // coalesce timer instead of taking the keystroke fast path.
        const parkedOutput = 'r'.repeat(300);
        sessionManager.emit('data-tap', 'sess-1', parkedOutput);
        expect(session.sendMessage).not.toHaveBeenCalled();

        sessionManager.emit('session-removed', 'sess-1', { id: 'sess-1', taskId: 'task-1', status: 'running', resuming: false });

        // The pending bytes ship FIRST, then session-ended is the feed's last word.
        const sentEvents = vi.mocked(session.sendMessage).mock.calls.map((call) => (call[0] as { event: { kind: string; payload: Record<string, unknown> } }).event);
        expect(sentEvents.map((event) => event.kind)).toEqual(['terminal', 'activity']);
        expect(sentEvents[0].payload).toEqual({ data: parkedOutput });
        expect(sentEvents[1].payload).toEqual({ type: 'session-ended', intentional: true });
        expectPhoneAcceptsEveryActivityEvent(session);

        // The subscription is fully torn down: registry entry, tap, listeners.
        expect(subscriptions.has('stream:sess-1')).toBe(false);
        expect(sessionManager.tapSubscriptions.size).toBe(0);
        expect(sessionManager.listenerCount('data-tap')).toBe(0);
        expect(sessionManager.listenerCount('exit')).toBe(0);

        // The PTY's exit arrives afterwards, and neither it nor a stray timer
        // adds a second session-ended or a duplicate flush.
        const sentBeforeExit = vi.mocked(session.sendMessage).mock.calls.length;
        sessionManager.emit('exit', 'sess-1', 0, true);
        await vi.runAllTimersAsync();
        expect(vi.mocked(session.sendMessage).mock.calls).toHaveLength(sentBeforeExit);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a successor whose spawn failed after the drain ends the feed with no successor', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);

      // Another task's session exiting while this row still exists changes nothing.
      sessionManager.emit('exit', 'sess-9', -1);
      expect(subscriptions.has('stream:sess-1')).toBe(true);

      // spawn-failure-handler: the paused row is gone, the successor is
      // registered 'exited' and reports only 'exit'.
      sessionManager.getSession.mockImplementation((id: string) => (
        id === 'sess-2' ? { id, taskId: 'task-1', status: 'exited', resuming: true } : undefined
      ));
      sessionManager.getSessionTaskId.mockImplementation((id: string) => (id === 'sess-2' ? 'task-1' : undefined));
      sessionManager.emit('exit', 'sess-2', -1);

      expect(sentActivityPayloads(session)).toEqual([{ type: 'session-ended', intentional: true }]);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
    });

    it('an exit of another session of the same task leaves the feed alone while its own row is still registered', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);

      // sess-2 passes the task check a real successor passes, and the feed
      // tracks successors, so only the "own row is gone" check can be what
      // holds the feed in place: a live paused row is not replaced by anything.
      sessionManager.getSessionTaskId.mockImplementation((id: string) => (id === 'sess-2' ? 'task-1' : undefined));
      sessionManager.emit('exit', 'sess-2', -1);

      expect(sentActivityPayloads(session)).toEqual([]);
      expect(subscriptions.has('stream:sess-1')).toBe(true);
      expect(sessionManager.listenerCount('exit')).toBe(1);

      // Control: the same exit once the feed's own row is gone ends it, so the
      // registered row was the only thing standing in the way.
      sessionManager.getSession.mockReturnValue(undefined);
      sessionManager.emit('exit', 'sess-2', -1);

      const payloads = sentActivityPayloads(session);
      expect(payloads).toEqual([{ type: 'session-ended', intentional: true }]);
      // toEqual treats a key set to undefined as absent, so pin the absence.
      expect('successorSessionId' in payloads[0]).toBe(false);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
    });

    it('a Command Terminal session never treats another session as its successor', async () => {
      sessionManager.getSession.mockReturnValue({ id: 'sess-1', taskId: '', status: 'running', resuming: false, transient: true });
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);

      sessionManager.getSession.mockReturnValue(undefined);
      sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: '', status: 'running', resuming: false, transient: true });

      expect(sentActivityPayloads(session)).toEqual([]);
      expect(subscriptions.has('stream:sess-1')).toBe(true);
    });

    describe('with the feed\'s own row already gone from the registry', () => {
      type RegistryRow = { id: string; taskId: string; status: string; resuming: boolean; transient?: boolean };

      /** Subscribes a list-only feed on `sess-1`; the caller then drops the row (`getSession` -> undefined) the way the spawn flow's sibling drain does. */
      async function subscribeFeed(snapshotRow: RegistryRow = { id: 'sess-1', taskId: 'task-1', status: 'suspended', resuming: false }) {
        sessionManager.getSession.mockReturnValue(snapshotRow);
        const session = fakeSession();
        const subscriptions = new SubscriptionRegistry();
        const context = { sessionManager } as unknown as IpcContext;
        await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe', terminal: false }), session, context, subscriptions);
        return { session, subscriptions };
      }

      it('an exited same-task newcomer ends the feed as intentional with no successor id at all', async () => {
        const { session, subscriptions } = await subscribeFeed();

        // A newcomer that is already 'exited' is no live successor to name.
        sessionManager.getSession.mockReturnValue(undefined);
        sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: 'task-1', status: 'exited', resuming: false });

        const payloads = sentActivityPayloads(session);
        expect(payloads).toEqual([{ type: 'session-ended', intentional: true }]);
        // toEqual treats a key set to undefined as absent, so pin the absence.
        expect('successorSessionId' in payloads[0]).toBe(false);
        expect(subscriptions.has('stream:sess-1')).toBe(false);
        expectPhoneAcceptsEveryActivityEvent(session);
      });

      it('a transient same-task newcomer is never taken for a successor', async () => {
        // The feed's own row is a normal task session, so only the newcomer's
        // transient flag can be what holds the feed in place.
        const { session, subscriptions } = await subscribeFeed();

        sessionManager.getSession.mockReturnValue(undefined);
        sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: 'task-1', status: 'running', resuming: false, transient: true });

        expect(sentActivityPayloads(session)).toEqual([]);
        expect(subscriptions.has('stream:sess-1')).toBe(true);
        expect(sessionManager.listenerCount('session-changed')).toBe(1);

        // Control: the same event without the flag does end the feed, so the
        // flag was the only thing standing in the way.
        sessionManager.emit('session-changed', 'sess-3', { id: 'sess-3', taskId: 'task-1', status: 'running', resuming: false });
        expect(sentActivityPayloads(session)).toEqual([{ type: 'session-ended', intentional: true, successorSessionId: 'sess-3' }]);
        expect(subscriptions.has('stream:sess-1')).toBe(false);
      });

      it('a new session of a different task sends nothing and leaves the subscription in place', async () => {
        const { session, subscriptions } = await subscribeFeed();

        sessionManager.getSession.mockReturnValue(undefined);
        sessionManager.emit('session-changed', 'sess-9', { id: 'sess-9', taskId: 'task-9', status: 'running', resuming: false });

        expect(sentActivityPayloads(session)).toEqual([]);
        expect(subscriptions.has('stream:sess-1')).toBe(true);
        expect(sessionManager.listenerCount('session-changed')).toBe(1);

        // Control: the same event for this feed's own task does end it, so the
        // task check was the only thing standing in the way.
        sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: 'task-1', status: 'running', resuming: false });
        expect(sentActivityPayloads(session)).toEqual([{ type: 'session-ended', intentional: true, successorSessionId: 'sess-2' }]);
      });

      it('an exit of a session of a different task sends nothing and leaves the subscription in place', async () => {
        const { session, subscriptions } = await subscribeFeed();
        const taskIdBySession: Record<string, string> = { 'sess-1': 'task-1', 'sess-2': 'task-1', 'sess-9': 'task-9' };
        sessionManager.getSessionTaskId.mockImplementation((id: string) => taskIdBySession[id]);

        sessionManager.getSession.mockReturnValue(undefined);
        sessionManager.emit('exit', 'sess-9', -1);

        expect(sentActivityPayloads(session)).toEqual([]);
        expect(subscriptions.has('stream:sess-1')).toBe(true);
        expect(sessionManager.listenerCount('exit')).toBe(1);

        // Control: a same-task exit does end it, so the task check was the only
        // thing standing in the way.
        sessionManager.emit('exit', 'sess-2', -1);
        expect(sentActivityPayloads(session)).toEqual([{ type: 'session-ended', intentional: true }]);
        expect(subscriptions.has('stream:sess-1')).toBe(false);
      });

      // Each case removes exactly one half of
      // `tracksSuccessor = taskId !== '' && snapshotSession.transient !== true`
      // from the picture: the newcomer is shaped to pass every OTHER guard, so
      // only that half can be what holds the feed in place. The Command Terminal
      // test above sets both halves at once, so it cannot tell them apart.
      it.each([
        ['the feed\'s own row is transient but carries a task id', { id: 'sess-1', taskId: 'task-1', status: 'running', resuming: false, transient: true }, 'task-1'],
        ['the feed\'s own row has no task id and is not transient', { id: 'sess-1', taskId: '', status: 'running', resuming: false }, ''],
      ])('never treats another session as its successor when %s', async (_label, snapshotRow, sharedTaskId) => {
        const { session, subscriptions } = await subscribeFeed(snapshotRow);
        sessionManager.getSession.mockReturnValue(undefined);
        // Same task id as the feed's own row, not transient, so the newcomer
        // passes the task and transient checks a real successor passes.
        sessionManager.getSessionTaskId.mockImplementation((id: string) => (id === 'sess-2' ? sharedTaskId : undefined));

        sessionManager.emit('exit', 'sess-2', -1);
        expect(sentActivityPayloads(session)).toEqual([]);
        expect(subscriptions.has('stream:sess-1')).toBe(true);

        sessionManager.emit('session-changed', 'sess-2', { id: 'sess-2', taskId: sharedTaskId, status: 'running', resuming: false });
        expect(sentActivityPayloads(session)).toEqual([]);
        expect(subscriptions.has('stream:sess-1')).toBe(true);
        expect(sessionManager.listenerCount('session-changed')).toBe(1);
      });
    });
  });

  it('a small data-tap chunk flushes immediately (keystroke-echo fast path); a different session never pushes', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.emit('data-tap', 'sess-OTHER', 'ignored');
      expect(session.sendMessage).not.toHaveBeenCalled();

      // A few echoed keystrokes: at or under the immediate-flush budget, each
      // ships without waiting out the coalesce timer.
      sessionManager.emit('data-tap', 'sess-1', 'h');
      expect(session.sendMessage).toHaveBeenCalledTimes(1);
      expect(session.sendMessage).toHaveBeenCalledWith({
        type: 'event',
        event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: 'h' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops terminal bytes once teardown begins (suspend/kill writing the exit sequence)', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    sessionManager.emit('data-tap', 'sess-1', 'legit output before teardown');
    expect(session.sendMessage).toHaveBeenCalledTimes(1);

    // suspend()/kill() has now flipped status / stamped intentionalExit,
    // BEFORE writing the adapter's exit sequence into the PTY.
    sessionManager.isSessionTeardownInFlight.mockReturnValue(true);
    sessionManager.emit('data-tap', 'sess-1', '\x03/exit\r'); // the exit sequence itself
    sessionManager.emit('data-tap', 'sess-1', 'bare shell prompt$ '); // the fullscreen TUI's alt-screen-exit repaint

    // No new terminal event for either post-teardown chunk - only the one
    // pushed before teardown began.
    expect(session.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('bytes already parked on the coalesce timer when teardown begins still flush', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      // Past TERMINAL_IMMEDIATE_FLUSH_CHARS, so this lands on the coalesce
      // timer rather than the fast path - genuinely queued, not yet sent.
      const queuedOutput = 'z'.repeat(300);
      sessionManager.emit('data-tap', 'sess-1', queuedOutput);
      expect(session.sendMessage).not.toHaveBeenCalled();

      // Teardown starts while those bytes are still parked.
      sessionManager.isSessionTeardownInFlight.mockReturnValue(true);
      sessionManager.emit('data-tap', 'sess-1', '\x03/exit\r');

      await vi.runAllTimersAsync();

      // The pre-teardown backlog ships; the exit sequence never joined it.
      expect(session.sendMessage).toHaveBeenCalledTimes(1);
      expect(session.sendMessage).toHaveBeenCalledWith({
        type: 'event',
        event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: queuedOutput } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an output burst past the immediate budget coalesces into one terminal event on the timer', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      const bigChunk = 'x'.repeat(300);
      sessionManager.emit('data-tap', 'sess-1', bigChunk);
      sessionManager.emit('data-tap', 'sess-1', 'tail');
      expect(session.sendMessage).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(session.sendMessage).toHaveBeenCalledTimes(1);
      expect(session.sendMessage).toHaveBeenCalledWith({
        type: 'event',
        event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: `${bigChunk}tail` } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pty-resize flushes pending old-grid output first, then pushes a terminal-resize event', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.emit('data-tap', 'sess-1', 'y'.repeat(300)); // parked on the coalesce timer
      sessionManager.emit('pty-resize', 'sess-OTHER', 50, 20); // different session: ignored
      expect(session.sendMessage).not.toHaveBeenCalled();

      sessionManager.emit('pty-resize', 'sess-1', 48, 26);
      const calls = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect((calls[0][0] as { event: { kind: string } }).event.kind).toBe('terminal');
      expect(calls[1][0]).toEqual({
        type: 'event',
        event: { kind: 'terminal-resize', sessionId: 'sess-1', taskId: 'task-1', payload: { cols: 48, rows: 26 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // A phone that subscribed while the session was queued keeps its
  // subscription into the promotion (same id), and the PTY may spawn straight
  // at the stashed resting grid with no resize after it. The spawn's own grid
  // announcement is then the only grid event, so it must reach the phone.
  it('forwards the spawn-origin grid announcement as a terminal-resize', async () => {
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    sessionManager.emit('pty-resize', 'sess-1', 210, 48, 'spawn');

    expect(session.sendMessage).toHaveBeenCalledWith({
      type: 'event',
      event: { kind: 'terminal-resize', sessionId: 'sess-1', taskId: 'task-1', payload: { cols: 210, rows: 48 } },
    });
  });

  const userEntry = { kind: 'user', uuid: 'entry-user-1', ts: 100, text: 'hello agent' };
  const assistantEntry = { kind: 'assistant', uuid: 'entry-assistant-1', ts: 200, blocks: [{ type: 'text', text: 'hi there' }] };

  function liveTranscript(revision: number, entries: unknown[]): unknown {
    return { revision, entries, source: 'live', degraded: false };
  }

  function transcriptPushesOf(session: BridgeSession): unknown[][] {
    return (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => (message as { event?: { kind?: string } }).event?.kind === 'transcript',
    );
  }

  it('subscribe seeds the transcript sync without pushing - the phone bootstraps via transcript-window', async () => {
    resolveTaskTranscriptMock.mockResolvedValue(liveTranscript(1, [userEntry]));
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
    await Promise.resolve();
    await Promise.resolve();

    expect(transcriptPushesOf(session)).toHaveLength(0);
  });

  it('a session event pushes only the changed entries as an indexed delta, and only when the revision increased', async () => {
    vi.useFakeTimers();
    try {
      resolveTaskTranscriptMock
        .mockResolvedValueOnce(liveTranscript(1, [userEntry])) // subscribe-time seed (no push)
        .mockResolvedValueOnce(liveTranscript(1, [userEntry])) // unchanged revision - no push
        .mockResolvedValueOnce(liveTranscript(2, [userEntry, assistantEntry]));
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      await vi.advanceTimersByTimeAsync(0);
      expect(transcriptPushesOf(session)).toHaveLength(0);

      sessionManager.emit('event', 'sess-1', { ts: 1, type: 'tool_start' });
      await vi.advanceTimersByTimeAsync(300);
      expect(transcriptPushesOf(session)).toHaveLength(0); // unchanged revision

      sessionManager.emit('event', 'sess-1', { ts: 2, type: 'tool_end' });
      await vi.advanceTimersByTimeAsync(300);
      const transcriptPushes = transcriptPushesOf(session);
      expect(transcriptPushes).toHaveLength(1);
      expect((transcriptPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
        mode: 'delta',
        revision: 2,
        totalEntries: 2,
        upserts: [{ index: 1, entry: assistantEntry }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a burst of session events reads the transcript once, a quarter second after the burst', async () => {
    vi.useFakeTimers();
    try {
      resolveTaskTranscriptMock.mockResolvedValue(liveTranscript(1, [userEntry]));
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
      await vi.advanceTimersByTimeAsync(0);
      const readsAfterSeed = resolveTaskTranscriptMock.mock.calls.length;

      for (let event = 0; event < 5; event += 1) {
        sessionManager.emit('event', 'sess-1', { ts: event, type: 'tool_start' });
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(resolveTaskTranscriptMock.mock.calls.length).toBe(readsAfterSeed);
      await vi.advanceTimersByTimeAsync(300);
      expect(resolveTaskTranscriptMock.mock.calls.length).toBe(readsAfterSeed + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transcript-window returns the newest slice with its absolute start index', async () => {
    const older = { kind: 'user', uuid: 'entry-older', ts: 50, text: 'earlier question' };
    resolveTaskTranscriptMock.mockResolvedValue(liveTranscript(7, [older, userEntry, assistantEntry]));
    const context = { sessionManager } as unknown as IpcContext;

    const tail = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'transcript-window', limit: 2 }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
    );
    expect(tail.ok).toBe(true);
    expect(tail.payload).toEqual({ revision: 7, totalEntries: 3, startIndex: 1, entries: [userEntry, assistantEntry] });

    const olderPage = await handleReadStream(
      fakeRequest({ sessionId: 'sess-1', action: 'transcript-window', beforeIndex: 1, limit: 2 }),
      fakeSession(),
      context,
      new SubscriptionRegistry(),
    );
    expect(olderPage.payload).toEqual({ revision: 7, totalEntries: 3, startIndex: 0, entries: [older] });
  });

  it('pushes a permission activity event (with parsed option labels) when a prompt appears, deduplicates, and clears with pending false', async () => {
    const session = fakeSession();
    sessionManager.getSerializedFrame.mockResolvedValue(permissionDialogFrame);
    const context = { sessionManager } as unknown as IpcContext;
    await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

    const permissionPushes = (): unknown[][] =>
      (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );

    // A prompt appears after subscribe: the next activity emission carries it,
    // labeled from the dialog the probe finds in the frame.
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    await flushProbe();
    expect(permissionPushes()).toHaveLength(1);
    expect(permissionPushes()[0][0]).toEqual({
      type: 'event',
      event: {
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'permission', promptId: 'sess-1:tool-7', pending: true, options: permissionDialogOptions },
      },
    });

    // The same outstanding prompt does not re-emit.
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    await flushProbe();
    expect(permissionPushes()).toHaveLength(1);

    // The prompt clears: pending false carries the id that was answered.
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: false, permissionAwaitedToolId: null });
    sessionManager.emit('event', 'sess-1', { ts: 3, type: 'tool_end' });
    expect(permissionPushes()).toHaveLength(2);
    expect((permissionPushes()[1][0] as { event: { payload: unknown } }).event.payload).toEqual({
      type: 'permission',
      promptId: 'sess-1:tool-7',
      pending: false,
    });
  });

  it('retries the option probe once when the dialog has not painted yet, then pushes with the labels', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      // First probe read races the TUI's dialog paint and misses; the retry sees it.
      sessionManager.getSerializedFrame
        .mockResolvedValueOnce('still thinking, no dialog yet')
        .mockResolvedValue(permissionDialogFrame);
      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      expect(permissionPushes).toHaveLength(1);
      expect((permissionPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
        type: 'permission',
        promptId: 'sess-1:tool-7',
        pending: true,
        options: permissionDialogOptions,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes pending true without options when no numbered dialog ever parses (blind fallback preserved)', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession(); // frame stays 'serialized-frame': never a dialog
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      expect(permissionPushes).toHaveLength(1);
      expect((permissionPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
        type: 'permission',
        promptId: 'sess-1:tool-7',
        pending: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a stale pending push when the prompt clears while the probe is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession(); // frame never shows a dialog, so the probe parks on its retry timer
      const context = { sessionManager } as unknown as IpcContext;
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());

      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });

      // The prompt clears (answered at the desk) before the retry fires.
      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: false, permissionAwaitedToolId: null });
      sessionManager.emit('event', 'sess-1', { ts: 3, type: 'tool_end' });
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      // Only the clear went out; the in-flight pending push was dropped as stale.
      expect(permissionPushes).toHaveLength(1);
      expect((permissionPushes[0][0] as { event: { payload: unknown } }).event.payload).toEqual({
        type: 'permission',
        promptId: 'sess-1:tool-7',
        pending: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a probe parked on its retry never sends after the subscription tears down on exit', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession(); // frame never shows a dialog, so the probe parks on its retry timer
      const context = { sessionManager } as unknown as IpcContext;
      const subscriptions = new SubscriptionRegistry();
      await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, subscriptions);

      sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-7' });
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      sessionManager.emit('exit', 'sess-1', 0, true); // tears the subscription down
      await vi.runAllTimersAsync();

      const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
      );
      expect(permissionPushes).toHaveLength(0);
      expect(subscriptions.has('stream:sess-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a prompt already outstanding at subscribe time is not re-pushed by the next activity emission', async () => {
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: true, permissionAwaitedToolId: 'tool-9' });
    const session = fakeSession();
    const context = { sessionManager } as unknown as IpcContext;
    const response = await handleReadStream(fakeRequest({ sessionId: 'sess-1', action: 'subscribe' }), session, context, new SubscriptionRegistry());
    expect((response.payload as { awaitedPromptId: string | null }).awaitedPromptId).toBe('sess-1:tool-9');

    // The snapshot already told the phone; an unchanged prompt must not double-notify.
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    const permissionPushes = (session.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => (message as { event?: { payload?: { type?: string } } }).event?.payload?.type === 'permission',
    );
    expect(permissionPushes).toHaveLength(0);
  });
});
