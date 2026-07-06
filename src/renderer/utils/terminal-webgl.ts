import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

/**
 * WebGL renderer attachment with context-loss recovery.
 *
 * xterm's WebGL renderer is 10-50x faster than its DOM fallback for output
 * bursts. The GPU can drop the WebGL context (driver reset, tab throttling,
 * memory pressure); when it does, the addon fires `onContextLoss`. The old code
 * just `dispose()`d the addon on loss, silently and permanently reverting the
 * terminal to the DOM renderer for the rest of the session - so every later
 * burst became far more expensive with nothing recorded. This module retries
 * re-initializing WebGL after a loss (with a short backoff), logs what happened,
 * and tracks the live renderer type so devtools can observe a degraded terminal.
 */

export type TerminalRendererType = 'webgl' | 'dom';

export interface TerminalRendererStatus {
  /** The renderer currently backing this terminal. */
  renderer: TerminalRendererType;
  /** How many WebGL context losses this terminal has seen. */
  contextLossCount: number;
  /** True once retries are exhausted and the terminal is DOM-only for good. */
  permanentDomFallback: boolean;
}

/** The subset of `WebglAddon` this module uses. Narrowed so tests can fake it. */
interface WebglAddonLike {
  onContextLoss(handler: () => void): void;
  dispose(): void;
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
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000];

// hmr-safe: transient per-terminal renderer status; terminals dispose and
// re-register their entry across an HMR remount, and a devtools snapshot
// reading a stale map after a Fast Refresh is a harmless diagnostic read.
const rendererStatusByKey = new Map<string, TerminalRendererStatus>();

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

  const status: TerminalRendererStatus = { renderer: 'dom', contextLossCount: 0, permanentDomFallback: false };
  rendererStatusByKey.set(rendererKey, status);

  let currentAddon: WebglAddonLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

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
      if (disposed) return;
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
    if (disposed) return;
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

  // Initial attach. A construction throw means WebGL is unavailable in this
  // environment (headless, blocklisted GPU): stay on DOM, but now logged rather
  // than silently swallowed.
  if (!tryAttach()) {
    status.permanentDomFallback = true;
    console.warn(`[terminal-webgl] WebGL unavailable for ${rendererKey}; using the DOM renderer`);
  }

  return () => {
    disposed = true;
    clearRetryTimer();
    if (currentAddon) {
      try { currentAddon.dispose(); } catch { /* best-effort */ }
      currentAddon = null;
    }
    rendererStatusByKey.delete(rendererKey);
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
