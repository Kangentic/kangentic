import { useCallback, useEffect, useMemo } from 'react';
import { Activity, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { TerminalTab } from './TerminalTab';
import { ActivityLog } from './ActivityLog';
import { ContextBar } from './ContextBar';
import { IsolatedBadge } from '../IsolatedBadge';
import { slugify } from '../../utils/slugify';
import { shellDisplayName } from '../../utils/shell-display-name';
import { derivePanelSessions } from '../../utils/panel-sessions';
import { derivePanelSessionId } from '../../utils/focused-sessions';
import { useFormattedCombo } from '../../hooks/useKeybinding';
import { ACTIVITY_TAB } from '../../../shared/types';
import type { ActivityState } from '../../../shared/types';
import { requiresUserInteraction, isActive } from '../../../shared/activity-state';

interface TerminalPanelProps {
  collapsed?: boolean;
  showContent?: boolean;
  onToggleCollapse?: () => void;
}

export function TerminalPanel({ collapsed = false, showContent = true, onToggleCollapse }: TerminalPanelProps) {
  const terminalPanelCombo = useFormattedCombo('view.toggleTerminalPanel');
  const allSessions = useSessionStore((s) => s.sessions);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  // Fallback agent for default-agent tasks (task.agent null) so the ContextBar
  // picker resolves capabilities. Bottom panel never shows transient sessions
  // (filtered below), so this only ever serves task-bound sessions.
  const projectDefaultAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const selectActiveSession = useSessionStore((s) => s.selectActiveSession);
  const setDetailTaskId = useSessionStore((s) => s.setDetailTaskId);
  const dialogSessionIds = useSessionStore((s) => s.dialogSessionIds);
  const remoteDetailTaskIds = useSessionStore((s) => s.remoteDetailTaskIds);
  const markSingleIdleSessionSeen = useSessionStore((s) => s.markSingleIdleSessionSeen);

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
    }),
    [allSessions, currentProjectId, dialogSessionIds, remoteDetailTaskIds],
  );

  // Narrow activity/idle selectors to only the panel's visible sessions.
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
  const seenIdleSessions = useSessionStore(
    useShallow(
      useCallback((s) => {
        const result: Record<string, boolean> = {};
        for (const id of activeSessionIdSet) {
          if (s.seenIdleSessions[id]) result[id] = s.seenIdleSessions[id];
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
  const selectionDetached =
    (activeSessionId !== null && ownedSessionIds.has(activeSessionId)) ||
    (activeSessions.length > 0 && visibleSessions.length === 0);

  // Sync the store when the effective ID differs (stale or first auto-select)
  useEffect(() => {
    if (selectionDetached) return;
    if (effectiveActiveId !== activeSessionId) {
      setActiveSession(effectiveActiveId);
    }
  }, [selectionDetached, effectiveActiveId, activeSessionId, setActiveSession]);

  // Mark the active session as seen when it becomes the selected tab
  useEffect(() => {
    if (effectiveActiveId && effectiveActiveId !== ACTIVITY_TAB && requiresUserInteraction(sessionActivity[effectiveActiveId])) {
      markSingleIdleSessionSeen(effectiveActiveId);
    }
  }, [effectiveActiveId, sessionActivity, markSingleIdleSessionSeen]);

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
    // detached to a detail window the panel is force-collapsed to a thin strip
    // (`shouldForceCollapseTerminal`), and that hint would be a lie - those agents
    // are running, just somewhere else - so the strip stays blank.
    const detached = activeSessions.length > 0;
    return (
      <div
        data-testid="terminal-panel-empty"
        data-state={detached ? 'detached' : 'no-sessions'}
        data-dismiss-surface="board"
        className="h-full bg-surface flex items-center justify-center text-fg-disabled text-sm"
      >
        {detached ? null : 'No active sessions. Drag a task into a column that starts an agent.'}
      </div>
    );
  }

  const isActivityActive = effectiveActiveId === ACTIVITY_TAB;
  // A live xterm pane (and its ContextBar) is mounted only when content is shown and a real
  // session tab is active. Only in that state must the panel NOT dismiss the window on a
  // dead-space click; otherwise (empty tab bar / collapsed strip / Activity tab) it is a
  // dismiss surface like the rest of the app shell. As with every other marked surface, a new
  // clickable child here must carry `cursor-pointer` or `data-no-dismiss`, or a click on it will
  // also dismiss.
  const hasLiveTerminal = showContent && effectiveActiveId != null && !isActivityActive;

  return (
    <div className="h-full flex flex-col bg-surface" data-dismiss-surface={hasLiveTerminal ? undefined : 'board'}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-edge flex-shrink-0">
        <div className="flex items-center overflow-x-auto flex-shrink min-w-0">
          {/* Activity tab -- visible when 1+ sessions */}
          {showActivityTab && (
            <button
              onClick={() => setActiveSession(ACTIVITY_TAB)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-edge transition-colors whitespace-nowrap ${
                isActivityActive
                  ? 'bg-surface-raised text-fg'
                  : 'text-fg-faint hover:text-fg-tertiary hover:bg-surface-raised/50'
              }`}
            >
              <Activity size={12} />
              Activity
            </button>
          )}

          {visibleSessions.map((session) => {
            const label = taskLabelMap.get(session.id) || session.taskId.slice(0, 8);
            // Null/undefined is the Main session; a swimlane id means this is a
            // separate, context-isolated session for that column.
            const isIsolated = session.isolatedSwimlaneId != null;
            return (
              <button
                key={session.id}
                data-testid="terminal-session-tab"
                data-session-id={session.id}
                onClick={() => selectActiveSession(session.id)}
                onDoubleClick={() => setDetailTaskId(session.taskId)}
                title={`${label} (${shellDisplayName(session.shell)})${isIsolated ? ' - Isolated session' : ''}`}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-edge transition-colors whitespace-nowrap ${
                  effectiveActiveId === session.id
                    ? 'bg-surface-raised text-fg'
                    : 'text-fg-faint hover:text-fg-tertiary hover:bg-surface-raised/50'
                }`}
              >
                {session.status === 'running' && isActive(sessionActivity[session.id]) ? (
                  <Loader2 size={8} className="text-active animate-spin" />
                ) : session.status === 'running' && requiresUserInteraction(sessionActivity[session.id]) ? (
                  <div className={`w-1.5 h-1.5 rounded-full bg-attention${
                    effectiveActiveId !== session.id && !seenIdleSessions[session.id] ? ' animate-pulse' : ''
                  }`} />
                ) : (
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    session.status === 'running' ? 'bg-active' : 'bg-fg-faint'
                  }`} />
                )}
                {label}
                {isIsolated && <IsolatedBadge data-testid="terminal-tab-isolated-badge" />}
              </button>
            );
          })}
        </div>

        {/* Clickable spacer fills remaining tab bar space */}
        {onToggleCollapse && (
          <div
            role="presentation"
            className="flex-1 self-stretch cursor-pointer hover:bg-surface-raised/30 transition-colors"
            onClick={onToggleCollapse}
            title={`${collapsed ? 'Expand' : 'Collapse'} terminal panel (${terminalPanelCombo})`}
          />
        )}

        {/* Collapse / expand toggle */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="flex items-center justify-center px-2 py-1.5 text-fg-faint hover:text-fg-tertiary transition-colors flex-shrink-0"
            title={`${collapsed ? 'Expand' : 'Collapse'} terminal panel (${terminalPanelCombo})`}
          >
            {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {/* Terminal panes + context bar -- hidden after collapse animation completes */}
      {showContent && (
        <>
          {/* Terminal panes -- only the active one is positioned; rest are display:none.
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
                <div
                  key={session.id}
                  data-testid="terminal-session-pane"
                  className="absolute inset-0"
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
