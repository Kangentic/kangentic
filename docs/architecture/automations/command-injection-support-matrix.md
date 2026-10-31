---
type: Reference
title: Command injection support matrix
description: Which adapters verify delivery (verified, confirm-only or none), why escalation needs a measurement plus an in-app proof, the recipe for graduating an adapter, per-adapter limits (OpenCode remote, Copilot global history, Aider), delivery modes, and the measured delivery rate.
tags: [command-injection, adapters, verifier, escalation]
sources:
  - resource: src/main/agent/shared/submitted-text-verifier.ts
  - resource: src/main/agent/shared/transcript-tail-cache.ts
  - resource: src/main/agent/adapters/codex/command-injection-verifier.ts
  - resource: src/main/agent/adapters/qwen-code/command-injection-verifier.ts
  - resource: src/main/agent/adapters/kimi/command-injection-verifier.ts
  - resource: src/main/agent/adapters/grok/command-injection-verifier.ts
  - resource: src/main/agent/adapters/aider/command-injection-verifier.ts
  - resource: src/main/agent/adapters/opencode/command-injection-verifier.ts
  - resource: src/main/agent/adapters/copilot/command-injection-verifier.ts
  - resource: src/main/transition-engine/turn-completion.ts
---
# Command injection support matrix

## Per-adapter support matrix

There are three tiers, and the line between the first two is a safety property, not a quality judgement.

- **Verified** - flush latency measured live, AND this adapter's own verifier watched confirming a real submission inside a running app. Confirms, retries, and may escalate to a restart.
- **Confirm-only** - has a working verifier that confirms and drives retry-on-Enter, but **never escalates**. Each one records exactly which of the two proofs it is missing.
- **None** - no usable signal at all.

| Adapter | `'paste'` | `'command-injection'` | Tier | What it has, and what it lacks |
|---------|-----------|----------------------|------|-------|
| Claude | `null` | JSONL-polling verifier | **verified** | the shipped reference implementation; records slash invocations and user turns on submit |
| Codex | `null` | verifier (`submitted` only) | **verified** | 108ms worst, proven in-app both ways (confirmed a real record, escalated a forced miss), and its extractor pinned to a real rollout capture; declines SLASH commands, see below |
| Copilot | `null` | verifier | confirm-only | 38ms worst, the fastest measured. Lacks a real capture of `command-history-state.json` to pin its exact-match extractor against |
| OpenCode | `null` | verifier (SQL) | confirm-only | 95ms worst via a read-only query. Has a KNOWN wrong answer for remote sessions, below; declines SLASH commands, same as Codex |
| Qwen | `null` | verifier | confirm-only | 696ms worst, slash included. Builds its path from a CAPTURED session id and has never run against a live Qwen session in-app |
| Kimi | `null` | verifier | confirm-only | `wire.jsonl` shape pinned to real captures. Unmeasured: never reached a usable TUI |
| Grok Build | `null` | verifier | confirm-only | 313ms/32ms flush-on-submit measured live; extractor unwraps the stored `<user_query>` wrapper and skips `synthetic_reason` records. Lacks the in-app proof, and `chat_history.jsonl` records carry NO timestamps so the scan cannot bound a `sentAt` window - a byte-identical PRIOR submission could false-confirm, harmless for confirm-only, disqualifying for escalation. Declines SLASH commands (TUI palette, never a recorded turn) |
| Aider | `null` | verifier | confirm-only | markdown shape from a real fixture. Unmeasured: not installed on the measuring machine |
| Antigravity | `null` | verifier (`submitted` semantics) | confirm-only | 84ms worst against the brain-dir transcript (`USER_INPUT` steps, `<USER_REQUEST>` unwrapped, whole-second timestamps with a 5s tolerance). Lacks the in-app confirmation proof; declines SLASH commands (rejected client-side, never recorded) |
| Gemini | `null` | `null` | none | measured turn-end flushed and highly variable |
| Droid | `null` | `null` | none | measured unreliable: 564ms best, 3202ms worst |
| Cursor | `null` | `null` | none | measured turn-end flushed: appends land within ~40ms of the turn ending |
| Warp | `null` | `null` | none | no history file accessible via CLI |
| Ollama | `null` | `null` | none | `ollama run` keeps no session history |
| Goose | `null` | `null` | none | `getSubmissionVerifier` returns null for every context; no transcript is parsed |

