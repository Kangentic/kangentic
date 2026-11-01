---
paths:
  - "src/renderer/components/command-bar/**"
  - "src/renderer/stores/session-store/transient-session-slice.ts"
  - "src/renderer/components/sidebar/project-sidebar/SidebarCommandTerminalIndicator.tsx"
  - "src/renderer/components/layout/TitleBar.tsx"
  - "src/renderer/pop-out/roots/PopOutCommandTerminalRoot.tsx"
  - "src/renderer/pop-out/surfaces/command-terminal-surface.tsx"
  - "src/main/ipc/handlers/transient-sessions.ts"
  - "src/main/ipc/helpers/command-terminal-history.ts"
  - "src/main/agent/shared/command-terminal-namer.ts"
  - "src/main/mobile-bridge/handlers/command-terminal.ts"
---
# Rule: the Command Terminal panel is slot-keyed, its geometry is global, and its population is per-project

Ctrl+Shift+P opens the Command Terminal: one PANEL over a slight backdrop blur, holding a header
(the window controls), a rail (Add terminal, Earlier conversations, and a
Running list of every terminal) and up to four terminals. Each terminal is an ephemeral "transient" session with no task
row, and each is a window of a SECOND window-manager layer (`CommandTerminalLayer` +
`CommandTerminalWindow` in `components/command-bar/`), separate from the board task-detail layer:
the same engine (`src/renderer/window-manager/`) instantiated twice via `createWindowManagerStore`.
The layer is `hostArranged`, so the panel tiles the terminals and they never float on their own.
Several of its non-obvious properties were each settled against a bug: a window-local branch pill
that disagreed with the Monitor row, a reconcile that ran too late and spawned a PTY under the
wrong project, a pending-open flag armed on a project switch that never landed, and a When idle
sweep that ended two terminals and lost their conversations. Design history and the rejected
alternatives live in [docs/architecture/renderer/command-terminal.md](../../docs/architecture/renderer/command-terminal.md).

## The rule

- **Windows are keyed by a durable SLOT, never a singleton pointer.** Each window owns a slot id
  (`slot-1`, `slot-2`, ...) as its `anchor`, capped at `MAX_COMMAND_TERMINALS`. The
  `transientSessions` map in `transient-session-slice.ts` tracks them by
  `transientKey(projectId, slot)` (`${projectId}::${slot}`), and the value carries `projectId`
  and `slot` so consumers can filter by project. The map is preserved across HMR via
  `import.meta.hot.data`; on a hard reload `syncSessions()` re-pairs surviving transient PTYs to
  their slots.
- **MAIN owns the cap and the slot allocation.** `startCommandTerminal`
  (`transient-sessions.ts`) is the one start path, run by the desktop's `session:spawnTransient`
  and the bridge's `command-terminal` verb alike, and it routes by the input's `projectId`, never
  the main window's current project. It counts the project's non-exited Command Terminal rows plus
  a synchronous reservation map, so a phone start and a desktop New in flight together cannot pass
  the cap or share a slot. The renderer proposes a slot only for a window it is opening, from the
  union of window anchors and the replica's live Command Terminal rows, and handles a
  `slot-taken` throw. Never pick or cap slots from the window store alone: a phone terminal has
  no window.
