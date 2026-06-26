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
| **Tests** | (auto) | Agent keeps running. Can attach an auto-command (e.g. open a PR and drive its checks green). |
| **Ship It** | (auto) | Agent keeps running. Can attach an auto-command (e.g. merge a verified PR and pull back). |
| **Done** | done | Suspends the session (preserving context) and archives the task. |

## Task Lifecycle

### Create a Task

Click the **+** button on any column header or use the "New Task" button. Enter a title and optional description. You can set a priority level, add labels, and attach files (images, documents, or any file type) by pasting from the clipboard or dragging files onto the dialog. Attachments are included in the agent's prompt.

Pasted screenshots are automatically compressed to fit Claude's per-image budget. Kangentic re-encodes large pastes to JPEG and steps quality / dimensions down until each image lands under the budget, so a multi-monitor screen grab does not get rejected by the API.

In the description field, type `@` to trigger file autocomplete. A dropdown lists files and directories from the project root, which you can navigate with arrow keys and select with Enter to insert the path.

#### Advanced: Per-Task Agent / Model / Effort Override

Click **Advanced** in the New Task dialog (or in the task detail edit form for an existing task) to set per-task overrides:

| Field | Description |
|-------|-------------|
| **Agent** | Pick a specific agent CLI (Claude, Codex, etc.) for this task. Defaults to the destination column's agent override, then the project default. Hidden when only one agent is detected on the machine. |
| **Model** | Adapter-specific model identifier (e.g. `opus`, `sonnet`, `claude-opus-4-8`). The dropdown is fed by the shared model cache. For Claude, the list is populated both by scanning past session transcripts and by harvesting the CLI's own `/model` picker through a hidden background probe, so newly shipped models surface without first being used in a session. |
| **Effort** | Adapter-specific reasoning tier (Claude: `low`, `medium`, `high`, `xhigh`, `max`). Only shown when the agent reports effort levels. |

A per-task pick **stays with the task across column moves** - column settings are ignored once a task carries its own override. Changing the Agent resets Model + Effort because the previous picks were valid for the previous agent's capability matrix.

Before the first spawn, the task detail dialog also shows a slim **pre-spawn context bar** with the same Model and Effort pills. Set them there to avoid the spawn -> cancel -> restart loop: the picker writes the override to the DB, and `prepare-spawn` picks it up on the next agent launch.

When an agent is already running, the same Model / Effort pills appear in the live context bar below the terminal. Picking a value there delivers the change to the running session via the adapter's slash-command injection sequence when it supports live model changes (Claude's `/model`), or suspends and respawns when it does not.

### Spawn an Agent

Drag a task from To Do to any active column (Planning, Executing, etc.). Kangentic will:

1. Create a git worktree for the task (if worktrees are enabled)
2. Spawn a Claude Code CLI session with the task title and description as the prompt
3. The task card shows a spinner while the agent is thinking

### Monitor Progress

- **Terminal panel** at the bottom shows the active session's terminal output
- **Activity tab** shows structured events (tool calls, idle state) instead of raw terminal output
- **Context bar** below the terminal shows session metadata (shell, model, cost, tokens, context usage). Each element is configurable.
- **Task card status** - each card shows a contextual status bar at the bottom:
  - A spinning indicator and model name with context percentage when the agent is actively working
  - An idle icon (amber) when the agent is waiting for input
  - "Initializing..." or "Resuming..." during session startup
  - "Queued..." when waiting for a concurrency slot
  - "Paused" when manually suspended
- **Shimmer overlay** - when a session is starting or resuming (e.g., after a column move that triggers an auto_command), a shimmer loading overlay appears over the terminal. It shows a context-aware label such as the auto_command name, "Resuming agent...", or "Starting agent...". Terminal output is suppressed behind the overlay until the session is ready.

### Move Between Active Columns

