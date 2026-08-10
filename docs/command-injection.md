# Command Injection

Kangentic injects per-column "auto-commands" and per-column model/effort settings into a live agent session when a task moves between columns. `TerminalSubmitScheduler` (`src/main/transition-engine/terminal-submit-scheduler.ts`) schedules each task's burst, decides WHEN it is delivered, and records the outcome. `TerminalSubmit.submitKeystrokes` (`src/main/pty/terminal-submit.ts`) executes the byte-level sequence (`Ctrl+U? → text → Esc? → Enter` per command), where the leading `Ctrl+U` clears any draft on a warm session and the `Esc` fires only for a `/`-prefixed command, at most once, and never during a live turn. Each step is a drain plus output-settle handshake rather than a fixed sleep. This document covers how the **command-injection** verification context confirms each chained command lands cleanly on the agent's TUI.

## What gets injected (the settings delta)

`prepareInjectionPlan` (`src/main/transition-engine/injection-plan.ts`) decides which `/model` / `/effort`
slashes a column transition emits by diffing a **source** against a **target**:

- **Target** is the destination column's effective value: `task.<override> ?? toLane.<override> ?? project.default_<field> ?? null`.
  The project-default tier is read on both sides of the diff: without it, a task moving between
  two override-less columns on a project with a default model/effort set would read source = the
  applied project default (recorded at the last spawn) vs target = null, and spuriously
  restart/re-inject even though nothing actually changed.
- **Source** is the value the live session is *actually running at*. It is NOT the leaving
  column's config. The leaving column disagrees with reality after an in-flight ContextBar switch
  or a `kangentic.json` column-config edit, and is null on a move with no resolvable
  leaving-column - either case used to manufacture a redundant `/effort` injection even though the
  spawn/resume `--model` / `--effort` flags had already applied the value.
  - **Effort:** `task.effort_override ?? <agent-reported effort> ?? record.applied_effort ?? null`
    (`resolveSourceEffort`). `applied_effort` records what Kangentic *asked for*; an `/effort` the
    user types straight into the terminal never reaches it. Preferring the agent's own reported
    level fixes the case where applied = `high`, the user switched to `medium` by hand, and the
    destination column requires `high`: source and target both read `high`, no slash fires, and
    the session silently keeps running at `medium`. Callers resolve the live value with
    `resolveLiveEffort(usageCacheReader, sessionId)`, where the reader is anything exposing
    `getUsageCache()` (the handlers pass `context.sessionManager`). It is null for agents with no
    live telemetry and for models with no effort levels, where the behaviour is unchanged.
  - **Model:** `task.model_override ?? record.applied_model ?? null`. Deliberately *not* sourced
    from telemetry: the agent reports a canonical id (`claude-opus-4-8`) while the configured
    values are flag strings (`opus`), so comparing across those id spaces would read "changed" on
    almost every move and `needsRestartForModel` would turn that into a PTY restart each time.
  - A per-task override still wins for either field (source = target = pin, so no slash fires).

When effort changes to a concrete target, the returned `InjectionPlan` carries an
`appliedSettings: { effort? }`. Model is never recorded there: a model change restarts, and the
respawn records `applied_model` itself via its `--model` flag. Each caller (the `task-move`
Priority 3c path, the `SWIMLANE_UPDATE` propagation, and the `task:setRuntimeOverride` live path)
persists it via `SessionRepository.updateAppliedSettings` after scheduling the burst, so the
session's recorded running value stays current and the *next* transition diffs against the truth.
The same `updateAppliedSettings` is written at spawn/resume with the resolved spawn overrides.

## Why verification exists

Column transitions can chain several commands in sequence: `/model X`, `/effort Y`, then a user-supplied `auto_command`. Without verification, an Enter key can be silently dropped by the TUI (autocomplete still showing, model picker overlay open, render frame skipped), causing the next command's text to concatenate into the previous prompt buffer. The result is a single combined entry like `<command-args>claude-opus-4-7\n/effort xhigh</command-args>` -- a "model not found" failure that quietly leaves the column's intended settings unapplied.

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
    };

