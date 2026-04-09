# Activity Detection

## Overview

Kangentic tracks whether each agent session is **thinking** (actively using tools) or **idle** (waiting for input or stopped). This state drives the task card spinner in the Kanban board UI.

Each adapter declares an `ActivityDetectionStrategy` on its `runtime.activity` field that selects between hook-based events, PTY pattern detection, or both. The Claude Code pipeline (hooks-only) is described first because it's the richest source of activity information. PTY-based detection for agents without reliable hooks is documented in [Strategies](#strategies).

## Strategies

`src/shared/types.ts` - `ActivityDetectionStrategy` discriminated union

| `kind` | Used by | Behavior |
|--------|---------|----------|
| `'hooks'` | Claude Code | Hook events are the sole source of activity truth. PTY data does not influence activity state. |
| `'pty'` | Aider, Codex | Activity is inferred from PTY output patterns. The optional `detectIdle(data)` callback returns true on a definitive idle signal (e.g. an `aider>` prompt). Without `detectIdle`, a 10-second silence timer determines idle. |
| `'hooks_and_pty'` | Gemini | Hooks are primary, with PTY-based detection as a fallback if hooks fail to fire. Once hooks deliver a `thinking` event, `PtyActivityTracker.suppress()` permanently disables PTY detection for that session. |

### `ActivityDetection` factory

`src/shared/types.ts`

Adapters construct strategy values via factory functions rather than inline object literals. The factories enforce per-variant shape (e.g. `hooks()` cannot accidentally receive a `detectIdle` callback) and give descriptive call sites:

```ts
import { ActivityDetection } from '../../../../shared/types';

// Claude Code: hooks are the only source
runtime = { activity: ActivityDetection.hooks() };

// Codex: PTY only, no prompt-pattern shortcut (silence timer fallback)
runtime = { activity: ActivityDetection.pty() };

// Aider: PTY with prompt-regex detectIdle for instant transitions
runtime = { activity: ActivityDetection.pty((data) => /(?:^|\n)\s*aider>\s*$/.test(data)) };

// Gemini: hooks primary, PTY fallback with silence timer
runtime = { activity: ActivityDetection.hooksAndPty() };
```

`PtyActivityTracker` (`src/main/pty/pty-activity-tracker.ts`) owns the silence-timer state and the suppress flag. It exposes `onData()`, `onIdleDetected()`, `suppress()`, and `clearSession()` callbacks consumed by `UsageTracker`.

## Claude Code Pipeline

Activity detection uses a single pipeline: Claude Code hooks write structured events to a JSONL file, the main process watches that file, and the renderer derives the display state from event types.

## Pipeline

```
Claude Code hook fires (PreToolUse, PostToolUse, Stop, etc.)
  → event-bridge.js reads hook JSON from stdin
  → Appends one-line JSON to .kangentic/sessions/<id>/events.jsonl
  → SessionManager's event watcher detects file change (fs.watch, 50ms debounce)
  → Reads new bytes from last known offset (incremental, no full re-read)
  → Parses new JSONL lines into event objects
  → Derives activity state from event type (thinking or idle)
  → Emits IPC session:activity (state change) and session:event (log entry)
  → SessionStore updates, TaskCard re-renders spinner/mail icon
```

## Event Bridge Script

`src/main/agent/event-bridge.js`

A standalone Node.js script invoked by Claude Code's hook system. Each invocation:

1. Reads JSON from stdin (hook payload from Claude Code)
2. Builds an event object with timestamp, event type, and tool metadata
3. Appends a single JSON line to the events file
4. Exits immediately

The script is stateless -- no persistent process, no inter-invocation memory. All writes are wrapped in try/catch so a failed write never blocks Claude Code.

### Event Types

