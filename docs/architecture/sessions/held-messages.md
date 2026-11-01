---
type: Reference
title: Held messages
description: How a message for a task with no running agent (from an agent, a Move to column row or the phone) is held in the sent-messages log and delivered in the next agent's opening message (numbered, after the column's message, apart from a slash command), the claim that settles each held row once, the session-live flush for every other start, and what clears them.
tags: [sessions, messages, mcp, automations, mobile]
sources:
  - resource: src/main/held-messages/held-messages.ts
  - resource: src/main/db/repositories/sent-session-message-repository.ts
  - resource: src/main/ipc/helpers/agent-spawn.ts
    title: spawnAgent folds held messages into the opening message
  - resource: src/main/ipc/handlers/session-resume.ts
  - resource: src/main/agent/mcp-http/steering-tools.ts
  - resource: src/main/automations/turn-end/deliver-message.ts
  - resource: src/main/mobile-bridge/handlers/send-user-message.ts
    title: the phone's chat to a task with no running agent is held
  - resource: src/main/transition-engine/resume-prompt-delivery.ts
  - resource: src/main/ipc/handlers/task-move.ts
    title: a move to Done or To Do clears held messages
  - resource: src/main/ipc/handlers/task-archive.ts
    title: an unarchive into To Do clears held messages
  - resource: src/main/db/repositories/task-repository.ts
    title: a task delete takes its sent-messages log
  - resource: src/main/agent/mcp-http/session-send.ts
    title: the hold rate window
  - resource: src/main/automations/turn-end/agent-message-delivery.ts
    title: the paste that carries held messages after a turn
---
# Held messages

