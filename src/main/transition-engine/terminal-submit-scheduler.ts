import type { SessionManager } from '../pty/session-manager';
import type { CommandVerifier, TerminalSubmit } from '../pty/terminal-submit';

/**
 * Re-export so callers in injection-plan and slash-command-verifier can keep
 * importing `CommandVerifier` from the engine layer without reaching into
 * `pty/terminal-submit.ts` directly.
 */
export type { CommandVerifier } from '../pty/terminal-submit';

/** State for a task whose burst is in flight. `next` is the most-recently-
 *  scheduled follow-up that will run after the current one finishes; rapid
 *  drag-through transitions overwrite `next` so only the latest survives. */
interface ActiveBurst {
  controller: AbortController;
  next: { commands: string[]; opts: ScheduleKeystrokesOptions } | null;
}

/** State for a task waiting on a fresh-spawn `'thinking'` event. */
interface PendingDeferred {
  cleanup: () => void;
}

/** Options for `scheduleKeystrokes`. */
export interface ScheduleKeystrokesOptions {
  /**
   * True when the session was just spawned (or is `queued` waiting to spawn).
   * The scheduler waits for the CLI's first `'thinking'` activity event
   * before pushing keystrokes - sending them while the CLI still prints its
   * banner gets the text rendered into the wrong place.
   */
  freshlySpawned?: boolean;
  /** Per-command verifier; forwarded to TerminalSubmit.submitKeystrokes. */
  verifier?: CommandVerifier | null;
  /** Verifies leading prefix only; trailing commands fire-and-forget. */
  verifiedPrefixLength?: number;
  /**
   * Hard timeout for the fresh-spawn wait. When the CLI never emits
   * `'thinking'` (e.g. agent hung at startup), we cancel this task's
   * pending injection rather than wait forever. Default 120s.
   */
  timeoutMs?: number;
}

/**
 * `TerminalSubmitScheduler` is the lifecycle wrapper for keystroke
 * delivery. Where `TerminalSubmit.submitKeystrokes` answers "HOW the bytes
 * go out", this class answers "WHEN":
 *
 *   1. **Existing session** -- delivers immediately. If a burst is already
 *      in flight for this task, the new request stashes as `next`; only the
 *      most-recent stash runs after the current finishes (rapid drag-through
 *      transitions coalesce).
 *
 *   2. **Freshly spawned session** (`opts.freshlySpawned: true`) -- waits
 *      for the CLI's first `'thinking'` activity event before delivering.
 *      30s fallback delivers anyway if hooks never fire (CLI is up but the
 *      adapter has no thinking-state hook). `opts.timeoutMs` (default 120s)
 *      caps the total wait.
 *
 *   3. **Queued session** -- waits for `status:running`, then applies the
 *      `'thinking'` wait. Same fallback / hard-timeout structure.
 *
 * Cancellation tears down event listeners + timers AND aborts an in-flight
 * burst via the per-task `AbortController` plumbed through to
 * TerminalSubmit. Re-scheduling for the same task cancels any prior pending
 * injection.
 *
 * Used by every column-transition / lifecycle path that injects keystrokes:
 * auto_command on column move, `/model X` + `/effort Y` settings burst,
 * fresh-spawn auto_command, archive/un-archive flows.
 */
export class TerminalSubmitScheduler {
  private deferred = new Map<string, PendingDeferred>();
  private active = new Map<string, ActiveBurst>();

  constructor(
    private sessionManager: SessionManager,
    private terminalSubmit: TerminalSubmit,
  ) {}

