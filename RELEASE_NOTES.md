## What's New

### Multi-Agent Support
- Codex CLI, Gemini CLI, and Aider are now first-class agents alongside Claude Code.
- Each agent has its own permission modes, display name, CLI detection, and session-history telemetry.
- Pick a default agent per project, and override it per column.
- Context handoff between agents on column moves passes the prior agent's native session history to the next agent.
- Session resume works for Codex and Gemini.
- Welcome screen shows every supported agent in the detection grid.

### Claude Rate-Limit Quotas
- Task detail context bar shows Claude Code's 5-hour and weekly plan-usage bars.
- Toggleable under Settings -> Terminal -> Context Bar -> Rate Limits.

### Changes Panel
- Open Changes directly from the task context menu.
- Added to the Command Terminal dialog.
- Auto-selects the first file and shows untracked files.
- Expand/collapse toggle for denser workflows.

### Board & UX Polish
- Add Column button moved to the board toolbar with a dedicated create dialog.
- Confirmation dialog when moving a task with pending changes to To Do.
- Command Terminal fetches and fast-forward pulls the base branch before spawning.
- New Layout settings tab: card density, column width, panel visibility, window restore, animations.
- Notifications correctly label Command Terminal idle sessions and reopen the overlay on click.

### MCP Server
- Rewritten as an in-process HTTP streamable-transport server (replaces the old file bridge).
- New tools: `kangentic_get_current_task`, `kangentic_delete_task`, session file/event accessors.
- Unified task creation: routes "create a todo task" to the active board, "Backlog" column to the backlog.
- `get_transcript` now returns rich structured transcripts.

### Session Lifecycle
- Session state machine redesigned with atomic transitions.
- Per-task lifecycle locks eliminate pause/resume race conditions.
- Faster task-move to agent-spawn latency.
- Project switching feels instant.

## Bug Fixes

- Context bar always renders with a 0% default instead of missing-bar states.
- Task cards show "Loading agent..." and "Pausing agent..." instead of bare ellipsis.
- Hide uninstalled agents and version-number noise from agent dropdowns.
- Welcome screen no longer flashes on startup; window restores maximized state.
- Spinner animations no longer freeze during drag.
- Diff viewer crash on file selection fixed; flicker alongside the terminal eliminated.
- PTY: preserve scrollback across resume, suppress idle-to-thinking flicker on resize, unstick Codex/Gemini cards on first output, eliminate activity-watcher stale/recover loop, and wait for process exit before worktree removal.
- Codex: unwrap `event_msg` envelope so context usage updates; silence-timer idle detection; status-file hook wired.
- Gemini: reliable model name and session-ID capture.
- Claude: detect CLI installed via Homebrew and on Windows via shell-aware `execFile`.
- MCP: stop wiping in-flight commands on bridge start; align session-bridge directory.
- HMR: preserve terminal state, transient session pointers, Command Terminal open state, and move-generation counters across refreshes.
- Gemini shared-file hooks are now reference-counted so concurrent sessions no longer clobber each other.
