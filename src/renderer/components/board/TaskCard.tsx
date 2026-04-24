import React, { useCallback, useState, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Loader2, CirclePause, Mail, Paperclip, GitPullRequest, FolderMinus, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '../../lib/datetime';
import { TaskDetailDialog } from '../dialogs/TaskDetailDialog';
import { TaskChangesDialog } from '../dialogs/TaskChangesDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { stripMarkdown } from '../../utils/strip-markdown';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import { useTaskProgress } from '../../utils/task-progress';
import { getProgressColor } from '../../utils/color-lerp';
import { LabelPills } from '../Pill';
import type { Task } from '../../../shared/types';
import { TaskContextMenu } from './TaskContextMenu';

interface TaskCardProps {
  task: Task;
  isDragOverlay?: boolean;
  compact?: boolean;
  onDelete?: (taskId: string) => void;
}

const TaskCardInner = function TaskCard({ task, isDragOverlay, compact, onDelete }: TaskCardProps) {
  // A single `useShallow`-gated selector replaces six individual subscriptions.
  // Scaling: 100 cards × 6 subs each = 600 selector invocations per session-store
  // update; with one selector it drops to 100, and shallow equality still skips
  // re-renders when the projected object hasn't actually changed.
  const { showDetail, sessionId, isHighlighted, isResuming, hasFirstOutput, hasActivityEntry } = useSessionStore(
    useShallow(
      useCallback(
        (s: ReturnType<typeof useSessionStore.getState>) => {
          const resolvedSessionId = s._sessionByTaskId.get(task.id)?.id;
          return {
            showDetail: s.detailTaskId === task.id,
            sessionId: resolvedSessionId,
            isHighlighted: !!resolvedSessionId && resolvedSessionId === s.activeSessionId,
            isResuming: s._sessionByTaskId.get(task.id)?.resuming ?? false,
            hasFirstOutput: resolvedSessionId ? !!s.sessionFirstOutput[resolvedSessionId] : false,
            hasActivityEntry: resolvedSessionId ? s.sessionActivity[resolvedSessionId] !== undefined : false,
          };
        },
        [task.id],
      ),
    ),
  );
  const setDetailTaskId = useSessionStore((s) => s.setDetailTaskId);
  const displayState = useTaskProgress(task.id, sessionId);

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
    transition: transition || undefined,
    opacity: isDragging ? 0.4 : 1,
    contain: 'layout style paint',
  };

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmSendToBacklog, setConfirmSendToBacklog] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [forceEdit, setForceEdit] = useState(false);
  const [showChanges, setShowChanges] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    if (isDragOverlay) return;
    e.stopPropagation();
    setDetailTaskId(task.id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isDragOverlay || compact) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleSendToBacklog = async () => {
    setContextMenu(null);
    setConfirmSendToBacklog(false);
    const taskTitle = task.title;
    await useBacklogStore.getState().demoteTask({ taskId: task.id });
    useToastStore.getState().addToast({
      message: `Sent "${taskTitle}" to backlog`,
      variant: 'info',
    });
  };

  const handleMoveTo = async (targetSwimlaneId: string) => {
    const { swimlanes: currentSwimlanes, tasks: currentTasks, moveTask } = useBoardStore.getState();
    const targetName = currentSwimlanes.find((lane) => lane.id === targetSwimlaneId)?.name ?? 'column';
    const laneTasks = currentTasks.filter(
      (boardTask) => boardTask.swimlane_id === targetSwimlaneId,
    );
    await moveTask({ taskId: task.id, targetSwimlaneId, targetPosition: laneTasks.length });
    // If a confirmation dialog was triggered, moveTask returns early without
    // moving. Don't show a success toast in that case.
    if (useBoardStore.getState().pendingMoveConfirm) return;
    useToastStore.getState().addToast({
      message: `Moved "${task.title}" to ${targetName}`,
      variant: 'success',
    });
  };

  const handleArchive = async () => {
    const { swimlanes: currentSwimlanes, tasks: currentTasks, archiveTask } = useBoardStore.getState();
    const doneLane = currentSwimlanes.find((lane) => lane.role === 'done');
    if (!doneLane) return;
    const taskTitle = task.title;
    const taskId = task.id;
    archiveTask(taskId);
    const laneTasks = currentTasks.filter(
      (boardTask) => boardTask.swimlane_id === doneLane.id,
    );
    await window.electronAPI.tasks.move({ taskId, targetSwimlaneId: doneLane.id, targetPosition: laneTasks.length });
    useToastStore.getState().addToast({
      message: `Archived "${taskTitle}"`,
      variant: 'info',
    });
  };

  // Label display config
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
  const taskLabels = task.labels ?? [];
  const cardDensity = useConfigStore((state) => state.config.cardDensity);

  const handleContextDelete = async (dontAskAgain: boolean) => {
    if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
    const session = useSessionStore.getState()._sessionByTaskId.get(task.id);
    if (session) {
      await useSessionStore.getState().killSession(session.id);
    }
    await useBoardStore.getState().deleteTask(task.id);
    setConfirmDelete(false);
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
          {task.description && (
            <div className="mt-0.5">
              <span className="text-xs text-fg-disabled truncate block">{stripMarkdown(task.description)}</span>
            </div>
          )}
          <div className="mt-1">
            <LabelPills labels={taskLabels} labelColors={labelColors} />
          </div>
          {task.archived_at && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-xs text-fg-disabled">
                {formatRelativeTime(task.archived_at)}
              </span>
              {!task.worktree_path && task.branch_name && (
                <span
                  className="inline-flex items-center gap-1 text-[11px] text-fg-disabled"
                  title={`Worktree deleted; branch ${task.branch_name} preserved`}
                  data-testid="worktree-deleted-badge"
                >
                  <FolderMinus size={11} />
                  worktree deleted
                </span>
              )}
            </div>
          )}
        </div>

        {showDetail && (
          <TaskDetailDialog task={task} onClose={() => setDetailTaskId(null)} initialEdit={displayState.kind === 'none' && !task.archived_at} />
        )}
      </>
    );
  }

  // A running session is always either idle or thinking; see
  // task-progress.ts for how the fallback is resolved.
  const isIdle = displayState.kind === 'running' && displayState.activity === 'idle';
  const isThinking = displayState.kind === 'running' && displayState.activity === 'thinking';

  // Board-level density: compact prop (from backlog) takes precedence, otherwise use config
  const boardDensity = compact ? 'compact' : cardDensity;
  const isCompactDensity = boardDensity === 'compact';
  const isComfortableDensity = boardDensity === 'comfortable';

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        data-task-id={task.id}
        className={`border rounded-md ${isComfortableDensity ? 'p-3' : 'p-2.5'} cursor-grab active:cursor-grabbing transition-colors bg-surface-raised ${
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

        {!isCompactDensity && task.pr_url && (
          <div className="flex items-center gap-2 mt-1.5">
            <button
              onClick={(event) => {
                event.stopPropagation();
                window.electronAPI.shell.openExternal(task.pr_url!);
              }}
              className="text-xs text-accent-fg hover:underline flex items-center gap-1"
              data-testid="task-card-pr-link"
            >
              <GitPullRequest size={12} />
              PR #{task.pr_number}
            </button>
          </div>
        )}

        {!isCompactDensity && task.description && (
          <div className={`text-xs text-fg-faint mt-1 ${isComfortableDensity ? 'line-clamp-5' : 'line-clamp-3'}`}>{stripMarkdown(task.description)}</div>
        )}

        <div className={isCompactDensity ? 'mt-1' : 'mt-1.5'}>
          <LabelPills labels={taskLabels} labelColors={labelColors} />
        </div>

        {!isCompactDensity && task.attachment_count > 0 && displayState.kind === 'none' && (
          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-edge">
            <Paperclip size={15} className="text-fg-faint" />
            <span className="text-xs text-fg-faint">{task.attachment_count}</span>
          </div>
        )}

        {/* Bottom bar -- exhaustive switch on display state */}
        {!isCompactDensity && (() => {
          switch (displayState.kind) {
            case 'running': {
              const resolvedModelName = displayState.usage?.model.displayName || null;
              // Before the CLI has produced any signal (first output, activity
              // event, or usage data), show a single spinner pill so we don't
              // flash intermediate labels. Once any signal arrives, fall through
              // to the rich or minimal pill.
              const cliHasReported = hasFirstOutput || hasActivityEntry || !!displayState.usage;
              if (!cliHasReported) {
                const spinnerLabel = isResuming ? 'Resuming agent...' : 'Starting agent...';
                return (
                  <div className="mt-2 pt-2 border-t border-edge" data-testid="usage-bar">
                    <span className="text-xs text-fg-faint flex items-center gap-1">
                      <Loader2 size={12} className="animate-spin" />
                      {spinnerLabel}
                    </span>
                  </div>
                );
              }
              // Show just the model name (no progress bar) when EITHER:
              //   - Usage hasn't streamed any token counts yet (boot window)
              //   - The agent's context window size is unknown (unmapped
              //     Gemini model: contextWindowSize is 0 as sentinel)
              // Always render the full progress bar layout once the CLI has
              // reported. Default to 0% with a placeholder label when usage
              // data hasn't streamed yet -- the bar at zero is the graceful
              // baseline, never a blank slot. Smoothly animates to real
              // values via the inner bar's transition-all when tokens arrive.
              // Active/idle state is already conveyed by the top-left
              // status icon (spinner vs mail), so no dot or label here.
              const usage = displayState.usage;
              const hasTokens = !!usage && usage.contextWindow.totalInputTokens > 0;
              const hasKnownWindow = !!usage && usage.contextWindow.contextWindowSize > 0;
              const pct = usage && hasTokens && hasKnownWindow
                ? Math.round(usage.contextWindow.usedPercentage)
                : 0;
              const progressColor = getProgressColor(pct);
              return (
                <div className="mt-2 pt-2 border-t border-edge" data-testid="usage-bar">
                  <div className="flex items-center justify-between mb-1.5">
                    {resolvedModelName ? (
                      <span className="text-xs text-fg-faint truncate">
                        {resolvedModelName}
                      </span>
                    ) : (
                      <span className="text-xs text-fg-faint flex items-center gap-1 truncate">
                        <Loader2 size={12} className="animate-spin shrink-0" />
                        Loading agent...
                      </span>
                    )}
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
            case 'preparing':
            case 'initializing':
              return (
                <div className="mt-2 pt-2 border-t border-edge" data-testid="status-bar">
                  <span className="text-xs text-fg-faint flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" />
                    {displayState.label}
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
        <TaskDetailDialog task={task} onClose={() => { setDetailTaskId(null); setForceEdit(false); }} initialEdit={forceEdit || (displayState.kind === 'none' && !task.archived_at)} />
      )}

      {contextMenu && (
        <TaskContextMenu
          position={contextMenu}
          task={task}
          swimlanes={useBoardStore.getState().swimlanes}
          onEdit={() => { setForceEdit(true); setDetailTaskId(task.id); }}
          onShowChanges={() => setShowChanges(true)}
          onMoveTo={handleMoveTo}
          onSendToBacklog={() => {
            setContextMenu(null);
            // Skip confirmation when non-destructive (no session, no worktree) or user opted out
            const hasResources = !!task.session_id || !!task.worktree_path;
            const skipConfirm = useConfigStore.getState().config.skipDeleteConfirm;
            if (!hasResources || skipConfirm) {
              handleSendToBacklog();
            } else {
              setConfirmSendToBacklog(true);
            }
          }}
          onArchive={handleArchive}
          onDelete={() => {
            setContextMenu(null);
            const skipConfirm = useConfigStore.getState().config.skipDeleteConfirm;
            if (skipConfirm) {
              handleContextDelete(false);
            } else {
              setConfirmDelete(true);
            }
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {showChanges && (
        <TaskChangesDialog task={task} onClose={() => setShowChanges(false)} />
      )}

      {confirmSendToBacklog && (
        <ConfirmDialog
          title="Send to Backlog"
          message={<>
            <p>This will move &quot;{task.title}&quot; to the backlog and clean up its session and worktree.</p>
            <p className="text-fg-muted mt-1">You can move it back to the board later.</p>
          </>}
          confirmLabel="Send to Backlog"
          showDontAskAgain
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
            handleSendToBacklog();
          }}
          onCancel={() => setConfirmSendToBacklog(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete task"
          message={<>
            <p>This will permanently delete &quot;{task.title}&quot; and its session data.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={handleContextDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
};

export const TaskCard = React.memo(TaskCardInner);
