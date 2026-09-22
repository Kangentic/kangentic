---
paths:
  - "src/renderer/components/command-bar/**"
  - "src/renderer/stores/session-store/transient-session-slice.ts"
  - "src/renderer/components/sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx"
  - "src/renderer/components/layout/TitleBar.tsx"
  - "src/main/ipc/handlers/transient-sessions.ts"
---
# Rule: the Command Terminal layer is slot-keyed, its geometry is global, and its population is per-project

Ctrl+Shift+P opens an ephemeral "transient" session with no DB persistence, hosted in a SECOND
window-manager layer (`CommandTerminalLayer` + `CommandTerminalWindow` in
`components/command-bar/`), separate from the board task-detail layer: the same engine
(`src/renderer/window-manager/`) instantiated twice via `createWindowManagerStore` and
distributed through `WindowManagerProvider` context. So a Command Terminal is a movable,
resizable, maximizable, snappable window over a slight backdrop blur. Several of its
non-obvious properties were each settled against a bug: a window-local branch pill that
disagreed with the Monitor row, a reconcile that ran too late and spawned a PTY under the wrong
project, and a pending-open flag armed on a project switch that never landed. Design history and
the rejected alternatives live in [docs/command-terminal.md](../../docs/command-terminal.md).

## The rule

- **Windows are keyed by a durable SLOT, never a singleton pointer.** Each window owns a slot id
  (`slot-1`, `slot-2`, ...) as its `anchor`, capped at `MAX_COMMAND_TERMINALS`. The
  `transientSessions` map in `transient-session-slice.ts` tracks them by
  `transientKey(projectId, slot)` (`${projectId}::${slot}`), and the value carries `projectId`
  and `slot` so consumers can filter by project. The map is preserved across HMR via
  `import.meta.hot.data`; on a hard reload `syncSessions()` best-effort re-pairs surviving
  transient PTYs to slots.
- **A reattach NEVER fetches or checks out.** Hiding the layer (Ctrl+Shift+P, Ctrl+Shift+W,
  backdrop click) keeps every PTY alive; reopening reattaches each slot. The default-base
  checkout, plus its dirty-tree stay-put guard, runs on a COLD spawn only, because moving HEAD
  under a running agent is the class of thing #558 refused.
- **The branch is a PER-PROJECT fact, not a per-window one.** Every terminal of a project runs
  in the same project root and shares one HEAD, so a window keeps no local branch state: the
  pill reads its map entry's `branch`, and ONE layer bridge (`useTrackHeadBranch` in
  `CommandTerminalLayer.tsx`) re-derives every entry of the project from live HEAD
  (`git:worktreeHead`) on mount and on every `git:diffChanged`, mirroring each change to main
  (`session:setTransientBranch`, last write wins) so the Monitor row and a post-reload adopt
  agree with the pill. The Changes panel embed passes the effective default base as
  `baseBranch`, never `"HEAD"`.
- **GEOMETRY is global, POPULATION is per-project, and the reconcile runs BEFORE the layer
  mounts.** The layout blob (`AppConfig.commandTerminalWorkspace`) is shared across all
  projects, but which slots get windows is reconciled to the current project's live transient
  sessions on open (`reconcileCommandTerminalWindows` + `planCommandWindowReconciliation` in
  `command-window-reconcile.ts`). Project switching keeps every slot's PTY alive in the map, with
  no stash or restore. The reconcile closes carried-over windows whose slot has no live session
  for the new project (keeping one default terminal) and opens a window for every live session
  that lacks one. It must run in `useCommandBar.open()` and in the empty-store branch of
  `useEnsureCommandWindow`, not in a bridge effect: a carried-over window committed into the
  store spawns a fresh PTY under the wrong project before a later reconcile could close it.
- **There is NO per-window close button.** It was removed to avoid the task-detail "close this
  window" confusion. A window's Stop destroys THAT window's session and closes the window;
  stopping the last one hides the layer. The header is responsive (priority-plus via
  `useHeaderPillOverflow`): only Stop, the title, and the window controls are protected, and the
  pills and branch picker fold into the kebab as the window narrows. The divider precedes the
  window-frame cluster (kebab, THEN divider, THEN pop-out and maximize), mirroring
  `TaskDetailHeader`. That is not a "second-to-last control" rule; this header has no close
  button, so an untiled terminal legitimately reads kebab then maximize.
- **The title bar hosts TWO purpose-built buttons, not one overloaded control.** A plain
  open/close TOGGLE (`quick-session-button`) that never spawns, so there is always a one-click
  way to hide the layer even when a window is maximized over the backdrop; and, rendered only
  while the layer is open, a "New terminal" button to its LEFT (`quick-session-new-terminal`),
  disabled at `MAX_COMMAND_TERMINALS`. Only the TOGGLE carries the aggregate activity tone; "New
  terminal" is hardcoded `tone="rest"`, since it represents an action, not the state of any
  existing terminal. A thin divider mounts and unmounts together with the button. This pair is
  the LEFT-MOST icons in the title bar's right-aligned button row: that row is right-anchored,
  so an element's distance from the window edge is fixed by whatever comes AFTER it. Keeping the
  conditionally-mounted button first means it never shifts Quick Find, stats, settings, or the
  OS window controls.
- **Count and tone come from the UNSCOPED session list, through one shared selector.** Both the
  toggle and the sidebar indicator read `selectCommandTerminalSummary`
  (`transient-session-slice.ts`), which derives count and tone from `sessions`
  (`transient && projectId && status === 'running'`), NOT from the `transientSessions` map: that
  map is renderer-owned window pairing whose hard-reload recovery only re-pairs the current
  project, so a map-based count reads zero for every background project after a reload.
- **Arm the pending-open flag only once a project switch is CONFIRMED.** The sidebar indicator
  switches project and reopens the layer via the same `setPendingOpenCommandTerminal` flag the
  notification-click path uses. Awaiting `openProject` is not enough: it also RESOLVES without
  switching (a moved or renamed folder routes to the "Locate Folder" dialog). Re-read
  `currentProject` after the await and leave the flag disarmed unless it landed, or the layer
  opens on the OUTGOING project.

## Enforcement (self-maintaining)

- **Test (reconcile):** `tests/unit/command-window-reconcile.test.ts` locks the planner that
  decides which slots get windows on open. `tests/unit/command-terminal-summary.test.ts` locks
  the shared count/tone selector, and `tests/unit/command-terminal-name.test.ts` the titles. All
  run in CI via `npm run test:unit`.
- **Test (spawn and branch):** `tests/unit/transient-session-spawn-dirty-guard.test.ts`,
  `transient-session-spawn-ensure-trust.test.ts`, `transient-session-branch.test.ts`,
  `transient-session-adopt.test.ts`, and the two `session-manager-command-terminal-*` tests pin
  the cold-spawn checkout guard, the trust write, and the branch and label round-trips.
- **Test (UI):** `tests/ui/command-terminal.spec.ts`, `command-terminal-branch.spec.ts`, and
  `sidebar-command-terminals.spec.ts` cover the window chrome, the branch pill, and the sidebar
  indicator.
- **Review:** the header layout ordering and the title-bar button placement are visual
  conventions with no mechanical check. `/code-review` and `ui-conventions.md` are the backstop.

## Scope

The Command Terminal layer, its transient session slice, and the two title-bar controls. Shared
window-manager behavior (pop-out, the min-pane-width floor on tiling) lives in the engine and
applies to task-detail windows too, so it is governed where the engine is, not here.
