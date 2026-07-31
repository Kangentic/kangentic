---
paths:
  - "src/renderer/components/board/**"
  - "src/renderer/hooks/useBoardDragDrop.ts"
  - "src/renderer/stores/board-store/done-drop-confirm-slice.ts"
  - "src/renderer/stores/board-store/task-completion-slice.ts"
---
# Rule: hide in-flight (completing) tasks at the single lane chokepoint

A Done drop does not persist immediately. It removes the task from `tasks`, holds its id in the
store-level `completingTaskIds` Set, and flies a `FlyingCard` into the dropzone for ~700ms;
`persistCompletion -> moveTask` writes the DB (move + archive) only at the end. For that whole
flight the backend still has the task at its **source** lane, so any `loadBoard()` racing the
fly (an agent-driven `onUpdatedByAgent` / `onAutoMoved` reload, an HMR re-sync) re-injects the
task into `tasks` at its source `swimlane_id`. If a lane renders straight from its `tasks` prop,
the card flashes back in its source column for a frame before vanishing into Done. This bug
shipped and regressed 5+ times because the guard was applied per-lane (only `DoneSwimlane`
filtered `completingTaskIds`, which protected the wrong lane) instead of at the one place every
lane's task list is produced.

The `FlyingCard` mounts SYNCHRONOUSLY on drop, BEFORE the worktree probe: `handleDragEnd` calls
`setCompletingTask` (which mounts the card) and only then awaits `git.checkPendingChanges(...)`,
running the probe CONCURRENTLY with the fly. This closes an earlier blank window. The old order
awaited the probe (~100ms) *before* `setCompletingTask`, so for a worktree-backed task the card
disappeared at the drop point (already hidden by `completingTaskIds`) with nothing rendering it
until the probe resolved. Persistence is now held back by a completion gate (see
`completion-gate.ts`) that joins two signals - the fly finishing AND the move being approved
(probe clean, or the pending-changes dialog confirmed) - so the move runs exactly once and never
before the probe and any required confirmation resolve. A task with no worktree has no probe and
persists when the fly ends.

## The rule

`KanbanBoard`'s `tasksPerLane` memo is the **only** place lane membership is overridden, both by
exclusion and by redirection. It is the single chokepoint that buckets `tasks` into per-lane
arrays, so a guard applied there is reconciliation-proof against any mid-flight reload, and a
guard applied per-lane protects only the lane that implements it.

Two guards live there:

- **`completingTaskIds` (exclusion).** Skips any task whose id is in the Set, so a completing
  task renders in **no** lane (source or Done) for the entire flight.
- **`lanePins` (redirection).** Buckets a task with an optimistic cross-lane move still in flight
  into its pinned destination rather than the lane the server last reported. Same bug class on
  the non-Done side: `loadBoard()` has no staleness guard and replaces `tasks` wholesale, and
  `taskContentsMatch` compares `swimlane_id` explicitly, so the server row always wins over an
  optimistic move. `endBoardDrag()` runs at the top of `handleDragEnd`, well before `moveTask` is
  called, and drains parked reloads synchronously, so a reload's `tasks.list()` can be issued
  before the move's DB write and report the pre-move lane when it resolves. Dragging two tasks in
  quick succession made this visible as a card snapping back to its source column.

A pin's drop rule is content-based and must stay that way: it holds only while a payload reports
the task at BOTH the pre-move lane and the pre-move `updated_at`. Matching on lane alone leaks
forever when the server puts the task back at its origin (an auto-move, or a rejected move) -
a stranded pin is strictly worse than the snap-back it fixes. Every uncertainty resolves toward
dropping. See `src/renderer/stores/board-store/lane-pins.ts`.

- Individual lane components (`Swimlane`, `DoneSwimlane`, any future lane renderer under
  `src/renderer/components/board/`) MUST NOT read `completingTaskIds` or `lanePins` to re-derive
  their own task list. They receive an already-bucketed `tasks` prop from `tasksPerLane`; a
  second per-lane filter is redundant at best and reopens the source-lane gap at worst (it only
  ever guards the lane that implements it).
