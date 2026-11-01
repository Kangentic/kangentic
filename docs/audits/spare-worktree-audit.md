---
type: Audit
title: Spare worktree audit
description: "Whether to keep one pre-installed spare worktree per project (2026-10-31): a pnpm workspace's 25 s install becomes a 4.8 s claim, a moved spare breaks every package link, and the four bars set before measuring pass, the claim bar narrowly, so build it for projects with an init script, adopted in place, never moved."
tags: [audit, performance, worktrees, init-script]
sources:
  - resource: src/main/git/worktree-manager.ts
  - resource: src/main/git/task-worktree-folder.ts
  - resource: src/main/ipc/helpers/task-git.ts
  - resource: src/main/transition-engine/resource-cleanup.ts
  - resource: src/main/git/git-fetch-scheduler.ts
  - resource: scripts/measure-spare-worktree.mjs
---
# Spare worktree audit (2026-10-31)

A task that starts in a worktree waits for its Post-Worktree Script (`git.initScript`) before its
agent starts. The idea measured here: keep one spare worktree per project with that script already
run, and let the next task take it.

**Verdict: build it, scoped.** Keep a spare only for a project that sets an init script. Adopt the
spare where it is, under its own folder name, and never move it. Refill it only once no init script
is running in that project. All four bars pass, the claim bar narrowly. On the pnpm workspace
measured, a served start saves 17.5 s, about a minute a day on the one project here that uses an
init script. For a project with no init script (the default) a spare saves 1.6 s, too little to
build for.

Bar 1 assumes the agent starts while the init script runs. Build the spare only after the change
that does that has landed, and re-measure then (see "When to revisit"). The cost a user sees is a
non-numeric worktree folder for the life of every task that takes a spare.

## The bars, fixed before measuring

The doc recommends building only if all four hold on the pnpm workspace:

1. **A served start saves 10 s or more** at the median, with
   `saving = max(install, 7.8 s spawn) - max(claim, 7.8 s spawn)`. The 7.8 s is the agent's start
   (spawn until SessionStart) measured from logs on the same project, which overlaps the install
   once the agent starts alongside the init script.
2. **A current spare is claimed in 5 s or less** end to end, with no folder move and no full
   reinstall.
3. **One spare serves 50% of starts or more.** A start is served when the start before it was more
   than one refill earlier (the git phase plus a cold install, about 26 s).
4. **The idle cost is at most 1 GB** of free space per spare, and the only background work is a
   fast-forward per base move plus an install when the lockfile changed.

| Bar | Measured | Holds |
| --- | --- | --- |
| Saving per served start | 17.5 s median (17.4 to 21.4 s) | yes |
| Claim of a current spare | 4.8 s median (4.6 to 5.3 s), adopted in place | narrowly; over 5 s under load |
| Starts one spare serves | 44 of 78 (56%) | yes |
| Idle cost | 45 MB of free space, no background work needed | yes |

## Can a spare be renamed into place before the session starts?

The question assumed a task's worktree folder is derived from its branch. It is not. The folder is
`worktree_folder`, else the folder its stored path names, else the task's display number
(`taskWorktreeFolderFor` in `src/main/git/task-worktree-folder.ts`). It is written once
(`setWorktreeFolder`, `WHERE worktree_folder IS NULL`), has no format check, and nothing recomputes
it from the branch. Numeric folders replaced the branch-named ones on 2026-07-30.

Nothing keyed on a worktree's path exists before its first spawn. The Claude transcript folder, the
`~/.claude.json` trust entry (`ensureTrust` at spawn) and `sessions.cwd` are all made by the first
agent. Session directories, the MCP URL, `KANGENTIC_TASK_ID` and the browser cookie jar are keyed
by session or task id. So the identity rules allow either a move or an adoption, as long as it
happens before the spawn.

The install does not allow a move. pnpm on Windows links packages with junctions, and a junction
holds an absolute target. `node_modules/.modules.yaml` also records an absolute `virtualStoreDir`.
Three runs of `git worktree move` on an installed spare:

- The move itself took 66 to 67 ms, and every sampled package link was dangling after it.
- Running the init script as the project configures it (`pnpm install --frozen-lockfile`) printed
  pnpm's "modules directories will be removed and reinstalled" prompt, and with stdin closed it
  exited 0 in 433 to 479 ms. It changed nothing. The links stayed dangling and `virtualStoreDir`
  still named the old folder. An init script reports success over a broken install here.
- A forced purge (`--config.confirm-modules-purge=false`) repaired it in 48.9 to 60.7 s, median
  54.3 s. That is twice a cold creation.

So a spare is adopted in place. The task records the spare's own folder as its `worktree_folder`,
for good. That needs no rule change. It does change two things a user sees: the window title and
the `/preview` title show `#N` only for a numeric folder, because they parse the folder name. The
spare's name must also never be all digits, which would collide with a display number.

A first smoke run of the move probe was discarded. The board removed another task's worktree on its
way to Done during that run, so the disk was busy. The three runs above had the project idle.

## How does the spare stay current?

Nothing signals that a project's base moved. `fetchAllRemotesIfStale` returns nothing, and the
fetch scheduler sweeps only the focused project, every 5 minutes (`git-fetch-scheduler.ts`).

A background refresh is not needed for the drift measured. The claim fetches the base anyway (task
creation already does, throttled to once per 30 s), fast-forwards the spare and runs the init script
again:

- A spare 15 commits behind with its lockfile still current: fetch 0.69 s, fast-forward 0.88 s,
  install 3.0 s (a no-op that still checks every package), claim 4.8 s.
- A spare 16 commits behind that missed a lockfile change of about 400 lines: the install caught up
  in 3.9 s (3.7 to 4.3 s), claim 5.5 s (5.4 to 6.1 s). The new packages were already in pnpm's
  store from the main checkout's install.

