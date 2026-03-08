# Activity Detection

## Overview

Kangentic tracks whether each Claude Code agent is **thinking** (actively using tools) or **idle** (waiting for input or stopped). This state drives the task card spinner in the Kanban board UI.

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
| `tool_end` | Tool execution completed | `PostToolUse` (blank matcher) |
| `tool_failure` | Tool execution failed | `PostToolUseFailure` (blank matcher) |
| `prompt` | Agent submitted/received a prompt | `UserPromptSubmit`, `PostToolUse` (AskUserQuestion, ExitPlanMode) |
| `idle` | Agent stopped or is waiting | `Stop`, `PermissionRequest`, `PreToolUse` (AskUserQuestion, ExitPlanMode) |
| `interrupted` | User interrupted the agent | Detected from hook payload (`is_interrupted` flag) |

### Output Format

Each line in `events.jsonl` is a self-contained JSON object:

```json
{"ts":1709312400000,"event":"tool_start","tool":"Read","file":"/src/main.ts"}
{"ts":1709312400100,"event":"tool_end","tool":"Read"}
{"ts":1709312400200,"event":"tool_start","tool":"Edit","file":"/src/main.ts"}
{"ts":1709312400300,"event":"idle"}
```

Fields vary by event type. Common fields: `ts` (Unix ms), `event` (type string). Tool events include `tool` (tool name) and may include `file` or other metadata extracted from the hook payload.

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
| `tool_failure` | *(no change)* | Agent continues thinking after a failure |

Key design decisions:

- **`tool_end` does not set idle.** Between consecutive tool calls, there's a brief gap where no tool is running. Setting idle on `tool_end` would cause the spinner to flicker off and on rapidly. Instead, only explicit idle signals (`Stop`, `PermissionRequest`) set idle state.
- **`tool_failure` does not set idle.** The agent continues processing after a tool failure (it may retry or try a different approach). Only the `Stop` hook fires when the agent truly stops.
- **`AskUserQuestion` and `ExitPlanMode` are special-cased.** These tools indicate the agent is waiting for user input, so they fire `idle` on `PreToolUse` and `prompt` on `PostToolUse` (when the user responds and the agent resumes).
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

**Guard 1: idle → thinking suppression** (prevents subagent tool events from overriding idle)

| Condition | Result | Why |
|-----------|--------|-----|
| Event is `prompt` | **Allow** | User responded -- always reliable |
| Event is `subagent_start` | **Allow** | Main agent spawning -- always reliable |
| Subagent depth = 0 | **Allow** | No subagents running, so this `tool_start` is from the main agent |
| Subagent depth > 0 | **Suppress** | The `tool_start` is likely from a still-running subagent (even after permission approval) |

When idle is caused by a `PermissionRequest` (detail='permission'), a `permissionIdle` flag is set on the session. Guard 1 does NOT bypass suppression at depth > 0 -- permission idle stays sticky while subagents are active. Recovery happens naturally when subagents finish (depth returns to 0) and the next `tool_start` transitions to thinking.

**Guard 2: thinking → idle suppression** (prevents main agent Stop from showing idle while subagents work)

| Condition | Result | Why |
|-----------|--------|-----|
| Event is `interrupted` | **Allow** | User pressed Escape -- always goes through |
| Event detail is `permission` | **Allow** | Permission prompt blocks everything -- user must see idle immediately |
| Subagent depth = 0 | **Allow** | No subagents running, genuine idle |
| Subagent depth > 0 | **Defer** | Set `pendingIdleWhileSubagent` flag, emit idle when last subagent finishes |

**Deferred idle mechanism:**
- When Guard 2 suppresses an idle transition, it sets a `pendingIdleWhileSubagent` flag
- On `subagent_stop`, if depth reaches 0 and the flag is set, emit idle
- The flag is cleared when the main agent resumes thinking (`prompt`, `subagent_start`, or `tool_start` at depth 0)
- Permission idles (`detail: 'permission'`) also clear the pending flag to prevent stale deferred idles after approval