A message for a task whose agent is not running is held against the task and goes to the next
agent that starts or resumes there (GitHub #452). It works for every agent, and nothing in the app
shows the hold.

## What holds a message

`holdTaskMessage` in `src/main/held-messages/held-messages.ts` is the one way in. Three producers
call it.

- **`kangentic_send_session_message`** to a task with no running agent: paused, exited, still
  queued for a concurrency slot, or never started. It used to refuse ("not accepting input"). It
  now holds the message and tells the sending agent so
  ([Session tools](../../integrations/mcp-server/session-tools.md#kangentic_send_session_message)).
  The tool checks whether the target is writable in the same synchronous stretch as the send
  coordinator's own check, so the two cannot disagree.
- **A Move to column message** (`deliverMessageAfterMove`), or `kangentic_move_task`'s `message`,
  for a column where no agent runs, or whose agent exits before its turn ends. It used to be
  logged and dropped. The check is liveness, not `task.session_id`, which a paused agent's id can
  outlive.
- **The phone's chat to a paused task.** The mobile bridge's `send-user-message` names a session.
  When that session is not writable and belongs to a task (paused, queued or exited), it calls
  `holdTaskMessage` for the session's task with no caller ids, as a human sends, and answers the
  phone `delivered: true`. A refused hold answers with the refusal the phone got before, with the
  same error code and the hold's reason as its text. A Command Terminal or a workflow's own agent
  (transient) has no task, so it is refused as before. No rate window applies: that window stops
  an agent's send loop, and a person's sends are not one. A pause clears the task's `session_id`,
  so the phone names the paused session by its board row's `paused_session_id`, the registry id
  of the paused row. A restart re-registers that row under a new id, and the phone's next board
  snapshot carries it.

A task in Done (or archived) holds nothing and the hold is refused: the move into Done clears what
is held, and the move out of Done is a recovery move that sends the agent no messages, so a message
held there would arrive stale or never. A task in To Do holds, and its first agent gets the message.

## Where it is kept

In the sent-messages log, `session_messages_sent`. The row is the hold itself: `held`, keyed on
`task_id` with a NULL `session_id`, since the task may have no session and a To Do move deletes
its sessions. Its status moves on once, to `delivered_from_hold` (with the session that got it),
`cleared`, or `failed`. Every one of those writes is a compare-and-swap on `status = 'held'`. See
the [`session_messages_sent` table](../../database/session-tables.md#session_messages_sent-table)
and [migration 96](../../database/migrations.md).

## How it is delivered

An agent running when the message is sent never sees a hold: the message keeps its own `now` or
`idle` delivery. An agent that starts or resumes gets every held message in its **opening
message**, after the column's own message:

- Oldest first, numbered, a blank line between each (`formatHeldMessages`). A single held message
  goes as written, with no number. No heading and no sender line: a message goes in verbatim,
  because an attribution prefix made the receiving agent read it as an injection and refuse it.
  One thing changes a held message that rides a resume command line under PowerShell or cmd.exe:
  each `"` in it becomes `'`, as in every prompt the command builders quote there. A typed delivery
  keeps every character.
- With no column message, the held messages are the whole opening message.
- When the column message is a slash command, text after it becomes the command's arguments in
  some CLIs, so the held messages go as their own message, pasted once the command's turn ends
  (`composeOpeningMessage`'s `heldAfterTurn`, `pasteHeldAfterTurn`).

Where the opening message rides the resume command line (`claude --resume <id> "..."`), the held
messages ride it with the column's message. Otherwise they are typed in once the agent is ready,
with the column's message, through the path a column message takes. Which it is comes from the
adapter's `resumePromptDelivery` and `resumePromptRidesCommandLine`
(`src/main/transition-engine/resume-prompt-delivery.ts`): a prompt rides only where the CLI takes
one on resume, a multi-line prompt keeps its lines (a `.cmd` shim under PowerShell or Git Bash, a
cmd.exe shell, or no known shell flattens one), it does not open with `-`, and it fits under
`RESUME_PROMPT_COMMAND_LINE_CAP`. Everything else is reported back in `SpawnOutcome.unsentPrompt`
and typed.

Two places build an opening message, and only they claim held messages (pinned by
`tests/unit/spawn-entry-point-parity.test.ts`):

- **`spawnAgent`** claims them in `startAgent`, or in the handoff branch before its engine call.
  With a prompt slot open (a resume, or a spawn with no task template) they go into the resume
  prompt after the lead: the row's message, the task's own command, or a plan continuation. On a
  fresh spawn whose prompt is the task, or a resume whose prompt could not ride, they join the
  first message typed at the agent, as one delivery. When nothing is typed, they go alone after the
  enter group.
- **`resumeTaskSession`** (the Resume button, the phone's resume of a paused task) claims them and
  composes them with the prompt the Resume carries, or makes them a plain Resume's whole opening
  message.

Every other start, and a message held while a start was already under way, gets them from
**`registerHeldMessageFlush`**: on a task session's first `running` status (a direct spawn, a
queued session's promotion, startup recovery, the legacy Start agent row) it waits a beat, then
pastes what is still held once the agent's turn has settled and the keystroke scheduler holds
nothing for the task. A paste never cancels the opening message's keystrokes; a second fresh
keystroke burst would. Every agent reaches `idle` for that wait, through its hooks or the PTY
silence timer of `ActivityDetection.pty`.

A start that opened on an expired conversation's recap delivers none of them: they wait for the
next start, as the column's messages do. A return recap holds nothing back (see
[Resume](resume.md#a-return-to-the-main-conversation-opens-on-a-recap)). Ahead of a plain-text
lead it rides the same opening message, before the lead and the held messages. Ahead of a slash
command it is the resume's whole prompt, so the command goes once the recap's turn ends and the
held messages are pasted once the command's own turn ends, as behind any slash command. A move of
the task, or the session leaving, before the recap's turn ends releases them with a flush: they
stay held, and go to the task's agent at once if one is live.

## The claim

`claimHeldMessages` reserves the unclaimed held rows in memory, per task, and returns them as one
`HeldClaim`. A restart forgets the reservation and the rows, still `held`, go to the next start
rather than being lost. A claim settles exactly once:

- **commit** when the agent got them: a confirmed or unconfirmed typed delivery, or a command-line
  ride once its session first runs (`commitWhenSessionRuns`). A queued session bakes its opening
  message into a command that runs later, so a ride commits at the promotion, and a session removed
  before it runs puts the messages back.
- **release** when nothing of them reached the agent. The delivery report says so with
  `textReachedAgent: false`: a superseded paste or keystroke burst, a session gone, a turn wait
  that ended `exited` or `timeout`, a CLI that never came alive. Pausing a task during its first
  turn does not lose its held messages. A release from the start path flushes again if an agent is
  live by then; one from the late flush never does, so a paste that keeps failing cannot loop.
- **fail** when typing began and did not finish.

The code that takes a claim releases it in a `finally` unless it handed the claim to a delivery or
a ride: an aborted or superseded move, a row skipped by Condition or Frequency, a failed spawn.

## What clears them

- A move to **Done** or **To Do**: `clearHeldMessages` in `handleTaskMove`'s commit block, in the
  tick that moves the task, before any await and before `supersedeMessageDeliveries`. A held
  message mid-delivery then finds its row already `cleared`, and the compare-and-swap keeps it so.
- An unarchive into To Do (`resetSessionForTodoRestore`). Archiving happens only through the Done
  move.
- A **delete**, a **Backlog demote**, a **move to another project**, the startup orphan prune and a
  workflow rollback all go through `TaskRepository.delete`, which deletes the task's log rows; the
  `task_id` foreign key cascades too. A project delete removes the database.

## The resume prompt bug this fixed

Held messages ride the same opening-message path a column's message does, and that path had a
bug. The engine reported a resume prompt unsent only for a fresh spawn, so when Codex, Copilot,
Grok, OpenCode or Cursor resumed, their builders dropped the prompt while `spawnAgent` believed it
rode and skipped its typed fallback. The Resume button and the escalation restart discarded the
outcome entirely. Now every adapter declares `resumePromptDelivery`
(`tests/unit/resume-prompt-delivery-parity.test.ts` builds each real resume command and holds the
value to what it does), the engine names exactly what did not ride in `unsentPrompt` and asserts
idle for that resume, and every caller types it. Escalation, which restarts a session with the
command as its resume prompt, now needs an adapter whose resume carries one.
