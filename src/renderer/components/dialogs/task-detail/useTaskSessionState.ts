import { useEffect, useLayoutEffect } from 'react';
import { useSessionStore } from '../../../stores/session-store';
import { useTaskProgress } from '../../../utils/task-progress';
import type { Task, Session } from '../../../../shared/types';

interface TaskSessionState {
  session: Session | null;
  displayState: ReturnType<typeof useTaskProgress>;
  canToggle: boolean;
  isSessionActive: boolean;
  isQueued: boolean;
  isSuspended: boolean;
  /**
   * Whether the task has a non-terminal session state (running/queued/
   * initializing/preparing/suspended). Does NOT factor in a pending
   * suspend/resume transition - callers should OR this with `toggling`
   * to keep the dialog in large mode during the transition.
   */
  hasSessionContext: boolean;
  isInDone: boolean;
  canShowChanges: boolean;
}

/**
 * Derives the task-detail dialog's session-related view state and wires
 * the side effects around session lifecycle:
 *
 *   - Registers this session as the `dialogSessionId` so the bottom
 *     panel unmounts its TerminalTab before this dialog's terminal
 *     effects fire. Uses useLayoutEffect so the swap is synchronous.
 *   - Emits a `terminal-panel-resize` event when the session status
 *     flips to `running` so the embedded xterm instance refits.
 *   - Emits a `terminal-panel-resize` event when `isEditing` toggles
 *     (the edit form changes the dialog's layout).
 *
 * Note: this hook intentionally does NOT compute `hasSessionContext`,
 * `canShowChanges`, etc. against `isEditing` - those decisions stay in
 * the dialog so edit mode can short-circuit layout choices.
 */
export function useTaskSessionState(input: {
  task: Task;
  isEditing: boolean;
  isArchived: boolean;
  isInTodo: boolean;
  currentSwimlaneRole: string | null | undefined;
}): TaskSessionState {
  const session = useSessionStore((state) =>
    state.sessions.find((candidate) => candidate.taskId === input.task.id) ?? null,
  );
  const setDialogSessionId = useSessionStore((state) => state.setDialogSessionId);

  const displayState = useTaskProgress(input.task.id, session?.id);

  const canToggle = !input.isInTodo && (
    displayState.kind === 'running'
    || displayState.kind === 'queued'
    || displayState.kind === 'initializing'
    || displayState.kind === 'suspended'
    || displayState.kind === 'preparing'
  );
  const isSessionActive = displayState.kind === 'running'
    || displayState.kind === 'queued'
    || displayState.kind === 'initializing'
    || displayState.kind === 'preparing';
  const isQueued = displayState.kind === 'queued';
  const isSuspended = displayState.kind === 'suspended';
  const isInDone = input.currentSwimlaneRole === 'done';

  // Base session-context flag - excludes the "during-toggle transition"
  // compensation, which callers add in to keep the dialog large while
  // pendingAction is non-null.
  const hasSessionContext = !input.isArchived
    && (displayState.kind !== 'none' && displayState.kind !== 'exited');

  // Show Changes button when the task isn't in a terminal column.
  // Works with or without a branch/worktree - tasks on main show uncommitted working tree changes.
  const canShowChanges = !input.isArchived && !input.isInTodo && !isInDone;

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
  }, [input.isEditing, session?.id]);

  return {
    session,
    displayState,
    canToggle,
    isSessionActive,
    isQueued,
    isSuspended,
    hasSessionContext,
    isInDone,
    canShowChanges,
  };
}
