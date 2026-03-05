import type { SessionManager } from '../pty/session-manager';
import { sanitizeForPty } from '../../shared/paths';

/**
 * Tracks a pending auto-command injection for a single task.
 * Contains the cleanup function that removes all event listeners and timers.
 */
interface PendingInjection {
  cleanup: () => void;
}

/**
 * CommandInjector schedules and delivers auto-commands to PTY sessions.
 *
 * When a task moves into a column with an `auto_command`, the injector writes
 * the command text into the running terminal. It handles three scenarios:
 *
 * 1. **Existing session** — injects immediately (Ctrl+C to clear input first)
 * 2. **Freshly spawned session** — waits for first `thinking` event (CLI alive)
 * 3. **Queued session** — waits for `status:running`, then applies fresh logic
 *
 * The injector is keyed by taskId so rapid moves cancel previous injections.
 * All state is in-memory — no persistence needed (event-based, not recoverable).
 */
export class CommandInjector {
  private pending = new Map<string, PendingInjection>();

  constructor(private sessionManager: SessionManager) {}

  /**
   * Schedule an auto-command for delivery to a PTY session.
   *
   * @param taskId      - Task ID (used as map key; re-scheduling cancels previous)
   * @param sessionId   - Target session ID
   * @param command     - Already-interpolated command text (e.g. "/test" or "review the code")
   * @param opts.freshlySpawned - True if session was just spawned (wait for CLI startup)
   * @param opts.timeoutMs      - Hard timeout before giving up (default 120_000ms)
   */
  schedule(
    taskId: string,
    sessionId: string,
    command: string,
    opts?: { freshlySpawned?: boolean; timeoutMs?: number },
  ): void {
    // Cancel any existing injection for this task
    this.cancel(taskId);

    const freshlySpawned = opts?.freshlySpawned ?? false;
    const timeoutMs = opts?.timeoutMs ?? 120_000;

    // Check if session exists and has a live PTY
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[AUTO_COMMAND] No session ${sessionId.slice(0, 8)} -- skipping`);
      return;
    }

    // Existing session (not freshly spawned) — inject immediately
    if (!freshlySpawned) {
      this.deliver(sessionId, taskId, command, true);
      return;
    }

    // Queued or freshly spawned — need to wait for CLI to be alive
    const isQueued = session.status === 'queued';
    this.scheduleDeferred(taskId, sessionId, command, isQueued, timeoutMs);
  }

  /** Cancel a pending injection for a specific task. */
  cancel(taskId: string): void {
    const entry = this.pending.get(taskId);
    if (entry) {
      this.pending.delete(taskId);
      entry.cleanup();
    }
  }

  /** Cancel all pending injections. Called on killAll/suspendAll. */
  cancelAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
    }
  }

  /**
   * Handle deferred injection for freshly spawned or queued sessions.
   * Waits for the CLI to start (via 'thinking' event from hooks) before injecting.
   */
  private scheduleDeferred(
    taskId: string,
    sessionId: string,
    command: string,
    isQueued: boolean,
    timeoutMs: number,
  ): void {
    let state: 'queued' | 'waiting' = isQueued ? 'queued' : 'waiting';

    // --- Timers ---
    // 30s fallback: if hooks never fire, inject anyway (CLI should be running by then)
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    // Hard timeout: ultimate safety net
    const hardTimer = setTimeout(() => {
      console.warn(`[AUTO_COMMAND] Hard timeout (${timeoutMs}ms) for task ${taskId.slice(0, 8)} -- cancelling`);
      this.cancel(taskId);
    }, timeoutMs);

    const startFallbackTimer = (): void => {
      if (fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        if (!this.pending.has(taskId)) return;
        console.log(`[AUTO_COMMAND] 30s fallback for task ${taskId.slice(0, 8)} -- injecting`);
        detachAndDeliver();
      }, 30_000);
    };

    // Detach all event listeners and timers, then deliver the command.
    // deliver() sets a new pending entry that tracks the submit timers.
    const detachAndDeliver = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('status', onStatus);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
      this.deliver(sessionId, taskId, command, false);
    };

    // --- Event listeners ---
    const onActivity = (evtSessionId: string, activityState: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.pending.has(taskId)) return;

      if (state === 'waiting' && activityState === 'thinking') {
        // CLI is alive — detach listeners and deliver command
        detachAndDeliver();
      }
    };

    const onStatus = (evtSessionId: string, status: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.pending.has(taskId)) return;

      if (state === 'queued' && status === 'running') {
        // Session started — transition to waiting for CLI startup
        state = 'waiting';
        startFallbackTimer();
      }
    };

    const onExit = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.pending.has(taskId)) return;

      console.log(`[AUTO_COMMAND] Session ${sessionId.slice(0, 8)} exited -- cancelling injection for task ${taskId.slice(0, 8)}`);
      this.cancel(taskId);
    };

    // --- Attach listeners ---
    this.sessionManager.on('activity', onActivity);
    this.sessionManager.on('status', onStatus);
    this.sessionManager.on('exit', onExit);

    // Start fallback timer immediately if not queued (already running)
    if (!isQueued) {
      startFallbackTimer();
    }

    const cleanup = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('status', onStatus);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
    };

    this.pending.set(taskId, { cleanup });
  }

  /**
   * Deliver a command to a PTY session using separate writes with delays.
   *
   * Sends each part (text, Escape, Enter) as individual pty.write() calls
   * so Ink processes them as separate keypresses rather than a single paste.
   * Escape dismisses any autocomplete popup before Enter submits.
   *
   * Sequence: [Ctrl+C] → 150ms → [command text] → 100ms → [Escape] → 100ms → [Enter]
   *
   * @param sendCtrlC - Send Ctrl+C first to clear existing input / interrupt thinking
   */
  private deliver(sessionId: string, taskId: string, command: string, sendCtrlC: boolean): void {
    const sanitized = this.sanitize(command);
    if (!sanitized) {
      this.pending.delete(taskId);
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    let delay = 0;

    // Optional: Ctrl+C to clear existing input / interrupt thinking
    if (sendCtrlC) {
      this.sessionManager.write(sessionId, '\x03');
      delay = 150;
    }

    // Type the command text
    timers.push(setTimeout(() => {
      this.sessionManager.write(sessionId, sanitized);
    }, delay));
    delay += 100;

    // Escape to dismiss autocomplete
    timers.push(setTimeout(() => {
      this.sessionManager.write(sessionId, '\x1b');
    }, delay));
    delay += 100;

    // Enter to submit
    timers.push(setTimeout(() => {
      this.sessionManager.write(sessionId, '\r');
      this.pending.delete(taskId);
      console.log(`[AUTO_COMMAND] Delivered to session ${sessionId.slice(0, 8)} for task ${taskId.slice(0, 8)}`);
    }, delay));

    this.pending.set(taskId, {
      cleanup: () => {
        for (const t of timers) clearTimeout(t);
        this.pending.delete(taskId);
      },
    });
  }

  /**
   * Strip control characters from interpolated command text.
   * Newlines in a task title could prematurely submit a partial command.
   */
  private sanitize(command: string): string {
    return sanitizeForPty(command);
  }
}
