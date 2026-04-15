# Cross-Agent Handoff

When a task moves to a column with a different agent (e.g. Claude Code to Codex), Kangentic locates the source agent's native session history file and passes its path to the target agent. This enables seamless continuation across different AI coding tools without losing progress.

## Overview

The handoff system uses a **session history passthrough** approach: instead of manufacturing a synthetic context document, it locates the source agent's native session file on disk and tells the target agent to read it directly.

| Component | File | Purpose |
|-----------|------|---------|
| Session History Reference | `handoff/session-history-reference.ts` | Builds the prompt pointing the target agent to the session file |
| Transcript Cleanup | `handoff/transcript-cleanup.ts` | Shared utilities for cleaning PTY transcripts |
| Handoff Repository | `db/repositories/handoff-repository.ts` | Stores handoff audit trail in the database |

## When Handoff Triggers

Handoff is triggered by `resolveTargetAgent()` in `src/main/engine/agent-resolver.ts` when all three conditions are met:

1. The task has a previous agent (`task.agent` is set)
2. The resolved target agent differs from `task.agent`
3. A previous session exists for the task

If `task.agent` is null (fresh task, never spawned), no handoff occurs even if the target column has an agent override.

## Handoff Flow

```
Task moves to column with different agent_override
    |
    v
resolveTargetAgent() detects isHandoff=true
    |
    v
spawnAgent() enters handoff path (agent-spawn.ts)
    |
    v
Locate source agent's native session file:
    |--- Claude: ~/.claude/projects/<slug>/<sessionId>.jsonl
    |--- Codex:  ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
    |--- Gemini: ~/.gemini/tmp/<projectDir>/chats/session-<id>.json
    |--- Aider:  null (no session history files)
    |
    v
buildSessionHistoryReference() creates prompt with file path
    |
    v
engine.resumeSuspendedSession() spawns target agent with:
    - session history prompt prepended to the task prompt
    - agentOverride set to target agent
    |
    v
Post-spawn: handoff DB record updated with target session ID
```

## Session History File Locations

Each agent adapter implements `locateSessionHistoryFile(agentSessionId, cwd)` to find the native session file:

| Agent | File Pattern | Method |
|-------|-------------|--------|
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `locateClaudeTranscriptFile()` - direct path computation |
| Codex CLI | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` | `CodexSessionHistoryParser.locate()` - directory scan with polling |
| Gemini CLI | `~/.gemini/tmp/<projectDir>/chats/session-<id>.json` | `GeminiSessionHistoryParser.locate()` - directory scan with polling |
| Aider | N/A | Returns null - no native session files |

## Prompt Delivery

`buildSessionHistoryReference()` in `src/main/agent/handoff/session-history-reference.ts` builds a prompt that points the target agent to the source session file:

```
You are continuing work on this task that was previously handled by Claude Code.
The prior agent's full session history is at: /home/user/.claude/projects/slug/session-id.jsonl
Read this file for context on what was done, decisions made, and current state.
```

For Claude (MCP-capable), it also appends: "You can also use the `kangentic_get_transcript` MCP tool for a structured view of the prior session."

For agents without session files (Aider), the prompt falls back to: "No session history file is available - check `git log` for prior changes."

The prompt is built entirely by `buildSessionHistoryReference()` with no per-adapter customization needed.

## Database Storage

Handoff records are stored in the `handoffs` table for audit trail:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | Unique handoff ID |
| `task_id` | TEXT FK | Task being handed off |
| `from_session_id` | TEXT FK | Source session (nullable) |
| `to_session_id` | TEXT FK | Target session (filled post-spawn) |
| `from_agent` | TEXT | Source agent name |
| `to_agent` | TEXT | Target agent name |
| `trigger` | TEXT | What caused the handoff (`column_transition`) |
| `session_history_path` | TEXT | Absolute path to source session file (nullable) |
| `created_at` | TEXT | ISO timestamp |

## MCP Access

Claude Code sessions can access handoff metadata via the `kangentic_get_handoff_context` MCP tool, which returns the session history file path and handoff metadata. The `kangentic_get_transcript` tool provides structured access to Claude session transcripts. See [MCP Server](mcp-server.md) for details.

## Disabling Session History Passthrough

Each column has a "Session history passthrough" toggle (default: **off**). When disabled, cross-agent transitions still detect the agent change and spawn the correct target agent, but no session history is passed - no file location, no handoff DB record. The new agent receives only the task title and description, starting with a clean slate.

This is useful for workflows where independent review is desired. For example, a "Code Review" column with `agent_override` set to a different agent can disable passthrough so the reviewing agent assesses the code without being influenced by the previous agent's conversation or reasoning.

The toggle is a per-column setting in the Edit Column dialog, under the Agent section. The underlying DB field is `handoff_context` on the swimlanes table.

## Per-Agent Transcript Cleanup

TUI agents (Claude Code, Codex CLI, Gemini CLI) produce raw PTY output with agent-specific rendering artifacts. Cleanup utilities in `src/main/agent/handoff/transcript-cleanup.ts` provide shared functions (`filterNoiseLines`, `finalizeTranscript`) used by per-adapter transcript cleanup files. Each agent's cleanup lives in its adapter folder: `src/main/agent/adapters/<name>/transcript-cleanup.ts`.

GitHub Copilot CLI is also a TUI agent but does not yet ship its own `transcript-cleanup.ts`, so its handoff transcripts may contain rendering artifacts until one is added. Cursor CLI, Aider, and Oz CLI (Warp) stream plain text output (no alternate screen buffer) and do not need per-adapter cleanup.

## See Also

- [Agent Integration](agent-integration.md) - Adapter interface, per-agent CLI details
- [Session Lifecycle](session-lifecycle.md) - Spawn flow, suspend, resume
- [Database](database.md) - Schema for handoffs table
- [MCP Server](mcp-server.md) - `kangentic_get_handoff_context` and `kangentic_get_transcript` tools
