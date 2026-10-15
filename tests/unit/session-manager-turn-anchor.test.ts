/**
 * The turn end's transcript anchor (`TurnEndedPayload.transcriptAnchor`,
 * src/main/pty/session-manager.ts): where the turn began in its transcript, so
 * the turn-end runner reads the turn's own reply and never the message an
 * earlier turn ended on.
 *
 * The position comes from the message trail (`TranscriptPositionSource`). The
 * manager copies it when the session commits to idle and hands that copy to
 * the next turn, because the engine can notice a turn after the turn has
 * written text, and a read landing in that gap would already cover the text. A
 * copy taken at idle predates any later turn. A plan approval re-anchors at the
 * approval; a fresh spawn has no anchor.
 *
 * One refinement: the read a Stop starts can land after the commit to idle, so
 * a copy taken while a read is pending keeps settling. Each read that lands
 * (`transcriptReadLanded`) moves it until none is pending, and from then on it
 * is fixed.
 *
 * Driven through the real SessionManager and its real telemetry and engine,
 * with events ingested the way the status file reader hands them over.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidate: string) => /^[\\/]{2}[^\\/]/.test(candidate),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager, type TurnEndedPayload } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { TurnStartCause } from '../../src/main/activity-engine/engine';
import { MessageTrailTracker, type TrailRead } from '../../src/main/agent/message-trail-tracker';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';
import { EventType, IdleReason } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

/** The two engine callbacks the manager hands the telemetry, which the engine calls at a turn's edges. */
interface TurnEdgeCallbacks {
  onTurnStarted(sessionId: string, turnStartedAt: number, cause: TurnStartCause): void;
  onTurnEnded(sessionId: string, turnStartedAt: number | null, workSerial: number): void;
}

function getTurnEdgeCallbacks(manager: SessionManager): TurnEdgeCallbacks {
  return (getTelemetry(manager) as unknown as { callbacks: TurnEdgeCallbacks }).callbacks;
}

/** The manager's private anchor maps, which a forgotten entry leaves no other trace in. */
interface AnchorMaps {
  idleTranscriptAnchors: Map<string, { anchor: TranscriptAnchor | null; settling: boolean }>;
  turnTranscriptAnchors: Map<string, { turnStartedAt: number; anchor: TranscriptAnchor | null }>;
}

function getAnchorMaps(manager: SessionManager): AnchorMaps {
  return manager as unknown as AnchorMaps;
}

function at(byteOffset: number): TranscriptAnchor {
  return { agentSessionId: 'agent-session-1', byteOffset };
}

