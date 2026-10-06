# User Guide

This guide walks through all features of Kangentic from a user's perspective.

## First Launch

When you first open Kangentic with no existing projects, a welcome screen greets you with an **Open a Project** button. Click it to select a project folder and get started.

The welcome screen also detects Git and your installed agent CLIs, showing each one's version, or an install link when it is missing and a login command when it is found but unauthenticated. Two links in the footer open in your browser: **Read the setup guide** and **Pair a phone**, the latter covering the mobile companion app (see [Mobile Bridge](mobile-bridge.md)).

On subsequent launches, Kangentic automatically re-opens the last activated project so you pick up right where you left off. If you launch with the `--cwd` flag, that path takes priority.

When a project is opened, Kangentic initializes a `.kangentic/` directory inside the project folder (auto-added to `.gitignore`) and creates a board with default columns.

## Default Columns

New projects start with seven columns:

| Column | Role | Behavior |
|--------|------|----------|
| **To Do** | todo | Holding area. No agent runs here. Moving a task here kills its session. |
| **Planning** | (plan mode) | Spawns the agent in plan mode. Agent creates a plan, then task auto-moves to Executing. |
| **Executing** | (auto) | Spawns the agent in default permission mode. Agent works on the task. |
| **Code Review** | (auto) | Agent keeps running. Add a message telling it how to review the work (e.g. review the diff and fix what it finds). |
| **Testing** | (auto) | Agent keeps running. Add a message telling it how to test the work (e.g. open a PR and drive its checks green). |
| **Merge** | (auto) | Agent keeps running. Add a message telling it how to ship the work (e.g. merge a verified PR and pull back). |
| **Done** | done | Suspends the session (preserving context) and archives the task. |

None of the default columns carries automations or a description: the defaults are names, icons,
and colors only, since what a column should do when a task arrives depends on your repo and agent.
Both are yours to fill in from the Column Manager.
Message examples in this guide, like `/code-review`, come from Kangentic's own development
board, not from the defaults. A column's message to its agent is one kind of automation, a
**Send message to agent** row; see [Automations](#automations).

## Task Lifecycle

### Create a Task

Click the **+** button on any column header, or **New Task** in the backlog toolbar. Enter a title and optional description. You can set a priority level, add labels, and attach files (images, documents, or any file type) by pasting from the clipboard or dragging files onto the dialog. Attachments are included in the agent's prompt.

Pasted screenshots are capped at a 2000px long edge, which bounds a multi-monitor grab without costing the detail an agent needs to read small text. Oversized pastes are re-encoded as WebP, stepping quality down until each image lands under a ~1.5MB target, so a large grab is not rejected by the API. Small pastes (under 500KB), GIFs, SVGs, and PNGs already inside the cap are attached as-is.

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
Profiles are created and edited in the **Column Manager**, where selecting one
switches the column editors to that profile's values; column structure (which columns exist, their
names and order) is shared across all profiles and is locked while a profile is selected. So are
automations: a column's list is the same under every profile, and the list is read-only while one
is selected. Profiles are saved to `kangentic.json`, so they reach teammates through git.

The pencil button beside the Profile dropdown opens the Column Manager, which is the only place profiles
are authored - so creating your first one and retuning an existing one are the same trip. Until a
board has any, the dropdown shows **Default**, disabled: the concept stays visible without adding a
second creation path to keep in sync.

Choosing **Agent Override** reveals the per-task pins:

| Field | Description |
|-------|-------------|
| **Agent** | Pick a specific agent CLI (Claude, Codex, etc.) for this task. Defaults to the destination column's agent override, then the project default. Locked (shown disabled, on the one agent it has) when only one agent is detected on the machine. The pencil beside it opens Settings > Agent, where all four of these fields get their project defaults. |
| **Model** | Adapter-specific model identifier (e.g. `opus`, `sonnet`, `claude-opus-4-8`). When the agent offers floating aliases, the dropdown leads with a **Latest** group (Opus, Fable, Sonnet, Haiku for Claude), each with the version it runs today beside it. Pick one and the task follows each new release. The versions those aliases run, older generations, and dated pins sit in one collapsed **Specific versions** section, grouped by model with the newest first and a dated pin right after its generation. A current version with no alias stays in the main list. Without aliases, only older generations and dated pins are collapsed, under **Older versions**. For Claude, the list comes from scanning past session transcripts and from the CLI's own `/model` picker, read by a hidden background probe, so newly shipped models surface without first being used in a session. |
| **Effort** | Adapter-specific reasoning tier (Claude: `low`, `medium`, `high`, `xhigh`, `max`). Only shown when the agent reports effort levels. |
| **Permission** | Permission mode for this task. A column that forces Plan mode still wins while the task is in that column - that is a safety guarantee, not an ordinary default. |

A per-task pin **stays with the task across column moves** - column settings are ignored once a task
carries its own override. Changing the Agent resets Model + Effort because the previous picks were
valid for the previous agent's capability matrix.

You can also choose Agent Override and pick nothing at all. Each field then shows, in the muted
placeholder weight, the value it resolves to today, and keeps resolving live while the task sits in
To Do. The moment it leaves To Do for a spawn column - or spawns for the first time ever, whichever
comes first - all four lock to the values the dialog was showing. That is the point of the branch:
"whatever this task would run right now, pin exactly that." Because it stores no pins, the choice
itself is what is saved, so the branch is still selected when you reopen the task. Moving a pinned
task back to To Do does not erase the pins it already carries, but it does re-arm the lock: clear a
field there and the next move out pins it again to whatever the dialog was showing at that point.

