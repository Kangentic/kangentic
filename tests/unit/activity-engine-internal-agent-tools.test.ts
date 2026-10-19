/**
 * A tool event from an internal CLI agent is logged and nothing more.
 *
 * Claude Code runs agents of its own after a Stop. One of them (most likely the
 * run that answers the prompt suggestion ahead of time) can start a tool and
 * stop before it runs, so its `tool_start` gets no `tool_end`. Its tool hooks carry an `agent_id` that
 * never fired a SubagentStart. Counted, that start reopened the turn the Stop
 * had ended: `workSerial` moved, so the turn end's automations judged the turn
 * stale and ran nothing, and the card read as working until the
 * stuck-pending-tools watchdog, minutes later.
 *
 * The replay is synthetic (made-up ids and times) in the incident's shape: a
 * main turn with one Agent-tool subagent, the Stop, the prompt suggestion's
 * id-only stop, the orphan Skill start, that agent's id-only stop, an
 * idle_hint, and a later internal stop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { isInternalAgentToolEvent, releaseSubagentSlots, updateCounters } from '../../src/main/activity-engine/engine/event-handlers';
import { MAX_STARTED_SUBAGENT_IDS } from '../../src/main/activity-engine/engine/shapes';
import type { SessionEngineState } from '../../src/main/activity-engine/engine/shapes';
import { createSessionEngineState } from '../../src/main/activity-engine/engine/state-factory';
import { EventType } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'internal-agent-session';
const FIXTURE = 'session-033-internal-agent-tool-after-stop.jsonl';
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'replay');
const INTERNAL_AGENT_ID = 'a3333333333333333';
const SUBAGENT_ID = 'a1111111111111111';

function loadFixture(): SessionEvent[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, FIXTURE), 'utf-8');
  return raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as SessionEvent);
}

interface ReplayResult {
  turnEnds: number[];
  finalActivity: ActivityState | undefined;
  workSerialAtStop: number | undefined;
  finalWorkSerial: number | undefined;
  pendingToolCount: number | undefined;
  internalToolEvents: number | undefined;
}

function replay(events: SessionEvent[]): ReplayResult {
  const turnEnds: number[] = [];
  let currentTs = 0;
  let workSerialAtStop: number | undefined;
  const engine = new ActivityEngine(
    {
      onActivityChange() {},
      onTurnEnded() {
        turnEnds.push(currentTs);
      },
    },
    { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 300_000, staleThinkingTimeoutMs: 180_000 },
  );
  engine.initSession(SESSION_ID, false);
  for (const event of events) {
    currentTs = event.ts;
    engine.processEvent(SESSION_ID, event);
    if (event.type === EventType.Idle) workSerialAtStop = engine.getState(SESSION_ID)?.workSerial;
  }
  const state = engine.getState(SESSION_ID);
  const result: ReplayResult = {
    turnEnds,
    finalActivity: state?.activity,
    workSerialAtStop,
    finalWorkSerial: state?.workSerial,
    pendingToolCount: state?.pendingToolCount,
    internalToolEvents: engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.internalAgentToolEvent,
  };
  engine.dispose();
  return result;
}

describe('internal CLI agent tool events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('session-033: an orphan tool start after the Stop', () => {
    it('keeps the incident shape: an unstarted id on a tool start with no end', () => {
      const events = loadFixture();
      const internalStart = events.find((event) => event.type === EventType.ToolStart && event.subagentId === INTERNAL_AGENT_ID);
      expect(internalStart).toBeDefined();
      expect(events.some((event) => event.type === EventType.SubagentStart && event.subagentId === INTERNAL_AGENT_ID)).toBe(false);
      expect(events.some((event) => event.type === EventType.ToolEnd && event.toolId === internalStart?.toolId)).toBe(false);
    });

    it('ends the turn once at the Stop and stays there', () => {
      const events = loadFixture();
      const stop = events.find((event) => event.type === EventType.Idle);
      const result = replay(events);
      expect(result.turnEnds).toEqual([stop?.ts]);
      expect(result.finalActivity).toBe('idle');
      // The turn end's identity is still the latest, so its automations run.
      expect(result.finalWorkSerial).toBe(result.workSerialAtStop);
      expect(result.pendingToolCount).toBe(0);
      expect(result.internalToolEvents).toBe(1);
    });

    it('reopens the turn when the tool start carries no agent id (mechanical red-green)', () => {
      // What the engine saw before the tool hooks extracted `agent_id`.
      const withoutToolIds = loadFixture().map((event) => {
        if (event.type !== EventType.ToolStart && event.type !== EventType.ToolEnd) return event;
        const { subagentId: _subagentId, ...rest } = event;
        return rest;
      });
      const result = replay(withoutToolIds);
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalWorkSerial).toBeGreaterThan(result.workSerialAtStop ?? 0);
      expect(result.pendingToolCount).toBe(1);
      expect(result.internalToolEvents).toBe(0);
    });

    it('still counts the Agent-tool subagent\'s own tools', () => {
      const events = loadFixture();
      const subagentTool = events.find((event) => event.type === EventType.ToolStart && event.subagentId === SUBAGENT_ID);
      expect(subagentTool).toBeDefined();
      // Exactly one event was log-only, and it was not the subagent's.
      expect(replay(events).internalToolEvents).toBe(1);
    });
  });

  describe('isInternalAgentToolEvent', () => {
    const empty = {
      subagentDepth: 0,
      subagentLifecycleById: new Map<string, 'live' | 'stopped'>(),
      startedSubagentIds: new Set<string>(),
    };
    const toolStart = (subagentId?: string): SessionEvent => ({ ts: 0, type: EventType.ToolStart, tool: 'Read', toolId: 'toolu_x', subagentId });

    it('is false for the main agent, which sends no id', () => {
      expect(isInternalAgentToolEvent(empty, toolStart())).toBe(false);
      expect(isInternalAgentToolEvent(empty, toolStart(''))).toBe(false);
    });

    it('is true for an id that never started', () => {
      expect(isInternalAgentToolEvent(empty, toolStart('a-internal'))).toBe(true);
    });

    it('is false for a live subagent and for one that stopped once', () => {
      // A re-prompted background subagent runs tools after its first named stop (task #759).
      const state = {
        subagentDepth: 1,
        subagentLifecycleById: new Map<string, 'live' | 'stopped'>([['a-live', 'live'], ['a-stopped', 'stopped']]),
        startedSubagentIds: new Set(['a-live', 'a-stopped']),
      };
      expect(isInternalAgentToolEvent(state, toolStart('a-live'))).toBe(false);
      expect(isInternalAgentToolEvent(state, toolStart('a-stopped'))).toBe(false);
    });

    it('is false while an id-less start holds a slot', () => {
      // An older CLI whose SubagentStart carried no id: its subagent's tools must still count.
      const state = { subagentDepth: 1, subagentLifecycleById: new Map<string, 'live' | 'stopped'>(), startedSubagentIds: new Set<string>() };
      expect(isInternalAgentToolEvent(state, toolStart('a-unknown'))).toBe(false);
    });

    it('still counts a re-prompted subagent whose id the lifecycle ledger evicted', () => {
      // The #759 shape inside a big fan-out: the agent stops once, more than
      // the ledger's cap of other agents start and stop after it, and it then
      // runs tools again. Stopped ids are evicted first, so the ledger has
      // forgotten it; the started set has not.
      const engine = new ActivityEngine(
        { onActivityChange() {} },
        { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 300_000, staleThinkingTimeoutMs: 180_000 },
      );
      engine.initSession(SESSION_ID, false);
      let ts = 1;
      engine.processEvent(SESSION_ID, { ts: ts++, type: EventType.Prompt });
      engine.processEvent(SESSION_ID, { ts: ts++, type: EventType.SubagentStart, detail: 'test-builder', subagentId: 'a-early' });
      engine.processEvent(SESSION_ID, { ts: ts++, type: EventType.SubagentStop, detail: 'test-builder', subagentId: 'a-early' });
      for (let index = 0; index < 80; index++) {
        const id = `a-finder-${index}`;
        engine.processEvent(SESSION_ID, { ts: ts++, type: EventType.SubagentStart, detail: 'review-finder', subagentId: id });
        engine.processEvent(SESSION_ID, { ts: ts++, type: EventType.SubagentStop, detail: 'review-finder', subagentId: id });
      }
      expect(engine.getState(SESSION_ID)?.subagentLifecycleById.has('a-early')).toBe(false);

      const before = engine.getState(SESSION_ID)?.workSerial ?? 0;
      engine.processEvent(SESSION_ID, { ts, type: EventType.ToolStart, tool: 'SubagentHandback', toolId: 'toolu_handback', subagentId: 'a-early' });

      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
      expect(engine.getState(SESSION_ID)?.workSerial).toBe(before + 1);
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.internalAgentToolEvent).toBe(0);
      engine.dispose();
    });

    it('covers every tool event type, and nothing else', () => {
      const internalAgentId = 'a-internal';
      for (const type of [EventType.ToolStart, EventType.ToolEnd, EventType.Interrupted, EventType.BackgroundShellStart, EventType.BackgroundShellEnd]) {
        expect(isInternalAgentToolEvent(empty, { ts: 0, type, subagentId: internalAgentId })).toBe(true);
      }
      for (const type of [EventType.SubagentStart, EventType.SubagentStop, EventType.Idle, EventType.Prompt]) {
        expect(isInternalAgentToolEvent(empty, { ts: 0, type, subagentId: internalAgentId })).toBe(false);
      }
    });
  });

  describe('a main-agent turn in flight', () => {
    function startTurn(): ActivityEngine {
      const engine = new ActivityEngine(
        { onActivityChange() {} },
        { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 300_000, staleThinkingTimeoutMs: 180_000 },
      );
      engine.initSession(SESSION_ID, false);
      engine.processEvent(SESSION_ID, { ts: 1, type: EventType.Prompt });
      engine.processEvent(SESSION_ID, { ts: 2, type: EventType.ToolStart, tool: 'Skill', toolId: 'toolu_main_skill' });
      return engine;
    }

    it('an internal agent\'s tool end does not drain the main agent\'s tool of the same name', () => {
      const engine = startTurn();
      engine.processEvent(SESSION_ID, { ts: 3, type: EventType.ToolEnd, tool: 'Skill', toolId: 'toolu_internal', subagentId: 'a-internal' });
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
      expect(engine.getState(SESSION_ID)?.pendingToolStack.map((entry) => entry.id)).toEqual(['toolu_main_skill']);
      engine.dispose();
    });

    it('an internal agent\'s interrupted tool does not end the main turn', () => {
      const engine = startTurn();
      engine.processEvent(SESSION_ID, { ts: 3, type: EventType.Interrupted, tool: 'Bash', toolId: 'toolu_internal', subagentId: 'a-internal' });
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.turnActive).toBe(true);
      engine.dispose();
    });

    it('answers isInternalAgentEvent the same as the engine acts', () => {
      const engine = startTurn();
      const internal: SessionEvent = { ts: 3, type: EventType.ToolStart, tool: 'Read', toolId: 'toolu_internal', subagentId: 'a-internal' };
      expect(engine.isInternalAgentEvent(SESSION_ID, internal)).toBe(true);
      expect(engine.isInternalAgentEvent(SESSION_ID, { ...internal, subagentId: undefined })).toBe(false);
      engine.dispose();
    });

    it('answers from the session\'s own started ids, not from an empty fallback', () => {
      // An id that fired a subagent_start in THIS session is not internal. An
      // implementation that always used the empty fallback state would call it
      // internal (nothing started, no slot held).
      const engine = startTurn();
      engine.processEvent(SESSION_ID, { ts: 3, type: EventType.SubagentStart, detail: 'test-builder', subagentId: 'a-started' });
      engine.processEvent(SESSION_ID, { ts: 4, type: EventType.SubagentStop, detail: 'test-builder', subagentId: 'a-started' });
      const underStartedId: SessionEvent = { ts: 5, type: EventType.ToolStart, tool: 'Read', toolId: 'toolu_started', subagentId: 'a-started' };
      expect(engine.isInternalAgentEvent(SESSION_ID, underStartedId)).toBe(false);
      expect(engine.isInternalAgentEvent(SESSION_ID, { ...underStartedId, subagentId: 'a-never-started' })).toBe(true);
      engine.dispose();
    });
  });

  describe('isInternalAgentEvent for a session the engine has never seen', () => {
    // No initSession and no processEvent: the engine holds no state for this id,
    // so the answer comes from the empty fallback state (depth 0, nothing started).
    const UNSEEN_SESSION_ID = 'never-seen-session';
    const toolEvent = (subagentId?: string): SessionEvent => ({ ts: 1, type: EventType.ToolStart, tool: 'Read', toolId: 'toolu_unseen', subagentId });

    function makeUnseenEngine(): ActivityEngine {
      return new ActivityEngine(
        { onActivityChange() {} },
        { idleStabilityWindowMs: 0, bgShellEscapeHatchMs: 300_000, staleThinkingTimeoutMs: 180_000 },
      );
    }

    it('reads an id-bearing tool start as internal: no subagent_start named it and no slot is held', () => {
      const engine = makeUnseenEngine();
      expect(engine.isInternalAgentEvent(UNSEEN_SESSION_ID, toolEvent('a-internal'))).toBe(true);
      engine.dispose();
    });

    it('reads a tool start with no id as the main agent\'s, not internal', () => {
      const engine = makeUnseenEngine();
      expect(engine.isInternalAgentEvent(UNSEEN_SESSION_ID, toolEvent())).toBe(false);
      engine.dispose();
    });

    it('never reads a subagent_start as internal', () => {
      const engine = makeUnseenEngine();
      const subagentStart: SessionEvent = { ts: 1, type: EventType.SubagentStart, detail: 'general-purpose', subagentId: 'a-internal' };
      expect(engine.isInternalAgentEvent(UNSEEN_SESSION_ID, subagentStart)).toBe(false);
      engine.dispose();
    });

    it('is a query only: asking does not create a session', () => {
      const engine = makeUnseenEngine();
      engine.isInternalAgentEvent(UNSEEN_SESSION_ID, toolEvent('a-internal'));
      expect(engine.getState(UNSEEN_SESSION_ID)).toBeUndefined();
      engine.dispose();
    });
  });

  describe('the started-id set is bounded oldest-first', () => {
    /** A named subagent that starts and stops, so it holds no depth slot and no live ledger entry. */
    function startAndStop(state: SessionEngineState, subagentId: string): void {
      updateCounters(state, { ts: 0, type: EventType.SubagentStart, detail: 'general-purpose', subagentId });
      updateCounters(state, { ts: 0, type: EventType.SubagentStop, detail: 'general-purpose', subagentId });
    }
    /** Does a tool event under this id read as an internal agent's? An id the set dropped does: nothing holds a slot. */
    function readsAsInternal(state: SessionEngineState, subagentId: string): boolean {
      return isInternalAgentToolEvent(state, { ts: 0, type: EventType.ToolStart, tool: 'Read', toolId: 'toolu_x', subagentId });
    }

    it('keeps every id up to the cap', () => {
      const state = createSessionEngineState();
      for (let index = 0; index < MAX_STARTED_SUBAGENT_IDS; index++) startAndStop(state, `a-${index}`);
      expect(state.startedSubagentIds.size).toBe(MAX_STARTED_SUBAGENT_IDS);
      expect(readsAsInternal(state, 'a-0')).toBe(false);
      expect(readsAsInternal(state, `a-${MAX_STARTED_SUBAGENT_IDS - 1}`)).toBe(false);
    });

    it('evicts the id started longest ago once one more than the cap has started', () => {
      const state = createSessionEngineState();
      for (let index = 0; index <= MAX_STARTED_SUBAGENT_IDS; index++) startAndStop(state, `a-${index}`);
      expect(state.startedSubagentIds.size).toBe(MAX_STARTED_SUBAGENT_IDS);
      // The first id is gone, so its tool now reads as an internal agent's.
      expect(readsAsInternal(state, 'a-0')).toBe(true);
      // The second, and the newest, still count.
      expect(readsAsInternal(state, 'a-1')).toBe(false);
      expect(readsAsInternal(state, `a-${MAX_STARTED_SUBAGENT_IDS}`)).toBe(false);
    });

    it('re-starting the oldest id moves it to the newest position, so the next eviction takes another', () => {
      const state = createSessionEngineState();
      startAndStop(state, 'a-oldest');
      for (let index = 0; index < MAX_STARTED_SUBAGENT_IDS - 1; index++) startAndStop(state, `a-fill-${index}`);
      expect(state.startedSubagentIds.size).toBe(MAX_STARTED_SUBAGENT_IDS);

      startAndStop(state, 'a-oldest');
      startAndStop(state, 'a-fresh');

      // The oldest id was started again after the others, so the oldest OTHER id goes.
      expect(readsAsInternal(state, 'a-oldest')).toBe(false);
      expect(readsAsInternal(state, 'a-fill-0')).toBe(true);
      expect(readsAsInternal(state, 'a-fill-1')).toBe(false);
      expect(readsAsInternal(state, 'a-fresh')).toBe(false);
    });

    it('re-starting an id that is not the oldest takes no new slot, so it evicts nothing', () => {
      const state = createSessionEngineState();
      startAndStop(state, 'a-first');
      startAndStop(state, 'a-restarted');
      for (let index = 0; index < MAX_STARTED_SUBAGENT_IDS - 2; index++) startAndStop(state, `a-fill-${index}`);
      expect(state.startedSubagentIds.size).toBe(MAX_STARTED_SUBAGENT_IDS);

      // The set is full. Re-starting a member must not push the oldest id out:
      // the id is already counted, so the set does not grow.
      startAndStop(state, 'a-restarted');
      expect(state.startedSubagentIds.size).toBe(MAX_STARTED_SUBAGENT_IDS);
      expect(readsAsInternal(state, 'a-first')).toBe(false);

      // One new id evicts the oldest, and the re-started id is now the newest
      // but one, behind every fill. A second new id evicts the oldest fill.
      startAndStop(state, 'a-fresh-1');
      expect(readsAsInternal(state, 'a-first')).toBe(true);
      expect(readsAsInternal(state, 'a-restarted')).toBe(false);
      startAndStop(state, 'a-fresh-2');
      expect(readsAsInternal(state, 'a-fill-0')).toBe(true);
      expect(readsAsInternal(state, 'a-fill-1')).toBe(false);
      expect(readsAsInternal(state, 'a-restarted')).toBe(false);
      expect(readsAsInternal(state, 'a-fresh-1')).toBe(false);
      expect(readsAsInternal(state, 'a-fresh-2')).toBe(false);
    });
  });

  describe('a subagent whose depth slot a reset released keeps its started id', () => {
    const toolUnderReleasedAgent: SessionEvent = { ts: 30, type: EventType.ToolStart, tool: 'Read', toolId: 'toolu_after_release', subagentId: 'a-sub' };

    it('releaseSubagentSlots zeroes the depth and the ledger, and the id still reads as started', () => {
      const state = createSessionEngineState();
      updateCounters(state, { ts: 1, type: EventType.SubagentStart, detail: 'test-builder', subagentId: 'a-sub' });
      expect(state.subagentDepth).toBe(1);
      expect(isInternalAgentToolEvent(state, toolUnderReleasedAgent)).toBe(false);

      releaseSubagentSlots(state);

      // The release really happened. Were the id still live, its tool would count for that reason.
      expect(state.subagentDepth).toBe(0);
      expect(state.subagentLifecycleById.get('a-sub')).toBe('stopped');
      // Nothing holds a slot, so only the started set keeps this tool from reading as internal.
      expect(isInternalAgentToolEvent(state, toolUnderReleasedAgent)).toBe(false);
    });

    // Each engine path that force-releases the slots. A later edit to any one of
    // them (not only to releaseSubagentSlots) must leave the started ids alone.
    const STUCK_SUBAGENT_HATCH_MS = 5_000;
    const STABILITY_WINDOW_MS = 100;
    const releasePaths: Array<{
      name: string;
      release: (engine: ActivityEngine) => void;
      stuckSubagentFires: number;
    }> = [
      { name: 'forceIdle', release: (engine) => engine.forceIdle(SESSION_ID), stuckSubagentFires: 0 },
      {
        name: 'a main-agent interrupt',
        release: (engine) => engine.processEvent(SESSION_ID, { ts: 20, type: EventType.Interrupted }),
        stuckSubagentFires: 0,
      },
      {
        name: 'the stuck-subagent watchdog',
        release: () => vi.advanceTimersByTime(STUCK_SUBAGENT_HATCH_MS + STABILITY_WINDOW_MS + 50),
        stuckSubagentFires: 1,
      },
    ];

    it.each(releasePaths)('still counts the released subagent\'s tool after $name', ({ release, stuckSubagentFires }) => {
      const engine = new ActivityEngine(
        { onActivityChange() {} },
        { idleStabilityWindowMs: STABILITY_WINDOW_MS, bgShellEscapeHatchMs: STUCK_SUBAGENT_HATCH_MS, staleThinkingTimeoutMs: 180_000 },
      );
      engine.initSession(SESSION_ID, false);
      engine.processEvent(SESSION_ID, { ts: 1, type: EventType.Prompt });
      engine.processEvent(SESSION_ID, { ts: 2, type: EventType.SubagentStart, detail: 'test-builder', subagentId: 'a-sub' });
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(1);

      release(engine);

      // The release really happened, through the path under test.
      expect(engine.getState(SESSION_ID)?.subagentDepth).toBe(0);
      expect(engine.getState(SESSION_ID)?.subagentLifecycleById.get('a-sub')).toBe('stopped');
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.stuckSubagent).toBe(stuckSubagentFires);

      const workSerialBefore = engine.getState(SESSION_ID)?.workSerial ?? 0;
      engine.processEvent(SESSION_ID, toolUnderReleasedAgent);

      // A subagent a reset released can still be running, so its tool is the work it is.
      expect(engine.getState(SESSION_ID)?.pendingToolCount).toBe(1);
      expect(engine.getState(SESSION_ID)?.workSerial).toBe(workSerialBefore + 1);
      expect(engine.getStatsSnapshot(SESSION_ID)?.compensationCounters.internalAgentToolEvent).toBe(0);
      engine.dispose();
    });
  });
});
