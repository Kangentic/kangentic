---
paths:
  - "src/main/ipc/**"
---
# Rule: per-task lifecycle locks (`withTaskLock`)

Concurrent operations on the same task (a drag, an auto-spawn, a session resume) interleave
across `await` boundaries and corrupt per-task state: `task.session_id`, PTY sessions, DB row
transitions. `withTaskLock(taskId, fn)` (a per-task `p-queue` with concurrency 1) serializes
them while leaving different tasks fully parallel.

## The rule

Any IPC handler or helper that crosses an `await` boundary AND mutates per-task state MUST wrap
its async region in `withTaskLock(taskId, async () => { ... })` from
`src/main/ipc/task-lifecycle-lock.ts`. Per-task state means: `task.session_id` /
`task.swimlane_id` and companion per-task DB rows; `sessionManager.spawn` / `kill` / `suspend`
/ `removeByTaskId`; and `spawnAgent` / `engine.resumeSuspendedSession` / `autoSpawnForTask`.

Three rules (full detail in the JSDoc on `withTaskLock`):

1. **Cancellation goes OUTSIDE the lock.** Call `AbortController.abort()` on the existing
   controller BEFORE acquiring the lock, so the in-flight holder can observe the abort and
   release. Aborting after acquiring deadlocks.
2. **Not reentrant.** Code inside a locked block must not call `withTaskLock` for the same
   `taskId` (even transitively). Call `sessionManager.*`, repositories, and helpers directly.
3. **Re-check invariants after an unlocked gap.** If you release the lock for slow git I/O and
   re-acquire, re-read the task row and bail if the state you depended on changed.

Do NOT wrap long-running I/O already serialized elsewhere (`ensureTaskWorktree`,
`cleanupTaskResources`, etc. are serialized per project by `WorktreeManager.projectQueues`).
Pure read-only handlers and synchronous-only paths do not need the lock; if you never `await`,
you cannot race.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/task-lifecycle-lock.test.ts` locks same-task ordering, cross-task
  parallelism, error isolation, and bounded Map growth. Runs in CI via `npm run test:unit`.
- **Contract:** the JSDoc on `withTaskLock` in `src/main/ipc/task-lifecycle-lock.ts` is the
  full reference, including the split-lock pattern for handlers that mix DB writes and slow git
  I/O. Canonical usage: `SESSION_SUSPEND` / `SESSION_RESUME` in `handlers/sessions.ts`;
  `autoSpawnForTask` in `helpers/agent-spawn.ts` is the same split (locked gates, unlocked
  worktree and checkout, locked re-check and spawn) for the board-driven spawn chokepoint, and
  `tests/unit/auto-spawn-for-task-guards.test.ts` pins its lock-release ordering.

## Scope

Per-task async mutation in the main process. Cross-project serialization of worktrees is a
separate mechanism (`WorktreeManager.projectQueues`) and is not this lock.
