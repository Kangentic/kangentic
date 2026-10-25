---
type: Guide
title: Workflows
description: "How linked tasks run on their own: the Workflows view (Mod+Shift+L) with its canvas and inspector, the workflow agent pane, planning and Start, blockers and per-task routes, Plan approval, how a task moves on, card strips and links, and why running workflow cards are locked."
tags: [workflows, canvas, planning, blockers]
sources:
  - resource: src/renderer/components/workflows/
---
# Workflows

A workflow is a set of linked tasks that runs through the board on its own. Each task follows a
route (the columns it visits, every column between To Do and Done unless it skips some) and starts
when every task it waits for has reached Done, as agent slots allow. Deleting a task it waits for,
or removing that task's project, takes the link away on the engine's next pass, and the task
stops waiting for it.

**The Workflows view.** Workflows is the third segment of the Board / Backlog toggle
(Mod+Shift+L). Its header picks the workflow and holds Rename, the lifecycle button (Start,
Running, which pauses it, or Resume), Delete, the progress, and New workflow. The canvas in the
middle draws each task as its card with the links between them, and the inspector on the right
shows the workflow's Plan approval above the run order, or the selected task's route, what it waits
for, and what waits for it, with Open task (Open on its board, for a task on another project's
board) at the bottom. The board's
search and filter apply to the canvas too. The Workflows segment shows how many unfinished
workflows the project has, the same list the picker holds. While one of them runs, the working
mark takes the count's place; with none at all, the segment shows nothing. In the
picker's list, a line under each name says what that workflow's agent
is doing ("Agent idle, last message 10:44"), or, with no agent running, how many of its tasks wait
for you. The bottom terminal panel is hidden in this view and comes back on the board.

**On the canvas.** Drag a card by its body to place it, and drag empty space or scroll to pan
(Ctrl or Cmd with the wheel zooms). Fit view and Auto layout, which puts moved cards back in the
automatic layout, sit at the bottom left, and Add task at the bottom right. Right-click a started task's card for
the board's own menu, with Open on board in its top group, below Edit and Show changes, and Pause or Resume session below Show changes. The selected card wears the accent border, and
its links stand out: what it waits for flows into it (green once that task is done, grey while it
is not), what waits for it flows out in the accent, and every other link fades back. With
Animations off (Settings > Performance), the links hold still. A system reduced-motion setting does
not hold them in the desktop app.

**Planning one.** Click New workflow, or right-click a To Do card on the board and pick New
workflow (its title and description become the brief). A workflow with no tasks yet shows the
three steps on its canvas: tell the workflow agent what to build, review its plan, and press Start.
When the first cards land, the first task in the run order is selected. Add tasks with Add task on
the canvas, or ask an agent: "plan the usage budgets work as a workflow", which saves the plan with
`kangentic_save_workflow`. Nothing reaches the board until you press Start. Until then a card has
no #id, and double-clicking one opens it in the task form: the board's own New Task form, led
by the project the task goes on, with Base branch, Worktree or Project, and Column Settings or
Agent Override, as a task on the board has them. Each of those reads the chosen project: its
branches and default base branch, its Worktrees setting, its default agent, and its Board
Profiles. Choosing another project resets the task's route to every column of that board, and its
base branch and profile. Start creates the tasks, with those settings, in To Do
(the ones with nothing to wait for start at once) and moves the To Do task the workflow was made
from, if any, to Done. A task can go on another project's board; the inspector then names each
task's board. Delete removes a workflow that has not started, with its planned tasks; once
started, its unfinished tasks stay where they are as ordinary tasks. Its tasks in Done stay in Done,
and once the workflow is gone they are ordinary tasks, so Backlog, Move to and New workflow work on
them as on any task. Deleting a project does to its workflows what deleting each of its tasks would.
A workflow it was home to goes, and its tasks on other boards become ordinary tasks. A task
elsewhere that waited only on its tasks starts. A running or paused workflow left with no task is
deleted; a finished one stays. A plan with a task on that board refuses to start until you save it
again without that task.

