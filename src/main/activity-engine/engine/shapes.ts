import { EventType } from '../../../shared/types';
import type { ActivityState, ActivityReason, PermissionWaitKind, SessionEvent } from '../../../shared/types';

/**
 * Shapes for the activity engine: types, default constants, and
 * runtime classification sets used by the engine and its consumers.
 *
 * Heterogeneous on purpose - everything in this file is "static
 * configuration / vocabulary the engine uses". Splitting types from
 * constants from sets adds three import paths for one conceptual layer.
 */

/**
 * Default escape hatch for the stuck-pending-tools watchdog: a turn
 * whose `PostToolUse` was lost (e.g. Ctrl+C killed the bash) leaves
 * `pendingToolCount > 0` with no further signal. Force-clear after this
 * long of `lastSignalAt` silence.
 *
 * Default 5 minutes. Override via constructor option for tests.
 *
 * Note: this no longer drives the bg-shell hatch. That hatch is now
 * anchored to `bgShellHoldSince` with the shorter, keep-alive-resistant
 * `DEFAULT_BG_SHELL_ONLY_GRACE_MS` grace below.
 */
export const DEFAULT_BG_SHELL_ESCAPE_HATCH_MS = 5 * 60_000;

/**
 * Grace before the bg-shell hatch reclaims an ORPHANED background shell that
 * is the SOLE holder of `thinking`. Anchored to `bgShellHoldSince` (when bg
 * shells first became the only holder), NOT to `lastSignalAt`.
 *
 * Why anchored, not signal-based: a `Bash(run_in_background:true)` that exits
 * naturally fires no `BackgroundShellEnd` hook, so the engine over-counts
 * until something reclaims it. The old design had the process-tree watcher
 * refresh `lastSignalAt` whenever it saw ANY shell-like descendant; for an
 * already-exited (phantom) shell whose exit the watcher could not attribute,
 * that 2s pulse pushed the old 5-min deadline out forever - the session
 * stayed `active` indefinitely (empirically confirmed: `lastSignalAt` ~2s
 * fresh 7+ minutes after turn end, with events and status both silent).
 *
 * The deadline is therefore immovable by SIGNAL-ONLY keep-alives
 * (`markThinkingSignal`). It is refreshed only by watcher-CONFIRMED liveness
 * (`markBackgroundShellsAlive`), which the watcher emits exclusively on an
 * in-sync cycle where every tracked shell is still present in the OS tree. A
 * phantom shows a deficit, never gets confirmed, and is reclaimed at the
 * grace; a genuinely-running shell (e.g. a 10-min E2E) is observed alive each
 * cycle and held active until it actually exits. The watcher's attributed
 * drain (`onNaturalExit`, ~4-6s) still wins for clean exits; this grace is the
 * backstop for the un-attributable case.
 *
 * Default 30 seconds. Override via constructor option for tests.
 */
export const DEFAULT_BG_SHELL_ONLY_GRACE_MS = 30_000;

/**
 * FIFO cap on `pendingExemptShellToolIds`, and on `pendingServiceShellIds`.
 *
 * An entry lives only for the window between a bg shell's PreToolUse and its
 * PostToolUse (1.7s in the captured evidence), so in practice the set holds at
 * most one or two. A DROPPED PostToolUse would strand its entry indefinitely
 * though: only `forceIdle` and a `tool_end` for the same id clear the memo,
 * and neither fires for a shell that moved to the background - the
 * exempt-shell case is by definition a session that sits quiet for hours. A
 * stranded entry is inert (no counter, no predicate term, and `toolId`s are
 * unique per tool call so it can never false-match a later shell), but the
 * bound should be real rather than assumed. This cap is the ONLY bound on a
 * memo of a shell that moved to the background, which is why
 * `resetInFlightCounters` can safely leave it alone - see the comment there
 * for why it must. Shell ids are unique per session too, so the same argument
 * holds for a service mark whose shell never starts.
 */
export const MAX_PENDING_EXEMPT_SHELL_TOOL_IDS = 16;

/**
 * Cap on `subagentLifecycleById`, evicting the oldest stopped id first.
 *
 * The ledger only has to remember a stopped id long enough to recognize its
 * duplicate stop, which in the captured incident (task #759) landed 12.7s
 * after the first. A live id has to stay for its whole run, because a re-start
 * of a live id takes no second slot (task #835). A `/code-review` pass can start
 * more than 50 finders in rolling batches of 20, plus test-builders and
 * SendMessage continuations, so it can write more ids than the cap holds while
 * one long-running agent stays live. Evicting stopped ids first keeps that
 * agent, and a live id goes only when the ledger holds no stopped one. An evicted id falls back to count-based tracking, which is the
 * behavior before the ledger existed. A live id's stop still decrements, a
 * duplicate of an evicted stopped id decrements once more, and a re-start of an
 * evicted live id takes a second slot, as each always did.
 */
export const MAX_TRACKED_SUBAGENT_IDS = 64;

/**
 * Cap on `startedSubagentIds`, evicting the oldest start first.
 *
 * Kept apart from `subagentLifecycleById`, whose stopped-first eviction would
 * drop the very id this set exists for: a background subagent re-prompted
 * after its first named stop (task #759) runs tools under an id the ledger
 * reads `stopped`, and a `/code-review` fan-out writes more than 64 ids. A
 * dropped id here would read that agent's tools as an internal agent's, with
 * no depth slot left to hold the turn. Ids are short strings, so the cap is
 * set past any session's subagent count.
 */
export const MAX_STARTED_SUBAGENT_IDS = 1024;

/** A correlated subagent's last lifecycle event in `subagentLifecycleById`. */
export type SubagentLifecycle = 'live' | 'stopped';

/**
 * Default stale-thinking safety net for hook loss. If a session is
 * stuck in `'thinking'` because `turnActive=true` (a thinking event
 * fired but the matching Idle hook never arrived) we force-idle it
 * after this long. Pending tools and counters bypass this watchdog -
 * legitimate long-running work is not stuck state.
 *
 * Default 180 seconds (3 minutes). Long-thinking phases like plan
 * composition can produce no tool events for >45s, so a tighter
 * threshold causes false fires. The hold is anchored to
 * `signal-or-pty-output`, not `lastSignalAt` alone: a single very heavy
 * generation turn can stream PTY output for >180s with NO nested hook
 * event and a silent status heartbeat (Claude's `status.json` does not
 * update mid-generation when no tool call or turn boundary occurs;
 * task #246 streamed continuously for 211s while the heartbeat was
 * silent). Streaming PTY output therefore defers this hold; a
 * genuinely-finished turn sits at a quiet prompt with no PTY data, so
 * the anchor freezes and a genuine stuck state still recovers within
 * the threshold. Override via constructor option for tests.
 */
