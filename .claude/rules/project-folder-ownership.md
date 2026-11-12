---
paths:
  - "src/main/project-ownership/**"
  - "src/main/transition-engine/resource-cleanup.ts"
  - "src/main/transition-engine/session-startup/**"
  - "src/main/ipc/handlers/projects.ts"
  - "src/main/ipc/handlers/sessions.ts"
  - "src/main/ipc/helpers/spare-worktrees.ts"
  - "src/main/config/config-manager.ts"
  - "src/main/git/worktree-manager.ts"
  - "src/main/pty/session-manager.ts"
  - "src/main/pty/lifecycle/session-spawn-flow.ts"
  - "src/main/pty/spawn/pty-spawn.ts"
  - "src/renderer/components/board/task-card-view.tsx"
---

# Rule: a database proves it owns a project before anything acts on its folder

A project's folders live under `<project>/.kangentic/` and its rows live in a per-project database
in the instance's data directory, and nothing tied the two together. On 2026-11-05 a second
instance, started with a copy of `index.db` and empty per-project databases, opened every
registered project at startup. `pruneOrphanedDirectories` read "not in this database" as "orphaned"
and deleted 23 worktrees, 1,811 session folders and 113 task folders, 216 attachments among them
with no other copy. The 23 tasks left pointing at missing worktrees would have been deleted on the
next restart, and a queued session started `/merge-pull-request` in the home directory. A preview
then wrote its stub CLI into all 16 real `.kangentic/config.json` files, through a read.

An empty database is not evidence that nothing is its own. Any instance on another data directory
can do all of this, so the check lives in the app, not in a warning to whoever runs a rig.

## The rule

- **Only an owner sweeps.** `cleanupStaleResourcesAsync`, `pruneOrphanedDirectories`,
  `purgeExpiredSetAside` and `sweepSpareWorktreesAtOpen` take a `VerifiedOwnership`, and only
  `verifyProjectOwnership` makes one (`src/main/project-ownership/project-ownership.ts`). A pass that
  removes anything under `.kangentic/` on a guess takes the proof too, and derives its path from it,
  so a proof for one project cannot sweep another. Never cast one into being.
- **The proof is a token, never the project id.** A copied `index.db` carries the real ids at the
  real paths, so an id in the marker would match. The token lives in the per-project database
  (`schema_meta.folder_owner_token`) and in `.kangentic/project-owner.json`, which also names the
  database that wrote it, because a full copy of the data directory carries the token too.
- **A claim needs evidence.** With no valid marker, a database claims a folder only if it holds a
  task and either a row names an entry on disk or the swept folders are empty. An empty database
  never claims. A live database a marker names is never overwritten: that folder is `foreign`, and a
  marker for another folder (a copy) or a database that is gone (a moved data directory) falls
  through to evidence. The paths are compared with their links resolved, so a junction or symlink
  to the same folder or database is not a copy. A failed marker write is no ownership, the safe
  direction.
- **A foreign folder gets no recovery either.** `runColdOpenPasses` skips `resumeSuspendedSessions`,
  `autoSpawnTasks` and the Command Terminal restore there: a copied database would resume agents in
  another instance's worktrees. An `unclaimed` folder still recovers, because its rows are its own.
- **A non-owner writes nothing.** No marker, no token. The accepted cost is a disk leak: a re-added
  project with leftovers, or a folder whose database was lost, may never sweep them. The Done retry
  and the `removed-worktrees/` drain wait for an owner too, because a copied database's rows can be
  stale, so only `sweepAutomationRuns` runs without the proof.
- **A sweep does not destroy what it cannot rebuild.** `worktrees/` and `tasks/` entries move to
  `.kangentic/set-aside/<kind>/` (`src/main/project-ownership/set-aside.ts`) for
  `SET_ASIDE_RETENTION_MS`. `removed-worktrees/` cannot hold them: it is drained in full on every
  pass. A failed move keeps the folder, with no fallback delete. `sessions/` entries are deleted,
  behind the proof, because nothing in them is a person's.
