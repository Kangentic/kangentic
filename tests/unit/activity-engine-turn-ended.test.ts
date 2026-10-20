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
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActivityEngine, type TurnStartCause } from '../../src/main/activity-engine/engine';
import { buildHooks as buildQwenHooks } from '../../src/main/agent/adapters/qwen-code';
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
  /** Each `onTurnStarted`, in order: the stamp and what set it. */
  startCalls: Array<{ turnStartedAt: number; cause: TurnStartCause }>;
  send: (type: EventType, extra?: Partial<SessionEvent>) => void;
}

function createHarness(options: { stabilityMs?: number; seedThinking?: boolean } = {}): Harness {
  const turnEnds: number[] = [];
  const turnStarts: Array<number | null> = [];
  const workSerials: number[] = [];
  const startCalls: Array<{ turnStartedAt: number; cause: TurnStartCause }> = [];
  const engine = new ActivityEngine(
    {
      onActivityChange() {},
      onTurnStarted(_sessionId, turnStartedAt, cause) {
        startCalls.push({ turnStartedAt, cause });
      },
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
  return { engine, turnEnds, turnStarts, workSerials, startCalls, send };
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

  // Task #857: the agent marks a shell it left running as a service through the
  // kangentic_mark_background_service MCP tool. A held turn then ends as if its
  // background work had drained, through the real stability window.
  it('ends a turn held by an untagged server once the agent marks that server as a service', () => {
    const harness = createHarness({ stabilityMs: 400 });
    const turnStartedAt = Date.now();
    harness.send(EventType.Prompt);
    startBackgroundServer(harness, 'npm run dev');
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(60_000);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    expect(harness.turnEnds).toHaveLength(0);
    const workSerial = harness.engine.getState(SESSION_ID)?.workSerial;

    const outcomes = harness.engine.markBackgroundShellsAsServices(SESSION_ID, ['shell-server']);
    expect(outcomes).toEqual([{ shellId: 'shell-server', outcome: 'marked' }]);
    vi.advanceTimersByTime(400);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
    expect(harness.turnStarts).toEqual([turnStartedAt]);
    expect(harness.workSerials).toEqual([workSerial]);
    // Marking it again reports nothing more.
    harness.engine.markBackgroundShellsAsServices(SESSION_ID, ['shell-server']);
    vi.advanceTimersByTime(400);
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('ends the turn at its Stop when the agent marked its server as a service mid-turn', () => {
    const harness = createHarness({ stabilityMs: 400 });
    harness.send(EventType.Prompt);
    startBackgroundServer(harness, 'npm run dev');
    harness.engine.markBackgroundShellsAsServices(SESSION_ID, ['shell-server']);
    // The turn itself still holds until its Stop.
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('thinking');
    harness.send(EventType.Idle);
    vi.advanceTimersByTime(400);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  it('a mark that arrives before the engine saw the shell start lands it exempt at its promotion', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'server', detail: 'npm run dev' });
    expect(harness.engine.markBackgroundShellsAsServices(SESSION_ID, ['shell-server']))
      .toEqual([{ shellId: 'shell-server', outcome: 'pending' }]);
    harness.send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'server', detail: 'shell-server' });
    harness.send(EventType.Idle);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
    harness.engine.dispose();
  });

  // #854: the /preview watcher, flag included, launched through the PowerShell
  // tool. Claude's PreToolUse remap is Bash-only, so the launch is a plain
  // tool_start and only its PostToolUse names the shell.
  it('ends the turn at its Stop when a flagged server was launched through a tool the PreToolUse remap does not cover', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, {
      tool: 'PowerShell',
      toolId: 'preview-watch',
      detail: `node scripts/worktree-preview.js --wait --port=5175 ${NO_ACTIVITY_HOLD_FLAG}`,
    });
    harness.send(EventType.BackgroundShellStart, { tool: 'PowerShell', toolId: 'preview-watch', detail: 'bdrb9enzm' });
    harness.send(EventType.Idle);
    expect(harness.engine.getState(SESSION_ID)?.activity).toBe('idle');
    expect(harness.turnEnds).toHaveLength(1);
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

  it('a subagent re-started while still live holds one slot, so the parent\'s Stop after its one stop ends the turn', () => {
    // A SendMessage re-task of an agent whose first run never fired its named
    // stop (task #835). Counted twice, its one stop left the parent's Stop
    // reading as a subagent's.
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.SubagentStart, { detail: 'review-finder', subagentId: 'finder' });
    harness.send(EventType.SubagentStart, { detail: 'review-finder', subagentId: 'finder' });
    harness.send(EventType.SubagentStop, { detail: 'review-finder', subagentId: 'finder' });
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

  describe('a live Qwen Code 0.25.2 session with a background and a foreground subagent', () => {
    // The raw hook payloads of one session (tests/fixtures/qwen-hooks/), bridged
    // here through Qwen's real buildHooks wiring and event-bridge.js, so the
    // replay follows what the adapter wires today. The main agent's Stop on
    // line 17 arrived while a background subagent still ran (lines 19 to 21),
    // and the agent resumed on its own once it finished (line 22). Line 26 is
    // an Esc interrupt, which idles the session and reports no turn end.
    const QWEN_CAPTURE = path.join(__dirname, '..', 'fixtures', 'qwen-hooks', 'session-background-and-foreground-subagents.jsonl');
    const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');
    let bridged: Array<{ line: number; event: SessionEvent }> = [];

    beforeAll(() => {
      const hooks = buildQwenHooks('/mock/.kangentic/event-bridge.js', '/mock/.kangentic/events.jsonl', {});
      const capture = fs.readFileSync(QWEN_CAPTURE, 'utf-8').split('\n').filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { event: string; stdin: Record<string, unknown> });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-turn-end-'));
      const eventsFile = path.join(tmpDir, 'events.jsonl');
      try {
        bridged = [];
        capture.forEach((entry, index) => {
          const entries = hooks[entry.event];
          // A hook event the adapter does not wire never reaches the engine.
          if (!entries) return;
          // `node "<bridge>" "<events>" <eventType> <directive> ...`, with no spaces in the paths.
          const tokens = entries[entries.length - 1].hooks[0].command.split(' ');
          fs.rmSync(eventsFile, { force: true });
          execFileSync(process.execPath, [BRIDGE, eventsFile, tokens[3], ...tokens.slice(4)], {
            input: JSON.stringify(entry.stdin),
            timeout: 5000,
          });
          const event = JSON.parse(fs.readFileSync(eventsFile, 'utf-8').trim()) as SessionEvent;
          bridged.push({ line: index + 1, event: { ...event, ts: Date.parse(String(entry.stdin.timestamp)) } });
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      // One node process per hook payload, so a loaded CI shard gets room.
    }, 30_000);

    function replayQwen(): { turnEndLines: number[]; stopLines: number[]; finalActivity: string | undefined; finalDepth: number | undefined } {
      const turnEndLines: number[] = [];
      let currentLine = 0;
      const engine = new ActivityEngine(
        {
          onActivityChange() {},
          onTurnEnded() {
            turnEndLines.push(currentLine);
          },
        },
        { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 1000, staleThinkingTimeoutMs: 60_000 },
      );
      engine.initSession(SESSION_ID, true);
      for (const { line, event } of bridged) {
        currentLine = line;
        engine.processEvent(SESSION_ID, event);
      }
      const state = engine.getState(SESSION_ID);
      engine.dispose();
      return {
        turnEndLines,
        stopLines: bridged.filter(({ event }) => event.type === EventType.Idle && event.detail !== IdleReason.Permission).map(({ line }) => line),
        finalActivity: state?.activity,
        finalDepth: state?.subagentDepth,
      };
    }

    it('reports a turn end only at the Stops after which no subagent is left', () => {
      const { turnEndLines, stopLines } = replayQwen();
      expect(stopLines).toEqual([17, 29, 42]);
      expect(turnEndLines).toEqual([29, 42]);
    });

    it('ends idle with no subagent counted', () => {
      const { finalActivity, finalDepth } = replayQwen();
      expect(finalActivity).toBe('idle');
      expect(finalDepth).toBe(0);
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

  describe('session-032: #832 Code Review pass, a finder re-tasked before its first run stopped', () => {
    // Task #835. Trimmed from the #832 review session (0792ee8b) to its
    // subagent, SubagentHandback, SendMessage, prompt and idle events, with the
    // session_start reduced to its type. The three background shells a
    // test-builder started were dropped: the bg-shell watcher drained them in
    // production, and this harness does not drive the watcher.
    //
    // Finder a4ddf500929115e85 started with the fan-out. Its first run called
    // SubagentHandback, which got no tool_end, and no named stop came for that
    // run. The driver re-tasked it with SendMessage, which fired a second start
    // under the same id while the ledger still held it live. Counted twice, it
    // left the depth at 1 after the last test-builder stopped, so the parent's
    // final Stop read as a subagent's and the turn-end automations never ran.
    const FIXTURE = 'session-032-restarted-live-subagent.jsonl';
    const RESTARTED_ID = 'a4ddf500929115e85';

    function replay(events: SessionEvent[]): {
      turnEnds: number[];
      finalDepth: number | undefined;
      duplicateStarts: number | undefined;
    } {
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
      const finalDepth = engine.getState(SESSION_ID)?.subagentDepth;
      const duplicateStarts = engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.duplicateSubagentStart;
      engine.dispose();
      return { turnEnds, finalDepth, duplicateStarts };
    }

    const isNamedStop = (event: SessionEvent): boolean => event.type === EventType.SubagentStop && event.detail !== '';

    it('keeps the restart: 17 starts against 16 named stops, two of the starts for one finder', () => {
      const events = loadFixture(FIXTURE);
      expect(events.filter((event) => event.type === EventType.SubagentStart)).toHaveLength(17);
      expect(events.filter(isNamedStop)).toHaveLength(16);
      expect(events.filter((event) => event.type === EventType.SubagentStart && event.subagentId === RESTARTED_ID)).toHaveLength(2);
      expect(events.filter((event) => isNamedStop(event) && event.subagentId === RESTARTED_ID)).toHaveLength(1);
    });

    it('reports exactly one turn end, at the final Stop', () => {
      const events = loadFixture(FIXTURE);
      const finalStop = events.filter((event) => event.type === EventType.Idle).at(-1);
      if (!finalStop) throw new Error('The fixture lost its Stops');
      const { turnEnds, finalDepth, duplicateStarts } = replay(events);
      expect(turnEnds).toEqual([finalStop.ts]);
      expect(finalDepth).toBe(0);
      // The SendMessage re-task is the one start that took no slot.
      expect(duplicateStarts).toBe(1);
    });

    it('reports no turn end when the ids are stripped (mechanical red-green)', () => {
      // Without ids the engine counts every start, as it did before the fix.
      // One slot is left over, and the final Stop reads as a subagent's.
      const withoutIds = loadFixture(FIXTURE).map(({ subagentId: _subagentId, ...event }) => event);
      const { turnEnds, finalDepth, duplicateStarts } = replay(withoutIds);
      expect(turnEnds).toEqual([]);
      expect(finalDepth).toBe(1);
      expect(duplicateStarts).toBe(0);
    });
  });
});

/**
 * `ActivityEngineCallbacks.onTurnStarted`: every stamp of `turnStartedAt`,
 * with what set it. The session manager keys a turn's transcript anchor to the
 * stamp, so a turn end's reply is read from where its own turn began. The stamp
 * it reports must be the one the turn end reports back.
 */
describe('onTurnStarted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires when the session goes from idle to thinking, with the stamp the turn end reports', () => {
    const harness = createHarness();
    vi.advanceTimersByTime(1_000);
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(5_000);
    harness.send(EventType.Idle);
    expect(harness.startCalls).toEqual([{ turnStartedAt: harness.turnStarts[0], cause: 'idle' }]);
    harness.engine.dispose();
  });

  it('fires at the seed of a fresh spawn', () => {
    const seededAt = Date.now();
    const harness = createHarness({ seedThinking: true });
    vi.advanceTimersByTime(5_000);
    harness.send(EventType.Idle);
    expect(harness.startCalls).toEqual([{ turnStartedAt: seededAt, cause: 'seed' }]);
    expect(harness.turnStarts).toEqual([seededAt]);
    harness.engine.dispose();
  });

  it('does not fire when a permission prompt resolves back to thinking, which is the same turn', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    vi.advanceTimersByTime(1_000);
    harness.send(EventType.Idle, { detail: IdleReason.Permission });
    vi.advanceTimersByTime(4_000);
    harness.send(EventType.ToolStart, { tool: 'Bash', toolId: 'p' });
    harness.send(EventType.ToolEnd, { tool: 'Bash', toolId: 'p' });
    harness.send(EventType.Idle);
    expect(harness.startCalls.map((call) => call.cause)).toEqual(['idle']);
    harness.engine.dispose();
  });

  it('fires again at a plan approval, whose stamp is the one the turn end reports', () => {
    const harness = createHarness();
    harness.send(EventType.Prompt);
    harness.send(EventType.ToolStart, { tool: 'ExitPlanMode', toolId: 'plan' });
    harness.send(EventType.Idle, { detail: IdleReason.Permission });
    vi.advanceTimersByTime(60_000);
    const approvedAt = Date.now();
    harness.send(EventType.ToolEnd, { tool: 'ExitPlanMode', toolId: 'plan' });
    harness.send(EventType.ToolStart, { tool: 'Edit', toolId: 'edit' });
    harness.send(EventType.ToolEnd, { tool: 'Edit', toolId: 'edit' });
    harness.send(EventType.Idle);
    expect(harness.startCalls.map((call) => call.cause)).toEqual(['idle', 'plan-approval']);
    expect(harness.startCalls[1].turnStartedAt).toBe(approvedAt);
    expect(harness.turnStarts).toEqual([approvedAt]);
    harness.engine.dispose();
  });
});
