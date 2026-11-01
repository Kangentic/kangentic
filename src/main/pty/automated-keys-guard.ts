import type { SessionManager } from './session-manager';

/**
 * The one gate every automated keystroke passes before it is typed: a column
 * message, a workflow nudge, a paste's Enter, an agent's `now` send.
 *
 * A permission prompt takes typed keys as its answer, so an automated Enter
 * approves a tool call nobody saw. The guard used to be the activity engine's
 * `permission` state alone. A parallel subagent's start cleared that state 4 ms
 * after a prompt opened, the stale-thinking watchdog then committed idle, and
 * a recovery nudge typed into the still-open prompt and approved it. So the
 * guard also refuses while a tool call has no end in the session's hook events
 * (`SessionManager.automatedKeysBlocker`, `open-work-ledger.ts`).
 *
 * The cost is deliberate: a message meant for a running agent waits while a
 * foreground tool runs, and goes in between tool calls instead.
 */

export type AutomatedKeysWait = 'clear' | 'timeout' | 'exited' | 'aborted';

/**
 * A delivery whose Enter landed on a permission prompt the app had not heard
 * of yet, so it may have answered it (`SubmitKeystrokesResult.reachedPermissionPrompt`).
 * Its own error so a caller records it as its own outcome, not as a message
 * that failed to arrive.
 */
export class KeysReachedPermissionPromptError extends Error {
  constructor() {
    super('The keys reached a permission prompt, so they may have answered it.');
    this.name = 'KeysReachedPermissionPromptError';
  }
}

/** Sessions whose current refusal was already logged, keyed by its reason. */
const loggedRefusals = new Map<string, string>();

/**
 * Log a refusal once per session and reason, so a stuck entry shows up in the
 * log without a line per check.
 */
function logRefusal(sessionId: string, reason: string, source: string): void {
  if (loggedRefusals.get(sessionId) === reason) return;
  loggedRefusals.set(sessionId, reason);
  console.log(`[automated-keys] ${source}: holding keys for session ${sessionId.slice(0, 8)}: ${reason}`);
}

/** Why the session may not take automated keys now, or null. Logs a refusal once. */
export function automatedKeysRefusal(sessionManager: SessionManager, sessionId: string, source: string): string | null {
  const reason = sessionManager.automatedKeysBlocker(sessionId);
  if (reason) logRefusal(sessionId, reason, source);
  else loggedRefusals.delete(sessionId);
  return reason;
}

/**
 * Wait until the session may take automated keys. Re-checks on every event
 * and activity change of the session, so it resolves the moment the open call
 * ends. Never types anything itself.
 */
export function waitForAutomatedKeysClearance(
  sessionManager: SessionManager,
  sessionId: string,
  options: { signal?: AbortSignal; timeoutMs: number; source: string },
): Promise<AutomatedKeysWait> {
  if (options.signal?.aborted) return Promise.resolve('aborted');
  if (automatedKeysRefusal(sessionManager, sessionId, options.source) === null) return Promise.resolve('clear');
  return new Promise<AutomatedKeysWait>((resolve) => {
    let settled = false;
    const finish = (result: AutomatedKeysWait): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sessionManager.off('event', onEvent);
      sessionManager.off('activity', onActivity);
      sessionManager.off('exit', onExit);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const recheck = (): void => {
      if (automatedKeysRefusal(sessionManager, sessionId, options.source) === null) finish('clear');
    };
    const onEvent = (eventSessionId: string): void => {
      if (eventSessionId === sessionId) recheck();
    };
    const onActivity = (activitySessionId: string): void => {
      if (activitySessionId === sessionId) recheck();
    };
    const onExit = (exitSessionId: string): void => {
      if (exitSessionId === sessionId) finish('exited');
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), options.timeoutMs);
    timer.unref?.();
    sessionManager.on('event', onEvent);
    sessionManager.on('activity', onActivity);
    sessionManager.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How often a hold that has not cleared says so in the log. */
export const AUTOMATED_KEYS_HOLD_LOG_MS = 10 * 60_000;

/**
 * Wait until the session may take automated keys, however long that takes. A
 * message for an agent busy in a long foreground tool call (a 15-minute test
 * run) goes once the call ends; an earlier 10-minute bound dropped it as "Not
 * sent", where before the guard the CLI took it after the tool. Ends early only
 * when the session exits or `signal` aborts (a move superseded the delivery).
 * Says in the log every `logEveryMs` that it still holds, and why.
 */
export async function waitUntilAutomatedKeysClear(
  sessionManager: SessionManager,
  sessionId: string,
  options: { signal?: AbortSignal; source: string; logEveryMs?: number },
): Promise<Exclude<AutomatedKeysWait, 'timeout'>> {
  const startedAt = Date.now();
  for (;;) {
    const result = await waitForAutomatedKeysClearance(sessionManager, sessionId, {
      signal: options.signal,
      timeoutMs: options.logEveryMs ?? AUTOMATED_KEYS_HOLD_LOG_MS,
      source: options.source,
    });
    if (result !== 'timeout') return result;
    const minutes = Math.round((Date.now() - startedAt) / 60_000);
    const reason = sessionManager.automatedKeysBlocker(sessionId) ?? 'it cannot take keys';
    console.log(`[automated-keys] ${options.source}: still holding keys for session ${sessionId.slice(0, 8)} after ${minutes} min: ${reason}`);
  }
}

/** The session exited: its logged refusal goes with it (`SessionManager`'s exit). */
export function forgetAutomatedKeysSession(sessionId: string): void {
  loggedRefusals.delete(sessionId);
}

/** Test-only: forget which refusals were logged. */
export function resetAutomatedKeysGuardForTests(): void {
  loggedRefusals.clear();
}
