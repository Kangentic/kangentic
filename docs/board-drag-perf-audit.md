# Board card drag performance audit (2026-09-16)

Dragging a card is the board's most-used gesture, and from the `npm start` dogfooding instance
it did not feel consistently smooth, worse with background IO. This audit measured the gesture on
a PRODUCTION build first, then in dev, then changed only what the numbers justified. The one-line
answer: in production the drag itself drops no frames at all, including with live sessions
pushing updates and while autoscrolling; the one production-visible stall inside a gesture was an
xterm construction landing mid-drag (a 21 to 42ms frame), and that is now held until the drop.
The rest of the reported feel is dev mode: React's development build plus `StrictMode` make the
same drop handler 7x slower and the same construction 3 to 5x slower.

## How it was measured

Two rigs ran the same in-page probe (a `requestAnimationFrame` delta ring, a
`long-animation-frame` observer, a `longtask` observer, `event` timing for pointer handlers, and
a running-animations census), over the same board shape as the dogfooding one on the day (10
active cards across lanes, 15 archived cards in Done, 2 running sessions).

- **Production.** `scripts/drag-perf-rig.mjs` launches the `npm run build` output in a visible
  on-screen 1600x1000 window with the GPU enabled (the E2E helper's `launchApp` disables the GPU
  and parks the window off-screen, both of which invalidate a frame measurement) and drives
  trusted mouse drags through the scenarios below, five runs each. Sessions are a mock agent
  (`tests/fixtures/mock-claude-perf.js`) that writes `status.json` and `events.jsonl` through the
  real status-file pipeline, so the pushes are real `session:usage` and `session:activity`
  traffic at about 12 a second.
  The display refreshes at 144Hz, so a refresh period is 6.9ms and a frame at 13.8 or 20.7ms is
  a missed refresh, not a dropped 60Hz frame.
