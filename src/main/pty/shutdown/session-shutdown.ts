import type * as pty from 'node-pty';
import type { SessionStatus } from '../../../shared/types';
import type { SessionQueue } from '../session-queue';
import type { SessionFileManager } from '../lifecycle/session-file-manager';
import type { FirstOutputTracker } from '../lifecycle/first-output-tracker';
import { isYoungSession, type DeferredKillRegistry } from '../lifecycle/deferred-kill';

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
  /** First alt-screen entry, epoch ms; see ManagedSession.altScreenEnteredAt. */
  altScreenEnteredAt?: number;
  /** onData / onExit listener disposables, detached at kill so node-pty
   *  stops invoking our callbacks after the session dir is deleted. See
   *  ManagedSession.ptyDisposables for the full contract: only set on the
   *  normal-spawn path, left undefined for placeholder/queued sessions. */
  ptyDisposables?: pty.IDisposable[];
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
 * What the synchronous cleanup killed, handed to the before-quit exit-callback
 * drain (exit-callback-drain.ts).
 *
 * A count as well as a pid list because the two can disagree. A PTY whose child
 * pid is unreadable is still a kill whose exit callback can land after
 * `node::Stop()`; it just cannot be probed, so the drain waits it out on a fixed
 * budget instead. Reporting only the pids let such a kill skip the drain for the
 * whole shutdown.
 *
 * Measured on node-pty 1.1.0 (Electron 41, ConPTY): no production path produces
 * that disagreement. `pid` is a synchronous one-shot read at construction
 * (`windowsPtyAgent.js:90` assigns `_innerPid` from `connect.pid` as the
 * constructor's last statement; nothing reassigns it), so a PTY killed before its
 * first data event still carries a real pid, and a spawn that fails throws rather
 * than yielding a wrapper reading 0, which leaves a `pty: null` placeholder the
 * loop below skips outright. So `killedCount` is a DEFENSIVE guard: it keeps the
 * drain armed if a future path ever kills a PTY it cannot name, rather than
 * covering one that exists today.
 */
export interface PtyKillReport {
  /** Child pids of the killed PTYs; each is probed until it is gone. */
  pids: number[];
  /** Total PTYs killed, including any whose child pid was unreadable.
   *  Always >= pids.length. */
  killedCount: number;
  /**
   * How many of `killedCount` are DEFERRED: their exit sequence is written and
   * their force-kill fires on a timer (`KILL_GRACE_MS`) that the drain must
   * outlast. Counted in `killedCount` and `pids` like any other kill, so the
   * drain arms and probes them; this number only tells it to extend its
   * deadline by the grace. Zero on every route where no drain follows.
   */
  deferredCount: number;
}

export interface KillAllSessionsOptions {
  /**
   * Let a young session's force-kill wait out the exit-sequence grace on the
   * deferred registry's timer instead of landing now. Only for a route where
   * the before-quit drain WILL run (it is what keeps the loop alive for the
   * timer and holds the quit until the kill has landed). Defaults to false:
   * the instant kill, with every previously deferred PTY flushed as well.
   */
  allowGrace?: boolean;
  /** The manager's deferred-kill registry. Without it nothing can be deferred. */
  deferredKills?: DeferredKillRegistry;
}

/**
 * Synchronously kill every PTY and delete all session files.
 *
 * CRITICAL: must remain synchronous. This runs from Electron's
 * `before-quit` handler, which cannot await. If it ever does, the
 * main process stays alive while Chromium child processes (GPU,
 * utility, crashpad) survive as zombies - on Windows installed
 * builds this also causes the app to auto-reopen. See
 * .claude/rules/synchronous-shutdown.md.
 *
 * Best-effort graceful exit: each PTY gets the exit sequence written
 * to it before kill() lands. For a MATURE session the write buffer may or
 * may not flush in time (we do NOT wait). For a YOUNG session (inside Claude
 * Code's fullscreen boot-canary window, see lifecycle/deferred-kill.ts) and
 * only when `allowGrace` is set, the kill is instead parked on the deferred
 * registry's 1500 ms timer, which fires inside the before-quit drain: the
 * loop stays alive for it, the exit sequence lands, and the drain (whose
 * deadline extends by the grace when `deferredCount` is set) still holds the
 * quit until the child is gone. Every parked PTY's listeners are detached
 * here either way, exactly as for the rows below.
 *
 * Returns a PtyKillReport. The before-quit handler feeds it to the
 * exit-callback drain (exit-callback-drain.ts), which holds the quit until
 * those children are gone and node-pty's exit callbacks have been dispatched
 * while JS is still callable. A pid is reported even when killPty says the
 * child was already dead: it polls dead on the first tick, and the drain's
 * settle ticks still cover an exit callback that is queued but not yet
 * dispatched. `killedCount` counts every kill, including one whose child pid
 * was unreadable and so contributes no pid to probe; see PtyKillReport for why
 * that is a guard rather than a live path.
 */
export function killAllSessions<S extends ShutdownSession>(
  context: ShutdownContext<S>,
  options: KillAllSessionsOptions = {},
): PtyKillReport {
  const pids: number[] = [];
  let killedCount = 0;
  let deferredCount = 0;
  const deferredKills = options.deferredKills;
  const deferYoung = options.allowGrace === true && deferredKills !== undefined;
  // What an earlier kill() parked, read BEFORE the loop parks anything of its
  // own, so a row deferred below is counted once, not again as "pending".
  const previouslyParkedPids = deferredKills?.pendingPids() ?? [];
  const previouslyParkedCount = deferredKills?.size ?? 0;
  for (const session of context.sessions.values()) {
    if (session.pty) {
      writeExitSequence(session.pty, session.exitSequence);
      const ptyRef = session.pty;
      // Read before nulling: the drain needs the child pid, not the wrapper.
      const childPid = ptyRef.pid;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      if (deferYoung && isYoungSession(session)) {
        // The registry's timer does the kill; the listeners are detached just
        // below like every other row's, so the entry carries none.
        deferredKills.schedule({ sessionId: session.id, ptyRef, pid: childPid });
        deferredCount += 1;
      } else {
        context.killPty(ptyRef);
      }
      // Count the kill first, unconditionally. An unreadable pid means the drain
      // has nothing to probe for this child, NOT that nothing was killed.
      killedCount += 1;
      if (Number.isInteger(childPid) && childPid > 0) pids.push(childPid);
    }
    // Detach our onData / onExit listeners so node-pty stops invoking the
    // callbacks on a later tick. Without this a final ConPTY chunk fires
    // onData into the session dir detachAndDelete is about to remove (the
    // dev-only trace-recorder ENOENT), and every late callback keeps the
    // libuv loop referenced past a clean quit. Shutdown-only: the graceful
    // per-session paths (suspend, remove) must keep onExit live.
    if (session.ptyDisposables) {
      for (const disposable of session.ptyDisposables) {
        try {
          disposable.dispose();
        } catch {
          // Best-effort - node-pty may have already torn down the emitter.
        }
      }
      session.ptyDisposables = undefined;
    }
    context.sessionFiles.detachAndDelete(session.id);
  }
  // PTYs an earlier kill() parked, whose rows may already be gone. Their
  // listeners come off now for the same reason as the rows' above; the kill
  // itself either rides the timer (a drain follows) or lands here (none does).
  if (deferredKills) {
    deferredKills.detachAllListeners();
    if (deferYoung) {
      pids.push(...previouslyParkedPids);
      killedCount += previouslyParkedCount;
      deferredCount += previouslyParkedCount;
    } else {
      // Nothing was parked by the loop above on this branch, so the flush
      // covers exactly the previously parked PTYs.
      const flushed = deferredKills.flushAll();
      pids.push(...flushed.pids);
      killedCount += flushed.count;
    }
  }
  context.sessions.clear();
  context.sessionQueue.clear();
  context.firstOutputTracker.clear();
  return { pids, killedCount, deferredCount };
}
