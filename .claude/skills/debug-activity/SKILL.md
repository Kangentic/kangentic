---
description: Diagnose activity-engine issues - a task shows active or idle wrongly, the board indicator is stuck, false thinking or false idle, activity engine debugging playbook
---

# Debug Activity

A playbook for diagnosing why a task's board indicator shows the wrong state (active/thinking when it should be idle, idle when work is still running, or stuck). Reference this skill when investigating activity-engine behavior so the diagnostic method and known failure signatures are already in context.

`docs/activity-detection.md` is the authoritative architecture reference: read the relevant section instead of re-deriving behavior from the symptom. `src/main/activity-engine/README.md` is the code-reader quick ref.

**Route the symptom first.** If the engine state is correct but a renderer surface *buckets* it wrong (sidebar active/idle counts, card-pill grouping), that is a classification bug, not an engine bug: route through `.claude/rules/activity-state-classification.md` and the `requiresUserInteraction` / `isActive` helpers in `src/shared/activity-state.ts`, not this playbook. This skill is for the engine's own state being wrong.

## Working rules

The activity engine is core/critical. These constraints are not optional:

- **Empirical evidence before any fix.** Reproduce the symptom against a real captured `events.jsonl` (via `kangentic_get_session_events` or a session dir). Never reason from the board symptom alone.
- **Decide "bug vs designed behavior" explicitly before proposing a change.** Some surprising states are correct by design: in task #216 Incident A the board stayed active while Claude was parked at its prompt, because a backgrounded test shell was genuinely alive. That is the intended behavior, not the defect.
- **Minimal fixes only.** Do not refactor the engine to fix one signature.
- **Every confirmed bug gets a pinned replay fixture** in `tests/fixtures/replay/`, run by the harness below.
- **Red-green.** Prove the new fixture fails with the fix disabled before claiming the fix works.

## The predicate in one line

```
thinking IFF (turnActive OR subagentDepth > 0 OR bgShells > 0) AND NOT permissionPending
```

`src/main/activity-engine/engine/predicate.ts` (`derivePredicate`); `bgShells` = named (`activeBackgroundShellIds`) + anonymous (`anonymousBackgroundShellCount`). `permissionPending` forces `permission`. Every wrong indicator is one of two things: a predicate input is wrong (a counter stuck high or cleared early), or a watchdog / forced transition overrode the predicate. Triage is identifying which.

## Evidence-gathering ladder

Work this order. Each step narrows to a single session, then to a single transition.

1. **Resolve task to session.** `kangentic_find_task` (by `#N`, branch, or title) then `kangentic_list_sessions` for the task. A task can have several sessions; note the `sessionIndex` you want.
2. **Read the event stream.** `kangentic_get_session_events` (params: `taskId` | `sessionId`, `sessionIndex`, `tail` 1-2000 default 200, `since` epoch ms, `eventTypes` filter). Filter to the relevant types, e.g. `background_shell_start` / `background_shell_end`, `subagent_start` / `subagent_stop`, `idle`, `prompt`.
3. **Read live engine state.** `kangentic_devtools_engine_state` scoped to ONE `sessionId` (the unscoped dump is huge). The payload is `recentTransitions` (ring of 50) and `compensationCounters`; `recentPtyChunks` is noise for most investigations.
4. **Supporting context.** `kangentic_get_session_files` for the on-disk paths, `kangentic_tail_logs` for main-process logs, `kangentic_get_transcript` for what the agent was actually doing.

**Timeline trick:** clipboard screenshots paste with an epoch-ms filename (`pasted-image-<epochMs>.png`). Use that timestamp to place the user's "it was wrong at this moment" observation on the event stream, and feed it to `since`.

**Incident dirs are ephemeral.** A live session's raw files live in the MAIN checkout at `.kangentic/sessions/<id>/` (gitignored). They are gone once the session is cleaned up. The durable record is the committed replay fixtures (see below).

## Reading a transition trace

The trigger-label and counter-delta reference is in `docs/activity-detection.md`, section "Reading a transition trace". Interpretation that is playbook, not reference:

- **All six compensation counters read 0 in a clean session.** Any non-zero counter names the silent recovery path that fired (`bgShellHatch`, `staleThinking`, `stuckPendingTools`, `forceThinking`, `forceIdle`, `unmatchedBgShellEnd`) - start there.
- **In a bg-shell incident, the first thing to check is the end-label variant:** `event:bg-shell-ended:<shellId>` is a Tier A PID-exit drain (the watcher saw the OS process leave), while `event:bg-shell-ended:watcher` is the anonymous count-heuristic drain. A named shell that vanished via the cap rather than a PID exit is the #216 signature.
- The counter-delta string on each transition shows what shifted: `prompt` carries `turn yes`, `idle` carries `turn no`, tool/shell changes show signed deltas (`tools +1`, `bg -1`).

## Watchdog timing math

A watchdog fire time is `anchor + threshold + 400ms stability window`. The anchor differs per hold:

- **Both bg-shell holds** anchor on `bgShellHoldSince` (set when bg shells become the sole holder; refreshed ONLY by `markBackgroundShellsAlive`, never by signal-only keep-alives).
- **Stale-thinking** anchors on `max(lastSignalAt, lastPtyOutputAt)` (streaming PTY output defers it; a finished turn sits at a quiet prompt with no PTY data, so the safety net still fires) - EXCEPT while the agent is believed parked (`idleHintPending`, `turnForcedByHeartbeat`, OR `retryFailurePending`), where it narrows to `lastSignalAt` alone so parked-TUI PTY repaints stop deferring it (see #294/#364/#367 below).
- **Stuck-pending-tools** anchors on `max(lastSignalAt, lastPtyOutputAt)` (streaming foreground output keeps it alive).

Point at `src/main/activity-engine/engine/watchdog.ts` (the `buildWatchdogHolds` table) and `engine/shapes.ts` (the `DEFAULT_*` threshold constants) for live values. Do NOT copy the numbers into the diagnosis - they drift.

## Known failure signatures

**PID-capture starvation -> false idle on a live named shell** (task #216). A backgrounded E2E suite (named shell) never gets a Tier A OS PID, so the watcher cannot confirm it alive; the named sole-holder cap fires via `timer:stability` with `bgShellHatch: 1` while the suite is still running. Provenance: Incident A = task #213 session `f03f5e43-2411-42a0-b511-702453e4b27f`, shell `b9wh3dhov`, capped ~42s before the suite finished. Incident B = task #215 session `e3b001cc-1c49-4828-9b21-48e8578cc37a`, shell `bikrml4pf`. The contrast that proves capture is the variable: in the SAME #215 session, shells `bp7mkduzr` / `b0n5h2qf8` / `bcs8obf77` got Tier A PIDs and drained cleanly via `event:bg-shell-ended:<id>`. Capture fails under process churn (`PID_CAPTURE_RETRY_CYCLES = 3`; the unambiguous tree-diff needs exactly one pending id AND one candidate). No committed fixture yet (defect open under #216); fixing it must add one.

**Inverse: false ACTIVE up to the cap.** A PID-less named shell that dies with a lost `background_shell_end` hook is never count-drained (the watcher's deficit branch deliberately refuses named drains), so the task holds active until the 5-min named cap. Any fix for the above must not regress this direction.

**Double-start / promotion (misread as two shells).** `PreToolUse` emits `background_shell_start` with the command string as detail (anonymous); `PostToolUse` re-emits with the assigned shell id. The engine treats the second as a *promotion* (one anonymous slot becomes one named slot, count constant). Reading the trace as two separate shells is a misdiagnosis.

**Zombie distortion of the Tier B count.** Leaked app-under-test processes (a crashed Playwright worker that never closed its Electron instance) keep `shellLikeCount` desynced from expected, starving the count heuristic. Cleanup is tracked under task #218; an engine fix must work in their presence.

**Resume adoption.** After a Kangentic restart mid-session, `event:bg-shells-adopted` reflects descendants adopted as anonymous shells; they drain via the watcher as they exit. Expected, not a leak.

**Resume-picker CLI-internal turn -> false ACTIVE pinned forever** (task #331). A session spawned with `--resume` runs its resume-picker context-reload turn, a CLI-INTERNAL turn that fires NO turn hooks (`events.jsonl` has only `session_start` `source=resume`, then nothing until the next real prompt). While the reload summary generates, `status.json` output grows and the heartbeat correctly force-thinks. Then the reload finishes and Claude parks with no `Stop`/`idle_hint`, so nothing clears `turnActive`. The parked-TUI statusline keeps rewriting `status.json`; each write with growing-OR-frozen output used to pass the keep-warm gate (`thinking && !idleHintPending`) and refresh `lastSignalAt`, starving the 180s stale-thinking watchdog - the card pins ACTIVE until the next prompt. The `#294` idle-hint gate cannot help (no `idle_hint` ever arrives). Fix: gate keep-warm on OUTPUT-token GROWTH so frozen-output churn stops re-warming and the net self-heals. Provenance: session `de06e459`, output frozen at 1144 across the parked window, 252.7s PTY-quiet gap. Pinned by `session-021-false-active-resume-picker/`.

**Resume-picker, chatty parked TUI -> false ACTIVE pinned INDEFINITELY** (task #364, the residual leg #331 left open). Same resume-picker setup as #331, but if the parked-TUI statusline repaints never leave a gap over 180s, `#331`'s growth-gated keep-warm freezes `lastSignalAt` correctly, yet the stale-thinking hold's `signal-or-pty-output` anchor still reads `max(lastSignalAt, lastPtyOutputAt)` - and the continuous repaints keep `lastPtyOutputAt` fresh forever, so the net NEVER fires. Confirmed live: session `d1d25784` / task #290 self-healed only 180s after the LAST parked-TUI repaint (~4.5 min after output actually froze), not 180s after output froze, because the repaints happened to go quiet before the incident was noticed - a chattier TUI would never heal. Fix: record provenance on `turnActive` (`SessionEngineState.turnForcedByHeartbeat`, mirroring `idleAuthoritative`'s idle-side provenance), set only by the heartbeat's `forceThinking(sessionId, true)` and cleared by every real turn-initiating hook / turn-end / watchdog reset. The stale-thinking hold's narrow `signal` anchor (renamed `WatchdogHold.parkedAnchor`) now engages whenever `idleHintPending OR turnForcedByHeartbeat` - covering the hook-less resume turn that can never produce an `idle_hint`. Pinned by `session-022-false-active-repainting-past-180s/` (synthesized: continuous 10s-cadence PTY repaints for 300s, no idle_hint, no trailing turn).

**Transient server-error retry -> false IDLE mid-backoff** (task #367). Claude fires `StopFailure` not only for a terminal abort but also for a TRANSIENT, auto-retried error (529 overloaded / `server_error` / `rate_limit` / `api_error`); during the retry backoff the turn is still alive. Before the fix the engine treated every `StopFailure` as `turn_failed` and force-idled (the Interrupted bypass), so a task mid-retry showed a false "needs you" idle for the whole backoff window (no PTY output, no output-token growth). Fix: the Claude adapter classifies transient errors at the SOURCE into the generic `turn_retrying` event (`setTypeWhenDetailContains`, mirroring the `idle_hint` Notification precedent - the Claude-specific error strings live in the adapter, not the engine); the engine holds the session `thinking` (`applyRetryableFailureHold`, keeping `turnActive`) when the retry is genuinely live (`!idleHintPending && turnActive`), or idles immediately (`applyInterruptedBypass`, the terminal `turn_failed` path) when the turn had already wound down (`idleHintPending`) or ended (`!turnActive`). `turn_retrying` is NOT in `LOG_ONLY_EVENTS`, so each retry refreshes `lastSignalAt` and the 180s stale-thinking net fires ~180s after the LAST retry. A new provenance flag `retryFailurePending` joins the stale-thinking `believedParked` check so a parked-TUI "retrying in Ns..." repaint narrows the anchor to `signal` and cannot defer the net forever (the #294/#364 parked-repaint class). Empirical basis: kangentic.com Task #43 session `fc2f1446`, `idle` for ~166s during a live API retry. Pinned by `session-023-false-idle-server-error-retry.jsonl`.

Durable pins (committed fixtures, run by the harness): `session-009-phantom-bg-shell-no-end.jsonl` (#175), `session-012-auto-bg-named-shell-live.jsonl` (#212), `session-005-waiting-for-input-idle-hint.jsonl`, `session-006-ask-user-question-resume.jsonl`, `session-010-subagent-permission-resume.jsonl` (#194), and the directory (trace-bundle) fixtures `session-013-stuck-foreground-e2e/`, `session-020-false-active-parked-housekeeping/` (#294), `session-021-false-active-resume-picker/` (#331), and `session-022-false-active-repainting-past-180s/` (#364) - each has separate `events.jsonl`, `pty-chunks.jsonl`, `status-deltas.jsonl`, `meta.json`.

## Pinning and verifying a fix

- Harness (event-only fixtures): `tests/unit/activity-engine-replay.test.ts`. It replays each single-file `.jsonl` fixture with timing windows zeroed (`idleStabilityWindowMs: 0`, long stale timeout) for deterministic assertions on final activity, transition count, and compensation-counter flips. Use this when the bug is a pure event-sequence issue (bg shells, subagents, permission).
- Harness (trace-bundle fixtures): `tests/unit/activity-engine-trace-replay.test.ts`. It drives DIRECTORY bundles (`events.jsonl` + `status-deltas.jsonl` + `pty-chunks.jsonl` + `meta.json`) under PRODUCTION timing, advancing the clock by real inter-item gaps so the 180s watchdog and heartbeat-recovery actually fire. Use this when the bug needs status-token growth or PTY streaming to reproduce (stale-thinking, heartbeat force-think, keep-warm starvation). Its `applyStatusDelta` MIRRORS `SessionTelemetry.processStatusUpdate` inline - if you change the production heartbeat rule, update that mirror too.
- Sanitize any new fixture with `tests/fixtures/replay/_sanitize.mjs` before committing (the repo is public; strip personal paths). Use `tests/fixtures/replay/_inspect.mjs` to eyeball a fixture.
- Capture a portable fixture from a live incident via the dev-only trace recorder (`src/main/activity-engine/trace-recorder.ts`) or `kangentic_devtools_capture_trace`.
- Red-green: disable the fix, confirm the new fixture fails, re-enable, confirm green.

## Key source files

- `src/main/activity-engine/engine/predicate.ts` - the single predicate (`derivePredicate`, `deriveReasonForActivity`, `idleHintEndsTurn`).
- `src/main/activity-engine/engine/activity-engine.ts` - orchestration, transition recording, force-thinking/idle, bg-shell-end labels.
- `src/main/activity-engine/engine/event-handlers.ts` - per-event counter mutations and the permission flag.
- `src/main/activity-engine/engine/watchdog.ts` - the four watchdog holds, predicates, thresholds, anchors.
- `src/main/activity-engine/engine/shapes.ts` - core types, `TransitionTrigger`, `CompensationCounters`, `DEFAULT_*` constants.
- `src/main/activity-engine/engine/counter-snapshot.ts` - `formatCounterDelta` (the trace delta strings).
- `src/main/activity-engine/background-shell/watcher.ts` - Tier A PID capture / liveness, Tier B count heuristic, named-drain deficit branch.
- `src/main/activity-engine/session-telemetry.ts` - feeds events into the engine, Ctrl+C interrupt synthesis.
- `src/shared/activity-state.ts` - the idle-vs-active bucketing helpers (`requiresUserInteraction` / `isActive`) and the `ActivityDisposition` table; the `ActivityState` union itself lives in `src/shared/types.ts` (for classification questions; see `.claude/rules/activity-state-classification.md`).