export const DEFAULT_STALE_THINKING_TIMEOUT_MS = 180_000;

/**
 * Shortened threshold for the stale-thinking hold while `turnActive` was set by
 * the status-heartbeat (`turnForcedByHeartbeat`, task #364) and never confirmed
 * by a real turn-initiating hook - the hook-less `--resume` resume-picker class
 * (task #331/#364). That turn's anchor already narrows to `signal`
 * (`lastSignalAt` only, ignoring parked-TUI PTY repaints - see
 * `WatchdogHold.parkedAnchor`), so `lastSignalAt` is already frozen at the
 * moment output stopped growing; this only shortens HOW LONG the net waits
 * once frozen, from the general 180s down to this budget.
 *
 * Reasoned, not empirically calibrated (no capture of a live reload's
 * inter-output-growth cadence exists) - chosen for a strong self-correction
 * property instead: if this fires while the reload is still genuinely
 * generating, the very next output-growth status write re-triggers
 * `forceThinking(sessionId, true)` via the existing idle -> thinking heartbeat
 * recovery (`SessionTelemetry.processStatusUpdate`), so a too-aggressive grace
 * costs at most a brief idle blip (one status-write cycle, observed ~10s in
 * #331/#364), never a stuck-wrong state. That property is what makes 30s (the
 * fast end of the task's ~20-30s range) safe to pick without a live sample.
 *
 * Only the stale-thinking hold reads this (`WatchdogHold.heartbeatForcedThresholdMs`);
 * a real turn (`turnForcedByHeartbeat === false`) - including a live
 * long-generation turn that streams for minutes with no hooks (task #246) -
 * always uses `staleThinkingTimeoutMs`, never this budget. Override via
 * constructor option for tests.
 */
export const DEFAULT_STALE_AFTER_HEARTBEAT_FORCED_MS = 30_000;

/**
 * Shortened threshold for the `stuck-subagent` and `stuck-pending-tools` holds
 * while an `idle_hint` ("Claude is waiting for your input") is pending. When the
 * agent has reported it is back at the top-level prompt but a counter is still
 * stuck > 0 (the aborted/errored-turn signature: a named `subagent_stop` or
 * `tool_end` was lost), those holds reclaim on THIS budget instead of the 5-min
 * `bgShellEscapeHatchMs` cap.
 *
 * Defaulted to the SAME validated budget as the stale-thinking watchdog
 * (`DEFAULT_STALE_THINKING_TIMEOUT_MS`, 180s), not a smaller invented number:
 * the idle_hint is what justifies dropping the 5-min cap, but it is NOT proof
 * the turn ended (the notification can fire mid-subagent - task #237 /
 * session-018, confirmed by code.claude.com/docs/en/hooks), so we recover on the
 * same "this turn has been silent long enough to be stale" budget the engine
 * already trusts for a lone `turnActive`, rather than going below any validated
 * threshold. This shortens only the THRESHOLD; the anchor stays
 * `signal-or-pty-output` unless the hold's own `parkedWhen` narrows it (only
 * `stuck-subagent` does, and only during a live retry hold - task #532). So a
 * genuinely-live subagent streams PTY output (task #246 streamed continuously
 * for 211s), which defers this timer; only a truly silent (aborted) turn lets
 * it fire. Override
 * for tests. This is the EMPIRICALLY-VALIDATED recovery for the captured #277
 * incident, where the turn ended with a normal `Stop` (swallowed by the stuck
 * counter) plus an `idle_hint` - NO `StopFailure` was emitted. The structured
 * `turn_failed` path is the complement for the distinct hard-abort mode (an API
 * error that ends the turn via `StopFailure` INSTEAD of `Stop`), which is not
 * what #277 captured.
 */
export const DEFAULT_STALE_AFTER_IDLE_HINT_MS = 180_000;

/**
 * Default idle stability window. After computing a Stop-driven idle
 * (or a watcher-driven natural-exit idle), wait this long before
 * emitting. If a thinking signal arrives during the window, suppress
 * the idle. Prevents idle->thinking flicker from out-of-order hook
 * arrivals.
 *
 * Bypassed by Interrupted (instant), watchdog timeout (which waits at
 * least `DEFAULT_STALE_AFTER_HEARTBEAT_FORCED_MS`, and
 * `DEFAULT_STALE_THINKING_TIMEOUT_MS` on a normal turn), and PTY
 * silence (gated by `PTY_SILENCE_THRESHOLD_MS` in PtyActivityTracker).
 *
 * Default 400ms. Override via constructor option for tests / disable.
 */
export const DEFAULT_IDLE_STABILITY_WINDOW_MS = 400;

/**
 * How many audit-log entries to retain in the per-session ring buffer
 * for `getStatsSnapshot`. The log captures BOTH state transitions
 * (from !== to) AND counter-affecting events (from === to with a
 * non-empty counterDelta) so the debug overlay can reconstruct the
 * full reasoning chain across a turn. Sized for ~30s of typical
 * activity at 1-2 events/second.
 */
export const RECENT_TRANSITIONS_RING_SIZE = 50;

/**
 * PTY-chunk timeline buffer: bucket size and total window span.
 * Chunks are aggregated into 100ms buckets ({tsBucket, count}) so the
 * ring stays small (max ~1200 entries) and the timeline visualization
 * can render them as ticks without flooding SVG with thousands of
 * elements when an agent streams quickly.
 */
export const PTY_CHUNK_BUCKET_MS = 100;
export const PTY_CHUNK_WINDOW_MS = 120_000;

/**
 * Snapshot of the counters / flags the predicate keys off. Used to
 * compute a human-readable counter-delta string for the audit log.
 */
export interface CountersSnapshot {
  pendingToolCount: number;
  subagentDepth: number;
  bgShells: number;
  turnActive: boolean;
  permissionPending: boolean;
}