- **The panel arranges its terminals; nothing floats.** One terminal fills the terminal area, two
  sit side by side, three are one tall beside two stacked, four are a two by two grid split by
  columns (`hostArrangementTree`, `arrangeTiles`). Starting or stopping a terminal rebuilds the
  preset, and a dragged seam holds until the count changes (`isHostArranged`). The pane floor is
  `COMMAND_TERMINAL_FLOOR`, 630 by 200 (about 77 columns), the Command Terminal's own: task
  windows keep 650. 630 is where the context bar's one row (`useContextBarFold`), its bars at their
  40px minimum, still holds the
  agent, model, effort, rate limits and context beside its +N pill for every 5.x model and effort;
  a terminal is never narrowed to fit that row any other way. A resize never takes the grid away. The panel's minimum is the grid at that
  floor (`commandTerminalGridMinimum`: two columns from two terminals, two rows from three, one
  terminal while the user has one expanded) beside the rail at its narrowest: its 37px strip
  folded, its 200px drag minimum open. Opening the rail grows the panel by what the rail takes
  (below), so a panel sized down to the strip still leaves the terminals their floor. A dragged seam keeps its ratio, but the
  layout holds every pane at the floor while the area has room for the grid (`resolveTileLayout`'s
  `minPane`, which `WindowLayer` and `TileSplitter` pass for a host-arranged layer), so a seam
  skewed toward one side never leaves a terminal under the floor at the panel's minimum. An area
  short of the grid scales the floors down together, never back to the seam's own ratio: the hold
  dropping at the edge made a shrinking panel jump a terminal by 100px for a frame. The open rail
  gives way to the terminals in the same layout pass (`flex-shrink` down to its 200px minimum
  against the area's `commandTerminalAreaMinWidth`), because its resolved width follows the row a
  frame late. An edge resize or a maximize first adopts the layout on screen as the seams' own
  (`heldSplitSizes`, `setSplitSizes`), so two terminals the floor shows even grow evenly rather
  than from a seam an earlier, wider panel left skewed. A double-click on a seam evens its two
  terminals, 50/50. A seam whose pair has no room above both floors (the panel at its minimum)
  shows no resize cursor or line and takes no drag; a seam never grows the panel. So the
  edge stops where the grid still fits,
  and a terminal added (from anywhere) or a Restore grows the panel to fit, and the panel saves the
  size it grew to, so the next Expand does not shrink it back. Nothing falls back to one terminal
  expanded and Restore is never off: only an area smaller than the minimum (a small window, the
  detached window resized small) tiles the terminals under the floor. There is no per-terminal
  pop-out, float or maximize. The panel's
  own place is `AppConfig.commandTerminalPanel` (fractions of the area between the title bar and
  the status bar), it moves by its header and resizes live from its edges, and it maximizes. Its
  box is snapped to whole pixels (`toWholePixels`): the tiles are cut from the terminal area's
  whole-pixel client size, so a fractional panel left each tile a fraction of a pixel past the
  panel's clip, which cut off the bottom border that marks the focused terminal. A
  resize holds the manager-resize gate for the whole gesture, so its terminals keep their grids
  and refit once on release: the gate also holds every `scheduleWindowTerminalResize` and sends it
  when the gesture ends, without which a live resize sends a SIGWINCH per pointer frame (measured
  at 12 for one drag). Every window terminal's refit waits on that gate, so a gesture left open
  freezes them all: the gate closes a drag itself on the first pointer event that shows its
  button up, and the owner commits the drag as it stands. Never make a drag's end depend on its
  own handler alone. A layout saved before the panel (floating windows) is re-tiled on
  load. Never bump the shared `WORKSPACE_SCHEMA_VERSION` for it: board layouts use it too.
- **Expand and swap move the real terminals, never a copy.** Expand fills the panel with one
  terminal (`expandedWindowId`, transient, never saved); the others stay mounted behind it at the
  SAME rect, hidden and `inert` like a dormant window. The rail's Running section lists every
  terminal in the order they tile, tiled or expanded, with the one in front (the expanded one,
  else the focused tile) marked; a row's title brings its terminal to the front and its Stop ends
  it. Folded, the strip lists the same terminals, each as its agent's activity mark
  (`agentActivityMark`, as a task card draws it), never a Stop. Being the panel's size already, a switch through a Running row resizes
  nothing. Expand and Restore do jump sizes, and until the agent repaints the terminal shows its
  old frame on the new grid (the footer mid-panel, then dropped). The panel adds nothing of its
  own for that: a user's Expand or Restore is a layout change over the panel area
  (`runTerminalLayoutChange`, `terminal-layout-transition.ts`), which shows the new layout at
  once while each terminal it resized holds its last frame until its agent's frame is in, then
  draws that frame once, here as for a maximize, a task window or the bottom panel: on screen,
  pinned to the bottom, where the frame still fills its new box, and not drawn where the box grew.
  Nothing holds the pointer meanwhile. Only a user's gesture holds; a change main or an agent
  makes refits as it lands. Never add a Command-Terminal-only veil beside it.
  A header drag swaps
  two terminals (`swap-drag.ts`): a picture of the pressed terminal (`window:captureRegion`,
  taken on the press) follows the pointer, upright, cut to the SMALLEST tile's width and height
  around the grab point at the picture's own scale, and the real frames preview the swap in each
  other's tiles by saved-and-restored inline styles. The preview refits both terminals to the
  tiles they show in, each step a layout change of its own that holds their frames, so it looks
  the way the drop will once their agents repaint, and the landing tile is held as an empty terminal (the terminal background inside an
  accent ring) by an element of its own above the frame, so the dragged terminal is not on screen
  twice; the drop removes the picture and commits `swapWindows` at once, resizing nothing more,
  and a cancel refits them
  back. Never hold the preview's resizes to the drop: the terminals then show at the wrong size,
  the input box mid-tile in the taller one and cut off in the shorter. A second xterm on a live PTY is the bug
  class terminal ownership exists to prevent, so the thing under the pointer is a picture, never
  a `DragOverlay` copy. The header drag is the only way to swap. Escape cancels a drag in flight
  in the capture phase (`keybindings-registry.md`).
- **A terminal ENDS when its agent exits, and every end goes through
  `SessionManager.endCommandTerminal`.** It kills, removes the row (whose `session-removed`
  stamps the conversation's history row ended), and deletes the session directory only after the
  exit (the files are detached first
  so `remove()` keeps them, and a still-exiting agent's SessionEnd hook has somewhere to write).
  It refuses a task's session. A PTY that exits on its own removes its row in the spawn flow's
  `onPtyExited`. A Command Terminal must never be left as a bare shell a paired phone can type
  into. A conversation `/bg` moved into the agent CLI's own background session outlives the PTY,
  so the CLI stops it at every end, before the leftover reap, and before an Earlier resume, which
  then names the id `resolveResumableSessionId` returns. Both run on the agent's own files alone
  (`isInBackgroundSession`, `command-terminal-background-session.ts`), so an ordinary end or resume
  runs no CLI.
- **An ended conversation is recorded, and Earlier resumes it.** `CommandTerminalHistory`
  (`ipc/helpers/command-terminal-history.ts`, table `command_terminal_history`) writes a row when
  the agent's own session id is captured, so a `/clear` or `/resume` inside a terminal ends the
  previous row and starts a new one, and it skips an id a task or workflow owns. An untouched row
  is deleted when it ends. A row keeps the terminal's name and the conversation's first prompt
  (`first_prompt`, one line), and reads as the name, else the first prompt: with no Automation
  agent nothing names a terminal. The first prompt never seeds a resumed terminal's title. Earlier lists only rows a user touched
  (`Session.hasUserInput`, set in main from the input's content, never from xterm replies, focus
  reports or the repaint nudge) whose agent can resume by id (`canResumeConversationById`) and
  still find the transcript, and that no live terminal or in-flight resume holds. With no such
  row the rail shows no Earlier heading and no hint; the list stays mounted, so it has measured
  how many rows fit before the first arrives. A resume is a start with `resumeAgentSessionId`; main claims the
  conversation first (`claimResume`) and refuses a second with `conversation-open`, and a row it
  cannot resume with `conversation-gone`. A row resumes IN PLACE of the focused terminal only
  while nothing has reached that terminal; a used terminal is never replaced, and the resume opens
  beside it.
- **No pause reaches a Command Terminal.** A suspend still ends one (its conversation lands in
  Earlier like any other end, so nothing is lost, but the user did not ask). The low-memory pause
  never picks one (`isPauseEligible`), and the When idle sweep skips one before either of its
  callbacks (`isIdleTimeoutExempt`, answered with `isCommandTerminalSession`): an idle-timeout
  report alone makes the renderer mark the live row suspended. A workflow's own agent stays in
  the sweep. A new automatic pause or suspend path skips Command Terminals too.
- **The agent-absence sweep judges Command Terminals, and the SessionEnd hook fast-paths it.** Do
  not reintroduce a transient exclusion in `isAgentAbsenceCandidate`. The sweep judges a terminal
  only once its agent showed it started (its first SessionStart, or its first alt-screen entry) or
  the start ceiling has passed, so a slow shell is not ended before its agent runs. Where the tree
  cannot judge (`canTreeJudgeAgent`: a WSL shell, or the background-shell watcher off), a
  SessionEnd with no SessionStart inside the end settle ends the terminal instead. Known gap: an
  agent with no SessionEnd hook, under WSL or with the watcher off, outlives its agent until its
  PTY exits.
- **The launch overlay lifts on evidence the agent is on screen, never on first output or
  usage.** The window reads `sessionFirstOutput`, which main sets in `markAgentReady` (the
  agent's first text after the shell ran the spawn command, its first alt-screen entry, its
  SessionStart hook, or a ceiling). The adapter's first-output detector trips on the shell's
  startup frame and the spawn seeds usage with the model name, so either one showed the
  PowerShell prompt for seconds. The pane mounts under the overlay with output dropped, so its
  fit sizes the PTY before the agent's first frame. `command-terminal-launch-overlay.spec.ts` and
  `session-manager-agent-ready.test.ts` pin it.
- **A window follows a main-initiated end through ONE removal subscriber per renderer.**
  `useCloseCommandWindowOnRemoval` (mounted in `AppLayout`, and in the detached window's root)
  closes the slot's window when a `session-removed` push names a session the `transientSessions`
  map still points at. A renderer-initiated end (Stop, a branch switch, a resume in place) must
  scrub its map entry BEFORE it sends the kill, or the subscriber closes the window a second time
  (a branch switch would lose its window). Do not move this into App.tsx's removal handler, whose
  mapping the replica convergence test pins.
- **The panel can live in a window of its own, and then never also in the app.** Open in new
  window opens the project-scoped pop-out `command-terminal` (`command-terminal:<projectId>`,
  see `pop-out-surface-registry.md`), and stays off while a terminal is still starting: main
  holds that slot reserved until the start lands, so the new window could neither find the
  terminal nor take its slot. That renderer seeds its own project store from the params
  and never calls `projects.open`, which would switch the main window's board. It mounts the
  terminals only once its config, session list and agent list have landed, or a window cannot
  find the terminal already in its slot and starts a second one. It maps the session pushes the
  way App.tsx does and publishes its own focused set, since main streams a session's bytes only to
  the renderers that named it. In the main window the panel never mounts beside it: the push that
  reports it open clears `commandBarVisible` (which is what asks main for the terminals' output),
  the mount site is guarded, and every way of opening the panel focuses the window instead.
  Closing the window brings the panel back through the pending-open flag, only while that project
  is current and still has a terminal running: a window closed by its last Stop must not start a
  fresh terminal.
- **Naming runs in MAIN**, by `CommandTerminalNamer` on the Automation agent (its model and
  effort, in the shared answer home), and is off when no Automation agent is set: the terminal
  keeps "Command Terminal N". A resumed terminal is seeded with its conversation's label, so the
  namer skips it. Display reads `commandTerminalLabel` off the registry row through
  `commandTerminalDisplayName`; there is no renderer-side label. The namer needs the prompt's
  text on the Prompt event, so `startCommandTerminal` passes `capturePromptText` and an adapter
  whose hooks are per-session (Claude) copies its prompt payload into `detail`. Never set that
  flag on a task spawn: task events stay free of prompt text.
- **A user's name always wins.** The pencil after the title, Rename in the kebab, and a Running
  row's or strip mark's right-click menu all save through `session:renameTransient`
  (`SessionManager.renameCommandTerminal`), which normalizes the name
  (`normalizeCommandTerminalName`: one line, 64 characters, empty or the slot's own title clears)
  and marks the row `commandTerminalNamedByUser`. `setCommandTerminalLabel` refuses a marked row,
  which also drops a naming call in flight, and the namer returns before it spends an agent call or
  a rate-limit slot on one. A clear keeps the namer off for that terminal, and so does an Enter
  on the name field of a terminal nobody named, which keeps its number (`useCommandTerminalRename`);
  a click away with nothing changed sends nothing. The history writes the
  live label on every CHANGE of it, a clear included (`setLabel` is last write wins), never on an
  unchanged push, and holds a rename made before the agent's id arrives until the row exists.
  The kebab and the row menu render one item list (`CommandTerminalMenuItems`), so they cannot
  drift.
- **The rail's width and fold are one GLOBAL setting, and what it shows is resolved, never
  written.** `AppConfig.commandTerminalRail` (`src/shared/command-terminal-rail.ts`) holds the
  width its edge drag set (200 to 400, 300 by default) and whether it is folded to its 37px strip.
  `resolveRailWidth` narrows the SHOWN rail, down to 200, so the grid keeps its floor in a narrow
  row, and never saves the narrowed width. **The rail is part of the panel:** its edge drag, a
  fold and an open change the PANEL's width by the rail's change, its left edge held, and the
  terminals keep their size and refit nothing (`panel-edge-push.ts`, a width change the panel
  hands out). The fold button, with no pointer to follow, grows the panel to the left once the
  right edge is at the area's. Only where the panel cannot change (maximized, the detached window,
  the right edge at the area's during a drag) do the terminals give the rail its room, never under
  their floor. The panel's default size (`PANEL_CHROME`) reads the rail's default width, never its
  live one. The edge drag writes the width to the rail's element together with its open minimum
  (`applyRail`: the width alone left a strip folded mid-drag laid out at 200 until React
  rendered, and the terminals refit narrower), and holds the manager-resize gate, like the panel's
  own edges; its release commits the rail and the panel, saves and closes the gate as one layout
  change; Escape cancels both in the capture phase. The edge looks like a tile seam: a thin
  accent line on the boundary under the pointer and while it drags. Where it folds is
  `resolveFoldingEdgeDrag`, the project sidebar's divider's rule too: held at 200 down to 100,
  folded past that WHILE the drag runs, never on release alone. Never give either edge a rule of
  its own. The fold button is the rail's bottom row (outlined at rest; open, full width with the icon and "Hide"), with its
  icon on the same pixel open and folded, inside the rail so the detached window has it, and the
  rail is one element in both states so the button keeps focus. Both
  windows write the setting, so the rail reads it back from disk on mount, and the config store's
  refetch merge does not preserve it.
- **An unattended (phone) start never blocks and never moves HEAD under a live session.** Its
  fetch is non-interactive with a 5 s abort, its git phase has one 6 s budget, and it stays on the
  current branch when another running or queued session's cwd is the project root. Every failure
  falls back to the current HEAD and still launches. Desktop New keeps its existing behavior. A
  phone resume is the same unattended start. A phone sends `list-earlier` or `resume` only on the
  snapshot's `earlierConversationsOffered`.
- **A reattach NEVER fetches or checks out.** Hiding the panel (Ctrl+Shift+P, Ctrl+Shift+W, its
  Hide button, a backdrop click, Open in new window) keeps every PTY alive; reopening reattaches
  each slot. The default-base checkout, plus its dirty-tree stay-put guard, runs on a COLD spawn
  only, because moving HEAD under a running agent is the class of thing #558 refused.
- **The branch is a PER-PROJECT fact, not a per-window one.** Every terminal of a project runs
  in the same project root and shares one HEAD, so a window keeps no local branch state: the
  pill reads its map entry's `branch`, and ONE layer bridge (`useTrackHeadBranch` in
  `CommandTerminalLayer.tsx`) re-derives every entry of the project from live HEAD
  (`git:worktreeHead`) on mount and on every `git:diffChanged`, mirroring each change to main
  (`session:setTransientBranch`, last write wins) so the Monitor row and a post-reload adopt
  agree with the pill. The Changes panel embed passes the effective default base as
  `baseBranch`, never `"HEAD"`.
- **GEOMETRY is global, POPULATION is per-project, and the reconcile runs BEFORE the layer
  mounts.** The panel's place (`AppConfig.commandTerminalPanel`) and the terminals' layout
  (`AppConfig.commandTerminalWorkspace`) are shared across all projects, but which slots get
  windows is reconciled to the current project's live transient sessions on open
  (`reconcileCommandTerminalWindows` + `planCommandWindowReconciliation` in
  `command-window-reconcile.ts`). Project switching keeps every slot's PTY alive in the map, with
  no stash or restore. The reconcile closes carried-over windows whose slot has no live session
  for the new project (keeping one default terminal) and opens a window for every live session
  that lacks one. It must run in `useCommandBar.open()` and in the empty-store branch of
  `useEnsureCommandWindow`, not in a bridge effect: a carried-over window committed into the
  store spawns a fresh PTY under the wrong project before a later reconcile could close it.
- **There is NO per-terminal close button.** A terminal's Stop destroys THAT terminal's session
  and closes its window; stopping the last one hides the panel. The header reads Stop, the title,
  the rename pencil, the pills, the kebab, then Expand (only beside another terminal). It is
  responsive (priority-plus via `useHeaderPillOverflow`): only Stop, the title, the pencil, the
  kebab and Expand are protected, and the pills and branch picker fold into the kebab as the
  terminal narrows. While the name field is open the folded set is frozen, so nothing in the
  header moves. The focused terminal's cue is the frame's still accent border, shown only while
  two or more terminals are visible; there is no pulsing line.
- **The title bar hosts ONE terminal control: a plain open/close TOGGLE**
  (`quick-session-button`) that never spawns, so there is always a one-click way to hide the
  panel even when it is maximized over the backdrop. It carries the aggregate activity tone. Add
  terminal (`NewTerminalButton`, `command-terminal-new`; "Add", since "New" read as replacing the
  open terminal) is one labelled button at the top of the rail, in the panel and the detached
  window alike. The panel's header holds only its window controls: an Add icon there was tried
  and dropped. Add terminal is disabled with its reason once windows and live terminals together
  hold `MAX_COMMAND_TERMINALS` slots, as are the Earlier rows. At the rail's foot it was about
  2000px from the toggle.
- **Count and tone come from the UNSCOPED session list, through one shared selector.** Both the
  toggle and the sidebar indicator read `selectCommandTerminalSummary`
  (`transient-session-slice.ts`), which derives count and tone from `sessions`
  (`isCommandTerminalSession && projectId && status === 'running'`), NOT from the
  `transientSessions` map: that map is renderer-owned window pairing whose hard-reload recovery
  only re-pairs the current project, so a map-based count reads zero for every background project
  after a reload.
- **Transient is not the same as Command Terminal.** A workflow's own agent is transient too (no
  task, no `sessions` row) and carries `workflowId`. Anything about the Command Terminal (the
  count, the slot cap and re-pairing, window reconciliation, the history, the Monitor's terminal
  rows, the end on a PTY exit or suspend, `endCommandTerminal`, the namer, the leftover reap, and
  the phone's terminal list, lifecycle feed and push context) asks `isCommandTerminalSession`
  (`src/shared/session-owner.ts`), never `transient` alone. A workflow agent ended as a terminal
  loses the row its Workflows pane reads, so its Pause turns into a restart.
- **Arm the pending-open flag only once a project switch is CONFIRMED.** The sidebar indicator
  switches project and reopens the panel via the same `setPendingOpenCommandTerminal` flag the
  notification-click path uses. Awaiting `openProject` is not enough: it also RESOLVES without
  switching (a moved or renamed folder routes to the "Locate Folder" dialog). Re-read
  `currentProject` after the await and leave the flag disarmed unless it landed, or the panel
  opens on the OUTGOING project.

## Enforcement (self-maintaining)

- **Test (reconcile):** `tests/unit/command-window-reconcile.test.ts` locks the planner that
  decides which slots get windows on open. `tests/unit/command-terminal-summary.test.ts` locks
  the shared count/tone selector, and `tests/unit/command-terminal-name.test.ts` the titles. All
  run in CI via `npm run test:unit`.
- **Test (floor):** `tests/unit/command-terminal-grid-fit.test.ts` pins the grid's minimum at the
  630px floor for each count and while one is expanded, and `command-terminal.spec.ts` that two
  tile at 1920 with the panel's edge stopping where they still fit, that an expanded terminal's
  panel shrinks to one and Restore grows it back and keeps that size, that Add terminal grows a
  panel wider for two and taller for three, that a window too small for the grid keeps every
  terminal tiled, and that a terminal the user expanded stays expanded. `window-tiling.test.ts`
  pins the floor hold and that an area a pixel short of it moves a pane a pixel.
  `command-terminal.spec.ts` records every frame of a panel shrink with a skewed seam and fails on
  a terminal that grows mid-shrink, a refit or frame hold before release, or a gap beside the
  terminals; it grows the panel back from its edge and from its minimum and drags the seam its
  full range both ways; that a panel the floor holds even grows its terminals evenly from an edge
  and on maximize, whatever the seam held; and a double-click on a dragged seam evens it.
  `window-tiling.test.ts` pins `heldSplitSizes`, a split of three adopted exactly included.
- **Test (panel):** `tests/unit/command-terminal-host-arrangement.test.ts` pins the presets, the
  seam that holds until the count changes, the expanded window (focused, never saved, released on
  close), the swap that keeps every tile and seam, and the reading order a re-tile keeps.
  `tests/unit/terminal-repaint-wait.test.ts` replays the four measured runs through the repaint
  wait's lift rule, `tests/unit/terminal-layout-transition.test.ts` pins the landing (the change
  run once and at once, the join, the minimum, the wait for a terminal's first fit, the hold for a
  pane still moving, the cap),
  `command-terminal.spec.ts` pins
  from the compositor's own frames that Expand, Restore and the panel's maximize show at once with
  each terminal holding its frame and then drawing the new one, with one PTY resize per terminal,
  that a held terminal's output is drawn when the hold ends, that a swap preview holds and sends
  one resize per step, and that a click right after Expand reaches the layout on screen;
  `task-detail-maximize.spec.ts` pins that a box that grows shows no old text and fades its new
  frame in, and one that shrinks keeps its input box on screen in every frame with no frame
  painted hidden, and `tests/unit/manager-resize-gate.test.ts` pins the resize the gate holds to
  the end of a gesture and the gesture it closes when no owner saw the release, and that a
  release's late look spares a gesture the same pointer opened after it. The unseen-release
  case in `task-detail-maximize.spec.ts` and the seam cases in `command-terminal.spec.ts` drive it
  in the real app.
- **Test (history and resume):** `tests/unit/command-terminal-history.test.ts` (the rows, the
  touched filter, the owned-id skip, pruning, the resume claim),
  `tests/unit/transient-session-resume.test.ts` (the resume start, `conversation-gone` and
  `conversation-open`), `tests/unit/session-manager-user-input.test.ts` (what counts as touched),
  and `tests/unit/command-terminal-resume-request.test.ts` (the renderer's per-slot resume
  requests).
- **Test (spawn and branch):** `tests/unit/transient-session-spawn-dirty-guard.test.ts`,
  `transient-session-spawn-ensure-trust.test.ts`, `transient-session-branch.test.ts`,
  `transient-session-adopt.test.ts`, and the two `session-manager-command-terminal-*` tests pin
  the cold-spawn checkout guard, the trust write, and the branch and label round-trips. The
  dirty-guard file also pins main's slot allocation, the cap, concurrent reservations, the
  unattended start's guards, and that a desktop start needs no current project.
- **Test (ending):** `tests/unit/session-manager-end-command-terminal.test.ts` (the end order, the
  directory kept until the exit with real files, and the task-session refusal),
  `session-manager-agent-absence.test.ts` (terminals are judged and ended, the start-evidence
  gate and its ceiling, the SessionEnd fast path, the WSL and watcher-off end settle, `/clear`
  survives), `session-telemetry-wiring.test.ts` (`hasAgentAbsenceSweep`, which picks the end
  settle), `session-spawn-flow.test.ts` (the PTY-exit removal),
  `transient-session-kill-by-slot.test.ts` (scrub before kill),
  `command-terminal-namer.test.ts`, and `command-terminal-background-session.test.ts` with
  `command-terminal-leftovers.test.ts` and `transient-session-resume.test.ts` (a background session
  stopped before the reap and before a resume, and no CLI for an ordinary end or resume).
- **Test (no pause):** `tests/unit/session-telemetry-activity-decisions.test.ts` (the sweep times
  out neither callback for an exempt session, and still does for a task beside it),
  `session-manager-idle-suspend-wiring.test.ts` (a Command Terminal is exempt and never
  suspended; a task's agent and a workflow's agent are not exempt), `session-idle-timeout.test.ts`
  (a late report for a terminal is dropped unannounced), and `idle-agent-pause.test.ts` (the
  low-memory pause). This rule's `paths:` do not cover the sweep files, so these tests are what
  catches a change there.
- **Test (detached window):** `tests/unit/pop-out.test.ts` (the project key and its parser),
  `tests/unit/pop-out-window-manager.test.ts` (the project params check) and
  `tests/unit/pop-out-changed.test.ts` (the open hides the panel; the close reopens it only for
  the current project with a terminal running).
- **Test (UI):** `tests/ui/command-terminal.spec.ts` covers the panel (layout, move, resize,
  maximize), the rail and Earlier, Expand, Swap, Open in new window (including a page booted as
  the detached window that adopts its running terminal and starts no second one), a removal push
  closing its window, and a branch switch keeping it. `command-terminal-branch.spec.ts` and
  `sidebar-command-terminals.spec.ts` cover the branch pill and the sidebar indicator.
- **Test (rename):** `tests/unit/session-manager-command-terminal-label.test.ts` (the rename, the
  clear, the namer's setter refused after either), `command-terminal-namer.test.ts` (no agent call
  for a user-named terminal), `command-terminal-history.test.ts` (a rename and a clear reach the
  row, an unchanged push writes nothing, an early rename is held until the row exists),
  `transient-session-rename-handler.test.ts`, and `tests/ui/command-terminal-rename.spec.ts` (the
  pencil, the kebab, the off state while starting, the Running row's menu).
- **Test (rail):** `tests/unit/command-terminal-rail.test.ts` pins the resolved width (narrowed,
  never written, the strip), `tests/unit/config-store-command-terminal-rail.test.ts` that a refetch
  reads another window's rail write back and that adopting it writes nothing, and `tests/ui/command-terminal-rail.spec.ts` the 300px default, a drag
  that grows the panel by as much and refits no terminal, the panel at its minimum pushed out the
  same way, the maximized panel where the terminals give the room, Escape putting the rail and the
  panel back, the hold at 200, the live fold past 100 that shrinks the panel with no terminal
  narrowing mid-fold and the open from the strip, the footer button keeping its spot and its
  focus while the panel shrinks and grows with it, the edge's seam look, the floor
  after a fold, the strip's activity marks and the one in front, the narrowed rail at the window floor, and the cut-name tip.
  `tests/unit/demo-fit-layout-blob.test.ts` holds the web demo's panel fit to the rail width the
  frame's config gives, and the sample install's seeded rail to the fit's fallback.
- **Review:** the header layout ordering and the title-bar placement are visual conventions with
  no mechanical check. `/code-review` and `ui-conventions.md` are the backstop.

## Scope

The Command Terminal panel, its layer and detached window, its transient session slice, its
history, and the title-bar toggle. Shared window-manager behavior (the `hostArranged` option, the
tile presets, the min-pane floor on tiling, expand and swap state) lives in the engine and is
governed where the engine is, not here.
