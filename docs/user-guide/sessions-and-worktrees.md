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

A task's base can be a branch, a tag or a commit. The base picker lists origin's branches, then
the local branches origin does not have, marked local. It leaves out the branches Kangentic made
for its own tasks, since every task leaves one. Type any other ref into the picker's search box:
when it matches no listed branch, a Use row appears, and Enter or a click checks it with git. A
ref that names nothing shows git's own error under the box. A tag that exists only on origin is
fetched first; a commit that exists only on origin is not. An expression such as `HEAD~1` or
`origin/main` is refused: type the branch, tag or SHA itself.

A branch base is cut from origin's copy, unless your local branch has commits origin does not have
yet. A tag or a commit is cut from as it is. It does not move, so Update from base is off for that
task. A tag or commit base in the project folder needs a branch name to cut from it, since
checking either out there would leave the folder on no branch.

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

A Claude Code session resumed in the column it was paused in comes back in the permission mode it was last in, so a session you switched out of plan mode stays out of it. A move into another column, a column whose mode was edited since, and a bypass column still apply the column's mode. See [Resume](../architecture/sessions/resume.md).

### User-Paused Sessions

Sessions paused manually by the user (via the pause button in the task detail dialog or its kebab menu, the Pause session row in a task's right-click menu, or from a paired phone; see [Capability verbs](../integrations/mobile-bridge/capability-verbs.md)) are remembered across restarts. On relaunch, user-paused sessions remain paused instead of auto-resuming. This respects user intent. If you paused an agent, it will not start back up on its own. An agent Kangentic paused for you on the idle timer (see [Pausing agents](#pausing-agents)) stays paused across a restart too, until you open its task. Only system-suspended sessions (those suspended by shutdown or column moves) auto-resume.

## Pausing agents

An agent waiting on you holds all the memory it reserved: about 1 GB for each Claude Code agent on
Windows. Kangentic can pause one for you on a timer, in Settings > Performance > Pausing agents.

**When idle** (on by default). Pauses any agent that has waited on you for the minutes you set (30
by default). It counts idle waits only, not a permission prompt, and it waits while a background job
the agent started is still open. It never pauses a Command Terminal: a pause would end the terminal,
and its conversation with it. It also leaves alone an agent that cannot resume, such as Warp or
Ollama, for the same reason.

The agent stays paused until you come back to it: a restart does not bring it back, and neither does
a move into a column that starts agents. Open the task and it resumes at once, from its card, a
toast, search, or anywhere else that opens it. The conversation picks up where it stopped, and
opening sends the agent nothing, so it costs no tokens. Pausing frees a slot, so a queued task can
start in it. If the column is full when you open the task, it queues, and its window says why.

A paused task keeps its Resume button, and opening it does not resume it, in these cases:

- You paused it yourself.
- Its workflow is paused.
- You moved it to another column while it was paused. Resume runs that column's message, which is a
  paid turn, so it waits for your click.
- Its conversation cannot be resumed as it stands, so a resume would start a new one.

A window that was already open when the pause landed keeps its Resume button too. Click the button,
or click the task's card.

A message held for the task, such as what a Stop script stopped, reaches the agent after your next
turn ends. A task in a running workflow also rejoins that workflow when it resumes, so the workflow
can check its last reply and message it, as it can after Resume.

A short "Agent paused" toast names the task.
