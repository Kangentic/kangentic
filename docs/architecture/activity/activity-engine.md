---
type: Reference
title: Activity engine
description: "How Kangentic decides a session is thinking, idle or in permission: the hook-to-ActivityEngine pipeline, ActivityState and ActivityReason, the kind of a wait (question or approval), strategy variants per adapter, the 400ms stability window, heartbeat recovery and idle provenance, Ctrl+C synthesis, the open-work ledger, the debug overlay and trace labels."
tags: [activity, engine, state-machine, hooks]
sources:
  - resource: src/main/activity-engine/engine/
  - resource: src/main/activity-engine/session-telemetry.ts
  - resource: src/main/activity-engine/open-work-ledger.ts
  - resource: src/main/activity-engine/conversation-switch-gate.ts
  - resource: src/main/activity-engine/user-interrupt-coordinator.ts
  - resource: src/main/activity-engine/pty-activity-tracker.ts
  - resource: src/main/activity-engine/activity-interval-recorder.ts
  - resource: src/main/activity-engine/activity-interval-store.ts
  - resource: src/main/activity-engine/trace-recorder.ts
  - resource: src/main/activity-engine/usage-accumulator.ts
  - resource: src/main/activity-engine/rate-limit-ledger.ts
  - resource: src/main/agent/event-bridge.js
  - resource: src/shared/activity-state.ts
  - resource: src/renderer/components/board/ActivityReasonTooltip.tsx
  - resource: src/renderer/components/board/activity-reason-text.ts
  - resource: src/renderer/components/board/agent-wait.ts
  - resource: src/shared/types.ts
    title: ActivityState, PermissionWaitKind, ActivityReason, ActivityDetectionStrategy, SessionEvent.toolId, SessionEvent.subagentId, SessionEvent.planMode, SessionEvent.waitKind, SessionEvent.launchesSubagent
---
# Activity engine

