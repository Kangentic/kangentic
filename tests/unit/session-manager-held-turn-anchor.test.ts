/**
 * A held turn end and the drain's turn end for the same turn share one
 * transcript anchor. The held end only PEEKS the anchor (so a tool-less wake of
 * the same turn still reads from where the turn began); the drain's end TAKES
 * it and is marked `heldReported`. If the held end consumed the anchor, the
 * drain's end would carry none and the turn-end runner would read the wrong
 * reply.
 *
 * Driven through the real SessionManager, with the engine's edge callbacks
 * called the way the engine calls them (same rig as session-manager-turn-anchor.test.ts).
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
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { TurnStartCause } from '../../src/main/activity-engine/engine';
import type { TranscriptAnchor } from '../../src/main/agent/shared/transcript-anchor';

interface TurnEdgeCallbacks {
  onTurnStarted(sessionId: string, turnStartedAt: number, cause: TurnStartCause): void;
  onTurnEnded(sessionId: string, turnStartedAt: number | null, workSerial: number, heldReported: boolean): void;
  onTurnEndedHeld(sessionId: string, turnStartedAt: number | null, workSerial: number): void;
}

function getTurnEdgeCallbacks(manager: SessionManager): TurnEdgeCallbacks {
  const telemetry = (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
  return (telemetry as unknown as { callbacks: TurnEdgeCallbacks }).callbacks;
}

const ANCHOR: TranscriptAnchor = { agentSessionId: 'agent-session-1', byteOffset: 100 };

describe('SessionManager held turn end anchor', () => {
  let manager: SessionManager;
  let sessionId: string;
  let held: TurnEndedPayload[];
  let ended: TurnEndedPayload[];

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager({
      activityEngineOptions: { bgShellEscapeHatchMs: 60_000, staleThinkingTimeoutMs: 60_000, idleStabilityWindowMs: 0 },
    });
    const session = manager.registerSuspendedPlaceholder({ taskId: 'task-held', projectId: 'project-held', cwd: '/mock/cwd' });
    if (!session) throw new Error('The placeholder was not registered.');
    sessionId = session.id;
    held = [];
    ended = [];
    manager.on('turn-ended-held', (payload: TurnEndedPayload) => held.push(payload));
    manager.on('turn-ended', (payload: TurnEndedPayload) => ended.push(payload));
    manager.setTranscriptPositionSource({
      transcriptPosition: () => ANCHOR,
      hasPendingRead: () => false,
      hasReadInFlight: () => false,
    });
  });

  afterEach(() => {
    manager.dispose();
  });

  it('gives the held end and the drain\'s end the same anchor, and marks only the drain heldReported', () => {
    const edges = getTurnEdgeCallbacks(manager);
    edges.onTurnStarted(sessionId, 1000, 'idle');

    edges.onTurnEndedHeld(sessionId, 1000, 1);
    expect(held).toHaveLength(1);
    expect(held[0].transcriptAnchor).toEqual(ANCHOR);
    expect(held[0].heldReported).toBeUndefined();

    // The drain's own end of the same turn.
    edges.onTurnEnded(sessionId, 1000, 1, true);
    expect(ended).toHaveLength(1);
    expect(ended[0].transcriptAnchor).toEqual(ANCHOR);
    expect(ended[0].heldReported).toBe(true);
  });

  it('lets a second held report of the same turn read the anchor again, since a peek consumes nothing', () => {
    const edges = getTurnEdgeCallbacks(manager);
    edges.onTurnStarted(sessionId, 1000, 'idle');

    edges.onTurnEndedHeld(sessionId, 1000, 1);
    edges.onTurnEndedHeld(sessionId, 1000, 2);
    expect(held.map((payload) => payload.transcriptAnchor)).toEqual([ANCHOR, ANCHOR]);
  });

  it('marks a plain turn end (nothing held first) without heldReported', () => {
    const edges = getTurnEdgeCallbacks(manager);
    edges.onTurnStarted(sessionId, 1000, 'idle');
    edges.onTurnEnded(sessionId, 1000, 1, false);
    expect(ended[0].heldReported).toBeUndefined();
  });
});
