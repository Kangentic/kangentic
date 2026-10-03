---
paths:
  - "src/main/pty/**"
  - "src/main/utility-process/**"
  - "src/main/shared/child-tree-stop.ts"
  - "src/main/agent/shared/cli-print.ts"
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
- **A host crash ends its PTYs and recovery resumes them.** Main first stops each lost PTY's
  process tree by pid (`stopLostPtyTree`, which only the utility transport implements): a closed
  pseudo console or a hangup usually ends the agent, but nothing guarantees it, and one left running
  would edit its worktree beside the resumed session. Each lost PTY is then reported through its
  own exit listener with `PTY_HOST_LOST_EXIT_CODE` (-2), the host restarts (at once, then on the
  restart policy's backoff), main replays its focus and tap sets, and
  `recoverSessionsAfterPtyHostLoss` resumes the agent sessions through the startup recovery path,
  then starts fresh the lost tasks that had no agent session id to resume, as startup does.
- **macOS forks the host from inside the asar** (`ptyHostEntryPath`). node-pty finds its
  spawn-helper with a bare `replace('app.asar', 'app.asar.unpacked')` on its own path, which from
  the unpacked tree doubles and breaks every spawn. Windows and Linux fork from the unpacked tree,
  where the ConPTY conout worker loads from a real directory. The afterPack probe loads node-pty
  the same way per platform, and `spawn-helper-upstream-parity.test.ts` pins both.
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
  refuses to launch its own executable or main's (the init message carries `mainExecutable`, since
  on macOS the host runs from the Helper bundle), either of which, with the RunAsNode fuse off,
  would boot a second app. A session's or a probe's PTY whose program is one of them is refused
  the same way.
  The background-shell watcher's process table also comes from the host (`listProcesses`,
  `host-process-table.ts`): a Toolhelp snapshot through koffi on Windows (about 8 ms, against
  140 ms for the PowerShell CIM query it replaced, which the host still starts only if koffi
  cannot load), `ps` on POSIX. So does the task leftover reap (`reapTaggedProcesses`,
  `src/main/pty/process-tag/`): the host scans for the `KANGENTIC_TASK_ID` tag and kills, and on
  Windows and macOS it loads koffi (an esbuild external, unpacked, and loaded by the afterPack
  probe) to read another process's environment (the PEB; the `KERN_PROCARGS2` record) and, on
  macOS, the process list and working directories from libproc. The scan yields to the event loop
  as it goes, and a native call long enough to hold it (the Toolhelp snapshot) runs on the thread
  pool through koffi's async call. See
  [[task-process-tag]].
