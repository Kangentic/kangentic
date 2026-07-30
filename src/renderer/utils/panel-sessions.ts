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
}

export interface PanelSessions {
  /** Running, non-transient sessions for the current project: everything the
   *  bottom panel could show. */
  active: Session[];
  /** Of all known sessions, the ones a detail window already hosts a terminal
   *  for. One xterm per PTY, so the panel must never mount a second one. */
  owned: Set<string>;
  /** `active` minus `owned`: exactly the tabs the panel renders. */
  visible: Session[];
}

/**
 * The bottom panel's tab set.
 *
 * A task's terminal is only ever in one place. When its detail is open - as a
 * board task-detail window, in the in-app Agent Monitor, or in the detached
 * monitor pop-out - the panel drops that tab entirely rather than keeping a tab
 * whose body renders nothing. Opening a task therefore reads the same way
 * wherever you do it: the terminal detaches to the surface you opened it on, and
 * returns as a tab when you close it. Once no tab is left the panel collapses
 * (see `shouldForceCollapseTerminal`).
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

  return { active, owned, visible: active.filter((session) => !owned.has(session.id)) };
}
