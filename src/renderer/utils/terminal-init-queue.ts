/**
 * Serializes terminal construction so at most ONE xterm is built per animation frame.
 *
 * Each terminal host already defers its own `initTerminal()` by a frame (see
 * `useDeferredTerminalInit`), which keeps the cost out of the commit that mounts the pane.
 * That deferral is per-host, though, and every host that mounts in the same commit schedules
 * its frame callback for the SAME frame - so N hosts mounting together do not cost N separate
 * frames, they compound into one long one.
 *
 * Measured against the live app with `kangentic_devtools_event_loop_lag`'s long-frame ring:
 * terminal init is the single largest renderer long-task source, 129 inits in 90 minutes
 * averaging ~75ms and peaking at 130ms. The worst frames stacked 2-3 inits from the HEAVY end
 * (~120ms each) into one 330-350ms block. The average deliberately does not reproduce that
 * number: a burst mounts several panes whose sessions are all spawning at once, which is also
 * when an individual init runs heaviest. A third of a second is long enough that hover,
 * scroll, and typing all visibly stop.
 *
 * A queue does not make the work cheaper - the same terminals still get built. It caps the
 * TAIL, which is what a blocked main thread is actually felt as: the longest single block
 * drops to one init's worth instead of however many happened to mount together. The cost is
 * that the Nth terminal appears N turns later, and a turn is one CONSTRUCTION rather than one
 * vsync - the frame running an init is itself the long frame - so the stagger is ~75ms typical
 * and up to ~130ms, not ~16ms. That lands behind the replay veil each terminal already shows
 * until its scrollback settles, which is why the stagger is affordable at all.
 *
 * The handoff case that motivated the measurement (2-3 panes) is the mild one. The case this
 * really exists for is a BURST: dragging a batch of tasks into a spawning column mounts a
 * pane per task in a single commit, so ten constructions become one ~750ms lock with no
 * paint and no input. Spread across ten frames the same work stays interruptible, and input
 * keeps being processed between them. That matters most exactly when it happens, since a
 * drag is where a dropped pointer event is least recoverable - dnd-kit either loses the drag
 * or the card jumps. It is the same failure #468 fixed for a single mid-drag mount
 * (see useDeferredTerminalInit), extended to the burst.
 *
 * Order is FIFO, so panes appear in mount order. Worth knowing: there is no priority lane, so
 * a terminal the user just opened queues behind any burst already in flight. That is
 * deliberate for now - a priority scheme needs a real "which pane is the user looking at"
 * signal, and mount order is a good enough proxy that inventing one is not yet justified.
 *
 * The first enqueue still runs on the very next frame, so a single terminal opening on its
 * own is exactly as fast as before. Only the 2nd and later in a burst are pushed out.
 */

// Both declarations reset on an HMR update rather than being preserved, which is correct
// here: they hold per-mount work, not durable state. Carrying entries across an update would
// double-init, and a preserved `pumpScheduled` would reference a frame that no longer exists.
//
// Two branches, both safe. When Fast Refresh REMOUNTS a host, its effect cleanup cancels its
// entry out of the OLD module's array and the re-run re-enqueues onto the NEW one. When a
// host's effect does NOT re-run (only a non-component dependency changed), its entry stays in
// the OLD array and is drained by the OLD module's own pump - correctly, because
// `initTerminal`, `initializedRef`, and `element` are all still live references either way.
// The worst case is one frame carrying two inits during the update tick, which is dev-only and
// self-heals; no pane is ever dropped.
//
// Do NOT "fix" this by calling `resetTerminalInitQueue()` from App.tsx's `vite:afterUpdate`
// handler. That handler fires AFTER hosts have remounted and re-enqueued but BEFORE any pump
// frame runs, so a reset there wipes legitimate freshly-queued entries and leaves those panes
// permanently blank until a full reload. The reset exists for tests only.

// hmr-safe: per-mount work; hosts re-enqueue on the effect re-run (see above).
let pendingInits: Array<() => void> = [];
// hmr-safe: tracks a frame handle that does not survive the update (see above).
let pumpScheduled = false;

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  requestAnimationFrame(pumpInitQueue);
}

function pumpInitQueue(): void {
  pumpScheduled = false;
  const next = pendingInits.shift();
  if (!next) return;
  try {
    next();
  } finally {
    // Drain in `finally` so one host throwing during construction cannot strand every
    // terminal queued behind it - a wedged queue would leave panes permanently blank.
    if (pendingInits.length > 0) schedulePump();
  }
}

/**
 * Run `initTerminal` on a frame where no other terminal is being constructed.
 * Returns a canceller for the host's effect cleanup (StrictMode's mount/unmount/remount
 * relies on a queued init being cancellable before it ever runs).
 */
export function enqueueTerminalInit(initTerminal: () => void): () => void {
  pendingInits.push(initTerminal);
  schedulePump();
  return () => {
    pendingInits = pendingInits.filter((pending) => pending !== initTerminal);
  };
}

/**
 * Drop all queued work and forget any scheduled pump.
 *
 * Exists for tests: the queue is module state shared across every host, so a spec that stubs
 * `requestAnimationFrame` and clears its scheduled callbacks would otherwise leave
 * `pumpScheduled` stuck true and silently starve the next spec's enqueue.
 */
export function resetTerminalInitQueue(): void {
  pendingInits = [];
  pumpScheduled = false;
}

/** Number of inits still waiting. Test-facing; the queue is otherwise write-only. */
export function pendingTerminalInitCount(): number {
  return pendingInits.length;
}
