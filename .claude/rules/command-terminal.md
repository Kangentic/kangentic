---
paths:
  - "src/renderer/components/command-bar/**"
  - "src/renderer/stores/session-store/transient-session-slice.ts"
  - "src/renderer/components/sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx"
  - "src/renderer/components/layout/TitleBar.tsx"
  - "src/main/ipc/handlers/transient-sessions.ts"
  - "src/main/agent/shared/command-terminal-namer.ts"
  - "src/main/mobile-bridge/handlers/command-terminal.ts"
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
- **MAIN owns the cap and the slot allocation.** `startCommandTerminal`
  (`transient-sessions.ts`) is the one start path, run by the desktop's `session:spawnTransient`
  and the bridge's `command-terminal` verb alike. It counts the project's non-exited transient
  rows plus a synchronous reservation map, so a phone start and a desktop New in flight together
  cannot pass the cap or share a slot. The renderer proposes a slot only for a window it is
  opening, from the union of window anchors and the replica's live transient rows, and handles a
  `slot-taken` throw. Never pick or cap slots from the window store alone: a phone terminal has
  no window.
- **A terminal ENDS when its agent exits, and every end goes through
  `SessionManager.endCommandTerminal`.** It kills, removes the row, and deletes the session
  directory only after the exit (the files are detached first so `remove()` keeps them, and a
  still-exiting agent's SessionEnd hook has somewhere to write). It refuses a task's session. A
  PTY that exits on its own removes its row in the spawn flow's `onPtyExited`. A Command Terminal
  must never be left as a bare shell a paired phone can type into.
- **The agent-absence sweep judges Command Terminals, and the SessionEnd hook fast-paths it.** Do
  not reintroduce a transient exclusion in `isAgentAbsenceCandidate`. The sweep judges a terminal
  only once its agent showed it started (its first SessionStart, or its first alt-screen entry) or
  the start ceiling has passed, so a slow shell is not ended before its agent runs. Where the tree
  cannot judge (`canTreeJudgeAgent`: a WSL shell, or the background-shell watcher off), a
  SessionEnd with no SessionStart inside the end settle ends the terminal instead. Known gap: an
  agent with no SessionEnd hook, under WSL or with the watcher off, outlives its agent until its
  PTY exits.
- **The desktop window follows a main-initiated end through ONE removal subscriber.**
  `useCloseCommandWindowOnRemoval` (mounted in `AppLayout`) closes the slot's window when a
  `session-removed` push names a session the `transientSessions` map still points at. A
  renderer-initiated end (Stop, a branch switch) must scrub its map entry BEFORE it sends the
  kill, or the subscriber closes the window a second time (a branch switch would lose its window).
  Do not move this into App.tsx's removal handler, whose mapping the replica convergence test pins.
- **Naming runs in MAIN**, by `CommandTerminalNamer` with the session's own agent and project
  folder. Display reads `commandTerminalLabel` off the registry row through
  `commandTerminalDisplayName`; there is no renderer-side label. The namer needs the prompt's
  text on the Prompt event, so `startCommandTerminal` passes `capturePromptText` and an adapter
  whose hooks are per-session (Claude) copies its prompt payload into `detail`. Never set that
  flag on a task spawn: task events stay free of prompt text.
- **An unattended (phone) start never blocks and never moves HEAD under a live session.** Its
  fetch is non-interactive with a 5 s abort, its git phase has one 6 s budget, and it stays on the
  current branch when another running or queued session's cwd is the project root. Every failure
  falls back to the current HEAD and still launches. Desktop New keeps its existing behavior.
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
  disabled once windows and live terminals together hold `MAX_COMMAND_TERMINALS` slots. Only the TOGGLE carries the aggregate activity tone; "New
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
  the cold-spawn checkout guard, the trust write, and the branch and label round-trips. The
  dirty-guard file also pins main's slot allocation, the cap, concurrent reservations and the
  unattended start's guards.
- **Test (ending):** `tests/unit/session-manager-end-command-terminal.test.ts` (the end order, the
  directory kept until the exit with real files, and the task-session refusal),
  `session-manager-agent-absence.test.ts` (terminals are judged and ended, the start-evidence
  gate and its ceiling, the SessionEnd fast path, the WSL and watcher-off end settle, `/clear`
  survives), `session-telemetry-wiring.test.ts` (`hasAgentAbsenceSweep`, which picks the end
  settle), `session-spawn-flow.test.ts` (the PTY-exit removal),
  `transient-session-kill-by-slot.test.ts` (scrub before kill), and
  `command-terminal-namer.test.ts`.
- **Test (UI):** `tests/ui/command-terminal.spec.ts`, `command-terminal-branch.spec.ts`, and
  `sidebar-command-terminals.spec.ts` cover the window chrome, the branch pill, and the sidebar
  indicator. `command-terminal.spec.ts` also covers a removal push closing its window and a
  branch switch keeping it.
- **Review:** the header layout ordering and the title-bar button placement are visual
  conventions with no mechanical check. `/code-review` and `ui-conventions.md` are the backstop.

## Scope

The Command Terminal layer, its transient session slice, and the two title-bar controls. Shared
window-manager behavior (pop-out, the min-pane-width floor on tiling) lives in the engine and
applies to task-detail windows too, so it is governed where the engine is, not here.
