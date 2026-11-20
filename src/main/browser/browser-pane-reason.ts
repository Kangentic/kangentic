import type { BrowserPaneOpenPurpose } from '../../shared/types';
import { browserPaneRegistry } from './browser-pane-registry';

/**
 * Why each owner's agent last opened its Browser pane, as it said in
 * `kangentic_browser_open_pane` (decision 46 in
 * `docs/architecture/embedded-browser/decision-log.md`).
 *
 * Keyed by OWNER (a task id, or a Command Terminal's owner key from
 * `src/shared/browser-owner.ts`), never by registry entry: an entry is per
 * guest and is forgotten on every remount, while the reason belongs to the
 * owner's one surface across all of them.
 *
 * The reason changes only through the tool's inputs. An `open_pane` call sets
 * it, the next one replaces it, and a refused call leaves the previous one in
 * place. Closing the surface (the agent's `close_pane`, the user's Close
 * browser, the task menu's Close of an offscreen surface) or ending the session
 * clears it. Nothing is inferred from turns. The pane shows it, as
 * "Agent is <reason>", only while the agent drives (`agentInputReason`, read by
 * the agent-input sender in `src/main/index.ts`), so a reason the agent has
 * moved on from never sits on screen.
 */
export interface BrowserPaneReason {
  purpose: BrowserPaneOpenPurpose;
  reason: string;
  /** The agent session that gave it, so its end clears it. Null when unknown. */
  sessionId: string | null;
}

const reasons = new Map<string, BrowserPaneReason>();

/** One line: runs of whitespace, newlines included, become a single space. */
function normalizeBrowserPaneReason(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function setBrowserPaneReason(ownerKey: string, value: BrowserPaneReason): void {
  reasons.set(ownerKey, {
    purpose: value.purpose,
    reason: normalizeBrowserPaneReason(value.reason),
    sessionId: value.sessionId,
  });
}

export function getBrowserPaneReason(ownerKey: string): BrowserPaneReason | null {
  return reasons.get(ownerKey) ?? null;
}

export function clearBrowserPaneReason(ownerKey: string): void {
  reasons.delete(ownerKey);
}

/** The session ended: forget every reason it gave. */
export function clearBrowserPaneReasonsForSession(sessionId: string): void {
  for (const [ownerKey, value] of reasons) {
    if (value.sessionId === sessionId) reasons.delete(ownerKey);
  }
}

/**
 * What the agent-input push says for this guest: on the ACTIVE edge, the reason
 * the guest's owner gave, so the pane's label reads "Agent is <reason>"; null on
 * the end edge, for a guest no surface registered, and for an owner that gave
 * none. The end edge says nothing because the label keeps its words through its
 * fade.
 */
export function agentInputReason(webContentsId: number, active: boolean): string | null {
  if (!active) return null;
  const ownerKey = browserPaneRegistry.ownerKeyForWebContents(webContentsId);
  if (!ownerKey) return null;
  return reasons.get(ownerKey)?.reason ?? null;
}

/** Test seam: forget every owner's reason. */
export function clearAllBrowserPaneReasons(): void {
  reasons.clear();
}
