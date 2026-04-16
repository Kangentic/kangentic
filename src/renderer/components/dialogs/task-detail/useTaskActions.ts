import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import { useBoardStore } from '../../../stores/board-store';
import { useBacklogStore } from '../../../stores/backlog-store';
import { useSessionStore } from '../../../stores/session-store';
import { useToastStore } from '../../../stores/toast-store';
import type { Task, Session, AgentCommand, Swimlane } from '../../../../shared/types';
import type { useBranchConfig } from './useBranchConfig';
import type { useTaskProgress } from '../../../utils/task-progress';

/**
 * Orchestration hook for TaskDetailDialog. Owns:
 *
 *   - Action handlers: toggle/suspend/resume, command injection, move
 *     to column, save, cancel, send to backlog, archive, delete.
 *   - Transient UI state: pendingAction (pausing/resuming), resume
 *     failure + message, three confirmation flags, the worktree-
 *     enablement pending save ref.
 *   - The pendingAction auto-clear effect that watches for the session
 *     store to reach the target state (with a 5s safety timeout).
 *
 * Returns everything the dialog needs to wire into the header, body,
 * footer, and the three confirmation dialogs.
 *
 * This hook keeps the dialog component focused on layout + JSX.
 * Everything here is pure imperative logic that would otherwise bloat
 * the render function.
 */