- The producer side is unaffected: the store actions `addCompletingTaskId` /
  `removeCompletingTaskId` / `pinTaskLane` / `dropTaskLanePin` and the state definitions live in
  the board store (`src/renderer/stores/board-store/`) and are the source of truth the chokepoint
  reads.
- **Every task-list payload goes through `applyTaskListPayload`** (`lane-pins.ts`), never a bare
  `applyStructuralSharing(state.tasks, ...)`. Reconciling pins in the same `set()` as the payload
  keeps the two atomically consistent and makes the drop rule mechanically enforceable, rather
  than depending on someone remembering to add a `useEffect`.
- Populate the guard synchronously the moment a Done drop is detected, BEFORE any `await` in
  `handleDragEnd` (the `checkPendingChanges` probe). `handleDragEnd` calls `addCompletingTaskId`
  and then `setCompletingTask` (mounting the `FlyingCard`) synchronously, so the card is filtered
  out and re-rendered as the fly the same tick dnd-kit restores it; releasing happens in
  `persistCompletion`'s `finally` (success) or `cancelCompletion` via `cancelPendingDone` (the
  user declines the pending-changes confirm). On cancel, `cancelCompletion` also re-inserts the
  stashed task object into `tasks` in the same atomic `set`, so the card never has a frame where
  it is in neither `tasks` nor the `FlyingCard`. Persisting (`persistCompletion -> moveTask`)
  waits for both the fly to finish and the probe/confirm approval; nothing writes the DB before
  then.
- Do not "fix" a recurrence by tuning the drop animation, the `DragOverlay` `dropAnimation`, or
  the `FlyingCard` again. Those are settled; the durable guard is the chokepoint filter. The
  `FlyingCard` mount/probe ordering and the gate are likewise settled.

## Enforcement (self-maintaining)

- **Test (mechanical):** `tests/unit/board-completing-task-chokepoint.test.ts` scans
  `src/renderer/components/board/` and fails if any file other than `KanbanBoard.tsx` references
  `completingTaskIds` or `lanePins`; it also asserts `KanbanBoard` reads both, so the scan cannot
  pass vacuously after a rename. `tests/unit/board-lane-pin-lifecycle.test.ts` covers the pin drop
  rule as a pure-function table (including the bounce-back-to-origin case that a lane-only rule
  would leak) and statically fails any board-store slice that applies a task payload without
  going through `applyTaskListPayload`. Runs in CI via `npm run test:unit`.
- **Test (behavioral):** `tests/ui/move-to-done-reload-no-source-flash.spec.ts` drags a task to
  Done, fires a `loadBoard()` mid-flight, and asserts the card never reappears in its source
  lane (parametrized across multiple source columns). It goes red the moment the chokepoint
  guard is removed. `tests/ui/move-to-done-worktree-await-no-source-flash.spec.ts` covers the
  second window: a worktree task with a slowed `checkPendingChanges` probe must never return to
  full opacity in its source lane during the await. It goes red if the synchronous
  `addCompletingTaskId` on drop is removed. `tests/ui/move-to-done-continuous-visibility.spec.ts`
  asserts the stronger property: with a slowed probe, every frame from drop onward shows either a
  `.drag-overlay` or a `.flying-card` (no blank window), and the task is not archived before the
  probe resolves (the persistence gate). It goes red if `setCompletingTask` moves back after the
  probe, or if persistence stops being gated.
- **Review:** `/code-review` flags per-lane completing-task filtering on board changes.

## Scope

Board lane rendering under `src/renderer/components/board/`, plus the completing-task lifecycle in
`useBoardDragDrop.ts` (where the guard is populated on drop), `task-completion-slice.ts` (the gate
and `cancelCompletion` restore), and `done-drop-confirm-slice.ts` (which delegates cancel to
`cancelCompletion`). The mechanical no-per-lane-filter scan is scoped to
`src/renderer/components/board/`; the synchronous-hide timing is covered by the behavioral specs.
The singular `completingTask` field (which drives the `FlyingCard` animation in `KanbanBoard`) is
a different concern and is not governed by this rule.
