# Activity Detection

Kangentic tracks whether each agent session is **thinking** (working on a turn), **idle** (waiting for input or done), or in a **permission** state (paused awaiting user approval). This drives the task card spinner, the desktop "task done" notification, idle-timeout suspend, and auto-focus behavior.

## Why this matters

The "task done" notification is one of Kangentic's core differentiators. Agents that have started backgrounded work (`Bash(run_in_background:true)`) are still working until those processes exit, even after the agent's hook stream has gone quiet. A session that prematurely shows "idle" causes a false notification; one that's stuck in "thinking" never notifies at all. Both are user-visible bugs.

This subsystem aims to be near-100% accurate: notification fires within seconds of the agent (and all its background work) actually being done.

## Architecture

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  Agent CLI hook ↦ event-bridge.js ↦ events.jsonl                 │
   │  (each adapter wires its own hook flow; see below)               │
   └─────────────────────────────────┬────────────────────────────────┘
                                     │
                ┌────────────────────▼─────────────────────┐
                │  StatusFileReader (watches events.jsonl) │
                │  → SessionTelemetry.ingestEvents(events) │
                └────────────────────┬─────────────────────┘
                                     │
   ┌─────────────────────────────────▼──────────────────────────────────┐
   │              ActivityEngine (single-predicate state machine)        │
   │                                                                    │
   │   activity = 'permission' IFF permissionPending                    │
   │            = 'thinking'   IFF turnActive                           │
   │                              OR subagentDepth > 0                  │
   │                              OR backgroundShells > 0               │
   │            = 'idle'       otherwise                                │
   └─────────────────────────────────┬──────────────────────────────────┘
                                     │
                ┌────────────────────┼─────────────────┬──────────────┐
                ▼                    ▼                 ▼              ▼
   ┌───────────────────┐ ┌─────────────────────────┐ ┌────────────┐ ┌────────────┐
   │ Stability window  │ │ Watchdog table (5 holds)│ │ BgShell    │ │ Ctrl+C     │
   │ (400ms)           │ │ - bg-shell 5min + 30s   │ │ Watcher    │ │ synthesis  │
   │                   │ │ - stuck-tools  (5min)   │ │ (proc-tree)│ │ (3s settle)│
   │                   │ │ - stale-think  (180s)   │ │            │ │            │
   └───────────────────┘ └─────────────────────────┘ └────────────┘ └────────────┘
                                                          │
                                                          ▼
                                                ┌────────────────────┐
                                                │ ProcessTreeProbe   │
                                                │ Win: Get-CimInstance│
                                                │ POSIX: ps -A       │
                                                └────────────────────┘
```

## Key files

The engine itself is split across modules under `activity-engine/engine/`. External consumers import from `engine/index.ts`; internal modules are implementation details.

| File | Role |
|------|------|
| `src/main/activity-engine/engine/index.ts` | Public surface re-exports (`ActivityEngine`, `ActivitySnapshotWriter`, types, default constants) |
| `src/main/activity-engine/engine/activity-engine.ts` | Engine class - lifecycle + orchestration (delegates to the modules below) |
| `src/main/activity-engine/engine/shapes.ts` | `SessionEngineState`, `ActivityEngineOptions`, `TransitionRecord`, `PendingTool`, event sets, default thresholds |
| `src/main/activity-engine/engine/predicate.ts` | Pure `derivePredicate` / `deriveReason` / `deriveActivityAndReason` - no engine reference, no mutation |
| `src/main/activity-engine/engine/event-handlers.ts` | Pure `updateCounters` / `updatePermissionFlag` - the big switch on event type |
| `src/main/activity-engine/engine/counter-snapshot.ts` | `snapshotCounters` and `formatCounterDelta` for the audit log |
| `src/main/activity-engine/engine/state-factory.ts` | `createSessionEngineState` initial-state factory |
| `src/main/activity-engine/engine/watchdog.ts` | `WatchdogHold` table + `findActiveWatchdogHold` lookup - declarative safety nets |
| `src/main/activity-engine/engine/snapshot-writer.ts` | `ActivitySnapshotWriter` - atomic JSON snapshots for post-mortem diagnostics |

Surrounding infrastructure:

| File | Role |
|------|------|
| `src/main/activity-engine/session-telemetry.ts` | Wires the engine to event ingestion + PTY tracker + watchers + user-interrupt coordinator |
| `src/main/activity-engine/user-interrupt-coordinator.ts` | 3-second settle timer for Ctrl+C; synthesizes Interrupted if engine still hot |
| `src/main/activity-engine/usage-accumulator.ts` | Per-tool usage stats (call count, cost, tokens) |
| `src/main/activity-engine/pr-command-detector.ts` | PR command pattern detector |
| `src/main/activity-engine/pty-activity-tracker.ts` | PTY-byte fallback for non-hook agents |
| `src/main/activity-engine/background-shell/watcher.ts` | Process-tree-based natural-exit detector |
| `src/main/activity-engine/background-shell/process-tree.ts` | Cross-platform descendant enumeration; `listAllProcesses` shared once per cycle |
| `src/main/activity-engine/background-shell/resume.ts` | Resume-time orphan adoption |
| `src/main/activity-engine/background-shell/looks-like-shell-id.ts` | Shell-id shape gate |
| `src/main/agent/event-bridge.js` | Generic hook-to-JSONL bridge; decodes typed `<kind>:<base64(JSON)>` directives (extractTool, extractDetail, setTypeWhen, ...) built by `src/main/agent/shared/directive-builders.ts` |
| `src/main/agent/adapters/claude/hook-manager.ts` | Claude Code hook configuration |
| `src/shared/types.ts` | `ActivityState`, `ActivityReason`, `EventType`, `SessionEvent.toolId` |

## ActivityState

```ts
type ActivityState = 'thinking' | 'idle' | 'permission';
```

Three top-level states:

- **`thinking`** - agent is working. Spinner shown on task card. Notifications NOT fired.
- **`idle`** - agent is truly done. Notification fires. Auto-focus / auto-suspend can act. The
  desktop notify decision (cooldown, focus gate, active-project gate, title assembly) is owned by
  `src/main/notifications/desktop-notifier.ts`, which listens to `SessionManager`'s own `activity`
  event directly rather than a renderer round-trip.
- **`permission`** - agent paused awaiting user approval. Distinct from `idle` so the UI can render a different affordance (lock icon vs idle dot).

## ActivityReason (discriminated union)

Every transition emits both an `ActivityState` AND an `ActivityReason` describing WHY:

```ts
type ActivityReason =
  | { kind: 'idle'; since: number }
  | { kind: 'permission'; since: number }
  | { kind: 'tool';            pendingCount: number; currentTool: string | null }
  | { kind: 'subagent';        depth: number }
  | { kind: 'background-shell'; count: number; ids: readonly string[] }
  | { kind: 'turn-active' };
