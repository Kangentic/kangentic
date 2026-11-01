---
type: Reference
title: Worktree test coverage
description: Which unit tests cover worktree creation, sparse-checkout, the priority git queue and fail-fast removal, the Done move's move aside and deferred delete, base branch resolution, the fetch scheduler, the hook and trust managers, and the real-process reap tests that run on Linux, macOS and Windows runners.
tags: [worktrees, tests, unit]
sources:
  - resource: tests/unit/worktree-manager.test.ts
  - resource: tests/unit/worktree-base-branch.test.ts
  - resource: tests/unit/worktree-setup-outside-queue.test.ts
  - resource: tests/unit/done-worktree-move-aside.test.ts
  - resource: tests/unit/removed-worktree-restart.test.ts
  - resource: tests/unit/wait-for-churn-read.test.ts
  - resource: tests/unit/removed-worktrees-transient.test.ts
  - resource: tests/unit/removed-worktrees-drain.test.ts
  - resource: tests/unit/move-worktree-aside.test.ts
  - resource: tests/unit/project-delete-removed-worktrees.test.ts
  - resource: tests/unit/run-init-script.test.ts
  - resource: tests/unit/trust-manager.test.ts
  - resource: tests/unit/hook-manager.test.ts
  - resource: tests/unit/session-queue.test.ts
  - resource: tests/unit/git-fetch-scheduler.test.ts
  - resource: tests/unit/fetch-throttle.test.ts
  - resource: tests/unit/zombie-reaper.test.ts
  - resource: tests/unit/session-reap-real-processes.test.ts
  - resource: tests/unit/task-reap-plan.test.ts
  - resource: tests/unit/task-tagged-reap.test.ts
  - resource: tests/unit/task-process-readers.test.ts
  - resource: tests/unit/local-connections.test.ts
  - resource: tests/unit/task-directories.test.ts
  - resource: tests/unit/taskkill-stale-parent.test.ts
---
# Worktree test coverage

Unit tests (`tests/unit/`, run with `npm run test:unit`) cover the worktree strategy areas below.

## Trust Manager (`trust-manager.test.ts`)

- Creates `~/.claude.json` with trust entry when file doesn't exist
- Creates trust entry when file exists but has no `projects` key
- Skips write if worktree already trusted (idempotent)
- Copies `enabledMcpjsonServers` from parent project entry
- Uses empty array when parent has no MCP servers
- Preserves existing worktree entry fields while setting `hasTrustDialogAccepted`
- Leaves malformed JSON untouched rather than replacing it

Uses real temp files with mocked `os.homedir()`.

## Worktree Manager (`worktree-manager.test.ts`)

**Sparse-checkout** (`.claude/commands/` exclusion):
- On git 2.35+, one `set --no-cone` call excludes `.claude/commands/` only, with no `init`
- On git before 2.35, or an unknown version, keeps `init --no-cone` + `set`
- A sparse-checkout failure is non-fatal
- Sparse-checkout runs before `copyFiles`
- Skips `.claude/` entries in `copyFiles`
- No `skip-worktree` or `update-index` calls
- Does not call `rmSync` for `.claude` directories

**Parallel checkout workers:**
- `worktree add` carries `-c checkout.workers=N`, N being the core count capped at 8
- No `checkout.workers` on a single core
- A `checkout.workers` the user configured is left in charge (nothing passed)

**Fetch and base branch:**
- The fetch runs as `fetch --no-auto-gc origin <baseBranch>` (`fetch-throttle.test.ts`)
- Fetch succeeds → worktree created with `origin/<baseBranch>` as start point
- Fetch fails (no remote) → worktree created with local `<baseBranch>` as start point
- Stores `kangentic.baseBranch` with `--worktree`, after the sparse-checkout step
- Falls back to the shared config when git refuses `--worktree`
- `kangentic.baseBranch` config failure is non-fatal
- Two worktrees on different bases each read their own (`worktree-base-branch.test.ts`, real git)