| Type | Meaning | Hook Point |
|------|---------|------------|
| `tool_start` | Agent began using a tool | `PreToolUse` (blank matcher) |
| `tool_end` | Tool execution completed | `PostToolUse` (blank matcher), or `PostToolUseFailure` when `is_interrupt` is false |
| `prompt` | Agent submitted/received a prompt | `UserPromptSubmit` (blank matcher) |
| `idle` | Agent stopped or is waiting | `Stop`, `PermissionRequest` (blank matchers) |
| `interrupted` | User interrupted the agent | `PostToolUseFailure` when `is_interrupt` is true |
| `session_start` | Claude Code session started | `SessionStart` (blank matcher) |
| `session_end` | Claude Code session ended | `SessionEnd` (blank matcher) |
| `subagent_start` | Main agent launched a subagent | `SubagentStart` (blank matcher) |
| `subagent_stop` | Subagent finished | `SubagentStop` (blank matcher) |
| `notification` | Informational notification | `Notification` (blank matcher) |
| `compact` | Context compaction in progress | `PreCompact` (blank matcher) |
| `teammate_idle` | A teammate agent went idle | `TeammateIdle` (blank matcher) |
| `task_completed` | Agent completed a task | `TaskCompleted` (blank matcher) |
| `config_change` | Configuration changed | `ConfigChange` (blank matcher) |
| `worktree_create` | Worktree creation in progress | `WorktreeCreate` (blank matcher) |
| `worktree_remove` | Worktree removal in progress | `WorktreeRemove` (blank matcher) |

Note: `tool_failure` is passed as the event type argument to the bridge script, but is never written to the JSONL file as-is. The bridge reads `is_interrupt` from the hook payload and converts it to either `interrupted` (if true) or `tool_end` (if false).

### Output Format

Each line in `events.jsonl` is a self-contained JSON object:

```json
{"ts":1709312400000,"type":"tool_start","tool":"Read","detail":"/src/main.ts"}
{"ts":1709312400100,"type":"tool_end","tool":"Read"}
{"ts":1709312400200,"type":"tool_start","tool":"Edit","detail":"/src/main.ts"}
{"ts":1709312400300,"type":"idle"}
```

