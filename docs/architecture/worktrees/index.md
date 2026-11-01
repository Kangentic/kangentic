# Worktrees

## Lifecycle

* [Worktree lifecycle](worktree-lifecycle.md) - How a task's worktree is named (branch and numeric folder), which base branch wins, the skip reasons and written creation errors, how hooks and settings reach the session, what each column move and cleanup does to the worktree, how a Done move sets it aside and deletes it while no init script runs, and the background fetch scheduler.
* [Worktree creation](worktree-creation.md) - The per-project git queue with USER and BACKGROUND priorities, removal profiles and the creation registry, then the creation steps from fetch and worktree add to the Post-Worktree Script, core.longpaths, sparse-checkout of .claude/commands and node_modules linking.

## Process cleanup

* [Process reaping](process-reaping.md) - How a terminal transition kills a task's leftover processes by KANGENTIC_TASK_ID tag and directory, what the reap spares, Windows pid reuse, the per-platform readers, the WSL reap, the leftover toast and list, and the removal-failure backstop.

## Tests

* [Worktree test coverage](test-coverage.md) - Which unit tests cover worktree creation, sparse-checkout, the priority git queue and fail-fast removal, the Done move's move aside and deferred delete, base branch resolution, the fetch scheduler, the hook and trust managers, and the real-process reap tests that run on Linux, macOS and Windows runners.
