import React, { useEffect, useMemo } from 'react';
import { Activity, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { TerminalTab } from './TerminalTab';
import { ActivityLog } from './ActivityLog';
import { slugify } from '../../utils/slugify';

const ACTIVITY_TAB = '__all__';

interface TerminalPanelProps {
  collapsed?: boolean;
  showContent?: boolean;
  onToggleCollapse?: () => void;
}

export function TerminalPanel({ collapsed = false, showContent = true, onToggleCollapse }: TerminalPanelProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setOpenTaskId = useSessionStore((s) => s.setOpenTaskId);
  const dialogSessionId = useSessionStore((s) => s.dialogSessionId);
  const sessionActivity = useSessionStore((s) => s.sessionActivity);

  // Only show sessions that are actively running or queued.
  // Exited/suspended sessions are removed from the panel.
  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'queued',
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
          ? activeSessions[0].id
          : null;

  // Sync the store when the effective ID differs (stale or first auto-select)
  useEffect(() => {
    if (effectiveActiveId !== activeSessionId) {
      setActiveSession(effectiveActiveId);
    }
  }, [effectiveActiveId, activeSessionId, setActiveSession]);

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
      <div className="h-full bg-zinc-900 flex items-center justify-center text-zinc-600 text-sm">
        No active sessions. Drag a task to a column with a spawn_agent action to start one.
      </div>
    );
  }

  const isActivityActive = effectiveActiveId === ACTIVITY_TAB;

  return (
    <div className="h-full flex flex-col bg-zinc-900">
      {/* Tab bar */}
      <div className="flex items-center border-b border-zinc-700 flex-shrink-0">
        <div className="flex items-center overflow-x-auto flex-1 min-w-0">
          {/* Activity tab — visible when 1+ sessions */}
          {showActivityTab && (
            <button
              onClick={() => setActiveSession(ACTIVITY_TAB)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-zinc-700 transition-colors whitespace-nowrap ${
                isActivityActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
            >
              <Activity size={12} />
              Activity
            </button>
          )}

          {activeSessions.map((session) => (
            <button
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              onDoubleClick={() => setOpenTaskId(session.taskId)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-zinc-700 transition-colors whitespace-nowrap ${
                effectiveActiveId === session.id
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
            >
              {session.status === 'running' && sessionActivity[session.id] !== 'idle' ? (
                <Loader2 size={8} className="text-green-400 animate-spin" />
              ) : (
                <div className={`w-1.5 h-1.5 rounded-full ${
                  session.status === 'running' ? 'bg-green-400' :
                  session.status === 'queued' ? 'bg-yellow-400' :
                  'bg-zinc-500'
                }`} />
              )}
              {taskLabelMap.get(session.id) || session.taskId.slice(0, 8)}
            </button>
          ))}
        </div>

        {/* Collapse / expand toggle */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="flex items-center justify-center px-2 py-1.5 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
            title={collapsed ? 'Expand terminal panel' : 'Collapse terminal panel'}
          >
            {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {/* Terminal panes + context bar — hidden after collapse animation completes */}
      {showContent && (
        <>
          {/* Terminal panes — only the active one is positioned; rest are display:none.
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

            {/* Individual session terminals */}
            {activeSessions.map((session) => {
              const isActive = effectiveActiveId === session.id;
              const ownedByDialog = dialogSessionId === session.id;
              return (
                <div
                  key={session.id}
                  style={{ display: isActive && !ownedByDialog ? 'block' : 'none' }}
                  className="absolute inset-0"
                >
                  {!ownedByDialog && (
                    <TerminalTab sessionId={session.id} active={isActive} />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