- **Dev.** The `/preview` of the same worktree, driven with `kangentic_devtools_eval` and
  untrusted pointer events (dnd-kit's sensor accepts them), plus the dogfooding instance's own
  flight recorder (`kangentic_devtools_event_loop_lag`) for ambient attribution.

Noise floor first. With the app idle and no input for 3s, production shows a median of 7 frames
at 13.8ms out of about 430; moving the pointer over the board with no button down shows the same.
Those single missed refreshes appear at the same rate during every gesture below and are the
machine, not the drag path. The very first drags after a launch ran at a 13.8 or 20.7ms cadence
for a whole gesture; after two warm-up drags that never recurred, so every number below is warm.

## Production results

| Scenario | p95 frame | worst frame | long frames | drop handler | release to settle |
|---|---|---|---|---|---|
| S1 plain cross-column drag, no sessions | 7.1ms | 13.9ms (one 20.9) | 0 | 7.5 to 10ms | 265 to 272ms |
| S2 same drag, 2 live sessions pushing 12 updates/s | 7.0ms | 13.9ms | 0 | 7.9 to 10ms | 266 to 278ms |
| S4a cross-column drop with sessions live | 7.0ms | 14.0ms | 0 | 7.2 to 9.6ms | 266 to 273ms |
| S4b same-column reorder | 7.0ms | 14.0ms | 0 | 6.2 to 7.7ms | 265 to 271ms |
| S4c Done drop, worktree task, running session, local remote | 7.0ms | 7.3ms | 0 | 7.9 to 8.8ms | 526 to 536ms |
| S5 autoscroll, pointer held at the scroller's edge for 1.8s | 7.0ms | 7.7ms (one 27.7) | 0 | n/a (cancelled) | n/a |
| S3 spawn landing mid-drag, BEFORE the hold | 7.0ms | 20.8 to 27.8ms, 5 of 5 runs | 0 | 7.7 to 14ms | 268 to 279ms |

Other production facts from the same runs:

- Pointer-move handling, the collision callback included, runs under 0.2ms per event (event
  timing `processingEnd - processingStart`, 12 to 137 pointer events per gesture). The four filter
  passes in the collision callback are not a cost.
- Drag start (pointerdown to the overlay visible) is 37ms median, 48ms worst, and 10 to 15ms of
  that is the driver's own step latency. dnd-kit measures all 39 droppables at drag start; it is
  not where the time goes.
- The drop frame is the one expensive handler: `pointerup` runs 7 to 10ms of JS (dnd-kit's
  `handleEnd` plus `handleDragEnd` plus React's synchronous commit), and input to next paint is
  24ms. On the dogfooding instance the same handler shows as 60 to 78ms in the flight recorder.
- The 250ms release-to-settle on a non-Done drop is dnd-kit's drop animation. A Done drop is the
  500ms FlyingCard flight plus the pending-changes probe; with a local bare remote the probe adds
  about 30ms. On the dogfooding instance `git:checkPendingChanges` measured 640 to 1150ms in the
  IPC log (a network fetch, then `rev-list` and `cherry`), so there the archive lands about 0.6s
  after the fly ends. That is the sticky part of a Done drop, and it is main-process git work,
  not rendering.
- The Done column's conic-gradient spin (`.drop-zone-active::before`) was running during every
  S5 hold (the census lists it) and cost nothing measurable.
- Autoscroll works and is smooth: the board's inner horizontal scroller (949px of capacity at
  1600 wide) scrolled under the held pointer at 7ms frames. The outer wrapper also carries
  `overflow-x-auto` but has zero scroll capacity at every width tried; dnd-kit walks it as a
  scrollable ancestor for nothing. Harmless.
- Two live sessions pushing about 12 updates a second made no difference at all (S1 versus S2).
  The pushes are applied mid-drag on purpose (freezing them read as a hang, see commit e84099e1),
  and the per-card selectors they run are cheap in production.

### The construction stall (S3)

A drop into a spawning column mounts a pane in the bottom panel when the new session becomes the
active tab (the board's first session, or one the user selects), and the pane constructs an
xterm one frame later through `terminal-init-queue.ts`. With a worktree-backed task the mount
lands about 900ms after the release, which is 570 to 770ms into the NEXT drag when the user is
working through a batch. Before the hold, five of five runs showed the construction inside the
second gesture as a 20.8 to 27.8ms frame (3 to 4 refresh periods at 144Hz, 1.3 to 1.7 frames at
60Hz) in an otherwise flat 7ms gesture. That is the only production dropped-frame event this audit
found inside a drag.

After the hold (`pumpInitQueue` defers while `isBoardDragActive()` and `onBoardDragEnd`
re-arms it one frame after the drop frame), the same five runs show the gesture flat at 7ms and
the construction landing 36 to 46ms after the release, on the frame after the drop frame and
under dnd-kit's compositor-driven 250ms settle animation, which it does not disturb:
release-to-settle stayed at 266 to 278ms. The frame itself is not cheaper (still 20.8 to 27.7ms);
it no longer lands under the pointer. The cost of the hold is one gesture of extra veil on a card
whose session came up mid-drag. This holds construction only. The xterm write queue streams
through a drag on purpose (commit e84099e1), and S2 confirms that streaming costs nothing.

## Dev versus production

Two dev-side sources. The dogfooding instance's own flight recorder, sampled the same afternoon
while it ran two agents (10 active cards, 15 archived), gives the ambient attribution. And the
rig itself ran S1 once against the dev renderer by accident: a running `/preview` had written
the dev main bundle over `.vite/build/index.js`, so the same window, machine, and gesture loaded
the Vite dev server's React development build with `StrictMode`. The rig now refuses that
bundle, but the run is a clean like-for-like comparison of one scenario. A per-frame measurement
on the `/preview` window itself could not be completed: it was occluded and then minimized while
the machine was in use, and a hidden Chromium page stops `requestAnimationFrame` and throttles
timers to once a second.

| Work | Production (rig) | Dev |
|---|---|---|
| S1 mid-gesture frames (rig, same scenario) | p95 7.0ms, max 13.9ms | p95 7.0ms, the same single 13.9ms misses |
| S1 drag-start frame (rig) | overlay in 37ms, no long frame | 90 to 104ms frame, overlay in 132 to 143ms |
| S1 drop (rig) | `pointerup` handler 7.5 to 10ms | handler 50 to 56ms, then a 28 to 49ms frame; react-dom commit up to 113ms |
| Drop frame (flight recorder, `#document.onpointerup handleEnd`) | 7 to 10ms | 60 to 78ms |
| xterm construction (`pumpInitQueue`) | 21 to 42ms frame | 100 to 117ms script, 175ms blocking at worst |
| React commits landing near a gesture | none over 16ms in any scenario | 50 to 128ms (`performWorkUntilDeadline`, `VoidFunction`) |
| `WindowFrame` close cascade (`onanimationend`) | not exercised | 68 to 95ms |
| `workspace-saver.ts` debounce | not exercised | 49ms |

So even in dev the frames between pick-up and release are fine. What dev makes heavy is the two
React commits that bracket a drag: activation (every `useSortable` card re-renders once when
`active` is set) and the drop (the optimistic move plus dnd-kit's own state), each 5 to 7x their
production cost, plus a construction 4x its production cost when a spawn lands nearby. Two things compound:
React's development build (unminified, with its extra checks) and the unconditional
`React.StrictMode` in `src/renderer/index.tsx`, which double-invokes every render and every
mount effect, so a construction burst pays twice. Neither reaches a packaged build. That is the
whole of the "feels uneven" report: the gesture the user drags is fine in production, and the dev
build makes every synchronous cost on the main thread 4 to 7x larger, which is exactly what turns
a 25ms construction into a 100ms freeze under the pointer.

## Main process

Main-process blocking never stalls a frame, but it delays every IPC the drop waits on, so it is in
scope for a sticky drop. Two findings:

- The dogfooding instance's IPC log shows `task:move` at a consistent 1.75s and
  `git:checkPendingChanges` at 0.64 to 1.15s (the probe chain is `status`, a queued HEAD read,
  `getRemotes`, a throttled `fetch --all`, then `rev-list` and `cherry`). The renderer does not
  wait on the move for the optimistic update, so the 1.75s shows only as the moment the board's
  authoritative refresh lands; the probe is what a Done drop's completion gate waits on. The
  probe now logs its cumulative step times in dev (`[probe] checkPendingChanges cumulative:`), so
  the next sticky Done drop says which step it was. The dialog reports the unpushed count even
  when the tree is dirty, so an early exit on a dirty status would under-report the loss; that
  is why no early exit was added. What was added instead is a warm-up: when a drag of a
  worktree-backed card begins, the board fires the same throttled, non-interactive all-remotes
  fetch the scheduler uses (`git:prefetchRemotes`). How much that buys depends on the race. A
  fetch that finishes during the gesture leaves the probe a cache hit inside the 30s window; one
  still running at the drop is joined through the in-flight map, so the probe pays only its
  remainder. Today's scheduler fetches ran 183 to 1260ms against a 500ms fly, so both cases are
  real and the second is the common one for a quick drag. It is strictly a head start, never a
  new fetch: the probe fetches unconditionally today. It is skipped entirely when the user has
  turned the `git.autoFetch` switch off, since a drag is not a request to reach the network
  and a card moving between working columns never reaches the probe at all. Those users keep
  today's behavior exactly, fetch included, and simply do not get the head start.

  This is the one shipped change with no before and after from the rig, because the rig's remote
  is a local bare clone where the entire probe costs about 30ms. Verifying it needs a real
  remote: watch the dev-only `[probe] checkPendingChanges cumulative:` line on a Done drop and
  compare its `fetch` step against the `status` step before it.
- Of the six largest main-process blocks in the flight recorder that afternoon (929 to 1160ms),
  one was the boot IPC storm after a full renderer reload and five had nothing in the IPC log or
  the console log within their window. They are unlogged synchronous work, which the drift
  sampler cannot name. The lag report now carries `recentSlowSyncWork`: the known synchronous
  suspects (the 45s metrics snapshot transaction, the per-session status and events file reads,
  the embedding writeback, the task list read) wrap themselves in `timeSyncWork`, and any span of
  50ms or more lands in that ring with its label. It costs one boolean check while the monitor is
  not running. Attributing those five blocks needs the next `npm start` after this lands; this
  audit does not guess at them.

## What changed and why

| Candidate | Decision | Evidence |
|---|---|---|
| Hold xterm construction for the length of a drag (`terminal-init-queue.ts`) | Shipped | S3 before: 20.8 to 27.8ms frame inside the gesture, 5 of 5. After: gesture flat at 7ms, the construction 36 to 46ms after the release under the settle animation, settle time unchanged |
| Correct the coalescer's header, `isBoardDragActive` and `onBoardDragEnd` docs, the `drag-coalesce.spec.ts` header; drop the dead `queue.kick()` drag-end subscription in `useTerminal` | Shipped | Doc-only; the header claimed all session pushes are held, the code holds only reloads |
| Move the lane list the collision fallback reads into that branch (`useBoardDragDrop.ts`) | Shipped as cleanup | Pointer-move handling is under 0.2ms; the partition cache the audit proposed would save nothing measurable and was not built |
| Main-process slow-span attribution ring (`event-loop-lag.ts` and four wrapped suspects) | Shipped | Five unattributed 929 to 1160ms blocks; dev-only cost |
| Done probe step timing (`git-diff.ts`) | Shipped | 640 to 1150ms on the dogfooding instance with no per-step visibility |
| Warm the remote fetch when a worktree-backed card drag begins (`git:prefetchRemotes`, called from `handleDragStart`) | Shipped, ARGUED not measured | The only row here without a rig number: the rig's remote is a local bare clone, where the whole probe costs about 30ms, so S4c cannot show the win. The argument is from the dogfooding IPC log (probe 640 to 1150ms, fetch its dominant step) plus the throttle's own semantics. Non-interactive, fire-and-forget, no correctness change (refs get fresher, never staler). Pinned for behavior, not speed: `tests/ui/drag-prefetch-remotes.spec.ts` (the board calls it for a worktree card and never for a plain one), the gate cases in `tests/unit/git-diff-subscription-handler.test.ts` (off means no fetch), and a `fetch-throttle` case (a warm-up makes the probe's call a cache hit) |
| Disable the droppable half of the 15 archived preview cards | Declined | Drag start is 37ms and dnd-kit's measuring of 39 droppables is not the cost; the drag-start render of every card is, and the archived cards would still render as draggables |
| Split `TaskCard` into a sortable wrapper plus memoized body; scope `ActivityMark`'s layout effect | Declined | Over-change re-renders during the sweep cost nothing visible in production (S1 stays at 7ms while the pointer crosses card centres); the split touches a root that 51 test files select on. Dev-only relief is not a reason to ship a renderer restructure |
| `measuring` / `autoScroll` config; remove the outer `overflow-x-auto` | Declined | `WhileDragging` is already the default; autoscroll is smooth; the outer wrapper never scrolls and costs nothing measurable |
| Early exit in `probePendingChanges` on a dirty status | Declined | The confirm dialog reports the unpushed count even when dirty; skipping it under-reports the loss |
| Re-add the write-queue drag hold or re-park session pushes | Not considered | Commit e84099e1's reasons hold and S2 confirms the pushes cost nothing |

## The Workflows canvas (2026-10-04, #732)

The Workflows view draws real `TaskCard` bodies as React Flow nodes. Scenarios `W30` and `W100`
seed a started workflow of 30 or 100 linked tasks (with 5 and 8 mock sessions pushing activity),
open the view, and measure idle, a card drag, a pan on empty canvas, and a link drag, on the same
144Hz-class display (7.5ms refresh) as the board numbers above.

The first run at 100 cards missed the board's bar. Idle missed 18 to 87 refreshes in 3 seconds,
and a card drag ran at a 15ms p95 with up to 12ms of pointer-event processing. Script time was
about 50ms across a 3-second window, so React was not the cost. A trace (`--trace`) put it in
Blink: `Layerize` (`PaintArtifactCompositor::Update`) cost 5.7ms on every main frame, re-deciding
the compositor layers of 100 cards' paint chunks. An A/B over stylesheets (`--experiments`)
measured the candidates:

| Variant | Layerize per frame | Idle, missed | Drag, missed |
|---|---|---|---|
| As built | 5.7ms | 49 | 108 |
| Activity marks still | 5.6ms | 6 | 36 |
| Links hidden | 5.6ms | 42 | 110 |
| `contain: layout paint style` on each node | 5.7ms | 47 | 96 |
| `content-visibility: auto` on each node | 5.8ms | 55 | 101 |
| `will-change: transform` on each node | 0.2ms | 0 | 2 |
| `will-change: transform` on the viewport | 0.3ms | 2 | 2 |

The viewport shipped (`index.css`): one compositor layer instead of 100. Zooming in to 2x still
re-rasters it at the new scale, checked with screenshots, so the cards stay sharp. Two React
changes ship with it: the node's `memo` ignores the position props React Flow passes every drag
frame, so a drag never re-renders the card; and a reload keeps every node and task object it did
not change (`reseedNodes`, `shareUnchanged`), so dropping one card no longer re-renders all 100.

After, at 100 cards, 5 runs: idle 0 missed; card drag at an 8ms p95 with 3.8ms of event
processing; link drag at an 8ms p95. At 30 cards every scenario is flat at 8ms. A pan at 100
cards still misses a single refresh on 3 to 8% of frames, never a frame over 16ms (so nothing a
60Hz display would show); two identical baselines measured 25 and 62 misses, and no variant beat
that spread. About 1ms of each frame's paint is the activity marks' stroke animation, which runs
on the main thread on the board too.

### Workflow cards on the board, and the link drag (2026-10-04, #732 M4)

Two measurements after the board gained workflow cards and the canvas gained its link hint, at
100 cards, 3 runs each, on the production build:

- **Link drag.** Every node subscribed to "is a link being drawn", so a link's start and end
  re-rendered all 100 cards, and each mounted (then unmounted) its full-card drop target and asked
  React Flow to re-measure it: a 48 to 62ms frame at both ends. The target now mounts with the card
  and a `data-linking` attribute on the canvas root turns its pointer events on. Worst frame 48.7ms
  to 14.1ms (median), no frame over 33ms.
- **Board drag of a workflow card.** The W scenarios now drag a To Do workflow card on the board
  (the lock refuses the drop), then delete the workflow, which leaves the same cards as ordinary
  tasks, and drag again. dnd-kit re-renders every card when a drag starts, and the first build's
  workflow body re-rendered with it: the drag-start frame was 83 to 97ms against the plain board's
  41.7ms, and overlay latency 161ms against 82ms. The strip and the To Do footer are now memoized
  on the task row and skip that pass: 55.6ms and 117ms. What is left is the taller cards' forced
  layout (about 12ms of `getBoundingClientRect` in dnd-kit's measuring) and the activity marks'
  `getAnimations` in their layout effect, which runs on every render of every mark. The plain
  board's own 41.7ms at 100+ cards is the board's existing activation cost, not the workflow's.
- **The pan, and the waiting footers' spinners.** The pan figures above were measured before the
  canvas cards had footers. Once every To Do card said "Blocked by #413..." with the design's
  spinning `Loader2`, a pan at 100 cards missed 82 to 143 of about 500 refreshes, with frames to
  28ms. An A/B over stylesheets (`--experiments`) found the cause in one row: with the canvas's
  spinners stopped the pan missed 7, and with every other candidate (the inspector, the header,
  the canvas tools, the dot grid, the activity marks, the idle pulse) it stayed above 100. Pausing
  them only while a gesture runs did not help. A task waiting on another is not loading, so the
  waiting footer's glyph is now held still (`WorkflowWaitingBar`). On the real code: pan 1 missed
  refresh, card drag 0, idle 1, link drag 3, and the board drag of a workflow card now measures
  the same as the plain board (108ms against 109ms overlay latency).

### With the workflow agent's pane open (2026-10-04, #732 M5)

The view now opens its workflow agent in a 560px pane beside the canvas, a live terminal the rig's
mock agent keeps writing to. At 100 cards, 5 runs, medians: idle 1 missed refresh, card drag 0,
pan 0, link drag 3. The canvas gestures are where they were without the pane.

The board drag of a workflow card measured 111ms overlay latency and a 62.5ms drag-start frame,
against 81ms and 41.6ms for the plain board. The workflow figure is inside its earlier 108 to 117ms
range, and the pane is not mounted on the board. The plain board is what moved: 109ms in the run
above, 81ms here, and 82ms in the first M4 run. So "the same as the plain board" above was one
plain run's variance. The taller cards' activation cost described in the M4 bullet remains.
`releaseToSettle` reads 8,030ms for the workflow card because the lock refuses the drop and the
card never lands in Executing, so the settle wait runs to its 8-second timeout.

Since 2026-10-11 a locked card is held to its own column for the whole drag (it can be reordered
there, never carried out), and the rig now waits for it to settle back in To Do, so `releaseToSettle`
for the workflow card should read a real settle rather than the timeout. Owed: a W30 and W100 rerun
to confirm it, and to measure the links overlay following a kept card through a drag (it measures
every frame of that drag).

### The final tree (2026-10-04, #732 production-readiness pass)

`W30` and `W100`, 5 runs each, on the production build of the branch as it stands after the
journey fixes, medians:

- At 30 cards every canvas scenario (idle, card drag, pan, link drag) is flat: an 8.1ms p95, no
  missed refresh, no frame over 8.6ms. The board drag of a workflow card misses 1 refresh with a
  52ms overlay latency, against 48ms for the same cards with no workflow.
- At 100 cards idle, card drag and pan are flat, and the link drag misses none (2 in its worst
  run). The board drag of a workflow card reads 97ms overlay latency and a 53.4ms drag-start
  frame, against 79ms and 39.4ms for the plain board. That is below M5's 111ms and 62.5ms, and
  the gap is the taller cards' activation cost described in the M4 bullet.
- The start burst is new to this audit: the 4 seconds after Start, once the first sessions run,
  while the rest of the free slots spawn. At 30 cards it is flat. At 100 cards it missed 10
  refreshes with one 46.6ms frame and 62ms of stall over 16ms in all. It happens once per Start,
  and nothing in it is a gesture.

### The workflow card's drag start, traced (2026-10-04, #732)

The M4 bullet blamed the remaining gap on taller cards' forced layout in dnd-kit's measuring and
on the activity marks' `getAnimations`. A trace says neither. Every `Layout` in the drag-start
task was 0.4 to 0.5ms with about 54 dirty objects, and both calls were only where a forced style
pass landed. Two board costs scaled with the size of the dragged card's column, which at W100 is
To Do with about 90 cards:

- **The drop highlight restyled the whole column.** The first `onDragOver` names the card's own
  column, and `updateDropHighlight` wrote `--drop-color` onto it. A custom property is
  inherited, so the next measurement recalculated every element in the column: 2,948 elements
  and 10ms with workflow cards, 608 and 3ms without. The column now carries its color from
  render (`Swimlane`), and the drag only toggles the class.
- **Every card in that column started a transition.** dnd-kit gives each of those cards its zero
  transform when the drag starts, with the sortable `transition` in the same commit. The resting
  value was `translate3d(0, 0, 0)`, the same matrix spelled differently, so about 90 cards ran a
  200ms transition from identity to identity. That cost a 3ms style pass inside the task and
  about 5ms of paint and layerize on the frame that first draws the overlay (1.5ms on the plain
  board). The resting value is now dnd-kit's own spelling (`TaskCard`), so nothing changes and
  nothing starts.

The committed rig, interleaving the two builds (two invocations each, 6 runs per scenario),
medians with the worst in brackets: the workflow card's overlay latency went from 122.5ms (132)
to 86.5ms (88), and the same cards with no workflow from 92.5ms (95) to 86.5ms (108). The
drag-start frame went from about 69ms to 42ms on the workflow board, the same as the plain
board. What is left is the board's own activation (four commits that each re-render every card,
because the sortable context changes) and the overlay drawing the taller card.

### The selected task's flowing links (2026-10-07, #732)

The selected card's own links now flow, their dashes moving from blocker to dependent
(`.workflow-link-flow`, a `stroke-dashoffset` animation). A dash offset is not a composited
property, so every frame repaints the link, and inside the viewport's single layer that repaint
lands on tiles full of cards. At `W100` the stylesheet A/B compared the flow inside the viewport's
layer, the flow switched off, and the flowing link's own `<svg>` (React Flow draws each edge in
one) on a layer of its own with `will-change: transform`. Seven rig invocations, two of them with
16 busy threads loading the CPU:

| Invocations | Flow in the viewport's layer | Flow on its own layer | Flow off |
|---|---|---|---|
| The first two (no layer arm yet) | 4 of 5 pans missed 12 or more | not run | 1 of 4, with another animation running |
| The last five (all three arms in each) | 1 of 15 | 0 of 15, at most 1 missed | 0 of 15 |

The first two invocations caught the flow halving a pan's rate (a 13.9ms p95, every other
refresh, three times). That never recurred in the last five, in any arm, so the comparison that
matters, the last five, shows no clear win for the layer. It shows no cost either: Layerize stayed
at 0.2 to 0.4ms a frame in every arm, idle and card drag were flat, and a 2x zoom on a flowing link
(`zoomShot` with `zoomAt`) is as sharp with the layer as without. The layer shipped (`index.css`) as
a precaution that confines the per-frame repaint to the link, and only a flowing link gets one, so
a selection adds one layer per link it flows on.

The `--experiments` table now leads with `anims`, the count of running animations under each
stylesheet, so an arm that switches an animation off shows it did (13 with the flow, 11 without,
for a selected card with two links). A `zoomShot` experiment can name `zoomAt`, a selector, to
zoom over the first element it matches inside the canvas instead of the canvas's centre.

## The cross-column drop gap (2026-10-20)

A card dragged into another column now parts that column's cards under the ghost, the way its own
column does, and a dimmed copy of the card fills the slot (`src/renderer/utils/board-drop-preview.ts`). It runs
on every pointer move (dnd-kit's `onDragOver` fires only when `over` changes, and the slot can
change under the same `over`), so it was built to the budget above. The slot is computed from the
drag event alone, with no layout read per move. The DOM is written only when the slot changes, and
then only on the cards that cross it, with the slot card's one layout read made before those
writes. The
parting itself is dnd-kit's own inline `transform 200ms ease` on each card, driven by an
attribute and a non-inherited registered custom property, so a write restyles only the card it is
on. Nothing changes lane membership, which is what the earlier preview did before `cd7b40c1b`
removed it. The slot's copy of the card is made once each time the ghost enters a column, never per
move: copying and laying out a whole column of 13 cards (80 elements) measured 0.6ms median and
1.3ms worst on the dev build, so one card is a fraction of that.

S1 and S4a, 5 runs each, on the production build before and after, run back to back on the same
machine, medians:

| Scenario | p95 frame | missed refreshes | pointer-move max | release to settle |
|---|---|---|---|---|
| S1 before | 10.3ms | 22 | 8.2ms | 270ms |
| S1 after | 9.0ms | 20 | 7.5ms | 272ms |
| S4a before | 11.3ms | 16 | 7.4ms | 267ms |
| S4a after | 10.7ms | 13 | 7.7ms | 269ms |

The machine was busier than in the September runs (a 10ms p95 against 7ms then), so only these two
runs compare, and their differences sit inside run-to-run spread. Neither had a long task or a long
animation frame.

With the slot holding a copy of the card, S1 measured a 7.0ms p95 with no missed refresh on a quiet
machine, and S6 put the overlay up 29 to 30ms after the pointerdown with no long frame. The copy does
not show up at all.

The committed drop uses the same slot. `rawDropPosition` (`board-drop-preview.ts`) turns it into the
raw position of the card holding the slot, and `TaskRepository.move` writes that position, so a lane
with gaps in its positions takes the card where the gap showed.

## Drag start at 100 cards (2026-10-20)

The September table declined splitting `TaskCard` into a sortable wrapper and a memoized body: the
sweep's re-renders cost nothing visible, and the split restructured a root 51 test files select on.
The #732 trace then put the remaining drag-start cost in four commits that each re-render every
card, and the dnd-kit maintainer's advice for large lists is the same split (issue #389; every legacy
performance issue was closed with a pointer to the `@dnd-kit/react` rewrite, so no fix is coming in
6.x). It ships now without touching the DOM. `useTaskCardViewModel` returns one object per change
instead of per render, and `TaskCard` hands React its content as a memoized element. Every drag-start
commit still re-renders each card's root, because `useSortable` reads dnd-kit's context, but stops
there. `tests/ui/board-drag-skips-card-content.spec.ts` counts content renders through the activity
mark's per-render layout effect. It counted 24 at a drag start without the memo (6 cards, 4
commits) and 0 with it.