### Why escalation takes two proofs, and measurement is only the first

A verifier does two separable things, and they carry very different risk:

- **Rung 2, retry-on-Enter.** A `false` re-presses Enter. Pure upside: it recovers a submission a picker swallowed, and it is what closes the measured 92.9% -> 100% delivery gap. This is where nearly all the delivery win lives.
- **Rung 3, escalation.** Exhausting the retries restarts the session with the command as an argv prompt. That **destroys live work** if the verifier was wrong.

The harness answers one question: *does the CLI write the record fast enough?* It hunts a unique nonce with its own file reader, deliberately agent-agnostic so it stays honest even when the app's resolver is broken. That independence is also its limit. It says nothing about:

- whether **this adapter's resolver** points at the file the harness read (a path built from a session id that was never captured resolves to nothing, forever);
- whether the CLI **wraps or decorates** the stored text. Cursor stores `<user_query>\n<task>...</task>\n</user_query>`, which a nonce substring search finds happily and exact trim-equality never matches.

Both of those produce a **permanent** false negative rather than an intermittent one, so they would escalate *every* auto_command the adapter ever receives. That is why the second proof is a run inside the app, and why an adapter stays confirm-only until it has one, even with a clean measurement.

The wrapping half of that risk is partly mechanised: `tests/unit/command-injection-real-capture-extractors.test.ts` runs each extractor over a real captured history file committed under `tests/fixtures/` and asserts it hands back text that trim-equals what was typed. A hand-authored fixture cannot do this - it pins our belief about the shape rather than the shape itself. Codex, Qwen, Kimi, and Aider have such a capture; Copilot, OpenCode, Grok, and Antigravity do not, and adding one is the cheapest single contribution toward graduating any of them.

Mechanically: `canEscalateOnVerificationFailure() === false` makes `prepareInjectionPlan` mark the auto_command `escalatable: false`, and `TerminalSubmitScheduler.escalate` filters it out. So does a `resumePromptDelivery` other than `command-line` (Copilot, Grok, OpenCode and Cursor are `typed`, Aider is `no-resume`): the restart would type the command again rather than carry it. Worst case for a confirm-only adapter is a `failed` outcome and a notice, never a respawn. The tiers are pinned per adapter in `tests/unit/agent-submission-verifier-shape.test.ts`, so flipping one without recording the evidence fails CI.

### Graduating an adapter (the contributor recipe)

This is written for someone who already uses the agent in question - the numbers below could not be taken here for exactly the agents you may have installed. Do the steps in order; step 2 is the one that has actually caught bugs.

**1. Measure the CLI.** `node scripts/measure-injection-flush.mjs --agent <name>`, on a machine where that CLI is authenticated and responsive. Run `--agent claude` first as a control: Claude's verifier ships and works, so a harness that fails Claude is broken and no other verdict from it can be trusted. Record the short/long/slash numbers in the [Measured flush latency](command-injection-measurements.md#measured-flush-latency) table. The bar is the 4000ms delivery budget (five 400ms windows plus the 2000ms grace, from the first Enter), applied to the WORST observation.

**2. Prove the adapter's own verifier in the app.** Create a task with `agent_override` set to that agent, move it into a column carrying an `auto_command`, and read the task's `auto_command_state` back out of the project DB. Expect `confirmed`. With the real CLI installed that is the whole of it, and it costs one ordinary turn.

