---
paths:
  - "src/preload/preload.ts"
  - "src/shared/types.ts"
  - "src/main/ipc/handlers/**"
  - "src/renderer/stores/**"
---
# Rule: renderer-driven task/session mutations carry an explicit projectId

The main process resolves which project's database a task-scoped or session mutation hits from
the ambient `context.currentProjectId`, set on the last `project:open`. That value can change
between the user's interaction and the handler running. The worst case shipped: a task dropped on
Done flies for ~700ms (the FlyingCard), then `task:move` fires; if the user switched projects
during the flight, the move resolved against the wrong project, the lookup missed, and the move
threw while the UI reported success. Every renderer-driven mutation shares the hazard; the fix is
to stamp the project at interaction time and route by it.

## The rule

A renderer-driven **mutation** of task-scoped or session state MUST pass an explicit `projectId`,
captured at interaction time, as the trailing IPC argument. The main handler prefers it over the
ambient current project (`projectId ?? context.currentProjectId`), keeping the ambient fallback
only for main-process internal callers (engine, auto-move, MCP command handlers).

- **Capture at interaction time, not send time.** Synchronous actions read
  `useProjectStore.getState().currentProject?.id ?? null` at the call site. The deferred Done move
  is special: it captures the id on drop into the completion gate (`CompletingTask.projectId`) and
  threads it through `moveTask`, because the IPC fires ~700ms after the drop.
- **Handlers route by the explicit id.** Use `getProjectRepos(context, projectId ?? context.currentProjectId)`
  or `resolveProjectContext(context, projectId)` (which also resolves `projectPath`). Do not read
  bare `context.currentProjectId` / `context.currentProjectPath` for a renderer-driven mutation.
- **A failed mutation must not report success, and must roll back the source project safely.**
  `moveTask` returns `{ ok }` (it does not silently swallow), and on a cross-project switch it
  invalidates the source project's warm-cache snapshot (`invalidateProject`) instead of reloading
  the wrong project. See [[board-completing-task-chokepoint]] for the FlyingCard lifecycle this
  builds on.

The mutation set today: tasks `create`/`update`/`delete`/`move`/`unarchive`/`bulkDelete`/
`bulkUnarchive`/`switchBranch`/`updateFromBase`/`setRuntimeOverride`/`resolvePr`; sessions
`spawn`/`suspend`/`resume`/`reset`/`reconcile`. Reads (`list`, `listArchived`, the `get*` probes) and
by-session-id / project-agnostic channels (`kill`, `write`, `resize`, `cancelSpawn`, the transient
session channels) are NOT stamped: a read against the wrong project shows stale data for a frame
(reconciled by the warm cache), it does not corrupt the wrong project.

## Drift over time

New IPC channels are added regularly, and the read-trigger gap means this rule may not be loaded
when a new channel is created. The CI test below is the backstop: it classifies every
`ipcRenderer.invoke(IPC.TASK_* | IPC.SESSION_*)` in `preload.ts` as either a stamped mutation or
an explicit allowlist entry, and FAILS on an unclassified channel. A new mutation therefore cannot
ship without a deliberate decision: forward `projectId`, or justify an allowlist entry. When the
mutation set grows, update both the test's `MUTATION_CHANNELS` set and the prose list above.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/project-scoped-ipc.test.ts` parses `preload.ts`, asserts every
  mutation-set channel forwards a `projectId` argument, and asserts every task/session invoke
  channel is classified (mutation or allowlist) so a new unclassified channel fails. Runs in CI
  via `npm run test:unit`.
- **Review:** the `ipc-auditor` agent cross-references the 7 IPC layers (see
  [[ipc-7-layer-parity]]); `/code-review` flags a renderer mutation that resolves ambient
  `currentProjectId` instead of an explicit id.

## Scope

The renderer-to-main IPC bridge for task-scoped and session state. Main-process internal callers
that legitimately operate on the current project (and pass no id) keep the ambient fallback. Reads
and by-session-id channels are out of scope, as is the separate transient (Command Terminal)
session lifecycle.
