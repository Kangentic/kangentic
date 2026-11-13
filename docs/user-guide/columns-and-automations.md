---
type: Guide
title: Columns and automations
description: "Editing a column in the Column Manager (agent, model, effort and permission overrides, Plan approval, After Plan Mode, Isolated session) and its automations: the five types, the enter, turn end and exit triggers, Condition and Frequency, Run again, and Pause automations per task."
tags: [columns, automations, triggers, plan-mode]
sources:
  - resource: src/renderer/components/dialogs/board-manager/
  - resource: src/shared/automation-manifest.ts
    title: AUTOMATION_MANIFEST
---
# Columns and automations

## Add a Column

Click **Add column** at the right-hand end of the board toolbar. It becomes a plain **+** once the
toolbar runs short of room.

## Edit a Column

Click a column header to open the **Column Manager**. Settings are on the left, the column's
automations on the right.

| Setting | Description |
|---------|-------------|
| **Name** | Column display name |
| **Description** | Column header tooltip, shared via `kangentic.json`. The column's own agent never gets it. A workflow's planning agent reads it as the column's purpose when it picks each task's route, the workflow's turn-end step check puts it in its question, and `kangentic_list_columns` prints it. Say what the column does and which work needs it |
| **Color** | Header accent color |
| **Icon** | Lucide icon name (e.g., `square-terminal`, `code`, `flask-conical`) |
| **Agent** | Override the project's default agent for this column (e.g., use Codex for code review) |
| **Model** / **Effort** | Override the project's default model and reasoning effort for agents in this column. The Model dropdown has the same **Latest** and **Specific versions** layout as the New Task dialog. A column set to `Opus` follows each new Opus release, while one set to a specific version stays put. In **All columns**, a column pinned to an older version shows a small mark naming the newer one. |
| **Permission Mode** | Override the global permission mode for agents in this column |
| **Auto Spawn** ("Start an agent here") | Whether moving a task here spawns an agent (default: on). Turning it off also stops any **Send message to agent** automation on the column, since there is no agent to type at; those rows show as off with a disabled switch and the reason. |
| **Plan approval** | For plan-mode columns: whether you approve each plan (**Manual**, the default) or Kangentic does (**Automatic**). Automatic answers the plan prompt and, for Claude, a planning prompt for an MCP tool your project allows; a question the agent asks still waits. A workflow task can override it for itself, and a task with automations disabled is always Manual. Automatic is disabled for an agent Kangentic cannot approve plans for ("Kangentic can't approve Codex CLI's plans, so they wait for you."), and both options are disabled while a Board Profile is selected, since every profile shares the column's value |
| **After Plan Mode** | For plan-mode columns: where the task goes when the plan is approved. Pick a column, shown with its icon in its color; picking the column itself keeps the task where it is |
| **Hand off context when the agent changes** | The new agent picks up the previous agent's conversation instead of starting from the task description |
| **Which conversation this column uses** | Main continues the task's conversation, and Isolated starts a new one on every entry. An isolated column suits a code review or any pass that should not inherit the work before it. A split icon marks an isolated column in the column list, in **All columns**, and on this control's Isolated option |
| **Run one agent in this column at a time** | Other tasks wait in this column and start in the order they arrived, for a column whose work must not overlap, such as merging. See [Running one agent at a time](#running-one-agent-at-a-time) |

The column's message to its agent is no longer a field here. It is an automation, and it lives in
the list on the right: see [Automations](#automations) below.

**Remove column**, at the left of the dialog's footer, stages the removal until you save; Cancel
keeps the column. A column that still has tasks cannot be removed.

When a column's agent override differs from the current session's agent, moving a task into that column triggers a cross-agent handoff. The outgoing agent's context (transcript, git changes, metrics) is automatically packaged and delivered to the incoming agent.

## Running one agent at a time

Turn on **Run one agent in this column at a time**, at the bottom of a column's Sessions section,
and one task's agent runs there while the rest wait their turn.

- An agent holds the column while it is working or waiting on you. A paused or queued task does not.
- The order is when each task entered the column. Dragging cards within the column does not change it, and a task that leaves joins the end if it comes back.
- A task that arrives with its agent still running has that agent paused, and on its turn it resumes the same conversation.
- Every start and resume waits its turn, and **Max concurrent sessions** in Settings still applies on top.
- Turning it on stops nothing: agents already running in the column carry on, and the limit applies from the next start.

A waiting card reads "Next in line..." or "2 tasks ahead...". Its task window shows the whole line
with a count of the tasks waiting, and says why they wait. Each row opens its task, and the reason
opens the setting. The bottom bar is read-only while a task waits: pause the task to change its
model or effort.

## Automations

What a column does when a task enters it, each time its agent finishes a turn there, and when it
leaves. Each column owns one ordered list, split into **On task enter**, **On agent turn end** and
**On task exit**, and each row has its own switch. A row belongs to one column; there is no sharing
and no library.

Five types:

| Type | What it does |
|------|--------------|
| **Send message to agent** | Types a message at the column's agent. Plain instructions or a slash command. |
| **Run script** | Runs a script in the task's worktree, or the project checkout when it has none. |
| **Call webhook** | Calls a URL. Retries a transport error, 408, 429 or 5xx, for up to three attempts in total. |
| **Notify me** | Notifies you on the desktop and on every paired phone, with the row's Title and Body, whatever your notification settings. Opening it opens the task. |
| **Move to column** | Moves the task to another column (or the next one), with a message for the agent there. On agent turn end only. |

**Adding one.** Each group has its own **Add automation** control, so where you add decides when
it runs. The picker offers the types that group runs, and below them every row on every other
column, to copy. A copy is independent of the original. A type the column cannot run is offered
disabled, with the reason.

**Editing one.** Clicking the row opens a dialog with the name, then one card for each part of the
rule: **Trigger** (when it runs), **Condition**, **Frequency**, and **Action** (the type and its own
fields). The pencil does the same, for a pointer that is already over it; the grip, the switch and
the trash keep their own jobs and do not open it. A name is required and must be unique on its
column. Every text field takes template variables: type `{{` to pick one, or use the **Template
variable** button. A known variable is highlighted; an unknown one is flagged and sent as written.

**Condition and Frequency.** Any row can carry a **Condition**, and the Condition card picks how
it is checked:

- **Agent evaluation** is a sentence in plain words ("the review found work the implementer can
  do"). The **Automation agent**, chosen in Settings > Workflows, checks it before the row runs.
  Until one is set up, this kind shows a notice with Open Settings where its field would be. The
  same agent names tasks and Command Terminals, and without one naming is off.
- **Agent's message** is a Text match checked against the last line the agent writes when its
  turn ends, such as `Verdict: Ready`. It is read once per turn end, from the agent's final
  message, on the spot, with no agent and no cost. Use `*` as a wildcard (`Ready for *`); case,
  punctuation and markdown are ignored, so `**Verdict: Ready.**` matches too. A `!` at the very
  start means not: `!Design: waiting on you` runs on any last line but that one. The field takes
  one pattern per line, and Enter adds a line. The row runs when the last line matches any plain
  line and none of the `!` lines, in any order; with only `!` lines it runs on any line but those.
  A turn that ends with no message runs no Text match, with or without `!`. Hover the info icon
  after its hint for the rules and examples.
- **Your message** is the same Text match, against your last message in the turn instead,
  including one you typed while the agent was working. A message Kangentic typed (a column message,
  a nudge) never counts as yours. Neither does one you sent while no agent was running, from your
  phone or the desktop: Kangentic holds it and hands it to the next agent itself, often inside the
  column's own message. It is how a column lets you move a card on by saying so: the
  Design column's **On to Planning** row moves a card when you type "signed off". The run log says
  whether your message matched, never what it said. When Kangentic cannot read the turn exactly (an
  agent's first turn, a very large turn, Run again), the row does not run. It needs an agent that
  reports the messages you send (Claude Code today); for another agent the tab is disabled with the
  reason, and a saved row is shown off.

Both message tabs share one patterns field, and both are offered on **On agent turn end** only: on
enter or exit they are shown disabled, with the reason.

Either way, a no means the row did not run, and it is checked again next time. A row holds one kind.
A new Condition starts on Agent evaluation, or on Agent's message at a turn end when no Automation
agent is set up. **Frequency** caps how many times a row runs on one task, across every visit, which is
what keeps a review loop from bouncing a task forever. The count starts over each time you move the
task to another column, by a drag, from your phone, or by restoring it from the Completed list, so
a task you send back for another pass runs the board's automations again. A move the board makes
keeps the count: a Move to column row, a workflow step, or an agent's own move. That includes a
move you ask an agent to make in chat, since the agent makes it. Taking a task out of Done starts
the count over whoever moves it. On task enter and On task exit rows count the same way, so a move
you make into or out of their column always runs them, and their Frequency limits only the moves
the board makes. Both start off.

**A card the board stopped.** The card's amber envelope turns into a pennant when its agent has
finished and nothing will move it until you act. That is one of two things, in a column with On agent
turn end rows: a Move to column row would have run but has used up its Frequency, or the agent says
it cannot go on until a person does something, in any words. The second is judged by the Automation
agent after your rows have run, at a small model cost, only when no row moved the task or messaged
the agent. A last line of `Needs owner: <what you need>` counts with no model call, so a column's
prompt can ask for it. With no Automation agent, only that line and a spent row count. The pennant
shows only when the app knows, so a turn that just ends on an unexpected line keeps the envelope. It
has no tooltip: open the task to read why. It goes when the card leaves the column, or, for what the
agent said, when a later turn no longer says so. A spent row's pennant stays until a person moves
the card. On a workflow task it shows when the agent ends on `Needs owner:` or recovery runs out, not
while recovery is still trying.

**Reading a row.** Every row has the same two lines. The second says what the row does, and to
what: the verb and the type's one required value, such as `Sends "Review the changes"`, `Moves the
task to Executing`, or `Runs npm run lint` (a script shows in code type). A long value ends where
the row ends, and a message or script with several lines shows its first line; hover the line to
read all of it, every line. Any option you switched on is a mark after the name,
in the editor's card order: a robot for an Agent evaluation or a magnifier over text for a Text
match, a repeat icon with the run limit for a Frequency, a clock on a Send message row that waits
for the current turn, and a speech bubble on a Move to column row that carries a Message. Hover a
mark to read its card and value ("Condition: only if the review is clean.", "Condition: only if the
last line reads "Verdict: Ready".", "Condition: only if your message reads "*signed off*".",
"Frequency: at most 3 times until you move the task."); a
Message or a Condition reads in full there. A webhook's body and headers and a notification's body are not
marked: open the row for those. The rows under **Copy existing** in the Add automation picker carry
the same marks.

**On agent turn end.** Runs when the column's agent finishes a turn on its own, not when you stop
it or a request fails. Each row runs at most once per visit to the column, top to bottom, and a
**Move to column** row that runs ends the list. `{{agentReply}}` is the agent's final message of
the turn, whole, so a review's findings can ride a Move to column message back to the column that
fixes them. A column whose agent cannot report a finished turn (agents that only go quiet) shows the
reason instead of Add automation. A Send message row here sends at once, since the turn is already
over, so its **Delivery** is shown disabled and keeps whatever it was set to.

A turn counts as finished only once the background commands the agent started have exited, since
the agent may be waiting on a build or a test run. A dev server or watcher it leaves running would
keep the task working forever, so an agent that reports its background commands (Claude, Codex,
Copilot, Gemini, Grok and Qwen) holds the turn until they exit. Claude, Copilot, Gemini and
Qwen are also told, when they start one, how to mark it as a service; the others read it in the
marking tool's description. A marked command no longer counts. While a task waits, its
card's activity tooltip names the background shells. If one of them is a server, ask the agent to
mark it as a service.

**Reordering.** Drag a row by its grip. A drag stays inside its own group: it changes where the row
sits, never when it runs. To change when it runs, open the row and set its Trigger.

**The agent starts by itself.** Nothing in the list starts the agent, and there is no Start agent
row. On enter, Kangentic starts the column's agent right before the first automation that needs
one, which today means a **Send message to agent** row. On exit there is no agent to start, so
such a row is skipped with that reason recorded.

**When something fails.** Every run is recorded, whatever happens. A failure raises one toast
naming the task, the automation and the column, with a **Run again** action that re-runs it against
the task's current state. Click the toast to open the task, in its own project if you have switched
away. The toast stays up, so Run again is still there once you have looked. Run again on a
**Move to column** row moves the card, but only while the task is still in that row's column; once
it has left, drag the card instead. Nothing is retried automatically: a fired webhook and a half-run
script are not safe to repeat blind. A run that was in flight when Kangentic quit is marked
interrupted the next time the project opens.

**To Do and Done** run exit automations only. Nothing runs when a task enters them.

**Holding one task.** Right-click a card and choose **Pause automations** to keep the board from
advancing it, for example while it waits on CI. While paused, no automation runs for that task in
any column, on enter, turn end or exit, and a drag into a column sends it no column message.
Kangentic does not approve its plans either: in a column with **Plan approval** set to Automatic,
the plan waits for you, and once you approve it the task moves on per **After Plan Mode** as usual.
The column's agent settings, manual drags and **Run again** still work, and so does the task's own
command. The card shows an **Automations paused** strip across its top, and so does its card in
the [Agent Monitor](agent-monitor.md#agent-monitor), whose list row and table mark it too. The run log records
each skipped automation with "Automations are paused for this task." Choose **Resume automations**
to turn them back on; nothing that was skipped is replayed. Adding the task to a workflow resumes
them. A task moved or restored out of Done keeps its automations paused. A running or paused workflow's
card offers no such row: to stop work there, pause the workflow (see
[Workflows](workflows.md#workflows)).
An agent can do the same for its own task with `kangentic_update_task`'s `automationsDisabled`, except in a running or paused workflow, which refuses it.

**Where they live.** Saving writes them to `kangentic.json` under the column that owns them, so
they are shared with your team through git. The column header shows the automations mark (a
column with a cog) and the count of automations that will run there, and **All columns** in the Column Manager shows
every column's counts side by side, and whether each column runs one agent at a time.

## Reorder Columns

Drag a column by the grip in its header to reorder, or Tab to the grip and use Space and the arrow keys (see [Move Between Active Columns](tasks.md#move-between-active-columns)). To Do stays first.

## Delete a Column

Columns can only be deleted when empty (no tasks).
