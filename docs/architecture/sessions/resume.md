---
type: Reference
title: Resume
description: Why Resume is refused for To Do, Done and archived tasks, resume on open and on the owner's move for an idle-paused task, assessResumeConversation's never-started, expired and unknown verdicts with the expired-conversation recap, the return recap a main conversation gets after an isolated column's session, who resumed a session (resumedBy), fork id reconcile, plan-exit continuation, auto_command escalation, and restore progress labels.
tags: [sessions, resume, expired-conversation, recap, return-recap]
sources:
  - resource: src/main/transition-engine/resume-conversation-guard.ts
  - resource: src/main/transition-engine/resume-id-reconcile.ts
  - resource: src/main/transition-engine/expired-recap-sources.ts
  - resource: src/main/agent/shared/expired-conversation-recap.ts
  - resource: src/main/agent/adapters/claude/conversation-gone.ts
  - resource: src/main/agent/shared/project-folders.ts
  - resource: src/main/ipc/helpers/pending-conversation-expired.ts
  - resource: src/main/ipc/handlers/session-resume.ts
  - resource: src/main/ipc/handlers/session-transcript-path.ts
    title: the two writers of the row's transcript path
  - resource: src/main/ipc/handlers/session-resume-on-open.ts
  - resource: src/main/ipc/helpers/idle-pause-lift.ts
    title: whether the owner's open or move lifts an idle pause
  - resource: src/renderer/window-manager/persistence/restore-workspace.ts
    title: a switch back to a project resumes the tasks whose windows it restores
  - resource: src/main/activity-engine/session-telemetry.ts
    title: the idle sweep skips an open task and starts its wait over
  - resource: src/main/pty/session-manager.ts
    title: isTaskOpen and setTaskWindowLookup
  - resource: src/shared/session-resume-eligibility.ts
  - resource: src/main/ipc/handlers/session-reconcile.ts
  - resource: src/main/transition-engine/spawn-progress.ts
  - resource: src/main/automations/turn-end/recap-turns.ts
  - resource: src/main/ipc/helpers/idle-restart-keeps-recap.ts
    title: an idle settings restart keeps a recap's waiting message
  - resource: src/main/transition-engine/resume-prompt-delivery.ts
  - resource: src/main/transition-engine/return-recap.ts
  - resource: src/main/automations/turn-end/carried-owner-turn.ts
    title: the turn a restart cut off, carried by startup recovery
  - resource: src/main/db/repositories/session-repository.ts
    title: markAgentNeverRan, the never-ran mark's freshness rule
  - resource: src/main/transition-engine/session-lifecycle.ts
    title: a queued record's promotion takes the never-ran mark off
---
# Resume

