import type { WindowState } from '../window-manager/store/types';

/**
 * Pure planner for terminal visibility across the windowed-terminal surfaces:
 * which sessions are PARKED (off-view, so their PTY stream should be dropped
 * at the main-process emit gate and their queue should ack-and-discard), and
 * which terminals get one of the page's budgeted live WebGL attachments.
 *
 * Extracted from useFocusedSessionsSync (the coordinator) so the policy can be
 * unit-tested with plain fixtures, mirroring planCommandWindowReconciliation.
 *
 * Parking scope (v1, deliberately conservative):
 * - The whole board layer is parked while the Backlog view is active (the
 *   overlay is visibility:hidden but every window stays mounted).
 * - A window is occluded when a maximized window with a higher zIndex exists
 *   in the SAME layer. No rect-containment math: full coverage by a floating
 *   window is rare, and a false negative just keeps today's behavior.
 * - Cross-layer occlusion is out: the command layer's backdrop is translucent,
 *   so board windows behind it remain partially visible.
 *
 * WebGL budget: visible terminals are ranked by focus recency - the command
 * layer stacks above the board layer, and within a layer the window store's
 * `order` array is an exact MRU (front-most last, so a higher order index is
 * more recent). The bottom panel's single collapsed xterm is always attached
 * and never parked. Parked terminals are always suspended. Sessions the
 * planner does not know about appear in neither output set, so applying the
 * plan leaves them untouched.
 */

export interface TerminalVisibilityWindowInput {
  windowId: string;
  /** Live PTY session id; null when suspended/closed/not yet spawned. */
  sessionId: string | null;
  /** False for windows without an xterm (conversation); they still occlude. */
  hasTerminal: boolean;
  state: WindowState;
  zIndex: number;
  /** Index in the layer store's MRU `order` array (front-most = highest). */
  orderIndex: number;
  layer: 'board' | 'command';
}

export interface TerminalVisibilityInput {
  /** True when the board overlay is off-view (activeView !== 'board'). */
  boardLayerParked: boolean;
  windows: TerminalVisibilityWindowInput[];
  /**
   * The bottom panel's mounted terminal session (already N->1 collapsed);
   * always attached, never parked. Null when the panel renders no terminal.
   */
  panelSessionId: string | null;
  /** Max live WebGL attachments (WEBGL_ATTACH_BUDGET). */
  webglBudget: number;
}

export interface TerminalVisibilityPlan {
  parkedSessionIds: string[];
  webglAttachSessionIds: string[];
  webglSuspendSessionIds: string[];
}

/**
 * A window is occluded when a maximized window with a higher zIndex exists in
 * its layer. Windows without a terminal still occlude; multiple maximized
 * windows occlude the lower-z ones.
 */
export function computeOccludedWindowIds(
  windows: readonly TerminalVisibilityWindowInput[],
): Set<string> {
  const occluded = new Set<string>();
  for (const layer of ['board', 'command'] as const) {
    const layerWindows = windows.filter((candidate) => candidate.layer === layer);
    let topMaximizedZIndex: number | null = null;
    for (const candidate of layerWindows) {
      if (candidate.state !== 'maximized') continue;
      if (topMaximizedZIndex === null || candidate.zIndex > topMaximizedZIndex) {
        topMaximizedZIndex = candidate.zIndex;
      }
    }
    if (topMaximizedZIndex === null) continue;
    for (const candidate of layerWindows) {
      if (candidate.zIndex < topMaximizedZIndex) occluded.add(candidate.windowId);
    }
  }
  return occluded;
}

export function planTerminalVisibility(input: TerminalVisibilityInput): TerminalVisibilityPlan {
  const occludedWindowIds = computeOccludedWindowIds(input.windows);

  interface VisibleTerminal {
    sessionId: string;
    layer: 'board' | 'command';
    orderIndex: number;
  }

  const parkedSessionIds: string[] = [];
  const visibleTerminals: VisibleTerminal[] = [];
  for (const window of input.windows) {
    if (!window.hasTerminal || window.sessionId === null) continue;
    const layerParked = window.layer === 'board' && input.boardLayerParked;
    if (layerParked || occludedWindowIds.has(window.windowId)) {
      parkedSessionIds.push(window.sessionId);
    } else {
      visibleTerminals.push({
        sessionId: window.sessionId,
        layer: window.layer,
        orderIndex: window.orderIndex,
      });
    }
  }

  // Focus recency: command layer stacks above the board layer; within a layer
  // a higher MRU order index is more recent.
  visibleTerminals.sort((first, second) => {
    if (first.layer !== second.layer) return first.layer === 'command' ? -1 : 1;
    return second.orderIndex - first.orderIndex;
  });

  const webglAttachSessionIds: string[] = [];
  // The panel session is force-attached first, but only when it is not parked.
  // derivePanelSessionId is window-blind and can resolve to a session a
  // task-detail window already owns, and that window may be parked or occluded.
  // Attaching a parked session would keep its off-view WebGL context live,
  // wasting a budget slot and contradicting "parked terminals are always
  // suspended" - so a parked panel session falls through to the suspend set.
  if (input.panelSessionId !== null && !parkedSessionIds.includes(input.panelSessionId)) {
    webglAttachSessionIds.push(input.panelSessionId);
  }
  for (const terminal of visibleTerminals) {
    if (webglAttachSessionIds.length >= input.webglBudget) break;
    if (!webglAttachSessionIds.includes(terminal.sessionId)) {
      webglAttachSessionIds.push(terminal.sessionId);
    }
  }

  const webglSuspendSessionIds: string[] = [];
  const collectSuspend = (sessionId: string): void => {
    if (!webglAttachSessionIds.includes(sessionId) && !webglSuspendSessionIds.includes(sessionId)) {
      webglSuspendSessionIds.push(sessionId);
    }
  };
  for (const sessionId of parkedSessionIds) collectSuspend(sessionId);
  for (const terminal of visibleTerminals) collectSuspend(terminal.sessionId);

  return { parkedSessionIds, webglAttachSessionIds, webglSuspendSessionIds };
}