```

`since` (epoch ms) is `SessionEngineState.needsUserSince`: when the session FIRST entered a
needs-user state. It spans both `idle` and `permission` - a `permission <-> idle` crossing keeps
the original park time rather than resetting it - and is cleared only on returning to `thinking`.
The renderer uses it to show elapsed wait time ("Idle for 12m") in the TaskCard hover tooltip
(`formatActivityReasonText` / `ActivityReasonTooltip` in
`src/renderer/components/board/ActivityReasonTooltip.tsx`).

The renderer uses `reason.kind` to pick a Lucide icon (Wrench / Users / Terminal / Lock / Loader2 / Mail) and inline label for the TaskCard hover tooltip.

### Durable activity-interval history

The engine's own state is in-memory only - `needsUserSince` (and every other field) is lost on
`deleteSession()` / app restart, and `events.jsonl` records raw hook events, not committed
transitions, so it is neither a faithful nor a reliably-retained substitute (a raw `idle` event
cancelled by the 400ms stability window still appears there with no matching state change, and a
watchdog-synthesized idle commits with no raw event at all).

`src/main/activity-engine/activity-interval-recorder.ts` durably records every committed
`ActivityDisposition` transition (`shared/activity-state.ts`'s `dispositionOf` - `'active'` for
`thinking`, `'idle'` for both `idle` and `permission`) to the per-project
`session_activity_intervals` table (migration in `src/main/db/migrations/project-schema.ts`,
alongside `conversation_turn_usage`), one row per interval (not per transition - a
`permission <-> idle` crossing shares the `'idle'` disposition, so it does not close and reopen a
row). Symmetric by design: both dispositions are recorded directly rather than deriving "active
time" as the inverse of "idle time", which would need exact session-boundary reconciliation
across resumes/suspends and would silently break on a crash-orphaned open row. Each row carries
the engine's own `enter_trigger` / `exit_trigger` labels, so a consumer can distinguish a
hook-authoritative park (`event:idle`) from a watchdog guess (`timer:stale-thinking`), and a
genuine human reply (`event:prompt`) from the agent resuming itself
(`event:prompt:pty-activity`, `force-thinking`). `started_ms`/`ended_ms` (epoch integers, used by
the `duration_ms` arithmetic and the `started_ms` index) are mirrored by `started_at`/`ended_at`
(TEXT UTC ISO 8601, per `.claude/rules/utc-timestamps.md`) - the store derives the mirror from the
same value it writes to the `_ms` column, so the two can never drift. Read via the
`kangentic_get_activity_intervals` MCP tool (see `docs/mcp-server.md`) or `kangentic_query_db`. No
desktop-facing IPC endpoint exists yet.

Priority ladder: `permission > tool > subagent > background-shell > turn-active > idle`. Anchored to `state.activity` for consistency - when forced paths (Interrupted, forceIdle) commit a transition that diverges from the bare predicate (e.g. clearing all counters on Esc), the reason follows the committed state.

## EventType reference

The 24 `EventType` values written to `events.jsonl` by `event-bridge.js`, defined in `src/shared/types.ts`. The activity column shows how each event maps to `ActivityState` via the `EventTypeActivity` table, also in `src/shared/types.ts`.

| EventType key | JSONL value | Activity mapping | Notes |
|---------------|-------------|------------------|-------|
| `Prompt` | `prompt` | `thinking` | User submitted a prompt; agent is starting a turn |
| `ToolStart` | `tool_start` | `thinking` | Agent began invoking a tool |
| `ToolEnd` | `tool_end` | log-only | Tool returned; counters update and `lastSignalAt` refreshes (a `PostToolUse` hook proves the agent is alive, so `tool_end` is NOT in the engine's `LOG_ONLY_EVENTS` set), but the activity state does not change |
| `Idle` | `idle` | `idle` | Agent finished its turn (Stop hook, prompt-regex, or silence timer) |
| `Interrupted` | `interrupted` | `idle` | User pressed Esc / Ctrl+C; clears counters and commits idle |
| `TurnFailed` | `turn_failed` | `idle` | Turn aborted by a TERMINAL service/API error (Claude's `StopFailure` hook, which fires instead of `Stop`); `detail` carries the error type (e.g. `authentication_error`). Routed through the Interrupted bypass: clears counters and commits idle immediately (see "Aborted-turn recovery") |
| `TurnRetrying` | `turn_retrying` | conditional idle | `StopFailure` fired for a TRANSIENT, auto-retried error (overloaded/server_error/rate_limit/api_error), classified at the source (like `IdleHint`). Holds the session `thinking` through a live retry (deferring to the 180s stale-thinking watchdog); idles immediately if the turn had already wound down or ended (see "Aborted-turn recovery") |
| `SessionStart` | `session_start` | log-only | Session began; carries adapter session metadata |
| `SessionEnd` | `session_end` | log-only | Session ended (CLI process exited) |
| `SubagentStart` | `subagent_start` | `thinking` | Main agent spawned a child agent |
| `SubagentStop` | `subagent_stop` | log-only | Subagent returned; depth counter decrements - EXCEPT an empty-string `detail` ("") which is a spurious inner-loop stop and is ignored (see "Subagent depth") |
| `Notification` | `notification` | log-only | Informational notification from the agent |
| `IdleHint` | `idle_hint` | conditional idle | "Waiting for your input" notification, classified at the source. Ends the turn only when no other holder remains; otherwise log-only (see "Idle hints" below) |
| `Compact` | `compact` | `thinking` | Context-window compaction in progress |
| `TeammateIdle` | `teammate_idle` | log-only | Cross-agent teammate signaled idle |
| `TaskCompleted` | `task_completed` | log-only | Agent declared the task finished |
| `ConfigChange` | `config_change` | log-only | Agent settings/model changed mid-session |
| `WorktreeCreate` | `worktree_create` | `thinking` | Agent created a git worktree |
| `WorktreeRemove` | `worktree_remove` | log-only | Agent removed a git worktree |
| `BackgroundShellStart` | `background_shell_start` | `thinking` | `Bash(run_in_background: true)` launched, or a foreground Bash auto-backgrounded on timeout (its `tool_response` carries a shell id) |
| `BackgroundShellEnd` | `background_shell_end` | log-only | `KillBash` invoked, a watcher-inferred natural exit, or the watcher's transcript drain observing a tracked shell's terminal `<task-notification>` directly in the durable session transcript; decrements active-shells counter |
| `ModelStart` | `model_start` | log-only | LLM API call beginning (Qwen/Gemini per-call telemetry) |
| `ModelEnd` | `model_end` | log-only | LLM API call returned |
| `ToolSelectionStart` | `tool_selection_start` | log-only | Agent is choosing the next tool |

"log-only" means the event is recorded for the activity feed and may update internal counters, but does not on its own change `ActivityState`. State changes only occur through the predicate (see below) or via direct `Idle` / `Interrupted` events.

### Idle hints (waiting-for-input notifications)

Some turns end without a `Stop`/`Idle` hook ever reaching the main agent - most commonly when the whole turn was delegated to a subagent. When the subagent stops, `subagentDepth → 0` but `turnActive` is still `true`, and the only thing that arrives is a `Notification` ("Claude is waiting for your input"). Because `Notification` is log-only, nothing clears `turnActive`, and the session stays `thinking` until the 180s stale-thinking watchdog fires - the user sees the spinner spin ~3 minutes after the agent is actually done.

`idle_hint` closes that gap. The classification happens **at the source, not in the engine**: the Claude adapter's `Notification` hook carries a generic `setTypeWhenDetailContains('waiting for your input', EventType.IdleHint)` directive (the only Claude-specific string), so `event-bridge.js` rewrites the matching notification's `type` to `idle_hint`. The match runs on the already-extracted `detail` text (empirically "Claude is waiting for your input"), so it does not depend on which payload field carried the message. The engine never string-matches notification text and never branches on agent name.

The engine treats `idle_hint` as **conditionally** turn-ending (`idleHintEndsTurn` in `predicate.ts`): it clears `turnActive` only when `turnActive && pendingToolCount === 0 && subagentDepth === 0 && bgShellCount === 0 && !permissionPending`. When the guard passes, the predicate flips to idle through the normal 400ms stability window (near-instant for the user). When it fails - tools, subagents, or background shells still outstanding, or a permission pending - `idle_hint` does NOT clear `turnActive` (a notification that fires mid-turn never short-circuits genuine work), but it is no longer a complete no-op: it sets `idleHintPending`, which shortens the stuck-subagent and stuck-pending-tools watchdogs (see "Aborted-turn recovery" below). `idle_hint` is in `LOG_ONLY_EVENTS`, so it never resets `lastSignalAt` (a failed guard leaves the genuine work's watchdog anchor untouched).

**Why the substring is deliberately narrow.** A scan of 221 real Claude sessions surfaced exactly four distinct notification texts: "Claude is waiting for your input" (794x), "Claude Code needs your approval for the plan" (109x), "Claude Code needs your attention" (43x), and "Claude needs your permission[ to use X]" (51x). Only the first fires for a pure turn-end whose `Stop` hook can be dropped. The other three each fire ~6s AFTER a `PermissionRequest` (tool permission, ExitPlanMode plan approval, or AskUserQuestion) has already driven the engine to the `permission` state, so they are correctly left log-only - reclassifying any of them would conflate `permission` with `idle`. The negative cases are pinned with the real strings in `tests/unit/event-bridge-remap.test.ts`.

Only the Claude adapter wires this today, because Claude is the only agent for which we have captured evidence (a real session) of both the notification text and the dropped-Stop failure mode (a turn fully delegated to a subagent). The engine path is generic: any adapter that classifies a notification into `idle_hint` gets the same behavior.

To extend it to another hook-based agent, capture a real session that exhibits the stall, read the notification's extracted `detail`, then add a `setTypeWhenDetailContains('<observed substring>', EventType.IdleHint)` directive (built via the typed builder in that adapter's hook-manager, never hand-authored) to that adapter's Notification hook. Do not guess the string. Current status of the other agents:

- **Gemini / Qwen Code** share the same hook shape (`AfterAgent` -> `idle` stop-equivalent, `Notification` -> `notification`), so they could be susceptible. But they wire no `SubagentStart`/`SubagentStop` hooks, so the subagent-delegation failure mode is not modeled, and we have no captured session to confirm their notification text. Wire only after capturing evidence.
- **Kimi** does not need this: its wire protocol emits an explicit `TurnEnd -> Idle`, and none of its `Notification`-mapped messages mean "waiting for input."
- **Codex / Copilot / OpenCode** wire no Notification hook, so the pattern cannot apply.

### Aborted-turn recovery (service errors)

When a service/API error (rate limit, overload, server error) disrupts a turn, a subagent's NAMED terminal `subagent_stop` or a tool's `tool_end` can be lost, so `subagentDepth` or `pendingToolCount` stays > 0 and the board shows the task `thinking` while the agent is actually parked at the prompt. There are three distinct failure modes, and a layer for each.

**Layer A - the idle-hint-shortened watchdog (the validated fix for #277).** In the captured #277 incident the stuck counter came from a subagent whose named stop was dropped, while the **parent turn kept running normally** - each later turn ended with a real `Stop` (an `idle` event, swallowed by the stuck counter) plus an `idle_hint`, and **no `StopFailure` was ever emitted** (the `idle` events confirm the turns ended via `Stop`, not an abort). To recover this, an `idle_hint` ("waiting for your input") arriving while a counter is still stuck > 0 sets `idleHintPending`, which drops the `stuck-subagent` and `stuck-pending-tools` holds from the 5-min `bgShellEscapeHatchMs` cap to the validated stale-thinking budget (`staleAfterIdleHintMs`, default 180s). The hold **anchor is unchanged** (`signal-or-pty-output`): a top-level `idle_hint` can fire while a subagent is genuinely live (the notification fires outside the main agentic loop - task #237 / session-018), so this only shortens the timer; a live subagent keeps streaming PTY output, which defers it, and its named stops arrive while it works. `idleHintPending` is cleared by the next turn-initiating event and by any reset (bypass / force-*), and is surfaced on `ActivityStatsSnapshot` for the debug overlay.

**Layer B - the structured `StopFailure` signal, terminal case.** A *different* mode is a turn that an API error terminates outright: Claude Code fires a `StopFailure` hook *instead of* `Stop` (`code.claude.com/docs/en/hooks`, added in CLI 2.1.78), so that turn's closing hooks never run. The Claude adapter's hook-manager wires `StopFailure` to emit `turn_failed` by default, carrying the error type (Claude's `error` / `error_details` fields) in `detail`. The engine treats `turn_failed` like `Interrupted` (it is in `TURN_ENDING_EVENTS` and routes through `applyInterruptedBypass`): all counters reset and the session commits idle immediately, with the error type preserved in the transition trigger (`event:turn_failed:<error>`) - distinct from a user-`Esc` `interrupted`.

**Layer C - the structured `StopFailure` signal, TRANSIENT case (`turn_retrying`).** Claude Code also fires `StopFailure` for a **transient, auto-retried** error - 529 overloaded / `server_error` / `rate_limit` / `api_error` - not only a final abort. During the retry backoff the turn is still alive, but before this layer the engine treated every `StopFailure` identically (Layer B's immediate `applyInterruptedBypass`), force-idling a task mid-retry with no safety net to revive it (no PTY output, no output-token growth during backoff). Confirmed empirically by replaying the real captured `events.jsonl` from kangentic.com Task #43 (session `fc2f1446`) through the actual `ActivityEngine`: the committed disposition was `idle` for the whole ~166s retry window, driven by `event:turn_failed:server_error`.

The fix classifies the error at the **source, not the engine** (mirroring the `IdleHint` precedent): the Claude adapter's `StopFailure` directive reclassifies a transient error's already-extracted `detail` into the generic `turn_retrying` event via chained `setTypeWhenDetailContains` directives (`overloaded`, `server_error`, `rate_limit`, `api_error`), leaving `turn_failed` for everything else. The engine then decides liveness with `idleHintPending` as the discriminator (the same field Layer A uses) - this is what keeps Layer B's #277 fixture correct while fixing the new bug:

- **Live retry** (`!idleHintPending && turnActive`, e.g. an open tool/subagent, no preceding "waiting for input"): `applyRetryableFailureHold` resets the in-flight counters (decoupled cleanup, same reset as `applyInterruptedBypass`) but KEEPS `turnActive`, so the session stays `thinking` and `turnActive` becomes the sole watchdog holder. `turn_retrying` is NOT in `LOG_ONLY_EVENTS`, so each retry refreshes `lastSignalAt` - the existing 180s stale-thinking watchdog therefore fires ~180s after the LAST retry (not the first), only if the turn genuinely never resumes. A backoff shorter than 180s (the fc2f1446 incident's gap was ~148s) never false-idles.
- **Wound-down or already-ended turn** (`idleHintPending`, e.g. session-019's shape, or `!turnActive`): treated exactly like a terminal `turn_failed` - `applyInterruptedBypass` idles immediately.

**Preventing a parked-repaint regression (#294/#364 class).** During a live-retry hold, neither existing "believed parked" signal (`idleHintPending`, `turnForcedByHeartbeat`) is set, so the stale-thinking hold would keep its `signal-or-pty-output` anchor - a parked-TUI "retrying in Ns..." repaint streams real PTY bytes and would defer the 180s net forever if the error turns out to be terminal. `applyRetryableFailureHold` sets a new provenance flag, `retryFailurePending`, added to `watchdogBaseTime`'s `believedParked` check alongside the other two, so the hold narrows to its `signal` anchor during a retry hold exactly as it does for `idleHintPending`. Cleared by the same events that clear `idleHintPending`: a genuine turn-initiating event, the bypass/hold reset, and `forceThinking`/`forceIdle`.

Empirical basis: task #277 (session `27582968`) held `thinking` for ~560s after the agent was idle; the condensed stream is pinned in `tests/fixtures/replay/session-019-service-error-stuck-subagent.jsonl` (its "without turn_failed" assertion reproduces the real stuck-thinking bug). Task #43 (session `fc2f1446`) held `idle` for ~166s during a live API retry; the condensed stream is pinned in `tests/fixtures/replay/session-023-false-idle-server-error-retry.jsonl`. The timer-driven recovery for both (which the fast-time replay harness cannot advance) is covered in `tests/unit/activity-engine.test.ts` ("aborted/errored-turn recovery" and "turn_retrying").

## ActivityDetectionStrategy variants

Each adapter declares one strategy via its `runtime.activity` field (constructed through the `ActivityDetection` factory). The three variants:

| Kind | Hooks fire? | PTY fallback? | Used by | Semantics |
|------|-------------|---------------|---------|-----------|
| `hooks` | Yes (sole source of truth) | No | Claude Code | Activity state is driven exclusively by hook deliveries. PTY traffic is ignored for state transitions. |
| `pty` | No | Yes | Aider, Cursor, Warp, Droid, Codex, Kimi (today) | No hook protocol available. The PTY tracker emits `forceIdle` after a silence window, optionally short-circuited by an adapter-supplied `detectIdle(data)` regex that matches the agent's input prompt. Kimi gets authoritative `TurnBegin`/`TurnEnd` transitions from `runtime.sessionHistory` (wire.jsonl), not the hook pipeline. |
| `hooks_and_pty` | Yes (primary) | Yes (fallback) | Gemini, Qwen, OpenCode, Copilot | Hooks are authoritative when they fire; the PTY tracker is auto-suppressed on the first hook event and re-engages only if hooks stop arriving. |

Both `pty` and `hooks_and_pty` may pass an optional `detectIdle(data: string) => boolean` for instant idle detection from the input-prompt regex. Without it, idle is inferred from a silence timer.

## Predicate

The engine exposes ONE predicate:

```
'thinking' IFF turnActive
            OR subagentDepth > 0
            OR (activeBackgroundShellIds.size + anonymousBackgroundShellCount) > 0
