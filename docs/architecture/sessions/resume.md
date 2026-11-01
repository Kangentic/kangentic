---
type: Reference
title: Resume
description: Why Resume is refused for To Do, Done and archived tasks, assessResumeConversation's never-started, expired and unknown verdicts with the expired-conversation recap, the return recap a main conversation gets after an isolated column's session, who resumed a session (resumedBy), fork id reconcile, plan-exit continuation, auto_command escalation, and restore progress labels.
tags: [sessions, resume, expired-conversation, recap, return-recap]
sources:
  - resource: src/main/transition-engine/resume-conversation-guard.ts
  - resource: src/main/transition-engine/resume-id-reconcile.ts
  - resource: src/main/transition-engine/expired-recap-sources.ts
  - resource: src/main/agent/shared/expired-conversation-recap.ts
  - resource: src/main/agent/adapters/claude/conversation-gone.ts
  - resource: src/main/ipc/helpers/pending-conversation-expired.ts
  - resource: src/main/ipc/handlers/session-resume.ts
  - resource: src/shared/session-resume-eligibility.ts
  - resource: src/main/ipc/handlers/session-reconcile.ts
  - resource: src/main/transition-engine/spawn-progress.ts
  - resource: src/main/automations/turn-end/recap-turns.ts
  - resource: src/main/transition-engine/resume-prompt-delivery.ts
  - resource: src/main/transition-engine/return-recap.ts
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
`'recovery'`. The workflow's memory resume passes `'memory'` through `resumeTaskSession` and
`SpawnOverrides.resumedBy`. Workflow recovery reads it: an agent Kangentic restarted lost the
background commands it started, so its recovery starts over at once (see
[Workflow engine](../workflows/workflow-engine.md)).
A transient session emits none. Turn ends themselves arrive as `'turn-ended'`, a separate event
from `'activity'`; see [Activity event types](../activity/event-types.md#turn-ends-onturnended).

## Where resume is refused

`SESSION_RESUME` (the task detail's Pause/Resume toggle and the card menu's Resume session row) restarts a suspended session **in
place**, in the task's current column. Its body is `resumeTaskSession`
(`handlers/session-resume.ts`), which the phone's `start-session` verb also calls for a paused
task, so a phone Resume is the same resume: it cancels a resume already in flight for the task,
labels the task "Resuming session...", resumes the conversation idle, and runs no enter
automations or column message. The exception is a task that entered its column after it was
paused (its current visit's `task_moves.at` is later than the record's `suspended_at`) in a column
that starts an agent. A move never starts a paused agent, so that entry ran only its rows that need
no agent. The Resume then calls `spawnAgent` with `resumesEntry` instead of the engine: the column's
own strategy (a fresh conversation in an always-new column) and its enter rows that need the agent.
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

`assessResumeConversation` (`src/main/transition-engine/resume-conversation-guard.ts`) decides
before the spawn, at both chokepoints (`executeSpawnAgent` and `prepareAgentSpawn`), and answers
`never-started`, `expired`, or `unknown`. It runs AFTER the resume-time id reconcile, so it checks
the id actually being resumed, and on the board path after the cwd migration too, so it finds a
migrated file where it now is (startup recovery migrates nothing). Both chokepoints build the
lineage below with one helper, `resolveResumeLineage`.

The evidence is per record of the conversation's lineage (the retiring record, then every record
sharing the reconciled `agent_session_id`, newest first), from three agent-written sources:

| Source | Transcript path | Turns |
|---|---|---|
| the session row | `sessions.transcript_path`, written from the status line when it changes, and inherited at insert from the same conversation's newest row | token or cost totals above zero prove turns; zero proves nothing |
| `status.json` | the status line's `transcript_path`, when its `session_id` is the resumed id (another process with the same `--settings`, such as a background daemon's spare, can write it last) | tokens or cost |
| `events.jsonl` | `transcript_path` inside the SessionStart hook payload | any event beyond `session_start` / `session_end` |

The row exists because a quit or a removal deletes the session folder (`detachAndDelete`), which
left most old conversations with no evidence at all. The SessionStart hook exists because the
status line only runs once the TUI is up, so a CLI killed in its first second leaves no status.

- **`never-started`** needs no turns anywhere in the lineage, the agent's own report (status or
  hook, never the row alone) saying so, and the path it names failing with ENOENT. The spawn is
  re-resolved `forceFresh` exactly as before: the task's own prompt, no recap, no notice. A column
  message the resume carried goes out after the spawn, as on any fresh spawn, since the task
  template took its place in the prompt. The spawn hands that message back in
  `SpawnOutcome.unsentPrompt` for the caller to type in.
- **`expired`** needs turns and the adapter's proof that the file is gone
  (`AgentAdapter.proveConversationGone`). Claude's (`adapters/claude/conversation-gone.ts`) wants an
  absolute reported path named `<id>.jsonl`; that path and the one every reader would open both
  failing with ENOENT (the transcript locator's, which looks past the cwd to the folder the
  conversation started in, see [Where a Claude transcript is](../../integrations/agents/session-history.md#where-a-claude-transcript-is);
  a permission or lock error is not proof, `agent/shared/confirmed-missing.ts`); the projects folder
  two levels above the reported path readable (a WSL session's Linux path stops here); and no
  project folder under it, a symlinked or junctioned one included, holding `<id>.jsonl` (measured at
  16 to 22 ms over 617 folders), so a file Claude might find elsewhere always resumes.
  Claude's own retention sweep does not race it: in Claude Code 2.1.300 it is background
  housekeeping, first run 5 s after launch and at most once a day, while `--resume` resolves its
  file at launch.
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
  recap's turn. Startup recovery's recap is the whole prompt on every session,
  so its first turn is skipped the same way. That pass therefore starts each expired task working:
  one summary turn per task, paid in model tokens with nobody watching, which is the price of the
  task saying where it stands when the user next opens it.
- **On an isolated column set to keep its own conversation** (isolated plus `create_or_resume`,
  never the default) the old conversation says the column's pass is old, not the task, so it starts
  a normal fresh pass with the recap prepended as context, and its turn end runs the column's rows.
  When the column sends its task template, the template is the pass's prompt and the column's
  message goes out after the spawn, as on any fresh spawn. A column prompt too long to leave room
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
  interrupted recap) they go anyway. A move of the task or the session leaving first sends nothing:
  the column's message is reported cancelled and held messages are released.
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
  command: `--permission-mode` (lane override, else global default), `--model`,
  and `--effort`. A move into a column that changes the model or effort to a
  concrete value forces this suspend + respawn cycle on a live session; neither
  is ever typed into the PTY as `/model` or `/effort`. A permission-mode change
  alone never restarts a live session: in the Planning -> Executing flow Claude
  already left plan mode in-session, so the recorded spawn-time mode is stale.
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
  Kimi, Droid and Goose.
- `typed`: the CLI takes no prompt with a resume, or does not document that it does. Copilot,
  Grok, OpenCode and Cursor each take a prompt on a new session, but nothing they document says it
  runs on a resumed one.
- `no-resume`: the adapter has no session id to resume by, so every start is fresh. Aider, Ollama
  and Warp's oz.

`tests/unit/resume-prompt-delivery-parity.test.ts` builds each real adapter's resume command with
a marked prompt and holds the declaration to what the builder does.

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
started over, a forced-fresh spawn). It replaced `resumePromptUnsent`, a boolean that covered only
that case.

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
