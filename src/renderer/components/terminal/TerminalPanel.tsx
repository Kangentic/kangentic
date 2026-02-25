import React, { useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Layers, Loader2 } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { TerminalTab } from './TerminalTab';
import { AggregateTerminal } from './AggregateTerminal';
import { slugify } from '../../utils/slugify';

const ALL_SESSIONS_TAB = '__all__';

interface TerminalPanelProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function TerminalPanel({ collapsed = false, onToggleCollapse }: TerminalPanelProps) {
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

  const showAllTab = activeSessions.length >= 2;

  // Resolve the effective active ID: must be in the activeSessions list
  // or be the ALL_SESSIONS_TAB sentinel (when 2+ sessions exist).
  const effectiveActiveId =
    activeSessionId === ALL_SESSIONS_TAB && showAllTab
      ? ALL_SESSIONS_TAB
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

  // Build sessionId → slug map for tab labels and aggregate terminal badges
  const taskLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of activeSessions) {
      const task = tasks.find((t) => t.id === session.taskId);
      map.set(session.id, task ? slugify(task.title) : session.taskId.slice(0, 8));
    }
    return map;
  }, [activeSessions, tasks]);

  const aggregateSessionIds = useMemo(
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

  const isAllActive = effectiveActiveId === ALL_SESSIONS_TAB;

  return (
    <div className="h-full flex flex-col bg-zinc-900">
      {/* Tab bar */}
      <div className="flex items-center border-b border-zinc-700 flex-shrink-0">
        <div className="flex items-center overflow-x-auto flex-1 min-w-0">
          {/* "All" aggregate tab — only when 2+ sessions */}
          {showAllTab && (
            <button
              onClick={() => setActiveSession(ALL_SESSIONS_TAB)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-zinc-700 transition-colors whitespace-nowrap ${
                isAllActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
            >
              <Layers size={10} />
              All
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

      {/* Terminal panes + context bar — hidden when collapsed */}
      {!collapsed && (
        <>
          {/* Terminal panes — only the active one is positioned; rest are display:none.
              Sessions owned by the detail dialog are unmounted to avoid two xterm
              instances fighting over PTY dimensions (different column widths cause
              garbled TUI output). The panel recreates the terminal from scrollback
              when the dialog closes. */}
          <div className="flex-1 min-h-0 relative">
            {/* Aggregate "All" terminal */}
            {showAllTab && (
              <div
                style={{ display: isAllActive ? 'block' : 'none' }}
                className="absolute inset-0"
              >
                <AggregateTerminal
                  active={isAllActive}
                  sessionIds={aggregateSessionIds}
                  taskIdMap={taskLabelMap}
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
