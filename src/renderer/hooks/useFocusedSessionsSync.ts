import { useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/session-store';
import { useBoardStore } from '../stores/board-store';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import { deriveFocusedSessionIds, derivePanelSessionId } from '../utils/focused-sessions';
import { selectCurrentProjectTransientSessionIds, transientKey } from '../stores/session-store/transient-session-slice';
import { boardWindowManager, commandWindowManager } from '../window-manager/store/window-store';
import {
  planTerminalVisibility,
  type TerminalVisibilityWindowInput,
} from '../utils/terminal-visibility';
import { syncParkedTerminals } from '../utils/parked-terminals';
import {
  WEBGL_ATTACH_BUDGET,
  applyWebglAttachmentPlan,
  onWebglAttachmentsChanged,
  type WebglAttachmentPlan,
} from '../utils/terminal-webgl';

/**
 * The terminal-visibility coordinator. On every relevant UI-state change it
 * derives one visibility plan (utils/terminal-visibility.ts) and applies its
 * three outputs in order:
 *
 * 1. The PARKED set (utils/parked-terminals.ts): sessions whose terminal
 *    window is off-view (board layer parked on Backlog, or occluded by a
 *    maximized same-layer window). Publishing the set fires reveal listeners
 *    for parked -> visible edges, which trigger each terminal's scrollback
 *    catch-up repaint.
 * 2. The FOCUSED set, pushed to the main process. Main drops PTY data IPC for
 *    any session not in this set (see src/main/pty/session-manager.ts), so any
 *    terminal visible to the user must be listed here or its output will be
 *    silently suppressed. Parked sessions are filtered out so main stops
 *    emitting for them at the source.
 * 3. The WebGL attachment plan (utils/terminal-webgl.ts): the budgeted top-K
 *    terminals by focus recency keep live WebGL contexts; the rest are
 *    temporarily suspended to the DOM renderer. A second subscription
 *    re-applies the last plan whenever an attachment registers (terminal init
 *    is ResizeObserver-deferred, so a terminal can mount after the plan ran).
 *
 * This must live in an always-mounted component (AppLayout). Previously this
 * effect lived inside TerminalPanel, which is unmounted on the Backlog view -
 * causing the command bar overlay opened from Backlog to freeze because the
 * transient session was never added to the focused set.
 *
 * Resolves the panel's focused session from the running-sessions list
 * directly (rather than trusting `activeSessionId`), matching the
 * TerminalPanel render-time derivation so that a stale `activeSessionId`
 * (pointing at a session that just exited) doesn't leak into the focused
 * set for the ~1-render-cycle window before TerminalPanel syncs the store.
 *
 * The derivation logic is extracted into pure helpers
 * (utils/focused-sessions.ts, utils/terminal-visibility.ts) for unit
 * testability.
 */
export function useFocusedSessionsSync(): void {
  const activeView = useBoardStore((s) => s.activeView);
  const terminalPanelVisible = useConfigStore((s) => s.config.terminalPanelVisible);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const dialogSessionIds = useSessionStore((s) => s.dialogSessionIds);
  const commandBarVisible = useSessionStore((s) => s.commandBarVisible);
  // A stable, comma-joined key of the current project's transient session ids:
  // the selector returns a fresh array each call, so joining to a primitive lets
  // Zustand skip re-renders when the set is unchanged (mirrors panelSessionId).
  const transientSessionIdsKey = useSessionStore((s) =>
    selectCurrentProjectTransientSessionIds(s.transientSessions, currentProjectId).join(','),
  );

  // Per-layer window fingerprints (same joined-primitive idiom): re-run the
  // effect when a window opens/closes/focuses/maximizes or its session binding
  // changes, but not on unrelated store churn (geometry drags, titles). Order
  // in the fingerprint IS the store's MRU `order`, so a focus change reorders
  // the string. The effect reads the full window state via getState().
  const boardWindowsKey = boardWindowManager.store((s) =>
    s.order
      .map((windowId) => {
        const managedWindow = s.windows[windowId];
        if (!managedWindow) return windowId;
        return `${windowId}|${managedWindow.sessionId ?? ''}|${managedWindow.kind}|${managedWindow.state}|${managedWindow.zIndex}`;
      })
      .join(';'),
  );
  const commandWindowsKey = commandWindowManager.store((s) =>
    s.order
      .map((windowId) => {
        const managedWindow = s.windows[windowId];
        if (!managedWindow) return windowId;
        return `${windowId}|${managedWindow.anchor}|${managedWindow.state}|${managedWindow.zIndex}`;
      })
      .join(';'),
  );

  // Single derived selector: returns the primitive panel session id. The
  // selector body runs on every store change (O(N) over running sessions),
  // but Zustand's Object.is comparison on the string|null result means the
  // hook only re-renders when the resolved id actually changes. This avoids
  // re-rendering AppLayout on every sessionActivity push.
  const panelSessionId = useSessionStore((s) =>
    derivePanelSessionId({
      activeSessionId: s.activeSessionId,
      sessions: s.sessions,
      currentProjectId,
      sessionActivity: s.sessionActivity,
    }),
  );

  const lastWebglPlanRef = useRef<WebglAttachmentPlan | null>(null);

  useEffect(() => {
    const boardState = boardWindowManager.store.getState();
    const commandState = commandWindowManager.store.getState();
    const transientSessions = useSessionStore.getState().transientSessions;
    const sessions = useSessionStore.getState().sessions;

    const windows: TerminalVisibilityWindowInput[] = [];
    boardState.order.forEach((windowId, orderIndex) => {
      const managedWindow = boardState.windows[windowId];
      if (!managedWindow) return;
      // Resolve the window's LIVE session id by anchor (its taskId), not the
      // window store's `sessionId` field: that field is captured at open time
      // and never updated, so it goes stale after a session respawn (an
      // isolated-swimlane switch, or a suspend/respawn). The live terminal
      // registers its WebGL controller, parked-drop gate, and reveal listener
      // under the live id (useTerminal's rendererKey = the live session id), so
      // keying the plan off the stale field would silently miss it. Mirrors the
      // anchor-based resolution in useWindowSessionClaims.
      const boardSessionId =
        managedWindow.kind === 'task-detail'
          ? (sessions.find((candidate) => candidate.taskId === managedWindow.anchor)?.id ?? null)
          : managedWindow.sessionId;
      windows.push({
        windowId,
        sessionId: boardSessionId,
        hasTerminal: managedWindow.kind !== 'conversation',
        state: managedWindow.state,
        zIndex: managedWindow.zIndex,
        orderIndex,
        layer: 'board',
      });
    });
    // Command windows participate only while their layer is mounted: when the
    // command bar is hidden, every command xterm is unmounted (no queue, no
    // WebGL attachment), and rule 4 of deriveFocusedSessionIds already drops
    // the transient sessions from the focused set. Including them here would
    // only waste WebGL budget slots on unmounted terminals.
    if (commandBarVisible && currentProjectId) {
      commandState.order.forEach((windowId, orderIndex) => {
        const managedWindow = commandState.windows[windowId];
        if (!managedWindow) return;
        const transientEntry = transientSessions[transientKey(currentProjectId, managedWindow.anchor)];
        windows.push({
          windowId,
          sessionId: transientEntry?.sessionId ?? null,
          hasTerminal: true,
          state: managedWindow.state,
          zIndex: managedWindow.zIndex,
          orderIndex,
          layer: 'command',
        });
      });
    }

    const plan = planTerminalVisibility({
      boardLayerParked: activeView !== 'board',
      windows,
      panelSessionId,
      webglBudget: WEBGL_ATTACH_BUDGET,
    });
    const parkedSessionIds = new Set(plan.parkedSessionIds);

    // Order matters: publish the parked set FIRST so reveal listeners kick off
    // their scrollback catch-up (their scrollbackPendingRef holds any live
    // bytes until the replay paints), THEN re-focus the sessions so main
    // resumes emitting, THEN swap the WebGL attachments.
    syncParkedTerminals(parkedSessionIds);

    const focusedIds = deriveFocusedSessionIds({
      activeView,
      terminalPanelVisible,
      panelSessionId,
      dialogSessionIds,
      commandBarVisible,
      transientSessionIds: transientSessionIdsKey ? transientSessionIdsKey.split(',') : [],
      parkedSessionIds,
    });
    window.electronAPI.sessions.setFocused(focusedIds);

    lastWebglPlanRef.current = {
      attachKeys: new Set(plan.webglAttachSessionIds),
      suspendKeys: new Set(plan.webglSuspendSessionIds),
    };
    applyWebglAttachmentPlan(lastWebglPlanRef.current);
  }, [
    activeView,
    terminalPanelVisible,
    panelSessionId,
    dialogSessionIds,
    commandBarVisible,
    transientSessionIdsKey,
    boardWindowsKey,
    commandWindowsKey,
    currentProjectId,
  ]);

  // A terminal that mounts AFTER the plan ran starts suspended when the page
  // is over budget; re-applying the last plan resumes it if the plan names it
  // in the attach set (a newly opened window is the MRU front, so it does).
  useEffect(() => {
    return onWebglAttachmentsChanged(() => {
      if (lastWebglPlanRef.current) applyWebglAttachmentPlan(lastWebglPlanRef.current);
    });
  }, []);
}
