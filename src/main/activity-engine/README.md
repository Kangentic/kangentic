# Activity Detection Subsystem

This directory implements Kangentic's activity-detection engine. The full architecture is documented at [`docs/activity-detection.md`](../../../docs/activity-detection.md). This README is a quick reference for code-readers.

## Files

| File | Purpose |
|------|---------|
| `activity-engine.ts` | The state machine. Single predicate + counter tracking + 400ms stability window + 45s stale-thinking watchdog + 5-min bg-shell escape hatch. |
| `bg-shell-watcher.ts` | Process-tree-based natural-exit detector. Polls every 2s when sessions have active bg shells. Two tiers: PID-aware + count-based heuristic. |
| `process-tree.ts` | Cross-platform descendant enumeration (POSIX `ps`, Windows `Get-CimInstance Win32_Process`). |
| `bg-shell-resume.ts` | Resume-time helper that adopts orphan bg shells when Kangentic restarts mid-session. |
| `session-telemetry.ts` | Per-session telemetry orchestrator. Wires engine + watcher + PTY tracker + accumulator + PR detector. Owns the per-session event cache, idle-timeout sweep, and agent-session-id capture. Routes parsed events from every telemetry source. |
| `usage-accumulator.ts` | Token / cost / per-tool stats. Pure transformations of parsed events. |
| `pr-command-detector.ts` | Detects `gh pr ...` Bash invocations so the orchestrator can scan scrollback for the printed PR URL on the matching ToolEnd. |
| `pty-activity-tracker.ts` | PTY-byte fallback for non-hook agents (Aider, Codex, etc.). |

## Predicate (load-bearing)

```
'thinking'   IFF turnActive
              OR subagentDepth > 0
              OR (activeBackgroundShellIds.size + anonymousBackgroundShellCount) > 0
'permission' IFF permissionPending
'idle'       otherwise
```

`pendingToolCount` is intentionally NOT in the predicate. An explicit `Idle` event must transition to idle even if a PostToolUse hook never arrived.

## Hierarchy of natural-exit detection

For background shells (the highest-stakes case), the engine has THREE mechanisms in priority order:

1. **Tier A: bash_id status (instant)** - when `BashOutput` PostToolUse reports `status: completed`, the engine removes that shell_id from the Set. Currently inert - depends on the empirical capture step (see plan).
2. **Tier B: process-tree count (seconds)** - `BgShellWatcher` polls every 2s. When the count of "shell-like" descendants drops below the snapshot taken at last `background_shell_start`, the watcher synthesizes a `background_shell_end`.
3. **Tier C: escape hatch (5 min)** - final fallback. If the watcher couldn't run (probe failure) or the heuristic missed (e.g. a non-shell-like process spawned by the bg shell), the engine force-clears the counters after 5 minutes of no signals.

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
| `tests/unit/activity-engine-replay.test.ts` | Replay 5 sanitized production `events.jsonl` files, assert expected end-state |
| `tests/unit/event-activity-derivation.test.ts` | Integration tests through real fs.watch + JSONL pipeline |
| `tests/unit/process-tree.test.ts` | Real-OS smoke tests (`isAlive`, `listDescendants`); `isShellLike` allowlist coverage |
| `tests/unit/bg-shell-watcher.test.ts` | Watcher with mock probe: Tier A/B, multi-session, lazy polling, dispose, root-died handling |
| `tests/unit/bg-shell-resume.test.ts` | Resume-time orphan adoption with mock probe |
| `tests/e2e/background-shell-idle.spec.ts` | Full Electron + mock Claude CLI + real bg processes |

## When to read the full doc

Read [`docs/activity-detection.md`](../../../docs/activity-detection.md) before:
- Adding a new event type that affects activity (extend the engine's `TURN_INITIATING_EVENTS` / `LOG_ONLY_EVENTS` sets)
- Touching the watcher's polling cadence or the escape hatch latency
- Adding a new ActivityReason kind
- Debugging "stuck thinking" or "missed idle" reports (start with the Activity Engine Debug Overlay in Developer settings)
