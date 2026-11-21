/**
 * Task #1149: Ctrl+C, then a quick resubmit. The owner submitted a message,
 * pressed Ctrl+C about 0.7 s later (Claude Code puts the prompt back), and
 * submitted "signed off" 1.9 s after that, inside the 3 s Ctrl+C settle window.
 * The window then fired on the resubmitted turn and committed a false idle. The
 * idle took the transcript copy past both user messages, so the column's Text
 * match on the owner's message read "No message from you in this turn" and the
 * card stayed in Design. What a user loses without this: a sign-off that never
 * moves the card, and a board that shows the agent idle while it works.
 *
 * Timings come from #1146's own events.jsonl. The first prompt's hook stamped
 * 724 ms before the inferred Ctrl+C, and the resubmit's 1.9 s after it.
 *
 * Tier: Unit. The real SessionTelemetry and ActivityEngine on fake timers; the
 * bg-shell watcher is off so no OS probe is built.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { ActivityDetection, EventType, PromptReason } from '../../src/shared/types';
import type { AgentParser, SessionEvent } from '../../src/shared/types';

const SETTLE_MS = 3_000;

function claudeLikeParser(): AgentParser {
  return {
    detectFirstOutput: () => true,
    removeHooks: () => undefined,
    runtime: {
      activity: ActivityDetection.hooksAndPty(() => true),
      reportsTurnEnd: true,
    },
  } as unknown as AgentParser;
}

describe('a Ctrl+C followed by a quick resubmit', () => {
  let telemetry: SessionTelemetry | null = null;
  let activity: string | null;
  let logged: SessionEvent[];
  let turnStarts: number[];
  let turnEnds: Array<number | null>;

  function start(): SessionTelemetry {
    const created = new SessionTelemetry(
      {
        onUsageChange: () => {},
        onActivityChange: (_sessionId, next) => { activity = next; },
        onEvent: (_sessionId, pushed) => { logged.push(pushed); },
        onIdleTimeout: () => {},
        onPlanExit: () => {},
        onPRCandidate: () => {},
        requestSuspend: () => {},
        isSessionRunning: () => true,
        onTurnStarted: (_sessionId, turnStartedAt) => { turnStarts.push(turnStartedAt); },
        onTurnEnded: (_sessionId, turnStartedAt) => { turnEnds.push(turnStartedAt); },
      },
      { disableBgShellWatcher: true, activityEngineOptions: { idleStabilityWindowMs: 0 } },
    );
    created.initSession('s1', claudeLikeParser());
    telemetry = created;
    return created;
  }

  const interrupts = (): SessionEvent[] => logged.filter((entry) => entry.type === EventType.Interrupted);

  beforeEach(() => {
    vi.useFakeTimers();
    activity = null;
    logged = [];
    turnStarts = [];
    turnEnds = [];
  });

  afterEach(() => {
    telemetry?.dispose();
    telemetry = null;
    vi.useRealTimers();
  });

  it('keeps the resubmitted turn working, and its turn end starts before both messages', () => {
    const session = start();
    session.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]);
    expect(activity).toBe('thinking');
    expect(turnStarts).toHaveLength(1);
    const firstTurnStartedAt = turnStarts[0];

    vi.advanceTimersByTime(724);
    session.notifyUserInterrupt('s1');
    vi.advanceTimersByTime(1_900);
    session.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(interrupts()).toEqual([]);
    expect(activity).toBe('thinking');
    expect(turnStarts).toHaveLength(1);

    // The reply's own Stop ends the turn that began before the first submit,
    // whose transcript anchor holds both user messages.
    session.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Idle }]);
    expect(activity).toBe('idle');
    expect(turnEnds).toEqual([firstTurnStartedAt]);
  });

  // The engine drops the stopped turn's calls and the open-work ledger must
  // too, or a recovery nudge or pause would read them as still running.
  it('closes the stopped turn\'s tool calls and subagents in the open-work ledger', () => {
    const session = start();
    session.ingestEvents('s1', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.SubagentStart, subagentId: 'agent-1' },
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash', toolId: 'call-1' },
    ]);
    expect(session.getOpenWork('s1').toolCalls).toHaveLength(1);

    vi.advanceTimersByTime(500);
    session.notifyUserInterrupt('s1');
    vi.advanceTimersByTime(1_000);
    session.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]);
    expect(interrupts()).toEqual([]);
    expect(session.getOpenWork('s1').toolCalls).toEqual([]);

    // The ledger lists a subagent only once a turn has ended, so end the
    // resubmitted turn to read it. A subagent left open would show here.
    vi.advanceTimersByTime(100);
    session.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Idle }]);
    expect(session.getOpenWork('s1').backgroundSubagents).toEqual([]);
  });

  // Output read as activity is not a prompt the agent got. A status parser
  // ingests one this way (goose's program-status-parser).
  it('keeps the window through a prompt PTY activity stands in for', () => {
    const session = start();
    session.ingestEvents('s1', [
      { ts: Date.now(), type: EventType.Prompt },
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash', toolId: 'call-1' },
    ]);
    vi.advanceTimersByTime(500);
    session.notifyUserInterrupt('s1');
    vi.advanceTimersByTime(1_000);
    session.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt, detail: PromptReason.PtyActivity }]);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(interrupts()).toEqual([expect.objectContaining({ detail: 'user-ctrl-c' })]);
    expect(activity).toBe('idle');
  });
});
