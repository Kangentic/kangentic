/**
 * Keeps browser sign-ins from lapsing while the app is open.
 *
 * Each provider renews a sign-in only when an import reads from it, and a
 * refresh token nobody uses expires on the provider's clock (Linear's after 30
 * days, Atlassian's after 90). This pass asks every adapter that has one to renew
 * what is due, shortly after launch and then once a day. The adapter decides what
 * is due and how to renew it (`BoardAdapter.keepSignInAlive`), so nothing here
 * names a provider.
 *
 * A pass costs nothing for a user with no browser sign-in: each adapter reads its
 * own credential file and returns. With one, it is a single token request per
 * sign-in older than `SIGN_IN_RENEWAL_AFTER_MS`.
 *
 * Both timers are `.unref()`'d so they never hold a quit open, and shutdown
 * clears them (`.claude/rules/synchronous-shutdown.md`).
 */

import { createChokepointReporter } from '../analytics/handled-report';
import type { BoardAdapter } from './shared';
import { boardRegistry } from './board-registry';

/** Long enough after launch that the pass never competes with startup or the first import. */
export const KEEP_ALIVE_FIRST_PASS_DELAY_MS = 2 * 60_000;

/** A day: a sign-in is due at seven days old, so a daily look catches it with weeks to spare. */
export const KEEP_ALIVE_PASS_INTERVAL_MS = 24 * 60 * 60_000;

const keepAliveReporter = createChokepointReporter('board-sign-in-keep-alive');

/**
 * Ask each adapter to renew its due sign-ins, one provider at a time. One
 * provider failing never stops the next: its failure is reported (a refusal, an
 * outage and the network are filtered as expected) and the pass goes on.
 */
export async function runSignInKeepAlivePass(adapters: BoardAdapter[] = boardRegistry.list()): Promise<void> {
  for (const adapter of adapters) {
    if (!adapter.keepSignInAlive) continue;
    try {
      await adapter.keepSignInAlive();
    } catch (error) {
      keepAliveReporter.report(error, { tags: { provider: adapter.id } });
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

function arm(delayMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    void runSignInKeepAlivePass().finally(() => {
      if (running) arm(KEEP_ALIVE_PASS_INTERVAL_MS);
    });
  }, delayMs);
  timer.unref();
}

export const signInKeepAlive = {
  /** Arm the first pass. A second call while running changes nothing. */
  start(): void {
    if (running) return;
    running = true;
    arm(KEEP_ALIVE_FIRST_PASS_DELAY_MS);
  },

  /** Clear the pending pass. A pass already under way finishes and does not re-arm. */
  stop(): void {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  },
};

/** Test-only: forget the reporter's latch between cases. */
export function resetSignInKeepAliveForTests(): void {
  signInKeepAlive.stop();
  keepAliveReporter.reset();
}
