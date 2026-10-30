# User guide

## Getting started

* [Product overview](overview.md) - What Kangentic is and is not, the problem it solves, each feature in a paragraph (multi-agent handoff, backlog import, search palette, worktrees, session persistence, themes), the six-step board workflow, the tech stack and the target audience.
* [Installation](installation.md) - Installing Kangentic with npx kangentic or a native installer (NSIS, DMG, deb, rpm), prerequisites, the Intel Mac Knowledge Graph gap, SmartScreen, the Windows install-folder icacls grant for a launch that closes at once, macOS Gatekeeper, uninstalling, and --data-dir or KANGENTIC_DATA_DIR.
* [Board basics](board-basics.md) - First launch and the welcome screen, the seven default columns, the Quick Find search palette (Ctrl+Shift+F, #42 ticket search) and filter popover, kangentic.json team sharing, the project sidebar, announcements, the status bar and the npx kangentic CLI.

## Working with tasks

* [Tasks](tasks.md) - The task lifecycle: the New Task dialog (Column Settings or Agent Override, Board Profiles, model and effort pins, pasted images), what spawning, moving between active columns, Done and Return to To Do each do to the session and worktree, the card context menu, and the completed task view.
* [Task detail and terminal panel](task-detail.md) - The bottom terminal panel (session tabs and indicators, Activity tab, image paste, file drop), the task detail dialog's header pills, kebab menu and Close on Outside Click, the Changes panel (History graph, scopes, image diffs, per-file windows), the Browser pane, and a completed task's Summary, Changes, Conversation and Usage tabs.
* [Backlog](backlog.md) - The backlog staging view: creating and editing items, labels and the priority scale, filtering, bulk Move to Board, drag reorder, and Import, which pulls GitHub Issues, GitHub Projects and Azure DevOps items through the gh and az CLIs with incremental sync and duplicate detection.

## Automating the board

* [Columns and automations](columns-and-automations.md) - Editing a column in the Column Manager (agent, model, effort and permission overrides, Plan approval, After Plan Mode, Isolated session) and its automations: the five types, the enter, turn end and exit triggers, Condition and Frequency, Run again, and Pause automations per task.
* [Workflows](workflows.md) - How linked tasks run on their own: the Workflows view (Mod+Shift+L) with its canvas and inspector, the workflow agent pane, planning and Start, blockers and per-task routes, Plan approval, how a task moves on, working one task by hand, card strips and links, why running workflow cards are locked, and what Pause and Resume do.

## Agents and sessions

* [Sessions and worktrees](sessions-and-worktrees.md) - Where an agent runs and how its session survives: per-task git worktrees versus the project folder, branch naming and base branch order, the FIFO session queue, resume after restart and user-paused sessions, and pausing idle agents when memory is low or after an idle timer.
* [Command Terminal](command-terminal.md) - The Command Terminal panel (Ctrl+Shift+P): opening, hiding versus stopping, up to four tiled terminals per project, expand and swap, resuming earlier conversations, its own window, the branch picker, why a terminal ends with its agent, phone-started terminals, and what survives a project switch.
* [Agent Monitor and usage stats](agent-monitor.md) - The Agent Monitor (Mod+Shift+M) that watches every agent across all projects, with card, table and list layouts, grouping, filters, live output peek and in-place task detail, plus the Usage Stats dashboard (Mod+Shift+U) with cost and token metrics, ranges and background calls.
* [Conversation memory and Knowledge Graph](knowledge-graph.md) - The on-device conversation index (keyword and semantic search, the conversation viewer with column tabs) and the Knowledge Graph map (Mod+Shift+A): flying the 3D map, colour modes, filters, asking questions, Index card sources, task summaries, source code indexing, and Prior work on a task.

## Settings and help

* [Settings](settings.md) - Every Settings tab in the unified panel: project tabs (General with Move project, Theme, Agent, Git worktree and PR settings, Browser, Shortcuts) and shared tabs (Language, Board, Task, Changes, Terminal, Behavior, Performance, Hotkeys, Notifications, Workflows, Dictation, Knowledge Graph, MCP Server, Agent Browser, Mobile Devices, Privacy, Developer).
* [Keyboard shortcuts](keyboard-shortcuts.md) - Every default shortcut by area (general toggles, terminal and project cycling, task detail, description editor, window snapping and dragging, terminal copy and paste), which ones are rebindable in Settings > Hotkeys, and which are fixed.
* [Troubleshooting](troubleshooting.md) - Two failures after install: the window vanishing with no crash dialog when the Chromium graphics process fails (Kangentic turns off Graphics acceleration, gpu-process-gone crash records), and the Windows Low on memory warning (commit limit, page file size, Max Concurrent Sessions).
