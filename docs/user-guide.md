# User Guide

This guide walks through all features of Kangentic from a user's perspective.

## First Launch

When you first open Kangentic, you'll see an empty project list. Click **New Project** to get started:

1. Enter a project name
2. Select the project directory (the root of your git repository)
3. Optionally add a GitHub URL
4. Click Create

Kangentic initializes a `.kangentic/` directory inside your project (auto-added to `.gitignore`) and creates a board with default columns.

## Default Columns

New projects start with seven columns:

| Column | Role | Behavior |
|--------|------|----------|
| **Backlog** | backlog | Holding area. No agent runs here. Moving a task here kills its session. |
| **Planning** | (plan mode) | Spawns Claude in plan mode. Agent creates a plan, then task auto-moves to Executing. |
| **Executing** | (auto) | Spawns Claude in default permission mode. Agent works on the task. |
| **Code Review** | (auto) | Agent keeps running. Can attach an auto-command for review prompts. |
| **Tests** | (auto) | Agent keeps running. |
| **Ship It** | (auto) | Agent keeps running. |
| **Done** | done | Suspends the session (preserving context) and archives the task. |

## Task Lifecycle

### Create a Task

Click the **+** button on any column header or use the "New Task" button. Enter a title and optional description. You can also attach images (screenshots, mockups) that will be included in the agent's prompt.

### Spawn an Agent

Drag a task from Backlog to any active column (Planning, Executing, etc.). Kangentic will:

1. Create a git worktree for the task (if worktrees are enabled)
2. Spawn a Claude Code CLI session with the task title and description as the prompt
3. The task card shows a spinner while the agent is thinking

### Monitor Progress

- **Terminal panel** at the bottom shows the active session's terminal output
- **Activity tab** shows structured events (tool calls, idle state) instead of raw terminal output
- **Context bar** on task cards shows token usage and context window percentage
- **Thinking/idle indicator** on task cards shows whether the agent is actively working

### Move Between Active Columns

Dragging between active columns (e.g., Executing to Code Review) keeps the session alive. If the target column has an `auto_command`, that command is injected into the running session.

### Complete a Task

Drag to Done. The session is suspended (not destroyed), the task is archived, and the conversation ID is preserved. If you later unarchive the task and drag it to an active column, the agent resumes with full conversation context.

### Return to Backlog

Drag to Backlog to kill the session. The worktree is preserved (code stays on disk), but the session is ended. If you drag back to an active column, a fresh session starts.

## Terminal Panel

The bottom panel shows terminal output for running sessions.

### Session Tabs

Each running session gets a tab. Click a tab to switch between sessions. The active tab is highlighted.

### Activity Tab

The leftmost tab shows an activity log -- structured events from all sessions. This is a plain list (not a terminal) showing tool calls, idle events, and session state changes.

### Resize

Drag the panel divider to resize. The terminal resizes to match. Resize events are debounced to prevent output corruption.

## Task Detail Dialog

Click a task card to open the detail dialog. From here you can:

- Edit the task title and description
- View and manage attachments (images, files)
- See the full terminal output (takes ownership from the bottom panel while open)
- View session status, usage stats, and model info

When the dialog is open, it claims the terminal session -- the bottom panel releases it. When you close the dialog, the bottom panel reclaims the session.

## Column Management

### Add a Column

Click the **+** button at the end of the column row.

### Edit a Column

Click the column header's settings icon. You can configure:

| Setting | Description |
|---------|-------------|
| **Name** | Column display name |
| **Color** | Header accent color |
| **Icon** | Lucide icon name (e.g., `square-terminal`, `code`, `flask-conical`) |
| **Permission Mode** | Override the global permission mode for agents in this column |
| **Auto Spawn** | Whether moving a task here spawns an agent (default: on) |
| **Auto Command** | Command injected into running sessions when tasks arrive |
| **Plan Exit Target** | For plan-mode columns: where tasks move when planning completes |

### Reorder Columns

