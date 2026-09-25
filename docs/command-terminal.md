# Command Terminal

Ctrl+Shift+P opens an ephemeral "transient" session with no DB persistence: quick access to an
agent CLI without creating a task on the board. This document records the design decisions and
the bugs behind them. The prescriptive version, which is what you need when editing the layer,
is [`.claude/rules/command-terminal.md`](../.claude/rules/command-terminal.md). The end-user
walkthrough is in [User Guide](user-guide.md#command-terminal).

## A second window-manager layer

The Command Terminal is hosted in a second window-manager layer (`CommandTerminalLayer` +
`CommandTerminalWindow` in `components/command-bar/`), separate from the board task-detail
layer. It is the same engine (`src/renderer/window-manager/`) instantiated twice via
`createWindowManagerStore` and distributed through `WindowManagerProvider` context.

So a Command Terminal is a movable, resizable, maximizable, snappable window, top-layered over a
slight backdrop blur, and its arrangement persists globally: one blob,
`AppConfig.commandTerminalWorkspace`, shared across all projects. Several terminals can run at
once (capped at `MAX_COMMAND_TERMINALS`), tiled among themselves via the engine's N-ary tiling.

Each window has full task-detail parity, and both behaviors live in the shared engine, so
task-detail windows get them too:

- **Pop-out** (`untileWindow`): the clicked pane floats at its current rect, and the survivors
  stay docked and keep their absolute widths by shrinking the footprint, with no rescale. A
  2-pane group is the exception and fully dissolves, so both float.
- **A min-pane-width floor on tiling**: a seam-drag clamp in `TileSplitter`, plus a footprint
  grow on spawn.

## Slots, not a singleton

Each window owns a durable slot id (`slot-1`, `slot-2`, ...) as its `anchor`. The
`transientSessions` map in `transient-session-slice.ts` tracks them keyed by
`transientKey(projectId, slot)` (`${projectId}::${slot}`), and the value carries `projectId` and
`slot` so consumers can filter by project. There is no singleton pointer. The map is preserved
across HMR via `import.meta.hot.data`; on a hard reload `syncSessions()` best-effort re-pairs
surviving transient PTYs to slots.

## A reattach never touches HEAD

Hiding the layer (Ctrl+Shift+P, Ctrl+Shift+W, or a backdrop click) keeps every PTY alive in the
background, and reopening reattaches each slot. A reattach never fetches and never checks out.
The default-base checkout, plus its dirty-tree stay-put guard, runs on a cold spawn only,
because moving HEAD under a running agent is the class of thing #558 refused.

## The branch is per-project

Every terminal of a project runs in the same project root and shares one HEAD, so the branch a
window shows is a per-project fact, not a per-window one. A window therefore keeps no local
branch state.

The pill reads its map entry's `branch`, and one layer bridge (`useTrackHeadBranch` in
`CommandTerminalLayer.tsx`) re-derives every entry of the project from live HEAD
(`git:worktreeHead`) on mount and on every `git:diffChanged`. Each change is mirrored to main
(`session:setTransientBranch`, last write wins), so the Monitor row and a post-reload adopt agree
with the pill.

The Changes panel embed passes the effective default base as `baseBranch`, never `"HEAD"`.
Working and Staged ignore it, and the Branch tab, the ahead/behind, and the base badge all
measure against it.

## Geometry is global, population is per-project

The window layout blob is shared across projects, but which slots get windows is reconciled to
the current project's live transient sessions on open (`reconcileCommandTerminalWindows` and
`planCommandWindowReconciliation` in `command-window-reconcile.ts`).

Project switching keeps every slot's PTY alive in the map, with no stash or restore. The bar
closes on switch, and on reopen the reconcile closes carried-over windows whose slot has no live
session for the new project (keeping one default terminal) and opens a window for every live
session that lacks one, so switching back reattaches all of a project's terminals instead of
leaking a window-less PTY.

The reconcile has to run before the layer mounts: in `useCommandBar.open()`, plus the
empty-store branch of `useEnsureCommandWindow` for the app-restart blob-restore path. A
carried-over window committed into the store would otherwise spawn a fresh PTY under the wrong
project before a bridge-effect reconcile could close it.

## Window chrome

There is no per-window close button. It was removed to avoid the task-detail "close this window"
confusion. A window's Stop destroys that window's session and closes the window; stopping the
last window hides the layer.

The header is responsive, priority-plus via `useHeaderPillOverflow`. Only Stop, the title, and
the window controls (kebab, pop-out, maximize) are protected; the pills and the branch picker
fold into the kebab as the window narrows, down to the min width.