export interface ActivityEngineOptions {
  /** Stuck-pending-tools escape hatch (orphaned tool_start, lost PostToolUse). */
  bgShellEscapeHatchMs?: number;
  /** Grace before reclaiming a bg shell that is the sole holder of thinking. */
  bgShellOnlyGraceMs?: number;
  /** Stale-thinking watchdog when only turnActive is holding thinking. */
  staleThinkingTimeoutMs?: number;
  /** Shortened stuck-subagent / stuck-pending-tools grace while an idle_hint is pending. */
  staleAfterIdleHintMs?: number;
  /** Shortened stale-thinking grace while turnActive was set by the status-heartbeat (turnForcedByHeartbeat). */
  staleAfterHeartbeatForcedMs?: number;
  /** Stability window before emitting Stop-driven idle. Set to 0 to disable. */
  idleStabilityWindowMs?: number;
  /** Time source - injectable for tests. */
  now?: () => number;
}

/**
 * One in-flight tool tracked on the `pendingToolStack`. `id` is the
 * adapter's correlation id when available (e.g. Claude's `tool_use_id`
 * via the `tool-id` directive); undefined for adapters that don't
 * surface IDs - the engine falls back to LIFO-by-name in that case.
 * `name` is always set (sourced from `event.tool`).
 */
export interface PendingTool {
  id?: string;
  name: string;
  /** The call starts a subagent (`SessionEvent.launchesSubagent`). */
  launchesSubagent?: boolean;
}

/**
 * Monotonic per-session tally of recovery and compensation events.
 * Increments live for the lifetime of the session - never decremented.
 * Surfaced via `ActivityStatsSnapshot` so the debug overlay can render
 * a "click into the timeline to see what happened" cue when the
 * counters go non-zero. In a clean session, all eleven read zero.
 *
 * Reset only on `initSession()` (fresh state) or `dispose()`.
 */
export interface CompensationCounters {
  /** `timer:stale-thinking` watchdog fires (turnActive held alone, hook lost). */
  staleThinking: number;
  /** `timer:bg-shell-hatch` fires (30s sole-holder grace reclaims an orphan bg shell the watcher missed; NOT the stuck-pending-tools hatch below). */
  bgShellHatch: number;
  /** `timer:stuck-pending-tools` fires (Ctrl+C dropped PostToolUse). */
  stuckPendingTools: number;
  /** Heartbeat-recovery / PTY-tracker forced thinking transitions. */
  forceThinking: number;
  /** PTY-silence / shutdown forced idle transitions. */
  forceIdle: number;
  /**
   * A `background_shell_end` arrived that matched no tracked shell (no id
   * match AND no anonymous count to drain). Rather than corrupt an
   * attributable named shell with an unmatchable end, the engine treats it
   * as a no-op and bumps this counter. Non-zero means the input layer
   * emitted a spurious bg-shell end (e.g. a tool-blind remap leaked one).
   */
  unmatchedBgShellEnd: number;
  /**
   * A `subagent_stop` with an empty-STRING detail ("") was ignored rather
   * than decrementing `subagentDepth`. These are a subagent's spurious
   * inner-loop Stops (fired before the Task tool returns its named terminal
   * Stop); counting them drove depth to 0 while subagents were still live ->
   * false idle (task #237). Non-zero is normal and healthy on any session
   * that ran subagents - it is the count of noise the engine correctly
   * discarded, not an error.
   */
  ignoredInnerSubagentStop: number;
  /**
   * A NAMED `subagent_stop` was ignored because its `subagentId`'s last event
   * was already a stop. A background subagent that ends its turn without
   * calling SubagentHandback stops, is re-prompted by the CLI, and stops again
   * after the handback; counting the second stop took a live sibling's depth
   * slot and false-idled the session (task #759). Also bumped by a late stop
   * for a subagent whose slot a reset already released, and by a SendMessage
   * continuation's own stop after its first run's late stop already released
   * the one slot the two share (task #835). Non-zero is benign: it counts
   * duplicates the engine correctly discarded.
   */
  duplicateSubagentStop: number;
  /**
   * A `subagent_start` took no new depth slot because its `subagentId` was
   * already live. A driver re-tasked an agent with SendMessage after the
   * agent's first run lost its named stop. Counting the second start gave one
   * agent two slots, and the parent's Stop never ended the turn (task #835).
   * Non-zero is benign, because the engine absorbed the restart. When
   * `duplicateSubagentStop` also rises for that agent, its first run's stop
   * landed after the restart, and the depth read 0 while the continuation ran.
   */
  duplicateSubagentStart: number;
  /**
   * A tool event from an agent that never fired a `subagent_start`
   * (`ActivityEngine.isInternalAgentEvent`) was logged and nothing more. Claude
   * Code runs internal agents after a Stop, and they can start a tool whose end
   * never comes. Counted, the start reopened the turn the Stop ended, which
   * dropped that turn's end automations and held the card working until a
   * watchdog. Non-zero is benign.
   */
  internalAgentToolEvent: number;
  /**
   * `timer:stuck-subagent` fired: `subagentDepth` was stuck > 0 (a named
   * terminal `subagent_stop` was lost after its empty inner stop was
   * ignored) with no other holder, and no other watchdog could reclaim it
   * because they all gate on `subagentDepth === 0`. Non-zero means EITHER a
   * named SubagentStop hook was dropped (the original #237 cause), OR a wedged
   * CLI never resumed during a live retry hold that deliberately PRESERVED the
   * depth (task #532) - there the subagent may still be genuinely alive and no
   * hook was lost. The trigger label cannot distinguish them; check
   * `retryFailurePending` on the transition record.
   */
  stuckSubagent: number;
}

/**
 * One bucket of PTY-chunk arrival counts. `tsBucket` is the bucket's
 * lower bound in wall-clock ms (i.e. the chunk's `Date.now()` floored
 * to `PTY_CHUNK_BUCKET_MS`). Buckets older than `PTY_CHUNK_WINDOW_MS`
 * are evicted on each insertion so the ring stays bounded.
 */
export interface PtyChunkTick {
  tsBucket: number;
  count: number;
}

/**
 * Per-session bookkeeping for the v2 activity engine.
 *
 * The shape is intentionally smaller than v1's `SessionTrackingState`:
 * the three guards, the `pendingIdle*` flags, the `deferredIdleAt`
 * timestamp, the `pendingPermissions` counter, the
 * `lastThinkingSignal`/`firstThinkingTimestamp` watchdog scaffolding -
 * all of it collapses into a single predicate.
 */
