---
type: Design
title: Command Terminal
description: Why the Command Terminal is one auto-tiled panel over a second window-manager layer with main-owned slots, why it ends when its agent exits, why no pause reaches it, how ended conversations are recorded and resumed, expand and swap, its own window, naming in main, phone starts, leftover reaping, per-project branch and geometry, the title-bar toggle, and the sidebar indicator.
tags: [command-terminal, window-manager, slots, design, resume]
sources:
  - resource: src/renderer/components/command-bar/
    title: Command Terminal layer, panel, rail, window, pane, icon and reconcile
  - resource: src/main/ipc/handlers/transient-sessions.ts
  - resource: src/main/ipc/helpers/command-terminal-history.ts
  - resource: src/main/agent/shared/command-terminal-namer.ts
  - resource: src/main/pty/session-manager.ts
    title: renameCommandTerminal, setCommandTerminalLabel, endCommandTerminal
  - resource: src/main/ipc/helpers/command-terminal-leftovers.ts
  - resource: src/shared/command-terminal-name.ts
  - resource: src/shared/command-terminal-rail.ts
  - resource: src/renderer/utils/folding-edge-drag.ts
  - resource: src/renderer/components/terminal/context-bar-fold.ts
    title: The context bar's one-row fold, whose row sets the pane floor
  - resource: src/renderer/components/terminal/useContextBarFold.ts
  - resource: src/renderer/components/terminal/ContextBarOverflow.tsx
  - resource: src/renderer/stores/session-store/transient-session-slice.ts
  - resource: src/renderer/window-manager/tiling/host-arrangement.ts
  - resource: src/renderer/pop-out/roots/PopOutCommandTerminalRoot.tsx
  - resource: src/renderer/pop-out/surfaces/command-terminal-surface.tsx
  - resource: src/renderer/hooks/useCommandBar.ts
  - resource: src/shared/terminal-input-content.ts
  - resource: src/renderer/components/layout/TitleBar.tsx
  - resource: src/renderer/components/sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx
---
# Command Terminal

