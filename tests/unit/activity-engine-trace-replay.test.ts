/**
 * Trace-bundle replay tests: drive captured 4-stream traces (events,
 * status deltas, PTY chunks, recent-transitions snapshot) through the
 * activity engine in fixture-time and assert the resulting transition
 * log against a golden file.
 *
 * Bundles are produced by the `kangentic_devtools_capture_trace` MCP
 * tool. The bundle layout under `tests/fixtures/replay/<name>/`:
 *
 *   events.jsonl          - SessionEvent[] from the engine's input
 *   status-deltas.jsonl   - {ts, model, inputTokens, outputTokens}[]
 *   pty-chunks.jsonl      - {ts, length}[]
 *   transitions.json      - ActivityStatsSnapshot at capture time
 *   meta.json             - {capturedAt, sessionId, kangenticVersion, ...}
 *   expected-transitions.json - golden TransitionRecord[] (regenerable)
 *
 * Regenerate the golden file by setting `UPDATE_GOLDENS=1` in the env.
 *
 * The harness mirrors SessionTelemetry's heartbeat-recovery logic
 * inline so we exercise the engine WITHOUT pulling in the full session
 * orchestrator (PtyTracker, BgShellWatcher, idle-timeout interval, ...).
 * If SessionTelemetry's heartbeat rule changes, update applyStatusDelta
 * below to match.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import type { TransitionRecord, ActivityStatsSnapshot } from '../../src/main/activity-engine/engine';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'replay');
const SESSION_ID = 'replay-session';

interface StatusDelta {
  ts: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

interface PtyChunk {
  ts: number;
  length: number;
}

interface TraceBundle {
  events: SessionEvent[];
  statusDeltas: StatusDelta[];
  ptyChunks: PtyChunk[];
  meta: { sessionId: string; capturedAt?: string };
}

interface TimedItem {
  ts: number;
  kind: 'event' | 'status' | 'pty';
  payload: SessionEvent | StatusDelta | PtyChunk;
}

interface ReplayResult {
  transitions: TransitionRecord[];
  finalActivity: ActivityState;
  /**
   * Monotonic compensation counters at the end of replay. The watchdog
   * hatches commit their idle THROUGH the stability window, so the committed
   * transition carries the `timer:stability` trigger, not the hatch's own -
   * these counters are the reliable signal that a hatch actually fired.
   */
  compensationCounters: ActivityStatsSnapshot['compensationCounters'];
}

function loadJsonlMaybe<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

export function loadTraceBundle(directory: string): TraceBundle {
  const eventsPath = path.join(directory, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`Trace bundle missing events.jsonl: ${directory}`);
  }
  const events = loadJsonlMaybe<SessionEvent>(eventsPath);
  const statusDeltas = loadJsonlMaybe<StatusDelta>(path.join(directory, 'status-deltas.jsonl'));
  const ptyChunks = loadJsonlMaybe<PtyChunk>(path.join(directory, 'pty-chunks.jsonl'));
  const metaPath = path.join(directory, 'meta.json');
  const meta = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as TraceBundle['meta'])
    : { sessionId: SESSION_ID };
  return { events, statusDeltas, ptyChunks, meta };
}

function mergeStreams(bundle: TraceBundle): TimedItem[] {
  const merged: TimedItem[] = [];
  for (const event of bundle.events) merged.push({ ts: event.ts, kind: 'event', payload: event });
  for (const delta of bundle.statusDeltas) merged.push({ ts: delta.ts, kind: 'status', payload: delta });
  for (const chunk of bundle.ptyChunks) merged.push({ ts: chunk.ts, kind: 'pty', payload: chunk });
  // Sort stably so events that share a ts retain relative order. Within
  // a tie, prefer 'event' first (the most semantically meaningful), then
  // 'status' (heartbeat), then 'pty' (chunk arrival).
  const kindOrder: Record<TimedItem['kind'], number> = { event: 0, status: 1, pty: 2 };
  merged.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : kindOrder[a.kind] - kindOrder[b.kind]));
  return merged;
}

