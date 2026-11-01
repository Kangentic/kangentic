---
type: Reference
title: Command injection
description: "How a column message reaches a live agent: the settings delta that restarts instead of typing /model, the verifier contract, the four-rung delivery ladder, handshake keystrokes (Ctrl+U, one Esc, retried Enter), the prompt-draft ledger, the automated keystrokes guard, outcomes, awaited exit delivery, test coverage and the file map."
tags: [command-injection, keystrokes, verifier, delivery]
sources:
  - resource: src/main/transition-engine/injection-plan.ts
  - resource: src/main/transition-engine/terminal-submit-scheduler.ts
  - resource: src/main/transition-engine/turn-completion.ts
  - resource: src/main/pty/terminal-submit.ts
  - resource: src/main/pty/automated-keys-guard.ts
  - resource: src/main/pty/prompt-draft-ledger.ts
  - resource: src/main/pty/output-settle.ts
  - resource: src/main/ipc/helpers/auto-command-outcome.ts
  - resource: src/main/ipc/helpers/exit-message-delivery.ts
  - resource: src/main/automations/turn-end/agent-message-delivery.ts
  - resource: src/main/agent/adapters/claude/slash-command-verifier.ts
  - resource: src/main/agent/shared/submitted-text-verifier.ts
  - resource: src/main/transition-engine/resume-prompt-delivery.ts
---
# Command injection

