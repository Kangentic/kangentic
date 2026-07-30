---
paths:
  - "src/main/task-detail/**"
  - "src/main/ipc/handlers/task-detail-ownership.ts"
  - "src/renderer/window-manager/bridge/**"
  - "src/renderer/components/monitor/**"
---
# Rule: task-detail ownership is derived, never accumulated

A task's detail can only be open in one place at a time, and main arbitrates where
(`DetailOwnerRegistry`). That record used to be built incrementally: a host sent `claim` when it
mounted a detail window and `release` when the window closed, and main trusted the resulting map
indefinitely. Any path that lost the release stranded a claim, and a stranded claim made the task
answer `focused-existing` for a window that no longer existed - so every attempt to open it focused
nothing, silently, and the task could never be opened again until the renderer reloaded. Nothing on
screen explained it.

Two such paths were found in a single session, in opposite directions: the monitor's handlers lived
inside a layer that unmounts on close/detach while its window store survives (a claim with nobody
left to report on it or hear `DETAIL_CLOSE_HERE`), and a restored workspace's windows were never
claimed at all (a window on screen that main did not know about, so the same task could be opened a
second time - two xterms on one PTY).

## The rule

- **A host reports its COMPLETE set, main reconciles.** The only ownership mutations are
  `DetailOwnerRegistry.syncOwned(webContentsId, host, entries)` and `releaseAllFor(webContentsId)`.
  There is no per-detail claim or release channel, and the preload API deliberately does not expose
  one, so adding a call is a compile error rather than a silent regression.
- **The set is derived from a window store, by the one shared hook**
  (`window-manager/bridge/useDetailOwnershipSync.ts`). A second reporter can report a partial set,
  which reads as "I no longer host these" and frees windows that are still open.
- **Mount the reporter where it outlives the window store it describes** - a renderer root, never
  inside a layer. Window stores deliberately outlive their subtrees; a reporter that does not is the
  original bug.
- **Reconciliation is scoped to `(webContentsId, host)` for removals and may displace on add.**
  Removal scoping is what makes a handover converge in either interleaving (a stale report cannot
  erase the new owner); displacement is what lets the requester win, and the caller MUST send
  `DETAIL_CLOSE_HERE` to every displaced owner or the detail ends up mounted twice.
- **Abstain rather than report empty** when a host cannot derive its set yet (no open project).
  An empty report is a destructive statement, not a neutral one.
- **Keep the reconcile order-stable.** `ownedElsewhere` iterates in insertion order and the renderer
  compares the result, so re-inserting an unchanged entry reads as a change and needlessly
  re-publishes the focused-session set - which gates whether main streams PTY bytes at all.

## Enforcement (self-maintaining)

- **Type system (primary):** `claim` / `release` do not exist on `ElectronAPI.taskDetailOwnership`,
  so incremental bookkeeping does not compile.
- **Test:** `tests/unit/derived-detail-ownership.test.ts` asserts that only `syncOwned` and
  `releaseAllFor` write the owner map, that the retired channels and identifiers do not return, that
  exactly one renderer module reports, and that the reporter is mounted only at allowlisted
  renderer-lifetime sites. Runs in CI via `npm run test:unit`.
- **Test:** `tests/unit/detail-owner-registry.test.ts` pins the reconcile semantics (per-pair
  scoping, displacement, both handover interleavings, idempotence, teardown re-establishment).
- **Review:** `/code-review` flags a new ownership mount site or a second reporter.

## Scope

Task-detail ownership across renderers. The separate renderer-local terminal claim set
(`dialogSessionIds` / `useWindowSessionClaims`) is NOT this mechanism and correctly gates on
`isLayerMounted`: an unmounted layer has no xterm, whereas its windows still exist. Do not unify the
two.
