import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { traceTerminalRenderer } from './terminal-grid-registry';

/**
 * WebGL renderer attachment with context-loss recovery and a page-wide
 * attachment budget.
 *
 * xterm's WebGL renderer is 10-50x faster than its DOM fallback for output
 * bursts. The GPU can drop the WebGL context (a GPU process crash, a driver
 * reset, memory pressure). blink restores a lost context on its own within
 * about a second whenever Chromium allows it, and the addon fires
 * `onContextLoss` only when no restore arrived inside 3s. That callback
 * therefore almost always means Chromium is REFUSING the context, not that the
 * GPU is gone, and the refusal is time-bounded (see the comment above
 * `DEFAULT_RETRY_DELAYS_MS`). This module re-acquires on a backoff schedule
 * whose tail outlasts that refusal and never stops trying: a terminal on the
 * DOM renderer for any reason other than a deliberate budget suspend always has
 * a retry armed. It used to stop after two retries and latch the terminal onto
 * the DOM renderer for the rest of the session (Sentry DESKTOP-T: a GPU process
 * crash-looping once a minute burned both retries inside Chromium's block, and
 * the terminal never came back even after the GPU was healthy again).
 *
 * The budget exists because Chromium caps live WebGL contexts per page (~16)
 * and silently drops the OLDEST when a new one is created - which lands here as
 * a context loss on some other terminal. With windowed terminals the page can
 * host far more xterms than the cap, so attachments above `WEBGL_ATTACH_BUDGET`
 * start suspended, and a coordinator (useFocusedSessionsSync) applies an LRU
 * plan via `applyWebglAttachmentPlan` to keep the most-recently-focused
 * terminals on WebGL. A budget-driven suspend is NOT a context loss: it never
 * touches `contextLossCount`, does not advance the retry schedule, and the
 * terminal re-attaches on its next `resume()`.
 */

export type TerminalRendererType = 'webgl' | 'dom';

export interface TerminalRendererStatus {
  /** The renderer currently backing this terminal. */
  renderer: TerminalRendererType;
  /** How many WebGL context losses this terminal has seen (cumulative). */
  contextLossCount: number;
  /**
   * Consecutive failed WebGL acquisitions since the last successful attach: a
   * context loss the addon could not restore, a re-init that threw, a resume
   * that threw. Picks the retry slot. Reset only by a successful attach, so a
   * budget suspend/resume cycle mid-schedule does not restart the schedule.
   */
  failedAttempts: number;
  /** True while a re-acquisition timer is pending. */
  retryArmed: boolean;
  /**
   * True while the WebGL attachment budget has this terminal temporarily on
   * the DOM renderer. Not a failure state: the coordinator resumes the
   * attachment when the terminal climbs back into the top-K by focus recency.
   */
  suspendedByBudget: boolean;
}

/** The subset of `WebglAddon` this module uses. Narrowed so tests can fake it. */
interface WebglAddonLike {
  onContextLoss(handler: () => void): void;
  dispose(): void;
  clearTextureAtlas(): void;
}

interface AttachWebglOptions {
  /** Addon factory, injectable for tests. Defaults to a real `WebglAddon`. */
  createAddon?: () => WebglAddonLike;
  /**
   * Backoff schedule for re-acquisition attempts, indexed by the number of
   * consecutive failures. The last delay repeats indefinitely; the length does
   * NOT cap the number of retries.
   */
  retryDelaysMs?: number[];
  /** Live-attachment cap, injectable for tests. Defaults to WEBGL_ATTACH_BUDGET. */
  attachBudget?: number;
}

