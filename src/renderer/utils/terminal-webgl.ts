import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { traceTerminalRenderer } from './terminal-grid-registry';

/**
 * WebGL renderer attachment with context-loss recovery and a page-wide
 * attachment budget.
 *
 * xterm's WebGL renderer is 10-50x faster than its DOM fallback for output
 * bursts. The GPU can drop the WebGL context (driver reset, tab throttling,
 * memory pressure); when it does, the addon fires `onContextLoss`. The old code
 * just `dispose()`d the addon on loss, silently and permanently reverting the
 * terminal to the DOM renderer for the rest of the session - so every later
 * burst became far more expensive with nothing recorded. This module retries
 * re-initializing WebGL after a loss (with a short backoff), logs what happened,
 * and tracks the live renderer type so devtools can observe a degraded terminal.
 *
 * The budget exists because Chromium caps live WebGL contexts per page (~16)
 * and silently drops the OLDEST when a new one is created - which lands here as
 * a context loss on some other terminal and, after the retries re-trip the cap,
 * a permanent DOM fallback. With windowed terminals the page can host far more
 * xterms than the cap, so attachments above `WEBGL_ATTACH_BUDGET` start
 * suspended, and a coordinator (useFocusedSessionsSync) applies an LRU plan via
 * `applyWebglAttachmentPlan` to keep the most-recently-focused terminals on
 * WebGL. A budget-driven suspend is NOT a context loss: it never touches
 * `contextLossCount` or `permanentDomFallback`, and the terminal re-attaches on
 * its next `resume()`.
 */

export type TerminalRendererType = 'webgl' | 'dom';

export interface TerminalRendererStatus {
  /** The renderer currently backing this terminal. */
  renderer: TerminalRendererType;
  /** How many WebGL context losses this terminal has seen. */
  contextLossCount: number;
  /** True once retries are exhausted and the terminal is DOM-only for good. */
  permanentDomFallback: boolean;
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
   * Backoff schedule for post-context-loss re-inits. Its length also caps the
   * number of retries: after this many losses the terminal stays DOM-only.
   * Default: retry once after 2s, once more after 10s, then give up.
   */
  retryDelaysMs?: number[];
  /** Live-attachment cap, injectable for tests. Defaults to WEBGL_ATTACH_BUDGET. */
  attachBudget?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000];

/**
 * Max simultaneous live WebGL attachments on this page. Chromium's own cap is
 * ~16 per page; terminals are the page's only WebGL consumers (pop-outs are
 * separate pages and never host terminals; the changes panel is Monaco). 8
 * covers every realistic fully-visible layout (task-detail windows + max 4
 * command terminals + the bottom panel's single collapsed xterm) while leaving
 * half of Chromium's budget as headroom for suspend/resume transitions, so
 * Chromium's silent oldest-context eviction never engages.
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
 * Subscribe to attachment registry changes (a terminal attaching or disposing).
 * The coordinator uses this to re-apply its last plan when a terminal mounts
 * after the plan ran (terminal init is ResizeObserver-deferred), so an over-cap
 * newcomer that started suspended converges to WebGL once the plan's suspends
 * have freed a context.
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
  const retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const attachBudget = options?.attachBudget ?? WEBGL_ATTACH_BUDGET;

  const status: TerminalRendererStatus = {
    renderer: 'dom',
    contextLossCount: 0,
    permanentDomFallback: false,
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
  };

  const tryAttach = (): boolean => {
    try {
      const addon = createAddon();
      addon.onContextLoss(handleContextLoss);
      terminal.loadAddon(addon as unknown as ITerminalAddon);
      currentAddon = addon;
      status.renderer = 'webgl';
      return true;
    } catch {
      status.renderer = 'dom';
      return false;
    }
  };

  function scheduleReattach(attempt: number): void {
    // `attempt` is 1-based; retryDelaysMs[attempt - 1] is this attempt's delay.
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || suspended) return;
      if (tryAttach()) {
        console.warn(`[terminal-webgl] WebGL renderer recovered for ${rendererKey}`);
        return;
      }
      // The re-init itself failed. Advance to the next backoff slot, or give up
      // for good once the slots are exhausted - never leave the terminal stuck
      // on DOM with permanentDomFallback still false and no retry armed.
      if (attempt >= retryDelaysMs.length) {
        status.permanentDomFallback = true;
        console.warn(`[terminal-webgl] WebGL re-init failed for ${rendererKey}; staying on the DOM renderer`);
        return;
      }
      const nextAttempt = attempt + 1;
      console.warn(`[terminal-webgl] WebGL re-init failed for ${rendererKey}; retrying in ${retryDelaysMs[nextAttempt - 1]}ms`);
      scheduleReattach(nextAttempt);
    }, retryDelaysMs[attempt - 1]);
  }

  function handleContextLoss(): void {
    // A loss event during/after a budget suspend is not counted: the suspend
    // already disposed the addon and moved the terminal to DOM deliberately,
    // and it must never escalate toward permanentDomFallback.
    if (disposed || suspended) return;
    if (currentAddon) {
      try { currentAddon.dispose(); } catch { /* addon may already be gone */ }
      currentAddon = null;
    }
    status.renderer = 'dom';
    status.contextLossCount += 1;
    const lossNumber = status.contextLossCount;

    if (lossNumber > retryDelaysMs.length) {
      status.permanentDomFallback = true;
      console.warn(`[terminal-webgl] WebGL context lost ${lossNumber}x for ${rendererKey}; staying on the DOM renderer`);
      return;
    }

    console.warn(`[terminal-webgl] WebGL context lost (${lossNumber}) for ${rendererKey}; retrying in ${retryDelaysMs[lossNumber - 1]}ms`);
    scheduleReattach(lossNumber);
  }

  const suspend = (): void => {
    // A permanently-DOM terminal has no context to free; marking it
    // budget-suspended would only make the renderer report lie about why it
    // is on DOM.
    if (disposed || suspended || status.permanentDomFallback) return;
    suspended = true;
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
    if (disposed || status.permanentDomFallback) return false;
    if (!suspended) return true;
    suspended = false;
    if (tryAttach()) {
      status.suspendedByBudget = false;
      traceTerminalRenderer(rendererKey, 'webgl-resume', { attached: true });
      return true;
    }
    // Stay budget-suspended rather than escalating: the coordinator re-applies
    // its plan on the next window/store change, which is the retry. Arming the
    // context-loss backoff ladder here would conflate a transient acquisition
    // failure with a real loss.
    suspended = true;
    traceTerminalRenderer(rendererKey, 'webgl-resume', { attached: false });
    console.warn(`[terminal-webgl] WebGL re-attach after budget suspend failed for ${rendererKey}; staying suspended`);
    return false;
  };

  const clearTextureAtlas = (): void => {
    // Best-effort: a no-op while on DOM (budget-suspended or permanently
    // fallen back) since there is no live addon to clear.
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
    // Initial attach failed. A construction throw means WebGL is unavailable in
    // this environment (headless, blocklisted GPU): stay on DOM, but now logged
    // rather than silently swallowed.
    status.permanentDomFallback = true;
    console.warn(`[terminal-webgl] WebGL unavailable for ${rendererKey}; using the DOM renderer`);
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