Kangentic tracks whether each agent session is **thinking** (working on a turn), **idle** (waiting for input or done), or in a **permission** state (paused awaiting the user's answer or approval). This drives the task card spinner, the desktop "task done" notification, the in-app idle toast, idle-timeout suspend, and auto-focus behavior.

## Why this matters

The "task done" notification is one of Kangentic's core differentiators. Agents that have started backgrounded work (`Bash(run_in_background:true)`) are usually still working until those processes exit, even after the agent's hook stream has gone quiet. A session that prematurely shows "idle" causes a false notification; one that's stuck in "thinking" never notifies at all. Both are user-visible bugs.

"Usually", because a background shell can also be one the agent is merely OBSERVING rather than working through - `/preview`'s watcher blocks for hours on a service the user controls. Those opt out explicitly; see [Opting a background shell out of the hold](background-shells.md#opting-a-background-shell-out-of-the-hold).

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
   │                   │ │ - stuck-pending-tools 5m│ │ (proc-tree)│ │ (3s settle)│
   │                   │ │ - stale-thinking (180s) │ │            │ │            │
   │                   │ │ - stuck-subagent (5min) │ │            │ │            │
   └───────────────────┘ └─────────────────────────┘ └────────────┘ └────────────┘
                                                          │
                                                          ▼
                                                ┌────────────────────┐
                                                │ ProcessTreeProbe   │
                                                │ (pty host)         │
                                                │ Win: Toolhelp      │
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
| `src/main/activity-engine/engine/event-handlers.ts` | Pure `updateCounters` / `updatePermissionFlag` - the big switch on event type - plus `releaseSubagentSlots`, the one way a reset zeroes `subagentDepth` |
| `src/main/activity-engine/engine/counter-snapshot.ts` | `snapshotCounters` and `formatCounterDelta` for the audit log |
| `src/main/activity-engine/engine/state-factory.ts` | `createSessionEngineState` initial-state factory |
| `src/main/activity-engine/engine/watchdog.ts` | `WatchdogHold` table + `findActiveWatchdogHold` lookup - declarative safety nets |
| `src/main/activity-engine/engine/snapshot-writer.ts` | `ActivitySnapshotWriter` - atomic JSON snapshots for post-mortem diagnostics |

Surrounding infrastructure:

| File | Role |
|------|------|
| `src/main/activity-engine/session-telemetry.ts` | Wires the engine to event ingestion + PTY tracker + watchers + user-interrupt coordinator |
| `src/main/activity-engine/open-work-ledger.ts` | What each session still has open (tool calls, background shells, background subagents), from its hook events and closed only by a real end (see [Open work](#open-work)) |
| `src/main/activity-engine/user-interrupt-coordinator.ts` | 3-second settle timer for Ctrl+C; synthesizes Interrupted if engine still hot |
| `src/main/activity-engine/usage-accumulator.ts` | Per-tool usage stats (call count, run time paired by `toolId`, calls that waited on the user, cost, tokens) and the per-session usage cache. Stamps each reported rate-limit window with its reset generation before caching it, and brings sibling caches up when a reset opens. A report that leaves a window out keeps the session's last value for it (an idle Claude status carried only the seven-day window, measured), so the cache a renderer reload rebuilds its rate-limit snapshot from still holds both |
| `src/main/activity-engine/rate-limit-ledger.ts` | Per-session rate-limit history that stamps each window's reset `generation`, so a free usage reset (usage falls, `resetsAt` stays) replaces stale sibling reports |
| `src/main/activity-engine/pr-command-detector.ts` | PR command pattern detector |
| `src/main/activity-engine/push-command-detector.ts` | `git push` destination capture: remembers the branch a Bash push named on ToolStart, reports it on that call's ToolEnd (paired by `toolId`) as the task's `pushed_branch` PR anchor; parser in `src/main/git/push-command.ts` |
| `src/main/activity-engine/pty-activity-tracker.ts` | PTY-byte fallback for non-hook agents |
| `src/main/activity-engine/background-shell/watcher.ts` | Process-tree-based natural-exit detector |
| `src/main/activity-engine/background-shell/process-tree.ts` | Cross-platform descendant enumeration; `listAllProcesses` shared once per cycle |
| `src/main/activity-engine/background-shell/looks-like-shell-id.ts` | Shell-id shape gate |
| `src/main/agent/event-bridge.js` | Generic hook-to-JSONL bridge; decodes typed `<kind>:<base64(JSON)>` directives (extractTool, extractToolId, extractSubagentId, extractPlanMode, extractDetail, setTypeWhen, markSubagentLaunch, ...) built by `src/main/agent/shared/directive-builders.ts`. The events-path argument is either a literal path or the sentinel `env:<NAME>`, resolved from the hook process environment at run time - used by adapters whose CLI has no per-session settings mechanism (Grok): one static per-cwd hook file routes each session's events via that session's own spawn env, and a session without the variable (the user's own manual CLI run) is a silent no-op |
| `src/main/agent/adapters/claude/hook-manager.ts` | Claude Code hook configuration |
| `src/main/agent/adapters/claude/permission-rejection-transcript.ts` | Manual-deny detector (task #640): scans the durable transcript for a rejected `tool_result` no hook can report |
| `src/main/activity-engine/plan-approval-gate.ts` | Runs first in `SessionTelemetry.ingestEvents`: drops or holds the permission idle of the plan prompt, and of an allowed tool the adapter's hook answers, for a plan Kangentic approves, and emits `plan_auto_approved` (see [Plan approval gate](event-types.md#plan-approval-gate)) |
| `src/main/activity-engine/plan-mode-trail.ts` | Each session's reported plan-mode changes (`SessionEvent.planMode`), stamped at ingest, so the turn-end runner can ask whether a session had left plan mode by a past move |
| `src/shared/types.ts` | `ActivityState`, `ActivityReason`, `EventType`, `SessionEvent.toolId`, `SessionEvent.subagentId`, `SessionEvent.planMode`, `SessionEvent.launchesSubagent` |

## ActivityState

```ts
type ActivityState = 'thinking' | 'idle' | 'permission';
```

Three top-level states:

- **`thinking`** - agent is working. Spinner shown on task card. Notifications NOT fired.
- **`idle`** - agent is truly done. Notification fires. Auto-focus / auto-suspend can act. The
  desktop notify decision (cooldown, focus gate, active-project gate, title assembly) is owned by
  `src/main/notifications/desktop-notifier.ts`, which listens to `SessionManager`'s own `activity`
  event directly rather than a renderer round-trip. The in-app toast half lives in the renderer
  (`src/renderer/utils/idle-toast.ts`) and fires on the opposite condition: the user is on this
  project but is not already looking at that session's terminal. It is edge-triggered off the
  previous state, because `session:activity` also carries reason-only refreshes that must not
  retrigger it.
- **`permission`** - agent paused waiting on the user: a question it asked or an approval it wants. Distinct from `idle` so the UI can render a different affordance (the speech bubble or the crested shield against the envelope). Both notification channels bucket it WITH `idle` through `requiresUserInteraction`; only the alert text differs. What the wait is for rides on its reason, not on a fourth state (see [The kind of a wait](#the-kind-of-a-wait)).

## ActivityReason (discriminated union)

Every transition emits both an `ActivityState` AND an `ActivityReason` describing WHY:

```ts
type ActivityReason =
  | { kind: 'idle'; since: number; inOwnCall?: true }
  | { kind: 'permission'; since: number; waitKind?: PermissionWaitKind }
  | { kind: 'tool';            pendingCount: number; currentTool: string | null }
  | { kind: 'subagent';        depth: number }
  | { kind: 'background-shell'; count: number; ids: readonly string[] }
  | { kind: 'turn-active' };
```

The reason also moves WITHOUT the state moving, and it is pushed on its own when it does. A
session stays `thinking` from before the first subagent spawns until after the last one stops, so
a transition-only push leaves the reason frozen at whatever it was when the turn began. On a
recorded 9-way `/code-review` fan-out (`tests/fixtures/replay/session-029-*.jsonl`) that was 3
deliveries across 711 events while the derived kind changed 176 times. `ActivityEngine` therefore
tracks `lastPushedReason` and calls a second callback, `onReasonChange`, whenever `reason.kind`
differs from the last one delivered (`sameReasonShape` in `engine/predicate.ts`). The gate is the
KIND, plus a permission wait's `waitKind`: tool churn moves `currentTool` and `pendingCount` on
nearly every event, and reporting on those would push about four times a second per session, but a
question raised while an approval is open stays `permission` throughout and its card must still
swap its mark. `SessionManager` emits it as `activity-reason`, NOT as `activity`, because the
notifiers, turn-completion auto-move, the terminal submit scheduler, and the interval recorder all
read an `activity` emit as a real transition.

`since` (epoch ms) is `SessionEngineState.needsUserSince`: when the session FIRST entered a
needs-user state. It spans both `idle` and `permission` - a `permission <-> idle` crossing keeps
the original park time rather than resetting it - and is cleared only on returning to `thinking`.
The renderer uses it to show elapsed wait time ("Idle for 12m") in the TaskCard hover tooltip
(`formatActivityReasonText` in `src/renderer/components/board/activity-reason-text.ts`, and
`activityReasonIcon` in `src/renderer/components/board/ActivityReasonTooltip.tsx`).

`inOwnCall` is not the engine's. Main adds it to the renderer's push (`markOwnCallIdle` in
`ipc/handlers/sessions.ts`) on the idle that ends the turn in which the session moved its own task
or paused its own workflow, while that call is still taking effect. The call ends the session about
1.5 s later (see
[A call that ends the caller's own session](../sessions/suspend-and-cleanup.md#a-call-that-ends-the-callers-own-session)),
so the renderer raises no "Agent finished" toast and moves no bottom panel focus for it
(`endsOwnCallTurn`). The desktop notifier skips the same idle through `isSessionInOwnCall`. A
permission prompt in that turn still notifies both ways.

The renderer uses `reason.kind` to pick an icon and inline label for the TaskCard hover tooltip. The
kinds that describe agent activity itself render the shared `@kangentic/branding` activity marks
via `ActivityMark`, so they match the TaskCard indicator exactly (`idle` -> `agent-idle`,
`permission` -> `agent-question` or `agent-approval` by its `waitKind`, `turn-active` ->
`agent-working`); the kinds that name a specific cause have no counterpart in that set and stay
Lucide (`tool` -> Wrench, `subagent` -> Users, `background-shell` -> Terminal).

### The kind of a wait

A `permission` wait is a question the agent asked or an approval it wants
(`PermissionWaitKind = 'question' | 'approval'`, GitHub #452). Each adapter says which at the
source, on the `idle:permission` event's own field, `SessionEvent.waitKind`. Never in `detail`:
about ten sites test `detail === IdleReason.Permission`. A hook adapter tags its entry with an
event-bridge directive (`setWaitKind`, `setWaitKindWhen`, `appendPermissionWaitForTool`, see
[bridge scripts](../../integrations/agents/bridge-scripts.md)); a parser sets the field itself. Which
agents report it, and from what signal, is each agent's doc.

The engine keeps it as `permissionWaitKind` beside `permissionPending`, set by the wait that raised
the flag (the newest wait wins) and cleared at every site that clears the flag: the awaited call's
own start or end, a depth-0 tool event the engine cannot tell apart from it, Prompt, Interrupted,
TurnFailed, a SubagentStart the awaited call started, a non-permission Idle, `forceThinking`,
`forceIdle`, a rejection read from the transcript and a terminal TurnRetrying. The permission
reason carries it as `waitKind`, absent rather than null when the agent did not say, and the debug
overlay shows it as Wait kind. The phone's wire carries it too (protocol 0.26.0):
`toActivityReasonWire` builds the permission reason field by field and adds `waitKind` only when the
reason has one, and the `input-required` push seals the snapshot's `permissionWaitKind` as its own
`waitKind`, so a phone titles the push "Agent has a question" or "Agent needs your approval".

Every new wait an adapter reports needs an end the engine already clears on, and the end must not
fake a turn end: a plain non-permission Idle from a parser is read as the agent's own Stop
(`turnEndSource === 'stop'`) and runs the column's turn-end automations. A wait must also land
AFTER its own tool's `tool_start`. Before it the engine cannot name the awaited call, and a depth-0
tool start clears a wait whose call it cannot name. The PTY tracker leaves a
wait alone (its silence timer fires only while `thinking`, and PTY output forces thinking only from
`idle`), but a `detectIdle` prompt match does end it.

A parallel sibling that finishes does not end a wait. A live `/preview` run showed why: Claude ran
a ToolSearch beside AskUserQuestion, the question opened, and the search ended 30 ms later. The
engine took the stack top (the search, which started second) as the awaited tool, and a depth-0
ToolEnd cleared the wait anyway, so the card showed thinking under an open question. The envelope
had the same gap before the kind existed. The rules in `updatePermissionFlag` close it:

- The awaited tool (`permissionAwaitedToolId`) is the newest pending entry the event's `tool`
  names, and the stack top only when the event names none or names no pending call. Claude, Qwen
  and the appended Codex and Antigravity waits carry `tool`. The usage accumulator credits the waited call by the
  same rule.
- The other pending ids at that moment are the wait's siblings (`permissionSiblingToolIds`,
  engine-internal). A depth-0 ToolEnd of a sibling leaves the wait open and drops that id.
- Another call's depth-0 ToolStart or ToolEnd clears the wait only when the engine cannot tell it
  from the awaited call: the event carries no `toolId`, or the awaited call has none. With both ids
  known, the wait stays open until its own call starts or ends, the transcript poll reads a denial,
  or the turn ends (task #952).
- A SubagentStart clears it only when the awaited call is one that starts subagents. The adapter
  marks those calls on their `tool_start` (`SessionEvent.launchesSubagent`, from the
  `markSubagentLaunch` directive; Claude names `Agent` and `Task`), and the engine keeps the mark
  on the pending entry (`PendingTool.launchesSubagent`). A parallel subagent started in the same
  batch says nothing about the prompt (see [Permission flag](predicate.md#permission-flag) for the
  overnight case that showed it).

`activity-engine-wait-kind.test.ts` replays the captured four events.

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
same value it writes to the `_ms` column, so the two can never drift. Read directly via the
`kangentic_get_activity_intervals` MCP tool (see `docs/integrations/mcp-server/session-tools.md`) or `kangentic_query_db`, and
indirectly by the usage dashboard: `ActivityIntervalStore.getActiveTotals(sinceMs, untilMs)` sums
the CLOSED `'active'` intervals in a window behind `usage:getDashboardStats`, backing the
`activeMs` / `activeSessionsCovered` KPI pair (the Avg Active tile) and the per-project Avg Active
column. Those two travel together because this ledger covers FEWER sessions than `usage_history`
does - per-interval recording shipped later - so the average is over the sessions with coverage,
never over the Sessions count.

A quit or a crash leaves the interval it was in open (`ended_ms IS NULL`). Overnight, such rows
read as agents still waiting hours after their sessions had ended. So the first open of a project
in a launch closes them (`ActivityIntervalStore.closeIntervalsLeftOpen`, called from
`resumeSuspendedSessions` before it starts any session, task #952). A row closes at its session's
recorded suspend or exit time with `exit_trigger` `app-quit`, and with neither recorded at its own
start with `app-crash`, so the sweep never adds time the session may not have spent. A session this
launch already runs (a phone started it, the project was open before) keeps its row. Readers still
filter open rows.

Priority ladder: `permission > tool > subagent > background-shell > turn-active > idle`. Anchored to `state.activity` for consistency - when forced paths (Interrupted, forceIdle) commit a transition that diverges from the bare predicate (e.g. clearing all counters on Esc), the reason follows the committed state.

## ActivityDetectionStrategy variants

Each adapter declares one strategy via its `runtime.activity` field (constructed through the `ActivityDetection` factory). The three variants:

| Kind | Hooks fire? | PTY fallback? | Used by | Semantics |
|------|-------------|---------------|---------|-----------|
| `hooks` | Yes (sole source of truth) | No | Claude Code | Activity state is driven exclusively by hook deliveries. PTY traffic is ignored for state transitions. |
| `pty` | No | Yes | Aider, Cursor, Warp, Droid, Ollama, Goose (today) | No hook protocol in use. For most of these the CLI has none; Goose is the exception, having a hook system that this adapter does not wire yet (see `docs/integrations/agents/goose-cli.md`). The PTY tracker emits `forceIdle` after a silence window, optionally short-circuited by an adapter-supplied `detectIdle(data)` regex that matches the agent's input prompt. |
| `hooks_and_pty` | Yes (primary) | Yes (fallback) | Gemini, Qwen, OpenCode, Copilot, Grok, Antigravity, Codex, Kimi | Hooks are authoritative when they fire (Kimi has none: its `runtime.sessionHistory` wire.jsonl is the structured source, and its first read suppresses the PTY tracker; Codex's rollout opts out of that suppression with `suppressesPtyFallback: false`, so a session whose hooks Codex did not confirm keeps the tracker); the PTY tracker is auto-suppressed on the first hook event and re-engages only if hooks stop arriving. For Grok the fallback is load-bearing by design: its project hooks are folder-trust-gated and silently skipped in an untrusted directory, so the PTY tracker carries activity until trust lands. Antigravity's hook events are `prompt` (PreInvocation), `tool_end` (PostToolUse), and `idle` (Stop); its hooks never fire in `-p` print mode, where the PTY fallback (silence timer + the `? for shortcuts` idle-footer regex) carries detection. |

Both `pty` and `hooks_and_pty` may pass an optional `detectIdle(data: string) => boolean` for instant idle detection from the input-prompt regex. Without it, idle is inferred from a silence timer.

## Stability window (400ms)

When the predicate flips from `thinking` to `idle` due to a Stop event or a counter clearing, the engine waits 400ms before emitting the transition. If a thinking signal arrives during the window, the pending idle is cancelled. Prevents `idle → thinking → idle` flicker from out-of-order hook arrivals.

Bypassed by:
- `Interrupted` (Esc - instant, no flicker concern)
- `forceIdle` (PTY-driven; already debounced 3s in PtyActivityTracker)
- Stale-thinking watchdog (already 180s, or 30s on a heartbeat-forced turn)

Configurable via `ActivityEngineOptions.idleStabilityWindowMs`. Tests set this to 0 for deterministic timing.

## Heartbeat recovery and idle provenance

For a pure-`hooks` agent (Claude) the `PtyActivityTracker` never fires, so the status-file heartbeat is the ONLY force-thinking path. `SessionTelemetry.processStatusUpdate` runs on every `status.json` change: if the engine is idle and the agent's cumulative **OUTPUT** tokens (`contextWindow.totalOutputTokens`) grew while idle for >1s, it calls `forceThinking` - the agent silently resumed generating. Output only, never input: Claude's `totalInputTokens` is current context-window occupancy (cache + input) that climbs while parked at the prompt with no generation, so summing it would false-flip a correct idle to thinking on a parked session (#295 / #297, fixed by the output-only compare in #298).

Output-only is necessary but not sufficient. A parked session still ticks `total_output_tokens` upward on background, non-turn housekeeping (compaction / summarization) emitted with NO turn-start hook, and the heartbeat read that as "resumed generating" and pinned a parked agent ACTIVE (task #294). So the engine records **idle provenance** on `SessionEngineState.idleAuthoritative`:

- **Authoritative** (`true`): the idle was entered via a genuine hook turn-end - a non-permission `Idle` hook, an `idle_hint` that cleared `turnActive`, `Interrupted`/`TurnFailed`, or a `turn_retrying` whose turn had already wound down (`idleHintPending`) or ended (`!turnActive`), which the engine treats exactly like a terminal `TurnFailed`. "The agent told us the turn ended." Set at those source sites in `processEvent` (the synthetic watchdog `Idle/Timeout` is excluded), and out of band by `markIdleAuthoritative` (see below), the one writer outside the hook stream.
- **Fallback** (`false`): the idle was entered via a watchdog hatch resetting a stuck holder, via `forceIdle`, or it is a brand-new never-started session. "We only guessed the turn ended."

The heartbeat may force-think ONLY on a non-authoritative idle (`!state.idleAuthoritative`). This kills the housekeeping-re-activates-a-parked-agent class while preserving the net's real job - recovering a fallback idle whose agent is actually generating (a dropped turn-start hook leaves a non-authoritative idle, so the net still fires). The trade is a rare, self-correcting false-IDLE (a fully-hook-dropped new turn after an authoritative idle shows idle until any hook lands) for eliminating the common false-ACTIVE pin. Pinned by the real-capture fixture `tests/fixtures/replay/session-020-false-active-parked-housekeeping` (asserts `forceThinking: 0` across the parked output growth) and the provenance unit tests.

One caller asserts provenance from OUTSIDE the hook stream. The ORDINARY settings-change restart (`restartSessionForSettingsChange` called with no `resumePrompt`) respawns with `--resume` under a contract of "no prompt, no auto_command", but the CLI's resume-picker context reload is an internal turn that fires no hooks while growing `total_output_tokens` - exactly the shape the heartbeat force-thinks. So a ContextBar model switch painted a parked agent `thinking` for a fixed 30s (`DEFAULT_STALE_AFTER_HEARTBEAT_FORCED_MS`). `ActivityEngine.markIdleAuthoritative(sessionId)` (reached through `SessionManager` and `SessionTelemetry`) sets the flag on an already-idle session without committing a transition, asserting only what the restart already guarantees. It is the one writer that is neither a turn-end, a `forceIdle`, nor a watchdog hatch, and it no-ops silently on three conditions: the engine is disposed; the session has no engine state yet (a respawn still `queued` behind `SessionQueue` has not reached `initSession`, so that resume is **not** covered and can still be force-thought); or the session is not idle (a fresh-intent respawn is seeded `thinking`).

Two status writes are never proof of work, because they compare two different conversations'
totals: a session's FIRST write, whose cached usage is only the spawn's model seed while a resumed
conversation reports its whole history, and a write whose agent session id differs from the last
one reported (a `/resume` or `/clear` inside the session; Claude holds such a write until a hook names the id,
see the next paragraph). `processStatusUpdate` treats either as a new baseline, with no previous usage to grow against, so neither force-thinks nor keeps a
thinking state warm. Without it a Command Terminal resumed from its Earlier list, or switched
with `/resume`, read as working for the heartbeat's 30 seconds.

For Claude, a write whose id the session has not adopted never reaches the baseline at all. Every
process started with the session's `--settings` writes the same status file, and Claude Code's
background daemon runs an empty spare beside the conversation it moved. The id capture adopts a
changed id only after a SessionStart hook that moved the conversation named it
(`ConversationSwitchGate`, see [Mid-session fork reconcile](../../integrations/agents/session-history.md#mid-session-fork-reconcile-clear-moves-the-conversation-to-a-new-id)).
A write from any other writer returns before the usage cache, the heartbeat and the stale-thinking
refresh, so the spare's zeros never reset the baseline.

The SAME function is also rung 3 of the auto_command delivery ladder, called with a `resumePrompt` so the command rides the spawn as the CLI's prompt argument (see [Command Injection](../automations/command-injection.md)). That call deliberately SKIPS the assertion (`if (resumedSessionId && !options.resumePrompt)`): a resume carrying a prompt starts a real turn, so claiming the session is authoritatively idle would be a lie, and the heartbeat force-thinking it is then correct rather than the bug described above. A command that cannot ride the command line (lines a `.cmd` shim launch would flatten, or over the cap) is the exception: the engine keeps it off, asserts idle on the new session itself, and the restart types it in (see [How the resume prompt arrives](../sessions/resume.md#how-the-resume-prompt-arrives)).

The heartbeat's `markThinkingSignal` keep-warm - which refreshes `lastSignalAt` so a genuinely-thinking session survives the 180s stale-thinking watchdog - fires only on **proof of work**: OUTPUT tokens grew since the previous status write, AND no `idle_hint` is pending. Each condition closes a distinct false-ACTIVE pin, both caused by parked-TUI statusline churn re-blinding the (`signal`-anchored) net:

- **The `idle_hint` gate** stops the churn after a real turn ends - the agent reported waiting-for-input, so its repaints are noise (task #294).
- **The growth gate** handles the case with NO `idle_hint` at all. A `--resume` resume-picker reload is a CLI-internal turn that fires no turn hooks, so when it finishes and Claude parks, no `idle_hint` ever arrives and the idle-hint gate cannot help; only frozen-output detection stops the churn from re-warming `lastSignalAt` forever and starving the watchdog (task #331). Live generation keeps re-warming because output keeps growing (and foreground streaming keeps `lastPtyOutputAt` fresh regardless, #246). Pinned by the real-capture fixture `tests/fixtures/replay/session-021-false-active-resume-picker` (asserts the stale-thinking net self-heals to idle) plus the `#331` unit tests in `session-telemetry-activity-decisions.test.ts`.

`markThinkingSignal`'s growth gate closes the SIGNAL-re-warm leg of the resume-picker scenario, but a chatty parked TUI whose statusline repaints never leave a gap over 180s still pins the stale-thinking net's `signal-or-pty-output` anchor via `lastPtyOutputAt` indefinitely - the PTY-output-ANCHOR leg (task #364). The heartbeat's `forceThinking(sessionId, true)` call (the one immediately above, "resumed generating") is the ONLY caller that records `turnForcedByHeartbeat` provenance; the stale-thinking watchdog reads it to narrow its own anchor to `signal` for a hook-less turn too, so it self-heals ~180s after output froze rather than ~180s after the last PTY repaint (or never, if the repaints never stop). See [the stale-thinking watchdog's `parkedAnchor`](watchdog.md#3-stale-thinking-watchdog-180s).

## Ctrl+C user-interrupt synthesis (3s)

When the user presses Ctrl+C in a session terminal, the renderer fires the `notifyUserInterrupt` IPC alongside the regular `\x03` write to the PTY. Telemetry arms a 3-second settle timer per session. After the window, if the engine is still in `thinking` AND state is hot (`pendingToolCount > 0` OR `turnActive`), telemetry synthesizes an `Interrupted` event with `detail: 'user-ctrl-c'`. The engine's Interrupted handler clears all counters and commits idle immediately.

If Claude's hooks already recovered the engine state during the settle window, the synthetic is a no-op (state isn't hot). Multiple rapid Ctrl+C presses collapse to one - the existing timer is cleared and re-armed each time.

Without this path, hook-drop scenarios on Ctrl+C have to wait for the 5-minute stuck-pending-tools watchdog to fire.

## Open work

The engine's counters exist to paint the card, and a reset that is right for a card says nothing
about whether the work ended: the background-shell hatch drops a shell after five quiet minutes, and
a watchdog or a non-permission idle empties the pending tool stack. Overnight, three failures came
from reading a reset as an end. A recovery nudge typed into a permission prompt the engine had
lost. The low-memory pause stopped agents whose own gate was still running in the background. The
workflow step check judged a session by its reply's wording, with the same gate running each time.

`OpenWorkLedger` (`open-work-ledger.ts`, task #952) keeps its own record from the same hook events.
`SessionTelemetry` feeds it each event after the engine has seen it, and only an event that says the
work ended closes an entry:

- **A tool call** opens on its `tool_start` and closes on its own `tool_end` (by id, else the newest
  open call of that name), on its move to a background shell, on `interrupted` or `turn_failed` (a
  synthesized interrupt included), on the main agent's turn end, on a denial read from the
  transcript, and at the session's end. A `subagent_start`, a `prompt`, an `idle_hint` or a reset
  closes nothing.
- **A background shell** opens when the engine starts holding a named shell, so an exempt service
  never opens. It closes on an end that names it, a PID exit or transcript drain the watcher
  applied, being marked a service, and the session's end. The hatch and the output-quiescence
  reclaim close nothing.
- **A subagent** opens on its `subagent_start` and closes on its named `subagent_stop`,
  `interrupted`, `turn_failed` and the session's end. One started before the main agent's latest
  turn end is background work.

`SessionManager.getOpenWork(sessionId)` reads it. Each spawn starts the session's ledger empty, so a
resumed agent carries nothing its old process left open. Three readers act on it: the automated
keystrokes guard, where an open tool call holds every automated key (see
[Command injection](../automations/command-injection.md#the-automated-keystrokes-guard)); the
low-memory pause, which skips an agent with an open background shell or background subagent; and
the workflow step check, which reads open background work as still working. A lost end fails safe:
Kangentic types nothing and pauses nothing while an entry is open, and the workflow's working wait
bounds how long it waits.

## Resume reconciliation (deliberately none)

When Kangentic restarts mid-session the engine starts clean while the session's shell may still have living descendants. A `reconcileBgShellsOnResume` used to enumerate those at resume time and adopt them as anonymous bg shells. **It was deleted, and must not be reintroduced:** the adopted count was a phantom the engine had no way to drain, so a resumed session sat in `thinking` indefinitely (the "activity engine stays thinking on idle sessions" bug).

The resume path now adopts nothing. Any surviving shell-like descendants are instead folded into the watcher's first-cycle `preExistingHelpers` baseline, so they are treated as helpers rather than as background work - deliberately over-inclusive at resume, as `SessionWatchState.helperPids` notes. Pinned by the `performSpawn - resume path does not adopt bg shells` guard in `tests/unit/session-spawn-flow.test.ts`.

## Observability

### TaskCard hover tooltip

The activity mark on each task card is wrapped in the app's Tooltip. Its label is `formatActivityReasonText` and it leads with `activityReasonIcon`, one glyph per reason kind: "Running Bash", "2 subagents active", "1 background shell (bdrb9enzm)", "Asking you a question for 2m", "Waiting for your approval for 1m", "Waiting on you for 2m" (a wait of unknown kind), etc. The mark's `aria-label` is the same text, so a screen reader hears the reason once, without hovering.

### Activity Engine Debug Overlay (Developer settings tab)

A global setting under **Developer → Activity Engine Debug Overlay** enables a floating panel showing live engine state. Global, not per-project: Developer is a system tab, and the overlay reads `globalConfig` precisely so a project override cannot toggle it. It shows:
- Current activity + reason for each running session
- Raw counters (tools, subagents, bg shells)
- **Compensation counters** (`staleThinking`, `bgShellHatch`, `stuckPendingTools`, `forceThinking`, `forceIdle`, `unmatchedBgShellEnd`, `ignoredInnerSubagentStop`, `duplicateSubagentStop`, `duplicateSubagentStart`, `internalAgentToolEvent`, `stuckSubagent`) - monotonic tallies of silent recovery events. In a clean session the watchdog and forced-transition counters read 0; any non-zero value flags a watchdog / forced transition / unattributable or discarded event that did not visibly flip the activity pill. (`ignoredInnerSubagentStop` is the benign exception: non-zero is normal on any session that ran subagents - it is the count of spurious empty-detail inner stops the engine correctly discarded. `duplicateSubagentStop` is benign too: it counts second named stops from re-prompted subagents, and late stops from agents whose slot a reset already released, task #759. It also counts a `SendMessage` continuation's own stop when its first run's late stop already released the slot the two share, task #835. `duplicateSubagentStart` is benign as well: it counts starts for an already-live `subagentId` that took no second slot, task #835. When both duplicate counters rise for one agent, its first run's stop landed after the restart. `internalAgentToolEvent` is benign too: it counts tool events from internal CLI agents the engine only logged, see [Internal CLI agents' tools](predicate.md#internal-cli-agents-tools).)
- The last 5 transitions from the 50-entry ring buffer (the full ring is read through `kangentic_devtools_engine_state`)
- **PTY chunk timeline** - bucketed PTY arrivals over the last ~120 seconds (100ms buckets) from `ActivityStatsSnapshot.recentPtyChunks`, rendered by `ActivityTimeline` alongside the watchdog deadline (`lastSignalAt + thresholdMs`). Empty in production builds where the trace recorder is dead-code-eliminated.

Polls `getActivityStats(sessionId)` every 2 seconds. Hidden by default - power users discover via Developer settings; bug reporters can enable + screenshot.

### Reading a transition trace

Each entry in `recentTransitions` (the ring of 50 returned by `getStatsSnapshot` / the MCP `kangentic_devtools_engine_state` tool; the overlay renders the last 5) carries a `trigger` label naming what caused it. The label vocabulary (`TransitionTrigger` in `src/main/activity-engine/engine/shapes.ts`):

| Trigger | Meaning |
|---------|---------|
| `event:<type>` | A hook event drove the transition, e.g. `event:tool_start`, `event:prompt`, `event:idle`. |
| `event:<type>:<detail>` | A hook event with a detail qualifier, e.g. `event:idle:permission` (paused awaiting approval). |
| `event:bg-shell-ended:<shellId>` | Id-keyed named drain - the watcher saw a named shell's OS process leave the tree (Tier A PID-exit), OR reclaimed a PID-less named shell whose output froze while it showed a persistent process-tree deficit (output-quiescence reclaim). |
| `event:bg-shell-ended:transcript` | Definitive drain - the watcher observed a tracked shell's own terminal `<task-notification>` directly in the durable session transcript (task #386). Fires independent of process-tree count or output-file state; distinct from the Tier A / quiescence label above even though both are id-keyed. |
| `event:bg-shell-ended:watcher` | Tier B count-heuristic drain - an anonymous shell reclaimed by the descendant-count drop. |
| `event:bg-shells-adopted` | Resume reconciliation adopted living descendants as anonymous shells. |
| `event:bg-shell-service:mcp` | The agent marked background shells as services through `kangentic_mark_background_service`, moving them from the holding set to `exemptBackgroundShellIds` (see [Opting a background shell out of the hold](background-shells.md#opting-a-background-shell-out-of-the-hold)). |
| `event:permission-rejected:transcript` | A manually denied permission prompt (task #640) - the transcript poll observed the awaited tool's rejection `tool_result` in the agent's durable session transcript, a signal no hook can deliver. See [Permission flag](predicate.md#permission-flag). |
| `force-thinking` | PTY tracker / heartbeat recovery forced thinking (predicate saw no holder). |
| `force-idle` | PTY silence timer, Esc, or shutdown forced idle. |
| `timer:stability` | The 400ms idle stability window expired and committed a pending idle. |
| `timer:bg-shell-hatch` | A bg-shell sole-holder hold fired (named 5-min cap or anonymous 30s grace; same label, different threshold). |
| `timer:stale-thinking` | The stale-thinking watchdog fired (`turnActive` held alone, matching Idle never arrived); 180s cap, or the 30s `staleAfterHeartbeatForcedMs` budget when the turn was heartbeat-forced (`turnForcedByHeartbeat`, a hook-less `--resume` turn - see [Fast heal for the heartbeat-forced case](watchdog.md#3-stale-thinking-watchdog-180s)). |
| `timer:stuck-pending-tools` | The stuck-pending-tools hatch fired (orphaned `tool_start`, lost `PostToolUse`); 5-min cap, or the 180s `staleAfterIdleHintMs` budget when an `idle_hint` was pending. |
| `timer:stuck-subagent` | The stuck-subagent hatch fired (`subagentDepth` held > 0). Two causes: a named `subagent_stop` was dropped after its empty-detail inner stop was ignored (#237), or a wedged CLI never resumed during a live retry hold that preserved the depth (#532). 5-min cap, or the 180s `staleAfterIdleHintMs` budget when an `idle_hint` was pending. |
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

- **Watchdog Idle/Timeout:** when ANY of the five watchdog holds fires - `onTick` emits this uniformly for whichever hold `findActiveWatchdogHold` matched, before dispatching to that hold's compensation counter. That is the 180s stale-thinking watchdog, either bg-shell sole-holder hold (5-min named cap or 30s anonymous grace), the 5-min stuck-pending-tools hatch, or the 5-min stuck-subagent hatch. Pushed BEFORE the matching `onActivityChange` so the log entry appears before the state change.
- **Natural-exit `BackgroundShellEnd`:** when the watcher infers a bg shell exited naturally. Detail is `IdleReason.NaturalExit` for `onNaturalExit` (anonymous count drain), or the shell_id for `onShellPidExited` (Tier A PID-exit) and `onNamedShellLikelyExited` (a PID-less named shell reclaimed by output quiescence in a persistent deficit).

## Test infrastructure

Four test tiers:

1. **Unit** (`tests/unit/activity-engine.test.ts`, `bg-shell-watcher.test.ts`, `process-tree.test.ts`): direct engine + watcher tests with mock probe. Two parity guards ride alongside them: `activity-stats-snapshot-parity.test.ts` (the snapshot's engine and IPC copies) and `no-activity-hold-sentinel-parity.test.ts` (the no-activity-hold flag's four hand-duplicated copies).
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

### Global setting

`developer.activityDebugOverlay: boolean` - enables the debug overlay for every project on this install. Global-only, with no per-project override. Default false.

### Environment variables

- `KANGENTIC_BG_SHELL_WATCHER=0` - disables the bg-shell process-tree watcher (fallback to the sole-holder grace only).
- `SKIP_PROCESS_TREE_PROBE=1` - skips real-OS probe smoke tests in CI environments without `ps`/`pwsh`.

## History

The current design (v2) replaced a v1 three-guard state machine that had grown to 557 lines with overlapping concerns: Guard 1 (suppressSubagentWakeDuringPermission), Guard 2 (deferStopUntilSubagentFinishes), Guard 3 (deferStopUntilBackgroundShellsFinish), composite hand-off bookkeeping, a 45s stale-thinking watchdog, a 10-min Guard 3 escape hatch, and a `pendingPermissions` counter with depth-≥2 freeze logic.

The v2 single-predicate engine + process-tree watcher reduced this to ~600 lines total across `engine/activity-engine.ts` + `background-shell/watcher.ts` + `background-shell/process-tree.ts`, with a near-100% empirical hit rate on the natural-exit cases that motivated the rewrite.