'permission' IFF permissionPending
'idle' otherwise
```

Notably absent: `pendingToolCount` is NOT in the predicate. An explicit `Idle` event (Stop hook) must transition to idle even if a tool's PostToolUse never arrived. `pendingToolCount` only drives the `'tool'` reason for UI tooltips.

### turnActive

Set on any "thinking-initiating" event (`ToolStart`, `Prompt`, `SubagentStart`, `Compact`, `WorktreeCreate`, `BackgroundShellStart`). Cleared by `Interrupted`, and by `Idle` **only when `subagentDepth === 0`** (an `Idle` arriving while a subagent is live is the subagent's own inner Stop and must not end the parent turn - see [Subagent depth](#subagent-depth)). Also re-armed when a permission pause resolves (see [Permission flag](#permission-flag)). Persists across the silent gaps between tool calls so the spinner doesn't flicker.

### Subagent depth

Tracks nested subagent invocations. `SubagentStart` increments; a `SubagentStop` decrements (clamped to 0), **except a `SubagentStop` whose `detail` is the empty string `""`, which is ignored** (it bumps the `ignoredInnerSubagentStop` compensation counter instead). A subagent runs synchronously inside the parent's turn, so when its inner loop finishes it fires a `Stop` hook (mapped to `Idle`) **while it is still tracked as live**. That `Idle` is the subagent's, not the parent's: the engine therefore does NOT clear the parent's `turnActive` when `subagentDepth > 0` (the parent is blocked on / about to consume the subagent result and has not finished). The parent's own Stop arrives only after every subagent has returned (i.e. at `subagentDepth === 0`), and that is the `Idle` that clears `turnActive`.

Why the empty-string skip: a real capture (session `87524f38`, task #234 running 3 parallel `Explore` agents then a `Plan` agent) showed every subagent emit **two** stops - a spurious empty-detail (`detail: ""`) inner-loop stop when its inner turn ends, then its authoritative **named** terminal stop (`detail: "Explore"` / `"Plan"`) when the Task tool returns. Counting the empty inner stops drove `subagentDepth` to 0 while subagents were still live, so a later real `Idle` (an Explore inner stop) or `idle_hint` ("waiting for your input", the ~69s Plan window) ended the parent turn early - the board went idle for the tail of the run (task #237, the inverse of a false-active). Ignoring the empty-string inner stops keeps `subagentDepth` accurate so the depth-0 gates above do their job. The guard is strictly `detail === ''`: a detail-**less** stop (no `detail` field, e.g. `session-008`'s hand-crafted stream) and a named stop are real terminal stops and still decrement. Pinned by the `session-017-false-idle-during-live-subagent` (the earlier ordering) and `session-018-parallel-subagent-false-idle` (the harder ordering, this fix) replay fixtures; the raw hook payloads confirm a subagent-context Stop carries `agent_id` while the main-agent Stop does not.

### Background-shell tracking (Set + anonymous fallback)

Two storage modes:

- **`activeBackgroundShellIds: Set<string>`** - when the hook directive extracted a `shell_id` (today: KillBash events), the engine tracks shells by id. `markBackgroundShellEnded(sessionId, shellId)` removes the matching id.
- **`anonymousBackgroundShellCount: number`** - fallback for shells whose start-event lacked a shell_id (the common case today; production hooks emit the command string as detail, not a shell_id). The watcher's count-based heuristic decrements this.

The predicate uses `set.size + anonymousCount > 0` so both modes coexist.

### Permission flag

Set when an `Idle` event fires with `detail: 'permission'`. The engine also records `permissionAwaitedToolId` - the correlation id at the top of `pendingToolStack`, i.e. the tool the prompt was raised for (permission prompts fire between PreToolUse and execution, and permission idles leave the stack intact). Cleared by:
- `Prompt` (user typed something new)
- `Interrupted` (Esc)
- `SubagentStart` (main agent spawning a child)
- `Idle` with non-permission detail (agent ended turn)
- `ToolStart`/`ToolEnd` at `subagentDepth === 0` (main agent activity)
- `ToolStart`/`ToolEnd` carrying `permissionAwaitedToolId`, at ANY depth (the prompt was approved and that exact tool ran - e.g. a tool inside a subagent; without this the flag stays stuck until the subagent stops, since the PTY net deliberately exempts `'permission'`)

Unrelated subagent-tool events at depth>0 (different or absent toolId) do NOT clear permission (parallel-subagent tool churn must not dismiss a prompt that is still awaiting approval). The approved-tool clear is pinned by the `session-010` replay fixture (task #194's stuck 77s window).

**Resume restores `turnActive`.** A permission pause begins with `Idle{detail:'permission'}`, which clears `turnActive` (Idle is a turn-ending event). When the pause resolves, the wake is typically a depth-0 `ToolEnd` (e.g. the `AskUserQuestion` / `ExitPlanMode` tool ending after the user answers/approves) - a non-turn-initiating event that clears `permissionPending` but does not re-arm `turnActive`. The resumed turn emits no fresh `Prompt`/`ToolStart` hook, so without intervention the predicate would see no holder and drop to **idle** until the PTY force-thinking net catches up seconds later. To avoid that, `processEvent` restores `turnActive = true` whenever `permissionPending` transitions `true -> false` on a non-turn-ending event (i.e. not `Idle`/`Interrupted`, which are genuine end-of-turn). This is classified by the generic permission-clear shape, not by tool or agent name, so it covers every permission-class pause. Pinned by the `session-006`/`session-007` replay fixtures.

### Tool tracking (stack with correlation IDs + LIFO-by-name fallback)

`pendingToolStack: Array<{ id?: string; name: string }>` records in-flight tools in start order. `currentTool` always reflects the top of the stack and is exposed via `ActivityReason` for the TaskCard hover tooltip ("Running Bash").

ToolEnd matching priority:
1. **By correlation id** - when both events carry `event.toolId` (Claude's `tool_use_id` extracted via the `extractToolId` directives, top-level and nested), exact removal regardless of stack position. Solves the duplicate-name and out-of-order cases.
2. **LIFO-by-name** - fallback when an event has no toolId or the id didn't match (drift recovery from hook drop or version skew).
3. **Raw pop** - fallback for `Interrupted` (no tool name carried).

Hard reset on `pendingToolCount === 0`: the stack is cleared even if name desync left dangling entries. Idle events also clear the stack (see "Idle clamp" below).

Adapters opt into ID correlation by adding `extractToolId(['<field>'])` and `extractToolId(['<field>'], { nested: '<parent>' })` directives to their hook config. Adapters without correlation IDs leave `event.toolId` undefined and the engine falls back to LIFO-by-name automatically - no breaking change.

### Idle clamp

When a non-permission `Idle` event arrives, the engine forcibly clears `pendingToolCount`, the stack, and `currentTool`. The agent's turn is done; any unmatched ToolStart events are stale by definition (PostToolUse hook dropped, tool force-killed, etc.).

Permission idles bypass the clamp because the agent paused awaiting approval and may resume the same tool.

## Stability window (400ms)

When the predicate flips from `thinking` to `idle` due to a Stop event or a counter clearing, the engine waits 400ms before emitting the transition. If a thinking signal arrives during the window, the pending idle is cancelled. Prevents `idle → thinking → idle` flicker from out-of-order hook arrivals.

Bypassed by:
- `Interrupted` (Esc - instant, no flicker concern)
- `forceIdle` (PTY-driven; already debounced 3s in PtyActivityTracker)
- Stale-thinking watchdog (already 180s)

Configurable via `ActivityEngineOptions.idleStabilityWindowMs`. Tests set this to 0 for deterministic timing.

## Five safety nets (the watchdog table)

The predicate handles the common case. Five timer-driven safety nets in `engine/watchdog.ts` catch hook-loss / orphan situations. Each is a `WatchdogHold` describing a state shape, threshold, timer anchor (a `WatchdogAnchor`: which timestamp the deadline is measured from), reset action, and audit-log label. `findActiveWatchdogHold(state, holds)` picks the matching one each cycle (first match wins).

### 1. Named bg-shell sole-holder cap (5 min)

Once the turn is over and a NAMED background shell (`activeBackgroundShellIds`, declared by a `background_shell_start` hook with a shell_id) is the only holder of `thinking`, the engine reclaims it at the long 5-min cap (`timer:bg-shell-hatch`). A named shell is positive evidence of real agent-initiated work, so absence of watcher confirmation must EXTEND, not shorten, the hold. It is reclaimed sooner by positive exit evidence (a `BackgroundShellEnd` event or a Tier A PID death) or held active indefinitely by the watcher confirming its PID alive each cycle (`markBackgroundShellsAlive`, see below). The reset clears the bg-shell counters and emits idle through the stability window.

The deadline is anchored to when bg shells became the sole holder (`bgShellHoldSince`; `anchor: 'bg-shell-hold-since'`), NOT to `lastSignalAt`. An earlier design had the watcher refresh `lastSignalAt` every 2s while it saw any shell-like descendant; for an orphan whose exit the watcher could not attribute, that pulse pushed the deadline out forever and pinned the session `active` indefinitely (tasks #175/#180). Anchoring to the hold-start makes the deadline immovable by signal-only keep-alives; only watcher-confirmed liveness (`markBackgroundShellsAlive`) advances it. The original design used a single 30s grace for ALL bg shells, which false-idled a genuinely-running 10-min E2E at turn end when the watcher could not confirm it alive (tasks #210/#212); splitting named (5-min cap, Tier A liveness) from anonymous (30s grace) fixed that.

### 2. Anonymous bg-shell sole-holder grace (30s)

When only ANONYMOUS bg shells (`anonymousBackgroundShellCount`, no shell_id) hold `thinking` and the turn is over, the engine reclaims them after a short 30s grace (also `timer:bg-shell-hatch`). Anonymous shells are heuristic adoptions (resume-time descendants with no `background_shell_start` hook), so fast reclaim stays correct. Same anchor (`'bg-shell-hold-since'`) and reset as the named cap; only the threshold differs. The watcher's attributed drain (`onNaturalExit`, ~4s) still wins for clean exits; the grace is the backstop for the unattributable case.

### 3. Stale-thinking watchdog (180s)

Held by `turnActive` alone (no tools, no subagent, no bg shells) for 180 seconds. The matching Idle/Stop hook never arrived. Emits synthetic `Idle/Timeout`, clears `turnActive`. Bypasses the stability window (the 180s already debounced any flicker). Anchored to the FRESHER of `lastSignalAt` and `lastPtyOutputAt` (`anchor: 'signal-or-pty-output'`, resolved in `watchdogBaseTime`). `lastSignalAt` is refreshed by every non-log-only event - including `tool_end` (a `PostToolUse` hook is proof of liveness), so a foreground tool longer than 180s that ends while the turn continues gets a fresh window instead of being force-idled the instant it ends (task #229; pinned by `session-016-false-idle-after-long-foreground-tool`). `lastPtyOutputAt` is refreshed by `markPtyOutput` (called unconditionally on every PTY chunk by the spawn flow), so a single heavy generation turn that streams output for >180s with no nested hook event and a silent status heartbeat is not force-idled either (task #246; pinned by `session-019-false-idle-tool-less-streaming-gap`). A genuinely-finished turn sits at a quiet prompt with no PTY data (a blinking cursor is xterm-rendered terminal state, not a PTY chunk), so the anchor freezes and the safety net still fires at the threshold.

**Exception while the agent is BELIEVED parked (`parkedAnchor: 'signal'`).** A parked Claude TUI keeps repainting its statusline (rate-limit / context meter, spinner) = real PTY bytes, so the `signal-or-pty-output` anchor stays fresh forever and the net never fires - the safety net is blinded by the same parked-TUI behavior. The hold narrows its anchor to `signal` (`lastSignalAt` only, ignoring `lastPtyOutputAt`) while ANY of three "believed parked" signals holds:

- `idleHintPending` - the agent reported waiting-for-input, so its repaints are noise (task #294). Paired with the heartbeat no longer refreshing `lastSignalAt` while `idleHintPending` (see [Heartbeat recovery and idle provenance](#heartbeat-recovery-and-idle-provenance)), `lastSignalAt` freezes at the last genuine hook and the 180s net self-heals a stuck `turnActive` from any cause.
- `turnForcedByHeartbeat` - the CURRENT `turnActive=true` was set by the status-heartbeat's `forceThinking(sessionId, true)` (output-token growth while idle) and has not since been confirmed by a real turn-initiating hook. A `--resume` resume-picker context-reload is a CLI-internal turn that fires NO turn hooks, so it can NEVER produce an `idle_hint` when it parks - the `idleHintPending` gate alone cannot help, and a chatty parked TUI (statusline repaints with no gap exceeding 180s) would otherwise pin the card ACTIVE indefinitely (task #364, the residual leg task #331 left open). `turnForcedByHeartbeat` is set only by the heartbeat's `forceThinking` call and cleared by every real turn-initiating hook, the permission-resume path, every turn-end, and every turn-ending watchdog reset - mirroring `idleAuthoritative`'s provenance discipline for the active-turn side. (The bg-shell escape hatches do not touch it: their predicate already requires `!turnActive`, so it is `false` before they fire.) The PTY tracker's `forceThinking` callers (non-hooks agents) leave it `false`, so their `lastPtyOutputAt` liveness anchor is never narrowed away.
- `retryFailurePending` - the session is in a LIVE `turn_retrying` hold (`applyRetryableFailureHold`, see "Aborted-turn recovery" Layer C below): a parked-TUI "retrying in Ns..." repaint during the retry backoff is noise the same way, and must not defer the net forever if the error turns out to be terminal (task #367). Set only by `applyRetryableFailureHold` and cleared the same way as `idleHintPending` - by every real turn-initiating hook, the bypass/hold reset, and `forceThinking`/`forceIdle`.

Any of the three freezes the anchor at the last genuine hook / output growth / retry signal, so the 180s net still fires ~180s after real activity stopped. A live long-generation turn never fires `idle_hint`, is never heartbeat-forced, and is never in a retry hold (it is thinking via a real turn hook), so it keeps the `signal-or-pty-output` anchor and the PTY keeps it alive (#246).

**Fast heal for the heartbeat-forced case (30s, not 180s).** Freezing the anchor is only half the fix for `turnForcedByHeartbeat`: `lastSignalAt` is frozen at the moment output stopped growing, but the hold still waited the general 180s from there before task #331/#364's follow-up. A hook-less `--resume` resume-picker turn is a distinct class from a genuine `idle_hint`/`retryFailurePending` parked turn - it can never receive ANY confirming hook, so once `lastSignalAt` freezes there is nothing further to wait for. The stale-thinking hold's `effectiveThreshold` therefore checks `state.turnForcedByHeartbeat` FIRST (before the `idleHintPending` short grace) and, when set, uses `DEFAULT_STALE_AFTER_HEARTBEAT_FORCED_MS` (30s) instead of `staleThinkingTimeoutMs` (180s). The anchor is unchanged (still `signal`), so this only shortens how long the net waits once frozen - a live reload that is still genuinely generating keeps refreshing `lastSignalAt` via output-token growth and never reaches the grace. The 30s value is reasoned, not empirically calibrated: it is safe because a too-aggressive heal self-corrects (the next output-growth status write re-triggers `forceThinking(sessionId, true)` via the same idle → thinking heartbeat recovery), so the worst case is a brief idle blip, not a stuck-wrong state. Reuses the stale-thinking hold's `timer:stale-thinking` trigger and `staleThinking` counter rather than adding a new one - a trace cannot distinguish the fast 30s heal from the slow 180s net except by the transition's timestamp relative to when output froze. Pinned by `session-024-fast-heal-hook-less-resume` (enabled vs. disabled-grace red-green) and `session-022-false-active-repainting-past-180s` (updated to assert the tighter 30s deadline).

### 4. Stuck-pending-tools watchdog (5 min)

Held by `pendingToolCount > 0` alone for 5 minutes. Common cause: user pressed Ctrl+C, the agent killed the bash, but `PostToolUseFailure` didn't propagate. Without this hatch the engine would be stuck in `thinking` forever - the stale-thinking watchdog requires `pendingToolCount === 0` to fire, the bg-shell holds require bg shells, and the Idle clamp only works when Idle actually fires.

Resets `pendingToolCount`, the stack, `currentTool`, AND `turnActive` (the matching Stop hook for this turn was lost along with the PostToolUse). Goes through the stability window for the same reason as the bg-shell holds.

This hold is anchored to the FRESHER of `lastSignalAt` and `lastPtyOutputAt` (`anchor: 'signal-or-pty-output'`, resolved in `watchdogBaseTime`). A long quiet foreground tool (a single test run streaming output for >5 min with no nested hook events and a silent status heartbeat) used to be force-idled here, because for hooks-based agents the `PtyActivityTracker` is suppressed and PTY data never refreshed `lastSignalAt` (task #210, empirical `stuckPendingTools: 2`). `markPtyOutput` (called unconditionally on every PTY chunk by the spawn flow) refreshes `lastPtyOutputAt`, so streaming TUI output keeps a genuinely-running tool active; after Ctrl+C / a lost PostToolUse the CLI sits at a quiet prompt, output stops, and the hatch fires 5 min after the last chunk.

### 5. Stuck-subagent watchdog (5 min)

Held by `subagentDepth > 0` alone (no pending tools, no bg shells, no permission) for 5 minutes. Because the empty-string inner-stop skip (see "Subagent depth") makes `subagentDepth` sticky, a subagent whose authoritative **named** terminal `SubagentStop` is dropped (only its ignored empty inner stop arrived) would leave depth stuck > 0 forever: every other watchdog hold gates on `subagentDepth === 0`, and the `PtyActivityTracker`'s `forceIdle` (which zeroes depth) is suppressed for hook-active agents. This hold is the only recovery. It resets `subagentDepth` (and `turnActive`) and emits synthetic `Idle/Timeout`. Anchored to `signal-or-pty-output` and capped at the long 5-min threshold, so a genuinely live subagent - which refreshes the anchor via its nested tool events and streaming output - never trips it; it fires only after a real, long silence. Disjoint from the holds above by its `subagentDepth > 0` predicate. Tallied as the `stuckSubagent` compensation counter (task #237).

### Adding a new watchdog

Append to the table in `buildWatchdogHolds()`:

```ts
{
  predicate: (state) => /* what state shape qualifies as stuck */,
  thresholdMs: config.someThresholdMs,
  trigger: 'timer:my-watchdog',
  anchor: 'signal', // WatchdogAnchor: which timestamp gates the deadline
  reset: (state) => { /* mutations to clear the hold */ },
  applyStabilityWindow: true,
}
```

The predicates partition the state space, so `findActiveWatchdogHold` returns the first match. Each hold declares its timer anchor explicitly via the `anchor` field, and `watchdogBaseTime` (plus `scheduleTimer`'s `bgShellHoldSince` maintenance) dispatches on it; a new `WatchdogAnchor` kind is a compile-time error rather than a silent fall-through. The `trigger` string is only the audit-log label and the key for the compensation-counter tally. The two bg-shell holds share both `trigger: 'timer:bg-shell-hatch'` and `anchor: 'bg-shell-hold-since'`, so they behave as the same hold class with different thresholds. If a new hold's predicate could overlap an existing one, mind the table order.

## Heartbeat recovery and idle provenance

For a pure-`hooks` agent (Claude) the `PtyActivityTracker` never fires, so the status-file heartbeat is the ONLY force-thinking path. `SessionTelemetry.processStatusUpdate` runs on every `status.json` change: if the engine is idle and the agent's cumulative **OUTPUT** tokens (`contextWindow.totalOutputTokens`) grew while idle for >1s, it calls `forceThinking` - the agent silently resumed generating. Output only, never input: Claude's `totalInputTokens` is current context-window occupancy (cache + input) that climbs while parked at the prompt with no generation, so summing it would false-flip a correct idle to thinking on a parked session (#295 / #297, fixed by the output-only compare in #298).

Output-only is necessary but not sufficient. A parked session still ticks `total_output_tokens` upward on background, non-turn housekeeping (compaction / summarization) emitted with NO turn-start hook, and the heartbeat read that as "resumed generating" and pinned a parked agent ACTIVE (task #294). So the engine records **idle provenance** on `SessionEngineState.idleAuthoritative`:

- **Authoritative** (`true`): the idle was entered via a genuine hook turn-end - a non-permission `Idle` hook, an `idle_hint` that cleared `turnActive`, or `Interrupted`/`TurnFailed`. "The agent told us the turn ended." Set at those source sites in `processEvent` (the synthetic watchdog `Idle/Timeout` is excluded).
- **Fallback** (`false`): the idle was entered via a watchdog hatch resetting a stuck holder, via `forceIdle`, or it is a brand-new never-started session. "We only guessed the turn ended."

The heartbeat may force-think ONLY on a non-authoritative idle (`!state.idleAuthoritative`). This kills the housekeeping-re-activates-a-parked-agent class while preserving the net's real job - recovering a fallback idle whose agent is actually generating (a dropped turn-start hook leaves a non-authoritative idle, so the net still fires). The trade is a rare, self-correcting false-IDLE (a fully-hook-dropped new turn after an authoritative idle shows idle until any hook lands) for eliminating the common false-ACTIVE pin. Pinned by the real-capture fixture `tests/fixtures/replay/session-020-false-active-parked-housekeeping` (asserts `forceThinking: 0` across the parked output growth) and the provenance unit tests.

The heartbeat's `markThinkingSignal` keep-warm - which refreshes `lastSignalAt` so a genuinely-thinking session survives the 180s stale-thinking watchdog - fires only on **proof of work**: OUTPUT tokens grew since the previous status write, AND no `idle_hint` is pending. Each condition closes a distinct false-ACTIVE pin, both caused by parked-TUI statusline churn re-blinding the (`signal`-anchored) net:

- **The `idle_hint` gate** stops the churn after a real turn ends - the agent reported waiting-for-input, so its repaints are noise (task #294).
- **The growth gate** handles the case with NO `idle_hint` at all. A `--resume` resume-picker reload is a CLI-internal turn that fires no turn hooks, so when it finishes and Claude parks, no `idle_hint` ever arrives and the idle-hint gate cannot help; only frozen-output detection stops the churn from re-warming `lastSignalAt` forever and starving the watchdog (task #331). Live generation keeps re-warming because output keeps growing (and foreground streaming keeps `lastPtyOutputAt` fresh regardless, #246). Pinned by the real-capture fixture `tests/fixtures/replay/session-021-false-active-resume-picker` (asserts the stale-thinking net self-heals to idle) plus the `#331` unit tests in `session-telemetry-activity-decisions.test.ts`.