/**
 * Re-acquisition schedule, sized against Chromium's 3D-API block rather than
 * against the GPU process relaunch (which takes about a second).
 *
 * Chromium (content/browser/gpu/gpu_data_manager_impl_private.cc, read at
 * 146.0.7680.166, the Chromium inside Electron 41.1.1) records one block entry
 * for the page's domain every time a live WebGL context is lost to a GPU
 * process crash or a driver reset, and answers `getContext('webgl2')` with null
 * while TWO or more entries are younger than `kBlockedDomainExpirationPeriod`
 * (2 minutes): "Allow one context loss per domain, so block if there are two or
 * more." The domain key is the URL host (empty for the file:// page production
 * loads), so every terminal on the page is blocked together. A single loss is
 * restored by blink itself within a second, so `onContextLoss` (fired only when
 * no restore arrived in 3s) almost always means the SECOND loss inside two
 * minutes, and the block lifts when the OLDER entry ages out: up to 120s after
 * the second-most-recent crash, which is no later than about 117s after the
 * addon's callback. No retry inside that window can succeed, which is why the
 * old 2s/10s pair always failed in exactly the case it ran in.
 *
 * Cumulative: 2, 12, 42, 72, 132, 252, 372... seconds. The first two slots are
 * the original transient calibration; 132s is the first attempt guaranteed past
 * the block when no further crash extends it; after that the last slot repeats
 * at the block's own period. A probe while blocked is a sync round trip to the
 * browser process that returns null, sub-millisecond and no GPU work, so the
 * unending tail costs nothing in an environment where WebGL never comes back
 * (headless, blocklisted GPU). The numbers are not load-bearing: if Chromium's
 * expiry changes, recovery slips by at most one tail slot.
 *
 * Do not "fix" this by calling `app.disableDomainBlockingFor3DAPIs()` in main.
 * If WebGL use is what trips the driver, the block is the only thing pacing the
 * crashes: without it the terminal re-trips the driver every second, and
 * Chromium's own crash counter (3 in 5 minutes) drops the whole app to software
 * compositing. With the block, each successful re-attach can still yield a
 * crash pair in that environment and the counter still converges the same way
 * over a few cycles; the old latch did not prevent that either, it only left
 * the terminal slow afterwards.
 */
const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 30_000, 60_000, 120_000];

/**
 * Max simultaneous live WebGL attachments on this page. Chromium's own cap is
 * ~16 per page; terminals are the page's only WebGL consumers (the changes
 * panel is Monaco). A pop-out is a separate page with its own cap and its own
 * instance of this module: the Agent Monitor pop-out can host a task detail
 * terminal, and it counts against that page's budget, not this one's. 8 covers
 * every realistic fully-visible layout (task-detail windows + max 4 command
 * terminals + the bottom panel's single collapsed xterm) while leaving half of
 * Chromium's budget as headroom for suspend/resume transitions, so Chromium's
 * silent oldest-context eviction never engages.
 */
export const WEBGL_ATTACH_BUDGET = 8;

interface WebglAttachmentController {
  suspend(): void;
  resume(): boolean;
  clearTextureAtlas(): void;
}

export interface WebglAttachmentPlan {
  /** Keys that should hold a live WebGL context (top-K by focus recency). */
  attachKeys: ReadonlySet<string>;
  /** Keys to temporarily suspend. Keys in NEITHER set are left untouched. */
  suspendKeys: ReadonlySet<string>;
}

type AcquisitionFailure = 'context-loss' | 're-init-failed' | 'unavailable';

// Preserved across HMR (Pattern A, mirroring terminal-capture-registry.ts).
// These three must round-trip as a UNIT: countLiveWebgl() reads
// rendererStatusByKey for budget headroom while applyWebglAttachmentPlan looks
// up already-mounted terminals in attachmentControllersByKey, so resetting one
// independently would desync them (a live terminal invisible to the budget
// count, or uncontrollable by the coordinator) after a components-only Fast
// Refresh that does not remount already-mounted terminals.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const rendererStatusByKey: Map<string, TerminalRendererStatus> = import.meta.hot?.data?.rendererStatusByKey ?? new Map();
// @ts-expect-error -- Vite handles import.meta.hot
const attachmentControllersByKey: Map<string, WebglAttachmentController> = import.meta.hot?.data?.attachmentControllersByKey ?? new Map();
// @ts-expect-error -- Vite handles import.meta.hot
const webglAttachmentListeners: Set<() => void> = import.meta.hot?.data?.webglAttachmentListeners ?? new Set();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.rendererStatusByKey = rendererStatusByKey;
    data.attachmentControllersByKey = attachmentControllersByKey;
    data.webglAttachmentListeners = webglAttachmentListeners;
  });
}