  /**
   * Schedule a keystroke sequence for a task's PTY session. A single command
   * becomes `[command]`; chained bursts (e.g. `/model X`, `/effort Y`,
   * auto_command) pass them all in `commands[]` so the per-task coalesce
   * worker can pick up the whole burst as one unit.
   */
  scheduleKeystrokes(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions = {},
  ): void {
    if (commands.length === 0) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[TerminalSubmitScheduler] No session ${sessionId.slice(0, 8)} for task ${taskId.slice(0, 8)} -- skipping`);
      return;
    }

    const freshlySpawned = opts.freshlySpawned ?? false;
    const isQueued = session.status === 'queued';

    // Existing session, ready right now: try to claim the active-burst slot.
    if (!freshlySpawned && !isQueued) {
      const existing = this.active.get(taskId);
      if (existing) {
        // A burst is in flight. Stash this as "next"; the worker drains it
        // when the current burst finishes. Overwriting any previous "next"
        // intentionally coalesces transient drags.
        existing.next = { commands, opts };
        console.log(`[TerminalSubmitScheduler] Queueing burst for task ${taskId.slice(0, 8)} (in-flight burst running)`);
        return;
      }
      this.startBurst(taskId, sessionId, commands, opts);
      return;
    }

    // Fresh spawn or queued - wait for CLI to come alive, then start the burst.
    this.cancel(taskId);
    this.scheduleDeferred(taskId, sessionId, commands, opts, isQueued);
  }

  /**
   * Cancel any pending or in-flight injection for a specific task. Aborts
   * the AbortController plumbed through to TerminalSubmit so an in-flight
   * burst stops at the next write/wait boundary. Drops the queued "next"
   * sequence on any active worker.
   */
  cancel(taskId: string): void {
    const pending = this.deferred.get(taskId);
    if (pending) {
      this.deferred.delete(taskId);
      pending.cleanup();
    }
    const burst = this.active.get(taskId);
    if (burst) {
      burst.next = null;
      burst.controller.abort();
    }
  }

  /** Cancel all pending injections. Called on `killAll`/`suspendAll`. */
  cancelAll(): void {
    const pending = [...this.deferred.values()];
    this.deferred.clear();
    for (const entry of pending) entry.cleanup();
    for (const burst of this.active.values()) {
      burst.next = null;
      burst.controller.abort();
    }
  }

  /**
   * Start a burst on the active map and run it through TerminalSubmit. When
   * the burst finishes (or aborts), drain any queued `next` sequence so a
   * rapid drag-through transition gets the last update applied.
   */
  private startBurst(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions,
  ): void {
    const controller = new AbortController();
    const entry: ActiveBurst = { controller, next: null };
    this.active.set(taskId, entry);
    void this.runBurst(taskId, sessionId, commands, opts, entry);
  }

  private async runBurst(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions,
    entry: ActiveBurst,
  ): Promise<void> {
    try {
      await this.terminalSubmit.submitKeystrokes(sessionId, commands, {
        // Fresh-spawn paths just consumed the CLI prompt arg and have nothing
        // to interrupt; sending Ctrl+C here on Windows ConPTY + Ink lands
        // mid-render of the initial turn and causes the next keystrokes to
        // concatenate onto the prompt as one user message (rendered as
        // `</task>/test` glued together). Live-injection paths (model/effort
        // live swap, board column-edit) keep the leading Ctrl+C so they can
        // interrupt mid-thinking and deliver new flags.
        sendCtrlC: !opts.freshlySpawned,
        verifier: opts.verifier,
        verifiedPrefixLength: opts.verifiedPrefixLength,
        signal: entry.controller.signal,
        source: `task:${taskId.slice(0, 8)}`,
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (!message.includes('abort')) {
        console.error(`[TerminalSubmitScheduler] Burst failed for task ${taskId.slice(0, 8)}: ${message}`);
      }
    }

    // The burst slot is still ours - check for a queued follow-up before
    // releasing the slot to a future scheduleKeystrokes call.
    const current = this.active.get(taskId);
    if (current === entry && entry.next) {
      const queued = entry.next;
      entry.next = null;
      // Recurse into a fresh AbortController so the new burst is
      // independently cancellable.
      const next: ActiveBurst = { controller: new AbortController(), next: null };
      this.active.set(taskId, next);
      void this.runBurst(taskId, sessionId, queued.commands, queued.opts, next);
      return;
    }
    if (current === entry) {
      this.active.delete(taskId);
    }
  }

  /**
   * Wait for the CLI to come alive (via `'thinking'` event from adapter
   * hooks) before starting the burst. 30s fallback covers adapters with no
   * thinking-state hook; `timeoutMs` hard cap covers truly hung sessions.
   */
  private scheduleDeferred(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions,
    isQueued: boolean,
  ): void {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let state: 'queued' | 'waiting' = isQueued ? 'queued' : 'waiting';
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const hardTimer = setTimeout(() => {
      console.warn(`[TerminalSubmitScheduler] Hard timeout (${timeoutMs}ms) for task ${taskId.slice(0, 8)} -- cancelling`);
      this.cancel(taskId);
    }, timeoutMs);

    const startFallbackTimer = (): void => {
      if (fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        if (!this.deferred.has(taskId)) return;
        console.log(`[TerminalSubmitScheduler] 30s fallback for task ${taskId.slice(0, 8)} -- delivering anyway`);
        detachAndDeliver();
      }, 30_000);
    };

    const detachAndDeliver = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('session-changed', onSessionChanged);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
      this.deferred.delete(taskId);
      // Hand off to the active-burst path. If somehow another burst was
      // started for this task while we were waiting (unlikely - fresh-spawn
      // is exclusive), startBurst's caller handled the conflict.
      this.startBurst(taskId, sessionId, commands, opts);
    };

    const onActivity = (evtSessionId: string, activityState: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.deferred.has(taskId)) return;
      if (state === 'waiting' && activityState === 'thinking') {
        detachAndDeliver();
      }
    };

    const onSessionChanged = (evtSessionId: string, evtSession: { status: string }): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.deferred.has(taskId)) return;
      if (state === 'queued' && evtSession.status === 'running') {
        state = 'waiting';
        startFallbackTimer();
      }
    };

    const onExit = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.deferred.has(taskId)) return;
      console.log(`[TerminalSubmitScheduler] Session ${sessionId.slice(0, 8)} exited -- cancelling injection for task ${taskId.slice(0, 8)}`);
      this.cancel(taskId);
    };

    this.sessionManager.on('activity', onActivity);
    this.sessionManager.on('session-changed', onSessionChanged);
    this.sessionManager.on('exit', onExit);

    if (!isQueued) {
      startFallbackTimer();
    }

    const cleanup = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('session-changed', onSessionChanged);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
    };

    this.deferred.set(taskId, { cleanup });
  }
}
