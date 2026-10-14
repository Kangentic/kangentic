/**
 * `ActivityEngineCallbacks.onTurnEnded`: the signal column automations' On
 * agent turn end and a workflow task's step check hang off. It must fire once
 * for a turn the agent itself ended, after that turn has fully settled, and
 * never for an interrupt, a failed turn, an `idle_hint` (Esc between tool
 * calls ends a turn that way, with no hook), PTY silence, a watchdog guess, a
 * resume's idle seed, or a permission prompt.
 *
 * The replay half drives task #529's eighth Code Review pass (session #76),
 * whose Stops arrived while background `test-builder` subagents were still
 * running.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';
import { NO_ACTIVITY_HOLD_FLAG } from '../../src/shared/background-shell-hold';

const SESSION_ID = 'turn-end-session';
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'replay');

interface Harness {
  engine: ActivityEngine;
  turnEnds: number[];
  /** The `turnStartedAt` each turn end reported, in order. */
  turnStarts: Array<number | null>;
  /** The `workSerial` each turn end reported, in order: the turn's identity. */
  workSerials: number[];
  send: (type: EventType, extra?: Partial<SessionEvent>) => void;
}

function createHarness(options: { stabilityMs?: number; seedThinking?: boolean } = {}): Harness {
  const turnEnds: number[] = [];
  const turnStarts: Array<number | null> = [];
  const workSerials: number[] = [];
  const engine = new ActivityEngine(
    {
      onActivityChange() {},
      onTurnEnded(_sessionId, turnStartedAt, workSerial) {
        turnEnds.push(Date.now());
        turnStarts.push(turnStartedAt);
        workSerials.push(workSerial);
      },
    },
    {
      idleStabilityWindowMs: options.stabilityMs ?? 0,
      bgShellEscapeHatchMs: 300_000,
      staleThinkingTimeoutMs: 180_000,
    },
  );
  engine.initSession(SESSION_ID, options.seedThinking ?? false);
  const send = (type: EventType, extra: Partial<SessionEvent> = {}) => {
    engine.processEvent(SESSION_ID, { ts: Date.now(), type, ...extra });
  };
  return { engine, turnEnds, turnStarts, workSerials, send };
}

function loadFixture(name: string): SessionEvent[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as SessionEvent);
}