export interface SessionEngineState {
  /** Current derived activity state. */
  activity: ActivityState;
  /**
   * True between any "thinking-initiating" event (ToolStart, Prompt,
   * SubagentStart, Compact, WorktreeCreate, BackgroundShellStart) and
   * the next "idle-initiating" event (Idle, Interrupted).
   */
  turnActive: boolean;
  /** In-flight ToolStart events with no matching ToolEnd/Interrupted. */
  pendingToolCount: number;
  /** Nesting depth of active subagents. */
  subagentDepth: number;
  /**
   * Each correlated subagent's LAST lifecycle event, keyed by
   * `SessionEvent.subagentId`. A dedupe ledger only: nothing reads it but the
   * `SubagentStart` / `SubagentStop` cases and `releaseSubagentSlots`, and the
   * predicate still keys on `subagentDepth` alone.
   *
   * A stop for an id already marked `'stopped'` is a duplicate and does not
   * decrement (task #759). A start re-marks the id `'live'`, because a
   * SendMessage continuation fires a fresh SubagentStart under the same id
   * before its next stop. A start for an id already `'live'` takes no second
   * slot, because a re-task of an agent whose first run lost its named stop
   * would otherwise hold two (task #835). Events with no id, or an empty one,
   * never touch the ledger.
   *
   * Bounded at `MAX_TRACKED_SUBAGENT_IDS`, evicting the stopped id written
   * longest ago first and a live one only when no stopped id remains.
   */
  subagentLifecycleById: Map<string, SubagentLifecycle>;
  /**
   * Every `subagentId` a `subagent_start` has named in this session, so a tool
   * event from an id never named is an internal CLI agent's
   * (`isInternalAgentToolEvent`). Never cleared by a reset: a subagent a
   * watchdog released can still be running. Bounded at
   * `MAX_STARTED_SUBAGENT_IDS`, oldest first.
   */
  startedSubagentIds: Set<string>;
  /**
   * Identity-aware bg shell tracking (set by Subsystem C). Until
   * shell_id is extracted from hooks this set will only be populated
   * by direct `markBackgroundShellEnded(sessionId, shellId)` calls
   * from the watcher's PID-aware path.
   */
  activeBackgroundShellIds: Set<string>;
  /**
   * Fallback counter for shells whose start-event lacked a `shell_id`
   * detail. Decremented in lockstep with the watcher's count-based
   * heuristic (Subsystem B Tier B).
   */
  anonymousBackgroundShellCount: number;
  /**
   * Named bg shells that do not hold the session. Two ways in: the launching
   * command carried `NO_ACTIVITY_HOLD_FLAG` (`/preview`'s watcher, which blocks
   * for the preview's whole lifetime), or the agent marked the shell as a
   * service through the `kangentic_mark_background_service` MCP tool
   * (`ActivityEngine.markBackgroundShellsAsServices`), which moves the id here
   * from `activeBackgroundShellIds`.
   *
   * Deliberately a SEPARATE set rather than a side-flag on
   * `activeBackgroundShellIds`: every activity site is written in terms of
   * `activeBackgroundShellIds` and `anonymousBackgroundShellCount` and nothing
   * else - `derivePredicate`, `idleHintEndsTurn`, the reason ladder, and
   * `snapshotCounters` sum the two, while the two bg-shell watchdog holds each
   * test one term and the other three require the sum to be zero. A set that
   * appears in none of those expressions is invisible to all of them by
   * construction, so none of them needed an edit.
   *
   * NOT invisible to the watcher: `getActiveShellCount` and `getNamedShellIds`
   * in `session-telemetry.ts` sum BOTH sets, so Tier A PID capture, the
   * transcript drain, and the `expected = preExistingHelpers + tracked`
   * deficit math keep working and the shell drains normally when the preview
   * exits. Dropping an exempt id from `tracked` while its process is alive
   * would take the watcher's surplus branch and permanently fold a real
   * process into `preExistingHelpers`.
   */
  exemptBackgroundShellIds: Set<string>;
  /**
   * `toolId`s whose PreToolUse event carried `NO_ACTIVITY_HOLD_FLAG`, awaiting
   * their PostToolUse promotion. The PreToolUse event is a
   * `background_shell_start` for a Bash `run_in_background` launch and a plain
   * `tool_start` for any other (Claude's PowerShell tool, or a foreground
   * command Claude moves to the background itself). A `tool_end` for the same
   * id drops it: that command finished in the foreground and never promotes.
   *
   * A correlation memo, NOT a counter: the exempt shell is still counted in
   * `anonymousBackgroundShellCount` (or, from a `tool_start`, in
   * `pendingToolCount`) during the window between the two events, so every
   * existing drain path stays untouched.
   *
   * The memo is required because the anonymous-to-named promotion is a shape
   * heuristic, not a `toolId` correlation, and the exemption cannot be
   * re-derived at PostToolUse: that event's `detail` is the shell id, and the
   * command string carrying the flag is gone by then.
   *
   * Bounded at `MAX_PENDING_EXEMPT_SHELL_TOOL_IDS` (FIFO) so a dropped
   * PostToolUse cannot strand entries indefinitely.
   */
  pendingExemptShellToolIds: Set<string>;
  /**
   * Shell ids the agent marked as services before the engine saw them start.
   * The MCP call and the events tailer race: the agent reads the id from the
   * tool result the PostToolUse hook ran beside, so its mark can arrive before
   * the PostToolUse line is ingested. The named promotion reads this set and
   * files the id straight into `exemptBackgroundShellIds`.
   *
   * Bounded at `MAX_PENDING_EXEMPT_SHELL_TOOL_IDS` (FIFO), like the toolId
   * memo, so a mark for an id that never starts cannot strand entries.
   */
  pendingServiceShellIds: Set<string>;
  /**
   * Sticky flag set when an Idle event with `detail=permission` fires.
   * Cleared by Prompt, Interrupted, SubagentStart, depth-0 ToolStart,
   * depth-0 ToolEnd, a ToolStart/ToolEnd carrying
   * `permissionAwaitedToolId` (any depth), non-permission Idle,
   * forceThinking, forceIdle.
   */
  permissionPending: boolean;
  /**
   * Correlation id of the tool the pending permission prompt was raised
   * for: the newest entry of `pendingToolStack` named by the
   * `idle:permission` event's `tool`, else the stack top (permission
   * prompts fire between PreToolUse and execution, and permission idles
   * leave the stack intact). Lets the engine clear
   * `permissionPending` when THAT tool starts/ends at any subagent
   * depth. Without it, an approved tool inside a subagent leaves the
   * flag stuck until the subagent stops: the depth-0 gate ignores its
   * tool_end, and the PTY force-thinking net deliberately exempts
   * 'permission'. Null when no permission is pending or the awaiting
   * tool carried no correlation id.
   */
  permissionAwaitedToolId: string | null;
  /**
   * Ids of the other tools already running when the pending permission
   * prompt was raised: its parallel siblings. A depth-0 ToolEnd of one of
   * them does not clear the prompt, because a sibling finishing says
   * nothing about the answer. Measured on Claude Code with a ToolSearch
   * run beside AskUserQuestion: the search ended 30 ms after the question
   * opened, and clearing on it hid a question still on screen. Emptied
   * with `permissionPending`; engine-internal, not in the snapshot.
   */
  permissionSiblingToolIds: Set<string>;
  /**
   * What the pending wait is for, from the `waitKind` of the `idle:permission`
   * event that raised it: a question or an approval. Null when no wait is
   * pending or the agent did not report a kind. Set and cleared in lockstep
   * with `permissionPending`; a later permission idle replaces it.
   */
  permissionWaitKind: PermissionWaitKind | null;
  /**
   * Wall-clock ms of the most recent activity-proving signal. Used by
   * the bg-shell escape hatch and stale-thinking watchdog.
   */
  lastSignalAt: number | null;
  /**
   * Wall-clock ms of the most recent PTY output chunk. Refreshed on every
   * PTY chunk (production, unconditional - NOT gated by PtyActivityTracker
   * suppression). Feeds the `signal-or-pty-output` watchdog holds
   * (stuck-pending-tools, stuck-subagent, stale-thinking): while a turn is
   * genuinely working, the agent CLI's TUI streams spinner/output, so chatty
   * PTY proves the session is alive even when no hook event or status
   * heartbeat refreshes `lastSignalAt`. This covers a foreground tool, a live
   * subagent, AND a long tool-less generation gap (task #246). It is only PTY
   * DATA: a blinking cursor is xterm-rendered terminal state, never a PTY
   * chunk, so it does not refresh this field. Deliberately does NOT feed the
   * bg-shell holds (anchored to `bgShellHoldSince` so signal-only keep-alives
   * cannot pin a phantom). Null until the first chunk.
   */
  lastPtyOutputAt: number | null;
  /**
   * Most recent ToolStart's tool name. Sticky until the next ToolStart
   * or until pendingToolCount drops to 0. Surfaced in `ActivityReason`
   * for UI tooltips ("Running Bash"). DERIVED from `pendingToolStack` -
   * always equals the top of the stack, or null when the stack is
   * empty. Maintained in lockstep so external readers can keep using
   * the field without thinking about the stack.
   */
  currentTool: string | null;
  /**
   * Stack of in-flight tools in start order. Pushed on `ToolStart`;
   * matched by id (preferred) or LIFO-by-name (fallback) on `ToolEnd`.
   *
   * Length stays in lockstep with `pendingToolCount` for the common
   * case; a hook drop or out-of-order arrival can desync them, so the
   * predicate uses pendingToolCount and the UI uses the stack top.
   */
  pendingToolStack: PendingTool[];
  /** Wall-clock ms of the most recent idle transition (used by idle-timeout sweep). */
  idleTimestamp: number | null;
  /**
   * Wall-clock ms since the session first entered a state that needs the
   * user (`requiresUserInteraction` true - `'idle'` or `'permission'`).
   * Distinct from `idleTimestamp`, which is scoped to `'idle'` alone and
   * drives auto-suspend: this field spans BOTH needs-user states so a
   * `thinking -> permission -> idle` run keeps the ORIGINAL park time
   * instead of resetting when permission resolves into idle. Set on first
   * entering either state from `'thinking'`; left unchanged on a
   * `permission <-> idle` crossing; cleared to null on entering
   * `'thinking'`. Surfaced on `ActivityReason` so the UI can render "waiting
   * Nm" next to the mail affordance.
   */
  needsUserSince: number | null;
  /**
   * Provenance of the CURRENT idle: true iff this idle was entered via a
   * genuine hook turn-end (a non-permission `Idle` hook, an `idle_hint` that
   * cleared `turnActive`, or an `Interrupted`/`TurnFailed`) - "the agent told
   * us the turn ended". False when idle was entered via a fallback (a watchdog
   * hatch resetting a stuck holder, or `forceIdle`), or for a brand-new
   * never-started session.
   *
   * Read by the status-file heartbeat recovery
   * (`SessionTelemetry.processStatusUpdate`): output-token growth while idle may
   * only force-think when the idle was NOT hook-authoritative. This stops
   * background non-turn housekeeping (compaction/summarization output emitted
   * with no turn-start hook) from re-activating a parked pure-hooks agent, while
   * preserving the net's real job of recovering a fallback idle whose agent is
   * actually generating. Re-assigned (to true or false, not merely cleared) at
   * each turn-ending, force-idle, and watchdog-hatch entry; only meaningful
   * while `activity === 'idle'`.
   */
  idleAuthoritative: boolean;
  /**
   * What cleared `turnActive` for the turn still settling, so the idle it
   * produces can be told apart once it commits: `'stop'` for the agent's own
   * turn-end hook (a non-permission `Idle` at subagent depth 0), `'idle-hint'`
   * for an `idle_hint` that ended the turn, null for everything else (no turn
   * ended yet, an interrupt, a failed turn, `forceIdle`, a new turn).
   *
   * The commit cannot read this from its trigger: a Stop arms the stability
   * window and the idle lands later as `timer:stability`, and background work
   * the Stop left running can hold the session thinking until long after it.
   * Only `'stop'` counts as a turn end (`ActivityEngineCallbacks.onTurnEnded`).
   * An `idle_hint` does not: Esc between tool calls fires no hook and ends the
   * turn through it, so it cannot tell a finished turn from a stopped one.
   * Consumed (set back to null) by the commit that reports the turn end, so a
   * turn ends at most once.
   */
  turnEndSource: 'stop' | 'idle-hint' | null;
  /**
   * When the session last went from idle to thinking (engine clock), or null
   * before its first turn. Reported with a turn end so a consumer can tell a
   * turn that began before some boundary from one that began after it: a task
   * dragged into a column while its agent is mid-turn must not have that
   * column's turn-end automations judge the old column's work. A permission
   * prompt resolving back to thinking is the same turn and does not restamp it,
   * except a plan approval (`AgentTool.ExitPlanMode`'s `tool_end` resolving the
   * prompt): the agent implements in the turn that planned, so the approval is
   * where this column's work begins.
   */
  turnStartedAt: number | null;
  /**
   * How many events that start or carry a turn's work (`TURN_INITIATING_EVENTS`)
   * the engine has processed for this session. Reported with a turn end, so a
   * consumer that judged that turn can ask later whether the agent has reported
   * anything since: a newer turn moves it even when that turn failed or was
   * interrupted back to idle with no turn end of its own.
   *
   * Only `processEvent` moves it, so only the agent's own hooks or wire events
   * do. PTY output and the status heartbeat force thinking without touching it,
   * since an agent's trailing paint after a turn end is not a new turn. That is
   * why it, and not `turnStartedAt`, is the turn's identity: a PTY-tracked
   * agent's paint re-stamps `turnStartedAt`.
   */
  workSerial: number;
  /**
   * The last `ActivityReason` handed to a consumer, or null before the first
   * one. Exists so a reason that changes KIND without the activity changing can
   * still be reported.
   *
   * A session is `thinking` from the start of a turn until the end of it, and
   * `commitTransition` returns early when the activity is unchanged, so an
   * activity-transition-only push reports nothing for the whole of a long turn.
   * Measured over a real 9-way /code-review capture, the engine derived 711
   * reasons and delivered 3 (`tests/unit/activity-engine-replay.test.ts`,
   * session-029). That is what left every card's hover tooltip reporting a
   * reason frozen since the turn began.
   *
   * Compared on KIND only, never deep-equal: `pendingCount` and `currentTool`
   * move on nearly every event, so a deep-equal gate would push about a thousand
   * times across that same capture instead of 176.
   */
  lastPushedReason: ActivityReason | null;
  /**
   * Provenance of the CURRENT `turnActive=true`: true iff it was set by the
   * status-heartbeat's `forceThinking(sessionId, true)` (output-token growth
   * while idle, e.g. a `--resume` resume-picker context-reload, which fires NO
   * turn hooks) and has not since been confirmed by a real turn-initiating hook.
   * False for a hook-confirmed turn (`TURN_INITIATING_EVENTS`, permission-resume)
   * and for a PTY-tracker-forced turn (non-hooks agents), and reset false on
   * every turn-end, turn-ending watchdog reset, and `forceIdle` (the bg-shell
   * hatches leave it untouched - their predicate already requires `!turnActive`,
   * so it is `false` by the time they fire).
   *
   * Read by `watchdogBaseTime`: the stale-thinking hold's `signal` narrow-anchor
   * (which makes the 180s net ignore parked-TUI PTY repaints) engages while
   * EITHER `idleHintPending` OR this flag is set - the latter covers a hook-less
   * resume turn that can never fire an `idle_hint` (task #364). With the
   * heartbeat's output-growth-gated keep-warm (`markThinkingSignal`, task #331),
   * `lastSignalAt` stays fresh while output grows and freezes the moment it
   * stops, so the narrowed anchor still self-heals ~180s after output froze
   * rather than ~180s after the last PTY repaint. Only meaningful while
   * `turnActive` is true.
   */
  turnForcedByHeartbeat: boolean;
  /**
   * Pending stability-window idle. When non-null, an idle transition
   * is scheduled to commit at this wall-clock ms. A thinking signal
   * arriving before then cancels it.
   */
  pendingIdleAt: number | null;
  /**
   * Wall-clock ms anchoring the `timer:bg-shell-hatch` deadline. Set to when
   * background shells first became the SOLE holder of `thinking`, then
   * refreshed forward by `markBackgroundShellsAlive` each cycle the watcher
   * confirms the tracked shells are still alive in the OS tree. Signal-only
   * `markThinkingSignal` keep-alive pulses deliberately CANNOT push it out -
   * so a phantom (which the watcher sees as a deficit, never confirming
   * liveness) is still reclaimed at the grace, while a genuinely-running shell
   * is held. Stamped lazily by `scheduleTimer` when the bg-shell hold becomes
   * active; cleared the moment any other holder appears or the bg count
   * reaches zero. `null` whenever bg shells are not the sole holder.
   */
  bgShellHoldSince: number | null;
  /**
   * True between an `idle_hint` ("waiting for your input") notification and the
   * next genuine turn-initiating event. While set, the `stuck-subagent` and
   * `stuck-pending-tools` watchdog holds use the `staleAfterIdleHintMs` budget
   * (the validated stale-thinking 180s) instead of the 5-min
   * `bgShellEscapeHatchMs` cap, so a counter left stuck by an aborted/errored
   * turn is reclaimed on the established stale budget instead of the 5-min cap.
   *
   * NOT proof the turn ended: Claude's idle notification can fire while a
   * subagent is genuinely live (task #237), so this only SHORTENS the watchdog -
   * the `signal-or-pty-output` anchor still defers it while live work streams
   * output. Set on `IdleHint`; cleared by any turn-initiating event, the
   * Interrupted/TurnFailed bypass, and force-thinking / force-idle.
   */
  idleHintPending: boolean;
  /**
   * True while the session is held `thinking` through a LIVE `turn_retrying`
   * retry (a transient StopFailure error, e.g. 529 overloaded, that the agent
   * is auto-retrying mid-turn - see `ActivityEngine.applyRetryableFailureHold`).
   * Feeds the `believedParked` check (`watchdogBaseTime`) alongside
   * `idleHintPending` / `turnForcedByHeartbeat`: without it, a parked-TUI
   * "retrying in Ns..." repaint during backoff would stream real PTY bytes and
   * defer the net indefinitely for a retryable error that turns out to be
   * terminal (reintroducing the #294/#364 parked-repaint class). Narrowing the
   * anchor to `signal` while this is set lets the net still fire after the last
   * genuine hook/output-growth signal. WHICH watchdog it narrows depends on the
   * preserved `subagentDepth` (task #532): stale-thinking at depth 0 (~180s), or
   * stuck-subagent at depth > 0 (the 5-min cap), the latter via that hold's own
   * `parkedWhen`, which narrows on THIS flag alone.
   * Cleared by the same events that clear `idleHintPending`: a genuine
   * turn-initiating event, the Interrupted/TurnFailed/TurnRetrying bypass
   * (`resetInFlightCounters`), and `forceThinking`/`forceIdle`.
   */
  retryFailurePending: boolean;
  /**
   * Ring buffer of recent transitions for the debug overlay. Mutated
   * only by `recordTransition`; external observers via `getState` /
   * `forEachState` see this through `Readonly<SessionEngineState>`,
   * which prevents accidental writes from outside the engine.
   */
  recentTransitions: TransitionRecord[];
  /**
   * Monotonic compensation counters - see `CompensationCounters`.
   * Live for the session's lifetime so a flip-flop hours into a long
   * session is still visible.
   */
  compensationCounters: CompensationCounters;
  /**
   * Bucketed PTY-chunk arrival ring for the timeline visualization.
   * Each entry is a 100ms bucket with the count of chunks that
   * arrived during it. Buckets older than 120s are evicted on insert.
   */
  recentPtyChunks: PtyChunkTick[];
}