- **A pass that would clear most of a folder clears none of it.** `wouldClearMostOf` refuses at 5 or
  more orphans that are over half the folder, and reports the refusal to Sentry, so a false trip on
  a real owner gets noticed. Measured on 16 real boards on 2026-11-05: no orphans in any folder.
- **A missing worktree never deletes a card, and never moves its agent.** The branch outlives the
  folder. Startup recovery keeps the row and shows the task as not running, with a suspended
  placeholder whose reason is `worktree-missing`, and Resume recreates the folder. `git worktree add`
  refuses a path still registered, so `createWorktree` prunes first when it recreates one.
  `demoteMissingWorktree` is only for a task `canRecreateWorktree` says nothing can make one for, and
  `ensureTaskWorktree` applies it at runtime the same way: a start that makes no worktree for a task
  whose folder is gone demotes it rather than handing the spawn a path it will refuse
  (`session-resume-worktree-gone.test.ts`). Never for a project on an SSH host: its worktree folder
  here is a stand-in, and only the host proves a path absent ([[ssh-remote]]).
- **A start that never reached an agent says so on its card.** `Session.startBlockedReason` replaces "Paused" in the footer, on the board card and the Monitor card alike, with the reason in the tip. Every refused or failed start sets it, a direct one (`showRefusedStart`) included, because a toast closes.
- **A read never copies this instance's settings into a project.** `getEffectiveConfig` already
  merges global under project, so `parseProjectOverrides` needs no seed. Its remaining rewrites
  migrate the file's own text.

## Enforcement (self-maintaining)

- **Type system:** every pass above requires `VerifiedOwnership`, and `tsc` (`npm run typecheck`)
  fails a caller without one.
- **Test (scan):** `tests/unit/project-folder-ownership-proof.test.ts` fails on a `VerifiedOwnership`
  made anywhere in `src/` but `project-ownership.ts`, the one way past that type check.
- **Test (behavior):** `tests/unit/project-ownership.test.ts` runs every branch on real folders and
  real databases, the incident and a full data directory copy included.
  `tests/unit/project-folder-sweep.test.ts` runs the sweep with nothing mocked between it and the
  disk. `tests/unit/project-open-lifecycle.test.ts` pins the gate on all three open paths.
  `tests/unit/prune-orphaned-dirs.test.ts` pins the refusal and the set-aside.
  `tests/unit/worktree-recreate-after-folder-gone.test.ts` pins the prune on real git.
  `auto-spawn-first-spawn-lock-wiring.test.ts` and `resume-suspended-profile-scoped.test.ts` pin that
  recovery keeps the task, and `config-manager.test.ts` that a read writes no `cliPaths`.
  `tests/unit/session-resume-worktree-gone.test.ts` pins the runtime demotion on real git, and
  `task-git-remote-worktree-skip.test.ts` that a row the caller's copy disagrees with, or a project
  folder that is gone, demotes nothing.
  `tests/e2e/project-folder-ownership.spec.ts` replays the incident across real launches: a second
  instance on a copied `index.db` sweeps nothing, the owner then does, and a card whose worktree went
  while the app was closed reads Worktree missing and comes back through Resume.
  `tests/ui/card-start-blocked.spec.ts` pins each footer and tip, and
  `session-queue-folder-recheck.test.ts` that every refusal leaves the reason on a row.
- **Review:** `/code-review` flags a new pass that removes folders on a row's absence with no proof.
  Row-driven cleanup (a To Do reset, a Done retry) acts on what a row names and is not a guess.

## Scope

Cold-open startup passes and the folders under `.kangentic/`. A user's own action (a project delete, a
relocate, a Done move) needs no proof: the user asked, and `discardProjectSpares` runs without one.
Board-driven spawns are not gated: an instance may run an agent where the user points it. An agent
never starts in a folder that is gone, on any path ([[spawn-entry-point-parity]]). A spare worktree's
build is not gated either: it starts only from a task's own start, a foreign folder runs none at a
cold open, and it adds a folder rather than removing one.
