---
type: Guide
title: Sessions and worktrees
description: "Where an agent runs and how its session survives: per-task git worktrees versus the project folder, branch naming and base branch order, the FIFO session queue, resume after restart and user-paused sessions, and pausing idle agents when memory is low or after an idle timer."
tags: [sessions, worktrees, queue, resume, pausing]
sources:
  - resource: src/main/git/worktree-manager.ts
  - resource: src/main/pty/session-queue.ts
  - resource: src/main/diagnostics/low-memory-agent-pauser.ts
  - resource: src/main/diagnostics/idle-agent-pause.ts
---
# Sessions and worktrees

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

The limit counts agents, not memory. On Windows each running agent reserves about 1 GB of commit, so a high limit can run the machine short before it fills. See [Low memory warning](troubleshooting.md#low-memory-warning-windows).

## Session Persistence

Sessions survive app restarts. When you close Kangentic:

1. All running sessions are marked as `suspended` in the database
2. PTY processes are closed or force-killed. Claude Code on Windows and Linux is closed the way a terminal window closes, and it exits on its own, so its SessionEnd hook runs and its transcript is written. On macOS and for other agents, a session still in its first moments after spawn gets a brief grace first (its exit command, then the force-kill about 1.5 s later) so the agent's own startup bookkeeping is not cut off mid-boot
3. On next launch, sessions are automatically resumed via `--resume` using the saved session ID

Because Claude Code supports `--resume`, conversation context is fully preserved even when a session is killed rather than exited. If the app crashes, orphaned sessions are detected and recovered on the next launch.

If Claude Code has already deleted a conversation (it removes transcripts older than its `cleanupPeriodDays`), the resume starts a new conversation from a recap of the old one instead, and an info toast says so.

### User-Paused Sessions

Sessions paused manually by the user (via the pause button in the task detail dialog or its kebab menu, the Pause session row in a task's right-click menu, or from a paired phone; see [Capability verbs](../integrations/mobile-bridge/capability-verbs.md)) are remembered across restarts. On relaunch, user-paused sessions remain paused instead of auto-resuming. This respects user intent. If you paused an agent, it will not start back up on its own. An agent Kangentic paused for you, for low memory or the idle timer (see [Pausing agents](#pausing-agents)), stays paused the same way. Only system-suspended sessions (those suspended by shutdown or column moves) auto-resume.

## Pausing agents

An agent waiting on you holds all the memory it reserved: about 1 GB for each Claude Code agent on
Windows. Kangentic can pause one for you, two ways, both in Settings > Performance > Pausing agents.

**When memory runs low** (on by default). Once a minute, while memory is low, Kangentic pauses the
agent that has waited on you longest, then reads memory again before the next. It stops once there
is room. Each platform reads its own signal:

- **Windows:** the room left under the commit limit, the same figure the
  [low memory warning](troubleshooting.md#low-memory-warning-windows) reads. Low starts at the warning's line and ends
  at twice it.
- **Linux:** free memory plus free swap, against RAM plus swap, through the same lines.
- **macOS:** the system's own memory pressure level. Low starts at warn or critical and ends at
  normal.

Only an agent that has waited on you for at least 5 minutes, idle or at a permission prompt, is
paused. Never an agent that is working, one with text typed into its prompt, one whose terminal is
on screen, or one with a column command or message on its way to it. Never one waiting on its own
work either: a background command it started, or a subagent still running past its turn, even
when its card reads idle. A workflow task its step check found still working in the last hour is
left alone too. Command Terminals and a workflow's own agent are never paused. An agent paused at a
permission prompt does not run the tool it was asking about.

**When idle** (off by default). Pauses any agent that has waited on you for the minutes you set (30
by default). It counts idle waits only, not a permission prompt. It never pauses a Command
Terminal: a pause would end the terminal, and its conversation with it.

Either way the agent stays paused until you resume it: a restart does not bring it back, and
neither does memory recovering or a move into a column that starts agents. Resume it from its card
or its task window, as you would one you paused yourself. The conversation picks up where it
stopped. Pausing frees a slot, so a queued task can start in it.

A running workflow's task is the one exception. Nobody is there overnight to resume it, so once
memory recovers Kangentic brings its memory-paused tasks back by itself, one at a time and only
into a free agent slot. A task waiting on you, or one you are resuming yourself, is left alone. A
task paused again soon after waits longer each time, and after three times in a day it stays
paused, with one notice, until you resume it or the first of those returns is a day old. See
[Workflows](workflows.md).

A memory pause says so: a toast reads "Idle agent paused", and as more are paused it counts them
("3 idle agents paused") in place rather than stacking. Its **Review** button lists them, longest
wait first, with each project's name when they come from more than one. Each row has its own
**Resume**, which brings that agent back without opening the task, and the row then reads Running.
There is no Resume all, since bringing every agent back at once would fill the memory that was
just freed. The toast counts down as agents come back, from its list, from a card, window or
move, or by themselves in a running workflow, and as their tasks move to To Do or are deleted. It closes once none on it is still paused.
An open list stays up until you close it. Closing the toast yourself clears the list too, and the
next pause starts a new one. An idle timer pause shows a short "Agent paused" toast for its task
instead.
