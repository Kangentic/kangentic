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

The script is stateless — no persistent process, no inter-invocation memory. All writes are wrapped in try/catch so a failed write never blocks Claude Code.

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
| `tool_end` | *(no change)* | Another tool_start typically follows immediately |
| `tool_failure` | *(no change)* | Agent continues thinking after a failure |
| `idle` | **idle** | Agent stopped, hit a permission wall, or asked a question |
| `interrupted` | **idle** | User interrupted; agent is no longer processing |

Key design decisions:

- **`tool_end` does not set idle.** Between consecutive tool calls, there's a brief gap where no tool is running. Setting idle on `tool_end` would cause the spinner to flicker off and on rapidly. Instead, only explicit idle signals (`Stop`, `PermissionRequest`) set idle state.
- **`tool_failure` does not set idle.** The agent continues processing after a tool failure (it may retry or try a different approach). Only the `Stop` hook fires when the agent truly stops.
- **`AskUserQuestion` and `ExitPlanMode` are special-cased.** These tools indicate the agent is waiting for user input, so they fire `idle` on `PreToolUse` and `prompt` on `PostToolUse` (when the user responds and the agent resumes).

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
  "" (blank)         → idle          # Agent hit a permission wall
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

All Kangentic artifacts stay in `.kangentic/` — nothing is written to `.claude/settings.local.json`.

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
