/**
 * Property-based tests for ActivityEngine.
 *
 * Generates random sequences of SessionEvents (and force-path calls)
 * via fast-check and asserts core invariants that must hold regardless
 * of input. These catch regressions that example-based tests miss:
 *
 * - counters never go negative
 * - predicate returns one of three legal values
 * - dispose is idempotent
 * - no crash on any sequence of legal events
 * - state is internally consistent (e.g. activity matches predicate)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'property-session';

const EVENT_TYPES: EventType[] = [
  EventType.Prompt,
  EventType.ToolStart,
  EventType.ToolEnd,
  EventType.Idle,
  EventType.Interrupted,
  EventType.SubagentStart,
  EventType.SubagentStop,
  EventType.BackgroundShellStart,
  EventType.BackgroundShellEnd,
  EventType.SessionStart,
  EventType.SessionEnd,
  EventType.Notification,
  EventType.IdleHint,
  EventType.Compact,
  EventType.WorktreeCreate,
  EventType.WorktreeRemove,
];

const eventArb = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  detail: fc.option(
    fc.oneof(
      fc.constant(IdleReason.Permission),
      fc.constant('bash_1'),
      fc.constant('bash_2'),
      fc.string({ minLength: 1, maxLength: 8 }),
    ),
    { nil: undefined },
  ),
  tool: fc.option(
    fc.constantFrom('Bash', 'Read', 'Edit', 'Glob', 'Grep'),
    { nil: undefined },
  ),
}).map((parts): SessionEvent => ({
  ts: 0,
  type: parts.type,
  detail: parts.detail ?? undefined,
  tool: parts.tool ?? undefined,
}));

const sequenceArb = fc.array(eventArb, { minLength: 0, maxLength: 200 });

function makeEngine() {
  const transitions: Array<{ activity: ActivityState; reason: ActivityReason }> = [];
  const engine = new ActivityEngine(
    {
      onActivityChange(_sessionId, activity, reason) {
        transitions.push({ activity, reason });
      },
    },
    {
      bgShellEscapeHatchMs: 60_000,
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0, // skip window for property tests - keep them deterministic
    },
  );
  return { engine, transitions };
}

describe('ActivityEngine property tests', () => {
  it('counters never go negative for any event sequence', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
          const state = engine.getState(SESSION_ID);
          expect(state).toBeDefined();
          expect(state!.pendingToolCount).toBeGreaterThanOrEqual(0);
          expect(state!.subagentDepth).toBeGreaterThanOrEqual(0);
          expect(state!.anonymousBackgroundShellCount).toBeGreaterThanOrEqual(0);
        }
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('activity is always a legal value', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        const state = engine.getState(SESSION_ID)!;
        expect(['idle', 'thinking', 'permission']).toContain(state.activity);
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('reason kind is always a legal value', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        const reason = engine.getActivityReason(SESSION_ID)!;
        expect([
          'idle',
          'permission',
          'tool',
          'subagent',
          'background-shell',
          'turn-active',
        ]).toContain(reason.kind);
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('Interrupted always lands in idle (no counters held)', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        engine.processEvent(SESSION_ID, { ts: 0, type: EventType.Interrupted });
        const state = engine.getState(SESSION_ID)!;
        expect(state.activity).toBe('idle');
        // Interrupted decrements pendingToolCount but doesn't reset counters.
        // (Subagent and bg shells from the prefix sequence may still be held.)
        // Still - the immediate transition should be idle.
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('forceIdle always lands in idle with all counters cleared', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        engine.forceIdle(SESSION_ID);
        const state = engine.getState(SESSION_ID)!;
        expect(state.activity).toBe('idle');
        expect(state.turnActive).toBe(false);
        expect(state.pendingToolCount).toBe(0);
        expect(state.subagentDepth).toBe(0);
        expect(state.activeBackgroundShellIds.size).toBe(0);
        expect(state.anonymousBackgroundShellCount).toBe(0);
        expect(state.permissionPending).toBe(false);
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('dispose() is idempotent and clears all state', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        engine.dispose();
        engine.dispose(); // second call is a no-op
        // Post-dispose, mutators are no-ops
        engine.processEvent(SESSION_ID, { ts: 0, type: EventType.ToolStart });
        engine.forceThinking(SESSION_ID);
        engine.forceIdle(SESSION_ID);
        // No state should exist
        expect(engine.getState(SESSION_ID)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('activity matches the predicate (no internal inconsistency)', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          engine.processEvent(SESSION_ID, event);
        }
        const state = engine.getState(SESSION_ID)!;
        const reason = engine.getActivityReason(SESSION_ID)!;
        // Activity must be consistent with reason kind
        if (state.activity === 'permission') {
          expect(reason.kind).toBe('permission');
          expect(state.permissionPending).toBe(true);
        } else if (state.activity === 'idle') {
          expect(reason.kind).toBe('idle');
          // No counter holds, no permission, no turn
          expect(state.permissionPending).toBe(false);
          expect(state.turnActive).toBe(false);
          expect(state.subagentDepth).toBe(0);
          expect(state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount).toBe(0);
        } else {
          // thinking
          expect(['tool', 'subagent', 'background-shell', 'turn-active']).toContain(reason.kind);
          expect(state.permissionPending).toBe(false);
          // At least one signal must be holding
          const heldByCounter =
            state.turnActive
            || state.subagentDepth > 0
            || (state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount) > 0;
          expect(heldByCounter).toBe(true);
        }
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('repeated identical events do not corrupt state (compared to single event)', () => {
    fc.assert(
      fc.property(eventArb, fc.integer({ min: 2, max: 10 }), (event, repeats) => {
        // Skip events with side effects that genuinely accumulate
        // (ToolStart, SubagentStart, BackgroundShellStart). Repeating
        // those legitimately increments counters - not a bug.
        if (
          event.type === EventType.ToolStart
          || event.type === EventType.SubagentStart
          || event.type === EventType.BackgroundShellStart
        ) return;
        const { engine: e1 } = makeEngine();
        e1.initSession(SESSION_ID);
        e1.processEvent(SESSION_ID, event);
        const single = e1.getState(SESSION_ID)!.activity;
        e1.dispose();

        const { engine: e2 } = makeEngine();
        e2.initSession(SESSION_ID);
        for (let i = 0; i < repeats; i++) {
          e2.processEvent(SESSION_ID, event);
        }
        const repeated = e2.getState(SESSION_ID)!.activity;
        e2.dispose();

        expect(repeated).toBe(single);
      }),
      { numRuns: 100 },
    );
  });

  it('processEvent never throws for any legal event', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        const { engine } = makeEngine();
        engine.initSession(SESSION_ID);
        for (const event of events) {
          expect(() => engine.processEvent(SESSION_ID, event)).not.toThrow();
        }
        engine.dispose();
      }),
      { numRuns: 200 },
    );
  });

  it('multiple sessions are isolated', () => {
    fc.assert(
      fc.property(sequenceArb, sequenceArb, (eventsA, eventsB) => {
        const { engine } = makeEngine();
        engine.initSession('a');
        engine.initSession('b');
        // Interleave events
        const max = Math.max(eventsA.length, eventsB.length);
        for (let i = 0; i < max; i++) {
          if (i < eventsA.length) engine.processEvent('a', eventsA[i]);
          if (i < eventsB.length) engine.processEvent('b', eventsB[i]);
        }
        // Drive A through events alone (in a fresh engine) and compare
        const { engine: refA } = makeEngine();
        refA.initSession('a');
        for (const event of eventsA) refA.processEvent('a', event);

        const aFromInterleaved = engine.getState('a')!.activity;
        const aFromIsolated = refA.getState('a')!.activity;
        expect(aFromInterleaved).toBe(aFromIsolated);

        engine.dispose();
        refA.dispose();
      }),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Model-based invariant fuzzer
// ─────────────────────────────────────────────────────────────────────

/**
 * Triggers that legitimately produce a thinking → idle transition.
 * The `event:idle:*` and `event:bg-shell-ended:*` families use prefix
 * matching because their `:detail` suffix carries the IdleReason or
 * shell id. Using a fixed Set would either be incomplete (missing
 * future IdleReason values) or wrong (only matching the `:watcher`
 * variant of bg-shell-ended).
 */
