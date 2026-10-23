# Transition Engine

`src/main/transition-engine/transition-engine.ts`

The transition engine runs a column's automations when tasks move between swimlanes. It handles the logic that makes Kanban columns "active" -- spawning agents, sending messages, running scripts, calling webhooks, and raising notifications.

Each column owns ONE ordered list, split into three groups: On task enter, On agent turn end and On task exit. An automation belongs to exactly one column: there are no `from -> to` pairs and no shared, named actions. Every type is an adapter under `src/main/automations/adapters/`, declared once in `AUTOMATION_MANIFEST` (`src/shared/automation-manifest.ts`), and the engine dispatches through `automationRegistry`. Users edit the lists in the Column Manager; the file format is [Configuration](configuration.md#column-automations) and the tables are [Database](database/index.md).

## Priority Rules on Task Move

When a task moves from one column to another, the IPC handler (`task:move`) checks these conditions in order. The first match wins:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Target is **To Do** (role=`todo`) | Drop the PR link of a task that did its own work as the move commits (`forgetPRLinkOnTodoReset`, see [pr-integration.md](integrations/pull-requests/index.md)), then kill session, reap what the task left running, remove worktree (and branch when `git.autoCleanup` is on) |
| 2 | Target is **Done** (role=`done`) | Suspend session (resumable), reap what the task left running, archive task |
| 2.5 | Target has `auto_spawn=false` (non-todo, non-done) | Suspend session |
| 3 | Task has **active session** | A model or effort change suspends and respawns with the destination's CLI flags. A column message alone is injected into the running session. A permission-only change, or none, keeps it alive. |
| 4 | Task has **no session** | Resume suspended session (with the column's message preloaded as resume prompt) OR create worktree (if enabled) + run the destination's On enter group |

The SOURCE column's On exit group runs ahead of all five, in Phase 1. See [Triggers](#triggers).

"Active session" is decided against the registry, not the raw `task.session_id`. Phase 1 runs `reconcileTaskSessionRef` (`session-reconcile.ts`, the same self-heal `SESSION_RESUME`, `SESSION_RECONCILE`, `SESSION_SUSPEND`, `task:setRuntimeOverride`, and the auto_spawn-off suspend in `reconcileAutoSpawnChange` use) before the ladder: a pointer at a non-live registry row (an agent that exited on its own, a `--resume` that could not read its transcript) is cleared so the move takes Priority 4 and resumes the record, and a live PTY the pointer lost is re-linked so the move takes Priority 3 instead of spawning a second agent. Before #682 the raw pointer decided, and a task whose CLI had ended by itself was "kept alive" on every move with nothing running.

### Priority 3: Active Session Handling

Priority 3 has four sub-cases, checked in order:

**a) Agent change (handoff):** If `resolveTargetAgent()` returns a different agent than the current session's agent, the session is suspended and the engine falls through to the `spawnAgent` path. The `agentOverride` parameter is set on the spawn request to prevent the new session from resuming the old agent's session. **Side effect:** per-task `model_override` and `effort_override` are cleared on handoff because override values are model-name-specific and don't carry across agents (Claude's `claude-sonnet-4-6` is meaningless to Codex). This clear is skipped when `task.agent_override` is set, since the user locked the agent at creation and the overrides remain valid for that agent. If the target column has `handoff_context` enabled, prior work context (transcript, git diff, metrics) is packaged and delivered to the new agent. If disabled (the default), no history is packaged: the new agent gets only the task title/description, or resumes its own earlier conversation on this task when one is resumable. See [Cross-Agent Handoff](#cross-agent-handoff) below.

**b) Same agent + model or effort change:** If `prepareInjectionPlan` returns a `restartReason` (`'model'` or `'effort'`), the session is suspended and respawned so the destination's `--model` / `--effort` / `--permission-mode` land as launch flags. Nothing is typed into the PTY: a live `/model` left the agent paused after a Planning -> Executing handoff, and a mid-turn `/effort` writes no transcript entry, so it could not be confirmed on a plan-exit move, which always lands mid-turn. The respawn resumes the same agent session id and carries the column's message as its prompt. A plan-exit auto-move passes a continuation prompt that names the destination column ("The session restarted to apply the <column> column's settings. Proceed with implementing the approved plan.") delivered as the resumed session's first message only when neither the destination column's message (its first enabled `send_message` enter automation) nor the task's own `auto_command` is set; either one takes the prompt slot instead. No continuation is sent when the move switches session track (into or out of an isolated column), lands in an `always_spawn_new` column, or changes agent: each of those lands in a conversation that never saw the plan. The progress label is `switching-model` for a model change and `applying-settings` for an effort-only one.

The delta is computed against what the session is *actually running at*, not the leaving column, so a column whose value the session already has restarts nothing. The two fields resolve that differently: **model** uses the session record's `applied_model`, while **effort** prefers the level the agent itself reports (`task.effort_override ?? <agent-reported effort> ?? record.applied_effort`), because `applied_effort` records only what Kangentic last asked for and an `/effort` typed straight into the terminal never reaches it. A level the model silently downgraded counts as applied: when the target equals `applied_effort` and the reported level has not moved since the session's first report, nothing restarts. Model deliberately stays record-only - telemetry reports canonical ids while the configured values are flag strings, so comparing them would read a false change and restart the PTY on every move. Only a concrete target restarts: entering a "Default" column (null target) keeps the session, since `--resume <id>` preserves what it runs at. A per-task override wins on both sides, so a pinned field never restarts. See [Command Injection](command-injection.md) for the full precedence.

**c) Same agent + column message only:** If the plan carries the column's message and no `restartReason`, the message is scheduled into the running session via `TerminalSubmitScheduler.scheduleKeystrokes`. No suspend/resume cycle occurs. A column message that `shouldPaste` (more than one line or over 1,000 characters, and not a slash command) stays out of the plan and is pasted into the session instead, after the turn ends; the row still counts as delivered, so the On enter group does not send it again.

**d) Same agent, permission-only change or no change:** The session stays alive with no interruption. A permission-mode delta never restarts: in the canonical Planning -> Executing flow the user already approved the plan in the terminal and Claude left plan mode in-session, so the spawn-time permission mode recorded on the session is stale.

## Triggers

An automation's `trigger` is `enter`, `turn_end` or `exit`. `enter` and `exit` mean any move into or out of the column it belongs to; `turn_end` means each time the agent working the task finishes a turn there. There is no `from -> to` pair and no wildcard, because a list belongs to one column rather than to a lane pair. The three are declared once in `AUTOMATION_TRIGGERS`.

**On exit runs in Phase 1**, inside the short task lock, after the DB write and the `board:changed` emit and BEFORE the priority branches. That order is load-bearing: Priority 1 kills the session, so an exit automation that needs the agent has to find it still attached. Two consequences:

- **An exit automation never aborts the move.** The rollback only reverts Phase 2 and Phase 3, and the group runs after the commit point. A throw, a timeout, or the whole group failing records its outcome and the move proceeds to its priority branch.
- **The exit group is capped at 60 seconds in aggregate** (`EXIT_GROUP_BUDGET_MS`), overriding the adapters' own budgets, because holding the short lock is what wedges that task's next move. A row that would exceed the cap is recorded `failed` with "Exit automations are capped so the board stays responsive." Exit is for quick handoffs; long work belongs on enter, where Phase 3 already holds the lock across the spawn and has a progress spinner to show for it.

**On enter runs at both of the destination's session paths.** Priority 3's two keep-alive returns run the group against the live session (`runWarmEnterAutomations`), and Priority 4 runs it with the fallback spawn handed in as `startAgent`. To Do and Done run exit rows only: an enter automation can never fire there, so the Column Manager does not offer the group and `canColumnRun` blocks one written by hand.

