# User Guide

This guide walks through all features of Kangentic from a user's perspective.

## First Launch

When you first open Kangentic with no existing projects, a welcome screen greets you with an **Open a Project** button. Click it to select a project folder and get started.

On subsequent launches, Kangentic automatically re-opens the last activated project so you pick up right where you left off. If you launch with the `--cwd` flag, that path takes priority.

When a project is opened, Kangentic initializes a `.kangentic/` directory inside the project folder (auto-added to `.gitignore`) and creates a board with default columns.

## Default Columns

New projects start with seven columns:

| Column | Role | Behavior |
|--------|------|----------|
| **To Do** | todo | Holding area. No agent runs here. Moving a task here kills its session. |
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

Drag a task from To Do to any active column (Planning, Executing, etc.). Kangentic will:

1. Create a git worktree for the task (if worktrees are enabled)
2. Spawn a Claude Code CLI session with the task title and description as the prompt
3. The task card shows a spinner while the agent is thinking

### Monitor Progress

- **Terminal panel** at the bottom shows the active session's terminal output
- **Activity tab** shows structured events (tool calls, idle state) instead of raw terminal output
- **Context bar** below the terminal shows session metadata (shell, model, cost, tokens, context usage). Each element is configurable.
- **Task card status** -- each card shows a contextual status bar at the bottom:
  - A spinning indicator and model name with context percentage when the agent is actively working
  - An idle icon (amber) when the agent is waiting for input
  - "Initializing..." or "Resuming..." during session startup
  - "Queued..." when waiting for a concurrency slot
  - "Paused" when manually suspended
- **Shimmer overlay** -- when a session is starting or resuming (e.g., after a column move that triggers an auto_command), a shimmer loading overlay appears over the terminal. It shows a context-aware label such as the auto_command name, "Resuming agent...", or "Starting agent...". Terminal output is suppressed behind the overlay until the session is ready.

### Move Between Active Columns

Dragging between active columns (e.g., Executing to Code Review) keeps the session alive when the target has no `auto_command`. If the target column has an `auto_command` configured (e.g., `/code-review`), the session is suspended and resumed with the command as the resume prompt. Permission mode differences alone do not cause a suspend/resume cycle.

### Complete a Task

Drag to Done. The session is suspended (not destroyed), the task is archived, and the conversation ID is preserved. If you later unarchive the task and drag it to an active column, the agent resumes with full conversation context.

Clicking a completed task opens a session summary showing: duration, model, cost, token usage, tool call count, files changed, and lines added/removed. The Done column also supports searching completed tasks by title and sorting by date, cost, tokens, or duration.

### Return to To Do

Drag to To Do to kill the session. The worktree is preserved (code stays on disk), but the session is ended. If you drag back to an active column, a fresh session starts.

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
- View and manage image attachments (drag-and-drop files onto the dialog, or paste from clipboard)
- Right-click an attachment thumbnail to copy the image to clipboard
- Click any attachment thumbnail to open a full-size preview modal (press Escape to close)
- See the full terminal output (takes ownership from the bottom panel while open)
- View session status, usage stats, and model info
- Pause or resume the agent session using the circular play/pause button in the header
- Run shortcuts from the header bar (configurable pills that launch external tools)
- Open the **Commands & Skills** popover to browse and run Claude Code commands (`.claude/commands/`) and skills (`.claude/skills/`) from the project directory. Search by name, navigate with arrow keys, press Enter to invoke.
- Access the kebab menu (three-dot icon) for additional actions:
  - **Edit** -- switch to edit mode for title and description
  - **Open folder** -- open the worktree or project directory in your file manager
  - **View PR** -- open the associated pull request. PR URLs are populated automatically when an agent runs `gh pr create` or `gh pr view` (GitHub), explicitly via the `kangentic_update_task` MCP tool (any platform), or manually through the PR URL field in edit mode. Also shown as a pill in the header bar and a clickable badge on the task card.
  - **Commands & Skills** -- submenu of available Claude Code commands and skills (same as the header popover)
  - **Pause / Resume session** -- manually suspend or resume the agent
  - **Move to** -- submenu listing all other columns as move targets
  - **Archive** -- move the task to Done and archive it
  - **Delete** -- permanently delete the task, session, and worktree

When the dialog is open, it claims the terminal session -- the bottom panel releases it. When you close the dialog, the bottom panel reclaims the session.

## Backlog

The Backlog is a staging area for tasks before they reach the board. Switch between **Board** and **Backlog** views using the tabs at the top.

