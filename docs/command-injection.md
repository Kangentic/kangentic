# Command Injection

Kangentic injects per-column "auto-commands" and per-column model/effort settings into a live agent session when a task moves between columns. `TerminalSubmitScheduler` (`src/main/transition-engine/terminal-submit-scheduler.ts`) schedules each task's burst and decides whether the burst is prefixed with a `Ctrl+C` (live-injection) or not (fresh-spawn). `TerminalSubmit.submitKeystrokes` (`src/main/pty/terminal-submit.ts`) executes the byte-level keystroke sequence (`Ctrl+C? → text → Esc → Enter` per command). This document covers how the **command-injection** verification context confirms each chained command lands cleanly on the agent's TUI.

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
  | { type: 'command-injection'; text: string; agentSessionId?: string; cwd?: string; sentAt?: number };

type SubmissionVerifier = (context: SubmissionContext) => Promise<boolean>;
```

For the `'command-injection'` context, the verifier receives the literal command text plus session metadata (the `agent_session_id`, the session `cwd`, and `sentAt` - the wall-clock timestamp of the most recent Enter the verifier should match against) and returns `true` once it confirms the command was processed. `sentAt` advances on each retry-Enter so stale transcript entries from previous attempts cannot satisfy the current verification.

The `agent_session_id` is NOT captured once at plan-build time: `buildCommandInjectionVerifier`
re-reads the session record by primary key (`findByAnyId(recordId)`) on every poll, and when the
record's id has changed mid-burst it accepts a match under either the current or the
plan-build-time id. A `/clear` during an in-flight burst forks the live conversation to a new id
(see docs/adapter-session-history.md, "Mid-session fork reconcile"); polling only the
plan-build-time id would never confirm, ending in stray retry Enters plus a Ctrl+C fired into
the live session.

## Claude's JSONL-polling implementation

Claude is the only adapter that currently provides a `'command-injection'` verifier. Claude Code writes every successful slash invocation to its session JSONL transcript as a `local_command` system entry whose `<command-name>` matches the slash and whose `<command-args>` matches exactly what was sent. The verifier (`src/main/agent/adapters/claude/slash-command-verifier.ts`) tail-scans this file for an entry matching both fields exactly:

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

For a verifiable command, each attempt polls the verifier for 400ms; up to 5 attempts. **The retry re-sends Esc AND Enter, not Enter alone** - re-firing Enter into a picker that is still open just gets eaten again; the Esc is what clears the condition.

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
| `confirmed` | seen in the transcript | only if it discarded a draft, interrupted a turn, or required a restart |
| `unconfirmed` | nothing could be checked | no |
| `failed` | a verifiable command exhausted its retries | yes |
| `cancelled` | superseded or the session went away | no |

`unconfirmed` is **not** a failure. Only Claude implements a `command-injection` verifier, so on every other agent every delivery lands there; conflating the two would make the field meaningless off Claude and turn a normal delivery into an error notice for most users.

## When to use `'paste'` vs `'command-injection'`

| Context | Caller | What gets verified | Latency |
|---------|--------|-------------------|---------|
| `'paste'` | `TerminalSubmit.submitContent` (browser captures, single auto-command paste) | "the agent acknowledged this prompt" | 100-500ms |
| `'command-injection'` | `TerminalSubmit.submitKeystrokes` (chained slash commands) | "this exact command was processed as a discrete invocation" | 50-150ms typical, ~2s worst case |

The two contexts solve different problems: `'paste'` confirms one-shot paste submissions of arbitrary user prompts, while `'command-injection'` confirms each link in a multi-command chain landed cleanly. They share an interface (`getSubmissionVerifier`) so adapters declare what they support per context, and the renderer/IPC layer never has to branch on agent name.

**OR-combine vs poll-and-retry.** The two contexts also differ in how the engine consumes the verifier:

- `'paste'` runs the verifier **in parallel** with the activity-event listener and post-`\r` data path. The first signal to resolve wins. A verifier resolving `false` does not short-circuit the fallbacks - they remain active for the rest of the wait window. This matches the "best-effort confirmation" model: a verifier strengthens evidence but cannot weaken the existing fallback path.
- `'command-injection'` runs the verifier in a **tight poll loop** inside `TerminalSubmit.pollWithRetries`. On each iteration the verifier is invoked with the current `sentAt`; if it returns `false`, the loop sleeps `pollMs` and retries. Past the retry interval (with no confirmation), Enter is re-fired and `sentAt` advances. This matches the "deterministic chain" model: each command must be confirmed before the next.

## Per-adapter support matrix

| Adapter | `'paste'` | `'command-injection'` |
|---------|-----------|----------------------|
| Claude | `null` (time-based fallback) | JSONL-polling verifier |
| Codex / Gemini / Qwen | `null` | `null` |
| OpenCode / Copilot / Aider | `null` | `null` |
| Cursor / Droid / Kimi / Warp | `null` | `null` |

When an adapter returns `null`, the caller falls back to:
- `'paste'`: activity event or any post-`\r` data byte (within 3s).
- `'command-injection'`: the handshake chain alone, with an outcome of `unconfirmed`.

An adapter with no verifier cannot reach 100% delivery: with no confirmation signal there is nothing to retry against, and no failure to escalate. Measured on the load rig it reaches ~93% against Claude's 100%, and its safety property still holds absolutely (a delivery may be missed, but a wrong one is never submitted). A non-Claude adapter closes that gap by implementing `'command-injection'` verification once its CLI exposes a comparable structured signal.

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
- `tests/unit/injection-plan.test.ts` - plan building and per-command verify modes.
- `tests/unit/agent-submission-verifier-shape.test.ts` - every registered adapter implements `getSubmissionVerifier`.

## Files

- `src/main/transition-engine/injection-plan.ts` - builds the command sequence (each with its verify mode) + verifier from a column transition spec; sources the effort delta from the agent's reported level ahead of the session record's `applied_effort` (`resolveLiveEffort` / `resolveSourceEffort`), the model delta from `applied_model` alone, and returns `appliedSettings` for the caller to persist.
- `src/main/transition-engine/terminal-submit-scheduler.ts` - task-keyed lifecycle: the burst FIFO, fresh-spawn wait, deferred wait, escalation, and outcome reporting.
- `src/main/transition-engine/turn-completion.ts` - the shared turn-completion predicate.
- `src/main/pty/terminal-submit.ts` - byte-level engine: `submitContent` (bracketed paste) + `submitKeystrokes` (handshake chain, prompt-state policy, per-command verification).
- `src/main/pty/output-settle.ts` - the settle primitive, shared with `paste-engine.ts`.
- `src/main/pty/prompt-draft-ledger.ts` - unsent-user-text accounting.
- `src/main/ipc/helpers/auto-command-outcome.ts` - persists the outcome and rations the notice.
- `src/main/agent/adapters/claude/slash-command-verifier.ts` - Claude's JSONL-polling implementation, including the `submitted` exact-content scan.
- `src/shared/types.ts` - `SubmissionContext`, `SubmissionContextType`, `SubmissionVerifier`, `AutoCommandMode`, `AutoCommandState`, `AutoCommandResultNotice`.
