/**
 * Kimi's wire.jsonl driving the real SessionTelemetry the way SessionManager
 * wires it (task #859): `dispatchSessionHistoryResult` sends the parsed events
 * before the chunk's activity hint, and the first read suppresses the PTY
 * tracker for a `hooks_and_pty` agent (`onFirstTelemetry`).
 *
 * kimi-wire-parser.test.ts replays the same capture through the engine alone.
 * This file covers what only the telemetry layer can break: a PTY idle after
 * the first wire read must not clear a running task's hold, and each chunk's
 * forced activity must land after its events. Each line is its own chunk here,
 * the worst case for the second point, since every StepBegin then forces
 * thinking on its own.
 *
 * Tier: Unit - real SessionTelemetry and engine, the bg-shell watcher off, no
 * PTY, no filesystem watcher.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { dispatchSessionHistoryResult } from '../../src/main/pty/readers/session-history-reader';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi';
import { parseWireJsonl } from '../../src/main/agent/adapters/kimi/wire-parser';
import type { AgentParser } from '../../src/shared/types';

const SESSION_ID = 'kimi-session';
const WIRE_LINES = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'kimi', 'wire-background-tasks.jsonl'), 'utf-8')
  .split('\n')
  .filter((line) => line.length > 0);

const lineIndexOf = (predicate: (line: string) => boolean, from = 0): number => {
  const index = WIRE_LINES.findIndex((line, lineIndex) => lineIndex >= from && predicate(line));
  if (index < 0) throw new Error('fixture line not found');
  return index;
};
const LAUNCH_RESULT = lineIndexOf((line) => line.includes('"Background task started."'));
const FIRST_TURN_END = lineIndexOf((line) => line.includes('"TurnEnd"'));

describe('Kimi wire.jsonl through SessionTelemetry', () => {
  let telemetry: SessionTelemetry;
  let turnEnds: number;
  let firstReadDone: boolean;
  const adapter = new KimiAdapter();

  function feed(lines: readonly string[]): void {
    for (const line of lines) {
      // SessionManager's onFirstTelemetry: a hooks_and_pty agent's first
      // history read turns the PTY tracker off.
      if (!firstReadDone) {
        firstReadDone = true;
        if (adapter.runtime.activity.kind === 'hooks_and_pty') telemetry.suppressPty(SESSION_ID);
      }
      dispatchSessionHistoryResult(SESSION_ID, parseWireJsonl(`${line}\n`, 'append'), {
        onUsageUpdate: () => {},
        onEvents: (sessionId, events) => telemetry.ingestEvents(sessionId, events),
        onActivity: (sessionId, activity) => telemetry.forceActivity(sessionId, activity),
      });
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    turnEnds = 0;
    firstReadDone = false;
    telemetry = new SessionTelemetry(
      {
        onUsageChange: () => {},
        onActivityChange: () => {},
        onEvent: () => {},
        onIdleTimeout: () => {},
        onPlanExit: () => {},
        onPRCandidate: () => {},
        requestSuspend: () => {},
        isSessionRunning: () => true,
        onTurnEnded: () => { turnEnds += 1; },
      },
      {
        disableBgShellWatcher: true,
        activityEngineOptions: {
          bgShellEscapeHatchMs: 600_000,
          bgShellOnlyGraceMs: 600_000,
          staleThinkingTimeoutMs: 600_000,
          staleAfterHeartbeatForcedMs: 600_000,
          idleStabilityWindowMs: 0,
        },
      },
    );
    telemetry.initSession(SESSION_ID, adapter as AgentParser);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('keeps a running task holding through PTY silence once wire.jsonl flows', () => {
    feed(WIRE_LINES.slice(0, LAUNCH_RESULT + 1));
    expect(telemetry.getActivityStatsSnapshot(SESSION_ID)?.backgroundShellIds).toEqual(['bash-tkkk1arw']);

    // Red: with Kimi on `pty` activity, the prompt regex or the silence timer
    // reaches forceIdle here, which clears the hold.
    telemetry.notifyPtyIdle(SESSION_ID);
    telemetry.notifyPtyData(SESSION_ID);
    vi.advanceTimersByTime(10_000);

    expect(telemetry.getActivityStatsSnapshot(SESSION_ID)?.backgroundShellIds).toEqual(['bash-tkkk1arw']);
    expect(telemetry.getActivityCache()[SESSION_ID]).toBe('thinking');
  });

  it('ends the turn on TurnEnd with the stopped task released and the flagged one exempt', () => {
    feed(WIRE_LINES.slice(0, FIRST_TURN_END + 1));
    const snapshot = telemetry.getActivityStatsSnapshot(SESSION_ID);
    expect(snapshot?.backgroundShellIds).toEqual([]);
    expect(snapshot?.exemptBackgroundShellIds).toEqual(['bash-n2672x0l']);
    expect(telemetry.getActivityCache()[SESSION_ID]).toBe('idle');
    expect(turnEnds).toBe(1);
  });

  it('ends each of the capture\'s three turns for onTurnEnded', () => {
    feed(WIRE_LINES);
    expect(turnEnds).toBe(3);
    expect(telemetry.getActivityCache()[SESSION_ID]).toBe('idle');
  });
});