type SubmissionVerifier = (context: SubmissionContext) => Promise<boolean>;
```

For the `'command-injection'` context, the verifier receives the literal command text plus session metadata (the `agent_session_id`, the session `cwd`, and `sentAt` - the wall-clock timestamp of the most recent Enter the verifier should match against) and returns `true` once it confirms the command was processed. `sentAt` advances on each retry-Enter so stale transcript entries from previous attempts cannot satisfy the current verification. `mode` selects HOW strongly the command must be confirmed; see "Per-command verification modes" below.

The `agent_session_id` is NOT captured once at plan-build time: `buildCommandInjectionVerifier`
re-reads the session record by primary key (`findByAnyId(recordId)`) on every poll, and when the
record's id has changed mid-burst it accepts a match under either the current or the
plan-build-time id. A `/clear` during an in-flight burst forks the live conversation to a new id
(see docs/adapter-session-history.md, "Mid-session fork reconcile"); polling only the
plan-build-time id would never confirm, so the burst would spend its whole retry budget pressing
Enter into a session whose evidence is being written somewhere else.

The record is re-read on a 250ms TTL rather than on every poll. `findByAnyId` calls `db.prepare`
inline and better-sqlite3 is synchronous, so polling it at the 25ms verify cadence would put 40
blocking DB round trips per second per in-flight burst on the thread that services IPC. The TTL
stays well inside a single 400ms retry attempt, so a fork is still picked up in the attempt that
follows it.

## Claude's JSONL-polling implementation

Claude's is the richest verifier, and the only one that matches on a structured slash-invocation record rather than on the submitted text. Six adapters provide a `'command-injection'` verifier today (see the matrix below); the other five reuse the shared submitted-text scan.

Claude Code writes every successful slash invocation to its session JSONL transcript as a `local_command` system entry whose `<command-name>` matches the slash and whose `<command-args>` matches exactly what was sent. The verifier (`src/main/agent/adapters/claude/slash-command-verifier.ts`) tail-scans this file for an entry matching both fields exactly:

- Match `<command-name>` against the slash (e.g. `/model`).
- Match `<command-args>` against the literal args we sent (e.g. `claude-opus-4-7`).

A combined-args entry like `claude-opus-4-7\n/effort xhigh` is **not** a match by design -- that is the failure mode we want to detect and retry.

The scan is bounded by a 50ms tolerance window around the send time (`Date.now()` at the moment of the Enter), so the polling cadence (~25ms) lands on the expected entry within ~50-100ms in the happy path.

## The delivery ladder

`auto_command` reaches the agent by more than one mechanism, and they do not have equal guarantees. Delivery is an ordered ladder that ends in one:

| Rung | Mechanism | When | Guarantee |
|---|---|---|---|
| 1 | **argv prompt** | The session is being spawned or resumed anyway (fresh spawn; a move that already needs a restart for a model change) | Guaranteed by the spawn |
| 2 | **keystrokes** | A live warm session | Verified in the transcript, or falls to rung 3 |
| 3 | **restart + argv prompt** | Rung 2 exhausted its retries on a *verifiable* command | Guaranteed by the spawn |
| 4 | **recorded failure + notice** | Rung 3 unavailable or itself failed | Observable |

Rung 1 is the most reliable path and must not be regressed into keystrokes (see `agent-spawn.ts`: a promptless isolated spawn never emits `'thinking'`, so the keystroke scheduler would burn its full 30s fallback and read as "the auto_command never ran").

Rung 3 is what makes the guarantee falsifiable rather than aspirational. It routes through `restartSessionForSettingsChange`, which is already allowlisted as a non-first-spawn direct engine call, so escalation adds no new spawn entry point. Three constraints hold:

- It is gated on the same turn-completion predicate deferred mode uses, never a bare `idle` check. A bare idle would fire during an API retry backoff or a `Monitor` wait and kill live work.
- It is attempted at most once. If the restart's argv prompt still does not confirm, the outcome is `failed`.
- It carries **only** the user's auto_command. An adapter-emitted settings write joined into an argv prompt stops being a slash invocation and becomes literal message text, and `--resume` preserves already-applied settings anyway.

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
- **Settle observes `'data-tap'`, not `'data'`.** The `'data'` event is gated on renderer focus and is default-closed. Auto_command injection normally targets a session whose terminal is not the one on screen, so observing `'data'` would degrade every such delivery to the wall-clock cap.
- **Esc and Enter must land in SEPARATE reads.** `\x1b` immediately followed by `\r` in one read *is* the terminal's Meta encoding: the TUI parses it as Alt+Enter, which Claude Code binds to "insert a newline" rather than "submit". `drain()` does not prevent this - it empties Kangentic's write queue and says nothing about how ConPTY chunks bytes to the child, so the two writes routinely coalesce. The two are separated by an output-settle wait (idle-based, capped by `ESC_SETTLE_CAP_MS`, currently 400ms), not a fixed sleep. What the gap buys is an encoding boundary, not a render wait: it matters only that the bytes land in separate reads, not how long the pause is.

  This shipped briefly and was caught in manual testing: the command typed correctly, then every retry added a blank line to the prompt instead of submitting, and the burst escalated to a restart. An earlier version of this document argued the opposite - that Esc and Enter should stay adjacent to dodge a picker mounting between them. That trade was wrong twice over: nothing new is typed between the two keystrokes, so no new picker can mount, and the adjacency silently changed which KEY the TUI received.

  The load rig missed it because `SimulatedSessionManager` delivered every `write()` as its own key event, which is not how a PTY behaves. It now buffers incoming bytes and parses them on a coalesce window, so Meta sequences form the same way they do in a real terminal. Removing the gap drops the no-verifier sweep from 85.7% to 57.1% and produces submissions like `"/code-review\n"`.

**Esc is sent only for `/`-prefixed commands.** Its job is dismissing the slash-command picker, which only opens for a slash. On a plain-prose auto_command no picker exists and Esc is not a no-op on Claude Code's prompt, so sending it risks clearing the text just typed.

### Retry, and what happens on exhaustion

For a verifiable command, each attempt polls the verifier for 400ms; up to 5 attempts. **Retries re-press Enter alone.** Esc is sent at most once, on the first attempt only, because it is not a picker-scoped key: Claude Code documents it as "stop Claude while it is generating output", and on a non-empty prompt with no picker the first press prints "Esc again to clear", so a second press would delete the very command being submitted.

On exhaustion the code does **not** write `Ctrl+C`. If the command actually did submit and verification merely lagged, that Ctrl+C would kill the turn it just started, and it was the only path that could produce two consecutive Ctrl+C presses and exit the CLI. Exhaustion reports a failure, and the scheduler escalates.

### Prompt-state policy

The clear is not a blunt universal. Three states:

1. **Empty prompt** - nothing to clear. A fresh spawn's prompt is empty by construction, so the clear is skipped; sending it would only add a keystroke that historically landed mid-render.
2. **User has text typed** - clear it, then type. Concatenation becomes impossible because the prompt is empty when we type. The discarded text is surfaced in a notice so it is recoverable rather than silently lost.
3. **Agent mid-turn** - in immediate mode the clear *is* the interrupt, and it is reported rather than silent. Deferred mode cannot reach this state.

"Empty at spawn time" is not "empty at delivery time": fresh-spawn delivery is deferred, and a user can type during the wait. That is the realistic path to the reported `instead can we/pull-request` bug, and it is why the fresh-spawn path still clears when the draft ledger saw the user type.

### Fresh-spawn concatenation failure mode

Fresh-spawn auto_command paths just consumed the CLI prompt arg (e.g. `claude -- "<task>...</task>"`) and the CLI is mid-render of that first user turn. On Windows ConPTY + Ink, sending `Ctrl+C` during that render landed in a state where the just-submitted prompt and the follow-up keystrokes rendered as one user message: `</task>/test` glued together. That was a *timing* failure, and the drain + settle handshake after the clear is what fixes it properly; skipping the clear on an already-empty prompt is a separate, smaller decision.

## The prompt-draft ledger

`PromptDraftLedger` (`src/main/pty/prompt-draft-ledger.ts`) answers "has the user typed something and not sent it?" without reading the screen. The main process sees a raw ANSI byte stream, not a rendered screen, and the rendered screen lives in a renderer that may not even be showing this session - but every byte the user types passes through `SessionManager.write`, so accumulating those is a direct measure rather than an inference.

`write` takes a `WriteOrigin` (`'user' | 'system'`, defaulting to `'system'`). The human-facing entry points (renderer `SESSION_WRITE`, dictation, the mobile bridge's interactive terminal and permission answers) pass `'user'`. Submit and clear bytes empty the ledger whatever their origin, since they empty the real prompt too; printable text counts only from `'user'`, so an injected command passing through is never mistaken for a draft.

It is deliberately **not** load-bearing for correctness: a warm session clears unconditionally, so a stale or missed entry degrades the message the user sees, never the delivery. It changes behavior in exactly one place - the fresh-spawn path, where it only ever *adds* a clear that would otherwise be skipped.

## Per-command verification modes

Each command carries how its delivery may be confirmed:

| Mode | Used for | Question answered |
|---|---|---|
| `command-match` | adapter-emitted settings writes (`/effort xhigh`) | did the transcript record a discrete invocation with exactly these args? |
| `submitted` | the user's `auto_command` | did exactly this text become a user turn? |
| `none` | adapters with no verifier | nothing; the outcome is `unconfirmed` |

This replaced a single `verifiedPrefixLength` count. That shape could express only ONE semantic for a whole burst, so the trailing user auto_command - the thing users actually care about - had to be excluded from verification entirely and settled on a fixed timer. Per-command modes remove the hole by construction rather than by tuning a number.

`submitted` is strictly weaker than `command-match`, and therefore always available: a user's command may be plain prose or an unregistered `/foo`, and Claude only treats a *leading* slash as a command anyway. The match must be **exact** - `instead can we/pull-request` *contains* `/pull-request`, so a substring test would confirm the precise bug this exists to catch.

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

`unconfirmed` is **not** a failure. It is the normal outcome on every adapter without a verifier, and conflating the two would turn a normal delivery into an error notice for most users. See the per-adapter matrix below for which agents verify today.

## When to use `'paste'` vs `'command-injection'`

| Context | Caller | What gets verified | Latency |
|---------|--------|-------------------|---------|
| `'paste'` | `TerminalSubmit.submitContent` (browser captures, single auto-command paste) | "the agent acknowledged this prompt" | 100-500ms |
| `'command-injection'` | `TerminalSubmit.submitKeystrokes` (chained slash commands) | "this exact command was processed as a discrete invocation" | 50-150ms typical, ~2s worst case |

The two contexts solve different problems: `'paste'` confirms one-shot paste submissions of arbitrary user prompts, while `'command-injection'` confirms each link in a multi-command chain landed cleanly. They share an interface (`getSubmissionVerifier`) so adapters declare what they support per context, and the renderer/IPC layer never has to branch on agent name.

**OR-combine vs poll-and-retry.** The two contexts also differ in how the engine consumes the verifier:

- `'paste'` runs the verifier **in parallel** with the activity-event listener and post-`\r` data path. The first signal to resolve wins. A verifier resolving `false` does not short-circuit the fallbacks - they remain active for the rest of the wait window. This matches the "best-effort confirmation" model: a verifier strengthens evidence but cannot weaken the existing fallback path.
- `'command-injection'` runs the verifier in a **tight poll loop** inside `TerminalSubmit.pollWithRetries`. On each iteration the verifier is invoked with the current `sentAt`; if it returns `false`, the loop sleeps `pollMs` and retries. Past the retry interval (with no confirmation), Enter is re-fired and `sentAt` advances. This matches the "deterministic chain" model: each command must be confirmed before the next.

## Why a verifier must be measured before it is written

A verifier is what AUTHORIZES escalation, and escalation restarts the session with the command as an argv prompt. That makes the two failure modes wildly asymmetric:

- **No verifier** - the outcome is `unconfirmed`, escalation never fires, and nothing destructive happens.
- **A too-slow verifier** - a false `failed` escalates, and the restart **destroys live work.**

So a wrong verifier is worse than no verifier, and `getSubmissionVerifier` returning `null` is a declared answer (pinned per adapter in `tests/unit/agent-submission-verifier-shape.test.ts`), not an omission.

Measurement is the gate on WRITING a verifier. It is not on its own the gate on letting one escalate: see [Why escalation takes two proofs](#why-escalation-takes-two-proofs-and-measurement-is-only-the-first).

The trap is that the obvious measurement gives the wrong answer. A trivial prompt ends its turn in under a second, so an agent that flushes its history at TURN-END still reads sub-second and looks like a pass. The discriminator is a **paired short/long trial**: if append latency tracks turn duration, the agent is turn-end flushed and fails the gate. `scripts/measure-injection-flush.mjs` runs that pairing (plus a slash-command trial) against the real CLI under node-pty, and the numbers below come from it.

Two further rules the harness enforces, both learned the hard way here:

- **Measure the file the VERIFIER reads.** Qwen's probe text reaches `~/.qwen/tmp/<hash>/logs.json` in ~130ms but its `chats/<sessionId>.jsonl` in ~500ms. Reporting the first number would have credited the verifier with a latency belonging to a file it never opens.
- **An offline run can never establish a pass.** With credentials stripped there is no turn to flush at turn-end, so a fast append proves nothing. Offline yields only "absent" or "needs live confirmation".

## Measured flush latency

Live runs, 2026-08-08, Windows. "Worst" is the slowest observation across trials, because the safety-relevant statistic for a restart-authorizing signal is the worst case, never the mean.

| Agent | Short turn | Long turn (turn length) | Worst | Slash recorded? | Verdict |
|---|---|---|---|---|---|
| Copilot | 36ms, 37ms | 38ms, 37ms (32.3s, 23.3s) | **38ms** | yes (37ms, 53ms) | **implement** |
| Codex | 64ms, 108ms | 62ms, 61ms (4.6s, 4.4s) | **108ms** | no | **implement** |
| OpenCode | 64ms, 64ms | 95ms, 64ms (5.0s, 7.3s) | **95ms** | no | **implement** |
| Qwen | 443ms, 519ms | 696ms, 479ms (13.5s, 14.1s) | **696ms** | yes (306ms, 355ms) | **implement** |
| Claude (control) | 775ms, 1876ms | 791ms, 1828ms (11.4s, 6.3s) | **1876ms** | yes | **implement** |
| Droid | 3202ms, 941ms | 661ms, 636ms (4.5s, 9.9s) | **3202ms** | yes (580ms, 564ms) | **stop** |
| Cursor | login-gated | 5766ms, 5446ms (5.8s, 5.4s) | **5766ms** | yes (2614ms) | **stop** |
| Gemini | 5504ms, never (>25s) | never (>25s), 6302ms (16.9s) | **>25s** | not reached | **stop** |

**The bar is the delivery BUDGET, not a margin.** `submitKeystrokes` retries up to 5 times polling 400ms each, so a submission has ~2000ms to become visible before the outcome is `failed`, and `sentAt` advances on every retry. Two earlier attempts to hold reserve (1000ms, then 1500ms) both failed the CLAUDE CONTROL - the reference implementation whose verifier ships and works. Any bar that rejects the known-good adapter is measuring the wrong thing.

**Run the control after touching the harness.** Claude's numbers are bimodal (775/791/779ms or 1812/1828/1876ms, nothing between - a periodic flush caught either side of its interval), which is also why "typical" latency is meaningless here and only the upper mode matters. If `--agent claude` does not pass, the instrument is broken and no other verdict from it can be trusted.

**Cursor is the clearest turn-end flush after Gemini.** Its appends landed 40ms and 42ms either side of the turn ENDING - not correlated with turn length, essentially identical to it. Its first two probes were also login-gated (the harness's auth-gate detector did not recognise Cursor's wording, since phrase matching lags vendors), but that contamination changes nothing: the trials that DID land are disqualifying on their own at nearly 3x the budget.

OpenCode is measured through a read-only SQL query rather than a file scan, because a SQLite page is not observable as text. Getting that number took three runs and exposed a harness bug worth recording: some TUIs drop the first characters of typed input while they finish becoming interactive (OpenCode ate between 6 and 40 of them), which destroyed a front-anchored nonce and read as "never landed". The probe marker now sits at the END of the prompt and the harness settles before typing. Production does not hit this - `submitKeystrokes` runs its own Ctrl+U handshake and settle first - but any future probe must keep the marker trailing.

That contamination only ever produced false NEGATIVES, and it does not touch the verdicts above: Gemini and Droid failed on the latency of trials that DID land (5504ms/6302ms and 3202ms respectively), and every Codex and Qwen trial landed with an exact match.

Codex's append latency is flat against a turn 70x longer, which is what proves the write happens on submit. A read-only pre-screen agreed before any quota was spent: of 114 rollout files on a real machine, five ended in a TORN JSON line and one ended mid-turn on `exec_command_end` - only possible if the process died mid-append, which rules out a turn-end buffer.

Gemini is the case the gate exists for. It writes on message completion (its own parser says so), so two of four probes never landed within 25 seconds. A verifier built on it by analogy with Codex would have reported `failed` on healthy sessions and escalated them into restarts.

A note for anyone re-running this: Droid's numbers below are exactly as measured, but the verdict was corrected by hand afterwards. The saved report from that run records `implement`, because the gate itself had the bug described below and was fixed after the run. The measurement did not change; only the rule applied to it did. A fresh run on the current harness reports `stop`.

Droid fails for a different and more instructive reason: it is not turn-end flushed at all (its LONG turns appended fastest, at ~640ms), it is simply **unreliable** - 564ms at best and 3202ms at worst, with no relation to turn length. 3202ms exceeds the entire ~2s retry budget, so those submissions would have been reported `failed` while the agent was working normally. This is why the bar is the WORST observation rather than the mean, and why the harness gates on every trial rather than only the long-turn ones: an earlier revision checked only the long runs and returned "implement" for Droid while printing a 3202ms worst case.

Qwen passes but with far less margin than Codex, and lands ABOVE the 400ms single-attempt window, so it typically confirms on the second Enter attempt. That is well inside the ~2s budget, but it means any future tightening of `VERIFY_WINDOW_MS` puts Qwen at risk first.

## Per-adapter support matrix

There are three tiers, and the line between the first two is a safety property, not a quality judgement.

- **Verified** - flush latency measured live, AND this adapter's own verifier watched confirming a real submission inside a running app. Confirms, retries, and may escalate to a restart.
- **Confirm-only** - has a working verifier that confirms and drives retry-on-Enter, but **never escalates**. Each one records exactly which of the two proofs it is missing.
- **None** - no usable signal at all.

| Adapter | `'paste'` | `'command-injection'` | Tier | What it has, and what it lacks |
|---------|-----------|----------------------|------|-------|
| Claude | `null` | JSONL-polling verifier | **verified** | the shipped reference implementation; records slash invocations and user turns on submit |
| Codex | `null` | verifier (`submitted` only) | **verified** | 108ms worst, and proven in-app both ways (confirmed a real record, escalated a forced miss); declines SLASH commands, see below |
| Copilot | `null` | verifier | confirm-only | 38ms worst, the fastest measured. Lacks a real capture of `command-history-state.json` to pin its exact-match extractor against |
| OpenCode | `null` | verifier (SQL) | confirm-only | 95ms worst via a read-only query. Has a KNOWN wrong answer for remote sessions, below; declines SLASH commands, same as Codex |
| Qwen | `null` | verifier | confirm-only | 696ms worst, slash included. Builds its path from a CAPTURED session id and has never run against a live Qwen session in-app |
| Kimi | `null` | verifier | confirm-only | `wire.jsonl` shape pinned to real captures. Unmeasured: never reached a usable TUI |
| Aider | `null` | verifier | confirm-only | markdown shape from a real fixture. Unmeasured: not installed on the measuring machine |
| Gemini | `null` | `null` | none | measured turn-end flushed and highly variable |
| Droid | `null` | `null` | none | measured unreliable: 564ms best, 3202ms worst |
| Cursor | `null` | `null` | none | measured turn-end flushed: appends land within ~40ms of the turn ending |
| Warp | `null` | `null` | none | no history file accessible via CLI |
| Ollama | `null` | `null` | none | `ollama run` keeps no session history |

### Why escalation takes two proofs, and measurement is only the first

A verifier does two separable things, and they carry very different risk:

- **Rung 2, retry-on-Enter.** A `false` re-presses Enter. Pure upside: it recovers a submission a picker swallowed, and it is what closes the measured 92.9% -> 100% delivery gap. This is where nearly all the delivery win lives.
- **Rung 3, escalation.** Exhausting the retries restarts the session with the command as an argv prompt. That **destroys live work** if the verifier was wrong.

The harness answers one question: *does the CLI write the record fast enough?* It hunts a unique nonce with its own file reader, deliberately agent-agnostic so it stays honest even when the app's resolver is broken. That independence is also its limit. It says nothing about:

- whether **this adapter's resolver** points at the file the harness read (a path built from a session id that was never captured resolves to nothing, forever);
- whether the CLI **wraps or decorates** the stored text. Cursor stores `<user_query>\n<task>...</task>\n</user_query>`, which a nonce substring search finds happily and exact trim-equality never matches.

Both of those produce a **permanent** false negative rather than an intermittent one, so they would escalate *every* auto_command the adapter ever receives. That is why the second proof is a run inside the app, and why an adapter stays confirm-only until it has one, even with a clean measurement.

Mechanically: `canEscalateOnVerificationFailure() === false` makes `prepareInjectionPlan` mark the auto_command `escalatable: false`, and `TerminalSubmitScheduler.escalate` filters it out. Worst case for a confirm-only adapter is a `failed` outcome and a notice, never a respawn. The tiers are pinned per adapter in `tests/unit/agent-submission-verifier-shape.test.ts`, so flipping one without recording the evidence fails CI.

### Graduating an adapter (the contributor recipe)

Both steps cost zero agent quota. Do them in order; step 2 is the one that has actually caught bugs.

**1. Measure the CLI.** `node scripts/measure-injection-flush.mjs --agent <name>`, on a machine where that CLI is authenticated and responsive. Run `--agent claude` first as a control: Claude's verifier ships and works, so a harness that fails Claude is broken and no other verdict from it can be trusted. Record the short/long/slash numbers in the latency table above. The bar is the ~2000ms delivery budget, applied to the WORST observation.

**2. Prove the adapter's own verifier in the app.** Point `agent.cliPaths.<agent>` at a mock CLI that writes a real-shaped record into that agent's real history location (read the working directory off the CLI's own argument rather than `process.cwd()` - Codex records the `-C` value, and getting that wrong silently writes to the wrong slug). Create a task with `agent_override` set to that agent, move it into a column carrying an `auto_command`, and read the task's `auto_command_state` back out of the project DB.

   - Expect `confirmed`.
   - Then disable the mock's record write and repeat. A confirm-only adapter must land on `failed` with the session still alive; an escalating one must land on `escalated` with a restart.

**3. Flip the flag and say why.** Drop that adapter's `canEscalateOnVerificationFailure` override, update its row in the matrix above and its entry in `agent-submission-verifier-shape.test.ts`, and record what you ran. **Do not drop the override because the parser tests pass** - the parser was never the risky part.

If you only get through step 1, that is still worth a PR: the numbers go in the table and the adapter keeps its confirm-only verifier. And if an adapter misbehaves for you, the useful bug report is its `auto_command_state`, the agent, and whether the session was local or remote.

Run to date, against a mock CLI writing a real rollout file, driving actual column moves:

| Adapter | Tier | Verifier outcome | `auto_command_state` | Session restarted? |
|---|---|---|---|---|
| Codex | verified | confirmed 1ms after the record landed | `confirmed` | no |
| Codex | verified | never recorded (forced) | `escalated` | **yes** |
| OpenCode | confirm-only | never confirmed | `failed` | **no** |

The last two rows are the whole point of the tier split: identical verifier behaviour, opposite consequences.

### Known limitations, per adapter

Each confirm-only adapter carries a guard standing in for what could not be measured, or a documented wrong answer:

- **OpenCode remote sessions are reported `failed` however well they were delivered.** A remote session keeps no local row, so the query finds nothing on every poll. `locateSessionHistoryFile` guards this case via `remoteTargetsByCwd`, but `getSubmissionVerifier` receives only a context type and has no `cwd` to check it with; and once running, the verifier's boolean contract cannot distinguish "cannot observe" from "observed absence" - both must return false so the caller keeps polling through the normal post-spawn gap. Escalation being off is the containment: a spurious notice instead of a restart on every delivery. Widening the verifier contract is the real fix and is not attempted here.
- **Copilot's history is GLOBAL** across every session and project, with no timestamps and no session id, so a concurrent injection from another task can push our entry down the list. The verifier accepts a match from the newest few entries rather than strictly `[0]`, which biases the residual error toward a harmless false POSITIVE instead of a false negative. That mitigation is reasoning, not measurement.
- **Aider** has no per-entry timestamps and one file per project, appended forever, so a previously-run auto_command would otherwise confirm from a months-old entry. It requires the FILE's mtime to be at/after `sentAt` AND matches only the LAST user block. It is also the one adapter with NO session id at all, so it declares `requiresAgentSessionIdForVerification() === false`; without that the shared wrapper short-circuits on the missing id and the verifier can never confirm, which is worse than having none (the burst still retries, then reports `failed` where it would have stayed silently `unconfirmed`).
- **Kimi** records `timestamp` in unix SECONDS; it is scaled to milliseconds, without which every record reads ~56 years stale and nothing would ever confirm.

**Unmeasured is a real verdict, distinct from a measured "no".** Two adapters have no number yet, and neither has been shown to flush late:

- **Kimi** never reached a usable TUI (it hung past the harness's four-minute per-probe ceiling on a single trial).
- **Aider** is not installed on the measuring machine.

OpenCode used to sit here too, and how it left is the instructive part: nothing about OpenCode changed, the INSTRUMENT did. Its storage is a SQLite database, so a byte scan of the page file proved nothing either way; once the harness gained a read-only query mode it measured 64-95ms. Treat "unmeasured" as a statement about the harness as much as about the agent.

### Cursor: located, not yet verified

Cursor's entry used to read "session history location is not known". It is now known, and the reason it stayed unknown is worth recording: Cursor was **undetectable** on any machine that also had xAI's Grok CLI, because both publish a PATH shim named `agent` and Grok's `agent.exe` wins PATHEXT order. Nobody could investigate an agent the app could not find. That is fixed (`binaryName: 'cursor-agent'` with `agent` as an alias; see `tests/unit/cursor-grok-binary-collision.test.ts`).

What exists on disk:

- `~/.cursor/projects/<cwd-slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl` - per-session JSONL, records `{"role":"user","message":{"content":[{"type":"text","text":...}]}}`.
- `~/.cursor/chats/<hash>/<sessionId>/store.db` - a per-session SQLite store alongside it.

Three things must be settled before Cursor earns a verifier, and none is done:

1. **Flush latency is unmeasured.** The harness has no Cursor entry yet.
2. **The records carry no timestamp.** The shared scan bounds itself with a `sentAt` watermark read off each record; with none, the same guards Aider needs apply (file mtime at/after `sentAt`, and match only the LAST user block). The per-session file at least bounds staleness to one session, unlike Aider's per-project log.
3. **The stored text is WRAPPED.** The captured turn reads `<user_query>\n<task>...</task>\n</user_query>`, not the raw submitted text, so exact trim-equality would fail unless the extractor unwraps it. Whether a keystroke-injected auto_command is wrapped the same way is itself unverified.

Droid is different: it WAS measured, on an authenticated session, and failed on variance rather than on being unmeasurable. Do not re-litigate it without new numbers.

The harness distinguishes these cases automatically. It detects a CLI parked on a login or device-code prompt and reports `unmeasurable-here` rather than a measured "no" - without that check, Droid drew a confident `stop` verdict while it was actually sitting on a Factory login screen, which is a fabricated measurement.

### Codex declines slash commands specifically

Codex handles slash input in the TUI. A probe of `/kng-probe-<nonce>` printed `Unrecognized command` and produced no record at all, so absence from the rollout file cannot distinguish:

- the CLI **rejected** it (nothing ran), from
- the CLI **ran it client-side** (`/status`, `/compact`) and simply never made it a conversation turn.

Treating the second as a failure would escalate a command that actually worked into a session restart. So `CodexAdapter.canVerifySlashSubmission()` returns `false`, and `prepareInjectionPlan` tags a slash `auto_command` `verify: 'none'` for it - neither retried nor escalated, outcome `unconfirmed`. Prose auto_commands on Codex are still fully verified. This is a declared capability rather than an agent-name check, per `agent-adapters-boundary`.

When an adapter returns `null`, the caller falls back to:
- `'paste'`: activity event or any post-`\r` data byte (within 3s).
- `'command-injection'`: the handshake chain alone, with an outcome of `unconfirmed`.

An adapter with no verifier cannot reach 100% delivery: with no confirmation signal there is nothing to retry against, and no failure to escalate. Measured on the load rig it reaches ~93% against Claude's 100%, and its safety property still holds absolutely (a delivery may be missed, but a wrong one is never submitted). An adapter closes that gap by implementing `'command-injection'` verification once measurement shows its CLI flushes history on submit.

## Delivery modes

A column declares WHEN its auto_command fires, via `Swimlane.auto_command_mode`:

- **`immediate`** (default) - inject as soon as the task lands, interrupting the agent's current turn if there is one. The interruption is reported, not silent.
- **`deferred`** - hold until the agent's current turn genuinely finishes.

"Finishes" is the two-signal predicate in `src/main/transition-engine/turn-completion.ts`: activity is `idle` **and** the PTY has produced no output for a quiet window. A bare `idle` is not enough, because the catalogued sustained false idles (an API 529 retry backoff, a `Monitor` wait) report idle for minutes while the CLI keeps painting - a stability window expires inside both. Note the direction: output *present* holds delivery back; output *absent* is never taken as proof of anything on its own. `permission` is excluded from the completion set, since injecting there would answer the prompt with the command text.

That single predicate is shared with rung-3 escalation; there is deliberately no second idle check.

## Measured delivery rate

`tests/unit/injection-load-rig.test.ts` drives the real `TerminalSubmit` against a TUI model that can fail the way the real one fails (a picker with a render delay that eats Enter, a prompt buffer that survives, a startup window that swallows Ctrl+C, an asynchronous write queue, and reads that coalesce so Meta sequences form). Before and after the rebuild:

| Scenario | before | after |
|---|---|---|
| picker-render sweep | 57.1% | 100% |
| loaded sweep (seeded jitter) | 57.5% | 100% |
| draft present, warm session | 64.3% | 100% |
| fresh spawn, user typed during wait | 0% | 100% |
| startup render swallows the clear | 64.3% | 100% |
| adapter with no verifier | 57.1% | 92.9% |

Every "before" failure in the picker sweep fell in the 100-200ms band - exactly `KEYPRESS_DELAY < pickerRender < 2 * KEYPRESS_DELAY`. The fresh-spawn row is the reported bug verbatim: all 14 trials submitted `instead can we/code-review` as a single message.

## Test coverage

- `tests/unit/injection-load-rig.test.ts` - the delivery-rate rig and its recorded before/after.
- `tests/unit/injection-tui-simulator.ts` - the shared TUI model (not a test file).
- `tests/unit/terminal-submit.test.ts` - byte contract, prompt-state policy, verification modes, retry recovery, and that exhaustion never writes Ctrl+C.
- `tests/unit/terminal-submit-scheduler.test.ts` - scheduling, the FIFO queue (no silent drop), deferred mode, escalation, outcome reporting.
- `tests/unit/turn-completion.test.ts` - the two-signal predicate, including the sustained false-idle cases.
- `tests/unit/prompt-draft-ledger.test.ts` - draft accounting.
- `tests/unit/auto-command-outcome.test.ts` - what is persisted vs what notifies.
- `tests/unit/injection-plan.test.ts` - plan building and per-command verify modes, including the slash opt-out.
- `tests/unit/agent-submission-verifier-shape.test.ts` - pins each adapter's recorded verdict AND its escalation tier, so adding a verifier without a measurement fails, and so does flipping a tier without the in-app proof.
- `tests/unit/codex-command-injection-verifier.test.ts` - Codex record shape, exact-match, and read cost.
- `tests/unit/qwen-command-injection-verifier.test.ts` - Qwen record shape, exact-match, and the missing-file case.
- `tests/unit/copilot-command-injection-verifier.test.ts` - Copilot's newest-first global history, the partial-write case, and the exactness property.
- `tests/unit/confirm-only-command-injection-verifiers.test.ts` - the Kimi / Aider / OpenCode record shapes and the guards standing in for their missing measurements.
- `tests/unit/cursor-grok-binary-collision.test.ts` - that `cursor-agent` is preferred over the `agent` shim Grok also publishes.
- `tests/unit/auto-command-escalation-gate.test.ts` and `tests/unit/auto-command-escalation.test.ts` - when escalation may fire at all.
- `tests/unit/gemini-session-file-format.test.ts` - the `.json` / `.jsonl` generations for locate, capture, and telemetry parse.
- `tests/unit/claude-slash-command-verifier.test.ts` - Claude's matcher, plus the LRU-vs-clear-all burst guarantee.

## Files

- `src/main/transition-engine/injection-plan.ts` - builds the command sequence (each with its verify mode) + verifier from a column transition spec; sources the effort delta from the agent's reported level ahead of the session record's `applied_effort` (`resolveLiveEffort` / `resolveSourceEffort`), the model delta from `applied_model` alone, and returns `appliedSettings` for the caller to persist.
- `src/main/transition-engine/terminal-submit-scheduler.ts` - task-keyed lifecycle: the burst FIFO, fresh-spawn wait, deferred wait, escalation, and outcome reporting.
- `src/main/transition-engine/turn-completion.ts` - the shared turn-completion predicate.
- `src/main/pty/terminal-submit.ts` - byte-level engine: `submitContent` (bracketed paste) + `submitKeystrokes` (handshake chain, prompt-state policy, per-command verification).
- `src/main/pty/output-settle.ts` - the settle primitive, shared with `paste-engine.ts`.
- `src/main/pty/prompt-draft-ledger.ts` - unsent-user-text accounting.
- `src/main/ipc/helpers/auto-command-outcome.ts` - persists the outcome and rations the notice.
- `src/main/agent/adapters/claude/slash-command-verifier.ts` - Claude's JSONL-polling implementation, including the `submitted` exact-content scan.
- `src/main/agent/shared/transcript-tail-cache.ts` - the bounded 256KB tail read and its LRU content-identity cache, shared by every adapter's verifier. Must stay ONE module-global instance.
- `src/main/agent/shared/submitted-text-verifier.ts` - the shared backwards tail walk, `sentAt` watermark, and exact trim-equality. Adapters supply only a synchronous path resolver and a record-shape extractor.
- `src/main/agent/adapters/codex/command-injection-verifier.ts` - Codex resolver (memoised readdir scan) and rollout record shape.
- `src/main/agent/adapters/qwen-code/command-injection-verifier.ts` - Qwen resolver (direct path construction) and chats record shape.
- `src/main/agent/adapters/kimi/command-injection-verifier.ts` - CONFIRM-ONLY. `wire.jsonl` resolver plus the unix-SECONDS timestamp conversion.
- `src/main/agent/adapters/aider/command-injection-verifier.ts` - CONFIRM-ONLY. The only verifier not using the shared scan: no per-entry timestamps, so it guards on file mtime and matches the LAST user block only.
- `src/main/agent/adapters/opencode/command-injection-verifier.ts` - CONFIRM-ONLY, and the only SQL-backed verifier; a remote session has no local row and is reported `failed`.
- `src/main/agent/adapters/copilot/command-injection-verifier.ts` - CONFIRM-ONLY. Reads the GLOBAL `command-history-state.json` newest-first, guarded by file mtime and a bounded recent-entry window.
- `scripts/measure-injection-flush.mjs` - the manual measurement harness that gates every verifier above.
- `src/shared/types.ts` - `SubmissionContext`, `SubmissionContextType`, `SubmissionVerifier`, `AutoCommandMode`, `AutoCommandState`, `AutoCommandResultNotice`.