export function useTaskActions(input: {
  task: Task;
  onClose: () => void;
  initialEdit: boolean | undefined;

  // Form state (read + some writers for cancel to reset)
  title: string;
  description: string;
  prUrl: string;
  labels: string[];
  priority: number;
  setTitle: Dispatch<SetStateAction<string>>;
  setDescription: Dispatch<SetStateAction<string>>;
  setPrUrl: Dispatch<SetStateAction<string>>;
  setLabels: Dispatch<SetStateAction<string[]>>;
  setPriority: Dispatch<SetStateAction<number>>;
  setIsEditing: Dispatch<SetStateAction<boolean>>;

  // Branch config hook
  branchConfig: ReturnType<typeof useBranchConfig>;

  // Session state
  session: Session | null;
  isSessionActive: boolean;
  hasSessionContext: boolean;
  isSuspended: boolean;
  canToggle: boolean;
  displayState: ReturnType<typeof useTaskProgress>;

  // Column context
  isArchived: boolean;
  isInTodo: boolean;
  swimlanes: Swimlane[];

  // Store bindings (passed in so the hook doesn't re-subscribe redundantly)
  updateTask: ReturnType<typeof useBoardStore.getState>['updateTask'];
  deleteTask: ReturnType<typeof useBoardStore.getState>['deleteTask'];
  moveTask: ReturnType<typeof useBoardStore.getState>['moveTask'];
  unarchiveTask: ReturnType<typeof useBoardStore.getState>['unarchiveTask'];
  archiveTask: ReturnType<typeof useBoardStore.getState>['archiveTask'];
  loadBoard: ReturnType<typeof useBoardStore.getState>['loadBoard'];
  killSession: ReturnType<typeof useSessionStore.getState>['killSession'];
  suspendSession: ReturnType<typeof useSessionStore.getState>['suspendSession'];
  resumeSession: ReturnType<typeof useSessionStore.getState>['resumeSession'];
  skipDeleteConfirm: boolean;
  updateConfig: (partial: { skipDeleteConfirm?: boolean }) => void;
}) {
  const [pendingAction, setPendingAction] = useState<null | 'pausing' | 'resuming'>(null);
  const toggling = pendingAction !== null;
  const [resumeFailed, setResumeFailed] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSendToBacklog, setConfirmSendToBacklog] = useState(false);
  const [showEnableWorktreeConfirm, setShowEnableWorktreeConfirm] = useState(false);
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null);

  const handleToggle = async () => {
    if (!input.canToggle || toggling) return;
    const action: 'pausing' | 'resuming' = input.isSessionActive ? 'pausing' : 'resuming';
    setPendingAction(action);
    try {
      if (action === 'pausing') {
        await input.suspendSession(input.task.id);
      } else {
        await input.resumeSession(input.task.id);
        setResumeFailed(false);
        setResumeError('');
      }
      await input.loadBoard();
      // pendingAction is cleared by the effect below once the session store
      // actually reflects the target state.
    } catch (err) {
      console.error('Toggle session failed:', err);
      const reason = err instanceof Error ? err.message : '';
      if (action === 'resuming') {
        setResumeFailed(true);
        setResumeError(reason);
      }
      useToastStore.getState().addToast({
        message: reason
          ? `Failed to ${action === 'pausing' ? 'suspend' : 'resume'} session: ${reason}`
          : `Failed to ${action === 'pausing' ? 'suspend' : 'resume'} session`,
        variant: 'warning',
      });
      setPendingAction(null);
    }
  };

  // Clear pendingAction once the session store reflects the target state.
  // Includes a 5s safety timeout in case the transition never arrives.
  useEffect(() => {
    if (!pendingAction) return;
    const reached = pendingAction === 'pausing'
      ? (input.isSuspended || input.displayState.kind === 'none' || input.displayState.kind === 'exited')
      : input.isSessionActive;
    if (reached) {
      setPendingAction(null);
      return;
    }
    const timer = setTimeout(() => setPendingAction(null), 5000);
    return () => clearTimeout(timer);
  }, [pendingAction, input.isSuspended, input.isSessionActive, input.displayState.kind]);

  const handleResetSession = async () => {
    try {
      await useSessionStore.getState().resetSession(input.task.id);
      setResumeFailed(false);
      setResumeError('');
      await input.loadBoard();
    } catch (err) {
      console.error('Reset session failed:', err);
      useToastStore.getState().addToast({
        message: 'Failed to reset session',
        variant: 'warning',
      });
    }
  };

  const handleCommandSelect = async (command: AgentCommand) => {
    if (!input.task.id || toggling) return;
    setPendingAction('resuming');
    try {
      useSessionStore.getState().setPendingCommandLabel(input.task.id, command.displayName);
      await input.suspendSession(input.task.id);
      await input.resumeSession(input.task.id, command.displayName);
      await input.loadBoard();
    } catch (error) {
      console.error('Command invocation failed:', error);
      useSessionStore.getState().clearPendingCommandLabel(input.task.id);
      useToastStore.getState().addToast({
        message: `Failed to invoke ${command.displayName}`,
        variant: 'warning',
      });
      await input.loadBoard().catch(() => {});
      setPendingAction(null);
    }
  };

  const handleMoveTo = async (targetSwimlaneId: string) => {
    const targetName = input.swimlanes.find((candidate) => candidate.id === targetSwimlaneId)?.name ?? 'column';
    if (input.isArchived) {
      input.onClose();
      await input.unarchiveTask({ id: input.task.id, targetSwimlaneId });
    } else {
      const laneTasks = useBoardStore.getState().tasks.filter(
        (candidate) => candidate.swimlane_id === targetSwimlaneId,
      );
      await input.moveTask({ taskId: input.task.id, targetSwimlaneId, targetPosition: laneTasks.length });
      // If a confirmation dialog was triggered, moveTask returns early without
      // moving. Don't close the detail dialog or show a toast in that case.
      if (useBoardStore.getState().pendingMoveConfirm) return;
      input.onClose();
    }
    useToastStore.getState().addToast({
      message: `Moved "${input.task.title}" to ${targetName}`,
      variant: 'success',
    });
  };

  const handleCancel = () => {
    if (input.initialEdit && !input.session) {
      input.onClose();
      return;
    }
    input.setTitle(input.task.title);
    input.setDescription(input.task.description);
    input.setPrUrl(input.task.pr_url ?? '');
    input.setLabels(input.task.labels ?? []);
    input.setPriority(input.task.priority ?? 0);
    input.branchConfig.resetToTask();
    input.setIsEditing(false);
  };

  /** Build pr_url/pr_number fields if the PR URL changed. */
  const buildPrUrlFields = (): Pick<Parameters<typeof input.updateTask>[0], 'pr_url' | 'pr_number'> => {
    const trimmedPrUrl = input.prUrl.trim();
    if (trimmedPrUrl === (input.task.pr_url ?? '')) return {};
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
    const needsSwitchBranch = (input.task.worktree_path && branchChanged) || enablingWorktree;
    const prUrlFields = buildPrUrlFields();

    if (needsSwitchBranch) {
      try {
        await window.electronAPI.tasks.switchBranch({
          taskId: input.task.id,
          newBaseBranch: trimmedBranch,
          enableWorktree: enablingWorktree || undefined,
        });
        if (input.title !== input.task.title
          || input.description !== input.task.description
          || prUrlFields.pr_url !== undefined
          || JSON.stringify(input.labels) !== JSON.stringify(input.task.labels ?? [])
          || input.priority !== (input.task.priority ?? 0)) {
          await input.updateTask({
            id: input.task.id,
            title: input.title,
            description: input.description,
            labels: input.labels,
            priority: input.priority,
            ...prUrlFields,
          });
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
      const payload: Parameters<typeof input.updateTask>[0] = {
        id: input.task.id,
        title: input.title,
        description: input.description,
        labels: input.labels,
        priority: input.priority,
        ...prUrlFields,
      };

      if (!input.isSessionActive && !input.isArchived) {
        if (branchChanged) {
          payload.base_branch = trimmedBranch || null;
        }
        if (worktreeChanged) {
          payload.use_worktree = input.branchConfig.useWorktree != null
            ? (input.branchConfig.useWorktree ? 1 : 0)
            : null;
        }
        if (input.isInTodo) {
          const trimmedCustomBranch = input.branchConfig.customBranchName.trim();
          payload.branch_name = trimmedCustomBranch || null;
        }
      }
      await input.updateTask(payload);
    }

    if (!input.session) {
      input.onClose();
    } else {
      input.setIsEditing(false);
    }
  };

  const handleSave = async () => {
    const trimmedBranch = input.branchConfig.baseBranch.trim();
    const originalBranch = input.task.base_branch || '';
    const branchChanged = trimmedBranch !== originalBranch;
    const originalWorktree = input.task.use_worktree != null ? Boolean(input.task.use_worktree) : null;
    const worktreeChanged = input.branchConfig.useWorktree !== originalWorktree;
    const enablingWorktree = !input.task.worktree_path
      && input.branchConfig.useWorktree === true
      && (originalWorktree !== true);

    if (enablingWorktree && input.hasSessionContext) {
      pendingSaveRef.current = async () => {
        await executeSave(branchChanged, worktreeChanged, enablingWorktree, trimmedBranch);
      };
      setShowEnableWorktreeConfirm(true);
      return;
    }

    await executeSave(branchChanged, worktreeChanged, enablingWorktree, trimmedBranch);
  };

  const executeSendToBacklog = async () => {
    setConfirmSendToBacklog(false);
    const taskTitle = input.task.title;
    input.onClose();
    await useBacklogStore.getState().demoteTask({ taskId: input.task.id });
    useToastStore.getState().addToast({
      message: `Sent "${taskTitle}" to backlog`,
      variant: 'info',
    });
  };

  const handleSendToBacklog = () => {
    const hasResources = !!input.task.session_id || !!input.task.worktree_path;
    if (!hasResources || input.skipDeleteConfirm) {
      executeSendToBacklog();
    } else {
      setConfirmSendToBacklog(true);
    }
  };

  const handleArchive = async () => {
    const doneLane = input.swimlanes.find((candidate) => candidate.role === 'done');
    if (!doneLane) return;
    const taskTitle = input.task.title;
    const taskId = input.task.id;
    flushSync(() => {
      input.onClose();
    });
    input.archiveTask(taskId);
    const laneTasks = useBoardStore.getState().tasks.filter(
      (candidate) => candidate.swimlane_id === doneLane.id,
    );
    await window.electronAPI.tasks.move({ taskId, targetSwimlaneId: doneLane.id, targetPosition: laneTasks.length });
    useToastStore.getState().addToast({
      message: `Archived "${taskTitle}"`,
      variant: 'info',
    });
  };

  const handleDelete = async (dontAskAgain: boolean) => {
    if (dontAskAgain) input.updateConfig({ skipDeleteConfirm: true });
    const taskTitle = input.task.title;
    input.onClose();
    if (input.session) {
      await input.killSession(input.session.id);
    }
    await input.deleteTask(input.task.id);
    useToastStore.getState().addToast({
      message: `Deleted task "${taskTitle}"`,
      variant: 'info',
    });
  };

  return {
    // state
    pendingAction,
    toggling,
    resumeFailed,
    resumeError,
    confirmDelete,
    setConfirmDelete,
    confirmSendToBacklog,
    setConfirmSendToBacklog,
    showEnableWorktreeConfirm,
    setShowEnableWorktreeConfirm,
    pendingSaveRef,

    // handlers
    handleToggle,
    handleResetSession,
    handleCommandSelect,
    handleMoveTo,
    handleCancel,
    handleSave,
    handleSendToBacklog,
    handleArchive,
    handleDelete,
    executeSendToBacklog,
  };
}
