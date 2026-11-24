/**
 * The accounts store when the bridge rejects: a push handler has nobody to catch a rejection, and a
 * failed save must not leave the dragged order on screen. Runs the real store against a stubbed
 * `window.electronAPI.accounts`. Tier: Unit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAccount, AgentAccountsCard, AgentAccountsList } from '../../src/shared/agent-accounts';

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
    lastUsageAt: null, absentWindowIds: [],
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
    usageWindows: [],
    signInIsInteractive: false,
    switchMovesSessions: true,
    overrides: [],
    unsupportedTarget: false,
  };
}

/** Main's answer once this run's CLI check has landed. */
function checkedList(cards: AgentAccountsCard[]): AgentAccountsList {
  return { cards, checked: true };
}

const accountsBridge = {
  list: vi.fn<() => Promise<AgentAccountsList>>(),
  reorder: vi.fn<(agent: string, orderedIds: string[]) => Promise<void>>(),
  startLogin: vi.fn(),
  switchTo: vi.fn(),
  cancelLogin: vi.fn(),
  refreshUsage: vi.fn(),
};

type LoginStart = { ok: true; loginId: string; accountId: string | null } | { ok: false; reason: string };

/** A startLogin answer the test lands when it chooses. */
function heldLoginStart() {
  let answer: (started: LoginStart) => void = () => undefined;
  const promise = new Promise<LoginStart>((resolve) => { answer = resolve; });
  return { promise, answer };
}

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
  accountsBridge.cancelLogin.mockReset();
  accountsBridge.cancelLogin.mockResolvedValue(undefined);
  accountsBridge.refreshUsage.mockReset();
  vi.stubGlobal('window', { electronAPI: { accounts: accountsBridge } });
  useAccountsStore.setState({ cards: [makeCard(['a', 'b'])], loaded: true, checked: true, usageReads: 0, login: null, loginEnded: null });
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
    accountsBridge.list.mockResolvedValue(checkedList([makeCard(['a', 'b'])]));
    await useAccountsStore.getState().reorder('claude', ['b', 'a']);
    expect(accountsBridge.list).toHaveBeenCalledTimes(1);
    expect(accountIds()).toEqual(['a', 'b']);
  });

  it('reorder shows the dragged order at once, before main answers', async () => {
    let finishSave: () => void = () => undefined;
    accountsBridge.reorder.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    accountsBridge.list.mockResolvedValue(checkedList([makeCard(['b', 'a'])]));
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

  // Main lists slowly, so lists overlap. The tab showed a Manual-era order after Order went back
  // to Automatic because an older list landed last.
  it('applies the latest list, not the one that lands last', async () => {
    let answerOlder: (answer: AgentAccountsList) => void = () => undefined;
    accountsBridge.list
      .mockReturnValueOnce(new Promise<AgentAccountsList>((resolve) => { answerOlder = resolve; }))
      .mockResolvedValueOnce(checkedList([makeCard(['b', 'a'])]));
    const older = useAccountsStore.getState().loadAccounts();
    await useAccountsStore.getState().loadAccounts();
    expect(accountIds()).toEqual(['b', 'a']);
    answerOlder(checkedList([makeCard(['a', 'b'])]));
    await older;
    expect(accountIds()).toEqual(['b', 'a']);
  });

  it('shows the older answer when it lands first and the newer request then fails', async () => {
    useAccountsStore.setState({ cards: [], loaded: false });
    let answerOlder: (answer: AgentAccountsList) => void = () => undefined;
    let failNewer: (error: Error) => void = () => undefined;
    accountsBridge.list
      .mockReturnValueOnce(new Promise<AgentAccountsList>((resolve) => { answerOlder = resolve; }))
      .mockReturnValueOnce(new Promise<AgentAccountsList>((_resolve, reject) => { failNewer = reject; }));
    const older = useAccountsStore.getState().loadAccounts();
    const newer = useAccountsStore.getState().loadAccounts();
    answerOlder(checkedList([makeCard(['x', 'y'])]));
    await older;
    expect(accountIds()).toEqual(['x', 'y']);
    failNewer(new Error('main is busy'));
    await expect(newer).resolves.toBeUndefined();
    expect(accountIds()).toEqual(['x', 'y']);
    expect(useAccountsStore.getState().loaded).toBe(true);
  });

  it('switchTo raises the failure toast', async () => {
    accountsBridge.switchTo.mockRejectedValue(new Error('main is busy'));
    accountsBridge.list.mockResolvedValue(checkedList([makeCard(['a', 'b'])]));
    await useAccountsStore.getState().switchTo('b');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('error');
  });
});

