/**
 * A background subagent's tool hooks, from Claude Code 2.1.303, through the
 * real hook commands, the real event bridge and a real ActivityEngine.
 *
 * Claude puts `agent_id` on a tool hook's stdin when the tool ran in an agent
 * context of its own, and omits it for the main agent. The engine reads a tool
 * event from an id that no `subagent_start` named as an internal CLI agent's,
 * and logs it without acting on it. That is only safe if the id on a REAL
 * subagent's tool events is the id its `SubagentStart` carried, and the main
 * agent's tool events carry none. This pins that chain against the capture in
 * `tests/fixtures/claude-tool-hook-agent-id.jsonl` (sanitized, one hook stdin
 * payload per line, in the order the CLI fired them):
 *
 *   0 PreToolUse Read (main)          6 PreToolUse Read (subagent)
 *   1 PostToolUse Read (main)         7 PostToolUse Read (subagent)
 *   2 PreToolUse Agent (main)         8 PreToolUse SubagentHandback (subagent)
 *   3 SubagentStart                   9 PostToolUse SubagentHandback (subagent)
 *   4 PostToolUse Agent (main)       10 SubagentStop
 *   5 Stop (subagent still running)  11 Stop
 *
 * The directive arguments are not hand-built: each payload is fed to the real
 * `event-bridge.js` with the arguments of the command `buildHooks` generates
 * for that payload's own `hook_event_name`.
 *
 * Test tier: Unit (vitest). Bridge output goes to a directory under
 * `os.tmpdir()`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHooks } from '../../src/main/agent/adapters/claude';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'claude-tool-hook-agent-id.jsonl');
const SESSION_ID = 'tool-hook-agent-id-session';
/** The `agent_id` of the background subagent in the capture. */
const SUBAGENT_ID = 'a82e5ff400000000f';

/** The slots of the capture, in the order the CLI fired the hooks. */
const SLOT = {
  mainReadStart: 0,
  mainReadEnd: 1,
  mainAgentToolStart: 2,
  subagentStart: 3,
  mainAgentToolEnd: 4,
  mainStop: 5,
  subagentReadStart: 6,
  subagentReadEnd: 7,
  subagentHandbackStart: 8,
  subagentHandbackEnd: 9,
  subagentStop: 10,
  finalStop: 11,
} as const;

interface HookPayload {
  hook_event_name: string;
  tool_name?: string;
  agent_id?: string;
  tool_response?: { agentId?: string };
}

const fixtureLines = fs.readFileSync(FIXTURE, 'utf-8').split(/\r?\n/).filter((line) => line.trim().length > 0);
const payloads = fixtureLines.map((line) => JSON.parse(line) as HookPayload);

/**
 * `buildHooks` is given placeholder paths with no spaces, so a command splits on
 * single spaces: `node "<bridge>" "<events>" <event type> <directive>...`. Every
 * directive is one base64 token (see directive-builders.ts), so what follows
 * the two quoted paths is exactly what a shell would hand the bridge.
 */
const hooks = buildHooks('/fake/event-bridge.js', '/fake/events.jsonl', {});

/** The bridge arguments after the events path: `[event type, ...directives]`, for one hook. */
function bridgeArgsFor(hookEventName: string): string[] {
  const entries = hooks[hookEventName];
  expect(entries, `buildHooks defines a ${hookEventName} hook`).toBeDefined();
  const tokens = entries[0].hooks[0].command.split(' ');
  expect(tokens[0]).toBe('node');
  return tokens.slice(3);
}

/** Feed one raw stdin payload to the real bridge, with the arguments of the hook that owns it. */
function runBridge(eventsPath: string, hookEventName: string, stdin: string): void {
  execFileSync(process.execPath, [BRIDGE, eventsPath, ...bridgeArgsFor(hookEventName)], {
    input: stdin,
    timeout: 10_000,
  });
}

