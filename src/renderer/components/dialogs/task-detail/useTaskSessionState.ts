import { useEffect, useLayoutEffect, useRef } from 'react';
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
 * Derives the task-detail window's session-related view state and wires
 * the side effects around session lifecycle:
 *
 *   - Claims this session in `dialogSessionIds` so the bottom panel drops
 *     its TerminalTab before this window's terminal effects fire (one xterm
 *     per PTY). Uses useLayoutEffect so the swap is synchronous.
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
  const reconcileSession = useSessionStore((state) => state.reconcileSession);

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

  // Claim this session for this detail window so the bottom panel drops its
  // TerminalTab BEFORE any terminal effects fire (one xterm per PTY).
  // useLayoutEffect runs synchronously after DOM mutations but before paint.
  // Each open window claims its own session; the claim is released on close.
  useLayoutEffect(() => {
    const sessionId = session?.id;
    if (!sessionId) return;
    useSessionStore.getState().claimDialogSession(sessionId);
    return () => useSessionStore.getState().releaseDialogSession(sessionId);
  }, [session?.id]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on session.id intentionally; the full session object would refit on every unrelated session update
  }, [input.isEditing, session?.id]);

  // Proactively reconcile a 'suspended' view against main's registry on dialog
  // mount. The renderer cache can drift from the live PTY (HMR listener gap,
  // optimistic suspend in suspendSession, multi-session-per-task races). If
  // main reports the session is actually running, the store update swaps in
  // the live session and the dialog re-renders the active terminal. If main
  // confirms suspended (or no session at all), this is a no-op for the UI.
  //
  // Guarded by a ref keyed on (taskId, sessionId) so we probe at most once
  // per session per dialog mount. Re-probing on every status flap would be
  // a loop hazard since the probe itself updates session.status.
  const probedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    if (session.status !== 'suspended') return;
    const key = `${input.task.id}:${session.id}`;
    if (probedKeyRef.current === key) return;
    probedKeyRef.current = key;
    reconcileSession(input.task.id).catch((error) => {
      console.warn('[useTaskSessionState] reconcile probe failed', error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on session.id/status only; the full session object would re-probe on every flap (loop hazard, see comment above)
  }, [session?.id, session?.status, input.task.id, reconcileSession]);

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