describe('useAccountsStore checked', () => {
  it('loadAccounts takes checked from main answer: unchecked first, then checked', async () => {
    useAccountsStore.setState({ cards: [], loaded: false, checked: true });
    accountsBridge.list.mockResolvedValueOnce({ cards: [makeCard(['a'])], checked: false });
    await useAccountsStore.getState().loadAccounts();
    expect(useAccountsStore.getState().checked).toBe(false);
    expect(useAccountsStore.getState().loaded).toBe(true);
    accountsBridge.list.mockResolvedValueOnce(checkedList([makeCard(['a'])]));
    await useAccountsStore.getState().loadAccounts();
    expect(useAccountsStore.getState().checked).toBe(true);
  });
});

describe('useAccountsStore sign-in dialog while main starts the sign-in', () => {
  it('opens the dialog at once, with no loginId yet', async () => {
    const start = heldLoginStart();
    accountsBridge.startLogin.mockReturnValue(start.promise);
    const starting = useAccountsStore.getState().startLogin('claude');
    expect(useAccountsStore.getState().login).toMatchObject({ loginId: null, accountId: null, agent: 'claude' });
    start.answer({ ok: true, loginId: 'L1', accountId: 'A1' });
    await expect(starting).resolves.toBe(true);
    expect(useAccountsStore.getState().login).toMatchObject({ loginId: 'L1', accountId: 'A1' });
  });

  it('cancels a sign-in main started after the dialog was closed, and keeps the dialog closed', async () => {
    const start = heldLoginStart();
    accountsBridge.startLogin.mockReturnValue(start.promise);
    const starting = useAccountsStore.getState().startLogin('claude');
    useAccountsStore.getState().closeLogin();
    // A sign-in with no id yet has nothing to cancel.
    expect(accountsBridge.cancelLogin).not.toHaveBeenCalled();
    expect(useAccountsStore.getState().login).toBeNull();
    start.answer({ ok: true, loginId: 'L1', accountId: 'A1' });
    await starting;
    expect(accountsBridge.cancelLogin).toHaveBeenCalledTimes(1);
    expect(accountsBridge.cancelLogin).toHaveBeenCalledWith('L1');
    expect(useAccountsStore.getState().login).toBeNull();
  });

  it('cancels the superseded attempt and shows the newer one', async () => {
    const startA = heldLoginStart();
    const startB = heldLoginStart();
    accountsBridge.startLogin.mockReturnValueOnce(startA.promise).mockReturnValueOnce(startB.promise);
    const startingA = useAccountsStore.getState().startLogin('claude');
    const startingB = useAccountsStore.getState().startLogin('codex');
    startA.answer({ ok: true, loginId: 'LA', accountId: 'AA' });
    await startingA;
    expect(accountsBridge.cancelLogin).toHaveBeenCalledTimes(1);
    expect(accountsBridge.cancelLogin).toHaveBeenCalledWith('LA');
    expect(useAccountsStore.getState().login).toMatchObject({ loginId: null, agent: 'codex' });
    startB.answer({ ok: true, loginId: 'LB', accountId: 'AB' });
    await startingB;
    expect(useAccountsStore.getState().login).toMatchObject({ loginId: 'LB', agent: 'codex' });
    expect(accountsBridge.cancelLogin).toHaveBeenCalledTimes(1);
  });

  it('a refused start resolves false and clears the dialog', async () => {
    accountsBridge.startLogin.mockResolvedValue({ ok: false, reason: 'failed' });
    await expect(useAccountsStore.getState().startLogin('claude')).resolves.toBe(false);
    expect(useAccountsStore.getState().login).toBeNull();
  });

  it('a failure of an older attempt does not clear a newer dialog', async () => {
    const startA = heldLoginStart();
    const startB = heldLoginStart();
    accountsBridge.startLogin.mockReturnValueOnce(startA.promise).mockReturnValueOnce(startB.promise);
    const startingA = useAccountsStore.getState().startLogin('claude');
    const startingB = useAccountsStore.getState().startLogin('codex');
    startA.answer({ ok: false, reason: 'failed' });
    await expect(startingA).resolves.toBe(false);
    expect(useAccountsStore.getState().login).toMatchObject({ agent: 'codex', loginId: null });
    startB.answer({ ok: true, loginId: 'LB', accountId: null });
    await startingB;
    expect(useAccountsStore.getState().login).toMatchObject({ loginId: 'LB' });
  });

  it('a rejected start of an older attempt does not clear a newer dialog', async () => {
    const startB = heldLoginStart();
    accountsBridge.startLogin.mockRejectedValueOnce(new Error('no cli')).mockReturnValueOnce(startB.promise);
    const startingA = useAccountsStore.getState().startLogin('claude');
    const startingB = useAccountsStore.getState().startLogin('codex');
    await expect(startingA).resolves.toBe(false);
    expect(useAccountsStore.getState().login).toMatchObject({ agent: 'codex' });
    startB.answer({ ok: true, loginId: 'LB', accountId: null });
    await startingB;
  });

  it('closeLogin cancels a sign-in that has an id', () => {
    useAccountsStore.setState({ login: { loginId: 'L9', accountId: 'A9', agent: 'claude', attempt: 99 } });
    useAccountsStore.getState().closeLogin();
    expect(accountsBridge.cancelLogin).toHaveBeenCalledWith('L9');
    expect(useAccountsStore.getState().login).toBeNull();
  });
});