/**
 * Mirrors `SessionTelemetry.processStatusUpdate`: status updates that
 * see the engine in 'thinking' reset lastSignalAt; status updates that
 * see the engine 'idle' for >1s with OUTPUT-token growth force-recover to
 * thinking. Output only, never input: Claude's input total is context-window
 * occupancy that climbs while parked with no generation (see the production
 * comment). If the production rule changes, update this function.
 */
function applyStatusDelta(
  engine: ActivityEngine,
  sessionId: string,
  current: StatusDelta,
  previous: StatusDelta | null,
): void {
  const state = engine.getState(sessionId);
  if (!state) return;
  if (state.activity === 'thinking') {
    engine.markThinkingSignal(sessionId);
    return;
  }
  if (state.activity === 'idle' && previous) {
    const idleStart = state.idleTimestamp;
    if (current.outputTokens > previous.outputTokens && idleStart && Date.now() - idleStart > 1000) {
      engine.forceThinking(sessionId);
    }
  }
}

export function replayBundle(bundle: TraceBundle): ReplayResult {
  const merged = mergeStreams(bundle);
  if (merged.length === 0) {
    return { transitions: [], finalActivity: 'idle' };
  }

  vi.setSystemTime(merged[0].ts);

  const engine = new ActivityEngine(
    {
      onActivityChange: () => {
        // Transition records are inspected via getStatsSnapshot below;
        // no callback bookkeeping needed here.
      },
    },
    {
      // Faithful production timing - the whole point of trace replay
      // is to verify the engine under real-world thresholds.
    },
  );
  const sessionId = bundle.meta.sessionId || SESSION_ID;
  engine.initSession(sessionId);

  let previousStatus: StatusDelta | null = null;
  let previousTs = merged[0].ts;

  for (const item of merged) {
    const advance = item.ts - previousTs;
    if (advance > 0) {
      vi.advanceTimersByTime(advance);
    }
    previousTs = item.ts;

    if (item.kind === 'event') {
      engine.processEvent(sessionId, item.payload as SessionEvent);
    } else if (item.kind === 'status') {
      const delta = item.payload as StatusDelta;
      applyStatusDelta(engine, sessionId, delta, previousStatus);
      previousStatus = delta;
    } else if (item.kind === 'pty') {
      // Production-faithful: for hooks-based agents (Claude) the
      // PtyActivityTracker is suppressed, so PTY data does NOT act as a
      // generic thinking signal (markThinkingSignal). It DOES refresh the
      // stuck-pending-tools watchdog base via markPtyOutput, which the spawn
      // flow calls unconditionally on every chunk. This is what keeps a long
      // quiet foreground test run from being force-idled.
      engine.markPtyOutput(sessionId);
    }
  }

  // Drain pending timers (stability-window idle, watchdog deadlines)
  // so the final state reflects what production would observe after a
  // brief tail. Cap at 60 seconds to keep the harness bounded.
  vi.advanceTimersByTime(60_000);

  const snapshot = engine.getStatsSnapshot(sessionId);
  const transitions: TransitionRecord[] = snapshot ? [...snapshot.recentTransitions] : [];
  const finalActivity = snapshot?.activity ?? 'idle';
  const compensationCounters = snapshot
    ? { ...snapshot.compensationCounters }
    : { staleThinking: 0, bgShellHatch: 0, stuckPendingTools: 0, forceThinking: 0, forceIdle: 0, unmatchedBgShellEnd: 0 };
  engine.dispose();
  return { transitions, finalActivity, compensationCounters };
}