Bar 2 is the closest call. A check run made while three more agent sessions were starting on the
same machine claimed in 5.5 s, and its spare's own cold install took 30.6 s instead of 25 s. Both
grew by about a fifth, so the saving held, but the claim went over 5 s. A second check, with no
install or test running anywhere on the machine, claimed in 5.0 s. If the claim needs to
come down, a fast-forward when the fetch scheduler sees the base move would take the 0.9 s
fast-forward out of it.

In the 31 days to 2026-10-31, 13 of the project's 106 commits to `main` changed the lockfile. A
spare left for days could fall many lockfile changes behind, and that was not measured. The build
should rebuild a spare whose catch-up install fails, and fall back to a fresh creation for the task
that hit it.

## What does it cost idle, and when is it made?

On the pnpm workspace (several workspace packages, a checkout of about 2,000 files), an installed
worktree holds about 55,000 files, 6,800 directories and 1,900 package links under its
`node_modules`. It cost 45 MB of the volume's free space. pnpm hardlinks package files from its store, so the files themselves
cost almost nothing. A project that installs with npm copies its packages instead, and was not
measured. Idle, a spare does no work: with the catch-up at claim time, nothing needs to watch the
base.

Only one project on the measuring machine sets an init script, out of six that were checked. The
other five link the main checkout's `node_modules`. For them, on the Kangentic repo (a 5,231-file
checkout), a cold creation's git phase took 2.2 s (the add 1.44 s, sparse checkout and config 0.79
s) and the claim's git work 0.66 s, besides the fetch both pay. That is a 1.6 s saving.

When to make it:

- **Not at app start for every project.** Make a spare for a project with an init script after its
  first worktree task starts, so a project never opened costs nothing.
- **Refill after each claim, but only once no init script is running in that project.** An install
  that ran beside a finished task's worktree removal took 27 s instead of about 20 s (measured for
  the change that keeps Done cleanup out of dependents' installs). A removal of this workspace's
  worktree took 35.6 to 42.8 s here.
- **One spare is enough.** Of 78 first starts over 13 days, 35 came within 30 s of the start before
  them, in workflow bursts of 2 to 12 tasks. One spare serves the first start of a burst, and each
  extra spare would serve one more. 44 of the 78 starts (56%) came more than one refill after the
  start before them. Five tasks record their branch as `main` today; counting them as unable to use
  a spare gives 42 of 73 (57.5%).

The project ran 78 worktree starts in 13 days, about 6 a day. At 56% served and 17.5 s each, a
spare saves about a minute a day there, plus the wait whenever someone watches a task start.

## What building it would take

- **Claim in `ensureTaskWorktree`** (`src/main/ipc/helpers/task-git.ts`), the one place every start
  goes through, after its reuse check. Create the task's auto branch name with `git switch -c`, fetch
  and fast-forward to the base, copy `git.copyFiles` again, write `kangentic.baseBranch`, run the init
  script again, then `recordWorktree` with the spare's folder and the new fork point. Fall back to a
  fresh creation on any failure.
- **Eligibility.** No spare for a task with a base branch override, a custom branch name, worktrees
  off, remote execution, or a restore out of Done, which re-attaches its own folder.
- **Never `git worktree move` a spare**, and say why in the code.
- **The orphan sweep.** `pruneOrphanedDirectories`
  (`src/main/transition-engine/resource-cleanup.ts`) deletes any `.kangentic/worktrees/` child no
  task references after 10 minutes. Spares need a reserved name the sweep keeps, and a startup pass
  that deletes a spare whose build was cut off.
- **Titles.** The window title and the `/preview` title read the task's number from its row, not
  from the folder name.
- **Building the spare** runs the init script outside any session. It must not call `ensureTrust`
  on the spare's path, and a process the script leaves running carries no task tag, so the task
  reap will not stop it.

## When to revisit

- When the change that starts the agent while the init script runs has landed. Re-measure the spawn
  time; bar 1 assumed 7.8 s.
- Before turning spares on for an npm project: measure its idle disk cost.
- If the project's lockfile churn rises well above 13 changes a month, measure a spare that is
  several lockfile changes behind.

## How it was measured

`scripts/measure-spare-worktree.mjs` drives each probe against a real repository. It creates its
worktrees under `<repo>/.kangentic/probe-spare/`, on the same volume as task worktrees and outside
the orphan sweep's folder, and removes them afterwards. It mirrors Kangentic's git phase (a detached
`worktree add` with `checkout.workers`, the sparse exclusion of `.claude/commands/`, the
per-worktree `kangentic.baseBranch`) and runs the install through the native shell with stdin
closed, as `runInitScript` does. Each probe ran three times on 2026-10-31 with no install running in
the project, on Windows 11, Node 24.15, git 2.51 and pnpm 10.5. The burst figures come from the
project's own `sessions.started_at`, one first start per task.

The script's probes are p1 (move an installed spare), p2 (create a worktree cold, which also records
the idle cost), p3 (claim a current spare) and p4 (claim a spare that missed a lockfile change).

The command lines:

```
node scripts/measure-spare-worktree.mjs --repo <repo> --install "pnpm install --frozen-lockfile" --repair-install "pnpm install --frozen-lockfile --config.confirm-modules-purge=false" --copy .claude/settings.local.json --probes p1 --runs 3
node scripts/measure-spare-worktree.mjs --repo <repo> --install "pnpm install --frozen-lockfile" --copy .claude/settings.local.json --probes p2,p3,p4 --runs 3
node scripts/measure-spare-worktree.mjs --repo <repo> --install none --link-node-modules --lockfile package-lock.json --probes p2,p3 --runs 3
```