A resumed agent comes back idle and reports no turn end, so `SessionManager` announces the resume
itself. Every task session spawned with `resuming: true` and reaching `running` (a Resume, a
workflow's Resume, launch recovery, recovery after a pty host crash) emits `'session-resumed'`
with the session, task and project ids, the conversation it resumed, and its work serial as it
came back. A resume begins no turn, so the payload carries neither a turn start nor a transcript
anchor. The turn-end runner uses it to give a workflow task the step check a Pause or a quit
cut short (see [On agent turn end](../automations/triggers.md#on-agent-turn-end), "A resume catches up the workflow step").
The payload also says who resumed the session (`resumedBy`, a `SessionResumer`), from
`SpawnSessionInput.resumedBy`. A person's resume is `'user'`, the default. Startup recovery,
which also brings agents back after a pty host loss (`resumeSuspendedSessions`), passes
`'recovery'`. Workflow recovery reads it: an agent Kangentic restarted lost the
background commands it started, so its recovery starts over at once (see
[Workflow engine](../workflows/workflow-engine.md)).
Startup recovery also carries the turn the restart cut off. The old record's `open_turn` (where its
last turn began, kept until a turn end takes it) is copied to the new record's `carried_owner_turn`
and cleared on the old one (`carryInterruptedTurn`, `src/main/automations/turn-end/carried-owner-turn.ts`).
A resume that ran no turn hands on what it carried: the old record's own `carried_owner_turn` wins,
since it began earlier, and the old record's id is appended to its `recordIds`. The new session's first turn end then reads the owner's message
from there, so a sign-off typed just before a restart still moves the card. Nothing moves at the
resume itself (see [On agent turn end](../automations/triggers.md#on-agent-turn-end), "A turn a
restart cut off keeps the owner's message"). A person's Resume carries nothing.
A transient session emits none. Turn ends themselves arrive as `'turn-ended'`, or as
`'turn-ended-held'` when the agent's Stop is held by background work (a running workflow task's step
and a plain idle resume's held messages both act on it), both separate events from `'activity'`; see [Activity event types](../activity/event-types.md#turn-ends-onturnended).

## Resume on open

A person opening a task the idle timeout paused resumes it at once, with no click and no settle
delay (`resumeTaskOnOpen`, `handlers/session-resume-on-open.ts`). The idle timeout is on by default
because of this: a pause costs the user nothing. Flicking across cards starts each idle-paused one.
That was accepted: a plain resume spends no tokens, a full column queues it, and the agent idles out
again on the normal clock, which a spawn seeds from its start.

**What counts as opening.** Every click that opens a task passes `setDetailTaskId`, and it calls
`sessions.resumeOnOpen` unless the open is an agent's or the edit form's. The Agent Monitor's own
open, `requestMonitorDetail`, calls it too. A project switch writes `detailTaskId` with `setState`
and a workspace restore rebuilds windows directly, so neither reaches the action. That is why the
call is there and not in the bridge's effect, which a launch restore fires too. A task a
notification click or a Monitor row parked across the switch opens through `setDetailTaskId`
(`useProjectSwitchEffect`).

A switch back to a project asks on its own, once the saved layout is restored: `resumeRestoredTasks`
(`restore-workspace.ts`) calls `resumeOnOpen` for each task window it brought back. A window in a
project nobody is looking at does not count as open (below), so its agent can be paused meanwhile,
and coming back is opening it again. The launch restore never asks, since a restart lifts no pause.

A pause that lands on a window already open asks nothing, and the sweep makes no such pause. Until
#1191 it did, and a level check ("focused and paused") was ruled out because it would resume, idle
and pause in a loop all night (#1041). With the open window exempt there is nothing to loop.

**What main requires.** The renderer reads `Session.suspendedBy`, which mirrors the record's `suspended_by`, only to word
the pause: "Paused while idle" on the card, and a line under the window's Resume button (a held
pause says it stays paused until resumed). It still asks on every open, because the other conditions below live only in main. One read
(`isPlainIdleResume`) runs unlocked first, where most opens end with no log line,
and again under the task lock in both of `resumeTaskSession`'s locked phases, through its
`plainResume` option:

- No refusal from `resumeBlockReasonForTask`.
- The latest record is `suspended` with `suspended_by = 'auto'`, so a user's Pause stays paused.
- No `launch_failed_at`: that launch still owes its prompt.
- The task has not entered a column since the pause: the column's message is a paid turn.
- The task's workflow is not paused, and is readable. A member the idle timeout paused first never
  reached the workflow's Pause, so its record still reads `auto`.
- No workflow recovery is armed or running, the same check the idle pause makes.

The record, launch, workflow and recovery checks are `isLiftableIdlePause`
(`helpers/idle-pause-lift.ts`), which the owner's move shares (below). The column check is the
open's own, because a move IS the entry.

**The owner's move resumes it too.** A move into a column that starts an agent ends an idle pause
when the owner made it: a drag or a phone move (`isMoveByAPerson`), or an agent's
`kangentic_move_task` the owner asked for (`ownerRequested`): any Command Terminal's move, one from a
client outside Kangentic, or one in a turn the owner started. The same flag is written to the move
row's `owner_requested`. Priority 4 of `handleTaskMove` keeps its spawn plan, and Phase 3 calls
`spawnAgent` with `liftsIdlePause`, which asks `isLiftableIdlePause` again under the lock. The
start is the move's: the column's session strategy, its message and its whole enter group, with
held messages in the opening message. It costs the turn a running agent would get from the same
move. When the re-check declines (a workflow paused or a recovery armed during the move's worktree
phase), `spawnAgent` runs the enter group with `agentPaused`, as the move's held branch would have.
A move the board made (a Move to column row, a plan approval's auto-move, a workflow step, an
agent's move in a turn the board started) keeps the pause, and so does a restart, since
`HELD_PAUSE_SOURCES` still lists `'auto'`.

A resume already in flight wins (`isResumeInFlight`), since `resumeTaskSession` cancels whatever is
in flight and that could be a Resume carrying a prompt, a workflow's Resume, or the launch retry.

**It never sends a message.** `plainResume` claims no held messages, and passes `resumeOnly`, so the
engine declines (`SpawnOutcome.declined`) a start that is not a resume: no id to resume, an agent
changed while paused, or a `never-started` or `expired` verdict. The record stays `suspended`, and
the card keeps its Resume button after a brief "Resuming" label. The engine can only decline after
the git phase and the CLI checks, so `resumeTaskOnOpen` remembers the record in memory and later
opens of the card end at the first read. Held messages wait for the agent to end a turn
(`deferHeldUntilTurnEnd`): the flush that follows any other start would paste them and spend a paid
turn. The mark clears on the agent's own Stop, `'turn-ended'` or a turn end held by background
shells (`'turn-ended-held'`, whose paste accepts the held turn), and never on an activity edge: Claude
reloads its context on a resume with no hook, the status heartbeat reads that as thinking, and a
watchdog idles it with no turn run. If no turn ends they stay held for the next start, which is also
where an agent that reports no Stop leaves them. A task in a running workflow is the one way a turn
can still follow: its resume announces `'session-resumed'` like any other, so the turn-end runner
catches the workflow step up, and recovery may nudge the agent.

**Failures.** A refusal is quiet, and a resume that fails after it started raises the spawn-blocked
notice through `onFailed`, since nobody awaits it. The launch carries `startPath: 'open'`, so returns
can be counted.

**From a phone.** A paired phone opening the task (a push tap, a card tap) reaches the same
function through `start-session` with `trigger: 'open'` (`openTaskSession`, protocol 0.28.0), with
`startPath: 'phone_open'`. `resumeTaskOnOpen` reports what it did, `not-eligible`, `live` or
`starting`, through `onDecided` as soon as it knows, before the git phase, so the phone's verb
answers inside its budget. The desktop's own open ignores the outcome. See
[Capability verbs](../../integrations/mobile-bridge/capability-verbs.md).

**What the sweep leaves running.** An agent whose task is open is never paused for being idle
(`SessionManager.isTaskOpen`). Open is a task window in any renderer (the board's, the Agent
Monitor's, the detached Monitor's), read from main's `DetailOwnerRegistry` through
`setTaskWindowLookup`, or the task's screen on a paired phone (`MobileTerminalProbe`). A window the
user closed and one kept only for its Browser pane are not in that registry. A Monitor window counts
while the Monitor is closed, because it is still there when the Monitor reopens. The bottom panel
does not count: it picks a tab by itself. The focused-session set was not used, because it drops a
window hidden by the Backlog view and includes that tab.

The sweep asks (`checkIdleTimeouts`), and so does the pause's `stillEligible` under the task lock,
for a window opened while the pause waited. The wait starts over when the task closes. The sweep
stamps each idle session it sees open and counts from one sweep after the last stamp, so the pause
comes between the whole timeout and about two minutes past it, never early. It is a sample and not
a close event, so a window and a phone need no events of their own and a reload or a handover
opens no gap. The engine's `idleTimestamp` and `needsUserSince` stay as they are, so the card still
shows how long the agent has waited. A window opened and closed between two sweeps is not seen. A
window left open overnight keeps its agent running, and the project's Stop script, which follows an
idle pause, does not run for it.

With the timeout on by default, the idle pause also waits while
`getOpenWork` lists a background shell. The activity engine reclaims a shell the watcher cannot
confirm at the five-minute cap, so a long build can read idle, and a pause ends it. A service the
agent marked never opens there, so a task that only left a dev server running still pauses. An agent
that cannot resume (`resumePromptDelivery: 'no-resume'`) is exempt from the sweep
(`isIdleTimeoutExempt`), because a pause would end its conversation for good.

## Where resume is refused

`SESSION_RESUME` (the task detail's Pause/Resume toggle and the card menu's Resume session row) restarts a suspended session **in
place**, in the task's current column. Its body is `resumeTaskSession`
(`handlers/session-resume.ts`), which the phone's `start-session` verb also calls for a paused
task, so a phone Resume is the same resume: it cancels a resume already in flight for the task,
labels the task "Resuming session...", resumes the conversation idle, and runs no enter
automations or column message. The exception is a task that entered its column after it was
paused (its current visit's `task_moves.at` is later than the record's `suspended_at`) in a column
that starts an agent. A move starts no paused agent, so that entry ran only its rows that need no
agent. The owner's move of an idle-paused task is the exception, described above. The Resume then
calls `spawnAgent` with `resumesEntry` instead of the engine: the column's own strategy (a fresh conversation in an always-new column) and its enter rows that need the agent.
An entry out of Done, a drag back or an unarchive, is a recovery move, which sends the agent
nothing, so that start passes `suppressAutoCommand` too. A drag out of Done does not stop at the
paused branch: Done removed the worktree, so the move restores it, as an unarchive does.
The read-stream feed tells the phone when that promise holds
(`resumable`, see [Data feeds](../../integrations/mobile-bridge/data-feeds.md)). It is refused for three states, resolved by one shared
rule (`sessionToggleOffer` in `src/shared/session-resume-eligibility.ts`, over `resumeBlockReasonForTask`)
that the main-process handler, the task detail, the card menu row, and the phone's `startTaskSession`
(`handlers/session-start.ts`, the `start-session` verb) all read, and whose role set startup recovery shares:

| State | Why |
|---|---|
| Lane role `todo` | A To Do card has not started; its detail opens straight into the edit form |
| Lane role `done` | The task is complete. The route back is to move it OUT of Done |
| `archived_at` set | Same, for a task archived without a live Done-role lane |

Resuming a completed task in place would recreate the worktree the move to Done had just deleted
and leave the task archived AND running at once, with no board card to show for it. The supported
route is the recovery move below, which unarchives first and then spawns through the normal
chokepoint, so the refusal never applies to it. The main-process guard is the contract; the task
detail hides the control so it is never offered. Pausing a session that is genuinely live is NOT
refused in any of those states, so a stray agent can still be stopped from the window showing it.

The guard runs three times. `resumeRefusalBeforeLock` reads the task row before the resume cancels
anything or queues on the task lock, and refuses at once. A move to Done holds that lock through its
suspend, reap and worktree removal (17 s on a project with a large `node_modules`), so a refusal
that waited for the lock reached the user only after all of it. A task with a live session passes
that read, because Phase 1's self-heal hands its PTY back even on an archived task. Phase 1 and
Phase 3 still check under the lock, which catches a move that commits after the read.
`startTaskSession` runs the same read before its own lock, inside the phone's 10 s budget.

The task detail's gate is only as fresh as the renderer's board. Every move whose card the renderer
did not move itself (an agent's `kangentic_move_task`, a plan exit, a phone, an automation, a
workflow) sends a quiet board reload at its commit point. Before that, an agent's move of its own
task to Done reached the board only once the move settled: the card stayed in its old column,
unarchived, while its paused session offered a Resume that main refused. A move from the detached
Agent Monitor sends `task:changedInOtherWindow` at its commit point too. The in-app Monitor covers
the board while it is open and reloads it as it closes, since its own moves resync the board only
when they settle.

## A resume the CLI cannot serve starts fresh instead

Two cases spawn `--resume <id>` for a conversation the CLI cannot find. It answers "No conversation
found with session ID" and exits, and the user is left on a bare shell with the record still
reading `running` (the shell PTY outlives the CLI).

- **The conversation never started.** Kangentic pre-specifies `--session-id` for Claude and
  persists it on the session record AT SPAWN TIME, while the CLI writes its transcript on the first
  turn. The recovery move out of Done spawns command-free, and moving the task back before typing
  suspends a record with nothing behind it. Reachable in seconds of ordinary use.
- **The agent deleted it.** Claude Code deletes transcripts older than its `cleanupPeriodDays` (30
  by default), so any task idle that long hits this on its next resume.

`assessResumeConversationWithEvidence` (`src/main/transition-engine/resume-conversation-guard.ts`)
decides before the spawn, at both chokepoints (`executeSpawnAgent` and `prepareAgentSpawn`), and
answers `{ verdict, evidence }`: the verdict is `never-started`, `expired`, or `unknown`, and the
evidence is a summary of what the check read, in fixed values (`ResumeEvidenceSummary`). A spawn that
still resumes carries the summary as `resumeEvidence`, and a launch report for it sends the
`resume_*` tags ([Error reporting](../../telemetry/error-reporting.md)).
`assessResumeConversation` is the same check returning the verdict alone. It runs AFTER the resume-time id reconcile, so it checks
the id actually being resumed, and on the board path after the cwd migration too, so it finds a
migrated file where it now is (startup recovery migrates nothing). Both chokepoints build the
lineage below with one helper, `resolveResumeLineage`.

The evidence is per record of the conversation's lineage (the retiring record, then every record
sharing the reconciled `agent_session_id`, newest first), from three agent-written sources:

| Source | Transcript path | Turns |
|---|---|---|
| the session row | `sessions.transcript_path`, written from the status line when it changes, filled from the SessionStart hook when the row has none, and set at insert to the path its agent had already reported, else inherited from the same conversation's newest row | token or cost totals above zero prove turns; zero proves nothing |
| `status.json` | the status line's `transcript_path`, when its `session_id` is the resumed id (another process with the same `--settings`, such as a background daemon's spare, can write it last) | tokens or cost |
| `events.jsonl` | `transcript_path` inside the SessionStart hook payload | any event beyond `session_start` / `session_end` |

The row exists because a quit or a removal deletes the session folder (`detachAndDelete`), which
left most old conversations with no evidence at all. The SessionStart hook exists because the
status line only runs once the TUI is up, so a CLI killed in its first second leaves no status.

The row takes its path from both reports. The status line was its only source, and nothing makes
that line run before a session ends. Rows of sessions that never took a turn reached a restart with
no path, and after the quit nothing the agent reported was left (Sentry DESKTOP-2M and DESKTOP-2J,
the `resume_transcript=not_reported` events, 3 of 6 tagged, on Claude Code 2.1.322 to 2.1.326).
Why the status line wrote nothing on those installs is not established: measured on Claude Code
2.1.327 on Windows, with the `refreshInterval` Kangentic sets, it ran 46 ms after the SessionStart
hook of a session nobody opened. The hook fires at session start and names the same file, so the
session manager announces it (`'transcript-path'`) and `persistHookTranscriptPath`
(`handlers/session-transcript-path.ts`) fills the row:

- It only fills an empty path (`SessionRepository.fillTranscriptPath`). The status line stays the
  authority and overwrites. A resumed row starts with the path its conversation's newest row
  holds, which can sit outside the folder the new cwd maps to, and the hook never replaces it.
- A hook that names another conversation is ignored. Every process started with the session's
  `--settings` fires SessionStart, and Claude Code's background daemon runs an empty spare.
- A Command Terminal and a workflow's own agent have no row. A session on an SSH host keeps none
  either: its hook payload is the host's word, and the check answers `unknown` for a host anyway.
- An early agent's hook fires while it is hidden, before its record exists. That record takes the
  path at insert: `commitSessionRecord` asks `SessionManager.getAgentReportedTranscriptPath`.
- Only an adapter whose `parseSessionStart` reports a `transcriptPath` takes part, which is Claude.

- **`never-started`** needs no turns anywhere in the lineage and one of four things:
  - The agent's own report (status or hook) says nothing happened, and the path it names fails
    with ENOENT.
  - A launch check marked the record (`launch_failed_at`).
  - The record that minted the resumed id, the oldest of the lineage holding it, is marked
    `agent_never_ran_at`: its fresh launch ended, or still waits queued, with its CLI never run.
  - No report is left, the path a row kept fails with ENOENT, and the adapter's
    `proveConversationGone` proves the conversation gone.

  The last is the restart case (Sentry DESKTOP-2M). A quit deletes the session folder, so every
  never-turned session that startup recovery restored used to resume into "No conversation found".
  The row's path is still the agent's own, copied from its status line or its SessionStart hook,
  and the proof is the adapter's, so a moved project still resumes.

  The third covers the rows with no path at all (DESKTOP-2M again, on 0.63.0, both events
  `resume_transcript=not_reported`). A fresh launch mints its id and its record carries it before
  the CLI runs, so a launch Kangentic ended in its first second, one a quit suspended, or one still
  queued at a quit or a crash, left a resumable record naming a conversation no CLI wrote. Now the
  record is marked from Kangentic's own launch observation, never a path:

  - **At its end.** `noteLaunchEnded` emits `'launch-ended-before-agent-ran'` for a fresh launch
    that minted its id and shows no sign its agent started (no start hook, no alt screen, no end
    signal, no other hook, no id of its own), when its terminal printed nothing at all, or its
    adapter reports its start and the shell never ran the typed line (`SessionManager.agentNeverRan`).
    The listener in `ipc/handlers/sessions.ts` writes it, whoever ended the launch and whether or
    not a pause or a park lands after: those decline when a person's start overtook them. The
    0.63.0 Ubuntu event fits that shape, a session that spawned and exited in one second with no
    output, then the resume. Its breadcrumbs do not say which record that resume retired.
  - **At a quit.** `markSessionsSuspended` marks a running record by the same test, since no exit
    listener runs during a quit.
  - **At its insert.** A spawn that queued, or whose terminal failed to start, is marked as it is
    written, on both chokepoints, and its promotion to running takes the mark off. So a queued
    record a quit or a crash orphans still reads as never run. Startup recovery and auto-spawn now
    write a queued spawn's record `queued`, as the board path does, where they wrote `running`.

  Freshness comes from the spawn itself, never from a row's shape alone: only a launch that minted
  the id (`SpawnSessionInput.mintedAgentSessionId`) is marked, and only when no other row of its
  task holds the id (`SessionRepository.markAgentNeverRan`). A resume can hold an id no other row
  holds, after the reconcile follows a background session, so the row rule alone could mark one.
  Both tests are Kangentic's own facts, so the ground stays inside the #255 rule. The typed-line
  test needs the start report beside it because a shell whose clear the handoff test does not know
  never shows its line run (`AgentOutputTracker`). A session on an SSH host is never marked. Its
  output crosses the link late, so a terminal silent here may hold a CLI that already ran on the
  host, and only the host proves a conversation absent. Its resume's own miss still marks it
  (`markResumeMiss`). It is a separate column from `launch_failed_at`
  because a person moving a task on before its agent booted is no failed launch: it holds no idle
  pause and changes no held-message commit.

  A row with no path and no mark proves nothing and still resumes, and the post-failure heal is its
  only way out: a CLI that ran its typed line and died before its SessionStart hook, a hook payload
  the event bridge cut short, or an agent whose adapter reports no hook path.

  The last two cases end where `markResumeMiss` and its retry used to end, without the dead launch.
  The verdict carries `promptOwed`, and two starts read it. Both rest on the same rows-only turn
  evidence as a marked launch:

  - Startup recovery replays the lineage's prompt (`owedPromptOf`) itself.
  - The Resume button passes the engine `SpawnOverrides.owedPromptOpening`. The engine calls it
    with the owed prompt only when its own check set `promptOwed`, and opens on what it returns,
    with no task template. `resumeTaskSession` composes that opening as it does for a
    `launch_failed_at` record: a command the person chose leads, else the owed prompt, then any
    held messages. A lineage that owes nothing (a launch that carried no prompt, such as a
    recovery move out of Done) opens on any held messages alone, and with no prompt when none are
    held. It never gets the task template.

  A move into a column passes no such callback and re-resolves its column's prompt, as for any
  `never-started`. So does a Resume after the task entered its column while paused, which goes
  through `spawnAgent`, and a `never-started` the agent's own report decided.

  Either way the spawn is re-resolved `forceFresh`, with no recap and no notice. Where the
  template takes the prompt, a column message the resume carried is treated as on any fresh spawn.
  One the caller lets follow the template (`SpawnOverrides.carriedMessageJoinsTemplate`: an
  `immediate` message that is not a slash command) joins the opening after it, #1138. An immediate
  slash command on a cold spawn takes the opening slot instead, and the spawn skips the task
  template so the command stays the prompt's first word. Any other goes out after the spawn, and
  the spawn hands it back in `SpawnOutcome.unsentPrompt` for the caller to type in. A start that
  opens on the owed prompt hands nothing back: its caller built the whole opening, the carried
  message included.
- **`expired`** needs turns and the adapter's proof that the file is gone
  (`AgentAdapter.proveConversationGone`). Claude's (`adapters/claude/conversation-gone.ts`) wants an
  absolute reported path named `<id>.jsonl`; that path and the one every reader would open both
  failing with ENOENT (the transcript locator's, which looks past the cwd to the folder the
  conversation started in, see [Where a Claude transcript is](../../integrations/agents/session-history.md#where-a-claude-transcript-is);
  a permission or lock error is not proof, `agent/shared/confirmed-missing.ts`); the projects folder
  two levels above the reported path readable (a WSL session's Linux path stops here); and no
  project folder under it, a symlinked or junctioned one included, holding `<id>.jsonl` (measured at
  16 to 22 ms over 617 folders), so a file Claude might find elsewhere always resumes. The folder
  listing and that scan are `agent/shared/project-folders.ts`, which Qwen's proof uses too.
  Claude's own retention sweep does not race it: in Claude Code 2.1.300 it is background
  housekeeping, first run 5 s after launch and at most once a day, while `--resume` resolves its
  file at launch.
  Gemini's (`adapters/gemini/conversation-gone.ts`) reads the path its SessionStart hook reported
  (`transcript_path`, from the session's events file): absolute, in a `chats` folder under
  Gemini's `tmp`, named `session-<time>-<first 8 of the id>.jsonl` (or the legacy `.json`) and
  failing with ENOENT; the reader's own folder holding no file for the id; and `tmp` readable with
  no project's `chats` folder holding one. Gemini deletes chats past
  `general.sessionRetention.maxAge` (30 days by default). Built from its docs and source, not yet
  run against an expired chat.
- **`unknown`** is everything else, and resumes exactly as before. Mocked CLIs write no status and
  no row path, so they land here structurally, which is what keeps the E2E resume specs passing.

This is deliberately narrower than the `canResumeSession` transcript-presence guard reverted in
#255 (see docs/integrations/agents/session-history.md), whose computed paths and false misses silently lost
real conversations. A wrong `expired` costs a new conversation in place of the resume, never data.

On `expired` the same spawn starts fresh. The old record is retired and kept, nothing is deleted,
and the new session's prompt is a recap (`buildExpiredConversationRecap`,
`src/main/agent/shared/expired-conversation-recap.ts`): what happened and when, the task, its
summary, the old conversation's last turns (from the transcript archive, else the index), the
branch's commits and uncommitted changes, and a pointer to `kangentic_get_transcript`. It rides the
command line, so it is measured as cmd.exe receives it (`commandLineLength` in
`agent/shared/prompt-budget.ts`, where each `%` is the 4 characters `quoteArg` writes for it)
against the 7,000-character inline budget, less what the caller's own text beside it takes (an
isolated column's prompt, a handoff pointer). The three sources are read at once, each with its own
wait (1.5 s for the retrieval worker, 3 s for git). Once one worker read in a set runs out of its
wait, the set's later worker reads answer at once, so a startup pass over many expired tasks pays
that wait once.

- **On the task's main session the recap is the whole prompt** and ends "reply with a short summary
  of where the work stands, then wait". The message the resume carried (a column's message, a
  plan-exit continuation) and the column's task template are not sent, and neither is the task's own
  `auto_command`: a conversation old enough to expire belongs to a stale task. The automation runner
  records every message row of that move as skipped, "Not sent"
  (`AgentStartReport.withholdMessages`), and so does a move whose legacy Start agent row opened the
  session on that recap. A cross-agent handoff that resumes the target agent's own deleted
  conversation sends no column message either. The turn that answers the recap runs no On agent
  turn end rows and no workflow step (`automations/turn-end/recap-turns.ts`). That turn began at the
  spawn, before the session first went idle, and it lasts until the agent receives a prompt after
  that idle: an idle no Stop caused (the stale-thinking watchdog) can land mid-turn, and the engine
  re-stamps the turn's start when thinking resumes. A turn the user starts with a prompt after an
  interrupted recap runs its rows, unless the prompt lands inside the engine's interrupt settle
  (about 3 s after a Ctrl+C between tool calls, which fires no hook), where it still counts as the
  recap's turn. Startup recovery's recap is the whole prompt on every session whose CLI takes a
  starting prompt, so its first turn is skipped the same way. An agent with
  `freshPromptDelivery: 'typed'` (Kimi Code) opens with no recap. That pass therefore starts each expired task working:
  one summary turn per task, paid in model tokens with nobody watching, which is the price of the
  task saying where it stands when the user next opens it.
- **On an isolated column set to keep its own conversation** (isolated plus `create_or_resume`,
  never the default) the old conversation says the column's pass is old, not the task, so it starts
  a normal fresh pass with the recap prepended as context, and its turn end runs the column's rows.
  When the column sends its task template, the template is the pass's prompt. The column's
  message follows it when it is `immediate` and not a slash command (#1138). A `deferred` message
  still waits for that turn. An immediate slash command on this start-over still goes after the
  spawn, because the resume record kept the template in the slot. A column prompt too long to leave room
  for the recap's header and pointer gets no recap, and the pass runs on its own prompt.

Once the new session exists, main queues a notice for the task's project
(`src/main/ipc/helpers/pending-conversation-expired.ts`) and pushes `task:conversationExpired`.
Startup recovery does the same. The renderer never toasts the push's payload. It takes the
project's queue (`task:takeConversationExpired`), and it does so on the push when the push names
the project on screen and whenever a project becomes current (`useProjectSwitchEffect`). The take
is a synchronous handler that removes what it returns, so a notice shows at most once however the
two takes race. It can show not at all: a renderer reload between the take and the toast loses
it, and a take that resolves after the user switched to another project is dropped rather than
toasted over that board. Each notice gives its own toast, titled New conversation, with one
sentence naming the task and the old conversation's date: "Fix login redirect" started fresh
because its conversation from Sep 3 expired. A click on it opens the task. A long absence expires every suspended task on the same launch, so the toast limit drops
the oldest. The toast does not say whether a message was held back: the agent summarizing instead
of acting shows that, the run log records it for a column's rows, and a handoff logs it only in
main.

The queue is what keeps the startup notice. The auto-opened project's recovery starts while the
window is still loading, before App.tsx subscribes and before the project store holds the opened
project, and `notifyConversationExpired` runs with no window at all during it. A push alone was
dropped there. A task recovered in a background project now gets its toast when the user opens
that project, rather than none. The queue keeps the latest notice per task and is cleared when the
project is deleted. The take drops a notice whose task was deleted or archived while it waited,
so a toast never names a task that is gone.

## A return to the main conversation opens on a recap

An isolated column's session runs in a conversation of its own (see
[Isolated sessions](spawn-flow.md#isolated-sessions-per-column-session-model)). Its commits land
in the shared worktree, but the main conversation never saw them. In an overnight workflow, Code
Review ran in its own conversation, committed its fixes and ended Ready. Testing then resumed the
main conversation, which ran its gate against a branch it believed it knew (task #952). So when
`spawnAgent` resumes the task's main conversation, it tells the agent what the isolated sessions
did (`src/main/transition-engine/return-recap.ts`). The recap is plain text in the opening
message, so it works for every agent and every column setup.

- **What ran.** `SessionRepository.listIsolatedSince` lists the task's isolated sessions that
  started at or after the main conversation last ran: its record's suspend, else its exit, else
  its start (`mainConversationLeftAt`). A column re-entered after a send-back counts, and so do two
  isolated columns in a row.
- **What it says.** The isolated columns by name. The first-parent commits since the earliest
  session's `sessions.start_head_sha` (`readCommitsSince` in `src/main/git/worktree-head.ts`), at
  most 20 of the newest with a count of the rest, and HEAD now. A merge of the base branch reads as
  one commit. The final message of each of the latest three sessions, each cut to 1,500
  characters. A move that carries its own message (a Move to column row's Message,
  `kangentic_move_task`'s `message`, passed down as `moveCarriesMessage`) leaves the final
  messages out, since that message is usually the same reply. With no commit and no message there
  is no recap.
- **Bounded.** It is built under the task lock. Each final-message read gets 2 s and the whole
  recap 3 s, after which the resume goes without it.
- **Only a resume of the same agent's main conversation.** A fresh spawn has nothing to catch up,
  a handoff gets the other agent's history, an always-new column starts over, and a recovery move
  out of Done sends nothing. A resume the engine started over (`SpawnOutcome.startOver`) drops it.

How the recap opens the resume depends on the lead the column would send, and on whether messages
held for the task go with it (`returnRecapOpeningFor`):

- **Plain text** gets the recap ahead of it, in one turn (`prefix`). With no lead, held messages
  take its place.
- **A slash command** cannot have text ahead of it, because that stops the command running in
  every agent CLI. The recap is then the resume's whole prompt and asks for a one-line reply
  (`before-command`). The session is marked a `return` recap (`recap-turns.ts`), so that turn runs
  no On agent turn end rows and no workflow step. The command, and any held messages, wait for that
  turn to end (`whenRecapTurnEnds`) and then go as usual. After 20 minutes without a turn end (an
  interrupted recap) they go anyway, except while the session waits at a usage limit with every
  account full, when that bound is paused (`pauseRecapTurnWait`). A move of the task or the session
  leaving first sends nothing:
  the column's message is reported cancelled and held messages are released. An account
  continuation that restarts the session during the recap is not a leave. It carries the mark to
  the session that replaces it (`carryRecapAcross`), which opens on the same recap, and what waited
  goes to that session once its recap turn ends. A settings change that restarts the session idle
  during the recap (a column or Board Profile edit, a model or effort pick) carries the mark too
  (`restartIdleKeepingRecap`). That replacement takes no recap turn, so what waited goes to it at
  once.
- **No lead and nothing held** makes the recap the whole prompt, which asks for a one-line reply
  and then a wait (`acknowledge`). That turn is a `return` recap too, so it runs no rows and no
  step. This is a send-back (Code Review moving the task to a column whose own message is off),
  whose findings follow the move as its message once this turn ends, or a person who moved the task
  to type the next instruction. A recap that told the agent to carry on had it working a whole turn
  before the findings arrived.

A recap the resume command line could not carry is typed ahead of the next message the start
sends, never ahead of a slash command. Ahead of one it is typed on its own first, and if that
delivery fails nothing waits on it.

## A restore reports progress instead of showing a Resume button

Restoring from Done is slow (the worktree is recreated from the preserved branch, then the CLI
boots) and the task's suspended record survives that whole window, so the UI used to advertise a
manual "Resume session" button while the engine was already restoring the conversation. Three things
now prevent that:

- `TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE` thread `onProgress` into their git helpers exactly as
  `task-move` does, and emit `resuming` immediately so the card is never silent while the lane is
  resolved and the git op queues.
- The Resume button's own handler (`SESSION_RESUME`) does the same once it knows it will spawn
  (its self-heal return spawns nothing): it emits `resuming`, threads `onProgress` into
  `ensureTaskWorktree`, and releases the label in one `finally`, so a paused card stops reading
  "Paused" while its resume runs. It labels through `claimSpawnProgress`, whose release clears
  only while no other path has labelled the task since. The label slot is per task, and a phone
  Start or a newer resume can be labelling the same task when this one unwinds. Every other spawn
  path still clears unconditionally.
- `getTaskProgress` lets an in-flight spawn label outrank a `suspended` session (only `suspended`;
  a running or queued session owns its own display). An emitted label means main is spawning right
  now, which is newer than a record suspended earlier.

The task therefore shows the `preparing` launch overlay from about 100ms after the drop, through
"Creating worktree..." and "Starting agent...", until the terminal takes over.

The same mechanism generalizes to a **same-column respawn**: a live session forced to suspend and
restart in place, not because the task moved to Done and back but because the destination column
needs new CLI flags on a resumed process. `suspendLiveSessionForRespawn`
(`src/main/ipc/handlers/task-move.ts`) is the shared helper behind all four triggers - a model
change, a cross-agent handoff, an effort change to a concrete value, and a session-track
switch (isolated-column entry/exit, or `always_spawn_new`) - and it emits its phase label
(`switching-model` / `switching-agent` / `applying-settings` / `new-session`) as its first
statement, before the record is even marked suspended. Without this, the suspend that begins the
respawn left the card reading "Paused" and the detail offering a manual "Resume session" for the
whole unlocked worktree/branch-checkout window between the suspend and the eventual
`starting-agent` label.

The in-place restart, `restartSessionForSettingsChange` (`src/main/ipc/handlers/session-reconcile.ts`),
follows the same contract with a required `phase`: the ContextBar model/effort pick, an MCP
`kangentic_update_task` settings write, and a column or Board Profile propagation emit `switching-model` (or `applying-settings` for an effort-only
restart), and the auto_command escalation emits `resending-command` ("Re-sending command...").
A queued session is not restarted by any of these: its waiting command is rebuilt in place (see
[Command injection](../automations/command-injection.md)), so no phase label is emitted for it.
It emits before its
suspend and clears the label in a `finally` once the resume has returned or failed, the ordering
task-move's Phase 3 uses. The emit is what lets the mobile bridge tell this respawn from a park
(see [Scope and protocol history](../../integrations/mobile-bridge/scope.md#protocol-0140-a-respawn-shows-the-phone-switching-not-ended)); until #682 this path emitted nothing, and the phone showed
"Session ended" for the swap.

That main-side emit alone is not sufficient: `SessionManager.suspend()` pushes the session's
`suspended` row to the renderer almost immediately, well before its own graceful-shutdown wait
completes, and the renderer's `upsertSession` (`src/renderer/stores/session-store.ts`) used to
clear any in-flight spawn-progress label on every arriving row - including that one - wiping the
label within milliseconds of it being set. `upsertSession` now skips the clear specifically when
the arriving row's status is `suspended`, since that row is the respawn's own suspend landing, not
a genuine park. `clearSpawnProgress` remains the only way a label actually retires, but only two
park paths in `task-move.ts` call it explicitly (move to Done, move into an `auto_spawn=false`
column). Five other genuine parks - a manual pause (`pauseTaskSession` in
`handlers/session-pause.ts`, which the desktop's `SESSION_SUSPEND` and the phone's `pause-session`
verb share), the idle-timeout suspend,
the `kill_session` action, project-relocate, and auto-spawn-reconcile - suspend through
`applySuspendDbWrites` or `executeKillSession` and never clear a label explicitly; this is a
known gap, not fixed here, and a label still in flight when one of those fires survives until the
120s TTL sweeps it (see the carve-out's own comment in `session-store.ts` for the full list).

When a suspended task moves to an active column:

- Command: `claude --settings <path> --resume <agentSessionId>`, plus `-- "<message>"` when the
  move carries one (the column's message, a plan continuation, held messages). On an agent whose
  resume takes no prompt, the message is typed in once the agent is ready instead (see
  [How the resume prompt arrives](#how-the-resume-prompt-arrives))
- The resumed id tracks mid-session forks. Running `/clear` inside a Claude session forks the
  conversation to a brand-new session id. Its SessionStart hook names the new id, the statusline
  re-reports it, and the change-sensitive status-file capture
  (`SessionTelemetry.processStatusUpdate` -> `recoverStaleSessionId`) rewrites
  `sessions.agent_session_id` live. The capture adopts a changed id only after such a hook named
  it, because another process started with the same `--settings` can write the same status file.
  At resume time, `reconcileResumeAgentSessionId`
  (`src/main/transition-engine/resume-id-reconcile.ts`) additionally checks the retiring record's
  own `status.json` and swaps the resumed id if a fork landed in the final seconds before suspend
  (the status watcher detaches before the CLI exits), under the same hook rule. Details and the
  empirical grounding: docs/integrations/agents/session-history.md, "Mid-session fork reconcile".
- A conversation Claude Code's `/bg` moved into a background session of its own can still be
  running there, because the supervisor runs it outside the task's PTY. When the record's own
  events file shows that (`backgroundSessionHoldingConversation`), the same reconcile first stops
  it through the CLI (`AgentAdapter.stopBackgroundSession`), so the resume never runs a second
  process on the conversation, then asks `resolveResumableSessionId` for the id `--resume`
  reaches: a background session that took no turn resumes by the conversation it continued. An
  ordinary resume runs no CLI. See
  [Claude Code background sessions](../../integrations/agents/session-history.md#claude-code-background-sessions-bg).
- New PTY spawned with scrollback carried over from the most recently started previous row for the task (see [Spawn flow](spawn-flow.md#engine-spawn-board-driven-path))
- New session DB record inserted, old record marked `exited`
- The destination column's settings are re-applied as CLI flags on the resume
  command: `--permission-mode` (a column set to plan wins, else the task's pin,
  then the column's mode, then the global default), `--model`, and `--effort`.
  A resume in the same column can leave `--permission-mode` out (the next
  bullet).
  A move into a column that changes the model or effort to a
  concrete value forces this suspend + respawn cycle on a live session; neither
  is ever typed into the PTY as `/model` or `/effort`. A permission-mode change
  alone never restarts a live session: in the Planning -> Executing flow Claude
  already left plan mode in-session, so the recorded spawn-time mode is stale.
- A resume in the column the session was paused in keeps the permission mode the
  conversation was last in. The Resume button, opening a paused task, a phone
  resume, a restart of the app and an in-place restart for a settings change all
  pass `keepSessionMode`, and `keepsSessionPermissionMode` (`spawn-preamble.ts`)
  then leaves `--permission-mode` off for an agent whose CLI restores the mode
  itself (`AgentAdapter.restoresPermissionModeOnResume`, Claude). So a session
  the user switched out of plan mode comes back in the mode it was switched to.
  The flag is still stated when the column's mode differs from the one the
  session was last launched with (the column was edited), when that mode is
  bypass (Claude never restores bypass), on a move into a column, and on a Resume
  after the task entered its column while paused. The new session row records the
  column's mode either way.
- A plan-exit auto-move (Planning -> Executing), triggered when the plan is
  approved, by the user or by Kangentic with the column's Plan approval set to
  Automatic (the `ExitPlanMode` tool completes, not when the agent merely
  invokes it), passes a continuation prompt
  ("The session restarted to apply the <column> column's settings. Proceed
  with implementing the approved plan.", naming the destination column)
  delivered as the resumed session's first message only when neither the
  destination column's message (its first enabled `send_message` enter
  automation) nor the task's own `auto_command` is set. Either one takes the
  prompt slot instead. On an agent whose resume takes no prompt, the
  continuation is typed in once the agent is ready; it used to be lost there.
  It names the restart because the suspend lands right after approval and Claude
  Code records it as `[Request interrupted by user]`. Without the reason, the
  resumed turn reads as the user stopping the agent and typing a new
  instruction. A plan exit that switches session track (into an isolated
  column, or out of one back to main) or lands in an always-new column sends
  no continuation, and neither does one into a column that runs a different
  agent. Each of those moves lands in a different conversation, which never
  saw the plan. A handoff drops it whether or not the target agent has an
  older conversation on the task; when it has one, `spawnAgent` resumes that
  conversation.
- The resume prompt is also how **auto_command escalation** lands. When a live
  session's keystroke injection cannot be confirmed in the agent's transcript,
  `restartSessionForSettingsChange` suspends and resumes with the command as the
  prompt argument, which is guaranteed by the spawn rather than by TUI timing.
  Only an adapter whose resume carries a prompt
  (`resumePromptDelivery: 'command-line'`) escalates. For any other, the restart
  would type the command again, which is the delivery that just failed, so
  `prepareInjectionPlan` marks it `escalatable: false` and an unconfirmed command
  ends `failed`.
  That restart is gated on the turn-completion predicate (activity idle AND a
  quiet PTY) so it can never kill live work, is attempted at most once, and
  carries only the user's `auto_command` - never an adapter-emitted settings
  write, which would arrive as literal message text. While the gate waits, the
  scheduler re-polls the verifier against the burst's original first-Enter
  watermark, and a late confirmation cancels the restart: a command that went
  in but confirmed late (a late transcript flush, or a submission the CLI
  queued behind a running turn) must not be run a second time, which is what
  happened on every observed Tests-to-Ship-It move before #682. Unlike the
  ordinary settings-change restart it does NOT assert idle-authoritative
  afterwards, because a resume with a prompt starts a real turn. The exception
  is a command that cannot ride the command line (lines a `.cmd` shim launch
  would flatten, or over the cap): the engine keeps it off, asserts idle itself,
  and the restart types `unsentPrompt` in once the agent is ready. See
  [Command Injection](../automations/command-injection.md) for the full delivery ladder.
- The **first move OUT of Done** (the recovery / restore move, whatever the
  destination column) resumes the session WITHOUT delivering the destination
  column's message. Restoring a Done task is usually to inspect the
  session or ask a question, so the message (e.g. `/merge-pull-request`)
  sits idle until the next move. This is unconditional and matches crash
  recovery, which also resumes command-free. Every Done-out path goes through
  `spawnAgent`'s `suppressAutoCommand`: the unarchive handlers
  (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) set it on their `spawnAgent`
  calls, and a non-archived Done-out move (MCP `move_task`, legacy rows) gets
  it from `handleTaskMove` when `fromLane.role === 'done'`. Model / effort /
  permission-mode settings still apply on the recovery move. The next move
  delivers per column config as usual.

  **Only rows that need the agent are suppressed.** The destination's On enter
  group still runs, so a script, a webhook or a notification fires as it
  normally would; a recovery move is not a reason to stop telling a webhook the
  task moved. The flag reaches the runner as `suppressAgentMessages` and each
  suppressed row is recorded `skipped` with the reason, rather than being
  allowed to run against a `deliverToAgent` that silently does nothing and then
  report a success for a message nobody received. See
  [The column's message on a move](../automations/transition-engine.md#the-columns-message-on-a-move).

## How the resume prompt arrives

A resume can carry a message: a column's message, a plan continuation, a handoff pointer to the
source agent's history, or [held messages](held-messages.md). Not every CLI takes a prompt with a
resume, so each adapter declares `AgentAdapter.resumePromptDelivery`:

- `command-line`: the resume command carries the prompt (`claude --resume <id> -- "..."`,
  `codex resume <id> "..."`) and nothing is typed. Claude, Codex, Gemini, Qwen Code, Antigravity,
  Droid, Goose and Aider. Aider's resume restores the session's own history file
  (`--restore-chat-history`) and carries the message on `--message`, which replies once and exits,
  as a fresh Aider start does.
- `typed`: the CLI takes no prompt with a resume, or does not document that it does. Copilot,
  Grok, OpenCode and Cursor each take a prompt on a new session, but nothing they document says it
  runs on a resumed one. Kimi Code's interactive session takes no prompt on any launch.
- `no-resume`: the adapter has no session id to resume by, so every start is fresh. Ollama and
  Warp's oz.

`tests/unit/resume-prompt-delivery-parity.test.ts` builds each real adapter's resume command with
a marked prompt and holds the declaration to what the builder does.

A fresh session has the same question, answered by the optional
`AgentAdapter.freshPromptDelivery`. Omitted or `command-line`, the launch carries its prompt. Set
to `typed` (Kimi Code), the engine keeps the whole prompt off the command line and returns it as
`SpawnOutcome.typedOpening`, the field an adopted early agent uses, and the caller types it in
before it sends the agent anything else. That spawn opens idle (`markIdleAuthoritative`), since no
turn runs until the prompt lands. Startup recovery types nothing, so it opens such an agent with
no recap. A workflow's agent cannot be one (`canBeWorkflowAgent`). A fresh prompt too long for its
command line goes the same way on an agent that may take it typed, and is refused on any other
([A prompt too long for its command line](spawn-flow.md#a-prompt-too-long-for-its-command-line)).

The engine decides per spawn with `resumePromptRidesCommandLine`
(`src/main/transition-engine/resume-prompt-delivery.ts`). The prompt rides only when all four hold:

- the adapter is `command-line`;
- a multi-line prompt keeps its lines. A `.cmd` shim under PowerShell or Git Bash flattens one
  (`resolveShimLaunch` strategy `flattened-prompt`), and so does quoting for a cmd.exe shell or for
  no known shell (`quoteArgKeepsNewlines`). Flattened, a numbered list of held messages runs
  together;
- it does not open with `-`. Codex takes its resume prompt as a bare positional, so such a prompt
  would read as an option and the resume would not start;
- it fits under `RESUME_PROMPT_COMMAND_LINE_CAP`, 6,000 characters by `commandLineLength`, which
  counts each `%` as the `"^%"` cmd.exe gets. cmd.exe cuts a whole command line at 8,191, and the
  rest of a resume command takes up to about 1,500 of them.

Otherwise the builder gets no prompt and the resume opens idle. The engine hands the whole prompt
back in `SpawnOutcome.unsentPrompt`, the handoff pointer included, and calls
`markIdleAuthoritative` on the new session. Claude's resume reloads its context with no hook, which
the status heartbeat reads as 30 s of thinking, and that would hold the typed delivery back.
`unsentPrompt` is also set when a fresh spawn's task template took the prompt slot (a resume that
started over, a forced-fresh spawn) and the carried message could not follow it: the caller did
not set `carriedMessageJoinsTemplate`, or the joined opening would not fit a command line the agent
cannot type past. It replaced `resumePromptUnsent`, a boolean that covered only that case.

Every caller types what comes back once the agent is ready:

- `spawnAgent` (`helpers/agent-spawn.ts`): the column's message or the task's own command, a plan
  continuation, and a handoff pointer, with any held messages in the same delivery.
- `resumeTaskSession` (`handlers/session-resume.ts`): the Resume button, the Commands menu's
  command, and the phone's resume of a paused task.
- `restartSessionForSettingsChange` (`handlers/session-reconcile.ts`): an escalation command that
  could not ride.

The engine used to report a resume prompt unsent only for a fresh spawn. Codex, Copilot, Grok,
OpenCode and Cursor built their resume commands without the prompt while `spawnAgent` believed it
rode and skipped its typed fallback, so the column's message never arrived. The Resume path and
the escalation restart discarded the spawn's outcome entirely, and a plan continuation or handoff pointer that did not ride
was lost. Escalation, rung 3 of the [delivery ladder](../automations/command-injection.md#the-delivery-ladder),
now runs only for a `command-line` adapter.
