---
paths:
  - "src/renderer/stores/session-store.ts"
  - "src/renderer/stores/session-store/**"
  - "src/renderer/App.tsx"
  - "src/main/pty/session-manager.ts"
  - "src/main/pty/session-registry.ts"
  - "src/main/ipc/handlers/sessions.ts"
---
# Rule: the renderer session store is a replica, and a removal is its own push

The renderer's `useSessionStore.sessions` is a replica of main's session registry. Main keeps it
current with pushes, the renderer writes it optimistically ahead of main (a To Do move evicts the
task's rows the instant the drag lands), and `syncSessions` re-lists it on boot, on a Fast Refresh,
and on a cold project switch. Every user-visible session surface reads the replica, not the DB:
the board card, the task-detail body, the bottom panel's tabs, the agent count, the context bar.

This class of bug has shipped at least six times, each time as one writer or one push getting the
contract slightly wrong: a ghost `running` row after a To Do reset (#636), a stale suspended row
painting Resume over a live agent, an index left pointing at an evicted row, a handoff flashing
Resume (#638), an unarchive into To Do keeping a paused row, and #661, where main announced a
removal as a forced-`exited` status push, the status handler upserted it, and a To Do card opened
a black terminal with a populated context bar instead of the edit form.

## The rule

- **A removal is its own push.** A row leaving main's registry (`remove()`, `removeByTaskId()`,
  the exited-row eviction in `registerSuspendedPlaceholder`) emits `session-removed`
  (`IPC.SESSION_REMOVED`, `sessions.onRemoved`) with the row's last snapshot, before the row is
  deleted. It never announces itself on `session-changed`.
- **A status push only upserts; a removal push only removes.** `sessions.onStatus` maps to
  `upsertSession`, `sessions.onRemoved` maps to `removeSession`, and neither handler does the
  other's job. `removeSession` is the one push-driven writer that takes a row OUT.
- **Forgetting a session forgets everything keyed on it.** Dropping rows by id goes through
  `withoutSessions` / `withoutSessionsIndexed` (`session-index.ts`), which also scrub `sessionUsage`,
  `sessionActivity`, `sessionActivityReason`, `sessionEvents`, `sessionFirstOutput`,
  `seenIdleSessions`, and `sessionMessageTrails`, and clear a matching `activeSessionId`. Dropping
  rows by task goes through `withoutSessionsForTasks`. No writer filters `sessions` by hand and
  leaves the index or a map behind.
- **A sync never resurrects and never drops what arrived in its gap.** `syncSessions` skips a
  listed row that was held when the sync started and is gone when it lands (removed mid-gap), and
  keeps a row that was not held at the start, is held now, and is absent from the list (spawned
  mid-gap). Session ids are minted once per spawn, so both tests are unambiguous.
- **A todo-role task is sessionless.** Main tears the session down on every move into a todo-role
  column and both spawn chokepoints refuse the To Do and Done roles regardless of `auto_spawn`. The
  renderer therefore treats a STALE row for such a task as stale:
  `taskDetailSurfaceFor(kind, laneRole)` takes the lane as a required parameter and is `'inert'`
  there, `TaskCard` decides edit mode through that classifier, and `useTaskSessionState` resolves
  the session to null.

  **The lane never suppresses a LIVE session**, because the lane itself can be behind. The board's
  `tasks` only move on a `loadBoard()`, so a move made without the board store's optimistic write
  (an agent-driven or MCP move, a raw `tasks.move`) leaves the card and the detail window reading
  the OLD lane while main has already moved the task and spawned its agent. The bound is therefore
  liveness, not the lane alone: `KIND_IS_LIVE_SESSION` in `task-progress.ts` exempts the row-backed
  live kinds, and the hook exempts a row whose status is live (`isLiveSessionStatus`). A
  `preparing` LABEL is not a live row and stays suppressed.

  That is the same hazard that rules out a store-level reconciler dropping rows by lane, and it is
  easy to reintroduce one layer up: the first version of this change suppressed on the lane alone
  in the render path, and three E2E terminal specs caught it blanking a live agent's terminal.
- **An intentional exit is not a status.** `sessions.onExit` returns early for an intentional exit
  because it cannot tell a suspend from a hard end; a main path that ends a session deliberately
  must follow with the push that says what happened: `suspend()` (a `suspended` status),
  `remove()` (`session-removed`), or, for a caller that keeps the row after `kill()` +
  `awaitExit()`, `announceSessionEnded()` (the resolved status on `session-changed`). A bare
  `kill()` with none of these leaves the replica at `running`; the `cleanup_worktree` transition
  action shipped that way.
- **`session-removed` is the last edge a session has, so consumers that keep per-session state
  drop it there:** the activity-interval recorder closes the session's open interval from the
  payload's project id (the row is gone from the registry by the time its exit lands), and the
  message-trail tracker drops its state and trailing timer.

## Enforcement (self-maintaining)

- **Test (property):** `tests/unit/session-store-replica-convergence.test.ts` drives the real
  store through App.tsx's push mapping over 300 seeded random interleavings of spawns, suspends,
  crashes, To Do moves (evict, then teardown pushes), direct removals, usage and activity ticks, and
  stale syncs, and asserts the replica ends equal to the model registry with no stray map keys. It
  pins App.tsx's handler mapping by source so the model cannot drift from the app. Runs in CI via
  `npm run test:unit`.
- **Tests (emits):** `tests/unit/session-manager-remove-emit.test.ts` pins that `remove()` emits
  `session-removed` once, before the delete, and no `session-changed`;
  `tests/unit/session-manager-placeholder-emit.test.ts` pins the placeholder's evicted-row removal;
  `tests/unit/session-manager-announce-ended.test.ts` pins `announceSessionEnded`.
- **Test (kill sites):** `tests/unit/session-kill-followup.test.ts` scans every `kill(` /
  `killByTaskId(` call site under `src/main` and fails unless a `remove`, `suspend`,
  `announceSessionEnded`, cleanup helper, or inline status/removal emit follows within 40 lines,
  or the site is allowlisted by its own line with a reason. A line-order scan, not control flow;
  `tests/unit/transition-cleanup-worktree.test.ts` pins the one site that needed the announcement.
- **Tests (consumers):** `tests/unit/activity-interval-recorder.test.ts` pins that a removal closes
  the interval a direct `remove()` used to strand; `tests/unit/message-trail-tracker.test.ts` pins
  the eager drop.
- **Tests (store):** `tests/unit/session-store-remove-session.test.ts` pins `removeSession` and
  both sync-gap cases; `tests/unit/session-index-eviction.test.ts` scans the board slices for a
  hand-rolled `sessions.filter`; `tests/unit/session-display-state.test.ts` pins the lane table and
  the two consumers that turn it into behavior.
- **Tests (behavior):** `tests/ui/todo-reset-no-ghost-session.spec.ts` and
  `tests/ui/todo-stale-exited-row-opens-edit.spec.ts` drive the real store over the mock, whose
  `tasks.move` fires the removal push for a todo-role move the way main does.
- **Review:** `/code-review` flags a new `sessions` writer that bypasses the index helpers, a new
  registry-row exit without `session-removed`, and a new push handler that does another push's job.

## Scope

The renderer session replica (`src/renderer/stores/session-store.ts`, `session-store/**`, the
session-push subscriptions in `App.tsx`) and the main-side registry exits that feed it
(`session-manager.ts`, `session-registry.ts`, the forwarders in `ipc/handlers/sessions.ts`). The
Command Terminal's `transientSessions` map is renderer-only pairing state and is not the replica,
though its removers scrub through the same helper.
