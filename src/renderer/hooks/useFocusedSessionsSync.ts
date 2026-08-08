import { useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/session-store';
import { useBoardStore } from '../stores/board-store';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import { deriveFocusedSessionIds, derivePanelSessionId } from '../utils/focused-sessions';
import { derivePanelSessions } from '../utils/panel-sessions';
import { selectCurrentProjectTransientSessionIds, transientKey } from '../stores/session-store/transient-session-slice';
import { boardWindowManager, commandWindowManager } from '../window-manager/store/window-store';
import {
  planTerminalVisibility,
  type TerminalVisibilityWindowInput,
} from '../utils/terminal-visibility';
import { syncParkedTerminals } from '../utils/parked-terminals';
import { syncFocusedTerminals } from '../utils/focused-terminals';
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
 * 1. The WebGL attachment plan (utils/terminal-webgl.ts): the budgeted top-K
 *    terminals by focus recency keep live WebGL contexts; the rest are
 *    temporarily suspended to the DOM renderer. A second subscription
 *    re-applies the last plan whenever an attachment registers (terminal init
 *    is ResizeObserver-deferred, so a terminal can mount after the plan ran).
 *    This runs FIRST, and the reason is load-bearing - see the comment on the
 *    call itself.
 * 2. The PARKED set (utils/parked-terminals.ts): sessions whose terminal
 *    window is off-view (board layer parked on Backlog, or occluded by a
 *    maximized same-layer window). Publishing the set fires reveal listeners
 *    for parked -> visible edges, which trigger each terminal's scrollback
 *    catch-up repaint.
 * 3. The FOCUSED set, pushed to the main process. Main drops PTY data IPC for
 *    any session not in this set (see src/main/pty/session-manager.ts), so any
 *    terminal visible to the user must be listed here or its output will be
 *    silently suppressed. Parked sessions are filtered out so main stops
 *    emitting for them at the source.
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
/**
 * @param panelShowsTerminal whether the bottom panel currently has its terminal
 *   content mounted. Comes from `useTerminalResize`'s `showContent`, which is local
 *   React state rather than a store, so it has to be threaded in from `AppLayout`.
 *   A collapsed panel mounts no xterm, and a session nobody renders must not be
 *   focused - main would stream bytes with nothing to ack them.
 */
export function useFocusedSessionsSync(panelShowsTerminal: boolean): void {
  const activeView = useBoardStore((s) => s.activeView);
  const terminalPanelVisible = useConfigStore((s) => s.config.terminalPanelVisible);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const dialogSessionIds = useSessionStore((s) => s.dialogSessionIds);
  const remoteDetailTaskIds = useSessionStore((s) => s.remoteDetailTaskIds);
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
  //
  // Resolved over the panel's VISIBLE tabs, which is what it actually mounts: a
  // detached task has no tab, so opening a detail for the active one makes the
  // panel fall back to another session. Deriving this window-blind would keep
  // naming the detached one, and main would stream bytes to a terminal that is
  // not there while the newly shown one never receives its output.
  const panelSessionId = useSessionStore((s) =>
    derivePanelSessionId({
      activeSessionId: s.activeSessionId,
      sessions: s.sessions,
      currentProjectId,
      sessionActivity: s.sessionActivity,
      // Includes phone-streamed sessions (folded into `owned`): they have no
      // tab, so they can never be the panel's mounted terminal, and focus /
      // parking / WebGL all follow from this one resolution.
      ownedSessionIds: derivePanelSessions({
        sessions: s.sessions,
        currentProjectId,
        dialogSessionIds: s.dialogSessionIds,
        remoteDetailTaskIds: s.remoteDetailTaskIds,
        mobileTerminalStreamedSessionIds: s.mobileTerminalStreamedSessionIds,
      }).owned,
      panelShowsTerminal,
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

    // Swap the WebGL attachments FIRST, because a revealed terminal's catch-up
    // replay fits itself synchronously and a fit is only valid on the renderer
    // the terminal is going to KEEP.
    //
    // FitAddon derives columns from `_renderService.dimensions.css.cell.width`,
    // and that service is swapped wholesale when the WebGL addon attaches or is
    // disposed. A terminal parked off the board has its addon disposed
    // (`webgl-suspend`, the GPU budget), and the DOM fallback it lands on
    // measures a WIDER cell, so the same container proposes fewer columns.
    // Measured on a 1483px task-detail window: 210 columns attached, 191
    // suspended, with a byte-identical hostWidth.
    //
    // With the reveal published first, that 191 was the width the catch-up
    // replay wrote main's 210-column frame at, and the refit afterwards widened
    // the grid back to 210 WITHOUT reflowing it - xterm reflows the normal
    // buffer on resize and never the alternate one, so a full-screen agent TUI
    // stayed hard-wrapped until something made it repaint. Attaching first is
    // the same order the mount path already uses (attachWebglRenderer, then the
    // initial fit, in initTerminal).
    //
    // Nothing else depends on this running last: the plan is fully computed
    // above, and applying it touches only renderer attachments, not the parked
    // or focused sets.
    lastWebglPlanRef.current = {
      attachKeys: new Set(plan.webglAttachSessionIds),
      suspendKeys: new Set(plan.webglSuspendSessionIds),
    };
    applyWebglAttachmentPlan(lastWebglPlanRef.current);

    // Then publish the parked set, so reveal listeners kick off their scrollback
    // catch-up (their scrollbackPendingRef holds any live bytes until the replay
    // paints), and only THEN publish the focused set and re-focus the sessions
    // so main resumes emitting.
    syncParkedTerminals(parkedSessionIds);

    // Sessions a detail window in ANOTHER renderer owns. Resolved from task ids
    // here because that is the only cross-renderer name main can publish: session
    // ids are looked up per renderer from its own session list.
    const remotelyOwnedSessionIds = new Set<string>();
    if (remoteDetailTaskIds.length > 0) {
      const remoteTasks = new Set(remoteDetailTaskIds);
      for (const session of sessions) {
        if (remoteTasks.has(session.taskId)) remotelyOwnedSessionIds.add(session.id);
      }
    }

    const focusedIds = deriveFocusedSessionIds({
      activeView,
      terminalPanelVisible,
      panelSessionId,
      dialogSessionIds,
      commandBarVisible,
      transientSessionIds: transientSessionIdsKey ? transientSessionIdsKey.split(',') : [],
      parkedSessionIds,
      remotelyOwnedSessionIds,
    });
    // Same reasoning as the parked publish above, one step later because the
    // focused set is only known now: fire the refocus catch-up BEFORE the IPC
    // that makes main start feeding THIS renderer.
    //
    // The guarantee is per-renderer ROUTING, not global silence. Main's emit
    // gate is a union across renderers, so a session a detached monitor already
    // holds is being read the whole time - but SESSION_DATA is dispatched only
    // to the renderers focused on that session (`sendToFocusedRenderers` ->
    // `getRenderersFocusedOn`), so this renderer receives nothing until its own
    // setFocused lands. Anything that did arrive first would predate the sample,
    // which is exactly what the replay's queue reset exists to discard.
    syncFocusedTerminals(new Set(focusedIds));
    window.electronAPI.sessions.setFocused(focusedIds);
  }, [
    activeView,
    terminalPanelVisible,
    panelSessionId,
    dialogSessionIds,
    remoteDetailTaskIds,
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
