import { useCallback, useEffect, useMemo } from 'react';
import { Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Trans, useLingui } from '@lingui/react/macro';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { TerminalTab } from './TerminalTab';
import { ActivityLog } from './ActivityLog';
import { ContextBar } from './ContextBar';
import { IsolatedBadge } from '../IsolatedBadge';
import { Tooltip } from '../Tooltip';
import { ActivityMark } from '../ActivityMark';
import { titleRowMark } from '../board/agent-wait';
import { useActivityReasonTip } from '../board/useActivityReasonTip';
import { useTaskProgress } from '../../utils/task-progress';
import { slugify } from '../../utils/slugify';
import { shellDisplayName } from '../../utils/shell-display-name';
import { derivePanelSessions } from '../../utils/panel-sessions';
import { derivePanelSessionId } from '../../utils/focused-sessions';
import { isEveryPanelSessionDetached } from '../../utils/terminal-force-collapse';
import { ACTIVITY_TAB } from '../../../shared/types';
import type { ActivityState, Session } from '../../../shared/types';

interface TerminalPanelProps {
  collapsed?: boolean;
  showContent?: boolean;
  onToggleCollapse?: () => void;
}

export function TerminalPanel({ collapsed = false, showContent = true, onToggleCollapse }: TerminalPanelProps) {
  const { t } = useLingui();
  const allSessions = useSessionStore((s) => s.sessions);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  // Fallback agent for default-agent tasks (task.agent null) so the ContextBar
  // picker resolves capabilities. Bottom panel never shows transient sessions
  // (filtered below), so this only ever serves task-bound sessions.
  const projectDefaultAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);
  // The panel's sessions are the open project's, so a project on a host names its shells as the host does.
  const projectOnHost = useProjectStore((state) => state.currentProject?.remote != null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const selectActiveSession = useSessionStore((s) => s.selectActiveSession);
  const setDetailTaskId = useSessionStore((s) => s.setDetailTaskId);
  const dialogSessionIds = useSessionStore((s) => s.dialogSessionIds);
  const remoteDetailTaskIds = useSessionStore((s) => s.remoteDetailTaskIds);
  const mobileTerminalStreamedSessionIds = useSessionStore((s) => s.mobileTerminalStreamedSessionIds);

  // Which sessions the panel shows a tab for. `active` is every running,
  // non-transient session for this project; `owned` is the ones a task-detail
  // window already hosts a terminal for (a window in this renderer, or the
  // detached Agent Monitor's); `visible` is the difference, i.e. the tabs.
  //
  // A detached task keeps NO tab here. Its terminal moved to the surface the user
  // opened it on, so leaving a tab behind would mean a tab that selects an empty
  // pane. Memoized so the downstream useMemo hooks are not defeated by a fresh
  // array reference every render.
  const {
    active: activeSessions,
    owned: ownedSessionIds,
    visible: visibleSessions,
  } = useMemo(
    () => derivePanelSessions({
      sessions: allSessions,
      currentProjectId,
      dialogSessionIds,
      remoteDetailTaskIds,
      mobileTerminalStreamedSessionIds,
    }),
    [allSessions, currentProjectId, dialogSessionIds, remoteDetailTaskIds, mobileTerminalStreamedSessionIds],
  );

  // Narrow the activity selector to only the panel's visible sessions.
  // Prevents re-renders from background session state changes.
  const activeSessionIdSet = useMemo(() => visibleSessions.map((s) => s.id), [visibleSessions]);
  const sessionActivity = useSessionStore(
    useShallow(
      useCallback((s) => {
        const result: Record<string, ActivityState> = {};
        for (const id of activeSessionIdSet) {
          if (s.sessionActivity[id]) result[id] = s.sessionActivity[id];
        }
        return result;
      }, [activeSessionIdSet]),
    ),
  );
  const showActivityTab = visibleSessions.length >= 1;

  // Resolve the effective active ID: must be a visible tab, or the ACTIVITY_TAB
  // sentinel (when 1+ tabs exist). Delegated to `derivePanelSessionId` - the same
  // function `useFocusedSessionsSync` resolves the panel's session with - so the
  // tab this renders and the session main streams bytes for cannot disagree.
  const effectiveActiveId =
    activeSessionId === ACTIVITY_TAB && showActivityTab
      ? ACTIVITY_TAB
      : derivePanelSessionId({
          activeSessionId,
          sessions: allSessions,
          currentProjectId,
          sessionActivity,
          ownedSessionIds,
        });

  // A tab that vanished because its detail window took the terminal is not a stale
  // selection: leave the stored id pointing at it so closing that window returns the
  // user to the tab they left, rather than to whichever agent the panel fell back to
  // meanwhile. The fallback still RENDERS as active; only the store write is skipped.
  const everyPanelSessionDetached = isEveryPanelSessionDetached({
    activeSessionCount: activeSessions.length,
    visibleSessionCount: visibleSessions.length,
  });
  const selectionDetached =
    (activeSessionId !== null && ownedSessionIds.has(activeSessionId)) || everyPanelSessionDetached;

  // Sync the store when the effective ID differs (stale or first auto-select)
  useEffect(() => {
    if (selectionDetached) return;
    if (effectiveActiveId !== activeSessionId) {
      setActiveSession(effectiveActiveId);
    }
  }, [selectionDetached, effectiveActiveId, activeSessionId, setActiveSession]);

  const tasks = useBoardStore((s) => s.tasks);

  // Build sessionId → slug map for tab labels
  const taskLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of visibleSessions) {
      const task = tasks.find((t) => t.id === session.taskId);
      map.set(session.id, task ? slugify(task.title) : session.taskId.slice(0, 8));
    }
    return map;
  }, [visibleSessions, tasks]);

  const activeSessionIds = useMemo(
    () => visibleSessions.map((s) => s.id),
    [visibleSessions],
  );

  if (visibleSessions.length === 0) {
    // Two different nothings. With no sessions at all, the hint is the only place a
    // new user is told how to start an agent, so it stays. When every session is
    // detached to a detail window the panel is force-collapsed and takes no height
    // (AppLayout sizes the container to 0, see `isEveryPanelSessionDetached`), and that
    // hint would be a lie - those agents are running, just somewhere else - so this
    // stays blank.
    return (
      <div
        data-testid="terminal-panel-empty"
        data-state={everyPanelSessionDetached ? 'detached' : 'no-sessions'}
        className="h-full bg-surface flex items-center justify-center text-fg-disabled text-sm"
      >
        {everyPanelSessionDetached ? null : <Trans>No active sessions. Drag a task into a column that starts an agent.</Trans>}
      </div>
    );
  }

  const isActivityActive = effectiveActiveId === ACTIVITY_TAB;
  // One whole message per state, used by the spacer's tip, the toggle's tip and its name.
  const toggleLabel = collapsed ? t`Expand terminal panel` : t`Collapse terminal panel`;

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Tab bar. `data-no-dismiss` is DEFENSIVE here, not a live fix: today the tabs, the
          `cursor-pointer` spacer and the toggle tile the whole row (tab buttons and the toggle
          are a fixed `h-7`, 28px, so the strip leaves no band above or below itself), and every
          one of them is already excluded. The height is fixed rather than padded around the
          16px line box because the 17px Isolated badge grew a padded tab to 29px and the row
          to 30px, leaving every other tab's selected fill half a pixel short of the row. What is not
          structural is that the spacer and the toggle are BOTH conditional on
          `onToggleCollapse`: a second mount site that omits it would expose the entire
          right-hand remainder as dead space directly above a live terminal. AppLayout is the
          only mount site and always passes it, so that is latent. Marking the row makes the
          guarantee independent of the prop, and nothing here loses a click, since the marker
          opts out of light dismiss only. */}
      <div className="flex items-center border-b border-edge flex-shrink-0" data-no-dismiss>
        <div className="flex items-center overflow-x-auto flex-shrink min-w-0">
          {/* Activity tab -- visible when 1+ sessions */}
          {showActivityTab && (
            <button
              data-testid="terminal-activity-tab"
              onClick={() => setActiveSession(ACTIVITY_TAB)}
              className={`flex items-center gap-1.5 h-7 px-3 text-xs border-r border-edge transition-colors whitespace-nowrap ${
                isActivityActive
                  ? 'bg-surface-raised text-fg'
                  : 'text-fg-faint hover:text-fg-tertiary hover:bg-surface-raised/50'
              }`}
            >
              <Activity size={12} />
              <Trans>Activity</Trans>
            </button>
          )}

          {visibleSessions.map((session) => (
            <SessionTab
              key={session.id}
              session={session}
              label={taskLabelMap.get(session.id) || session.taskId.slice(0, 8)}
              selected={effectiveActiveId === session.id}
              shellName={shellDisplayName(session.shell, { onHost: projectOnHost })}
              onSelect={selectActiveSession}
              onOpenDetail={setDetailTaskId}
            />
          ))}
        </div>

        {/* Clickable spacer fills remaining tab bar space */}
        {onToggleCollapse && (
          <Tooltip label={toggleLabel} keys="view.toggleTerminalPanel">
            {/* select-none-ok: an empty spacer, so it has no text to select. */}
            <div
              role="presentation"
              className="flex-1 self-stretch cursor-pointer hover:bg-surface-raised/30 transition-colors"
              onClick={onToggleCollapse}
            />
          </Tooltip>
        )}

        {/* Collapse / expand toggle */}
        {onToggleCollapse && (
          <Tooltip label={toggleLabel} keys="view.toggleTerminalPanel">
            <button
              onClick={onToggleCollapse}
              className="flex items-center justify-center h-7 px-2 text-fg-faint hover:text-fg-tertiary transition-colors flex-shrink-0"
              aria-label={toggleLabel}
            >
              {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </Tooltip>
        )}
      </div>

      {/* Terminal panes + context bar -- hidden after collapse animation completes */}
      {showContent && (
        <>
          {/* Terminal panes -- only the active session's pane is mounted (see below);
              the Activity tab is the one pane hidden with display:none.
              Sessions owned by the detail dialog are unmounted to avoid two xterm
              instances fighting over PTY dimensions (different column widths cause
              garbled TUI output). The panel recreates the terminal from scrollback
              when the dialog closes. */}
          <div className="flex-1 min-h-0 relative">
            {/* Activity log tab */}
            {showActivityTab && (
              <div
                style={{ display: isActivityActive ? 'block' : 'none' }}
                className="absolute inset-0"
              >
                <ActivityLog
                  active={isActivityActive}
                  sessionIds={activeSessionIds}
                  taskLabelMap={taskLabelMap}
                />
              </div>
            )}

            {/* Active session terminal -- only the focused session is mounted.
                Background sessions accumulate in scrollback (Phase 1 gate) and reload
                via getScrollback() when the user switches tabs. This reduces xterm
                instances from N to 1, eliminating WebGL context exhaustion.

                The ownership check is kept as a second line of defence even though an
                owned session no longer has a tab to be active on: it is the guard
                against two xterms fitting one PTY to different widths, and that failure
                is silent and ugly (a frozen, mis-wrapped terminal) rather than loud. */}
            {visibleSessions
              .filter((session) => {
                const isActiveTab = effectiveActiveId === session.id;
                // Owned by a detail window in ANY renderer, not just this one.
                const ownedByWindow = ownedSessionIds.has(session.id);
                return isActiveTab && !ownedByWindow;
              })
              .map((session) => (
                // `data-no-dismiss`: clicking a running terminal must never light-dismiss an
                // open task window. This marker is what actually carries that here. It covers
                // everything `.xterm` does not reach: the pane's NON-xterm children
                // (LaunchOverlay - opaque, event-receiving, default cursor, so it would dismiss
                // while an agent is still starting - and FileDropOverlay), plus the horizontal
                // remainder of the pane, since `index.css` sizes `.xterm` to `height: 100%` but
                // not width. `.xterm` in useClickOutsideToClose's excluded selector is a SECOND
                // guarantee, not the primary one: every xterm host is already covered by an
                // ancestor marker (this wrapper here, `data-window-layer-root` for the task
                // detail and command terminal). Keep both - the cursor heuristic can stand in
                // for neither, because xterm's CSS sets `cursor: text` / `default`.
                // The wrapper only renders for a live, non-window-owned session, so marking it
                // unconditionally needs no `hasLiveTerminal` conditional to stay in sync. It is
                // NOT the whole live-panel exclusion though: the tab bar above and the
                // ContextBar below are siblings and carry their own markers.
                <div
                  key={session.id}
                  data-testid="terminal-session-pane"
                  // Which session this pane hosts. The panel swaps the mounted
                  // pane when its selection changes, so a test that waits on the
                  // bare testid can be satisfied by the OUTGOING pane.
                  data-session-id={session.id}
                  className="absolute inset-0"
                  data-no-dismiss
                >
                  <TerminalTab
                    sessionId={session.id}
                    taskId={session.taskId}
                    active
                  />
                </div>
              ))}
          </div>

          {/* Context bar for individual session tabs */}
          {effectiveActiveId && effectiveActiveId !== ACTIVITY_TAB && (
            <ContextBar sessionId={effectiveActiveId} agentFallback={projectDefaultAgent} />
          )}
        </>
      )}
    </div>
  );
}