function countLiveWebgl(): number {
  let liveCount = 0;
  for (const status of rendererStatusByKey.values()) {
    if (status.renderer === 'webgl') liveCount += 1;
  }
  return liveCount;
}

function notifyWebglAttachmentsChanged(): void {
  for (const listener of [...webglAttachmentListeners]) {
    try {
      listener();
    } catch {
      // One throwing listener must not block the others.
    }
  }
}

/**
 * Subscribe to attachment registry changes (a terminal attaching, disposing,
 * or parking itself as budget-suspended from a retry). The coordinator uses
 * this to re-apply its last plan when a terminal mounts after the plan ran
 * (terminal init is ResizeObserver-deferred), so an over-cap newcomer that
 * started suspended converges to WebGL once the plan's suspends have freed a
 * context.
 */
export function onWebglAttachmentsChanged(listener: () => void): () => void {
  webglAttachmentListeners.add(listener);
  return () => {
    webglAttachmentListeners.delete(listener);
  };
}

/**
 * Apply an attachment plan. Suspends run BEFORE resumes so contexts are freed
 * before new ones are acquired - the live count never overshoots the budget
 * mid-application. Keys that are not currently registered, and registered keys
 * the plan does not name, are left untouched.
 */
export function applyWebglAttachmentPlan(plan: WebglAttachmentPlan): void {
  for (const key of plan.suspendKeys) {
    attachmentControllersByKey.get(key)?.suspend();
  }
  for (const key of plan.attachKeys) {
    attachmentControllersByKey.get(key)?.resume();
  }
}

/**
 * Force the WebGL renderer to re-rasterize every glyph from scratch. Call this
 * after a live font change: xterm's char-size measurement re-runs as soon as
 * `terminal.options.fontFamily` is assigned, and a glyph rasterized against a
 * measurement taken mid-font-swap can read back a 0-width cell, which throws
 * `IndexSizeError` in `TextureAtlas._drawToCache`'s `getImageData` call. A
 * no-op if the terminal has no live WebGL attachment (DOM fallback, or no
 * entry for this key).
 */
export function notifyFontChanged(rendererKey: string): void {
  attachmentControllersByKey.get(rendererKey)?.clearTextureAtlas();
}

/**
 * Attach the WebGL renderer to `terminal`, recovering from context loss. Returns
 * a dispose function that cancels any pending retry, disposes the live addon,
 * and drops the status entry. `rendererKey` identifies this terminal in the
 * renderer report (the session id, or a transient key for a session-less pane).
 */
