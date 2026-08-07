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

Pasted screenshots are automatically compressed to fit Claude's per-image budget. Kangentic resizes large pastes to a 1568px long edge (matching the API's own downscale) and re-encodes them as WebP, stepping quality down until each image lands under a ~1.5MB target, so a multi-monitor screen grab does not get rejected by the API. Small pastes (under 500KB), GIFs, and SVGs are attached as-is.

In the description field, type `@` to trigger file autocomplete. A dropdown lists files and directories from the project root, which you can navigate with arrow keys and select with Enter to insert the path.

#### How this task runs: Column Settings or Agent Override

At the bottom of the New Task dialog (and the task detail edit form for an existing task) is a
single either/or choice. The two options are mutually exclusive - picking one clears the other -
because one varies settings per column while the other pins them for the task's whole life.

| Option | Behavior |
|--------|----------|
| **Column Settings** | Each column applies its own settings as the task moves. A **Profile** dropdown picks *which* set: **Default** (the board as configured) or a named Board Profile. |
| **Agent Override** | Pinned for the whole task, ignoring column settings. |

**Board Profiles** are the answer to "I want Opus xhigh for Planning but Sonnet high for Merge."
A profile is a named alternate set of per-column settings, so a heavy task and a light task can
ride the same board at different tiers without either user changing the shared column config.
Profiles are created and edited in **Edit Columns** (the Board Manager), where selecting one
switches the column editors to that profile's values; column structure (which columns exist, their
names and order) is shared across all profiles and is locked while a profile is selected. Profiles
are saved to `kangentic.json`, so they reach teammates through git.

The pencil button beside the Profile dropdown opens Edit Columns, which is the only place profiles
are authored - so creating your first one and retuning an existing one are the same trip. Until a
board has any, the dropdown shows **Default**, disabled: the concept stays visible without adding a
second creation path to keep in sync.

Choosing **Agent Override** reveals the per-task pins:

| Field | Description |
|-------|-------------|
| **Agent** | Pick a specific agent CLI (Claude, Codex, etc.) for this task. Defaults to the destination column's agent override, then the project default. Locked (shown disabled, on the one agent it has) when only one agent is detected on the machine. The pencil beside it opens Settings > Agent, where all four of these fields get their project defaults. |
| **Model** | Adapter-specific model identifier (e.g. `opus`, `sonnet`, `claude-opus-4-8`). The dropdown is fed by the shared model cache. For Claude, the list is populated both by scanning past session transcripts and by harvesting the CLI's own `/model` picker through a hidden background probe, so newly shipped models surface without first being used in a session. |
| **Effort** | Adapter-specific reasoning tier (Claude: `low`, `medium`, `high`, `xhigh`, `max`). Only shown when the agent reports effort levels. |
| **Permission** | Permission mode for this task. A column that forces Plan mode still wins while the task is in that column - that is a safety guarantee, not an ordinary default. |

A per-task pin **stays with the task across column moves** - column settings are ignored once a task
carries its own override. Changing the Agent resets Model + Effort because the previous picks were
valid for the previous agent's capability matrix.

You can also choose Agent Override and pick nothing at all. Each field then shows, in the muted
placeholder weight, the value it resolves to today, and keeps resolving live until the task spawns
for the first time - at which point all four lock to the values the dialog was showing. That is the
point of the branch: "whatever this task would run right now, pin exactly that." Because it stores
no pins, the choice itself is what is saved, so the branch is still selected when you reopen the
task.

