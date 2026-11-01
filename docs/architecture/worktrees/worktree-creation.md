---
type: Reference
title: Worktree creation
description: The per-project git queue with USER and BACKGROUND priorities, removal profiles and the creation registry, then the creation steps from fetch and worktree add to the Post-Worktree Script, the agent starting while that script runs (prompt held, or the script in the background), core.longpaths, sparse-checkout of .claude/commands and node_modules linking.
tags: [worktrees, git-queue, sparse-checkout, init-script]
sources:
  - resource: src/main/git/worktree-manager.ts
  - resource: src/main/git/worktree-creation-registry.ts
  - resource: src/main/git/run-init-script.ts
  - resource: src/main/git/spawn-with-abort.ts
  - resource: src/main/git/node-modules-link.ts
  - resource: src/main/git/sparse-exclusion.ts
  - resource: src/main/git/git-version.ts
  - resource: src/main/git/rm-with-retry.ts
  - resource: src/main/git/git-client.ts
  - resource: src/main/ipc/helpers/task-git.ts
  - resource: src/main/transition-engine/early-agent.ts
---
# Worktree creation

## Concurrency

Each git command a worktree lifecycle runs (create, fetch, checkout, removal) goes through
`src/main/git/git-client.ts` (`gitAt`), which starts it in the pty host, so a workflow running
several task lifecycles at once does not stall main on synchronous git spawns. The Scope section
of `.claude/rules/pty-host-out-of-process.md` lists the git calls that still run on main.

All git-mutating operations (create, remove, branch delete, prune, checkout, rename) are serialized per project via a priority-aware queue (`WorktreeManager.withGitLock` / instance `withLock`). Exactly one operation runs at a time per project (preserving the `.git` lock-contention guarantee), but waiting operations are ordered by `GitQueuePriority` - `USER` (0, the default) runs ahead of `BACKGROUND` (10, e.g. retry cleanups and background prune), with FIFO order within a priority band. This keeps a user-initiated spawn from head-of-line-blocking behind a slow or failing background cleanup. Different projects run independently. `removeWorktree`'s `{ timeoutMs, removalProfile }` options bound how hard a removal retries so one stuck delete cannot hold the queue: `removalProfile` is one of `thorough` (full backoff under a 30s wall clock; the default, used where a failure surfaces an error to the user such as worktree create or project delete), `moderate` (a pinned path fails in a few seconds; used on the user-facing Done-move and cleanup paths so a held handle never holds the queue for minutes), or `fast` (a single attempt; used by the background startup retry pass). `clearQueue` (on project close) rejects any still-waiting jobs so their callers do not hang.

`thorough` is the only profile with a clock, because it was the only one whose budget was otherwise unbounded. Its retry ladder looks bounded but is not: Node applies `{ maxRetries, retryDelay }` per locked path and the ladder compounds through the recursion, so the ceiling scales with the tree rather than with time. One observed create-worktree ground for 402716ms on a directory pinned by a live process, holding the queue the whole time. Measured directly against a two-directory tree pinned by a live process's cwd on Windows, the unbudgeted call took 668215ms against the budgeted call's 29832ms, so the incident's number was not an outlier. Under a budget, `removeWithRetry` turns Node's per-path retry off and drives every retry itself until the deadline, which caps the worst case at one fast tree walk past it. The budget covers a whole removal attempt (node_modules, `git worktree remove`, manual rm), and the retry that follows a successful reap gets a shorter 10s one, since a removal that is still stuck after the holder is dead will not be fixed by grinding. The node_modules step is capped again at the smaller of 10s and half the remaining budget: it runs first and `removeNodeModulesPath` swallows its own errors, so a locked node_modules would otherwise grind to the deadline, return normally, and leave the two steps that matter running on the 1s floor with git's real verdict replaced by a timeout abort. A job past 60s logs its `[GIT_QUEUE] ... still running` heartbeat at `warn` rather than `log`, so it survives into a production log tail.

The bound matters beyond the wait: it is what makes the [reap](process-reaping.md) reachable at all. The reap runs only on `tryGitRemoval`'s failure, and without a clock attempt 1 never returned, so the recovery code sat behind a call that never came back.

