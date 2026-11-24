---
paths:
  - "src/main/utility-process/off-main-*.ts"
  - "src/main/shared/child-tree-stop.ts"
  - "src/main/git/spawn-with-abort.ts"
  - "src/main/agent/shared/cli-print.ts"
  - "src/main/shell-env.ts"
  - "tests/unit/main-thread-process-starts.test.ts"
---
# Rule: main starts no child process on its own thread

On Windows `child_process.spawn` runs CreateProcess on the calling thread. A start made from
Electron's main thread held the window for 3,850 ms on 2026-11-23: the Terminal font list
ran `font-list`, which calls `exec` of cmd and then PowerShell, during the burst of processes every
boot starts. Nothing painted and no input was taken until it returned. An ordinary start on main
costs 17 to 71 ms, and one made while other starts are in flight costs far more. The pty host
already has a spawn worker for exactly this (see [[pty-host-out-of-process]]). This rule keeps
every start on it.

## The rule

- **Main-process code never imports `child_process` to start a process.** A one-shot run whose
  output is read at the end uses `execFileAsync` or `execAsync`
  (`src/main/utility-process/off-main-exec.ts`). A run that needs stdin, streamed or binary output,
  or a stop uses `spawnOffMain` (`off-main-spawn.ts`), which is `spawnOffMainCli`
  (`off-main-cli.ts`) with its local fallback in one call. Git uses `gitAt`
  (`src/main/git/git-client.ts`). Each runs the child on the pty host's spawn worker, and starts it
  here only when no host is registered: unit tests, and startup before the host.
- **A move changes where a child starts, never what a quit does to it.** A child main used to start
  and never stopped at a quit (a project's script, a run-script automation, a shortcut command)
  starts with `outlivesApp`, so the host leaves it alone at shutdown as main did. A stop is still
  the caller's: `stop('treeNow')` for a script that timed out or was superseded, `stop('process')`
  for a program that starts nothing. A caller that reports a run as failed when the host is lost
  under it ends what the run left by pid (`killChildTreeByPid`), and a shortcut command never does.
- **Bytes do not cross to the host.** The channel carries text and has no backpressure, so input
  of any size is a file the child reads for itself (`stdinFile`), as the SSH helper upload is.
- **Prefer no process at all.** The font list reads Chromium's own
  (`src/preload/local-fonts.ts`). Before adding a command, look for an API that answers the
  question.
- **Never a synchronous start.** `execSync`, `execFileSync` and `spawnSync` hold main for the
  child's whole run, not only its start. The quit failsafe in `shutdown.ts` is the one place where
  that is the point.
- **A package that starts a process from its caller's thread stays out of main.** `font-list` and
  `node-machine-id` are banned by name, each replaced by code of ours. `simple-git` is banned from
  main's graph and stays installed only as the oracle `tests/unit/git-client.test.ts` checks
  `gitAt` against. Read a new dependency for `child_process` before main imports it.
- **An exception is classified with its reason, in the test below.** The reasons that hold: the
  start is a drop-in's own no-host fallback, it runs before the host exists, it is the quit, it
  stops a run whose host died, the file is a host module main bundles only for the in-process host
  core, or the code is a package's own and runs on one platform at init.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/main-thread-process-starts.test.ts` bundles `src/main/index.ts` with an
  esbuild metafile, the way `scripts/build.js` builds it, so the graph it reads is exactly what
  runs in main. It fails on a module of ours in that graph that imports `child_process` without an
  entry in `CLASSIFIED_STARTS` (the file, the `child_process` exports it may import, and a reason),
  on a bundled package that does so without an entry in `CLASSIFIED_PACKAGES`, and on an esbuild
  external main reaches that `EXTERNAL_PACKAGES` does not classify. An entry whose file is gone, is
  no longer in the graph, or imports other exports than it lists fails too, so the lists describe
  only what is there. It also fails on a banned package in the graph or in `package.json`, and on
  `deviceModelManufacturer` anywhere under `src/main`, the Sentry option that starts PowerShell
  from main. Runs in CI via `npm run test:unit`.
- **Test:** `tests/unit/pty-host-boundary.test.ts` fails on `promisify(exec)` or
  `promisify(execFile)` under `src/main` outside the drop-in.
- **Tests (the drop-in and its runs):** `tests/unit/off-main-spawn.test.ts` pins that both routes
  hand back the same child, report a failed start as `error` then `close`, and stop the same way.
  `host-cli-processes.test.ts`, `pty-host-spawn-worker.test.ts` and `remote-cli-process.test.ts`
  pin `outlivesApp` (not stopped and not waited for at shutdown, waited for once a stop was asked),
  the stop modes, the ignored stdio and the file as stdin. Each moved caller pins its own options:
  `spawn-with-abort-off-main.test.ts`, `run-script-adapter-tree-kill.test.ts`,
  `shell-exec-handler.test.ts`, `remote-ssh-run.test.ts` and `ssh-setup.test.ts`.
- **Measure:** a dev build times every start (`src/devtools/main/spawn-tracer.ts`).
  `kangentic_devtools_event_loop_lag` lists main's own under labels that start `spawn:`, and the
  host's under `pty-host:spawn-worker:` (only those of 16 ms or more). After a boot and a Settings
  open, main's own `syncWorkByLabel` holds no label that starts `spawn:`. Measured in a `/preview`
  on 2026-11-24 across a boot, the font list, the Changes and Graph reads, the file search, an
  image preview, `ssh -V`, a Post-Worktree Script, a run-script row and a shortcut command.
- **Gap:** the scan is per module. A classified file can gain a second start of the same kind
  without failing, so a change to one is review's to read.
- **Gap:** the Stop script was not driven in the running app. It starts through the same
  `spawnWithAbort` branch as the Post-Worktree Script, and its own behavior is pinned by
  `tests/unit/run-stop-script.test.ts` on a real stub.

## Scope

Code that runs in Electron's main process: everything `src/main/index.ts` reaches, dev tooling
included. The pty host, its spawn worker, the retrieval and dictation workers and the SSH helper
are other processes with their own graphs. The host's terminal thread has the same rule for the
same reason, kept by [[pty-host-out-of-process]]. A process Chromium starts (a renderer, a utility
process, `shell.openExternal`) is not a `child_process` start and is out of scope.
