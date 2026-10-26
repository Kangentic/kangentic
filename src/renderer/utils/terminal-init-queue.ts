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
 * own is exactly as fast as before. Only the 2nd and later in a burst are pushed out, and
 * any of them while a drag or typing holds the queue (below).
 *
 * BOARD DRAG HOLD. While a card is being dragged the pump does not run at all. A drag is
 * driven by pointer events on the main thread, so a construction landing inside one skips
 * the pointer for its whole duration and the card visibly jumps to catch up. Measured on
 * the production build in the 2026-09-16 drag audit: a construction is a 21 to 42ms frame
 * there (3 to 6 refresh periods at 144Hz), and 75 to 130ms in dev. The collision is not
 * rare: the pane a drop spawns mounts 400 to 800ms after the release with a mock agent
 * and seconds later with a real CLI, which is exactly when the user is dragging the NEXT
 * card of a batch. Held inits resume one frame after the drop frame (that frame already
 * pays the drop handler, 8 to 10ms in production), landing under dnd-kit's compositor-
 * driven 250ms settle animation, which a main-thread block does not stall. Every path
 * that ends a drag routes through the coalescer's `endBoardDrag()` (the real drop, cancel,
 * the unmount cleanup, the 30s watchdog, the window-blur backstop), so a stuck gate cannot
 * starve inits, and the cost of the hold is one gesture of extra veil on a card that
 * spawned mid-drag. This holds CONSTRUCTION only; the xterm write queue deliberately does
 * not hold for a drag (see `shouldHold` in useTerminal.ts).
 *
 * TYPING HOLD. The same reasoning for keys: a construction that lands between two keys
 * holds the second key's echo for the whole frame. Measured in dev while typing and
 * spawning tasks by drag, the spawned pane's construction put 109 ms into a 160 ms frame
 * and the worst key's echo took 170 ms. So the pump also waits while a key was pressed in
 * any terminal within `TYPING_QUIET_MS` (`terminal-typing.ts`), and runs at the first
 * pause that long. Typing has no end event the way a drag has a drop, so the hold is
 * capped. Once the oldest queued init has waited `TYPING_HOLD_CAP_MS` it is built in the
 * next gap between keys: `ECHO_SETTLE_MS` after the last key, when that key's echo has
 * painted and the next key is still to come. Released at an arbitrary moment instead, the
 * build landed on the echo of the key just typed. A held key autorepeats faster than that
 * gap, so `TYPING_HOLD_HARD_CAP_MS` builds it regardless.
 */
import { isBoardDragActive, onBoardDragEnd } from '../lib/session-update-coalescer';
import { msSinceTerminalKeydown } from './terminal-typing';

/** A pause in typing this long lets a held construction run. Typing runs about 100 to
 *  250 ms between keys, so 500 ms is a pause, not the gap between two words. */
export const TYPING_QUIET_MS = 500;
/** The longest typing holds the oldest queued init for a pause. The terminal it builds sits
 *  behind its replay veil meanwhile, so the wait shows as a slower arrival, never a blank
 *  pane. */
export const TYPING_HOLD_CAP_MS = 3000;
/** Past the cap, the build waits this long after the last key. A key's echo paints 10 to
 *  15 ms after it (p50 and p99 measured with the keys drive), so this is after the echo
 *  with margin, and shorter than any gap between two typed keys. */
export const ECHO_SETTLE_MS = 40;
/** The build runs here whatever the keys do. A held key autorepeats about every 33 ms,
 *  inside `ECHO_SETTLE_MS`, and would otherwise hold the queue for as long as it is held. */
export const TYPING_HOLD_HARD_CAP_MS = 6000;

interface PendingInit {
  init: () => void;
  enqueuedAt: number;
}

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
let pendingInits: PendingInit[] = [];
// hmr-safe: tracks a frame handle that does not survive the update (see above).
let pumpScheduled = false;
// hmr-safe: a timer handle, cleared by the dispose below.
let typingPauseTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How much longer typing holds the queue: zero once the keys pause for
 * `TYPING_QUIET_MS`, once the oldest init has waited `TYPING_HOLD_CAP_MS` and the
 * last key is `ECHO_SETTLE_MS` old, or once it has waited `TYPING_HOLD_HARD_CAP_MS`.
 */
