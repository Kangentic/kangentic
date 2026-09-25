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
  set `git.autoFetchIntervalMinutes` to off, since a drag is not a request to reach the network
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
`--analyze=<json>` re-prints a saved run. Keep the window unoccluded for the duration: a hidden
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