export function attachWebglRenderer(
  terminal: Terminal,
  rendererKey: string,
  options?: AttachWebglOptions,
): () => void {
  const createAddon = options?.createAddon ?? (() => new WebglAddon());
  const retryDelaysMs = options?.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const attachBudget = options?.attachBudget ?? WEBGL_ATTACH_BUDGET;

  const status: TerminalRendererStatus = {
    renderer: 'dom',
    contextLossCount: 0,
    failedAttempts: 0,
    retryArmed: false,
    suspendedByBudget: false,
  };
  rendererStatusByKey.set(rendererKey, status);

  let currentAddon: WebglAddonLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let suspended = false;

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    status.retryArmed = false;
  };

  const delayForFailures = (failures: number): number =>
    retryDelaysMs[Math.min(failures, retryDelaysMs.length) - 1];

  const tryAttach = (): boolean => {
    let addon: WebglAddonLike;
    try {
      addon = createAddon();
    } catch {
      // Nothing was handed to xterm, so there is nothing to dispose. The real
      // addon's constructor throws only on old Safari; the WebGL2 acquisition
      // happens inside loadAddon below.
      status.renderer = 'dom';
      return false;
    }
    try {
      // Bound to THIS addon: a superseded addon's late loss callback must not
      // touch whichever addon is live by then (see handleContextLoss).
      addon.onContextLoss(() => handleContextLoss(addon));
      terminal.loadAddon(addon as unknown as ITerminalAddon);
    } catch {
      // `loadAddon` pushes the addon onto xterm's addon list BEFORE calling
      // `activate`, and `activate` is where `getContext('webgl2')` throws when
      // WebGL is blocked or unavailable. Disposing the failed addon splices that
      // entry back out; the addon registers its renderer-swap teardown only
      // after its renderer constructs, so this swaps nothing.
      try { addon.dispose(); } catch { /* best-effort */ }
      status.renderer = 'dom';
      return false;
    }
    currentAddon = addon;
    status.renderer = 'webgl';
    status.failedAttempts = 0;
    return true;
  };

  /**
   * The only place a retry timer is created. Every arming path (a recorded
   * failure, and the no-coordinator wait in onRetryTimer) routes through
   * here, which is what keeps "a DOM terminal that is not budget-suspended
   * has exactly one pending timer" true across the re-entrant paths.
   */
  function armRetryTimer(delayMs: number): void {
    clearRetryTimer();
    retryTimer = setTimeout(onRetryTimer, delayMs);
    status.retryArmed = true;
  }

  /**
   * The loss path, the initial-attach failure, and a failed resume all route
   * through here: it advances the schedule, logs, and arms the next slot.
   */
  function recordFailureAndArm(failure: AcquisitionFailure): void {
    status.failedAttempts += 1;
    const failures = status.failedAttempts;
    const delayMs = delayForFailures(failures);
    // Every warn here becomes a Sentry breadcrumb (a 100-entry ring), so the
    // steady-state tail must not fill it: log each failure through the first
    // pass of the schedule, then one line, then nothing until recovery.
    if (failures <= retryDelaysMs.length) {
      const what =
        failure === 'context-loss' ? `WebGL context lost (${status.contextLossCount})`
          : failure === 're-init-failed' ? 'WebGL re-init failed'
            : 'WebGL unavailable';
      console.warn(`[terminal-webgl] ${what} for ${rendererKey}; retrying in ${delayMs}ms`);
    } else if (failures === retryDelaysMs.length + 1) {
      console.warn(`[terminal-webgl] WebGL still unavailable for ${rendererKey}; retrying every ${delayMs}ms`);
    }
    armRetryTimer(delayMs);
  }

  function onRetryTimer(): void {
    retryTimer = null;
    status.retryArmed = false;
    if (disposed || suspended) return;
    if (countLiveWebgl() >= attachBudget) {
      if (webglAttachmentListeners.size === 0) {
        // No coordinator on this page (the Agent Monitor pop-out hosts task
        // detail terminals without one), so nobody would ever resume a parked
        // terminal. Wait out a tail slot instead. Not a failure.
        armRetryTimer(retryDelaysMs[retryDelaysMs.length - 1]);
        return;
      }
      // Over budget: park as budget-suspended and let the coordinator's plan
      // decide who holds a slot - a retry never asks Chromium for a context
      // past the cap, mirroring the initial-attach guard below. State is
      // committed BEFORE the notify: the coordinator re-applies its plan
      // synchronously inside it and may resume() this very controller.
      suspended = true;
      status.suspendedByBudget = true;
      traceTerminalRenderer(rendererKey, 'webgl-suspend', { reason: 'budget', from: 'retry' });
      notifyWebglAttachmentsChanged();
      return;
    }
    const attempt = status.failedAttempts + 1;
    const attached = tryAttach();
    traceTerminalRenderer(rendererKey, 'webgl-retry', { attempt, attached });
    if (attached) {
      console.warn(`[terminal-webgl] WebGL renderer recovered for ${rendererKey}`);
      return;
    }
    recordFailureAndArm('re-init-failed');
  }

  function handleContextLoss(addon: WebglAddonLike): void {
    // Not counted: a loss during/after a budget suspend (the suspend already
    // disposed the addon and moved the terminal to DOM deliberately), and a
    // loss reported by a superseded addon (the real addon never clears its 3s
    // restore timer on dispose; it fires into a disposed emitter today, but a
    // future addon version or a test fake may not be so forgiving). Either
    // would advance the schedule for a terminal that is not on WebGL.
    if (disposed || suspended || addon !== currentAddon) return;
    try { addon.dispose(); } catch { /* addon may already be gone */ }
    currentAddon = null;
    status.renderer = 'dom';
    status.contextLossCount += 1;
    recordFailureAndArm('context-loss');
  }

  const suspend = (): void => {
    if (disposed || suspended) return;
    suspended = true;
    // Applies to a terminal mid-schedule too. This is the primary bound on how
    // many terminals re-acquire at once: the coordinator suspends every
    // non-top-K terminal on each plan run, so timer holders are a subset of
    // the plan's attach set (plus pop-out terminals, which have no
    // coordinator). failedAttempts is deliberately kept: a suspend/resume
    // cycle during a block must not restart the schedule at 2s.
    clearRetryTimer();
    if (currentAddon) {
      try { currentAddon.dispose(); } catch { /* best-effort */ }
      currentAddon = null;
    }
    status.renderer = 'dom';
    status.suspendedByBudget = true;
    // Traced at the FLIP, not at applyWebglAttachmentPlan: the coordinator
    // re-applies the full plan on every window/store change, so tracing the call
    // would bury the handful of real transitions in constant no-op noise.
    traceTerminalRenderer(rendererKey, 'webgl-suspend', { reason: 'budget' });
  };

  const resume = (): boolean => {
    if (disposed) return false;
    // Not suspended: either live on WebGL, or on DOM with a retry armed. Both
    // are left alone. Turning the second into an immediate probe would tie
    // probe timing to window focus, since the coordinator re-applies its plan
    // on every window/store change.
    if (!suspended) return true;
    suspended = false;
    status.suspendedByBudget = false;
    if (tryAttach()) {
      traceTerminalRenderer(rendererKey, 'webgl-resume', { attached: true });
      return true;
    }
    // The coordinator wants this terminal live and the acquisition failed,
    // which is the same situation as a failed retry after a loss (Chromium's
    // 3D-API block is the common cause of both): arm the schedule rather than
    // wait for a plan re-application that a quiet window, or a pop-out with no
    // coordinator, may never produce.
    traceTerminalRenderer(rendererKey, 'webgl-resume', { attached: false });
    recordFailureAndArm('unavailable');
    return false;
  };

  const clearTextureAtlas = (): void => {
    // Best-effort: a no-op while on DOM (budget-suspended or between retries)
    // since there is no live addon to clear.
    try { currentAddon?.clearTextureAtlas(); } catch { /* best-effort */ }
  };

  if (countLiveWebgl() >= attachBudget) {
    // Over budget: start suspended WITHOUT requesting a context, so this page
    // never asks Chromium for a context past the cap (which would silently
    // evict the oldest). Not a fallback: the coordinator resumes this terminal
    // if it is top-K by recency (a newly opened window is the MRU front).
    suspended = true;
    status.suspendedByBudget = true;
  } else if (!tryAttach()) {
    // WebGL refused or unavailable at mount (blocked after a GPU crash,
    // headless, blocklisted GPU): same schedule as a loss. In a WebGL-less
    // environment the tail keeps probing at its slowest slot for the life of
    // the terminal, which is one null getContext every two minutes.
    recordFailureAndArm('unavailable');
  }

  attachmentControllersByKey.set(rendererKey, { suspend, resume, clearTextureAtlas });
  notifyWebglAttachmentsChanged();

  return () => {
    disposed = true;
    clearRetryTimer();
    if (currentAddon) {
      try { currentAddon.dispose(); } catch { /* best-effort */ }
      currentAddon = null;
    }
    attachmentControllersByKey.delete(rendererKey);
    rendererStatusByKey.delete(rendererKey);
    notifyWebglAttachmentsChanged();
  };
}

/** Snapshot of every live terminal's renderer status, keyed by renderer key. */
export function getTerminalRendererReport(): Record<string, TerminalRendererStatus> {
  const report: Record<string, TerminalRendererStatus> = {};
  for (const [key, status] of rendererStatusByKey) {
    report[key] = { ...status };
  }
  return report;
}
