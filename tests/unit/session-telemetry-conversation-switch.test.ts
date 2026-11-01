/**
 * The status channel follows a new agent session id only after a SessionStart
 * hook that moves the conversation named it (`ConversationSwitchGate`).
 *
 * Every process started with a session's `--settings` runs Kangentic's
 * statusLine into that session's one status.json. Claude Code 2.1.316 moved a
 * live task into its background daemon, which started two sessions with the
 * task's settings: the moved conversation (SessionStart `fork`) and an empty
 * spare (SessionStart `startup`, cost 0, no transcript). Their writes
 * alternated about 0.6 s apart on each 10 s refresh, and the change-sensitive
 * capture read every alternation as a /clear: a "Conversation moved" toast, a
 * resume-id rewrite, and the spare's zeros on the context bar, twice every 10 s.
 *
 * Driven with the real Claude adapter, so its own `parseSessionStart` reads
 * the hook payloads. Adapters without that capability keep the old behavior
 * (pinned in session-telemetry-agent-session-id-gate.test.ts).
 *
 * Test tier: Unit (vitest, no Electron, no processes).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { ActivityDetection } from '../../src/shared/types';
import type { AgentParser, SessionUsage } from '../../src/shared/types';
import { claudeSessionStartLine } from './helpers/claude-session-start';

const ORIGINAL = '206fcc54-ddb8-497b-9d57-a0f6defcced9';
const MOVED = '58bd8a86-0d47-4861-8449-63202d8e6a43';
const SPARE = '9dfc0083-eb3a-4c38-bb6c-c4d991525d2b';
const CLEARED = '7f3e1c2a-1b4d-4e5f-8a9b-0c1d2e3f4a5b';

interface EmittedUsage {
  agentSessionId: string | undefined;
  totalCostUsd: number;
  totalOutputTokens: number;
}

interface Harness {
  telemetry: SessionTelemetry;
  capturedIds: string[];
  emittedUsage: EmittedUsage[];
}

function makeHarness(
  confirmsBackgroundMove?: (sessionId: string, fromAgentSessionId: string, toAgentSessionId: string) => Promise<boolean>,
): Harness {
  const capturedIds: string[] = [];
  const emittedUsage: EmittedUsage[] = [];
  const telemetry = new SessionTelemetry(
    {
      ...(confirmsBackgroundMove ? { confirmsBackgroundMove } : {}),
      onUsageChange: (_sessionId, usage) => {
        emittedUsage.push({
          agentSessionId: usage.sessionId,
          totalCostUsd: usage.cost.totalCostUsd,
          totalOutputTokens: usage.contextWindow.totalOutputTokens,
        });
      },
      onActivityChange: () => {},
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      onAgentSessionId: (_sessionId, agentReportedId) => {
        capturedIds.push(agentReportedId);
      },
      requestSuspend: () => {},
      isSessionRunning: () => true,
    },
    { disableBgShellWatcher: true },
  );
  return { telemetry, capturedIds, emittedUsage };
}

function statusUsage(agentSessionId: string, totalCostUsd: number, totalOutputTokens: number): SessionUsage {
  return {
    sessionId: agentSessionId,
    contextWindow: {
      usedPercentage: totalCostUsd > 0 ? 40 : 0,
      usedTokens: totalCostUsd > 0 ? 400_000 : 0,
      cacheTokens: 0,
      totalInputTokens: totalCostUsd > 0 ? 400_000 : 0,
      totalOutputTokens,
      contextWindowSize: 1_000_000,
    },
    cost: { totalCostUsd, totalDurationMs: 1_000 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  };
}

/** The conversation's write, and the empty spare's. */
const conversation = (agentSessionId: string, outputTokens = 200): SessionUsage => statusUsage(agentSessionId, 51.58, outputTokens);
const spare = (): SessionUsage => statusUsage(SPARE, 0, 0);

