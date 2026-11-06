---
type: Guide
title: Sessions and worktrees
description: "Where an agent runs and how its session survives: per-task git worktrees versus the project folder, branch naming and base branch order, the FIFO session queue, resume after restart and user-paused sessions, and pausing idle agents after an idle timer."
tags: [sessions, worktrees, queue, resume, pausing]
sources:
  - resource: src/main/git/worktree-manager.ts
  - resource: src/main/pty/session-queue.ts
---
# Sessions and worktrees

## Worktrees

When worktrees are enabled (default), each task gets its own git branch and working directory. This allows multiple agents to work in parallel without merge conflicts.

A project with a Post-worktree script keeps one spare worktree with the script already run. The next new task that uses the project's default base and an auto-named branch starts in it, which skips most of the install, and Kangentic makes the next spare once no script is running. That task's folder under `.kangentic/worktrees/` is named `spare_<8 hex>` instead of its number, for as long as the task lives. When a spare saves no time, as with `npm ci`, which reinstalls everything on every run, Kangentic stops making spares for that script.

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

When the max concurrent sessions limit is reached, new sessions are queued automatically. Queued tasks show their place in line on their card, such as "Next in line..." or "2 tasks ahead...", and the task window lists the whole line. A task a full column holds back is left out of this line, since it cannot take a free slot. When a running session exits or is suspended, the next queued session promotes automatically (FIFO order). A column can also [run one agent at a time](columns-and-automations.md#running-one-agent-at-a-time), and its tasks then wait in the order they entered it.

The limit counts agents, not memory.

## Session Persistence

Sessions survive app restarts. When you close Kangentic:

1. All running sessions are marked as `suspended` in the database
2. PTY processes are closed or force-killed. Claude Code on Windows and Linux is closed the way a terminal window closes, and it exits on its own, so its SessionEnd hook runs and its transcript is written. On macOS and for other agents, a session still in its first moments after spawn gets a brief grace first (its exit command, then the force-kill about 1.5 s later) so the agent's own startup bookkeeping is not cut off mid-boot
3. On next launch, sessions are automatically resumed via `--resume` using the saved session ID

Because Claude Code supports `--resume`, conversation context is fully preserved even when a session is killed rather than exited. If the app crashes, orphaned sessions are detected and recovered on the next launch.

If Claude Code has already deleted a conversation (it removes transcripts older than its `cleanupPeriodDays`), the resume starts a new conversation from a recap of the old one instead, and an info toast says so.

### User-Paused Sessions

Sessions paused manually by the user (via the pause button in the task detail dialog or its kebab menu, the Pause session row in a task's right-click menu, or from a paired phone; see [Capability verbs](../integrations/mobile-bridge/capability-verbs.md)) are remembered across restarts. On relaunch, user-paused sessions remain paused instead of auto-resuming. This respects user intent. If you paused an agent, it will not start back up on its own. An agent Kangentic paused for you on the idle timer (see [Pausing agents](#pausing-agents)) stays paused the same way. Only system-suspended sessions (those suspended by shutdown or column moves) auto-resume.

## Pausing agents

An agent waiting on you holds all the memory it reserved: about 1 GB for each Claude Code agent on
Windows. Kangentic can pause one for you on a timer, in Settings > Performance > Pausing agents.

**When idle** (off by default). Pauses any agent that has waited on you for the minutes you set (30
by default). It counts idle waits only, not a permission prompt. It never pauses a Command
Terminal: a pause would end the terminal, and its conversation with it.

The agent stays paused until you resume it: a restart does not bring it back, and neither does a
move into a column that starts agents. Resume it from its card or its task window, as you would one
you paused yourself. The conversation picks up where it stopped. Pausing frees a slot, so a queued
task can start in it.

A short "Agent paused" toast names the task.