Dragging between active columns (e.g., Executing to Code Review) keeps the session alive when the target has no `auto_command`. If the target column has an `auto_command` configured (e.g., `/code-review`), the session is suspended and resumed with the command as the resume prompt. Permission mode differences alone do not cause a suspend/resume cycle.

### Complete a Task

Drag to Done. A confirmation dialog asks you to approve deleting the local worktree (with a "Delete automatically in the future" checkbox to suppress future prompts). On confirm, the worktree directory is removed to reclaim disk, the session is suspended (not destroyed), the task is archived, and both the branch and conversation ID are preserved. If you later unarchive the task and drag it to an active column, Kangentic recreates the worktree from the preserved branch and the agent resumes with full conversation context.

Clicking a completed task opens a session summary showing: duration, model, cost, token usage, tool call count, files changed, and lines added/removed. A collapsible "By tool" section breaks the count down per tool name (calls, total duration, average duration, plus a Failed column when any tool was interrupted). Cost / input / output columns appear only for adapters that emit per-tool telemetry. The Done column also supports searching completed tasks by title and sorting by date, cost, tokens, or duration.

### Task Card Context Menu

Right-click any task card on the board to open a context menu with:
- **Copy Task ID** - copies the display ID (e.g., `#42`) to clipboard
- **Edit** - opens the task detail dialog in edit mode
- **Move to** - submenu listing all other columns as move targets
- **Backlog** - send the task back to the backlog (cleans up session and worktree)
- **Archive** - move the task to Done and archive it
- **Delete** - permanently delete the task, session, and worktree

### Return to To Do

Drag to To Do to kill the session. The worktree is preserved (code stays on disk), but the session is ended. If you drag back to an active column, a fresh session starts.

## Terminal Panel

The bottom panel shows terminal output for running sessions.

### Session Tabs

Each running session gets a tab. Click a tab to switch between sessions. The active tab is highlighted. Double-click a tab to open the corresponding task detail dialog.

Tab indicators show session state at a glance:
- **Green spinner** - agent is actively working
- **Amber dot** - agent is idle (waiting for input). Pulses on tabs that have not been viewed since going idle.
- **Green dot** - session is running (no activity data yet)
- **Gray dot** - session is not running

The amber idle indicator replaces the previous auto-focus behavior (which switched the panel to the idle session automatically). Auto-focus is still available as an opt-in setting under Behavior > Auto-Focus Idle Sessions, but defaults to off.

### Activity Tab

The leftmost tab shows an activity log - structured events from all sessions. This is a plain list (not a terminal) showing tool calls, idle events, and session state changes.

### Clipboard Paste

Press **Ctrl+V** (Cmd+V on macOS) in the terminal to paste. Text on the clipboard is pasted directly. If the clipboard contains an image (and no text), the image is saved to a temporary file and the file path is written to the PTY, allowing Claude Code to pick it up as a vision input. Paths are automatically quoted for the active shell (PowerShell, bash, cmd, WSL, etc.).

### File Drop to Terminal

Drag files from your file manager onto the terminal to insert their file paths into the active session. Paths containing spaces are automatically quoted. Multiple files are inserted as a space-separated list. A visual overlay appears when files are dragged over the terminal area.

### Resize

Drag the panel divider to resize. The terminal resizes to match. Resize events are debounced to prevent output corruption.

## Task Detail Dialog

Click a task card to open the detail dialog. From here you can:

- View the task's **display ID** (e.g., `#42`) in the header - click it to copy to clipboard
- See the **priority badge** next to the display ID when a priority is set
- View **Markdown-rendered descriptions** with full GitHub Flavored Markdown support (tables, task lists, strikethrough, links)
- Edit the task title, description, priority, and labels (type `@` in the description field for file path autocomplete)
- View and manage attachments of any file type (drag-and-drop files onto the dialog, or paste from clipboard)
- Right-click an attachment thumbnail to copy the image to clipboard
- Click any attachment thumbnail to open a full-size preview modal (press Escape to close)
- See the full terminal output (takes ownership from the bottom panel while open)
- View session status, usage stats, and model info
- Pause or resume the agent session using the circular play/pause button in the header
- Run shortcuts from the header bar (configurable pills that launch external tools)
- Open the **Commands & Skills** popover to browse and run Claude Code commands (`.claude/commands/`) and skills (`.claude/skills/`) from the project directory. Search by name, navigate with arrow keys, press Enter to invoke.
- Access the kebab menu (three-dot icon) for additional actions:
  - **Edit** - switch to edit mode for title and description
  - **Open folder** - open the worktree or project directory in your file manager
  - **View PR** - open the associated pull request. PR URLs are populated automatically when an agent runs `gh pr create` or `gh pr view` (GitHub), explicitly via the `kangentic_update_task` MCP tool (any platform), or manually through the PR URL field in edit mode. Also shown as a pill in the header bar and a clickable badge on the task card.
  - **Commands & Skills** - submenu of available Claude Code commands and skills (same as the header popover)
  - **Pause / Resume session** - manually suspend or resume the agent
  - **Move to** - submenu listing all other columns as move targets
  - **Archive** - move the task to Done and archive it
  - **Delete** - permanently delete the task, session, and worktree

### Changes Panel

The Changes tab in the task detail dialog shows a git diff of all files modified by the task's branch compared to its base branch. The file tree on the left lists changed files with insertion/deletion counts. Click a file to view a side-by-side or inline diff on the right. Toggle between split and inline view modes using the button in the toolbar. The panel persists its expanded/collapsed state and selected file across dialog reopens.

The Changes panel is available for all tasks, whether or not worktrees are enabled. It uses `git merge-base` to show only branch-specific changes, excluding upstream commits.

When the dialog is open, it claims the terminal session. The bottom panel releases it. When you close the dialog, the bottom panel reclaims the session.

### Browser Pane

Tasks can host an embedded browser inside the task detail dialog. Use it to preview your dev server, capture screenshots with annotations, and submit framed prompts back to the agent without leaving Kangentic. The pane uses a shared Electron webview partition so cookies and storage persist across all task browsers.

| Action | Shortcut |
|--------|----------|
| Zoom in | **Ctrl+=** / **Ctrl++** (or **Ctrl+wheel up** inside the page) |
| Zoom out | **Ctrl+-** (or **Ctrl+wheel down** inside the page) |
| Reset zoom to 100% | **Ctrl+0** |
| Reload page | **F5** or **Ctrl+R** (outside the embedded page) |

Zoom snaps to a Chrome-compatible ladder (25%, 33%, 50%, 67%, 75%, 80%, 90%, 100%, 110%, 125%, 150%, ... up to 500%). Ctrl+wheel zoom inside the webview uses a smoother multiplicative step but stays clamped to the same range. The toolbar shows a zoom pill with the current factor, plus dedicated zoom-out / reset / zoom-in buttons.

Keyboard shortcuts are scoped to the browser pane: they fire when the mouse is over the pane or focus is inside it, so Ctrl+0 from elsewhere in the app does not interfere with anything else.

## Backlog

The Backlog is a staging area for tasks before they reach the board. Switch between **Board** and **Backlog** views using the tabs at the top.

### Creating Items

Click **New Task** in the backlog toolbar to create a backlog item with a title, description, priority, labels, and optional file attachments. You can paste or drag-and-drop any file type as an attachment.

### Editing Items

Double-click any row to open it for editing. You can also click the pencil icon in the row's action buttons, or right-click and select **Edit** from the context menu.

### Labels

Click **Labels** in the toolbar to manage labels. Labels are free-form text tags added during item creation or editing. From the Labels popover you can rename a label across all items, delete a label, and assign colors to labels for visual distinction. Labels and their colors are shared between the backlog and the board.

### Priorities

Click **Priorities** in the toolbar to manage the priority scale. The default scale is None, Low, Medium, High, Urgent (0-4). You can rename priority levels, reorder them, add new ones, or remove existing ones. Priority colors are customizable.