**Post-Worktree Script abort:**
- An abort during the script rejects creation with an `AbortError`; a script's own failure stays a failure
- The next creation attaches to the leftover branch and still reports its base while it sits at the start point (`worktree-base-branch.test.ts`)
- Abort and timeout kill the script's whole process tree (`run-init-script.test.ts`; real processes in `run-init-script-tree-kill.test.ts`)
- An abort settles on the killed shell's `close`, or at `TREE_EXIT_WAIT_MS` when it never comes (`run-init-script.test.ts`)
- The init-script heartbeat stops the moment the setup is aborted

**Setup phase outside the git queue:**
- `createWorktree` copies no files, links no `node_modules` and runs no script; `setUpWorktree` copies, then links, then runs the script
- Each step logs `create step=<name> done in <n>ms`, and the `[INIT-SCRIPT]` completed, failed and stopped lines carry the elapsed time
- `prepareStaleWorktreeForCreation` clears only a stale directory, never a live worktree, and nothing with worktrees off
- `removeWorktree` refuses a path whose creation is in flight; `createWorktree`'s own stale-directory clear still runs while its creation holds the path
- `ensureTaskWorktree` sets up after the lock is released and records only after the setup succeeds, except in the background mode (`git.holdPromptForInitScript` off), which records once the files are set up while the script runs on under the creation's hold; a second same-task creation waits and reuses (`task-git-remote-worktree-skip.test.ts`)
- With a real repo and a real blocking script (`worktree-setup-outside-queue.test.ts`): another task's creation, a Done-move removal and auto-fetch all finish while the script runs; an in-queue removal refuses and an outside-queue one waits; an abort kills the script before the creation settles
- The move-failure stale cleanup skips whole while a newer creation holds a candidate path (`task-move-stale-branch-cleanup.test.ts`); the backlog pass skips a held task whole, and the orphan sweep skips a held path, including one claimed while it runs (`resource-cleanup.test.ts`, `prune-orphaned-dirs.test.ts`)
- The MCP delete and the project delete wait for a creation at the path before they remove it (`mcp-project-context.test.ts`)

**Removal:**
- `removeWorktree` calls `git worktree remove --force`
- `removeWorktree` falls back to `rmSync` + `git worktree prune` on failure
- `removeWorktree` no-ops when path doesn't exist
- `removeBranch` calls `git branch -D`
- `removeBranch` silently handles missing branch

**Done removal (move aside, then a deferred delete):**
- With a real repo and a real blocking script (`done-worktree-move-aside.test.ts`): a Done move takes the worktree off its path, out of `git worktree list` and off the row at once; a script that starts while the deleter is mid-delete parks it with its removed-entry count unchanged until the script ends, and a Done during a running script deletes nothing until it ends. The test reads the deleter's own state, never a timed wait. With the gate disabled both fail on an assertion in about 2 s
- A task moved back out of Done gets its worktree at the same path and branch while the old copy waits (the move pruned the old record), and a pnpm-style link in the copy (a junction on Windows) whose absolute target the restored worktree re-creates is removed as a link, with the live files kept
- In the default setup, where the worktree's `node_modules` links to the project root's, the link is removed from the copy as soon as it moves, and every root file survives. `removeNodeModulesLinkOnly` removes a link and keeps its target, and leaves a real directory alone
- The deleter stops after the batch in flight when told to (relocation), and a project delete deletes the copies at once without waiting for a running script
- `waitForChurnRead` waits for a running or still-queued churn read in that directory, ignores another directory's, and returns at its bound (`wait-for-churn-read.test.ts`)
- The walker removes files, directories, a read-only file and a link without entering it, stops when told to, refuses any path that is not a direct child of `removed-worktrees/`, and each move gets its own name
- The walker retries a brief `ENOTEMPTY` or `EBUSY` (a handle antivirus or the indexer still holds), gives up on one that lasts, and does not retry any other error (`removed-worktrees-transient.test.ts`)
- A copy set aside while a drain ends is still deleted: the schedule is placed 0 to 24 microtasks after the drain's last listing, and a one-microtask gap between the drain's last check and its exit fails it (`removed-worktrees-transient.test.ts`)
- Across a restart (`removed-worktree-restart.test.ts`, file-backed database closed and reopened): a copy a quit left mid-delete is deleted by the next project open, and a Done row a quit left with its worktree still on disk is moved aside, deleted and cleared, branch kept. Without the project-open sweep both fail
- `moveWorktreeAside` with real git (`move-worktree-aside.test.ts`): it refuses a path a creation holds and changes nothing, a failed rename prunes nothing and keeps the `node_modules` link, a failed prune still answers true, an already-gone path is still pruned, and a move leaves the copy with no link and no `.git`
- The drain (`removed-worktrees-drain.test.ts`): a stop resolves while the deleter waits on a running script, a schedule during a stop starts no drain, a quit ends it between batches, the same drain's reruns skip a copy that failed, a failed batch settles its siblings first, the Windows `EPERM` and `readlink` branches with the platform stubbed, a read-only parent on macOS and Linux, and a direct child named `..foo`
- Relocation stops the deleter before the folder moves (`project-relocate.test.ts`), and a project delete runs it before it removes `.kangentic/`, but not for a project that is itself a worktree (`project-delete-removed-worktrees.test.ts`)
- `runInitScript` counts a script from the call until it settles, however it settles (`run-init-script.test.ts`)
- `deleteTaskWorktree` waits for the churn read and the creation, moves aside in the BACKGROUND lock, clears the row before it starts the deleter, and removes in place only when the move fails (`delete-task-worktree.test.ts`)

