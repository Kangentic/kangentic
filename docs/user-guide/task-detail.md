---
type: Guide
title: Task detail and terminal panel
description: "The bottom terminal panel (session tabs and indicators, Activity tab, image paste, file drop) and the task detail dialog: header pills, kebab menu, Close on Outside Click, the Changes panel (History graph, scopes, image diffs, per-file windows) and the Browser pane."
tags: [terminal, dialog, changes, diff, browser]
sources:
  - resource: src/renderer/components/terminal/TerminalPanel.tsx
  - resource: src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx
  - resource: src/renderer/components/dialogs/task-detail/changes/
---
# Task detail and terminal panel

## Terminal Panel

The bottom panel shows terminal output for running sessions.

### Session Tabs

Each running session gets a tab. Click a tab to switch between sessions. The active tab is highlighted. Double-click a tab to open the corresponding task detail dialog.

Opening a task's detail moves its terminal out of the panel, so that tab disappears while the detail is open - on the board and in the [Agent Monitor](agent-monitor.md#agent-monitor) alike. The other tabs stay where they are. Close the detail and the tab comes back, still selected. When the last tab goes because its detail is open, the panel closes completely and the board takes its space. It comes back when you close the detail.

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
- Open the task's transcript in the read-only [conversation viewer](knowledge-graph.md#the-conversation-viewer) via the **View conversation** pill (speech-bubble icon). Muted until the task has session history, live or historical. A task opened from the Agent Monitor has no View conversation, since the viewer opens on the board.
- See the **pull request pill** in the header once a PR is linked, carrying its number and merge readiness (`ready`, `blocked`, `conflicting`, `queued`, `running`, or `unknown`). `ready` means clicking Merge right now would succeed, which is a stronger claim than "no conflicts". The same pill appears on the task card. See [PR Integration](../integrations/pull-requests/connector-model.md#merge-readiness) for what each value promises and which Git settings change it.
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

The Changes tab in the task detail dialog is a read-only review surface split horizontally: a left rail (the changed-file list, with a collapsible **History** section pinned at its bottom) and the diff pane on the right, divided by a resizable divider. The rail sizes itself proportionally, so expanding the panel widens filenames instead of leaving a narrow rail stranded in a wide window; drag the divider to override that, and double-click it to go back to the default. In a narrow panel the rail gives up width first, so the diff pane keeps at least 240px until the rail reaches its 160px floor.

The rail's **History** section is collapsed by default - its header row stays visible with a live commit count, so history is one click away without spending vertical space on it. Expanding it reveals a **pinned "Uncommitted changes" row** above the branch's commit graph (a visual DAG: commit nodes down a vertical axis, lane columns for parallel branches, and edges to each commit's parents). Each commit row shows the short SHA, subject, author, and relative time; the branch tip is marked `HEAD`, and the base branch and a linked pull request's head commit are marked with tone dots (hover for the full label). The graph reads git directly (no session required), refreshes live as you commit or the branch's refs change, and is capped at the most recent 200 commits with a note when older commits are trimmed. A history with several parallel lanes is cramped at rail width; pop the whole panel out into its own window to read it comfortably.

**Uncommitted changes** is selected by default and shows the branch-wide diff: the rail lists changed files with insertion/deletion counts in an aligned column and a checkbox to mark each one **viewed** (a viewed row dims, and the header keeps a running viewed/total count with a progress fill under it), a scope selector (working / staged / branch) picks which changes to diff, and a base-branch label shows whether the branch diverged from the default base or a custom one. Sort the list by name, status, size, or extension from the sort menu, and switch between the tree and a flat list; sorting a flat list by status groups it under status headings. Click a file to view a side-by-side or inline diff on the right. Toggle between split and inline view modes using the button in the toolbar. When there is nothing to review, the diff pane says so and names the scope it searched, so an empty **Working** view reads as "No uncommitted changes" rather than looking broken next to a History section full of commits.

**Selecting a commit** in the History section scopes the detail pane to that commit's own diff (`<oid>^..<oid>`) instead - a compact header at the top of the rail identifies the commit, with a back button that returns to Uncommitted changes.

Right-click a file in the tree for **View history**, a popover listing the commits that touched that file (`git log --follow`); selecting one jumps the detail pane to that commit.

The diff toolbar's **View options** menu collects the rendering choices as named, checkable items rather than icons you have to hover to identify: ignore whitespace, collapse unchanged regions, wrap long lines, and render inline when the pane is narrow. All four are app-wide preferences shared with **Settings > Changes**, and the menu's **Open settings** item jumps straight there. The same menu carries the **blame** toggle (off by default, per file, never remembered), which annotates each line of the modified editor with its short hash and author via a left-gutter column, with the full hash/author/date on hover. Blame reflects the file's current working-tree content, so it is unavailable while browsing a historical commit and in the **Staged** scope, and for binary or deleted files, which have no current content to annotate. The menu stays reachable even with no file selected, so you can set up how diffs render before there is anything to review.

Images open as pictures. A changed PNG, JPEG, GIF, WebP, BMP, ICO, or AVIF shows its old and new versions. An SVG opens on its text diff, and the eye button in the toolbar previews both versions as images; an SVG that `.gitattributes` marks binary opens straight into the images. A row under the images picks how to compare them: **Side by side** (it reads **Stacked** when the layout toggle is set to inline), **Slider** to drag a divider across the two, **Overlay** to fade one into the other, and **Diff** to paint the changed pixels over a faded copy of the new image and report what share of pixels changed. The choice holds while you step through files, and the next-change keys roll from one image to the next. A bar above that row lists each version's dimensions and file size, and dimensions that changed are highlighted. An added or deleted image shows its one version. A version over 10 MB shows its size instead of the picture, and a Git LFS pointer or data that is not an image is labeled as such. A version that could not be read says so, and Diff reports that it could not compare when the combined canvas holds more pixels than a 4096 by 4096 one (about 16.8 million).

**Double-click a file** (or pick **Open in new window** from its right-click menu) to detach that one file's diff into its own OS window - read it full-screen or on a second monitor, and open several files side by side to compare them (one window per file; double-clicking the same file again focuses its existing window). The window opens maximized by default; un-maximize for a floating window, and once you resize, move, or maximize one, that becomes how every later diff window opens. Up to 8 file windows can be open at once; opening a 9th shows a toast asking you to close one first. The window is read-only, follows your diff view options (split/inline, whitespace, collapse-unchanged, wrap long lines, inline-when-narrow), live-updates as the file changes, shows an empty state if the change is reverted while it is open, and closes with its own window controls or **Escape**. Available in every file list (Working / Staged / Branch and a commit's files) except the Command Terminal's Changes view, which has no task to scope the window to.

The panel persists its expanded/collapsed state, selected file, selected commit, the diff scope, which files you have marked viewed, whether the rail's History section is expanded, and the divider positions across dialog reopens. Those are per-task; the View options above are app-wide.

Each file also remembers where you had scrolled it. Open a file for the first time and it opens centred on its first change; leave it and come back and it returns to where you left off. That memory is per task and per diff scope, and it is held in memory rather than in the database, so it lasts as long as the app is running and a restart puts every file back on its first change.

The whole panel can also detach into its own OS window - click the pop-out icon in its header - not just a single file's diff. Unlike the properties above, this is not preserved through a close: while the window is open the header pill still reads **Hide changes**, but closing the window leaves the panel closed instead of restoring it inline; click **Show changes** again to reopen it.

The Changes panel is available for all tasks, whether or not worktrees are enabled. It uses `git merge-base` to show only branch-specific changes, excluding upstream commits. When the commit git recorded as the branch's starting point is newer, the panel diffs from that instead. That keeps a branch cut before the base branch's history was rewritten from showing the rewritten history as its own changes. The same fork point measures the lines and files a task changed.

When the dialog is open, it claims the terminal session and the bottom panel drops that task's tab. Any other running session keeps its tab and its live terminal; the panel only collapses once nothing is left in it. Closing the dialog returns the tab, still selected.

### Browser Pane

Tasks can host an embedded browser inside the task detail dialog. Use it to preview your dev server, capture screenshots with annotations, and submit framed prompts back to the agent without leaving Kangentic. Each task gets its own persistent webview partition (cookie jar), so two tasks logged into dev servers on the same localhost host don't clobber each other's sessions. Non-localhost logins are shared: signing into an identity provider (Google, GitHub, your SSO) in one task's pane carries to the project's other tasks through a per-project identity jar, so you sign in once per project rather than once per task. Holding two different accounts at the same provider across tasks at the same time is unsupported; the Clear Browser Data action wipes every jar, identity included.

Settings > Browser turns the pane on or off for a project and holds the project's default URL, which is saved the first time you navigate the pane. Clear browser data is there too.

Agents can drive the pane themselves through the `kangentic_browser_*` MCP tools (navigate, screenshot, DOM queries, click, type, eval), governed by the [Agent Browser](settings.md#agent-browser) settings tab. An agent can also open and close its own task's pane rather than waiting for you to do it, which means it may open that task's detail window on its own if none is open.

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

## Completed task view

Clicking a completed task opens the completed task view. A strip under the title reads when the task started (its first move out of To Do) and ended (its move into Done), the elapsed time between them, the agent runtime (how long an agent was working on it, summed over every conversation), the lines and files it changed, its pull request, and its cost, then Completed, or Exited with the code when the agent's last run ended with an error. The strip stays on one row: on a narrow window the dates drop their time first, then the status keeps only its icon. Under it are three tabs, Summary, Usage and Description, and View conversation on the right; the arrow keys, Home and End move between tabs.

- **Summary** shows the task summary when the Knowledge Graph has written one. Otherwise it says why, with an Open Settings button where a setting is the reason: pending, what summaries still need (an agent, or its model), Task summaries off, or indexing off. The agent's last message shows in its place. Route draws each column the task worked in, in board order and sized to its time there, and a column it came back to with two or more stays of a minute or more lists each stay with its date. Click a column to open the [conversation viewer](knowledge-graph.md#the-conversation-viewer) on that column's part of the conversation, or a stay to open it at that stay. A task opened from the Agent Monitor has no such buttons, since the viewer opens on the board. Commits and Files changed list what the Knowledge Graph linked to the task, eight files at a time.
- **Usage** has three cards. Runs lists each run of an agent in the order they started, with the columns it ran in, its conversation as a short ID, when it started, its model, effort and permission mode, its compactions, and its own runtime and cost. Two runs with the same ID continue one conversation, and an isolated column such as Code Review has its own, its ID led by the split icon that marks an isolated session everywhere; click an ID to copy it in full. A resumed conversation reports a running total, so each run shows only what it added and the Total matches the strip. A run whose agent exited with an error is marked beside its start time, since the strip's status reads only the last run. Models and tokens lists each model's turns and its fresh input, cache write, cache read and output tokens, with subagent work on its own row; with indexing off it falls back to each model's input and output from the session totals. Background calls lists each automation a condition check was asked about, one row per automation, and each call with no automation behind it (a title, a task summary, a terminal name), with its column, model, effort, runtime, cost and tokens, ten rows at a time. Its Outcome reads Ran when the automation ran, Skipped when its condition was not met or a later gate stopped it, and Error when the automation failed or was interrupted, or the check never answered; hover the Outcome for the reason. One check can answer several automations, so the Total counts each call once. A failed check that repeats later in the same visit adds no row. Click a header in any of the three cards to sort by it: a right-aligned number starts highest first, and text or a date starts A to Z or oldest first, a second click flips it, and a third returns the card's own order. Shift+Click adds a tie-break. A row with no value sorts last, and the Total stays at the bottom.
- **Description** is the task's description, labels and attachments.

Each run's tool call count opens a table that breaks its calls down per tool name, and the Total's opens the same table for the whole task, so its rows add up to the tool call count: Calls, then Time and Avg when durations were measured, Tokens when the agent can estimate them from its transcript, and a Failed column when any tool was interrupted. Time is each tool's own run time. Calls that waited for your answer or approval are left out of Time and Avg, and the Time header's tooltip says how many. Tokens estimates how much of the conversation each tool's output took up; it is not billed usage, and today only Claude provides it. Every column except Failed sorts on click, and the default is Calls, most first. The tool-call count in a running task's context bar opens the same table for that session. It counts every run of the session, so it does not drop to 0 when the session resumes after an app restart or a pause. A Code Review column that runs in its own session keeps its own count. Tokens for a run that ended when the app quit are filled in from the agent's transcript after the session resumes. Cost / input / output columns appear only for adapters that emit per-tool telemetry. The Done column also supports searching completed tasks by title and sorting by date, cost, tokens, or agent runtime.

Changes come from git on your machine, with or without a pull request: each time a session ends, Kangentic measures the task's branch against where it left its base. Once the pull request is merged, or the task is archived with a measurement already stored, it keeps that measurement, so a branch reset after the work landed does not overwrite it.
