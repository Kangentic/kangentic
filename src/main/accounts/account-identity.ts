import type { AgentAccount } from '../../shared/agent-accounts';

/**
 * Which login a row names, and what a sign-in read of its home means for the list (task #1113).
 * Pure: no I/O, so every case is unit-tested on plain rows. The account service applies the answer.
 *
 * A home holds one login, and a `/login` in any session on it replaces that login with no hook and
 * nothing on the status line. So a read can find a home holding another login than its row names,
 * and the list must then still name every login once: the replaced one stays listed under its
 * email, one Sign in away, and the one the home holds now is not listed twice.
 */

/** A login as the CLI names it: its email and, when reported, its organization. */
export interface LoginIdentity {
  email: string | null;
  orgId: string | null;
}

/**
 * True when two identities name one login: the same email, ignoring case, and the same
 * organization when both report one. A missing email is never a match. A missing organization
 * matches either way, so a row from before org ids were stored still matches its own login, and one
 * email in two organizations is two logins.
 */
export function sameLogin(first: LoginIdentity, second: LoginIdentity): boolean {
  if (!first.email || !second.email) return false;
  if (first.email.toLowerCase() !== second.email.toLowerCase()) return false;
  return !first.orgId || !second.orgId || first.orgId === second.orgId;
}

/** The identity a row names. */
export function loginOf(account: Pick<AgentAccount, 'email' | 'orgId'>): LoginIdentity {
  return { email: account.email, orgId: account.orgId };
}

/** A row that names a login it can run on, as opposed to one whose home moved to another. */
function isLive(account: AgentAccount): boolean {
  return account.status !== 'replaced';
}

/**
 * What a read of a row's home that found `found` (a signed-in login with an email) means:
 * - `unchanged`: the home holds the row's own login. A `replaced` row whose login is back goes
 *   back to running.
 * - `first-read`: the row named no login yet, and no other row names this one. It takes it.
 * - `already-listed`: the row named no login yet, and another row already names this one. The row
 *   is set aside (`replaced`, no email) rather than listing the login twice.
 * - `to-listed`: the home now holds a login another row names. The row keeps its own login, set
 *   aside, and the sessions on its home now run as `listedId`.
 * - `still-replaced`: the row was already set aside for this, and the home still holds `listedId`'s
 *   login. Nothing changes and nothing is reported again.
 * - `to-new`: the home now holds a login no row names. The row takes it, and its old login moves
 *   to a new row of its own, set aside, with a folder of its own to sign in to.
 * - `merged`: as `to-new`, but a set-aside row (`replacedId`) already names the new login: it takes
 *   the old login instead, so no row is added and none names a login twice.
 */
export type IdentityDecision =
  | { kind: 'unchanged' }
  | { kind: 'first-read' }
  | { kind: 'already-listed'; listedId: string }
  | { kind: 'to-listed'; listedId: string }
  | { kind: 'still-replaced'; listedId: string }
  | { kind: 'to-new' }
  | { kind: 'merged'; replacedId: string };

/**
 * Decides what a read of `account`'s home means. `others` are the rest of the agent's rows.
 * Idempotent: reading the same answer again gives `unchanged` or `still-replaced`.
 */
export function decideIdentity(account: AgentAccount, others: readonly AgentAccount[], found: LoginIdentity): IdentityDecision {
  const otherRows = others.filter((other) => other.id !== account.id);
  const live = otherRows.find((other) => isLive(other) && sameLogin(loginOf(other), found));
  if (!account.email) {
    if (!live) return { kind: 'first-read' };
    return account.status === 'replaced' ? { kind: 'still-replaced', listedId: live.id } : { kind: 'already-listed', listedId: live.id };
  }
  if (sameLogin(loginOf(account), found)) return { kind: 'unchanged' };
  if (live) return account.status === 'replaced' ? { kind: 'still-replaced', listedId: live.id } : { kind: 'to-listed', listedId: live.id };
  const setAside = otherRows.find((other) => !isLive(other) && sameLogin(loginOf(other), found));
  return setAside ? { kind: 'merged', replacedId: setAside.id } : { kind: 'to-new' };
}

/**
 * Rows that name a login another running row already names: a list written before this check
 * existed. Of each group one row stays. The agent's own home is the one that yields, since that is
 * where a `/login` with no home variable lands; otherwise the newest row yields. The rows returned
 * are set aside with no email, because the login they held before cannot be known.
 */
export function duplicateLoginRows(accounts: readonly AgentAccount[]): AgentAccount[] {
  const yielding: AgentAccount[] = [];
  const live = accounts.filter((account) => isLive(account) && account.email);
  const ranked = [...live].sort((first, second) => {
    const firstDefault = Number(first.kind === 'default');
    const secondDefault = Number(second.kind === 'default');
    return firstDefault - secondDefault || first.createdAt.localeCompare(second.createdAt) || first.position - second.position;
  });
  const kept: AgentAccount[] = [];
  for (const account of ranked) {
    if (kept.some((other) => sameLogin(loginOf(other), loginOf(account)))) yielding.push(account);
    else kept.push(account);
  }
  return yielding;
}

/**
 * The accounts in `ordered` with each login once: a later row naming a login an earlier one names
 * is dropped. Ranking and the continuation read this, so one login never counts as two accounts.
 */
export function oneRowPerLogin(ordered: readonly AgentAccount[]): AgentAccount[] {
  const kept: AgentAccount[] = [];
  for (const account of ordered) {
    if (kept.some((other) => sameLogin(loginOf(other), loginOf(account)))) continue;
    kept.push(account);
  }
  return kept;
}
