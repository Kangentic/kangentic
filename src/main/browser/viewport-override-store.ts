import type { WebContents } from 'electron';

/**
 * What viewport override each Browser surface is currently under.
 *
 * Split out from `viewport-override.ts`, which owns the mechanisms, because
 * this half must be importable from anywhere and that half must not be. The
 * mechanisms reach the lane manager and the pop-out window manager, and the
 * lane manager imports `browser-pane-registry`, so a registry that imported
 * the mechanisms directly would close a runtime import cycle. The registry
 * needs exactly one thing from here - forget a dead guest's entry - and this
 * module imports nothing but an Electron type, so it can hand that over
 * without dragging the cycle along. The same reasoning is why the registry
 * takes its pane-closed handler by injection.
 *
 * Keyed by guest `webContentsId`, which is the only identifier both the
 * mechanisms and the renderer push agree on: a surface HANDLE survives a
 * re-register onto the same guest, and the override belongs to the guest.
 */

export type ViewportMechanism = 'device-emulation' | 'window-resize' | 'lane-resize';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewportOverrideRecord {
  /**
   * The agent session that asked for it, captured when it was applied and
   * never re-read from the registry.
   *
   * The registry updates `ownerSessionId` IN PLACE when a `/clear` rotates a
   * session onto the same guest, so looking the owner up later would attribute
   * this override to whoever holds the pane now. The session that ends is the
   * one whose override should be undone, so the answer has to be frozen here.
   */
  sessionId: string | null;
  mechanism: ViewportMechanism;
  requested: ViewportSize;
  measured: ViewportSize;
  deviceScaleFactor: number;
  /**
   * The zoom factor the surface had BEFORE the first override was applied.
   *
   * Setting a size now also sets the zoom, so that the whole requested layout
   * fits the pane instead of being cropped. That makes zoom something the
   * agent changed, so a reset has to put it back. Recorded once, on the first
   * override: re-reading it on a later call would capture the fitted zoom and
   * make the restore a no-op.
   */
  zoomBefore: number;
  appliedAt: string;
}

const overridesByWebContentsId = new Map<number, ViewportOverrideRecord>();

export type ViewportOverrideSender = (
  guest: WebContents,
  override: ViewportOverrideRecord | null,
) => void;

let sendViewportOverride: ViewportOverrideSender | null = null;

/** Wired once at startup from `src/main/index.ts`. Injected rather than
 *  imported so this module stays testable with no window plumbing; null makes
 *  the pushes inert, which is what unit tests rely on. */
export function setViewportOverrideSender(sender: ViewportOverrideSender | null): void {
  sendViewportOverride = sender;
}

export function pushViewportOverride(
  guest: WebContents,
  override: ViewportOverrideRecord | null,
): void {
  sendViewportOverride?.(guest, override);
}

export function getViewportOverride(webContentsId: number): ViewportOverrideRecord | null {
  return overridesByWebContentsId.get(webContentsId) ?? null;
}

export function rememberViewportOverride(
  webContentsId: number,
  record: ViewportOverrideRecord,
): void {
  overridesByWebContentsId.set(webContentsId, record);
}

/**
 * Forget a surface's override without touching the guest.
 *
 * For a surface that is going away anyway (guest destroyed, pane unregistered,
 * lane torn down with its window), so the map does not grow a dead entry per
 * open-and-close across a long session. A caller that wants the PAGE put back
 * uses `clearViewport` or `releaseViewportOverride` instead.
 */
export function forgetViewportOverride(webContentsId: number): boolean {
  return overridesByWebContentsId.delete(webContentsId);
}

/** Surfaces currently holding an override on behalf of this agent session. */
export function webContentsIdsWithOverrideForSession(sessionId: string): number[] {
  const ids: number[] = [];
  for (const [webContentsId, record] of overridesByWebContentsId) {
    if (record.sessionId === sessionId) ids.push(webContentsId);
  }
  return ids;
}

/** Test seam: drop every override without touching any guest. */
export function resetViewportOverrideStore(): void {
  overridesByWebContentsId.clear();
}
