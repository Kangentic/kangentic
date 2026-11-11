import type { AgentAccountOrderMode, AgentAccountsCard } from '../../shared/agent-accounts';

/**
 * How Settings > Accounts lays out its agents (task #1064). Pure, so the rules are unit-tested.
 */

/**
 * Whether an agent gets a card of its own. It does when it has something to show beyond the CLI's
 * own login: a second account, usage, a variable that outranks its accounts, or a CLI that runs in
 * WSL (its note, and no Add account). Every other agent shares the More agents card, one line each.
 */
export function hasOwnAccountsCard(card: AgentAccountsCard): boolean {
  return card.accounts.length > 1 || card.reportsUsage || card.overrides.length > 0 || card.unsupportedTarget;
}

/** The agents with a card of their own, and the rest for the More agents card, each in list order. */
export function partitionAccountCards(cards: readonly AgentAccountsCard[]): { own: AgentAccountsCard[]; more: AgentAccountsCard[] } {
  const own: AgentAccountsCard[] = [];
  const more: AgentAccountsCard[] = [];
  for (const card of cards) (hasOwnAccountsCard(card) ? own : more).push(card);
  return { own, more };
}

/**
 * The cards the Account switching settings act on: an agent that reports usage, since Automatic
 * sorts by reset and the switch reads usage, with two accounts to order and switch between. The
 * card shows when there is one, and its description names them.
 */
export function accountSwitchingCards(cards: readonly AgentAccountsCard[]): AgentAccountsCard[] {
  return cards.filter((card) => card.reportsUsage && card.accounts.length > 1);
}

/**
 * Whether the list is in the user's order, so its rows take a drag: Manual order, or an agent that
 * reports no usage (Automatic has no reset to sort it by, so it keeps the user's order). Only an
 * agent with two or more accounts has an order at all.
 */
export function isAccountOrderEditable(card: AgentAccountsCard, orderMode: AgentAccountOrderMode): boolean {
  return card.accounts.length > 1 && (orderMode === 'manual' || !card.reportsUsage);
}