Agents can read and edit Board Profiles too, including across projects, which is the practical way
to keep them in sync as models change ("update every profile's Opus 4.8 to Opus 5", "copy this
board's Heavy profile into project X"). See
[MCP Server > Board Profiles](mcp-server.md#board-profiles).

Before the first spawn, the task detail dialog also shows a slim **pre-spawn context bar** with the same Model and Effort pills. Set them there to avoid the spawn -> cancel -> restart loop: the picker writes the override to the DB, and `prepare-spawn` picks it up on the next agent launch.

The Model popover on both bars leads with the same **Latest** group when the agent offers aliases, then a collapsed **Specific versions** section.

When an agent is already running, the same Model / Effort pills appear in the live context bar below the terminal. Picking a value there delivers the change to the running session via the adapter's slash-command injection sequence when it supports live model changes (Claude's `/model`), or suspends and respawns when it does not.

### Spawn an Agent

Drag a task from To Do to any active column (Planning, Executing, etc.). Kangentic will:

1. Create a git worktree for the task (if worktrees are enabled). Otherwise the agent runs in the project folder, and the task detail says so - see [Worktrees](#worktrees)
2. Spawn an agent CLI session with the task title and description as the prompt
3. The task card shows a spinner while the agent is thinking

A move out of To Do is the only kind of move that sends the task itself to the agent: the title,
description, and any attachment paths become the opening prompt (the seeded template
`{{task_xml}}{{attachments}}`). A move between two active columns resumes the same
conversation - the description is not sent again, and the destination column's **Send message to
agent** automation, if it has one, is the only new instruction the agent receives.
Moving a task back to To Do kills its session, so moving it out again starts a fresh
conversation and sends the task once more.

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
  - A pull request pill once the task has a linked PR, showing its number and merge readiness (`ready`, `blocked`, `conflicting`, `queued`, `running`, or `unknown`). The same pill appears in the task detail header. See [PR Integration](pr-integration.md#merge-readiness) for what each value promises and which settings change it
- **Shimmer overlay** - when a session is starting or resuming (e.g., after a column move that runs the destination's automations), a shimmer loading overlay appears over the terminal. It shows a context-aware label such as the running automation's name, "Resuming agent...", or "Starting agent...". Terminal output is suppressed behind the overlay until the session is ready.

### Move Between Active Columns

Dragging between active columns (e.g., Executing to Code Review) keeps the session alive. If the target column has a **Send message to agent** automation (e.g., `/code-review`), it is typed straight into the running agent as keystrokes - no suspend, no restart. A suspend and respawn happens only when the move needs one for its own reasons (a permission-mode change, or a model/effort change the agent cannot swap live); in that case the message rides along as the resume prompt instead. The source column's exit automations run first, while its session is still attached, and the destination's remaining enter automations run after the move lands.

The agent keeps its conversation across these moves; the message is the only new input it sees. A new project has no messages configured, so by default these moves simply carry the session along.

Each column chooses WHEN its message arrives via **Message timing**: `immediate` sends it on arrival (the agent queues it if mid-turn), while `deferred` holds it until the current turn genuinely finishes.

**From the keyboard.** Tab to a card, press Space to pick it up, move it with the arrow keys, and press Space again to drop it; Escape puts it back. The pickup only arms from a Tab-placed focus: a card you clicked or dragged with the mouse stays put on Space and Enter, and a picked-up card is released the moment you click anywhere or focus lands in a terminal. The same keys reorder columns (from the grip in the column header), backlog rows, Column Manager rows, priorities, and shortcuts.

### Complete a Task

Drag to Done. The worktree directory is removed to reclaim disk, the session is suspended (not destroyed), the task is archived, and the conversation ID is preserved. The branch is deleted too when **git.autoCleanup** is on (the default) and kept when it is off. A clean move happens silently; a confirmation dialog appears only when the move would destroy real work - uncommitted files, or commits that exist only on the local branch about to be deleted - and it spells out exactly what is at risk (worktree deleted, branch kept or deleted, session history kept). If you later unarchive the task and drag it to an active column, Kangentic recreates the worktree and the agent resumes with full conversation context.

Anything the task's agent left running in its folder, such as a dev server it started in the background, is stopped before the worktree is removed. When that happens a toast gives the counts, and its **Review** link lists each process with a **Stop** button for any that kept running: a window the agent opened, a tmux server, or a tool other work also uses (another task, or a command running in one of your terminals). The same happens when a task returns to To Do or is deleted. Turn it off with [Stop Leftover Processes](#behavior-settings); the toast then lists what kept running and stops nothing.

Clicking a completed task opens a session summary showing: duration, model, cost, token usage, tool call count, files changed, and lines added/removed. A collapsible "By tool" section breaks every run's calls down per tool name, so its rows add up to the tool call count: Calls, then Time and Avg when durations were measured, Tokens when the agent can estimate them from its transcript, and a Failed column when any tool was interrupted. Time is each tool's own run time. Calls that waited for your answer or approval are left out of Time and Avg, and the Time header's tooltip says how many. Tokens estimates how much of the conversation each tool's output took up; it is not billed usage, and today only Claude provides it. Every column except Failed sorts on click, and the default is Calls, most first. The tool-call count in a running task's context bar opens the same table for that session. It counts every run of the session, so it does not drop to 0 when the session resumes after an app restart or a pause. A Code Review column that runs in its own session keeps its own count. Tokens for a run that ended when the app quit are filled in from the agent's transcript after the session resumes. Cost / input / output columns appear only for adapters that emit per-tool telemetry. The Done column also supports searching completed tasks by title and sorting by date, cost, tokens, or duration.

### Task Card Context Menu

Right-click any task card on the board to open a context menu with:
- **Copy Task ID** - copies the display ID (e.g., `#42`) to clipboard
- **Edit** - opens the task detail dialog in edit mode
- **Move to** - submenu listing all other columns as move targets
- **Backlog** - send the task back to the backlog (cleans up session and worktree)
- **Archive** - move the task to Done and archive it
- **Delete** - permanently delete the task, session, and worktree

### Return to To Do

Drag to To Do to reset the task to "not started": the session is killed and its history wiped, what its agent left running is stopped (see [Complete a Task](#complete-a-task)), and the worktree is removed (the branch too, when **git.autoCleanup** is on). When the reset would destroy pending changes, a confirmation dialog warns that the worktree and session history will be lost before anything happens. If you drag back to an active column, a fresh session starts in a fresh worktree.

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

Press **Ctrl+V** (Cmd+V on macOS) in the terminal to paste. Text on the clipboard is pasted directly. If the clipboard contains an image (and no text), the image is saved to a temporary PNG, capped at a 2000px long edge so a 4K or 5K grab does not land on disk at full size. The cap costs no detail - it sits at the point above which the extra pixels are discarded before an agent ever sees them. Saved pastes are pruned by age and count, so the temp directory no longer grows for the life of the install. The saved file's path is then pasted into the terminal the way a native terminal delivers a dropped file: as a bracketed paste when the program in the terminal asked for one, as plain text otherwise. With Claude Code in the foreground, the pasted path becomes an `[Image #1]` chip and the image lands in your next message directly, with no `Read` tool call and no extra model round trip; Claude still knows the file's path on disk. Kangentic's own capture is more reliable than the CLI's clipboard reader, which can silently miss a Windows Snipping Tool image. Gemini CLI and OpenCode attach the pasted capture the same way. Agents that do not attach from a pasted path receive the quoted path as text. At a plain shell prompt the quoted path is inserted as text and nothing runs. Paths are automatically quoted for the active shell (PowerShell, bash, cmd, WSL, etc.).

### File Drop to Terminal

Drag files from your file manager onto the terminal to insert their file paths into the active session. Every dropped path is delivered as a paste, the same way a native terminal delivers a drop. With Claude Code in the foreground, a PNG, JPEG, GIF, or WebP file becomes an `[Image #N]` chip, one per file, and the images land in your next message directly. Gemini CLI and OpenCode attach PNG, JPEG, and GIF drops the same way. An image in a format the agent does not attach from a path (a BMP, an ICO) is converted to a PNG copy first, saved next to the clipboard captures, and that copy is what gets pasted, so it attaches too. An SVG, or a file whose bytes are not an image, gets an explicit "Read this image: ..." instruction under Claude Code (Claude reads SVG markup with its Read tool) and the bare path under other agents. Any other file is inserted as its bare file path. Paths containing spaces are automatically quoted. Dropping several files inserts them separated by spaces. A visual overlay appears when files are dragged over the terminal area.

Two shell-specific limits apply to a dropped or pasted image on Windows. Under Git Bash the path is converted to `/c/...`, which Claude Code (a Windows process) cannot open, so the image arrives as text; WSL's `/mnt/c/...` form reads fine. Under a Unix-style shell a file name containing an apostrophe is quoted with `'\''`, which the path scan cannot undo, so that file also arrives as text.

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
- Pause or resume the agent session using the circular play/pause button in the header. Pausing also closes the detail window, so you do not have to dismiss it separately; the session stays paused and resumable from the board
- Run shortcuts from the header bar (configurable pills that launch external tools)
- Open the **Commands & Skills** popover to browse and run Claude Code commands (`.claude/commands/`) and skills (`.claude/skills/`) from the project directory. Search by name, navigate with arrow keys, press Enter to invoke.
- Open the task's transcript in the read-only [conversation viewer](#the-conversation-viewer) via the **View conversation** pill (speech-bubble icon). Muted until the task has session history, live or historical.
- See the **pull request pill** in the header once a PR is linked, carrying its number and merge readiness (`ready`, `blocked`, `conflicting`, `queued`, `running`, or `unknown`). `ready` means clicking Merge right now would succeed, which is a stronger claim than "no conflicts". The same pill appears on the task card. See [PR Integration](pr-integration.md#merge-readiness) for what each value promises and which Git settings change it.
- Access the kebab menu (three-dot icon) for additional actions:
  - **Edit** - switch to edit mode for title and description
  - **Open worktree** / **Open project folder** - open the task's directory in your file manager; the label names which one it is
  - **View conversation** - same as the header pill
  - **View PR** - open the associated pull request. PR URLs are populated automatically when an agent runs `gh pr create` or `gh pr view` (GitHub), explicitly via the `kangentic_create_task` / `kangentic_update_task` MCP tools (any platform), or manually through the PR URL field in edit mode. Those are the only ways to link a PR: writing a PR URL into the task description does not link it, so you can cite another task's PR as background without it being mistaken for this task's own. Also shown as a pill in the header bar and a clickable badge on the task card.
  - **Commands & Skills** - submenu of available Claude Code commands and skills (same as the header popover)
  - **Pause / Resume session** - manually suspend or resume the agent (pausing closes the detail window, same as the header button)
  - **Move to** - submenu listing all other columns as move targets
  - **Archive** - move the task to Done and archive it
  - **Delete** - permanently delete the task, session, and worktree

**Closing by clicking outside.** Task-detail windows are modeless, so clicking empty space outside one closes it. The rule is a denylist, not an allowlist: a control, a task card, or a running terminal still acts on your first click, so clicking outside never costs you a click you meant for something else, and overlays mounted outside the window shell (the settings panel, palettes, dialogs) never dismiss it either. Set the policy at **Settings > Behavior > Windows > Close on Outside Click**: `Off`, `Single Window` (only when one is open), `Focused Window` (the default), or `All Windows`. Closing a window never kills its session; the agent keeps running and reattaches when you reopen the task.

### Changes Panel

The Changes tab in the task detail dialog is a read-only review surface split horizontally: a left rail (the changed-file list, with a collapsible **History** section pinned at its bottom) and the diff pane on the right, divided by a resizable divider. The rail sizes itself proportionally, so expanding the panel widens filenames instead of leaving a narrow rail stranded in a wide window; drag the divider to override that, and double-click it to go back to the default.

The rail's **History** section is collapsed by default - its header row stays visible with a live commit count, so history is one click away without spending vertical space on it. Expanding it reveals a **pinned "Uncommitted changes" row** above the branch's commit graph (a visual DAG: commit nodes down a vertical axis, lane columns for parallel branches, and edges to each commit's parents). Each commit row shows the short SHA, subject, author, and relative time; the branch tip is marked `HEAD`, and the base branch and a linked pull request's head commit are marked with tone dots (hover for the full label). The graph reads git directly (no session required), refreshes live as you commit or the branch's refs change, and is capped at the most recent 200 commits with a note when older commits are trimmed. A history with several parallel lanes is cramped at rail width; pop the whole panel out into its own window to read it comfortably.

**Uncommitted changes** is selected by default and shows the branch-wide diff: the rail lists changed files with insertion/deletion counts in an aligned column and a checkbox to mark each one **viewed** (a viewed row dims, and the header keeps a running viewed/total count with a progress fill under it), a scope selector (working / staged / branch) picks which changes to diff, and a base-branch label shows whether the branch diverged from the default base or a custom one. Sort the list by name, status, size, or extension from the sort menu, and switch between the tree and a flat list; sorting a flat list by status groups it under status headings. Click a file to view a side-by-side or inline diff on the right. Toggle between split and inline view modes using the button in the toolbar. When there is nothing to review, the diff pane says so and names the scope it searched, so an empty **Working** view reads as "No uncommitted changes" rather than looking broken next to a History section full of commits.

**Selecting a commit** in the History section scopes the detail pane to that commit's own diff (`<oid>^..<oid>`) instead - a compact header at the top of the rail identifies the commit, with a back button that returns to Uncommitted changes.

Right-click a file in the tree for **View history**, a popover listing the commits that touched that file (`git log --follow`); selecting one jumps the detail pane to that commit.

The diff toolbar's **View options** menu collects the rendering choices as named, checkable items rather than icons you have to hover to identify: ignore whitespace, collapse unchanged regions, wrap long lines, and render inline when the pane is narrow. All four are app-wide preferences shared with **Settings > Changes**, and the menu's **Open settings** item jumps straight there. The same menu carries the **blame** toggle (off by default, per file, never remembered), which annotates each line of the modified editor with its short hash and author via a left-gutter column, with the full hash/author/date on hover. Blame reflects the file's current working-tree content, so it is unavailable while browsing a historical commit and in the **Staged** scope, and for binary or deleted files, which have no current content to annotate. The menu stays reachable even with no file selected, so you can set up how diffs render before there is anything to review.

**Double-click a file** (or pick **Open in new window** from its right-click menu) to detach that one file's diff into its own OS window - read it full-screen or on a second monitor, and open several files side by side to compare them (one window per file; double-clicking the same file again focuses its existing window). The window opens maximized by default; un-maximize for a floating window, and once you resize, move, or maximize one, that becomes how every later diff window opens. Up to 8 file windows can be open at once; opening a 9th shows a toast asking you to close one first. The window is read-only, follows your diff view options (split/inline, whitespace, collapse-unchanged, wrap long lines, inline-when-narrow), live-updates as the file changes, shows an empty state if the change is reverted while it is open, and closes with its own window controls or **Escape**. Available in every file list (Working / Staged / Branch and a commit's files) except the Command Terminal's Changes view, which has no task to scope the window to.

The panel persists its expanded/collapsed state, selected file, selected commit, the diff scope, which files you have marked viewed, whether the rail's History section is expanded, and the divider positions across dialog reopens. Those are per-task; the View options above are app-wide.

Each file also remembers where you had scrolled it. Open a file for the first time and it opens centred on its first change; leave it and come back and it returns to where you left off. That memory is per task and per diff scope, and it is held in memory rather than in the database, so it lasts as long as the app is running and a restart puts every file back on its first change.

The whole panel can also detach into its own OS window - click the pop-out icon in its header - not just a single file's diff. Unlike the properties above, this is not preserved through a close: while the window is open the header pill still reads **Hide changes**, but closing the window leaves the panel closed instead of restoring it inline; click **Show changes** again to reopen it.

The Changes panel is available for all tasks, whether or not worktrees are enabled. It uses `git merge-base` to show only branch-specific changes, excluding upstream commits. When the commit git recorded as the branch's starting point is newer, the panel diffs from that instead. That keeps a branch cut before the base branch's history was rewritten from showing the rewritten history as its own changes. The same fork point measures the lines and files a task changed.

When the dialog is open, it claims the terminal session and the bottom panel drops that task's tab. Any other running session keeps its tab and its live terminal; the panel only collapses once nothing is left in it. Closing the dialog returns the tab, still selected.

### Browser Pane

Tasks can host an embedded browser inside the task detail dialog. Use it to preview your dev server, capture screenshots with annotations, and submit framed prompts back to the agent without leaving Kangentic. Each task gets its own persistent webview partition (cookie jar), so two tasks logged into dev servers on the same localhost host don't clobber each other's sessions. Non-localhost logins are shared: signing into an identity provider (Google, GitHub, your SSO) in one task's pane carries to the project's other tasks through a per-project identity jar, so you sign in once per project rather than once per task. Holding two different accounts at the same provider across tasks at the same time is unsupported; the Clear Browser Data action wipes every jar, identity included.

Agents can drive the pane themselves through the `kangentic_browser_*` MCP tools (navigate, screenshot, DOM queries, click, type, eval), governed by the [Agent Browser](#agent-browser) settings tab. An agent can also open and close its own task's pane rather than waiting for you to do it, which means it may open that task's detail window on its own if none is open.

**Hiding the pane is not the same as closing it.** The Browser pill only hides: the page stays loaded so you get it back exactly as you left it, which also means the agent driving it is never interrupted by you reclaiming the space. Closing the task's window while its agent is still running keeps it the same way. A loaded page costs real memory (roughly 120 MB, more for a heavy app), so when you are genuinely finished with a task's browser, use **Close browser** in the pane's toolbar, or the same item in the task menu when the pane is hidden. That ends the page and frees the memory. The task's URL is remembered either way, so showing the pane again reopens the same address on a fresh page. While a task's browser is loaded, its Browser pill shows a green dot and a green globe appears on the task's card.

| Action | Shortcut |
|--------|----------|
| Zoom in | **Ctrl+=** / **Ctrl++** (or **Ctrl+wheel up** inside the page) |
| Zoom out | **Ctrl+-** (or **Ctrl+wheel down** inside the page) |
| Reset zoom to 100% | **Ctrl+0** |
| Reload page | **F5** or **Ctrl+R** (outside the embedded page) |
| Send the capture to the agent | **Enter** (with the note field focused) |

Zoom snaps to a Chrome-compatible ladder (25%, 33%, 50%, 67%, 75%, 80%, 90%, 100%, 110%, 125%, 150%, ... up to 500%). Ctrl+wheel zoom inside the webview uses a smoother multiplicative step but stays clamped to the same range. The toolbar shows a zoom pill with the current factor, plus dedicated zoom-out / reset / zoom-in buttons.

Keyboard shortcuts are scoped to the browser pane: they fire when the mouse is over the pane or focus is inside it, so Ctrl+0 from elsewhere in the app does not interfere with anything else. Send is the exception. Its handler is bound on the note field itself rather than on the pane-scoped listener, so Enter sends only while that field has focus.

## Backlog

The Backlog is a staging area for tasks before they reach the board. Switch between **Board** and **Backlog** views using the tabs at the top.

Both views share one toolbar row, and it adapts to the space it has. As the window narrows or the
sidebar widens, its controls drop their text and become icons in the same positions, keeping the
label as a tooltip. Nothing is hidden and nothing moves, so every control named below is still
where this guide says it is, just narrower. At the smallest window size the whole row is icons.

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

Drag rows by the grip handle on the left to manually reorder items, or Tab to the grip and use Space and the arrow keys. Drag-to-reorder is available when no column sort is active. When you sort by a column header (priority, title, created date), manual reorder is disabled until the sort is cleared.

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

The dialog opens from a per-project cache of the source's items, so the list paints at once, and a
"Syncing..." line at the bottom shows while it fetches only the items changed since the last sync in
the background. The cache survives an app restart and a project switch. The **Open / Closed / All**
toggle filters that cache on the spot, without another fetch. If the sync fails, the error banner
carries a **Retry**; once every item is imported, **Refresh to check for new items** on the empty
state refetches the whole source rather than only the changes.
See [board-integration.md](board-integration.md) for the adapter contract behind the incremental
fetch.

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
- Past agent conversations, by the words in them - see [Conversation Memory](#conversation-memory)

Quick Find matches words only, and it is instant: it starts no embedding model. Its last row, **Ask the Knowledge Graph: "what you typed"**, hands the query to the [Knowledge Graph](#knowledge-graph), which answers by meaning. A typed question usually has no keyword matches, and then that row is selected, so Enter asks it.

Type `#<number>` (e.g. `#42`) to search by **ticket number**: the palette matches tasks whose display ID (`#N`) prefix-matches the number (`#4` matches #4, #40, #41, ...) and shows only those, skipping the other result kinds. The board search box (Ctrl+F on the board) accepts the same `#<number>` syntax to filter the board by ticket number.

Default scope is the current project; toggle to **All projects** to widen the search across every registered project. Selecting a hit jumps to the right place: tasks open the detail dialog, session events scroll the Activity Log to the matched event with a brief highlight, backlog hits switch to the backlog view and open the item's edit dialog, project hits switch projects, and conversation hits open the read-only [conversation viewer](#the-conversation-viewer) scrolled to the matched turn (or route to the live terminal if that session is still running).

### Filter Popover

Click the filter icon at the top right of the board to open the filter popover. Filter by:
- **Priority** - toggle one or more priority levels (None, Low, Medium, High, Urgent)
- **Labels** - toggle one or more labels from the project's label set

Active filters show a count badge on the filter icon. Click "Clear all filters" at the bottom of the popover to reset. Priority and label filters combine with the search query - a task must match all active criteria to be visible.

## Column Management

### Add a Column

Click **Add column** at the right-hand end of the board toolbar. It becomes a plain **+** once the
toolbar runs short of room.

### Edit a Column

Click a column header to open the **Column Manager**. Settings are on the left, the column's
automations on the right.

| Setting | Description |
|---------|-------------|
| **Name** | Column display name |
| **Description** | Column header tooltip, shared via `kangentic.json`. Display only; never sent to the agent |
| **Color** | Header accent color |
| **Icon** | Lucide icon name (e.g., `square-terminal`, `code`, `flask-conical`) |
| **Agent** | Override the project's default agent for this column (e.g., use Codex for code review) |
| **Model** / **Effort** | Override the project's default model and reasoning effort for agents in this column. The Model dropdown has the same **Latest** and **Specific versions** layout as the New Task dialog. A column set to `Opus` follows each new Opus release, while one set to a specific version stays put. In **All columns**, a column pinned to an older version shows a small mark naming the newer one. |
| **Permission Mode** | Override the global permission mode for agents in this column |
| **Auto Spawn** ("Start an agent here") | Whether moving a task here spawns an agent (default: on). Turning it off also stops any **Send message to agent** automation on the column, since there is no agent to type at; those rows show as off with a disabled switch and the reason. |
| **Hand off context when the agent changes** | On a move that changes the agent, hand the previous agent's conversation to the new one instead of starting it with just the task title and description |
| **Session** | Whether the column runs the task's main session or its own isolated one. An isolated session is separate from the main one and starts clean on every entry, which suits an adversarial code review |
| **Plan Exit Target** | For plan-mode columns: where tasks move when planning completes |

The column's message to its agent is no longer a field here. It is an automation, and it lives in
the list on the right: see [Automations](#automations) below.

**Remove column**, at the left of the dialog's footer, stages the removal until you save; Cancel
keeps the column. A column that still has tasks cannot be removed.

When a column's agent override differs from the current session's agent, moving a task into that column triggers a cross-agent handoff. The outgoing agent's context (transcript, git changes, metrics) is automatically packaged and delivered to the incoming agent.

### Automations

What a column does when a task enters or leaves it. Each column owns one ordered list, split into
**On enter** and **On exit**, and each row has its own switch. A row belongs to one column; there
is no sharing and no library.

Four types:

| Type | What it does |
|------|--------------|
| **Send message to agent** | Types a message at the column's agent. Plain instructions or a slash command. |
| **Run script** | Runs a script in the task's worktree, or the project checkout when it has none. |
| **Call webhook** | Calls a URL. Retries a transport error, 408, 429 or 5xx up to three times. |
| **Notify me** | Raises one desktop notification. Clicking it opens the task. |

**Adding one.** Each group has its own **Add automation** control, so where you add decides when
it runs. The picker offers the four types, and below them every row on every other column, to
copy. A copy is independent of the original. A type the column cannot run is offered disabled,
with the reason.

**Editing one.** Clicking the row opens a dialog with the name, the type, the type's own fields,
and When. Nothing else. The pencil does the same, for a pointer that is already over it; the grip,
the switch and the trash keep their own jobs and do not open it. A name is required and must be unique on its column. Every text field takes
template variables: type `{{` to pick one, or use the **Template variable** button. A known
variable is highlighted; an unknown one is flagged and sent as written.

**Reordering.** Drag a row by its grip. A drag stays inside its own group: it changes where the row
sits, never when it runs. To change when it runs, open the row and set When.

**The agent starts by itself.** Nothing in the list starts the agent, and there is no Start agent
row. On enter, Kangentic starts the column's agent right before the first automation that needs
one, which today means a **Send message to agent** row. On exit there is no agent to start, so
such a row is skipped with that reason recorded.

**When something fails.** Every run is recorded, whatever happens. A failure raises one toast
naming the automation and the column, with a **Run again** action that re-runs it against the
task's current state. Nothing is retried
automatically: a fired webhook and a half-run script are not safe to repeat blind. A run that was
in flight when Kangentic quit is marked interrupted the next time the project opens.

**To Do and Done** run exit automations only. Nothing runs when a task enters them.

**Where they live.** Saving writes them to `kangentic.json` under the column that owns them, so
they are shared with your team through git. The board header shows a lightning glyph with the
count of automations that will actually run there, and **All columns** in the Column Manager shows
every column's counts side by side.

### Reorder Columns

Drag a column by the grip in its header to reorder, or Tab to the grip and use Space and the arrow keys (see [Move Between Active Columns](#move-between-active-columns)). To Do stays first.

### Delete a Column

Columns can only be deleted when empty (no tasks).

## Settings

Settings are accessed from two entry points, both opening the same unified panel:

- **App Settings** - click the gear icon in the title bar. Scoped to the currently active project (or, if none is open, only the shared System tabs appear).
- **Project Settings** - click the gear icon on a project row in the sidebar. Opens the same panel scoped to that project, with a project switcher dropdown in the header to jump between projects.

Both panels use a VS Code-style layout: a sidebar with tab navigation on the left, and the active settings pane on the right. Tabs above the divider (General, Theme, Agent, Git, Browser, Shortcuts) are per-project settings; tabs below it (Board, Task, Changes, Terminal, Behavior, Performance, Hotkeys, Notifications, Dictation, Knowledge Graph, MCP Server, Agent Browser, Mobile Devices, Privacy, Developer) are shared across all projects. The shared tabs are further grouped into Core (Board through Notifications, unlabeled), Advanced (Dictation through Mobile Devices), and Other (Privacy, Developer). The Performance tab holds Graphics acceleration (see [Graphics failures](#graphics-failures)) and Animations, which moved there from Board because it applies to the whole app rather than the board. The General tab shows the project's location on disk with a "Move..." button (see [Moving a project](#moving-a-project)); the Theme tab holds the interface color-scheme picker. The Task tab (Card Density, Ticket Numbers, Context Bar) holds settings for how an individual task presents itself, split out from Board and Terminal. Terminal (shell, font, cursor style, colors) is a shared tab, not per-project: nobody wants a different font per project, and the shell setting in particular was never reliably project-scoped under the hood. When no project is open, only the shared tabs appear.

### Moving a project

To relocate a project to a new folder, open Project Settings > General and click **Move...**. Pick the destination's parent folder; Kangentic moves the project folder (keeping its name) into it and re-points the project at the new path in one step. All tasks, board history, and worktrees move with it, and each agent's resumable session data is migrated so sessions resume at the new location.

Before the move, a confirmation dialog lists the project's active agent sessions. Confirming stops them (they resume automatically at the new path) and performs the move; cancelling changes nothing. Only this project's own sessions are touched - agents running in other projects or external terminals are left alone.

A same-drive move is instant. Moving to a different drive copies the folder (a progress indicator shows the copy), then removes the original once the relocation has succeeded; if the original cannot be fully removed, the move still completes and a warning notes that the old copy remains.

If a project's folder was moved or renamed outside Kangentic while the app was closed, you are instead prompted with **Project Folder Not Found** the next time you open it; click **Locate Folder...** to point Kangentic at the new location.

### Search

A search bar at the top of each panel filters settings by keyword. Type multiple words to narrow results (all tokens must match). Results are grouped by tab with match count badges on the sidebar tabs. Tabs with zero matches are dimmed. Press Ctrl+F (Cmd+F on macOS) to focus the search bar, Escape to clear the filter.

### Themes

The Theme tab (a per-project setting) shows the 12 themes as a grid of tiles, each painted in
its own colours, so you pick by eye. Rest the pointer on a tile to try that theme on the whole
app without changing anything; move off the grid and it reverts. Click a tile to keep it, or
with the grid focused use the arrow keys, Home and End, or type the first letter of a name; the
app repaints as the selection moves. The tiles are grouped by whether the theme is dark or
light underneath:
- **Dark:** Graphite, Rust, Moon, Forest, Ocean, Ember
- **Light:** Paper, Clay, Sand, Mint, Sky, Peach

Graphite and Paper are the neutral defaults. Rust and Clay are the product palette, built from
kangentic.com's own tokens, so the app and the site read as one surface; their tiles carry the
brand mark. Colour only: the site's typefaces do not come with the theme, and the terminal keeps
its own colour scheme (see Terminal Colors below). Searching Settings for a theme's name finds
the picker. (In `config.json` Graphite and Paper keep their original ids, `dark` and `light`;
the others are their lower-cased names.)

**Follow system appearance**, the switch above the grid, keeps one theme for when the OS is
light and another for when it is dark. With it on, each group in the grid has its own selected
tile and the other tiles dim so the pair stands out (a dimmed tile still previews on hover and
can be picked); the app paints the one that matches the OS right now and switches the moment
the OS does, with no restart. Turning it on keeps the theme you had (it becomes that group's
choice), and turning it off keeps whichever theme is showing. The launch background follows the
same rule, so a follow-system install opens in the right colour.

### Terminal Colors

The Terminal tab's **Colors** section (not the Theme tab's color-scheme picker - this is a global setting, not per-project) lets you customize the terminal's background, foreground, and cursor color. Click a swatch to open the color picker; any color left at its default shows the built-in value (near-black `#0c0c0c` background, `#e4e4e7` foreground/cursor). The preset grid offers the built-in default first, then a color matching your current app theme (skipped if it would duplicate the default), then curated generic presets. The 16-color ANSI palette (used by shell tools like `git diff` and `ls --color`) is a fixed scheme based on Windows Terminal's Campbell, not individually customizable. "Reset to default" clears every customization. Applies globally across all projects.

### Terminal Settings

Applies to every project (Settings > Terminal, not a per-project override):

| Setting | Description |
|---------|-------------|
| Shell | Override the auto-detected shell |
| Font Size | Terminal text size in pixels, from 8 to 32 |
| Font Family | Terminal font, picked from your detected system fonts via an autocomplete field |
| Cursor Style | Terminal cursor appearance (block, underline, or bar) |
| Word Delete on Backspace | Backspace deletes the whole previous word instead of one character (off by default) |

### Task Settings

Applies to every project (Settings > Task, not a per-project override). These describe how an individual task presents itself, not board layout or terminal cosmetics:

| Setting | Description |
|---------|-------------|
| Card Density | Amount of detail shown on task cards (compact, default, comfortable) |
| Card Preview | The text under each card's title: the latest agent message (default), recent agent messages one line each, or the task description |
| Ticket Numbers | Show each task's `#N` number as a muted badge on its card (on by default) |

With Card Preview at its default, a card whose agent is running prints that agent's newest message in place of the description, in a shaded terminal panel, wrapped to three lines at default density, five at comfortable, one at compact. **Recent** prints the agent's newest messages one line each and newest last in those same lines, for a sense of the agent's last few steps instead of one whole thought. The text updates live as the agent works. The panel appears exactly when the card's activity glyph does, including while the agent is waiting on you, and the moment the session pauses or ends the card goes back to showing the task description. A task with no session, or whose agent has not said anything yet, shows its description too. The Agent Monitor's cards honor the same setting and render it the same way. The Task tab also holds the Context Bar toggles below.

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
| Default Agent | Which agent CLI to use for new sessions in this project. Supported agents: Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Qwen Code, Kimi Code, OpenCode, Droid (Factory), Cursor CLI, GitHub Copilot CLI, Aider, Oz CLI (Warp), Ollama, Grok Build, Goose CLI. Per-project setting. |
| CLI Path | Path to agent CLI binary (auto-detected if empty) |
| Execution (remote) | For agents that support it (today OpenCode), attach to a server you run instead of spawning a local process: server URL, authentication, and the server-side working directory. Shown only when the selected agent declares remote execution. |
| Launch Options | Agent-specific startup toggles (today Codex's "Disable ChatGPT Apps", which skips the optional cloud ChatGPT Apps connector that can hang startup). Shown only for agents that declare options. |
| Permissions | Default permission mode for all sessions. Options vary by agent (e.g., Claude Code has Plan, Don't Ask, Default, Accept Edits, Auto, and Bypass; Aider has Interactive and Auto-Approve) |

All permission modes are available in both the global App Settings dropdown and the per-column Edit Column dialog. The dropdown shows only the modes supported by the active agent. Each column can override the project default agent via the Edit Column dialog. When a task moves between columns with different agents, a context handoff occurs automatically - see [Column Management](#column-management) above.

### Git Settings

Three cards: **Branches**, **Worktrees**, and **Pull requests**.

| Setting | Card | Description |
|---------|------|-------------|
| Default base branch | Branches | Branch new worktrees start from (default: main) |
| Auto-fetch remote | Branches | On by default. Fetches all remotes 5 minutes after the project's last full fetch, so "behind" counts stay current. Any full fetch resets that clock: opening the Changes panel, the Done check, or this sweep. Creating a worktree always fetches its base branch first, even with this off. Off, the project still fetches when it opens |
| Worktrees | Worktrees | On by default. Gives tasks the option to run in their own git worktree: the New Task dialog then offers Worktree or Project, starting on Worktree. Off, the dialog does not offer the choice and tasks run in the project folder, including one created earlier with Worktree picked. A task that already has a worktree keeps it. The rows below show only while this is on |
| Auto-cleanup | Worktrees | Remove a task's worktree when the task completes |
| Link node_modules | Worktrees | Symlink the root `node_modules` into each worktree to skip a fresh install (on by default). Turn off to let the Post-worktree script install the worktree's own dependencies |
| Copy files | Worktrees | Files to copy from repo root into each new worktree, such as `.env` |
| Post-worktree script | Worktrees | Shell script run in each new worktree after creation (e.g. `npm install`). A non-zero exit or timeout fails worktree creation |
| Auto-refresh PRs | Pull requests | On by default. Checks each open PR about 2 minutes after its own last check, one call at a time and at least 10 s apart, so at most 360 calls an hour however many PRs are open. Any check resets a PR's clock: this queue, the 30 s re-poll while CI runs, an agent's `gh pr create`, or a manual refresh. Past 12 open PRs each PR's interval stretches instead of the cost growing. Off, PRs are checked when the project opens and nothing re-polls one whose checks are running |
| Count merge bypass as ready | Pull requests | On by default, GitHub only. Ready means you could merge the PR now. A PR still waiting on a required review reads `blocked` even when you can bypass that rule and merge it yourself, which is how the Merge column already lands PRs. That stays true once somebody else's PR lands and leaves yours behind the base. On, such a PR reads `ready`, at one extra `gh` call per such PR per check. Never past a check: the same call reads the branch's required checks and every one must have reported green. Turn it off to keep the review norm even where you could bypass |

Azure DevOps PRs always get their branch policies checked (reviewer minimums, required builds, work-item linking), so a clean Azure PR reads `ready` or `blocked` the same way a GitHub one does. Kangentic does not read Azure DevOps bypass permissions yet.

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
| Stop Leftover Processes | Stop what a task's agent left running in its folder when the task is done, moved back to To Do, or deleted. Off, nothing is stopped and the toast still lists what kept running. |
| Close on Outside Click | Click empty space outside a task window to close it. Controls, task cards, and running terminals still act on the first click. Closing a window does not kill its session. |
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

The sync runs both ways. Opening a project also reads an existing `kangentic.json` back INTO your database first, before that write - so editing the file by hand is a genuine way to change the board, not just a record of it. That read happens with no banner and no prompt, and the file wins where the two disagree. A file that cannot be read, such as one with git merge conflict markers, is never overwritten: the board loads from the database and a banner says the file needs fixing. See [Board Config Sync](configuration.md#board-config-sync-kangenticjson) for the full rules.

### Personal Overrides

Create a `kangentic.local.json` in the project root for personal customizations (column colors, icons, extra columns). This file is auto-added to `.gitignore` and merges on top of the team config.

### Applying Changes

When `kangentic.json` or `kangentic.local.json` changes on disk, a reconciliation banner appears at the top of the board. Click "Apply" to reconcile the file into your database, or dismiss to ignore. Enable Auto-Apply Board Config Changes in the Board settings tab to apply changes automatically instead.

If a teammate removes a column that still has your tasks, the column becomes a "ghost" (hidden but preserved). Once you move all tasks out of the ghost column, it is automatically deleted.

## Worktrees

When worktrees are enabled (default), each task gets its own git branch and working directory. This allows multiple agents to work in parallel without merge conflicts.

A task WITHOUT a worktree runs in the project folder itself: the checkout you have open in your editor (and the one Kangentic runs from), shared with every other task that has no worktree. Nothing prevents two such agents from editing the same tree at once; Kangentic only refuses to switch that folder's branch under a live agent. This happens when you choose Project instead of Worktree in the Branch row, and also when the project cannot have a worktree at all: it is not a git repository, it has no commits yet, or the project folder is itself a git worktree (git cannot nest them). A remote-execution agent gets no local worktree either, but runs in its server directory rather than the project folder.

Where an agent works is always visible:

- **New Task dialog and edit form** - the line under the Branch row says where the task will run before you create it: "Runs in the project folder on `main`" (the branch the folder actually has checked out) versus "will be created from `main` in a new worktree". A pinned base or a custom branch without a worktree reads "`x` will be checked out in the project folder", since that is a real branch switch in the folder you have open. When the project cannot have a worktree, the line reads "Runs in the project folder" and the Worktree option is disabled, with the reason in its tooltip.
- **Task detail** - the folder button in the header shows the worktree icon for a task in its own worktree and the git-folder icon otherwise, and the kebab's folder item reads "Open worktree" or "Open project folder".

### Per-Task Placement

The Branch row's Worktree | Project pair sets where an individual task runs, regardless of the global setting. Choose it when creating a task or in the task detail edit form. Choosing Worktree cannot override the structural cases above.

### Branch Naming

Branches follow the pattern `{slug}-{taskId8}` (e.g., `fix-auth-bug-a1b2c3d4`).

### Base Branch

Priority order:
1. Task's base branch (per-task override)
2. `kangentic.json` `defaultBaseBranch` (team-shared, overridable via `kangentic.local.json`)
3. Per-user `git.defaultBaseBranch` (default: `main`)

The base is not part of the branch name; the task's worktree records it as `kangentic.baseBranch`.

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

Notifications fire when an agent needs attention and you cannot already see it. The two channels cover opposite halves of that, so between them nothing is missed and nothing is said twice.

Desktop notifications are for when you are away: they fire only when the window is minimized or unfocused, or a different project is active. Notification events: agent idle, permission-blocked idle (body shows "Needs permission"), session crash (non-zero exit), and plan-completion auto-moves. The task name is the title and the project name is the body. Clicking one brings the window to the foreground, switches to the correct project, and opens the task detail dialog. The taskbar also flashes on Windows. A 10-second cooldown prevents the same agent repeating the same kind of desktop notification. Idle and crash are counted separately, so an agent that dies right after finishing a turn still reports the crash. A newer desktop notification for a task replaces that task's older one in Windows Action Center or macOS Notification Center, so they do not stack. Command Terminal notifications are the exception and still stack.

Toasts are for when you are here but looking elsewhere. Every notification toast is scoped to the open project, so a background project speaks through the desktop channel alone. The idle toast fires when an agent finishes its turn or needs permission, and is skipped when that session's terminal is already on screen: a task-detail window, the in-app or detached Agent Monitor, or a phone streaming it. It carries an **Open** button that opens the task. One toast per turn, not one per progress update.

The Settings > Notifications panel exposes four configurable events: **Agent idle**, **Agent crash** (session exit; desktop alerts on error exits only, toasts also cover clean exits), **Plan complete**, and **Spawn stalled** (a task spawn that waits too long on the git queue while preparing). Each can be set to Off, Desktop, Toast, or Both. Toast duration and max visible count are also configurable.

### Announcements

Occasionally Kangentic shows a product announcement (for example, a call for mobile-app beta
testers) as a slim banner above the board. **Learn more** opens the full message with links and
a QR code; the **X** hides that banner for good on this machine.

Dismissing does not lose the announcement. The **megaphone** in the title bar is always there and
opens the full history, newest first, so anything you dismissed or that has since expired stays
readable. Its badge counts announcements you have not opened yet, and reading one clears it.
Dismissing is not reading, so an announcement you waved away still shows in the count until you
open it.

Announcements are fetched from a static file on the public GitHub repo - no account, no tracking,
and if the feed is unreachable (offline or self-hosted setups) no new ones appear, though your
history stays available. See
[Configuration - In-App Announcements](configuration.md#in-app-announcements) for the feed
mechanics.

### Mobile Devices

The Mobile Devices tab is the desktop half of the mobile companion app's pairing link - global (applies to this desktop installation, not any one project) and off by default. Below the **Mobile Bridge** toggle it splits into two sections: **Relay** (where this desktop connects) and **Mobile** (which phones may use it). Each ends in a documentation link that stays usable with the bridge off, since someone still deciding whether to enable it is exactly the person who has not.

Enable the toggle, then pick a **Relay**: *Kangentic* (the default, the one Kangentic operates) or *Custom* (your own self-hosted address). Dev builds also offer a *Local* option pointing at a relay on localhost. The address being dialed always sits in the field directly beneath the picker, read-only for the presets and editable for a custom relay, so there is one place to look regardless of which you chose; a shield in front of it marks the Kangentic-operated relay and appears for nothing else. **Test connection** probes that address before you pair: it reports whether the relay answered and how long it took, or prints why it did not. The relay forwards encrypted traffic and never holds your keys; **How the relay works** opens the relay documentation, which covers what it does, what an operator can still observe, and how to run your own. A custom address must use `wss://`, or `ws://` for localhost only, since the phone refuses to pair over an untrusted transport.

Click **Pair a device** to display a QR code; scanning it with the Kangentic mobile app starts an end-to-end encrypted pairing handshake. Once the handshake completes, both the desktop and the phone show the same short code - compare them, then tap **Confirm** on the phone. The desktop auto-enrolls the device as soon as it hears back; there is no second confirmation to make on the desktop. This catches a photographed or relayed QR, since an attacker cannot make both sides show the same code. To back out, cancel on the phone (or close the desktop's pairing panel) before confirming.

The phone is treated as an extension of your own desktop, not a separate integration to configure: pairing grants it full access to every capability the protocol defines (there is no shell, file, or arbitrary-command access in the protocol at all). Paired devices appear in a list below, identified by a key fingerprint you can compare against the phone's own Settings > Devices screen, along with their connection status and paired date. Rename a device from that list, or revoke it - revoking removes it from the desktop's signed roster immediately, and a revoked phone must be paired again from scratch to reconnect. See [Mobile Bridge](mobile-bridge.md) for the underlying protocol, pairing ceremony, and security design.

The Mobile section closes with **How to install and pair**, which opens the [Kangentic Mobile docs](https://kangentic.com/mobile/): installing the app, pairing a phone, and push notifications. It is always present, in both directions - it stays usable with the bridge toggle off, since someone who has not installed the app yet is exactly the person who has not enabled the bridge, and it does not disappear once phones are paired, since that link is a docs landing page rather than an install page and you may well be adding a second device. Install instructions live on the website so they stay current between desktop releases; while a store rollout is in progress, the in-app Announcements dialog carries the signup steps for the current phase.

### Privacy

The Privacy tab shows what anonymous telemetry Kangentic collects (app launches and the previous run's duration, crash reports, task and session counts, daily feature-usage counts, and a once-per-launch list of which global settings differ from their defaults) and how to opt out. Usage analytics are powered by Aptabase (no cookies, GDPR-compliant, plus one anonymous non-reversible install id used only to count unique installs); crash and error reports go to Sentry with machine-specific paths removed from stack traces. Set `KANGENTIC_TELEMETRY=0` as an environment variable to disable all telemetry, or `KANGENTIC_ERROR_REPORTING=0` to disable only error reporting. It also lists `support@kangentic.com` for questions about what is collected. This tab is informational only - there are no configurable settings.

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
2. PTY processes are force-killed. A session still in its first moments after spawn gets a brief grace first (its exit command, then the force-kill about 1.5 s later) so Claude Code's own startup bookkeeping is not cut off mid-boot
3. On next launch, sessions are automatically resumed via `--resume` using the saved session ID

Because Claude Code supports `--resume`, conversation context is fully preserved even when a session is killed rather than exited. If the app crashes, orphaned sessions are detected and recovered on the next launch.

### User-Paused Sessions

Sessions paused manually by the user (via the pause button in the task detail dialog or kebab menu) are remembered across restarts. On relaunch, user-paused sessions remain paused instead of auto-resuming. This respects user intent. If you paused an agent, it will not start back up on its own. Only system-suspended sessions (those suspended by shutdown or column moves) auto-resume.

## Graphics failures

Chromium renders the app through a separate graphics process. Rarely, that process fails over and
over, or cannot be started again. When it
exhausts every fallback it has, Chromium shuts the whole app down on purpose. There is no crash
dialog and no warning: the window simply disappears. On some machines it happens within seconds of
launching, so the app can look like it will not start at all. On others, so far only Linux, it
happens a few minutes into a normal session.

Kangentic recovers itself. The next launch starts without graphics acceleration, which removes the
graphics process entirely and takes that shutdown off the table. You get a toast saying so, and
Settings > Performance shows **Graphics acceleration** switched off, with a note that Kangentic
turned it off after repeated failures.

What to expect while it is off:

- Terminals render through the slower DOM path instead of WebGL. Long-running agents with heavy
  output feel less smooth. Everything still works.
- Animations and the rest of the UI are unaffected.
- Nothing turns it back on by itself. When you want to try again, switch **Graphics acceleration**
  back on in Settings > Performance and choose **Restart now**. Kangentic restarts with acceleration
  on, and running agents resume after the restart. If the failure returns, the next launch turns it
  off again.

Only a graphics process that actually fails counts. Shutting down or restarting the computer with
Kangentic open, ending it from Task Manager, or running out of memory does not turn acceleration off.

Kangentic does not diagnose the cause, and deliberately does not guess at one. On the installs that
failed at boot, the failures started seconds in, before any agent or terminal existed. A display
driver is the usual culprit for that shape, so updating yours is the first thing worth trying, but
the app has no way to confirm that from the inside and will not claim it did. If it keeps happening,
the local crash records under `<project>/.kangentic/logs/crashes/` (kind `gpu-process-gone`) are the
useful thing to attach to a bug report. A record whose message ends in "(not a GPU fault)" was a kill
or a shutdown, not a failure. When the graphics process could not be started at all,
there is no such record: Chromium never reports a failed start to the app, and only the fallback
itself is recorded.

Unrelated, despite the similar name: **Model acceleration** in Settings > Knowledge Graph controls where
the local search model runs, not app rendering. The two are independent.

## Conversation Memory

Kangentic indexes every session's conversation into a per-project, on-device search index, so past agent conversations are recallable without scrolling through old terminals. Indexing is on by default; turn it off or tune it in Settings > Knowledge Graph.

### What Gets Indexed

The structured transcript of each session: user turns, assistant replies, thinking blocks, and tool-call summaries. Raw terminal scrollback is never indexed (for TUI agents it is mostly cursor and redraw noise). A session is indexed when it finishes or suspends, an in-progress conversation is re-indexed at each turn boundary, and older history is backfilled in small sweeps when a project opens.

### Keyword and Semantic Search

Keyword (full-text) search is always available while indexing is on. Turning on the **Knowledge Graph** in Settings > Knowledge Graph downloads a small embedding model once and then runs fully offline. The **Search quality** row picks it: **Best** is IBM's Granite embedding English R2 (153 MB), **Light** is bge-small (33 MB). The status row under it reads **Downloading** over a progress track, then **Local model** with the model's name, size and where it runs, or **Download failed** in red, and a **License** line links the model's license. It powers the [Knowledge Graph](#knowledge-graph) and hybrid `kangentic_search` for agents; Quick Find stays keyword-only. Embedding runs in an isolated background process, duty-cycle throttled so backfills never peg the CPU, with a **Model acceleration** setting (Auto / GPU / CPU). Changing Search quality re-indexes in the background by itself. **Rebuild the index**, in the Index card, reads every source again in every project without deleting anything: the open project now, every other one the next time you open it. It is only needed if search misses something you know is there, or after a new agent or model, when it also rewrites the task summaries written the old way. Every failure path (no model yet, slow embedding) degrades transparently to keyword-only.

### Where It Surfaces

- The [Search Palette](#search-palette) shows a **Conversations** group of keyword matches; a hit opens the viewer at the matched turn.
- The **View conversation** pill in the [Task Detail Dialog](#task-detail-dialog) opens the task's newest session directly, no search needed.
- Agents read what the Knowledge Graph knows over MCP - see [mcp-server.md](mcp-server.md):
  - `kangentic_search` recalls past conversations by meaning (the default) and finds the commits a query matches, each with the task it came from. It ranks tasks by a topic (`groupBy: "task"`, with each task's facts and summary) or by how like one task they are (`relatedToTask`). An agent drills into a cited turn with `kangentic_get_transcript`.
  - `kangentic_find_task` and `kangentic_get_current_task` carry a finished task's summary, the commits linked to it, and the files its sessions changed.

### The Conversation Viewer

A read-only window on the same layer as task detail windows: drag, resize, snap, tile, and maximize it like any other window. Open viewers persist in the workspace across project switches and app restarts. Each turn renders cleanly with per-message copy buttons, and the header keeps two one-tap actions, **Open task** (jump to the owning task's detail window) and **Copy conversation as Markdown**, both also available from the window's kebab menu.

The viewer opens positioned at the latest message, or centered on the turn matching where you had scrolled in the live terminal, so it lands where you were looking. A search bar at the top does debounced substring search across the transcript with snippet results and prev/next navigation; press **Mod+F** (Ctrl+F on Windows/Linux, Cmd+F on macOS) to focus it, and click a result to jump straight to that turn. Very long transcripts (tens of thousands of messages) stay smooth via row virtualization and a custom overlay scrollbar with a "jump to latest" pill.

## Command Terminal

The Command Terminal provides quick, ephemeral access to Claude Code without creating a task on the board. Useful for one-off actions like creating releases, running queries, or any ad-hoc interaction.

**Opening:** Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS), or click the terminal icon in the title bar (the left-most icon in its right-hand button row). The same button **toggles** the layer closed again, so there is always a one-click way to hide it, even when a window is maximized. The terminal icon reflects activity across your open terminals: its prompt blinks in green while an agent is working, it holds a steady warm amber when one needs your input, and it stays plain when idle.

**Behavior:**
- Spawns Claude Code at the project root on the configured default base branch. If you have uncommitted changes to tracked files on another branch, a new terminal stays on that branch and tells you so, rather than carrying your work onto the base.
- It opens as a **window** over a slight backdrop blur: drag it by the header, resize it from any edge or corner, maximize / restore it (double-click the header or use the maximize button), and snap it to a screen half or full screen (Windows-style). The layout (size, position, maximized state) **persists globally** across all projects and app restarts.
- **Run more than one at once.** While the layer is open, a second terminal icon (with a `+` in its center) appears in the title bar just to the left of the main terminal icon - click it to open another terminal (up to four); it disables once you hit the cap. New terminals split into the current window's footprint (side by side, keeping the size you set) so you can keep two ad-hoc tasks cooking and glance between them; drag the seam to rebalance, or maximize one to focus it.
- **Each window is numbered.** A terminal titles itself `Command Terminal 1`, `Command Terminal 2`, and so on, from its durable window slot - so two side-by-side terminals are tellable apart, and the number stays put when a sibling opens or closes. The same title identifies that terminal on its Agent Monitor row. Once you send a first prompt, the title becomes a short auto-derived name for what you asked instead.
- **Layout controls (same as task windows).** When a terminal is tiled, a **pop-out** button floats it back out of the tile group. The title always wins the header's space: the quick-action pills (Commands, Project, Changes, shortcuts) fold into the `...` menu as the window narrows.
- The **branch picker** in the header lets you switch branches - selecting a new branch kills that terminal's session and respawns it on the selected branch. The pill names the branch the checkout is actually on: it is re-read from git whenever you reopen the layer and whenever the checkout moves (an agent running `git checkout` inside the terminal, or your own git usage), so it never keeps claiming a branch the repo has left. Reopening never checks anything out.
- The terminal's **Changes** panel measures ahead/behind, and diffs its Branch tab, against the project's default base branch, the same base the pill's default names.
- A shimmer overlay shows while Claude Code initializes, then lifts to reveal the clean TUI
- Transient sessions are fully independent of task sessions - they don't appear in the terminal panel tabs, don't count toward session limits, and produce no toasts when they exit or go idle
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
- **Breakdowns** - by model, by agent, by reasoning effort, and, when a session fanned out to subagents, by subagent type, alongside KPI tiles (cost, tokens, sessions, tool calls, line churn, files, cache reads, compactions, burn rate, average active time, subagent tokens) with "vs previous period" deltas. The Subagents tile's tooltip adds how many of those subagents another subagent spawned, and names any agent in the range that cannot report subagent usage at all - only Claude can today, so a Codex or Gemini range says so rather than showing a dash that looks like "nothing fanned out".

Totals are read from the durable usage ledgers, so they survive task and session deletion. The selected range and scope persist across app restarts (one global value shared across all projects).

Two things the numbers do NOT mean, both said on the tiles themselves. Cost is API-equivalent list price for the tokens each agent reported, not what a subscription was billed, so a subscription session can report $0. And tokens are counted per turn and kept apart by type (fresh input, output, cache write, cache read) because cache reads are far larger and far cheaper than fresh input; per-turn counting started later than cost did, so a long range covers less of it, and the Tokens tile says from when.

## Knowledge Graph

Open it from the brain icon in the title bar or with `Mod+Shift+A`. It answers "what does this
project's conversation index actually know, and how much of my history has it reached" - a question
neither the Knowledge Graph settings tab (switches, counts and a Rebuild button) nor Quick Find (a flat list of keyword matches)
can answer.

**The map.** Every indexed conversation is a point in 3D space, placed by the meaning of its
embeddings, so conversations about the same thing cluster together. Links join each conversation to
its nearest neighbours. Regions are named automatically from what the conversations in them are
about, so the map reads as a topic atlas of the project rather than an anonymous scatter. The names
come from the conversations' task titles, and with **Task summaries** on, from each task's summary too,
counted a little lower than its title: a region then reads as what its work touched ("alt screen /
wheel scroll") rather than how its titles happened to be worded ("code / quit / exit"). As summaries
are written the regions are renamed in place, at most every few minutes and once more when the
summaries have caught up; no conversation moves. Switching summaries off puts the title-only names back.

**Flying it.** Drag to orbit, right-drag to pan, scroll to zoom in and out. Click the map and use
**W** / **S** to fly forward and back, **A** / **D** to slide left and right, and **Q** / **E** to
rise and drop - you can fly right into a cluster and out the other side. The camera toolbar at the
bottom centre of the map holds **Reset view**, which frames the whole map again so it is always
possible to get un-lost, and **Controls**, which shows these keys. With regions switched off, Reset
view frames what is left rather than the regions you hid, so resetting a scoped map fills the view
instead of pulling it back out. With no chat open, Reset view also clears the selected conversation
and its panel, and centres the map in the space the panel leaves. While a chat is open the selection
stays, since its panel's Back is the way back to the chat.

Every change to what the map shows moves the camera by flying, never by a cut: narrowing a filter
or landing an answer flies to what is lit, clearing it or ending the chat flies back to the whole
map, and adding or removing a project flies from where you were to the new map. Three things still
reframe at once: resizing the window (a fly would fight the drag), opening the graph, and switching
the open project.

**Clicking around.** Hover a point for its title and size; click it for a detail panel. With a
chat open, the panel's **Back** control returns to it. With **Task summaries** on, the panel shows the
conversation's task summary under its title: what the task set out to do and did, in a sentence or
two.

The panel lists **Closest conversations**, its strongest links, ordered rather than scored: the
embeddings sit in a narrow similarity band where a percentage reads "99%" on every row and tells
you nothing, so the ordering is the signal.

Two actions: **Open conversation** (or a double-click on the point) opens the full transcript in a
movable window over the map, so it stays where you are reading rather than opening behind the
graph - the same when the graph is detached into its own window. **Explore from here** re-scopes
the map to that conversation and everything it links to, with a breadcrumb at the top of the map to
take it back.

The left panel holds four cards, and each one collapses: **Filter** (projects, time and status),
**Regions** (detail and the region list), **Display** (colour and what shows), and **Index**, which
opens beside the panel.

**Colour** switches what the points encode:

- **Topic** - the region each conversation belongs to.
- **Recency** - warm is recent, cool is old. Shows where your attention has moved, and which
  areas have gone quiet.
- **Status** - green is Done, amber is still open on the board, grey is a conversation with no
  task. Offered only when the less common status covers at least a twentieth of the index: on a
  healthy board almost everything gets done (642 of 648 on a real one), and a map that is uniformly
  green with six specks in it is a question for the status FILTER rather than a thing colour can
  show.
- **Length** - how much transcript the conversation holds, from deep indigo for the shortest through
  blue and teal to a warm yellow for the longest.
- **Duration** - how long it ran in wall time, on the same ramp.
- **Cost** - what it cost to run, on the same ramp.

Those last three are three different questions, not three readings of one: measured on a real index
their rank correlations are 0.507 (length to duration), 0.560 (length to cost) and 0.664 (duration
to cost), so a long conversation is not reliably a slow one and a slow one is not reliably an
expensive one. Duration and Cost are hidden on an index that records neither, and a conversation
missing one draws at the low end rather than disappearing.

**Show** turns the region labels and the similarity links on and off.

**Detail** cuts the map into more or fewer regions: **Coarse**, **Balanced** (the default) or
**Fine**. All three are computed with the map, so switching between them is instant and never
rebuilds anything. There is no measurement that can pick this for you - every way of scoring a
clustering prefers the fewest regions on a cloud this continuous - so it is simply how much detail
you want to read. How finely the map CAN be cut is bounded by the index: on a small one every
setting produces the same regions, and the control hides itself rather than offering choices that
repaint the identical picture.

**Filter** scopes the map by time (Any, 30 days, 90 days) and by status (Any, Done, Open), each a
row of buttons so every choice shows and takes one click. Done is a task in the Done column (or
archived, which only moving to Done does), and Open is every other task on the board. Both rows
always show their three choices, lined up in columns, so changing the scope never moves the panel.
A choice that cannot narrow this index is disabled, and its tooltip says why: both time windows
when nothing is older than 30 days, a status no task has, and the one status every task has.
Unlike the colour mode, the status row survives a lopsided board, which is the point of it -
scoping to the handful still open is exactly the question a green map cannot answer.

**Projects.** The graph opens on the project you have open. The Filter card's first row names the
scope and picks which projects the map shows: any of them, or **All**. It is there however many
projects are indexed, so it never comes and goes, and the header does not repeat it. **None** goes back to the open project
alone, since an empty map would leave nothing to pick from. Each project draws as its own island, labelled with its name and sized by how much it
holds, and the Regions list groups each project's regions under its name. A project with nothing
indexed is listed but cannot be picked. One the graph has never shown builds its map the first time
it is picked, which takes about a minute on a large project, and its island appears when that
finishes.

Asking follows the same scope. The box reads "Ask across 3 projects", every project's tasks go into
one table and one search, and the agent's own searches can reach each project. Ticket numbers repeat
between projects, so the reply names another project's task with its project, like **Mobile #88**,
and every row names its project. A row opens its conversation from its own project, and **Open
task** switches to that project to show it.

The **Regions** section below it lists every region with its colour and how many conversations it
holds, each independently switchable, plus **All** and **None**. A large index can carry dozens of
regions, so past a dozen the list gains a **Find a region** box. That narrows the LIST only - All
and None still act on every region, which is what the "N of M shown" count above them reports.

Position and links are not equally precise, and the surface says so rather than letting you assume:
**links are exact** (computed in the embedding's full dimensionality), while **position is
approximate** - reducing 1024 dimensions to three loses information, so "nearby" is a strong hint
rather than a guarantee. Follow the links when you want certainty.

**Asking.** Type a question in the box and press Enter: "what was the most expensive task?", "why
did we drop the sphere fit?", "which tasks touched the relay?". The question moves into a chat on
the right and the box goes. Follow-ups go in the chat's own box, and the **X** in its header ends
the chat and brings the box back. The chat is not saved, and it also ends when you switch projects.

**Set first, answer on top.** Before the agent starts, Kangentic searches every indexed conversation
and every task's own record (its title, labels, description and summary) for the question, locally
and in under a second, and rolls the matches up per task. A task's record can bring it in even when
none of its conversations was indexed, as long as the map is not filtered. The map lights
that related set at once, brighter where a task matches more strongly, and the chat reads "Reading
14 related tasks" while the agent works. When the answer lands, the map narrows to the tasks it is
about and nothing else: eleven tasks for an answer that names eleven, one conversation for an answer
about one. The rest fades out and the camera flies in, so a follow-up that narrows the answer
narrows the map with it, and clicking an earlier turn brings its tasks back the same way. If none of
the answer's tasks has a conversation of its own (tasks found by their records alone), the related
set stays, dimmed, so the map still points at the work the answer drew on. An answer that names no
task, such as "nothing here covers that", lights nothing and leaves the plain map. The filters in the left panel are the scope of the
question: a filtered map means a filtered table and a filtered search, so the chat never repeats
them.

**How it answers.** The agent is handed the related tasks with their strongest passages, facts and
summaries, a complete table of every task in scope, and the chat so far. The table holds every task on the
board, including ones with no indexed conversation, and settles factual questions exactly: what
each task cost, how long it ran, its tokens, how many sessions it took, how many files and lines
its branch changed, which pull request it opened and whether that merged, when it was last active,
which region it sits in, and what agent and model ran it, with the totals computed before the agent
sees them.
A task with no indexed conversation has nothing to open over the map, so its row opens the task on
the board instead. An agent that can use a tool also gets ONE: the same `kangentic_search` every agent gets,
scoped to this project (or to each project in a scope that spans several), for when the related
work misses something. Each search shows as a step in
the chat, and the conversations it found get a white ring on the map. Nothing else loads: no other
tool, none of your other MCP servers, and not the project's own instructions.

**The reply** is a few sentences that name tasks by their board ticket, drawn as small **#561**
marks. Under it are rows of one kind, a ticket and a title for each task the reply is about: five,
then **Show all**, which folds back with **Show fewer**. A row or a mark opens that task's most relevant conversation over the map,
scrolled to the passage the answer used, and that window's **Open task** closes the graph and opens
the task on the board. When you ask a follow-up, the earlier reply's rows fold into **Show N
tasks**. Asked something neither the table nor the conversations cover, it says so rather than
guessing. If the agent fails, its reason is shown as it came, with **Try again**.

It knows what the board and the conversations recorded, and, with **Source code** on, the code on
the project's default branch. With it on, the passages of code that read closest to a question go to
the agent beside the related tasks, so "how does the embedding drain pace itself?" is answered from
the code, naming the files, and the reply's rows stay tasks. A board question gets no code: code is
handed only when it reads close enough to the question. With it off, "how many agents does the app
support?" is a question about the repository that nothing here holds. Work done outside a board task
leaves nothing to find either way, and the box's placeholder says "tasks, conversations and code" only
while code is indexed.

Each question costs one agent call, and the glyph at the end of the box names the agent before you
press Enter.

**Which agent answers** is its own setting, because the agent that runs your tasks and the agent
that reads their history are different choices. The **Knowledge Graph** card in Settings >
Knowledge Graph holds the switch that turns the feature on, then the local model that finds work by
meaning, then the agent that answers: its **Agent** and **Model**, one choice for the whole app.
Nothing picks them for you: until both are set, pressing Enter in the box opens Settings > Knowledge
Graph at that row and keeps your question typed, so you can come back and press Enter again. The same agent and model write the
task summaries, so it is chosen once. Reading the index is lighter work than writing code, so a
cheaper model is usually enough. Every agent that has a headless read-only mode can answer; Warp
cannot, since it has none. **Effort** appears when the agent's CLI reports effort levels, and starts
at `low`, which answers fastest. Pick a higher level for questions that need counting or comparing
across many tasks: at Claude's `max`, a count that `low` got wrong came out right, at about ten
times the wait. Effort is for answers only: summaries always write at the recommended level, where
a higher one changed nothing.

The **Index** card below it lists what the index searches, one line per source:
**Conversations**, **Tasks** and **Commits** are always indexed while the index is on, on switches
that cannot be turned off, each with its count and a check once caught up. **Task summaries** and
**Source code** have their own switches and are on by default. A running source keeps its line and
shows the share done and the time left over a progress track ("22%, 3 min left"). Switched off, a
line shows what switching it on would cover ("674 tasks", "1,488 files"), or for Task summaries
the count with a check once every Done task already has one. The figures are every
indexed project's (each project with a conversation in the index), the same projects the Knowledge
Graph's All projects map draws, so the two read the same. Source code switched off is the exception:
its estimate is the open project's. Both wait for the Knowledge Graph and its agent, spending nothing until then, and say
so ("Needs the Knowledge Graph", "Needs an agent"): the agent writes the summaries, and only its
answers read the code. Their switches still work while they wait, so you can turn one off before
choosing the agent that would start it.

**Task summaries** start once the Knowledge Graph has an agent and a model. The agent writes a
sentence or two about each Done task: what it set out to do and what it ended up doing, from the
task's title and description, the files its sessions changed, the commits it landed on the default
branch, and how its last sessions ended. A summary is searched with the task and handed to the
agent beside it, so a question finds a task by what it did, not only by what its title says.
Summaries are written in the background, ten tasks to a call, three calls at a time (at Sonnet,
about $0.02 per ten tasks, and about three minutes for 700 tasks), and a task that reaches Done
gets one on the next pass. Every project is asked once each launch, a minute in, whether or not you
open it, and again when summaries are switched on or the agent is chosen. Caught up, the line shows
the count with a check. Behind with nothing writing, it shows how many are written of how many
could be, and how many the agent passed over ("670 of 673, 3 skipped"); those are asked about again
on the next launch, or after **Rebuild**. When a reply answers none of its batch while another batch
in the same pass was answered, each of those tasks is asked again on its own, so one task the agent
will not summarize does not hold back the rest. A failed call reads **A call failed** in yellow, with when
it is retried. When a call fails and no other call of the pass came back answered, every project's
summaries wait until then, since the agent is the same for all of them. One call failing beside
another that answered holds back only its own project. Switching summaries off stops new calls and keeps the
summaries already written, so they go on helping search. A new model applies to new and changed
tasks, and the line loses its check until **Rebuild** rewrites the rest, showing the share
rewritten over a track while those rewrites are being written; Rebuild asks first when it
will rewrite summaries, and says how many and about how many calls. Measured on this project's own
tasks, a mid-size model at low effort (Sonnet) wrote as well as a larger one and higher effort
changed nothing; the larger models (Opus, Fable) add a little detail at two to seven times the
cost, and the smallest (Haiku) invented details.

**Source code** starts once the Knowledge Graph has an agent. It reads the project's default branch as committed:
`origin/main` (or whatever the project's base branch is), else the local branch of that name, else
the remote's own default, else the branch you have checked out. Any branch works; it reads source
files and docs, not tests, fixtures, data files, lock files, build output or anything over 256 KB.
Each file is split into passages at its top-level declarations and embedded in the background by
the Knowledge Graph's local model. Off, its line shows the files it would read, or "Nothing committed yet"
in a repository with no commit. This repository took about half an hour on a GPU and would take a
couple of hours on a CPU. When the branch moves, only the files whose content changed are read
again. Switching it off clears the open project's code index at once and another project's the
next time you open it; switching it back on reads the branch again. Switching the Knowledge Graph
off, or clearing its agent, keeps the code index as it is, so turning it back on costs nothing.

The **Index** card at the bottom of the left panel opens to its side into the Index card that
Settings > Knowledge Graph shows, without its switches. Each source is a line: its count with a
check once caught up, its share while it is still being embedded, and a tag while it waits for
something (the Knowledge Graph, an agent, a model). The sources are **Conversations** (what the map
draws), **Tasks** (each task's and backlog item's own text), **Commits** (the commits on the
project's default branch, each tied to the task whose conversation wrote it), **Task summaries**
(how many Done tasks have one, a track only while a pass is writing them) and **Source code** (the
default branch's files). A source with nothing in it yet says **Not yet indexed**, and Task summaries with no Done
task says **No Done tasks yet**. Session changes
are kept as text for the task summaries and never searched, so they have no line. On All projects
the panel reads the same figures as the Settings card. With the Knowledge Graph switched off it
reads as off here too, even while the map it already drew is still shown: counts without a share,
and **Needs the Knowledge Graph** on the lines that wait for it.

Below the sources is what only the map has. **Links** counts the similarity links, computed in full
embedding dimensionality, so they are exact; a dot's position is an approximate reduction.
**Transcript gone** counts conversations whose agent transcript file was deleted (a pruned
worktree, a cleaned CLI cache) while their indexed text and embeddings still answer queries. On a
mature project that is most of the index, and it is not a problem. **Not yet indexed** counts
conversations the background sweep has not reached, **Failed to index** any it could not read, and
**Size on disk** covers every source. **Open Settings** opens Settings > Knowledge Graph, where the
sources change, the index is rebuilt, and its model and agent are set.

The panel opens to the side and stays inside the window whatever the left panel holds: with every
card expanded it rises until its bottom clears the window's edge, and in a window too short for it
the panel scrolls inside itself.

The index holds what the board and its conversations recorded, plus your repository's committed
files while Source code is on.

The map is drawn on the GPU. On a machine that cannot provide a 3D drawing context (a blocklisted
driver, some remote sessions) it says so, and the coverage numbers and Ask keep working.

**Building the map.** The first time a project opens the graph, Kangentic reads every embedding in
the index to place the dots. On a large project that takes a few minutes, runs in the background,
and only happens once; after that it updates in about a second as new conversations are indexed.
While it builds, one card in the middle of the screen shows how far it has got (reading the
conversations, then placing them, then naming the regions), the same source lines the Index panel
lists, and an **Open Settings** button. The Index card joins the left panel once the map is drawn.
It needs the Knowledge Graph's embeddings (Settings > Knowledge Graph). Without them there is no
meaningful notion of "near", so until the Knowledge Graph has embedded anything the graph shows an
Off card with an **Open Settings** button rather than drawing a map that would imply a meaning it
does not have. Switching the Knowledge Graph off later keeps the map it already drew.

Like the Agent Monitor and Usage Stats, it detaches into its own window from the pop-out control in
its header.

### Prior work on a task

The map is somewhere you go. This is the same recall coming to you: open a task and, if the index
holds earlier conversations near it, a line appears under the description reading
**"3 earlier conversations about this"**. Expand it to see them, click one to open its transcript.

The task's own title and description are the query, so there is nothing to type, and the task's own
history is excluded (that is already one click away in the header). When there is no earlier work
near a task, nothing is shown at all.

## Agent Monitor

Open the monitor from the activity icon in the title bar or with `Mod+Shift+M`. It answers "what are all my agents doing right now?" in one place, across **every** registered project rather than just the one whose board is open. The title-bar icon itself is the ambient signal: green while any agent anywhere is working, amber the moment one starts waiting on you.

Each session shows its owning project and column, the task title and ticket number, live activity state, agent, model, effort and permission mode, how long it has been running, and what the agent is doing right now. Four tiles across the top count what needs you, what is active, what is paused, and how many projects have something live. The tiles follow the Projects filter, so a scoped view counts only the projects in view.

The slot under each card's title follows the same Card Preview setting as the board card (Settings > Task), and renders it the same way. A session with an agent on it shows what that agent is doing, in a shaded terminal panel: its latest message wrapped, or its recent messages one line each. When it has not said anything yet, or it is a Command Terminal with no task, that same panel carries a **live output peek** instead, the last few rendered lines of the session's terminal. The peek updates in place as the agent works (at most twice a second, and only when the visible text actually changes), so you can see what a session is saying without opening it. A paused or finished session shows the task description instead, as does every card when Card Preview is set to the task description. A Command Terminal has no task to describe, so it keeps its last output peek in both of those cases. The terminal panel is a fixed height whichever of the two it carries, so a card never resizes as messages land.

Command Terminals (`Mod+Shift+P`) appear here too. They are the one thing the board cannot show you - they belong to no task, so before now a Command Terminal left running in another project was invisible. Each is titled `Command Terminal N` (matching the number on its own window), draws a terminal-shaped activity glyph rather than the agent one, and names the **branch** it is working on where a task card names its column.

You choose how it looks, and the choice is remembered (including across a restart):

- **Layout** - cards (which reflow into 2 or 3 columns as the window widens), a dense sortable table, or a one-line-per-session list.
- **Grouping** - by status (Idle / Active / Paused / Recently finished) or by project. Rows are always sectioned, which is what keeps anything waiting on you at the top without you having to sort for it.
- **Sort** - Oldest or Newest, applied within each section. The table layout sorts by its own column headers instead.
- **Filters** - a project scope multi-select that narrows the whole view (list and tiles) to a chosen subset of projects; its pill reads "All projects" until narrowed (then e.g. "2 of 5 projects") and appears once more than one project has sessions, staying while narrowed - as long as any project has a session - so Clear is always reachable. Plus a text filter across title, project, column, agent, model, ticket number and labels, and a "Live only" toggle that drops paused and recently finished sessions.

Clicking a row opens that task's full detail - terminal included - **in the monitor**, so several agents across several projects can be watched and driven from one surface without leaving for another project's board. Right-click a row and choose **Open on board** for the old behavior. A task's detail is only ever open in one place: opening it somewhere else moves it rather than making a second copy, and its tab leaves the bottom panel while it is open.

Clicking empty space anywhere in the monitor - its list, header, summary cards, or filter bar - closes a detail open there, following your [Close on Outside Click](#behavior-settings) setting. It is scoped to the monitor, so it never reaches through to a task window open on the board underneath.

The pop-out button detaches the monitor into its own window, which is the intended way to keep it on a second monitor. The detached window lays out by its own width, so it stays readable narrow while the in-app view fills a wide screen.

Whatever you have open in the monitor follows it. Detaching carries your open details into the pop-out, closing the pop-out hands them back to the in-app monitor, and the arrangement survives a restart - the same way board and Command Terminal layouts do. Nothing stays running in the background: closing the monitor unmounts its terminals (the agents keep working, and their tabs return to the bottom panel), and reopening it restores what you had.

Two things are deliberately left out of that restore, because the monitor is for watching agents that are still working: a task you have since opened on the board stays where it is rather than being pulled back in, and a detail whose agent has finished is not reopened. You can still click a finished session's row to look at it; it just will not come back on its own.

## Keyboard Shortcuts

Every shortcut is declared in a central registry, and nearly all are **rebindable** under Settings > Hotkeys, where each can be bound to a key chord or a mouse button (middle or side buttons). Hotkeys also flags conflicts and combos already claimed by the OS or another app. The description-editor keys below are the exception: they are **fixed**, because they are the platform conventions for text formatting. Fixed keys are still listed in Hotkeys for reference, just not editable. `Mod` below is Cmd on macOS and Ctrl on every other platform.

General:

- **Mod+Shift+S** - Toggle the settings panel
- **Mod+Shift+U** - Toggle the Usage Stats dashboard
- **Mod+Shift+A** - Toggle the Knowledge Graph (a map of what this project's conversation index has learned)
- **Mod+Shift+M** - Toggle the Agent Monitor (every running agent, across all projects)
- **Mod+Shift+B** - Switch between Board and Backlog view
- **Mod+Shift+E** - Toggle the project sidebar
- **Mod+Shift+J** - Toggle the bottom terminal panel
- **Mod+Shift+P** - Toggle the Command Terminal window
- **Mod+Shift+F** - Open Quick Find (cross-project search palette)
- **Mod+F** - Find on board (focuses board search; opens Quick Find when not on the board)
- **Mod+N** - New Task on the board
- **Escape** - Close any open dialog or the search palette

Task detail (whichever panel is open):

- **Mod+Shift+M** - Maximize the command terminal, the task detail dialog (view or edit mode), or a create dialog (New Task / New Backlog Task)
- **Mod+Shift+W** - Close the command terminal, the task detail dialog, or a create dialog (New Task / New Backlog Task). Escape also closes any modal.
- **Mod+Shift+B** - Toggle the browser pane inside the task detail dialog
- **Mod+Shift+G** - Toggle the changes (diff) panel inside the task detail dialog
- **Mod+Shift+K** - Toggle the description panel inside the task detail dialog
- **Alt+Shift+Left** / **Alt+Shift+Right** - Move the open task one column left / right without closing its window. Stops at the first and last board columns; Done is never a target. Column automations and move confirmations apply exactly as they do for the kebab's "Move to"
- **Middle-click the window header** - Close a modeless task-detail window (default `Mouse:Middle`; routes through the same unsaved-edits guard as the close button)

Description editor (mounts in task detail and in the New Task / New Backlog Task dialogs). All four are fixed, not rebindable:

- **Mod+B** - Wrap the selected text in bold markdown
- **Mod+I** - Wrap the selected text in italic markdown
- **Mod+K** - Wrap the selected text in a markdown link
- **Mod+Shift+V** - Paste without converting pasted HTML to markdown. Not listed in Settings > Hotkeys, since no app lets you rebind it

Windows (modeless task-detail windows):

- **Mod+Shift+Left** / **Mod+Shift+Right** - Snap the focused window to the left / right half of the board area
- **Mod+Shift+Up** / **Mod+Shift+Down** - Stateful snap: Up maximizes a floating window and moves a half-snapped one to its top corner; Down restores a maximized window and moves a half-snapped one to its bottom corner
- **Drag by the header** - Wherever your cursor goes decides what happens: run it into the left, right or bottom edge of the board area to snap that half, into the top edge to maximize, or over another window to tile beside it. Over a window, the left and right thirds dock to that side at any height, and the middle third docks above or below depending on which half of the window you point at. Dragging onto another window only tiles once you have moved a fair distance, so a nudge just repositions; the screen edges arm as soon as the cursor reaches them.
- **Escape while dragging** - Abandon the drag: the window returns to where it started and nothing docks

Terminal:

- **Mod+C** / **Mod+Shift+C** - Copy selected text, stripping quote-bar decoration from any decorated lines (with no selection, Ctrl+C cancels the running command)
- **Mod+V** / **Mod+Shift+V** - Paste text or an image into the terminal
- Standard OS shortcuts for the rest of terminal editing

## Tips

- **Plan mode workflow:** Use a Planning column with `permission_mode='plan'` and `plan_exit_target_id` pointing to your Executing column. The agent plans first, then auto-moves to execution.
- **Column messages:** Add a **Send message to agent** automation on a Code Review column to automatically ask the agent to review its own code when tasks arrive. Prose works: "Review the diff on this branch and fix what you would change."
- **Concurrent agents:** Increase `maxConcurrentSessions` to run more agents in parallel. Each needs its own worktree to avoid conflicts.
- **Resume from Done:** Unarchive a completed task and drag it back to an active column. Kangentic recreates the worktree from the preserved branch on the fly, and the agent picks up exactly where it left off.
