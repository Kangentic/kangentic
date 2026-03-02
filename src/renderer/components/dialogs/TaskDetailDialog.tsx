import React, { useState, useLayoutEffect, useRef, useEffect, useCallback, useMemo } from 'react';
import { X, Trash2, Pencil, Loader2, ExternalLink, ArrowRightLeft, ChevronRight, MoreHorizontal, Archive, CirclePause, CirclePlay, Play, Image, Clock } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import { TerminalTab } from '../terminal/TerminalTab';
import { ContextBar } from '../terminal/ContextBar';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';
import { useSessionDisplayState } from '../../utils/session-display-state';
import { BranchPicker } from './BranchPicker';
import { WorktreeChip } from './WorktreeChip';
import type { Task, TaskAttachment } from '../../../shared/types';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

const MEDIA_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

interface AttachmentWithPreview extends TaskAttachment {
  previewUrl?: string;
}

interface TaskDetailDialogProps {
  task: Task;
  onClose: () => void;
  initialEdit?: boolean;
}

function QueuedPlaceholder({ sessionId }: { sessionId: string | null }) {
  const maxConcurrent = useConfigStore((s) => s.config.claude.maxConcurrentSessions);
  const runningCount = useSessionStore((s) => s.getRunningCount());
  // Split into primitive selectors — avoids new object refs triggering re-renders
  const queuePosition = useSessionStore((s) => {
    if (!sessionId) return 0;
    const pos = s.getQueuePosition(sessionId);
    return pos ? pos.position : 0;
  });
  const queueTotal = useSessionStore((s) => {
    if (!sessionId) return 0;
    const pos = s.getQueuePosition(sessionId);
    return pos ? pos.total : 0;
  });

  const openSettingsTab = useConfigStore((s) => s.openSettingsTab);

  return (
    <div className="flex-1 flex flex-col bg-surface/50">
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <Clock size={32} className="text-fg-faint animate-pulse" />
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-base text-fg-muted font-medium">Waiting in queue</span>
          {queuePosition > 0 && (
            <span className="text-sm text-fg-faint">
              Position {queuePosition} of {queueTotal}
            </span>
          )}
          <span className="text-xs text-fg-disabled mt-1">
            Starts automatically when a slot opens up
          </span>
        </div>
      </div>
      <div className="px-4 py-2.5 border-t border-edge">
        <button
          onClick={() => openSettingsTab('agent')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-fg-faint bg-surface-hover/50 hover:bg-surface-hover hover:text-fg-tertiary transition-colors"
        >
          {runningCount} / {maxConcurrent} agent slots in use
          <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

export function TaskDetailDialog({ task, onClose, initialEdit }: TaskDetailDialogProps) {
  const updateTask = useBoardStore((s) => s.updateTask);
  const deleteTask = useBoardStore((s) => s.deleteTask);
  const moveTask = useBoardStore((s) => s.moveTask);
  const unarchiveTask = useBoardStore((s) => s.unarchiveTask);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const killSession = useSessionStore((s) => s.killSession);
  const suspendSession = useSessionStore((s) => s.suspendSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [isEditing, setIsEditing] = useState(!!initialEdit);
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [baseBranch, setBaseBranch] = useState(task.base_branch || '');
  const worktreesEnabled = useConfigStore((s) => s.config.git.worktreesEnabled);
  const [useWorktree, setUseWorktree] = useState<boolean | null>(
    task.use_worktree != null ? Boolean(task.use_worktree) : null,
  );
  const effectiveWorktree = useWorktree ?? worktreesEnabled;
  const [textareaFocused, setTextareaFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [toggling, setToggling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const defaultBaseBranch = useConfigStore((s) => s.config.git.defaultBaseBranch);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const kebabMenuRef = useRef<HTMLDivElement>(null);

  // Attachment state
  const [savedAttachments, setSavedAttachments] = useState<AttachmentWithPreview[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<{ url: string; filename: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const isArchived = task.archived_at !== null;
  const currentSwimlane = swimlanes.find((s) => s.id === task.swimlane_id);
  const isInBacklog = currentSwimlane?.role === 'backlog';

  // Load attachments on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.electronAPI.attachments.list(task.id);
        if (cancelled) return;
        // Load preview data URLs for each attachment
        const withPreviews = await Promise.all(
          list.map(async (att) => {
            try {
              const previewUrl = await window.electronAPI.attachments.getDataUrl(att.id);
              return { ...att, previewUrl };
            } catch {
              return { ...att, previewUrl: undefined };
            }
          }),
        );
        if (!cancelled) setSavedAttachments(withPreviews);
      } catch {
        // No attachments API (e.g. in tests) — ignore
      }
    })();
    return () => { cancelled = true; };
  }, [task.id]);

  const addImageFile = useCallback(async (file: File, filenameOverride?: string) => {
    if (file.size > MAX_IMAGE_SIZE) {
      useToastStore.getState().addToast({
        message: `Image "${file.name}" exceeds 10MB limit`,
        variant: 'warning',
      });
      return;
    }
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      const filename = filenameOverride || file.name;
      try {
        const attachment = await window.electronAPI.attachments.add({
          task_id: task.id,
          filename,
          data: base64,
          media_type: file.type,
        });
        const previewUrl = await window.electronAPI.attachments.getDataUrl(attachment.id);
        setSavedAttachments((prev) => [...prev, { ...attachment, previewUrl }]);
      } catch (err) {
        console.error('Failed to add attachment:', err);
      }
    };
    reader.readAsDataURL(file);
  }, [task.id]);

  const removeAttachment = useCallback(async (id: string) => {
    try {
      await window.electronAPI.attachments.remove(id);
      setSavedAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error('Failed to remove attachment:', err);
    }
  }, []);

  const handleAttachmentPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const ext = MEDIA_TYPE_EXT[file.type] || '.png';
        const count = savedAttachments.filter((a) => a.filename.startsWith('pasted-image-')).length;
        const name = `pasted-image-${count + 1}${ext}`;
        addImageFile(file, name);
      }
    }
  }, [savedAttachments, addImageFile]);

  const handleAttachmentDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleAttachmentDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleAttachmentDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        addImageFile(file);
      }
    }
  }, [addImageFile]);

  const handlePreview = useCallback(async (att: AttachmentWithPreview) => {
    if (att.previewUrl) {
      setPreviewAttachment({ url: att.previewUrl, filename: att.filename });
    }
  }, []);

  // Close kebab menu on click outside
  useEffect(() => {
    if (!showKebabMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (kebabMenuRef.current && !kebabMenuRef.current.contains(e.target as Node)) {
        setShowKebabMenu(false);
        setShowMoveSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [showKebabMenu]);

  // Columns available as move targets: exclude current column and Done column (for archived tasks)
  const moveTargets = useMemo(() =>
    swimlanes.filter((s) => {
      if (s.id === task.swimlane_id) return false;
      if (isArchived && s.role === 'done') return false;
      return true;
    }),
    [swimlanes, task.swimlane_id, isArchived],
  );

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
  // Targeted selector — only re-renders when THIS session changes, not all sessions
  const session = useSessionStore((s) =>
    task.session_id ? s.sessions.find((sess) => sess.id === task.session_id) ?? null : null
  );

  // Centralized display state derivation
  const displayState = useSessionDisplayState(task);
  const isThinking = displayState.kind === 'running' && displayState.activity !== 'idle';
  const canToggle = displayState.kind === 'running' || displayState.kind === 'queued'
    || displayState.kind === 'initializing' || displayState.kind === 'suspended';
  const isSessionActive = displayState.kind === 'running' || displayState.kind === 'queued'
    || displayState.kind === 'initializing';
  const isQueued = displayState.kind === 'queued';
  const isSuspended = displayState.kind === 'suspended';

  // Use large dialog when there's an active session OR a suspended one
  const hasSessionContext = (displayState.kind !== 'none' && displayState.kind !== 'exited') || toggling;
  const dialogSizeClass = hasSessionContext && !isQueued
    ? 'w-[90vw] h-[85vh]'
    : isQueued
      ? 'w-[520px] h-[320px]'
      : 'w-[640px] max-h-[80vh]';

  // Auto-expand textarea for no-session edit mode
  useEffect(() => {
    if (!isEditing || hasSessionContext) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 800)}px`;
  }, [description, isEditing, hasSessionContext]);

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

  // Refit terminal when edit mode toggles (changes available height)
  useEffect(() => {
    if (!session) return;
    const id = setTimeout(() => {
      window.dispatchEvent(new Event('terminal-panel-resize'));
    }, 100);
    return () => clearTimeout(id);
  }, [isEditing, session?.id]);

  // Register this session with the store so the bottom panel unmounts its
  // TerminalTab BEFORE any terminal effects fire. useLayoutEffect runs
  // synchronously after DOM mutations but before paint, ensuring the panel's
  // terminal is torn down before the dialog's terminal initializes.
  useLayoutEffect(() => {
    if (session?.id) {
      // Guard against redundant store updates — prevents re-render cascades
      if (useSessionStore.getState().dialogSessionId !== session.id) {
        setDialogSessionId(session.id);
      }
      return () => setDialogSessionId(null);
    }
  }, [session?.id, setDialogSessionId]);

  const handleCancel = () => {
    setTitle(task.title);
    setDescription(task.description);
    setBaseBranch(task.base_branch || '');
    setUseWorktree(task.use_worktree != null ? Boolean(task.use_worktree) : null);
    setIsEditing(false);
  };

  const handleSave = async () => {
    const payload: Parameters<typeof updateTask>[0] = { id: task.id, title, description };
    if (!hasSessionContext) {
      const trimmed = baseBranch.trim();
      const original = task.base_branch || '';
      if (trimmed !== original) {
        payload.base_branch = trimmed || null;
      }
      const originalWorktree = task.use_worktree != null ? Boolean(task.use_worktree) : null;
      if (useWorktree !== originalWorktree) {
        payload.use_worktree = useWorktree != null ? (useWorktree ? 1 : 0) : null;
      }
    }
    await updateTask(payload);
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

  // Thumbnail strip component (shared between edit and view modes)
  const thumbnailStrip = savedAttachments.length > 0 && (
    <div className="flex gap-2.5 overflow-x-auto pb-1" data-testid="attachment-thumbnails">
      {savedAttachments.map((att) => (
        <div
          key={att.id}
          className="relative flex-shrink-0 w-24 h-24 rounded-md border border-edge-input overflow-hidden group cursor-pointer"
          onClick={() => handlePreview(att)}
        >
          {att.previewUrl && (
            <img
              src={att.previewUrl}
              alt={att.filename}
              className="w-full h-full object-cover"
            />
          )}
          {isEditing && (
            <button
              onClick={(e) => { e.stopPropagation(); removeAttachment(att.id); }}
              className="absolute top-0 right-0 p-1 bg-black/70 text-white rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X size={14} />
            </button>
          )}
          <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-fg-tertiary truncate opacity-0 group-hover:opacity-100 transition-opacity">
            {att.filename}
          </div>
        </div>
      ))}
    </div>
  );

  const customHeader = (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Pause / Resume toggle */}
      {canToggle && (
        toggling ? (
          <Loader2 size={18} className="text-fg-muted animate-spin flex-shrink-0" />
        ) : (
          <button
            onClick={handleToggle}
            className={`p-1 rounded-full transition-colors flex-shrink-0 ${
              isQueued
                ? 'text-fg-muted hover:bg-surface-hover'
                : isSessionActive
                  ? 'text-green-400 hover:bg-green-400/10'
                  : 'text-fg-faint hover:bg-surface-hover hover:text-fg-tertiary'
            }`}
            title={isQueued ? 'Queued — click to pause' : isSessionActive ? 'Pause session' : 'Resume session'}
          >
            {isQueued ? (
              <Clock size={18} />
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
          className="bg-surface border border-edge-input rounded px-2 py-1 text-sm text-fg focus:outline-none focus:border-accent flex-1 min-w-0"
          autoFocus
        />
      ) : (
        <h2 className="text-base font-semibold text-fg truncate flex-1 min-w-0">{task.title}</h2>
      )}

      {/* Actions */}
      {isEditing && hasSessionContext ? (
        <>
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors flex-shrink-0"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors flex-shrink-0"
          >
            Save
          </button>
        </>
      ) : !isEditing ? (
        <div className="relative flex-shrink-0" ref={kebabMenuRef}>
          <button
            onClick={() => { setShowKebabMenu(!showKebabMenu); setShowMoveSubmenu(false); }}
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
            title="Actions"
          >
            <MoreHorizontal size={16} />
          </button>
          {showKebabMenu && (
            <div className="absolute top-full right-0 mt-1 min-w-[170px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1">
              {/* Edit */}
              <button
                onClick={() => { setShowKebabMenu(false); setShowMoveSubmenu(false); setIsEditing(true); }}
                disabled={isThinking}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                  isThinking
                    ? 'text-fg-disabled cursor-not-allowed'
                    : 'text-fg-tertiary hover:bg-surface-hover hover:text-fg'
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
                    className={`w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 ${showMoveSubmenu ? 'bg-surface-hover text-fg' : ''}`}
                  >
                    <ArrowRightLeft size={14} />
                    <span className="flex-1">Move to</span>
                    <ChevronRight size={14} />
                  </button>
                  {showMoveSubmenu && (
                    <div className="absolute left-full top-0 -ml-px min-w-[150px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1">
                      {moveTargets.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => handleMoveTo(s.id)}
                          className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2"
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
                  onClick={() => { setShowKebabMenu(false); setShowMoveSubmenu(false); handleToggle(); }}
                  disabled={toggling}
                  className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 disabled:opacity-50"
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
              <div className="my-2 mx-2 border-t border-edge-input" />

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
                  className="w-full text-left px-3 py-2 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2"
                >
                  <Archive size={14} />
                  Archive
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Divider + Close */}
      <div className="w-px h-5 bg-surface-hover flex-shrink-0" />
      <button
        onClick={onClose}
        className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
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
              className="accent-accent rounded border-edge-input bg-surface"
            />
            <span className="text-xs text-fg-muted">Don't ask again</span>
          </label>
        }
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    );
  }

  return (
    <>
      <BaseDialog
        onClose={onClose}
        header={customHeader}
        rawBody
        className={dialogSizeClass}
        backdropClassName="p-6"
        testId="task-detail-dialog"
        footer={isEditing && !hasSessionContext ? (
          <div className={`flex ${isInBacklog ? 'justify-between' : 'justify-end'} items-center`}>
            {isInBacklog && (
              <button
                onClick={() => skipDeleteConfirm ? handleDelete() : setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-faint hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
              >
                <Trash2 size={14} />
                Delete
              </button>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="px-3 py-1.5 text-xs bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        ) : undefined}
      >
        {/* Description edit mode with drag/drop support */}
        {isEditing && (
          <div
            className="px-4 py-3 border-b border-edge flex-shrink-0 relative space-y-2"
            onDragOver={handleAttachmentDragOver}
            onDragLeave={handleAttachmentDragLeave}
            onDrop={handleAttachmentDrop}
          >
            <div className="relative">
              {hasSessionContext ? (
                /* Compact textarea for tasks with an active/suspended session */
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onPaste={handleAttachmentPaste}
                  rows={3}
                  className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent resize-y min-h-[80px] max-h-[300px]"
                />
              ) : (
                /* Premium textarea for no-session tasks — matches NewTaskDialog */
                <textarea
                  ref={textareaRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onPaste={handleAttachmentPaste}
                  onFocus={() => setTextareaFocused(true)}
                  onBlur={() => setTextareaFocused(false)}
                  className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent min-h-[200px] max-h-[800px] resize-y overflow-y-auto"
                />
              )}
              {!description && (
                hasSessionContext ? (
                  <div className="absolute inset-0 flex flex-col pointer-events-none px-3 py-2">
                    <span className="text-sm text-fg-faint">Description</span>
                    <div className="flex-1 flex items-center justify-center">
                      <div className="flex flex-col items-center gap-1.5 border border-dashed border-edge rounded-lg px-5 py-3">
                        <Image size={18} className="text-fg-disabled" />
                        <span className="text-xs text-fg-disabled">Paste or drop images here</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className={`absolute inset-0 flex flex-col pointer-events-none px-3 py-2 transition-opacity duration-200 ${textareaFocused ? 'opacity-100' : 'opacity-40'}`}>
                    <span className="text-sm text-fg-faint">Describe the task for the agent...</span>
                    <div className="flex-1 flex items-center justify-center">
                      <div className="flex flex-col items-center gap-1.5 border border-dashed border-edge rounded-lg px-6 py-4">
                        <Image size={20} className="text-fg-disabled" />
                        <span className="text-xs text-fg-disabled">Paste or drop images here</span>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
            {thumbnailStrip}

            {/* Base branch picker + worktree toggle (no-session edit only) */}
            {!hasSessionContext && (
              <div className="flex items-center gap-2">
                <BranchPicker value={baseBranch} defaultBranch={defaultBaseBranch || 'main'} onChange={setBaseBranch} />
                {!task.worktree_path && (
                  <>
                    <div className="w-px h-5 bg-edge-input" />
                    <WorktreeChip enabled={effectiveWorktree} onToggle={() => setUseWorktree(effectiveWorktree ? false : true)} />
                  </>
                )}
              </div>
            )}

            {isDragOver && (
              <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
                <span className="text-sm text-accent-fg font-medium">Drop images here</span>
              </div>
            )}
          </div>
        )}

        {/* Description view mode with attachment thumbnails */}
        {!isEditing && (task.description || savedAttachments.length > 0) && !hasSessionContext && (
          <div className="px-4 py-3 border-b border-edge flex-shrink-0 space-y-2">
            {task.description && (
              <p className="text-sm text-fg-muted whitespace-pre-wrap">{task.description}</p>
            )}
            {thumbnailStrip}
          </div>
        )}

        {/* Worktree / PR info */}
        {!isEditing && (task.worktree_path || task.pr_url) && (
          <div className="px-4 py-2 border-b border-edge flex-shrink-0 flex items-center gap-4 text-xs">
            {task.branch_name && (
              <span className="text-fg-muted flex items-center gap-1.5">
                Branch:
                {task.worktree_path ? (
                  <button
                    onClick={() => window.electronAPI.shell.openPath(task.worktree_path!)}
                    className="inline-flex items-center gap-1.5 text-fg-secondary hover:text-accent-fg transition-colors"
                    title="Open worktree directory"
                  >
                    {task.branch_name}
                    <ExternalLink size={12} />
                  </button>
                ) : (
                  <span className="text-fg-secondary">{task.branch_name}</span>
                )}
              </span>
            )}
            {task.pr_url && (
              <span className="text-fg-muted">PR: <span className="text-accent-fg">#{task.pr_number}</span></span>
            )}
          </div>
        )}

        {/* Terminal, queued placeholder, suspended placeholder, or empty state */}
        {session && displayState.kind !== 'queued' ? (
          <>
            <div className="flex-1 min-h-0 relative">
              <div className="absolute inset-0">
                <TerminalTab
                  key={session.id}
                  sessionId={session.id}
                  active={true}
                />
              </div>
            </div>
            <ContextBar sessionId={session.id} />
          </>
        ) : displayState.kind === 'queued' ? (
          <QueuedPlaceholder sessionId={task.session_id} />
        ) : isSuspended || toggling ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-surface/50">
            <button
              onClick={handleToggle}
              disabled={toggling}
              className="flex items-center gap-2.5 px-6 py-3 rounded-lg bg-accent/20 border border-accent/40 text-base text-accent-fg hover:bg-accent/30 transition-colors disabled:opacity-50"
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
          !isEditing && !task.description && savedAttachments.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-fg-disabled text-sm p-8">
              No active session. Drag this task to a column with a transition to start one.
            </div>
          )
        )}
      </BaseDialog>

      {/* Full-size preview overlay */}
      {previewAttachment && (
        <div
          className="fixed inset-0 bg-black/80 flex flex-col items-center justify-center z-[60]"
          onClick={() => setPreviewAttachment(null)}
        >
          <button
            className="absolute top-4 right-4 p-2 text-fg-muted hover:text-fg-secondary transition-colors"
            onClick={() => setPreviewAttachment(null)}
          >
            <X size={24} />
          </button>
          <img
            src={previewAttachment.url}
            alt={previewAttachment.filename}
            className="max-w-[90vw] max-h-[85vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="mt-2 text-sm text-fg-muted">{previewAttachment.filename}</p>
        </div>
      )}
    </>
  );
}
