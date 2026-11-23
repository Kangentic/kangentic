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
function isLive(limitWindow: RateLimitWindow, nowSeconds: number): boolean {
  return limitWindow.resetsAt <= 0 || limitWindow.resetsAt > nowSeconds;
}

function liveWindows(account: AgentAccount, nowSeconds: number): RateLimitWindow[] {
  return (account.lastUsage ?? []).filter((limitWindow) => isLive(limitWindow, nowSeconds));
}

/**
 * How far a report's reset may sit past a full window's and still be that window. Two sources of
 * one window can round its reset differently (Claude's cache keeps fractions of a second, its
 * status line whole seconds). A window's next reset is 5 hours or 7 days later.
 */
export const SAME_WINDOW_SLACK_SECONDS = 10 * 60;

/**
 * A full window never goes down before its reset. Of `next`, a window that would lower a stored
 * window at 100 is replaced by the stored one, while that window's reset is still ahead and the
 * report's reset is not a later one (a new window). Claude's status line reads 99 for a weekly
 * window its own cache reads 100 and spent (measured on 2.1.330, task #1147): a live report on
 * another session of the account wrote the 99 over the 100 a continuation had just read, and the
 * next spawn took the spent account. A window with no reset time is never held, since it would
 * never expire.
 */
export function keepFullWindows(
  previous: readonly RateLimitWindow[],
  next: readonly RateLimitWindow[],
  nowSeconds: number,
): RateLimitWindow[] {
  const isHeld = (limitWindow: RateLimitWindow): boolean => limitWindow.usedPercentage >= 100 && limitWindow.resetsAt > nowSeconds;
  // Every live report passes through here, and almost none find a full window: copy and go.
  if (!previous.some(isHeld)) return [...next];
  const fullById = new Map(previous
    .filter(isHeld)
    .map((limitWindow): [string, RateLimitWindow] => [limitWindow.id, limitWindow]));
  return next.map((reported) => {
    const full = fullById.get(reported.id);
    if (!full || reported.usedPercentage >= 100) return reported;
    return reported.resetsAt <= full.resetsAt + SAME_WINDOW_SLACK_SECONDS ? full : reported;
  });
}

/**
 * A window at or above this is worth a fresh read before a session is trusted to it. Claude's
 * status line reads 99 for a weekly window Claude has spent (task #1147), so a stored reading
 * under 100 can still be a spent account. The percentage only decides whether to read, never
 * whether to move a session.
 */
export const NEAR_FULL_PERCENT = 95;

/** True when any live window of the account is at `NEAR_FULL_PERCENT` or above. */
export function isNearFull(account: AgentAccount, nowSeconds: number): boolean {
  return liveWindows(account, nowSeconds).some((limitWindow) => limitWindow.usedPercentage >= NEAR_FULL_PERCENT);
}

/** An account that can take a new session: signed in with a plan, links in place, no full window. */
export function hasRoom(account: AgentAccount, nowSeconds: number): boolean {
  if (account.status !== 'ok') return false;
  return liveWindows(account, nowSeconds).every((window) => window.usedPercentage < 100);
}

/**
 * The reset that orders an account under Automatic: the longest window the CLI reports (7d weekly
 * before 5h session), because that is the allowance a reset hands back the most of. Null when the
 * account reports no live window of that length. Once every longest window has reset since the
 * reading, the next reset is unknown until a read, so the account orders with the accounts that
 * have no reading. A shorter window never stands in, since its reset is hours away while a week
 * that just rolled over resets in about 7 days.
 */
export function orderingReset(account: AgentAccount, nowSeconds: number): number | null {
  // A window with no reset time has nothing to order by. Expired windows still say which length
  // is the longest the account reports. A window with no length counts as the shortest.
  const dated = (account.lastUsage ?? []).filter((limitWindow) => limitWindow.resetsAt > 0);
  if (dated.length === 0) return null;
  const longestDuration = Math.max(...dated.map((limitWindow) => limitWindow.windowDurationSeconds ?? 0));
  const liveLongest = dated.find((limitWindow) =>
    (limitWindow.windowDurationSeconds ?? 0) === longestDuration && isLive(limitWindow, nowSeconds),
  );
  return liveLongest?.resetsAt ?? null;
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
