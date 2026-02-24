import React, { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Loader2, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { TaskDetailDialog } from '../dialogs/TaskDetailDialog';
import { useSessionStore } from '../../stores/session-store';
import { getProgressColor } from '../../utils/color-lerp';
import type { Task } from '../../../shared/types';

export function TaskCard({ task, isDragOverlay, compact, onDelete }: TaskCardProps) {
  const [showDetail, setShowDetail] = useState(false);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const openTaskId = useSessionStore((s) => s.openTaskId);
  const setOpenTaskId = useSessionStore((s) => s.setOpenTaskId);
  const sessionUsage = useSessionStore((s) => s.sessionUsage);
  const sessionActivity = useSessionStore((s) => s.sessionActivity);

  const session = task.session_id ? sessions.find((s) => s.id === task.session_id) : null;
  const isHighlighted = !!task.session_id && task.session_id === activeSessionId;
  const usage = task.session_id ? sessionUsage[task.session_id] : undefined;
  const activity = task.session_id ? sessionActivity[task.session_id] : undefined;
  const isThinking = session?.status === 'running' && activity !== 'idle';

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

  const handleClick = (e: React.MouseEvent) => {
    if (isDragOverlay) return;
    e.stopPropagation();
    setShowDetail(true);
  };

  if (compact) {
    return (
      <>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          onClick={handleClick}
          className={`bg-zinc-800/60 border border-zinc-700/50 rounded-md px-2.5 py-1.5 cursor-grab active:cursor-grabbing hover:border-zinc-600 transition-colors group/card ${
            isDragOverlay ? 'shadow-xl' : ''
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-zinc-300 truncate flex-1">{task.title}</span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-xs text-zinc-600">
                {task.archived_at ? formatDistanceToNow(new Date(task.archived_at), { addSuffix: true }) : ''}
              </span>
              {onDelete && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
                  className="ml-1.5 p-2 rounded-full text-zinc-600 hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover/card:opacity-100 transition-all"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {showDetail && (
          <TaskDetailDialog task={task} onClose={() => setShowDetail(false)} />
        )}
      </>
    );
  }

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

        {task.pr_url && (
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs text-blue-400">
              PR #{task.pr_number}
            </span>
          </div>
        )}

        {task.description && (
          <div className="text-xs text-zinc-500 mt-1 line-clamp-3">{task.description}</div>
        )}

        {usage ? (() => {
          const pct = Math.round(usage.contextWindow.usedPercentage);
          const progressColor = getProgressColor(pct);
          return (
            <div className="mt-2 pt-2 border-t border-zinc-700" data-testid="usage-bar">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[11px] text-zinc-500 flex items-center gap-1">
                  {isThinking && <Loader2 size={10} className="text-green-400 animate-spin" />}
                  {usage.model.displayName || 'Claude'}
                </span>
                <span className="text-[11px] transition-colors duration-300" style={{ color: progressColor }}>{pct}%</span>
              </div>
              <div className="w-full h-1 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: progressColor }}
                />
              </div>
            </div>
          );
        })() : session && (
          <div className="mt-2 pt-2 border-t border-zinc-700" data-testid="initializing-bar">
            <div className="flex items-center gap-1.5">
              <Loader2 size={10} className="text-zinc-500 animate-spin" />
              <span className="text-[11px] text-zinc-500">
                {session.status === 'queued' ? 'Queued...' : 'Initializing...'}
              </span>
            </div>
          </div>
        )}
      </div>

      {showDetail && (
        <TaskDetailDialog task={task} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}
