---
type: Guide
title: Tasks
description: "The task lifecycle: the New Task dialog (Column Settings or Agent Override, Board Profiles, model and effort pins, pasted images), what spawning, moving between active columns, Done and Return to To Do each do to the session and worktree, the card context menu, and the completed task view."
tags: [tasks, lifecycle, profiles, done]
sources:
  - resource: src/renderer/components/dialogs/NewTaskDialog.tsx
  - resource: src/renderer/components/board/TaskContextMenu.tsx
  - resource: src/renderer/components/dialogs/task-detail/completed/
---
# Tasks

## Create a Task

Click the **+** button on any column header, or **New Task** in the backlog toolbar. Enter a title and optional description. A **Name from prompt** button beside the title suggests one from the description, and a task still carrying a placeholder title such as `fix` is renamed for you the first time its agent stops for you after its first 30 seconds, with a Task renamed toast. Both work only when an Automation agent is set up in Settings > Workflows. You can set a priority level, add labels, and attach files (images, documents, or any file type) by pasting from the clipboard or dragging files onto the dialog. Attachments are included in the agent's prompt.

Pasted screenshots are capped at a 2000px long edge, which bounds a multi-monitor grab without costing the detail an agent needs to read small text. Oversized pastes are re-encoded as WebP, stepping quality down until each image lands under a ~1.5MB target, so a large grab is not rejected by the API. Small pastes (under 500KB), GIFs, SVGs, and PNGs already inside the cap are attached as-is.

In the description field, type `@` to trigger file autocomplete. A dropdown lists files and directories from the project root, which you can navigate with arrow keys and select with Enter to insert the path.