### Filtering

Click **Filter** to filter by priority level and/or label. Active filters show a count badge on the Filter button. Use the search bar to filter items by title, description, or label text.

### Multi-Selection & Bulk Operations

Click a row to select it, or use the checkboxes. The header checkbox selects/deselects all visible items. When multiple items are selected, a bulk toolbar appears at the bottom with **Move to Board** and **Delete** actions. Right-clicking with multiple items selected shows a context menu that operates on the entire selection.

### Context Menu

Right-click any backlog row to open a context menu with:
- **Move to Board** - submenu listing all available columns as targets
- **Edit** - open the item for editing
- **Delete** - permanently remove the item

When multiple items are selected and you right-click one of them, the context menu operates on all selected items (e.g., "Move 5 to Board", "Delete 3 items").

### Drag to Reorder

Drag rows by the grip handle on the left to manually reorder items. Drag-to-reorder is available when no column sort is active. When you sort by a column header (priority, title, created date), manual reorder is disabled until the sort is cleared.

### Promoting to the Board

Select one or more items using the checkboxes, then click **Move to Board** in the bulk toolbar that appears at the bottom. Choose a target column and the items become board tasks. If the target column has auto-spawn enabled, an agent session starts immediately. You can also promote individual items using the arrow icon in the row action buttons or the context menu.

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

## Board Filtering

The board supports filtering to help you focus on relevant tasks across all columns.

### Search Palette

Press **Ctrl+Shift+F** (Cmd+Shift+F on macOS) or **Ctrl+F** (Cmd+F) to open the global search palette. The same overlay is also reachable from the search icon in the title bar. The palette searches across:

- Tasks (active and archived) by title and description
- Backlog items by title and description
- Session events (tool calls, agent activity from `events.jsonl`)
- Registered projects by name and path

Default scope is the current project; toggle to **All projects** to widen the search across every registered project. Selecting a hit jumps to the right place: tasks open the detail dialog, session events scroll the Activity Log to the matched event with a brief highlight, backlog hits switch to the backlog view and open the item's edit dialog, and project hits switch projects.

### Filter Popover

Click the filter icon at the top right of the board to open the filter popover. Filter by:
- **Priority** - toggle one or more priority levels (None, Low, Medium, High, Urgent)
- **Labels** - toggle one or more labels from the project's label set

Active filters show a count badge on the filter icon. Click "Clear all filters" at the bottom of the popover to reset. Priority and label filters combine with the search query - a task must match all active criteria to be visible.

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
| **Agent** | Override the project's default agent for this column (e.g., use Codex for code review) |
| **Permission Mode** | Override the global permission mode for agents in this column |
| **Auto Spawn** | Whether moving a task here spawns an agent (default: on) |
| **Auto Command** | Command injected into running sessions when tasks arrive |
| **Plan Exit Target** | For plan-mode columns: where tasks move when planning completes |

When a column's agent override differs from the current session's agent, moving a task into that column triggers a cross-agent handoff. The outgoing agent's context (transcript, git changes, metrics) is automatically packaged and delivered to the incoming agent.

### Reorder Columns

Drag column headers to reorder.

### Delete a Column

Columns can only be deleted when empty (no tasks).

## Settings

Settings are accessed from two entry points:

- **App Settings** - click the gear icon in the title bar. This is the main settings panel with all app-wide and project-default settings.
- **Project Settings** - click the gear icon on a project row in the sidebar. This shows only the per-project overridable subset.

Both panels use a VS Code-style layout: a sidebar with tab navigation on the left, and the active settings pane on the right. In App Settings, tabs above the separator (General, Theme, Terminal, Agent, Git, Browser, Shortcuts) are per-project settings; tabs below the separator (Layout, Behavior, Hotkeys, MCP Server, Agent Browser, Notifications, Privacy, Developer) are shared across all projects. The General tab shows the project's location on disk with a "Move..." button (see [Moving a project](#moving-a-project)). When no project is open, only the shared tabs appear. Project Settings shows inherited defaults as hints, with reset buttons on any overridden value and a "Reset All" footer when overrides exist.

