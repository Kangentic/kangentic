/**
 * Whether the launch has settled: the window has loaded, the open project's
 * recovery has handed its agents to the session manager, and no agent has
 * started for a while.
 *
 * Background work that starts processes waits for this. Before it existed each
 * piece ran on its own fixed timer (20 s for the account usage pass, 5 s for
 * the other projects' recovery), and the agent inventory probed every CLI the
 * moment the renderer mounted, so all of it landed on the seconds in which the
 * resumed agents were starting. Measured in a preview with six agents resuming,
 * over five launches: `agent:list` ran for 19 to 22 s, and a key typed into a
 * resumed agent while it ran took up to 6.4 s to echo.
 *
 * Settled by default. Only main's entry point calls `beginBoot`, so a unit
 * test, the pty host and the retrieval worker, which never do, read "settled"
 * and wait for nothing.
 */

/** No sooner than this after the window loaded, so a board with nothing to resume still gets its first paint clear. */
export const BOOT_SETTLE_FLOOR_MS = 15_000;
/** How long after the last agent start the launch counts as quiet. A resumed Claude draws within a few seconds of its start. */
export const BOOT_SETTLE_QUIET_MS = 10_000;
/** Settled by now whatever happened: a recovery pass that hangs must not hold the usage pass or the inventory refresh for good. */
export const BOOT_SETTLE_CAP_MS = 90_000;

/** What ended the wait. */
export type BootSettleReason = 'quiet' | 'cap';

interface BootState {
  startedAt: number;
  windowLoadedAt: number | null;
  lastAgentStartAt: number | null;
  pendingWork: number;
  quietTimer: ReturnType<typeof setTimeout> | null;
  capTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  /** The app is quitting: nothing settles this launch any more. */
  disposed: boolean;
  waiters: Array<() => void>;
}

let boot: BootState | null = null;

function settle(state: BootState, reason: BootSettleReason): void {
  if (state.settled) return;
  state.settled = true;
  if (state.quietTimer) clearTimeout(state.quietTimer);
  if (state.capTimer) clearTimeout(state.capTimer);
  state.quietTimer = null;
  state.capTimer = null;
  console.log(`[BOOT] settled after ${Date.now() - state.startedAt} ms (${reason})`);
  const waiters = state.waiters;
  state.waiters = [];
  for (const resolve of waiters) resolve();
}

function evaluate(state: BootState): void {
  if (state.settled || state.disposed) return;
  if (state.quietTimer) clearTimeout(state.quietTimer);
  state.quietTimer = null;
  // Until the window loads and the tracked work returns, only the cap can settle it.
  if (state.windowLoadedAt === null || state.pendingWork > 0) return;
  const floorAt = state.windowLoadedAt + BOOT_SETTLE_FLOOR_MS;
  const quietAt = state.lastAgentStartAt === null ? 0 : state.lastAgentStartAt + BOOT_SETTLE_QUIET_MS;
  const settleAt = Math.max(floorAt, quietAt);
  const remainingMs = settleAt - Date.now();
  if (remainingMs <= 0) {
    settle(state, 'quiet');
    return;
  }
  state.quietTimer = setTimeout(() => evaluate(state), remainingMs);
  state.quietTimer.unref?.();
}

/** Start tracking this launch. Called once, before anything can spawn; a second call changes nothing. */
export function beginBoot(): void {
  if (boot) return;
  const state: BootState = {
    startedAt: Date.now(),
    windowLoadedAt: null,
    lastAgentStartAt: null,
    pendingWork: 0,
    quietTimer: null,
    capTimer: null,
    settled: false,
    disposed: false,
    waiters: [],
  };
  state.capTimer = setTimeout(() => settle(state, 'cap'), BOOT_SETTLE_CAP_MS);
  state.capTimer.unref?.();
  boot = state;
}

/** The window finished loading. A rebuilt window later in the run changes nothing. */
export function noteWindowLoaded(): void {
  if (!boot || boot.settled || boot.windowLoadedAt !== null) return;
  boot.windowLoadedAt = Date.now();
  evaluate(boot);
}

/** Launch work that starts agents: the launch cannot settle before it returns, however it ends. */
export function trackBootWork(work: Promise<unknown>): void {
  const state = boot;
  if (!state || state.settled) return;
  state.pendingWork += 1;
  const done = (): void => {
    state.pendingWork -= 1;
    evaluate(state);
  };
  // report-ok: the launch settles however the work ended. Neither caller passes a promise that
  // rejects: the cold open reports through reportRecoveryPassFailure first, and the background
  // activation's promise only resolves.
  work.then(done, done);
}

/** An agent is starting or has just drawn its first output: the quiet period starts over. */
export function noteAgentStarting(): void {
  if (!boot || boot.settled) return;
  boot.lastAgentStartAt = Date.now();
  evaluate(boot);
}

export function isBootSettled(): boolean {
  return boot === null || boot.settled;
}

/** Resolves once the launch has settled, at once when it already has. Never rejects. */
export function whenBootSettled(): Promise<void> {
  const state = boot;
  if (!state || state.settled) return Promise.resolve();
  return new Promise((resolve) => {
    // After a dispose nothing resolves a waiter, so none is kept.
    if (!state.disposed) state.waiters.push(resolve);
  });
}

/**
 * Synchronous, for the quit path: clears the timers and drops the waiters
 * unresolved, so nothing that waited for the launch starts during a quit. An
 * agent start or tracked work that lands afterwards arms no timer again.
 */
export function disposeBootSettle(): void {
  if (!boot) return;
  boot.disposed = true;
  if (boot.quietTimer) clearTimeout(boot.quietTimer);
  if (boot.capTimer) clearTimeout(boot.capTimer);
  boot.quietTimer = null;
  boot.capTimer = null;
  boot.waiters = [];
}

/** Tests only: back to no launch tracked, which reads as settled. */
export function resetBootSettleForTests(): void {
  disposeBootSettle();
  boot = null;
}