The move-failure stale cleanup in `handleTaskMove` runs at `moderate`, not the default `thorough`. Creation just failed on that same path, so a second full-budget grind re-proves what is already known while the user waits on a failure toast and the git queue stays held: measured in a preview, the two thorough passes put the toast about 62s out against about 34s with this profile.

### Creation holds the queue for its git phase only

A worktree creation (`ensureTaskWorktree`, the one entry point every spawn path uses) runs in two phases. The git phase (fetch, the stale-directory clear, `worktree add`, sparse-checkout, the config writes) is one `create-worktree:<id8>` job on the queue. The setup phase (copy files, the `node_modules` link, the Post-Worktree Script) runs after that job ends, still before the agent spawns. The script used to run inside the job, so one `pnpm install` held every other git operation in the project: another task's creation, a Done move's removal, auto-fetch. In one project's logs a second task waited 11 s for the first task's 9.8 s install, and a 21.6 s install held the queue alone. N tasks starting together ran N scripts back to back.

Two things now do what the queue used to do for the setup phase.

- **The creation registry** (`src/main/git/worktree-creation-registry.ts`) holds a task's worktree path from the start of `ensureTaskWorktree` until the setup ends. A second creation for the same task waits for the first, then re-reads the task row, so it reuses the worktree the first one recorded instead of clearing it as a stale directory. A removal that runs outside the queue (`prepareWorktreeForRemoval`: the To Do move, a delete from the board, an MCP delete, a project delete; the Done move's own `waitForWorktreeCreation` ahead of its move aside) waits for the hold to end. It runs only for a worktree its task has recorded, so a Done or To Do move during a first creation's script waits for nothing. When that creation came from an earlier move, the new move aborts it, and the next creation at the path clears the unrecorded directory it leaves. A removal inside the queue (`removeWorktree`: the move-failure stale cleanup, the startup retry; `moveWorktreeAside`, with a `move aside skipped` line) refuses a held path with a `remove skipped` line and never waits (the waiting removal logs `remove step=creation-wait done in <n>ms`), so it cannot hold the queue for a script's run. The move-failure stale cleanup and the backlog pass each skip a task whole, branch and row included, when a creation holds one of its candidate paths. The orphan-directory sweep skips a held path, and asks again just before it deletes. `withTaskLock` could not do this: four callers already hold it across `ensureTaskWorktree`, and it is not reentrant.
- **An aborted script settles only once its tree is gone.** `spawnWithAbort` kills the tree and then waits for the shell's `close` (every holder of its output pipes has exited), at most `TREE_EXIT_WAIT_MS` (5 s), before it rejects. Until then the creation, and so the registry hold, has not ended. A removal or a new creation at the path never starts while the script is still writing there.
- **A script that runs after its worktree was recorded has a stop of its own.** In the background mode (below) the move that started the script has returned, so no move's signal reaches it. The creation registers an `AbortController` for it (`registerBackgroundSetup`), and `prepareWorktreeForRemoval` calls `abortWorktreeSetup` before it waits, so a Done move, a To Do move, a delete or a project delete stops the install and waits only for its tree to die.

A stale directory's real `node_modules` (an install an aborted creation left behind) is the slow part of clearing it: one create job spent 15.8 s in `remove step=node-modules`. `prepareStaleWorktreeForCreation` clears it before the git phase, outside the queue, so the in-queue clear finds only the checkout. It runs only when worktrees are on for the task and there is no live worktree to reuse.

## Creation Flow

Before the git phase, outside the queue: wait for any creation this task already has in flight, then clear a stale directory's `node_modules` (see [Creation holds the queue for its git phase only](#creation-holds-the-queue-for-its-git-phase-only)).

The git phase, steps 1 to 9, is one `create-worktree:<id8>` job on the per-project queue, opened by `ensureTaskWorktree` around `ensureWorktree`, whose body is `createWorktree`:

1. Create `.kangentic/worktrees/` directory
2. `git fetch --no-auto-gc origin <baseBranch>` (best-effort). `--no-auto-gc` skips the
   `git maintenance run --auto` a fetch ends with. Windows cannot detach that maintenance, so a gc
   that comes due runs inside the fetch: measured 2.06 s against 0.11 s without it on Windows,
   with no difference on Linux, where it detaches. Every fetch Kangentic runs passes
   `--no-auto-gc` (this base fetch, the background sweep, and the branch picker's remote-branch
   fetch), so maintenance runs on the next commit, or on a fetch you run yourself. The start point
   is `origin/<baseBranch>` only
   when the fetch actually lands that ref; otherwise it falls back to the ref
   `resolveWorktreeBase` already verified (`verifiedStartPoint`), which may itself be
   `origin/<baseBranch>` for a base that was only ever fetched and never checked out locally.
   A fetch exiting 0 is not proof the ref landed (a narrowed `remote.origin.fetch` refspec, or a
   fetch that only populated `FETCH_HEAD`), so both call sites re-verify before trusting it.