const LEGAL_THINKING_TO_IDLE_EXACT = new Set([
  'interrupted',
  'force-idle',
  'timer:stability',
  'timer:bg-shell-hatch',
  'timer:stuck-pending-tools',
  'timer:stale-thinking',
]);

function isLegalThinkingToIdleTrigger(trigger: string): boolean {
  if (LEGAL_THINKING_TO_IDLE_EXACT.has(trigger)) return true;
  if (trigger === 'event:idle' || trigger.startsWith('event:idle:')) return true;
  if (trigger.startsWith('event:bg-shell-ended:')) return true;
  // An idle_hint (waiting-for-input notification) legitimately ends the turn
  // when no other holder remains. With a zero stability window it commits
  // immediately under this trigger; with a non-zero window it commits via
  // 'timer:stability' (already covered above).
  if (trigger === 'event:idle_hint' || trigger.startsWith('event:idle_hint:')) return true;
  return false;
}

const DESYNC_SEAM_TRIGGERS = new Set([
  'interrupted',
  'force-idle',
  'timer:stuck-pending-tools',
  'timer:stale-thinking',
]);

interface FuzzModel {
  openToolIds: string[];
  openShellIds: string[];
  openSubagents: number;
}

interface FuzzReal {
  engine: ActivityEngine;
  sessionId: string;
  previousCompensation: {
    staleThinking: number;
    bgShellHatch: number;
    stuckPendingTools: number;
    forceThinking: number;
    forceIdle: number;
    unmatchedBgShellEnd: number;
  };
}