function readEvents(eventsPath: string): SessionEvent[] {
  return fs.readFileSync(eventsPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

let tmpDir: string;
let eventsPath: string;
let events: SessionEvent[];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-hook-agent-id-'));
  eventsPath = path.join(tmpDir, 'events.jsonl');
  // Twelve node spawns, in file order so each event lands in the order it fired.
  fixtureLines.forEach((line, index) => runBridge(eventsPath, payloads[index].hook_event_name, line));
  events = readEvents(eventsPath);
}, 60_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the capture', () => {
  it('has the twelve hooks in the order the slots name', () => {
    expect(payloads.map((payload) => payload.hook_event_name)).toEqual([
      'PreToolUse', 'PostToolUse', 'PreToolUse', 'SubagentStart', 'PostToolUse', 'Stop',
      'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop',
    ]);
  });

  it('puts agent_id on the subagent\'s hooks only, and the agent\'s id inside the main PostToolUse response', () => {
    const withAgentId = payloads.map((payload, slot) => (payload.agent_id !== undefined ? slot : -1)).filter((slot) => slot >= 0);
    expect(withAgentId).toEqual([
      SLOT.subagentStart,
      SLOT.subagentReadStart, SLOT.subagentReadEnd, SLOT.subagentHandbackStart, SLOT.subagentHandbackEnd,
      SLOT.subagentStop,
    ]);
    for (const slot of withAgentId) expect(payloads[slot].agent_id).toBe(SUBAGENT_ID);
    // The trap: the main PostToolUse for the Agent tool names the agent, but not as a top-level agent_id.
    expect(payloads[SLOT.mainAgentToolEnd].tool_response?.agentId).toBe(SUBAGENT_ID);
  });
});

describe('through the real bridge, with the real hook commands', () => {
  it('writes one event per hook, in the order they fired, and no directive went unknown', () => {
    expect(events.map((event) => event.type)).toEqual([
      EventType.ToolStart, EventType.ToolEnd, EventType.ToolStart, EventType.SubagentStart, EventType.ToolEnd, EventType.Idle,
      EventType.ToolStart, EventType.ToolEnd, EventType.ToolStart, EventType.ToolEnd, EventType.SubagentStop, EventType.Idle,
    ]);
    // The bridge logs an unknown or malformed directive here (a stale copy, a renamed kind).
    expect(fs.existsSync(path.join(tmpDir, 'events-bridge.error.log'))).toBe(false);
  });

  it('carries no subagentId on the main agent\'s tool events', () => {
    const mainToolSlots = [SLOT.mainReadStart, SLOT.mainReadEnd, SLOT.mainAgentToolStart, SLOT.mainAgentToolEnd];
    for (const slot of mainToolSlots) {
      expect(events[slot].subagentId, `slot ${slot} (${payloads[slot].tool_name})`).toBeUndefined();
    }
    // Including the Agent tool's own PostToolUse, whose response names the agent it launched.
    expect(events[SLOT.mainAgentToolEnd].tool).toBe('Agent');
    expect(events[SLOT.mainAgentToolEnd].subagentId).toBeUndefined();
  });

  it('carries the SubagentStart\'s subagentId on every subagent tool event', () => {
    const startedId = events[SLOT.subagentStart].subagentId;
    expect(startedId).toBe(SUBAGENT_ID);
    const subagentToolSlots = [SLOT.subagentReadStart, SLOT.subagentReadEnd, SLOT.subagentHandbackStart, SLOT.subagentHandbackEnd];
    for (const slot of subagentToolSlots) {
      expect(events[slot].subagentId, `slot ${slot} (${payloads[slot].tool_name})`).toBe(startedId);
    }
    expect(events[SLOT.subagentStop].subagentId).toBe(startedId);
  });

  it('keeps each tool event\'s tool name and correlation id beside the agent id', () => {
    expect(events[SLOT.subagentReadStart]).toMatchObject({ type: EventType.ToolStart, tool: 'Read', toolId: 'toolu_01SubRead000000000000001' });
    expect(events[SLOT.subagentReadEnd]).toMatchObject({ type: EventType.ToolEnd, tool: 'Read', toolId: 'toolu_01SubRead000000000000001' });
    expect(events[SLOT.subagentHandbackStart]).toMatchObject({ type: EventType.ToolStart, tool: 'SubagentHandback' });
  });

  describe('a PostToolUseFailure, which the capture has none of', () => {
    // Derived from the capture's own subagent payload (hook_event_name swapped,
    // the failure fields Claude documents added), not a capture of its own.
    function interruptedEventFrom(extraFields: Record<string, unknown>): SessionEvent {
      const failurePath = path.join(tmpDir, `failure-${Math.random().toString(36).slice(2)}.jsonl`);
      const derived = { ...JSON.parse(fixtureLines[SLOT.subagentReadStart]) as Record<string, unknown>, hook_event_name: 'PostToolUseFailure', error: 'Interrupted', is_interrupt: true, ...extraFields };
      runBridge(failurePath, 'PostToolUseFailure', JSON.stringify(derived));
      const written = readEvents(failurePath);
      expect(written).toHaveLength(1);
      return written[0];
    }

    it('keeps the subagent\'s id on its interrupted tool', () => {
      const event = interruptedEventFrom({});
      expect(event).toMatchObject({ type: EventType.Interrupted, tool: 'Read', subagentId: SUBAGENT_ID, detail: 'Interrupted' });
    });

    it('has no subagentId on the main agent\'s', () => {
      const event = interruptedEventFrom({ agent_id: undefined });
      expect(event.type).toBe(EventType.Interrupted);
      expect(event.subagentId).toBeUndefined();
    });
  });
});