3. Check if branch already exists (stale branch from failed cleanup, or custom branch)
4. Clean up the stale worktree directory if it exists on disk. If removal fails because a process holds the directory as its current directory (Windows pinned-CWD) and the leftover is an empty husk, reuse it in place; if it is non-empty or cannot be inspected, fail with an actionable error naming the likely blocker (an open terminal or editor, the `/preview` dev server, or antivirus). (`git worktree prune` itself is NOT part of creation - it only runs on the removal path, `pruneWorktrees()`, and the debounced background prune.)
5. If branch exists: `git worktree add [--force] <worktreePath> <branchName>`
6. If new branch: `git worktree add [--force] -b <branchName> <worktreePath> <startPoint>` (`--force` is added only when reusing an empty husk from step 4, to clear any stale `.git/worktrees/` registration whose directory still exists)

   Both forms run with `-c checkout.workers=N`, where N is the core count capped at 8, so the
   checkout writes files with parallel workers. Measured `worktree add` on a 3,388-file repo: 1.65 s
   down to 0.66 s on Windows, 269 ms down to 111 ms on Linux. git passes `-c` to the inner
   `reset --hard` and to every worker, `core.longpaths` included. Files that need a filter driver
   (Git LFS), symlinks, and case-colliding paths are still written one at a time, git stays
   sequential below 100 files, and git before 2.32 ignores the key. When the user has set
   `checkout.workers` in their own git config, Kangentic passes nothing and their value applies.