describe('useAccountsStore usageReads', () => {
  it('a rejected usage read still lists and returns the count to 0', async () => {
    accountsBridge.refreshUsage.mockRejectedValue(new Error('cli failed'));
    accountsBridge.list.mockResolvedValue(checkedList([makeCard(['a'])]));
    useAccountsStore.setState({ usageReads: 0 });
    await expect(useAccountsStore.getState().refreshUsage()).resolves.toBeUndefined();
    expect(accountsBridge.list).toHaveBeenCalledTimes(1);
    expect(useAccountsStore.getState().usageReads).toBe(0);
  });

  it('counts overlapping reads and returns to 0', async () => {
    accountsBridge.refreshUsage.mockResolvedValue(undefined);
    accountsBridge.list.mockResolvedValue(checkedList([makeCard(['a'])]));
    const first = useAccountsStore.getState().refreshUsage();
    expect(useAccountsStore.getState().usageReads).toBe(1);
    const second = useAccountsStore.getState().refreshUsage();
    expect(useAccountsStore.getState().usageReads).toBe(2);
    await Promise.all([first, second]);
    expect(useAccountsStore.getState().usageReads).toBe(0);
  });

  it('keeps the count up while the follow-up list is pending', async () => {
    accountsBridge.refreshUsage.mockResolvedValue(undefined);
    let answerList: (answer: AgentAccountsList) => void = () => undefined;
    accountsBridge.list.mockReturnValue(new Promise<AgentAccountsList>((resolve) => { answerList = resolve; }));
    const reading = useAccountsStore.getState().refreshUsage();
    await vi.waitFor(() => expect(accountsBridge.list).toHaveBeenCalledTimes(1));
    expect(useAccountsStore.getState().usageReads).toBe(1);
    answerList(checkedList([makeCard(['a'])]));
    await reading;
    expect(useAccountsStore.getState().usageReads).toBe(0);
  });
});
