import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import { useBacklogStore } from '../../../stores/backlog-store';
import { useSessionStore } from '../../../stores/session-store';
import { useToastStore } from '../../../stores/toast-store';
import { useTaskDetailHost } from './task-detail-host';
import type { Task, Session, AgentCommand, Swimlane, PermissionMode, TaskRunMode } from '../../../../shared/types';
import type { useBranchConfig } from './useBranchConfig';
import { hasSessionLifecycle } from '../../../utils/task-progress';
import type { useTaskProgress } from '../../../utils/task-progress';

/**
 * Orchestration hook for the task-detail surface (TaskDetailWindow). Owns:
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
  agentOverride: string;
  modelOverride: string;
  effortOverride: string;
  permissionOverride: string;
  /** Board Profile the task rides, or null for Default. */
  profileId: string | null;
  /** Which run-mode branch the edit form has selected (see `Task.run_mode`). */
  runMode: TaskRunMode;
  setTitle: Dispatch<SetStateAction<string>>;
  setDescription: Dispatch<SetStateAction<string>>;
  setPrUrl: Dispatch<SetStateAction<string>>;
  setLabels: Dispatch<SetStateAction<string[]>>;
  setPriority: Dispatch<SetStateAction<number>>;
  setAgentOverride: Dispatch<SetStateAction<string>>;
  setModelOverride: Dispatch<SetStateAction<string>>;
  setEffortOverride: Dispatch<SetStateAction<string>>;
  setPermissionOverride: Dispatch<SetStateAction<string>>;
  setProfileId: Dispatch<SetStateAction<string | null>>;
  setRunMode: Dispatch<SetStateAction<TaskRunMode>>;
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

  // Store bindings (passed in so the hook doesn't re-subscribe redundantly).
  // The task-scoped mutations are NOT here: they come from the host context, so
  // they resolve against the hosted task's project rather than the open board's.
  killSession: ReturnType<typeof useSessionStore.getState>['killSession'];
  suspendSession: ReturnType<typeof useSessionStore.getState>['suspendSession'];
  resumeSession: ReturnType<typeof useSessionStore.getState>['resumeSession'];
  skipDeleteConfirm: boolean;
  updateConfig: (partial: { skipDeleteConfirm?: boolean }) => void;
}) {
  // Every project-scoped read and write goes through the host, so this hook works
  // unchanged whether its task belongs to the open board or to another project.
  const host = useTaskDetailHost();
  const [pendingAction, setPendingAction] = useState<null | 'pausing' | 'resuming'>(null);
  const toggling = pendingAction !== null;
  const [saving, setSaving] = useState(false);
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
        // Pausing means "I am done with this task for now", so the window leaves
        // immediately instead of sitting on a Resume prompt. It deliberately does
        // NOT wait for the suspend to resolve: main tears the PTY down inside
        // that call (gracefulPtyShutdown gives the agent up to 1500ms to exit,
        // then force-kills and waits up to 1500ms more for propagation), and
        // there is nothing for the user to watch meanwhile. Nor is there much to
        // guard against - with a project open and the task on the board, suspend
        // has no realistic reject path, and a rejection is still surfaced by the
        // catch below. Starting the suspend BEFORE closing matters: the store's
        // optimistic write lands synchronously, so the bottom panel already reads
        // the session as suspended by the time the window goes.
        //
        // This hangs off the GESTURE, never the suspended state: a board move,
        // the Code Review column, and a restart with auto-resume off all reach
        // 'suspended' without ever entering this branch, and handleCommandSelect
        // suspends through the same store action without entering handleToggle at
        // all. `onClose` bypasses the unsaved-edit discard guard (`closeWithGuard`)
        // rather than being unwrapped - it is the window's `requestCloseFrozen`,
        // which snapshots the body's branch selector before starting the exit.
        // Skipping the discard guard is safe because the edit-mode title bar
        // carries no pause control, so this gesture cannot fire while editing.
        const suspending = input.suspendSession(input.task.id);
        input.onClose();
        await suspending;
      } else {
        // Snapshot the displayed session id BEFORE the call. If main returns
        // the same id we already had on display, the renderer's view was
        // stale (it thought 'suspended' but main had a live PTY all along) -
        // resume self-healed instead of spawning. Show an info toast so the
        // user understands no new agent was started.
        //
        // Note: priorSessionId is null only when displayState is 'preparing'
        // or 'none', neither of which can drift to a self-heal path - the
        // Resume button isn't shown for 'none', and 'preparing' implies main
        // is mid-spawn and reconcileTaskSessionRef finds no live session.
        // So a null priorSessionId always means a real spawn happened.
        const priorSessionId = input.session?.id ?? null;
        const returned = await input.resumeSession(input.task.id);
        setResumeFailed(false);
        setResumeError('');
        if (returned && returned.status === 'running' && priorSessionId === returned.id) {
          useToastStore.getState().addToast({
            message: 'Reconnected to running session',
            variant: 'info',
          });
        }
      }
      await host.refresh();
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
    // "No session lifecycle left" is the ended bucket of SESSION_LIFECYCLE_PHASE
    // ('none' / 'exited'), read through the compile-enforced table rather than
    // re-listed here, so a kind added later cannot leave a pause hanging on the
    // 5s timeout below.
    const reached = pendingAction === 'pausing'
      ? (input.isSuspended || !hasSessionLifecycle(input.displayState.kind))
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
      await host.refresh();
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
      await host.refresh();
    } catch (error) {
      console.error('Command invocation failed:', error);
      useSessionStore.getState().clearPendingCommandLabel(input.task.id);
      useToastStore.getState().addToast({
        message: `Failed to invoke ${command.displayName}`,
        variant: 'warning',
      });
      await host.refresh().catch(() => {});
      setPendingAction(null);
    }
  };

  const handleMoveTo = async (targetSwimlaneId: string) => {
    const targetName = input.swimlanes.find((candidate) => candidate.id === targetSwimlaneId)?.name ?? 'column';
    if (input.isArchived) {
      input.onClose();
      await host.unarchiveTask({ id: input.task.id, targetSwimlaneId });
    } else {
      const laneTasks = host.laneTasks(targetSwimlaneId);
      await host.moveTask({ taskId: input.task.id, targetSwimlaneId, targetPosition: laneTasks.length }, false);
      // If a confirmation dialog was triggered, moveTask returns early without
      // moving. Don't close the detail dialog or show a toast in that case.
      if (host.isMoveConfirmPending()) return;
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
    input.setAgentOverride(input.task.agent_override ?? '');
    input.setModelOverride(input.task.model_override ?? '');
    input.setEffortOverride(input.task.effort_override ?? '');
    input.setPermissionOverride(input.task.permission_mode ?? '');
    // The run-mode branch and the profile pick live in the same host state as
    // the four pins above and outlive the edit form's unmount, so cancel has to
    // revert them too - otherwise re-entering edit shows the branch (or the
    // profile) the user just abandoned.
    input.setProfileId(input.task.profile_id ?? null);
    input.setRunMode(input.task.run_mode);
    input.branchConfig.resetToTask();
    input.setIsEditing(false);
  };

  /**
   * Build the pr_url/pr_number/pr_state fields if the PR URL changed. All three
   * move together, exactly as the linker writes them: leaving a stale `pr_state`
   * behind produces the inconsistent row the linker forbids, and a terminal
   * `merged`/`closed` value short-circuits every non-force resolve, freezing the
   * task on a PR it no longer points at. The state is nulled on both branches
   * (cleared and re-pointed) and refilled by the next resolve.
   */
  const buildPrFields = (): Pick<Parameters<typeof host.updateTask>[0], 'pr_url' | 'pr_number' | 'pr_state'> => {
    const trimmedPrUrl = input.prUrl.trim();
    if (trimmedPrUrl === (input.task.pr_url ?? '')) return {};
    if (trimmedPrUrl) {
      const prNumberMatch = trimmedPrUrl.match(/\/pull\/(\d+)/);
      return {
        pr_url: trimmedPrUrl,
        pr_number: prNumberMatch ? parseInt(prNumberMatch[1], 10) : null,
        pr_state: null,
      };
    }
    return { pr_url: null, pr_number: null, pr_state: null };
  };

  const executeSave = async (
    branchChanged: boolean,
    worktreeChanged: boolean,
    enablingWorktree: boolean,
    trimmedBranch: string,
  ) => {
    // In-flight guard: a double-click or rapid keyboard activation must not fire
    // a second updateTask/switchBranch before the first resolves. The Save button
    // also disables on `saving`; this early return backstops any programmatic
    // re-entry (including the deferred pendingSaveRef path).
    if (saving) return;
    setSaving(true);
    try {
      const needsSwitchBranch = (input.task.worktree_path && branchChanged) || enablingWorktree;
      const prFields = buildPrFields();

      // Per-task overrides: empty string in the form maps to null in the DB.
      // Always include them in the payload (even when unchanged) so a user
      // clearing a previously-set override is persisted. Skipped when the
      // session is active because the user picks model/effort via the live
      // ContextBar popover in that flow; agent is never changed while running.
      const overrideFields = !input.isSessionActive && !input.isArchived
        ? {
          agent_override: input.agentOverride || null,
          model_override: input.modelOverride || null,
          effort_override: input.effortOverride || null,
          permission_mode: (input.permissionOverride || null) as PermissionMode | null,
          // Sent alongside the pins because they are mutually exclusive: the
          // repository clears whichever side this write did not set, so both
          // must travel together or one silently wins.
          profile_id: input.profileId ?? null,
          // Inside this object, not beside it: the whole block is skipped for an
          // active session, which is the same condition that hides the run-mode
          // control (TaskDetailEditForm). Sending it unconditionally would write
          // a mode from a control the user was never shown.
          run_mode: input.runMode,
        }
        : {};

      if (needsSwitchBranch) {
        try {
          await window.electronAPI.tasks.switchBranch({
            taskId: input.task.id,
            newBaseBranch: trimmedBranch,
            enableWorktree: enablingWorktree || undefined,
          }, host.projectId || null);
          if (input.title !== input.task.title
            || input.description !== input.task.description
            || prFields.pr_url !== undefined
            || JSON.stringify(input.labels) !== JSON.stringify(input.task.labels ?? [])
            || input.priority !== (input.task.priority ?? 0)
            || (input.agentOverride || null) !== input.task.agent_override
            || (input.modelOverride || null) !== input.task.model_override
            || (input.effortOverride || null) !== input.task.effort_override
            || (input.permissionOverride || null) !== input.task.permission_mode
            || (input.profileId ?? null) !== input.task.profile_id
            || input.runMode !== input.task.run_mode) {
            await host.updateTask({
              id: input.task.id,
              title: input.title,
              description: input.description,
              labels: input.labels,
              priority: input.priority,
              ...prFields,
              ...overrideFields,
            });
          }
          await host.refresh();
        } catch (error) {
          console.error('switchBranch failed:', error);
          useToastStore.getState().addToast({
            message: `Failed to switch branch: ${error instanceof Error ? error.message : 'Unknown error'}`,
            variant: 'warning',
          });
          return;
        }
      } else {
        const payload: Parameters<typeof host.updateTask>[0] = {
          id: input.task.id,
          title: input.title,
          description: input.description,
          labels: input.labels,
          priority: input.priority,
          ...prFields,
          ...overrideFields,
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
        await host.updateTask(payload);
      }

      if (!input.session) {
        input.onClose();
      } else {
        input.setIsEditing(false);
      }
    } finally {
      setSaving(false);
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
    host.archiveTask(taskId);
    const laneTasks = host.laneTasks(doneLane.id);
    await window.electronAPI.tasks.move({ taskId, targetSwimlaneId: doneLane.id, targetPosition: laneTasks.length }, host.projectId || null);
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
    await host.deleteTask(input.task.id);
    useToastStore.getState().addToast({
      message: `Deleted task "${taskTitle}"`,
      variant: 'info',
    });
  };

  return {
    // state
    pendingAction,
    toggling,
    saving,
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