type FuzzCommand = fc.Command<FuzzModel, FuzzReal>;

function checkInvariants(real: FuzzReal): void {
  const state = real.engine.getState(real.sessionId);
  if (!state) throw new Error('Engine state vanished mid-fuzz - dispose() must not have been called.');
  const snapshot = real.engine.getStatsSnapshot(real.sessionId);
  if (!snapshot) throw new Error('getStatsSnapshot returned null on a live session.');

  if (!['idle', 'thinking', 'permission'].includes(state.activity)) {
    throw new Error(`Illegal activity: ${state.activity}`);
  }

  let expectedActivity: ActivityState;
  if (state.permissionPending) {
    expectedActivity = 'permission';
  } else if (
    state.turnActive
    || state.subagentDepth > 0
    || state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount > 0
  ) {
    expectedActivity = 'thinking';
  } else {
    expectedActivity = 'idle';
  }
  if (state.pendingIdleAt === null && state.activity !== expectedActivity) {
    throw new Error(
      `Predicate mismatch: state.activity=${state.activity}, expected=${expectedActivity}, ` +
      `turnActive=${state.turnActive}, tools=${state.pendingToolCount}, ` +
      `subagents=${state.subagentDepth}, ` +
      `bgShells=${state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount}, ` +
      `permissionPending=${state.permissionPending}`,
    );
  }

  if (state.activity === 'idle' && !state.turnActive) {
    const total =
      state.pendingToolCount
      + state.subagentDepth
      + state.activeBackgroundShellIds.size
      + state.anonymousBackgroundShellCount;
    if (total !== 0) {
      throw new Error(
        `Idle invariant violation: idle+!turnActive but holders nonzero ` +
        `(tools=${state.pendingToolCount}, subagents=${state.subagentDepth}, ` +
        `bgShells=${state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount})`,
      );
    }
    if (state.permissionPending) {
      throw new Error('Idle invariant violation: idle but permissionPending=true');
    }
  }

  const lastTransition = [...snapshot.recentTransitions].reverse().find(
    (record) => record.from !== record.to,
  );
  if (lastTransition && lastTransition.from === 'thinking' && lastTransition.to === 'idle') {
    if (!isLegalThinkingToIdleTrigger(lastTransition.trigger)) {
      throw new Error(
        `Silent thinking → idle transition with illegal trigger: ${lastTransition.trigger}`,
      );
    }
  }

  const lastRingEntry = snapshot.recentTransitions[snapshot.recentTransitions.length - 1];
  const isDesyncSeam = lastRingEntry && DESYNC_SEAM_TRIGGERS.has(lastRingEntry.trigger);
  if (!isDesyncSeam && state.pendingToolStack.length !== state.pendingToolCount) {
    throw new Error(
      `Stack/count desync: stack.length=${state.pendingToolStack.length}, ` +
      `pendingToolCount=${state.pendingToolCount}, lastTrigger=${lastRingEntry?.trigger ?? '(none)'}`,
    );
  }

  const current = snapshot.compensationCounters;
  const previous = real.previousCompensation;
  for (const key of Object.keys(previous) as (keyof typeof previous)[]) {
    if (current[key] < previous[key]) {
      throw new Error(
        `Compensation counter ${key} decremented: ${previous[key]} → ${current[key]}`,
      );
    }
  }
  real.previousCompensation = { ...current };
}