### Moving a project

To relocate a project to a new folder, open Project Settings > General and click **Move...**. Pick the destination's parent folder; Kangentic moves the project folder (keeping its name) into it and re-points the project at the new path in one step. All tasks, board history, and worktrees move with it, and each agent's resumable session data is migrated so sessions resume at the new location.

Before the move, a confirmation dialog lists the project's active agent sessions. Confirming stops them (they resume automatically at the new path) and performs the move; cancelling changes nothing. Only this project's own sessions are touched - agents running in other projects or external terminals are left alone.

A same-drive move is instant. Moving to a different drive copies the folder (a progress indicator shows the copy), then removes the original once the relocation has succeeded; if the original cannot be fully removed, the move still completes and a warning notes that the old copy remains.

If a project's folder was moved or renamed outside Kangentic while the app was closed, you are instead prompted with **Project Folder Not Found** the next time you open it; click **Locate Folder...** to point Kangentic at the new location.

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
| Scrollback Lines | Lines kept in the visible scrollback (1000 to 100000, default 5000). Full session history is preserved for replay regardless of this value. |
| Cursor Style | Terminal cursor appearance (block, underline, or bar) |

### Context Bar

The context bar is a status line displayed below the terminal showing session metadata. Each element can be individually toggled on or off in App Settings > Terminal.

| Toggle | What it shows |
|--------|--------------|
| Shell | The active shell name (e.g., pwsh, bash, zsh) |
| Version | Agent CLI version |
| Elapsed | Ticking wall-clock time since the session started |
| Model | Active model name (e.g., Claude Sonnet 4) |
| Cost | Cumulative session cost in dollars |
| Tool Calls | Cumulative count of completed tool calls |
| Agent Active | Agent active time reported by the CLI (off by default) |
| Tokens | Token usage (input + output) |
| Context Fraction | Context window usage as a percentage |
| Progress Bar | Visual progress bar for context window usage |
| Rate Limits | Adapter-reported plan-usage quota bars (e.g. Claude reports 5-hour session and 7-day weekly windows). Hidden for adapters that do not report rate limits. |

### Agent Settings

