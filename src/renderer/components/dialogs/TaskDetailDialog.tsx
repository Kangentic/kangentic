import { useState, useLayoutEffect, useRef, useEffect, useMemo, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { useSessionDisplayState } from '../../utils/session-display-state';
import { resolveShortcutCommand } from '../../../shared/template-vars';
import { PriorityBadge } from '../backlog/PriorityBadge';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import {
  TaskDetailHeader,
  TaskDetailEditForm,
  TaskDetailBody,
  ImagePreviewOverlay,
  useAttachments,
  useBranchConfig,
  useCopyDisplayId,
} from './task-detail';
import type { Task, ClaudeCommand, ShortcutConfig } from '../../../shared/types';

interface TaskDetailDialogProps {
  task: Task;
  onClose: () => void;
  initialEdit?: boolean;
}

export function TaskDetailDialog({ task, onClose, initialEdit }: TaskDetailDialogProps) {
  const updateTask = useBoardStore((s) => s.updateTask);
  const deleteTask = useBoardStore((s) => s.deleteTask);
  const moveTask = useBoardStore((s) => s.moveTask);
  const unarchiveTask = useBoardStore((s) => s.unarchiveTask);
  const updateAttachmentCount = useBoardStore((s) => s.updateAttachmentCount);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const shortcuts = useBoardStore((s) => s.shortcuts);
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const killSession = useSessionStore((s) => s.killSession);
  const suspendSession = useSessionStore((s) => s.suspendSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const setDialogSessionId = useSessionStore((s) => s.setDialogSessionId);
  const pendingCommandLabel = useSessionStore((s) => s.pendingCommandLabel[task.id] ?? null);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const archiveTask = useBoardStore((s) => s.archiveTask);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [prUrl, setPrUrl] = useState(task.pr_url ?? '');
  const [isEditing, setIsEditing] = useState(!!initialEdit);
  const [toggling, setToggling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEnableWorktreeConfirm, setShowEnableWorktreeConfirm] = useState(false);
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null);

  const isArchived = task.archived_at !== null;
  const currentSwimlane = swimlanes.find((s) => s.id === task.swimlane_id);
  const isInTodo = currentSwimlane?.role === 'todo';

  // Hooks
  const attachments = useAttachments(task.id, updateAttachmentCount);
  const branchConfig = useBranchConfig(task, title, isInTodo);

  // Session state
  const session = useSessionStore((s) =>
    s.sessions.find((session) => session.taskId === task.id) ?? null
  );
  const displayState = useSessionDisplayState(session?.id);
  const canToggle = !isInTodo && (displayState.kind === 'running' || displayState.kind === 'queued'
    || displayState.kind === 'initializing' || displayState.kind === 'suspended');
  const isSessionActive = displayState.kind === 'running' || displayState.kind === 'queued'
    || displayState.kind === 'initializing';
  const isQueued = displayState.kind === 'queued';
  const isSuspended = displayState.kind === 'suspended';

  // Use large dialog when there's an active session OR a suspended one (but not for archived tasks)
  const hasSessionContext = !isArchived && ((displayState.kind !== 'none' && displayState.kind !== 'exited') || toggling);
  const dialogSizeClass = isEditing || !hasSessionContext
    ? (isQueued ? 'w-[520px] h-[320px]' : 'w-[700px]')
    : 'w-[90vw] h-[85vh]';

  const { copied: displayIdCopied, copy: copyDisplayId } = useCopyDisplayId(task.display_id);

  // Track whether mouse is inside the dialog content (for Escape key behavior)
  const mouseInsideDialog = useRef(false);

  // Columns available as move targets: exclude current column and Done column (for archived tasks)
  const moveTargets = useMemo(() =>
    swimlanes.filter((s) => {
      if (s.id === task.swimlane_id) return false;
      if (isArchived && s.role === 'done') return false;
      return true;
    }),
    [swimlanes, task.swimlane_id, isArchived],
  );

  const headerShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'header' || action.display === 'both')),
    [shortcuts],
  );

  const menuShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'menu' || action.display === 'both')),
    [shortcuts],
  );

  const executeShortcut = useCallback((action: ShortcutConfig) => {
    const cwd = task.worktree_path ?? projectPath ?? '';
    const resolved = resolveShortcutCommand(action.command, {
      cwd,
      branchName: task.branch_name ?? '',
      taskTitle: task.title,
      projectPath: projectPath ?? '',
    });
    window.electronAPI.shell.exec(resolved, cwd);
  }, [task, projectPath]);

  // Register this session with the store so the bottom panel unmounts its
  // TerminalTab BEFORE any terminal effects fire. useLayoutEffect runs
  // synchronously after DOM mutations but before paint.
  useLayoutEffect(() => {
    if (session?.id) {
      if (useSessionStore.getState().dialogSessionId !== session.id) {
        setDialogSessionId(session.id);
      }
      return () => setDialogSessionId(null);
    }
  }, [session?.id, setDialogSessionId]);

  // Auto-save and exit edit mode when a session appears
  const hadSessionContext = useRef(hasSessionContext);
  const editingRef = useRef(isEditing);
  const titleRef = useRef(title);
  const descriptionRef = useRef(description);
  editingRef.current = isEditing;
  titleRef.current = title;
  descriptionRef.current = description;
  useEffect(() => {
    if (!hadSessionContext.current && hasSessionContext && editingRef.current) {
      updateTask({ id: task.id, title: titleRef.current, description: descriptionRef.current });
      setIsEditing(false);
    }
    hadSessionContext.current = hasSessionContext;
  }, [hasSessionContext, task.id, updateTask]);

  // Capture-phase Escape listener: close dialog when mouse is outside content
  useEffect(() => {
    if (!hasSessionContext || isEditing) return;
    const handleEscapeCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mouseInsideDialog.current && !attachments.previewOpenRef.current) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscapeCapture, true);
    return () => document.removeEventListener('keydown', handleEscapeCapture, true);
  }, [hasSessionContext, isEditing, onClose, attachments.previewOpenRef]);

  // Refit terminal when session resumes
  useEffect(() => {
    if (session?.status === 'running') {
      const id = setTimeout(() => {
        window.dispatchEvent(new Event('terminal-panel-resize'));
      }, 300);
      return () => clearTimeout(id);
    }
  }, [session?.status]);

  // Refit terminal when edit mode toggles
  useEffect(() => {
    if (!session) return;
    const id = setTimeout(() => {
      window.dispatchEvent(new Event('terminal-panel-resize'));
    }, 100);
    return () => clearTimeout(id);
  }, [isEditing, session?.id]);

  // -- Action handlers --

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

  const handleCommandSelect = async (command: ClaudeCommand) => {
    if (!task.id || toggling) return;
    setToggling(true);
    try {
      useSessionStore.getState().setPendingCommandLabel(task.id, command.displayName);
      await suspendSession(task.id);
      await resumeSession(task.id, command.displayName);
      await loadBoard();
    } catch (error) {
      console.error('Command invocation failed:', error);
      useSessionStore.getState().clearPendingCommandLabel(task.id);
      useToastStore.getState().addToast({
        message: `Failed to invoke ${command.displayName}`,
        variant: 'warning',
      });
      await loadBoard().catch(() => {});
    } finally {
      setToggling(false);
    }
  };

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

  const handleCancel = () => {
    if (initialEdit && !session) {
      onClose();
      return;
    }
    setTitle(task.title);
    setDescription(task.description);
    setPrUrl(task.pr_url ?? '');
    branchConfig.resetToTask();
    setIsEditing(false);
  };

  const handleSave = async () => {
    const trimmedBranch = branchConfig.baseBranch.trim();
    const originalBranch = task.base_branch || '';
    const branchChanged = trimmedBranch !== originalBranch;
    const originalWorktree = task.use_worktree != null ? Boolean(task.use_worktree) : null;
    const worktreeChanged = branchConfig.useWorktree !== originalWorktree;
    const enablingWorktree = !task.worktree_path && branchConfig.useWorktree === true && (originalWorktree !== true);

    if (enablingWorktree && hasSessionContext) {
      pendingSaveRef.current = async () => {
        await executeSave(branchChanged, worktreeChanged, enablingWorktree, trimmedBranch);
      };
      setShowEnableWorktreeConfirm(true);
      return;
    }

    await executeSave(branchChanged, worktreeChanged, enablingWorktree, trimmedBranch);
  };

  /** Build pr_url/pr_number fields if the PR URL changed. */
  const buildPrUrlFields = (): Pick<Parameters<typeof updateTask>[0], 'pr_url' | 'pr_number'> => {
    const trimmedPrUrl = prUrl.trim();
    if (trimmedPrUrl === (task.pr_url ?? '')) return {};
    if (trimmedPrUrl) {
      const prNumberMatch = trimmedPrUrl.match(/\/pull\/(\d+)/);
      return { pr_url: trimmedPrUrl, pr_number: prNumberMatch ? parseInt(prNumberMatch[1], 10) : null };
    }
    return { pr_url: null, pr_number: null };
  };

  const executeSave = async (
    branchChanged: boolean,
    worktreeChanged: boolean,
    enablingWorktree: boolean,
    trimmedBranch: string,
  ) => {
    const needsSwitchBranch = (task.worktree_path && branchChanged) || enablingWorktree;
    const prUrlFields = buildPrUrlFields();

    if (needsSwitchBranch) {
      try {
        await window.electronAPI.tasks.switchBranch({
          taskId: task.id,
          newBaseBranch: trimmedBranch,
          enableWorktree: enablingWorktree || undefined,
        });
        if (title !== task.title || description !== task.description || prUrlFields.pr_url !== undefined) {
          await updateTask({ id: task.id, title, description, ...prUrlFields });
        }
        await useBoardStore.getState().loadBoard();
      } catch (error) {
        console.error('switchBranch failed:', error);
        useToastStore.getState().addToast({
          message: `Failed to switch branch: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'warning',
        });
        return;
      }
    } else {
      const payload: Parameters<typeof updateTask>[0] = { id: task.id, title, description, ...prUrlFields };

      if (!isSessionActive && !isArchived) {
        if (branchChanged) {
          payload.base_branch = trimmedBranch || null;
        }
        if (worktreeChanged) {
          payload.use_worktree = branchConfig.useWorktree != null ? (branchConfig.useWorktree ? 1 : 0) : null;
        }
        if (isInTodo) {
          const trimmedCustomBranch = branchConfig.customBranchName.trim();
          payload.branch_name = trimmedCustomBranch || null;
        }
      }
      await updateTask(payload);
    }

    if (!session) {
      onClose();
    } else {
      setIsEditing(false);
    }
  };

  const [confirmSendToBacklog, setConfirmSendToBacklog] = useState(false);

  const executeSendToBacklog = async () => {
    setConfirmSendToBacklog(false);
    const taskTitle = task.title;
    onClose();
    await useBacklogStore.getState().demoteTask({ taskId: task.id });
    useToastStore.getState().addToast({
      message: `Sent "${taskTitle}" to backlog`,
      variant: 'info',
    });
  };

  const handleSendToBacklog = () => {
    const hasResources = !!task.session_id || !!task.worktree_path;
    if (!hasResources || skipDeleteConfirm) {
      executeSendToBacklog();
    } else {
      setConfirmSendToBacklog(true);
    }
  };

  const handleArchive = async () => {
    const doneLane = swimlanes.find((s) => s.role === 'done');
    if (!doneLane) return;
    const taskTitle = task.title;
    const taskId = task.id;
    flushSync(() => {
      onClose();
    });
    archiveTask(taskId);
    const laneTasks = useBoardStore.getState().tasks.filter(
      (t) => t.swimlane_id === doneLane.id,
    );
    await window.electronAPI.tasks.move({ taskId, targetSwimlaneId: doneLane.id, targetPosition: laneTasks.length });
    useToastStore.getState().addToast({
      message: `Archived "${taskTitle}"`,
      variant: 'info',
    });
  };

  const handleDelete = async (dontAskAgain: boolean) => {
    if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    const taskTitle = task.title;
    onClose();
    if (session) {
      await killSession(session.id);
    }
    await deleteTask(task.id);
    useToastStore.getState().addToast({
      message: `Deleted task "${taskTitle}"`,
      variant: 'info',
    });
  };

  // -- Render --

  if (confirmSendToBacklog) {
    return (
      <ConfirmDialog
        title="Send to Backlog"
        message={<>
          <p>This will move &quot;{task.title}&quot; to the backlog and clean up its session and worktree.</p>
          <p className="text-fg-muted mt-1">You can move it back to the board later.</p>
        </>}
        confirmLabel="Send to Backlog"
        showDontAskAgain
        onConfirm={(dontAskAgain) => {
          if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
          executeSendToBacklog();
        }}
        onCancel={() => setConfirmSendToBacklog(false)}
      />
    );
  }

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
        showDontAskAgain
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    );
  }

  const customHeader = (
    <TaskDetailHeader
      task={task}
      onClose={onClose}
      isEditing={isEditing}
      setIsEditing={setIsEditing}
      canToggle={canToggle}
      isSessionActive={isSessionActive}
      isQueued={isQueued}
      isArchived={isArchived}
      toggling={toggling}
      onToggle={handleToggle}
      onCommandSelect={handleCommandSelect}
      onArchive={handleArchive}
      onSendToBacklog={handleSendToBacklog}
      onDelete={() => skipDeleteConfirm ? handleDelete(false) : setConfirmDelete(true)}
      onMoveTo={handleMoveTo}
      moveTargets={moveTargets}
      headerShortcuts={headerShortcuts}
      menuShortcuts={menuShortcuts}
      executeShortcut={executeShortcut}
      projectPath={projectPath}
    />
  );

  return (
    <>
      <BaseDialog
        onClose={onClose}
        {...(isEditing
          ? {
            title: (
              <span className="flex items-center gap-2">
                Edit Task
                <button
                  type="button"
                  className="flex items-center gap-1 text-sm font-mono text-fg-muted hover:text-fg-secondary transition-colors font-normal"
                  title={`Click to copy: ${task.display_id}`}
                  data-testid="task-display-id"
                  onClick={copyDisplayId}
                >
                  {displayIdCopied
                    ? <Check size={12} className="text-green-400" />
                    : <Copy size={12} className="text-fg-disabled" />
                  }
                  #{task.display_id}
                </button>
                <PriorityBadge priority={task.priority ?? 0} />
              </span>
            ),
            icon: <Pencil size={14} className="text-fg-muted" />,
          }
          : { header: customHeader, rawBody: true }
        )}
        onContentMouseEnter={() => { mouseInsideDialog.current = true; }}
        onContentMouseLeave={() => { mouseInsideDialog.current = false; }}
        className={dialogSizeClass}
        backdropClassName="p-6"
        testId="task-detail-dialog"
        footer={isEditing ? (
          <div className={`flex ${isInTodo ? 'justify-between' : 'justify-end'} items-center`}>
            {isInTodo && (
              <button
                onClick={() => skipDeleteConfirm ? handleDelete(false) : setConfirmDelete(true)}
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
                disabled={!!branchConfig.branchNameError}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  branchConfig.branchNameError
                    ? 'bg-accent-emphasis/50 text-accent-on/50 cursor-not-allowed'
                    : 'bg-accent-emphasis hover:bg-accent text-accent-on'
                }`}
              >
                Save
              </button>
            </div>
          </div>
        ) : undefined}
      >
        {isEditing && (
          <TaskDetailEditForm
            task={task}
            title={title}
            setTitle={setTitle}
            description={description}
            setDescription={setDescription}
            prUrl={prUrl}
            setPrUrl={setPrUrl}
            attachments={attachments}
            branchConfig={branchConfig}
            isSessionActive={isSessionActive}
            isArchived={isArchived}
            isInTodo={isInTodo}
          />
        )}

        {!isEditing && (
          <TaskDetailBody
            task={task}
            isArchived={isArchived}
            isInTodo={isInTodo}
            hasSessionContext={hasSessionContext}
            sessionId={session?.id ?? null}
            displayKind={displayState.kind}
            isSuspended={isSuspended}
            toggling={toggling}
            pendingCommandLabel={pendingCommandLabel}
            savedAttachments={attachments.savedAttachments}
            handlePreview={attachments.handlePreview}
            handleOpenExternal={attachments.handleOpenExternal}
            removeAttachment={attachments.removeAttachment}
            handleToggle={handleToggle}
          />
        )}
      </BaseDialog>

      {/* Enable worktree confirmation */}
      {showEnableWorktreeConfirm && (
        <ConfirmDialog
          title="Enable worktree?"
          message="This will create an isolated worktree for this task. Your session history will be preserved and the agent will continue from where it left off in the new worktree."
          confirmLabel="Enable"
          variant="default"
          onConfirm={async () => {
            setShowEnableWorktreeConfirm(false);
            if (pendingSaveRef.current) {
              await pendingSaveRef.current();
              pendingSaveRef.current = null;
            }
          }}
          onCancel={() => {
            setShowEnableWorktreeConfirm(false);
            pendingSaveRef.current = null;
          }}
        />
      )}

      {/* Full-size preview overlay */}
      {attachments.previewAttachment && (
        <ImagePreviewOverlay
          url={attachments.previewAttachment.url}
          filename={attachments.previewAttachment.filename}
          onClose={attachments.closePreview}
        />
      )}
    </>
  );
}