class ToolStartCommand implements FuzzCommand {
  constructor(private name: string, private id: string) {}
  check = () => true;
  run(model: FuzzModel, real: FuzzReal): void {
    real.engine.processEvent(real.sessionId, {
      ts: Date.now(),
      type: EventType.ToolStart,
      tool: this.name,
      detail: this.id,
    });
    model.openToolIds.push(this.id);
    checkInvariants(real);
  }
  toString = (): string => `ToolStart(${this.name},${this.id})`;
}

class ToolEndCommand implements FuzzCommand {
  constructor(private idIndex: number) {}
  check = (model: Readonly<FuzzModel>): boolean => model.openToolIds.length > 0;
  run(model: FuzzModel, real: FuzzReal): void {
    const index = this.idIndex % model.openToolIds.length;
    const toolId = model.openToolIds[index];
    real.engine.processEvent(real.sessionId, {
      ts: Date.now(),
      type: EventType.ToolEnd,
      detail: toolId,
    });
    model.openToolIds.splice(index, 1);
    checkInvariants(real);
  }
  toString = (): string => `ToolEnd(idx=${this.idIndex})`;
}

class SubagentStartCommand implements FuzzCommand {
  check = () => true;
  run(model: FuzzModel, real: FuzzReal): void {
    real.engine.processEvent(real.sessionId, { ts: Date.now(), type: EventType.SubagentStart });
    model.openSubagents += 1;
    checkInvariants(real);
  }
  toString = (): string => 'SubagentStart';
}

class SubagentStopCommand implements FuzzCommand {
  check = (model: Readonly<FuzzModel>): boolean => model.openSubagents > 0;
  run(model: FuzzModel, real: FuzzReal): void {
    real.engine.processEvent(real.sessionId, { ts: Date.now(), type: EventType.SubagentStop });
    model.openSubagents -= 1;
    checkInvariants(real);
  }
  toString = (): string => 'SubagentStop';
}

class BackgroundShellStartCommand implements FuzzCommand {
  constructor(private id: string) {}
  check = () => true;
  run(model: FuzzModel, real: FuzzReal): void {
    real.engine.processEvent(real.sessionId, {
      ts: Date.now(),
      type: EventType.BackgroundShellStart,
      detail: this.id,
    });
    model.openShellIds.push(this.id);
    checkInvariants(real);
  }
  toString = (): string => `BackgroundShellStart(${this.id})`;
}

class BackgroundShellEndCommand implements FuzzCommand {
  constructor(private idIndex: number) {}
  check = (model: Readonly<FuzzModel>): boolean => model.openShellIds.length > 0;
  run(model: FuzzModel, real: FuzzReal): void {
    const index = this.idIndex % model.openShellIds.length;
    const shellId = model.openShellIds[index];
    real.engine.processEvent(real.sessionId, {
      ts: Date.now(),
      type: EventType.BackgroundShellEnd,
      detail: shellId,
    });
    model.openShellIds.splice(index, 1);
    checkInvariants(real);
  }
  toString = (): string => `BackgroundShellEnd(idx=${this.idIndex})`;
}

class PromptCommand implements FuzzCommand {
  check = () => true;
  run(_model: FuzzModel, real: FuzzReal): void {
    real.engine.processEvent(real.sessionId, { ts: Date.now(), type: EventType.Prompt });
    checkInvariants(real);
  }
  toString = (): string => 'Prompt';
}

class IdleCommand implements FuzzCommand {
  constructor(private detail?: IdleReason) {}
  check = () => true;
  run(model: FuzzModel, real: FuzzReal): void {
    real.engine.processEvent(real.sessionId, {
      ts: Date.now(),
      type: EventType.Idle,
      detail: this.detail,
    });
    if (this.detail !== IdleReason.Permission) {
      model.openToolIds.length = 0;
    }
    checkInvariants(real);
  }
  toString = (): string => `Idle(${this.detail ?? '-'})`;
}

class IdleHintCommand implements FuzzCommand {
  check = () => true;
  run(_model: FuzzModel, real: FuzzReal): void {
    // idle_hint conditionally ends the turn (only when no other holder
    // remains). It never mutates tool/subagent/shell counts, so the model's
    // open-* tracking is unaffected; checkInvariants derives the expected
    // activity from the real engine state, not the model.
    real.engine.processEvent(real.sessionId, {
      ts: Date.now(),
      type: EventType.IdleHint,
      detail: 'Claude is waiting for your input',
    });
    checkInvariants(real);
  }
  toString = (): string => 'IdleHint';
}

