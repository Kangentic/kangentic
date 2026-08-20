import PQueue from 'p-queue';

/**
 * Serializes CDP drives against ONE guest.
 *
 * Nothing used to. `withGuest` gated policy, resolved the pane, attached CDP and
 * ran, with no mutex and no per-guest queue, so concurrent callers interleaved
 * against a single guest. Multi-command sequences are the visible damage:
 * `typeText` awaits three dispatches PER CHARACTER, `clickAtCenterOfSelector` is
 * mouseMoved -> mousePressed -> mouseReleased awaited separately, and
 * `dragFromTo` is a press, N moves, and a release. Two callers overlapping any
 * of those produce interleaved input against one page, and neither of them can
 * tell.
 *
 * The refcount in `agent-input-signal.ts` is NOT this. It dedupes the renderer
 * ANNOUNCEMENT so an overlapping burst emits two pushes rather than two per
 * call; its own comment ("two tool calls can overlap on one pane") is direct
 * evidence that overlap was expected and unguarded.
 *
 * ## What this does not fix, stated plainly
 *
 * A mutex serializes COMMANDS, not INTENT. It cannot stop caller A navigating
 * away from the page caller B is midway through verifying - only separate
 * guests do that. And it cannot unwedge the transport: `captureScreenshot`
 * races its command against a timeout and ABANDONS rather than cancels it, so a
 * capture against a non-composited guest still head-of-line-blocks Electron's
 * own per-guest CDP queue no matter what this lock does.
 *
 * ## Why acquisition is bounded
 *
 * An unbounded FIFO turns one stuck holder into every later caller's problem,
 * which is strictly worse than the interleaving it replaces. So a drive that
 * cannot acquire within the bound refuses with an actionable error instead of
 * hanging. The bodies themselves are bounded separately (screenshot has its own
 * timeout, navigate is raced, and `wait` acquires per poll rather than holding
 * across its whole timeout).
 */

/**
 * How long a drive waits for the guest before refusing.
 *
 * Comfortably above the slowest bounded body (a navigation, at
 * NAVIGATE_TIMEOUT_MS) so a normal queued call always waits rather than
 * refusing, while a genuinely stuck guest still surfaces within one agent turn
 * instead of hanging forever.
 */
export const GUEST_DRIVE_WAIT_TIMEOUT_MS = 30_000;

/** Raised when a drive gave up waiting for its turn on the guest. */
export class GuestBusyError extends Error {
  constructor(waitedMs: number) {
    super(
      `Another agent has been driving this Browser pane for more than ${Math.round(waitedMs / 1000)}s. ` +
        'Retry, or call kangentic_browser_open_pane with isolated: true to get your own pane so you are not sharing one.',
    );
    this.name = 'GuestBusyError';
  }
}

const guestQueues = new Map<number, PQueue>();

/**
 * Run `fn` with exclusive access to the guest identified by `webContentsId`.
 *
 * Keyed on the GUEST, not the pane or the caller: the guest is what CDP
 * commands actually contend over, and it is the identity that stays correct
 * when a pane re-registers under a rotated session id.
 */
export async function withGuestDriveLock<T>(
  webContentsId: number,
  fn: () => Promise<T>,
  timeoutMs: number = GUEST_DRIVE_WAIT_TIMEOUT_MS,
): Promise<T> {
  let queue = guestQueues.get(webContentsId);
  if (!queue) {
    queue = new PQueue({ concurrency: 1 });
    guestQueues.set(webContentsId, queue);
  }
  const heldQueue = queue;

  const startedWaitingAt = Date.now();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  // The bound is on ACQUISITION only. Once `fn` starts it runs to completion:
  // abandoning a half-dispatched click or a partly-typed string mid-flight
  // would leave the page in exactly the torn state this lock exists to prevent.
  const acquired = heldQueue.add(async () => {
    if (timedOut) return undefined as T;
    return fn();
  }) as Promise<T>;

  const bounded = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new GuestBusyError(Date.now() - startedWaitingAt));
    }, timeoutMs);
    timer.unref?.();
  });

  // Attached before the race so a rejection that loses it is still observed.
  acquired.catch(() => {}).finally(() => {
    if (heldQueue.size === 0 && heldQueue.pending === 0) {
      guestQueues.delete(webContentsId);
    }
  });

  try {
    return await Promise.race([acquired, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How many drives are queued or running for a guest. Telemetry only. */
export function guestDriveDepth(webContentsId: number): number {
  const queue = guestQueues.get(webContentsId);
  if (!queue) return 0;
  return queue.size + queue.pending;
}

/**
 * Drop every queue.
 *
 * Test seam, mirroring `resetAgentInputSignalForTests`. The unit suite reuses a
 * fixed `webContentsId` across tests against the real registry singleton, so a
 * module-level map leaks state between them without this.
 */
export function resetGuestDriveQueuesForTests(): void {
  guestQueues.clear();
}
