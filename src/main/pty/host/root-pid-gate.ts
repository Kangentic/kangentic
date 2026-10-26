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
 * reports CreateProcessW's failure as an exit carrying its Win32 code (2, 5,
 * 193), and that spawn is answered as failed, the way node-pty 1.1.0 threw it.
 *
 * An exit carrying -1 is different: the output connection never came up, so
 * CreateProcessW never ran (`WindowsPtyAgent._failPtyConnection`). Its cause is
 * node-pty's own connect timeout or its conout worker's error, and node-pty has
 * already closed the pseudoconsole. On a machine too busy to answer in 5 s
 * (Sentry DESKTOP-23) the host spawns such a PTY once more (`retryWindowMs`)
 * before it answers.
 */

/** How often the pid is read while no output has arrived to prompt a read. */
export const ROOT_PID_POLL_MS = 10;

/**
 * node-pty's `CONNECTION_TIMEOUT` (`windowsPtyAgent.js`): how long it waits
 * for the conout worker before it fails the PTY with -1. `WindowsTerminal`
 * builds its agent without options, so it cannot be raised.
 */
export const NODE_PTY_CONNECT_TIMEOUT_MS = 5_000;

/**
 * How long main waits for the host to answer a spawn or a raw spawn
 * (`PtyHostClient`). The retry window below is sized against it, so both
 * attempts answer before main gives up and kills the ptyId.
 */
export const SPAWN_REQUEST_TIMEOUT_MS = 15_000;

/** Kept back from main's budget for the answer's trip to main. */
export const SPAWN_ANSWER_MARGIN_MS = 1_000;

/**
 * The shortest window a retry is started with: node-pty's full connect timeout
 * and a second. A shorter one would let the gate's backstop race node-pty's
 * own timer and answer "started, pid 0" for a PTY about to fail.
 */
export const SPAWN_RETRY_MIN_WINDOW_MS = NODE_PTY_CONNECT_TIMEOUT_MS + 1_000;

/** The exit code node-pty gives a PTY whose output connection never came up. */
export const OUTPUT_NOT_CONNECTED_EXIT_CODE = -1;

/** The `code` of the error such a spawn is answered with. It crosses to main on `PtyHostError.code`. */
export const PTY_OUTPUT_NOT_CONNECTED_CODE = 'PTY_OUTPUT_NOT_CONNECTED';

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

/**
 * The error a spawn is answered with when its process never started.
 * `elapsedMs` is the attempt's time from its spawn: about 5000 is node-pty's
 * connect timeout, a fast failure is the conout worker's own error.
 * `longestStallMs` is the gate's `longestStallMs`, which tells a held host
 * loop from a late worker.
 */
export function processNotStartedError(exitCode: number, elapsedMs: number, longestStallMs: number): Error {
  if (exitCode === OUTPUT_NOT_CONNECTED_EXIT_CODE) {
    const error: NodeJS.ErrnoException = new Error(`Terminal output never connected after ${elapsedMs} ms, longest pty host stall ${longestStallMs} ms (ConPTY error code: -1)`);
    error.code = PTY_OUTPUT_NOT_CONNECTED_CODE;
    return error;
  }
  // node-pty 1.1.0's own text for a CreateProcessW failure, so logs and the
  // error report's title read the same as before.
  return new Error(`Cannot create process, error code: ${exitCode}`);
}

/**
 * The backstop a retry's gate gets, or null when there is no time for one.
 * `elapsedMs` runs from main's send of the request: the time it waited for the
 * host's loop, then the first attempt's. The window is what is left of main's
 * budget less the answer's margin, so the retry answers before main gives up;
 * a first attempt that ran node-pty's full timeout straight away leaves 9 s.
 * Past 8 s there is no full connect timeout left, and no retry. A third attempt
 * never fits. A loop held during the retry runs its gate's timer late, and
 * that answer can still miss main's budget; main then fails the spawn.
 */
export function retryWindowMs(elapsedMs: number): number | null {
  const windowMs = Math.min(ROOT_PID_WAIT_LIMIT_MS, SPAWN_REQUEST_TIMEOUT_MS - SPAWN_ANSWER_MARGIN_MS - elapsedMs);
  return windowMs >= SPAWN_RETRY_MIN_WINDOW_MS ? windowMs : null;
}

export class RootPidGate {
  /** Settles once: the pid is set, the PTY exited first, or the backstop ran out. */
  readonly outcome: Promise<RootPidOutcome>;
  /**
   * The longest the host's event loop went between two of this gate's turns
   * (each 10 ms poll, and the exit) while the spawn waited. A stall past
   * node-pty's 5 s timeout says the timeout may have fired only because the
   * loop was held, with the conout worker's ready message still unread; a
   * short one says the worker itself was late (Sentry DESKTOP-23).
   */
  longestStallMs = 0;
  private lastTurnAtMs = Date.now();
  private settle: (outcome: RootPidOutcome) => void = () => undefined;
  private settled = false;
  private held: Array<() => void> | null = [];
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly limitTimer: ReturnType<typeof setTimeout>;

  /** `limitMs` is the backstop; a retry passes the time it has left (`retryWindowMs`). */
  constructor(private readonly pty: { readonly pid: number }, limitMs: number = ROOT_PID_WAIT_LIMIT_MS) {
    this.outcome = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.pollTimer = setInterval(() => {
      this.noteTurn();
      this.readPid();
    }, ROOT_PID_POLL_MS);
    this.limitTimer = setTimeout(() => this.finish({ kind: 'timedOut' }), limitMs);
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
      if (this.settled) return;
      this.noteTurn();
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

  /** Measure the gap since the gate's last turn, while the spawn still waits. */
  private noteTurn(): void {
    const now = Date.now();
    this.longestStallMs = Math.max(this.longestStallMs, now - this.lastTurnAtMs);
    this.lastTurnAtMs = now;
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
