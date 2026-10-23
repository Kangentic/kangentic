---
type: Design
title: Command injection measurements
description: Why a verifier must be measured before it is written, the paired short and long turn trial in measure-injection-flush.mjs, and the live flush latency per agent (Claude, Codex, Qwen, Cursor, Gemini, Droid) against the 4000 ms delivery budget, with each verdict.
tags: [command-injection, measurements, latency, verifier]
sources:
  - resource: scripts/measure-injection-flush.mjs
---
# Command injection measurements

## Why a verifier must be measured before it is written

A verifier is what AUTHORIZES escalation, and escalation restarts the session with the command as an argv prompt. That makes the two failure modes wildly asymmetric:

- **No verifier** - the outcome is `unconfirmed`, escalation never fires, and nothing destructive happens.
- **A too-slow verifier** - a false `failed` escalates, and the restart **destroys live work.**

So a wrong verifier is worse than no verifier, and `getSubmissionVerifier` returning `null` is a declared answer (pinned per adapter in `tests/unit/agent-submission-verifier-shape.test.ts`), not an omission.

Measurement is the gate on WRITING a verifier. It is not on its own the gate on letting one escalate: see [Why escalation takes two proofs](command-injection-support-matrix.md#why-escalation-takes-two-proofs-and-measurement-is-only-the-first).

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
| Claude (control, 2026-09-18, 2.1.276, haiku) | 895ms, 888ms | 871ms, 1032ms (9.4s, 9.3s) | **1032ms** | yes (930ms, 914ms) | **implement** |
| Droid | 3202ms, 941ms | 661ms, 636ms (4.5s, 9.9s) | **3202ms** | yes (580ms, 564ms) | **stop** |
| Cursor | login-gated | 5766ms, 5446ms (5.8s, 5.4s) | **5766ms** | yes (2614ms) | **stop** |
| Gemini | 5504ms, never (>25s) | never (>25s), 6302ms (16.9s) | **>25s** | not reached | **stop** |
| Grok Build | 313ms, 32ms (2.1s, ~4s turns) | (not yet paired-long measured) | **313ms** | n/a (slash never recorded, by design) | **implement (confirm-only)** |
| Antigravity (2026-08-16, agy 1.1.13, 1 trial) | 84ms | 74ms (4.1s) | **84ms** | never recorded (rejected client-side: "Unknown command") | **implement** |

Grok's two numbers come from `scripts/probe-grok.js`'s interactive PTY leg (2026-08-16, grok
1.0.0, Windows) rather than `measure-injection-flush.mjs` - a typed submit polled against
`chat_history.jsonl` at 25ms cadence. Both landed well inside the single-attempt 400ms window
and far below the turn end, which is the flush-on-submit signature; the formal paired
short/long trial has not been run, which (together with the missing in-app proof and the
records carrying no timestamps) is why its verifier ships confirm-only rather than verified.

**The bar is the delivery BUDGET, not a margin.** `submitKeystrokes` retries up to 5 times polling 400ms each and then polls a further 2000ms without pressing, so a submission has ~4000ms to become visible before the outcome is `failed`, all of it measured from the FIRST Enter. Two earlier attempts to hold reserve (1000ms, then 1500ms) both failed the CLAUDE CONTROL - the reference implementation whose verifier ships and works. Any bar that rejects the known-good adapter is measuring the wrong thing. (The budget was 2000ms until #682, and the watermark advanced on every retry, which meant the second half of that budget could never confirm an entry stamped in the first half; the control's slow mode alone consumed 1876ms of it.)

**Run the control after touching the harness.** Claude's 2026-08-08 numbers were bimodal (775/791/779ms or 1812/1828/1876ms, nothing between - a periodic flush caught either side of its interval), which is also why "typical" latency is meaningless here and only the upper mode matters. The 2026-09-18 re-run on 2.1.276 (haiku, a trusted scratch directory no session was using) read 871 to 1032ms on all six trials, one mode this time and uncorrelated with turn length. A same-day run from inside the live checkout read 323 to 373ms with a 1401ms outlier and is discarded: its probes shared this session's `~/.claude/projects/<slug>/` directory, and a run whose numbers a neighbour can move in either direction measures nothing. The 4000ms delivery budget covers the clean worst about four times over, and with the fixed first-Enter watermark a 900 to 1000ms flush confirms on attempt 3 (Enter at 800ms, window to 1200ms). If `--agent claude` does not pass, the instrument is broken and no other verdict from it can be trusted.

**The harness needs a trusted workspace on current Claude Code.** A fresh temp directory raises the workspace trust dialog, and since 2.1.x the dialog parks its cursor on "No, exit"; `maybeAnswerPrompt` now reads the selected row off the frame and moves it before confirming, and answering restarts the ready-quiet window so the probe is never typed into the dialog. Accepting trust for a brand-new directory was still observed to redraw the dialog and end the CLI when the harness ran inside another Claude Code session, so `--workspace <dir>` runs every probe in a directory the CLI already trusts. Do not point it at a directory a live agent session is running in: the probe's transcripts then share that session's `~/.claude/projects/<slug>/` directory, which is how the 1401ms outlier above was produced. Trust a scratch directory once from an interactive `claude` and reuse it. Model the run with `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` to keep the control cheap.

**Cursor is the clearest turn-end flush after Gemini.** Its appends landed 40ms and 42ms either side of the turn ENDING - not correlated with turn length, essentially identical to it. Its first two probes were also login-gated (the harness's auth-gate detector did not recognise Cursor's wording, since phrase matching lags vendors), but that contamination changes nothing: the trials that DID land are disqualifying on their own, 5.4 to 5.8 seconds against a 4000ms budget.

OpenCode is measured through a read-only SQL query rather than a file scan, because a SQLite page is not observable as text. Getting that number took three runs and exposed a harness bug worth recording: some TUIs drop the first characters of typed input while they finish becoming interactive (OpenCode ate between 6 and 40 of them), which destroyed a front-anchored nonce and read as "never landed". The probe marker now sits at the END of the prompt and the harness settles before typing. Production does not hit this - `submitKeystrokes` runs its own Ctrl+U handshake and settle first - but any future probe must keep the marker trailing.

That contamination only ever produced false NEGATIVES, and it does not touch the verdicts above: Gemini and Droid failed on the latency of trials that DID land (5504ms/6302ms and 3202ms respectively), and every Codex and Qwen trial landed with an exact match.

Codex's append latency is flat against a turn 70x longer, which is what proves the write happens on submit. A read-only pre-screen agreed before any quota was spent: of 114 rollout files on a real machine, five ended in a TORN JSON line and one ended mid-turn on `exec_command_end` - only possible if the process died mid-append, which rules out a turn-end buffer.

Gemini is the case the gate exists for. It writes on message completion (its own parser says so), so two of four probes never landed within 25 seconds. A verifier built on it by analogy with Codex would have reported `failed` on healthy sessions and escalated them into restarts.

A note for anyone re-running this: Droid's numbers below are exactly as measured, but the verdict was corrected by hand afterwards. The saved report from that run records `implement`, because the gate itself had the bug described below and was fixed after the run. The measurement did not change; only the rule applied to it did. A fresh run on the current harness reports `stop`.

Droid fails for a different and more instructive reason: it is not turn-end flushed at all (its LONG turns appended fastest, at ~640ms), it is simply **unreliable** - 564ms at best and 3202ms at worst, with no relation to turn length. 3202ms exceeded the whole 2000ms budget that applied when it was measured, so those submissions were reported `failed` while the agent was working normally. The budget has been 4000ms since the fixed watermark and the grace landed, which would put that one trial inside it with under 800ms to spare; two trials on a 2026-08 build are not a re-measurement, so the verdict stands until the harness is re-run against a current Droid. This is why the bar is the WORST observation rather than the mean, and why the harness gates on every trial rather than only the long-turn ones: an earlier revision checked only the long runs and returned "implement" for Droid while printing a 3202ms worst case.

Qwen passes but with far less margin than Codex, and lands ABOVE the 400ms single-attempt window, so it typically confirms on the second Enter attempt. That is well inside the 4000ms budget, but it means any future tightening of `VERIFY_WINDOW_MS` puts Qwen at risk first.