**Stale branch recovery:**
- `createWorktree` reuses auto-generated branch that already exists (no `-b` flag)
- `createWorktree` does NOT inline `git worktree prune` (moved to the removal path and background prune - see [Creation Flow](worktree-creation.md#creation-flow))
- `createWorktree` cleans up stale directory before `git worktree add`
- `pruneWorktrees` calls `git worktree prune`
- The move-failure stale cleanup (`handleTaskMove`, `task-move.ts`) force-deletes ONLY an
  auto-generated branch, gated on `isAutoGeneratedBranch`. A custom, agent-supplied branch is left
  in place even when its worktree could not be created, because `removeBranch` is `git branch -D`
  with its errors swallowed and would otherwise destroy unpushed commits on any worktree failure.
  This gate is local to that one recovery path; the `autoCleanup`-gated call sites in
  [Session Lifecycle](worktree-lifecycle.md#session-lifecycle) are unaffected.

**Priority queue:**
- Concurrent operations on same project execute sequentially (one at a time)
- Concurrent operations on different projects execute in parallel
- Failed operation does not block subsequent operations
- A later `USER`-priority op jumps ahead of an already-queued `BACKGROUND` op; equal priority drains FIFO
- `clearQueue` removes the project entry and rejects any still-waiting jobs
- `withLock` instance method uses the project path

**Fail-fast removal:**
- All three profiles are pinned: `fast` forwards single-attempt opts to `removeWithRetry`, `moderate` forwards its bounded budget to both removal steps, and `thorough` (the default) forwards a wall-clock `budgetMs` to both. The thorough case exists because its absence is why the budget shipped unbounded in the first place
- Background retry cleanup runs at `BACKGROUND` priority: it moves the worktree aside first (`{ timeoutMs: 3000 }`), and falls back to `{ timeoutMs: 3000, removalProfile: 'fast' }` in place (`retry-failed-done-cleanups.test.ts`)
- The post-reap retry gets a shorter budget than the first attempt
- The node_modules step is capped again so it cannot spend the whole budget
- The move-failure stale cleanup passes `removalProfile: 'moderate'`
- A budget expiry logs `remove step=manual-rm timed out` and `removed=false timedOut=true` at `warn`
- A hanging `worktree-removing` listener cannot stall the removal (2s cap)
- `createWorktree` still reuses an EMPTY husk after a timed-out removal; only a non-empty or unlistable directory is fatal, and that error names the holders when the scan found any

**listWorktrees:**
- Parses `git worktree list --porcelain` output correctly
- Returns empty array for bare output

Uses vi.mock for the git client (`src/main/git/git-client.ts`) and `node:fs`.

## Process reaping (`zombie-reaper.test.ts`, the `task-*` reap tests, `session-reap-real-processes.test.ts`)

`zombie-reaper.test.ts` drives the pure predicates through the `_internals` spy seam, so no test
spawns PowerShell or `ps`: the self-skip and orphan gates, the trailing-separator boundary against a
prefix-sibling worktree, the two needles (command line, executable path), the bare-worktree-root
match (`commandLineReferencesPath`), the separation of the filtered and unfiltered scan caches, and
the holder-reporting half (`findWorktreePathHolders`, `processImageName`, `describeHolder`). The
Windows output shapes are parsed from fixtures so they are covered on the Linux CI runner, the
`CreationDate` forms included. It pins that a reused parent pid only spares, and that on Windows a
registered identity stop gets every candidate by pid and creation time and nothing is killed by
bare pid, a row with no creation time is skipped, and the by-pid kill runs only with no stop
registered or off Windows.

The task reap is covered in layers. `task-reap-plan.test.ts` pins the kill plan with the shapes the
runners measured: the tag and the directory both required, a shared process spared with its
subtree (pm2's daemon with a later untagged app, a cleared-tag child), console hosts and unknown
directories taking no part, a tmux server and a visible app protected with everything under them,
the macOS withheld branch, never main's tree, a host-held PTY, another task, or pids 0 to 4, and on
Windows no parent link through a recycled ppid, and no kill walk (a reap's, a Stop's) through a
process with no identity. It also pins the connection evidence (which clients
count, propagation through a spared server, a listener that is never kept for its children), the
kept launchers (the adb server, emulator and launcher shapes), and `connectionQueryOf`;
`local-connections.test.ts` pins the pairing of a listener to its clients.
`task-directories.test.ts` pins the roots that are never accepted. `task-tagged-reap.test.ts`
pins the two passes (a SIGTERM-ignoring survivor and a respawned child are force-killed, a pid
reused between scans is not) and request coalescing. It also pins that each pass reads connections
after its scan, that the second pass keeps what the first kept after the client's connection is
gone, and `connection_list` in either pass. `task-process-readers.test.ts` runs each
platform's parser on fixtures, so all three are covered on the Linux CI runner. It also reads real
loopback connections, a dual-stack listener included, and checks them against `ss`, `lsof` and
`netstat`.
`pty-host-core-tagged-reap.test.ts` pins the host protecting a PTY it still holds.
`session-leftover-reap-wiring.test.ts` pins where the reap is called and where it is not.

`session-reap-real-processes.test.ts` is the discriminating one and uses REAL processes on whatever
OS runs it. It builds the incident's shape (a grandchild whose argv and executable path both fall
outside the worktree and whose cwd is inside it, launcher killed), asserts the path scan finds
nothing and that after the reap the directory removes; it also asserts that `rmSync` fails while
the process lives, but only on Windows, since POSIX unlinks a busy directory happily. It then
fast-detaches tagged processes (a Node `detached: true` relaunch, plus `nohup` and `setsid` on
POSIX or `cmd /c start /b` on Windows) from inside a fake project and asserts the reap kills them.
It asserts the reap spares a tagged live child of the reaping process, another task's process, a
cleared tag, a tagged process started outside the project, one that moved to the filesystem root,
and a tagged parent whose child cleared the tag. It also asserts that a server another task holds a
TCP connection to is kept, while one only its own task uses, and an idle one, still stop. It runs a
tmux server on a private socket (`-L`)
and asserts neither it nor its pane is killed. Under CI it opens a visible app (Character Map on
Windows, since a Windows 11 desktop's `notepad.exe` is a packaged app's alias whose pid exits at
once; xterm under xvfb on Linux, Chrome on macOS) and asserts it survives; it never opens one on a
developer's machine. With `KANGENTIC_WINDOWS_TERMINAL` naming a portable Windows Terminal, which the
workflow unpacks on Windows, it starts that Terminal untagged, opens a tagged `cmd /c ping` tab in
the worktree, and asserts the reap kills the tab's shell and ping. On macOS it starts a `cd <dir> && cmd &` chain under `env -i`, whose record
reads exactly like a SIP-withheld one, inside the worktree, inside the project and outside both,
and asserts only the worktree one dies. On Linux it runs the WSL reap script for real against
`/proc`. On Windows it stops a worktree holder by the creation time a real `Win32_Process` scan
read, and refuses one a millisecond off. The `task-reap-real-processes` workflow runs the file on
Linux (with a display), macOS on Apple silicon and Intel, and Windows, and on Windows it also
reruns the taskkill probe (`taskkill-stale-parent.test.ts`, see [Parent pids Windows reuses](process-reaping.md#parent-pids-windows-reuses)).

## Base Branch Resolution (`worktree-base-branch.test.ts`)

Runs the real `git` binary against temp directories (mirroring `ensure-git-repo.test.ts`) rather
than mocking git, so the behavior pinned is what `git worktree add` actually does with each
resolved ref.

**`WorktreeManager.ensureWorktree`, end to end:**
- Takes the byte-identical path when the base resolves normally (the additive-only invariant)
- Falls back to `master` when the repo only has `master` and the default is the unconfigured `main`
- Creates and pushes a branch for a task whose base is a bare name like `develop`, checked out locally and only on the remote (the old base-folder name failed both)
- Throws a written error naming the branch when an explicit per-task base does not exist
- Reproduces the identical worktree path on a Done round-trip after a default-chain substitution
- Throws and lists the repo's real branches when the default chain is fully exhausted
- Resolves a base that exists only on origin and was never fetched (fetch retry)
- Falls back to a verified `origin/<base>` start point when worktree creation's own fetch fails (the `verifiedStartPoint` seam)
- Reports `{ skipped: true, reason: 'no-commits' }` for an unborn HEAD, now enforced inside `ensureWorktree`
- Regression pins for states that are already no-ops: detached HEAD (creates normally), a bare repo (`not-a-repo`), a broken `.git` file pointer (`nested-worktree`)

**`resolveWorktreeBase` candidate order:**
- Tries only the per-task base branch when set, never substituting main/master
- Treats an empty-string task base branch as "not set" (falls through to the default chain, not an explicit unresolvable candidate)
- Deduplicates the default chain when the configured default is already `master`
- Resolves the configured default itself when it exists (no fallback engaged)
- Falls through to a later default-chain candidate resolved only via the fetch pass

**`resolveWorktreeBase` - listBranches truncation:**
- Caps `availableBranches` at `MAX_LISTED_BRANCHES` (10) even when the repo has more

**`resolveWorktreeBase` and `WorktreeManager.createWorktree` - narrowed refspec (fetch succeeds, ref never lands):**
- `resolveWorktreeBase` does not trust a fetch that succeeds without landing the remote-tracking ref
- `createWorktree` falls back to `verifiedStartPoint` instead of trusting a fetch that reports success without landing the ref

**`describeUnresolvableBase` message formatting:**
- Names the branch and offers the fix for an explicit per-task base
- Lists every attempted default-chain candidate and points at the settings fix
- Formats a two-item attempted list without an Oxford comma before "or"

## Background remote refresh (`git-fetch-scheduler.test.ts`, `fetch-throttle.test.ts`)

`git-fetch-scheduler.test.ts` mocks `WorktreeManager.withGitLock` and `fetchAllRemotesIfStale`
and drives the timers with fake time:
- Runs an immediate sweep and arms a periodic timer at the configured interval
- Sweeps through the git lock at `BACKGROUND` priority with `nonInteractive: true`
- A rejected lock never escapes the tick as an unhandled rejection
- Off (`null` interval) runs the on-load sweep but arms no timer
- `stop()` clears the periodic timer; `stop(projectId)` only stops when that project owns it
- Switching projects tears down the prior timer and arms the new one
- Skips a tick when the project is no longer the current one

`fetch-throttle.test.ts` pins the env the fetch runs under: the default hands the child main's
environment (without Crashpad's pipe name, see `docs/platforms/windows.md`) so a user-driven fetch can
still prompt, and `nonInteractive` hands BOTH git calls (the common-dir probe
and the fetch) an env with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`.

## Hook Manager (`hook-manager.test.ts`)

- Inject event hooks creates correct hook entries
- Hooks preserve user-defined hooks
- Strip removes all Kangentic hooks, preserves user hooks
- Strip cleans up empty settings file
- Strip handles missing file gracefully

Uses real temp files.

## Session Queue (`session-queue.test.ts`)

- FIFO ordering with configurable concurrency
- Queue drain callback fires when all tasks complete
- Task errors don't block subsequent tasks