Kangentic injects a column's message to its agent into a live agent session when a task moves between columns. The column's model and effort settings are never typed into a task session. A change to either restarts the session with the new launch flags (see the next section). Only the Command Terminal, which has no session to `--resume`, still switches model and effort live with a typed `/model` or `/effort`. The message comes from a **Send message to agent** automation on the column (see [Column automations](../../settings/cascade.md#column-automations)); it used to be the `auto_command` field, and this document still uses that name for the delivery machinery, which did not change: the scheduler, the verifier contract, and the four `auto_command_*` outcome columns on `tasks` are all as they were. `TerminalSubmitScheduler` (`src/main/transition-engine/terminal-submit-scheduler.ts`) schedules each task's burst, decides WHEN it is delivered, and records the outcome. `TerminalSubmit.submitKeystrokes` (`src/main/pty/terminal-submit.ts`) executes the byte-level sequence (`Ctrl+U? → text → Esc? → Enter` per command), where the leading `Ctrl+U` clears any draft on a warm session and the `Esc` fires only for a `/`-prefixed command, at most once, and never during a live turn. Each step is a drain plus output-settle handshake rather than a fixed sleep. This document covers how the **command-injection** verification context confirms each chained command lands cleanly on the agent's TUI. The per-adapter support matrix and the recipe for graduating an adapter are in [Command injection support matrix](command-injection-support-matrix.md); the flush measurements are in [Command injection measurements](command-injection-measurements.md).

## What a move does to a live session (the settings delta)

`prepareInjectionPlan` (`src/main/transition-engine/injection-plan.ts`) decides whether a column
transition or a column/profile edit must restart the live session, by diffing a **source** against
a **target** for model and effort. It returns `restartReason`: `'model'` when the target model is
concrete and differs, else `'effort'` when the target effort is concrete and differs, else `null`.
A column move with a reason suspends the session and resumes it with `--model` / `--effort` as
launch flags (phase label `switching-model` or `applying-settings`), carrying the column message or
plan-exit continuation as the resume prompt. Where the resume cannot carry it (an adapter whose
resume takes no prompt, a launch that would flatten its lines, a prompt over 6,000 characters), it
is typed in once the agent is ready (see [How the resume prompt arrives](../sessions/resume.md#how-the-resume-prompt-arrives)). A restart from a ContextBar pick or a column or Board
Profile edit resumes idle instead. A null target is the "Default" column and never
restarts: `--resume` keeps whatever the session runs at.

A column or Board Profile edit (`propagateStrategyToLiveSessions`) restarts every running session
in that column it changes, each resuming idle. Each restart runs under its own task lock and first
re-reads the task: if a move, a ContextBar pick, or an earlier edit already restarted or moved the
session, it skips. An edit that did not change effort never restarts for effort, so drift it never
touched (a manual `/effort`) leaves the turn alone; a move still realigns it.
The ContextBar pick decides with the same rule, `resolveRestartReason`, in
`applyTaskSettingsToLiveSession` (`task-runtime-override.ts`). The target is the task's effective
value after the write. The source is what the session runs at: for effort, the same
`resolveSourceEffort` a move uses, with the task's pin left out because the pin is what the pick
changes; for model, the session's `applied_model`. So picking an effort the user already set by
hand with `/effort`, or the model a Default column kept the session on, saves the pin without a
restart. Only the fields the pick touched count, so an effort pick never restarts to realign a
model the session drifted from. The record it reads is the live session's own
(`resolveOwnSessionRecord`), not the task's newest, which can belong to an isolated track.

An agent or the phone setting a model or effort pin, a profile, or a run mode through
`kangentic_update_task` reaches the running session the same way: the MCP host calls
`applyTaskSettingsToLiveSession` under the task lock, after the tool reply is sent. A field counts
as changed only when the write moved its stored value; a profile or run-mode change counts for
both. So an agent re-sending the run mode the task already has leaves a manual `/effort` alone.
Until now that write only took effect at the next spawn, and a move still reads the pin first, so
nothing realigned the session. The restart ends the session's current turn, which is the
calling agent's own turn when it updates its own task; the tool's reply says so.

Effort used to switch live with a typed `/effort`. That could not be confirmed where it mattered
most: a plan-exit move always lands mid-turn, a mid-turn `/effort` writes no transcript entry, and
the `command-match` retries pressed bare Enter into the running turn. A restart cuts the in-flight
turn, the same cost a model change already accepts. Measured from transcripts, a same-model
`--resume` within about an hour of the previous request reads the conversation back from the
prompt cache; a resume that also changes `--effort` has not been sampled yet.

- **Target** is the destination column's effective value: `task.<override> ?? toLane.<override> ?? project.default_<field> ?? null`.
  The project-default tier is read on both sides of the diff: without it, a task moving between
  two override-less columns on a project with a default model/effort set would read source = the
  applied project default (recorded at the last spawn) vs target = null, and spuriously
  restart even though nothing actually changed.
  That project tier is **gated on the destination agent**: it applies only when the agent the
  destination resolves to (`task.agent_override ?? toLane.agent_override ?? project.default_agent`)
  equals `project.default_agent`. Model and effort ids are adapter-specific, so a default chosen
  for the project's agent is meaningless for a different one - a Codex column on a `claude` project
  with `default_model: "haiku"` would otherwise target `haiku` and restart into a model Codex
  rejects outright. A task's or column's OWN override is never gated: it was chosen alongside that
  scope's agent. The gate is the shared `projectModelDefaultsApply` predicate
  (`src/main/transition-engine/spawn-preamble.ts`), and the spawn path applies the identical rule -
  they must agree, or a move would restart toward a model the spawn never applied.
- **Source** is the value the live session is *actually running at*. It is NOT the leaving
  column's config. The leaving column disagrees with reality after an in-flight ContextBar switch
  or a `kangentic.json` column-config edit, and is null on a move with no resolvable
  leaving-column - either case used to manufacture a spurious change even though the
  spawn/resume `--model` / `--effort` flags had already applied the value. `record` is the live
  session's own record (`resolveOwnSessionRecord`), not the task's newest, which can belong to an
  isolated track.
  - **Effort:** `task.effort_override ?? <agent-reported effort> ?? record.applied_effort ?? null`
    (`resolveSourceEffort`, subject to the silent-downgrade rule below). `applied_effort` records what Kangentic *asked for*; an `/effort` the
    user types straight into the terminal never reaches it. Preferring the agent's own reported
    level fixes the case where applied = `high`, the user switched to `medium` by hand, and the
    destination column requires `high`: source and target would both read `high`, nothing would
    restart, and the session would silently keep running at `medium`. Callers resolve the live
    value with `resolveReportedEffort(reader, sessionId)`, where the reader exposes
    `getUsageCache()` and `getFirstReportedEffort(sessionId)` (the handlers pass
    `context.sessionManager`). It is null for agents with no live telemetry and for models with no
    effort levels, where the record decides.
  - **A silent downgrade counts as applied.** Claude reports the level in force after any silent
    downgrade for its model, so a column asking for `max` on a model that tops out at `high` sees
    `high` reported back. Read plainly, every move into that column would restart, and each
    restart would land on `high` again. So the source is the target itself when two things hold:
    the target equals `applied_effort` (this session was launched at it), and the live level still
    equals the first level the agent reported after that launch (nobody has typed `/effort`
    since). `UsageAccumulator` keeps that first report per session id; every spawn or resume mints
    a new id, so it pairs with exactly one `applied_effort`. Both conditions are needed: a session
    launched at `max` and running at `high` must still read `high` when it moves into a `high`
    column, or it would restart for nothing. One cost remains. A session never launched at the
    target cannot know the model will downgrade it, so a session at `high` moved into a `max`
    column restarts once, and the moves after that converge. Removing that one restart needs
    per-model effort levels, and adapters discover `effortLevels` per agent from `--help`.
  - **Model:** `task.model_override ?? record.applied_model ?? null`. Deliberately *not* sourced
    from telemetry: the agent reports a canonical id (`claude-opus-4-8`) while the configured
    values are flag strings (`opus`), so comparing across those id spaces would read "changed" on
    almost every move and `restartReason` would turn that into a PTY restart each time.
  - A per-task override still wins for either field (source = target = pin, so that field never
    restarts the session).

Nothing is recorded as applied by the plan. A restart records `applied_model` / `applied_effort`
itself: `restartSessionForSettingsChange` and a move's Phase 3 both end in a spawn or resume that
writes `SessionRepository.updateAppliedSettings` with the resolved spawn overrides, so the *next*
transition diffs against what the session was launched with.

## Why verification exists

A column transition used to chain several commands in sequence: `/model X`, `/effort Y`, then a user-supplied `auto_command`. Settings now restart instead of being typed, so a task session's burst carries the `auto_command` alone, but the hazard it was built for still applies to that command. Without verification, an Enter key can be silently dropped by the TUI (autocomplete still showing, model picker overlay open, render frame skipped), causing the next text to concatenate into the previous prompt buffer. The original failure was a single combined entry like `<command-args>claude-opus-4-7\n/effort xhigh</command-args>`, a "model not found" failure that quietly left the column's intended settings unapplied.

Time-based settles cannot detect this because the writes did succeed; only the input semantics broke. We need an **authoritative signal** from the agent that the command was processed as the discrete invocation we intended.

## The verifier contract

Adapters declare verification capability via the optional `getSubmissionVerifier` method:

```typescript
interface AgentAdapter {
  getSubmissionVerifier?(contextType: SubmissionContextType): SubmissionVerifier | null;
}

type SubmissionContextType = 'paste' | 'command-injection';

type SubmissionContext =
  | { type: 'paste' }
  | {
      type: 'command-injection';
      text: string;
      agentSessionId?: string;
      cwd?: string;
      sentAt?: number;
      mode?: 'command-match' | 'submitted';
      /** Where the session's CLI runs when it is a WSL distro: its history is there. */
      cliTarget?: StoredCliTarget | null;
      /** The transcript path the agent reported (the session row's `transcript_path`). May be stale or name another id. */
      transcriptPath?: string | null;
    };

type SubmissionVerifier = (context: SubmissionContext) => Promise<boolean>;
```

For the `'command-injection'` context, the verifier receives the literal command text plus session metadata (the `agent_session_id`, the session `cwd`, the transcript path the agent reported, and `sentAt` - the wall-clock timestamp of the most recent Enter the verifier should match against) and returns `true` once it confirms the command was processed. `sentAt` advances on each retry-Enter so stale transcript entries from previous attempts cannot satisfy the current verification. `mode` selects HOW strongly the command must be confirmed; see "Per-command verification modes" below.

The `agent_session_id` is NOT captured once at plan-build time: `buildCommandInjectionVerifier`
re-reads the session record by primary key (`findByAnyId(recordId)`) on every poll, and when the
record's id has changed mid-burst it accepts a match under either the current or the
plan-build-time id. A `/clear` during an in-flight burst forks the live conversation to a new id
(see docs/integrations/agents/session-history.md, "Mid-session fork reconcile"); polling only the
plan-build-time id would never confirm, so the burst would spend its whole retry budget pressing
Enter into a session whose evidence is being written somewhere else.

The record is re-read on a 250ms TTL rather than on every poll. `findByAnyId` calls `db.prepare`
inline and better-sqlite3 is synchronous, so polling it at the 25ms verify cadence would put 40
blocking DB round trips per second per in-flight burst on the thread that services IPC. The TTL
stays well inside a single 400ms retry attempt, so a fork is still picked up in the attempt that
follows it.

## Claude's JSONL-polling implementation

Claude's is the richest verifier, and the only one that matches on a structured slash-invocation record rather than on the submitted text. Nine adapters provide a `'command-injection'` verifier today (see the [matrix](command-injection-support-matrix.md#per-adapter-support-matrix)). Of the eight besides Claude, five (Codex, Qwen, Kimi, Grok, Antigravity) reuse the shared submitted-text scan; Copilot, OpenCode, and Aider each ship a bespoke verifier, because their history formats cannot support that scan safely.

Claude Code writes every successful slash invocation to its session JSONL transcript as a `local_command` system entry whose `<command-name>` matches the slash and whose `<command-args>` matches exactly what was sent. The verifier (`src/main/agent/adapters/claude/slash-command-verifier.ts`) tail-scans this file for an entry matching both fields exactly:

- Match `<command-name>` against the slash (e.g. `/model`).
- Match `<command-args>` against the literal args we sent (e.g. `claude-opus-4-7`).

A combined-args entry like `claude-opus-4-7\n/effort xhigh` is **not** a match by design -- that is the failure mode we want to detect and retry.

The scan is bounded by a 50ms tolerance window around the send time (`Date.now()` at the moment of the FIRST Enter for the command), so the polling cadence (~25ms) lands on the expected entry within ~50-100ms in the happy path. That watermark is held fixed across the command's retry-Enters and the scheduler's late re-check; see [Retry, and what happens on exhaustion](#retry-and-what-happens-on-exhaustion) for why it must not advance.

## The delivery ladder

A column's message reaches the agent by more than one mechanism, and they do not have equal guarantees. Delivery is an ordered ladder that ends in one:

| Rung | Mechanism | When | Guarantee |
|---|---|---|---|
| 1 | **argv prompt** | The session is being spawned or resumed anyway (fresh spawn; a move that already needs a restart for a model or effort change) | Guaranteed by the spawn. A resume whose prompt cannot ride its command line hands it back (`unsentPrompt`), and it is typed in once the agent is ready, with no rung 3 behind it |
| 2 | **keystrokes** | A live warm session | Verified in the transcript, or falls to rung 3 |
| 3 | **restart + argv prompt** | Rung 2 exhausted its retries on a *verifiable* command, on an adapter whose resume carries a prompt (`resumePromptDelivery: 'command-line'`) | Guaranteed by the spawn |
| 4 | **recorded failure + notice** | Rung 3 unavailable or itself failed | Observable |

Rung 1 is the most reliable path and must not be regressed into keystrokes (see `agent-spawn.ts`: a promptless isolated spawn never emits `'thinking'`, so the keystroke scheduler would burn its full 30s fallback and read as "the auto_command never ran").

Rung 3 is what makes the guarantee falsifiable rather than aspirational. It routes through `restartSessionForSettingsChange`, which is already allowlisted as a non-first-spawn direct engine call, so escalation adds no new spawn entry point. These constraints hold:

- It needs an adapter whose resume carries a prompt (`resumePromptDelivery: 'command-line'`). For any other, the restart would type the command again, which is the delivery that just failed, so `prepareInjectionPlan` marks the command `escalatable: false` and it ends `failed`. Today the only adapters that escalate at all, Claude and Codex, are both `command-line`, so this gate changes no adapter's behavior yet; it stops a future graduation of a `typed` one. A `command-line` restart can still type its command, when it has lines a `.cmd` shim launch would flatten or is over the cap: the engine hands it back in `unsentPrompt` and `restartSessionForSettingsChange` types it in.
- It is gated on the same turn-completion predicate deferred mode uses, never a bare `idle` check. A bare idle would fire during an API retry backoff or a `Monitor` wait and kill live work.
- While that gate waits, the verifier is re-polled every second against each command's original first-Enter watermark (its `CommandDelivery.firstSentAt` on the burst result), and once more when the turn completes. A confirmation anywhere in that wait cancels the restart and the outcome becomes `confirmed`. A restart re-runs the command, and it did: every observed live injection of a skill command (`/merge-pull-request`, four of four moves) was reported `failed` by the burst and then run a second time by the restart (#682). The poll runs during the wait rather than only after it because the verifier reads a bounded tail; a long turn can push the entry out of reach of a single check at the end. Turn completion on its own is never taken as delivery evidence: the turn that completes may be the one that was already running when the command was typed. A verifier that throws is a miss on both looks (logged, then the restart proceeds), never a reason to abandon the restart: the gate is the one path that re-sends a swallowed command.
- It is attempted at most once. If the restart's argv prompt still does not confirm, the outcome is `failed`.
- It carries **only** the user's message. An adapter-emitted settings write joined into an argv prompt stops being a slash invocation and becomes literal message text, and `--resume` preserves already-applied settings anyway.
- It emits the `resending-command` spawn-progress phase ("Re-sending command...") before the suspend, through `restartSessionForSettingsChange`'s required `phase`, so the card names the swap and the mobile bridge can attach the label to the suspend's `session-ended` (see [Scope and protocol history](../../integrations/mobile-bridge/scope.md#protocol-0140-a-respawn-shows-the-phone-switching-not-ended)).

### The exit path is rung 2 only, and it is AWAITED

A **Send message to agent** automation in a column's On EXIT group is the one injection in the app that cannot be fire-and-forget, and the reason is structural rather than a matter of taste. `scheduleKeystrokes` returns as soon as the burst is started, and every priority branch below the exit hook opens with `terminalSubmitScheduler.cancel(task.id)` before it kills (To Do), suspends (Done, a non-spawning column) or re-points (a live session) the session. So a scheduled exit burst is cancelled a few milliseconds later, mid-burst, by the very move that asked for it.

Measured in a preview against a live session: the run row read `succeeded` / "Delivered" in one millisecond, and the agent received the burst's leading Ctrl+U and nothing else, ever. The text was never written. No typecheck or unit test could see it, and the row said it worked.

`deliverExitMessage` (`src/main/ipc/helpers/exit-message-delivery.ts`) awaits the scheduler's own outcome, so the cancels run after delivery rather than through it and the run row records what happened instead of what was scheduled. The same message then measured 2203ms and arrived in full. Three consequences:

- **Rung 3 is unavailable.** The task is leaving the column; a restart to re-deliver its exit message would be spawning a session for a column the task is no longer in. An unconfirmed burst is the end of the ladder here.
- **`unconfirmed` counts as delivered.** Eleven of twelve adapters have no submission verifier, so failing the row on "could not be checked" would fail it on every agent but Claude.
- **The wait is bounded by the run's own signal**, which is this row's slice of the 60s exit budget. That cap is why holding the short lock is acceptable: the budget that bounds a hung exit script bounds a hung exit message too.

The ENTER path deliberately does not await. Nothing there cancels, and awaiting would hold Phase 3's lock across a deferred message's full 120s wait.

## Handshakes, not fixed sleeps

`submitKeystrokes` used to sleep a flat 100ms between keypresses, sized against the worst observed Ink picker render. That is correct on an idle machine and wrong on a busy one, which is exactly why delivery degraded under load: when the picker took longer than 100ms, the Esc landed before it mounted (a no-op), the picker then rendered, and it ate the Enter.

Each keystroke now waits for the TUI's own render instead:

```
Ctrl+U (if warranted) -> drain -> settle
text                  -> drain -> settle    // longer idle for a slash picker
Esc (slash, once, no live turn) -> drain -> settle   // separate READ
Enter                 -> drain -> verify    // retries re-press Enter only
```

### Which keys, and why (verified against Claude Code's docs)

Three key choices were originally wrong, and each produced a distinct reported bug. They are now grounded in Claude Code's documented behaviour rather than inference.

| key | why |
|---|---|
| **Ctrl+U** clears the prompt | The docs name it directly: "Up arrow to edit queued messages or **Ctrl+U to clear the input line**". It replaced Ctrl+C, which means CANCEL and **exits the CLI on a double press**, and which did not reliably clear a draft - producing `Tell me about 10 planets with details/merge-pull-request`. Ctrl+U is line editing, so it also leaves a running turn alone. |
| **no interrupt, ever** | "When a command is sent while Claude is responding, it typically **queues** and runs after the current turn finishes." Immediate mode therefore types and presses Enter; the CLI queues it. Interrupting was both unnecessary and the cause of the "it looked like it was editing a message already in flight" behaviour. |
| **Esc at most once, never during a live turn** | Esc is not picker-scoped - the docs describe it as "**stop Claude while it is generating output**". So it must never fire while a turn is running (it would abort the agent), and never twice: on a non-empty prompt the first press prints "Esc again to clear" and the second **clears the command being submitted**. |

Three details are load-bearing:

- **The drain is what makes the wait mean anything.** `sessionManager.write` enqueues; the queue drains over later ticks. A delay measured without draining is a delay from the enqueue, not from the PTY.
- **Settle observes `'data-tap'`, not `'data'`.** The `'data'` event is gated on renderer focus and is default-closed. Auto_command injection normally targets a session whose terminal is not the one on screen, so observing `'data'` would degrade every such delivery to the wall-clock cap. The tap is not free-running either: the pty host sends a session's output as `tap` only while something holds a `subscribeDataTap` subscription for it, so the settle subscribes for the length of its wait (and `pasteAndSubmit` for the whole paste).
- **Esc and Enter must land in SEPARATE reads.** `\x1b` immediately followed by `\r` in one read *is* the terminal's Meta encoding: the TUI parses it as Alt+Enter, which Claude Code binds to "insert a newline" rather than "submit". `drain()` does not prevent this - it empties Kangentic's write queue and says nothing about how ConPTY chunks bytes to the child, so the two writes routinely coalesce. The two are separated by an output-settle wait (idle-based, capped by `ESC_SETTLE_CAP_MS`, currently 400ms), not a fixed sleep. What the gap buys is an encoding boundary, not a render wait: it matters only that the bytes land in separate reads, not how long the pause is.

  This shipped briefly and was caught in manual testing: the command typed correctly, then every retry added a blank line to the prompt instead of submitting, and the burst escalated to a restart. An earlier version of this document argued the opposite - that Esc and Enter should stay adjacent to dodge a picker mounting between them. That trade was wrong twice over: nothing new is typed between the two keystrokes, so no new picker can mount, and the adjacency silently changed which KEY the TUI received.

  The load rig missed it because `SimulatedSessionManager` delivered every `write()` as its own key event, which is not how a PTY behaves. It now buffers incoming bytes and parses them on a coalesce window, so Meta sequences form the same way they do in a real terminal. Removing the gap drops the no-verifier sweep from 85.7% to 57.1% and produces submissions like `"/code-review\n"`.

**Esc is sent only for `/`-prefixed commands.** Its job is dismissing the slash-command picker, which only opens for a slash. On a plain-prose auto_command no picker exists and Esc is not a no-op on Claude Code's prompt, so sending it risks clearing the text just typed.

### Retry, and what happens on exhaustion

For a verifiable command, each attempt polls the verifier for 400ms; up to 5 attempts. **Retries re-press Enter alone.** Esc is sent at most once, on the first attempt only, because it is not a picker-scoped key: Claude Code documents it as "stop Claude while it is generating output", and on a non-empty prompt with no picker the first press prints "Esc again to clear", so a second press would delete the very command being submitted.

**The watermark is the first Enter, for every poll of that command.** It used to be re-stamped on each retry, and that made every later attempt blind to the first one's success. The backward scan stops at the first entry older than its watermark, and a submission stamped between two Enters has newer siblings between it and the tail (Claude writes a `command_permissions` attachment in the same instant as a skill invocation's user turn, and a `pr-link` a moment later), so a retry's scan returned false on a sibling before it could reach the entry. Claude also stamps the user turn at submit but flushes it ~780ms or ~1830ms later (see [Measured flush latency](command-injection-measurements.md#measured-flush-latency)), which is why attempt 1's 400ms window rarely saw it in the first place. The two together turned a delivered `/merge-pull-request` into `failed` on every observed move (#682).

**After the last retry the burst keeps polling for a 2000ms grace without pressing Enter** (`LATE_FLUSH_GRACE_MS`). The retry cadence answers "did a picker eat the Enter?" and the evidence horizon answers "has the transcript caught up?"; tying the second to the first is what made the budget 2000ms when the slow flush mode plus a skill's expansion exceeds it. A sixth Enter would buy nothing (the prompt is empty if the command went in) and risks answering whatever the started turn has since put on screen. That made the horizon ~4s. Task #952 added a further 8000ms of polling with no Enter (`PASSIVE_EVIDENCE_GRACE_MS`), so it is now ~12s.

**The prompt hook is evidence too.** Under load the transcript and the hooks both land late: one overnight nudge's prompt hook arrived 3.1s after its first Enter, and the "unconfirmed" warning had already gone out 1s after that, for a delivery that had worked. So a `submitted` command also confirms on a `prompt` event from the agent's own hook (Claude's `UserPromptSubmit`, never the PTY tracker's synthesized one) dated at or after its first Enter. It counts only when nothing else sat in the prompt to be submitted with the command: the burst cleared the prompt, or a fresh spawn had no draft. A `command-match` write still needs the transcript. Waiting costs only the passive window, and only when neither signal has come.

On exhaustion the code does **not** write `Ctrl+C`. If the command actually did submit and verification merely lagged, that Ctrl+C would kill the turn it just started, and it was the only path that could produce two consecutive Ctrl+C presses and exit the CLI. Exhaustion reports a failure alongside one `CommandDelivery` record per command (its text, its first-Enter `firstSentAt`, whether it confirmed; positional, so two identical commands in a burst keep separate records), and the scheduler escalates.

### Prompt-state policy

The clear is not a blunt universal. Three states:

1. **Empty prompt** - nothing to clear. A fresh spawn's prompt is empty by construction, so the clear is skipped; sending it would only add a keystroke that historically landed mid-render.
2. **User has text typed** - clear it, then type. Concatenation becomes impossible because the prompt is empty when we type. The discarded text is surfaced in a notice so it is recoverable rather than silently lost.
3. **Agent mid-turn** - in immediate mode the clear *is* the interrupt, and it is reported rather than silent. Deferred mode cannot reach this state.

"Empty at spawn time" is not "empty at delivery time": fresh-spawn delivery is deferred, and a user can type during the wait. That is the realistic path to the reported `instead can we/pull-request` bug, and it is why the fresh-spawn path still clears when the draft ledger saw the user type.

### Fresh-spawn concatenation failure mode

Fresh-spawn auto_command paths just consumed the CLI prompt arg (e.g. `claude -- "<task>...</task>"`) and the CLI is mid-render of that first user turn. On Windows ConPTY + Ink, sending `Ctrl+C` during that render landed in a state where the just-submitted prompt and the follow-up keystrokes rendered as one user message: `</task>/test` glued together. That was a *timing* failure, and the drain + settle handshake after the clear is what fixes it properly; skipping the clear on an already-empty prompt is a separate, smaller decision.

## The prompt-draft ledger

`PromptDraftLedger` (`src/main/pty/prompt-draft-ledger.ts`) answers "has the user typed something and not sent it?" without reading the screen. The pty host sees a raw ANSI byte stream, not a rendered screen, and the rendered screen lives in a renderer that may not even be showing this session - but every byte the user types passes through the host's write queue for that PTY, so accumulating those is a direct measure rather than an inference.

`write` takes a `WriteOrigin` (`'user' | 'system'`, defaulting to `'system'`). The human-facing entry points (a renderer's keystrokes, which reach the pty host on its own port, dictation, the mobile bridge's interactive terminal and permission answers) are tagged `'user'`. The ledger runs in the pty host, which records each write in the order its queue hands it to the PTY. Submit and clear bytes empty the ledger whatever their origin, since they empty the real prompt too; printable text counts only from `'user'`, so an injected command passing through is never mistaken for a draft.

Main reads the draft two ways. Keystroke injection asks the host (`SessionManager.readPendingDraft`, the `getPromptDraft` request), so a key typed on the renderer's port just before a burst is counted. The idle and low-memory pause checks read main's mirror (`getPendingDraft`), which the host's `promptDraft` event keeps, since they ask again on their next sweep.

It is deliberately **not** load-bearing for correctness: a warm session clears unconditionally, so a stale or missed entry degrades the message the user sees, never the delivery. It changes behavior in exactly one place - the fresh-spawn path, where it only ever *adds* a clear that would otherwise be skipped.

## The automated keystrokes guard

A permission prompt takes typed keys as its answer, so an automated Enter approves a tool call nobody saw. Every key Kangentic types on its own asks one gate first (`src/main/pty/automated-keys-guard.ts`, task #952): a column message, a workflow recovery nudge, the Enter of an automated paste, and an agent's message to another session. The gate reads `SessionManager.automatedKeysBlocker`, which refuses while the session is in `permission` or while a tool call has no end in the [open-work ledger](../activity/activity-engine.md#open-work). The second signal is there because the first can be lost: a parallel subagent's start once cleared the permission flag 4ms after a prompt opened, and a recovery nudge's Enter then approved the call. Each refusal is logged once per session and reason (`[automated-keys]`).

- **A keystroke burst** (`submitKeystrokes`) asks before it types, before each Esc and Enter, and again right before the Enter that follows an Esc's settle. A refusal waits for the session to clear, re-checking on each of its events and activity changes, however long that takes (`waitUntilAutomatedKeysClear`), and logs every 10 minutes that it still holds (`AUTOMATED_KEYS_HOLD_LOG_MS`). A message for an agent busy in a long foreground tool call goes once the call ends. An earlier 10-minute bound dropped it as "Not sent", where before the guard the CLI took it after the tool. Only the caller's signal (a move superseded the delivery) or the session exiting ends the wait early. A session that exits returns `failed` with `heldBy` naming it, and the scheduler records "Not sent: <reason>." with no escalation.
- **An automated paste** (`PasteOptions.automated`) waits the same way: before it writes, with no bound but its signal or the caller's `clearanceTimeoutMs` (before the paste's own timeout starts), and within that timeout before each Enter. Only the MCP `now` send passes a bound (30 s), because its caller's own tool call waits on it. One whose session exits during the wait throws `PasteSubmitError` with code `held`, and one whose signal ends it throws code `aborted`, both with nothing typed. The column message paste after a turn end and `kangentic_send_session_message` set it. A paste a person sends from the phone, dictation or the Browser pane never waits.
- **An agent's `deliverWhen: 'now'` send** is refused at once with `target-at-prompt`, which names the reason and points the caller at `deliverWhen: "idle"`.
- **Workflow recovery** asks the gate before it nudges and holds the nudge while it refuses (see [Workflow engine](../workflows/workflow-engine.md)).

The cost is deliberate: a message meant for a running agent waits while a foreground tool runs, and goes in between tool calls instead.

**Keys that reached a prompt anyway.** A burst watches the session's hook events while it runs (`BurstHookWatch`). A permission hook that arrives within 2s after an Enter, dated no more than 100ms after it, with no prompt hook for the command, means the prompt was on screen when the Enter landed, and the Enter most likely answered it. The burst stops typing and its result carries `reachedPermissionPrompt`. The scheduler records that as its own outcome: `failed`, with "An Enter reached a permission prompt, so it may have answered it.", never retried and never escalated. The exit path rejects with `KeysReachedPermissionPromptError` for it, and workflow recovery logs it as an attempt that does not count.

## Per-command verification modes

Each command carries how its delivery may be confirmed:

| Mode | Used for | Question answered |
|---|---|---|
| `command-match` | adapter-emitted settings writes (`/effort xhigh`). No current caller sends one: task sessions restart for settings, and the Command Terminal's slashes go out as `none`. It stays the Claude verifier's default mode. | did the transcript record a discrete invocation with exactly these args? |
| `submitted` | the user's `auto_command` | did exactly this text become a user turn? |
| `none` | adapters with no verifier | nothing; the outcome is `unconfirmed` |

This replaced a single `verifiedPrefixLength` count. That shape could express only ONE semantic for a whole burst, so the trailing user auto_command - the thing users actually care about - had to be excluded from verification entirely and settled on a fixed timer. Per-command modes remove the hole by construction rather than by tuning a number.

`submitted` is strictly weaker than `command-match`, and therefore always available: a user's command may be plain prose or an unregistered `/foo`, and Claude only treats a *leading* slash as a command anyway. The match must be **exact** - `instead can we/pull-request` *contains* `/pull-request`, so a substring test would confirm the precise bug this exists to catch.

On Claude, `submitted` accepts a third record shape besides the raw user text and the `<command-name>` rewrite: a `queue-operation` `enqueue` whose `content` equals the command. Text typed during a running turn is queued by the CLI, which writes the enqueue entry at once and the user turn only when the queue drains at the end of the turn, minutes later in a `/pull-request` pass. From the enqueue on the CLI owns the text (it is dequeued as the next turn or absorbed mid-turn), so keystroke delivery is complete and further Enters are no-ops. Without it a mid-turn injection could never confirm inside the retry budget, and the escalation restart ran it a second time (#682, two of the four incidents). `command-match` does NOT accept it: an adapter-emitted settings write must prove it parsed as the discrete invocation with these args, and "the CLI took the text" says nothing about that. Diagnostic: every `false` from Claude's scan logs one rate-limited `[slash-verifier] "..." not yet in <file>: stop=..., watermark=..., newest=..., scanned=N` line (at most one per 500ms per command for the first ten lines, then one per 5s, so a two-minute escalation gate on an unreadable transcript does not write 240 copies of the same fact); `newest` older than the watermark means nothing has flushed yet, `stop=watermark` on a newer sibling means the scan stopped before reaching the entry.

## Outcomes

Every scheduled injection ends in exactly one recorded outcome, persisted on the task (`auto_command_state`, `auto_command_text`, `auto_command_error`, `auto_command_at`):

| Outcome | Meaning | Notifies? |
|---|---|---|
| `confirmed` | seen in the transcript | only if it discarded a draft |
| `unconfirmed` | nothing could be checked | no |
| `escalated` | keystrokes went unconfirmed, so the command was delivered by restarting the session with it as the argv prompt | yes - a session respawn is never silent |
| `failed` | a verifiable command exhausted its retries, and no restart delivered it either | yes |
| `cancelled` | superseded or the session went away | no |

`escalated` is checked BEFORE `confirmed` in `toState()` (`src/main/ipc/helpers/auto-command-outcome.ts`), so a delivery that required a restart is never reported as `confirmed`. Escalation resolving means the restart was ISSUED and argv delivery is guaranteed by the spawn; it does not mean a verifier watched it land, which is why it is neither `confirmed` nor `failed`.

`unconfirmed` is **not** a failure. It is the normal outcome on every adapter without a verifier, and conflating the two would turn a normal delivery into an error notice for most users. See the [per-adapter matrix](command-injection-support-matrix.md#per-adapter-support-matrix) for which agents verify today.

## When to use `'paste'` vs `'command-injection'`

| Context | Caller | What gets verified | Latency |
|---------|--------|-------------------|---------|
| `'paste'` | `TerminalSubmit.submitContent` (browser captures, single auto-command paste, and a column message of more than one line or over 1,000 characters that is not a slash command) | "the agent acknowledged this prompt" | 100-500ms |
| `'command-injection'` | `TerminalSubmit.submitKeystrokes` (chained slash commands) | "this exact command was processed as a discrete invocation" | 50-150ms typical, ~12s worst case (five 400ms windows plus the 2000ms grace and the 8000ms passive window) |

The two contexts solve different problems: `'paste'` confirms one-shot paste submissions of arbitrary user prompts, while `'command-injection'` confirms each link in a multi-command chain landed cleanly. They share an interface (`getSubmissionVerifier`) so adapters declare what they support per context, and the renderer/IPC layer never has to branch on agent name.

**OR-combine vs poll-and-retry.** The two contexts also differ in how the engine consumes the verifier:

- `'paste'` runs the verifier **in parallel** with the activity-event listener and post-`\r` data path. The first signal to resolve wins. A verifier resolving `false` does not short-circuit the fallbacks - they remain active for the rest of the wait window. This matches the "best-effort confirmation" model: a verifier strengthens evidence but cannot weaken the existing fallback path.
- `'command-injection'` runs the verifier in a **tight poll loop** inside `TerminalSubmit.pollForConfirmation`. On each iteration the verifier is invoked with the command's first-Enter `sentAt`; if it returns `false`, the loop sleeps `pollMs` and retries. Past the retry interval (with no confirmation), Enter is re-fired and the watermark stays where it was. This matches the "deterministic chain" model: each command must be confirmed before the next.

## Test coverage

- `tests/unit/injection-load-rig.test.ts` - the delivery-rate rig and its recorded before/after.
- `tests/unit/injection-tui-simulator.ts` - the shared TUI model (not a test file).
- `tests/unit/terminal-submit.test.ts` - byte contract, prompt-state policy, verification modes, retry recovery, that exhaustion never writes Ctrl+C, the late-flush cases (a submission visible only 900ms or 2300ms after the Enter confirms on a later attempt or in the grace; five swallowed Enters still fail), the prompt hook's confirmation, a burst held by the keys guard, and an Enter that reached a permission prompt.
- `tests/unit/paste-engine.test.ts` - an automated paste's wait for the keys guard before it writes and before each Enter, and that a person's paste never waits.
- `tests/unit/mcp-session-send.test.ts` - the `now` refusal on an open prompt or an open tool call.
- `tests/unit/terminal-submit-scheduler.test.ts` - scheduling, the FIFO queue (no silent drop), deferred mode, escalation, outcome reporting, and the late confirmation at the escalation gate (a verifier that confirms during the wait or on the final check cancels the restart; one that never confirms still restarts; one that throws is a miss on the poll and on the final check alike; a cancelled burst stops polling).
- `tests/unit/turn-completion.test.ts` - the two-signal predicate, including the sustained false-idle cases.
- `tests/unit/prompt-draft-ledger.test.ts` - draft accounting.
- `tests/unit/auto-command-outcome.test.ts` - what is persisted vs what notifies.
- `tests/unit/injection-plan.test.ts` - plan building and per-command verify modes, including the slash opt-out.
- `tests/unit/agent-submission-verifier-shape.test.ts` - pins each adapter's recorded verdict AND its escalation tier, so adding a verifier without a measurement fails, and so does flipping a tier without the in-app proof.
- `tests/unit/codex-command-injection-verifier.test.ts` - Codex record shape, exact-match, and read cost.
- `tests/unit/qwen-command-injection-verifier.test.ts` - Qwen record shape, exact-match, and the missing-file case.
- `tests/unit/copilot-command-injection-verifier.test.ts` - Copilot's newest-first global history, the partial-write case, and the exactness property.
- `tests/unit/command-injection-real-capture-extractors.test.ts` - every extractor run over a REAL captured history file, asserting it recovers the user's text exactly. Covers Codex, Qwen, Kimi, and Aider; Copilot, OpenCode, Grok, and Antigravity have no committed capture, which is part of why they stay confirm-only.
- `tests/unit/confirm-only-command-injection-verifiers.test.ts` - the Kimi / Aider / OpenCode record shapes and the guards standing in for their missing measurements.
- `tests/unit/opencode-command-injection-query-bound.test.ts` - that OpenCode's `part` query stays bounded to the message ids already fetched, and is skipped entirely when there are none. Unbounded, it scanned and JSON-parsed every part row in the session on every 25ms poll, synchronously, on the thread that services IPC.
- `tests/unit/cursor-grok-binary-collision.test.ts` - that `cursor-agent` is preferred over the `agent` shim Grok also publishes.
- `tests/unit/auto-command-escalation-gate.test.ts` and `tests/unit/auto-command-escalation.test.ts` - when escalation may fire at all, and that the rung 3 restart holds its `resending-command` label across the suspend and clears it on every exit.
- `tests/unit/gemini-session-file-format.test.ts` - the `.json` / `.jsonl` generations for locate, capture, and telemetry parse.
- `tests/unit/claude-slash-command-verifier.test.ts` - Claude's matcher, the LRU-vs-clear-all burst guarantee, the queued-submission (`queue-operation` enqueue) evidence and its exactness, and the real skill-invocation record shape from the #682 transcript at both a first-Enter and an advanced watermark.

## Files

- `src/main/transition-engine/injection-plan.ts` - decides the `restartReason` (`'model'` / `'effort'` / null) for a column transition or column/profile edit, and builds the auto_command sequence (with its verify mode) + verifier; sources the effort delta from the agent's reported level ahead of the session record's `applied_effort`, counting a silent downgrade of the launch level as applied (`resolveReportedEffort` / `resolveSourceEffort`), and the model delta from `applied_model` alone. `resolveTargetSettings` resolves the target side for a move and a ContextBar pick alike.
- `src/main/transition-engine/terminal-submit-scheduler.ts` - task-keyed lifecycle: the burst FIFO, fresh-spawn wait, deferred wait, escalation, and outcome reporting.
- `src/main/automations/turn-end/agent-message-delivery.ts` - the one paste-or-type decision every column message path asks (`shouldPaste`: more than one line or over 1,000 characters, and not a slash command), and the paste after the agent's turn ends.
- `src/main/transition-engine/turn-completion.ts` - the shared turn-completion predicate.
- `src/main/pty/terminal-submit.ts` - byte-level engine: `submitContent` (bracketed paste) + `submitKeystrokes` (handshake chain, prompt-state policy, per-command verification).
- `src/main/pty/automated-keys-guard.ts` - the one gate every automated keystroke asks (`automatedKeysRefusal`, `waitForAutomatedKeysClearance`) and `KeysReachedPermissionPromptError`.
- `src/main/pty/output-settle.ts` - the settle primitive, shared with `paste-engine.ts`.
- `src/main/pty/prompt-draft-ledger.ts` - unsent-user-text accounting.
- `src/main/ipc/helpers/auto-command-outcome.ts` - persists the outcome and rations the notice.
- `src/main/agent/adapters/claude/slash-command-verifier.ts` - Claude's JSONL-polling implementation, including the `submitted` exact-content scan.
- `src/main/agent/shared/transcript-tail-cache.ts` - the bounded 256KB tail read and its LRU content-identity cache. Used by seven of the nine verifiers: Claude and Aider import it directly, Codex/Qwen/Kimi/Grok/Antigravity reach it through the shared scan. Copilot and OpenCode do not read an appendable text file at all (a global JSON blob and a SQL query), so they bypass it. Must stay ONE module-global instance.
- `src/main/agent/shared/submitted-text-verifier.ts` - the shared backwards tail walk, `sentAt` watermark, and exact trim-equality. Adapters supply only a synchronous path resolver and a record-shape extractor.
- `src/main/agent/adapters/codex/command-injection-verifier.ts` - Codex resolver (memoised readdir scan) and rollout record shape.
- `src/main/agent/adapters/qwen-code/command-injection-verifier.ts` - Qwen resolver (direct path construction) and chats record shape.
- `src/main/agent/adapters/kimi/command-injection-verifier.ts` - CONFIRM-ONLY. `wire.jsonl` resolver plus the unix-SECONDS timestamp conversion.
- `src/main/agent/adapters/grok/command-injection-verifier.ts` - CONFIRM-ONLY. `chat_history.jsonl` resolver (deterministic path from the caller-owned session UUID) and the `<user_query>`-unwrapping extractor; records carry no timestamps, so `timestampMs` is null and the scan matches on text alone within the bounded tail.
- `src/main/agent/adapters/aider/command-injection-verifier.ts` - CONFIRM-ONLY. One of the three bespoke verifiers that cannot use the shared scan (with OpenCode and Copilot): no per-entry timestamps, so it guards on file mtime and matches the LAST user block only.
- `src/main/agent/adapters/opencode/command-injection-verifier.ts` - CONFIRM-ONLY, and the only SQL-backed verifier; a remote session has no local row and is reported `failed`.
- `src/main/agent/adapters/copilot/command-injection-verifier.ts` - CONFIRM-ONLY. Reads `command-history-state.json` newest-first, guarded by file mtime and a bounded recent-entry window. Copilot keeps the file in its config home, and a Kangentic session's home is its own `copilot-config` folder (`--config-dir`), so the adapter hands the verifier the files of the sessions built for that folder first, then `~/.copilot`'s.
- `scripts/measure-injection-flush.mjs` - the manual measurement harness that gates every verifier above ([Command injection measurements](command-injection-measurements.md)).
- `src/shared/types.ts` - `SubmissionContext`, `SubmissionContextType`, `SubmissionVerifier`, `AutoCommandMode`, `AutoCommandState`, `AutoCommandResultNotice`.