describe('SessionTelemetry: a status id change needs a SessionStart that moved the conversation', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = makeHarness();
    harness.telemetry.initSession('s1', new ClaudeAdapter());
  });

  afterEach(() => {
    harness.telemetry.dispose();
    vi.useRealTimers();
  });

  it('two writers on one status file: one switch, no flip back, and none of the spare usage', () => {
    const { telemetry, capturedIds, emittedUsage } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    // The daemon's two SessionStart hooks, spare first, as recorded live.
    telemetry.noteSessionStartHooks('s1', [
      claudeSessionStartLine(SPARE, 'startup'),
      claudeSessionStartLine(MOVED, 'fork'),
    ]);

    for (let refresh = 0; refresh < 4; refresh++) {
      telemetry.processStatusUpdate('s1', conversation(MOVED));
      telemetry.processStatusUpdate('s1', spare());
    }
    // The original conversation's writer is gone, but a late write of it is
    // no reason to go back.
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));

    expect(capturedIds).toEqual([ORIGINAL, MOVED]);
    expect(emittedUsage.map((usage) => usage.agentSessionId)).toEqual([ORIGINAL, MOVED, MOVED, MOVED, MOVED]);
    expect(emittedUsage.some((usage) => usage.totalCostUsd === 0)).toBe(false);
    expect(telemetry.getUsageCache()['s1'].sessionId).toBe(MOVED);
  });

  it('a status write that lands before its hook is held, then applied when the hook arrives', () => {
    const { telemetry, capturedIds, emittedUsage } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.processStatusUpdate('s1', conversation(MOVED, 300));
    expect(capturedIds).toEqual([ORIGINAL]);
    expect(emittedUsage).toHaveLength(1);

    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);

    expect(capturedIds).toEqual([ORIGINAL, MOVED]);
    expect(emittedUsage).toHaveLength(2);
    expect(emittedUsage[1]).toEqual({ agentSessionId: MOVED, totalCostUsd: 51.58, totalOutputTokens: 300 });
  });

  it('/clear still switches, and the new conversation sets a fresh heartbeat baseline', () => {
    const { telemetry, capturedIds } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 50));
    vi.advanceTimersByTime(1_500);
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(CLEARED, 'clear')]);
    telemetry.processStatusUpdate('s1', conversation(CLEARED, 4_000));
    expect(capturedIds).toEqual([ORIGINAL, CLEARED]);
    // 50 -> 4000 is two conversations' totals, not growth.
    expect(telemetry.getActivityCache()['s1']).toBe('idle');
    // The cleared conversation's own growth counts once it is the baseline.
    vi.advanceTimersByTime(1_500);
    telemetry.processStatusUpdate('s1', conversation(CLEARED, 4_400));
    expect(telemetry.getActivityCache()['s1']).toBe('thinking');
  });

  it("a hook naming the current id leaves nothing that could carry a stale writer back", () => {
    const { telemetry, capturedIds } = harness;
    // The spawn's own resume hook, before the first status write.
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(ORIGINAL, 'resume')]);
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    // A compaction names the current id again.
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(ORIGINAL, 'compact')]);
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);
    telemetry.processStatusUpdate('s1', conversation(MOVED));
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.processStatusUpdate('s1', conversation(MOVED));
    expect(capturedIds).toEqual([ORIGINAL, MOVED]);
  });

  it('a new SessionStart naming a replaced id brings it back, as an in-terminal /resume does', () => {
    const { telemetry, capturedIds, emittedUsage } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);
    telemetry.processStatusUpdate('s1', conversation(MOVED));
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 120));
    expect(capturedIds).toEqual([ORIGINAL, MOVED]);

    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(ORIGINAL, 'resume')]);
    expect(capturedIds).toEqual([ORIGINAL, MOVED, ORIGINAL]);
    expect(emittedUsage.at(-1)).toEqual({ agentSessionId: ORIGINAL, totalCostUsd: 51.58, totalOutputTokens: 120 });
  });

  it('two quick moves: the later one wins, and a late write of the earlier one is not adopted', () => {
    const { telemetry, capturedIds } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    // A /resume choice, then a /clear right after it.
    telemetry.noteSessionStartHooks('s1', [
      claudeSessionStartLine(MOVED, 'resume'),
      claudeSessionStartLine(CLEARED, 'clear'),
    ]);
    telemetry.processStatusUpdate('s1', conversation(CLEARED));
    telemetry.processStatusUpdate('s1', conversation(MOVED));
    expect(capturedIds).toEqual([ORIGINAL, CLEARED]);
  });

  it('two quick moves whose writes land in order both switch', () => {
    const { telemetry, capturedIds } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.noteSessionStartHooks('s1', [
      claudeSessionStartLine(MOVED, 'resume'),
      claudeSessionStartLine(CLEARED, 'clear'),
    ]);
    telemetry.processStatusUpdate('s1', conversation(MOVED));
    telemetry.processStatusUpdate('s1', conversation(CLEARED));
    expect(capturedIds).toEqual([ORIGINAL, MOVED, CLEARED]);
  });

  it("the first id-bearing write is the baseline with no hook, whatever the spawn's own hook named", () => {
    const { telemetry, capturedIds } = harness;
    // A --resume that silently started fresh: a startup hook for a new id,
    // which is still the conversation to follow (stale-id recovery).
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(SPARE, 'startup')]);
    telemetry.processStatusUpdate('s1', conversation(CLEARED));
    expect(capturedIds).toEqual([CLEARED]);
  });

  it('a startup hook confirms nothing, and lines that are not a SessionStart are skipped', () => {
    const { telemetry, capturedIds } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.noteSessionStartHooks('s1', [
      claudeSessionStartLine(SPARE, 'startup'),
      JSON.stringify({ ts: 2, type: 'tool_start', tool: 'Bash', hookContext: '{"session_id":"x","source":"fork"}' }),
      'not json',
    ]);
    telemetry.processStatusUpdate('s1', spare());
    telemetry.processStatusUpdate('s1', statusUsage('x', 1, 1));
    expect(capturedIds).toEqual([ORIGINAL]);
  });

  it('removeSession forgets the hooks it had seen', () => {
    const { telemetry, capturedIds } = harness;
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);
    telemetry.removeSession('s1');
    telemetry.initSession('s1', new ClaudeAdapter());
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.processStatusUpdate('s1', conversation(MOVED));
    expect(capturedIds).toEqual([ORIGINAL, ORIGINAL]);
  });
});

