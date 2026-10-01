---
paths:
  - "src/main/pty/**"
  - "src/main/ipc/register-all.ts"
  - "build/verify-unpacked-worker.js"
---
# Rule: every PTY runs in the pty host, never in main

Every terminal byte used to cross Electron's main process: node-pty's synchronous spawn, the
headless xterm parse of every chunk, the raw transcript strip and insert, and each adapter's output
detectors. Measured under a 15 s terminal flood, main was 40.6% busy, ran 30,507 `pty:data` spans,
and its event-loop delay reached 43 to 46 ms. VS Code runs node-pty in a utility process for the
same reason. So every PTY moved to the `kangentic-pty-host` utility process
(`src/main/pty/host/pty-host-entry.ts`), and the same flood now costs main 0.6 to 0.7% with its delay
at the Windows timer floor.

## The rule

- **The host core owns every session PTY and the per-chunk work.** `PtyHostCore`
  (`src/main/pty/host/pty-host-core.ts`) holds node-pty, the headless buffer and scrollback ring,
  backpressure, the raw transcript writer, and the adapters' output detectors. Main reaches it only
  through `PtyHostClient` (commands, id-matched requests, ordered events; `protocol.ts`).
  `SessionManager` stays the facade, so `sessionManager.spawn(` and every other rule's call shape
  are unchanged.
- **Main keeps mirrors, not the data.** What main reads synchronously (alt-screen state, buffer
  width) is mirrored from host events. Everything else is an async request: scrollback, the serialized
  frame, raw scrollback, the output peek, diagnostics. Do not add a synchronous read of host state
  to main.
- **Output reaches main only where something consumes it.** The host sends `data` for the focused
  union (`setFocused`), `tap` for sessions a phone streams (`subscribeDataTap`, ref-counted), and a
  coalesced `outputSeen` (no bytes) for everything else. A new consumer of raw output subscribes a
  tap for as long as it needs one; it never widens `data`.
- **One host, forked once, built in two places only.** `register-all.ts` constructs the
  `UtilityPtyHostTransport`; `SessionManager.createInProcessHost` is the only place the core runs in
  main, as the unit tests' host and as the fallback after five host crashes.
- **A host crash ends its PTYs and recovery resumes them.** Each lost PTY is reported through its
  own exit listener with `PTY_HOST_LOST_EXIT_CODE` (-2), the host restarts (at once, then on the
  restart policy's backoff), main replays its focus and tap sets, and
  `recoverSessionsAfterPtyHostLoss` resumes the agent sessions through the startup recovery path.
- **The host stays free of main-only modules.** No `electron` import, no IPC layer, no analytics,
  no Sentry, no retrieval code. It writes transcripts on its own database connection (migrations
  off, `wal_autocheckpoint` 0: the retrieval worker runs the checkpoints).
- **Quit.** `killAll()` posts every kill (a young session's after its grace, see
  [[pty-teardown-grace]]) and adds the host's pid to the drain report; `dispose()` posts `shutdown`;
  the host flushes, waits for every exit callback, and exits itself. See [[synchronous-shutdown]].
- **Project delete awaits `closeProjectInPtyHost`** before unlinking the database files, as it does
  the retrieval worker's close.
- **One-shot child processes run in the host too.** On Windows libuv runs CreateProcess
  synchronously on the calling thread, 15 to 30 ms a spawn; agent detection alone ran 30 of them on
  main at startup, 17 at 16 ms or more. Use `execAsync` / `execFileAsync` from
  `src/main/utility-process/off-main-exec.ts`, never `promisify(exec)` or `promisify(execFile)`:
  they resolve and reject exactly as `promisify` does, run the child in the host (`host-exec.ts`),
  and fall back to a local spawn where no host is registered or reachable. The host never forks and
  refuses to launch its own executable, which with the RunAsNode fuse off would boot a second app.
  The background-shell watcher's process table also comes from the host (`listProcesses`), which
  keeps the probe's PowerShell child.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/pty-host-boundary.test.ts` builds the host entry with an esbuild metafile
  (dev and production) and fails on `electron`, the IPC layer, analytics, Sentry, retrieval or dev
  tooling in its graph; pins the build entry in both `scripts/build.js` and `scripts/dev.js`; pins
  the one construction site of each transport and of `PtyHostCore`; fails on a value import of
  `node-pty` outside the host core; fails on `promisify(exec)` / `promisify(execFile)` under
  `src/main` outside the drop-in and its two reasoned exceptions; and pins that `host-exec.ts`
  never forks and checks for its own executable. Runs in CI via `npm run test:unit`.
  `tests/unit/off-main-exec.test.ts` pins the drop-in's routing, error shape and fallback.
- **Tests:** `tests/unit/pty-host-core.test.ts` pins the core's behavior;
  `tests/unit/utility-pty-host-transport.test.ts` pins the fork, init, request timeout, crash
  restart, fallback, heartbeat and shutdown; `tests/unit/verify-unpacked-worker.test.ts` pins the
  packaging (all of `node_modules/node-pty/**` and `.vite/build/pty-host.js` unpacked) and runs the
  afterPack probe's real spawn under this checkout's Electron.
- **Packaging gate:** `build/afterPack.js` resolves node-pty from the unpacked tree and spawns a
  real process with it under the packaged Electron binary, failing the build when it cannot.

## Scope

Session PTYs and their output pipeline (`src/main/pty/**`), the host's fork and wiring in
`register-all.ts`, one-shot child processes on main, and the packaging. Still on main, by
measurement: the two probe PTYs (the Claude model picker, the Antigravity print runner), which run
short, rare processes and load node-pty lazily; git through simple-git and `runGitWithTimeout`
(5 to 17 ms a spawn, event-driven; the library has no spawn hook and the abortable runner would
need request cancellation); and streaming CLI runs (`auto-name.ts`).
