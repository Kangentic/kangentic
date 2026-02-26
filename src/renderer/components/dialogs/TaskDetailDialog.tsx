import React, { useState, useLayoutEffect, useRef, useEffect } from 'react';
import { X, Trash2, Pencil, Loader2, ExternalLink, ArrowRightLeft, ChevronRight, MoreHorizontal, Archive, CirclePause, CirclePlay, Play } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import { TerminalTab } from '../terminal/TerminalTab';
import { ContextBar } from '../terminal/ContextBar';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';
import type { Task } from '../../../shared/types';

interface TaskDetailDialogProps {
  task: Task;
  onClose: () => void;
}

export function TaskDetailDialog({ task, onClose }: TaskDetailDialogProps) {
  const updateTask = useBoardStore((s) => s.updateTask);
  const deleteTask = useBoardStore((s) => s.deleteTask);
  const moveTask = useBoardStore((s) => s.moveTask);
  const unarchiveTask = useBoardStore((s) => s.unarchiveTask);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const killSession = useSessionStore((s) => s.killSession);
  const suspendSession = useSessionStore((s) => s.suspendSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const sessions = useSessionStore((s) => s.sessions);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [isEditing, setIsEditing] = useState(false);
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const kebabMenuRef = useRef<HTMLDivElement>(null);

  const isArchived = task.archived_at !== null;

  // Close kebab menu on click outside
  useEffect(() => {
    if (!showKebabMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (kebabMenuRef.current && !kebabMenuRef.current.contains(e.target as Node)) {
        setShowKebabMenu(false);
        setShowMoveSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showKebabMenu]);

  // Columns available as move targets: exclude current column and Done column (for archived tasks)
  const moveTargets = swimlanes.filter((s) => {
    if (s.id === task.swimlane_id) return false;
    if (isArchived && s.role === 'done') return false;
    return true;
  });

  const handleMoveTo = async (targetSwimlaneId: string) => {
    const targetName = swimlanes.find((s) => s.id === targetSwimlaneId)?.name ?? 'column';
    onClose();
    if (isArchived) {
      await unarchiveTask({ id: task.id, targetSwimlaneId });
    } else {
      const laneTasks = useBoardStore.getState().tasks.filter(
        (t) => t.swimlane_id === targetSwimlaneId,
      );
      await moveTask({ taskId: task.id, targetSwimlaneId, targetPosition: laneTasks.length });
    }
    useToastStore.getState().addToast({
      message: `Moved "${task.title}" to ${targetName}`,
      variant: 'success',
    });
  };

  const setDialogSessionId = useSessionStore((s) => s.setDialogSessionId);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const sessionActivity = useSessionStore((s) => s.sessionActivity);
  const session = task.session_id ? sessions.find((s) => s.id === task.session_id) : null;
  const activity = task.session_id ? sessionActivity[task.session_id] : undefined;
  const isThinking = session?.status === 'running' && activity !== 'idle';

  const sessionUsage = useSessionStore((s) => s.sessionUsage);

  // For toggle: find session by taskId (includes suspended sessions)
  const taskSession = sessions.find((s) => s.taskId === task.id);
  const canToggle = taskSession && (taskSession.status === 'running' || taskSession.status === 'queued' || taskSession.status === 'suspended');
  const isSessionActive = taskSession?.status === 'running' || taskSession?.status === 'queued';
  const isSuspended = taskSession?.status === 'suspended';

  // Use large dialog when there's an active session OR a suspended one
  const hasSessionContext = !!session || !!isSuspended || toggling;

  // Usage data for the suspended placeholder (may come from the old session id)
  const taskUsage = taskSession ? sessionUsage[taskSession.id] : undefined;

  const handleToggle = async () => {
    if (!canToggle || toggling) return;
    setToggling(true);
    try {
      if (isSessionActive) {
        await suspendSession(task.id);
      } else {
        await resumeSession(task.id);
      }
      await loadBoard();
    } catch (err) {
      console.error('Toggle session failed:', err);
      useToastStore.getState().addToast({
        message: `Failed to ${isSessionActive ? 'suspend' : 'resume'} session`,
        variant: 'warning',
      });
    } finally {
      setToggling(false);
    }
  };

  // Refit terminal when session resumes (transitions to running)
  useEffect(() => {
    if (session?.status === 'running') {
      const id = setTimeout(() => {
        window.dispatchEvent(new Event('terminal-panel-resize'));
      }, 300);
      return () => clearTimeout(id);
    }
  }, [session?.status]);

  // Register this session with the store so the bottom panel unmounts its
  // TerminalTab BEFORE any terminal effects fire. useLayoutEffect runs
  // synchronously after DOM mutations but before paint, ensuring the panel's
  // terminal is torn down before the dialog's terminal initializes.
  useLayoutEffect(() => {
    if (session?.id) {
      setDialogSessionId(session.id);
      return () => setDialogSessionId(null);
    }
  }, [session?.id, setDialogSessionId]);

  const handleSave = async () => {
    await updateTask({ id: task.id, title, description });
    if (!session) {
      onClose();
    } else {
      setIsEditing(false);
    }
  };

  const archiveTask = useBoardStore((s) => s.archiveTask);

  const handleArchive = async () => {
    const doneLane = swimlanes.find((s) => s.role === 'done');
    if (!doneLane) return;
    const taskTitle = task.title;
    // Close dialog and optimistically archive (no animation)
    onClose();
    archiveTask(task.id);
    // Persist via IPC — TASK_MOVE to Done auto-archives in the DB
    const laneTasks = useBoardStore.getState().tasks.filter(
      (t) => t.swimlane_id === doneLane.id,
    );
    await window.electronAPI.tasks.move({ taskId: task.id, targetSwimlaneId: doneLane.id, targetPosition: laneTasks.length });
    useToastStore.getState().addToast({
      message: `Archived "${taskTitle}"`,
      variant: 'info',
    });
  };

  const handleDelete = async () => {
    if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    const taskTitle = task.title;
    // Close dialog first to unmount the terminal (xterm) cleanly
    // before tearing down the session — prevents WebGL renderer crash
    onClose();
    if (task.session_id) {
      await killSession(task.session_id);
    }
    await deleteTask(task.id);
    useToastStore.getState().addToast({
      message: `Deleted task "${taskTitle}"`,
      variant: 'info',
    });
  };

  const customHeader = (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Pause / Resume toggle */}
      {canToggle && (
        toggling ? (
          <Loader2 size={18} className="text-zinc-400 animate-spin flex-shrink-0" />
        ) : (
          <button
            onClick={handleToggle}
            className={`p-1 rounded-full transition-colors flex-shrink-0 ${
              isSessionActive
                ? 'text-green-400 hover:bg-green-400/10'
                : 'text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300'
            }`}
            title={isSessionActive ? 'Pause session' : 'Resume session'}
          >
            {isSessionActive && isThinking ? (
              <Loader2 size={18} className="animate-spin" />
            ) : isSessionActive ? (
              <CirclePause size={18} />
            ) : (
              <CirclePlay size={18} />
            )}
          </button>
        )
      )}

      {/* Title — fills remaining space */}
      {isEditing ? (
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-500 flex-1 min-w-0"
          autoFocus
        />
      ) : (
        <h2 className="text-base font-semibold text-zinc-100 truncate flex-1 min-w-0">{task.title}</h2>
      )}

      {/* Actions */}
      {isEditing ? (
        <>
          <button
            onClick={() => { setTitle(task.title); setDescription(task.description); setIsEditing(false); }}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-600 hover:border-zinc-500 rounded transition-colors flex-shrink-0"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors flex-shrink-0"
          >
            Save
          </button>
        </>
      ) : (
        <div className="relative flex-shrink-0" ref={kebabMenuRef}>
          <button
            onClick={() => { setShowKebabMenu(!showKebabMenu); setShowMoveSubmenu(false); }}
            className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 rounded transition-colors"
            title="Actions"
          >
            <MoreHorizontal size={16} />
          </button>
          {showKebabMenu && (
            <div className="absolute top-full right-0 mt-1 min-w-[170px] bg-zinc-800 border border-zinc-600 rounded-md shadow-xl z-50 py-1">
              {/* Edit */}
              <button
                onClick={() => { setShowKebabMenu(false); setShowMoveSubmenu(false); setIsEditing(true); }}
                disabled={isThinking}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                  isThinking
                    ? 'text-zinc-600 cursor-not-allowed'
                    : 'text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
                }`}
                title={isThinking ? 'Cannot edit while agent is thinking' : undefined}
              >
                <Pencil size={14} />
                Edit
              </button>

              {/* Move to — flyout submenu to the right */}
              {moveTargets.length > 0 && (
                <div
                  className="relative"
                  onMouseEnter={() => setShowMoveSubmenu(true)}
                  onMouseLeave={() => setShowMoveSubmenu(false)}
                >
                  <button
                    onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
                    className={`w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors flex items-center gap-2 ${showMoveSubmenu ? 'bg-zinc-700 text-zinc-100' : ''}`}
                  >
                    <ArrowRightLeft size={14} />
                    <span className="flex-1">Move to</span>
                    <ChevronRight size={14} />
                  </button>
                  {showMoveSubmenu && (
                    <div className="absolute left-full top-0 -ml-px min-w-[150px] bg-zinc-800 border border-zinc-600 rounded-md shadow-xl z-50 py-1">
                      {moveTargets.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => handleMoveTo(s.id)}
                          className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors flex items-center gap-2"
                        >
                          <span className="flex-shrink-0" style={{ color: s.color }}>
                            {(() => {
                              const Icon = getSwimlaneIcon(s);
                              return Icon ? (
                                <Icon size={14} strokeWidth={1.75} />
                              ) : (
                                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                              );
                            })()}
                          </span>
                          {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Pause / Resume */}
              {canToggle && (
                <button
                  onClick={() => { setShowKebabMenu(false); setShowMoveSubmenu(false); handleToggle(new MouseEvent('click') as any); }}
                  disabled={toggling}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {isSessionActive ? (
                    <>
                      <CirclePause size={14} />
                      Pause session
                    </>
                  ) : (
                    <>
                      <CirclePlay size={14} />
                      Resume session
                    </>
                  )}
                </button>
              )}

              {/* Divider */}
              <div className="my-2 mx-2 border-t border-zinc-600" />

              {isArchived ? (
                /* Delete — only for archived tasks */
                <button
                  onClick={() => { setShowKebabMenu(false); setShowMoveSubmenu(false); skipDeleteConfirm ? handleDelete() : setConfirmDelete(true); }}
                  className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-400/10 hover:text-red-300 transition-colors flex items-center gap-2"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              ) : (
                /* Archive — moves to Done, no confirmation */
                <button
                  onClick={() => { setShowKebabMenu(false); setShowMoveSubmenu(false); handleArchive(); }}
                  className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors flex items-center gap-2"
                >
                  <Archive size={14} />
                  Archive
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Divider + Close */}
      <div className="w-px h-5 bg-zinc-700 flex-shrink-0" />
      <button
        onClick={onClose}
        className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 rounded transition-colors flex-shrink-0"
      >
        <X size={16} />
      </button>
    </div>
  );

  if (confirmDelete) {
    return (
      <ConfirmDialog
        title="Delete task"
        message={<>
          <p>This will permanently delete the task, its session history, and any associated worktree.</p>
          <p className="text-red-400 font-medium">This action cannot be undone.</p>
        </>}
        confirmLabel="Delete"
        variant="danger"
        footerLeft={
          <label className="inline-flex items-center gap-2 cursor-pointer h-full">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="rounded border-zinc-600 bg-zinc-900 accent-blue-500"
            />
            <span className="text-xs text-zinc-400">Don't ask again</span>
          </label>
        }
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    );
  }

  return (
    <BaseDialog
      onClose={onClose}
      header={customHeader}
      rawBody
      className={hasSessionContext ? 'w-[90vw] h-[85vh]' : 'w-[480px] max-h-[80vh]'}
      backdropClassName="p-6"
    >
        {/* Description (collapsible when terminal is present) */}
        {isEditing && (
          <div className="px-4 py-3 border-b border-zinc-700 flex-shrink-0">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Description"
              className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>
        )}

        {!isEditing && task.description && !hasSessionContext && (
          <div className="px-4 py-3 border-b border-zinc-700 flex-shrink-0">
            <p className="text-sm text-zinc-400 whitespace-pre-wrap">{task.description}</p>
          </div>
        )}

        {/* Worktree / PR info */}
        {!isEditing && (task.worktree_path || task.pr_url) && (
          <div className="px-4 py-2 border-b border-zinc-700 flex-shrink-0 flex items-center gap-4 text-xs">
            {task.branch_name && (
              <span className="text-zinc-400 flex items-center gap-1.5">
                Branch:
                {task.worktree_path ? (
                  <button
                    onClick={() => window.electronAPI.shell.openPath(task.worktree_path!)}
                    className="inline-flex items-center gap-1.5 text-zinc-200 hover:text-blue-400 transition-colors"
                    title="Open worktree directory"
                  >
                    {task.branch_name}
                    <ExternalLink size={12} />
                  </button>
                ) : (
                  <span className="text-zinc-200">{task.branch_name}</span>
                )}
              </span>
            )}
            {task.pr_url && (
              <span className="text-zinc-400">PR: <span className="text-blue-400">#{task.pr_number}</span></span>
            )}
          </div>
        )}

        {/* Terminal, suspended placeholder, or empty state */}
        {session ? (
          <>
            <div className="flex-1 min-h-0 relative">
              <div className="absolute inset-0">
                <TerminalTab key={session.id} sessionId={session.id} active={true} />
              </div>
            </div>
            <ContextBar sessionId={session.id} />
          </>
        ) : isSuspended || toggling ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-900/50">
            <button
              onClick={handleToggle}
              disabled={toggling}
              className="flex items-center gap-2.5 px-6 py-3 rounded-lg bg-blue-500/20 border border-blue-500/40 text-base text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
            >
              {toggling ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={16} />
              )}
              Resume session
            </button>
          </div>
        ) : (
          !isEditing && !task.description && (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm p-8">
              No active session. Drag this task to a column with a transition to start one.
            </div>
          )
        )}
      </BaseDialog>
  );
}