**The workflow agent.** The pane on the left is the workflow's own agent. It reads the code and the
board and changes only this workflow's plan, through Kangentic's workflow tools. It runs on the
agent, model and effort chosen in Settings > Workflows > Workflow agent, not on the project's
default agent; the Agent menu lists every installed agent that can reach Kangentic's MCP server
with a server address of its own. Where the agent's CLI can be launched read-only, it has no tools
that edit a file or run a command. Any other agent runs in its own default
mode in your checkout, and its first message tells it to plan only and leave files alone; it is
asked, not prevented, and an agent that asks before an edit asks in the pane. A conversation kept
from an earlier agent runs at that CLI's own defaults. Until that is chosen the pane says so in place of the terminal, with an Open
Settings button, and, for a new workflow, starts the agent on its own once you choose and close
Settings. A new workflow's agent starts with the first message (Settings > Workflows > Workflow agent prompt,
which you can edit), reads the brief, plans the tasks, and saves them;
made from nothing, it first asks what you want to build. A workflow another session made, such as
a Command Terminal or an outside CLI saving a plan with `kangentic_save_workflow`, starts no agent
when you open it or close Settings, and Start and every edit are yours at once. A workflow whose
agent could not start, and whose tasks you added by hand, opens the same way. Its pane opens folded
to its strip for the plan's room, until an agent has run on it; expanded, it says "The workflow
agent has not seen this plan", and Ask for changes starts the agent on the saved plan, which it
builds on rather than planning again. Talk to it in its terminal to reshape the plan. While it
works, the canvas says so and the controls that would change its plan (Start, Add task, links,
routes, Remove) wait until its turn ends; moving cards does not. The toggle in its
header pauses and resumes it, and the conversation is kept across a restart. An agent that picks
its own conversation id reports it once it has one; paused before that, or when its CLI cannot find
the conversation, it starts a new one from the saved plan, and the pane says it started over. It
also reads the other projects its workflow's tasks are on, and when it needs another of your
projects to plan, it asks for it and gets it without a prompt. An agent whose CLI can be told to
read outside its folder restarts on the same conversation with that project readable and carries
on; any other is told the grant takes effect for an agent that can. The speech-bubble
button in its header opens its conversation in the
transcript viewer, paused or not, and its spend counts in Stats. Drag the pane's right
edge to widen it; the width is kept. Opening Workflows folds the project sidebar for room, and
leaving restores it as you had it, both at once with no slide. It keeps running when you leave the
view, and ends when its workflow is deleted or finishes.

**Shaping it.** Drag from a card's right-hand dot onto the card that should wait; the card under
the pointer says what a release would do, or why it cannot. In the inspector, the route list
starts at To Do and ends at Done, both locked on, and its switches turn each column between them on
or off for that task; the X on a link row removes the link, and Add blocker makes the task wait for
another. A control that would break a rule stays in place, disabled, and its
tooltip says why (a task that has started, or has no task left to wait for, cannot get a new
blocker; a step it has reached cannot change). Remove takes a task out of the workflow.

**Moving on.** When a task's agent finishes a turn, the Automation agent (Settings > Workflows)
judges whether that column's work is done and the agent is not waiting on you. Done moves the task
to the next column on its route, and the last one to Done; not done leaves it where it is. A task
that finishes a plan moves on when its plan is approved. Who approves is the workflow's **Plan
approval**, in the inspector with no task selected: **Automatic** has Kangentic approve every plan
in the workflow, and **Manual** leaves each one to you. While a plan is approved automatically, an
MCP tool your Claude allow rules name, in the project's settings or your own, runs without a prompt during planning, even one Claude's
plan mode would ask about. A question the agent asks, and any tool you have not allowed, still wait.
Until you pick, it shows what the plan columns on its tasks' routes give together: Automatic only
when every one is set to Automatic and runs an agent Kangentic can approve plans for, Manual
otherwise. A pick holds from then on. When no plan column on the routes runs an agent Kangentic can
approve plans for, it shows Manual and Automatic is disabled. Before Start, an agent can set it too, with `kangentic_save_workflow`'s
`planApproval`. Without an Automation agent, or in a column with no agent, you drag the card on
yourself.