To force the negative case, or to avoid spending a turn at all, point `agent.cliPaths.<agent>` at a mock CLI that writes a real-shaped record into that agent's real history location, then run the same move twice - once with the record write on, once off. One caveat if you write a mock: read the working directory off the CLI's own argument rather than `process.cwd()`. Codex records the `-C` value, and getting that wrong silently writes to the wrong slug and looks like a verifier bug.

   - Record write on: expect `confirmed`.
   - Record write off: a confirm-only adapter must land on `failed` with the session still alive; an escalating one must land on `escalated` with a restart.

**3. Add a real capture, if the adapter has none.** Sanitize one of that agent's own history files into `tests/fixtures/` and extend `tests/unit/command-injection-real-capture-extractors.test.ts`. This is what proves the CLI does not wrap or decorate the stored text, and it is the cheapest single contribution for Copilot or OpenCode.

**4. Flip the flag and say why.** Drop that adapter's `canEscalateOnVerificationFailure` override, update its row in the matrix above and its entry in `agent-submission-verifier-shape.test.ts`, and record what you ran. **Do not drop the override because the parser tests pass** - the parser was never the risky part. Dropping it lets an adapter escalate only if its `resumePromptDelivery` is `command-line`; a `typed` or `no-resume` one (Copilot, Grok, OpenCode, Cursor, Aider, Ollama, Warp) still stops at `failed`.

Any subset of this is worth a PR. Step 1 alone puts numbers in the table; step 3 alone strengthens an adapter without touching its tier. And if an adapter simply misbehaves for you, the useful bug report is the agent, the task's `auto_command_state`, and whether the session was local or remote.

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

View conversation does read this file. It drops the leading `<timestamp>` tag, unwraps `<user_query>`, and unwraps a body that is one `<task>` element. Entries carry no clock (`ts: 0`). That is a reader, not a verifier: a confirm still needs a time bound and a match against the text that was submitted, and neither of those is settled.

Droid is different: it WAS measured, on an authenticated session, and failed on variance rather than on being unmeasurable. Do not re-litigate it without new numbers.

The harness distinguishes these cases automatically. It detects a CLI parked on a login or device-code prompt and reports `unmeasurable-here` rather than a measured "no" - without that check, Droid drew a confident `stop` verdict while it was actually sitting on a Factory login screen, which is a fabricated measurement.

### Codex declines slash commands specifically

Codex handles slash input in the TUI. A probe of `/kng-probe-<nonce>` printed `Unrecognized command` and produced no record at all, so absence from the rollout file cannot distinguish:

- the CLI **rejected** it (nothing ran), from
- the CLI **ran it client-side** (`/status`, `/compact`) and simply never made it a conversation turn.

Treating the second as a failure would escalate a command that actually worked into a session restart. So `CodexAdapter.canVerifySlashSubmission()` returns `false`, and `prepareInjectionPlan` tags a slash `auto_command` `verify: 'none'` for it - neither retried nor escalated, outcome `unconfirmed`. Prose auto_commands on Codex are still fully verified. This is a declared capability rather than an agent-name check, per `agent-adapters-boundary`.

Antigravity declares the same `false` for the same measured reason: its slash probe printed `Unknown command` in the TUI and appended nothing to the brain-dir transcript, so absence there is equally ambiguous. Prose auto_commands on Antigravity remain fully verified.

When an adapter returns `null`, the caller falls back to:
- `'paste'`: activity event or any post-`\r` data byte (within 3s).
- `'command-injection'`: the handshake chain alone, with an outcome of `unconfirmed`.

An adapter with no verifier cannot reach 100% delivery: with no confirmation signal there is nothing to retry against, and no failure to escalate. Measured on the load rig it reaches ~93% against Claude's 100%, and its safety property still holds absolutely (a delivery may be missed, but a wrong one is never submitted). An adapter closes that gap by implementing `'command-injection'` verification once measurement shows its CLI flushes history on submit.

## Delivery modes

A column declares WHEN its message fires, via the `mode` field on its **Send message to agent**
automation. That used to be `Swimlane.auto_command_mode`, a per-column field; the message is an
automation now (see [Column automations](../../settings/cascade.md#column-automations)), so the choice
belongs to the row that supplies the text. The two values and their meanings are unchanged:

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