/**
 * What `ActivityEngine.markBackgroundShellsAsServices` did with one shell id:
 *   - `marked`         - it was holding the session and now does not.
 *   - `already-marked` - it was already exempt (flagged at launch, or marked before).
 *   - `pending`        - the engine has not seen it start yet; it lands exempt
 *                        when it does (`pendingServiceShellIds`).
 */
export interface BackgroundShellServiceOutcome {
  shellId: string;
  outcome: 'marked' | 'already-marked' | 'pending';
}

/**
 * Free-form trigger label describing what caused a transition. Useful
 * for debugging "why did this go idle?" reports. Examples:
 *   - `event:tool_start`           - hook event drove it
 *   - `event:idle:permission`      - hook event with detail
 *   - `force-thinking`             - PTY tracker / heartbeat recovery
 *   - `force-idle`                 - PTY silence / Esc / shutdown
 *   - `timer:stability`            - 400ms idle stability window expired
 *   - `timer:bg-shell-hatch`       - 30s sole-holder orphan-bg-shell grace
 *   - `timer:stale-thinking`       - 180s stale-thinking watchdog
 *   - `timer:stuck-pending-tools`  - 5-min hatch for orphan tool_starts
 *   - `timer:stuck-subagent`       - 5-min hatch for a stuck subagentDepth
 *   - `event:bg-shell-service:mcp` - the agent marked background shells as services
 *   - `interrupted`                - Interrupted event reset everything
 */
