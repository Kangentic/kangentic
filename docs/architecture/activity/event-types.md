---
type: Reference
title: Activity event types
description: The 27 EventType values with their JSONL names and ActivityState mapping, the plan approval gate that holds permission idles, idle_hint turn endings, the onTurnEnded, turnStartedAt and workSerial contract, and turn_failed and turn_retrying recovery layers A to D.
tags: [activity, events, hooks, turn-end]
sources:
  - resource: src/shared/types.ts
    title: EventType, EventTypeActivity
  - resource: src/main/agent/event-bridge.js
  - resource: src/main/agent/plan-approval-bridge.js
  - resource: src/main/agent/adapters/claude/hook-manager.ts
  - resource: src/main/activity-engine/plan-approval-gate.ts
  - resource: src/main/activity-engine/plan-mode-trail.ts
  - resource: src/main/activity-engine/engine/event-handlers.ts
  - resource: src/main/activity-engine/engine/predicate.ts
---
# Activity event types

The 27 `EventType` values, defined in `src/shared/types.ts`. All but `plan_auto_approved` are written to `events.jsonl`: by `event-bridge.js`, except `plan_approval_sent` and `tool_approval_sent`, which `plan-approval-bridge.js` writes. Main's plan approval gate emits `plan_auto_approved` and never writes it to the file. The activity column shows how each event maps to `ActivityState` via the `EventTypeActivity` table, also in `src/shared/types.ts`.