### Creating Items

Click **New Task** in the backlog toolbar to create a backlog item with a title, description, priority, labels, and optional image attachments.

### Labels

Click **Labels** in the toolbar to manage labels. Labels are free-form text tags added during item creation or editing. From the Labels popover you can rename a label across all items, delete a label, and assign colors to labels for visual distinction.

### Priorities

Click **Priorities** in the toolbar to manage the priority scale. The default scale is None, Low, Medium, High, Urgent (0-4). You can rename priority levels, reorder them, add new ones, or remove existing ones. Priority colors are customizable.

### Filtering

Click **Filter** to filter by priority level and/or label. Active filters show a count badge on the Filter button. Use the search bar to filter items by title or description text.

### Promoting to the Board

Select one or more items using the checkboxes, then click **Move to Board** in the bulk toolbar that appears at the bottom. Choose a target column and the items become board tasks. If the target column has auto-spawn enabled, an agent session starts immediately.

### Importing from External Sources

Click **Import** in the backlog toolbar to pull tasks from external project management tools.

**Supported sources:**
- **GitHub Issues** - import issues from any GitHub repository
- **GitHub Projects** - import items from a GitHub Project board
- **Azure DevOps Work Items** - import work items from Azure DevOps boards, sprints, or backlogs

**Prerequisites:**
- **GitHub:** The `gh` CLI must be installed and authenticated. For GitHub Projects, the `project` scope is required (`gh auth refresh -s project`).
- **Azure DevOps:** The `az` CLI must be installed, authenticated (`az login`), and the azure-devops extension installed (`az extension add --name azure-devops`).

**Adding a source:**
1. Click **Import** > **Add Source**
2. Choose a provider (GitHub or Azure DevOps) and source type
3. Paste the full URL (e.g., `https://github.com/owner/repo`, `https://github.com/orgs/owner/projects/1`, or `https://dev.azure.com/org/project`)
4. Click **Connect** - Kangentic verifies CLI authentication and saves the source
5. For Azure DevOps sprint URLs, items are automatically scoped to that sprint's iteration path

**Importing items:**
1. Click a saved source to open the import dialog
2. Browse items with filtering by title, type, status, assignee, and labels
3. Use the "Imported" toggle to hide already-imported items (on by default)
4. Click anywhere on a row to select it (or use the checkbox)
5. Click **Import (N)** to pull selected items into the backlog

Imported items include the title, description (markdown), labels, and assignee from the source. Inline images in issue bodies are downloaded as backlog attachments. A small GitHub icon appears on imported items linking back to the original ticket.

Items that have already been imported are detected by `external_source` + `external_id` and shown with a checkmark. Re-importing the same source skips duplicates automatically.

Saved sources persist in `.kangentic/config.json` per project and appear in the Import dropdown for quick re-syncing.

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

Settings are accessed from two entry points:

- **App Settings** -- click the gear icon in the title bar. This is the main settings panel with all app-wide and project-default settings.
- **Project Settings** -- click the gear icon on a project row in the sidebar. This shows only the per-project overridable subset.

Both panels use a VS Code-style layout: a sidebar with tab navigation on the left, and the active settings pane on the right. In App Settings, tabs above the separator (Appearance, Terminal, Agent, Git, Shortcuts) are per-project settings; tabs below the separator (Behavior, MCP Server, Notifications, Privacy) are shared across all projects. When no project is open, only the shared tabs appear. Project Settings shows inherited defaults as hints, with reset buttons on any overridden value and a "Reset All" footer when overrides exist.

### Search

A search bar at the top of each panel filters settings by keyword. Type multiple words to narrow results (all tokens must match). Results are grouped by tab with match count badges on the sidebar tabs. Tabs with zero matches are dimmed. Press Ctrl+F (Cmd+F on macOS) to focus the search bar, Escape to clear the filter.

### Themes

Choose from 10 themes:
- **Base:** Dark, Light
- **Dark variants:** Moon, Forest, Ocean, Ember
- **Light variants:** Sand, Mint, Sky, Peach

### Terminal Settings

| Setting | Description |
|---------|-------------|
| Shell | Override the auto-detected shell |
| Font Size | Terminal text size in pixels |
| Font Family | CSS font-family for the terminal |
| Scrollback Lines | Maximum lines kept in terminal buffer (1000--100000, default 5000) |
| Cursor Style | Terminal cursor appearance (block, underline, or bar) |

### Context Bar

The context bar is a status line displayed below the terminal showing session metadata. Each element can be individually toggled on or off in App Settings > Terminal.