The divider precedes the window-frame cluster: kebab, then divider, then pop-out and maximize.
That mirrors `TaskDetailHeader`'s divider placement, separating the actions menu from the
window-frame controls wherever that boundary falls. It is not a "second-to-last control" rule.
This header has no close button, so an untiled terminal legitimately reads kebab then maximize.

## Two title-bar buttons, not one overloaded control

- A plain open/close **toggle** (`useCommandBar().open` / `close`, `TitleBar.tsx`'s
  `quick-session-button`) that never spawns a terminal, so there is always a discoverable
  one-click way to hide the layer even when a window is maximized over the backdrop.
- A **New terminal** button, rendered only while the layer is open, positioned to the toggle's
  left (`quick-session-new-terminal`, calling `spawnAdditionalCommandTerminal()`), disabled at
  `MAX_COMMAND_TERMINALS`.

Both share the custom `CommandTerminalIcon` glyph, not a bare lucide icon. The toggle shows the
shell-prompt variant; New terminal passes `showPlus` for the center-plus variant (`data-plus` on
the svg), so the spawn affordance reads as "add a Command Terminal" rather than a generic plus.
`CommandTerminalIcon` is a thin wrapper over `components/ActivityMark.tsx`, rendering the
`terminal-idle` / `terminal-working` / `terminal-new` marks from `@kangentic/branding`; see
[Activity Marks](activity-marks.md).

Only the toggle carries the aggregate activity tone (`tone={transientActivityTone}`). New
terminal is hardcoded `tone="rest"`, uncolored and unanimated, since it represents an action,
not the state of any existing terminal: a fresh terminal has no activity to reflect.

A thin divider, matching the one before the Windows min/max/close controls, sits right after New
terminal, so it reads as a transient action distinct from the permanent icon cluster to its
right (toggle, Quick Find, stats, settings). The divider mounts and unmounts together with the
button, so it never leaves an orphan line when the layer is closed.

### Why the pair is left-most

This pair is the left-most icons in the title bar's right-aligned button row, before Quick Find,
deliberately. That row is right-anchored: a `flex-1` spacer eats the space to its left, so an
element's on-screen distance from the window edge is fixed by whatever comes after it, never
before it. Keeping New terminal, the divider, and the toggle first means the
conditionally-mounted New terminal button appearing and disappearing as the layer opens and
closes never shifts Quick Find, stats, settings, or the OS window controls. Only this pair's own
position moves.

The toggle glyph's stroke color is the aggregate activity of the project's terminals
(active-green working, attention-amber needs-you, muted rest, via the central `--kng-active` and
`--kng-attention` tokens), and the working state blinks its whole prompt like a live shell
cursor (`.kng-blink`, shipped with the mark). It marched a travelling dash until 2026-08-07; a
rounded rect cannot carry a composited travelling dash, so the working chip was redesigned
rather than left stalling.

## The sidebar indicator

The toggle reflects only the current project, so the same glyph is mirrored per project in the
sidebar: `SidebarCommandTerminalIndicator` in each `ProjectListItem` row, plus a plain tone dot
on `CollapsedRail`'s 28px buttons, where an arc-bearing glyph would read as broken.

Both the toggle and the sidebar read one shared selector, `selectCommandTerminalSummary`
(`transient-session-slice.ts`), which derives count and tone from the unscoped `sessions` list
(`transient && projectId && status === 'running'`) rather than from the `transientSessions` map.
That map is renderer-owned window pairing whose hard-reload recovery only re-pairs the current
project, so a map-based count reads zero for every background project after a reload.

Placement: the indicator sits beside the agent thinking/idle counts in the row's right-aligned
cluster, never merged into them, since a Command Terminal is not a task agent. It always prints
its count, even at 1, so it forms an icon-plus-digit pair matching the agent counts and the three
indicators stack into one tabular column down the list. A name-adjacent placement was tried and
reverted: project names vary enough that the glyph landed at a different x on every row.

Clicking it switches to that project and reopens its layer via the same
`setPendingOpenCommandTerminal` flag the notification-click path uses, armed only once the switch
is confirmed. Awaiting is not enough: `openProject` also resolves without switching when a moved
or renamed folder routes to the "Locate Folder" dialog, and re-throws every other failure. So the
sidebar re-reads `currentProject` after the await and leaves the flag disarmed unless it landed.
Arming on those paths opens the layer on the outgoing project.