W100's board drags, two interleaved invocations per build (A, B, A, B) from a scratch copy of the
tree, medians with the traced first run of the second pair left out:

| 100 cards | overlay latency before | after | drag-start slow frame before | after |
|---|---|---|---|---|
| Plain cards | 67ms | 60ms | 35ms | 28ms |
| Workflow cards | 73ms | 65ms | 35ms | 28ms |

That is one refresh off the drag start at 100 cards. At 25 cards S6 is unchanged once warm (30 to
36ms after, 29 to 37ms before; its first two runs after were 44 and 45ms because that invocation ran
S6 first, before any warm-up drag). The traced drag start, one run each, was a single 87.7ms task before and 42.1ms after, and
that is the clearest single number here: run-to-run spread on this machine is as large as the gain,
which is why the pairs were interleaved. What is left in that task is dnd-kit itself: about 15ms of
forced style and layout while it measures every droppable (`getBoundingClientRect` plus
`getComputedStyle` per node), and its own reducer and context work. ResizeObserver delivery was 0ms
in both traces, so disabling the cards' observers (`resizeObserverConfig`) would buy nothing.

A path note for the rig: run from a checkout whose path is short. W100 starts its sessions in git
worktrees under the rig's project, and from a 150-character scratch path those passed Windows'
260-character limit, so no session started and the scenario timed out waiting for four.

