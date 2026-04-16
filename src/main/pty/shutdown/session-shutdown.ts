import type * as pty from 'node-pty';
import type { SessionStatus } from '../../../shared/types';
import type { SessionQueue } from '../session-queue';
import type { SessionFileManager } from '../lifecycle/session-file-manager';
import type { FirstOutputTracker } from '../lifecycle/first-output-tracker';

/**
 * Error-tolerant write of an agent exit sequence to a PTY.
 *
 * PTYs may die between `.write()` calls (agent processed `/exit` and
 * the underlying shell exited), in which case node-pty throws. Each
 * command is attempted independently and errors are swallowed - the
 * caller's next step is to force-kill anyway.
 */
export function writeExitSequence(ptyRef: pty.IPty, exitSequence: string[]): void {
  for (const command of exitSequence) {
    try {
      ptyRef.write(command);
    } catch {
      // PTY may already be dead - ignore and fall through to force-kill
    }
  }
}

/** Minimum shape of a managed session that shutdown operations touch. */
export interface ShutdownSession {
  id: string;
  taskId: string;
  pty: pty.IPty | null;
  status: SessionStatus;
  startedAt: string;
  exitSequence: string[];
}

export interface ShutdownContext<S extends ShutdownSession = ShutdownSession> {
  sessions: Map<string, S>;
  sessionQueue: SessionQueue;
  sessionFiles: SessionFileManager;
  firstOutputTracker: FirstOutputTracker;
  killPty: (ptyRef: pty.IPty) => boolean;
}

/**
 * Gracefully suspend every running PTY session.
 *
 * Sends the adapter-specific exit sequence (Ctrl+C + /exit for Claude,
 * Ctrl+C + /quit for Gemini) to each process so it saves conversation
 * state (JSONL) before exit. Waits up to `timeoutMs` for natural exit,
 * then force-kills any remaining.
 *
 * Uses a shorter wait (200ms) when all running sessions are "fresh"
 * (< 10s old): they have minimal state to flush, so the full 2s
 * deadline would just slow shutdown for no benefit. This matters on
 * recovery-from-crash where many sessions spawn back-to-back.
 *
 * Returns the list of task IDs so the caller (suspendAll's orchestrator
 * in index.ts) can mark them 'suspended' in the DB before exiting.
 */
export async function suspendAllSessions<S extends ShutdownSession>(
  context: ShutdownContext<S>,
  timeoutMs = 2000,
): Promise<string[]> {
  const taskIds: string[] = [];
  const ptysToKill: pty.IPty[] = [];
  const freshSessionThresholdMs = 10_000;
  const now = Date.now();
  let hasLongRunningSession = false;

  for (const session of context.sessions.values()) {
    if (session.pty && session.status === 'running') {
      taskIds.push(session.taskId);

      const sessionAge = now - new Date(session.startedAt).getTime();
      if (sessionAge >= freshSessionThresholdMs) {
        hasLongRunningSession = true;
      }

      writeExitSequence(session.pty, session.exitSequence);
      ptysToKill.push(session.pty);
      session.status = 'exited';
    }
  }

  // Queued sessions have no PTY yet - count them as suspended and drop
  // the queue so they don't auto-promote after the app reopens.
  for (const session of context.sessions.values()) {
    if (session.status === 'queued') {
      taskIds.push(session.taskId);
      session.status = 'exited';
    }
  }
  context.sessionQueue.clear();

  if (ptysToKill.length > 0) {
    const effectiveTimeout = hasLongRunningSession ? timeoutMs : 200;
    await new Promise((resolve) => setTimeout(resolve, effectiveTimeout));
  }

  for (const session of context.sessions.values()) {
    // Preserve files on disk - sessions will be resumed on next app
    // launch via session recovery. See SessionFileManager.detachPreservingFiles.
    context.sessionFiles.detachPreservingFiles(session.id);

    if (session.pty) {
      const ptyRef = session.pty;
      session.pty = null;
      context.killPty(ptyRef);
    }
  }

  return taskIds;
}

/**
 * Synchronously kill every PTY and delete all session files.
 *
 * CRITICAL: must remain synchronous. This runs from Electron's
 * `before-quit` handler, which cannot await. If it ever does, the
 * main process stays alive while Chromium child processes (GPU,
 * utility, crashpad) survive as zombies - on Windows installed
 * builds this also causes the app to auto-reopen. See the
 * "Shutdown (CRITICAL)" section in CLAUDE.md.
 *
 * Best-effort graceful exit: each PTY gets the exit sequence written
 * to it before kill() lands. The write buffer may or may not flush
 * in time (we do NOT wait); the agent might get a few ms to start
 * flushing conversation state. For a true graceful suspend, call
 * suspendAllSessions first.
 */
export function killAllSessions<S extends ShutdownSession>(
  context: ShutdownContext<S>,
): void {
  for (const session of context.sessions.values()) {
    if (session.pty) {
      writeExitSequence(session.pty, session.exitSequence);
      const ptyRef = session.pty;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      context.killPty(ptyRef);
    }
    context.sessionFiles.detachAndDelete(session.id);
  }
  context.sessions.clear();
  context.sessionQueue.clear();
  context.firstOutputTracker.clear();
}