function assertGoldenTransitions(directory: string, transitions: TransitionRecord[]): void {
  const goldenPath = path.join(directory, 'expected-transitions.json');
  const portable = transitions.map(({ from, to, trigger, reasonKind, counterDelta }) => ({
    from,
    to,
    trigger,
    reasonKind,
    ...(counterDelta ? { counterDelta } : {}),
  }));
  if (process.env.UPDATE_GOLDENS === '1') {
    fs.writeFileSync(goldenPath, JSON.stringify(portable, null, 2));
    return;
  }
  if (!fs.existsSync(goldenPath)) {
    throw new Error(
      `Golden file not found: ${goldenPath}. Run with UPDATE_GOLDENS=1 to create it.`,
    );
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf-8')) as unknown[];
  expect(portable).toEqual(golden);
}

describe('ActivityEngine trace-bundle replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loadTraceBundle handles a synthetic bundle', () => {
    const baseTs = 1_700_000_000_000;
    const bundle: TraceBundle = {
      events: [
        { ts: baseTs, type: 'session_start' as SessionEvent['type'] },
        { ts: baseTs + 100, type: 'prompt' as SessionEvent['type'] },
        { ts: baseTs + 200, type: 'idle' as SessionEvent['type'] },
      ],
      statusDeltas: [
        { ts: baseTs + 50, inputTokens: 10, outputTokens: 5 },
        { ts: baseTs + 150, inputTokens: 20, outputTokens: 10 },
      ],
      ptyChunks: [
        { ts: baseTs + 75, length: 42 },
        { ts: baseTs + 175, length: 100 },
      ],
      meta: { sessionId: SESSION_ID },
    };
    const result = replayBundle(bundle);
    expect(result.finalActivity).toBe('idle');
  });

  it('mergeStreams sorts by ts with stable tie-break', () => {
    const baseTs = 1_700_000_000_000;
    const bundle: TraceBundle = {
      events: [{ ts: baseTs, type: 'prompt' as SessionEvent['type'] }],
      statusDeltas: [{ ts: baseTs, inputTokens: 1, outputTokens: 1 }],
      ptyChunks: [{ ts: baseTs, length: 10 }],
      meta: { sessionId: SESSION_ID },
    };
    const merged = mergeStreams(bundle);
    expect(merged.map((item) => item.kind)).toEqual(['event', 'status', 'pty']);
  });

  // Pins the applyStatusDelta OUTPUT-only mirror. The session starts idle;
  // two status deltas arrive 2s apart with a growing input total but frozen
  // output total. The grace (>1000ms) is satisfied, so the only guard
  // keeping the engine idle is the output-only comparison. If applyStatusDelta
  // were reverted to the summed-token check, the second delta would compute
  // 5000+50=5050 > 100+50=150, calling engine.forceThinking and producing
  // finalActivity 'thinking' - causing this test to fail (red confirmed).
  it('heartbeat recovery: does NOT force-think when input grows but output is frozen across >1s idle', () => {
    const baseTs = 1_700_000_000_000;
    const bundle: TraceBundle = {
      events: [],
      statusDeltas: [
        { ts: baseTs, inputTokens: 100, outputTokens: 50 },
        { ts: baseTs + 2000, inputTokens: 5000, outputTokens: 50 }, // input grew, output frozen
      ],
      ptyChunks: [],
      meta: { sessionId: SESSION_ID },
    };
    const result = replayBundle(bundle);
    expect(result.finalActivity).toBe('idle');
  });

  // Real capture of bug B (task #210): a long quiet foreground
  // `npx playwright test` (single PowerShell call, no nested hook events,
  // ~466s) ran while the status heartbeat was silent for 638s. Pre-fix the
  // 5-min stuck-pending-tools hatch force-idled it mid-run; post-fix the
  // streaming PTY output (markPtyOutput) keeps the base fresh so the hatch
  // never fires while the tool is genuinely running.
  describe('session-013-stuck-foreground-e2e', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const bundle = loadTraceBundle(path.join(FIXTURES_DIR, 'session-013-stuck-foreground-e2e'));
      result = replayBundle(bundle);
    });

    it('does not fire the stuck-pending-tools hatch while the foreground test streams output', () => {
      // The hatch commits its idle through the stability window, so the
      // compensation counter (not the transition trigger) is the reliable
      // signal. Pre-fix this is 1 (force-idled mid-run); post-fix it is 0.
      expect(result.compensationCounters.stuckPendingTools).toBe(0);
    });

    it('settles idle after the agent finishes (last turn ended cleanly)', () => {
      expect(result.finalActivity).toBe('idle');
    });
  });

  // Reconstruction of task #229 (session c13bcda7): a single foreground
  // `npx playwright test --project=ui` runs 273s (longer than the 180s
  // stale-thinking timeout) with PTY streaming but no nested hook events and a
  // silent status heartbeat, then ENDS while the turn continues (the agent
  // analyzes output and calls its next tool ~20s later). Because tool_end now
  // refreshes lastSignalAt (it is NOT log-only), the stale-thinking hold gets a
  // fresh anchor at the hand-off instead of the frozen tool_start one, so the
  // post-tool thinking gap is not force-idled. Pre-fix (ToolEnd back in
  // LOG_ONLY_EVENTS) the stale-thinking watchdog fires the instant the tool
  // ends, flashing the card idle until force-thinking recovers it ~13s later.
  describe('session-016-false-idle-after-long-foreground-tool', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const bundle = loadTraceBundle(
        path.join(FIXTURES_DIR, 'session-016-false-idle-after-long-foreground-tool'),
      );
      result = replayBundle(bundle);
    });

    it('does not fire the stale-thinking watchdog when the long tool ends and the turn continues', () => {
      // The reliable signal: pre-fix this is 1 (false idle at the hand-off),
      // post-fix it is 0 (the refreshed anchor gives a fresh 180s budget).
      expect(result.compensationCounters.staleThinking).toBe(0);
    });

    it('records no thinking -> idle stale-thinking transition mid-stream', () => {
      const staleIdles = result.transitions.filter(
        (transition) =>
          transition.from === 'thinking'
          && transition.to === 'idle'
          && transition.trigger === 'timer:stale-thinking',
      );
      expect(staleIdles).toEqual([]);
    });

    it('settles idle after the real turn ends (clean Stop)', () => {
      expect(result.finalActivity).toBe('idle');
    });
  });

  // Reconstruction of task #246 (session d7b0125a): a single heavy generation
  // turn streamed PTY output for 211s between a completed Read (pasted image)
  // and the next Write, with NO nested hook event and a silent status heartbeat.
  // This is the tool-less sibling of session-016: pendingToolCount === 0 the
  // whole gap, so the stuck-pending-tools hold cannot help and (pre-fix) the
  // stale-thinking hold - anchored to lastSignalAt only - force-idled the live
  // session at +180s. The fix anchors stale-thinking to signal-or-pty-output, so
  // the streaming chunks (markPtyOutput) keep it thinking. Pre-fix (anchor:
  // 'signal') this replays a timer:stale-thinking thinking->idle mid-gap with
  // staleThinking: 1.
  describe('session-019-false-idle-tool-less-streaming-gap', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const bundle = loadTraceBundle(
        path.join(FIXTURES_DIR, 'session-019-false-idle-tool-less-streaming-gap'),
      );
      result = replayBundle(bundle);
    });

    it('does not fire the stale-thinking watchdog while the tool-less turn streams output', () => {
      // The reliable signal: pre-fix this is 1 (force-idled mid-gap), post-fix 0
      // (streaming PTY keeps the signal-or-pty-output anchor fresh).
      expect(result.compensationCounters.staleThinking).toBe(0);
    });

    it('records no thinking -> idle stale-thinking transition mid-stream', () => {
      const staleIdles = result.transitions.filter(
        (transition) =>
          transition.from === 'thinking'
          && transition.to === 'idle'
          && transition.trigger === 'timer:stale-thinking',
      );
      expect(staleIdles).toEqual([]);
    });

    it('settles idle after the real turn ends (clean Stop)', () => {
      expect(result.finalActivity).toBe('idle');
    });
  });

  // Concrete regression fixture for Task #121 (plan-composition gap).
  // Skipped until the bundle has been captured via
  // `kangentic_devtools_capture_trace`. Drop the .skip when the fixture
  // is populated (see tests/fixtures/replay/task-121-plan-composition/).
  describe.skip('task-121-plan-composition', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const bundle = loadTraceBundle(path.join(FIXTURES_DIR, 'task-121-plan-composition'));
      result = replayBundle(bundle);
    });

    it('does not fire timer:stale-thinking across the 189s thinking window', () => {
      const staleThinking = result.transitions.filter(
        (transition) => transition.trigger === 'timer:stale-thinking',
      );
      expect(staleThinking).toEqual([]);
    });

    it('matches the golden transition log', () => {
      assertGoldenTransitions(
        path.join(FIXTURES_DIR, 'task-121-plan-composition'),
        result.transitions,
      );
    });
  });
});
