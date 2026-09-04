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
3. Fire-and-forget analytics. Never `await` a network call during shutdown.
4. Set a hard failsafe timer (`taskkill /T /F` on Windows, `SIGKILL` of the process group
   elsewhere) as a backstop.

This forfeits the 2-second graceful CLI exit window (`suspendAll`). Sessions stay resumable
because DB records are marked `suspended` before PTYs are killed, and `--resume <id>` works from
the saved session id.

## The one exception: the PTY exit-callback drain

`src/main/pty/shutdown/exit-callback-drain.ts`, wired by `createBeforeQuitHandler`
(`src/main/pty/shutdown/before-quit-handler.ts`). After the synchronous cleanup has killed the
PTYs, the handler calls `event.preventDefault()`, polls the killed children's pids every 25ms
until every one is gone plus 100ms of further loop turns (deadline 1500ms), then calls
`app.quit()` again. The second `before-quit` pass is a no-op and Electron proceeds. With no PTY
killed, the quit is the plain synchronous one.

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
only when the cleanup actually killed a PTY, never runs after an OS-initiated shutdown (Windows
`session-end`, powerMonitor `shutdown`), and the hard failsafe is armed inside `performShutdown()`
before the drain starts.

## Enforcement (self-maintaining)

- **Tests:** `tests/unit/task-move-shutdown.test.ts`, `shutdown-history-wiring.test.ts`, and
  `shutdown-leak-fixes.test.ts` cover early-exit guards, IPC error swallowing during shutdown,
  and closing connections before close to plug leaks. `tests/unit/pty-exit-callback-drain.test.ts`
  pins the drain's settle, deadline, and never-rejects contract;
  `tests/unit/before-quit-drain-wiring.test.ts` pins the handler state machine (hold once, re-quit
  once, pass the second time) and scans `src/main/index.ts` for the `createBeforeQuitHandler`
  registration, the `app.quit()` re-entry, the absence of `process.exit` there, and the
  OS-shutdown disarm; `tests/unit/session-shutdown-flow.test.ts` pins that `killAllSessions`
  returns the killed pids. All run in CI via `npm run test:unit`.
- **Contract:** the JSDoc in `src/main/shutdown.ts` and
  `src/main/pty/shutdown/session-shutdown.ts` restate the synchronous requirement at the call
  sites.

## Scope

The Electron quit path only. Normal runtime code may be async; this rule is specifically about
`before-quit` and the functions it invokes synchronously.
