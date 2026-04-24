import { useCallback, useEffect, useMemo } from 'react';
import { Activity, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { TerminalTab } from './TerminalTab';
import { ActivityLog } from './ActivityLog';
import { ContextBar } from './ContextBar';
import { slugify } from '../../utils/slugify';
import { shellDisplayName } from '../../utils/shell-display-name';
import { ACTIVITY_TAB } from '../../../shared/types';
import type { ActivityState } from '../../../shared/types';

interface TerminalPanelProps {
  collapsed?: boolean;
  showContent?: boolean;
  onToggleCollapse?: () => void;
}

export function TerminalPanel({ collapsed = false, showContent = true, onToggleCollapse }: TerminalPanelProps) {
  const allSessions = useSessionStore((s) => s.sessions);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setDetailTaskId = useSessionStore((s) => s.setDetailTaskId);
  const dialogSessionId = useSessionStore((s) => s.dialogSessionId);
  const markSingleIdleSessionSeen = useSessionStore((s) => s.markSingleIdleSessionSeen);

  // Only show sessions that are actively running.
  // Queued/exited/suspended sessions are removed from the panel.
  // Memoized to prevent downstream useMemo hooks (taskLabelMap, activeSessionIds)
  // from being defeated by a new array reference on every render.
  const activeSessions = useMemo(
    () => allSessions.filter((s) => s.status === 'running' && s.projectId === currentProjectId && !s.transient),
    [allSessions, currentProjectId],
  );

  // Narrow activity/idle selectors to only the panel's visible sessions.
  // Prevents re-renders from background session state changes.
  const activeSessionIdSet = useMemo(() => activeSessions.map((s) => s.id), [activeSessions]);
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

  const showActivityTab = activeSessions.length >= 1;

  // Resolve the effective active ID: must be in the activeSessions list
  // or be the ACTIVITY_TAB sentinel (when 1+ sessions exist).
  const effectiveActiveId =
    activeSessionId === ACTIVITY_TAB && showActivityTab
      ? ACTIVITY_TAB
      : activeSessions.some((s) => s.id === activeSessionId)
        ? activeSessionId
        : activeSessions.length > 0
          ? (activeSessions.find((s) => sessionActivity[s.id] === 'idle')?.id
              ?? activeSessions[0].id)
          : null;

  // Sync the store when the effective ID differs (stale or first auto-select)
  useEffect(() => {
    if (effectiveActiveId !== activeSessionId) {
      setActiveSession(effectiveActiveId);
    }
  }, [effectiveActiveId, activeSessionId, setActiveSession]);

  // Mark the active session as seen when it becomes the selected tab
  useEffect(() => {
    if (effectiveActiveId && effectiveActiveId !== ACTIVITY_TAB && sessionActivity[effectiveActiveId] === 'idle') {
      markSingleIdleSessionSeen(effectiveActiveId);
    }
  }, [effectiveActiveId, sessionActivity, markSingleIdleSessionSeen]);

  const tasks = useBoardStore((s) => s.tasks);

  // Build sessionId → slug map for tab labels
  const taskLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of activeSessions) {
      const task = tasks.find((t) => t.id === session.taskId);
      map.set(session.id, task ? slugify(task.title) : session.taskId.slice(0, 8));
    }
    return map;
  }, [activeSessions, tasks]);

  const activeSessionIds = useMemo(
    () => activeSessions.map((s) => s.id),
    [activeSessions],
  );

  if (activeSessions.length === 0) {
    return (
      <div className="h-full bg-surface flex items-center justify-center text-fg-disabled text-sm">
        No active sessions. Drag a task into a working column to start an agent.
      </div>
    );
  }

  const isActivityActive = effectiveActiveId === ACTIVITY_TAB;

  return (
    <div className="h-full flex flex-col bg-surface">
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

          {activeSessions.map((session) => {
            const label = taskLabelMap.get(session.id) || session.taskId.slice(0, 8);
            return (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                onDoubleClick={() => setDetailTaskId(session.taskId)}
                title={`${label} (${shellDisplayName(session.shell)})`}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-edge transition-colors whitespace-nowrap ${
                  effectiveActiveId === session.id
                    ? 'bg-surface-raised text-fg'
                    : 'text-fg-faint hover:text-fg-tertiary hover:bg-surface-raised/50'
                }`}
              >
                {session.status === 'running' && sessionActivity[session.id] !== 'idle' ? (
                  <Loader2 size={8} className="text-green-400 animate-spin" />
                ) : session.status === 'running' && sessionActivity[session.id] === 'idle' ? (
                  <div className={`w-1.5 h-1.5 rounded-full bg-amber-400${
                    effectiveActiveId !== session.id && !seenIdleSessions[session.id] ? ' animate-pulse' : ''
                  }`} />
                ) : (
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    session.status === 'running' ? 'bg-green-400' : 'bg-fg-faint'
                  }`} />
                )}
                {label}
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
            title={collapsed ? 'Expand terminal panel' : 'Collapse terminal panel'}
          />
        )}

        {/* Collapse / expand toggle */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="flex items-center justify-center px-2 py-1.5 text-fg-faint hover:text-fg-tertiary transition-colors flex-shrink-0"
            title={collapsed ? 'Expand terminal panel' : 'Collapse terminal panel'}
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
                instances from N to 1, eliminating WebGL context exhaustion. */}
            {activeSessions
              .filter((session) => {
                const isActive = effectiveActiveId === session.id;
                const ownedByDialog = dialogSessionId === session.id;
                return isActive && !ownedByDialog;
              })
              .map((session) => (
                <div
                  key={session.id}
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

          {/* Context bar for individual session tabs (hidden when dialog owns the session) */}
          {effectiveActiveId && effectiveActiveId !== ACTIVITY_TAB && effectiveActiveId !== dialogSessionId && (
            <ContextBar sessionId={effectiveActiveId} compact />
          )}
        </>
      )}
    </div>
  );
}
