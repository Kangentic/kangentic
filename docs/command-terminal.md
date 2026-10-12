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
once (capped at `MAX_COMMAND_TERMINALS`, four per project, in `src/shared/command-terminal-name.ts`),
tiled among themselves via the engine's N-ary tiling.

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

### Main owns the cap and the slots

The renderer used to pick a slot by counting its own windows and enforce the cap the same way.
That broke once a paired phone could start a terminal: the phone has no window, so a desktop New
could pick a slot a phone terminal already held. `startCommandTerminal`
(`src/main/ipc/handlers/transient-sessions.ts`), which both the desktop's `session:spawnTransient`
and the bridge's `command-terminal` verb run, now allocates the lowest free slot and refuses a
fifth terminal. The occupied set is the project's non-exited transient registry rows plus a
module-level reservation map filled synchronously on entry and released in a `finally`, so two
starts in flight together cannot both pass the cap or share a slot across the spawn's awaits. A
window that asks for a slot already taken gets a throw, which `CommandTerminalWindow` already toasts
and closes on.

The renderer still proposes the slot for a window it opens, because the window's anchor exists
before the spawn. It reads the union of window anchors and the project's live transient rows from
the session replica, so it only proposes a taken slot in a true race. `spawnTransient` answers with
the slot main settled on.

## A terminal ends when its agent exits

A Command Terminal is an agent, not a shell. When its agent exits, the terminal ends: the PTY is
killed, the registry row removed, the session directory deleted, and the desktop window closed. The
same happens when the PTY exits on its own. Before, a terminal whose agent ran `/exit` stayed open as
a bare PowerShell or bash prompt at the project root, which became a real exposure once a paired
phone could type into the session.

The agent-absence sweep (see [Session Lifecycle](session-lifecycle.md#a-session-whose-agent-exited-under-a-surviving-shell))
is what notices, and the agent's SessionEnd hook asks it to look at once, so `/exit` closes the
window in about 4 seconds. `/clear` also fires SessionEnd, but its process stays alive and the
process tree keeps the terminal. Every end, a desktop Stop included, goes through
`SessionManager.endCommandTerminal`, which refuses a task's session. The session directory
outlives the shell: a Stop returns at once, but the directory is deleted only after the PTY
exits, so a still-exiting agent's SessionEnd hook writes into a directory that exists.

The sweep waits for evidence that the agent started before it judges a terminal: the agent's
first SessionStart, or its first alt-screen entry, which no shell emits. A shell slow to reach the
agent command (a heavy profile, a cold machine) used to be ended 30 seconds in, before its agent
ran. Without either signal the sweep judges the terminal after a two-minute ceiling anyway. That
covers a launch that failed and an agent with neither hooks nor an alt screen, at the cost of
leaving those up to two minutes longer than before.

The sweep cannot read a WSL shell's tree (its agent is not a Win32 descendant of `wsl.exe`), and
it does not run at all with the background-shell watcher off. There the agent's SessionEnd is the
only signal, so a SessionEnd with no SessionStart within 5 seconds ends the terminal. `/clear`
sends its SessionStart 148 ms after its SessionEnd, and a `/resume` choice 116 ms after (Claude
Code 2.1.294), well inside that settle. An open `/resume` picker sends neither, so browsing it
costs nothing. An agent with no SessionEnd hook in either case still outlives its agent until the PTY
exits. A suspend (the idle timeout, a project relocate) ends a terminal outright, since there is
no record to resume.

Nothing in the renderer used to close a window when main ended its session, since `App.tsx`
ignores an intentional exit. `useCloseCommandWindowOnRemoval` (`CommandTerminalLayer.tsx`, mounted
in `AppLayout` so it runs while the layer is hidden) is its own `session-removed` subscriber: when a
map entry still points at the removed session, main ended it (the agent exited, the PTY died, or a
phone pressed Stop), so it clears the entry and closes that slot's window in the current project.
A desktop Stop and a branch switch scrub the entry BEFORE they send the kill, so their own removal
push finds nothing to close and the branch switch keeps its window.

## Naming runs in main

A terminal gets its name from its first prompt, summarized by its own agent CLI in its own project
folder, through `CommandTerminalNamer` (`src/main/agent/shared/command-terminal-namer.ts`). It used
to be named in the renderer by the open project's default agent, so a terminal a phone started, or
one in a project the desktop did not have open, never got one. The namer shares the summarize rate
limit (`autoNameRateLimitPerHour`) with the task namer, skips the synthetic PTY-activity prompt,
and writes through `setCommandTerminalLabel`, which emits `session-changed` once. The window title,
the Monitor row, the phone's list and its push alerts all read the name from the registry row
through `commandTerminalDisplayName`, falling back to "Command Terminal N".

Naming needs an agent whose prompt event carries the prompt's text, and most hooks report only that
a prompt was submitted. Two agents report it: Claude Code, because a Command Terminal's start passes
`capturePromptText` and the Claude adapter then copies `UserPromptSubmit`'s `prompt` into the event
(per session, through that session's own `--settings` file, so task sessions' events stay free of
prompt text), and Kimi, whose wire parser always carries it. Gemini and Qwen Code have a `prompt`
field too, but their hooks live in the project's shared settings file, where a terminal's capture
would leak onto every other session in the folder, so their terminals keep "Command Terminal N".
Before this, the renderer namer read the same empty field and no Claude terminal was ever named.

## Starting one from a phone

The bridge's `command-terminal` verb (see [Mobile Bridge](mobile-bridge.md#capability-verbs))
runs the same `startCommandTerminal` as the desktop's New, with `unattended: true`. A user on a
phone is away from the desk and cannot recover a start that hangs on a credential prompt or a
slow fetch, so an unattended start keeps the desktop's steps and makes each one unable to block:

- the fetch is non-interactive (`fetchIfStale`'s `nonInteractive` option) and aborts after 5 s;
- the whole git phase has one 6 s budget, after which the remaining steps are skipped;
- it never checks out under another live session in the project folder (a sibling terminal, or a
  task with no worktree), comparing resolved paths, case-folded on Windows. A task in its own
  worktree does not count: a worktree has its own HEAD;
- every failure falls back to the branch already checked out, as the dirty-tree stay-put does.

It needs no project open on the desktop. A terminal a phone starts in the project the desktop has
open gets no window until the layer reopens; the toggle's count and tone update live.

## Leftover processes

A terminal's agent can start something that outlives it: a dev server launched with
`Start-Process`, a `nohup` job. Measured: a detached `ping` a terminal's agent started kept
running after the terminal ended, and nothing reported it. So each terminal's PTY carries its own
`KANGENTIC_TASK_ID` (its made-up task id), and `CommandTerminalLeftoverReaper`
(`src/main/ipc/helpers/command-terminal-leftovers.ts`) runs the same reap a task gets at Done
when the terminal ends: it honors "Stop leftover processes" and reports under the terminal's name.
It runs 12 s after the terminal ends, longer than the pty host gives an agent to exit by itself,
so it never force-kills Claude while Claude is still shutting down. Nothing is reaped during a
quit. That host step, which asks the agent a dead shell left running to exit and terminates it
after the grace (`dead-root-orphans.ts`), runs on Windows only. On macOS and Linux nothing asks
such an agent to exit, and this reap is the only cleanup.

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
  left (`quick-session-new-terminal`, calling `spawnAdditionalCommandTerminal()`), disabled once
  the project's windows and live terminals together hold `MAX_COMMAND_TERMINALS` slots.

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
