---
paths:
  - "src/main/remote/**"
  - "src/main/pty/spawn/remote-spawn.ts"
  - "src/main/pty/lifecycle/session-spawn-flow.ts"
  - "src/main/pty/host/pty-host-client.ts"
  - "src/main/pty/shutdown/session-shutdown.ts"
  - "src/main/db/repositories/ssh-host-repository.ts"
  - "tests/unit/remote-*.test.ts"
---
# Rule: a session on a remote host is never treated as a process on this machine

A remote project runs its agent on a Linux host over SSH (#913). The agent, its PTY, its files and
its git all live there, and this computer holds the board, the UI and a link. Nearly every piece of
code in main was written for a process that is here, so each of these is a place that is silently
wrong, not loudly wrong, when it meets a session that is not: a pid that names another machine's
process, a path tested against the wrong disk, an environment that overwrites the host's own.

## The rule

- **A remote PTY has no pid here, in the type.** `PtyHandle.pid` is `number | null`, and null means
  the PTY runs on a host. Never invent a number for "none": `process.kill(0)` signals Kangentic's own
  process group and `-1` signals every process the user owns. Anything that signals, waits on or
  lists by pid handles null, and `tsc` fails the site that does not. A local pty host dying ends no
  remote PTY (`PtyHostClient.takeLiveHandles`); the host's own link says when one is gone.
- **A spawn names its host, and everything after follows the PTY.** `PtyHostSpawnParams.hostId` sends
  a spawn to the link hub, and `HostRouter` sends each later command and request to wherever its PTY
  or session lives. A request with no meaning on a host is refused with a sentence
  (`HostUnreachableError`), never sent to the wrong machine.
- **Nothing of this computer reaches a host.** A remote spawn is one plan (`planRemoteSpawn`): the
  host's login shell, the host path verbatim, the adapter's variables plus the task tag and a TERM,
  and a command quoted for the host's shell on Linux. Never `buildSpawnEnv`'s result (the helper
  layers a spawn's variables over the host's own, so a sent `PATH` or `HOME` replaces the host's),
  never `resolveSpawnCwd` (it tests the path on this disk), never `process.platform` for a question
  about the host (graceful close, quoting).
- **Only the host proves a path absent.** A path on a host is checked by the helper's `pathPresence`
  and read through its `readFile`, never by this computer's disk or a local mirror, and a failed ask
  is an error, never "absent". With the link down nothing is pruned, demoted, retired or deleted
  for want of a path.
- **A drop is a state, never an exit.** The link reports `remoteLink`, and agents on the host keep
  running. A session ends only when the host reports its exit, or reports it gone after a restart
  (`remoteSessions`, `lost`), which resumes it through the recovery path.
- **A quit hands remote sessions to the link.** `killAllSessions` signals, types into and counts
  nothing for them. `SessionManager` posts each host its plan (`remoteQuitPlan`: the adapter's exit
  sequence and whether closing the console is graceful), the link sends it as one `suspendAll` frame,
  and the helper ends the agents on its own clock. A remote session keeps the pty host process in
  the quit drain, or Electron could tear it down before that frame goes out.
- **A reconnect never prompts.** `ssh` runs with `BatchMode=yes`, so a host that needs a password or a
  passphrase fails with its own words, shown as given. Kangentic never asks for a passphrase. A
  destination that `ssh` would read as an option (a leading `-`) is refused before it reaches `ssh`.
- **The helper writes and reads only beneath the user's home on the host,** and refuses any other
  path, a relative one and one that climbs out, before it touches anything. That covers removing a
  file and the folder a program is run in.
- **An adapter declares the host files its code edits; it never reaches for the host itself.** A
  CLI on a host has its trust, hook and MCP files there. An adapter lists them in `remoteFiles()`
  (home-relative, project-relative, and the ones that hold a secret), and `HostFileSync` pulls them
  into the folders the unchanged adapter code edits, pushes the change after the command is built,
  and restores them at release. A new adapter file that reads or writes a CLI's config does it
  through `cliHomeDir(place)` or the working directory and declares the file; it never opens a path
  on the host any other way. Nothing is written over a host file that changed meanwhile, the helper
  re-checks it as it swaps the file in, and a push is compared with what Kangentic last knew the host
  to hold (shared by every session on the host), never with one session's own pull, which another
  session's push makes stale. A file that is not plain JSON is never rewritten.
- **A forwarded dev-server port is its own `ssh -N -L`, never a channel of the link.** The process that
  holds the links starts it (`link/port-forward.ts`), bound to 127.0.0.1 and named explicitly, only for a
  port the dev-port ledger leases to a project on that host, and only once the host's program reports a
  server listening on it. Main sends the full wanted set (`port-forward-plan.ts`), recomputed from the
  tables and not from one release path. Terminal traffic never shares a stream with it.
- **A probe of an agent's CLI on a host runs on the host.** `execCliForTarget` and
  `place.files.runCommand` run the program through the user's shell on the host, with a timeout
  that stops its process group. `cliInvocationForTarget` throws for a host: it would start a
  process on this computer.

## Enforcement (self-maintaining)

- **Type system:** `PtyHandle.pid: number | null` makes `tsc` (`npm run typecheck`) name every pid
  reader.
- **Tests (pid and quit):** `tests/unit/pty-host-client-remote-pid.test.ts` pins the null pid and that
  a dying local host leaves a remote PTY alone. `tests/unit/session-shutdown-flow.test.ts` and
  `tests/unit/session-manager-remote-quit.test.ts` pin that the quit signals, types into and counts
  nothing for a remote session, sends each host its plan, and keeps the host in the drain.
- **Tests (spawn):** `tests/unit/session-spawn-flow.test.ts` (the remote block) and
  `tests/unit/remote-spawn.test.ts` pin the shell, cwd, environment, graceful-close platform and
  quoting. `tests/unit/remote-helper-host-ops.test.ts` pins the login-shell flags, the host's own
  environment, and the helper's refusal of a path outside home.
- **Tests (routing and link):** `tests/unit/remote-host-router.test.ts`, `remote-link-hub.test.ts`,
  `remote-link-gate.test.ts`, `remote-frame-codec.test.ts` and `remote-resume-endpoint.test.ts` run the
  real router, hub, link and helper over an in-memory stream.
  `tests/unit/remote-host-service.test.ts` pins the ssh options, the destination check, and that a
  failed ask is never an absence. `tests/unit/remote-helper-boundary.test.ts` keeps the helper bundle
  free of electron and the native modules it cannot load.
- **Tests (host files and probes):** `tests/unit/host-file-sync.test.ts` pins the pull, the push
  (modes, private files, a conflict refused), the git exclude and the restore against an in-memory
  host. `tests/unit/remote-host-command.test.ts` runs real programs through the helper's command
  runner on POSIX (banner stripped, exit code, stdin, timeout) and pins the shell choice.
  `tests/unit/<adapter>-ssh-remote.test.ts` runs each adapter's real trust and builder over a fake
  host and asserts what lands there carries host paths and nothing of this computer.
- **Tests (forwarded ports):** `tests/unit/remote-listening-ports.test.ts` pins the kernel-table parser
  (loopback and wildcard only, both families) and that a failed read is an error, never an empty list.
  `tests/unit/remote-port-forward.test.ts` pins the exact `ssh` arguments, that a forward starts only
  once a server listens, a port held here is blocked without starting `ssh`, retry with backoff, and that
  every `ssh` is ended on removal, when a port leaves the wanted set, and on exit.
  `tests/unit/remote-port-forward-plan.test.ts` pins the wanted set from the ledger and project rows, and
  `tests/unit/remote-host-router.test.ts` the path through the router and the helper.
- **Test (link down):** `tests/unit/remote-link-down-no-mutation.test.ts` runs cold-open recovery
  with the host out of reach and asserts a paused remote task stays paused, whether the resume fails
  to prepare (the case a down link reaches) or the spawn throws, and that a local spawn that throws
  still retires its record. A PTY spawn that reaches the host and fails resolves as an exited session
  for local and remote alike, and is not covered.
  **Gap:** the other board operations (prune, stale-resource cleanup, auto-spawn) have no remote
  test yet. A remote task has no worktree path for them to find absent, which is what keeps them
  from demoting it, and `pathPresence` over `existsSync` is otherwise held by review.
- **Review:** `/code-review` flags a new `existsSync`, `fs` read or pid use on a path or session that
  may belong to a remote project, and a new spawn path that reads `process.env` or `process.platform`
  for a host.

## Scope

The link, helper, router and host service under `src/main/remote/`, the remote branches of the spawn
flow, client and quit path, and the host table. The renderer's connection indicators (the host chip, the
board strip) and the SSH tab's Add host flow follow the UI conventions, like any other renderer surface.
