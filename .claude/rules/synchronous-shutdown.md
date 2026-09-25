---
paths:
  - "src/main/index.ts"
  - "src/main/shutdown.ts"
  - "src/main/pty/shutdown/**"
---
# Rule: the `before-quit` shutdown path must be synchronous

Electron's `before-quit` handler must do only synchronous work. The previous approach
(`event.preventDefault()` + async shutdown + `process.exit()`) cancelled Electron's normal quit
flow: if the async chain stalled (network call, PTY wait, uncaught error), the main process
survived and every Chromium child process (GPU, utility, crashpad) became a zombie. On Windows
installed builds it also caused the app to auto-reopen.

## The rule

The `before-quit` handler in `src/main/index.ts`, and everything it calls, must be fully
synchronous.

1. Do all cleanup synchronously: mark DB session records `suspended`, kill PTYs, close DBs
   (better-sqlite3 is synchronous).
2. Do NOT call `event.preventDefault()`, with exactly one sanctioned exception: the bounded PTY
   exit-callback drain described below. Nothing else may hold the quit.
3. No network analytics at all from the quit path. Every route exits before the SDK's request
   can complete, so an event fired here never lands (`app_close` was fired on every quit and
   arrived on none). The quit path's only analytics is `recordRunExit('clean')`, a synchronous
   disk write the next launch reports on `app_launch` (`src/main/analytics/run-uptime.ts`).
   `tests/unit/before-quit-drain-wiring.test.ts` pins that `performShutdown` contains it and no
   `trackEvent(` or `trackHeartbeat(`.
4. Set a hard failsafe timer (`taskkill /T /F` on Windows, `SIGKILL` of the process group
   elsewhere) as a backstop.

This forfeits the 2-second graceful CLI exit window (`suspendAll`) for a MATURE session. Sessions
stay resumable because DB records are marked `suspended` before PTYs are killed, and
`--resume <id>` works from the saved session id. A YOUNG session (inside Claude Code's fullscreen
boot-canary window, see [[pty-teardown-grace]]) is the one exception, and it costs the quit no
`await`: `killAll({ allowGrace: true })` writes its exit sequence and parks its force-kill on the
deferred registry's 1500 ms timer, which fires INSIDE the drain below. The report's `deferredCount`
extends the drain deadline by that grace, so the quit is still held until the child is gone.
`allowGrace` is passed only where the drain follows; a Windows `session-end` and the signal
handlers call `performShutdown()` bare and flush every parked PTY at once.

## The one exception: the PTY exit-callback drain