| EventType key | JSONL value | Activity mapping | Notes |
|---------------|-------------|------------------|-------|
| `Prompt` | `prompt` | `thinking` | User submitted a prompt; agent is starting a turn |
| `ToolStart` | `tool_start` | `thinking` | Agent began invoking a tool. `launchesSubagent: true` marks a call that starts a subagent (the adapter's `markSubagentLaunch` directive; Claude names `Agent` and `Task`), so a `subagent_start` closes a permission prompt only when that call was the one awaited (see [Permission flag](predicate.md#permission-flag)). A stale bridge copy never sets it |
| `ToolEnd` | `tool_end` | log-only | Tool returned; counters update and `lastSignalAt` refreshes (a `PostToolUse` hook proves the agent is alive, so `tool_end` is NOT in the engine's `LOG_ONLY_EVENTS` set), but the activity state does not change |
| `Idle` | `idle` | `idle` | Agent finished its turn (Stop hook, prompt-regex, or silence timer). With `detail: 'permission'` it is instead a wait on the user, and its optional `waitKind` (`question` or `approval`) says which (see [The kind of a wait](activity-engine.md#the-kind-of-a-wait)) |
| `Interrupted` | `interrupted` | `idle` | The user stopped the turn: Esc while a tool runs, or Ctrl+C; clears counters and commits idle. Esc BETWEEN tool calls fires no hook at all, so that turn ends through `idle_hint` instead (see "Turn ends" below) |
| `TurnFailed` | `turn_failed` | `idle` | Turn aborted by a TERMINAL service/API error (Claude's `StopFailure` hook, which fires instead of `Stop`); `detail` carries the error type (e.g. `authentication_error`). Routed through the Interrupted bypass: clears counters and commits idle immediately (see "Aborted-turn recovery") |
| `TurnRetrying` | `turn_retrying` | conditional idle | `StopFailure` fired for a TRANSIENT, auto-retried error (overloaded/server_error/rate_limit/api_error), classified at the source (like `IdleHint`). Holds the session `thinking` through a live retry (preserving `subagentDepth` and deferring to the stale-thinking or stuck-subagent watchdog); idles immediately if the turn had already wound down or ended (see "Aborted-turn recovery") |
| `SessionStart` | `session_start` | log-only | Session began; carries adapter session metadata |
| `SessionEnd` | `session_end` | log-only | Session ended (CLI process exited) |
| `SubagentStart` | `subagent_start` | `thinking` | Main agent spawned a child agent. Clears a pending permission prompt only when the awaited call carries `launchesSubagent` |
| `SubagentStop` | `subagent_stop` | log-only | Subagent returned; depth counter decrements - EXCEPT an empty-string `detail` ("") which is a spurious inner-loop stop, and a stop whose `subagentId` has already stopped, which is a duplicate. Both are ignored (see [Subagent depth](predicate.md#subagent-depth)) |
| `Notification` | `notification` | log-only | Informational notification from the agent |
| `IdleHint` | `idle_hint` | conditional idle | "Waiting for your input" notification, classified at the source. Ends the turn only when no other holder remains; otherwise log-only (see "Idle hints" below) |
| `Compact` | `compact` | `thinking` | Context-window compaction in progress |
| `TeammateIdle` | `teammate_idle` | log-only | Cross-agent teammate signaled idle |
| `TaskCompleted` | `task_completed` | log-only | Agent declared the task finished |
| `ConfigChange` | `config_change` | log-only | Agent settings/model changed mid-session |
| `WorktreeCreate` | `worktree_create` | `thinking` | Agent created a git worktree |
| `WorktreeRemove` | `worktree_remove` | log-only | Agent removed a git worktree |
| `BackgroundShellStart` | `background_shell_start` | `thinking` | `Bash(run_in_background: true)` launched, a foreground Bash auto-backgrounded on timeout (its `tool_response` carries a shell id), or a `Monitor` wait promoted via its `tool_response.taskId`. For the other agents that report background commands, a launch their post-tool hook or history file reports (see [Agents other than Claude](background-shells.md#opting-a-background-shell-out-of-the-hold)). `noActivityHold: true`, honored on a named start only, lands it exempt: a CLI with no tool id for the PreToolUse memo reports the opt-out flag this way |
| `BackgroundShellEnd` | `background_shell_end` | log-only | `KillBash` invoked, another agent's stop tool or end notification, a watcher-inferred natural exit, or the watcher's transcript drain observing a tracked shell's terminal `<task-notification>` directly in the durable session transcript; decrements active-shells counter |
| `ModelStart` | `model_start` | log-only | LLM API call beginning (Gemini per-call telemetry) |
| `ModelEnd` | `model_end` | log-only | LLM API call returned |
| `ToolSelectionStart` | `tool_selection_start` | log-only | Agent is choosing the next tool |
| `PlanApprovalSent` | `plan_approval_sent` | log-only | Written to `events.jsonl` by `plan-approval-bridge.js` when it answers the plan prompt, before the agent acts on the answer, so it proves only that the answer was sent. `detail` says where the task goes. Not rendered (see [Plan approval gate](#plan-approval-gate)) |
| `PlanAutoApproved` | `plan_auto_approved` | log-only | Emitted by main's plan approval gate, never written to the file, right after the plan exit's `tool_end` that follows a `plan_approval_sent`. The Activity log draws it as a "Plan approved automatically" badge with `detail` "Moved to <column>" or "Stayed in <column>", and the engine re-stamps `turnStartedAt` on it |
| `ToolApprovalSent` | `tool_approval_sent` | log-only | Written to `events.jsonl` by `plan-approval-bridge.js` when, while a plan is approved automatically, it answers a plan-mode prompt for a tool the session's allow rules name, or for a Claude built-in call whose input only reads or publishes. `tool` names it. Like `plan_approval_sent`, it proves only that the answer was sent. Not rendered (see [Plan approval gate](#plan-approval-gate)) |

"log-only" means the event is recorded for the activity feed and may update internal counters, but does not on its own change `ActivityState`. State changes only occur through the [predicate](predicate.md) or via direct `Idle` / `Interrupted` events.

## Plan approval gate

A plan Kangentic approves (Plan approval Automatic, see [Bridge scripts](../../integrations/agents/bridge-scripts.md#plan-approval-bridgejs))
still raises the agent's plan prompt as a permission request, and two hooks answer it in parallel:
the catch-all `PermissionRequest` hook writes a permission `idle` carrying `tool: ExitPlanMode`, and
the plan approval hook writes `plan_approval_sent` and approves. Either can land first. Measured on
Claude Code 2.1.302, the permission idle led the marker by 24 to 31 ms in all four runs, and the
plan exit's `PostToolUse` followed the marker 130 to 170 ms later. Three more on 2.1.303 in a
preview matched: 29 to 30 ms, then 131 to 183 ms. Letting that idle through would
show the card as needing you, raise the desktop permission notification and push the phone, for a
prompt nobody has to answer.

`PlanApprovalGate` (`plan-approval-gate.ts`) runs first in `SessionTelemetry.ingestEvents`, before
the engine or any detector reads an event:

- A plan exit permission idle is held for `PLAN_APPROVAL_HOLD_MS` (2 s) when the session's current
  decision approves plans (`PlanApprovalWriter.approves`) or a marker less than 15 s old
  (`PLAN_APPROVAL_MARKER_WINDOW_MS`) precedes it. A marker that arrives while one is held restarts
  the wait, since the CLI acts on the answer after it.
- The plan exit's `tool_end` drops the held idle. The marker alone never does: it proves only that
  the answer was sent, and the CLI can refuse it. On timeout the idle is released late and the
  marker is spent, so an approver that failed, or an answer the CLI refused, still shows the dialog
  as needing you.
- The plan exit `tool_end` that follows a marker is followed by `plan_auto_approved`.
- Once the session's agent has ended (`SessionTelemetry.emitSessionEnd`), a held idle is dropped and
  nothing more is held, so the exit's last flush never releases a permission idle after the
  session's end.

A question the agent asks the user passes untouched.

The same hook answers a plan-mode prompt for a tool the session's allow rules name, and writes
`tool_approval_sent` with the tool's name (task #870). Claude's plan mode asks about an MCP tool
with no `readOnlyHint` even when an allow rule names it. Since task #952 it also answers Claude's
built-in `Artifact` call when its input only reads, lists or publishes, with no allow rule (see
[Bridge scripts](../../integrations/agents/bridge-scripts.md#plan-approval-bridgejs)). Its permission idle races that marker the same way: on
Claude Code 2.1.306 the approving hook started 5 to 114 ms after the catch-all one. So, for a
session whose decision approves plans and a tool its adapter's `mayApprovePlanTool` names (for
Claude, any MCP tool but Kangentic's own, and `Artifact`), or when that tool's marker already arrived first:

- The idle is held for `TOOL_APPROVAL_WAIT_MS` (1 s) for the marker, and released then if none
  came. A prompt the hook left alone shows that much late.
- A matching marker, before the idle (within `TOOL_APPROVAL_MARKER_WINDOW_MS`, 5 s) or after it,
  holds the idle until the tool's `tool_end` (a failed call's included) or its `interrupted`,
  which drops it. After `TOOL_APPROVAL_HOLD_MS` (30 s)
  it is released late instead, so a tool the CLI still prompts for shows as needing you within a
  minute. A tool that really runs longer reads as needing you from then until its `tool_end`.
- Several can wait at once, as when a subagent calls the tool its parent does. Markers, idles and
  `tool_end`s pair with the oldest entry of the same tool. The agent's end drops them all.
- The turn's end drops them all too: any idle that is not a permission one, a `turn_failed`, an `interrupted` that names no
  tool, or a new prompt. An idle released after the turn ended would mark an idle session as
  needing you.

A workflow task whose plan approval is Automatic has its plans approved in every plan column of
its route whose agent can approve plans, so a tool prompt in such a task shows up to 1 s late
there too; the hook itself answers only in plan mode.

## Idle hints (waiting-for-input notifications)

Some turns end without a `Stop`/`Idle` hook ever reaching the main agent - most commonly when the whole turn was delegated to a subagent. When the subagent stops, `subagentDepth → 0` but `turnActive` is still `true`, and the only thing that arrives is a `Notification` ("Claude is waiting for your input"). Because `Notification` is log-only, nothing clears `turnActive`, and the session stays `thinking` until the 180s stale-thinking watchdog fires - the user sees the spinner spin ~3 minutes after the agent is actually done.

`idle_hint` closes that gap. The classification happens **at the source, not in the engine**: the Claude adapter's `Notification` hook carries a generic `setTypeWhenDetailContains('waiting for your input', EventType.IdleHint)` directive (the only Claude-specific string), so `event-bridge.js` rewrites the matching notification's `type` to `idle_hint`. The match runs on the already-extracted `detail` text (empirically "Claude is waiting for your input"), so it does not depend on which payload field carried the message. The engine never string-matches notification text and never branches on agent name.

The engine treats `idle_hint` as **conditionally** turn-ending (`idleHintEndsTurn` in `predicate.ts`): it clears `turnActive` only when `turnActive && pendingToolCount === 0 && subagentDepth === 0 && bgShellCount === 0 && !permissionPending`. When the guard passes, the predicate flips to idle through the normal 400ms stability window (near-instant for the user). When it fails - tools, subagents, or background shells still outstanding, or a permission pending - `idle_hint` does NOT clear `turnActive` (a notification that fires mid-turn never short-circuits genuine work), but it is no longer a complete no-op: it sets `idleHintPending`, which shortens the stuck-subagent and stuck-pending-tools watchdogs (see "Aborted-turn recovery" below). `idle_hint` is in `LOG_ONLY_EVENTS`, so it never resets `lastSignalAt` (a failed guard leaves the genuine work's watchdog anchor untouched).

**Why the substring is deliberately narrow.** A scan of 221 real Claude sessions surfaced exactly four distinct notification texts: "Claude is waiting for your input" (794x), "Claude Code needs your approval for the plan" (109x), "Claude Code needs your attention" (43x), and "Claude needs your permission[ to use X]" (51x). Only the first fires for a pure turn-end whose `Stop` hook can be dropped. The other three each fire ~6s AFTER a `PermissionRequest` (tool permission, ExitPlanMode plan approval, or AskUserQuestion) has already driven the engine to the `permission` state, so they are correctly left log-only - reclassifying any of them would conflate `permission` with `idle`. The negative cases are pinned with the real strings in `tests/unit/event-bridge-remap.test.ts`.

Only the Claude adapter wires this today, because Claude is the only agent for which we have captured evidence (a real session) of both the notification text and the dropped-Stop failure mode (a turn fully delegated to a subagent). The engine path is generic: any adapter that classifies a notification into `idle_hint` gets the same behavior.

To extend it to another hook-based agent, capture a real session that exhibits the stall, read the notification's extracted `detail`, then add a `setTypeWhenDetailContains('<observed substring>', EventType.IdleHint)` directive (built via the typed builder in that adapter's hook-manager, never hand-authored) to that adapter's Notification hook. Do not guess the string. Current status of the other agents:

- **Gemini** maps `AfterAgent` to the `idle` stop-equivalent and `Notification` to `notification` (one whose `notification_type` is `ToolPermission` also to the permission `idle`), so it could be susceptible. But it wires no `SubagentStart`/`SubagentStop` hooks, so the subagent-delegation failure mode is not modeled, and we have no captured session to confirm its notification text. Wire only after capturing evidence.
- **Qwen Code** does not share Gemini's hook shape: its events use Claude's names (`Stop` -> `idle`). Its "Qwen Code is waiting for your input" notification (`notification_type: idle_prompt`) cannot be an idle hint. A live 0.25.2 session sends it mid-turn, right after almost every `PreToolUse`, so it says nothing about the turn ending. It stays a log-only `notification`, pinned by `tests/unit/qwen-hook-bridge.test.ts`.
- **Kimi** does not need this: its wire protocol emits an explicit `TurnEnd -> Idle`, and none of its `Notification`-mapped messages mean "waiting for input."
- **Codex / Copilot / OpenCode** wire no Notification hook, so the pattern cannot apply.

## Turn ends (`onTurnEnded`)

Going idle and finishing a turn are different facts, and On agent turn end automations need the
second. The engine reports one through `ActivityEngineCallbacks.onTurnEnded(sessionId,
turnStartedAt, workSerial)`, which `SessionTelemetry` relays and `SessionManager` emits as `'turn-ended'`
(`TurnEndedPayload`, with the task, project, agent session, isolated column, and the
`transcriptAnchor` the turn's reply is read from). `'activity'` is
not overloaded for it: that event fires on every state change, and a Stop commits as
`timer:stability`, the same trigger three watchdogs use.

- **What counts.** The engine records what cleared the turn in `turnEndSource`: `'stop'` for the
  agent's own turn-end hook (a non-permission, non-timeout `Idle`), `'idle-hint'` for an
  `idle_hint` that ended it, and null for everything else. `onTurnEnded` fires once, on the
  thinking-to-idle COMMIT, only when the source is `'stop'`. The commit, not the hook, so a turn
  whose background shells or subagents were still held reports only once they drain.
- **What does not.** An `idle_hint` (Esc between tool calls fires no hook and ends the turn exactly
  this way, so the two cannot be told apart), `Interrupted`, `TurnFailed`, a `TurnRetrying` that
  idles, a permission prompt, every watchdog and silence timer, and a resume's idle seed.
- **`turnStartedAt`** is stamped on every idle-to-thinking commit, and at spawn when the session is
  seeded thinking. A permission prompt resolving back to thinking keeps it, since that is the same
  turn, with one exception: a plan approval (the `AgentTool.ExitPlanMode` `tool_end` that resolves
  the prompt) stamps it again. The agent implements in the turn that planned, so the approval is
  where the implementation begins. A plan Kangentic approved never shows the prompt as pending, so
  the `plan_auto_approved` event that follows its `tool_end` stamps it instead (`onTurnStarted`
  reason `'plan-approval'`). A rejected plan sends no `tool_end` and keeps the stamp. The
  turn-end runner uses it to ignore a turn that began before the task entered its column. A task
  dragged into Executing mid-plan and approved after the drag therefore counts there, while one
  dragged in mid-turn with no approval after the drag is dropped, unless the drag came after the
  plan was left (next bullet).
- **Plan mode.** A plan left in the conversation, with no approved ExitPlanMode, gets no re-stamp:
  the user types "looks good" in Planning, drags the card on mid-turn, and the turn would read as
  Planning's (kangentic-mobile #119). So an adapter can report the session's mode on its events, as
  the boolean `SessionEvent.planMode` that the `extractPlanMode` directive sets. Claude's
  `UserPromptSubmit` and `Stop` hooks carry `permission_mode`. A payload that carries `agent_id`
  fired inside a subagent, which can run in its own mode, so it reports nothing. `SessionTelemetry`
  keeps each session's changes in a `PlanModeTrail` (`plan-mode-trail.ts`), stamped with the app's
  clock at ingest rather than `event.ts`, which is the agent host's.
  `SessionManager.hadLeftPlanModeBy(sessionId, atMs)` is true when the session reported plan mode
  and then reported being out of it by `atMs`. The trail is dropped on a suspend and on removal, so
  a resumed session starts with none, and a drag counts as a plan exit only once it reports plan
  mode again. An agent that reports no mode always answers false.
- **`workSerial`** is the turn's identity. It counts the turn-initiating events (`TURN_INITIATING_EVENTS`)
  `processEvent` has handled, and rides the turn end beside `turnStartedAt`.
  `SessionManager.isLatestTurn(sessionId, workSerial)` is true only while the agent has reported no
  work since. The turn-end runner and the workflow step ask it before acting on a check's answer, so
  a turn the user began meanwhile stops them even after it failed or was interrupted back to idle
  with no turn end of its own. It is not `turnStartedAt` because `forceThinking` re-stamps that: a
  PTY-tracked agent's trailing paint after its turn end (Kimi's tracker is never suppressed) would
  read as a new turn every time. Only an agent's own hook or wire events move the serial.
- **`onTurnStarted(sessionId, turnStartedAt, cause)`** fires at each of the three stamps, with its
  `TurnStartCause` (`'seed'`, `'idle'` or `'plan-approval'`). `SessionManager` uses it to key the turn's
  `transcriptAnchor`, the transcript byte offset the turn end's reply is read from. The anchor is
  the message trail's cursor as copied when the session last committed to idle (`'idle'`, moved
  only by a trail read already pending at that commit), as it stands at the approval
  (`'plan-approval'`), or none (`'seed'`). It reaches the turn end only when
  the stamp it was keyed to is the one the turn end reports. A turn with no anchor (no trail
  read yet, a fresh spawn, or an agent with no window read) reads the newest reply in the
  transcript instead. See
  [Automation triggers](../automations/triggers.md#on-agent-turn-end).
- **Which agents have one.** Each adapter's runtime strategy declares `reportsTurnEnd`. True for
  Claude, Codex (its Stop hook), Copilot, Gemini, Antigravity, Qwen, Grok, OpenCode and Kimi (whose
  wire protocol emits `TurnEnd`); false for agents whose only signal is
  terminal silence, where a quiet compile and a finished turn look the same.
- Pinned by `tests/unit/activity-engine-turn-ended.test.ts` and two replay fixtures:
  `session-030-code-review-background-subagents` (#529's pass #76: 12 Stops, 3 turn ends, because
  the background reviewers held the other nine) and `session-031-turn-failed-then-continue` (a
  captured task session: a `turn_failed` with error `unknown` idles with no turn end, then the turn
  after the user's "continue" ends once at its Stop).

## Aborted-turn recovery (service errors)

When a service/API error (rate limit, overload, server error) disrupts a turn, a subagent's NAMED terminal `subagent_stop` or a tool's `tool_end` can be lost, so `subagentDepth` or `pendingToolCount` stays > 0 and the board shows the task `thinking` while the agent is actually parked at the prompt. There are three distinct failure modes, and a layer for each.

**Layer A - the idle-hint-shortened watchdog (the validated fix for #277).** In the captured #277 incident the stuck counter came from a subagent whose named stop was dropped, while the **parent turn kept running normally** - each later turn ended with a real `Stop` (an `idle` event, swallowed by the stuck counter) plus an `idle_hint`, and **no `StopFailure` was ever emitted** (the `idle` events confirm the turns ended via `Stop`, not an abort). To recover this, an `idle_hint` ("waiting for your input") arriving while a counter is still stuck > 0 sets `idleHintPending`, which drops the `stuck-subagent` and `stuck-pending-tools` holds from the 5-min `bgShellEscapeHatchMs` cap to the validated stale-thinking budget (`staleAfterIdleHintMs`, default 180s). The hold **anchor is unchanged** (`signal-or-pty-output`): a top-level `idle_hint` can fire while a subagent is genuinely live (the notification fires outside the main agentic loop - task #237 / session-018), so this only shortens the timer; a live subagent keeps streaming PTY output, which defers it, and its named stops arrive while it works. `idleHintPending` is cleared by the next turn-initiating event and by any reset (bypass / force-*), and is surfaced on `ActivityStatsSnapshot` for the debug overlay.

**Layer B - the structured `StopFailure` signal, terminal case.** A *different* mode is a turn that an API error terminates outright: Claude Code fires a `StopFailure` hook *instead of* `Stop` (`code.claude.com/docs/en/hooks`, added in CLI 2.1.78), so that turn's closing hooks never run. The Claude adapter's hook-manager wires `StopFailure` to emit `turn_failed` by default, carrying the error type (Claude's `error` / `error_details` fields) in `detail`. The engine treats `turn_failed` like `Interrupted` (it is in `TURN_ENDING_EVENTS` and routes through `applyInterruptedBypass`): all counters reset and the session commits idle immediately, with the error type preserved in the transition trigger (`event:turn_failed:<error>`) - distinct from a user-`Esc` `interrupted`.

**Layer C - the structured `StopFailure` signal, TRANSIENT case (`turn_retrying`).** Claude Code also fires `StopFailure` for a **transient, auto-retried** error - 529 overloaded / `server_error` / `rate_limit` / `api_error` - not only a final abort. During the retry backoff the turn is still alive, but before this layer the engine treated every `StopFailure` identically (Layer B's immediate `applyInterruptedBypass`), force-idling a task mid-retry with no safety net to revive it (no PTY output, no output-token growth during backoff). Confirmed empirically by replaying the real captured `events.jsonl` from kangentic.com Task #43 (session `fc2f1446`) through the actual `ActivityEngine`: the committed disposition was `idle` for the whole ~166s retry window, driven by `event:turn_failed:server_error`.

The fix classifies the error at the **source, not the engine** (mirroring the `IdleHint` precedent): the Claude adapter's `StopFailure` directive reclassifies a transient error's already-extracted `detail` into the generic `turn_retrying` event via chained `setTypeWhenDetailContains` directives (`overloaded`, `server_error`, `rate_limit`, `api_error`), leaving `turn_failed` for everything else. The engine then decides liveness with `idleHintPending` as the discriminator (the same field Layer A uses) - this is what keeps Layer B's #277 fixture correct while fixing the new bug:

- **Live retry** (`!idleHintPending && turnActive`, e.g. an open tool/subagent, no preceding "waiting for input"): `applyRetryableFailureHold` resets the in-flight counters (decoupled cleanup, same reset as `applyInterruptedBypass`) EXCEPT `subagentDepth` (see Layer D), and KEEPS `turnActive`, so the session stays `thinking`. `turn_retrying` is NOT in `LOG_ONLY_EVENTS`, so each retry refreshes `lastSignalAt` - the watchdog therefore fires from the LAST retry (not the first), only if the turn genuinely never resumes. A backoff shorter than the threshold (the fc2f1446 incident's gap was ~148s) never false-idles.
- **Wound-down or already-ended turn** (`idleHintPending`, e.g. session-019's shape, or `!turnActive`): treated exactly like a terminal `turn_failed` - `applyInterruptedBypass` idles immediately.

**Preventing a parked-repaint regression (#294/#364 class).** During a live-retry hold, neither existing "believed parked" signal (`idleHintPending`, `turnForcedByHeartbeat`) is set, so the holding watchdog would keep its `signal-or-pty-output` anchor - a parked-TUI "retrying in Ns..." repaint streams real PTY bytes and would defer the net forever if the error turns out to be terminal. `applyRetryableFailureHold` sets a provenance flag, `retryFailurePending`, added to `watchdogBaseTime`'s `believedParked` check alongside the other two, so the hold narrows to its `signal` anchor during a retry hold exactly as it does for `idleHintPending`. Cleared by the same events that clear `idleHintPending`: a genuine turn-initiating event, the bypass/hold reset, and `forceThinking`/`forceIdle`.

**Layer D - preserving `subagentDepth` across a live retry (#532).** Layer C's shared reset also zeroed `subagentDepth`, which is wrong for a live hold: a rate-limit retry does not kill live subagents. They survive the parent's API retry and self-heal through their own terminal `SubagentStop`. And because the decrement is clamped (`Math.max(0, depth - 1)`), those stops could never restore the count - once wiped, the depth was pinned at 0 for the rest of the session and every later `idle` / `idle_hint` sailed through the `subagentDepth === 0` turn-ending gate. In the captured incident (task #527, session `7faa4308`), 11 turn-enders were let through while 2 to 11 subagents were live, and the durable `activity_intervals` rows were mis-recorded with them.

This surfaced now because Claude Code dispatches Agent subagents in the **background**: `PreToolUse` to `PostToolUse` averaged 1.7s on that session while the agents lived 2 to 19 minutes. The parent's own `Stop` therefore routinely arrives with agents still live, and `subagentDepth` is the only signal keeping the board honest during that window.

`resetInFlightCounters` takes a `preserveSubagentDepth` option, defaulting OFF so `applyInterruptedBypass` is unchanged (whether background agents survive an Esc or a terminal `turn_failed` is unverified, so it stays out of scope). `pendingToolCount` / `pendingToolStack` are deliberately still cleared - the same shape of loss, but weaker (the count is not in the predicate, and the turn-ending gate keys only on `subagentDepth`), and restoring the count without its id-matched stack would leave arriving `tool_end`s unable to match.

Preserving the depth changes WHICH watchdog arbitrates a retry hold: every other hold requires `subagentDepth === 0`, so `stuck-subagent` (5-min cap) takes over from `stale-thinking` (180s). That hold had no `parkedAnchor`, which would have reopened the parked-repaint hole above. It now carries `parkedAnchor: 'signal'` plus a `parkedWhen` predicate narrowing the parked test to `retryFailurePending` alone - `idleHintPending` must NOT narrow this hold, because an idle_hint can fire while a subagent is genuinely live (#237 / session-018) and there the streaming output must keep deferring it. The narrowing is safe because every real work signal disengages it: `tool_start` / `subagent_start` are turn-initiating (they clear `retryFailurePending`), and `tool_end` is deliberately not log-only, so it refreshes the narrowed `signal` anchor itself. Only a wedged CLI emitting nothing but repaints is left to the 5-min cap.

Empirical basis: task #277 (session `27582968`) held `thinking` for ~560s after the agent was idle; the condensed stream is pinned in `tests/fixtures/replay/session-019-service-error-stuck-subagent.jsonl` (its "without turn_failed" assertion reproduces the real stuck-thinking bug). Task #43 (session `fc2f1446`) held `idle` for ~166s during a live API retry; the condensed stream is pinned in `tests/fixtures/replay/session-023-false-idle-server-error-retry.jsonl`. Task #527 (session `7faa4308`) showed ~103s of false idle in one of 11 such windows while its Code Review agent worked; that shape is pinned in `tests/fixtures/replay/session-028-turn-retrying-wipes-subagent-depth.jsonl`. The timer-driven recovery for all three (which the fast-time replay harness cannot advance) is covered in `tests/unit/activity-engine.test.ts` ("aborted/errored-turn recovery" and "turn_retrying").
