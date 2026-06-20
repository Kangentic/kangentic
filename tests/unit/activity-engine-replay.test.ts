/**
 * Replay tests: drive captured production events.jsonl files through
 * the activity engine in fast-time and assert expected end-state.
 *
 * These pin behavior against real-world data. A regression in the
 * engine that changes how it handles a real event sequence will diff
 * the expected outcome here.
 *
 * Fixtures live at `tests/fixtures/replay/*.jsonl` (sanitized - see
 * `tests/fixtures/replay/_sanitize.mjs`). Expected outcomes are
 * embedded in this test file (one describe block per fixture).
 *
 * Engine timing for replay is set to no-op windows (0/0/0) so each
 * event commits instantly and final state reflects the predicate
 * exactly. Production timing windows are out-of-scope for replay
 * tests - they're tested separately in activity-engine.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'replay');
const SESSION_ID = 'replay-session';

interface ReplayResult {
  finalActivity: ActivityState;
  totalTransitions: number;
  /** Every committed activity value, in order (one entry per onActivityChange). */
  transitions: ActivityState[];
  finalState: {
    pendingToolCount: number;
    subagentDepth: number;
    activeBackgroundShellIds: string[];
    anonymousBackgroundShellCount: number;
    turnActive: boolean;
    permissionPending: boolean;
  };
  staleThinkingCompensations: number;
  /** PTY-tracker / heartbeat forced-thinking transitions (the safety net). */
  forceThinkingCompensations: number;
  /** Unattributable `background_shell_end` events made no-ops by the engine
   *  invariant (a spurious end that matched no tracked shell). */
  unmatchedBgShellEndCompensations: number;
  /** Times the named/anonymous bg-shell escape hatch (5-min cap) fired. Zero
   *  in replay (no timers advanced) UNLESS the stream itself forces it. */
  bgShellHatchCompensations: number;
  /** Empty-string `subagent_stop` events ignored as spurious inner-loop Stops
   *  (the fix for task #237's false idle). */
  ignoredInnerSubagentStopCompensations: number;
  /** Trigger of the last committed thinking->idle transition, or null. */
  lastThinkingToIdleTrigger: string | null;
}

function loadFixture(name: string): SessionEvent[] {
  const filePath = path.join(FIXTURES_DIR, name);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as SessionEvent);
}

function replay(events: SessionEvent[]): ReplayResult {
  const transitions: ActivityState[] = [];
  const engine = new ActivityEngine(
    {
      onActivityChange(_sessionId, activity) {
        transitions.push(activity);
      },
    },
    {
      bgShellEscapeHatchMs: 1000,        // sane finite values for tick processing
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0,          // skip window for deterministic replay
    },
  );
  engine.initSession(SESSION_ID);
  for (const event of events) {
    engine.processEvent(SESSION_ID, event);
  }
  const state = engine.getState(SESSION_ID)!;
  const snapshot = engine.getStatsSnapshot(SESSION_ID)!;
  const lastThinkingToIdle = [...snapshot.recentTransitions]
    .reverse()
    .find((record) => record.from === 'thinking' && record.to === 'idle');
  const result: ReplayResult = {
    finalActivity: state.activity,
    totalTransitions: transitions.length,
    transitions: transitions.slice(),
    finalState: {
      pendingToolCount: state.pendingToolCount,
      subagentDepth: state.subagentDepth,
      activeBackgroundShellIds: Array.from(state.activeBackgroundShellIds),
      anonymousBackgroundShellCount: state.anonymousBackgroundShellCount,
      turnActive: state.turnActive,
      permissionPending: state.permissionPending,
    },
    staleThinkingCompensations: snapshot.compensationCounters.staleThinking,
    forceThinkingCompensations: snapshot.compensationCounters.forceThinking,
    unmatchedBgShellEndCompensations: snapshot.compensationCounters.unmatchedBgShellEnd,
    bgShellHatchCompensations: snapshot.compensationCounters.bgShellHatch,
    ignoredInnerSubagentStopCompensations:
      snapshot.compensationCounters.ignoredInnerSubagentStop,
    lastThinkingToIdleTrigger: lastThinkingToIdle?.trigger ?? null,
  };
  engine.dispose();
  return result;
}

