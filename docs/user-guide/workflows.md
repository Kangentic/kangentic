---
type: Guide
title: Workflows
description: "How linked tasks run on their own: the Workflows view (Mod+Shift+L) with its canvas and inspector, the workflow agent pane, planning and Start, blockers and per-task routes, Plan approval, how a task moves on, working one task by hand, card strips and links, why running workflow cards are locked, and what Pause and Resume do."
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
shows the run order, or the selected task's Plan approval (while a plan column is ahead of it), its
route, what it waits for, and what waits for it, with Open task (Open on its board, for a task on
another project's board) at the bottom. The board's
search and filter apply to the canvas too. The Workflows segment shows how many unfinished
workflows the project has, the same list the picker holds. While one of them runs, the working
mark takes the count's place; with none at all, the segment shows nothing. In the
picker's list, a line under each name says what that workflow's agent
is doing ("Agent idle, last message 10:44"), or, with no agent running, how many of its tasks wait
for you. The bottom terminal panel is hidden in this view and comes back on the board.

**On the canvas.** Drag a card by its body to place it, and drag empty space or scroll to pan
(Ctrl or Cmd with the wheel zooms). Fit view and Auto layout, which puts moved cards back in the
automatic layout, sit at the bottom left, and Add task at the bottom right. Right-click a started task's card for
the board's own menu, with Open on board in its top group, below Edit and Show changes, and Pause or Resume session and Pause or Resume automations below Show changes. The selected card wears the accent border, and
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
started, its unfinished tasks stay where they are as ordinary tasks. When some of them never
started (still in To Do, with no session ever, no worktree, and never in another column), the
confirm offers "Also delete its N tasks that never started", off by default. Ticked, those go
through the board's own task delete, and a task that has run stays. A task that cannot be deleted
stays in To Do as an ordinary task, and a toast names it. Its tasks in Done stay in Done,
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
to the next column on its route, and the last one to Done; not done leaves it where it is. A column
with a Move to column automation that moves the task forward on the agent's last line (a Text match
such as "Verdict: Ready") has said what finishes it. There a task moves on only when that last line
matches a forward one. A reply that matches none of them, or matches only one that sends the task
back, is treated as not finished, whatever the Automation agent made of it. A task
that finishes a plan moves on when its plan is approved, and its agent's first prompt says so. The
agent may also move its task on itself with `kangentic_move_task` and "next", except in a plan
column, where its prompt says the approval does it, and not from a column its task already left
during that turn: after an approval moved the task on, the agent is told it is now doing the next
column's step instead. Who approves is the task's own **Plan
approval**, at the top of its panel in the inspector and in task detail's Workflow panel:
**Automatic** has Kangentic approve the task's plan, and **Manual** leaves it to you. Left alone,
a task follows the plan columns on its own route: Automatic only when every one is set to
Automatic and runs an agent Kangentic can approve plans for, Manual otherwise. Picking the other
option overrides it for that task only, and picking the columns' value again goes back to
following them. The lit option's tooltip says which ("Manual, set for this task (kangentic's
Planning column is Automatic)."). On a route where only some plan columns run an agent Kangentic
can approve plans for, Automatic approves only in those, and the tooltip names the agent whose plans
still wait. While a plan is approved automatically, an MCP tool your Claude
allow rules name, in the project's settings or your own, runs without a prompt during planning,
even one Claude's plan mode would ask about. So does Claude's own Artifact tool when it only
reads, lists or publishes, with no allow rule; deleting an artifact still asks, and a deny or ask
rule naming `Artifact` keeps it asking. A question the agent asks, and any tool you have not
allowed, still wait. When no plan column on the route runs an agent Kangentic can approve plans
for, the task shows Manual and Automatic is disabled. The control is there only while a plan column
is still ahead of the task; once the task has passed it, or is in Done, it is gone. An agent can
set it too: `planApproval` on a task in `kangentic_save_workflow` or `kangentic_add_workflow_task`,
and `kangentic_update_task` for a started workflow task that has not passed its plan column. Without an Automation agent, or in a
column with no agent, you drag the card on yourself.

**When a step does not finish.** Nothing an agent writes stops a running workflow's task unless it
says that only you can settle it: a change from the plan, something you must weigh in on, or a
decision between options. The agent says so by ending its reply with a `Needs owner: <the question>` line, which
every workflow task is told about. When a turn ends with the step not done:

- **It ends on the Needs owner line.** You get a notice with the question, at once, and nothing is
  typed for you. This needs no Automation agent.
- **Work it started is still running**: a background command, or a subagent still going past the
  turn. Kangentic reads this from the agent's own tool events, not from what its reply says. It is
  left alone for an hour. When that work wakes the agent, the turn it ends is judged as usual.
- **Anything else.** Kangentic types one line into its terminal telling it to carry on, at 5, 15,
  30 and 60 minutes, up to four times, and only while you are not there: no text typed, nothing you
  typed into it in the last 5 minutes, the agent idle and not at a permission prompt. The line
  answers what the reply says it is stuck on: memory is back so run it again, the base branch
  fails the same tests so check that on a separate checkout of the base, note those and fix the
  rest, a sibling task
  merged into the base branch (said as a fact, not an order to merge), or Kangentic restarted so
  start its background commands again. A nudge whose turn fails,
  as in an outage, does not count. The line shows in the conversation like any message.