| Toggle | What it shows |
|--------|--------------|
| Shell | The active shell name (e.g., pwsh, bash, zsh) |
| Version | Claude CLI version |
| Model | Active model name (e.g., Claude Sonnet 4) |
| Cost | Cumulative session cost in dollars |
| Tokens | Token usage (input + output) |
| Context Fraction | Context window usage as a percentage |
| Progress Bar | Visual progress bar for context window usage |

### Agent Settings

| Setting | Description |
|---------|-------------|
| CLI Path | Path to Claude CLI binary (auto-detected if empty) |
| Max Concurrent Sessions | Limit how many agents can run at the same time (1--20) |
| When Max Sessions Reached | How new agent requests are handled when all slots are in use (Queue or Reject) |
| Idle Timeout (minutes) | Auto-suspend sessions after N minutes idle; 0 to disable |
| Permissions | Default permission mode for all sessions (Default, Plan, Accept Edits, Don't Ask, or Bypass) |

All five permission modes are available in both the global App Settings dropdown and the per-column Edit Column dialog.

### Git Settings

| Setting | Description |
|---------|-------------|
| Worktrees Enabled | Create isolated branches per task |
| Auto Cleanup | Delete branches when worktrees are removed |
| Default Base Branch | Branch to create worktrees from (default: main) |
| Copy Files | Files to copy from repo root into worktrees |
| Init Script | Shell script to run after worktree creation |

### Shortcuts

The Shortcuts tab lets you add custom command buttons to the task detail dialog. Each shortcut has a label, icon, shell command, and display location (header bar, kebab menu, or both).

Commands support template variables: `{{cwd}}`, `{{branchName}}`, `{{taskTitle}}`, `{{projectPath}}`. These are resolved at runtime using the active task's context.

Shortcuts can be scoped as **Team** (saved in `kangentic.json`, shared via git) or **Personal** (saved in `kangentic.local.json`, local-only). Presets are available for common tools (VS Code, Cursor, GitHub Desktop, terminal emulators, file managers).

### Scope

Settings have two scopes:
- **Global** -- applies to all projects
- **Project** -- overrides global settings for this project only (stored in `.kangentic/config.json`)

Some settings are global-only and cannot be overridden per-project (e.g., max concurrent sessions, sidebar width).

### Behavior Settings

These are global-only settings that apply to the entire app.

| Setting | Description |
|---------|-------------|
| Skip Task Delete Confirmation | Delete tasks immediately without a confirmation dialog |
| Auto-Focus Idle Sessions | Automatically switch the bottom panel to the most recently idle session |
| Launch All Projects on Startup | Start agents across all projects on launch, not just the current one |
| Restore Window Position | Remember window size and position between launches |
| Show Board Search Bar | Display the search bar above board columns. Press Ctrl+F / Cmd+F to toggle. |

## Board Configuration

Kangentic can export your board layout to a `kangentic.json` file in the project root. Commit this file to git so your team shares the same column structure, actions, and transitions.

### Sharing with Your Team

When you open a project, Kangentic automatically writes `kangentic.json` with the current board state. Commit and push this file. When teammates pull it, Kangentic detects the change and shows a banner offering to apply the new configuration.

### Personal Overrides

Create a `kangentic.local.json` in the project root for personal customizations (column colors, icons, extra columns). This file is auto-added to `.gitignore` and merges on top of the team config.

### Applying Changes

When `kangentic.json` or `kangentic.local.json` changes on disk, a reconciliation banner appears at the top of the board. Click "Apply" to reconcile the file into your database, or dismiss to ignore. Enable `skipBoardConfigConfirm` in settings to apply changes automatically.

If a teammate removes a column that still has your tasks, the column becomes a "ghost" (hidden but preserved). Once you move all tasks out of the ghost column, it is automatically deleted.

## Worktrees

When worktrees are enabled (default), each task gets its own git branch and working directory. This allows multiple agents to work in parallel without merge conflicts.

### Per-Task Toggle

Individual tasks can opt in or out of worktrees regardless of the global setting. Set this when creating a task or in the task detail dialog.

### Branch Naming

Branches follow the pattern `{slug}-{taskId8}` (e.g., `fix-auth-bug-a1b2c3d4`).

### Base Branch

Priority order:
1. Task's base branch (per-task override)
2. Action config's base branch (per-transition override)
3. `kangentic.json` `defaultBaseBranch` (team-shared, overridable via `kangentic.local.json`)
4. Per-user `git.defaultBaseBranch` (default: `main`)

## Session Queue

When the max concurrent sessions limit is reached, new sessions are queued automatically. Queued tasks show a "Queued" indicator on their card. When a running session exits or is suspended, the next queued session promotes automatically (FIFO order).

## Sidebar

### Multi-Project

The sidebar shows all your projects. Click to switch between them. Each project has its own board, columns, and sessions. Drag projects to reorder them -- the order persists across app restarts. New projects appear at the top.

The selected project shows action buttons (Open, Settings, Delete) directly on the row. Right-click any project to open a context menu with Rename, Open in Explorer, Project Settings, and Delete. Inline rename is supported via the context menu - press Enter to save, Escape to cancel.

### Idle Badges

When an agent goes idle (waiting for input or stopped) on a non-active project, the sidebar shows a badge. This helps you notice when agents need attention across projects.

### Notifications

Desktop and toast notifications fire when an agent needs attention and the user can't already see it -- either the window is minimized/unfocused, or a different project is active. Notification events: agent idle, permission-blocked idle (body shows "Needs permission"), session crash (non-zero exit), and plan-completion auto-moves. The task name is the title and the project name is the body. Clicking a desktop notification brings the window to the foreground, switches to the correct project, and opens the task detail dialog. The taskbar also flashes on Windows. A 10-second per-session cooldown prevents repeated desktop notifications from the same agent.

The Settings > Notifications panel exposes two configurable events: **Agent Idle** and **Plan Complete**. Each can be set to Desktop & Toast, Desktop Only, Toast Only, or Off. Toast duration and max visible count are also configurable. The **Agent Crash** notification (non-zero exit) is always on and not exposed in the settings UI.

## CLI

Open a project directly from the terminal:

```bash
npx kangentic            # Open the current directory
npx kangentic /path/to   # Open a specific project path
```

If the project doesn't exist yet, it's created automatically.

## Session Persistence

Sessions survive app restarts. When you close Kangentic:

1. All running sessions are marked as `suspended` in the database
2. PTY processes are force-killed (there is no graceful shutdown window)
3. On next launch, sessions are automatically resumed via `--resume` using the saved session ID

Because Claude Code supports `--resume`, conversation context is fully preserved despite the hard kill. If the app crashes, orphaned sessions are detected and recovered on the next launch.

### User-Paused Sessions

Sessions paused manually by the user (via the pause button in the task detail dialog or kebab menu) are remembered across restarts. On relaunch, user-paused sessions remain paused instead of auto-resuming. This respects user intent. If you paused an agent, it will not start back up on its own. Only system-suspended sessions (those suspended by shutdown or column moves) auto-resume.

## Command Terminal

The Command Terminal provides quick, ephemeral access to Claude Code without creating a task on the board. Useful for one-off actions like creating releases, running queries, or any ad-hoc interaction.

**Opening:** Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS), or click the terminal icon in the title bar (next to the settings gear).

