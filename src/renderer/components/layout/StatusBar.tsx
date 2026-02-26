import React from 'react';
import { Terminal, ListTodo } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';

export function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const claudeInfo = useConfigStore((s) => s.claudeInfo);
  const claudeVersionLabel = useConfigStore((s) => s.claudeVersionLabel);
  const tasks = useBoardStore((s) => s.tasks);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const currentProject = useProjectStore((s) => s.currentProject);

  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'queued',
  ).length;
  const queued = sessions.filter((s) => s.status === 'queued').length;

  // Count tasks not in "done" role swimlanes
  const doneSwimlaneIds = new Set(
    swimlanes.filter((s) => s.role === 'done').map((s) => s.id),
  );
  const activeTasks = tasks.filter((t) => !doneSwimlaneIds.has(t.swimlane_id)).length;

  return (
    <div className="h-9 bg-zinc-900 border-t border-zinc-700 flex items-center px-3 text-xs text-zinc-500 select-none flex-shrink-0">
      {currentProject && (
        <>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800" data-testid="session-count">
              <Terminal size={14} className={activeSessions > 0 ? 'text-green-400' : 'text-zinc-500'} />
              <span className={activeSessions > 0 ? 'text-green-400' : ''}>
                {activeSessions} active
              </span>
              {queued > 0 && <span className="text-yellow-400">({queued} queued)</span>}
            </span>
            <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800" data-testid="task-count">
              <ListTodo size={14} />
              {activeTasks} tasks
            </span>
          </div>

          <div className="flex-1" />
        </>
      )}

      {!currentProject && <div className="flex-1" />}

      <div className="flex items-center gap-4">
        {claudeInfo && (
          claudeInfo.found ? (
            <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-500">{claudeVersionLabel}</span>
          ) : (
            <span className="text-red-400">claude not found</span>
          )
        )}
      </div>
    </div>
  );
}
