# Activity Detection Subsystem

This directory implements Kangentic's activity-detection engine. The full architecture is documented at [`docs/activity-detection.md`](../../../docs/activity-detection.md). This README is a quick reference for code-readers.

## Files

| File | Purpose |
|------|---------|
| `engine/activity-engine.ts` | The state machine. Single predicate + counter tracking + 400ms stability window + 180s stale-thinking watchdog + the bg-shell escape hatch (5-min cap once a shell is named, 30s grace while all are anonymous). |
| `engine/event-handlers.ts` | Pure event-to-counter mutations (`updateCounters`, `updatePermissionFlag`). |
| `engine/predicate.ts` | The predicate below, plus `idleHintEndsTurn` and the reason ladder. |
| `engine/watchdog.ts` | The five watchdog holds and their resets. |
| `engine/shapes.ts` | `SessionEngineState`, `ActivityStatsSnapshot`, and the tunable defaults. |
| `background-shell/watcher.ts` | Process-tree-based natural-exit detector. Polls every 2s when sessions have active bg shells. Two tiers: PID-aware + count-based heuristic. |
| `background-shell/process-tree.ts` | Cross-platform descendant enumeration (POSIX `ps`, Windows `Get-CimInstance Win32_Process`). |
| `session-telemetry.ts` | Per-session telemetry orchestrator. Wires engine + watcher + PTY tracker + accumulator + PR detector. Owns the per-session event cache, idle-timeout sweep, and agent-session-id capture. Routes parsed events from every telemetry source. |
| `usage-accumulator.ts` | Token / cost / per-tool stats. Pure transformations of parsed events. |
| `pr-command-detector.ts` | Detects `gh pr ...` Bash invocations so the orchestrator can scan scrollback for the printed PR URL on the matching ToolEnd. |
| `pty-activity-tracker.ts` | PTY-byte fallback for non-hook agents (Aider, Codex, etc.). |
| `activity-interval-recorder.ts` | Listens for the engine's disposition transitions (`activity`/`exit` events, both active and idle - symmetric, not idle-only) and durably records them - the engine's own state is in-memory only. |
| `activity-interval-store.ts` | DB access for the `session_activity_intervals` table (open/close/query). |

## Predicate (load-bearing)

```
'thinking'   IFF turnActive
              OR subagentDepth > 0
              OR (activeBackgroundShellIds.size + anonymousBackgroundShellCount) > 0
'permission' IFF permissionPending
'idle'       otherwise
```

`pendingToolCount` is intentionally NOT in the predicate. An explicit `Idle` event must transition to idle even if a PostToolUse hook never arrived.

`exemptBackgroundShellIds` is NOT in the predicate either, by construction. A background shell whose launching command carried `NO_ACTIVITY_HOLD_FLAG` (`src/shared/background-shell-hold.ts`) is tracked in that separate set instead, so it never appears in the sum above. Today's only caller is `/preview`'s exit watcher, which blocks for the preview's whole lifetime (hours) and would otherwise pin the task ACTIVE the entire time. Exempt shells stay fully tracked everywhere else: `session-telemetry.ts` sums BOTH sets for the process-tree watcher, so PID capture, liveness confirmation, and the `expected = preExistingHelpers + tracked` deficit math are unaffected and the shell drains normally on exit.

Because a separate set is invisible to the sum, exempting a shell also RE-ARMS the three watchdog holds that gate on `(size + anonymous) === 0` (stuck-pending-tools, stale-thinking, stuck-subagent). That is intended: an exempt shell must behave exactly as if it did not exist.

## Hierarchy of natural-exit detection

For background shells (the highest-stakes case), the engine has THREE mechanisms in priority order:

1. **Tier A: PID-aware exit (seconds)** - `BgShellWatcher` captures each named shell's real OS PID, either by adopting a PID memoized while its foreground tool ran (the auto-background path) or by an unambiguous 1:1 process-tree diff over the next few cycles. Once a shell has a PID, its disappearance from the tree is an attributable exit, and the watcher fires `background_shell_end` for that specific id.
2. **Tier B: process-tree count (seconds)** - `BgShellWatcher` polls every 2s. When the count of "shell-like" descendants drops below the snapshot taken at last `background_shell_start`, the watcher synthesizes a `background_shell_end`.
3. **Tier C: escape hatch** - final fallback. If the watcher couldn't run (probe failure) or the heuristic missed (e.g. a non-shell-like process spawned by the bg shell), the engine force-clears the counters: 5 minutes once any shell is named, 30 seconds while all are anonymous. Anchored to `bgShellHoldSince` and refreshed only by watcher-CONFIRMED liveness, so a signal-only keep-alive cannot defer it forever.

A fourth, agent-specific path complements these: the Claude adapter reads terminated background shells straight out of the durable session transcript (`background-shell-transcript.ts`), which catches exits the process tree could not attribute.

Empirical data: Tier B catches 95%+ of cases in production sessions.

## Cross-platform

The process-tree probe spawns a single OS query per cycle:
- Windows: `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ..."`
- POSIX: `ps -A -o pid=,ppid=,comm=`

Both have a 1.5s internal timeout. Probe failure degrades to the 5-min escape hatch.

## Kill switch

`KANGENTIC_BG_SHELL_WATCHER=0` disables the watcher entirely. Use only if process enumeration is causing problems (lockdown environments, sandboxed Windows installs, etc.).

## Tests

| Test file | Coverage |
|-----------|----------|
| `tests/unit/activity-engine.test.ts` | Engine state machine, transitions, predicate, counters, stability window, watchdog, escape hatch, force paths, permission state, currentTool stickiness, getStatsSnapshot, dispose() |
| `tests/unit/activity-engine-property.test.ts` | fast-check property tests: counters never negative, activity matches reason, dispose idempotent, multi-session isolation, repeated events deterministic |
| `tests/unit/activity-engine-replay.test.ts` | Replay sanitized production `events.jsonl` captures from `tests/fixtures/replay/`, assert expected end-state |
| `tests/unit/activity-engine-trace-replay.test.ts` | Replay directory-shaped captures (events + PTY chunks + status deltas) for timing-sensitive cases |
| `tests/unit/activity-stats-snapshot-parity.test.ts` | `ActivityStatsSnapshot`'s two copies (engine + IPC) must not drift |
| `tests/unit/no-activity-hold-sentinel-parity.test.ts` | The no-activity-hold flag's three hand-duplicated copies must not drift |
| `tests/unit/event-activity-derivation.test.ts` | Integration tests through real fs.watch + JSONL pipeline |
| `tests/unit/process-tree.test.ts` | Real-OS smoke tests (`isAlive`, `listDescendants`); `isShellLike` allowlist coverage |
| `tests/unit/bg-shell-watcher.test.ts` | Watcher with mock probe: Tier A/B, multi-session, lazy polling, dispose, root-died handling |
| `tests/e2e/background-shell-idle.spec.ts` | Full Electron + mock Claude CLI + real bg processes |

## When to read the full doc

Read [`docs/activity-detection.md`](../../../docs/activity-detection.md) before:
- Adding a new event type that affects activity (extend the engine's `TURN_INITIATING_EVENTS` / `LOG_ONLY_EVENTS` sets)
- Touching the watcher's polling cadence or the escape hatch latency
- Adding a new ActivityReason kind
- Debugging "stuck thinking" or "missed idle" reports (start with the Activity Engine Debug Overlay in Developer settings)
