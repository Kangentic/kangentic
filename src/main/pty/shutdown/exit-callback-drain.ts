/**
 * Bounded drain of node-pty exit callbacks, run between the synchronous
 * shutdown cleanup and the moment Electron is allowed to tear Node down.
 *
 * Why it exists (Sentry DESKTOP-C, symbolicated against node-pty's shipped
 * conpty.pdb): node-pty delivers a PTY's exit through a native
 * `Napi::ThreadSafeFunction`. A thread waits for the child process to die,
 * then queues a main-thread call of node-pty's JS exit handler. If that call
 * is first dispatched after `node::Stop()` (Electron's
 * `PostMainMessageLoopRun` stops Node, then `FreeEnvironment` runs the libuv
 * loop once more to close handles), `napi_call_function` is refused, node-addon-api
 * throws a C++ `Napi::Error`, and its catch block's `ThrowAsJavaScriptException`
 * is refused too, so a second C++ exception escapes from inside a catch block
 * and the process dies with an unhandled C++ exception. No JS frame is below
 * that dispatch, so nothing in this codebase can catch it, and Kangentic ships
 * node-pty's prebuilt binary, which lacks NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS.
 * VS Code carries the same open crash on macOS (microsoft/vscode#243952).
 *
 * The synchronous cleanup kills every PTY, so every quit with a live session
 * races that dispatch against the message loop quitting. This drain removes
 * the race from the app side: it keeps the loop alive, timer-only, until each
 * killed child's pid is gone plus a few more loop turns for the queued
 * callback to be dispatched while JS is still callable. Deadline-bounded, no
 * network, no PTY output, no IPC; the caller then re-issues `app.quit()`.
 * Not killing the PTYs is not an option: the same ThreadSafeFunction's
 * finalizer joins the waiting thread, so an un-killed child would hang
 * Electron's teardown until the hard failsafe fires.
 *
 * The pid probe is the right signal on both platforms. On Windows
 * `process.kill(pid, 0)` throws ESRCH the instant the process object is
 * signalled, which is when node-pty's thread wakes from WaitForSingleObject.
 * On POSIX it throws ESRCH only once the zombie has been reaped, which
 * node-pty's thread does with waitpid right before queuing the callback.
 *
 * A kill whose child pid was unreadable has no probe at all, so the drain
 * cannot wait for that child to be gone and spends a fixed budget instead
 * (PTY_EXIT_DRAIN_BLIND_SETTLE_TICKS). Dropping such a kill from the report is
 * what used to disarm the whole drain for the entire shutdown: an empty pid
 * list read as "no PTY was killed" rather than "no PTY could be named". See
 * PtyKillReport in session-shutdown.ts for why no production path produces one
 * today.
 */

export const PTY_EXIT_DRAIN_POLL_MS = 25;
/** Loop turns to allow after the last child is gone: the exit thread's
 *  BlockingCall lands on the libuv async handle, which the next loop
 *  iteration dispatches. Four ticks (100ms) leaves margin for a busy box. */
export const PTY_EXIT_DRAIN_SETTLE_TICKS = 4;
/** Settle ticks used instead when a kill had no readable child pid. With no
 *  liveness signal the countdown IS the whole wait, so it has to cover the
 *  child dying as well as the callback dispatching. Sixteen ticks is 400ms of
 *  countdown at the 25ms poll, 425ms end to end including the tick that arms
 *  it. The probed path measures 200ms to 220ms end to end for three Command
 *  Terminals, 100ms of which is its own settle, so observed death latency is
 *  about 100ms to 120ms; 400ms is roughly three times that plus the settle, and
 *  stays well inside both the 1500ms deadline and the 6000ms hard failsafe. */
export const PTY_EXIT_DRAIN_BLIND_SETTLE_TICKS = 16;
export const PTY_EXIT_DRAIN_DEADLINE_MS = 1500;

export interface PtyExitDrainOptions {
  /** Child pids of the PTYs the synchronous cleanup just killed. */
  pids: number[];
  /** Total PTYs the cleanup killed, including any whose child pid was
   *  unreadable. Defaults to the number of probe-able pids, which reproduces
   *  the pure-probe behavior. Anything above that count has no liveness signal
   *  and is drained blind on `blindSettleTicks`. */
  killedCount?: number;
  isProcessAlive: (pid: number) => boolean;
  pollIntervalMs?: number;
  settleTicks?: number;
  blindSettleTicks?: number;
  deadlineMs?: number;
  /** Defaults to console.log; the lines become Sentry console breadcrumbs. */
  log?: (line: string) => void;
}