Nudges go one at a time, at most one a minute, and none while memory is low, so several agents do
not start their gates at once. After Kangentic restarts (a quit, a crash), a task that was mid-step
is nudged at once, since its background commands stopped with the old process. An idle agent with a
tool call that has had no end for 10 minutes is most likely at a permission prompt nobody answered,
so Kangentic types nothing into it and tells you: "it may be waiting on a permission prompt for
<tool>".

With Claude Code, a turn that hangs (shown working while Claude writes nothing for 20 minutes) is
interrupted with Claude's own Esc, then nudged the same way. If the interrupt does not reach it,
you get the stall notice instead. Other agents are not checked for this yet. If you have raised
Claude Code's limit on a foreground command past 20 minutes, a long command can be interrupted.

When the nudges run out, or a check cannot run for a whole schedule, you get one notice, "Workflow
stalled", on your desktop and your paired phone. The card and the Workflows view's header show
Stalled with why on hover. Through an outage Kangentic keeps checking every hour, so when the
service comes back the task moves on by itself. If you answer a stalled task and it stops again
later, recovery starts over for it, with its own notice. A task the low-memory pause stops comes
back by itself once memory recovers, one at a time. After three such returns in a day it stays
paused, and gets the same notice, until you resume it or the first of those returns is a day old.
A return that fails does not count; the next try waits half an hour. A start that keeps failing for 30
minutes and a hung turn the interrupt does not end get the notice too. Pausing the workflow
cancels all of it, and a task in a running workflow raises no plain Agent idle notice. The
**Workflow stalled** switch is in Settings > Notifications.

**Working one task by hand.** To take one task out of a running workflow while the rest keeps
going, right-click its card (on the board, the Workflows canvas or the Agent Monitor) and choose
**Pause automations**. The workflow then leaves that task alone: it does not judge its turns, move
it on, nudge it, interrupt a hung turn or send a Workflow stalled notice for it, and the plain
Agent idle notice comes back. Its column's own automations stop too, as on any task. You can drag
the card to any column but To Do. The tasks that wait for it keep waiting until it reaches Done,
and a held task in To Do is not started. A plan you approve yourself still moves it on, as the
approval is yours. The card wears an **Automations paused** strip over its workflow strip, a held
To Do card's footer says Paused, and the inspector shows the strip with a **Resume** button.
Choose **Resume automations** (or Resume in the inspector) to hand it back. Nothing the hold
skipped is replayed: an enter automation a hand move skipped stays skipped (Run again runs it).
If the agent finished its work in this column and sits idle, its last reply is judged at once and
the task moves on; a reply from before a hand move is left for the next turn. Its recovery starts
over, with its own nudges and notice. Pausing the whole workflow, on the Workflows header, does stop
a held task's agent too, and Resume brings it back still held. An agent can do the same with
`kangentic_update_task`'s `automationsDisabled`.

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
to, Backlog and Archive, disabled with the same reason. Pause the workflow (the Running button) to move its cards by hand, and Resume it after. To move one card by hand while the rest
runs, pause that task's automations instead (see Working one task by hand); Backlog and Archive stay
off for it, since both take the task out of its workflow.
When every task is in Done, a Workflow complete notification says so (Settings > Notifications).

**Pausing.** The Running button pauses the workflow, and so do the phone and
`kangentic_pause_workflow`. Pause stops every one of its agents at once, a task with paused
automations included, and frees what they hold. If an agent cannot be stopped, a toast names its
task. When an agent pauses its own workflow, that agent stops once its turn ends, so its reply
stays in its conversation. While paused, the workflow does nothing by itself: it starts no task, judges no turn, nudges
nothing and moves no card. You still can. Resume one card's agent to look into it, drag cards, or
approve a plan. A card you work this way is an ordinary card. Its column's automations run, and its
agent's own `kangentic_move_task` moves it, so it can run on through its board. A card whose agent
the Pause stopped stays paused when you drag it, until you resume it. Its new column's automations
that need no agent (a script, a webhook, a notification) still run, and the ones that need the
agent, such as a column message, wait for its Resume. The automation log says so on each one.

Resume brings back every agent the Pause stopped, each in the column its task is in now, and starts
one, with the column's message, for a task in an agent column that has none. An agent already
running is left running, and its last reply is judged, so a card you worked to the end of its
column moves on. A task with paused automations gets its stopped agent back, still held, and never
a new one. The workflow then carries on from the board as it is: a task you finished while it was
paused lets what waits for it start. A paused agent you dragged to a new column comes back the way
that move would have started it: a fresh conversation in a column that always starts new (an
isolated Code Review, even one the card left and came back to), its conversation with the column's
settings in one that resumes, and then the column's message. A card you did not move comes back in
the same conversation, with no message. In a column that starts no agent, the paused conversation
comes back as it was. An agent that comes back with no message has its last reply from the column
it left, so the workflow does not judge it there: about five minutes later it tells the agent to
carry on with the new column's step. The same holds for Resume on the card itself.

The idle timeout can pause an agent while its workflow runs, and the card then reads Paused. Resume
on its card brings it back. Pausing and resuming the whole workflow does too, but that interrupts
every agent in the middle of its turn.