function typingHoldRemainingMs(now: number): number {
  if (pendingInits.length === 0) return 0;
  const sinceKey = msSinceTerminalKeydown(now);
  const waited = now - pendingInits[0].enqueuedAt;
  if (sinceKey >= TYPING_QUIET_MS || waited >= TYPING_HOLD_HARD_CAP_MS) return 0;
  if (waited < TYPING_HOLD_CAP_MS) {
    return Math.min(TYPING_QUIET_MS - sinceKey, TYPING_HOLD_CAP_MS - waited);
  }
  if (sinceKey >= ECHO_SETTLE_MS) return 0;
  return Math.min(ECHO_SETTLE_MS - sinceKey, TYPING_HOLD_HARD_CAP_MS - waited);
}

/** Look again when the hold could next end. A key pressed meanwhile only moves the
 *  answer later, and the pump asks again then. */
function retryAfterTypingPause(delayMs: number): void {
  if (typingPauseTimer !== null) return;
  typingPauseTimer = setTimeout(() => {
    typingPauseTimer = null;
    schedulePump();
  }, delayMs);
}

function schedulePump(): void {
  if (pumpScheduled) return;
  // Never arm a frame mid-gesture. A pump armed during the drag is still pending when the drop
  // lands, so it fires in the drop frame's own animation-frame phase and constructs there,
  // which is exactly the frame `resumeAfterDrag`'s extra hop exists to keep free. Declining to
  // arm makes that function the only way back, which is what the header comment promises.
  if (isBoardDragActive()) return;
  pumpScheduled = true;
  requestAnimationFrame(pumpInitQueue);
}

function pumpInitQueue(): void {
  pumpScheduled = false;
  if (pendingInits.length === 0) return;
  // Held for the gesture: a drag that BEGAN after this frame was armed, which the guard in
  // `schedulePump` cannot see. The queue stays intact and `resumeAfterDrag` below re-arms it.
  if (isBoardDragActive()) return;
  const typingHoldMs = typingHoldRemainingMs(performance.now());
  if (typingHoldMs > 0) {
    retryAfterTypingPause(typingHoldMs);
    return;
  }
  const next = pendingInits.shift();
  if (!next) return;
  try {
    next.init();
  } finally {
    // Drain in `finally` so one host throwing during construction cannot strand every
    // terminal queued behind it - a wedged queue would leave panes permanently blank.
    if (pendingInits.length > 0) schedulePump();
  }
}

/**
 * Re-arm the pump one frame AFTER the drop frame. `endBoardDrag()` notifies from inside
 * the pointerup handler, and a frame callback requested there still runs in that same
 * frame's animation-frame phase, so a bare `schedulePump()` would stack the construction
 * onto the drop handler. The extra frame puts it on the next one.
 */
function resumeAfterDrag(): void {
  if (pendingInits.length === 0) return;
  requestAnimationFrame(() => schedulePump());
}

// hmr-safe: the coalescer notifies its listeners on its own HMR reset, and a listener from
// a replaced module re-arms a pump over an emptied array, which is a no-op; the dispose
// below drops it anyway so listeners do not accumulate across updates.
const unsubscribeResumeAfterDrag = onBoardDragEnd(resumeAfterDrag);
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => {
    unsubscribeResumeAfterDrag();
    if (typingPauseTimer !== null) clearTimeout(typingPauseTimer);
  });
}

/**
 * Run `initTerminal` on a frame where no other terminal is being constructed.
 * Returns a canceller for the host's effect cleanup (StrictMode's mount/unmount/remount
 * relies on a queued init being cancellable before it ever runs).
 */
export function enqueueTerminalInit(initTerminal: () => void): () => void {
  pendingInits.push({ init: initTerminal, enqueuedAt: performance.now() });
  schedulePump();
  return () => {
    pendingInits = pendingInits.filter((pending) => pending.init !== initTerminal);
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
  if (typingPauseTimer !== null) clearTimeout(typingPauseTimer);
  typingPauseTimer = null;
}

/** Number of inits still waiting. Test-facing; the queue is otherwise write-only. */
export function pendingTerminalInitCount(): number {
  return pendingInits.length;
}