Fields vary by event type. Common fields: `ts` (Unix ms), `type` (event type string). Tool events include `tool` (tool name) and may include `detail` (file path, command, or other metadata extracted from the hook payload's `tool_input`).

## Activity State Derivation

The SessionManager derives thinking/idle state from event types using this mapping:

| Event Type | Activity State | Rationale |
|------------|---------------|-----------|
| `tool_start` | **thinking** | Agent is actively executing a tool |
| `prompt` | **thinking** | Agent received input and will start processing |
| `subagent_start` | **thinking** | Main agent launched a subagent -- active work |
| `compact` | **thinking** | Context compaction in progress |
| `worktree_create` | **thinking** | Worktree creation in progress |
| `idle` | **idle** | Agent stopped, hit a permission wall, or asked a question |
| `interrupted` | **idle** | User interrupted; agent is no longer processing |
| `notification` | *(no change)* | Informational only -- fires unpredictably, often while idle |
| `subagent_stop` | *(no change)* | Subagent finishing doesn't mean the main agent is active |
| `tool_end` | *(no change)* | Another tool_start typically follows immediately |
| `session_start` | *(no change)* | Lifecycle event only -- session just started |
| `session_end` | *(no change)* | Lifecycle event only -- session ended |
| `teammate_idle` | *(no change)* | Informational -- a teammate agent went idle |
| `task_completed` | *(no change)* | Informational -- agent completed a task |
| `config_change` | *(no change)* | Informational -- configuration changed |
| `worktree_remove` | *(no change)* | Informational -- worktree removal |

Key design decisions:

- **`tool_end` does not set idle.** Between consecutive tool calls, there's a brief gap where no tool is running. Setting idle on `tool_end` would cause the spinner to flicker off and on rapidly. Instead, only explicit idle signals (`Stop`, `PermissionRequest`) set idle state.
- **`tool_failure` is never a final event type.** The event bridge converts `PostToolUseFailure` payloads based on the `is_interrupt` flag: `interrupted` if the user pressed Escape, `tool_end` otherwise. There is no `tool_failure` entry in the JSONL file or the activity state mapping.
- **`notification` does not change state.** Notifications (e.g. "Context getting full") are informational and fire unpredictably -- often after an idle event, which would incorrectly flip state back to thinking.
- **`subagent_stop` does not change state.** A subagent finishing is not evidence that the main agent is actively working. The main agent's own tool events drive thinking state.

## Subagent-Aware Transitions

When the main agent is idle (permission prompt, `Stop`, `AskUserQuestion`), subagents may still be running and firing `tool_start` events through the same hooks pipeline. Without guarding, these subagent events override the idle state, causing the task card to show an incorrect "active" spinner.

### Subagent Depth Tracking

The SessionManager tracks a `subagentDepth` counter per session:

- `subagent_start` → increment depth
- `subagent_stop` → decrement depth (floor 0)
- Cleared on session kill/suspend

### Transition Guards

Two guards protect against incorrect state transitions when subagents are running:

**Guard 1: idle → thinking suppression** (`suppressSubagentWakeDuringPermission`, prevents a subagent tool event from waking the state while a permission is still pending)

| Condition | Result | Why |
|-----------|--------|-----|
| Event is `prompt` | **Allow** | User responded -- always reliable |
| Event is `subagent_start` | **Allow** | Main agent spawning -- always reliable |
| Subagent depth = 0 | **Allow** | No subagents running, so this `tool_start` is from the main agent |
| `permissionIdle` is false | **Allow** | No permission outstanding -- the wake is legitimate |
| All of: depth > 0, `permissionIdle` true | **Suppress** | Showing "thinking" would hide a still-pending permission prompt |

Guard 1 only fires while `permissionIdle` is true. Once the `pendingPermissions` counter drains to zero via matching `tool_end` events (see "Permission idle recovery" below), `permissionIdle` is cleared and the next subagent `tool_start` cleanly wakes the state.

**Guard 2: thinking → idle suppression** (`deferStopUntilSubagentFinishes`, prevents main agent Stop from showing idle while subagents work)

| Condition | Result | Why |
|-----------|--------|-----|
| Event is `interrupted` | **Allow** | User pressed Escape -- always goes through |
| Event detail is `IdleReason.Permission` | **Allow** | Permission prompt blocks everything -- user must see idle immediately |
| Subagent depth = 0 | **Allow** | No subagents running, genuine idle |
| Subagent depth > 0 | **Defer** | Set `pendingIdleWhileSubagent` flag, emit idle when last subagent finishes |

**Deferred idle mechanism:**
- When Guard 2 suppresses an idle transition, it sets a `pendingIdleWhileSubagent` flag
- On `subagent_stop`, if depth reaches 0 and the flag is set, emit idle
- The flag is cleared when the main agent resumes thinking (`prompt`, `subagent_start`, or `tool_start` at depth 0)
- Permission idles (`IdleReason.Permission`) also clear the pending flag to prevent stale deferred idles after approval

**Permission idle recovery (`pendingPermissions` counter):**
- When idle is caused by `PermissionRequest` (event detail = `IdleReason.Permission`), a `permissionIdle` flag is set and a `pendingPermissions` counter increments (at `subagentDepth <= 1` only)
- Each subsequent `tool_end` event at depth <= 1 decrements the counter while `permissionIdle` is true
- When the counter drains to zero **from a positive value**, `permissionIdle` clears and the next subagent `tool_start` cleanly wakes the state (Guard 1 no longer suppresses)
- At `depth >= 2` the counter is frozen (increments and decrements are gated) -- we cannot tell which subagent's `tool_end` balances which permission, so the conservative sticky behavior is preserved until depth returns to 0
- The counter never decrements from 0: a `tool_end` with counter already at 0 is either (a) a permission fired at `depth >= 2` that was never counted, or (b) an orphan event. Clearing `permissionIdle` in that case would prematurely wake a still-pending permission

**Heartbeat recovery (safety net):**
- Claude Code's `status.json` contains cumulative token counts (`totalInputTokens`, `totalOutputTokens`) that only increase during active model inference
- The status file is already watched with 100ms debounce via `readAndEmitUsage()`
- When tokens increase while idle for >1 second, the session transitions to thinking
- During any true idle, the model is blocked and token counts are frozen -- no false recovery is possible
- The 1-second grace period prevents race conditions from status updates arriving slightly after an idle event

**Stale thinking safety timer:**
- A background interval (every 15s) checks all sessions in the `thinking` state
- If no signal (hook event or status.json update) has arrived for 45 seconds, the session transitions to idle
- **Pending tool suppression:** If any tools are in-flight (`pendingToolCount > 0`), the timer resets instead of transitioning to idle. This prevents false idle during long-running tools (e.g. `npm run build`, `npx playwright test`) and subagent executions (the `Agent` tool stays pending for the entire subagent lifetime). The timer resumes normal behavior once all tools complete.
- This catches cases where hooks fail to fire (e.g. Ctrl+C during model inference, not during a tool call, so no `PostToolUseFailure` hook fires)
- A synthetic `idle` event with `detail: IdleReason.Timeout` is emitted to the activity log so the user can see why it went idle
- Any subsequent event or usage update resets the 45-second timer
- The timer only checks running sessions in the `thinking` state; idle sessions are ignored
- **Nucleation guard:** Sessions that have never received usage data (no `usageCache` entry) are skipped by the stale timer. During nucleation, Claude Code reads local context before making API calls. No hooks fire and no `status.json` exists, so the 45s threshold would falsely trigger. Once the first API response arrives and `status.json` is written, the normal timer applies.

### Scenarios

1. **Permission prompt + subagents running:** Permission idle bypasses Guard 2 → card shows idle immediately. `permissionIdle` flag is set and `pendingPermissions` increments (at depth <= 1). Subagent tool_starts remain suppressed by Guard 1 while the counter is non-zero (correct)
2. **Permission approved + subagent continues:** Each matching `tool_end` at depth <= 1 decrements the counter. When the last counted permission's `tool_end` fires, `permissionIdle` clears. The next subagent `tool_start` wakes the state to thinking -- no need to wait for depth to return to 0 (correct)
3. **Multiple parallel permissions at depth 1:** Each `idle/permission` event increments the counter; each corresponding `tool_end` decrements it. The state wakes only after the LAST counted permission resolves, not the first -- partially-granted permissions keep the card idle (correct)
4. **Permission at depth >= 2 (nested subagent):** The counter is frozen (increments and decrements are gated). `permissionIdle` is still set by the transition, so Guard 1 suppresses wake attempts. Recovery waits for depth to return to 0 and the next wake event (conservative but correct for the ambiguous multi-subagent case)
5. **False idle with no event recovery:** Heartbeat detects token increase after 1s idle → card transitions to thinking (correct)
6. **Long-running tool (e.g. npm run build):** `tool_start` fires at launch, no events during execution, `tool_end` fires on completion. `pendingToolCount > 0` suppresses the stale thinking timer throughout. Card stays thinking (correct)
7. **Subagent thinking gap:** Agent tool_start fires at subagent launch. Subagent thinks for >45s between its own tool calls. `pendingToolCount > 0` (Agent tool still pending) suppresses the timer. Card stays thinking (correct)
8. **Ctrl+C during model inference (no tool running):** No hook fires; stale thinking timer detects 45s without signals → card transitions to idle with `detail: IdleReason.Timeout` (correct)
9. **User sends new message:** `prompt` always transitions regardless of depth (correct)
10. **Main agent spawns subagent then fires Stop:** Idle suppressed, card stays thinking while subagent works (correct)
11. **Last subagent finishes after deferred idle:** Card transitions to idle when depth reaches 0 (correct)
12. **User presses Escape while subagents run:** `interrupted` always goes through, card shows idle immediately (correct)
13. **Prompt fires while idle is deferred:** Pending flag cleared, no stale idle emitted when subagents finish (correct)
14. **Nested subagents with deferred idle:** Idle only emits when ALL subagents finish (depth 0), not on intermediate stops (correct)
15. **Long nucleation (no API call yet):** Session stays thinking throughout nucleation. Stale timer skipped because `usageCache` has no entry. Once first API response writes `status.json`, normal 45s timer applies (correct)

### Idle and Prompt Sub-Reasons

`src/shared/types.ts` -- `IdleReason` and `PromptReason` typed constants

Idle and synthetic-prompt events carry a `detail` field with one of these documented values. Compare against the constants rather than string literals:

| Constant | Value | When it fires |
|----------|-------|---------------|
| `IdleReason.Permission` | `'permission'` | `PermissionRequest` hook -- agent is blocked on user approval |
| `IdleReason.Timeout` | `'timeout'` | Synthetic: the stale-thinking watchdog forced a transition after 45s without signals |
| `IdleReason.Prompt` | `'prompt'` | Synthetic: the PTY tracker matched a known prompt pattern (e.g. `aider>`) |
| `IdleReason.Silence` | `'silence'` | Synthetic: the PTY tracker's 10s silence timer expired |
| `PromptReason.PtyActivity` | `'pty-activity'` | Synthetic: the PTY tracker observed output while idle and emits a synthetic `prompt` event to wake the state |

Only `IdleReason.Permission` comes from a Claude Code hook. The other four are synthetic markers emitted by Kangentic's own detectors (stale-thinking watchdog, PTY activity tracker) so the activity log can distinguish hook-driven transitions from inferred ones.

## Hook Configuration

Hooks are injected into Claude Code's settings as part of the session settings merge. The event-bridge is registered on 17 hook points, all using blank matchers (`matcher: ''`):

```
PreToolUse:          "" → tool_start       # Any tool starting
PostToolUse:         "" → tool_end         # Any tool completed
PostToolUseFailure:  "" → tool_failure*    # Any tool failed (*converted by bridge)
UserPromptSubmit:    "" → prompt           # User submitted a prompt
Stop:                "" → idle             # Agent stopped naturally
PermissionRequest:   "" → idle (permission)# Agent hit a permission wall
SessionStart:        "" → session_start    # Session started
SessionEnd:          "" → session_end      # Session ended
SubagentStart:       "" → subagent_start   # Subagent launched
SubagentStop:        "" → subagent_stop    # Subagent finished
Notification:        "" → notification     # Informational notification
PreCompact:          "" → compact          # Context compaction
TeammateIdle:        "" → teammate_idle    # Teammate went idle
TaskCompleted:       "" → task_completed   # Agent completed task
ConfigChange:        "" → config_change    # Configuration changed
WorktreeCreate:      "" → worktree_create  # Worktree created
WorktreeRemove:      "" → worktree_remove  # Worktree removed
```

*`tool_failure` is passed as the argument to event-bridge.js, but the bridge converts it to `interrupted` (if `is_interrupt` is true in the payload) or `tool_end` (otherwise) before writing to the JSONL file.

All hooks use blank matchers, meaning they fire for every invocation of that hook point regardless of tool name. There are no tool-specific matchers (e.g. no `AskUserQuestion` or `ExitPlanMode` matchers).

## Hook Injection

All sessions (main repo and worktree) use a single code path in `CommandBuilder.createMergedSettings()` (`src/main/agent/adapters/claude/command-builder.ts`):

1. Reads `.claude/settings.json` from project root (committed, shared)
2. Deep-merges `.claude/settings.local.json` from project root (personal)
3. For worktrees: merges permissions from the worktree's `.claude/settings.local.json` (captures "always allow" grants)
4. Calls `buildEventHooks()` from `hook-manager.ts` to append event-bridge entries to all hook points
5. Writes the merged settings to `.kangentic/sessions/<id>/settings.json`
6. Passes `--settings <path>` to the Claude CLI

All Kangentic hooks live in `.kangentic/sessions/<id>/settings.json` -- nothing is written to `.claude/settings.local.json`.

## Hook Cleanup

`stripKangenticHooks()` in `src/main/agent/adapters/claude/hook-manager.ts` removes all Kangentic hooks on project close or delete. This function is deprecated since the unified `--settings` approach (hooks are now in `.kangentic/sessions/<id>/settings.json`), but is kept for backward compatibility with older worktrees that may still have hooks in `.claude/settings.local.json`:

- Identifies hooks by two markers: `.kangentic` in the command AND a known bridge name (`activity-bridge` or `event-bridge`)
- Backs up `settings.local.json` before modification
- Validates JSON integrity before writing
- Restores from backup on any error
- Deletes empty settings files and `.claude/` directories

## File Watcher

The SessionManager's event watcher (`src/main/pty/session-manager.ts`) uses `fs.watch` with a 50ms debounce to detect changes to `events.jsonl`.

### Incremental Reading

The watcher tracks a byte offset into the file. On each change:

1. `fs.stat` to get current file size
2. If size > last offset, open file and read from the offset
3. Split new bytes into lines, parse each as JSON
4. Update offset to current file size
5. Emit events to renderer

This avoids re-reading the entire file on every change, which matters as the file grows (one line per tool call, potentially hundreds per session).

### Event Capping

The SessionManager caps events at 500 per session in memory. The renderer's ActivityLog component renders these as a plain DOM list (no xterm overhead).

## Status Bridge (separate concern)

The status bridge (`status-bridge.js`) is a separate pipeline that tracks token usage, cost, model name, and context window percentage. It writes to `status.json` and is watched with a 100ms debounce. It uses Claude Code's `statusLine` feature (not hooks) and is unrelated to activity detection.

## Historical Note

Earlier versions used a dual-pipeline approach with both an `activity-bridge.js` (writing `activity.json`) and the event bridge. The activity bridge was removed because on Windows, `fs.watch` can fire spuriously or with delays, causing the activity watcher to read stale state and overwrite the correct state set by the event watcher. The event-bridge-only approach eliminates this race condition by deriving activity state from structured event types rather than reading a separate polling file.