describe('replayed through a real ActivityEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Step {
    type: string;
    pendingToolCount: number;
    subagentDepth: number;
    workSerial: number;
    internalAgentToolEvent: number;
  }

  /** Feed the events in order and record the engine's counters after each one. */
  function replay(replayed: SessionEvent[]): Step[] {
    const engine = new ActivityEngine(
      { onActivityChange() {} },
      { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 300_000, staleThinkingTimeoutMs: 180_000 },
    );
    engine.initSession(SESSION_ID, false);
    const steps: Step[] = [];
    for (const event of replayed) {
      engine.processEvent(SESSION_ID, event);
      const state = engine.getState(SESSION_ID);
      steps.push({
        type: event.type,
        pendingToolCount: state?.pendingToolCount ?? -1,
        subagentDepth: state?.subagentDepth ?? -1,
        workSerial: state?.workSerial ?? -1,
        internalAgentToolEvent: engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.internalAgentToolEvent ?? -1,
      });
    }
    engine.dispose();
    return steps;
  }

  it('counts the background subagent\'s tools after the main agent\'s Stop, and drops none as internal', () => {
    const steps = replay(events);

    // The setup the capture is about: the main agent stopped while its subagent
    // was still running, so the subagent holds the depth slot.
    expect(steps[SLOT.mainStop].type).toBe(EventType.Idle);
    expect(steps[SLOT.mainStop].subagentDepth).toBe(1);
    expect(steps[SLOT.mainStop].pendingToolCount).toBe(0);

    // The subagent's Read is real work after that Stop: counted in, then counted out.
    expect(steps[SLOT.subagentReadStart].pendingToolCount).toBe(1);
    expect(steps[SLOT.subagentReadStart].workSerial).toBe(steps[SLOT.mainStop].workSerial + 1);
    expect(steps[SLOT.subagentReadEnd].pendingToolCount).toBe(0);
    // So is its SubagentHandback.
    expect(steps[SLOT.subagentHandbackStart].pendingToolCount).toBe(1);
    expect(steps[SLOT.subagentHandbackStart].workSerial).toBe(steps[SLOT.subagentReadStart].workSerial + 1);
    expect(steps[SLOT.subagentHandbackEnd].pendingToolCount).toBe(0);

    expect(steps[SLOT.subagentStop].subagentDepth).toBe(0);
    for (const step of steps) expect(step.internalAgentToolEvent).toBe(0);
  });

  it('would drop those same tools as an internal agent\'s had the subagent never started (the control)', () => {
    const withoutSubagentStart = events.filter((_event, slot) => slot !== SLOT.subagentStart);
    const steps = replay(withoutSubagentStart);

    // Four tool events carry the subagent's id, and with no start naming it and no slot held, all four are logged only.
    expect(steps[steps.length - 1].internalAgentToolEvent).toBe(4);
  });
});