// Claude Code's /bg moves the conversation into a background session and its
// /fork starts a copy there while the terminal keeps the original; both fire a
// SessionStart with source `fork`, with identical fields (measured on 2.1.316).
// Only a move ends the old transcript with `continued-in`, which the adapter
// checks (`statusFile.confirmsBackgroundMove`, through the session manager).
describe('SessionTelemetry: a background session\'s hook switches only once the move is proven', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a /fork copy never takes the terminal\'s place, however often it writes', async () => {
    vi.useFakeTimers();
    const confirmsBackgroundMove = vi.fn(async () => false);
    const { telemetry, capturedIds, emittedUsage } = makeHarness(confirmsBackgroundMove);
    telemetry.initSession('s1', new ClaudeAdapter());
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));

    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);
    for (let refresh = 0; refresh < 3; refresh++) {
      telemetry.processStatusUpdate('s1', statusUsage(MOVED, 0.1, 5));
      telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 110 + refresh));
    }
    await vi.advanceTimersByTimeAsync(6_000);

    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(3);
    expect(confirmsBackgroundMove).toHaveBeenCalledWith('s1', ORIGINAL, MOVED);
    expect(capturedIds).toEqual([ORIGINAL]);
    expect(emittedUsage.every((usage) => usage.agentSessionId === ORIGINAL)).toBe(true);
    telemetry.dispose();
  });

  it('a /bg move switches once proven, on a later check, and applies the write it held', async () => {
    vi.useFakeTimers();
    const confirmsBackgroundMove = vi.fn<(sessionId: string, from: string, to: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { telemetry, capturedIds, emittedUsage } = makeHarness(confirmsBackgroundMove);
    telemetry.initSession('s1', new ClaudeAdapter());
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));

    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);
    telemetry.processStatusUpdate('s1', conversation(MOVED, 300));
    await vi.advanceTimersByTimeAsync(0);
    expect(capturedIds).toEqual([ORIGINAL]);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(capturedIds).toEqual([ORIGINAL, MOVED]);
    expect(emittedUsage.at(-1)).toEqual({ agentSessionId: MOVED, totalCostUsd: 51.58, totalOutputTokens: 300 });
    telemetry.dispose();
  });

  it('asks nothing for a hook that is not a background session\'s, such as /clear', () => {
    const confirmsBackgroundMove = vi.fn(async () => false);
    const { telemetry, capturedIds } = makeHarness(confirmsBackgroundMove);
    telemetry.initSession('s1', new ClaudeAdapter());
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(CLEARED, 'clear')]);
    telemetry.processStatusUpdate('s1', conversation(CLEARED));
    expect(confirmsBackgroundMove).not.toHaveBeenCalled();
    expect(capturedIds).toEqual([ORIGINAL, CLEARED]);
    telemetry.dispose();
  });
});

