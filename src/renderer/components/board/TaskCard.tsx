import React, { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskDetailDialog } from '../dialogs/TaskDetailDialog';
import { useSessionStore } from '../../stores/session-store';
import type { Task } from '../../../shared/types';

interface TaskCardProps {
  task: Task;
  isDragOverlay?: boolean;
}

export function TaskCard({ task, isDragOverlay }: TaskCardProps) {
  const [showDetail, setShowDetail] = useState(false);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const openTaskId = useSessionStore((s) => s.openTaskId);
  const setOpenTaskId = useSessionStore((s) => s.setOpenTaskId);

  const session = task.session_id ? sessions.find((s) => s.id === task.session_id) : null;
  const isHighlighted = !!task.session_id && task.session_id === activeSessionId;

  useEffect(() => {
    if (openTaskId === task.id) {
      setShowDetail(true);
      setOpenTaskId(null);
    }
  }, [openTaskId, task.id, setOpenTaskId]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: 'task' },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const statusColor = session
    ? session.status === 'running'
      ? 'bg-green-400'
      : session.status === 'queued'
      ? 'bg-yellow-400'
      : session.status === 'exited'
      ? 'bg-zinc-400'
      : 'bg-red-400'
    : '';

  const handleClick = (e: React.MouseEvent) => {
    if (isDragOverlay) return;
    e.stopPropagation();
    setShowDetail(true);
  };

  const handleSessionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.session_id) {
      setActiveSession(task.session_id);
    }
  };

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={handleClick}
        className={`bg-zinc-800 border border-zinc-700 rounded-md p-2.5 cursor-grab active:cursor-grabbing hover:border-zinc-600 transition-colors ${
          isDragOverlay ? 'shadow-xl' : ''
        } ${isHighlighted ? 'ring-2 ring-blue-500/60' : ''}`}
      >
        <div className="text-sm text-zinc-100 font-medium truncate">{task.title}</div>

        {(task.agent || task.pr_url) && (
          <div className="flex items-center gap-2 mt-1.5">
            {task.agent && session && (
              <button
                onClick={handleSessionClick}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <div className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
                {task.agent}
              </button>
            )}
            {task.pr_url && (
              <span className="text-xs text-blue-400">
                PR #{task.pr_number}
              </span>
            )}
          </div>
        )}

        {task.description && (
          <div className="text-xs text-zinc-500 mt-1 line-clamp-2">{task.description}</div>
        )}
      </div>

      {showDetail && (
        <TaskDetailDialog task={task} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}
