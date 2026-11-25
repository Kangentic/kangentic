import { create, type StateCreator } from 'zustand';
import { refreshPinnedStore, sharedModuleState } from './hmr-store-pin';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useToastStore } from './toast-store';
import { describeAccountSwitchResult } from '../lib/account-toasts';
import { ipcFailureToastFields } from '../lib/ipc-error';
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
  /** Null while main is still starting it: the dialog opens on the click, not on main's answer. */
  loginId: string | null;
  accountId: string | null;
  agent: string;
  /** Tells this start from a later one, so an answer for a dialog already closed is not shown. */
  attempt: number;
}

interface AccountsState {
  /** One card per installed agent that declares accounts. Main owns it; this is a copy. */
  cards: AgentAccountsCard[];
  /** False until the first list lands, so the tab does not flash an empty state. */
  loaded: boolean;
  /**
   * The cards come from this run's CLI check. Before it lands they are the saved ones (task #1202),
   * so an empty list means nothing is saved yet, not that no agent has accounts.
   */
  checked: boolean;
  /** Usage reads the tab started that have not landed yet. The usage cards show a spinner meanwhile. */
  usageReads: number;
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

/**
 * This module's mutable state, one object every evaluation of the module shares
 * (`sharedModuleState`), so an action still in flight across a refresh (Pattern E) and its
 * replacement count lists the same way.
 */
interface AccountsModuleState {
  /** Bumped per list request. */
  listOrdinal: number;
  /** The request whose answer is on screen; an answer to an older one is dropped. */
  appliedOrdinal: number;
  /** Bumped per sign-in start. */
  loginAttempt: number;
}

const accountsModuleState = sharedModuleState<AccountsModuleState>(
  // @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
  import.meta.hot?.data,
  'accountsModuleState',
  () => ({ listOrdinal: 0, appliedOrdinal: 0, loginAttempt: 0 }),
);

const accountsStoreInitializer: StateCreator<AccountsState> = (set, get) => {
  /**
   * Opens the sign-in dialog at once and starts the sign-in. Main may first have to find the
   * agent's CLI, which took 12 s after a restart (task #1202), so the dialog shows its empty
   * terminal meanwhile. False when it did not start, whatever the reason.
   */
  const beginLogin = async (request: AgentAccountLoginRequest, agent: string): Promise<boolean> => {
    accountsModuleState.loginAttempt += 1;
    const attempt = accountsModuleState.loginAttempt;
    set({ login: { loginId: null, accountId: null, agent, attempt }, loginEnded: null });
    const stillOpen = (): boolean => get().login?.attempt === attempt;
    try {
      const started = await window.electronAPI.accounts.startLogin(request);
      if (!started.ok) {
        if (stillOpen()) set({ login: null });
        return false;
      }
      if (!stillOpen()) {
        // The dialog was closed while main started it: end the sign-in nobody is watching.
        void window.electronAPI.accounts.cancelLogin(started.loginId).catch(() => undefined); // report-ok: the dialog is gone, and main ends a sign-in whose terminal it cannot reach
        return true;
      }
      set({ login: { loginId: started.loginId, accountId: started.accountId, agent, attempt } });
      return true;
    } catch (error) {
      // report-ok: main's IPC wrap reports a handler's rejection, and the tab's toast says the
      // sign-in did not start.
      console.warn('[accounts] Could not start a sign-in:', error);
      if (stillOpen()) set({ login: null });
      return false;
    }
  };

  return {
  cards: [],
  loaded: false,
  checked: false,
  usageReads: 0,
  login: null,
  loginEnded: null,

  loadAccounts: async () => {
    // Lists overlap: a drag's, the push after it, an Order change's, the push when main's CLI check
    // lands, the one after a usage read. Once the check has landed each list detects every agent's
    // CLI again, so a list can take seconds. An answer is applied unless a newer request's answer already is: an
    // older one landing last put a Manual order back on screen after Order went back to
    // Automatic. An older answer that lands first still shows, so a newer request that fails
    // leaves the newest answer that arrived.
    accountsModuleState.listOrdinal += 1;
    const ordinal = accountsModuleState.listOrdinal;
    try {
      // Optional chaining: during a Vite full reload the preload bridge may predate this namespace.
      const answer = await window.electronAPI.accounts?.list();
      if (answer && ordinal > accountsModuleState.appliedOrdinal) {
        accountsModuleState.appliedOrdinal = ordinal;
        set({ cards: answer.cards, checked: answer.checked, loaded: true });
      }
    } catch (error) {
      // report-ok: main's IPC wrap reports a handler's rejection, and the cards on screen stay.
      // The next push or the tab's next open lists again. Callers reach this from push handlers,
      // where a rejection has nobody to catch it.
      console.warn('[accounts] Could not list accounts:', error);
    }
  },

  refreshUsage: async () => {
    set({ usageReads: get().usageReads + 1 });
    try {
      await window.electronAPI.accounts?.refreshUsage();
    } catch (error) {
      // report-ok: main's IPC wrap reports a handler's rejection, and the list below shows the
      // usage main last read.
      console.warn('[accounts] Could not refresh usage:', error);
    }
    try {
      await get().loadAccounts();
    } finally {
      // After the list, so the spinner stops as the new bars land.
      set({ usageReads: Math.max(0, get().usageReads - 1) });
    }
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
    // A sign-in still starting has no id yet; `beginLogin` ends it when main answers.
    // report-ok: main's IPC wrap reports a handler's rejection, and the dialog closes either way.
    if (login?.loginId && !loginEnded) void window.electronAPI.accounts.cancelLogin(login.loginId).catch(() => undefined);
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
      // report-ok: main's IPC wrap reports a handler's rejection, and the list below puts main's
      // order back on screen.
      console.warn('[accounts] Could not save the order:', error);
    } finally {
      // Main's order, saved or not: a failed save must not leave the dragged order on screen.
      await get().loadAccounts();
    }
  },

  switchTo: async (accountId) => {
    // Answers once each of the agent's running sessions was looked at once (idle ones moved, working
    // ones wait for a safe point); the list itself changes at once, through the `accounts:changed` push.
    let result: AgentAccountSwitchResult;
    try {
      result = await window.electronAPI.accounts.switchTo(accountId);
    } catch (error) {
      // report-ok: main's IPC wrap reports a handler's rejection, and the toast below says the
      // switch failed.
      console.warn('[accounts] Could not switch account:', error);
      result = { ok: false, agent: null, accountName: null, moved: 0, pending: 0, failed: 0 };
    }
    await get().loadAccounts();
    useToastStore.getState().addToast(describeAccountSwitchResult(result));
  },

  remove: async (accountId) => {
    try {
      await window.electronAPI.accounts.remove(accountId);
    } catch (error) {
      // report-ok: the try holds only the IPC call, whose rejection main's wrap reports, and
      // the toast tells the user the removal failed.
      console.warn('[accounts] Could not remove the account:', error);
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't remove account`),
        ...ipcFailureToastFields(error),
        variant: 'error',
      });
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