### How this task runs: Column Settings or Agent Override

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
[Board Profiles](../integrations/mcp-server/profile-tools.md#board-profiles).

Before the first spawn, the task detail dialog also shows a slim **pre-spawn context bar** with the same Model and Effort pills. Set them there to avoid the spawn -> cancel -> restart loop: the picker writes the override to the DB, and `prepare-spawn` picks it up on the next agent launch.

The Model popover on both bars leads with the same **Latest** group when the agent offers aliases, then a collapsed **Specific versions** section.

When an agent is already running, the same Model / Effort pills appear in the live context bar below the terminal. Picking a value there restarts the session: Kangentic suspends it and resumes it with the new `--model` or `--effort` launch flag, so the change interrupts the turn in progress. The Command Terminal's context bar is the exception and switches live.

## Spawn an Agent

Drag a task from To Do to any active column (Planning, Executing, etc.). Kangentic will:

1. Create a git worktree for the task (if worktrees are enabled). Otherwise the agent runs in the project folder, and the task detail says so - see [Worktrees](sessions-and-worktrees.md#worktrees)
2. Spawn an agent CLI session with the task title and description as the prompt
3. The task card shows a spinner while the agent is thinking

A move out of To Do is the only kind of move that sends the task itself to the agent: the title,
description, and any attachment paths become the opening prompt (the seeded template
`{{task_xml}}{{workflow_xml}}{{attachments}}`, where `{{workflow_xml}}` is empty outside a workflow). A move between two active columns resumes the same
conversation - the description is not sent again, and the destination column's **Send message to
agent** automation, if it has one, is the only new instruction the agent receives.
Moving a task back to To Do kills its session, so moving it out again starts a fresh
conversation and sends the task once more.

## Monitor Progress

- **Terminal panel** at the bottom shows the active session's terminal output
- **Activity tab** shows structured events (tool calls, idle state) instead of raw terminal output
- **Context bar** below the terminal shows session metadata (shell, model, cost, tokens, context usage). Each element is configurable.
- **Task card status** - each card shows a contextual status bar at the bottom:
  - A spinning indicator and model name with context percentage when the agent is actively working
  - An amber mark when the agent is waiting on you, shaped by why: an envelope when it finished its turn, a speech bubble when it asked you a question (or did not say what it waits for), and a crested shield when it wants a tool or a plan approved. Hover it for how long ("Asking you a question for 2m"). The sidebar keeps one amber count for all three
  - "Starting agent..." or "Resuming agent..." during session startup
  - An agent whose CLI streams no live telemetry shows its adapter's own label in place of that spinner (for example "Telemetry: TUI only"; see `liveTelemetryUnsupported` in [Optional adapter properties](../integrations/agents/optional-properties.md))
  - "Queued..." when waiting for a concurrency slot
  - "Paused" when manually suspended
  - A pull request pill once the task has a linked PR, showing its number and merge readiness (`ready`, `blocked`, `conflicting`, `queued`, `running`, or `unknown`). The same pill appears in the task detail header. See [PR connector model](../integrations/pull-requests/connector-model.md#merge-readiness) for what each value promises and which settings change it
- **Shimmer overlay** - when a session is starting or resuming (e.g., after a column move that runs the destination's automations), a shimmer loading overlay appears over the terminal. It shows a context-aware label such as the running automation's name, "Resuming agent...", or "Starting agent...". Terminal output is suppressed behind the overlay until the session is ready.

## Move Between Active Columns

Dragging between active columns (e.g., Executing to Code Review) keeps the session alive. If the target column has a **Send message to agent** automation (e.g., `/code-review`), it is typed straight into the running agent as keystrokes - no suspend, no restart. A suspend and respawn happens only when the move needs one for its own reasons (the destination changes the model or effort); in that case the message rides along as the resume prompt instead. An agent whose resume takes no prompt gets it typed in once it is back. The source column's exit automations run first, while its session is still attached, and the destination's remaining enter automations run after the move lands.

While you drag a card into another column, the cards there part at the slot it would take, and a dimmed copy of the card holds that slot. Releasing the card places it at that slot. A card dragged out of Done onto a column is restored to the same slot.

The agent keeps its conversation across these moves; the message is the only new input it sees. A new project has no messages configured, so by default these moves simply carry the session along.

Each column chooses WHEN its message arrives via **Message timing**: `immediate` sends it on arrival (the agent queues it if mid-turn), while `deferred` holds it until the current turn genuinely finishes.

A message for a column that runs no agent is held until the task's next agent starts, and it is dropped if the task moves to Done. A move to To Do clears what is held.

**From the keyboard.** Tab to a card, press Space to pick it up, move it with the arrow keys, and press Space again to drop it; Escape puts it back. The pickup only arms from a Tab-placed focus: a card you clicked or dragged with the mouse stays put on Space and Enter, and a picked-up card is released the moment you click anywhere or focus lands in a terminal. The same keys reorder columns (from the grip in the column header), backlog rows, Column Manager rows, priorities, and shortcuts.

## Complete a Task

Drag to Done. The worktree directory is moved aside at once and its files are deleted in the background to reclaim disk, never while another task's setup script runs. The session is suspended (not destroyed), the task is archived, and the conversation ID is preserved. The branch is deleted too when **git.autoCleanup** is on (the default) and kept when it is off. A clean move happens silently; a confirmation dialog appears only when the move would destroy real work - uncommitted files, or commits that exist only on the local branch about to be deleted - and it spells out exactly what is at risk (worktree deleted, branch kept or deleted, session history kept). If you later unarchive the task and drag it to an active column, Kangentic recreates the worktree and the agent resumes with full conversation context.

Anything the task's agent left running in its folder, such as a dev server it started in the background, is stopped before the worktree is removed. When that happens a toast gives the counts, and a click on it lists each process with a **Stop** button for any that kept running: a window the agent opened, a tmux server, or a tool other work also uses (another task, or a command running in one of your terminals). A process that exits on its own after that reads **Ended** in the list, and the toast closes once nothing it named is still running. The same happens when a task returns to To Do or is deleted. Turn it off with [Stop Leftover Processes](settings.md#behavior-settings); the toast then lists what kept running and stops nothing.

Clicking a completed task opens the [completed task view](task-detail.md#completed-task-view): its timing, runtime, changes and cost, and its Summary, Changes, Conversation, Usage and Description tabs.

## Task Card Context Menu

Right-click any task card on the board to open a context menu with:
- **Copy Task ID** - copies the display ID (e.g., `#42`) to clipboard
- **Edit** - opens the task detail dialog in edit mode
- **Show changes** - the task's diff, when it has a worktree
- **Pause session** / **Resume session** - on any task with a running, queued, or paused session
  outside To Do. It does what the task window's header toggle does, with no window to open. A
  paused task in Done or an archived one keeps a disabled Resume row, with the reason as its
  tooltip; the header shows no toggle for it
- **Pause automations** / **Resume automations** - on any task, whatever its column or state (an
  archived task's menu does not offer it): holds the task out of every column's automations (see
  [Automations](columns-and-automations.md#automations)). On a workflow task it also holds the task
  out of its workflow while the rest runs (see [Workflows](workflows.md#workflows))
- **Open workflow** - on a task in a workflow (see [Workflows](workflows.md#workflows))
- **New workflow** - on a To Do task in no workflow: a new workflow with this task as its brief
- **Move to** - submenu listing all other columns as move targets
- **Backlog** - send the task back to the backlog (cleans up session and worktree)
- **Archive** - move the task to Done and archive it
- **Delete** - permanently delete the task, session, and worktree

The last group holds only the actions that take a task off the active board. Everything else that
acts on the task sits above the bottom divider, and Move to has its own section between the two
groups. On a task in a running workflow, Move to, Backlog and
Archive stay in the menu, disabled, with the reason as their tooltip.

An archived card, in the Done column or the Completed Tasks list, has a shorter menu: its task
ID, Open, View conversation, Show changes, Restore to (each column it can go back to), and
Delete, which asks first. View conversation and Show changes open the task's window on its
Conversation or Changes tab, on every archived task, since both read the task's record and git
rather than its worktree.

## Return to To Do

Drag to To Do to reset the task to "not started": the session is killed and its history wiped, what its agent left running is stopped (see [Complete a Task](#complete-a-task)), and the worktree is removed (the branch too, when **git.autoCleanup** is on). A task that did its own work also drops its PR link, so the next run links its own PR. A PR link you typed onto a task that never started stays. When the reset would destroy pending changes, a confirmation dialog warns that the worktree and session history will be lost before anything happens. If you drag back to an active column, a fresh session starts in a fresh worktree.