export type TransitionTrigger =
  | `event:${string}`
  | `event:${string}:${string}`
  | `timer:${string}`
  | 'force-thinking'
  | 'force-idle'
  | 'interrupted';

export interface TransitionRecord {
  /** Wall-clock ms (from the engine's `now()` source). */
  ts: number;
  from: ActivityState;
  /** Same as `from` for non-transition events that mutated counters
   *  without changing activity. */
  to: ActivityState;
  reasonKind: ActivityReason['kind'];
  /** What caused the entry. Free-form for the debug overlay. */
  trigger: TransitionTrigger;
  /** Plain-text summary of which counters/flags changed during this
   *  step (e.g. "tools +1", "bg -1, turn no"). Undefined when no
   *  observable counter shifted - only set on state transitions OR
   *  non-transition events that did mutate something. */
  counterDelta?: string;
}

/**
 * Snapshot exposed via `getStatsSnapshot` for the debug overlay
 * (Subsystem E). Implementation detail leakage is acceptable here -
 * this method is dev-tools-only.
 *
 * Keep the scalar fields in sync with the parallel `ActivityStatsSnapshot`
 * in `src/shared/types.ts` (the IPC payload copy).
 * `tests/unit/activity-stats-snapshot-parity.test.ts` fails if the two copies'
 * top-level fields drift (typecheck alone does not catch a one-sided field add).
 */