- **Agent CLI runs start in the host too.** `spawnCli` (`src/main/agent/shared/cli-print.ts`)
  starts every headless run (Ask, task summaries, auto-name, the warm answer session) through
  `spawnOffMainCli` (`off-main-cli.ts`): a `cliSpawn` command, so the handle (`RemoteCliProcess`)
  comes back at once and emits what a local child does, `spawn`, `data`, `exit`, `close`, in the
  host's order. A summary backfill started the CLI 39 times in 100 s at 13 to 67 ms each on main;
  in the host the first, cold launch measured 51 ms and later ones stayed under 16 ms. Once posted
  a run never falls back to a local spawn, and a host crash fails it with `error`, `exit`, `close`
  rather than rerunning it (a second paid answer); main then stops the orphaned CLI's tree, since
  on Windows a child outlives its parent. Stops run in the host (`taskkill /T /F`, or the process
  group's SIGTERM then SIGKILL), and the host's shutdown stops every run still going and waits for
  them inside its exit bound. At quit, `stopAllCliRuns` also stops each run's tree from main by pid
  (`killChildTreeByPid`): with no terminal open the quit does not wait for the host, which can be
  torn down before it reads its stop. `spawnCli` spawns locally only when no host is registered.
  Every one of these stops, local, in the host, and by pid, is `src/main/shared/child-tree-stop.ts`,
  which imports only `spawn` so the host can bundle it.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/pty-host-boundary.test.ts` builds the host entry with an esbuild metafile
  (dev and production) and fails on `electron`, the IPC layer, analytics, Sentry, retrieval or dev
  tooling in its graph; pins the build entry in both `scripts/build.js` and `scripts/dev.js`; pins
  the one construction site of each transport and of `PtyHostCore`; fails on a value import of
  `node-pty` outside the host core, and on a lazy `import('node-pty')` outside the
  `off-main-pty.ts` fallback; fails on `promisify(exec)` / `promisify(execFile)` under
  `src/main` outside the drop-in and its two reasoned exceptions; pins that `host-exec.ts` and
  `host-cli-processes.ts` never fork and check for their own executable; pins that `spawnCli`
  asks `spawnOffMainCli` before its local fallback, which is the only spawn in `cli-print.ts`; and
  pins that `child-tree-stop.ts` never forks, spawns nothing but `taskkill`, imports only `spawn`,
  and is the only place a CLI tree stop builds a `taskkill`. Runs in CI via `npm run test:unit`.
  `tests/unit/child-tree-stop.test.ts` pins each stop branch per platform.
  `tests/unit/off-main-exec.test.ts` pins the drop-in's routing, error shape and fallback;
  `tests/unit/host-cli-processes.test.ts` runs real children through the host's runner (pipes,
  event order, stop, shutdown, a failed start, the own-executable refusal);
  `tests/unit/remote-cli-process.test.ts` pins main's handle (event order, stdin, stop, host loss
  and the orphan stop); `tests/unit/spawn-cli-off-main.test.ts` pins `spawnCli`'s routing and runs
  a headless print end to end through the host's runner.
- **Tests:** `tests/unit/pty-host-core.test.ts` pins the core's behavior;
  `tests/unit/utility-pty-host-transport.test.ts` pins the fork, init, request timeout, crash
  restart, fallback, heartbeat and shutdown; `tests/unit/verify-unpacked-worker.test.ts` pins the
  packaging (all of `node_modules/node-pty/**` and `.vite/build/pty-host.js` unpacked) and runs the
  afterPack probe's real spawn under this checkout's Electron.
- **Packaging gate:** `build/afterPack.js` resolves node-pty from the unpacked tree and spawns a
  real process with it under the packaged Electron binary, and on Windows and macOS loads koffi
  from the same place and makes one native call, failing the build when either cannot.
- **Packaged smoke:** `.github/workflows/package-smoke.yml` packages on Windows, macOS and Linux
  when a pull request touches the host, its clients or the packaging, and runs
  `scripts/package-smoke.mjs`: a terminal in the finished app, a Knowledge Graph read from the
  retrieval worker, a task reap that must stop a detached process a task's terminal left (koffi
  loading in the packaged host), a quit with the terminal running (a user's quit on Windows and Linux; SIGTERM
  on macOS, which skips the exit drain), and a fail on any log line saying a forked process
  crashed or the host fell back to main. Not a required check.
  `tests/unit/package-smoke.test.ts` pins the script's pure parts and that every log line it
  watches for still exists in `src/main`.

## Scope

Session PTYs and their output pipeline (`src/main/pty/**`), the host's fork and wiring in
`register-all.ts`, one-shot child processes on main, the probes' raw PTYs (the Claude model
picker, the Antigravity print runner spawn through `spawnOffMainPty`, `off-main-pty.ts`), the
agent CLI runs (`spawnCli`, `off-main-cli.ts`), and the packaging. Still on main, by measurement:
git. simple-git carries most git calls (about 60 call sites in 20 files) and has no spawn hook;
`runGitWithTimeout` could ride `cliSpawn` and `cliStop`, but it is a handful of calls (fetch,
prune, rev-parse), so moving it alone would move a fraction of the cost. Measured with three task
starts: 28 git spawns in 281 s, event-driven, at most 32 ms, three at 16 ms or more.