**When a step does not finish.** A running workflow stops a task only for a decision that only you
can make. When a turn ends with the step not done, the Automation agent also judges why it stopped:

- **It needs you**: a choice that changes the result, information or a secret it cannot find, or an
  approval for something outside the step, such as deleting data. You get a notice with the
  question, at once, and nothing is typed for you. Asking whether to go ahead with the step's own
  work ("Should I commit and run the gate now?") is not this.
- **Work it started is still running** ("the gate is still running, I'll report back"). It is left
  alone for an hour. When that work wakes the agent, the turn it ends is judged as usual.
- **Anything else.** Kangentic types one line into its terminal telling it to carry on with the
  step's own work without asking, at 5, 15, 30 and 60 minutes, up to four times, and only while you
  are not there: no text typed, its terminal not on screen, the agent idle. A nudge whose turn
  fails, as in an outage, does not count. The line shows in the conversation like any message.

With Claude Code, a turn that hangs (shown working while Claude writes nothing for 20 minutes) is
interrupted with Claude's own Esc, then nudged the same way. If the interrupt does not reach it,
you get the stall notice instead. Other agents are not checked for this yet. If you have raised
Claude Code's limit on a foreground command past 20 minutes, a long command can be interrupted.

When the nudges run out, or a check cannot run for a whole schedule, you get one notice, "Workflow
stalled", on your desktop and your paired phone. The card and the Workflows view's header show
Stalled with why on hover. Through an outage Kangentic keeps checking every hour, so when the
service comes back the task moves on by itself. If you answer a stalled task and it stops again
later, recovery starts over for it, with its own notice. A task the low-memory pause stops gets
the same notice, and so do a start that keeps failing for 30 minutes and a hung turn the interrupt
does not end. Pausing the workflow
cancels all of it, and a task in a running workflow raises no plain Agent idle notice. The
**Workflow stalled** switch is in Settings > Notifications.

**On the board.** A workflow task's card carries a strip with its workflow's name and a step
track, and a card in To Do says what it waits for ("Blocked by #413..."). The track is the
task's whole journey, one mark per stop: To Do, each column on its route, then Done, so it keeps
one length for the task's whole life. The stops it has passed are grey, where it is now is wider
and in its column's color, and the stops ahead are bars in their columns' colors, so even a task
that has not started says which columns it will visit. On the Workflows canvas the strip names no
column: where the task is shows as that column's icon on a tint of its color (a dot when the column
has no icon), and hovering it names the column. The strip's left side names the task's project.

**A card's links.** Rest the pointer on a workflow card for a moment and lines fade in from what
it waits for and to what waits for it, drawn as the Workflows canvas draws a selected card's; move
off the card and they fade out. Dragging the card keeps them through the whole drag, and after you
let go while the pointer stays on the card. A refused move shows them too, and keeps them until
Escape or a click on empty board space. Open workflow in the card's right-click menu shows every
link on the Workflows canvas. Task detail has a Workflow panel (the linked-cards button
in its header, or in the form a To Do task opens in) with the same route, links and guards as the
inspector. If the task's workflow was deleted, the panel says "The workflow this task was in no
longer exists." instead, even when it had the workflow loaded. If the workflow's database could not be read
(locked or damaged) and the panel has nothing to show yet, it says "The workflow this task is in could not be loaded." A
panel already showing the workflow keeps it through a failed read. The next read that succeeds
clears either message.

**Locked while it runs.** A running workflow's cards cannot be moved to another column by hand: a
drag stays in the card's own column, where you can still reorder it. The exception is a card you
move on yourself (no Automation agent, or a column with no agent), which you drag onto the next
column of its route. No workflow task can be moved back to To Do. A refused move leaves the card
where it is, says why in a toast that opens the workflow when clicked, and shows the card's links. The menu keeps Move
to, Backlog and Archive, disabled with the same reason. Pause the workflow (the Running button) to move its cards by hand, and Resume it after.
When every task is in Done, a Workflow complete notification says so (Settings > Notifications).
