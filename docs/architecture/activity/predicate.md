---
type: Reference
title: Activity predicate
description: The single predicate that derives thinking, permission or idle from turnActive, subagent depth, background shells and the permission flag, with the subagent id ledger, the transcript rejection poll, tool stack matching, internal CLI agent tool events and the idle clamp.
tags: [activity, predicate, subagents, permission]
sources:
  - resource: src/main/activity-engine/engine/predicate.ts
  - resource: src/main/activity-engine/engine/event-handlers.ts
  - resource: src/main/activity-engine/engine/shapes.ts
    title: SessionEngineState
  - resource: src/main/agent/adapters/claude/permission-rejection-transcript.ts
---
# Activity predicate

The engine exposes ONE predicate:

```
'thinking' IFF turnActive
            OR subagentDepth > 0
            OR (activeBackgroundShellIds.size + anonymousBackgroundShellCount) > 0
'permission' IFF permissionPending
'idle' otherwise
```

Notably absent: `pendingToolCount` is NOT in the predicate. An explicit `Idle` event (Stop hook) must transition to idle even if a tool's PostToolUse never arrived. `pendingToolCount` only drives the `'tool'` reason for UI tooltips.

Also absent, and deliberately so: `exemptBackgroundShellIds`. See [Opting a background shell out of the hold](background-shells.md#opting-a-background-shell-out-of-the-hold).

## turnActive

Set on any "thinking-initiating" event (`ToolStart`, `Prompt`, `SubagentStart`, `Compact`, `WorktreeCreate`, `BackgroundShellStart`). Cleared by `Interrupted`, and by `Idle` **only when `subagentDepth === 0`** (an `Idle` arriving while a subagent is live is the subagent's own inner Stop and must not end the parent turn - see [Subagent depth](#subagent-depth)). Also re-armed when an APPROVED permission pause resolves (see [Permission flag](#permission-flag)) - a REJECTED pause deliberately leaves it untouched instead. Persists across the silent gaps between tool calls so the spinner doesn't flicker.

## Subagent depth

Tracks nested subagent invocations. `SubagentStart` increments, except a start whose `subagentId` is already live (see "Re-started live subagent" below); a `SubagentStop` decrements (clamped to 0), **except a `SubagentStop` whose `detail` is the empty string `""`, which is ignored** (it bumps the `ignoredInnerSubagentStop` compensation counter instead), **and a named stop whose `subagentId` already stopped**, which is a duplicate and is also ignored (see "Duplicate named stops" below). A subagent runs synchronously inside the parent's turn, so when its inner loop finishes it fires a `Stop` hook (mapped to `Idle`) **while it is still tracked as live**. That `Idle` is the subagent's, not the parent's: the engine therefore does NOT clear the parent's `turnActive` when `subagentDepth > 0` (the parent is blocked on / about to consume the subagent result and has not finished).

The parent's own Stop **used** to arrive only after every subagent had returned (i.e. at `subagentDepth === 0`). That is no longer true. Claude Code now dispatches Agent subagents in the **background**: measured on session `7faa4308`, `PreToolUse` to `PostToolUse` for the Agent tool averaged **1.7s** while the agents themselves lived 2 to 19 minutes. The parent's turn ends, the agents keep working, and the main loop is auto-re-invoked on completion with no user action. So a parent `Stop` now routinely arrives with agents live, and `subagentDepth` is the **only** signal keeping the board honest during that window - which is why losing it (task #532, see Layer D in [Aborted-turn recovery](event-types.md#aborted-turn-recovery-service-errors)) produced multi-minute false idles rather than a cosmetic glitch.

Why the empty-string skip: a real capture (session `87524f38`, task #234 running 3 parallel `Explore` agents then a `Plan` agent) showed every subagent emit **two** stops - a spurious empty-detail (`detail: ""`) inner-loop stop when its inner turn ends, then its authoritative **named** terminal stop (`detail: "Explore"` / `"Plan"`) when the Task tool returns. Counting the empty inner stops drove `subagentDepth` to 0 while subagents were still live, so a later real `Idle` (an Explore inner stop) or `idle_hint` ("waiting for your input", the ~69s Plan window) ended the parent turn early - the board went idle for the tail of the run (task #237, the inverse of a false-active). Ignoring the empty-string inner stops keeps `subagentDepth` accurate so the depth-0 gates above do their job. The guard is strictly `detail === ''`: a detail-**less** stop (no `detail` field, e.g. `session-008`'s hand-crafted stream) and a named stop are real terminal stops and still decrement, unless the named stop's `subagentId` already stopped (see below). Pinned by the `session-017-false-idle-during-live-subagent` (the earlier ordering) and `session-018-parallel-subagent-false-idle` (the harder ordering, this fix) replay fixtures; the raw hook payloads confirm a subagent-context Stop carries `agent_id` while the main-agent Stop does not.

**Duplicate named stops (task #759).** One agent can also fire two NAMED stops. A background subagent that ends its turn with plain text, without calling `SubagentHandback`, fires a named stop; the CLI then injects `[handback-send-enforce]`, the subagent runs again, calls the handback, and fires a second named stop. Counting both took a live sibling's slot. In the captured incident (task #757, session `a0797fa5`) the correctness `review-finder` did this while a background `test-builder` was running, depth reached 0, and the parent's Stop passed the depth-0 gate: 49s of false idle. The Claude adapter now extracts `agent_id` from `SubagentStart` and `SubagentStop` into the generic `SessionEvent.subagentId` (the `extractSubagentId` directive, its own wire kind, so a stale bridge copy is a logged no-op), and the engine keeps a ledger of each id's last lifecycle event (`subagentLifecycleById`):

- A start marks its id live. A `SendMessage` continuation fires a fresh `SubagentStart` under the same id (captured on CLI 2.1.290), so a start always re-opens the id. It takes a slot only when the id was not already live.
- A stop for an id whose last event was already a stop is ignored and bumps `duplicateSubagentStop`. Any other stop decrements as before and marks its id stopped.
- The empty-detail guard runs first and never records an id, so a subagent's inner stops cannot pre-mark it stopped.
- Every path that force-zeroes the depth (the Interrupted / `turn_failed` bypass, `forceIdle`, the `stuck-subagent` hold) goes through `releaseSubagentSlots`, which also marks the live ids stopped, so a late stop from a released agent cannot take the slot of one started after the reset. The live `turn_retrying` hold preserves the depth (#532) and the ledger with it.
- An event with no id, or an empty one, never touches the ledger, so other adapters, older payloads, and every earlier fixture keep the count-based decrement. The ledger is capped at `MAX_TRACKED_SUBAGENT_IDS`, and an evicted id falls back to the count. At the cap the stopped id written longest ago goes first, and a live id goes only when no stopped id remains. A stopped id only has to outlast its duplicate stop by seconds, while a live id has to last its whole run, and a `/code-review` pass can start more than 50 finders while one long-running agent stays live.

**Re-started live subagent (task #835).** This is the mirror case, where one agent fired two STARTS for one named stop. In the #832 Code Review pass, finder `a4ddf500929115e85`'s first run called `SubagentHandback`, which got no `tool_end`, and no named stop came for that run. The driver re-tasked it with `SendMessage`, which fired a second `SubagentStart` under the same id while the ledger still held it live. Counting both gave one agent two slots. The session logged 17 starts against 16 named stops, and the parent's final Stop arrived at depth 1 and read as a subagent's. `turnEndSource` never became `'stop'`. The `stuck-subagent` hold later committed a plain idle, so `onTurnEnded` never fired and the column's On agent turn end rows never ran. A start for an id the ledger holds live now re-marks it live without taking a second slot, and bumps the `duplicateSubagentStart` compensation counter.

One ordering stays open, by choice. If the first run's named stop lands AFTER the continuation's start, it releases the one slot and marks the id stopped, and the continuation's own stop then reads as a duplicate. The depth ends balanced, but it reads 0 while the continuation runs, so a parent Stop in that window ends the turn early. The stream cannot tell that late stop from the continuation's own stop, and counting runs per id instead would bring the #832 leak back whenever the first run's stop never comes. Pinned by `session-032-restarted-live-subagent` (in `activity-engine-turn-ended.test.ts`, with an ids-stripped red-green) and the task #835 cases in `activity-engine.test.ts`, including this ordering.

Known residual, not fixed: the depth drops at the FIRST stop, so during the ~12s re-run the re-prompted agent is uncounted. If it is the only live subagent, a parent Stop in that window can commit idle until the re-run's next `tool_start` re-arms `turnActive`. Pinned by `session-030-duplicate-named-subagent-stop` (ids augmented, since the bridge did not record them at the time); with the ids stripped the same stream idles on `event:idle`.

## Permission flag

Set when an `Idle` event fires with `detail: 'permission'`. The engine also records `permissionAwaitedToolId`, the tool the prompt was raised for: the newest `pendingToolStack` entry named by the event's `tool`, else the top of the stack (permission prompts fire between PreToolUse and execution, and permission idles leave the stack intact). The other pending ids are recorded as the prompt's siblings (`permissionSiblingToolIds`). Cleared by:
- `Prompt` (user typed something new)
- `Interrupted` (Esc)
- `TurnFailed` and a terminal `TurnRetrying` (a turn that ended in an API error)
- `SubagentStart`, only when the awaited call starts subagents (its pending entry carries `launchesSubagent`, from `SessionEvent.launchesSubagent`): approving that call is what started this subagent. A parallel subagent's start leaves the prompt open (task #952)
- `Idle` with non-permission detail (agent ended turn)
- `ToolStart` or `ToolEnd` at `subagentDepth === 0` that cannot be told apart from the awaited call: the event has no `toolId`, or `permissionAwaitedToolId` is null. With both ids known, another call's start or end is a parallel sibling and leaves the prompt open until its own call starts or ends. A sibling already running when the prompt opened (Claude's ToolSearch beside AskUserQuestion) only drops from the sibling set when it ends. See [The kind of a wait](activity-engine.md#the-kind-of-a-wait)
- `ToolStart`/`ToolEnd` carrying `permissionAwaitedToolId`, at ANY depth (the prompt was approved and that exact tool ran - e.g. a tool inside a subagent; without this the flag stays stuck until the subagent stops, since the PTY net deliberately exempts `'permission'`)

That list is every HOOK-driven clear. A manual REJECTION fires no hook at all, so it clears through a separate, out-of-band path instead - the transcript poll described below.

Unrelated subagent-tool events at depth>0 (different or absent toolId) do NOT clear permission (parallel-subagent tool churn must not dismiss a prompt that is still awaiting approval). The approved-tool clear is pinned by the `session-010` replay fixture (task #194's stuck 77s window).

The narrower depth-0 and `SubagentStart` clears came from an overnight workflow. A parallel subagent's start cleared an `Artifact` prompt 4 ms after it opened, the stale-thinking watchdog later committed idle with the prompt still on screen, and a recovery nudge's Enter approved the call. A prompt held open longer this way costs a card that reads `permission` until the call's own end. Kangentic's automated keys never rely on the flag alone: they also wait out a tool call with no end in the [open-work ledger](activity-engine.md#open-work).

**Resume restores `turnActive`.** A permission pause begins with `Idle{detail:'permission'}`, which clears `turnActive` (Idle is a turn-ending event). When the pause resolves, the wake is typically a depth-0 `ToolEnd` (e.g. the `AskUserQuestion` / `ExitPlanMode` tool ending after the user answers/approves) - a non-turn-initiating event that clears `permissionPending` but does not re-arm `turnActive`. The resumed turn emits no fresh `Prompt`/`ToolStart` hook, so without intervention the predicate would see no holder and drop to **idle** until the PTY force-thinking net catches up seconds later. To avoid that, `processEvent` restores `turnActive = true` whenever `permissionPending` transitions `true -> false` on a non-turn-ending event (i.e. not `Idle`/`Interrupted`, which are genuine end-of-turn). This is classified by the generic permission-clear shape, not by tool or agent name, so it covers every permission-class pause. Pinned by the `session-006`/`session-007` replay fixtures.

**A manually REJECTED prompt clears through none of the above (task #640).** A deny at Claude's TUI (or from a paired phone via `answer-permission-prompt`) is not a resumed turn: the CLI does not re-invoke the model, so no `ToolStart`/`ToolEnd` ever arrives for the awaited tool. `Stop` never fires either (the turn aborted, not ended - there is no assistant turn to close). `PostToolUse` only fires "after a tool call succeeds", and `PermissionDenied` exists only for auto-mode denials, so no hook of any kind reports a manual deny. Left alone, `permissionPending` sticks until a human types something new (`Prompt` is still a clearing signal) - the mobile case (answer from the phone, put it down) never gets that. There is also no watchdog fallback: `scheduleTimer` only ever consults the hold table while `state.activity === 'thinking'` (`activity-engine.ts`'s `scheduleTimer`/`onTick`), so `permission` is the one state with no timer armed at all, by construction, not merely by the holds' own `!permissionPending` guard.

The recovery is a poll against the durable transcript, mirroring the bg-shell transcript drain (task #386) for the same reason: a denial IS always appended there, as a synthetic `tool_result` user turn (`is_error: true`, content starting `"The user doesn't want to proceed with this tool use"`), even though no hook reports it. `SessionTelemetry` lazily starts a 2s poll (`ensurePermissionRejectionPollRunning`/`stopPermissionRejectionPollIfIdle`) the instant any session enters `permission`, and stops it the instant none remain - `AdapterRuntimeStrategy.permissionPrompts.reportRejectedPromptTools` (Claude: `permission-rejection-transcript.ts`) checks the awaited `toolId` against a bounded tail of the transcript, filtered to lines at or after the prompt's park time (`needsUserSince`) so a re-scanned `--resume`-extended transcript can never match a stale historical rejection under a reused id. A match calls `ActivityEngine.markPermissionRejected`, an out-of-band method (like `markBackgroundShellEnded`) rather than a synthesized event - routing it through `processEvent` would hit the resume re-arm above and pin a denied session `thinking`. It clears the flag, drops the awaited tool's now-stale `pendingToolStack` entry (mirroring the Idle clamp), and deliberately leaves `turnActive` untouched: false at the common depth-0 case (already cleared by the initiating `idle:permission`, so the predicate lands on `idle`), or still true when the prompt was raised inside a live subagent (`subagentDepth > 0` kept it set, so the predicate correctly falls back to `thinking` instead). A session whose pending stack was empty when the prompt fired (`permissionAwaitedToolId` null) has no id to check and is left exactly as it behaves today - a looser match is exactly the hazard the awaited-tool-id gate above exists to prevent. Only a REJECTION is reported; an approval already clears via the normal `ToolEnd` path, and adding an approved branch here would be the only way this poll could itself produce a false `thinking` (a poll racing a dropped `ToolEnd`). Trigger label: `event:permission-rejected:transcript`.

## Tool tracking (stack with correlation IDs + LIFO-by-name fallback)

`pendingToolStack: Array<{ id?: string; name: string; launchesSubagent?: boolean }>` records in-flight tools in start order. `currentTool` always reflects the top of the stack and is exposed via `ActivityReason` for the TaskCard hover tooltip ("Running Bash").

ToolEnd matching priority:
1. **By correlation id** - when both events carry `event.toolId` (Claude's `tool_use_id` extracted via the `extractToolId` directives, top-level and nested), exact removal regardless of stack position. Solves the duplicate-name and out-of-order cases.
2. **LIFO-by-name** - fallback when an event has no toolId or the id didn't match (drift recovery from hook drop or version skew).
3. **Raw pop** - fallback for `Interrupted` (no tool name carried).

Hard reset on `pendingToolCount === 0`: the stack is cleared even if name desync left dangling entries. Idle events also clear the stack (see "Idle clamp" below).

Adapters opt into ID correlation by adding `extractToolId(['<field>'])` and `extractToolId(['<field>'], { nested: '<parent>' })` directives to their hook config. Adapters without correlation IDs leave `event.toolId` undefined and the engine falls back to LIFO-by-name automatically - no breaking change.

## Internal CLI agents' tools

Claude Code runs agents of its own after a Stop, each ending in an id-only `subagent_stop` (`detail: ''`) that the engine already ignores. Some of them run tools. The likeliest one, inferred and not captured, runs the suggested next prompt ahead of time and stops at the first tool it may not run, so its `tool_start` (Skill, ScheduleWakeup, SendFeedback, an MCP tool) gets no `tool_end`. Counted, that start reopened the turn the Stop had just ended: `workSerial` moved, the turn end's automations judged their turn stale and ran nothing, and the stuck-pending-tools watchdog idled the card minutes later. A local scan of event logs found the orphaned shape 70 times, each a second or three after a Stop.

Claude's tool hooks carry `agent_id` whenever the tool ran in an agent context of its own, so the adapter extracts it into `SessionEvent.subagentId` on `PreToolUse`, `PostToolUse` and `PostToolUseFailure`. A capture on CLI 2.1.303 (`tests/fixtures/claude-tool-hook-agent-id.jsonl`) shows the main agent's tool hooks with no `agent_id`, and an Agent-tool subagent's with the id its `SubagentStart` named, which lands before its first tool. That a post-Stop internal agent's tool hooks carry its id is inferred from its own id-only `SubagentStop`: a headless run starts none to capture. A tool event (`tool_start`, `tool_end`, `interrupted`, and the bg-shell remaps) whose id never fired a `subagent_start` is an internal agent's (`isInternalAgentToolEvent` in `event-handlers.ts`). The engine bumps `internalAgentToolEvent` and does nothing else: no counter, no `lastSignalAt`, no `workSerial`, no `turnActive`. `SessionTelemetry.ingestEvents` asks `ActivityEngine.isInternalAgentEvent` first and also skips everything after the activity log: the usage count, the PTY-tracker suppression, the plan-mode trail, the plan-exit, PR and push detectors, and the background-shell PID capture. The event stays in the activity log and still reaches the engine, which only counts it.

The test is "never started", not "not live": a background subagent re-prompted after its first named stop (task #759) runs tools under an id the ledger reads `stopped`. It reads `startedSubagentIds`, every id a `subagent_start` named (1024, oldest first), not the lifecycle ledger, whose stopped-first eviction at 64 ids would forget exactly that agent in a `/code-review` fan-out. It is also off while an id-less start holds a depth slot, so a CLI whose SubagentStart carries no id never has its subagents' tools dropped. Pinned by `session-033-internal-agent-tool-after-stop.jsonl`.

## Idle clamp

When a non-permission `Idle` event arrives, the engine forcibly clears `pendingToolCount`, the stack, and `currentTool`. The agent's turn is done; any unmatched ToolStart events are stale by definition (PostToolUse hook dropped, tool force-killed, etc.).

Permission idles bypass the clamp because the agent paused awaiting approval and may resume the same tool.
