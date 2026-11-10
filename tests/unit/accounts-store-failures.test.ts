/**
 * The accounts store when the bridge rejects: a push handler has nobody to catch a rejection, and a
 * failed save must not leave the dragged order on screen. Runs the real store against a stubbed
 * `window.electronAPI.accounts`. Tier: Unit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAccount, AgentAccountsCard } from '../../src/shared/agent-accounts';

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({ config: { notifications: { toasts: { durationSeconds: 4, maxCount: 5 } } } }),
  },
}));

import { useAccountsStore } from '../../src/renderer/stores/accounts-store';
import { useToastStore } from '../../src/renderer/stores/toast-store';

function makeAccount(id: string): AgentAccount {
  return {
    id,
    agent: 'claude',
    kind: 'folder',
    folderPath: null,
    keyFilePath: null,
    keyNames: [],
    email: `${id}@example.com`,
    plan: null,
    status: 'ok',
    position: 1,
    historyPrivate: false,
    lastUsage: null,
    lastUsageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeCard(ids: string[]): AgentAccountsCard {
  return {
    agent: 'claude',
    kind: 'folder',
    accounts: ids.map(makeAccount),
    activeAccountId: ids[0] ?? null,
    reportsUsage: true,
    signInIsInteractive: false,
    switchMovesSessions: true,
    overrides: [],
    unsupportedTarget: false,
  };
}

const accountsBridge = {
  list: vi.fn<() => Promise<AgentAccountsCard[]>>(),
  reorder: vi.fn<(agent: string, orderedIds: string[]) => Promise<void>>(),
  startLogin: vi.fn(),
  switchTo: vi.fn(),
};

function accountIds(): string[] {
  return useAccountsStore.getState().cards.flatMap((card) => card.accounts.map((account) => account.id));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  accountsBridge.list.mockReset();
  accountsBridge.reorder.mockReset();
  accountsBridge.startLogin.mockReset();
  accountsBridge.switchTo.mockReset();
  vi.stubGlobal('window', { electronAPI: { accounts: accountsBridge } });
  useAccountsStore.setState({ cards: [makeCard(['a', 'b'])], loaded: true, login: null, loginEnded: null });
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismissToast(toast.id);
});

describe('useAccountsStore when the bridge rejects', () => {
  it('loadAccounts does not reject and keeps the cards on screen', async () => {
    accountsBridge.list.mockRejectedValue(new Error('main is busy'));
    await expect(useAccountsStore.getState().loadAccounts()).resolves.toBeUndefined();
    expect(accountIds()).toEqual(['a', 'b']);
  });

  it('reorder re-lists from main, so the optimistic order does not stay', async () => {
    accountsBridge.reorder.mockRejectedValue(new Error('could not save'));
    accountsBridge.list.mockResolvedValue([makeCard(['a', 'b'])]);
    await useAccountsStore.getState().reorder('claude', ['b', 'a']);
    expect(accountsBridge.list).toHaveBeenCalledTimes(1);
    expect(accountIds()).toEqual(['a', 'b']);
  });

  it('reorder shows the dragged order at once, before main answers', async () => {
    let finishSave: () => void = () => undefined;
    accountsBridge.reorder.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    accountsBridge.list.mockResolvedValue([makeCard(['b', 'a'])]);
    const saving = useAccountsStore.getState().reorder('claude', ['b', 'a']);
    expect(accountIds()).toEqual(['b', 'a']);
    finishSave();
    await saving;
    expect(accountIds()).toEqual(['b', 'a']);
  });

  it('startLogin resolves false', async () => {
    accountsBridge.startLogin.mockRejectedValue(new Error('no cli'));
    await expect(useAccountsStore.getState().startLogin('claude')).resolves.toBe(false);
    expect(useAccountsStore.getState().login).toBeNull();
  });

  it('switchTo raises the failure toast', async () => {
    accountsBridge.switchTo.mockRejectedValue(new Error('main is busy'));
    accountsBridge.list.mockResolvedValue([makeCard(['a', 'b'])]);
    await useAccountsStore.getState().switchTo('b');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('error');
  });
});
