---
type: Reference
title: Resume
description: Why Resume is refused for To Do, Done and archived tasks, assessResumeConversation's never-started, expired and unknown verdicts with the expired-conversation recap, fork id reconcile, plan-exit continuation, auto_command escalation, and restore progress labels.
tags: [sessions, resume, expired-conversation, recap]
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
---
# Resume

A resumed agent comes back idle and reports no turn end, so `SessionManager` announces the resume
itself. Every task session spawned with `resuming: true` and reaching `running` (a Resume, a
workflow's Resume, launch recovery, recovery after a pty host crash) emits `'session-resumed'`
with the session, task and project ids, the conversation it resumed, and its work serial as it
came back. A resume begins no turn, so the payload carries neither a turn start nor a transcript
anchor. The turn-end runner uses it to give a workflow task the step check a Pause or a quit
cut short (see [Transition Engine](../automations/transition-engine.md), "A resume catches up the workflow step").
A transient session emits none. Turn ends themselves arrive as `'turn-ended'`, a separate event
from `'activity'`; see [Activity Detection](../activity/index.md), "Turn ends".

## Where resume is refused

`SESSION_RESUME` (the task detail's Pause/Resume toggle and the card menu's Resume session row) restarts a suspended session **in
place**, in the task's current column. Its body is `resumeTaskSession`
(`handlers/session-resume.ts`), which the phone's `start-session` verb also calls for a paused
task, so a phone Resume is the same resume: it cancels a resume already in flight for the task,
labels the task "Resuming session...", resumes the conversation idle, and runs no enter
automations or column message. The read-stream feed tells the phone when that promise holds
(`resumable`, see [Mobile Bridge](../../integrations/mobile-bridge/index.md)). It is refused for three states, resolved by one shared
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
| the session row | `sessions.transcript_path`, written from the status line when it changes | token or cost totals above zero prove turns; zero proves nothing |
| `status.json` | the status line's `transcript_path` | tokens or cost |
| `events.jsonl` | `transcript_path` inside the SessionStart hook payload | any event beyond `session_start` / `session_end` |

The row exists because a quit or a removal deletes the session folder (`detachAndDelete`), which
left most old conversations with no evidence at all. The SessionStart hook exists because the
status line only runs once the TUI is up, so a CLI killed in its first second leaves no status.

- **`never-started`** needs no turns anywhere in the lineage, the agent's own report (status or
  hook, never the row alone) saying so, and the path it names failing with ENOENT. The spawn is
  re-resolved `forceFresh` exactly as before: the task's own prompt, no recap, no notice. A column
  message the resume carried goes out after the spawn, as on any fresh spawn
  (`SpawnOutcome.resumePromptUnsent`), since the task template took its place in the prompt.
- **`expired`** needs turns and the adapter's proof that the file is gone
  (`AgentAdapter.proveConversationGone`). Claude's (`adapters/claude/conversation-gone.ts`) wants an
  absolute reported path named `<id>.jsonl`; that path and the locator's both failing with ENOENT (a
  permission or lock error is not proof, `agent/shared/confirmed-missing.ts`); the projects folder
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
(see [Mobile Bridge](../../integrations/mobile-bridge/index.md)); until #682 this path emitted nothing, and the phone showed
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

- Command: `claude --settings <path> --resume <agentSessionId>` (no prompt)
- The resumed id tracks mid-session forks. Running `/clear` inside a Claude session forks the
  conversation to a brand-new session id; the statusline re-reports it and the change-sensitive
  status-file capture (`SessionTelemetry.processStatusUpdate` -> `recoverStaleSessionId`)
  rewrites `sessions.agent_session_id` live. At resume time,
  `reconcileResumeAgentSessionId` (`src/main/transition-engine/resume-id-reconcile.ts`)
  additionally checks the retiring record's own `status.json` and swaps the resumed id if a fork
  landed in the final seconds before suspend (the status watcher detaches before the CLI exits).
  Details and the empirical grounding: docs/integrations/agents/session-history.md, "Mid-session fork
  reconcile".
- New PTY spawned with scrollback carried over from the most recently started previous row for the task (see Spawn Flow above)
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
  prompt slot instead. It names the restart because the suspend lands right after approval and Claude
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
  afterwards, because a resume with a prompt starts a real turn. See
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
  [Transition Engine](../automations/transition-engine.md#command-injection).