7. On Windows: enable `core.longpaths` (see below)
8. Set up sparse-checkout (see below)
9. `git config --worktree kangentic.baseBranch <baseBranch>`, after sparse-checkout because that
   step enables per-worktree config (see [Base Branch Resolution](worktree-lifecycle.md#base-branch-resolution))

The setup phase, steps 10 to 12, runs after the job ends (`setUpWorktree`, which is `prepareWorktreeFiles` for steps 10 and 11, then `runWorktreeInitScript`). The worktree is recorded on its task only once step 12 succeeds, except in the background mode described under [The agent starts while the script runs](#the-agent-starts-while-the-script-runs):

10. Copy optional files from repo root (configured via `config.git.copyFiles`)
11. Create `node_modules` junction/symlink to root repo's `node_modules` (skipped when `config.git.linkNodeModules` is `false`, so a worktree can own its own dependencies)
12. Run the Post-Worktree Script if `config.git.initScript` is set (see below)

Each step logs its time in the removal path's format, `[WORKTREE] create step=<name> done in <n>ms`: `stale-node-modules` (before the job), `fetch`, `stale-dir`, `worktree-add` and `configure` (in it), then `copy-files`, `link-node-modules` and `init-script` (after it). The job's own `[GIT_QUEUE] done create-worktree:<id8> in <n>ms` line is the git phase's total.

Creation writes no `~/.claude.json` trust entry. The adapter's `ensureTrust` writes it before each spawn, for whatever directory the agent runs in (see [Claude Code](../../integrations/agents/claude-code.md#trust-management)).

## Windows Long Paths

On Windows, projects with deeply nested file paths (e.g. .NET migrations, `node_modules` trees) can exceed the default 260-character path limit when checked out into a worktree under `.kangentic/worktrees/<n>/`. This causes `git worktree add` and subsequent git operations to fail with "Filename too long" errors.

Kangentic enables `core.longpaths` in two places:

1. **`git worktree add`** - the `-c core.longpaths=true` flag is passed as a per-command config override so the checkout itself succeeds. This does not modify any persistent git config.
2. **Repository config** - after creation, `git config core.longpaths true` runs in the worktree. A plain `git config` from a linked worktree writes the repo's SHARED `.git/config`, so the setting applies to every worktree and the main checkout, and all subsequent operations (sparse-checkout, agent commits, merges) also use extended-length paths.

This setting uses the `\\?\` extended-length path prefix on Windows. macOS and Linux have 1024-4096 byte `PATH_MAX` limits and are unaffected - the setting is only applied on `process.platform === 'win32'`.

`core.longpaths` covers git itself. Node and the JVM handle long paths on their own (measurement:
1,958 files past MAX_PATH in a real worktree, with `npm install` and Gradle both succeeding), so the
toolchains that run inside a worktree are largely unaffected too. See
[Windows MAX_PATH is mostly not the wall people expect](../../platforms/windows.md#windows-max_path-is-mostly-not-the-wall-people-expect) for the
measurements and for the one limit that does bind, which is CMake's own object-path policy rather
than the operating system.

## node_modules Linking and the Post-Worktree Script

By default Kangentic symlinks (junction on Windows, directory symlink on POSIX) the root repo's `node_modules` into each new worktree so agents can run typecheck/tests immediately without a slow `npm install`. The link is non-fatal: if the root has no `node_modules` yet, the step is skipped silently.

The shared link has a trade-off: the worktree runs the *root's* dependencies, not the branch's, and a worktree `npm install` writes back through the link into the main repo. For a branch that changes dependencies, set `config.git.linkNodeModules` to `false` to skip linking, then use the Post-Worktree Script to install the worktree's own dependencies.

A workspace repo (npm, Yarn or pnpm workspaces) should turn linking off, for two more reasons:

- **Workspace packages resolve to the main checkout's source.** A workspace package's entry in the root `node_modules` is a junction (a symlink on POSIX) to that package's folder in the main checkout. Through the linked `node_modules`, a worktree imports main's code for every workspace package, not the branch's. Kangentic itself escapes this only because `tsconfig.json` paths and the `vite.config.mts` alias send `@kangentic/protocol` to the worktree's own `packages/protocol/src`; a repo without such aliases runs main's packages.
- **pnpm keeps a `node_modules` in every workspace package.** Linking covers only the root one, so each package in the worktree has none.

Such a repo sets `linkNodeModules` to `false` and installs in the Post-Worktree Script (`pnpm install --frozen-lockfile`, `npm ci`).

The **Post-Worktree Script** (`config.git.initScript`, surfaced as "Post-worktree script" in Git settings) runs once in each new worktree, after files are copied and `node_modules` is linked (or deliberately skipped). It runs through the platform shell - `cmd.exe` on Windows, `/bin/sh` on POSIX - so the same configured command works cross-platform for simple cases like `npm install`. While it runs, the task card shows a "Running setup script..." phase. For a move or an auto-spawn the agent starts while it runs (next section); every other caller starts the agent only after it succeeds.

The script runs after the creation's git phase has left the per-project git queue (see [Creation holds the queue for its git phase only](#creation-holds-the-queue-for-its-git-phase-only)), so a slow install no longer stalls other tasks' worktree creation, Done cleanup or auto-fetch. The `[INIT-SCRIPT]` completed, failed and stopped lines each carry the script's elapsed time.

Disk is the one thing a script still shares. A Done move's in-place delete of a real `node_modules` slowed an install that ran beside it. So `runInitScript` counts the scripts running in every project (`isAnyInitScriptRunning`, `whenNoInitScriptRuns`), and a Done move's deferred delete waits before each batch while the count is above zero. See [Done removal](worktree-lifecycle.md#done-removal).

**A script that runs git** (`git submodule update`, `git lfs pull`) runs alongside Kangentic's own git work in the project, not inside the queue. git's lock files keep the two from corrupting each other's state. When both want the same lock at once, the command that loses fails with git's `Unable to create '...lock': File exists`. If the script's command loses, the script fails, and so does the creation, like any non-zero exit; moving the task again retries it. There is no setting to put the script back inside the queue: one would bring back the wait this change removed, for every task in the project.

The script is **fatal**: a non-zero exit or a timeout (10-minute cap) rejects worktree creation and fails the task move / agent spawn, surfacing the captured output. The worktree directory is left on disk on failure, exactly as a failed file copy is; the next attempt reuses or recreates it. The background mode is the one exception, below.

### The agent starts while the script runs

Measured on one project's task, 43 s passed between the previous task's Done and the new agent's SessionStart: 27.0 s of `pnpm install --frozen-lockfile`, then 7.8 s of trust and CLI start, one after the other. The two now overlap. `handleTaskMove` and `autoSpawnForTask` pass `ensureTaskWorktree` an `initScript` mode (`resolveInitScriptMode`); create, promote, unarchive and resume do not, and the branch switch must not, since it copies uncommitted changes into the new worktree at once. Only a new worktree with a script set takes a mode. A reused one has no script to run.

- **Hold the prompt (the default, `git.holdPromptForInitScript` on).** After steps 10 and 11, `createEarlyAgentLauncher` starts the task's agent while step 12 runs: hidden, with no prompt, in the unrecorded worktree (`TransitionEngine.launchEarlyAgent`; [Spawn flow](../sessions/spawn-flow.md#an-agent-started-during-the-setup-script)). The worktree is recorded only once the script succeeds, as before, and `ensureTaskWorktree` returns the agent's handle. The move's Phase 3 spawn adopts it and types the first prompt in, so every enter row still runs after the script. A script that fails or is cancelled discards the agent (kill, wait for its exit, remove its row) before the creation's hold ends, then rejects as it always did: the move is rolled back with `Worktree setup failed: ...`, and the next creation at the path never clears the directory under a live agent. Only an agent whose adapter's `firstPromptMayBeTyped` answers true for the launch starts early (Claude on its fullscreen renderer), and only when the column's first enter row needs the agent (or there is none), so a script row that prepares files still runs before the agent exists.

  The spawn adopts the agent only once its TUI has entered the alternate screen, where its input box is (`awaitAltScreen`), waiting at most until 15 s after the agent's launch. Measured in a preview on Claude Code 2.1.316: a repo whose `.mcp.json` names a server the project has not approved boots to "New MCP server found in this project" outside the alternate screen, with "Continue without using this MCP server" selected, so a typed prompt's Enter would answer it and the prompt would be lost. Such an agent is discarded and the spawn launches as before, with the prompt on its command line, and the user answers the screen. With a 20 s script, measured in the same preview, the agent launched 0.36 s into the script, was adopted 0.16 s after the script ended, and had its prompt pasted 4.3 s later, most of it the repaint after its terminal mounted. That run waited for 1.5 s of quiet before pasting; the wait is now 0.5 s (`OPENING_QUIET_MS`) and was not measured again. The old path took 7.8 s from the script's end to SessionStart before the prompt ran.
- **Don't hold it (`git.holdPromptForInitScript` off).** After steps 10 and 11 the worktree is recorded and `ensureTaskWorktree` returns while the script runs on under the creation's hold, with the stop above. The agent starts on its prompt at once, any agent, and the prompt opens with one line naming the script and asking the agent not to run it. A failed script no longer rolls anything back, since the agent may already have edits in the worktree: the task gets a "Setup script failed" warning (`TASK_SPAWN_WARNING`, kind `setup-script-failed`), and the agent gets the error as a held message (`holdTaskMessage`), pasted after its turn or carried in its next opening message. For Claude on its fullscreen renderer the paste also waits for the alternate screen (`awaitInputReady`), so a note that arrives while Claude still shows an MCP approval waits for the user's answer instead of answering it. It saves the whole script as well.

Known gaps:

- **A file the script writes that the agent reads at launch** (an `.mcp.json` it generates) is not there when the agent starts, in either mode. Copy such a file with `config.git.copyFiles`, which runs before the agent starts.
- **An agent stopped at a boot screen costs a wait.** Claude stopped at an MCP approval is discarded only 15 s after its launch. After a script that long it is discarded at once; after a shorter one the spawn waits out the rest. A shorter bound would discard a Claude still booting, which loses the saving every time instead of once. Claude on its classic renderer (a `tui` choice of `default`, which never enters the alternate screen) does not pay it: its launch answers `firstPromptMayBeTyped` false, so it is not started early.
- **A background script that fails, or a quit while it runs, leaves the worktree without its result.** Nothing runs the script again; the agent was told on a failure, and moving the task to To Do and back recreates the worktree.

A cancellation (a superseding move, a cancelled spawn, app shutdown) is not a failure: creation rejects with an `AbortError`, which every caller treats as an abort. That matters for a superseding move. Treated as a failure, the old move's stale-resource cleanup queued behind the new move's own create job on the per-project git lock, ran after it, and deleted the worktree and auto-generated branch the new move had just made (reproduced twice in `/preview`). The half-made worktree an abort leaves is never recorded, so the next creation at that path clears it. Its auto-generated branch survives and the next creation attaches to it. While that branch still sits at the resolved start point, the creation reports its base as it would for a new branch, so `resolved_base_branch` is still recorded.

The ordering that used to protect a superseding move came from the queue: the old move's create job, script included, held it, so nothing at that path ran until the old script was dead. With the script outside the queue, the creation registry gives the same order. The new move's creation waits for the old creation's hold to end before it touches the path, and that hold ends only once the old script's tree is gone. A failure of the old creation that lands after the new one took the path no longer cleans anything: its stale cleanup finds the newer hold and skips, so it cannot delete the worktree or branch the new move made.

On abort or timeout the script's whole process tree is killed, not only the shell: `taskkill /T /F` on Windows, where cmd.exe always runs the script as a child, and a process-group `SIGKILL` on POSIX, where the script leads its own group. Killing only the shell left whatever the script started (an `npm install`) running in the worktree; on Windows it held the directory open and stalled the next creation at that path by 12 s. The abort settles once the killed shell closes, at most 5 s after the kill (`TREE_EXIT_WAIT_MS`), so the creation does not end while the tree is still dying.

## Sparse-Checkout

Worktrees exclude only `.claude/commands/` from checkout using sparse-checkout in `--no-cone` mode:

```
git sparse-checkout set --no-cone '/*' '!/.claude/commands/'
```

That is one pass: it turns sparse-checkout on and removes only the excluded paths from the tree
`git worktree add` just checked out. `set` takes `--no-cone` from git 2.35. On older git, or when
the version cannot be read, creation runs the two-step form instead:

```
git sparse-checkout init --no-cone
git sparse-checkout set '/*' '!/.claude/commands/'
```

The two-step form is slow on large repos. `init` first applies git's own default (`/*` and
`!/*/`, top-level files only), which deletes every file below the root, and `set` then writes them
all back. On a 3,388-file repo on Windows that pair took about 2.4 s of a 4.1 s creation; the
single `set --no-cone` takes about 0.24 s. The version gate is required: before 2.35, `set` does
not reject `--no-cone` but stores it as an extra pattern. `getInstalledGitVersion`
(`src/main/git/git-version.ts`) reads the version once per process.

**Why only commands are excluded:** Claude Code's discovery behavior differs by artifact type:

- **Commands** walk up the directory tree from the worktree CWD to the main repo's `.claude/commands/`. Excluding them from the worktree prevents duplicate discovery.
- **Skills** and **agents** do NOT walk up. They are only discovered from the project root's `.claude/` directory. Since each worktree is its own project root (has a `.git` file), skills and agents must be present in the worktree checkout to be visible to the agent.

Worktrees get all files including `.claude/settings.json` (so Claude resolves permissions naturally), `.claude/skills/`, and `.claude/agents/`. `.claude/settings.local.json` is untracked (gitignored), so it's not present in worktrees from checkout -- writes to it (from Kangentic hooks or Claude's "always allow") are invisible to git.

Sparse-checkout was chosen over `skip-worktree` because skip-worktree flags get lost during rebase and merge operations. Sparse-checkout survives all git operations.

Two features account for the excluded folder (`WORKTREE_EXCLUDED_DIRECTORY` in `src/main/git/sparse-exclusion.ts`):
- **Switching a task to worktree mode.** The carry of uncommitted changes leaves `.claude/commands/` out (`task-branch.ts`). Without that, `git apply --3way` would write the excluded file back into the new worktree. A command-file edit made in the main checkout stays there.
- **The `@` file search.** It lists files with `git ls-files -t` and drops a skip-worktree (`S`) entry only when its file is missing on disk (`project-entry-search.ts`). That covers a worktree's `.claude/commands/` without hiding a file a developer marked skip-worktree to keep local edits.

Sparse-checkout in a linked worktree needs git 2.26+. On git 2.25.0 every sparse-checkout command fails there, because it cannot create the worktree's `info/` directory (fixed in 2.26). On that or older git the commands fail gracefully: worktrees still work, but `.claude/commands/` will be present, which may cause duplicate command discovery.