export interface PtyExitDrainResult {
  timedOut: boolean;
  elapsedMs: number;
  /** Pids still alive at the deadline (empty on a clean drain). */
  lingeringPids: number[];
  /** Kills with no readable child pid, waited out on the blind budget rather
   *  than probed. A timeout with this above zero and no lingering pids is a
   *  blind budget that outran the deadline, not a child that would not die. */
  unprobedKillCount: number;
}

/**
 * Resolve once every pid is gone and `settleTicks` further polls have run,
 * or at `deadlineMs`, whichever comes first. A kill with no probe-able pid
 * replaces that settle with the longer `blindSettleTicks`, since there is no
 * liveness signal to wait on first. Never rejects: a probe that throws counts
 * as dead so the quit can never be held open by the drain. The timers are
 * deliberately not unref'd; keeping the loop alive is the point.
 */
export function drainPtyExitCallbacks(options: PtyExitDrainOptions): Promise<PtyExitDrainResult> {
  const pending = new Set(options.pids.filter((pid) => Number.isInteger(pid) && pid > 0));
  // Every kill the pid set cannot account for. Clamped at zero so a report
  // claiming fewer kills than pids drains normally rather than going blind.
  const unprobedKillCount = Math.max(0, (options.killedCount ?? pending.size) - pending.size);
  if (pending.size === 0 && unprobedKillCount === 0) {
    return Promise.resolve({
      timedOut: false,
      elapsedMs: 0,
      lingeringPids: [],
      unprobedKillCount: 0,
    });
  }

  const pollIntervalMs = options.pollIntervalMs ?? PTY_EXIT_DRAIN_POLL_MS;
  const settleTicks = options.settleTicks ?? PTY_EXIT_DRAIN_SETTLE_TICKS;
  const blindSettleTicks = options.blindSettleTicks ?? PTY_EXIT_DRAIN_BLIND_SETTLE_TICKS;
  // With an unprobed kill there is nothing to poll for, so the countdown IS the
  // whole wait and it has to be the longer, blind one. Probed pids alongside it
  // only push the countdown's start later, never shorten it.
  const effectiveSettleTicks = unprobedKillCount > 0 ? blindSettleTicks : settleTicks;
  const deadlineMs = options.deadlineMs ?? PTY_EXIT_DRAIN_DEADLINE_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = Date.now();
  log(`[SHUTDOWN] pty-drain:start n=${pending.size} blind=${unprobedKillCount}`);

  return new Promise((resolve) => {
    let settled = false;
    // -1 while pids are still being polled; counts down once the set is empty.
    let settleTicksRemaining = -1;
    let pollTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;

    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const elapsedMs = Date.now() - startedAt;
      const lingeringPids = [...pending];
      if (timedOut) {
        log(
          `[SHUTDOWN] pty-drain:timeout ${elapsedMs}ms `
          + `lingering=${lingeringPids.join(',')} blind=${unprobedKillCount}`,
        );
      } else {
        log(`[SHUTDOWN] pty-drain:done ${elapsedMs}ms`);
      }
      resolve({ timedOut, elapsedMs, lingeringPids, unprobedKillCount });
    };

    const probe = (pid: number): boolean => {
      try {
        return options.isProcessAlive(pid);
      } catch {
        return false;
      }
    };

    const tick = (): void => {
      if (settled) return;
      if (settleTicksRemaining < 0) {
        for (const pid of pending) {
          if (!probe(pid)) pending.delete(pid);
        }
        if (pending.size === 0) settleTicksRemaining = effectiveSettleTicks;
      } else {
        settleTicksRemaining -= 1;
      }
      if (settleTicksRemaining === 0) {
        finish(false);
        return;
      }
      pollTimer = setTimeout(tick, pollIntervalMs);
    };

    deadlineTimer = setTimeout(() => finish(true), deadlineMs);
    pollTimer = setTimeout(tick, pollIntervalMs);
  });
}