export interface ActivityStatsSnapshot {
  sessionId: string;
  activity: ActivityState;
  reason: ActivityReason;
  pendingToolCount: number;
  subagentDepth: number;
  backgroundShellIds: readonly string[];
  anonymousBackgroundShellCount: number;
  /** Named bg shells that do not hold the session active (`NO_ACTIVITY_HOLD_FLAG`
   *  at launch, or marked as services by the agent). Tracked for liveness,
   *  excluded from the predicate. See `SessionEngineState.exemptBackgroundShellIds`. */
  exemptBackgroundShellIds: readonly string[];
  turnActive: boolean;
  permissionPending: boolean;
  /** The tool_use_id awaiting a permission decision when `permissionPending` is true, else null. See `SessionEngineState.permissionAwaitedToolId`. */
  permissionAwaitedToolId: string | null;
  /** What the pending wait is for, or null. See `SessionEngineState.permissionWaitKind`. */
  permissionWaitKind: PermissionWaitKind | null;
  msSinceLastSignal: number | null;
  /** Wall-clock ms of the most recent thinking-signal. Lets the
   *  debug-overlay timeline render the active watchdog deadline as
   *  `lastSignalAt + thresholdMs`. Null when no signal yet. */
  lastSignalAt: number | null;
  /** Wall-clock ms of the most recent PTY output chunk (stuck-pending-tools
   *  hold base, alongside `lastSignalAt`). Null when no chunk yet. */
  lastPtyOutputAt: number | null;
  /** ms since the most recent PTY output chunk, or null when no chunk yet. */
  msSincePtyOutput: number | null;
  pendingIdleArmed: boolean;
  /** Wall-clock ms since the session first needed the user (see
   *  `SessionEngineState.needsUserSince`), or null while thinking. */
  needsUserSince: number | null;
  /** True while an `idle_hint` is pending (see `SessionEngineState.idleHintPending`):
   *  the stuck-subagent / stuck-pending-tools watchdogs are on their short grace,
   *  not the 5-min cap. Lets the debug overlay explain a fast watchdog fire. */
  idleHintPending: boolean;
  /** True while the session is held `thinking` through a live `turn_retrying`
   *  retry (see `SessionEngineState.retryFailurePending`): the anchor of
   *  whichever watchdog is arbitrating the hold is narrowed to `signal`, so
   *  parked-TUI retry repaints do not defer its net. That is stale-thinking at
   *  `subagentDepth === 0` (~180s) and stuck-subagent at depth > 0 (the 5-min
   *  cap), since the hold preserves the depth (task #532). Lets the debug
   *  overlay explain a narrowed retry hold, the retry-side analog of
   *  `idleHintPending`. */
  retryFailurePending: boolean;
  recentTransitions: ReadonlyArray<TransitionRecord>;
  compensationCounters: CompensationCounters;
  recentPtyChunks: ReadonlyArray<PtyChunkTick>;
}

