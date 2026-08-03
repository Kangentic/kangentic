import type { Session } from '../../shared/types';

export interface PanelSessionsInput {
  /** This renderer's full session list. */
  sessions: Session[];
  currentProjectId: string | null;
  /** Sessions owned by a detail window in THIS renderer (a board task-detail
   *  window or the in-app Agent Monitor's), keyed by session id. */
  dialogSessionIds: readonly string[];
  /** Tasks whose detail lives in ANOTHER renderer (the detached Agent Monitor),
   *  keyed by TASK id, because that is the only cross-renderer name main can
   *  publish: session ids are resolved per renderer from its own session list. */
  remoteDetailTaskIds: readonly string[];
  /** Sessions a paired phone streams the TERMINAL of (session ids, pushed by
   *  main's mobile bridge via useMobileTerminalStreamsSync). Their terminal
   *  lives on the phone: the resting park owns the PTY grid, so a panel tab
   *  would either fit the strip out from under the phone or render a frame
   *  laid out for a grid it does not have. The user is on their phone anyway
   *  (user decision 2026-08-02) - so no tab, same as a detail-owned session,
   *  and the tab returns the moment the phone lets go. A task-detail window
   *  still shows these: the detail is the primary surface and takes the grid. */
  mobileTerminalStreamedSessionIds?: readonly string[];
}

export interface PanelSessions {
  /** Running, non-transient sessions for the current project: everything the
   *  bottom panel could show. */
  active: Session[];
  /** Of all known sessions, the ones whose terminal already lives on another
   *  surface - a detail window, or a streaming phone. One xterm per PTY, so
   *  the panel must never mount a second one. */
  owned: Set<string>;
  /** `active` minus `owned`: exactly the tabs the panel renders. */
  visible: Session[];
}

/**
 * The bottom panel's tab set.
 *
 * A task's terminal is only ever in one place. When its detail is open - as a
 * board task-detail window, in the in-app Agent Monitor, or in the detached
 * monitor pop-out - or a paired phone is streaming it, the panel drops that tab
 * entirely rather than keeping a tab whose body renders nothing. Opening a task
 * therefore reads the same way wherever you do it: the terminal detaches to the
 * surface you opened it on (or the phone that took it), and returns as a tab
 * when that surface lets go. Once no tab is left the panel collapses (see
 * `shouldForceCollapseTerminal`).
 *
 * Shared by the panel (what to render), `AppLayout` (whether to collapse) and
 * `useFocusedSessionsSync` (which sessions main must stream PTY bytes for), so
 * those three cannot disagree about which terminals are actually on screen - a
 * disagreement there is a terminal that paints nothing or one that never
 * receives its output.
 */
export function derivePanelSessions(input: PanelSessionsInput): PanelSessions {
  const active = input.sessions.filter(
    (session) =>
      session.status === 'running' &&
      session.projectId === input.currentProjectId &&
      !session.transient,
  );

  const owned = new Set(input.dialogSessionIds);
  if (input.remoteDetailTaskIds.length > 0) {
    const remoteTasks = new Set(input.remoteDetailTaskIds);
    for (const session of input.sessions) {
      if (remoteTasks.has(session.taskId)) owned.add(session.id);
    }
  }
  for (const sessionId of input.mobileTerminalStreamedSessionIds ?? []) owned.add(sessionId);

  return { active, owned, visible: active.filter((session) => !owned.has(session.id)) };
}