class InterruptedCommand implements FuzzCommand {
  check = () => true;
  run(model: FuzzModel, real: FuzzReal): void {
    real.engine.processEvent(real.sessionId, { ts: Date.now(), type: EventType.Interrupted });
    model.openToolIds.length = 0;
    model.openShellIds.length = 0;
    model.openSubagents = 0;
    checkInvariants(real);
  }
  toString = (): string => 'Interrupted';
}

class ForceThinkingCommand implements FuzzCommand {
  check = () => true;
  run(_model: FuzzModel, real: FuzzReal): void {
    real.engine.forceThinking(real.sessionId);
    checkInvariants(real);
  }
  toString = (): string => 'forceThinking';
}

class ForceIdleCommand implements FuzzCommand {
  check = () => true;
  run(model: FuzzModel, real: FuzzReal): void {
    real.engine.forceIdle(real.sessionId);
    model.openToolIds.length = 0;
    model.openShellIds.length = 0;
    model.openSubagents = 0;
    checkInvariants(real);
  }
  toString = (): string => 'forceIdle';
}

class AdvanceTimeCommand implements FuzzCommand {
  constructor(private deltaMs: number) {}
  check = () => true;
  run(model: FuzzModel, real: FuzzReal): void {
    vi.advanceTimersByTime(this.deltaMs);
    const state = real.engine.getState(real.sessionId);
    if (state) {
      if (state.pendingToolCount === 0 && model.openToolIds.length > 0) {
        model.openToolIds.length = 0;
      }
      const totalShells = state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount;
      if (totalShells === 0 && model.openShellIds.length > 0) {
        model.openShellIds.length = 0;
      }
      if (state.subagentDepth === 0 && model.openSubagents > 0) {
        model.openSubagents = 0;
      }
    }
    checkInvariants(real);
  }
  toString = (): string => `AdvanceTime(${this.deltaMs}ms)`;
}

const TOOL_NAMES = ['Bash', 'Read', 'Edit', 'Glob', 'Grep'];

const fuzzCommandArbs: fc.Arbitrary<FuzzCommand>[] = [
  fc.tuple(fc.constantFrom(...TOOL_NAMES), fc.integer({ min: 0, max: 999 }))
    .map(([name, id]) => new ToolStartCommand(name, `tool_${id}`)),
  fc.integer({ min: 0, max: 99 }).map((idx) => new ToolEndCommand(idx)),
  fc.constant(new SubagentStartCommand()),
  fc.constant(new SubagentStopCommand()),
  fc.integer({ min: 0, max: 999 }).map((id) => new BackgroundShellStartCommand(`bash_${id}`)),
  fc.integer({ min: 0, max: 99 }).map((idx) => new BackgroundShellEndCommand(idx)),
  fc.constant(new PromptCommand()),
  fc.oneof(
    fc.constant(new IdleCommand()),
    fc.constant(new IdleCommand(IdleReason.Permission)),
    fc.constant(new IdleCommand(IdleReason.NaturalExit)),
  ),
  fc.constant(new IdleHintCommand()),
  fc.constant(new InterruptedCommand()),
  fc.constant(new ForceThinkingCommand()),
  fc.constant(new ForceIdleCommand()),
  fc.constantFrom(50, 200, 500, 5_000, 200_000).map((ms) => new AdvanceTimeCommand(ms)),
];

describe('ActivityEngine invariants (model-based)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('all invariants hold across legal command sequences', () => {
    fc.assert(
      fc.property(fc.commands(fuzzCommandArbs, { maxCommands: 60 }), (commands) => {
        vi.setSystemTime(1_700_000_000_000);
        const setup = () => {
          const sessionId = 'fuzz-session';
          const engine = new ActivityEngine({ onActivityChange: () => {} }, {});
          engine.initSession(sessionId);
          return {
            model: { openToolIds: [], openShellIds: [], openSubagents: 0 },
            real: {
              engine,
              sessionId,
              previousCompensation: {
                staleThinking: 0,
                bgShellHatch: 0,
                stuckPendingTools: 0,
                forceThinking: 0,
                forceIdle: 0,
                unmatchedBgShellEnd: 0,
              },
            },
          };
        };
        fc.modelRun(setup, commands);
      }),
      { numRuns: 200 },
    );
  });
});