export interface ActivityEngineCallbacks {
  /** Fired every time the activity state actually changes (deduped). */
  onActivityChange(sessionId: string, activity: ActivityState, reason: ActivityReason): void;
  /**
   * Fired when the REASON changed kind but the activity did not, so a consumer
   * that renders the reason stays current through a long turn.
   *
   * Deliberately separate from `onActivityChange` rather than folded into it.
   * Everything hanging off that callback is written for a real transition and
   * pays a real cost per call: the telemetry snapshot writer does a synchronous
   * disk write, `getStatsSnapshot` slices a 1200-entry PTY window, and the
   * interval recorder opens and closes rows in `session_activity_intervals`.
   * A long turn raises the call count from about 3 per session to about 180, so
   * folding these together would charge all of that for a refresh whose only new
   * information is which reason to draw.
   *
   * Optional: a consumer that only cares about state transitions omits it.
   */
  onReasonChange?(sessionId: string, activity: ActivityState, reason: ActivityReason): void;
  /**
   * Fired when the engine itself originates a `SessionEvent` that did
   * not arrive from the JSONL stream (e.g. a watchdog-driven Idle event
   * carrying `detail: IdleReason.Timeout`). The caller is expected to
   * push this into the activity log so the user can see WHY the engine
   * transitioned.
   *
   * Always fires BEFORE the matching `onActivityChange` so listeners
   * see the log entry first.
   */
  onSyntheticEvent?(sessionId: string, event: SessionEvent): void;
  /**
   * Fired once when a turn the agent itself ended has fully settled: a
   * thinking-to-idle commit whose turn was cleared by the agent's turn-end hook
   * (`turnEndSource === 'stop'`), after any background work the turn left
   * holding the session has drained. A shell the agent marks as a service
   * (`markBackgroundShellsAsServices`) counts as drained: it no longer holds.
   * Never for an interrupt, a failed turn, an `idle_hint`, a PTY-silence or
   * watchdog idle, a resume's idle seed, or a permission prompt resolving to
   * idle.
   *
   * Always fires AFTER the matching `onActivityChange`, so a listener that
   * reads the session's activity sees `idle`. Optional: only the production
   * wiring consumes it (column automations and workflow steps).
   *
   * `turnStartedAt` is when the turn that just ended began
   * (`SessionEngineState.turnStartedAt`), or null when the engine never saw it
   * begin. `workSerial` is `SessionEngineState.workSerial` at the turn end: the
   * turn's identity, still current until the agent reports new work.
   */
  onTurnEnded?(sessionId: string, turnStartedAt: number | null, workSerial: number): void;
  /**
   * Fired each time the engine stamps `turnStartedAt`, with the stamp and what
   * set it (`TurnStartCause`). A consumer that ties something to the turn
   * (the transcript position a turn end reads its reply from) keys it on the
   * stamp, which the matching `onTurnEnded` reports back.
   *
   * Fires inside the engine's commit, so a listener does no I/O and must not
   * throw. Optional: only the production wiring consumes it.
   */
  onTurnStarted?(sessionId: string, turnStartedAt: number, cause: TurnStartCause): void;
}

/**
 * What stamped a turn's start:
 *
 * - `'seed'`: a fresh spawn seeded thinking, its prompt on the command line.
 * - `'idle'`: the session went from idle to thinking.
 * - `'plan-approval'`: an approved plan, where the turn's work starts again.
 */
export type TurnStartCause = 'seed' | 'idle' | 'plan-approval';

/**
 * Log-only events do NOT reset `lastSignalAt`, do NOT toggle
 * `turnActive`, and do NOT cause transitions. These fire unpredictably
 * (sometimes during true idle, e.g. Notification "Context getting full")
 * and treating them as alive signals would falsely keep idle sessions
 * in the thinking state.
 *
 * `EventType.ToolEnd` is deliberately NOT a member: a `PostToolUse` hook
 * is concrete proof the agent process is alive and progressing, which is
 * exactly what `lastSignalAt` tracks, so it must refresh the anchor (see
 * the regression-guard note where it would otherwise sit). The "fires
 * during true idle" worry does not apply to it: ToolEnd never toggles
 * `turnActive`, and refreshing `lastSignalAt` is inert unless a watchdog
 * hold is armed (`activity === 'thinking'`).
 */
export const LOG_ONLY_EVENTS = new Set<EventType>([
  EventType.SessionStart,
  EventType.SessionEnd,
  EventType.Notification,
  // idle_hint never resets lastSignalAt. Its only effect is a CONDITIONAL
  // turn-end handled explicitly in ActivityEngine.processEvent (clear
  // turnActive when no other holder remains). When the guard fails it is a
  // pure no-op, so the genuine work's stale-thinking anchor stays put.
  EventType.IdleHint,
  EventType.TeammateIdle,
  EventType.TaskCompleted,
  EventType.ConfigChange,
  EventType.WorktreeRemove,
  EventType.ModelStart,
  EventType.ModelEnd,
  EventType.ToolSelectionStart,
  // Plan approval bookkeeping. The markers are written by a hook while the
  // turn is held on a prompt, and the auto-approval follows the plan exit's
  // ToolEnd, which already refreshed the anchor. None is new work.
  EventType.PlanApprovalSent,
  EventType.PlanAutoApproved,
  EventType.ToolApprovalSent,
  // EventType.ToolEnd intentionally NOT here. A `PostToolUse` hook proves
  // the agent is alive, so it refreshes `lastSignalAt`. Re-adding it
  // reintroduces the false-idle-after-long-foreground-tool bug: a single
  // foreground tool (e.g. `npx playwright test`) longer than the 180s
  // stale-thinking timeout, emitting no nested hook signals, would hand the
  // turn off to the stale-thinking hold with an already-expired anchor and
  // force a false idle the instant it ends. Pinned by the
  // `session-016-false-idle-after-long-foreground-tool` trace fixture. It
  // still does not toggle `turnActive` (not in TURN_*_EVENTS).
  EventType.SubagentStop,
  EventType.BackgroundShellEnd,
]);

/**
 * Events that initiate a turn (transition idle/permission -> thinking
 * via `turnActive=true`).
 */
export const TURN_INITIATING_EVENTS = new Set<EventType>([
  EventType.ToolStart,
  EventType.Prompt,
  EventType.SubagentStart,
  EventType.Compact,
  EventType.WorktreeCreate,
  EventType.BackgroundShellStart,
]);

/**
 * Events that end the turn (transition thinking -> idle via
 * `turnActive=false`). SessionEnd is intentionally NOT here - it's
 * log-only; the session teardown path calls deleteSession explicitly.
 */
export const TURN_ENDING_EVENTS = new Set<EventType>([
  EventType.Idle,
  EventType.Interrupted,
  // A service/API error aborted the turn (Claude's StopFailure hook). Like
  // Interrupted, this clears turnActive regardless of subagentDepth - the whole
  // turn died - and routes through the Interrupted bypass (see processEvent).
  EventType.TurnFailed,
]);