`markThinkingSignal`'s growth gate closes the SIGNAL-re-warm leg of the resume-picker scenario, but a chatty parked TUI whose statusline repaints never leave a gap over 180s still pins the stale-thinking net's `signal-or-pty-output` anchor via `lastPtyOutputAt` indefinitely - the PTY-output-ANCHOR leg (task #364). The heartbeat's `forceThinking(sessionId, true)` call (the one immediately above, "resumed generating") is the ONLY caller that records `turnForcedByHeartbeat` provenance; the stale-thinking watchdog reads it to narrow its own anchor to `signal` for a hook-less turn too, so it self-heals ~180s after output froze rather than ~180s after the last PTY repaint (or never, if the repaints never stop). See [the stale-thinking watchdog's `parkedAnchor`](#3-stale-thinking-watchdog-180s).

## Ctrl+C user-interrupt synthesis (3s)

When the user presses Ctrl+C in a session terminal, the renderer fires the `notifyUserInterrupt` IPC alongside the regular `\x03` write to the PTY. Telemetry arms a 3-second settle timer per session. After the window, if the engine is still in `thinking` AND state is hot (`pendingToolCount > 0` OR `turnActive`), telemetry synthesizes an `Interrupted` event with `detail: 'user-ctrl-c'`. The engine's Interrupted handler clears all counters and commits idle immediately.

If Claude's hooks already recovered the engine state during the settle window, the synthetic is a no-op (state isn't hot). Multiple rapid Ctrl+C presses collapse to one - the existing timer is cleared and re-armed each time.