// The CLI's record of a /bg move can land after the background session's hook,
// so a check that says no is asked again. The delays are OFFSETS from the hook
// (at once, then 1.5, 4, 10 and 30 s after it), not gaps between one ask and the
// next, and the checks stop as soon as the session is gone, has followed another
// id, or the move is proven.
describe('SessionTelemetry: a background session\'s move is checked on a schedule', () => {
  type ConfirmsBackgroundMove = (sessionId: string, fromAgentSessionId: string, toAgentSessionId: string) => Promise<boolean>;

  let telemetryUnderTest: SessionTelemetry | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    telemetryUnderTest?.dispose();
    telemetryUnderTest = null;
    vi.useRealTimers();
  });

  /**
   * A session on ORIGINAL when a background session's hook (`fork`) for MOVED
   * arrives, with MOVED's own status write already held behind it.
   */
  function hookForBackgroundSessionArrives(confirmsBackgroundMove: ConfirmsBackgroundMove): Harness {
    const harness = makeHarness(confirmsBackgroundMove);
    telemetryUnderTest = harness.telemetry;
    harness.telemetry.initSession('s1', new ClaudeAdapter());
    harness.telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    harness.telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);
    harness.telemetry.processStatusUpdate('s1', conversation(MOVED, 300));
    return harness;
  }

  /** Advances the fake clock to a time counted from the hook, rather than by an amount. */
  function clockFromHook(): (elapsedMs: number) => Promise<void> {
    let currentMs = 0;
    return async (elapsedMs) => {
      await vi.advanceTimersByTimeAsync(elapsedMs - currentMs);
      currentMs = elapsedMs;
    };
  }

  it('asks a /fork copy exactly five times, at 0, 1.5, 4, 10 and 30 s from the hook, and never again', async () => {
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>(async () => false);
    const { capturedIds, emittedUsage } = hookForBackgroundSessionArrives(confirmsBackgroundMove);
    const advanceTo = clockFromHook();

    const schedule = [
      { atMs: 0, asked: 1 },
      { atMs: 1_500, asked: 2 },
      { atMs: 4_000, asked: 3 },
      { atMs: 10_000, asked: 4 },
      { atMs: 30_000, asked: 5 },
    ];
    for (const { atMs, asked } of schedule) {
      if (atMs > 0) {
        // One millisecond short of the point: the next ask has not happened yet.
        await advanceTo(atMs - 1);
        expect(confirmsBackgroundMove).toHaveBeenCalledTimes(asked - 1);
      }
      await advanceTo(atMs);
      expect(confirmsBackgroundMove).toHaveBeenCalledTimes(asked);
    }

    await advanceTo(31_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(5);
    await advanceTo(300_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(5);
    expect(confirmsBackgroundMove).toHaveBeenLastCalledWith('s1', ORIGINAL, MOVED);
    // The copy never took the terminal's place.
    expect(capturedIds).toEqual([ORIGINAL]);
    expect(emittedUsage).toHaveLength(1);
  });

  it('a /bg move proven only on the 4th check (10 s) still switches, and applies the write it held', async () => {
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { capturedIds, emittedUsage } = hookForBackgroundSessionArrives(confirmsBackgroundMove);
    const advanceTo = clockFromHook();

    await advanceTo(9_999);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(3);
    expect(capturedIds).toEqual([ORIGINAL]);
    expect(emittedUsage).toHaveLength(1);

    await advanceTo(10_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(4);
    expect(capturedIds).toEqual([ORIGINAL, MOVED]);
    expect(emittedUsage.at(-1)).toEqual({ agentSessionId: MOVED, totalCostUsd: 51.58, totalOutputTokens: 300 });

    // A proven move ends the checks: the 30 s one is never asked.
    await advanceTo(300_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(4);
    expect(capturedIds).toEqual([ORIGINAL, MOVED]);
  });

  it('a session removed during a delay is not asked again, and nothing is adopted', async () => {
    // Would answer yes to a second ask, so a check that kept going would switch.
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { telemetry, capturedIds, emittedUsage } = hookForBackgroundSessionArrives(confirmsBackgroundMove);
    const advanceTo = clockFromHook();

    await advanceTo(1_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
    telemetry.removeSession('s1');

    await advanceTo(300_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
    expect(capturedIds).toEqual([ORIGINAL]);
    expect(emittedUsage).toHaveLength(1);
  });

  it('a /clear that moves the session to another id during a delay stops the pending check', async () => {
    // Would answer yes on the third ask, so a check that kept going would ask it.
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { telemetry, capturedIds, emittedUsage } = hookForBackgroundSessionArrives(confirmsBackgroundMove);
    const advanceTo = clockFromHook();

    await advanceTo(1_500);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(2);

    await advanceTo(2_000);
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(CLEARED, 'clear')]);
    telemetry.processStatusUpdate('s1', conversation(CLEARED, 40));
    expect(capturedIds).toEqual([ORIGINAL, CLEARED]);

    await advanceTo(300_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(2);
    // The background id was never adopted, and its held write never applied.
    expect(capturedIds).toEqual([ORIGINAL, CLEARED]);
    expect(emittedUsage.map((usage) => usage.agentSessionId)).toEqual([ORIGINAL, CLEARED]);
  });

  it('a check already in flight that resolves true after a /clear does not switch to the background id', async () => {
    let answerInFlightCheck: (moved: boolean) => void = () => {};
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>(
      () => new Promise<boolean>((resolve) => { answerInFlightCheck = resolve; }),
    );
    const { telemetry, capturedIds, emittedUsage } = hookForBackgroundSessionArrives(confirmsBackgroundMove);
    const advanceTo = clockFromHook();

    // The first ask is still waiting on the transcript when the /clear lands.
    await advanceTo(2_000);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(CLEARED, 'clear')]);
    telemetry.processStatusUpdate('s1', conversation(CLEARED, 40));
    expect(capturedIds).toEqual([ORIGINAL, CLEARED]);

    answerInFlightCheck(true);
    await advanceTo(2_001);
    await advanceTo(300_000);

    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
    expect(capturedIds).toEqual([ORIGINAL, CLEARED]);
    expect(emittedUsage.map((usage) => usage.agentSessionId)).toEqual([ORIGINAL, CLEARED]);
    expect(telemetry.getUsageCache()['s1'].sessionId).toBe(CLEARED);
  });

  it('a check that rejects reads as no, and a later one that resolves true still switches', async () => {
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>()
      .mockRejectedValueOnce(new Error('transcript unreadable'))
      .mockResolvedValue(true);
    const { capturedIds, emittedUsage } = hookForBackgroundSessionArrives(confirmsBackgroundMove);
    const advanceTo = clockFromHook();

    await advanceTo(0);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
    expect(capturedIds).toEqual([ORIGINAL]);

    await advanceTo(1_500);
    expect(confirmsBackgroundMove).toHaveBeenCalledTimes(2);
    expect(capturedIds).toEqual([ORIGINAL, MOVED]);
    expect(emittedUsage.at(-1)).toEqual({ agentSessionId: MOVED, totalCostUsd: 51.58, totalOutputTokens: 300 });
  });

  it('a fork hook naming the current id asks nothing', async () => {
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>(async () => true);
    const { telemetry, capturedIds } = makeHarness(confirmsBackgroundMove);
    telemetryUnderTest = telemetry;
    telemetry.initSession('s1', new ClaudeAdapter());
    telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));

    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(ORIGINAL, 'fork')]);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(confirmsBackgroundMove).not.toHaveBeenCalled();
    expect(capturedIds).toEqual([ORIGINAL]);
  });

  it('a fork hook before the session has reported any id asks nothing, and the first write is the baseline', async () => {
    const confirmsBackgroundMove = vi.fn<ConfirmsBackgroundMove>(async () => true);
    const { telemetry, capturedIds } = makeHarness(confirmsBackgroundMove);
    telemetryUnderTest = telemetry;
    telemetry.initSession('s1', new ClaudeAdapter());

    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(MOVED, 'fork')]);
    await vi.advanceTimersByTimeAsync(300_000);
    telemetry.processStatusUpdate('s1', conversation(MOVED, 300));

    expect(confirmsBackgroundMove).not.toHaveBeenCalled();
    expect(capturedIds).toEqual([MOVED]);
  });
});

describe('SessionTelemetry: an adapter that does not read its SessionStart hooks keeps every id change', () => {
  it('follows each status id change, as before', () => {
    const harness = makeHarness();
    const parserWithoutSessionStart = {
      detectFirstOutput: () => false,
      runtime: {
        activity: ActivityDetection.hooks(),
        reportsTurnEnd: true,
        statusFile: { parseStatus: () => null, parseEvent: () => null, isFullRewrite: true },
      },
      removeHooks: () => {},
    } as unknown as AgentParser;
    harness.telemetry.initSession('s1', parserWithoutSessionStart);
    harness.telemetry.processStatusUpdate('s1', conversation(ORIGINAL, 100));
    harness.telemetry.processStatusUpdate('s1', conversation(MOVED));
    harness.telemetry.processStatusUpdate('s1', spare());
    expect(harness.capturedIds).toEqual([ORIGINAL, MOVED, SPARE]);
    harness.telemetry.dispose();
  });
});
