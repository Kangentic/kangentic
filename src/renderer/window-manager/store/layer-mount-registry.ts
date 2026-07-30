/**
 * Which window-manager layers are currently MOUNTED in this renderer.
 *
 * A layer's store is a module singleton that deliberately outlives its React
 * subtree (Pattern E, so a Fast Refresh never loses your window layout). Most
 * layers are mounted for the app's whole life - the board's is in `AppLayout` -
 * but the Agent Monitor's lives inside `MonitorPage`, which unmounts whenever the
 * monitor is closed or detached into its own window.
 *
 * That gap matters for renderer-GLOBAL state derived from windows, specifically
 * `session-store.dialogSessionIds`. Its meaning is "an xterm currently owns this
 * PTY, so the bottom panel must not mount a second one" - and an unmounted layer
 * has no xterm, whatever its store still remembers. Deriving the claim from the
 * store alone let a monitor window that was no longer on screen keep claiming its
 * session, which silently starved the bottom panel of a terminal it should have
 * taken back.
 *
 * Deliberately NOT "close the windows on unmount": closing the monitor is a cheap
 * toggle, and the windows should still be there when it reopens. Only the claim
 * is transient, because only the xterm is.
 */

import type { WindowManager } from './window-store';

// hmr-safe: a mount-tracking set rebuilt by the layers' own effects. A reset on
// Fast Refresh reads as "no layer mounted" for the moment before those effects
// re-run, which releases claims that are immediately re-taken.
const mountedManagers = new Set<WindowManager>();
// hmr-safe: paired with the set above; a dropped listener is re-subscribed by the
// consumer's effect on the same Fast Refresh.
const listeners = new Set<() => void>();

/** Mark a layer mounted for as long as its surface is on screen. Returns the
 *  matching unmark, so callers use it straight as an effect cleanup. */
export function markLayerMounted(manager: WindowManager): () => void {
  mountedManagers.add(manager);
  for (const listener of listeners) listener();
  return () => {
    mountedManagers.delete(manager);
    for (const listener of listeners) listener();
  };
}

/** True while this layer's surface is rendered. */
export function isLayerMounted(manager: WindowManager): boolean {
  return mountedManagers.has(manager);
}

/** Observe mount/unmount, so a derived set can be reconciled when a layer comes
 *  or goes rather than only when its windows change. */
export function subscribeLayerMounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