describe('onTurnEnded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once for a turn the agent ended with its Stop', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Read', toolId: 'a' });
    harness.send(EventType.ToolEnd, { tool: 'Read', toolId: 'a' });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    // A second Stop for the same turn reports nothing more.
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('fires for a fresh spawn seeded thinking, whose first Stop is its first turn end', () => {
    const seededAt = Date.now();
    const harness = createHarness({ seedThinking: true });
    vi.advanceTimersByTime(5_000);
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    // The seed is the turn's start: its prompt rode the command line.
    expect(harness.turnStarts).toEqual([seededAt]);
    harness.engine.dispose();
  });

  it('reports when the turn began, so a turn started before a move can be told apart', () => {
    const harness = createHarness();
    vi.advanceTimersByTime(1_000);
    const firstStart = Date.now();
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(10_000);
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(2_000);
    const secondStart = Date.now();
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(3_000);
    harness.send(EventType.Idle);
    expect(harness.turnStarts).toEqual([firstStart, secondStart]);
    harness.engine.dispose();
  });

  it('keeps the turn start when a permission prompt resolves back to thinking', () => {
    const harness = createHarness();
    const start = Date.now();
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(1_000);
    harness.send(EventType.Idle, { detail: IdleReason.Permission });
    vi.advanceTimersByTime(4_000);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'p' });
    harness.send(EventType.ToolEnd, { tool: 'Bash', toolId: 'p' });
    vi.advanceTimersByTime(1_000);
    harness.send(EventType.Idle);
    expect(harness.turnStarts).toEqual([start]);
    harness.engine.dispose();
  });

  it('starts the turn again where a plan approval resolves its prompt, for a task dragged in mid-plan and approved after', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'ExitPlanMode', toolId: 'plan' });
    harness.send(EventType.Idle, { detail: IdleReason.Permission });
    // The user reads the plan for a while, and drags the task meanwhile.
    vi.advanceTimersByTime(40 * 60_000);
    const approvedAt = Date.now();
    harness.send(EventType.ToolEnd, { tool: 'ExitPlanMode', toolId: 'plan' });
    // Inside the stale-thinking watchdog, which would end a silent turn.
    vi.advanceTimersByTime(30_000);
    harness.send(EventType.ToolStart, { tool: 'Edit', toolId: 'edit' });
    harness.send(EventType.ToolEnd, { tool: 'Edit', toolId: 'edit' });
    harness.send(EventType.Idle);
    expect(harness.turnStarts).toEqual([approvedAt]);
    harness.engine.dispose();
  });

  it('keeps the turn start when the user sends a plan back, since a rejected plan never resolves with its tool_end', () => {
    const harness = createHarness();
    const start = Date.now();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'ExitPlanMode', toolId: 'plan' });
    harness.send(EventType.Idle, { detail: IdleReason.Permission });
    vi.advanceTimersByTime(5_000);
    // "Keep planning" with feedback: a prompt, and no tool_end for the plan.
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(5_000);
    harness.send(EventType.Idle);
    expect(harness.turnStarts).toEqual([start]);
    harness.engine.dispose();
  });

  it('starts the turn again only at the plan approval in a real session, not at the question answered before it (session-007)', () => {
    const events = loadFixture('session-007-exit-plan-mode-resume.jsonl');
    let currentTs = events[0].ts;
    const turnStarts: Array<number | null> = [];
    const engine = new ActivityEngine(
      {
        onActivityChange() {},
        onTurnEnded(_sessionId, turnStartedAt) {
          turnStarts.push(turnStartedAt);
        },
      },
      { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 1000, staleThinkingTimeoutMs: 600_000, now: () => currentTs },
    );
    // The excerpt opens mid-turn, on an AskUserQuestion prompt the user answers
    // before the plan. It has no Stop of its own, so one is added after it.
    engine.initSession(SESSION_ID, true);
    const stop: SessionEvent = { ts: events[events.length - 1].ts + 60_000, type: EventType.Idle };
    for (const event of [...events, stop]) {
      currentTs = event.ts;
      engine.processEvent(SESSION_ID, event);
    }
    engine.dispose();
    const approval = events.find((event) => event.type === EventType.ToolEnd && event.tool === 'ExitPlanMode');
    const answer = events.find((event) => event.type === EventType.ToolEnd && event.tool === 'AskUserQuestion');
    if (!approval || !answer) throw new Error('The fixture lost its plan approval or its answered question');
    expect(turnStarts).toEqual([approval.ts]);
    expect(turnStarts).not.toContain(answer.ts);
  });

  it('names the turn by its work serial, which a trailing paint leaves alone and new work moves', () => {
    // The turn-end runner and the workflow step act on a turn only while it is
    // still the latest (`SessionManager.isLatestTurn`), and this is what they
    // compare.
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Read', toolId: 'a' });
    harness.send(EventType.ToolEnd, { tool: 'Read', toolId: 'a' });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    const [ended] = harness.workSerials;
    expect(harness.engine.getState(SESSION_ID)?.workSerial).toBe(ended);

    // A PTY-tracked agent's trailing paint forces thinking and back. That
    // re-stamps the turn start, which is why the start is not the identity,
    // but it is no new work, so the turn that ended is still the latest.
    const startBefore = harness.engine.getState(SESSION_ID)?.turnStartedAt;
    vi.advanceTimersByTime(1_000);
    harness.engine.forceThinking(SESSION_ID);
    harness.engine.forceIdle(SESSION_ID);
    expect(harness.engine.getState(SESSION_ID)?.turnStartedAt).not.toBe(startBefore);
    expect(harness.engine.getState(SESSION_ID)?.workSerial).toBe(ended);

    // The user's next prompt is new work, even when that turn fails back to
    // idle with no turn end of its own.
    harness.send(EventType.Prompt);
    harness.send(EventType.TurnFailed, { detail: 'unknown' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
    expect(harness.engine.getState(SESSION_ID)?.workSerial).not.toBe(ended);
    harness.engine.dispose();
  });

  it('never fires for a resume idle seed, with no turn behind it', () => {
    // A resumed session is seeded idle. What reaches it before any prompt (a
    // late Stop from the conversation it reloaded, an idle the PTY forces) is
    // no turn of its own, so none of it ends one.
    const harness = createHarness();
    harness.send(EventType.Idle);
    harness.engine.forceIdle(SESSION_ID);
    vi.advanceTimersByTime(5_000);
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(0);
    // The control: the first real turn after the seed does end.
    harness.send(EventType.Prompt);
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('waits out the stability window and fires once it commits', () => {
    const harness = createHarness({ stabilityMs: 400 });
    harness.send(EventType.Prompt);
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(0);
    vi.advanceTimersByTime(399);
    expect(harness.turnEnds).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('a new turn inside the stability window cancels the pending turn end', () => {
    const harness = createHarness({ stabilityMs: 400 });
    harness.send(EventType.Prompt);
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(100);
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(1000);
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(401);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('does not fire for an idle_hint that ends the turn (Esc between tool calls fires no hook)', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'b' });
    harness.send(EventType.ToolEnd, { tool: 'Bash', toolId: 'b' });
    harness.send(EventType.IdleHint, { detail: 'Claude is waiting for your input' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('does not fire for an interrupt (Esc during a tool, Ctrl+C)', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'c' });
    harness.send(EventType.Interrupted, { tool: 'Bash' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(0);
    // A Stop that trails the interrupt reports nothing either: the turn did not finish.
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('does not fire for a failed turn, nor for a retry that wound down', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.TurnFailed, { detail: 'server_error' });
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.Prompt);
    harness.send(EventType.IdleHint, { detail: 'Claude is waiting for your input' });
    harness.send(EventType.TurnRetrying, { detail: 'overloaded' });
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('fires after a live retry resolves into a real Stop', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.TurnRetrying, { detail: 'overloaded' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    harness.send(EventType.ToolStart, { tool: 'Read', toolId: 'd' });
    harness.send(EventType.ToolEnd, { tool: 'Read', toolId: 'd' });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('a permission prompt is the agent waiting mid-turn, not a turn end', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'e' });
    harness.send(EventType.Idle, { detail: IdleReason.Permission });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('permission');
    expect(harness.turnEnds).toHaveLength(0);
    // Approved: the tool ends and the turn carries on to its own Stop.
    harness.send(EventType.ToolEnd, { tool: 'Bash', toolId: 'e' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('holds the turn end until background shells the Stop left running drain', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'f', detail: 'shell-1' });
    harness.send(EventType.Idle);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.BackgroundShellEnd, { detail: 'shell-1' });
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  // A dev server the agent leaves running in the background (`npm run
  // demo:serve`) is alive for hours. Untagged, it held a task's turn open
  // through every Stop, so the column's turn-end automations never ran.
  // CLAUDE.md tells the agent to tag it, as a trailing shell comment when the
  // program rejects unknown flags, so that exact form is pinned here.
  function startBackgroundServer(harness: Harness, command: string): void {
    // PreToolUse carries the command; PostToolUse carries the assigned shell id.
    harness.send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'server', detail: command });
    harness.send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'server', detail: 'shell-server' });
  }

  it('ends the turn at its Stop when the server it left running carries the no-hold flag in a trailing comment', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    startBackgroundServer(harness, `npm run demo:serve # ${NO_ACTIVITY_HOLD_FLAG}`);
    harness.send(EventType.Idle);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('holds the turn through every Stop while an untagged server runs (the control)', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    startBackgroundServer(harness, 'npm run demo:serve');
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(60_000);
    harness.send(EventType.Prompt);
    harness.send(EventType.Idle);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('a Stop inside a live subagent is the subagent\'s; the parent\'s Stop after it ends the turn once', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.SubagentStart, { detail: 'review-finder' });
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.SubagentStop, { detail: 'review-finder' });
    expect(harness.turnEnds).toHaveLength(0);
    harness.send(EventType.Idle);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('PTY silence and a dead agent are not turn ends', () => {
    const harness = createHarness();
    harness.engine.forceThinking(SESSION_ID);
    harness.engine.forceIdle(SESSION_ID);
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  it('the stale-thinking watchdog idles a turn whose Stop never came, without a turn end', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(181_000);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(0);
    harness.engine.dispose();
  });

  describe('session-030: #529 Code Review pass with background test-builder subagents', () => {
    // The pass fanned out to background reviewers and test-builders. Claude
    // logged a Stop each time the main agent paused to wait on them; the
    // engine holds the turn while they run (subagent depth > 0), so those
    // Stops report nothing, and only the three after which no subagent was
    // left are turn ends. Seconds are from the pass's first event.
    function replayTurnEnds(): { turnEnds: number[]; stops: number[] } {
      const events = loadFixture('session-030-code-review-background-subagents.jsonl');
      const turnEnds: number[] = [];
      let currentTs = 0;
      const engine = new ActivityEngine(
        {
          onActivityChange() {},
          onTurnEnded() {
            turnEnds.push(currentTs);
          },
        },
        { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 1000, staleThinkingTimeoutMs: 60_000 },
      );
      engine.initSession(SESSION_ID, true);
      for (const event of events) {
        currentTs = event.ts;
        engine.processEvent(SESSION_ID, event);
      }
      engine.dispose();
      const first = events[0]?.ts ?? 0;
      const toSeconds = (ts: number) => Math.round((ts - first) / 1000);
      return {
        turnEnds: turnEnds.map(toSeconds),
        stops: events.filter((event) => event.type === EventType.Idle).map((event) => toSeconds(event.ts)),
      };
    }

    it('of twelve Stops, only the three with no subagent left running end a turn', () => {
      const { turnEnds, stops } = replayTurnEnds();
      expect(stops).toHaveLength(12);
      expect(turnEnds).toEqual([2295, 2779, 4878]);
    });

    it('the Stops logged while background reviewers and test-builders ran report nothing', () => {
      const { turnEnds } = replayTurnEnds();
      for (const heldStop of [676, 1459, 1782, 1868, 2074]) {
        expect(turnEnds).not.toContain(heldStop);
      }
    });
  });

  describe('session-031: a failed turn, "continue", then a normal Stop', () => {
    // A captured task session. A turn ended in "API Error: Request size exceeds
    // model context window", which Claude Code reports as StopFailure with the
    // error "unknown", so the bridge emits `turn_failed`. The user typed
    // "continue", and that turn ended with a normal Stop. The failed turn idles
    // the session with no turn end, which is why the turn-end runner and the
    // workflow step cannot treat idle as "the turn I judged is still the
    // latest": they compare the turn's work serial (`isLatestTurn`) instead.
    function replay(): { turnEnds: number[]; idledAt: number[]; turnFailedAt: number; stopAt: number } {
      const events = loadFixture('session-031-turn-failed-then-continue.jsonl');
      const turnEnds: number[] = [];
      const idledAt: number[] = [];
      let currentTs = 0;
      const engine = new ActivityEngine(
        {
          onActivityChange(_sessionId, activity) {
            if (activity === 'idle') idledAt.push(currentTs);
          },
          onTurnEnded() {
            turnEnds.push(currentTs);
          },
        },
        { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 1000, staleThinkingTimeoutMs: 60_000 },
      );
      // Seeded thinking: the excerpt opens mid-session, on the prompt of a
      // turn. Its leading `session_start` is the fixtures' shared opening line
      // and log-only.
      engine.initSession(SESSION_ID, true);
      for (const event of events) {
        currentTs = event.ts;
        engine.processEvent(SESSION_ID, event);
      }
      engine.dispose();
      const turnFailed = events.find((event) => event.type === EventType.TurnFailed);
      const stop = events.find((event) => event.type === EventType.Idle);
      if (!turnFailed || !stop) throw new Error('The fixture lost its turn_failed or its Stop');
      return { turnEnds, idledAt, turnFailedAt: turnFailed.ts, stopAt: stop.ts };
    }

    it('reports no turn end through the turn_failed, though the session idles there', () => {
      const { turnEnds, idledAt, turnFailedAt } = replay();
      expect(idledAt).toContain(turnFailedAt);
      expect(turnEnds.filter((ts) => ts <= turnFailedAt)).toEqual([]);
    });

    it('reports exactly one turn end, at the Stop after "continue"', () => {
      const { turnEnds, stopAt } = replay();
      expect(turnEnds).toEqual([stopAt]);
    });
  });
});
