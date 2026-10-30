---
type: Guide
title: Board basics
description: "First launch and the welcome screen, the seven default columns, the Quick Find search palette (Ctrl+Shift+F, #42 ticket search) and filter popover, kangentic.json team sharing, the project sidebar, announcements, the status bar and the npx kangentic CLI."
tags: [board, sidebar, search, columns]
sources:
  - resource: src/renderer/components/layout/WelcomeScreen.tsx
  - resource: src/renderer/components/search/SearchPalette.tsx
  - resource: src/renderer/components/FilterPopover.tsx
  - resource: src/renderer/components/sidebar/ProjectSidebar.tsx
  - resource: src/renderer/components/sidebar/project-sidebar/sidebar-project-order.ts
  - resource: src/renderer/components/sidebar/project-sidebar/useSidebarDragDrop.ts
---
# Board basics

The board is where tasks live: columns, filtering, the board files a team shares, the sidebar of
projects, the CLI and the status bar. Tasks themselves are in [Tasks](tasks.md).

## First Launch

When you first open Kangentic with no existing projects, a welcome screen greets you with an **Open a Project** button. Click it to select a project folder and get started.

The welcome screen also detects Git and your installed agent CLIs, showing each one's version, or an install link when it is missing and a login command when it is found but unauthenticated. Two links in the footer open in your browser: **Read the setup guide** and **Pair a phone**, the latter covering the mobile companion app (see [Mobile bridge overview](../integrations/mobile-bridge/overview.md)).

On subsequent launches, Kangentic automatically re-opens the last activated project so you pick up right where you left off. If you launch with the `--cwd` flag, that path takes priority.

When a project is opened, Kangentic initializes a `.kangentic/` directory inside the project folder (auto-added to `.gitignore`) and creates a board with default columns.

## Default Columns

New projects start with seven columns:

| Column | Role | Behavior |
|--------|------|----------|
| **To Do** | todo | Holding area. No agent runs here. Moving a task here kills its session and removes its worktree. A task that did its own work also loses its PR link. |
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
**Send message to agent** row; see [Automations](columns-and-automations.md#automations).

## Board Filtering

The board supports filtering to help you focus on relevant tasks across all columns.

### Search Palette

Press **Ctrl+Shift+F** (Cmd+Shift+F on macOS) or **Ctrl+F** (Cmd+F) to open the global search palette. The same overlay is also reachable from the search icon in the title bar. The palette searches across:

- Tasks (active and archived) by title and description
- Backlog items by title and description
- Session events (tool calls, agent activity from `events.jsonl`)
- Registered projects by name and path
- Past agent conversations, by the words in them - see [Conversation Memory](knowledge-graph.md#conversation-memory)

Quick Find matches words only, and it is instant: it starts no embedding model. Its last row, **Ask the Knowledge Graph: "what you typed"**, hands the query to the [Knowledge Graph](knowledge-graph.md#knowledge-graph), which answers by meaning. A typed question usually has no keyword matches, and then that row is selected, so Enter asks it.

Type `#<number>` (e.g. `#42`) to search by **ticket number**: the palette matches tasks whose display ID (`#N`) prefix-matches the number (`#4` matches #4, #40, #41, ...) and shows only those, skipping the other result kinds. The board search box (Ctrl+F on the board) accepts the same `#<number>` syntax to filter the board by ticket number.

Default scope is the current project; toggle to **All projects** to widen the search across every registered project. Selecting a hit jumps to the right place: tasks open the detail dialog, session events scroll the Activity Log to the matched event with a brief highlight, backlog hits switch to the backlog view and open the item's edit dialog, project hits switch projects, and conversation hits open the read-only [conversation viewer](knowledge-graph.md#the-conversation-viewer) scrolled to the matched turn (or route to the live terminal if that session is still running).

### Filter Popover

Click the filter icon at the top right of the board to open the filter popover. Filter by:
- **Priority** - toggle one or more priority levels (None, Low, Medium, High, Urgent)
- **Labels** - toggle one or more labels from the project's label set

While filters are active, the Filter button shows how many, right after its label. Click "Clear all filters" at the bottom of the popover to reset. Priority and label filters combine with the search query - a task must match all active criteria to be visible.

## Board Configuration

Kangentic can export your board layout to a `kangentic.json` file in the project root. Commit this file to git so your team shares the same column structure, actions, and transitions.

### Sharing with Your Team

When you open a project, Kangentic automatically writes `kangentic.json` with the current board state. Commit and push this file. When teammates pull it, Kangentic detects the change and shows a banner offering to apply the new configuration.

The sync runs both ways. Opening a project also reads an existing `kangentic.json` back INTO your database first, before that write - so editing the file by hand is a genuine way to change the board, not just a record of it. That read happens with no banner and no prompt, and the file wins where the two disagree. A file that cannot be read, such as one with git merge conflict markers, is never overwritten: the board loads from the database and a banner says the file needs fixing. See [Board Config Sync](../settings/board-config.md#board-config-sync-kangenticjson) for the full rules.

### Personal Overrides

Create a `kangentic.local.json` in the project root for personal customizations (column colors, icons, extra columns). This file is auto-added to `.gitignore` and merges on top of the team config.

### Applying Changes

When `kangentic.json` or `kangentic.local.json` changes on disk, a reconciliation banner appears at the top of the board. Click "Apply" to reconcile the file into your database, or dismiss to ignore. Enable Auto-apply board config changes in the Board settings tab to apply changes automatically instead.

If a teammate removes a column that still has your tasks, the column becomes a "ghost" (hidden but preserved). Once you move all tasks out of the ghost column, it is automatically deleted.

## Sidebar

### Multi-Project

The sidebar shows all your projects. Click to switch between them. Each project has its own board, columns, and sessions. Drag projects to reorder them. The order persists across app restarts. New projects appear at the top.

The selected project shows action buttons (Open, Settings, Delete) directly on the row. Right-click any project to open a context menu with Rename, Open in Explorer, Project Settings, and Delete. Inline rename is supported via the context menu - press Enter to save, Escape to cancel.

If a project's folder is moved or renamed while Kangentic is closed, opening it shows a "Project Folder Not Found" dialog with a "Locate Folder..." button to re-point the project at its new location. To relocate proactively, Project Settings > General > **Move...** has Kangentic move the folder itself (see [Moving a project](settings.md#moving-a-project)). Because tasks and board history are keyed by project id, they are preserved across a relocation. Each agent's session data and per-project settings that live outside the project folder keyed by the old path (Claude transcripts, Codex/Gemini/Qwen trust and chats, OpenCode's session DB, Kimi/Droid session dirs, Copilot workspaces) are migrated automatically, so suspended sessions still resume at the new location. See [Project relocation](../integrations/agents/project-relocation.md#project-relocation) for the per-agent details.

### Idle Badges

When an agent goes idle (waiting for input or stopped) on a non-active project, the sidebar shows a badge. This helps you notice when agents need attention across projects.

### Command Terminal Indicator

Command Terminals keep running when you hide the layer and when you switch projects, so a project you are not looking at can still be holding live terminals. Each project row shows a terminal glyph and a count when it has any, alongside the agent idle/thinking counts, colored the same way as the title-bar toggle: green while a terminal is working, amber when one is waiting on you, muted when it is just sitting there. It sits next to the agent idle/thinking counts rather than merging with them, since a Command Terminal is not a task agent. Click it to switch to that project and reopen its terminals. When the sidebar is collapsed, the rail shows the same state as a small dot on the project's initial.

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
[In-App Announcements](../releases/announcements.md#in-app-announcements) for the feed
mechanics.

## CLI

Open a project directly from the terminal:

```bash
npx kangentic /path/to   # Open a specific project path
npx kangentic            # No path: reopen your last project
```

If the project doesn't exist yet, it's created automatically. Without a path, Kangentic reopens the project you last had active (or shows the welcome screen on a first run).

## Status Bar

The status bar runs along the bottom of the window, providing at-a-glance metrics for the current project.

| Element | Description |
|---------|-------------|
| **Agents** | Count of actively running agent sessions (green when > 0), plus queued count if any |
| **Tasks** | Count of active (non-done) tasks on the board |

## Tips

- **Plan mode workflow:** Use a Planning column with Permission Mode set to Plan and **After Plan Mode** pointing to your Executing column. The agent plans first, then auto-moves to execution when the plan is approved. Set **Plan approval** to Automatic to have Kangentic approve each plan, so the task moves on without waiting for you. With it, MCP tools your Claude allow rules name also run while the agent plans, without a prompt.
- **Column messages:** Add a **Send message to agent** automation on a Code Review column to automatically ask the agent to review its own code when tasks arrive. Prose works: "Review the diff on this branch and fix what you would change."
- **Concurrent agents:** Increase `maxConcurrentSessions` to run more agents in parallel. Each needs its own worktree to avoid conflicts.
- **Resume from Done:** Unarchive a completed task and drag it back to an active column. Kangentic recreates the worktree from the preserved branch on the fly, and the agent picks up exactly where it left off. If the agent deleted that conversation in the meantime, it starts a new one from a recap instead (see [Session Persistence](sessions-and-worktrees.md#session-persistence)).