describe('SessionManager turn-end transcript anchor', () => {
  let manager: SessionManager;
  let sessionId: string;
  let position: TranscriptAnchor | null;
  let pending: boolean;
  let turnEnds: TurnEndedPayload[];
  let clock: number;
  let trailTracker: MessageTrailTracker | null;

  function send(type: EventType, extra: Partial<SessionEvent> = {}): void {
    clock += 1;
    getTelemetry(manager).ingestEvents(sessionId, [{ ts: clock, type, ...extra }]);
  }

  function anchors(): Array<TranscriptAnchor | null> {
    return turnEnds.map((payload) => payload.transcriptAnchor);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager({
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    });
    const session = manager.registerSuspendedPlaceholder({ taskId: 'task-anchor', projectId: 'project-anchor', cwd: '/mock/cwd' });
    if (!session) throw new Error('The placeholder was not registered.');
    sessionId = session.id;
    position = null;
    pending = false;
    clock = Date.now();
    turnEnds = [];
    trailTracker = null;
    manager.on('turn-ended', (payload: TurnEndedPayload) => turnEnds.push(payload));
    manager.setTranscriptPositionSource({ transcriptPosition: () => position, hasPendingRead: () => pending });
  });

  afterEach(() => {
    trailTracker?.dispose();
    manager.dispose();
  });

  it('anchors a turn where reading stood when the session went idle, not where it reached by the time the turn began', () => {
    position = at(100);
    getTelemetry(manager).initSession(sessionId);
    // A read lands while the engine still reads the session as idle: the CLI
    // may already be writing a turn the engine has not noticed.
    position = at(250);
    send(EventType.Prompt);
    position = at(400);
    send(EventType.Idle);
    expect(anchors()).toEqual([at(100)]);

    // The turn end's own commit to idle is the next turn's anchor.
    position = at(900);
    send(EventType.Prompt);
    send(EventType.Idle);
    expect(anchors()).toEqual([at(100), at(400)]);
  });

  it('takes the position at the turn start when none had been read when the session went idle', () => {
    // A resumed session goes idle before its first trail read lands.
    getTelemetry(manager).initSession(sessionId);
    position = at(50);
    send(EventType.Prompt);
    send(EventType.Idle);
    expect(turnEnds[0].transcriptAnchor).toEqual(at(50));
  });

  it('re-anchors at a plan approval, which is where the turn end says the turn began', () => {
    position = at(100);
    getTelemetry(manager).initSession(sessionId);
    send(EventType.Prompt);
    send(EventType.ToolStart, { tool: 'ExitPlanMode', toolId: 'plan' });
    send(EventType.Idle, { detail: IdleReason.Permission });
    position = at(700);
    send(EventType.ToolEnd, { tool: 'ExitPlanMode', toolId: 'plan' });
    position = at(1200);
    send(EventType.ToolStart, { tool: 'Edit', toolId: 'edit' });
    send(EventType.ToolEnd, { tool: 'Edit', toolId: 'edit' });
    send(EventType.Idle);
    expect(anchors()).toEqual([at(700)]);
  });

  it('gives a fresh spawn\'s first turn no anchor, since its prompt rides the command line', () => {
    position = at(300);
    getTelemetry(manager).initSession(sessionId, undefined, true);
    send(EventType.Idle);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].transcriptAnchor).toBeNull();
  });

  it('gives no anchor when nothing reports a position', () => {
    const unwired = new SessionManager({ activityEngineOptions: { bgShellEscapeHatchMs: 60_000, staleThinkingTimeoutMs: 60_000, idleStabilityWindowMs: 0 } });
    const session = unwired.registerSuspendedPlaceholder({ taskId: 'task-unwired', projectId: 'project-anchor', cwd: '/mock/cwd' });
    if (!session) throw new Error('The placeholder was not registered.');
    const ends: TurnEndedPayload[] = [];
    unwired.on('turn-ended', (payload: TurnEndedPayload) => ends.push(payload));
    getTelemetry(unwired).initSession(session.id);
    getTelemetry(unwired).ingestEvents(session.id, [{ ts: clock + 1, type: EventType.Prompt }, { ts: clock + 2, type: EventType.Idle }]);
    expect(ends.map((payload) => payload.transcriptAnchor)).toEqual([null]);
    unwired.dispose();
  });

  it('still ends the turn, with no anchor, when the position source throws', () => {
    manager.setTranscriptPositionSource({
      transcriptPosition: () => {
        throw new Error('The trail is gone.');
      },
      hasPendingRead: () => false,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getTelemetry(manager).initSession(sessionId);
    send(EventType.Prompt);
    send(EventType.Idle);
    expect(anchors()).toEqual([null]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  describe('a read that was pending when the session went idle', () => {
    it('moves the idle copy to where that read landed, and fixes it once none is pending', () => {
      // The Stop's read is out when the engine commits to idle: reading stood
      // at 100 then, and the turn's closing text lands at 250.
      position = at(100);
      pending = true;
      getTelemetry(manager).initSession(sessionId);

      position = at(250);
      pending = false;
      manager.transcriptReadLanded(sessionId);

      // A read a later event starts lands while the session sits idle. The copy
      // is fixed by now: this position is already past where the next turn begins.
      position = at(400);
      manager.transcriptReadLanded(sessionId);

      send(EventType.Prompt);
      send(EventType.Idle);
      expect(anchors()).toEqual([at(250)]);
    });

    it('keeps moving the copy while a landing read leaves another pending, and fixes it at the last', () => {
      position = at(100);
      pending = true;
      getTelemetry(manager).initSession(sessionId);

      // The first read lands with the burst's trailing read still armed.
      position = at(250);
      pending = true;
      manager.transcriptReadLanded(sessionId);

      position = at(400);
      pending = false;
      manager.transcriptReadLanded(sessionId);

      position = at(700);
      manager.transcriptReadLanded(sessionId);

      send(EventType.Prompt);
      send(EventType.Idle);
      expect(anchors()).toEqual([at(400)]);
    });

    it('fills a copy that was empty at idle from the first read that lands, then fixes it', () => {
      // A resumed session goes idle before its first trail read, with none pending.
      position = null;
      pending = false;
      getTelemetry(manager).initSession(sessionId);

      position = at(80);
      manager.transcriptReadLanded(sessionId);

      // Fixed from here: a later landing must not move it, and neither does the
      // position the turn starts at.
      position = at(500);
      manager.transcriptReadLanded(sessionId);
      position = at(900);

      send(EventType.Prompt);
      send(EventType.Idle);
      expect(anchors()).toEqual([at(80)]);
    });

    it('ignores a landing for a session that holds no idle copy', () => {
      // Mid-turn there is no copy: a landing must not make one, or the next
      // turn would be anchored at wherever this read happened to reach.
      position = at(100);
      getTelemetry(manager).initSession(sessionId);
      send(EventType.Prompt);
      expect(getAnchorMaps(manager).idleTranscriptAnchors.has(sessionId)).toBe(false);

      position = at(300);
      manager.transcriptReadLanded(sessionId);
      expect(getAnchorMaps(manager).idleTranscriptAnchors.has(sessionId)).toBe(false);
    });
  });

  describe('the stamp that ties an anchor to its turn', () => {
    it('hands the anchor to the turn end of the turn it was taken for, once', () => {
      position = at(100);
      const edges = getTurnEdgeCallbacks(manager);
      edges.onTurnStarted(sessionId, 1000, 'idle');

      // A second turn end under the same stamp finds the entry consumed.
      edges.onTurnEnded(sessionId, 1000, 1);
      edges.onTurnEnded(sessionId, 1000, 2);
      expect(anchors()).toEqual([at(100), null]);
    });

    it('gives a turn end under another stamp no anchor, and drops the entry that was for another turn', () => {
      position = at(100);
      const edges = getTurnEdgeCallbacks(manager);
      edges.onTurnStarted(sessionId, 1000, 'idle');

      // The end names a turn that started at another moment, so the stored
      // anchor belongs to a different turn and reading from it would judge that
      // turn's reply.
      edges.onTurnEnded(sessionId, 2000, 1);
      expect(anchors()).toEqual([null]);
      expect(getAnchorMaps(manager).turnTranscriptAnchors.has(sessionId)).toBe(false);
    });

    it('gives a turn end with no start stamp no anchor', () => {
      position = at(100);
      const edges = getTurnEdgeCallbacks(manager);
      edges.onTurnStarted(sessionId, 1000, 'idle');

      edges.onTurnEnded(sessionId, null, 1);
      expect(anchors()).toEqual([null]);
    });
  });

  describe('forgetting the anchors of a session that ends', () => {
    const OTHER_SESSION_ID = 'session-that-stays';

    /** Both maps at once, which no single point of a session's flow ever holds. */
    function seedAnchors(forSessionId: string): void {
      const maps = getAnchorMaps(manager);
      maps.idleTranscriptAnchors.set(forSessionId, { anchor: at(10), settling: false });
      maps.turnTranscriptAnchors.set(forSessionId, { turnStartedAt: 5, anchor: at(10) });
    }

    function held(forSessionId: string): { idle: boolean; turn: boolean } {
      const maps = getAnchorMaps(manager);
      return {
        idle: maps.idleTranscriptAnchors.has(forSessionId),
        turn: maps.turnTranscriptAnchors.has(forSessionId),
      };
    }

    const HELD = { idle: true, turn: true };
    const FORGOTTEN = { idle: false, turn: false };

    it('forgets both anchors on kill(), and only that session\'s', () => {
      seedAnchors(sessionId);
      seedAnchors(OTHER_SESSION_ID);
      expect(held(sessionId)).toEqual(HELD);

      manager.kill(sessionId);

      expect(held(sessionId)).toEqual(FORGOTTEN);
      expect(held(OTHER_SESSION_ID)).toEqual(HELD);
    });

    it('forgets both anchors on suspend(), and only that session\'s', async () => {
      seedAnchors(sessionId);
      seedAnchors(OTHER_SESSION_ID);
      expect(held(sessionId)).toEqual(HELD);

      await manager.suspend(sessionId);

      expect(held(sessionId)).toEqual(FORGOTTEN);
      expect(held(OTHER_SESSION_ID)).toEqual(HELD);
    });

    it('forgets both anchors of an exited row a placeholder replaces, and only that row\'s', () => {
      // registerSuspendedPlaceholder evicts an exited row through the same
      // cache clearing remove() ends with, without going through kill().
      const exitedSessionId = 'sess-exited-anchors';
      const registry = (manager as unknown as { registry: SessionRegistry }).registry;
      registry.set(exitedSessionId, {
        id: exitedSessionId,
        taskId: 'task-exited-anchors',
        projectId: 'project-anchor',
        pty: null,
        status: 'exited',
        shell: '',
        cwd: '/mock/cwd',
        startedAt: new Date().toISOString(),
        exitCode: 1,
        resuming: false,
        transient: false,
        exitSequence: ['\x03'],
      } as ManagedSession);
      seedAnchors(exitedSessionId);
      seedAnchors(OTHER_SESSION_ID);
      expect(held(exitedSessionId)).toEqual(HELD);

      const placeholder = manager.registerSuspendedPlaceholder({ taskId: 'task-exited-anchors', projectId: 'project-anchor', cwd: '/mock/cwd' });

      expect(placeholder).not.toBeNull();
      expect(held(exitedSessionId)).toEqual(FORGOTTEN);
      expect(held(OTHER_SESSION_ID)).toEqual(HELD);
    });
  });

  describe('through the real message trail tracker', () => {
    it('anchors the next turn where the read a Stop started finally landed, not where reading stood at the Stop', async () => {
      // The tracker's reads resolve when this test says so, so the Stop's read
      // can be out when the engine commits to idle, as a slow retrieval worker
      // leaves it. `trailNow` is a stand-in clock the test moves forward, so a
      // trigger always starts its read at once instead of arming it.
      const reads: Array<{ resolve: (cursor: number) => void }> = [];
      let trailNow = 1_000_000;
      let landed = 0;
      const tracker = new MessageTrailTracker({
        sessionManager: manager,
        resolveSessionFacts: () => ({ sessionType: 'fake-agent', agentSessionId: 'agent-session-1', cwd: '/mock/cwd' }),
        readTrail: () => new Promise<TrailRead>((resolve) => {
          reads.push({ resolve: (cursor) => resolve({ previews: [], cursor, usedFallback: false }) });
        }),
        now: () => trailNow,
        minIntervalMs: 10,
        fallbackMinIntervalMs: 10,
      });
      trailTracker = tracker;

      async function landNextRead(cursor: number): Promise<void> {
        await vi.waitFor(() => expect(reads.length).toBeGreaterThan(landed), { timeout: 5000 });
        reads[landed].resolve(cursor);
        landed += 1;
      }

      // Warm-up: a first read anchors at 100, and the trailing read it arms
      // lands at the same place. Then nothing is pending.
      tracker.schedule(sessionId);
      await landNextRead(100);
      await landNextRead(100);
      await vi.waitFor(() => expect(tracker.hasPendingRead(sessionId)).toBe(false), { timeout: 5000 });
      expect(tracker.transcriptPosition(sessionId)).toEqual(at(100));

      // The session goes idle with reading at 100 and nothing pending, and a
      // first turn begins from there.
      trailNow += 1_000;
      getTelemetry(manager).initSession(sessionId);
      send(EventType.Prompt);

      // The Stop. The tracker hears the event before the engine does, so its
      // read is out when the engine commits to idle, and the turn's closing
      // text is the 400 that read is about to reach.
      trailNow += 1_000;
      send(EventType.Idle);
      expect(anchors()).toEqual([at(100)]);
      expect(tracker.hasPendingRead(sessionId)).toBe(true);

      // The Stop's read lands, then the trailing read it armed. Reading ends at
      // 400, and the burst is over.
      await landNextRead(400);
      await landNextRead(400);
      await vi.waitFor(() => expect(tracker.hasPendingRead(sessionId)).toBe(false), { timeout: 5000 });
      expect(tracker.transcriptPosition(sessionId)).toEqual(at(400));

      // The next turn begins after that text, so it is anchored at 400. Without
      // the landing notice it would be anchored at the 100 the Stop saw.
      trailNow += 1_000;
      send(EventType.Prompt);
      send(EventType.Idle);
      expect(anchors()).toEqual([at(100), at(400)]);
    });
  });
});
