import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
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
  useTaskSessionState,
  useTaskActions,
} from './task-detail';
import type { Task, ShortcutConfig } from '../../../shared/types';

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
  const pendingCommandLabel = useSessionStore((s) => s.pendingCommandLabel[task.id] ?? null);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const archiveTask = useBoardStore((s) => s.archiveTask);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [prUrl, setPrUrl] = useState(task.pr_url ?? '');
  const [labels, setLabels] = useState<string[]>(task.labels ?? []);
  const [priority, setPriority] = useState(task.priority ?? 0);
  const [isEditing, setIsEditing] = useState(!!initialEdit);
  const changesOpen = useSessionStore((s) => s.changesOpenTasks.has(task.id));
  const toggleChangesOpen = useSessionStore((s) => s.toggleChangesOpen);

  const isArchived = task.archived_at !== null;
  const currentSwimlane = swimlanes.find((s) => s.id === task.swimlane_id);
  const isInTodo = currentSwimlane?.role === 'todo';

  const attachments = useAttachments(task.id, updateAttachmentCount);
  const branchConfig = useBranchConfig(task, title, isInTodo);

  // Session state + related side effects live in a dedicated hook.
  const sessionState = useTaskSessionState({
    task,
    isEditing,
    isArchived,
    isInTodo: isInTodo ?? false,
    currentSwimlaneRole: currentSwimlane?.role,
  });

  // Action handlers + their transient state (pendingAction, confirmations,
  // pendingSaveRef) are split into a hook to keep this file focused on
  // layout. The hook uses the session state we computed above, and the
  // dialog then ORs `toggling` with `hasSessionContext` below to keep
  // the large layout active during a suspend/resume transition.
  const actions = useTaskActions({
    task,
    onClose,
    initialEdit,
    title,
    description,
    prUrl,
    labels,
    priority,
    setTitle,
    setDescription,
    setPrUrl,
    setLabels,
    setPriority,
    setIsEditing,
    branchConfig,
    session: sessionState.session,
    isSessionActive: sessionState.isSessionActive,
    hasSessionContext: sessionState.hasSessionContext,
    isSuspended: sessionState.isSuspended,
    canToggle: sessionState.canToggle,
    displayState: sessionState.displayState,
    isArchived,
    isInTodo: isInTodo ?? false,
    swimlanes,
    updateTask,
    deleteTask,
    moveTask,
    unarchiveTask,
    archiveTask,
    loadBoard,
    killSession,
    suspendSession,
    resumeSession,
    skipDeleteConfirm,
    updateConfig,
  });

  // Keep the dialog in large mode during a pending suspend/resume
  // transition even if displayState briefly reports 'exited'.
  const hasSessionContext = sessionState.hasSessionContext || actions.toggling;

  // Dialog sizing depends on session/edit state.
  const needsLargeDialog = hasSessionContext || changesOpen;
  const dialogSizeClass = isEditing || !needsLargeDialog
    ? (sessionState.isQueued ? 'w-[520px] h-[320px]' : 'w-[700px]')
    : 'w-[90vw] h-[85vh]';

  const { copied: displayIdCopied, copy: copyDisplayId } = useCopyDisplayId(task.display_id);

  // Track whether mouse is inside the dialog content (for Escape key behavior)
  const mouseInsideDialog = useRef(false);

  // Columns available as move targets: exclude current column and Done column (for archived tasks)
  const moveTargets = useMemo(() =>
    swimlanes.filter((candidate) => {
      if (candidate.id === task.swimlane_id) return false;
      if (isArchived && candidate.role === 'done') return false;
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

  // Auto-save and exit edit mode when a session appears
  const hadSessionContext = useRef(hasSessionContext);
  const editingRef = useRef(isEditing);
  const titleRef = useRef(title);
  const descriptionRef = useRef(description);
  const labelsRef = useRef(labels);
  const priorityRef = useRef(priority);
  editingRef.current = isEditing;
  titleRef.current = title;
  descriptionRef.current = description;
  labelsRef.current = labels;
  priorityRef.current = priority;
  useEffect(() => {
    if (!hadSessionContext.current && hasSessionContext && editingRef.current) {
      updateTask({
        id: task.id,
        title: titleRef.current,
        description: descriptionRef.current,
        labels: labelsRef.current,
        priority: priorityRef.current,
      });
      setIsEditing(false);
    }
    hadSessionContext.current = hasSessionContext;
  }, [hasSessionContext, task.id, updateTask]);

  // Capture-phase Escape listener: close dialog when mouse is outside content
  useEffect(() => {
    if (!hasSessionContext || isEditing) return;
    const handleEscapeCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !mouseInsideDialog.current && !attachments.previewOpenRef.current) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscapeCapture, true);
    return () => document.removeEventListener('keydown', handleEscapeCapture, true);
  }, [hasSessionContext, isEditing, onClose, attachments.previewOpenRef]);

  // -- Render --

  if (actions.confirmSendToBacklog) {
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
          actions.executeSendToBacklog();
        }}
        onCancel={() => actions.setConfirmSendToBacklog(false)}
      />
    );
  }

  if (actions.confirmDelete) {
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
        onConfirm={actions.handleDelete}
        onCancel={() => actions.setConfirmDelete(false)}
      />
    );
  }

  const customHeader = (
    <TaskDetailHeader
      task={task}
      onClose={onClose}
      isEditing={isEditing}
      setIsEditing={setIsEditing}
      canToggle={sessionState.canToggle}
      isSessionActive={sessionState.isSessionActive}
      isQueued={sessionState.isQueued}
      isArchived={isArchived}
      toggling={actions.toggling}
      onToggle={actions.handleToggle}
      onCommandSelect={actions.handleCommandSelect}
      onArchive={actions.handleArchive}
      onSendToBacklog={actions.handleSendToBacklog}
      onDelete={() => skipDeleteConfirm ? actions.handleDelete(false) : actions.setConfirmDelete(true)}
      onMoveTo={actions.handleMoveTo}
      moveTargets={moveTargets}
      headerShortcuts={headerShortcuts}
      menuShortcuts={menuShortcuts}
      executeShortcut={executeShortcut}
      projectPath={projectPath}
      canShowChanges={sessionState.canShowChanges}
      changesOpen={changesOpen}
      onToggleChanges={() => toggleChangesOpen(task.id)}
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
                onClick={() => skipDeleteConfirm ? actions.handleDelete(false) : actions.setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-faint hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
              >
                <Trash2 size={14} />
                Delete
              </button>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={actions.handleCancel}
                className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={actions.handleSave}
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
            labels={labels}
            setLabels={setLabels}
            priority={priority}
            setPriority={setPriority}
            attachments={attachments}
            branchConfig={branchConfig}
            isSessionActive={sessionState.isSessionActive}
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
            sessionId={sessionState.session?.id ?? null}
            displayKind={sessionState.displayState.kind}
            isSuspended={sessionState.isSuspended}
            toggling={actions.toggling}
            pendingAction={actions.pendingAction}
            pendingCommandLabel={pendingCommandLabel}
            savedAttachments={attachments.savedAttachments}
            handlePreview={attachments.handlePreview}
            handleOpenExternal={attachments.handleOpenExternal}
            removeAttachment={attachments.removeAttachment}
            handleToggle={actions.handleToggle}
            changesOpen={changesOpen}
            projectPath={projectPath ?? ''}
            resumeFailed={actions.resumeFailed}
            resumeError={actions.resumeError}
            onResetSession={actions.handleResetSession}
          />
        )}
      </BaseDialog>

      {/* Enable worktree confirmation */}
      {actions.showEnableWorktreeConfirm && (
        <ConfirmDialog
          title="Enable worktree?"
          message="This will create an isolated worktree for this task. Your session history will be preserved and the agent will continue from where it left off in the new worktree."
          confirmLabel="Enable"
          variant="default"
          onConfirm={async () => {
            actions.setShowEnableWorktreeConfirm(false);
            if (actions.pendingSaveRef.current) {
              await actions.pendingSaveRef.current();
              actions.pendingSaveRef.current = null;
            }
          }}
          onCancel={() => {
            actions.setShowEnableWorktreeConfirm(false);
            actions.pendingSaveRef.current = null;
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
