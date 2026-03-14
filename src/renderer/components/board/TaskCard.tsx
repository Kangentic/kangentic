import React, { useState, useEffect, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Loader2, Trash2, CirclePause, Mail, Image, Images } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { TaskDetailDialog } from '../dialogs/TaskDetailDialog';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useSessionDisplayState } from '../../utils/session-display-state';
import { getProgressColor } from '../../utils/color-lerp';
import type { Task, SessionSummary } from '../../../shared/types';

/** Priority: pending command (set by moveTask or manual invoke) > resuming > default. */
function deriveInitializingLabel(
  pendingCommandLabel: string | null,
  isResuming: boolean,
): string {
  if (pendingCommandLabel) return 'Running command...';
  if (isResuming) return 'Resuming...';
  return 'Initializing...';
}

interface TaskCardProps {
  task: Task;
  isDragOverlay?: boolean;
  compact?: boolean;
  onDelete?: (taskId: string) => void;
  summary?: SessionSummary;
}

const TaskCardInner = function TaskCard({ task, isDragOverlay, compact, onDelete, summary }: TaskCardProps) {
  const [showDetail, setShowDetail] = useState(false);

  // Extract sessionId once -- all other selectors derive from this single .find()
  const sessionId = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.taskId === task.id)?.id,
      [task.id],
    ),
  );
  // Simple primitive comparison -- no array scan needed
  const isHighlighted = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        !!sessionId && sessionId === s.activeSessionId,
      [sessionId],
    ),
  );
  const openTaskId = useSessionStore((s) => s.openTaskId);
  const setOpenTaskId = useSessionStore((s) => s.setOpenTaskId);
  const displayState = useSessionDisplayState(sessionId);

  // Derive contextual label for the initializing state (mirrors TerminalTab logic)
  const pendingCommandLabel = useSessionStore((s) => s.pendingCommandLabel[task.id] ?? null);
  const autoCommand = useBoardStore(
    useCallback(
      (s: ReturnType<typeof useBoardStore.getState>) => {
        const swimlane = s.swimlanes.find((l) => l.id === task.swimlane_id);
        return swimlane?.auto_command ?? null;
      },
      [task.swimlane_id],
    ),
  );
  // Lookup by sessionId (already extracted) instead of re-scanning by taskId
  const isResuming = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? (s.sessions.find((session) => session.id === sessionId)?.resuming ?? false) : false,
      [sessionId],
    ),
  );
  const hasCommand = !!pendingCommandLabel;
  const initializingLabel = deriveInitializingLabel(pendingCommandLabel, isResuming);

  useEffect(() => {
    if (openTaskId === task.id) {
      setShowDetail(true);
      setOpenTaskId(null);
    } else if (openTaskId !== null) {
      setShowDetail(false);
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
    transform: CSS.Transform.toString(transform) ?? 'translate3d(0, 0, 0)',
    transition: transition ?? 'transform 200ms ease',
    opacity: isDragging ? 0.4 : 1,
    contain: 'layout style paint',
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
          data-task-id={task.id}
          className={`bg-surface-raised/60 border border-edge/50 rounded-md px-2.5 py-1.5 cursor-grab active:cursor-grabbing hover:border-edge-input transition-colors group/card ${
            isDragOverlay ? 'shadow-xl' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-tertiary truncate flex-1" data-testid="compact-title">{task.title}</span>
            {onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
                className="p-2 rounded-full text-fg-disabled hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover/card:opacity-100 transition-all flex-shrink-0"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {task.description && (
              <span className="text-xs text-fg-disabled truncate flex-1">{task.description}</span>
            )}
            <span className="text-xs text-fg-disabled flex-shrink-0 ml-auto">
              {task.archived_at ? formatDistanceToNow(new Date(task.archived_at), { addSuffix: true }) : ''}
            </span>
          </div>
        </div>

        {showDetail && (
          <TaskDetailDialog task={task} onClose={() => setShowDetail(false)} initialEdit={displayState.kind === 'none' && !task.archived_at} />
        )}
      </>
    );
  }

  // Derive visual indicators from display state
  const isIdle = displayState.kind === 'running' && displayState.activity === 'idle';
  const isThinking = displayState.kind === 'running' && displayState.activity !== 'idle';

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={handleClick}
        data-task-id={task.id}
        className={`border rounded-md p-2.5 cursor-grab active:cursor-grabbing transition-colors bg-surface-raised ${
          isHighlighted ? 'border-[2px] border-fg-faint/60' : isIdle ? 'border-edge/40' : 'border-edge hover:border-edge-input'
        } ${isIdle ? 'animate-pulse-subtle' : ''
        } ${isDragOverlay ? 'shadow-xl' : ''}`}
      >
        <div className="flex items-center gap-1.5">
          {isIdle && (
            <Mail size={14} className="text-amber-400 shrink-0" />
          )}
          {isThinking && (
            <Loader2 size={14} className="text-emerald-400 animate-spin shrink-0" />
          )}
          <div className="text-sm text-fg font-medium truncate">{task.title}</div>
        </div>

        {task.pr_url && (
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs text-accent-fg">
              PR #{task.pr_number}
            </span>
          </div>
        )}

        {task.description && (
          <div className="text-xs text-fg-faint mt-1 line-clamp-3">{task.description}</div>
        )}

        {task.attachment_count > 0 && displayState.kind === 'none' && (
          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-edge">
            {task.attachment_count === 1
              ? <Image size={15} className="text-fg-faint" />
              : <Images size={15} className="text-fg-faint" />
            }
            <span className="text-xs text-fg-faint">{task.attachment_count}</span>
          </div>
        )}

        {/* Bottom bar -- exhaustive switch on display state */}
        {(() => {
          switch (displayState.kind) {
            case 'running': {
              if (!displayState.usage) return null;
              const pct = Math.round(displayState.usage.contextWindow.usedPercentage);
              const progressColor = getProgressColor(pct);
              return (
                <div className="mt-2 pt-2 border-t border-edge" data-testid="usage-bar">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-fg-faint">
                      {displayState.usage.model.displayName || 'Claude'}
                    </span>
                    <span className="text-xs text-fg-faint">{pct}%</span>
                  </div>
                  <div className="w-full h-1 bg-surface-hover rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: progressColor }}
                    />
                  </div>
                </div>
              );
            }
            case 'initializing':
              return (
                <div className="mt-2 pt-2 border-t border-edge" data-testid="status-bar">
                  <span className="text-xs text-fg-faint flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" />
                    {initializingLabel}
                  </span>
                </div>
              );
            case 'queued':
              return (
                <div className="mt-2 pt-2 border-t border-edge" data-testid="status-bar">
                  <span className="text-xs text-fg-faint flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" />
                    Queued...
                  </span>
                </div>
              );
            case 'suspended':
              return (
                <div className="mt-2 pt-2 border-t border-edge" data-testid="status-bar">
                  <span className="text-xs text-fg-faint flex items-center gap-1">
                    <CirclePause size={12} />
                    Paused
                  </span>
                </div>
              );
            case 'none':
            case 'exited':
            default:
              return null;
          }
        })()}
      </div>

      {showDetail && (
        <TaskDetailDialog task={task} onClose={() => setShowDetail(false)} initialEdit={displayState.kind === 'none' && !task.archived_at} />
      )}
    </>
  );
};

export const TaskCard = React.memo(TaskCardInner);