interface SessionTabProps {
  session: Session;
  /** The task's slug, the tab's visible label. */
  label: string;
  selected: boolean;
  /** The shell's display name, the tip's last line. */
  shellName: string;
  onSelect: (sessionId: string) => void;
  onOpenDetail: (taskId: string) => void;
}

/**
 * One session's tab. It draws the mark its task's board card draws in its title
 * row, from the same display state (`useTaskProgress`, then `titleRowMark`), so a
 * tab can never show a state its card does not, and its tip leads with the card's
 * own reason text and glyph (`useActivityReasonTip`), with the shell on the line
 * below. There is no pulse: the card has none.
 *
 * ONE `ActivityMark` at one JSX position in every state, so a state change is a
 * mark flip, as on the card: no element-type swap, so no `IconSlot`. A component
 * of its own so a waiting tab's per-second tick re-renders this tab alone.
 */
function SessionTab({ session, label, selected, shellName, onSelect, onOpenDetail }: SessionTabProps) {
  const displayState = useTaskProgress(session.taskId, session.id);
  const activityReason = useSessionStore((state) => state.sessionActivityReason[session.id]);
  const { mark, isIdle, isThinking, toneClass } = titleRowMark(displayState, activityReason);
  const { tipText, icon, accessibleName } = useActivityReasonTip({ activityReason, isIdle, isThinking });
  // The two lines are each already translated; the Tooltip keeps the newline.
  const tipLabel = tipText ? [tipText, shellName].join('\n') : shellName;
  // Null is the Main session; a swimlane id means this is a separate,
  // context-isolated session for that column.
  const isIsolated = session.isolatedSwimlaneId != null;
  return (
    <Tooltip label={tipLabel} icon={icon}>
      <button
        data-testid="terminal-session-tab"
        data-session-id={session.id}
        onClick={() => onSelect(session.id)}
        onDoubleClick={() => onOpenDetail(session.taskId)}
        className={`flex items-center gap-1.5 h-7 px-3 text-xs border-r border-edge transition-colors whitespace-nowrap ${
          selected
            ? 'bg-surface-raised text-fg'
            : 'text-fg-faint hover:text-fg-tertiary hover:bg-surface-raised/50'
        }`}
      >
        <ActivityMark mark={mark} size={14} className={`${toneClass} shrink-0`} aria-label={accessibleName} />
        {label}
        {isIsolated && <IsolatedBadge data-testid="terminal-tab-isolated-badge" />}
      </button>
    </Tooltip>
  );
}