Agents can read and edit Board Profiles too, including across projects, which is the practical way
to keep them in sync as models change ("update every profile's Opus 4.8 to Opus 5", "copy this
board's Heavy profile into project X"). See
[MCP Server > Board Profiles](mcp-server.md#board-profiles).

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

Drag to Done. The worktree directory is removed to reclaim disk, the session is suspended (not destroyed), the task is archived, and the conversation ID is preserved. The branch is deleted too when **git.autoCleanup** is on (the default) and kept when it is off. A clean move happens silently; a confirmation dialog appears only when the move would destroy real work - uncommitted files, or commits that exist only on the local branch about to be deleted - and it spells out exactly what is at risk (worktree deleted, branch kept or deleted, session history kept). If you later unarchive the task and drag it to an active column, Kangentic recreates the worktree and the agent resumes with full conversation context.

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

Drag to To Do to reset the task to "not started": the session is killed and its history wiped, and the worktree is removed (the branch too, when **git.autoCleanup** is on). When the reset would destroy pending changes, a confirmation dialog warns that the worktree and session history will be lost before anything happens. If you drag back to an active column, a fresh session starts in a fresh worktree.

## Terminal Panel

The bottom panel shows terminal output for running sessions.

### Session Tabs

Each running session gets a tab. Click a tab to switch between sessions. The active tab is highlighted. Double-click a tab to open the corresponding task detail dialog.

Opening a task's detail moves its terminal out of the panel, so that tab disappears while the detail is open - on the board and in the [Agent Monitor](#agent-monitor) alike. The other tabs stay where they are. Close the detail and the tab comes back, still selected. When the last tab goes, the panel collapses to its thin strip.

Tab indicators show session state at a glance:
- **Green spinner** - agent is actively working
- **Amber dot** - agent is idle (waiting for input). Pulses on tabs that have not been viewed since going idle.
- **Green dot** - session is running (no activity data yet)
- **Gray dot** - session is not running

The amber idle indicator replaces the previous auto-focus behavior (which switched the panel to the idle session automatically). Auto-focus is still available as an opt-in setting under Behavior > Auto-Focus Idle Sessions, but defaults to off.

### Activity Tab

The leftmost tab shows an activity log - structured events from all sessions. This is a plain list (not a terminal) showing tool calls, idle events, and session state changes.

### Clipboard Paste

Press **Ctrl+V** (Cmd+V on macOS) in the terminal to paste. Text on the clipboard is pasted directly. If the clipboard contains an image (and no text), the image is saved to a temporary file; the agent then reliably reads it as a vision input, since a bare file path alone is not recognized as an image by most CLIs. Claude Code receives an explicit "Read this image: ..." instruction pointing at the saved file (this is more reliable than the CLI's own clipboard reader, which can silently miss a Windows Snipping Tool image); other agents receive the bare file path today. Paths are automatically quoted for the active shell (PowerShell, bash, cmd, WSL, etc.).

### File Drop to Terminal

Drag files from your file manager onto the terminal to insert their file paths into the active session. An image file (PNG, JPEG, GIF, WebP, BMP, SVG) is inserted the same way as a pasted image (Claude Code gets an explicit "Read this image: ..." reference); any other file is inserted as its bare file path. Paths containing spaces are automatically quoted. Multiple files are inserted as a space-separated list. A visual overlay appears when files are dragged over the terminal area.

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
- See the full terminal output (takes the terminal from the bottom panel, whose tab for this task disappears while the detail is open)
- View session status, usage stats, and model info
- Pause or resume the agent session using the circular play/pause button in the header
- Run shortcuts from the header bar (configurable pills that launch external tools)
- Open the **Commands & Skills** popover to browse and run Claude Code commands (`.claude/commands/`) and skills (`.claude/skills/`) from the project directory. Search by name, navigate with arrow keys, press Enter to invoke.
- Open the task's transcript in the read-only [conversation viewer](#the-conversation-viewer) via the **View conversation** pill (speech-bubble icon). Muted until the task has session history, live or historical.
- Access the kebab menu (three-dot icon) for additional actions:
  - **Edit** - switch to edit mode for title and description
  - **Open folder** - open the worktree or project directory in your file manager
  - **View conversation** - same as the header pill
  - **View PR** - open the associated pull request. PR URLs are populated automatically when an agent runs `gh pr create` or `gh pr view` (GitHub), explicitly via the `kangentic_create_task` / `kangentic_update_task` MCP tools (any platform), or manually through the PR URL field in edit mode. Those are the only ways to link a PR: writing a PR URL into the task description does not link it, so you can cite another task's PR as background without it being mistaken for this task's own. Also shown as a pill in the header bar and a clickable badge on the task card.
  - **Commands & Skills** - submenu of available Claude Code commands and skills (same as the header popover)
  - **Pause / Resume session** - manually suspend or resume the agent
  - **Move to** - submenu listing all other columns as move targets
  - **Archive** - move the task to Done and archive it
  - **Delete** - permanently delete the task, session, and worktree

### Changes Panel

The Changes tab in the task detail dialog is a commit-history browser stacked vertically: a commit-history region on top, and a detail pane (file tree + diff) below, split by a resizable divider.

The history region is a **pinned "Uncommitted changes" row** above the branch's commit graph (a visual DAG: commit nodes down a vertical axis, lane columns for parallel branches, and edges to each commit's parents). Each commit row shows the short SHA, subject, author, and relative time; the branch tip is marked `HEAD`, the fork point is labelled with the base branch, and a linked pull request's head commit is tagged with its PR number. The graph reads git directly (no session required), refreshes live as you commit or the branch's refs change, and is capped at the most recent 200 commits with a note when older commits are trimmed.

**Uncommitted changes** is selected by default and shows the branch-wide diff: the file tree on the left lists changed files with insertion/deletion counts, a scope selector (working / staged / branch) picks which changes to diff, and a base-branch label shows whether the branch diverged from the default base or a custom one. Click a file to view a side-by-side or inline diff on the right. Toggle between split and inline view modes using the button in the toolbar.

**Selecting a commit** in the history region scopes the detail pane to that commit's own diff (`<oid>^..<oid>`) instead - a compact header identifies the commit, with a back button that returns to Uncommitted changes.

Right-click a file in the tree for **View history**, a popover listing the commits that touched that file (`git log --follow`); selecting one jumps the detail pane to that commit. The diff toolbar also has a **blame** toggle (off by default, per file) that annotates each line of the modified editor with its short hash and author via a left-gutter column, with the full hash/author/date on hover; blame is only available for the Uncommitted detail (it reflects the file's current content, so it doesn't apply while browsing a historical commit).

The panel persists its expanded/collapsed state, selected file, selected commit, and divider positions across dialog reopens.

The Changes panel is available for all tasks, whether or not worktrees are enabled. It uses `git merge-base` to show only branch-specific changes, excluding upstream commits.

When the dialog is open, it claims the terminal session and the bottom panel drops that task's tab. Any other running session keeps its tab and its live terminal; the panel only collapses once nothing is left in it. Closing the dialog returns the tab, still selected.

### Browser Pane

Tasks can host an embedded browser inside the task detail dialog. Use it to preview your dev server, capture screenshots with annotations, and submit framed prompts back to the agent without leaving Kangentic. Each worktree gets its own persistent webview partition (cookie jar), so two tasks logged into dev servers on the same localhost host don't clobber each other's sessions; tasks without a worktree share a single fallback jar.

Agents can drive the pane themselves through the `kangentic_browser_*` MCP tools (navigate, screenshot, DOM queries, click, type, eval), governed by the [Agent Browser](#agent-browser) settings tab.

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
2. Browse items with filtering by ID, title, type, status, assignee, and labels (the search box
   matches only what a row displays, so every hit is explainable from the row itself)
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
- Past agent conversations, by keyword or by meaning (Smart mode, when semantic search is enabled in Settings > Memory) - see [Conversation Memory](#conversation-memory)

Default scope is the current project; toggle to **All projects** to widen the search across every registered project. Selecting a hit jumps to the right place: tasks open the detail dialog, session events scroll the Activity Log to the matched event with a brief highlight, backlog hits switch to the backlog view and open the item's edit dialog, project hits switch projects, and conversation hits open the read-only [conversation viewer](#the-conversation-viewer) scrolled to the matched turn (or route to the live terminal if that session is still running).

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

Settings are accessed from two entry points, both opening the same unified panel:

- **App Settings** - click the gear icon in the title bar. Scoped to the currently active project (or, if none is open, only the shared System tabs appear).
- **Project Settings** - click the gear icon on a project row in the sidebar. Opens the same panel scoped to that project, with a project switcher dropdown in the header to jump between projects.

Both panels use a VS Code-style layout: a sidebar with tab navigation on the left, and the active settings pane on the right. Tabs above the divider (General, Theme, Agent, Git, Browser, Shortcuts) are per-project settings; tabs below it (Board, Task, Changes, Terminal, Behavior, Hotkeys, Notifications, Dictation, Memory, MCP Server, Agent Browser, Mobile Devices, Privacy, Developer) are shared across all projects. The shared tabs are further grouped into Core (Board through Notifications, unlabeled), Advanced (Dictation through Mobile Devices), and Other (Privacy, Developer). The General tab shows the project's location on disk with a "Move..." button (see [Moving a project](#moving-a-project)); the Theme tab holds the interface color-scheme picker. The Task tab (Card Density, Ticket Numbers, Context Bar) holds settings for how an individual task presents itself, split out from Board and Terminal. Terminal (shell, font, cursor style, colors) is a shared tab, not per-project: nobody wants a different font per project, and the shell setting in particular was never reliably project-scoped under the hood. When no project is open, only the shared tabs appear.

### Moving a project

To relocate a project to a new folder, open Project Settings > General and click **Move...**. Pick the destination's parent folder; Kangentic moves the project folder (keeping its name) into it and re-points the project at the new path in one step. All tasks, board history, and worktrees move with it, and each agent's resumable session data is migrated so sessions resume at the new location.

Before the move, a confirmation dialog lists the project's active agent sessions. Confirming stops them (they resume automatically at the new path) and performs the move; cancelling changes nothing. Only this project's own sessions are touched - agents running in other projects or external terminals are left alone.

A same-drive move is instant. Moving to a different drive copies the folder (a progress indicator shows the copy), then removes the original once the relocation has succeeded; if the original cannot be fully removed, the move still completes and a warning notes that the old copy remains.

If a project's folder was moved or renamed outside Kangentic while the app was closed, you are instead prompted with **Project Folder Not Found** the next time you open it; click **Locate Folder...** to point Kangentic at the new location.

### Search

A search bar at the top of each panel filters settings by keyword. Type multiple words to narrow results (all tokens must match). Results are grouped by tab with match count badges on the sidebar tabs. Tabs with zero matches are dimmed. Press Ctrl+F (Cmd+F on macOS) to focus the search bar, Escape to clear the filter.

### Themes

Choose from 10 themes in the Theme tab's dropdown (a per-project setting):
- **Base:** Dark, Light
- **Dark variants:** Moon, Forest, Ocean, Ember
- **Light variants:** Sand, Mint, Sky, Peach

### Terminal Colors

The Terminal tab's **Colors** section (not the Theme tab's color-scheme picker - this is a global setting, not per-project) lets you customize the terminal's background, foreground, and cursor color. Click a swatch to open the color picker; any color left at its default shows the built-in value (near-black `#0c0c0c` background, `#e4e4e7` foreground/cursor). The preset grid offers the built-in default first, then a color matching your current app theme (skipped if it would duplicate the default), then curated generic presets. The 16-color ANSI palette (used by shell tools like `git diff` and `ls --color`) is a fixed scheme based on Windows Terminal's Campbell, not individually customizable. "Reset to default" clears every customization. Applies globally across all projects.

### Terminal Settings

Applies to every project (Settings > Terminal, not a per-project override):

| Setting | Description |
|---------|-------------|
| Shell | Override the auto-detected shell |
| Font Size | Terminal text size in pixels |
| Font Family | Terminal font, picked from your detected system fonts via an autocomplete field |
| Cursor Style | Terminal cursor appearance (block, underline, or bar) |
| Word Delete on Backspace | Backspace deletes the whole previous word instead of one character (off by default) |

### Task Settings

Applies to every project (Settings > Task, not a per-project override). These describe how an individual task presents itself, not board layout or terminal cosmetics:

| Setting | Description |
|---------|-------------|
| Card Density | Amount of detail shown on task cards (compact, default, comfortable) |
| Ticket Numbers | Show each task's `#N` number as a muted badge on its card (off by default) |

The Task tab also holds the Context Bar toggles below.

### Context Bar

The context bar is a status line displayed below the terminal showing session metadata. Each element can be individually toggled on or off in App Settings > Task.

| Toggle | What it shows |
|--------|--------------|
| Shell Name | The active shell name (e.g., pwsh, bash, zsh) |
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
| Default Agent | Which agent CLI to use for new sessions in this project. Supported agents: Claude Code, Codex CLI, Gemini CLI, Qwen Code, Kimi Code, OpenCode, Droid (Factory), Cursor CLI, GitHub Copilot CLI, Aider, Oz CLI (Warp), Ollama. Per-project setting. |
| CLI Path | Path to agent CLI binary (auto-detected if empty) |
| Execution (remote) | For agents that support it (today OpenCode), attach to a server you run instead of spawning a local process: server URL, authentication, and the server-side working directory. Shown only when the selected agent declares remote execution. |
| Launch Options | Agent-specific startup toggles (today Codex's "Disable ChatGPT Apps", which skips the optional cloud ChatGPT Apps connector that can hang startup). Shown only for agents that declare options. |
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
| Auto-Focus Idle Sessions | Automatically switch the bottom panel to idle sessions. Idle tabs stay highlighted either way. |
| Auto-Resume Agents on Restart | Resume agent sessions that were running when the project last closed. Turn off if resuming many at once slows your machine. |
| Idle Timeout (minutes) | Auto-suspend sessions after N minutes idle; 0 to disable |
| Close on Outside Click | Click-outside (light-dismiss) policy for modeless task-detail windows. Closing a window does not kill its session. |
| Restore Window Position | Remember window size and position between launches |

The Board tab has its own Auto-Apply Board Config Changes toggle - see [Applying Changes](#applying-changes) below.

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

The sync runs both ways. Opening a project also reads an existing `kangentic.json` back INTO your database first, before that write - so editing the file by hand is a genuine way to change the board, not just a record of it. That read happens with no banner and no prompt, and the file wins where the two disagree. See [Board Config Sync](configuration.md#board-config-sync-kangenticjson) for the full rules, including the one case where an invalid file gets silently overwritten from the database.

### Personal Overrides

Create a `kangentic.local.json` in the project root for personal customizations (column colors, icons, extra columns). This file is auto-added to `.gitignore` and merges on top of the team config.

### Applying Changes

When `kangentic.json` or `kangentic.local.json` changes on disk, a reconciliation banner appears at the top of the board. Click "Apply" to reconcile the file into your database, or dismiss to ignore. Enable Auto-Apply Board Config Changes in the Board settings tab to apply changes automatically instead.

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

If a project's folder is moved or renamed while Kangentic is closed, opening it shows a "Project Folder Not Found" dialog with a "Locate Folder..." button to re-point the project at its new location. To relocate proactively, Project Settings > General > **Move...** has Kangentic move the folder itself (see [Moving a project](#moving-a-project)). Because tasks and board history are keyed by project id, they are preserved across a relocation. Each agent's session data and per-project settings that live outside the project folder keyed by the old path (Claude transcripts, Codex/Gemini/Qwen trust and chats, OpenCode's session DB, Kimi/Droid session dirs, Copilot workspaces) are migrated automatically, so suspended sessions still resume at the new location. See [Project relocation](agent-integration.md#project-relocation) for the per-agent details.

### Idle Badges

When an agent goes idle (waiting for input or stopped) on a non-active project, the sidebar shows a badge. This helps you notice when agents need attention across projects.

### Command Terminal Indicator

Command Terminals keep running when you hide the layer and when you switch projects, so a project you are not looking at can still be holding live terminals. Each project row shows a terminal glyph and a count when it has any, alongside the agent idle/thinking counts, colored the same way as the title-bar toggle: green while a terminal is working, amber when one is waiting on you, muted when it is just sitting there. It sits next to the agent idle/thinking counts rather than merging with them, since a Command Terminal is not a task agent. Click it to switch to that project and reopen its terminals. When the sidebar is collapsed, the rail shows the same state as a small dot on the project's initial.

### Notifications

Desktop and toast notifications fire when an agent needs attention and the user can't already see it - either the window is minimized/unfocused, or a different project is active. Notification events: agent idle, permission-blocked idle (body shows "Needs permission"), session crash (non-zero exit), and plan-completion auto-moves. The task name is the title and the project name is the body. Clicking a desktop notification brings the window to the foreground, switches to the correct project, and opens the task detail dialog. The taskbar also flashes on Windows. A 10-second per-session cooldown prevents repeated desktop notifications from the same agent.

The Settings > Notifications panel exposes four configurable events: **Agent Idle**, **Agent Crash** (session exit; desktop alerts on error exits only, toasts also cover clean exits), **Plan Complete**, and **Spawn Stalled** (a task spawn that waits too long on the git queue while preparing). Each can be set to Off, Desktop only, Toast only, or Both. Toast duration and max visible count are also configurable.

### Announcements

Occasionally Kangentic shows a product announcement (for example, a call for mobile-app beta
testers) as a slim banner above the board. **Learn more** opens the full message with links and
a QR code; the **X** dismisses that announcement permanently on this machine. Announcements are
fetched from a static file on the public GitHub repo - no account, no tracking, and if the feed
is unreachable (offline or self-hosted setups) the banner simply never appears. See
[Configuration - In-App Announcements](configuration.md#in-app-announcements) for the feed
mechanics.

### Mobile Devices

The Mobile Devices tab is the desktop half of the mobile companion app's pairing link - global (applies to this desktop installation, not any one project) and off by default. Enable the **Mobile Bridge** toggle, then pick a **Relay**: *Kangentic Relay* (the default, the one Kangentic operates) or *Custom Relay* (your own self-hosted address, entered in the field that appears below). Dev builds also offer a *Local* option pointing at a relay on localhost. The address actually being dialed is shown beneath the picker, carrying an **Official** badge when it is the Kangentic-operated relay, and **Test connection** probes it for reachability before you pair. The relay forwards encrypted traffic and never holds your keys. A custom address must use `wss://`, or `ws://` for localhost only, since the phone refuses to pair over an untrusted transport.

Click **Pair a Device** to display a QR code; scanning it with the Kangentic mobile app starts an end-to-end encrypted pairing handshake. Once the handshake completes, both the desktop and the phone show the same short code - compare them, then tap **Confirm** on the phone. The desktop auto-enrolls the device as soon as it hears back; there is no second confirmation to make on the desktop. This catches a photographed or relayed QR, since an attacker cannot make both sides show the same code. To back out, cancel on the phone (or close the desktop's pairing panel) before confirming.

The phone is treated as an extension of your own desktop, not a separate integration to configure: pairing grants it full access to the same ten capabilities the protocol defines (there is no shell, file, or arbitrary-command access in the protocol at all). Paired devices appear in a list below, identified by a key fingerprint you can compare against the phone's own Settings > Devices screen, along with their connection status and paired date. Rename a device from that list, or revoke it - revoking removes it from the desktop's signed roster immediately, and a revoked phone must be paired again from scratch to reconnect. See [Mobile Bridge](mobile-bridge.md) for the underlying protocol, pairing ceremony, and security design.

The **Kangentic Mobile** section at the bottom of the tab opens the [Kangentic Mobile docs](https://www.kangentic.com/mobile/): installing the app, push notifications, and how the encrypted link works. It is always present, in both directions - it stays usable with the bridge toggle off, since someone who has not installed the app yet is exactly the person who has not enabled the bridge, and it does not disappear once phones are paired, since that link is a docs landing page rather than an install page and you may well be adding a second device. Install instructions live on the website so they stay current between desktop releases; while a store rollout is in progress, the in-app Announcements dialog carries the signup steps for the current phase.

### Privacy

The Privacy tab shows what anonymous analytics Kangentic collects and how to opt out. Analytics are powered by Aptabase (no cookies, no persistent identifiers, GDPR-compliant). Set `KANGENTIC_TELEMETRY=0` as an environment variable to disable analytics entirely. It also lists `support@kangentic.com` for questions about what is collected. This tab is informational only - there are no configurable settings.

### Developer

The Developer tab exposes power-user diagnostics for the activity-detection subsystem. Settings here are global (apply to every project) and are intended for debugging only.

| Setting | Description |
|---------|-------------|
| Activity Engine Debug Overlay | Show a floating overlay with live activity-engine state for every running session: current `ActivityReason`, raw counters (pending tools, subagent depth, background shells), and a ring buffer of recent state transitions. Toggle from anywhere with Ctrl+Shift+D. Polls every 2 seconds while open; lazy-disables the IPC when closed. |

## CLI

Open a project directly from the terminal:

```bash
npx kangentic /path/to   # Open a specific project path
npx kangentic            # No path: reopen your last project
```

If the project doesn't exist yet, it's created automatically. Without a path, Kangentic reopens the project you last had active (or shows the welcome screen on a first run).

## Session Persistence

Sessions survive app restarts. When you close Kangentic:

1. All running sessions are marked as `suspended` in the database
2. PTY processes are force-killed (there is no graceful shutdown window)
3. On next launch, sessions are automatically resumed via `--resume` using the saved session ID

Because Claude Code supports `--resume`, conversation context is fully preserved despite the hard kill. If the app crashes, orphaned sessions are detected and recovered on the next launch.

### User-Paused Sessions

Sessions paused manually by the user (via the pause button in the task detail dialog or kebab menu) are remembered across restarts. On relaunch, user-paused sessions remain paused instead of auto-resuming. This respects user intent. If you paused an agent, it will not start back up on its own. Only system-suspended sessions (those suspended by shutdown or column moves) auto-resume.

## Conversation Memory

Kangentic indexes every session's conversation into a per-project, on-device search index, so past agent conversations are recallable without scrolling through old terminals. Indexing is on by default; turn it off or tune it in Settings > Memory.

### What Gets Indexed

The structured transcript of each session: user turns, assistant replies, thinking blocks, and tool-call summaries. Raw terminal scrollback is never indexed (for TUI agents it is mostly cursor and redraw noise). A session is indexed when it finishes or suspends, an in-progress conversation is re-indexed at each turn boundary, and older history is backfilled in small sweeps when a project opens.

### Keyword and Semantic Search

Keyword (full-text) search is always available while indexing is on. Enabling **Semantic search** in Settings > Memory downloads a small embedding model once (three quality tiers from the `bge` family) and then runs fully offline; searches become hybrid, fusing keyword and meaning-based rankings. Embedding runs in an isolated background process, duty-cycle throttled so backfills never peg the CPU, with a **Hardware acceleration** setting (Auto / GPU / CPU) and a **Rebuild index** button for a stale index. Every failure path (no model yet, slow embedding) degrades transparently to keyword-only.

### Where It Surfaces

- The [Search Palette](#search-palette) shows a **Conversations** group; a hit opens the viewer at the matched turn.
- The **View conversation** pill in the [Task Detail Dialog](#task-detail-dialog) opens the task's newest session directly, no search needed.
- Agents can recall past conversations themselves via the `kangentic_search` MCP tool (`mode: "hybrid"` for semantic) and drill into a cited turn with `kangentic_get_transcript` - see [mcp-server.md](mcp-server.md).

### The Conversation Viewer

A read-only window on the same layer as task detail windows: drag, resize, snap, tile, and maximize it like any other window. Open viewers persist in the workspace across project switches and app restarts. Each turn renders cleanly with per-message copy buttons, and the header keeps two one-tap actions, **Open task** (jump to the owning task's detail window) and **Copy conversation as Markdown**, both also available from the window's kebab menu.

The viewer opens positioned at the latest message, or centered on the turn matching where you had scrolled in the live terminal, so it lands where you were looking. A search bar at the top does debounced substring search across the transcript with snippet results and prev/next navigation; press **Mod+F** (Ctrl+F on Windows/Linux, Cmd+F on macOS) to focus it, and click a result to jump straight to that turn. Very long transcripts (tens of thousands of messages) stay smooth via row virtualization and a custom overlay scrollbar with a "jump to latest" pill.

## Command Terminal

The Command Terminal provides quick, ephemeral access to Claude Code without creating a task on the board. Useful for one-off actions like creating releases, running queries, or any ad-hoc interaction.

**Opening:** Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS), or click the terminal icon in the title bar (next to the settings gear). The same button **toggles** the layer closed again, so there is always a one-click way to hide it, even when a window is maximized. The terminal icon's border reflects activity across your open terminals: it marches in green while an agent is working, holds a steady warm amber when one needs your input, and stays plain when idle.

**Behavior:**
- Spawns Claude Code at the project root on the configured default base branch
- It opens as a **window** over a slight backdrop blur: drag it by the header, resize it from any edge or corner, maximize / restore it (double-click the header or use the maximize button), and snap it to a screen half or full screen (Windows-style). The layout (size, position, maximized state) **persists globally** across all projects and app restarts.
- **Run more than one at once.** While the layer is open, a second terminal icon (with a `+` in its center) appears in the title bar just to the left of the main terminal icon - click it to open another terminal (up to four); it disables once you hit the cap. New terminals split into the current window's footprint (side by side, keeping the size you set) so you can keep two ad-hoc tasks cooking and glance between them; drag the seam to rebalance, or maximize one to focus it.
- **Each window is numbered.** A terminal titles itself `Command Terminal 1`, `Command Terminal 2`, and so on, from its durable window slot - so two side-by-side terminals are tellable apart, and the number stays put when a sibling opens or closes. The same title identifies that terminal on its Agent Monitor row. Once you send a first prompt, the title becomes a short auto-derived name for what you asked instead.
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

## Usage Stats Dashboard

Open the usage dashboard from the chart icon in the title bar or with `Mod+Shift+U`. It replaces the old status-bar token/cost strip with a full-page view of agent usage:

- **Scope** - the current project, or an app-wide rollup across every registered project (with a per-project comparison table).
- **Metric** - toggle between cost and tokens.
- **Range** - Live (trailing 2 hours), Today, This Week, This Month, All Time, or a custom month range. Click a day in a chart to drill into that single day.
- **Breakdowns** - by model, by agent, and by reasoning effort, alongside KPI tiles (cost, tokens, sessions, tool calls, line churn, burn rate) with "vs previous period" deltas.

Totals are read from the durable usage ledgers, so they survive task and session deletion. The selected range and scope persist across app restarts (one global value shared across all projects).

## Agent Monitor

Open the monitor from the activity icon in the title bar or with `Mod+Shift+M`. It answers "what are all my agents doing right now?" in one place, across **every** registered project rather than just the one whose board is open. The title-bar icon itself is the ambient signal: green while any agent anywhere is working, amber the moment one starts waiting on you.

Each session shows its owning project and column, the task title and ticket number, live activity state, agent, model, effort and permission mode, how long it has been running, and what the agent is doing right now. Four tiles across the top count what needs you, what is active, what is paused, and how many projects have something live.

Every card also carries a **live output peek**: the last few rendered lines of that session's terminal, in a shaded panel where a task description would otherwise sit. It updates in place as the agent works (at most twice a second, and only when the visible text actually changes), so you can see what a session is saying without opening it. The panel is a fixed height, so a card never resizes as messages land.

Command Terminals (`Mod+Shift+P`) appear here too. They are the one thing the board cannot show you - they belong to no task, so before now a Command Terminal left running in another project was invisible. Each is titled `Command Terminal N` (matching the number on its own window), draws a terminal-shaped activity glyph rather than the agent one, and names the **branch** it is working on where a task card names its column.

You choose how it looks, and the choice is remembered (including across a restart):

- **Layout** - cards (which reflow into 2 or 3 columns as the window widens), a dense sortable table, or a one-line-per-session list.
- **Grouping** - by status (Idle / Active / Paused / Recently finished) or by project. Rows are always sectioned, which is what keeps anything waiting on you at the top without you having to sort for it.
- **Sort** - Oldest or Newest, applied within each section. The table layout sorts by its own column headers instead.
- **Filters** - a text filter across title, project, column, agent, model, ticket number and labels, plus a "Live only" toggle that drops paused and recently finished sessions.

Clicking a row opens that task's full detail - terminal included - **in the monitor**, so several agents across several projects can be watched and driven from one surface without leaving for another project's board. Right-click a row and choose **Open on board** for the old behavior. A task's detail is only ever open in one place: opening it somewhere else moves it rather than making a second copy, and its tab leaves the bottom panel while it is open.

The pop-out button detaches the monitor into its own window, which is the intended way to keep it on a second monitor. The detached window lays out by its own width, so it stays readable narrow while the in-app view fills a wide screen.

Whatever you have open in the monitor follows it. Detaching carries your open details into the pop-out, closing the pop-out hands them back to the in-app monitor, and the arrangement survives a restart - the same way board and Command Terminal layouts do. Nothing stays running in the background: closing the monitor unmounts its terminals (the agents keep working, and their tabs return to the bottom panel), and reopening it restores what you had.

Two things are deliberately left out of that restore, because the monitor is for watching agents that are still working: a task you have since opened on the board stays where it is rather than being pulled back in, and a detail whose agent has finished is not reopened. You can still click a finished session's row to look at it; it just will not come back on its own.

## Keyboard Shortcuts

Every shortcut is declared in a central registry and is **rebindable** under Settings > Hotkeys, where it can be bound to a key chord or a mouse button (middle or side buttons). Hotkeys also flags conflicts and combos already claimed by the OS or another app. `Mod` below is Cmd on macOS and Ctrl on every other platform.

General:

- **Mod+Shift+S** - Toggle the settings panel
- **Mod+Shift+U** - Toggle the Usage Stats dashboard
- **Mod+Shift+M** - Toggle the Agent Monitor (every running agent, across all projects)
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
- **Mod+Shift+K** - Toggle the description panel inside the task detail dialog
- **Middle-click the window header** - Close a modeless task-detail window (default `Mouse:Middle`; routes through the same unsaved-edits guard as the close button)

Windows (modeless task-detail windows):

- **Mod+Shift+Left** / **Mod+Shift+Right** - Snap the focused window to the left / right half of the board area
- **Mod+Shift+Up** / **Mod+Shift+Down** - Snap the focused window to the top / bottom half

Terminal:

- **Mod+C** / **Mod+Shift+C** - Copy selected text, stripping quote-bar decoration from any decorated lines (with no selection, Ctrl+C cancels the running command)
- **Mod+V** / **Mod+Shift+V** - Paste text or an image into the terminal
- Standard OS shortcuts for the rest of terminal editing

## Tips

- **Plan mode workflow:** Use a Planning column with `permission_mode='plan'` and `plan_exit_target_id` pointing to your Executing column. The agent plans first, then auto-moves to execution.
- **Auto commands:** Set `auto_command` on a Code Review column to automatically ask the agent to review its own code when tasks arrive.
- **Concurrent agents:** Increase `maxConcurrentSessions` to run more agents in parallel. Each needs its own worktree to avoid conflicts.
- **Resume from Done:** Unarchive a completed task and drag it back to an active column. Kangentic recreates the worktree from the preserved branch on the fly, and the agent picks up exactly where it left off.
