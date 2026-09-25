---
paths:
  - "src/main/pty/**"
  - "src/main/ipc/**"
  - "src/main/transition-engine/**"
  - "src/main/agent/**"
---
# Rule: a young agent is never force-killed without its exit sequence and the grace

Claude Code keeps a boot canary in `~/.claude.json`: `fullscreenBootPending[pid]` is written at
REPL mount and withdrawn 10 s after the first rendered frame, or on a graceful exit (`/exit`,
Ctrl+C, Ctrl+D). A record whose pid is dead at the next launch is a strike. One strike runs that
launch on the classic renderer and prints "fullscreen renderer didn't finish starting last time";
two make the classic renderer sticky on the machine until `/tui fullscreen` or a Claude update.
Kangentic injects `tui: fullscreen` for every user without a `/tui` choice, so a strike silently
brings back the scrollback duplication fullscreen was adopted to fix.

A bare `pty.kill()` is ClosePseudoConsole on Windows. Claude gets about 100 ms, and the locked
withdrawal of the record (a 1.4 MB read, parse, rewrite under `~/.claude.json.lock`) lands at
82 to 97 ms on an idle machine, so load or a sibling Claude holding the lock leaves the record
behind. This shipped: a Command Terminal stopped inside its first seconds, and every later launch
on the dogfooding machine printed the fallback line. The 1500 ms `suspend()` already gave every
session is what `kill()` now gives a young one.

## The rule

- **Every force-kill of a session PTY goes through `SessionManager.kill()`, `suspend()`, or
  `killAll()`.** `kill()` writes the adapter's exit sequence and parks the PTY on
  `DeferredKillRegistry` (`src/main/pty/lifecycle/deferred-kill.ts`) for `KILL_GRACE_MS` when
  `isYoungSession` says the agent may still be inside the canary window (alt-screen entered under
  12 s ago, or no alt screen yet and spawned under 60 s ago); a mature session is killed at once.
  `session.pty` is nulled synchronously either way, so a deferred PTY lives outside the registry
  row and no respawn or reset can cut its grace short. Do not add a direct `pty.kill()` /
  `safeKillPty()` on a session PTY anywhere else, and do not add a caller that knows better
  without the `immediate` option and a reason (the agent-absence sweep is the one that exists:
  its agent is already gone, and it stamps `exited` at once).
- **A caller that touches the session's cwd or process tree after a kill waits for the process,
  not for the call.** `kill(id)`, then capture `awaitExit(id)`, THEN `remove(id)` (the row must
  still exist when the promise is made), then await it before any `rmSync`, `removeWorktree`, or
  `reapSessionLeftovers`. Kill every session first and `Promise.all` the waits, so N young
  sessions cost one grace. Never await the exit inside the per-project worktree queue.
- **The quit path defers only where the drain follows.** `killAll({ allowGrace: true })` is
  passed only from `before-quit` (unless a Windows session-end disarmed the drain) and the
  powerMonitor shutdown; a signal handler or session-end calls it bare and gets the instant kill
  plus a flush of every parked PTY. The report's `deferredCount` extends the drain's deadline by
  the grace; at 1500 ms each, an unextended deadline would fire as the deferred kill lands.
  `SessionManager.dispose()` never touches the registry: it runs one statement after `killAll()`.
- **A short-lived probe PTY runs Claude on the classic renderer**
  (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, which never arms the canary) and exits it with
  `/exit`, waiting on the PTY's own `onExit` before the fallback kill. The model picker probe is
  the one that exists.
- **Every Kangentic read-modify-write of `~/.claude.json` runs under `withClaudeJsonLock`**
  (`src/main/agent/adapters/claude/claude-json-lock.ts`), which takes Claude's own
  `~/.claude.json.lock` as well as the in-process chain, and reads inside it. A write that
  straddles Claude's locked withdrawal of the record resurrects it. On a final `ELOCKED` the
  writer skips, as Claude does.

## Enforcement (self-maintaining)

- **Test (static scan):** `tests/unit/pty-teardown-grace.test.ts` scans `src/main/**` and fails
  on a `safeKillPty(` call, or a `.kill()` call in a file that imports `node-pty`, outside the
  allowlisted teardown modules; and on a `~/.claude.json` writer under `adapters/claude/` that
  does not go through `withClaudeJsonLock`. Runs in CI via `npm run test:unit`.
- **Tests (behavior):** `tests/unit/deferred-kill.test.ts` pins `isYoungSession`'s two bounds and
  the registry's timer, cancel, and flush; `tests/unit/session-manager-deferred-kill.test.ts`
  pins `kill()`'s exit sequence, the synchronous `session.pty = null`, the deferred force-kill,
  the cancel on a natural exit, the `immediate` option, and `killAll`'s report;
  `tests/unit/session-shutdown-flow.test.ts` pins the quit-path deferral and flush;
  `tests/unit/pty-exit-callback-drain.test.ts` pins the deadline extension;
  `tests/unit/claude-model-picker-probe.test.ts` pins the probe's env and graceful exit;
  `tests/unit/claude-json-lock.test.ts` pins the file lock's acquire, wait, stale break, and
  ELOCKED skip.
- **Review:** the `awaitExit` ordering is control flow the scan cannot see; `/code-review` flags a
  kill followed by filesystem work with no exit barrier.

## Scope

Session PTY teardown in the main process (`src/main/pty/**` and its callers under `src/main/ipc/**`,
`src/main/transition-engine/**`, `src/main/agent/**`), the Claude adapter's probe PTY, and the
Claude adapter's `~/.claude.json` writers. The respawn sibling drain in `session-spawn-flow.ts`
keeps its direct kill: it only ever finds a row whose `pty` is already null, since every kill path
nulls it first. Not covered: a dev restart that terminates Electron without `before-quit`, which no
app-side code can reach.