Drag column headers to reorder.

### Delete a Column

Columns can only be deleted when empty (no tasks).

## Settings

Open settings from the sidebar or title bar.

### Themes

Choose from 10 themes:
- **Base:** Dark, Light
- **Dark variants:** Moon, Forest, Ocean, Ember
- **Light variants:** Sand, Mint, Sky, Peach

### Terminal Settings

| Setting | Description |
|---------|-------------|
| Shell | Override the auto-detected shell |
| Font Family | Terminal font |
| Font Size | Terminal text size |

### Claude Settings

| Setting | Description |
|---------|-------------|
| Permission Mode | Default for all sessions (bypass, default, plan, acceptEdits, manual) |
| CLI Path | Override auto-detected Claude CLI path |
| Max Concurrent Sessions | How many agents can run at once (excess tasks queue) |

### Git Settings

| Setting | Description |
|---------|-------------|
| Worktrees Enabled | Create isolated branches per task |
| Auto Cleanup | Delete branches when worktrees are removed |
| Default Base Branch | Branch to create worktrees from (default: main) |
| Copy Files | Files to copy from repo root into worktrees |
| Init Script | Shell script to run after worktree creation |

### Scope

Settings have two scopes:
- **Global** -- applies to all projects
- **Project** -- overrides global settings for this project only (stored in `.kangentic/config.json`)

Some settings are global-only and cannot be overridden per-project (e.g., max concurrent sessions, sidebar width).

## Worktrees

When worktrees are enabled (default), each task gets its own git branch and working directory. This allows multiple agents to work in parallel without merge conflicts.

### Per-Task Toggle

Individual tasks can opt in or out of worktrees regardless of the global setting. Set this when creating a task or in the task detail dialog.

### Branch Naming

Branches follow the pattern `kanban/{slug}-{taskId8}` (e.g., `kanban/fix-auth-bug-a1b2c3d4`).

### Base Branch

Priority order:
1. Task's base branch (per-task override)
2. Action config's base branch (per-transition override)
3. Global `git.defaultBaseBranch` (default: `main`)

## Session Queue

When the max concurrent sessions limit is reached, new sessions are queued automatically. Queued tasks show a "Queued" indicator on their card. When a running session exits or is suspended, the next queued session promotes automatically (FIFO order).

## Sidebar

### Multi-Project

The sidebar shows all your projects. Click to switch between them. Each project has its own board, columns, and sessions.

### Idle Badges

When an agent goes idle (waiting for input or stopped) on a non-active project, the sidebar shows a badge. This helps you notice when agents need attention across projects.

### Window Flash

On Windows, the taskbar icon flashes when an agent goes idle on a non-active project (configurable via `notifyIdleOnInactiveProject`).

## CLI

Open a project directly from the terminal:

```bash
kgnt open            # Open the current directory
kgnt open /path/to   # Open a specific project path
```

If the project doesn't exist yet, it's created automatically.

## Session Persistence

Sessions survive app restarts. When you close Kangentic:

1. All running sessions receive a graceful shutdown signal (Ctrl+C then /exit)
2. Claude Code saves its conversation state
3. On next launch, sessions are automatically resumed via `--resume`

If the app crashes, orphaned sessions are detected and recovered on the next launch.

## Keyboard Shortcuts

- **Escape** -- Close any open dialog
- Standard OS shortcuts for copy, paste, etc. in the terminal

## Tips

- **Plan mode workflow:** Use a Planning column with `permission_strategy='plan'` and `plan_exit_target_id` pointing to your Executing column. The agent plans first, then auto-moves to execution.
- **Auto commands:** Set `auto_command` on a Code Review column to automatically ask the agent to review its own code when tasks arrive.
- **Concurrent agents:** Increase `maxConcurrentSessions` to run more agents in parallel. Each needs its own worktree to avoid conflicts.
- **Resume from Done:** Unarchive a completed task and drag it back to an active column. The agent picks up exactly where it left off.
