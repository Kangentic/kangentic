import { useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/session-store';
import { useBoardStore } from '../stores/board-store';
import type { Session, SessionUsage, ActivityState, SessionDisplayState } from '../../shared/types';

// ---------------------------------------------------------------------------
// Unified task progress derivation
//
// Single system that answers "what is this task doing right now?" for both
// the board card and the terminal overlay. Replaces the previously scattered
// logic across session-display-state.ts, TaskCard.tsx (deriveInitializingLabel),
// and TerminalTab.tsx (deriveOverlayLabel).
//
// Display lifecycle:
//   preparing → initializing → running → exited
//                                      → suspended
//
// - preparing:    Pre-session phase (worktree creation, branch checkout)
// - initializing: PTY spawned, waiting for first usage report
// - running:      Claude CLI active with usage data
// - queued:       Waiting for a concurrency slot
// - suspended:    Session paused
// - exited:       PTY process terminated
// - none:         No session, no progress
// ---------------------------------------------------------------------------

/**
 * Derive the initializing label when the PTY is spawned but usage hasn't
 * arrived yet. Priority chain (highest first):
 *   1. Pending command label ("Running command...")
 *   2. Resuming session ("Resuming...")
 *   3. Default ("Starting agent...")
 */
function deriveInitializingLabel(
  pendingCommandLabel: string | null | undefined,
  isResuming: boolean,
): string {
  if (pendingCommandLabel) return 'Running command...';
  if (isResuming) return 'Resuming...';
  return 'Starting agent...';
}

/**
 * Derive the terminal overlay label. Extends the initializing label with
 * swimlane auto_command support (shows the command text instead of generic).
 * Priority chain (highest first):
 *   1. Pending command label (explicit invocation text)
 *   2. Resuming session ("Resuming agent...")
 *   3. Swimlane auto_command (shows the command itself)
 *   4. Default ("Starting agent...")
 */
function deriveOverlayLabel(
  pendingCommandLabel: string | null | undefined,
  isResuming: boolean,
  autoCommand: string | null | undefined,
): string {
  if (pendingCommandLabel) return pendingCommandLabel;
  if (isResuming) return 'Resuming agent...';
  if (autoCommand) return autoCommand;
  return 'Starting agent...';
}

/**
 * Pure derivation of display state from raw task/session data.
 * Centralizes all progress state logic into one priority chain.
 *
 * Priority (highest to lowest):
 *   1. Spawn progress label (main process push during worktree/git I/O)
 *   2. Session-based display state (queued, initializing, running, etc.)
 *   3. None (no session, no progress)
 */
export function getTaskProgress(inputs: {
  session?: Session;
  usage?: SessionUsage;
  activity?: ActivityState;
  spawnProgressLabel?: string | null;
  pendingCommandLabel?: string | null;
}): SessionDisplayState {
  const { session, usage, activity, spawnProgressLabel, pendingCommandLabel } = inputs;

  // Pre-session: spawn progress from main process (worktree creation, etc.)
  if (spawnProgressLabel && !session) {
    return { kind: 'preparing', label: spawnProgressLabel };
  }

  if (!session) return { kind: 'none' };

  switch (session.status) {
    case 'exited':
      return { kind: 'exited', exitCode: session.exitCode ?? 0 };
    case 'suspended':
      return { kind: 'suspended' };
    case 'queued':
      return { kind: 'queued' };
    case 'running': {
      if (!usage) {
        return {
          kind: 'initializing',
          label: deriveInitializingLabel(pendingCommandLabel, session.resuming),
        };
      }
      return {
        kind: 'running',
        activity: activity ?? 'thinking',
        usage,
      };
    }
  }
}

/**
 * React hook for TaskCard progress state. Subscribes to minimal store slices.
 * Replaces useSessionDisplayState + deriveInitializingLabel + manual subscriptions.
 */
export function useTaskProgress(taskId: string, sessionId: string | undefined): SessionDisplayState {
  const taskSession = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? s.sessions.find((session) => session.id === sessionId) : undefined,
      [sessionId],
    ),
  );
  const usage = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? s.sessionUsage[sessionId] : undefined,
      [sessionId],
    ),
  );
  const activity = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? s.sessionActivity[sessionId] : undefined,
      [sessionId],
    ),
  );
  const spawnProgressLabel = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.spawnProgress[taskId] ?? null,
      [taskId],
    ),
  );
  const pendingCommandLabel = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.pendingCommandLabel[taskId] ?? null,
      [taskId],
    ),
  );

  return useMemo(
    () => getTaskProgress({
      session: taskSession,
      usage,
      activity,
      spawnProgressLabel,
      pendingCommandLabel,
    }),
    [taskSession, usage, activity, spawnProgressLabel, pendingCommandLabel],
  );
}

// ---------------------------------------------------------------------------
// Terminal overlay progress
// ---------------------------------------------------------------------------

export interface TerminalOverlayState {
  /** Label for the shimmer overlay (contextual text shown while CLI boots). */
  overlayLabel: string;
}

/**
 * React hook for TerminalTab overlay label. Consolidates the overlay label
 * derivation that was previously in TerminalTab.tsx (deriveOverlayLabel).
 *
 * Does NOT manage terminalReady state - that's a component-level lifecycle
 * concern (xterm init, firstOutput/usage gating) that stays local.
 */
export function useTerminalOverlay(taskId: string, sessionId: string): TerminalOverlayState {
  const isResuming = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.id === sessionId)?.resuming ?? false,
      [sessionId],
    ),
  );
  const pendingCommandLabel = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.pendingCommandLabel[taskId] ?? null,
      [taskId],
    ),
  );
  const autoCommand = useBoardStore(
    useCallback(
      (s: ReturnType<typeof useBoardStore.getState>) => {
        const task = s.tasks.find((t) => t.session_id === sessionId);
        if (!task) return null;
        const swimlane = s.swimlanes.find((lane) => lane.id === task.swimlane_id);
        return swimlane?.auto_command ?? null;
      },
      [sessionId],
    ),
  );

  const overlayLabel = useMemo(
    () => deriveOverlayLabel(pendingCommandLabel, isResuming, autoCommand),
    [pendingCommandLabel, isResuming, autoCommand],
  );

  return { overlayLabel };
}