Ctrl+Shift+P opens the Command Terminal: quick access to an agent CLI without creating a task on
the board. Each terminal is a "transient" session with no task row. This document records the
design decisions and the bugs behind them. The prescriptive version, which is what you need when
editing the layer, is [`.claude/rules/command-terminal.md`](../../../.claude/rules/command-terminal.md).
The end-user walkthrough is in [Command Terminal](../../user-guide/command-terminal.md#command-terminal).

## One panel over a second window-manager layer

The Command Terminal is one panel over a slight backdrop blur (`CommandTerminalPanel`): a header
with Open in new window, Maximize and Hide; a rail (`CommandTerminalRail`, 300px by default,
resizable and foldable, see [The rail](#the-rail)) with Add terminal at its top, the Earlier list,
and a Running list of every terminal; and up to four terminals in the rest. The button says "Add", as "Add task"
and "Add column" do, because "New terminal" read as replacing the terminal already open. The
panel's Maximize keeps the corners icon (`Maximize`) on purpose: each terminal's Expand uses the
diagonal arrows (`Maximize2`) a task window's maximize does, and the two sit one above the other. The panel moves by its header, resizes from its outer edges, and maximizes
to the area between the title bar and the status bar. A move translates the real panel and a
resize changes its box live, and both are saved once, on release. The first build drew a dashed
outline during a resize and changed nothing until the release, which no other resizable window
or panel in the app does and which made shrinking the panel hard to judge. A resize holds the
manager-resize gate (`window-manager/terminal/manager-resize-gate.ts`) for the whole gesture: the
terminals re-tile with the panel but keep their grids, and the gate holds every
`scheduleWindowTerminalResize` the re-tiling asks for and sends one when the gesture ends, so each
terminal refits once on release instead of sending its agent a SIGWINCH per pointer frame (12 for
one test drag without the hold). Its place is `AppConfig.commandTerminalPanel`, fractions of that
area, so it rescales with the window. A panel never moved opens centered at the size that gives a
lone terminal what a Command Terminal window had before the panel (58% by 70% of the area, the
window manager's first-window default), with the rail at its 300px default and the 40px header
added around it. The default reads the rail's default width, never its live one, so a panel
nobody moved opens at one size whatever the rail was left at.

The rail is part of the panel. Dragging its edge, folding it and opening it change the panel's
width by the rail's change, the panel's left edge held, and the terminals keep their size and
refit nothing (`panel-edge-push.ts`: the panel hands the rail a width change that starts from the
box it had). The first cut kept the panel's box and gave the change to the terminals, which made
seeing Earlier's names a two-step job at the panel's minimum (grow the panel, then the rail), and
narrowed the terminals for a change that is only the rail's. The fold button has no pointer to
follow, so an open the right edge cannot take grows the panel to the left. Where the panel cannot
change (maximized, the detached window, or a drag whose right edge reaches the area's), the
terminals give the rail its room, never under their floor. The rail's edge looks like a tile seam:
a thin accent line on the boundary under the pointer and while it drags.
Every user meets that default on the first open after updating, because the panel's place is a new
setting; a first cut at 94% by 92% made that first open jump from about half the window to all of
it.

### Decision: the resize gate closes a drag itself (2026-10-25)

Holding `scheduleWindowTerminalResize` on the gate is what made a leaked gesture serious. Before
that, a gesture left open only muted the per-frame refit, and a window's resize commit still refit
its terminal. After it, every window terminal's refit waited on the gate, so one gesture whose
release never reached its owner froze all of their grids until a reload. It was reported from a
task window that grew to 1981px while its terminal kept the 1483px grid it mounted at, and the
trace could not say which drag had leaked. The tests reproduce one way in: a window edge drag
that lost its release was replaced by the next edge drag without being ended, since that handler
had no re-entry guard. So the gate no longer counts begins against ends. Each drag holds a gesture
it can end once, and the gate abandons a gesture on the first host pointer event that shows its
button up, telling the owner to commit the drag as it stands (see
[Output streaming](../sessions/output-streaming.md)). A seam pressed and released without moving
had committed ratio 0, which clamps to the narrowest tile (594px lost in one test click); it now
commits only once it has moved. The driver's drag (`dragFromTo`) holds the left button on its
moves, since a CDP move without `buttons` reports none held and the gate would end the drag at its
first step.

Each terminal is a window of a second window-manager layer (`CommandTerminalLayer` +
`CommandTerminalWindow` in `components/command-bar/`), separate from the board task-detail
layer: the same engine (`src/renderer/window-manager/`) instantiated twice via
`createWindowManagerStore` and distributed through `WindowManagerProvider` context. The layer is
`hostArranged`: the window engine renders into the panel's terminal area (an explicit
`portalHost`) and the panel lays the windows out. One terminal fills the area, two sit side by
side, three are one tall beside two stacked, and four are a two by two grid split by columns
(`hostArrangementTree` in `tiling/host-arrangement.ts`, built by the store's `arrangeTiles`).
Starting or stopping a terminal rebuilds the preset for the new count and keeps the order the
terminals read in on screen (`windowIdsInReadingOrder`, which reads a preset by its structure so
seams that cross never reorder a grid). A dragged seam holds until the count changes, because
`isHostArranged` still recognizes the preset after a seam moves, and a double-click on a seam
evens its two terminals, 50/50, as a sash does in an editor. A seam only shares the room the
panel has, never pushes its edge: the panel's edges size it and the seam divides it, as in every
editor's and terminal's splits. So a seam with no room above both floors (the panel at its
minimum) shows no resize cursor or accent line and takes no drag, rather than a cursor that
promises a move it cannot make. The terminals' arrangement
persists globally in `AppConfig.commandTerminalWorkspace`, and a blob saved before the panel
(floating windows) is re-tiled on load.

The pane floor is 630 x 200 (`COMMAND_TERMINAL_FLOOR` in `command-terminal-grid-fit.ts`), about
77 columns, the Command Terminal's own; task windows keep 650. It is the width at which the context
bar's one row (below) still holds what it never folds. A resize never takes the grid away.
The panel's minimum is the grid at that floor (`commandTerminalGridMinimum`: two columns from two
terminals, two rows from three, one terminal while the user has one expanded) beside the rail at
its narrowest: the 37px strip folded, its 200px drag minimum open. It once held the open minimum
while folded, because opening the rail took its room from the terminals and would have put them
under their floor; opening now grows the panel instead. The minimum assumes even
tiles, so the layout holds each pane at the floor whatever a dragged seam asks for, while the area
has room for the grid (`resolveTileLayout`'s `minPane`). An edge resize or a maximize first adopts
what the hold shows as the seams' own sizes (`heldSplitSizes`), so the terminals grow from the
proportions on screen. Keeping the dragged ratio instead was the first version: a seam dragged
fully left in a wide panel, the panel shrunk to its minimum (shown even) and grown again, gave all
the new room to one terminal while the other sat at 630 until the panel was as wide as before.
Without the hold, a seam dragged toward one side and a panel
shrunk to its minimum left a terminal at 356px, found driving a live preview. An area short of the
grid scales the floors down together rather than dropping the hold, so the layout is continuous
across the edge. Dropping it there showed while shrinking a panel with a skewed seam: the rail's
resolved width follows the row a frame late, the terminal area was a few pixels short of the grid
for that frame, and a terminal jumped from 630 to 528px and back (recorded frame by frame). The
open rail now also gives way in the same layout pass, down to its 200px minimum, against the
area's `commandTerminalAreaMinWidth`, so that frame no longer comes short. So the panel's edge
stops where the grid still fits. A terminal added, from the rail or the phone, and a Restore grow the
panel to fit, because `toPixels` holds it above the minimum, and the panel saves the size it grew
to, so the next Expand leaves it there. Only an Expand the user chose lets the panel shrink to one
terminal. Two side by side need a 1462px panel, which a 1920 screen holds. An area smaller than
the minimum (a small window, the detached window resized small) shows the panel at the area's
size with every terminal tiled under the floor, and the panel's maximize is there for a screen
that small.

### The context bar's one row

The context bar under every terminal (the Command Terminal's, a task window's and the bottom
panel's: one component) is one row, inset 4px each side. The agent's name, the model and effort
pickers, the rate limits and the context always show, and a task's profile picker with them; the
rest folds into a +N pill in a fixed order (`CONTEXT_BAR_FOLD_ORDER`): the shell, the agent's
version number, active time, elapsed, tokens, tool calls, cost, then the context counts. They fold
before a bar would drop under 80px (`METER_COMFORT_TRACK_PX`), so at the floor the row is those
five alone and the bars take the room cost and the counts held; once only the five are left, a bar
narrows to its own 40px minimum before anything else folds. The +N pill's list shows copies of the
folded pills with their tips, drawn on the bar's own fill so each keeps the pill it is in the row,
and tool calls opened there opens its table above the +N pill. A folded pill stays mounted in the row, out of flow and out of sight, so
its width is its own and its pulses keep running. The fold is decided from widths it cannot change
(`useContextBarFold`): each pill's own width, and each meter's (the rate limits, the context) with
its tracks at their minimum, so a pill never flips in and out at the edge. It reruns on resize
observers, not on the bar's renders, which come with every usage tick. Under the floor, in a window
too small for the grid, the rate limits, then the context, then the agent's name fold too; the model
and effort never do.

The rate-limit tracks and the context bar keep a 40px minimum: at 20px they stopped reading as
bars. Measured on a live Claude bar with them there, the row that never folds needs 589px of
terminal for Haiku at low effort and 621 for Sonnet at medium, the widest 5.x pair, which is why
the floor is 630 (550 and 560 were tried first, with 20px bars). A longer "(1M context)" model
name needs more; at the floor its rate limits fold. The 80px comfort width came after, on
2026-10-31: with one rate-limit window, cost and the context counts fit beside bars of 73 and 51px
at the floor, and folding them gives the bars about 100 and 130px. It moves nothing about the
floor, which never counted them.

### Decision: a 650px floor instead of a one-row context bar (2026-10-25)

The floor was 320 x 200, what four terminals kept beside the rail at the 900 x 600 window floor
(two columns of about 325px). At that width a terminal is about 37 columns: the agent's own
output wrapped, and the context bar wrapped to five rows and left the terminal one. Two fixes were
drawn. One kept the 320px floor and folded the context bar to one row in every terminal, with
the overflow behind a +N menu; that needed a fold order and a priority-plus layout in a component
the board shares. The other gave Command Terminals the floor task windows already have, which
caps the bar at two rows, as on the board, and fixes the narrow output too. The floor won: one
behavior in every terminal and nothing new to maintain. What it costs is the four-terminal grid
on small screens, where the fallback shows one terminal at a time with the others a click away
under Running, the view Expand already had. Superseded on 2026-10-30, below.

### Decision: a panel that never resizes under its grid, and a one-row context bar (2026-10-30)

At 650 two terminals needed a 1502px panel even with the rail at its narrowest, so on a 1366 or
1440 laptop, and at the panel's default place on a 1920 screen, a second terminal never tiled: the
fallback expanded one, and shrinking a tiled panel past the line swapped the grid for one terminal
without asking. The grid is what the user arranged, so a resize now stops where it still fits,
and only an Expand the user chose lets the panel get smaller; Restore and a terminal added grow it
back. Measured on a real Claude context bar, the bar is two rows from 632px, three from 404 to
630, four from 402 and five from 342. A floor of 540 was built first, and its third bar row was the
problem: more than two rows was not wanted, and more than one turned out not to be either. So the
fold that lost on 2026-10-25 came back, as one row everywhere (two rows at most was drawn too),
and the floor became the width that row needs with its bars at 40px, 630. 480 and 404 were drawn and passed over for the
agent's wrapping. A window too small for the grid tiles every terminal under the floor rather than
falling back, since the user can maximize the panel there; the fallback to one expanded was drawn
as an option for that case and not picked.

### The rail

The rail opens at 300px, and its edge drags it from 200 to 400, the project sidebar's range. Below
200 it holds there while the pointer goes on to 100, and past 100 it folds to its 37px strip while
the drag still runs, so letting go keeps what the screen shows; dragged back past 100 it opens at
200. The project sidebar's divider follows the same rule, one function for both
(`resolveFoldingEdgeDrag`, `src/renderer/utils/folding-edge-drag.ts`). The rail's bottom row is its
fold button, outlined at rest as the sidebar's "Add project" footer button is (`border-edge/60`):
open, the full row with the icon and "Hide" (`PanelLeftClose`, named "Hide rail", no tooltip since
it carries its word); folded, the strip's icon (`PanelLeftOpen`, "Show rail" in its tooltip). The
icon is on the same pixel in both, so a second click undoes the first without moving the pointer. The rail is one element in
both states, so the button keeps keyboard focus across the fold. It lives inside the rail, not in the panel header,
because the detached window has no panel header. Folded, the strip keeps Add terminal as an icon on
the open rail's Add row and lists the same terminals as Running, each as its agent's activity mark,
the one a task card shows (`agentActivityMark`: the working ring, or the envelope, speech bubble or
shield of what it waits for, muted while it starts or rests), the one in front with the sidebar's
neutral selected-row fill (blue is Add terminal's alone). A mark's click brings that terminal to the front and its right-click
is its row menu. The strip has no Stop and no Earlier.

Width and fold are one global setting, `AppConfig.commandTerminalRail`, kept across projects and
restarts (`src/shared/command-terminal-rail.ts`, `useCommandTerminalRail`). What the rail shows is
resolved from it: in a row too narrow for the saved width beside the terminals' grid at its 630px
floor, the rail shows narrower, down to 200, and the saved width comes back when there is room.
Nothing writes the narrowed width back. The panel and
the detached window both write the setting, so the rail reads it back from disk when it mounts
rather than trusting the config this window loaded. The config store's refetch merge does not
preserve it, for the same reason as `monitorWorkspace`.

The drag is shaped like the panel's own edge drag. It writes the rail's width straight to its
element on each move, so the terminals' tiles follow it without a render, and it holds the
manager-resize gate for the gesture, so each terminal refits once on release. A fold or an open
lands during the drag too, so the tiles have followed it by the release and it costs one refit as
well; the fold button is a layout change with no gate and costs one. Escape cancels the drag in the
capture phase.

### Decision: a resizable, foldable rail (2026-10-30)

The rail was a fixed 248px. Measured against one project's 18 real Earlier names at 13px, 248 fit
4 whole, 300 fit 9, 336 fit 14 and 400 fit 16. A fixed wider rail takes room from the terminals on
every screen, so the default moved to 300 and the user sets the rest. Folding came out of the same
pass: the strip is the sidebar's compact pattern, and the chips keep the Running list's one-click
switch. A cut Earlier name shows its full text in a tooltip. A toggle beside Add terminal was drawn
first and dropped, because it turned the rail's top row into two rows.

The first build folded on release anywhere below 200, the sidebar's rule then, so the narrowest open
rail took a release within a pixel or two of the edge, and nothing on screen said the next pixel
folded. The fold line moved to half the minimum, drawn live, for the rail and the sidebar both:
VS Code's split views draw it there too. A fold made by a drag also stopped costing a second refit,
since it now lands before the release. The fold button went from a 28px corner icon to the rail's
full bottom row, icon only, for the larger target; a labelled footer like the sidebar's "Add
project" was drawn and passed over at first. Borderless until hovered, the row read as an icon in
an empty row, so it took that footer button's resting outline; outlined, it read as an empty box
with an icon in its corner, so it took a word too: "Hide", beside the icon so the icon keeps its
spot. A filled bar and a centered icon were drawn; centering moved the icon about 130px on a fold.

### Decision: one panel instead of floating windows (2026-10-24)

The Command Terminal used to be a set of movable, resizable, maximizable, snappable windows with
full task-detail parity, including a per-window pop-out out of a tile group and a per-window
maximize. The redesign signed off on 2026-10-24 replaced that with the panel. Free windows needed
the user to arrange every new terminal, the rail needed a fixed home beside them, and expand,
swap and the Earlier list all read better against a fixed grid. Task-detail windows keep the
floating behavior: `hostArranged` is a layer option, off for the board layer, so the engine's
pop-out and footprint resizers still serve them.

## Slots, not a singleton

Each window owns a durable slot id (`slot-1`, `slot-2`, ...) as its `anchor`. The
`transientSessions` map in `transient-session-slice.ts` tracks them keyed by
`transientKey(projectId, slot)` (`${projectId}::${slot}`), and the value carries `projectId` and
`slot` so consumers can filter by project. There is no singleton pointer. The map is preserved
across HMR via `import.meta.hot.data`; on a hard reload `syncSessions()` re-pairs surviving
transient PTYs to their slots, read off each row's `commandTerminalSlot`.

### Main owns the cap and the slots

The renderer used to pick a slot by counting its own windows and enforce the cap the same way.
That broke once a paired phone could start a terminal: the phone has no window, so a desktop New
could pick a slot a phone terminal already held. `startCommandTerminal`
(`src/main/ipc/handlers/transient-sessions.ts`), which both the desktop's `session:spawnTransient`
and the bridge's `command-terminal` verb run, now allocates the lowest free slot and refuses a
fifth terminal. The occupied set is the project's non-exited Command Terminal rows
(`isCommandTerminalSession`, so a workflow's own agent never takes a slot) plus a
module-level reservation map filled synchronously on entry and released in a `finally`, so two
starts in flight together cannot both pass the cap or share a slot across the spawn's awaits. A
window that asks for a slot already taken gets a throw, which `CommandTerminalWindow` already toasts
and closes on. A start is routed by the project its input names, never by the project the main
window shows, which is what lets a detached window or a phone start one anywhere.

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

A shell that never starts ends the same way. node-pty refuses a configured shell it cannot find
(a bare `pwsh` off PATH reports `File not found:`), and the spawn hands back an exited placeholder
whose exit went out before the spawn returned. `startCommandTerminal` ends that row and refuses the
start with `spawn-failed`, naming the shell and pointing at Settings > Terminal. The desktop window
toasts it and closes, and a phone gets `command-terminal-start-failed`. Handed back as a success,
the window waited on its launch shimmer for good, since it subscribes to the exit only once it
knows the session id.

The agent-absence sweep (see [Agent absence sweep](../sessions/agent-absence-sweep.md))
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

The window's launch overlay waits for the same kind of evidence. It used to lift on the adapter's
first-output latch or on the session's usage, and both arrive before the agent runs: the startup
frame of pwsh and Windows PowerShell carries the cursor-hide escape Claude's detector matches, and
the spawn seeds usage with the model name. So a new terminal showed the PowerShell prompt for
about three seconds before Claude's TUI. It now lifts when main says the agent is on screen
(`SessionManager.markAgentReady`, see [The launch overlay](../../integrations/agents/adapter-interface.md#the-launch-overlay)),
which works for every agent, inline ones included. The pane mounts behind the overlay with its
output dropped, so its fit sizes the PTY before the agent's first frame. Mounting only at the lift
let Claude compose that frame at the 120x30 spawn default.

The sweep cannot read a WSL shell's tree (its agent is not a Win32 descendant of `wsl.exe`), and
it does not run at all with the background-shell watcher off. There the agent's SessionEnd is the
only signal, so a SessionEnd with no SessionStart within 5 seconds ends the terminal. `/clear`
sends its SessionStart 148 ms after its SessionEnd, and a `/resume` choice 116 ms after (Claude
Code 2.1.294), well inside that settle. An open `/resume` picker sends neither, so browsing it
costs nothing. An agent with no SessionEnd hook in either case still outlives its agent until the PTY
exits. A suspend ends a terminal outright rather than pausing it, so nothing suspends one
automatically ([No pause reaches a terminal](#no-pause-reaches-a-terminal)). A project relocate
kills its terminals.

Nothing in the renderer used to close a window when main ended its session, since `App.tsx`
ignores an intentional exit. `useCloseCommandWindowOnRemoval` (`CommandTerminalLayer.tsx`, mounted
in `AppLayout` so it runs while the panel is hidden, and in the detached window's root) is its own
`session-removed` subscriber: when a map entry still points at the removed session, main ended it
(the agent exited, the PTY died, or a phone pressed Stop), so it clears the entry and closes that
slot's window in the current project. A desktop Stop and a branch switch scrub the entry BEFORE
they send the kill, so their own removal push finds nothing to close and the branch switch keeps
its window.

## No pause reaches a terminal

A task's pause can be resumed in place: its record keeps the agent's session id, and Resume runs
the CLI with it on the same card. A Command Terminal has no task record, so a suspend ends it
(`endCommandTerminalAfterPtyExit`). Its conversation is recorded (see
[Earlier: ended conversations resume](#earlier-ended-conversations-resume)), but the terminal the
user was looking at is gone, so the terminal is exempt from both automatic pauses. The low-memory
pause never picks one (`isPauseEligible` in `src/main/diagnostics/idle-agent-pause.ts`). The When
idle sweep skips one before it times anything out (`isIdleTimeoutExempt`, which `SessionManager`
answers with `isCommandTerminalSession`). The skip comes before both of the sweep's callbacks, not
just the suspend: an idle-timeout report alone reaches the renderer, which marks the session
suspended. The sweep's other job, suspending a workflow's own agent, is unchanged. That agent is
transient too, but its Workflows pane resumes it.

The sweep used to suspend every transient session it timed out. On 2026-10-23 that ended two
terminals about 30 minutes after their last reply, the When idle setting, one of them partway
through an investigation that was waiting on the user. Both conversations had to be recovered by
hand with `claude --resume <id>` from Claude's own transcript files. That loss is also what the
Earlier list answers.

A suspend that reaches a terminal by some other path still ends it, as the backstop. A new
automatic pause or suspend path must skip Command Terminals too.

## Earlier: ended conversations resume

`CommandTerminalHistory` (`src/main/ipc/helpers/command-terminal-history.ts`, the per-project
table `command_terminal_history`, see [Session tables](../../database/session-tables.md)) records
the conversations Command Terminals held, for every terminal, a phone's included. It works from
SessionManager's own events, in main:

- **A row is written when the agent reports its session id**, not when the terminal ends, because
  a quit removes no registry row (`killAll` never calls `remove()`). A terminal open at quit keeps
  its row, and the list stamps its end the first time it reads it. A `/clear` or `/resume` inside
  the terminal reports a new id, which ends the previous row and starts one for the new
  conversation. An id a board task or a workflow already owns is skipped: a `/resume` into a
  task's conversation is not a terminal's.
- **A row is listed only once someone used the terminal.** `Session.hasUserInput` is set in main
  from the input's content. The pty host judges it (`writeCarriesUserContent`,
  `src/shared/terminal-input-content.ts`, on a `'user'` write, whether it came on a renderer's own
  port or from main) and reports the first one as a `userInput` event, which main turns into
  `markUserInput`; a `TerminalSubmit.submitContent` paste calls `markUserInput` directly: a keystroke, a
  paste or a submit counts; xterm's DA and DSR replies,
  focus reports, mouse motion, the repaint nudge and the system's own pill writes do not. A
  resumed terminal is touched from birth. An untouched row is deleted when it ends, so a terminal
  nobody used leaves nothing behind.
- **A row is listed only while it can be resumed**: its agent resumes by id
  (`canResumeConversationById`, `src/main/agent/shared/workflow-agent-capability.ts`, the same
  test a workflow's own agent passes) and can still find the transcript (the adapter's
  `locateSessionHistoryFile`, wired in `register-all.ts`), and no live terminal or resume in
  flight holds it. The newest 50 ended rows per project are kept
  (`COMMAND_TERMINAL_HISTORY_LIMIT`).
- **A row reads as its name, else its first prompt.** The name comes from the namer, which runs
  only with an Automation agent set, and the Automation agent has no default. Every row read
  "Untitled conversation" until the row kept the conversation's first prompt too (`first_prompt`,
  from the Prompt event's text, collapsed to one line and capped at 200 characters; a prompt that
  arrives before the agent reports its id is held until the row exists). The rail and the phone's
  list both show it. A resumed terminal is never titled from it: only a real name seeds the title.

A resume is a start with `resumeAgentSessionId`. Main claims the conversation before the spawn
(`claimResume`), so two clicks, or a desktop and a phone, can never put two agents on one
transcript; the second is refused with `conversation-open`. A row that cannot be resumed is
refused with `conversation-gone`. The resumed terminal is seeded with the conversation's label,
so the namer skips it, and its first status write sets a new activity baseline rather than
reading as 30 seconds of work.

In the rail, a row resumes IN PLACE of the focused terminal (or the only one) only while nothing
has reached that terminal: a fresh terminal the user opened and then decided against is replaced
by the conversation they actually wanted. A used terminal is never replaced, and the conversation
opens beside the others in the next free slot instead. The slot's window takes the request
(`requestCommandTerminalResume`) whether it is live or still mounting, and a request for a slot
whose window closed first is dropped with it. At the cap the rows are off and say why.

## Expand and swap

**Expand** fills the panel with one terminal. `expandedWindowId` lives in the layer's store and is
transient: never saved, cleared by a restore, and moved to a new terminal opened while one is
expanded. The other terminals stay mounted behind it at the same rect, hidden exactly like a
dormant window (opacity 0, no pointer events, `aria-hidden`, `inert`). The rail then lists them
under Running; a row's title expands that terminal, and its Stop, the same `StopButtonIcon` as the
header's, ends it.

A terminal that changes size shows its old frame on the new grid until the agent repaints.
Measured on Claude Code 2.1.310 on Windows by resizing a live PTY and timestamping its output, in
four runs: ConPTY redraws the old screen within 45 ms, and the agent's own frame lands 98 to 181
ms after the resize, its tail within about 35 ms of it. That was the reported flicker on a switch
between expanded terminals: the footer drawn mid-panel, then dropped to the bottom.

So the terminals behind an expanded one are sized to the expanded rect, not their tiles
(`WindowFrame`): they take the new size while nobody can see them, at Expand, and a switch through
a Running row then changes no size and sends no resize. The first build kept them at their tile
rects so they would not refit at all; that is what made every switch a visible jump.

Expand and Restore still jump sizes, Restore every terminal at once. The panel no longer covers
that itself: a user's Expand or Restore is a layout change over the panel area (see
[Output streaming](../sessions/output-streaming.md), the frame hold). The new layout shows at
once, and each terminal it resized holds its last frame until its agent's new frame is in, then
draws that frame once. The repaint rule's fallback is the one first written for
this panel: no sooner than 190 ms after the PTY resize, then once the output has been quiet for
40 ms, and by 500 ms whatever the output does, which against the four runs lifts between 212 and
253 ms. Main's repaint
settle was tried first as the signal and is wrong here: it settles on the first screen clear after
the resize, which on Windows is ConPTY's redraw of the old screen, so a cover came down at about
25 ms and the jump showed anyway. An earlier build rejected holding the old picture until the new
one settled, since a click that does nothing for 200 ms reads as missed. The covers that replaced
it showed three things instead of one, and one change, a little later, read better.

### Decision: freeze, draw, swap (2026-10-25, superseded the same day by "hold the frame" below)

Three covers came first, and each read as a flicker in a different way:

- The terminal's background color. Every Expand and Restore showed each terminal black for 212
  to 253 ms.
- A picture of the terminal area taken before the switch (`window:captureRegion`). It covered
  Expand and Restore only, because every trigger had to call it before the layout changed, and
  each jump paid the capture over IPC.
- A copy of each terminal's own canvas taken in `useTerminal`'s fit. It reached every terminal host, but
  the WebGL renderer had to keep its drawing buffer for it (`preserveDrawingBuffer`, a copy on
  every frame every terminal draws), and it showed three stages: the old frame pinned to the
  top left of a pane that had already grown, a crossfade, then the new frame.

A user's layout change now runs inside an element-scoped View Transition
(`terminal-layout-transition.ts`). The scope keeps its last frame on screen while the change
commits, every terminal under it refits and sends its PTY resize, and the agents repaint; then the
new state shows in one cut. Nothing is copied, and nothing runs outside a transition. Synchronized
output markers (DEC 2026) were considered as the repaint signal and dropped, since ConPTY may wrap
only its own screen clears in them. A permanent `contain: layout` on each scope was dropped too:
it would confine the inline `BaseDialog` confirms to the overlay, so a scope with a dialog open
skips the freeze instead.

Measured against the committed picture hold, in the UI tier: headless Chromium on software GL at
13 to 31 frames a second, the same emulated agent in both builds (a full redraw 98 to 181 ms after
each PTY resize), and 10 changes each of a task window maximize and restore, Expand and Restore,
and the panel's maximize and restore, every compositor frame classified as the old picture, the
new one, or neither:

| | Picture hold | Freeze, draw, swap |
|---|---|---|
| Changes showing a frame that is neither | 57 of 60 | 0 of 60 |
| Time those frames were on screen, median per change | 117 to 542 ms | none |
| Stages a change shows | 3 to 5 | 2 |
| Main-thread time per change, median | 92 to 125 ms | 86 to 105 ms |
| Main-thread time while terminals stream, per second | 22 to 30 ms | 22 to 25 ms |
| `captureRegion` per Expand or Restore, median | 116 ms, 184 KB of PNG | none |

The final picture lands 86 to 124 ms sooner for Expand and Restore, which no longer wait on the
capture, at the same time for the panel's restore, and 57 to 178 ms later for a task window's
maximize and restore and the panel's maximize, with nothing on screen changing before it. That cost is the price of showing only the finished frame: the repaint rule cannot lift sooner
than 190 ms after the PTY send, because the agent's frame lands as late as 181 ms, and the
transition itself adds about three frames, which this rig draws slowly.

In the desktop app (Electron 45 on the GPU, a live Claude Code agent in each terminal, 10 changes
each), the new state showed this long after the click, median and p95:

| | Median | p95 |
|---|---|---|
| Task window maximize | 291 ms | 308 ms |
| Task window restore | 281 ms | 292 ms |
| Expand | 270 ms | 281 ms |
| Restore | 278 ms | 285 ms |
| Panel maximize | 319 ms | 326 ms |
| Panel restore | 315 ms | 333 ms |

No change raised a long task, and the page kept drawing through every freeze: its longest frame
gap was 49 ms. A window minimized in the middle of a freeze came back with nothing frozen and the
change applied.

The user found even that wait laggy, so the repaint wait now ends on the agent's first finished
frame rather than waiting out the near-identical frames after it (`terminal-repaint-wait.ts`). A
task window's maximize then swapped at 242 ms (p95 267) and its restore at 243 ms (p95 278). Timed
by phase over 10 maximizes: the freeze started 7 to 9 ms after the click, the window's own React
commit for the maximize took 25 to 45 ms, the PTY resize went out 34 to 72 ms after the click,
and the agent's first frame arrived 130 to 160 ms after that.

That commit was the whole app. `AppLayout` called `useFocusedSessionsSync`, which keys on every
window's state, so a maximize re-rendered `AppLayout` and everything under it (296 to 321
components). `AppLayout` also subscribed to the whole `config` and `globalConfig` objects, which
the store rebuilds on every write, so the window layout save half a second later re-rendered it
all again (243 components, 16 ms). The sync now runs in a component of its own that renders
nothing, and `AppLayout` selects only the values it reads (`app-layout-render-scope.test.ts` pins
both). The maximize commit is now 93 components in 7 to 8 ms, the PTY resize goes out 17 to 19 ms
after the click, the layout save re-renders 14 components in about 1 ms, and the swap lands 172 ms
after the click (p95 183), against 291 ms at the start. What is left is the agent's own redraw.

### Decision: hold the frame (2026-10-25)

The freeze above was superseded the same day. With the swap at 180 ms, the change itself had
become the lag: a click on maximize left the window where it was for 180 ms, which read as the
app not responding. The agent's redraw cannot get faster, so the window now moves at once, and
each terminal it resized holds its last frame until the agent's frame for the new grid is in
(`terminal-layout-transition.ts` and `useTerminal`). Only the double paint is removed: the old
frame reflowed onto the new grid, then ConPTY's redraw, then the agent's frame. The scope-wide
freeze, its click shield and its watchdog are gone, so nothing holds the pointer while an agent
repaints.

What a held terminal shows was settled by eye, one option at a time, in the desktop app:

- The old frame stretched to the new box: the text showed enlarged on a maximize and squeezed on
  a restore, which read as very odd.
- The old frame at its own size, pinned to the top left: a restore showed the banner with the
  input box cut off below the window's edge until the agent's frame put it back, which read as a
  flash.
- Pinned to the bottom: right for a restore, since an agent keeps its input box and newest output
  on the bottom rows and those stay where the frame will put them. On a maximize the old text sat
  narrow and low in the grown window, in a place it would not stay.

So the rule is: a frame that still fills its new box (the box shrank both ways) stays on screen
pinned to the bottom, and one that no longer fills it (the box grew either way) is not drawn. The
terminal shows its background until the agent's frame is in, which then fades in over 80 ms
rather than landing as a hard pop (an instant cut with Animations off). Nothing ever shows in a
place it will not stay.

How the hold ends was settled by measurement. The first build ended it under an element-scoped
View Transition on the terminal's host, so the old frame would never show reflowed. A screencast
check of a restore, recorded frame by frame over the terminal's bottom rows, found the host blank
for one or two frames at the cut, in headless Chromium's software renderer and again with WebGL
on the GPU (ANGLE on D3D11, the desktop app's backend). The terminal's screen element stayed
intersecting the viewport throughout, so xterm's renderer never paused; the blank was the
transition's. Now the hold ends in the gap between two frames: right after a paint, xterm resizes
and parses the held output in about a millisecond, and the screen is shown on the next frame,
after the renderer has drawn it, so the next painted frame is the agent's. The same check shows
no frame between the held one and the agent's, in software and on the GPU.

In the desktop app (Electron 45 on the GPU, live Claude Code agents, 10 changes each, measured
from the click with the page's own clock). These runs are from the build that stretched the
frame: the change, the landing and the send are the same in this one, but the end of the hold
(the paint-gap swap and the fade) is newer and was timed only in the UI tier:

| | Screen changes | New frame on screen | PTY resizes per terminal |
|---|---|---|---|
| Task window maximize and restore, freeze | 177 to 193 ms | the same moment | 1 |
| Task window maximize and restore | 7 to 10 ms | 162 to 184 ms | 1 |
| Task window Changes toggle | 7 to 15 ms | 146 to 244 ms | 1 |
| Command Terminal panel maximize and restore | 13 to 16 ms | 182 to 208 ms | 1 |
| Expand and Restore | 13 to 17 ms | 167 to 189 ms | 1 |

Every change ended on the agent's finished frame, and the longest frame gap in these runs was
22 ms. A drag release (a window edge, the bottom panel's height) was checked in the UI tier only:
one hold, one PTY resize after the release, no recovery.

Four more things were settled on the way:

- A landing stays open at least 150 ms. A frame-count rule alone (two still frames) closed before
  the Command Terminal panel's terminals re-tiled under load, because that re-tile runs in a React
  render of its own after the layer's resize observer, so they reflowed instead of holding (about
  1 run in 20 in the UI tier, none in 55 after).
- A landing also waits for a terminal's own fit, up to 500 ms. The 150 ms minimum held on a
  developer machine, but CI's UI tier failed the panel's maximize twice in a row: its boxes had
  moved and held still, the landing closed at about 170 ms, and the terminals' fit came after it.
  Reproduced on Linux pinned to two cores (4 of 6 runs failed), the trace showed the landing
  closing with no fit in it. `useTerminal` now reports each container fit that lands in a landing,
  and the landing does not settle on stillness until one has. Six repeats of that test, the
  held-grid conform test and the tiled edge-drag test then passed on two cores, and the four
  related UI specs (166 tests) passed there with no retries.
- The send waits one still frame, so a grid about to move again is not sent. On a task window that
  costs nothing measurable: the send goes out 1 to 3 ms after the hold starts, because the change
  lands before that frame's callbacks run.
- Flushing the layer's resize-observer update synchronously, so the Command Terminal panel's
  terminals hold in the same frame the panel grows rather than one frame later, made every number
  worse in the desktop app (the panel moved at 15 to 23 ms against 12 to 15, and the frame gap rose
  to 50 ms), so the panel still paints its old tiles for one frame.
- A hold keeps its terminal's output back, so it is never left open: a replay, a held grid, a
  terminal leaving view, or a session change ends it at once, and so does a throw on the way to
  its end or 2 s with no change. The throw is not hypothetical. A dev-mode update replaced the
  repaint wait's module under live terminals, whose wait objects then lacked a new method, and
  both Command Terminals stayed held with their output back until a reload.

**Swap** drags a terminal by its header onto another's tile (`swap-drag.ts`). A picture of the
pressed terminal follows the pointer, upright: main captures the window's pixels inside the
terminal's rect on the press, before anything moves (`window:captureRegion`,
`webContents.capturePage`), and until it arrives, or in the web build where there is nothing to
capture, the float shows the terminal's title. The float is the smallest tile's width and height,
cut from the picture around the grab point with the picture kept at its own scale, so a small
terminal floats whole, a tall one floats as its top with its header, the text stays sharp, and
nothing moves when the drag starts. The whole terminal at its own size covered the drop area, and
a tall terminal's picture swamped a short landing tile; the header alone, tried next, read as too
little of a window to be the thing being moved. The
terminals themselves stay live in the panel. Over another tile, the dragged one moves into that
tile and the terminal there moves into the dragged one's, so the panel previews the swap with the
real terminals, by inline styles saved first and put back exactly. The thing under the pointer is
a picture because a second xterm attached to a live PTY is the bug class terminal ownership
exists to prevent, so a dnd-kit `DragOverlay` was never an option. The first build floated the
real frame, tilted 1.5 degrees, over a grey stand-in card in the landing tile; the tilt blurred
every glyph and the grey read as unrelated to the black terminals, so both went.

The preview refits both terminals to the tiles they show in, so the panel looks the way the drop
will once their agents repaint. Each step is a layout change of its own, as the cancel and the
commit are, so a terminal it resizes holds its frame for the 100 to 180 ms its agent takes and
then draws the new one once, with one PTY resize per step. The second build held those resizes to the drop under the manager-resize gate,
and the preview then showed each terminal at its old size: the input box mid-tile in the taller
one and cut off in the shorter. A preview changes sizes in single steps, never per pointer frame,
so it needs no gate. The landing tile is held as an empty terminal: the terminals' own background
inside a 2px accent ring. The picture under the pointer already shows what lands, so the live
terminal refitting in that tile stays covered and the dragged terminal is not on screen twice;
the displaced terminal stays live in its new tile, which is what shows how the others move. A
first cut drew only the ring and an 8% accent wash over the live terminal, and with the picture
over it and the other terminals at full detail the drag read as too busy. The cover is an element
of its own over the tile, above the live terminal and below the picture, so it never reaches
inside a frame and takes no pointer. On release the picture goes at once. While the float was the
whole terminal at its own size, a 250 ms settle grew it into the landing tile and faded it over
the live terminal, because without one the swap read as cut off. Once the float became the
smallest tile's size, that settle mostly stretched a small picture over a big tile, and the live
terminals already sit where the preview put them, so it was dropped. The drop commits `swapWindows`, a pure `swapWindowsInTree` plus the two
windows' `leafId`s, which puts each frame where the preview already had it, so it resizes
nothing. Escape, a pointer cancel or the window losing focus puts everything back and refits it.
The kebab's "Swap with" was removed: the header drag is the one way to swap.

## In a window of its own

Open in new window moves the panel for one project into an OS window of its own: the pop-out kind
`command-terminal`, the one project-scoped kind (`command-terminal:<projectId>`; see
[App IPC channels](../ipc/app-channels.md)). Closing that window brings the panel back to the app,
and the terminals keep running throughout. The button stays off while a terminal is still
starting: main holds that slot reserved until the start lands (a cold start's fetch and checkout
can take seconds), so a window opened then would find no session in the slot, ask main for it,
and be refused with `slot-taken`. The window opens at least at the app window's own 900 x 600
floor, which holds one terminal at the pane floor beside the rail; a window too small for the
grid shows one terminal expanded, as the panel does.

The window is a renderer of its own with no App.tsx, which is where most of its rules come from:

- It seeds its project on its own project store from the params. It never calls `projects.open`,
  because that moves main's ambient project and switches the main window's board.
- It mounts the terminals only once its config, its session list and the agent list have landed.
  The layout restore reads the config once, on mount; and a window that mounts before the session
  list cannot find the terminal already running in its slot, so it starts a second one. The UI
  spec that boots a page as this window goes red with the sync taken out of the gate.
- Its bootstrap maps the session pushes the way App.tsx does (a status push only upserts, a
  removal only removes), each declared in the surface's `channels`, or main never fans it to the
  window.
- It publishes its own focused set, since main streams a session's bytes only to the renderers
  that named it.
- Hide, and stopping the last terminal, close the window.

In the main window the in-app panel never shows beside it. The push that reports the window open
clears `commandBarVisible`, which is also what asks main for the terminals' output; the mount site
is guarded; and Ctrl+Shift+P, the title-bar toggle and the pending-open paths bring the window
forward instead. Closing the window arms the pending-open flag, so the panel comes back through
the usual reconcile, but only while that project is current and still has a terminal running. A
window closed by its last Stop would otherwise reopen the panel, and the reconcile, keeping one
default terminal, would start a terminal nobody asked for.

## Naming runs in main

A terminal gets its name from its first prompt, summarized by the Automation agent at its model and
effort in the shared answer home, through `CommandTerminalNamer`
(`src/main/agent/shared/command-terminal-namer.ts`). With no Automation agent, naming is off and the
terminal keeps its "Command Terminal N" title. It used to be named in the renderer by the open
project's default agent, so a terminal a phone started, or one in a project the desktop did not have
open, never got one; and it later ran on the terminal's own agent in its project folder, which put a
four-word title on the project's default model with the project's instructions loaded. The namer
shares the summarize rate limit (`autoNameRateLimitPerHour`) with the task namer, spends no slot
when it cannot name, skips the synthetic PTY-activity prompt,
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

### Renaming by hand

A pencil right after the header's title, and Rename first in the terminal's ... menu, open an
inline name field in the title's place: the title's type, no box, an accent underline (the
sidebar's rename look), the name selected. Enter or a click away saves, Escape cancels, and an empty
name clears back to "Command Terminal N". One line, 64 characters (`normalizeCommandTerminalName`).
Both are off with "Available once the terminal starts" while the terminal has no session. A Running
row's right-click is the terminal's whole ... menu (`CommandTerminalRowMenu`, one item list with
the kebab, `CommandTerminalMenuItems`); its Rename edits the row in place, and a strip mark's brings
the terminal up and opens the header field. The save is `session:renameTransient`
(`SessionManager.renameCommandTerminal`), which writes the label and marks the row
`commandTerminalNamedByUser`. From then on a user name always wins: `setCommandTerminalLabel`, the
namer's and the resume seed's setter, refuses that row, which also drops a naming call already in
flight, and the namer skips the terminal before it spends an agent call or a rate-limit slot. A
cleared name keeps the namer off for that terminal.

The name reaches Earlier because `CommandTerminalHistory` writes the row's label on every change of
the live label, a clear included (last write wins, `setLabel`), and an unchanged push writes
nothing, so a `/resume` inside a renamed terminal into another conversation keeps that row's own
name. A rename that lands before the agent reports its id, right after a resume's spawn, is held
per session and written over the row once it exists. A resume brings the name back. The accepted
limit: a cleared name is not remembered across a resume, since the row holds null either way.
Renaming an Earlier row, and renaming from the phone or the Agent Monitor, are out of scope.

## Starting one from a phone

The bridge's `command-terminal` verb (see [Capability verbs](../../integrations/mobile-bridge/capability-verbs.md#capability-verbs-1))
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
open gets no window until the panel reopens; the toggle's count and tone update live. The same
verb lists the Earlier conversations and resumes one (`list-earlier`, `resume`) through the same
history and the same unattended start, offered to a phone on the snapshot's
`earlierConversationsOffered`.

## Leftover processes

A terminal's agent can start something that outlives it: a dev server launched with
`Start-Process`, a `nohup` job. Measured: a detached `ping` a terminal's agent started kept
running after the terminal ended, and nothing reported it. So each terminal's PTY carries its own
`KANGENTIC_TASK_ID` (its made-up task id), and `CommandTerminalLeftoverReaper`
(`src/main/ipc/helpers/command-terminal-leftovers.ts`) runs the same reap a task gets at Done
when the terminal ends: it honors "Stop leftover processes" and reports under the terminal's name.
The reap waits up to 8 s for the agent that shell left running to exit by itself before it scans, so it does not force-kill a Claude that is still shutting down unless that bound runs out. The host records the
terminal's root the moment its kill arrives, and the reap first waits for the agent that shell
left running to exit by itself (`awaitAgentExit`, `src/main/pty/host/exited-root-wait.ts`), on
every platform. A dev server the agent started is not waited for: it never exits by itself. For a shell that died on its own on Windows, that wait lasts until the host's orphan
cleanup is done with its agent. The reap still runs 5 s after the terminal ends rather than at
once: a WSL shell and the in-process core after host crashes hold no ledger for that wait, and
5 s is past Claude's longest measured exit after a close. It was 12 s before the wait existed.
Nothing is reaped during a quit. The orphan cleanup, which asks the agent a dead shell left
running to exit and terminates it after the grace (`dead-root-orphans.ts`), runs on Windows
only. On macOS and Linux the kernel hangs up a dead shell's terminal, and this reap is the only
cleanup after it.

## A reattach never touches HEAD

Hiding the panel (Ctrl+Shift+P, Ctrl+Shift+W, its Hide button, a backdrop click, or Open in new
window) keeps every PTY alive in the background, and reopening reattaches each slot. A reattach
never fetches and never checks out. The default-base checkout, plus its dirty-tree stay-put guard,
runs on a cold spawn only, because moving HEAD under a running agent is the class of thing #558
refused.

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

The panel's place and the terminals' layout are shared across projects, but which slots get
windows is reconciled to the current project's live Command Terminal sessions on open
(`reconcileCommandTerminalWindows` and `planCommandWindowReconciliation` in
`command-window-reconcile.ts`).

Project switching keeps every slot's PTY alive in the map, with no stash or restore. The panel
closes on switch, and on reopen the reconcile closes carried-over windows whose slot has no live
session for the new project (keeping one default terminal) and opens a window for every live
session that lacks one, so switching back reattaches all of a project's terminals instead of
leaking a window-less PTY.

The reconcile has to run before the layer mounts: in `useCommandBar.open()`, plus the
empty-store branch of `useEnsureCommandWindow` for the app-restart blob-restore path. A
carried-over window committed into the store would otherwise spawn a fresh PTY under the wrong
project before a bridge-effect reconcile could close it.

## Terminal chrome

There is no per-terminal close button. It was removed to avoid the task-detail "close this
window" confusion. A terminal's Stop destroys that terminal's session and closes its window;
stopping the last terminal hides the panel.

The header reads Stop, the title, the rename pencil, the pills, the kebab, then Expand, which
shows only beside another terminal since a lone one already fills the panel. It is responsive,
priority-plus via `useHeaderPillOverflow`. Only Stop, the title, the pencil, the kebab and Expand
are protected (the pencil's width counts toward the title's reservation); the pills and the branch
picker fold into the kebab as the terminal narrows, down to the pane floor. While the name field is
open the folded set is frozen, so nothing in the header moves under it. The focused terminal's
cue is a still, faint accent border, shown only while two or more terminals are visible: a lone or
expanded terminal has nothing to be told apart from. It used to carry a pulsing accent line along
its top as well; that went on 2026-10-31 for every window the frame draws, task windows included,
since the border alone tells the tiles apart and the motion only added noise.

## One title-bar toggle

The title bar holds one Command Terminal control: a plain open/close **toggle**
(`useCommandBar().open` / `close`, `TitleBar.tsx`'s `quick-session-button`) that never spawns a
terminal, so there is always a discoverable one-click way to hide the panel even when it is
maximized over the backdrop. Until the panel, a second **New terminal** button sat to its left
while the layer was open, so the title bar shifted as the panel opened and closed. It moved into
the panel, where it disables with its reason once the project's windows and live terminals
together hold `MAX_COMMAND_TERMINALS` slots. It first went to the rail's foot, which put it about
2000px of pointer travel from the toggle that opens the panel (a 2560 by 1392 window, the panel at
its default place). It now sits at the top of the rail, at the head of the list it starts, as
**Add terminal** (`NewTerminalButton`, `command-terminal-new`; "Add" because "New terminal" read
as replacing the open one). That saves the vertical part of the trip. An icon in the panel's
header, left of Open in new window and about 230px from the toggle, was drawn beside it to choose
between, and dropped: it added a fourth control to the header's window controls for a trip the
rail button already shortens. A labelled button in the header read as out of place among the
window controls. The detached window draws the same rail, so its Add terminal is in the same
place, and the layer mounts only once that window's terminals have synced, so the button cannot
start one early.

The toggle uses the custom `CommandTerminalIcon` glyph, not a bare lucide icon: a thin wrapper
over `components/ActivityMark.tsx`, rendering the `terminal-idle` and `terminal-working` marks from
`@kangentic/branding`; see [Activity Marks](activity-marks.md). It carries the aggregate activity
tone (`tone={transientActivityTone}`).

The toggle is the left-most icon in the title bar's right-aligned button row, before Quick Find.
That row is right-anchored: a `flex-1` spacer eats the space to its left, so an element's
on-screen distance from the window edge is fixed by whatever comes after it, never before it.

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
(`isCommandTerminalSession && projectId && status === 'running'`) rather than from the `transientSessions` map.
That map is renderer-owned window pairing whose hard-reload recovery only re-pairs the current
project, so a map-based count reads zero for every background project after a reload.

Placement: the indicator sits beside the agent thinking/idle counts in the row's right-aligned
cluster, never merged into them, since a Command Terminal is not a task agent. It always prints
its count, even at 1, so it forms an icon-plus-digit pair matching the agent counts and the three
indicators stack into one tabular column down the list. A name-adjacent placement was tried and
reverted: project names vary enough that the glyph landed at a different x on every row.

Clicking it switches to that project and reopens its panel via the same
`setPendingOpenCommandTerminal` flag the notification-click path uses, armed only once the switch
is confirmed. Awaiting is not enough: `openProject` also resolves without switching when a moved
or renamed folder routes to the "Locate Folder" dialog, and re-throws every other failure. So the
sidebar re-reads `currentProject` after the await and leaves the flag disarmed unless it landed.
Arming on those paths opens the panel on the outgoing project.