`src/main/pty/shutdown/exit-callback-drain.ts`, wired by `createBeforeQuitHandler`
(`src/main/pty/shutdown/before-quit-handler.ts`). After the synchronous cleanup has killed the
PTYs, the handler calls `event.preventDefault()`, polls the killed children's pids every 25ms
until every one is gone plus 100ms of further loop turns (deadline 1500ms, plus the 1500ms kill
grace when the report says a young session's kill is deferred to a timer inside the drain), then
calls `app.quit()` again. The second `before-quit` pass is a no-op and Electron proceeds. With no
PTY killed, the quit is the plain synchronous one.

A killed PTY whose child pid was unreadable has no probe, so the drain spends a fixed 400ms blind
budget for it instead of waiting on liveness. `killAllSessions` therefore returns a `PtyKillReport`
(pids plus a total kill count) rather than a bare pid list: an empty pid list must never be read as
"no PTY was killed" when one was killed and simply could not be named. No production path produces
that today (node-pty sets `pid` synchronously at construction, and a failed spawn throws instead of
yielding a wrapper reading 0), so the count is a guard against a future one, not a live case.

Why it exists (Sentry DESKTOP-C, symbolicated against node-pty's shipped `conpty.pdb`): node-pty
delivers a PTY's exit through a native `Napi::ThreadSafeFunction`. When that callback is first
dispatched after `node::Stop()` (Electron's `PostMainMessageLoopRun` stops Node, then
`FreeEnvironment` runs the libuv loop once more to close handles), `napi_call_function` is
refused, node-addon-api throws a C++ `Napi::Error`, its catch block's `ThrowAsJavaScriptException`
is refused too, and a second C++ exception escapes from inside a catch block: the process dies
with an unhandled C++ exception. No JS frame is below that dispatch, so no try/catch can reach
it, and Kangentic ships node-pty's prebuilt binary, which lacks
`NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS`. VS Code has the same open crash on macOS
(microsoft/vscode#243952). Not killing the PTYs is not an option either: the same function's
finalizer joins the waiting thread, so an un-killed child hangs teardown until the hard failsafe.

Why it does not reintroduce the zombie problem: it is timer-only (`setTimeout` plus
`process.kill(pid, 0)`), never awaits network, PTY output, IPC, or DB work, is deadline-bounded,
re-enters through `app.quit()` (never `process.exit()`, so Electron's own teardown runs), runs
only when the cleanup actually killed a PTY, never runs after an OS shutdown the app cannot ask to
be delayed, and the hard failsafe is armed inside `performShutdown()` before the drain starts.

Which OS shutdowns those are is per platform, and each route must pick a side. Windows
`session-end` is documented by Electron as unpreventable ("once this event fires, there is no way
to prevent the session from ending"), so it sets `osShutdownCannotBeDelayed` and the drain is
skipped. The macOS/Linux powerMonitor `shutdown` event is documented as accepting
`preventDefault()` to ask the OS for time to exit cleanly, so that handler takes it, runs the flush,
and calls `app.quit()`; the `before-quit` that follows drains normally. Leaving that path disarmed
meant every macOS or Linux reboot with a live PTY killed the children and then raced node-pty's
exit callback against `node::Stop()`.

Every path that SKIPS the drain emits a breadcrumb (`[SHUTDOWN] pty-drain:skip reason=...`), so a
native crash report arriving with no `pty-drain:start` says why the drain did not run instead of
being unfalsifiable. The OS disarm reaches the handler as its own dependency rather than as an
empty pid list, precisely so its skip reason is distinguishable from "nothing was killed".

## Enforcement (self-maintaining)

- **Tests:** `tests/unit/task-move-shutdown.test.ts`, `shutdown-history-wiring.test.ts`, and
  `shutdown-leak-fixes.test.ts` cover early-exit guards, IPC error swallowing during shutdown,
  and closing connections before close to plug leaks. `tests/unit/pty-exit-callback-drain.test.ts`
  pins the drain's settle, deadline, and never-rejects contract;
  `tests/unit/before-quit-drain-wiring.test.ts` pins the handler state machine (hold once, re-quit
  once, pass the second time), the skip-reason breadcrumbs, the kill-report wiring, and scans
  `src/main/index.ts` for the `createBeforeQuitHandler` registration, the `app.quit()` re-entry, the
  absence of `process.exit` there, and the per-platform OS-shutdown pairing (Windows disarms and
  never calls `preventDefault`; powerMonitor calls `preventDefault` and never disarms);
  `tests/unit/session-shutdown-flow.test.ts` pins that `killAllSessions` returns a `PtyKillReport`
  counting every kill, including one whose child pid was unreadable;
  `tests/unit/shutdown-history-wiring.test.ts` pins that a throwing cleanup step still reaches the
  PTY kill, and walks `syncShutdownCleanup`'s pre-kill AST so a future step added without
  `runCleanupStep` fails rather than silently reopening that hole. It parses rather than
  line-matches because a multi-line call and a `const x = getY();` initializer both hide from a
  line scan. One bare call is allowed by name, the `sessionManager` read the kill itself needs:
  a throw there leaves nothing to kill with either way. All run in CI via `npm run test:unit`.
- **Contract:** the JSDoc in `src/main/shutdown.ts` and
  `src/main/pty/shutdown/session-shutdown.ts` restate the synchronous requirement at the call
  sites.

## Scope

The Electron quit path only. Normal runtime code may be async; this rule is specifically about
`before-quit` and the functions it invokes synchronously.