### On agent turn end

`src/main/automations/turn-end/turn-end-runner.ts`, wired in `register-all.ts`. It is not part of a move: it runs when the agent working a task finishes a turn.

- **What a turn end is.** The activity engine's `onTurnEnded` (`SessionManager`'s `'turn-ended'` event): a thinking-to-idle commit whose turn the agent's own turn-end hook cleared (a Stop: a non-permission `Idle` at subagent depth 0), after any background work the turn left has drained. Never an interrupt, a failed turn, an `idle_hint` (Esc between tool calls ends a turn that way, with no hook), PTY silence or a watchdog guess. Only agents that declare `reportsTurnEnd` on their runtime strategy have one; a column whose agent does not (its only signal is terminal silence) offers no turn-end group. The listener only schedules: the work runs off the engine's commit stack.
- **Only a turn that began in this visit counts.** The payload carries `turnStartedAt`, and a turn that began before the task's latest `task_moves` entry into the column is ignored: a task dragged in mid-turn ends that turn here, but the turn did the last column's work. A plan approval is the exception. The agent implements in the same turn that planned, so the activity engine stamps the turn's start again when the approval resolves the plan prompt, and the turn counts in the column the task is in by then: one the approval moved it to (origin `auto-move`), or one it was dragged into before the approval. `{{agentReply}}` is the implementation's reply. An `auto-move` entry is exempt from the check as well, because under a busy task lock that move can be written a few milliseconds after the approval's stamp. A dropped turn records each pending row `skipped` with "The agent's turn began before the task entered this column." once per visit, and writes one `[turn-end]` console line with the turn's start and the move's time. A skip is not a run, so the next turn end of the visit runs the rows. The workflow step gets the console line only: its log row is a check's answer, so one written for a turn no check judged would read as a no.
- **A drag that is the plan exit counts too.** A move by hand (origin `renderer`, `mobile` or `agent`) from a column into that column's plan exit target is exempt from the visit check, but only when the session had left plan mode by the move. The target is the one the `plan-exit` listener would move an approved plan to (`planExitTargetFor`): the next column on a workflow task's route, else the Board Profile-folded `plan_exit_target_id`. The mode comes from what the agent reports on its events (`SessionManager.hadLeftPlanModeBy`; see [Activity Detection](architecture/activity/index.md)). A plan left in the conversation, not through an approved ExitPlanMode, gets no re-stamp, so the turn the user started with "looks good" in Planning would otherwise be dropped in Executing (kangentic-mobile #119). A move made while the agent was still planning stays carried in, since its turn ends on a plan reply, and so does every move from a session whose agent reports no mode. The alternative was to exempt that move whatever the mode. It needs no mode, but a drag made mid-plan whose plan the user then rejects would run unconditional rows on the plan reply.
- **The reply is the turn's own.** The payload also carries `transcriptAnchor`: a byte offset into the session's transcript where the turn began, and the reply is read from there (`readFinalReply` with `since`). `SessionManager` copies it from the message trail's cursor (`MessageTrailTracker.transcriptPosition`) when the session commits to idle, and hands that copy to the next turn the engine stamps (`onTurnStarted`). A plan approval re-anchors at the approval, so the plan stays out and the implementation counts. The copy is taken at idle, not at the stamp, because the engine can notice a turn after it has written text, and a trail read landing in between would already cover it. Only a trail read that was pending at the commit moves the copy (`transcriptReadLanded`, `hasPendingRead`), or any read while the copy is still empty: the read a Stop starts can land after the idle stability window (`DEFAULT_IDLE_STABILITY_WINDOW_MS`), and a copy taken before it would sit ahead of the turn's final text. Once no read is pending the copy is fixed. A read that lands with no position (the agent session id changed) leaves the copy's position as it was. A turn stamped before such a read landed, or at a plan approval, follows the read running at the stamp (`hasReadInFlight`) to where it lands, once. If the tracker drops the session's state while that read runs (an eviction at its session cap), the read never lands and the turn keeps its anchor (`transcriptReadDropped`). A read only armed on its trailing timer at the stamp starts after the turn began and could cover the turn's own text, so it moves nothing, and that turn keeps the earlier position. The tool call that opens a turn with no prompt can itself start the read the turn follows, which then covers the text written before that call; a turn whose last message has no text then has an empty reply. A watchdog's false idle mid-turn anchors the next stamp there, so text written before it falls outside that turn's reply. That can leave the reply empty, never an earlier turn's. Without the anchor, a Claude turn opened by a background job's `<task-notification>`, or by an `isMeta` peer hand-back or `/loop` wakeup (which the parser drops), has no prompt for the walk back to stop at. If such a turn writes no text, it hands on the message the previous turn ended on, such as `Findings: applied`. With the anchor, that turn has no reply. It is an offset, not the reply's time, because the CLI stamps its transcript with its own clock, and a WSL guest's clock can drift minutes from the app's. A turn has no anchor when the agent has no window read (every agent but Claude), on a fresh spawn's first turn (its prompt rides the command line, where the walk stops anyway), and when the agent session id changed mid-turn; then the read is the newest reply in the tail, as before. An anchor past the end of the file reads the tail too, and writes one `[final-reply]` warning.
- **The session must still be the task's.** A turn end from a session that is no longer `task.session_id`, or from an isolated column's session the task has left, does nothing.
- **The turn that answers an expired conversation's recap runs nothing.** A session started from a recap as its whole prompt (see [Session Lifecycle](session-lifecycle.md), a resume of a conversation the agent deleted) is asked to summarize and wait, so that turn's end runs no rows and no workflow step, and writes one `[turn-end]` console line (`automations/turn-end/recap-turns.ts`). It is bound to that turn: it began at the spawn, before the session first went idle, and lasts until the agent receives a prompt after that idle, so a mid-turn idle the watchdog forced does not end it, and a turn the user starts with a prompt after an interrupted recap runs its rows.
- **Cheap when there is nothing to do:** a column with no enabled turn-end rows costs one indexed query.
- **Then:** wait out the turn's last paint (`waitForTurnCompletion`, 1.5 s of PTY silence); read `{{agentReply}}` if a pending row needs it, a Text match or an Agent evaluation included (`transcript.finalReply` in the retrieval worker, from the turn's anchor, 15 s cap, empty on failure); answer every pending Agent evaluation in one call on the Automation agent, while each Text match is checked in code as its row comes up; re-check that the same session is idle in the same column on the same turn; run the rows. A paint wait that runs out (2 minutes without idle and 1.5 s of quiet together) writes one `[turn-end]` warning naming the task, the column, the session and the session's activity at the give-up. With the session idle there the pass goes on to its rows: the terminal never went quiet because the CLI paints a status line for its own background work (measured on Claude Code 2.1.299 at three to four repaints a second during a background agent, and the CLI's own agents, which fire no `SubagentStart` and leave no transcript, can run for minutes after the Stop), and the turn is over all the same. Nothing in the pass writes to that terminal; a message row's delivery waits for its own quiet window. With the session not idle on the same turn the pass runs nothing, and each pending row records `skipped` with "The agent was not idle when this was due to run." once per visit. A turn begun since the turn end stops the pass before the give-up is judged, with no warning and no record: that turn's own end judges it.
- **The same turn, not just idle.** The pass judges the turn its payload names, by its `workSerial` (how many turn-initiating events the agent had reported at the turn end), and asks `SessionManager.isLatestTurn` after the paint wait and again at the re-check. A turn the user started meanwhile moves the serial, so it abandons the pass and writes nothing more, even when that turn has already ended without a turn end of its own (a failed turn, an Esc) and the agent is idle again. The same turn with the session not idle at the re-check holds the rows back and records the not-idle skip on each, once per visit. That is the session leaving idle without reporting work: a permission prompt with no tool hook before it (`Idle:permission` is not turn-initiating) moves no serial, and no turn end may follow it. PTY output never moves it, so an agent's trailing paint does not. Neither does a tool event from an internal CLI agent, whose `agent_id` never fired a SubagentStart: the engine only logs it (`isInternalAgentToolEvent`). The workflow step runs the same check before its own Condition check and after it.
- **An abandoned turn end is judged after all when the newer work ends with no turn end of its own** (`abandoned-turns.ts`). A pass that gives up for newer work keeps its payload. When the session next commits to idle with no turn end in that commit (a watchdog, an idle hint), the runner reads the reply from where the newer work began. It re-runs the pass under the session's serial at that idle only when that work wrote no reply, and no prompt reached the agent and nothing was interrupted or failed since the earlier turn end. Otherwise, or when where the newer work began is unknown, or when the read fails, it logs a line and judges nothing. The interrupt test sees what reaches the event stream: a hook's `interrupted`, a failed turn, and the Ctrl+C the terminal synthesizes. An internal CLI agent's interrupted tool does not count, and a started subagent's does. An Esc between tool calls and a denied permission prompt report no event, so on newer work that began without a prompt they do not block it. Work that begins while the reply is read keeps the payload for that work's end. A turn end of the session's own forgets the payload, even one that lands before a pass still running for the older turn gives up, and so do a move and the session's removal. The re-run pass judges only while the task is still in the column it was kept for. Rows that already ran this visit are not run again. This is the backstop for work that never gets a Stop: before the engine logged internal agents' tool events only, such an agent's tool start after a Stop reopened the turn and never ended, and the rows were lost for good.
- **What leaves a record.** A turn the column was waiting on says why its rows did not run: a carried-in turn, a session not idle at the give-up or at the re-check, a task whose automations are off, and a spent Frequency. The rest is silent, each for a reason. The task left the column, was archived, or has another session (`resolveSubject`). An isolated column's session ended its turn after the task left. A move superseded the pass, or the session exited. A newer turn began, and its own turn end judges it, or the reclaim above does when it ends without one. Every row already ran this visit or cannot run in the column. The recap turn asks the agent to wait for the user, so the user acts next and nobody waits on that turn.
- **The run rule:** rows run top to bottom. A row runs at most once per visit (an executed run since the task's latest entry into the column), and only a row that executes counts: a Condition that answers no, or a Text match that misses, is recorded `skipped` with its reason, and the next turn end checks it again. A row already run this visit, or that the column cannot run, is left out without a record. A row past its Frequency is left out too, but is recorded `skipped` with its limit ("Already ran once on this task, its limit.") once per visit (`hasSkipSince`), so a gate that stopped moving the task says why. It never reaches the Condition check. It is written before the paint wait, as a carried-in turn's skip is: it is about the row, not the turn, so it stands when the wait runs out or a newer turn abandons the pass. A Move to column row that runs ends the group.
- **The column's rows first, then the workflow.** For a task in a running workflow, the workflow's own step runs after the column's turn-end rows, in the same pass, and only when they left it something to decide. A row that moved the task leaves it nothing: the step reads where the task is, so it never moves a task twice. A row that sent the agent a message started its next turn, so the step waits for the turn end that answers it. A row whose Condition answered no did nothing, so it does not hold the step back: once every row has been evaluated and the agent is still idle in the column, the step judges the turn and moves the task along its route when the column's work is done. To keep a workflow task in a column until something is true (a pull request ready to merge), give the column a row that acts while it is not, such as a Send message telling the agent to wait for CI and check again.
- **Outside the task lock, one pass per task.** A row can take minutes, and a Move to column row's own move takes that lock (`withTaskLock` is not reentrant). A move made meanwhile supersedes the group (`supersedeTurnEndWork`, called by `handleTaskMove` before it takes the lock); the group's own move passes `fromTurnEndGroup` and does not. A second turn end during a pass runs once more after it, so two passes never both read "not run this visit".
- **A resume catches up the workflow step, never the rows.** A resumed session (a Resume, a workflow's Resume, recovery at launch or after a pty host crash) comes back idle with no turn end, so `SessionManager` announces it (`'session-resumed'`, emitted for a task session spawned with `resuming: true`, carrying its work serial as it came back). For a task in a running workflow, `catchUpAfterResume` waits out the resume's repaint, and if no work began since, reads the final reply and runs the workflow step on it when the reply is from this visit and no step check has answered since it (`hasWorkflowStepSince`). That is the reply a Pause abandoned mid-check, or a quit cut short. A reply a check already answered is never asked again, and the column's rows stay with real turn ends. Both checks compare the reply's transcript time with app time (`reply.ts` against the visit's start, and against `hasWorkflowStepSince`), the comparison a turn end avoids with its anchor; a resume begins no turn, so it has none. The comparison holds while the CLI writes its transcript on the app's own clock. A transcript locator that reads a WSL guest's home, whose clock can drift minutes, needs these two checks replaced. A repaint wait that runs out writes the same `[turn-end]` warning as a pass, saying "after its resume" where a pass names the column, and goes on the same way when the session is idle. It shares the one-pass-per-task queue, behind any turn end.
- **Delivery waits.** A Send message row on a turn end awaits its outcome, like exit's. A message with more than one line (or over 1,000 characters) is pasted (`submitContent`) after the turn's last paint, so a `{{agentReply}}` keeps its line breaks. A message that opens with a slash command is always typed, since a pasted slash command never runs. Every trigger shares this rule; see [`send_message`](#send_message----send-message-to-agent).

### Condition and Frequency

Every row, on every trigger, can carry a **Condition** and a **Frequency** (`max_runs`). A Condition is one of two kinds: an **Agent evaluation** (`condition`, plain words the Automation agent judges) or, on a turn-end row only, a **Text match** (`final_line`, a pattern checked in code). A row holds one kind. The runner owns all of them; no adapter reads any.

- **Frequency** is checked first: a row that has run `max_runs` times on the task (counted across every visit, executed runs only) is skipped with "Already ran N times on this task, its limit." The count starts over when the task leaves Done, by a drag or a restore from the Completed list, so a reopened task goes through the board's loops and gates as if for the first time. The boundary is the task's newest `task_moves` row out of a `done` column; a `rollback` row, which undoes a failed move into Done, is not one. A Done column's own exit rows run after the move that sets the boundary, so each return starts their count at zero and their Frequency never stops them.
- **Condition** is answered by the Automation agent (`automation.agent` in Settings > Workflows) in one headless, read-only call for the group (`automations/condition-check/`): the task (its title, description, labels, column, and any linked PR with its state and, while it can still merge, its merge readiness, as the card's chip shows it), the move or the agent's final message, and each Condition under a label. It reads only that final message, never the rest of the conversation, so a column's prompt that wants its verdict judged has the agent end on it. The reply is one `C1: reason -> yes` line per Condition, reason first, so a model with no thinking reaches its verdict after its reason rather than guessing it first. It is read the same when written as a list item, and the older `C1: yes - reason` form is still read; a label missing or written twice is asked once more, in a second call that carries only the labels the reply missed (renumbered from C1) and one line asking for each label exactly once, and still missing after that counts as no. Each answer links to the call that gave it. A retry that is stopped or fails keeps the first call's answers. Each reply that leaves a label unanswered, the first and the retry alike, writes one `[automations]` warning naming those labels, the call id (`background_calls.id`) and what happens next, with the reply's first 1,000 characters and a count of any characters left out, so the skip can be explained from the log. Outside text is framed in tags that are defused inside it, and the prompt says it is data, never instructions. On enter and exit the call happens inside the group (on exit, within the 60 s budget); at a turn end it happens before anything runs. With no Automation agent, a row with an Agent evaluation is skipped with "Set up an Automation agent in Settings > Workflows to check this condition."
- **Text match** is checked after Frequency and before any Agent evaluation, against the final message the turn end read (`matchFinalLine` in `src/shared/final-line-match.ts`). It takes the last line that still has words in it once case, punctuation (markdown marks included), invisible characters (a zero-width space, a byte order mark, an emoji's variation selector) and extra spaces are dropped, so a closing code fence or `---` is skipped, and the pattern must cover that whole line, with `*` matching any text. The match walks the line once per wildcard with no regular expression, so no pattern can stall the main process on a long line. A miss is recorded `skipped` with "Text match not met: The final line reads "..."." and, like a no, is not a run. No Automation agent is involved, so a Text match runs with none set up, and a column whose pending rows are all Text matches makes no call. Run again on a turn-end row whose Text match, Condition or `{{agentReply}}` needs the final message reads the newest one the task's session wrote. That is the text a turn end reads, except before the task's first turn in the column. A message from a session that a queued move has since replaced counts as none. The runner skips a Text match it is handed with no reply at all (only a turn end and a Run again pass one) with "A text match is checked only at an agent turn end."
- The answer rides the run row: `condition_met` and `condition_reason` for an Agent evaluation, `final_line_met` and `final_line_reason` for a Text match.

### Disabling automations for one task

A task can hold itself out of every column's automations: `tasks.automations_disabled`, set from the card menu's "Disable automations" or by an agent through `kangentic_update_task`'s `automationsDisabled`. While it is set, no row runs for that task on any trigger, in any column. The one predicate is `canTaskRunAutomations` (`src/shared/automation-manifest.ts`), and it is asked in five places:

- `TransitionEngine.executeTransition`, after the group's rows are read: every row is recorded `skipped` with "Automations are disabled for this task." and nothing runs. That covers exit, warm and cold enter, and turn end. The task is read again there rather than taken from the caller, so a switch thrown during a turn end's paint wait is seen. A cold spawn's fallback still starts the agent per Start an agent here; it just gets no column message. A legacy `spawn_agent` row is held like any other, so its custom `promptTemplate` goes unused and the fallback starts the agent on the default prompt. A row the warm move already typed, because the switch was thrown after that, is recorded as sent rather than skipped.
- The turn-end runner, ahead of the Frequency records, the paint wait and the paid Condition check. Each row that would be pending is recorded once per visit (`hasSkipSince`), so a long chat does not bury the run log. `runRows` asks again before the Condition check.
- The two places a move types the column's message outside the runner: warm injection in `handleTaskMove` and the cross-agent handoff in `spawnAgent`. A disabled task's message there is treated as absent. The task's own `auto_command` still goes out: it is the task's input, not a column automation.
- The plan approval reader (`readPlanApprovalDecision`), which reads a disabled task's Plan approval as Manual. Its session's decision file says `approve: false`, so the user approves the plan in the terminal, and the After Plan Mode move then runs as for any approval the user gives. Switching the flag is a `task-updated` on the board bus, so `PlanApprovalWriter` rewrites the file both ways with no respawn. The pre-spawn question (`planApprovalModeForSpawn`) ignores the flag: a task spawned while held still launches with bypass available when its column's approval would continue in `bypassPermissions`, so enabling automations later restores that mode too.

Two display-only callers also read the predicate, to draw the board card's strip and the Agent Monitor's marker (`task-card-view.tsx` and `monitor-aggregator.ts`). Neither gates a row.

`executeSingleAutomation` (Run again, `kangentic_run_automation`) is not gated: it is an explicit request. Nothing is gated in `runAutomations` itself, which it shares. Enabling automations again replays nothing; the next trigger runs as usual, so an enter row skipped while disabled runs again only when the task re-enters the column.

With no one asking, the switch clears only when the task joins a workflow (`TaskRepository.setWorkflowMembership`). Every move keeps it, a move out of a `done` column and an unarchive included, so a held task comes back from Done still held. The destination's enter rows are skipped with the reason, and so are Done's exit rows on a move through `handleTaskMove` (a restore from the archive runs no exit rows). Frequency counts still start over when the task leaves Done, so a row that spent its limit before Done runs again on its next trigger, once the user has enabled automations. A workflow task never carries it: the IPC update and the MCP tools refuse it with "This task is in a workflow. Pause the workflow to hold it." (`automationsSwitchRefusal`), and the repository writes it false whatever the caller sends.

## The agent starts on demand

Nothing in a list starts the agent explicitly. An adapter declares what it `needs` (only `send_message` needs `'agent'`), and on enter the runner calls `startAgent()` once, right before the first row that needs it. If no row needed it, the caller's fallback spawn runs after the list as it always did.

On exit there is no `startAgent`: the task is leaving, so a row that needs an agent the task does not have is recorded `skipped` with the reason rather than starting one.

A column that cannot meet a need shows the row switched off with its switch disabled (Start an agent here is off), and the draft keeps the stored `enabled` so turning the setting back on restores it.

## Automation adapters

Six types, five of them offered for a new automation. Each declares its fields, its per-field escaping, its timeout and its retry policy in `AUTOMATION_MANIFEST`, which the renderer reads for the picker, the Edit automation dialog and the row sentence. A type may also declare the triggers it runs on (`triggers`, with `triggerUnavailableReason`) and that a row of it ends its group (`endsGroup`). A field may declare one trigger where it does nothing (`unavailableOn: { trigger, reason }`): the Edit automation dialog keeps it there, disabled, with the reason on each option, leaves its stored value alone, and the row earns no mark for it. Consumers read it through `automationFieldUnavailableReason`, never by the field's key. `tests/unit/automation-adapter-parity.test.ts` fails if the registry and the manifest disagree, and `tests/unit/automation-manifest-reserved-keys.test.ts` fails an `unavailableOn` on a field that cannot show it or on a trigger the type never runs on.

### `send_message` -- Send message to agent

Delivers an interpolated message to the task's agent. This is what the retired `Swimlane.auto_command` became: the migration moved every column's message into one of these.

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | The text, with `{{placeholders}}`. Escaping is `none`, because it is prose going to an agent |
| `mode` | `'immediate'` \| `'deferred'` | Run immediately (interrupts the current turn) or wait for the current turn. Unavailable on `turn_end` (`unavailableOn`): the turn is already over, so it sends at once |

Needs the agent. No timeout of its own beyond the scheduler's 120s, and no retry: `TerminalSubmitScheduler` already has a confirmation verifier and a one-shot escalation ladder. Delivery goes through `context.deliverToAgent`, which applies the three rungs when this run started the agent and the plain scheduled keystroke otherwise. See [Command Injection](command-injection.md).

Keystrokes turn line breaks into spaces, so every path that hands a message to a live agent asks one question first (`shouldPaste`, `automations/turn-end/agent-message-delivery.ts`). A message with more than one line, or over 1,000 characters, is pasted with bracketed paste (`submitContent`) and keeps its line breaks. A one-line message, and any message that starts with `/`, stays keystrokes, the only way a slash command runs: `/code-review {{attachments}}` spans lines once the paths are filled in, and it is typed on one line so the command still runs. When a paste lands depends on the trigger:

- **On task exit:** awaited inside the exit budget, and handed the run's signal. `immediate` pastes at once; `deferred` waits for the agent's turn to end first.
- **On task enter, Run again, and the warm move's column message:** in the background, once the agent's turn has ended and the scheduler has no keystrokes left for the task, whatever the mode. A task's pastes run one at a time, in order, on every trigger, so two of them never write into the terminal at once. On a fresh spawn that is the end of the agent's first turn. A move to another column cancels a paste still waiting (`supersedeMessageDeliveries`), and its outcome is reported like a keystroke burst's (`cancelled` is silent, `failed` raises a notice). A message the spawn already took as its opening prompt is not pasted again.
- **On agent turn end:** awaited, after the turn's last paint.

### `run_script` -- Run script

Runs a script as an ordinary child process, in the task's worktree when it has one and the project checkout when it does not. There is no working-directory setting; the legacy `workingDir` key is ignored and dropped on save.

| Field | Type | Description |
|-------|------|-------------|
| `script` | string | The script body, with `{{placeholders}}`. Escaping is `shell` |
| `timeoutMinutes` | number | Give up after this long. Default 10, range 1 to 120. Set in `kangentic.json` only, not in the Column Manager: an exit group is capped at 60 seconds in aggregate whatever this says, so the control could not tell the truth on half the rows it appeared on. The bound itself is not optional, because enter automations hold the task lock and `withTaskLock` has no timeout of its own |

Not a PTY. An interactive shell runs the script and then returns to its prompt and lives forever, so completion is unobservable and the exit code unobtainable; this adapter awaits the exit and records the code. The timeout kills the process TREE, because a bare kill reaches the shell only and leaves whatever it spawned running. No retry: a half-run script is not safe to repeat.

Every variable also arrives as a `KANGENTIC_*` environment variable, which is the lossless path: `"$KANGENTIC_TITLE"` gets the exact value on a POSIX shell or PowerShell, where substituted text is stripped of shell metacharacters (including the curly double quotes, which PowerShell ends a string at). Not on cmd.exe, which expands `%KANGENTIC_TITLE%` and then re-parses the value for metacharacters.

### `webhook` -- Call webhook

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target URL. Escaping is `url` (percent-encoded) |
| `method` | `'POST'` \| `'GET'` \| `'PUT'` | Default `POST` |
| `body` | string | Request body. Escaping is `json`. Empty means the default JSON envelope |
| `headers` | Record<string, string> | Extra headers, authored one per line as `Name: Value` |

30 second timeout via `AbortSignal.timeout`, a `response.ok` check, and 3 attempts on a transport error, 408, 429 or 5xx through the runner's retry loop (`delayBeforeRetry` in `src/main/automations/automation-runner.ts`), honoring `Retry-After`. Every attempt sends an `Idempotency-Key` built from the run id, so a retry cannot double-create downstream. `attempts` is written to the run row.

### `notify` -- Notify me

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Default `{{title}}`. Escaping is `none` |
| `body` | string | Default `{{toColumn}}`. Escaping is `none` |

One desktop notification through the same `showNotification` path `DesktopNotifier` uses, so it inherits click-to-task. No timeout, no retry.

### `move_to_column`: Move to column

| Field | Type | Description |
|-------|------|-------------|
| `targetColumn` | string | The destination column's name. Empty or absent is Next column: the column after the task's own (on its route in a workflow, else on the board), resolved by `resolveMoveTarget`, the same answer `kangentic_move_task`'s `column: "next"` gets. Renaming a column rewrites the rows that name it |
| `message` | string | Optional. Sent to the agent in the destination column once its turn ends, after that column's own On task enter rows. Escaping is `none`; a multi-line message (a review's `{{agentReply}}`) is pasted whole |

Offered on `turn_end` only: on enter or exit its move would run inside the move that fired it, under that move's own task lock. It moves through `context.moveTask`, which runs `handleTaskMove` with origin `'automation'` (a quiet push, `TASK_MOVED_BY_AUTOMATION`, and the row's name as the move's `task_moves` reason), so the source column's exit rows and the destination's enter rows run as they do for a drag. A row that runs ends its group (`endsGroup`). The message is handed on in the background (`deliverMessageAfterMove`), so the run row reads "Moved to Executing, with a message." as soon as the move commits rather than waiting out the destination agent's first turn. No timeout of its own and no retry: the move owns its deadlines.

### `spawn_agent` -- Start agent (legacy)

The one legacy adapter, kept because a row carrying a custom `promptTemplate` is not a duplicate of anything and has no other home. It is never offered for a new automation, appears as a disabled option in the dialog's Type select, and shows a lint on its row: "This is handled by the column's settings now. Remove it to use them." Its one field, `promptTemplate`, has escaping `none`.

`kill_session`, `create_worktree` and `cleanup_worktree` (`RETIRED_ACTION_TYPES`) are GONE, rows and all. Each was a no-op or a duplicate of the move path: `kill_session` suspended a session the task no longer had at that point, `create_worktree` did what `ensureTaskWorktree` does, and `cleanup_worktree` did what a To Do move does. `create_pr` was never implemented, and the migration drops it with any other type it does not recognize. A hand-written `kangentic.json` naming one of these is warned and skipped, matching what the migration did to the same row in the DB. `send_command` is not retired. The migration converted its rows to `send_message`, and a file that still names it is read as an alias (see [configuration.md](configuration.md)).

## Every row is isolated, bounded and recorded

`runAutomations` (`src/main/automations/automation-runner.ts`) is where the reliability promises live. Each was a live defect in the action system this replaces.

- **Isolated.** One throw used to abort the rest of the chain, and `agent-spawn.ts` then swallowed it while the move still resolved `ok`. Now each row is caught, its outcome recorded, and the next row runs. The rows are independent side effects; aborting means a webhook blip silently skips the agent message. The one real dependency stays expressed through `needs`.
- **Bounded.** Nothing timed out: `withTaskLock` is a PQueue with no timeout and Phase 3 holds it across the whole list, so one hung webhook wedged every later operation on that task until a restart. Each row now runs under its adapter's `timeoutMs`, combined with the move's own signal.
- **Recorded.** There was no run table at all, so "did my automation run" had no answer. Every row writes an `automation_runs` row: `running` before the attempt, closed on every exit path as `succeeded`, `failed`, `skipped` or `interrupted`, with a one-line `detail` (`HTTP 204`, `exit 0`, the skip reason, the error).

  A message reports **"Delivered" on exit and at a turn end, and "Sent" on enter**, and the difference is real rather than cosmetic. The exit hook awaits the keystroke burst, so the row is written only once it has gone out. The enter group cannot await: Phase 3 holds the task lock across it, and a deferred message waits for the agent's current turn to end, so awaiting would hold that lock for as long as the scheduler's ladder runs. Neither word is "Confirmed": only Claude implements a submission verifier, so on every other agent even the exit case is unconfirmed and the scheduler reports that outcome on its own channel.

The runner never throws for an automation's sake. It rethrows exactly one thing: an abort of the move itself.

### What the user sees

Nothing on success. A `failed` or `interrupted` run raises ONE error toast naming the automation and the column, with a Run again action, behind a 60s cooldown keyed on the project and the AUTOMATION. Keyed on the automation rather than the task deliberately: a bulk move of twelve tasks through one column fails the same webhook twelve times, and the run rows record all twelve, which is where a count belongs. The Column Manager row shows no run history (it used to print its last run under its sentence, which made rows in one list differ in height); the toast and `kangentic_get_automation_runs` are where "did my automation work" is answered. `emitSpawnProgress` carries the running row's name, which closes the gap where a column with `autoSpawn: false` and a slow webhook showed the user nothing at all.

**Run again re-executes ONE automation against the task's CURRENT state** and writes a fresh run row. The toast and the row both say "current state", because a task may have moved twice since the failure and re-running a stale context would be a worse lie than not offering it.

A Move to column row moves the task on Run again (and `kangentic_run_automation`) through the same move a turn end makes (`move-from-row.ts`). It runs outside the task lock, because `handleTaskMove` takes that lock and it is not reentrant, and it moves the task only from the row's own column: a task that has left it is refused with "The task is no longer in <column>, so this row cannot move it. Drag the card instead.", since Next column resolves from the row's column. A task that leaves between that check and the move is refused inside the task lock ("The task left <column> before it could be moved."). The move checks again inside its own lock (`handleTaskMove`'s `expectedFromSwimlaneId`), so a drag that lands while it waits refuses it rather than sending the task on from the new column. Every other row runs inside the lock.

### Interrupted runs and the project-open sweep

`synchronous-shutdown.md` forbids awaiting a drain on quit, so a `running` row at boot is a known orphan. In the same pass that runs `retryFailedDoneCleanups`, project open calls `markStaleRunsInterrupted()` and then `pruneTo(200)`. The first keeps the log honest; without it "these always run" is false on every restart. The second bounds a table nothing else bounds. If any row was interrupted, ONE summary toast, never one per row.

There is no automatic retry across a restart, ever. A fired webhook and a half-run script are not safe to repeat blind, so the user gets Run again on the row instead.

## Template Variables

One declaration (`src/shared/task-template-vars.ts`) drives every consumer: every
automation field that takes variables, the per-task `auto_command`, the legacy
`spawn_agent` automation's `promptTemplate`, the Column Manager's "Template
variable" picker and its inline `{{` completion, and this table - see
`tests/unit/task-template-vars-parity.test.ts`. Because the picker shows each
entry's `description`, that field is user-facing copy and should stay to one
line.

26 keywords. 19 resolve wherever there is a task, 5 only in an automation (the
move keywords and `{{agentReply}}`), and 2 only in a workflow agent's first
message (`{{columns}}` and `{{brief_xml}}`), each marked below. That first
message (Settings > Workflows) is the third context: it is written before any
task exists, so it offers only `{{projectName}}`, `{{projectPath}}`,
`{{baseBranch}}` (the project's default) and its own two.

**Two substitution rules, split by SOURCE rather than by destination.**

- **Every automation field** substitutes literally, through
  `interpolateAutomationConfig` -> `interpolateTemplate`: a known name is
  replaced, an unknown one is left exactly as written. That is what the field's
  own editor promises when it paints an unrecognized name amber and says
  "Unknown variable: nope. It will be sent as written."
- **A per-task `auto_command`** (MCP-only) and the legacy `spawn_agent`
  `promptTemplate` keep DROP-AND-COLLAPSE, through `interpolateTaskTemplate`:
  an unknown or empty `{{key}}` is dropped and the horizontal whitespace around
  it collapses, so `/code-review {{baseBranch}}` with no configured default
  yields `/code-review` rather than a trailing space.

The split is by source because the editor and the interpolator have to agree.
Nothing warns you about an empty keyword in an MCP-set `auto_command`, so
dropping it is the kinder behavior there; an automation field DOES warn, in the
dialog, before you save it.

Note what drop-and-collapse means for a FLAG-shaped placeholder in an
`auto_command`: `--port {{port}}` with no reservation collapses to a bare
`--port`, which most CLIs reject.

| Variable | Value |
|----------|-------|
| `{{title}}` | Task title (PTY-sanitized) |
| `{{description}}` | Task description with `: ` prefix when non-empty |
| `{{task_xml}}` | Task title and description wrapped in a `<task>` envelope (`<title>` / `<description>` children). Default seeded prompt template is `{{task_xml}}{{workflow_xml}}{{attachments}}`, which gives the agent a structured envelope without forcing the user to template it manually. |
| `{{workflow_xml}}` | A workflow task's `<workflow>` block: the workflow's name, the task's route, the tasks it built on (with their branch and PR) and the tasks waiting on it, then how its turns are judged (end a turn only with the column's work done or with a question; progress notes go beside the next tool call; `kangentic_move_task` with `"next"`; `kangentic_mark_background_service` for a background command left running after the turn). Read by the engine (`readWorkflowPromptFacts`) and escaped. Empty, and dropped, for a task outside a workflow, so an ordinary task's default prompt is unchanged. |
| `{{taskId}}` | Task UUID |
| `{{taskNumber}}` | The task's `#N`, the number people say out loud (`display_id`) |
| `{{projectPath}}` | Main project checkout path (empty if no project is open) - always the base repo, even when the task has a worktree |
| `{{projectName}}` | The project's name as it reads in the sidebar (empty if no project is open) |
| `{{worktreePath}}` | Worktree directory path (empty if none) - a raw read, never falls back to a project-level path |
| `{{branchName}}` | Git branch name (empty if none) - a raw read, never falls back to a project-level branch |
| `{{baseBranch}}` | Effective base branch: the task's `base_branch` override, else the project's configured default (board config, then app config, then `'main'`) |
| `{{prUrl}}` | Pull request URL (empty if none) |
| `{{prNumber}}` | Pull request number as string (empty if none) |
| `{{prState}}` | Pull request state: `open`, `merged`, `closed` or `draft` (empty if none) |
| `{{issueKey}}` | The linked tracker issue's key, such as a Jira key or a GitHub issue number (empty if none) |
| `{{issueUrl}}` | The linked tracker issue's URL (empty if none) |
| `{{labels}}` | The task's labels, comma-separated (empty if none) |
| `{{attachments}}` | Bare file paths (one per line) when present |
| `{{port}}` | Lowest dev-server port this task has RESERVED (empty if none, which is the normal state) - a raw read, never falls back to another task's port |
| `{{column}}` | The column the automation belongs to. Automations only |
| `{{fromColumn}}` | The column the task moved out of (empty for a task born into a column). Automations only |
| `{{toColumn}}` | The column the task moved into. Automations only |
| `{{trigger}}` | When this automation runs: `enter`, `turn_end` or `exit`. Automations only |
| `{{agentReply}}` | The agent's reply at the end of its last turn in this column: the final message, full text with its line breaks. Empty on task enter, and for an agent whose transcript Kangentic cannot read. A Claude turn that wrote no text of its own is empty too (see the note below the table). Automations only |
| `{{columns}}` | One line per column between To Do and Done, in board order: what it runs (an agent, plan mode and whether the user or Kangentic approves the plan, its own session, a slash command), its enabled automations, and how many of the last 10 finished tasks went through it (from `task_moves`; left out until a task has finished). Names escaped. Workflow agent only |
| `{{brief_xml}}` | What the workflow was made from: a `<brief>` block with the source task's `<source_task>#N</source_task>`, `<title>` and `<description>`, laid out and escaped like `{{task_xml}}`. Empty, and dropped, for a workflow made from nothing. Workflow agent only |

The five marked **automations only** and the two marked **workflow agent only** are limited because each entry declares
its `contexts` (`src/shared/task-template-vars.ts`). A `spawn_agent` prompt
template is not a move, so those five would resolve permanently empty there,
and the picker does not offer them in that context. A flat list that offered
everything everywhere would be lying about five of its entries.

`{{agentReply}}` is read from the session whose turn just ended, which for an
isolated column is that column's own session, not the task's main one. Without
an anchor it is the same final answer `kangentic_get_transcript` returns for
`view: "result"`, uncut: the newest assistant message after the last user
prompt, its text blocks joined. `kangentic_get_transcript` takes no anchor, so
with one the two can differ on a turn that wrote no text. At a turn end it is
read from where that turn began (`transcriptAnchor`), so a Claude turn that
wrote no text of its own has an empty reply rather than the one an earlier turn
ended on. Claude is the only agent with the window read that honors an anchor;
the other agents with a transcript reader read the newest reply in it, which can
be an earlier turn's. It is what carries a review's findings to the column a
Move to column row sends the task to.

Drop-and-collapse preserves newlines: only runs of spaces and tabs collapse,
and only in the template's own text, never inside a substituted value. That is
what keeps a multi-line `{{task_xml}}` envelope intact down to a markdown hard
break in the raw description.

The flag-shaped case matters more than it used to, because Kangentic reserves
NOTHING up front. A port exists for a task only once its agent asked for one
(`kangentic_reserve_dev_ports`), so empty is the normal state, not the edge
case. A message shared by every task in a column therefore should
not template `{{port}}` in - most of those tasks hold no reservation. Prefer
letting the agent reserve the ports it is about to bind and use them directly;
reach for `{{port}}` only where the task is known to hold one.

`{{projectPath}}` is flag-shaped the same way, and fails less legibly than a
bare `--port` does. With no project open, `git -C {{projectPath}} merge main`
collapses to `git -C merge main`, so git takes the SUBCOMMAND as the `-C`
argument and reports `fatal: cannot change to 'merge'`. That is a loud failure,
not a silent one, but it names a directory nobody asked for instead of the
value that went missing. Path-valued keywords are also substituted unquoted, so
quote them yourself (`git -C "{{projectPath}}" merge main`) wherever the path
may contain spaces.

Shortcut commands use a separate set of template variables. See [Configuration](configuration.md#shortcuts) for the full list.

## Stale Spawn Prevention (AbortSignal)

When a task moves rapidly between columns (e.g. user drags to the wrong column and immediately corrects), earlier transitions may still be in-flight when the new transition starts. Without cancellation, the old spawn would complete and create a PTY process that the new transition immediately supersedes.

The transition engine threads an `AbortSignal` through the execution chain:

- `runAutomations()` checks the signal before each row, and combines it with that row's own `timeoutMs` for the adapter
- `executeSpawnAgent()` checks the signal as a final gate before creating the PTY process

If the signal is aborted, the method throws an `AbortError` which the caller catches and ignores (the newer transition takes over). This prevents orphaned PTY processes from accumulating.

## Command Injection

When a task moves to a column whose On enter group holds a `send_message` automation, delivery depends on how the session was started:

**Resumed sessions** (priority 3 suspend-and-resume, or priority 4 resume from suspended):
- The message is interpolated and passed as the resume prompt to `claude --resume <id>`
- This is deterministic: the message is the first thing the agent sees on resume
- Two cases do not send the message as the resume prompt. If the agent deleted the conversation on a task's main session, the spawn starts fresh with a recap of the task, and the message is withheld and recorded as skipped "Not sent". If the conversation never started, the spawn is fresh and the message goes out after it. See [Session Lifecycle](session-lifecycle.md#a-resume-the-cli-cannot-serve-starts-fresh-instead).

**Fresh spawns** (priority 4, no suspended session to resume):
- `TerminalSubmitScheduler.scheduleKeystrokes` schedules the message for deferred PTY injection
- Interpolates the message with task variables
- Waits for the CLI's first `'thinking'` activity event, then delivers via `TerminalSubmit.submitKeystrokes` as a handshake chain (drain + output-settle between keystrokes) rather than fixed sleeps
- A message with more than one line, or over 1,000 characters, is pasted instead, once the agent's first turn ends, unless it opens with a slash command (see [`send_message`](#send_message----send-message-to-agent))

If keystroke delivery cannot be confirmed in the agent's transcript, it escalates to a session restart that passes the command as the CLI's prompt argument - the same guarantee the resumed path has. Every injection ends in a recorded outcome on the task, and a failure raises a notice instead of a console warning. The full contract, including the delivery ladder, the prompt-state policy, and the measured before/after delivery rate, is in [Command Injection](command-injection.md).

Each message declares WHEN it fires, via its own `mode` field: `immediate` (the default; interrupts the agent's current turn if there is one) or `deferred` (holds until that turn genuinely finishes). "Finishes" requires activity `idle` AND a quiet PTY, because a bare idle is reported for minutes during an API retry backoff or a `Monitor` wait. This was `Swimlane.auto_command_mode`, a per-column field; it belongs to the automation now, so a column can hold an immediate message and a deferred one.

This enables workflows like moving a task from "Running" to "Code Review" to automatically send a review prompt to the agent.

`resolveColumnMessage` picks the column's message: the FIRST enabled `send_message` row in its On enter group. First, not all of them, because the two callers that ask are asking a question with one answer. A spawn has a single prompt slot, and the live injection types exactly one command. Later message rows are the runner's to deliver. A first row with a Condition or a Frequency limit comes back `guarded`, and the live injection and the handoff leave it unsent, because only the runner applies those two: a warm move lets the enter group send it after both checks, and a handoff, which runs no enter group, does not send it. `resolveEffectiveAutoCommand` then puts a per-task `auto_command` (MCP-only, `kangentic_create_task`'s `autoCommand` param) ahead of it for that task.

**A profile cannot re-point the message.** Automations are shared by every profile, which is why the Column Manager's whole list is read-only under one. `BoardProfileEntry.autoCommand` is the retired key that used to overlay it: nothing reads it, and nothing writes it. A column's own legacy `autoCommand` in `kangentic.json` IS still read, and converted into a `send_message` row on apply.

The unarchive handlers (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) and any other move out of Done suppress delivery via `spawnAgent`'s `suppressAutoCommand` (the recovery-move contract; see [Session Lifecycle](session-lifecycle.md#resume)). That reaches the runner as `suppressAgentMessages`, which SKIPS every row whose adapter `needs` the agent, recording "Restoring a task from Done does not message the agent. The next move does." The skip belongs in the runner rather than in `deliverToAgent`'s own no-op, because a silent no-op lets `send_message` return normally and the row records "Delivered" for a message nobody received. It also runs before the agent-start step, so a message that is going to be skipped no longer spawns an agent to be skipped at. Every other type still runs: the suppression is about the agent's attention, not about the move.

A legacy `spawn_agent` automation that creates the session itself runs its own prompt template, and the fallback message / continuation injection is skipped for that spawn. This is uniform across every entry point (move, create, promote, MCP create), since all route through `spawnAgent`, whose fallback start only fires when no automation spawned the session. The task's own `auto_command` is the exception: when a legacy Start agent row, or a Send message row with no text, started the agent and no row sent it, it still goes out once after the enter group, unless the task's main session started over on an expired conversation's recap or the move was superseded. A fresh board is unaffected: nothing is seeded any more.

**On exit, a message is awaited rather than scheduled.** Every priority branch below the Phase 1 hook opens with `terminalSubmitScheduler.cancel(task.id)` before it kills, suspends or re-points the session, so a burst merely SCHEDULED in the hook is cancelled a few milliseconds later, mid-burst, by the very move that asked for it. Measured against a live session, the run row read `succeeded` in one millisecond while the agent received the burst's leading Ctrl+U and nothing else, ever. `deliverExitMessage` (`src/main/ipc/helpers/exit-message-delivery.ts`) now awaits the scheduler's own outcome, bounded by the run's signal, which is the 60s exit budget. The enter path deliberately does NOT await: nothing there cancels, and awaiting would hold Phase 3's lock across a 120s deferred wait.

## Swimlane Roles

Two special roles affect behavior:

| Role | Behavior |
|------|----------|
| `todo` | Task moves here → session killed (not suspended), leftover processes reaped, worktree removed |
| `done` | Task moves here → session suspended (resumable), leftover processes reaped, worktree directory removed (retried once 10 s later if the removal fails), task archived |

Both roles still run their On EXIT group (in Phase 1, before the kill or the suspend), and neither runs an On enter group: the Column Manager offers only the exit group there, and `canColumnRun` blocks an enter row written by hand.

All other columns (including Planning, Executing, Code Review, etc.) are custom columns with no special role. Their behavior is controlled by `auto_spawn`, their automations, `permission_mode`, `plan_exit_target_id`, and `plan_approval`.

## auto_spawn Flag

Each swimlane has an `auto_spawn` boolean (default: `true`):
- `true` -- tasks in this column should have active sessions. Session recovery and reconciliation will spawn agents here.
- `false` -- tasks in this column should NOT have active sessions. Moving a task here suspends its session.

To Do and Done columns have `auto_spawn=false` by default.

### Changing the flag applies immediately

Editing `auto_spawn` reconciles the tasks ALREADY in the column, with no restart
and no move: switching it on spawns for each task that has no session, and
switching it off suspends the live sessions there. This runs through
`reconcileAutoSpawnChange` (`src/main/ipc/handlers/auto-spawn-reconcile.ts`),
dispatched from `propagateStrategyToLiveSessions`, so all four authoring surfaces
behave identically on the ACTIVE project:

- the Board Manager's column edit (`SWIMLANE_UPDATE`),
- the Board Manager's Board Profile edit (`BOARD_CONFIG_SET_BOARD_PROFILES`) -
  `auto_spawn` is profile-scoped, so a profile can flip it for a task without the
  column changing,
- the MCP `kangentic_update_column` tool,
- the MCP profile tools (`kangentic_update_board_profile`,
  `kangentic_delete_board_profile`, `kangentic_create_board_profile`), which
  reach the same reconcile through `setBoardProfiles`.

An MCP tool can also target a background project via its `project` argument; that
writes the setting without reconciling. The reason is BLAST RADIUS, not an absent
session: a background project can have live sessions (the Agent Monitor and the
sidebar's per-project agent counts are built on exactly that). The reconcile
SPAWNS, and a spawn creates a worktree and checks out a branch in a checkout the
user is not looking at. Its tasks pick the new setting up when they next spawn.
The cost is that turning `auto_spawn` off on a non-focused project leaves that
project's agents running until it is next opened.

Three things it deliberately does not do. A task the user explicitly paused is
never started by a column edit; only an explicit Resume clears that. A To Do or
Done column never spawns, whatever the flag says: the Board Manager and
`apply-config.ts` both force `auto_spawn` false for a role column, but the MCP
`update_column` tool writes the field with no role validation, so the reconcile
guards the ON direction itself. Only the ON direction is guarded, since
suspending a session that should not have been there is always safe. And the
`kangentic.json` file watcher (`BOARD_CONFIG_APPLY`) does NOT reconcile, so a
`git pull` that flips `autoSpawn` still takes effect on the next project open -
that path fires for whichever project changed on disk, which is often not the
focused one.

## plan_exit_target_id

When a column has `permission_mode='plan'`, Claude runs in plan mode. When the plan is approved, Kangentic moves the task to the column specified by `plan_exit_target_id`, folded through the task's Board Profile. A workflow task goes to the next column on its route instead (`planExitTargetFor`, `src/main/ipc/helpers/plan-exit-target.ts`). No target means the task stays.

The move is keyed on the approval, not on the agent calling `ExitPlanMode`. The `plan-exit` listener (`ipc/handlers/sessions.ts`) fires on the tool's completion (`PostToolUse`), which the CLI sends only for an approved plan, so a rejected plan moves nothing. That holds whoever approves.

Who approves is the column's `plan_approval`. `manual` (the default) waits for the user in the agent's terminal. `automatic` has Kangentic answer the prompt through the agent's plan approval hook, for an agent that declares `supportsPlanAutoApproval` (see [Agent Integration](integrations/agents/bridge-scripts.md#plan-approval-bridgejs)). A task in a running workflow follows the workflow's `plan_approval` instead, and an agent that cannot approve plans, or a task with its automations disabled, always waits for the user. Kangentic's approval also switches the session to the permission mode it would spawn with in the destination column, with fallbacks when that is `plan` (see [Agent Integration](integrations/agents/bridge-scripts.md#plan-approval-bridgejs)). Besides the plan prompt, the hook answers only a planning prompt for another MCP server's tool the allow rules in the project's or the user's Claude settings name, which Claude's plan mode asks about anyway (task #870), so an unattended Planning session does not stall on a tool you allowed. A question the agent asks the user, any other tool, and Kangentic's own tools still wait.

Default setup: Planning column has `plan_exit_target_id` pointing to the Executing column.

## Default Seed Configuration

New projects get seven columns and NO automations. Every column's list starts empty.

The two rows the seed used to write were both dead weight. `* -> Planning: Kill Session` ran at Priority 4, where the task has no active session, so it found nothing to suspend and did nothing at all. `Start Planning Agent` carried `{{task_xml}}{{attachments}}`, which was then exactly what the fallback spawn used when nothing supplied a prompt (the default has since gained `{{workflow_xml}}`; the migration compares against the literal the seed wrote), so it duplicated what the column's own "Start an agent here" setting already produces.

Seeding them also taught the wrong model: it made starting an agent look like an automation a user could reorder or delete, when it is a column setting. An empty list is both true and the right blank page to start from. `tests/unit/default-swimlanes-seed-parity.test.ts` pins it.

## Cross-Agent Handoff

When a task moves to a column with a different agent (detected by `resolveTargetAgent()` in `src/main/transition-engine/agent-resolver.ts`), a cross-agent handoff occurs:

1. **Agent resolution** detects agent change: `resolveTargetAgent()` checks `task.agent_override` first (highest priority - the user's create-time lock), then column `agent_override`, then project `default_agent`, then global fallback (`'claude'`). If the resolved agent differs from the current session's agent, a handoff is triggered. Tasks with a non-null `task.agent_override` never trigger a handoff on column moves - the locked agent supersedes column settings.
2. **Task-move Priority 3** suspends the current session.
3. **spawnAgent handoff path** - the `agentOverride` parameter is passed to `executeSpawnAgent()`, which prevents resume of the wrong agent's session.
4. **HandoffOrchestrator** packages context from the previous session: transcript (from `session_transcript_chunks`), git diff, and session metrics.
5. **Transition engine** spawns the new agent with a `handoffPromptPrefix` that summarizes the handoff context.
6. **Post-spawn** - a `handoff-context.md` file is written to the session directory for the new agent to reference.

Spawn progress phases during handoff: `packaging-handoff` (while context is being assembled), `detecting-agent` (while the target agent CLI is detected), then `starting-agent`.

Because create-into-spawn-column and unarchive route through the same `spawnAgent` chokepoint as task moves, handoff semantics apply on those paths too: unarchiving a task into a column whose resolved agent differs from `task.agent` packages handoff context when the column's `handoff_context` toggle is enabled, and spawns the new agent fresh (no context) when it is disabled. The full entry-point table lives in [Session Lifecycle](session-lifecycle.md#spawn-entry-points).

## See Also

- [Session Lifecycle](session-lifecycle.md) -- spawn entry points, spawn flow, queue, suspend, resume
- [Agent Integration](integrations/agents/index.md) -- command building, permission modes, per-agent CLI details
- [Worktree Strategy](architecture/worktrees/index.md) -- worktree creation details
- [Database](database/index.md) -- schema for `column_automations`, `automation_runs`, swimlanes
- [Configuration](configuration.md#column-automations) -- the `kangentic.json` shape for a column's lists