## Reproducing

The production rig is committed as `scripts/drag-perf-rig.mjs` with its mock agent in
`tests/fixtures/mock-claude-perf.js`. Build first, then run it on a machine with a display; it
launches its own app with its own data directory and a throwaway project, so it never touches
a dogfooding instance:

```
npm run build
node scripts/drag-perf-rig.mjs --scenarios=S1,S3 --runs=5 --label=before
```

It writes `tests/.tmp/drag-perf-<label>.json` and prints the per-scenario table, and
`--analyze=<json>` re-prints a saved run. For the Workflows scenarios, `--cpu-profile` and
`--trace` record the first run of each gesture and print where its time went (scripts by chunk,
or rendering phases per thread), and `--experiments=<json>` takes a list of
`{ "name", "css" }` and prints the per-frame cost of each stylesheet against the same canvas. Keep the window unoccluded for the duration: a hidden
Chromium page stops `requestAnimationFrame` and throttles timers to once a second. Build again
after any `npm start` or `/preview` of the same checkout: `scripts/dev.js` writes its dev main
bundle to the same `.vite/build/index.js`, and the rig refuses to run against it.

## Regression gate

No frame-budget assertion was added. The UI tier understates renderer cost about 10x (SwiftShader
and a tiny DOM) and `cross-platform-parity.md` bans timing-value assertions, so a budget there
would be either vacuous or flaky. What is pinned instead is structural: the construction hold has
a red-green unit test in `tests/unit/deferred-terminal-init.test.ts` (an init never runs while a
drag is active, resumes exactly one frame after the drop frame, and the 30s watchdog releases a
stuck gate), and `tests/ui/drag-coalesce.spec.ts` keeps pinning that session pushes are applied
mid-drag without changing a card's height. The production rig is committed (see Reproducing
above) but is deliberately not wired into any tier: it needs a visible window and a real GPU, so
CI cannot run it. It is a tool to run by hand before and after a renderer change, not a gate.