**Permission idle recovery:**
- When idle is caused by `PermissionRequest` (detail='permission'), a `permissionIdle` flag is set on the session
- At depth > 0, permission idle stays sticky -- subagent tool_starts are suppressed just like normal idle
- Recovery happens when depth returns to 0 (all subagents finish) and the next `tool_start` at depth 0 transitions to thinking
- The flag is cleared when the transition to thinking occurs
- Permission idles also clear the `pendingIdleWhileSubagent` flag to prevent stale deferred idles

**Heartbeat recovery (safety net):**
- Claude Code's `status.json` contains cumulative token counts (`totalInputTokens`, `totalOutputTokens`) that only increase during active model inference
- The status file is already watched with 100ms debounce via `readAndEmitUsage()`
- When tokens increase while idle for >1 second, the session transitions to thinking
- During any true idle, the model is blocked and token counts are frozen -- no false recovery is possible
- The 1-second grace period prevents race conditions from status updates arriving slightly after an idle event

### Scenarios

1. **Permission prompt + subagents running:** Permission idle bypasses Guard 2 → card shows idle immediately. `permissionIdle` flag is set. Subagent tool events remain suppressed (permission idle is sticky at depth > 0). When subagents finish (depth 0), next `tool_start` transitions to thinking (correct)
2. **Permission approved + no subagents:** Next `tool_start` at depth 0 transitions to thinking via Guard 1 (correct)
3. **Permission approved + subagents still running:** Card stays idle while subagents work (tool_starts suppressed at depth > 0). Recovery happens when depth returns to 0 (correct)
4. **False idle with no event recovery:** Heartbeat detects token increase after 1s idle → card transitions to thinking (correct)
5. **User sends new message:** `prompt` always transitions regardless of depth (correct)
6. **Main agent spawns subagent then fires Stop:** Idle suppressed, card stays thinking while subagent works (correct)
7. **Last subagent finishes after deferred idle:** Card transitions to idle when depth reaches 0 (correct)
8. **User presses Escape while subagents run:** `interrupted` always goes through, card shows idle immediately (correct)
9. **Prompt fires while idle is deferred:** Pending flag cleared, no stale idle emitted when subagents finish (correct)
10. **Nested subagents with deferred idle:** Idle only emits when ALL subagents finish (depth 0), not on intermediate stops (correct)

## Hook Configuration

Hooks are injected into Claude Code's settings as part of the session settings merge. The event-bridge is registered on six hook points:

```
PreToolUse:
  "" (blank)         → tool_start    # Any tool starting
  "AskUserQuestion"  → idle          # Agent asking user a question
  "ExitPlanMode"     → idle          # Agent requesting plan approval

PostToolUse:
  "" (blank)         → tool_end      # Any tool completed
  "AskUserQuestion"  → prompt        # User answered, agent resumes
  "ExitPlanMode"     → prompt        # User approved plan, agent resumes

PostToolUseFailure:
  "" (blank)         → tool_failure  # Any tool failed

UserPromptSubmit:
  "" (blank)         → prompt        # User submitted a prompt

Stop:
  "" (blank)         → idle          # Agent stopped naturally

PermissionRequest:
  "" (blank)         → idle (detail: permission)  # Agent hit a permission wall
```

Matcher priority: Claude Code evaluates specific matchers before blank matchers. When `AskUserQuestion` fires, both the specific matcher (`→ idle`) and the blank matcher (`→ tool_start`) run. The specific matcher's event is appended after the blank matcher's event, so the final derived state is `idle` (correct).

## Hook Injection

All sessions (main repo and worktree) use a single code path in `CommandBuilder.createMergedSettings()` (`src/main/agent/command-builder.ts`):

1. Reads `.claude/settings.json` from project root (committed, shared)
2. Deep-merges `.claude/settings.local.json` from project root (personal)
3. For worktrees: merges permissions from the worktree's `.claude/settings.local.json` (captures "always allow" grants)
4. Appends event-bridge entries to each hook point
5. Writes merged settings to `.kangentic/sessions/<id>/settings.json`
6. Passes `--settings <path>` to the Claude CLI

All Kangentic artifacts stay in `.kangentic/` -- nothing is written to `.claude/settings.local.json`.

## Hook Cleanup

`stripActivityHooks()` in `src/main/agent/hook-manager.ts` removes all Kangentic hooks on project close or delete:

- Identifies hooks by two markers: `.kangentic` in the path AND a known bridge name (`event-bridge` or `status-bridge`)
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
