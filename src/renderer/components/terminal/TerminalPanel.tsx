import React, { useEffect } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { TerminalTab } from './TerminalTab';

export function TerminalPanel() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setOpenTaskId = useSessionStore((s) => s.setOpenTaskId);
  const dialogSessionId = useSessionStore((s) => s.dialogSessionId);

  // Only show sessions that are actively running or queued.
  // Exited/suspended sessions are removed from the panel.
  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'queued',
  );

  // Resolve the effective active ID: must be in the activeSessions list.
  // If activeSessionId is stale (from a previous project or removed session),
  // fall back to the first session.
  const effectiveActiveId =
    activeSessions.some((s) => s.id === activeSessionId)
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

  if (activeSessions.length === 0) {
    return (
      <div className="h-full bg-zinc-900 flex items-center justify-center text-zinc-600 text-sm">
        No active sessions. Drag a task to a column with a spawn_agent skill to start one.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-zinc-900">
      {/* Tab bar */}
      <div className="flex items-center border-b border-zinc-700 overflow-x-auto flex-shrink-0">
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
            <div className={`w-1.5 h-1.5 rounded-full ${
              session.status === 'running' ? 'bg-green-400' :
              session.status === 'queued' ? 'bg-yellow-400' :
              'bg-zinc-500'
            }`} />
            {session.taskId.slice(0, 8)}
          </button>
        ))}
      </div>

      {/* Terminal panes — only the active one is positioned; rest are display:none.
          Sessions owned by the detail dialog are unmounted to avoid two xterm
          instances fighting over PTY dimensions (different column widths cause
          garbled TUI output). The panel recreates the terminal from scrollback
          when the dialog closes. */}
      <div className="flex-1 min-h-0 relative">
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
    </div>
  );
}
