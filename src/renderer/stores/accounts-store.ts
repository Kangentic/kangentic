import { create, type StateCreator } from 'zustand';
import { refreshPinnedStore } from './hmr-store-pin';
import { useToastStore } from './toast-store';
import { describeAccountSwitchResult } from '../lib/account-toasts';
import {
  accountDisplayName,
  type AgentAccount,
  type AgentAccountLoginEnded,
  type AgentAccountLoginRequest,
  type AgentAccountSwitchResult,
  type AgentAccountsCard,
} from '../../shared/agent-accounts';

/** The sign-in whose terminal the Add account dialog shows. */
export interface AccountLoginInFlight {
  loginId: string;
  accountId: string;
  agent: string;
}

interface AccountsState {
  /** One card per installed agent that declares accounts. Main owns it; this is a copy. */
  cards: AgentAccountsCard[];
  /** False until the first list lands, so the tab does not flash an empty state. */
  loaded: boolean;
  /** The sign-in running in the dialog; null when none is open. */
  login: AccountLoginInFlight | null;
  /** How the last sign-in ended, shown in the dialog until it is closed. */
  loginEnded: AgentAccountLoginEnded | null;

  /** Pull the cards (the tab opening, the `accounts:changed` push, and HMR resync, Pattern B). */
  loadAccounts: () => Promise<void>;
  /** Reads who is signed in and every account's usage now. The cards refresh as each lands. */
  refreshUsage: () => Promise<void>;
  /** Starts a sign-in for a new account of `agent`. False when it could not start. */
  startLogin: (agent: string) => Promise<boolean>;
  /** Starts a sign-in again for a signed-out account. */
  startLoginAgain: (account: AgentAccount) => Promise<boolean>;
  /** Called from the `accounts:loginEnded` push. */
  receiveLoginEnded: (ended: AgentAccountLoginEnded) => void;
  /** Closes the dialog, ending a sign-in still running in it. */
  closeLogin: () => void;
  /** A drag: the agent's list takes this order. Optimistic. */
  reorder: (agent: string, orderedIds: string[]) => Promise<void>;
  /** Moves the account to #1 and its agent's running sessions onto it. */
  switchTo: (accountId: string) => Promise<void>;
  remove: (accountId: string) => Promise<void>;
}

/**
 * The name a session's account goes by (its email, or its key file), for the context bar's tip.
 * Null when the account is unknown, or the agent has only that one: with one account there is
 * nothing to tell apart.
 */
export function accountNameFor(cards: readonly AgentAccountsCard[], accountId: string | null | undefined): string | null {
  if (!accountId) return null;
  for (const card of cards) {
    const account = card.accounts.find((candidate) => candidate.id === accountId);
    if (!account) continue;
    if (card.accounts.length < 2) return null;
    return accountDisplayName(account);
  }
  return null;
}

const accountsStoreInitializer: StateCreator<AccountsState> = (set, get) => {
  /** Starts a sign-in and opens its dialog. False when it did not start, whatever the reason. */
  const beginLogin = async (request: AgentAccountLoginRequest, agent: string): Promise<boolean> => {
    try {
      const started = await window.electronAPI.accounts.startLogin(request);
      if (!started.ok) return false;
      set({ login: { loginId: started.loginId, accountId: started.accountId, agent }, loginEnded: null });
      return true;
    } catch (error) {
      console.warn('[accounts] Could not start a sign-in:', error);
      return false;
    }
  };

  return {
  cards: [],
  loaded: false,
  login: null,
  loginEnded: null,

  loadAccounts: async () => {
    try {
      // Optional chaining: during a Vite full reload the preload bridge may predate this namespace.
      const cards = await window.electronAPI.accounts?.list();
      if (cards) set({ cards, loaded: true });
    } catch (error) {
      // The cards on screen stay; the next push or the tab's next open lists again. Callers reach
      // this from push handlers, where a rejection has nobody to catch it.
      console.warn('[accounts] Could not list accounts:', error);
    }
  },

  refreshUsage: async () => {
    try {
      await window.electronAPI.accounts?.refreshUsage();
    } catch (error) {
      console.warn('[accounts] Could not refresh usage:', error);
    }
    await get().loadAccounts();
  },

  startLogin: (agent) => beginLogin({ agent }, agent),

  startLoginAgain: (account) => beginLogin({ accountId: account.id }, account.agent),

  receiveLoginEnded: (ended) => {
    // A sign-in whose dialog was already closed ends silently: its row (or its absence) says it.
    if (get().login?.loginId === ended.loginId) set({ loginEnded: ended });
    void get().loadAccounts();
  },

  closeLogin: () => {
    const { login, loginEnded } = get();
    if (login && !loginEnded) void window.electronAPI.accounts.cancelLogin(login.loginId).catch(() => undefined);
    set({ login: null, loginEnded: null });
  },

  reorder: async (agent, orderedIds) => {
    // The list takes the order at once; main's answer arrives as a re-list.
    set({
      cards: get().cards.map((card) => {
        if (card.agent !== agent) return card;
        const byId = new Map(card.accounts.map((account) => [account.id, account]));
        const ordered = orderedIds.flatMap((id) => byId.get(id) ?? []);
        return { ...card, accounts: [...ordered, ...card.accounts.filter((account) => !orderedIds.includes(account.id))] };
      }),
    });
    try {
      await window.electronAPI.accounts.reorder(agent, orderedIds);
    } catch (error) {
      console.warn('[accounts] Could not save the order:', error);
    } finally {
      // Main's order, saved or not: a failed save must not leave the dragged order on screen.
      await get().loadAccounts();
    }
  },

  switchTo: async (accountId) => {
    // Answers once the agent's running sessions have moved; the list itself changes at once,
    // through the `accounts:changed` push.
    let result: AgentAccountSwitchResult;
    try {
      result = await window.electronAPI.accounts.switchTo(accountId);
    } catch (error) {
      console.warn('[accounts] Could not switch account:', error);
      result = { ok: false, agent: null, accountName: null, moved: 0, failed: 0 };
    }
    await get().loadAccounts();
    useToastStore.getState().addToast(describeAccountSwitchResult(result));
  },

  remove: async (accountId) => {
    try {
      await window.electronAPI.accounts.remove(accountId);
    } catch (error) {
      console.warn('[accounts] Could not remove the account:', error);
    }
    await get().loadAccounts();
  },
  };
};

const createAccountsStore = () => create<AccountsState>(accountsStoreInitializer);

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this module's only runtime
// export is the non-component hook, so it is not a React Fast Refresh boundary. Pin the instance
// so a Fast Refresh cannot hand a second store to the tab while the sign-in dialog stays
// subscribed to the first.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedAccountsStore: ReturnType<typeof createAccountsStore> | undefined = import.meta.hot?.data?.accountsStore;
if (preservedAccountsStore) refreshPinnedStore(preservedAccountsStore, accountsStoreInitializer);

export const useAccountsStore = preservedAccountsStore ?? createAccountsStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.accountsStore = useAccountsStore;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