Without this path, hook-drop scenarios on Ctrl+C have to wait for the 5-minute stuck-pending-tools watchdog to fire.

## BgShellWatcher (the primary natural-exit mechanism)

Empirical analysis of ~50 production sessions found:
- ~206 `background_shell_start` events
- ~4 `background_shell_end` events (KillBash)
- 0 `BashOutput` tool calls

Conclusion: agents almost never explicitly end their bg shells. The only reliable signal is OS process-tree observation.

### How it works

The watcher polls every 2 seconds. For each session with `activeShellCount > 0`:

1. Check if the Claude CLI's root PID is alive. If dead, fire `onRootProcessDied` (engine forceIdle).
2. Enumerate the Claude CLI's descendant processes via `ps` (POSIX) or `Get-CimInstance Win32_Process` (Windows).
3. **Tier A (PID-aware):** when a named bg shell's OS PID is known (captured by tree-diff or the foreground-tool memo, see below), the watcher (a) fires `onShellPidExited(shellId)` → engine removes by id when the PID leaves the descendant tree, and (b) confirms liveness via `onShellsObservedAlive` → `markBackgroundShellsAlive` whenever every tracked named shell's PID is still present and there are no anonymous shells - even when the Tier B count is out of sync. This churn-proof liveness is what holds a backgrounded `npx playwright test` active while it spawns and kills its own app-under-test shells (tasks #210/#212).
4. **Tier B (count heuristic):** filter descendants to "shell-like" basenames (bash, sh, cmd, pwsh). If the topmost shell-like count dropped below `preExistingHelpers + tracked` for 2 consecutive cycles AND no foreground tool is pending, fire `onNaturalExit(delta)` capped at the engine's ANONYMOUS count. Named shells are deliberately excluded from the count-based (anonymous) drain (the engine's ambiguity guard refuses an anonymous decrement against a named shell anyway); they are governed by Tier A PID-exit, the transcript drain (a tracked shell's own terminal `<task-notification>` observed directly in the durable session transcript, see below), the output-quiescence reclaim (a PID-less named shell whose output froze while it shows a persistent deficit, see below), and the 5-min named cap as the final backstop.

**PID capture.** Tier A used to be dormant. It is now populated agent-agnostically: `SessionTelemetry.ingestEvents` calls `bgShellWatcher.noteBackgroundShellStarted(sessionId, shellId)` on every `background_shell_start` whose detail is id-shaped. The watcher resolves the OS PID two ways: (a) the **foreground-tool memo** - while a foreground tool runs (`pendingTools > 0`) the watcher remembers a single new shell-like PID, and adopts it immediately when that tool auto-backgrounds (the common case, where a fresh tree-diff would be ambiguous by promotion time); (b) **tree-diff** - on the next cycles, a topmost shell-like descendant that is neither a known helper (`helperPids`) nor already tracked, when unambiguous (exactly one candidate), is that shell's PID. Ambiguous or lagging captures retry a few cycles then give up, falling back to the count heuristic + 5-min cap.

**Transcript drain (definitive, task #386).** Before falling back to output-file heuristics at all, the watcher asks the agent adapter directly whether a tracked, PID-less named shell's terminal state is recorded in the agent's own durable session transcript: `AdapterRuntimeStrategy.backgroundShells.reportTerminatedShells({ cwd, agentSessionId, shellIds })` returns the subset of the given `shellIds` whose terminal `<task-notification>` (`<task-id>` + a terminal `<status>`) has appeared. For Claude, that notification is delivered to the CLI as a `queued_command` ATTACHMENT rather than a genuine user turn - so it never fires the `UserPromptSubmit` hook (this is why the original hook-based drain, described below, never worked) - but it IS appended to the native `~/.claude/projects/<slug>/<agentSessionId>.jsonl` transcript, which the watcher tails forward-only (an early-EOF-anchor cursor: the first call for a transcript anchors at end-of-file and returns nothing, since a shell is only ever asked about shortly after it started, long before a terminal notification could exist - so history is never scanned, only new bytes). Matching captured ids against the caller's own tracked `shellIds` is what makes an unrelated notification (a subagent/Task completion, delivered as a genuine `role:user` message carrying a long-hex agent id) a structural no-match. This is DEFINITIVE and count/output-independent: it fires the moment the transcript confirms completion, regardless of process-tree state, and can never false-idle a live shell (a live shell has emitted no terminal notification). Implemented in `src/main/agent/adapters/claude/background-shell-transcript.ts`; the watcher stays agent-agnostic behind the generic callback (`reportTerminatedShellsFromTranscript` -> engine's `onNamedShellTerminated` -> `markBackgroundShellEnded(sessionId, shellId, { source: 'transcript' })`, trigger label `event:bg-shell-ended:transcript`).

**Output-file liveness (PID-free ground truth).** When a named shell never gets an OS PID (capture stays ambiguous under app-under-test churn) AND the count heuristic never reaches its in-sync branch (the churn keeps the topmost shell-like count permanently in surplus or deficit), neither Tier A nor Tier B can confirm liveness, and a genuinely-running E2E (which exceeds 5 minutes by design) false-idles at the named cap. To resolve this without process-tree heuristics, the watcher consults a second ground-truth source each cycle: the agent's own on-disk output file for the shell. Claude Code writes each backgrounded Bash's output to `<os.tmpdir()>/claude/<munged-cwd>/<session-id>/tasks/<shellId>.output`; growth in that file (size or mtime advancing since the previous cycle) proves the shell is alive and fires `onShellsObservedAlive` → `markBackgroundShellsAlive`, refreshing the cap anchor. ANY growing named shell suffices (the anchor is session-level). Growth-stopped is not an exit signal ON ITS OWN (a quiet live shell is indistinguishable from a dead one by output alone), but the watcher COUNTS consecutive no-growth cycles per shell (`quiescentCycles`); when a PID-less named shell's output has been quiescent for `NAMED_SHELL_QUIESCENT_RECLAIM_CYCLES` (~30 cycles / ~60s) AND the process tree shows a persistent deficit (the shell's OS process is gone), the named arm of the deficit branch reclaims it via `onNamedShellLikelyExited(shellId)` -> `markBackgroundShellEnded(sessionId, shellId)`. This is the dropped-`background_shell_end` orphan whose Tier A PID capture was abandoned under churn (task #225: a fast `npm run build` that auto-backgrounded while `npx vitest run` churned the tree, exited in seconds, but pinned the task `active` for ~36 min). The dual condition (quiescent AND in deficit) is the precise discriminator: it does NOT regress a live-but-churning shell (output still growing, so `quiescentCycles` resets) or a quiet-but-alive shell (process still present, so no deficit). Quiescence WITHOUT a deficit still falls through to the count heuristic and caps. The path layout is Claude-specific and lives behind `AdapterRuntimeStrategy.backgroundShells.resolveOutputFile` (the watcher stays agent-agnostic); the file stat is injectable for tests. This is now the SECOND line of defense: task #386 (a dead `npx vitest` shell held ACTIVE ~38 min because the transcript drain did not yet exist and the count heuristic kept mis-reading process churn as liveness) is what motivated adding the transcript drain above it.

### Identity tracking and unattributable ends

A backgrounded Bash is tracked by id where possible. `PreToolUse` fires `background_shell_start` before Claude has assigned a shell id, so it counts anonymously (detail falls through to the command string). `PostToolUse` then re-emits `background_shell_start` carrying the assigned id from `tool_response` (field `shellId`, with `shell_id` / `backgroundTaskId` / `bash_id` as version fallbacks). The engine treats that as a **promotion**: it swaps one anonymous slot for a named slot keyed by the id, keeping the total count constant. A single backgrounded Bash is therefore tracked once, by id - not double-counted.

The PostToolUse remap keys on the **extracted shell-id detail** (`setTypeWhenDetailMatches('^[\w-]{1,64}$', ...)`, the id-shape regex sibling of `setTypeWhenDetailContains`), not on `tool_input.run_in_background`. This covers a second, distinct launch path: a **foreground** Bash that exceeds Claude Code's 10-minute ceiling is auto-promoted to a background shell and returns control, **without** ever carrying `run_in_background: true` (#187). Its `PreToolUse` was therefore a plain `ToolStart` (not a `background_shell_start`), so `pendingToolCount` was incremented; but its `PostToolUse` `tool_response` still carries the assigned shell id (empirically `bjosycg6w` in session `3fc0dca7`, `events.jsonl` line 20). Keying on the shell-id detail promotes it correctly, and the engine's `BackgroundShellStart` handler **closes the in-flight pending tool** matched by `tool_use_id` (the tool moved to the background rather than ending) as it opens the named shell - otherwise the orphaned pending tool would stick the session `thinking` until the 5-min watchdog. The inverse risk - a normal foreground Bash mistaken for a backgrounded shell - is structurally avoided: this `PostToolUse` `extractDetail` sources only the `tool_response` shell-id fields, so a plain completion has no detail and never remaps, and a failed Bash flows through `PostToolUseFailure` (a separate directive set). Such a named shell is then held active by the watcher's Tier A liveness each cycle it sees the bash's PID alive, and reclaimed by the Tier A PID-exit drain (or the 5-min named cap as backstop) once it exits - the exact "10-min E2E" case (tasks #210/#212).

`background_shell_end` from `KillBash` carries the id and drains the matching named slot; without an id it drains the anonymous count. A NAMED shell whose OS PID was never captured and whose `KillBash` end was never invoked (Incident A, session `f03f5e43`) is drained by the watcher instead: the transcript drain (definitive, see above) or, failing that, the output-quiescence reclaim or the 5-min named cap.

An earlier fix attempt drained this case via a SECOND `UserPromptSubmit` hook entry: Claude Code injects a `<task-notification>` user message on a backgrounded shell's terminal state, and the entry pulled the shell's `<task-id>` out of the `prompt` field and emitted `background_shell_end` with that id. This shipped as task #216's fix but turned out to be net-harmful in production (task #386, discovered from a real incident transcript): a background shell's terminal notification is delivered to the CLI as a `queued_command` ATTACHMENT, not a genuine user turn, so it never fires `UserPromptSubmit` at all - the hook never drained a real shell. Worse, subagent/Task completions DO arrive as genuine `role:user` `<task-notification>` messages (carrying a long-hex agent id, a different value from any shell id), so the hook fired on every one of those instead, each time emitting an **unattributable** `background_shell_end` - one that matches no named slot AND (if any anonymous shell happened to be live) could silently decrement it. The hook was removed; the transcript drain above (which matches captured ids against the caller's own tracked shell ids) is what replaced it - and does not have either defect, since a subagent's id was never asked about in the first place.

An unattributable end (an id-shaped `detail` that matches no tracked named shell) is treated as a no-op that bumps the `unmatchedBgShellEnd` compensation counter, rather than draining an arbitrary named shell OR falling back to the anonymous count. This bounds the blast radius of any input-layer mistake: a spurious end can never silently decrement a real shell (named or anonymous) and trigger a premature idle. Only a `detail`-LESS end (no id at all - the true anonymous-shell signal) drains the anonymous count.

### Lazy polling

The watcher only polls when at least one session has `getActiveShellCount() > 0`. Idle Kangentic = zero polls.

### Cross-platform

- **Windows:** `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"`. Walks the parent map in JS. Times out at 1.5s.
- **POSIX:** `ps -A -o pid=,ppid=,comm=`. Walks the parent map in JS. Times out at 1.5s.
- **Liveness probe:** `process.kill(pid, 0)`; treats EPERM as alive (matches existing pattern).

### Kill switch

Set `KANGENTIC_BG_SHELL_WATCHER=0` to disable the watcher. The sole-holder holds remain as fallback (named shells reclaim at the 5-min cap, anonymous shells at the 30s grace), but without the watcher a genuinely-running named shell is no longer held past the cap (Tier A liveness needs the watcher).

## Resume reconciliation

When Kangentic restarts mid-session, the engine starts clean but the agent's Claude CLI may have living descendant processes. `reconcileBgShellsOnResume` enumerates the descendants at resume time, filters to shell-like basenames, and adopts them as anonymous bg shells. The watcher then prunes them as they exit naturally.

## Observability

### TaskCard hover tooltip

The activity icon on each task card is wrapped in a tooltip rendering `ActivityReasonTooltip`. Hover reveals an icon + inline label per reason kind: "Running Bash", "2 subagents active", "1 background shell", "Awaiting permission", etc.

### Activity Engine Debug Overlay (Developer settings tab)

A per-project setting under **Developer → Activity Engine Debug Overlay** enables a floating panel showing live engine state:
- Current activity + reason for each running session
- Raw counters (tools, subagents, bg shells)
- **Compensation counters** (`staleThinking`, `bgShellHatch`, `stuckPendingTools`, `forceThinking`, `forceIdle`, `unmatchedBgShellEnd`, `ignoredInnerSubagentStop`, `stuckSubagent`) - monotonic tallies of silent recovery events. In a clean session all eight read 0; any non-zero value flags a watchdog / forced transition / unattributable or discarded event that did not visibly flip the activity pill. (`ignoredInnerSubagentStop` is the benign exception: non-zero is normal on any session that ran subagents - it is the count of spurious empty-detail inner stops the engine correctly discarded.)
- Ring buffer of last 10 transitions
- **PTY chunk timeline** - bucketed PTY arrivals over the last ~120 seconds (100ms buckets) from `ActivityStatsSnapshot.recentPtyChunks`, rendered by `ActivityTimeline` alongside the watchdog deadline (`lastSignalAt + thresholdMs`). Empty in production builds where the trace recorder is dead-code-eliminated.

Polls `getActivityStats(sessionId)` every 2 seconds. Hidden by default - power users discover via Developer settings; bug reporters can enable + screenshot.

### Reading a transition trace

Each entry in `recentTransitions` (the ring of 50 returned by `getStatsSnapshot` / the MCP `kangentic_devtools_engine_state` tool; the overlay renders the last 10) carries a `trigger` label naming what caused it. The label vocabulary (`TransitionTrigger` in `src/main/activity-engine/engine/shapes.ts`):

| Trigger | Meaning |
|---------|---------|
| `event:<type>` | A hook event drove the transition, e.g. `event:tool_start`, `event:prompt`, `event:idle`. |
| `event:<type>:<detail>` | A hook event with a detail qualifier, e.g. `event:idle:permission` (paused awaiting approval). |
| `event:bg-shell-ended:<shellId>` | Id-keyed named drain - the watcher saw a named shell's OS process leave the tree (Tier A PID-exit), OR reclaimed a PID-less named shell whose output froze while it showed a persistent process-tree deficit (output-quiescence reclaim). |
| `event:bg-shell-ended:transcript` | Definitive drain - the watcher observed a tracked shell's own terminal `<task-notification>` directly in the durable session transcript (task #386). Fires independent of process-tree count or output-file state; distinct from the Tier A / quiescence label above even though both are id-keyed. |
| `event:bg-shell-ended:watcher` | Tier B count-heuristic drain - an anonymous shell reclaimed by the descendant-count drop. |
| `event:bg-shells-adopted` | Resume reconciliation adopted living descendants as anonymous shells. |
| `force-thinking` | PTY tracker / heartbeat recovery forced thinking (predicate saw no holder). |
| `force-idle` | PTY silence timer, Esc, or shutdown forced idle. |
| `timer:stability` | The 400ms idle stability window expired and committed a pending idle. |
| `timer:bg-shell-hatch` | A bg-shell sole-holder hold fired (named 5-min cap or anonymous 30s grace; same label, different threshold). |
| `timer:stale-thinking` | The stale-thinking watchdog fired (`turnActive` held alone, matching Idle never arrived); 180s cap, or the 30s `staleAfterHeartbeatForcedMs` budget when the turn was heartbeat-forced (`turnForcedByHeartbeat`, a hook-less `--resume` turn - see "Fast heal for the heartbeat-forced case" above). |
| `timer:stuck-pending-tools` | The stuck-pending-tools hatch fired (orphaned `tool_start`, lost `PostToolUse`); 5-min cap, or the 180s `staleAfterIdleHintMs` budget when an `idle_hint` was pending. |
| `timer:stuck-subagent` | The stuck-subagent hatch fired (`subagentDepth` held > 0, a named `subagent_stop` was dropped after its empty-detail inner stop was ignored); 5-min cap, or the 180s `staleAfterIdleHintMs` budget when an `idle_hint` was pending. |
| `interrupted` | An Interrupted event (Esc / Ctrl+C, real or synthesized) reset all counters. |
| `event:turn_failed:<error>` | A `turn_failed` event (Claude `StopFailure`, a TERMINAL service/API error) reset all counters and committed idle; `<error>` is the error type (e.g. `authentication_error`). |
| `event:turn_retrying:<error>` | A `turn_retrying` event (Claude `StopFailure`, a TRANSIENT auto-retried error). Held the session `thinking` (`applyRetryableFailureHold`) if the retry was live, or committed idle (`applyInterruptedBypass`) if the turn had already wound down / ended; `<error>` is the error type (e.g. `server_error`). |

Each transition also carries an optional counter-delta string (`formatCounterDelta` in `engine/counter-snapshot.ts`) summarizing what shifted across the mutation: `"tools +1"`, `"subagent +1"`, `"bg -1, turn no"`, `"perm yes"`. Numeric counters render as a signed delta; booleans (`turnActive`, `permissionPending`) render as the new value (`yes` / `no`); the string is `undefined` when nothing observable changed.

### Trace capture and replay (dev only)

`src/main/activity-engine/trace-recorder.ts` is a dev-only passive recorder that writes two per-session JSONL files to the session directory:

- `pty-chunks.jsonl` - one `{ts, length}` line per PTY chunk arrival (no content, just timestamps and sizes)
- `status-deltas.jsonl` - one `{ts, ...usage}` line per `status.json` update

Both files rotate at `TRACE_FILE_MAX_BYTES` (10 MB) with one rotated copy kept (`.1` suffix), capping per-file disk use at ~20 MB. The recorder is always-on in dev so the data is there when a flip-flop or stuck-thinking report comes in after the fact; production builds eliminate the entire module via `__KANGENTIC_DEV__` esbuild dead-code elimination.

The dev-only `kangentic_devtools_capture_trace` MCP tool reads these alongside `events.jsonl` to produce a portable replay fixture. The `activity-engine-trace-replay.test.ts` suite drives captured traces back through the engine to pin expected end-state.

### Invariant property testing

`tests/unit/activity-engine-property.test.ts` uses fast-check to generate random event sequences and assert invariants the engine must preserve:
- Counters never go negative
- `activity` always matches `reason.kind` per the priority ladder
- `dispose` is idempotent
- Multiple sessions stay isolated (event delivery to session A does not perturb session B)

The fuzz tests complement the deterministic replay fixtures by exercising input shapes the recorded sessions never produced.

## Synthetic events

The engine itself emits synthetic events into the activity log via the `onSyntheticEvent` callback for two cases:

- **Watchdog Idle/Timeout:** when the 180s stale-thinking watchdog, a bg-shell sole-holder hold (5-min named cap or 30s anonymous grace), or the 5-min stuck-pending-tools hatch fires. Pushed BEFORE the matching `onActivityChange` so the log entry appears before the state change.
- **Natural-exit `BackgroundShellEnd`:** when the watcher infers a bg shell exited naturally. Detail is `IdleReason.NaturalExit` for `onNaturalExit` (anonymous count drain), or the shell_id for `onShellPidExited` (Tier A PID-exit) and `onNamedShellLikelyExited` (a PID-less named shell reclaimed by output quiescence in a persistent deficit).

## Test infrastructure

Three test tiers:

1. **Unit** (`tests/unit/activity-engine.test.ts`, `bg-shell-watcher.test.ts`, `process-tree.test.ts`, `bg-shell-resume.test.ts`): direct engine + watcher tests with mock probe.
2. **Property** (`tests/unit/activity-engine-property.test.ts`): fast-check generates random event sequences, asserts invariants (counters never negative, activity matches reason kind, dispose is idempotent, multi-session isolation).
3. **Replay** (`tests/unit/activity-engine-replay.test.ts`): drives sanitized real production `events.jsonl` files through the engine and pins expected end-state. Fixtures live at `tests/fixtures/replay/`. Sanitization helper at `tests/fixtures/replay/_sanitize.mjs`.
4. **E2E** (`tests/e2e/background-shell-idle.spec.ts`): real Electron + mock Claude CLI exercising the full pipeline with actual bg processes.

## Configuration

### `ActivityEngineOptions`

```ts
interface ActivityEngineOptions {
  bgShellEscapeHatchMs?: number;     // default 5 * 60_000 (stuck-pending-tools hatch AND named bg-shell cap)
  bgShellOnlyGraceMs?: number;       // default 30_000 (anonymous bg-shell sole-holder grace)
  staleThinkingTimeoutMs?: number;   // default 180_000
  staleAfterIdleHintMs?: number;     // default 180_000 (stuck-subagent / stuck-pending-tools grace while idle_hint pending)
  staleAfterHeartbeatForcedMs?: number; // default 30_000 (stale-thinking hold, heartbeat-forced turns only)
  idleStabilityWindowMs?: number;    // default 400
  now?: () => number;                // testability
}
```

Plumbed through `SessionManagerOptions.activityEngineOptions` for tests.

### Per-project setting

`developer.activityDebugOverlay: boolean` - enables the debug overlay for the current project. Default false.

### Environment variables

- `KANGENTIC_BG_SHELL_WATCHER=0` - disables the bg-shell process-tree watcher (fallback to the sole-holder grace only).
- `SKIP_PROCESS_TREE_PROBE=1` - skips real-OS probe smoke tests in CI environments without `ps`/`pwsh`.

## History

The current design (v2) replaced a v1 three-guard state machine that had grown to 557 lines with overlapping concerns: Guard 1 (suppressSubagentWakeDuringPermission), Guard 2 (deferStopUntilSubagentFinishes), Guard 3 (deferStopUntilBackgroundShellsFinish), composite hand-off bookkeeping, a 45s stale-thinking watchdog, a 10-min Guard 3 escape hatch, and a `pendingPermissions` counter with depth-≥2 freeze logic.

The v2 single-predicate engine + process-tree watcher reduced this to ~600 lines total across `engine/activity-engine.ts` + `background-shell/watcher.ts` + `background-shell/process-tree.ts`, with a near-100% empirical hit rate on the natural-exit cases that motivated the rewrite.