describe('ActivityEngine replay tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('session-001-bg-shell-orphans', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-001-bg-shell-orphans.jsonl');
      result = replay(events);
    });

    it('processes the entire event stream without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });

    it('ends with 3 orphan bg shells tracked (started, never KillBashed)', () => {
      // session-001 has 3 background_shell_start events with command
      // strings as detail (e.g. "npm run test:unit"). With current
      // engine, these go into activeBackgroundShellIds with the command
      // as the id (because no shell_id directive yet - Subsystem C).
      // Total bg shells held = 3.
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBe(3);
    });

    it('ends in thinking state because of orphan bg shells', () => {
      // 3 bg shells held -> predicate stays thinking. The escape
      // hatch would force-clear in production after 5 min.
      expect(result.finalActivity).toBe('thinking');
    });

    it('subagent depth balanced (4 starts + 4 stops = 0 net)', () => {
      expect(result.finalState.subagentDepth).toBe(0);
    });

    it('orphan tool_starts cleared by Idle clamp (production hook loss self-heals)', () => {
      // Real production sessions have unbalanced tool_start/tool_end
      // counts because of hook-loss edge cases. The engine self-heals:
      // every Idle event (Claude's Stop hook) clamps pendingToolCount
      // back to 0. Without the clamp, dropped PostToolUse hooks would
      // hold the predicate in 'thinking' indefinitely via the tool
      // reason. The bg-shell counts are independent and still gate
      // the predicate correctly.
      expect(result.finalState.pendingToolCount).toBe(0);
    });
  });

  describe('session-009-phantom-bg-shell-no-end', () => {
    // Real capture of the production bug (session 4632519c, task #175). The
    // agent ran `npm install` (anonymous) which was promoted to the named bg
    // shell `beg7osflu` as worktree setup, finished its turn (idle), and waited
    // for input - but no background_shell_end ever fired for it. The engine is
    // left holding one orphan: the exact precondition the timing-driven grace
    // reclaims (that recovery is exercised in activity-engine.test.ts).
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-009-phantom-bg-shell-no-end.jsonl');
      result = replay(events);
    });

    it('ends with exactly 1 orphaned bg shell tracked (start with no end)', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBe(1);
    });

    it('ends thinking, held only by the orphan after the turn is over', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
    });
  });

  describe('session-012-auto-bg-named-shell-live', () => {
    // Real capture of bug A (task #212). A foreground
    // `npx playwright test --project=electron` auto-backgrounds to the NAMED
    // shell `bx6k8r2cr`; the agent keeps working across several more turns
    // but never fires a background_shell_end for it. The named shell must
    // remain tracked the whole time (not spuriously dropped by an unrelated
    // idle or end), so the predicate keeps the task active while the shell
    // lives. The timing-driven hold split is covered in activity-engine.test.ts.
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-012-auto-bg-named-shell-live.jsonl');
      result = replay(events);
    });

    it('keeps the named shell tracked through end of capture (never ended)', () => {
      expect(result.finalState.activeBackgroundShellIds).toContain('bx6k8r2cr');
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBe(1);
    });

    it('ends thinking, held only by the live named shell after the last turn', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
    });

    it('never reclaimed the shell via a watchdog hatch during replay', () => {
      // Replay advances no timers, so a bg-shell-hatch trigger would only
      // appear if the engine spuriously dropped the shell. It must not.
      expect(result.lastThinkingToIdleTrigger).not.toBe('timer:bg-shell-hatch');
    });
  });

  describe('session-015-orphaned-named-bg-shell-no-pid', () => {
    // Real capture of task #225. A foreground `npm run build` auto-backgrounds
    // to the NAMED shell `benxug1zq` while a concurrent `npx vitest run` churns
    // the process tree, so Tier A PID capture stays ambiguous and is abandoned.
    // The agent never collects the build output, so its `background_shell_end`
    // hook never fires - contrast `bhflp7qsn` (a later bg shell) which DID get
    // its end. The pure event stream therefore leaves the engine holding the
    // orphan with no end. The engine is CORRECT to hold a named shell it has no
    // end for; detecting the DEAD OS process and draining it is the
    // BgShellWatcher's job (the watcher path that reclaims a PID-less,
    // output-quiescent named shell in deficit is covered in
    // bg-shell-watcher.test.ts - the replay harness drives only the engine, not
    // the watcher, so this fixture characterizes the engine's faithful hold of
    // the false-active condition, it is NOT the fix's red-green).
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-015-orphaned-named-bg-shell-no-pid.jsonl');
      result = replay(events);
    });

    it('ends thinking, held solely by the orphaned named bg shell', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(result.finalState.permissionPending).toBe(false);
      // Held by named shells only (no anonymous count involved).
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
    });

    it('keeps `benxug1zq` tracked (no end event) but drained `bhflp7qsn` (had its end)', () => {
      expect(result.finalState.activeBackgroundShellIds).toContain('benxug1zq');
      expect(result.finalState.activeBackgroundShellIds).not.toContain('bhflp7qsn');
    });

    it('the trailing idle_hint does NOT settle idle (and no bg-shell-hatch fires) while a bg shell holds the turn', () => {
      // The stream ends with a "Claude is waiting for your input" idle_hint, but
      // the orphan bg shell still holds the predicate, so the hint cannot flip
      // it to idle. This is exactly the user-visible false-active symptom.
      expect(result.finalActivity).toBe('thinking');
      expect(result.lastThinkingToIdleTrigger).not.toBe('timer:bg-shell-hatch');
    });
  });

  describe('session-002-many-bg-shells', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-002-many-bg-shells.jsonl');
      result = replay(events);
    });

    it('processes the entire event stream without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });

    it('ends with non-zero bg shell count (orphans)', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('session-003-no-bg-shells', () => {
    let result: ReplayResult;
    beforeEach(() => {
      // Despite the filename mentioning killbash, this session captured
      // a long agent run with NO background shells. Useful for testing
      // the engine's handling of high-volume tool/subagent events.
      const events = loadFixture('session-003-with-killbash.jsonl');
      result = replay(events);
    });

    it('no bg shells present', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBe(0);
    });

    it('subagent depth was overshot (more stops than starts: 4+9=net -5)', () => {
      // Real production sessions have unbalanced subagent events too.
      // Math.max(0, ...) clamps to 0 - never goes negative.
      expect(result.finalState.subagentDepth).toBe(0);
    });

    it('processes 900 events without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });
  });

  describe('session-004-large-22-bg-shells (stress test)', () => {
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-004-large-22-bg-shells.jsonl');
      result = replay(events);
    });

    it('handles 22+ bg shells without counter corruption', () => {
      const total =
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount;
      expect(total).toBeGreaterThanOrEqual(0);
      expect(total).toBeLessThanOrEqual(22);
      expect(result.finalState.subagentDepth).toBeGreaterThanOrEqual(0);
      expect(result.finalState.pendingToolCount).toBeGreaterThanOrEqual(0);
    });

    it('processes all events without throwing', () => {
      expect(result.totalTransitions).toBeGreaterThan(0);
    });
  });

  describe('session-005-waiting-for-input-idle-hint', () => {
    // Derived from the trace of task #156's session
    // 2d75b9e3-4ebb-420c-9d63-7ec48ba46c4b (sanitized). The whole turn was
    // delegated to a subagent; when the subagent stopped, turnActive was still
    // true and the only signal that arrived was a "Claude is waiting for your
    // input" notification (classified at the source into idle_hint). With no
    // pending tools/subagents/bg-shells, the pre-fix engine had nothing to drive
    // idle except the 180s stale-thinking watchdog. The idle_hint now settles it.
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-005-waiting-for-input-idle-hint.jsonl');
      result = replay(events);
    });

    it('reaches idle (not stuck thinking) after the waiting-for-input hint', () => {
      expect(result.finalActivity).toBe('idle');
      expect(result.finalState.turnActive).toBe(false);
    });

    it('settles via the idle_hint, NOT the 180s stale-thinking watchdog', () => {
      expect(result.lastThinkingToIdleTrigger).not.toBeNull();
      expect(result.lastThinkingToIdleTrigger).toMatch(/^event:idle_hint/);
      expect(result.lastThinkingToIdleTrigger).not.toBe('timer:stale-thinking');
    });

    it('never fires the stale-thinking compensation', () => {
      expect(result.staleThinkingCompensations).toBe(0);
    });

    it('all holders are clear at the end (no orphaned counters)', () => {
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
      expect(result.finalState.permissionPending).toBe(false);
    });
  });

  describe('session-006-ask-user-question-resume', () => {
    // Real capture from task #(fix-pr-linking) session
    // 037d97e9-ae42-49e7-ae69-b22b5016b848 (sanitized). The agent called
    // AskUserQuestion, which fired idle:permission (turnActive cleared). When
    // the user answered, the only signal was the AskUserQuestion tool_end at
    // depth 0 - a non-turn-initiating event that clears permissionPending but does
    // not re-arm turnActive. Pre-fix, the predicate dropped to idle and the card
    // sat idle (~65s observed) until the PTY force-thinking net caught up. The
    // resumed turn must show as thinking the instant the pause resolves.
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-006-ask-user-question-resume.jsonl');
      result = replay(events);
    });

    it('resumes to thinking immediately when the permission pause resolves (NOT idle)', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(true);
      expect(result.finalState.permissionPending).toBe(false);
    });

    it('never dips to idle between the permission pause and the resumed turn', () => {
      // Once the turn goes active, the pause resolves permission -> thinking
      // directly. A pre-fix run records a permission -> idle dip here. The
      // leading entry is the pre-turn initial idle from initSession (expected).
      const firstActive = result.transitions.findIndex((activity) => activity !== 'idle');
      expect(firstActive).toBeGreaterThanOrEqual(0);
      expect(result.transitions.slice(firstActive)).not.toContain('idle');
      expect(result.transitions[result.transitions.length - 1]).toBe('thinking');
    });

    it('recovers via the tool_end hook, NOT the PTY force-thinking net', () => {
      // The whole point of the fix: the hook event restores the turn, so the
      // safety net never has to fire for the resume.
      expect(result.forceThinkingCompensations).toBe(0);
      expect(result.staleThinkingCompensations).toBe(0);
    });

    it('leaves no orphaned holders (clean counters at the resume)', () => {
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
    });
  });

  describe('session-007-exit-plan-mode-resume', () => {
    // Real capture from task #(fix-board) session
    // 83f6b918-0942-466f-b116-5c5bf51940d9 (sanitized). This session paused
    // TWICE: first an AskUserQuestion, then an ExitPlanMode plan-approval. Both
    // resolved via a depth-0 tool_end with no fresh prompt/tool_start hook;
    // pre-fix the ExitPlanMode resume sat idle ~83s until the PTY net fired.
    // Proves the fix is generic across permission-class pauses, not just
    // AskUserQuestion.
    let result: ReplayResult;
    beforeEach(() => {
      const events = loadFixture('session-007-exit-plan-mode-resume.jsonl');
      result = replay(events);
    });

    it('resumes to thinking after the ExitPlanMode plan-approval resolves', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(true);
      expect(result.finalState.permissionPending).toBe(false);
    });

    it('never dips to idle across EITHER permission pause (both cycles recover)', () => {
      // A pre-fix run records a permission -> idle dip twice (once per resolved
      // pause). The leading entry is the pre-turn initial idle (expected).
      const firstActive = result.transitions.findIndex((activity) => activity !== 'idle');
      expect(firstActive).toBeGreaterThanOrEqual(0);
      expect(result.transitions.slice(firstActive)).not.toContain('idle');
    });

    it('recovers via hooks, NOT the PTY force-thinking net (no compensation)', () => {
      expect(result.forceThinkingCompensations).toBe(0);
      expect(result.staleThinkingCompensations).toBe(0);
    });

    it('leaves no orphaned holders at the end', () => {
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
    });
  });

  describe('session-010-subagent-permission-resume', () => {
    // Real capture from task #194 session 4ee951bb (sanitized). A PowerShell
    // tool INSIDE a Plan subagent raised a permission prompt (idle:permission
    // at subagentDepth 1). The user approved it: the tool ran to completion
    // and its tool_end arrived carrying the same toolId - but at depth 1,
    // where the depth-0 clearing gate ignored it. The PTY net deliberately
    // exempts 'permission' (a live prompt repaints the TUI), so the card sat
    // in the needs-attention state for the remaining 77s of the subagent's
    // life. The awaited tool's own completion must clear the flag regardless
    // of depth.
    const FIXTURE = 'session-010-subagent-permission-resume.jsonl';
    const APPROVED_TOOL_ID = 'toolu_0159sz6ngCMPXwqAqi3CUUiV';

    function sliceThroughApprovedToolEnd(events: SessionEvent[]): SessionEvent[] {
      const approvedToolEndIndex = events.findIndex(
        (candidate) => candidate.type === EventType.ToolEnd && candidate.toolId === APPROVED_TOOL_ID,
      );
      expect(approvedToolEndIndex).toBeGreaterThan(0);
      return events.slice(0, approvedToolEndIndex + 1);
    }

    it('clears permission the moment the approved subagent tool completes', () => {
      // Red without the awaited-toolId clear: the depth-0 gate ignores the
      // approving tool_end and this slice replays to a stuck 'permission'.
      const events = loadFixture(FIXTURE);
      const result = replay(sliceThroughApprovedToolEnd(events));
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.permissionPending).toBe(false);
      expect(result.finalState.turnActive).toBe(true);
      // The Plan subagent and its spawning Agent tool are still in flight.
      expect(result.finalState.subagentDepth).toBe(1);
      expect(result.finalState.pendingToolCount).toBe(1);
    });

    it('transitions idle -> thinking -> permission -> thinking with no idle dip', () => {
      const events = loadFixture(FIXTURE);
      const result = replay(sliceThroughApprovedToolEnd(events));
      // Leading idle is the initSession baseline. A pre-fix run ends on
      // 'permission' with no recovery entry.
      expect(result.transitions).toEqual(['idle', 'thinking', 'permission', 'thinking']);
    });

    it('full replay ends thinking with clean counters and no safety-net compensations', () => {
      const result = replay(loadFixture(FIXTURE));
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.permissionPending).toBe(false);
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
      expect(
        result.finalState.activeBackgroundShellIds.length
        + result.finalState.anonymousBackgroundShellCount,
      ).toBe(0);
      // Recovery came from the hook event, not the PTY net or watchdogs.
      expect(result.forceThinkingCompensations).toBe(0);
      expect(result.staleThinkingCompensations).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // The coupled tool-blind-remap bug (foreground Agent completion was
  // mis-mapped to background_shell_end). The two input-layer bugs
  // (over-decrement via the Agent mis-remap, over-increment via the failed
  // shell-id promotion) PARTIALLY CANCEL, so replaying the raw capture
  // looks fine. These three fixtures encode the bridge's output under the
  // full fix and under each deliberately-partial fix, so the harm and the
  // coupling are pinned at the engine level.
  // ───────────────────────────────────────────────────────────────────
  describe('session-008: coupled bg-shell / Agent-remap fix (GREEN, both fixes)', () => {
    const FIXTURE = 'session-008-coupled-bg-shell-corrected.jsonl';

    it('tracks the single backgrounded Bash with count 1 (named, not double-counted)', () => {
      // Replay up to (not including) the KillBash that ends the shell.
      const events = loadFixture(FIXTURE);
      const beforeKill = events.slice(0, -1);
      const result = replay(beforeKill);
      // The Pre+Post pair promoted the anonymous slot to a named slot:
      // exactly one shell, tracked by id, no anonymous double-count.
      expect(result.finalState.activeBackgroundShellIds).toEqual(['bash_1']);
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
      // The Agent completion was a plain tool_end, so nothing decremented
      // the bg-shell count: no spurious end.
      expect(result.unmatchedBgShellEndCompensations).toBe(0);
    });

    it('stays thinking after the main Stop while the real shell runs', () => {
      const events = loadFixture(FIXTURE);
      const beforeKill = events.slice(0, -1);
      const result = replay(beforeKill);
      // turnActive cleared by the Idle, but the named shell holds thinking.
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
    });

    it('idles only once the real shell actually exits, via the bg-shell-end trigger', () => {
      const result = replay(loadFixture(FIXTURE));
      expect(result.finalActivity).toBe('idle');
      expect(result.finalState.activeBackgroundShellIds).toEqual([]);
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
      expect(result.unmatchedBgShellEndCompensations).toBe(0);
      expect(result.lastThinkingToIdleTrigger).toMatch(/^event:background_shell_end/);
    });
  });

  describe('session-008: RED, fix-1-only (status remaps removed, shell-id field still wrong)', () => {
    // With the field name still wrong, the PostToolUse promotion re-emit is
    // detail-less, so the single real shell is double-counted as anonymous.
    // Removing the Agent mis-remap ALONE leaves this over-count, which keeps
    // the session thinking for the WRONG reason (phantom shells). This is why
    // fix #2 must land with fix #1.
    it('over-counts the bg shell (anon=2) when the shell-id field is not fixed', () => {
      const result = replay(loadFixture('session-008-coupled-bg-shell-red-fix1-only.jsonl'));
      expect(result.finalState.anonymousBackgroundShellCount).toBe(2);
      expect(result.finalState.activeBackgroundShellIds).toEqual([]);
      expect(result.finalActivity).toBe('thinking');
    });
  });

  describe('session-008: RED, fix-2-only (promotion works, Agent mis-remap still present)', () => {
    // With promotion fixed, the real shell is tracked by id (bash_1). The
    // Agent completion still leaks as a spurious, detail-less
    // background_shell_end. WITHOUT the engine invariant (#6) the old
    // last-resort drain would have removed bash_1 -> bgShell 0 -> premature
    // idle / false "task done" while playwright still ran. WITH #6 the
    // unattributable end is a no-op that bumps a counter, so the real shell
    // survives. This fixture is the red-green for both fix #1 and the
    // engine invariant.
    it('makes the spurious Agent end a no-op (counter bumps) and keeps the real shell', () => {
      const result = replay(loadFixture('session-008-coupled-bg-shell-red-fix2-only.jsonl'));
      expect(result.unmatchedBgShellEndCompensations).toBe(1);
      expect(result.finalState.activeBackgroundShellIds).toEqual(['bash_1']);
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
      // The real shell survives -> still thinking, NOT a premature idle.
      expect(result.finalActivity).toBe('thinking');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Incident A (session f03f5e43): a NAMED bg shell whose OS PID was never
  // captured exits, but its end hook is lost. The watcher's named-shell
  // no-drain branch correctly refuses a count-based drain, so the shell is
  // held until the 5-min cap -> the task shows falsely ACTIVE. The fix emits
  // a background_shell_end from the <task-notification> Claude injects on
  // terminal status. Two fixtures: the raw capture (bug) and the corrected
  // stream carrying the ends the fixed bridge emits.
  // ───────────────────────────────────────────────────────────────────
  describe('session-013-task-notification-missed-end (RAW, the bug)', () => {
    let result: ReplayResult;
    beforeEach(() => {
      result = replay(loadFixture('session-013-task-notification-missed-end.jsonl'));
    });

    it('leaves both backgrounded shells orphaned (no end hook ever fired)', () => {
      // npm-run-build promoted to `bfp9mv8jh`, the E2E run is named `b9wh3dhov`;
      // neither fires a background_shell_end in the raw capture.
      expect(result.finalState.activeBackgroundShellIds).toContain('b9wh3dhov');
      expect(result.finalState.activeBackgroundShellIds).toContain('bfp9mv8jh');
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
    });

    it('ends thinking, held only by the orphans after the turn is over (false ACTIVE)', () => {
      // This is exactly the precondition that the production engine reclaims
      // only at the 5-min cap. Replay advances no timers, so the orphan is
      // simply held here; the timing-driven cap is covered in
      // activity-engine.test.ts.
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.finalState.pendingToolCount).toBe(0);
      expect(result.finalState.subagentDepth).toBe(0);
    });
  });

  describe('session-013-task-notification-missed-end-corrected (the fix drains it)', () => {
    let result: ReplayResult;
    beforeEach(() => {
      result = replay(loadFixture('session-013-task-notification-missed-end-corrected.jsonl'));
    });

    it('drains both shells and reaches clean idle (no orphans, no hatch)', () => {
      // The corrected stream carries the two background_shell_end events the
      // fixed bridge emits from each shell's <task-notification>. Both named
      // shells drain; the session settles to idle with no holders.
      expect(result.finalActivity).toBe('idle');
      expect(result.finalState.activeBackgroundShellIds).toEqual([]);
      expect(result.finalState.anonymousBackgroundShellCount).toBe(0);
      expect(result.bgShellHatchCompensations).toBe(0);
      expect(result.unmatchedBgShellEndCompensations).toBe(0);
    });

    it('settles via the background_shell_end, not a watchdog cap', () => {
      expect(result.lastThinkingToIdleTrigger).toMatch(/^event:background_shell_end/);
    });
  });

  describe('session-014-named-shell-output-liveness (Incident B, engine-level invariant)', () => {
    // Session e3b001cc: four backgrounded test shells, the last being the
    // electron E2E run `bikrml4pf`. The engine-replay tier cannot exercise the
    // process-tree watcher (where the output-file liveness fix lives), so this
    // fixture pins the session-012-style invariant: the named shell stays
    // tracked through the end of capture and is never spuriously dropped, so
    // the predicate keeps the task active while the shell lives.
    let result: ReplayResult;
    beforeEach(() => {
      result = replay(loadFixture('session-014-named-shell-output-liveness.jsonl'));
    });

    it('keeps the electron E2E shell tracked through end of capture', () => {
      expect(result.finalState.activeBackgroundShellIds).toContain('bikrml4pf');
    });

    it('ends thinking, held by the live named shells, never reclaimed by a hatch', () => {
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.bgShellHatchCompensations).toBe(0);
      expect(result.lastThinkingToIdleTrigger).not.toBe('timer:bg-shell-hatch');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // A parent session shows IDLE while a subagent is still running. Real
  // capture (session bab8e0a8, a doc-auditor sync-docs audit): one
  // `subagent_start doc-auditor`, then the subagent's own inner Stop arrives
  // as `idle` while it is still live, then a spurious empty-detail
  // `subagent_stop` drops the counter to 0 ~50s before the real, named
  // terminal `subagent_stop doc-auditor`. Pre-fix, the `idle` cleared the
  // PARENT's turnActive AND the empty stop zeroed subagentDepth, so the board
  // went idle for the whole tail of the subagent's run. The fix gates the
  // Idle turn-end on subagentDepth === 0, so a subagent's inner Stop can no
  // longer end the parent turn; even though the empty stop still drains the
  // raw counter, turnActive (held by the gate) keeps the predicate thinking.
  // No watchdog is involved - the engine inputs are simply held correct.
  // ───────────────────────────────────────────────────────────────────
  describe('session-017-false-idle-during-live-subagent', () => {
    const FIXTURE = 'session-017-false-idle-during-live-subagent.jsonl';

    it('stays thinking through the subagent run (no false idle from its inner Stop)', () => {
      const result = replay(loadFixture(FIXTURE));
      // The parent turn is still active (about to consume the subagent
      // result), so the board must stay thinking. Pre-fix this was 'idle'.
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(true);
      // The empty/named stops drained the raw counter - harmless, because
      // turnActive (held by the gate) keeps the predicate thinking.
      expect(result.finalState.subagentDepth).toBe(0);
      // No thinking->idle transition ever committed: the subagent's inner Stop
      // did not end the parent turn (the leading 'idle' in `transitions` is the
      // engine's initial state before the first prompt, not a false idle).
      // Pre-fix this was a non-null `event:subagent_stop` trigger.
      expect(result.lastThinkingToIdleTrigger).toBeNull();
      // The inputs are correct, not force-recovered by a watchdog.
      expect(result.staleThinkingCompensations).toBe(0);
      expect(result.forceThinkingCompensations).toBe(0);
    });

    it('settles to idle once the PARENT fires its own Stop at depth 0', () => {
      // Append the parent's real Stop (an Idle arriving after the subagent has
      // fully returned, depth 0). It is NOT a subagent Stop, so it ends the
      // turn - guarding the inverse: the gate must not leave the turn stuck.
      const events = [
        ...loadFixture(FIXTURE),
        { ts: 1781459958000, type: EventType.Idle } as SessionEvent,
      ];
      const result = replay(events);
      expect(result.finalActivity).toBe('idle');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.lastThinkingToIdleTrigger).toMatch(/^event:idle/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // The harder ordering session-017 does NOT cover. Real capture (session
  // 87524f38, task #234's own plan-mode session running 3 parallel `Explore`
  // agents then a `Plan` agent). Each subagent emits TWO stops: a spurious
  // empty-detail ("") inner-loop Stop when its inner turn ends, then its
  // authoritative NAMED terminal Stop when the Task tool returns. The empty
  // inner stops arrive FIRST and drove `subagentDepth` to 0 while subagents
  // were still live. With depth prematurely 0:
  //   - a real `idle` (a subagent's inner Stop) cleared the parent turn ->
  //     the two `Explore` flickers, and
  //   - an `idle_hint` ("waiting for your input") ended the parent turn ->
  //     the ~69s `Plan` window.
  // session-017's c44ff281 depth-0 gate could not help because the count it
  // gates on was already corrupted. The fix ignores the empty-string inner
  // stops so `subagentDepth` stays accurate and those gates do their job. A
  // detail-LESS stop (session-008) still decrements; only `detail === ""` is
  // ignored. Pinned here; red with the empty-stop skip removed.
  // ───────────────────────────────────────────────────────────────────
  describe('session-018-parallel-subagent-false-idle', () => {
    const FIXTURE = 'session-018-parallel-subagent-false-idle.jsonl';

    it('stays thinking through the whole parallel+nested subagent run (no false idle)', () => {
      const result = replay(loadFixture(FIXTURE));
      // The parent turn is live the entire window (it resumes after each
      // subagent returns), so the board must stay thinking throughout.
      expect(result.finalActivity).toBe('thinking');
      expect(result.finalState.turnActive).toBe(true);
      // All named terminal stops landed: depth balances back to 0.
      expect(result.finalState.subagentDepth).toBe(0);
      // The crux: no thinking->idle ever committed. Pre-fix this was a real
      // `event:idle` (the Explore flickers) or `event:idle_hint` (the Plan
      // window), because the empty inner stops zeroed depth first.
      expect(result.lastThinkingToIdleTrigger).toBeNull();
      // Once the turn goes active it never dips back to idle (the leading
      // entry is the pre-turn initSession baseline idle, which is expected).
      const firstActive = result.transitions.findIndex((activity) => activity !== 'idle');
      expect(firstActive).toBeGreaterThanOrEqual(0);
      expect(result.transitions.slice(firstActive)).not.toContain('idle');
      // The empty-detail inner stops were recognized and discarded, not just
      // absent (4 in this stream: 3 Explore + 1 Plan).
      expect(result.ignoredInnerSubagentStopCompensations).toBe(4);
      // Held by correct inputs, not force-recovered by a watchdog.
      expect(result.staleThinkingCompensations).toBe(0);
      expect(result.forceThinkingCompensations).toBe(0);
    });

    it('still settles to idle once the PARENT fires its own Stop at depth 0 (inverse preserved)', () => {
      // Append the parent's real terminal Stop after every subagent has
      // returned (depth 0). It is NOT a subagent inner stop, so it ends the
      // turn: the fix must not leave the turn stuck thinking.
      const events = [
        ...loadFixture(FIXTURE),
        { ts: 1781496300000, type: EventType.Idle } as SessionEvent,
      ];
      const result = replay(events);
      expect(result.finalActivity).toBe('idle');
      expect(result.finalState.turnActive).toBe(false);
      expect(result.lastThinkingToIdleTrigger).toMatch(/^event:idle/);
    });

    it('classifies a trailing AskUserQuestion as permission, unchanged by the fix', () => {
      // The real capture's next state was a (correct) permission prompt. The
      // fix touches neither the permission flag nor derivePredicate, so an
      // idle:permission after the run still classifies as permission.
      const events = [
        ...loadFixture(FIXTURE),
        { ts: 1781496300000, type: EventType.Idle, detail: 'permission' } as SessionEvent,
      ];
      const result = replay(events);
      expect(result.finalActivity).toBe('permission');
      expect(result.finalState.permissionPending).toBe(true);
    });
  });

  describe('cross-fixture invariants', () => {
    it('all fixtures produce a deterministic outcome (no flakiness)', () => {
      const fixtures = [
        'session-001-bg-shell-orphans.jsonl',
        'session-002-many-bg-shells.jsonl',
        'session-003-with-killbash.jsonl',
        'session-004-large-22-bg-shells.jsonl',
        'session-006-ask-user-question-resume.jsonl',
        'session-007-exit-plan-mode-resume.jsonl',
        'session-010-subagent-permission-resume.jsonl',
        'session-008-coupled-bg-shell-corrected.jsonl',
        'session-008-coupled-bg-shell-red-fix1-only.jsonl',
        'session-008-coupled-bg-shell-red-fix2-only.jsonl',
        'session-013-task-notification-missed-end.jsonl',
        'session-013-task-notification-missed-end-corrected.jsonl',
        'session-014-named-shell-output-liveness.jsonl',
        'session-017-false-idle-during-live-subagent.jsonl',
        'session-018-parallel-subagent-false-idle.jsonl',
      ];
      for (const name of fixtures) {
        const events = loadFixture(name);
        const r1 = replay(events);
        const r2 = replay(events);
        expect(r1).toEqual(r2);
      }
    });

    it('every fixture has a non-empty event stream', () => {
      const names = fs
        .readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith('.jsonl'));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const events = loadFixture(name);
        expect(events.length).toBeGreaterThan(0);
        // First event should be session_start (Claude Code's invariant)
        expect(events[0].type).toBe(EventType.SessionStart);
      }
    });
  });
});