| Setting | Description |
|---------|-------------|
| Default Agent | Which agent CLI to use for new sessions in this project. Supported agents: Claude Code, Codex CLI, Gemini CLI, Qwen Code, Kimi Code, OpenCode, Droid (Factory), Cursor CLI, GitHub Copilot CLI, Aider, Oz CLI (Warp). Per-project setting. |
| CLI Path | Path to agent CLI binary (auto-detected if empty) |
| Idle Timeout (minutes) | Auto-suspend sessions after N minutes idle; 0 to disable |
| Permissions | Default permission mode for all sessions. Options vary by agent (e.g., Claude Code has Plan, Don't Ask, Default, Accept Edits, Auto, and Bypass; Aider has Interactive and Auto-Approve) |

All permission modes are available in both the global App Settings dropdown and the per-column Edit Column dialog. The dropdown shows only the modes supported by the active agent. Each column can override the project default agent via the Edit Column dialog. When a task moves between columns with different agents, a context handoff occurs automatically - see [Column Management](#column-management) above.

### Git Settings

| Setting | Description |
|---------|-------------|
| Worktrees Enabled | Create isolated branches per task |
| Auto Cleanup | Delete branches when worktrees are removed |
| Default Base Branch | Branch to create worktrees from (default: main) |
| Copy Files | Files to copy from repo root into worktrees |
| Post-Worktree Script | Shell script run in each new worktree after creation (e.g. `npm install`). A non-zero exit or timeout fails worktree creation |
| Link node_modules | Symlink the root `node_modules` into each worktree to skip a fresh install (on by default). Turn off to let the Post-Worktree Script install the worktree's own dependencies |

### Shortcuts

The Shortcuts tab lets you add custom command buttons to the task detail dialog. Each shortcut has a label, icon, shell command, and display location (header bar, kebab menu, or both).

Commands support template variables: `{{cwd}}`, `{{branchName}}`, `{{taskTitle}}`, `{{projectPath}}`. These are resolved at runtime using the active task's context.

Shortcuts can be scoped as **Team** (saved in `kangentic.json`, shared via git) or **Personal** (saved in `kangentic.local.json`, local-only). Presets are available for common tools (VS Code, Cursor, GitHub Desktop, terminal emulators, file managers).

### Scope

Settings have two scopes:
- **Global** - applies to all projects
- **Project** - overrides global settings for this project only (stored in `.kangentic/config.json`)

Some settings are global-only and cannot be overridden per-project (e.g., max concurrent sessions, sidebar width).

### Behavior Settings

These are global-only settings that apply to the entire app.

| Setting | Description |
|---------|-------------|
| Max Concurrent Sessions | Limit how many agents can run at the same time |
| When Max Sessions Reached | How new agent requests are handled when all slots are in use (Queue or Reject) |
| Auto-Focus Idle Sessions | Automatically switch the bottom panel to idle sessions. Idle tabs are always highlighted regardless of this setting. |
| Auto-Resume Agents on Restart | When a project opens, resume any agent sessions that were running at last close. When off, those sessions stay paused until you click Resume on each task. Turn off if resuming many agents at once slows your machine. |
| Auto-Apply Board Config Changes | When a kangentic.json board change is detected (from a teammate or a pulled-back commit), apply it immediately instead of showing the confirmation dialog. |

### MCP Server

The MCP Server tab controls the built-in Model Context Protocol server. When enabled, agents running inside Kangentic get access to MCP tools for creating tasks, querying the board, and viewing session stats. Disable this if you don't want agents to interact with the board programmatically.

| Setting | Description |
|---------|-------------|
| Kangentic MCP Server | Enable or disable the built-in MCP server that gives agents board-aware tools |

### Agent Browser

The Agent Browser tab controls whether and how agents may drive the embedded Browser pane via the `kangentic_browser_*` tools (screenshot, click, type, navigate, and more), so an agent can verify a dev server you have loaded. It is a global (per-machine) policy, separate from the per-project Browser tab.

| Setting | Description |
|---------|-------------|
| Enable Browser Automation | Master switch. Turn off to disable all agent browser control. |
| Allow Interaction | Let agents click, type, press keys, and drag. Off is observe-only (screenshots and DOM reads still work). |
| Allow Navigation | Let agents point the pane at other URLs. Off confines agents to the page you loaded. |
| Allow Eval | Let agents run arbitrary JavaScript in the loaded page. Off by default. |
| Restrict Navigation to Localhost | Only allow agents to navigate the pane to localhost / private hosts. Off by default. |

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

The sidebar shows all your projects. Click to switch between them. Each project has its own board, columns, and sessions. Drag projects to reorder them. The order persists across app restarts. New projects appear at the top.

The selected project shows action buttons (Open, Settings, Delete) directly on the row. Right-click any project to open a context menu with Rename, Open in Explorer, Project Settings, and Delete. Inline rename is supported via the context menu - press Enter to save, Escape to cancel.

If a project's folder is moved or renamed while Kangentic is closed, opening it shows a "Project Folder Not Found" dialog with a "Locate Folder..." button to re-point the project at its new location. Project Settings > General > Change does the same thing on demand. Because tasks and board history are keyed by project id, they are preserved across a relocation. Each agent's session data and per-project settings that live outside the project folder keyed by the old path (Claude transcripts, Codex/Gemini/Qwen trust and chats, OpenCode's session DB, Kimi/Droid session dirs, Copilot workspaces) are migrated automatically, so suspended sessions still resume at the new location. See [Project relocation](agent-integration.md#project-relocation) for the per-agent details.

### Idle Badges

When an agent goes idle (waiting for input or stopped) on a non-active project, the sidebar shows a badge. This helps you notice when agents need attention across projects.

### Notifications

Desktop and toast notifications fire when an agent needs attention and the user can't already see it - either the window is minimized/unfocused, or a different project is active. Notification events: agent idle, permission-blocked idle (body shows "Needs permission"), session crash (non-zero exit), and plan-completion auto-moves. The task name is the title and the project name is the body. Clicking a desktop notification brings the window to the foreground, switches to the correct project, and opens the task detail dialog. The taskbar also flashes on Windows. A 10-second per-session cooldown prevents repeated desktop notifications from the same agent.

The Settings > Notifications panel exposes two configurable events: **Agent Idle** and **Plan Complete**. Each can be set to Desktop & Toast, Desktop Only, Toast Only, or Off. Toast duration and max visible count are also configurable. The **Agent Crash** notification (non-zero exit) is always on and not exposed in the settings UI.

### Privacy

The Privacy tab shows what anonymous analytics Kangentic collects and how to opt out. Analytics are powered by Aptabase (no cookies, no persistent identifiers, GDPR-compliant). Set `KANGENTIC_TELEMETRY=0` as an environment variable to disable analytics entirely. This tab is informational only - there are no configurable settings.

### Developer

The Developer tab exposes power-user diagnostics for the activity-detection subsystem. Settings here are global (apply to every project) and are intended for debugging only.

| Setting | Description |
|---------|-------------|
| Activity Engine Debug Overlay | Show a floating overlay with live activity-engine state for every running session: current `ActivityReason`, raw counters (pending tools, subagent depth, background shells), and a ring buffer of recent state transitions. Toggle from anywhere with Ctrl+Shift+D. Polls every 2 seconds while open; lazy-disables the IPC when closed. |

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

**Opening:** Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS), or click the terminal icon in the title bar (next to the settings gear). The terminal icon's border reflects activity across your open terminals: it marches in green while an agent is working, holds a steady warm amber when one needs your input, and stays plain when idle.

**Behavior:**
- Spawns Claude Code at the project root on the configured default base branch
- It opens as a **window** over a slight backdrop blur: drag it by the header, resize it from any edge or corner, maximize / restore it (double-click the header or use the maximize button), and snap it to a screen half or full screen (Windows-style). The layout (size, position, maximized state) **persists globally** across all projects and app restarts.
- **Run more than one at once.** While the layer is open, the title-bar terminal icon shows a **`+`** in its center - click it to open another terminal (up to four). New terminals split into the current window's footprint (side by side, keeping the size you set) so you can keep two ad-hoc tasks cooking and glance between them; drag the seam to rebalance, or maximize one to focus it.
- **Layout controls (same as task windows).** The header's tile-layout button offers one-click snap (left / right / top / bottom) and tilings (columns / grid). When a terminal is tiled, a **pop-out** button floats it back out of the tile group. The title always wins the header's space: the quick-action pills (Commands, Project, Changes, shortcuts) fold into the `...` menu as the window narrows.
- The **branch picker** in the header lets you switch branches - selecting a new branch kills that terminal's session and respawns it on the selected branch
- A shimmer overlay shows while Claude Code initializes, then lifts to reveal the clean TUI
- Transient sessions are fully independent of task sessions - they don't appear in the terminal panel tabs, don't count toward session limits, and produce no toasts on exit
- Your terminals are **preserved across project switches**. If you open terminals, switch to another project, and switch back, they are still running. Each project keeps its own terminals, so you can keep ad-hoc work going while navigating between projects.
- If git checkout fails when switching branches (e.g., uncommitted changes), a warning toast explains the issue and the session stays on the current branch

**Hiding vs stopping:** Press `Ctrl+Shift+P` again, `Ctrl+Shift+W`, or click the blurred backdrop to **hide** the layer - every PTY stays alive in the background and reopening reattaches (so the layout and running sessions are right where you left them). There is no per-window close button: a window's **Stop** (red, and the kebab's "Stop terminal") **destroys** that one terminal - it kills the PTY, cleans up the session directory, and closes the window; the rest stay open. Stopping the last terminal hides the layer. Transient sessions are non-resumable by design.

## Status Bar

The status bar runs along the bottom of the window, providing at-a-glance metrics for the current project.

| Element | Description |
|---------|-------------|
| **Agents** | Count of actively running agent sessions (green when > 0), plus queued count if any |
| **Tasks** | Count of active (non-done) tasks on the board |
| **Tokens** | Aggregate input and output token counts across sessions |
| **Cost** | Aggregate API cost across sessions |

### Time Period

Click the time period dropdown at the right end of the status bar to change the reporting window. Options:

- **Live** - shows only metrics from currently running sessions (default)
- **Today** - includes historical session metrics from today plus live sessions
- **This Week** - includes metrics from the past 7 days plus live sessions
- **This Month** - includes metrics from the past 30 days plus live sessions
- **All Time** - includes all historical metrics plus live sessions

Token and cost values pulse briefly when they change. The selected period persists across app restarts (stored in `statusBarPeriod` config key).

## Keyboard Shortcuts

Every shortcut is declared in a central registry and is **rebindable** under Settings > Hotkeys, where it can be bound to a key chord or a mouse button (middle or side buttons). Hotkeys also flags conflicts and combos already claimed by the OS or another app. `Mod` below is Cmd on macOS and Ctrl on every other platform.

General:

- **Mod+Shift+S** - Toggle the settings panel
- **Mod+Shift+B** - Switch between Board and Backlog view
- **Mod+Shift+E** - Toggle the project sidebar
- **Mod+Shift+J** - Toggle the bottom terminal panel
- **Mod+Shift+P** - Toggle the Command Terminal window
- **Mod+Shift+F** - Open Quick Find (cross-project search palette)
- **Mod+F** - Find on Board (focuses board search; opens Quick Find when not on the board)
- **Mod+N** - New Task on the board
- **Escape** - Close any open dialog or the search palette

Task detail (whichever panel is open):

- **Mod+Shift+M** - Maximize the command terminal, the task detail dialog (view or edit mode), or a create dialog (New Task / New Backlog Task)
- **Mod+Shift+W** - Close the command terminal, the task detail dialog, or a create dialog (New Task / New Backlog Task). Escape also closes any modal.
- **Mod+Shift+B** - Toggle the browser pane inside the task detail dialog
- **Mod+Shift+G** - Toggle the changes (diff) panel inside the task detail dialog
- **Middle-click the window header** - Close a modeless task-detail window (default `Mouse:Middle`; routes through the same unsaved-edits guard as the close button)

Windows (modeless task-detail windows):

- **Mod+Shift+Left** / **Mod+Shift+Right** - Snap the focused window to the left / right half of the board area
- **Mod+Shift+Up** / **Mod+Shift+Down** - Snap the focused window to the top / bottom half

Terminal:

- **Mod+C** / **Mod+Shift+C** - Copy selected text (with no selection, Ctrl+C cancels the running command)
- **Mod+V** / **Mod+Shift+V** - Paste text or an image into the terminal
- Standard OS shortcuts for the rest of terminal editing

## Tips

- **Plan mode workflow:** Use a Planning column with `permission_mode='plan'` and `plan_exit_target_id` pointing to your Executing column. The agent plans first, then auto-moves to execution.
- **Auto commands:** Set `auto_command` on a Code Review column to automatically ask the agent to review its own code when tasks arrive.
- **Concurrent agents:** Increase `maxConcurrentSessions` to run more agents in parallel. Each needs its own worktree to avoid conflicts.
- **Resume from Done:** Unarchive a completed task and drag it back to an active column. Kangentic recreates the worktree from the preserved branch on the fly, and the agent picks up exactly where it left off.
