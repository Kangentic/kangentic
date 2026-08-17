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
//   preparing → running → exited
//                       → suspended
//
// - preparing:    Pre-session phase (worktree creation, branch checkout)
// - running:      Agent CLI active (usage data optional)
// - queued:       Waiting for a concurrency slot
// - suspended:    Session paused
// - exited:       PTY process terminated
// - none:         No session, no progress
// ---------------------------------------------------------------------------

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
// ---------------------------------------------------------------------------
// Display-kind classification (compile-enforced)
//
// Consumers used to ask "which kind is this?" with chains of string-literal
// comparisons, e.g. the task-detail body's terminal gate:
//
//   sessionId && kind !== 'queued' && kind !== 'suspended'
//
// A denylist like that silently ADOPTS every kind added later, which is exactly
// how a restore came to paint the outgoing session's dead terminal: the moment
// an in-flight spawn label started resolving to 'preparing', a gate that had
// never heard of it matched. The failure is invisible - no type error, no test,
// just the wrong face.
//
// Both tables below are `satisfies Record<SessionDisplayState['kind'], ...>`, so
// adding a kind to the union fails `npm run typecheck` until every consumer has
// been told what to do with it. Same mechanism as ACTIVITY_DISPOSITION in
// shared/activity-state.ts (see .claude/rules/activity-state-classification.md).
// ---------------------------------------------------------------------------

/** Which face the task-detail body paints. */
export type TaskDetailSurface =
  /** The live xterm for the task's session. */
  | 'terminal'
  /** Spinner + spawn phase label: work is happening, no session to show yet. */
  | 'launch-overlay'
  /** Waiting for a concurrency slot. */
  | 'queued-placeholder'
  /** Offer to restart a session that is genuinely parked. */
  | 'resume-prompt'
  /** Nothing session-shaped to show; the body falls through to its other faces. */
  | 'inert';

const TASK_DETAIL_SURFACE = {
  // A session exists and is producing output (its boot noise included).
  running: 'terminal',
  initializing: 'terminal',
  // Pre-session work. NOTE: during a restore the outgoing session's id is still
  // on the row, so this must not fall through to 'terminal' or the user watches
  // a dead shell while the agent is being restored.
  preparing: 'launch-overlay',
  queued: 'queued-placeholder',
  suspended: 'resume-prompt',
  exited: 'inert',
  none: 'inert',
} satisfies Record<SessionDisplayState['kind'], TaskDetailSurface>;

/** The task-detail face for a display kind. Total by construction. */
export function taskDetailSurfaceFor(kind: SessionDisplayState['kind']): TaskDetailSurface {
  return TASK_DETAIL_SURFACE[kind];
}

/** Where a display kind sits in the session lifecycle. */
export type SessionLifecyclePhase =
  /** The agent is working or on its way to working. */
  | 'active'
  /** Parked, but resumable - it still has a session behind it. */
  | 'paused'
  /** No session lifecycle at all (never started, or finished). */
  | 'ended';

const SESSION_LIFECYCLE_PHASE = {
  running: 'active',
  queued: 'active',
  initializing: 'active',
  preparing: 'active',
  suspended: 'paused',
  exited: 'ended',
  none: 'ended',
} satisfies Record<SessionDisplayState['kind'], SessionLifecyclePhase>;

/** True while the agent is working or starting: the Pause direction of a toggle. */
export function isActiveKind(kind: SessionDisplayState['kind']): boolean {
  return SESSION_LIFECYCLE_PHASE[kind] === 'active';
}

/**
 * True when the task has a session lifecycle to talk about (active or paused).
 * The complement of "never started / already finished".
 */
export function hasSessionLifecycle(kind: SessionDisplayState['kind']): boolean {
  return SESSION_LIFECYCLE_PHASE[kind] !== 'ended';
}

export function getTaskProgress(inputs: {
  session?: Session;
  usage?: SessionUsage;
  activity?: ActivityState;
  spawnProgressLabel?: string | null;
}): SessionDisplayState {
  const { session, usage, activity, spawnProgressLabel } = inputs;

  // Pre-session: spawn progress from main process (worktree creation, etc.).
  //
  // A SUSPENDED session does not suppress this. Main only emits a spawn label
  // while it is actively spawning or resuming right now, which is strictly
  // newer information than a record that was suspended earlier. Restoring a
  // task from Done is the case that made this obvious: the suspended record is
  // deliberately preserved for the resume, so the old `!session` test discarded
  // the label for the entire worktree-recreate and CLI-boot window and left the
  // card reading "Paused" with a manual "Resume session" button, while the
  // engine was already restoring the conversation behind it. The same stale
  // window hit any suspended task moved into an auto-spawn column.
  //
  // Only 'suspended' is overridden. A running/queued session owns its own
  // display, and a stale label must never mask a live agent.
  if (spawnProgressLabel && (!session || session.status === 'suspended')) {
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
      // Session is running - show as running regardless of usage data.
      // Usage enriches the display (model, cost, context %) but its
      // absence doesn't mean the agent isn't running.
      //
      // A running session is in one of three states: 'thinking', 'idle',
      // or 'permission' (waiting on user approval). When the renderer
      // has no cached value (brief startup window, HMR recovery gap
      // where syncSessions's snapshot didn't contain the session,
      // listener reattach race, orphaned DB row with no live engine
      // entry), we default to 'idle'. Defaulting to 'thinking' would
      // stick the spinner permanently for any of those cases; 'idle'
      // is the safer default because a real thinking session emits
      // events quickly and corrects itself.
      return {
        kind: 'running',
        activity: activity ?? 'idle',
        usage: usage ?? null,
      };
    }
  }
}

/**
 * React hook for TaskCard progress state. Subscribes to minimal store slices.
 * Replaces useSessionDisplayState + manual subscriptions.
 */
export function useTaskProgress(taskId: string, sessionId: string | undefined): SessionDisplayState {
  const taskSession = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) => {
        if (!sessionId) return undefined;
        // Every board card runs this selector on every session-store write, so the
        // linear scan below was O(cards x sessions) per activity push. The task
        // index answers the same question in one lookup for the normal case (the
        // caller's session IS the task's current session, which is how TaskCard
        // resolves it); the scan stays as the fallback for a caller asking about
        // some other session.
        const indexed = s._sessionByTaskId.get(taskId);
        if (indexed && indexed.id === sessionId) return indexed;
        return s.sessions.find((session) => session.id === sessionId);
      },
      [sessionId, taskId],
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
  return useMemo(
    () => getTaskProgress({
      session: taskSession,
      usage,
      activity,
      spawnProgressLabel,
    }),
    [taskSession, usage, activity, spawnProgressLabel],
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
