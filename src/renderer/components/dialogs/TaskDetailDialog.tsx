import React, { useState, useEffect, useLayoutEffect } from 'react';
import { X, Trash2, Pencil } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { TerminalTab } from '../terminal/TerminalTab';
import { ContextBar } from '../terminal/ContextBar';
import { useToastStore } from '../../stores/toast-store';
import type { Task } from '../../../shared/types';

interface TaskDetailDialogProps {
  task: Task;
  onClose: () => void;
}

export function TaskDetailDialog({ task, onClose }: TaskDetailDialogProps) {
  const updateTask = useBoardStore((s) => s.updateTask);
  const deleteTask = useBoardStore((s) => s.deleteTask);
  const killSession = useSessionStore((s) => s.killSession);
  const sessions = useSessionStore((s) => s.sessions);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const setDialogSessionId = useSessionStore((s) => s.setDialogSessionId);
  const claudeVersionLabel = useConfigStore((s) => s.claudeVersionLabel);
  const session = task.session_id ? sessions.find((s) => s.id === task.session_id) : null;

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
    setIsEditing(false);
  };

  const handleDelete = async () => {
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

  // Global Escape key listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`bg-zinc-800 border border-zinc-700 rounded-lg shadow-2xl flex flex-col overflow-hidden ${
          session ? 'w-[90vw] h-[85vh]' : 'w-[480px] max-h-[80vh]'
        }`}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {session && (
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                session.status === 'running' ? 'bg-green-400 animate-pulse' :
                session.status === 'queued' ? 'bg-yellow-400' :
                'bg-zinc-400'
              }`} />
            )}
            {isEditing ? (
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-500 w-64"
                autoFocus
              />
            ) : (
              <h2 className="text-base font-semibold text-zinc-100 truncate">{task.title}</h2>
            )}
            {session && !isEditing && (
              <span className="text-xs text-zinc-500 flex-shrink-0">
                {claudeVersionLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {isEditing ? (
              <>
                <button
                  onClick={() => { setTitle(task.title); setDescription(task.description); setIsEditing(false); }}
                  className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded"
                >
                  Save
                </button>
              </>
            ) : (
              <>
                {confirmDelete ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-red-400 mr-1">Delete this task?</span>
                    <button
                      onClick={handleDelete}
                      className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded transition-colors"
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                )}
                <button
                  onClick={() => setIsEditing(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
                >
                  <Pencil size={13} />
                  Edit
                </button>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
              </>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 rounded transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

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

        {!isEditing && task.description && !session && (
          <div className="px-4 py-3 border-b border-zinc-700 flex-shrink-0">
            <p className="text-sm text-zinc-400 whitespace-pre-wrap">{task.description}</p>
          </div>
        )}

        {/* Worktree / PR info */}
        {!isEditing && (task.worktree_path || task.pr_url) && (
          <div className="px-4 py-2 border-b border-zinc-700 flex-shrink-0 flex items-center gap-4 text-xs">
            {task.branch_name && (
              <span className="text-zinc-400">Branch: <span className="text-zinc-200">{task.branch_name}</span></span>
            )}
            {task.pr_url && (
              <span className="text-zinc-400">PR: <span className="text-blue-400">#{task.pr_number}</span></span>
            )}
          </div>
        )}

        {/* Terminal or empty state */}
        {session ? (
          <>
            <div className="flex-1 min-h-0 relative">
              <div className="absolute inset-0">
                <TerminalTab key={session.id} sessionId={session.id} active={true} />
              </div>
            </div>
            <ContextBar sessionId={session.id} />
          </>
        ) : (
          !isEditing && !task.description && (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm p-8">
              No active session. Drag this task to a column with a transition to start one.
            </div>
          )
        )}
      </div>
    </div>
  );
}