**Behavior:**
- Spawns Claude Code at the project root on the configured default base branch
- The **branch picker** in the header lets you switch branches - selecting a new branch kills the current session and respawns on the selected branch
- A shimmer overlay shows while Claude Code initializes, then lifts to reveal the clean TUI
- Transient sessions are fully independent of task sessions - they don't appear in the terminal panel tabs, don't count toward session limits, and produce no toasts on exit
- If git checkout fails when switching branches (e.g., uncommitted changes), a warning toast explains the issue and the session stays on the current branch

**Closing:** Press `Ctrl+Shift+P` again, or click the backdrop outside the overlay. The PTY is killed and the session directory is cleaned up. Transient sessions are non-resumable by design.

## Keyboard Shortcuts

- **Ctrl+Shift+P** / **Cmd+Shift+P** -- Toggle the Command Terminal overlay
- **Ctrl+F** / **Cmd+F** -- Toggle board search
- **Escape** -- Close any open dialog
- Standard OS shortcuts for copy, paste, etc. in the terminal

## Tips

- **Plan mode workflow:** Use a Planning column with `permission_mode='plan'` and `plan_exit_target_id` pointing to your Executing column. The agent plans first, then auto-moves to execution.
- **Auto commands:** Set `auto_command` on a Code Review column to automatically ask the agent to review its own code when tasks arrive.
- **Concurrent agents:** Increase `maxConcurrentSessions` to run more agents in parallel. Each needs its own worktree to avoid conflicts.
- **Resume from Done:** Unarchive a completed task and drag it back to an active column. The agent picks up exactly where it left off.
