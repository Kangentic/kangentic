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

That 100 ms was measured on Claude Code 2.1.268. Remeasured on 2.1.294 (Windows 11 build 26200,
node-pty 1.1.0, a mature idle session): closing the console made Claude run its SessionEnd hook
(reason `other`) and exit 585 ms later with its transcript whole, as `/exit` does (hook at 191 ms,
exit at 622 ms). The grace stays: the young-session case was not remeasured, and an older Claude
still gets the 100 ms.

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
  its agent is already gone, and it stamps `exited` at once). The PTY itself lives in the pty host
  ([[pty-host-out-of-process]]): `session.pty` is a `RemotePty` handle, a kill is a command the
  host carries out, and the grace timer stays on main. The host's own `kill` handling is the one
  allowlisted `.kill()` in `pty-host-core.ts`, and its `shutdown` kills nothing, so a parked
  PTY's grace is never cut short there.
- **An agent whose shell exited on its own is asked to exit before anything is terminated
  (Windows).** node-pty never closes the pseudoconsole after a natural exit (microsoft/node-pty#965),
  so the agent the shell started keeps running with no session. The pty host ends it in
  `host/dead-root-orphans.ts`: it writes the session's exit sequence into the dead shell's
  still-open console input (`spawn/exited-console-input.ts`, the one channel that reaches it),
  waits up to `DEAD_ROOT_ORPHAN_EXIT_GRACE_MS` (10 s) for the processes it found to exit by
  themselves, and only then terminates what is left, by identity, each through a handle whose
  creation time is re-checked. Measured on Claude Code 2.1.294: asked this way, Claude ran its
  SessionEnd hook and exited about 600 ms after the write with its transcript whole; terminated,
  it runs no SessionEnd hook and writes no exit records. `IPty.write()` after the exit, `kill()`
  after the exit, and terminating the console host all leave it running, so none of them can
  replace the ask. Do not shorten the grace below Claude's SessionEnd budget (1.5 s by default,
  raised by a hook's own timeout). It runs in the utility host only (never the in-process core,
  whose fake PTYs carry real-looking pids), and never after a kill the host was sent, during a
  quit, or for a WSL root.
- **A caller that touches the session's cwd or process tree after a kill waits for the process,
  not for the call.** `kill(id)`, then capture `awaitExit(id)`, THEN `remove(id)` (the row must
  still exist when the promise is made), then await it before any `rmSync`, `removeWorktree`, or
  `reapTaskLeftovers`. That reap force-kills the task's tagged processes in its directories, so it also waits
  for `removeByTaskId` to settle; the pty host protecting any PTY it still holds is the second
  line, not the first. The reap also waits on its own for a PTY of its tasks still parked on the
  deferred kill (`DeferredKillRegistry.sessionsAwaitingExit`, bounded by the grace plus 1500 ms):
  a Done move right after a young session was stopped finds no PTY for `suspend()` to wait on,
  and the host would protect the still-running agent and its children. Kill every session first
  and `Promise.all` the waits, so N young sessions cost one grace. Never await the exit inside the
  per-project worktree queue.
- **The quit path defers only where the drain follows.** `killAll({ allowGrace: true })` is
  passed only from `before-quit` (unless a Windows session-end disarmed the drain) and the
  powerMonitor shutdown; a signal handler or session-end calls it bare and gets the instant kill
  plus a flush of every parked PTY. The report's `deferredCount` extends the drain's deadline by
  the grace; at 1500 ms each, an unextended deadline would fire as the deferred kill lands.
  `SessionManager.dispose()` never touches the registry: it runs one statement after `killAll()`.
- **A short-lived probe PTY runs Claude on the classic renderer**
  (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, which never arms the canary) and exits it with
  `/exit`, waiting on the PTY's own `onExit` before the fallback kill. The model picker probe is
  the one that exists. It writes Esc and `/exit` only after its own `/model` was submitted, and
  not when a dialog replaced the picker. A dialog takes typed keys as its answer, so a run that
  never got `/model` into the input box, or whose Enter opened a dialog, ends on the plain kill,
  which the classic renderer makes safe.
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
  `tests/unit/claude-model-picker-probe.test.ts` pins the probe's env, its graceful exit, and its
  no-key-into-a-dialog guards;
  `tests/unit/claude-json-lock.test.ts` pins the file lock's acquire, wait, stale break, and
  ELOCKED skip. `tests/unit/dead-root-orphans.test.ts` pins the orphan cleanup's identity window,
  that it asks before it terminates and terminates nothing that exits within the grace, and that a
  kill, a quit, a WSL root, POSIX and the in-process core never run it;
  `tests/unit/exited-console-input.test.ts` pins the node-pty fields the ask writes through.
- **Review:** the `awaitExit` ordering is control flow the scan cannot see; `/code-review` flags a
  kill followed by filesystem work with no exit barrier.

## Scope

Session PTY teardown in the main process (`src/main/pty/**` and its callers under `src/main/ipc/**`,
`src/main/transition-engine/**`, `src/main/agent/**`), the Claude adapter's probe PTY, and the
Claude adapter's `~/.claude.json` writers. The respawn sibling drain in `session-spawn-flow.ts`
keeps its direct kill: it only ever finds a row whose `pty` is already null, since every kill path
nulls it first. Two more direct kills in that file kill with no grace for one reason: a spawn
abandoned because a teardown overtook its host round trip (`abandonCancelledSpawn`), and one
overtaken by the quit. The host started that PTY one round trip ago, before the agent reaches its
boot canary. Not covered: a dev restart that terminates Electron without `before-quit`, which no
app-side code can reach.
