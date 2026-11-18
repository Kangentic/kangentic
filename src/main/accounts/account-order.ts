import type { AgentAccount } from '../../shared/agent-accounts';
import type { RateLimitWindow } from '../../shared/types';
import { loginOf, oneRowPerLogin, sameLogin } from './account-identity';

/**
 * The agents with two or more accounts: the only ones whose usage is read on a schedule, and whose
 * homes are watched and compared with their rows.
 */
export function multiAccountAgents(accounts: readonly AgentAccount[]): Set<string> {
  const perAgent = new Map<string, number>();
  for (const account of accounts) perAgent.set(account.agent, (perAgent.get(account.agent) ?? 0) + 1);
  return new Set([...perAgent].filter(([, count]) => count >= 2).map(([agent]) => agent));
}

/**
 * Pure ordering rules for one agent's accounts (docs/integrations/accounts.md). No I/O, so they are unit-tested
 * against fixed clocks.
 */

/**
 * A window still counts until its reset passes; after that the CLI has not reported it again. A
 * window with no reset time (`resetsAt` 0, a CLI that reports none) never expires by the clock:
 * it counts until a later report replaces it.
 */
function liveWindows(account: AgentAccount, nowSeconds: number): RateLimitWindow[] {
  return (account.lastUsage ?? []).filter((limitWindow) => limitWindow.resetsAt <= 0 || limitWindow.resetsAt > nowSeconds);
}

/** An account that can take a new session: signed in with a plan, links in place, no full window. */
export function hasRoom(account: AgentAccount, nowSeconds: number): boolean {
  if (account.status !== 'ok') return false;
  return liveWindows(account, nowSeconds).every((window) => window.usedPercentage < 100);
}

/**
 * The reset that orders an account under Automatic: the longest window the CLI reports (7d weekly
 * before 5h session), because that is the allowance a reset hands back the most of. Null when the
 * account reports no live window.
 */
export function orderingReset(account: AgentAccount, nowSeconds: number): number | null {
  // A window with no reset time has nothing to order by.
  const windows = liveWindows(account, nowSeconds).filter((limitWindow) => limitWindow.resetsAt > 0);
  if (windows.length === 0) return null;
  const longest = windows.reduce((best, window) =>
    (window.windowDurationSeconds ?? 0) > (best.windowDurationSeconds ?? 0) ? window : best,
  );
  return longest.resetsAt;
}

/**
 * Automatic order: the account whose longest window resets soonest is #1, so an allowance is used
 * before it resets. Accounts with no reading keep their place after those with one; accounts that
 * cannot run go last, in their current order.
 */
export function automaticOrder(accounts: readonly AgentAccount[], nowSeconds: number): AgentAccount[] {
  const byPosition = [...accounts].sort((left, right) => left.position - right.position);
  // One login counts once: a second row naming a login an earlier one names sorts with the
  // skipped, so its reading never ranks that login twice.
  const firstOfLogin = new Set(oneRowPerLogin(byPosition.filter((account) => account.status === 'ok')).map((account) => account.id));
  const runnable = byPosition.filter((account) => firstOfLogin.has(account.id));
  const skipped = byPosition.filter((account) => !firstOfLogin.has(account.id));
  const withReset = runnable
    .map((account) => ({ account, reset: orderingReset(account, nowSeconds) }))
    .sort((left, right) => {
      if (left.reset === null && right.reset === null) return left.account.position - right.account.position;
      if (left.reset === null) return 1;
      if (right.reset === null) return -1;
      return left.reset - right.reset || left.account.position - right.account.position;
    })
    .map((entry) => entry.account);
  return [...withReset, ...skipped];
}

/** The account new sessions start on: the first in list order with room. */
export function topAccountWithRoom(ordered: readonly AgentAccount[], nowSeconds: number): AgentAccount | null {
  return ordered.find((account) => hasRoom(account, nowSeconds)) ?? null;
}

/**
 * Where a session at its limit continues: the first account with room after the one it ran on,
 * then from the top. Never the account it ran on, and never another row naming its login, which
 * would continue it on the login that just ran out.
 */
export function nextAccountWithRoom(
  ordered: readonly AgentAccount[],
  currentAccountId: string,
  nowSeconds: number,
): AgentAccount | null {
  const index = ordered.findIndex((account) => account.id === currentAccountId);
  const current = index < 0 ? undefined : ordered[index];
  const rotated = index < 0 ? [...ordered] : [...ordered.slice(index + 1), ...ordered.slice(0, index)];
  return rotated.find((account) => hasRoom(account, nowSeconds)
    && !(current && sameLogin(loginOf(current), loginOf(account)))) ?? null;
}

/** When every account is full: the account and time of the soonest reset that frees one. */
export function firstReset(
  ordered: readonly AgentAccount[],
  nowSeconds: number,
): { account: AgentAccount; resetsAt: number } | null {
  let best: { account: AgentAccount; resetsAt: number } | null = null;
  for (const account of ordered) {
    if (account.status !== 'ok') continue;
    const full = liveWindows(account, nowSeconds).filter((window) => window.usedPercentage >= 100);
    // A full window with no reset time frees at a moment nobody knows: the account names none.
    if (full.length === 0 || full.some((window) => window.resetsAt <= 0)) continue;
    // The account has room again only once every full window has reset.
    const freedAt = Math.max(...full.map((window) => window.resetsAt));
    if (!best || freedAt < best.resetsAt) best = { account, resetsAt: freedAt };
  }
  return best;
}
