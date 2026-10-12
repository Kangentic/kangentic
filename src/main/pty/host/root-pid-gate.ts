/**
 * Holds a new PTY's events until its spawn has been answered with a real pid.
 *
 * node-pty 1.2 starts a ConPTY's process from its conout worker's ready
 * callback (microsoft/node-pty#763), so on Windows `IPty.pid` is 0 when
 * `spawn()` returns. node-pty sets it when the output pipe connects, which is
 * before the first output chunk. Measured on node-pty 1.2.0-beta.15 under
 * Electron 44 (`scripts/probe-conpty-exit-race.js --mode pid`): 0 at the
 * return, set 155 ms later, first output at 196 ms. node-pty 1.1.0 had it at
 * the return.
 *
 * Main takes the pid from the spawn answer and keeps it: the quit drain probes
 * it, a host loss stops the PTY's tree by it, the background-shell watcher
 * walks from it. So the host answers such a spawn only once the pid is set,
 * and holds the PTY's output and exit until the answer has gone out, so main
 * has its handle before any event for the PTY arrives.
 *
 * A PTY that exits while its pid is still 0 never started a process. node-pty
 * reports CreateProcessW's failure, or its own 5 s connect timeout, as an exit
 * carrying the error code. That spawn is answered as failed, the way node-pty
 * 1.1.0 threw it.
 */

/** How often the pid is read while no output has arrived to prompt a read. */
export const ROOT_PID_POLL_MS = 10;

/**
 * Backstop only. node-pty's own connect timeout (5 s) ends a PTY that never
 * connects with an exit well before this, and that exit answers the spawn.
 *
 * Reaching it answers the spawn as started, with pid 0, and logs. Answering it
 * as failed was the alternative, and it would leave a running PTY nobody holds:
 * the host cannot end it, because node-pty runs kill() only after the PTY's
 * first output, which such a PTY has not produced.
 */
export const ROOT_PID_WAIT_LIMIT_MS = 10_000;

export type RootPidOutcome =
  | { kind: 'started' }
  | { kind: 'failed'; exitCode: number }
  | { kind: 'timedOut' };

/** The error a spawn is answered with when its process never started. */
export function processNotStartedError(exitCode: number): Error {
  // node-pty 1.1.0's own text for this failure, so the spawn-failure path and
  // its grouping in error reports read the same as before.
  return new Error(`Cannot create process, error code: ${exitCode}`);
}

export class RootPidGate {
  /** Settles once: the pid is set, the PTY exited first, or the backstop ran out. */
  readonly outcome: Promise<RootPidOutcome>;
  private settle: (outcome: RootPidOutcome) => void = () => undefined;
  private settled = false;
  private held: Array<() => void> | null = [];
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly limitTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly pty: { readonly pid: number }) {
    this.outcome = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.pollTimer = setInterval(() => this.readPid(), ROOT_PID_POLL_MS);
    this.limitTimer = setTimeout(() => this.finish({ kind: 'timedOut' }), ROOT_PID_WAIT_LIMIT_MS);
    this.pollTimer.unref?.();
    this.limitTimer.unref?.();
  }

  /**
   * `handle` for the PTY's output, held while the answer is pending. By the
   * first chunk, node-pty has set the pid. Once released it is a null check
   * per chunk, with no allocation.
   */
  gateOutput(handle: (data: string) => void): (data: string) => void {
    return (data) => {
      if (!this.held) {
        handle(data);
        return;
      }
      this.held.push(() => handle(data));
      this.readPid();
    };
  }

  /** `handle` for the PTY's exit, held the same way. An exit while the pid is still 0 means nothing started. */
  gateExit(handle: (exitCode: number, signal: number | undefined) => void): (exitCode: number, signal: number | undefined) => void {
    return (exitCode, signal) => {
      if (!this.held) {
        handle(exitCode, signal);
        return;
      }
      this.held.push(() => handle(exitCode, signal));
      if (!this.readPid()) this.finish({ kind: 'failed', exitCode });
    };
  }

  /**
   * The spawn has been answered. Run what was held, in order, on the next
   * macrotask. The answer goes out in the request's microtask continuation
   * (`pty-host-entry.ts`), so it always lands first. Events arriving before
   * then are held too, and the drain below is synchronous, so none can slip in
   * between the held ones.
   *
   * A handler that throws does not stop the ones after it. The exit is usually
   * last, and without it the PTY would never leave the host's table and main
   * would never hear that it ended. The first error is thrown once all have
   * run, so it still surfaces as it would from node-pty's own emitter.
   */
  release(): void {
    setImmediate(() => {
      const held = this.held ?? [];
      this.held = null;
      const errors: unknown[] = [];
      for (const handle of held) {
        try {
          handle();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    });
  }

  /** The spawn failed: nothing held is handled. */
  discard(): void {
    this.held = null;
  }

  private readPid(): boolean {
    if (this.pty.pid <= 0) return false;
    this.finish({ kind: 'started' });
    return true;
  }

  private finish(outcome: RootPidOutcome): void {
    if (this.settled) return;
    this.settled = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.limitTimer);
    this.settle(outcome);
  }
}
