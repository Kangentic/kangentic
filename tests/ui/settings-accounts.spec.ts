/**
 * Settings > Accounts (task #1057).
 *
 * What only a browser proves about the tab: a one-account install shows its login with no run
 * order and nothing to reorder; three accounts show the order, the Active mark on the first with
 * room and a skipped account at its limit; Switch to, Remove's confirm and the sign-in dialog do
 * what their rows say. The mock holds the accounts (`window.__mockAccountCards`), so nothing here
 * runs a CLI. Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

interface MockCall { name: string; args: unknown[] }

const HOUR = 3600;
const DAY = 86_400;
const fiveHour = (usedPercentage: number, resetsInSeconds: number) =>
  ({ id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage, resetsInSeconds, windowDurationSeconds: 5 * HOUR });
const sevenDay = (usedPercentage: number, resetsInSeconds: number) =>
  ({ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsInSeconds, windowDurationSeconds: 7 * DAY });

const THREE_ACCOUNTS = [{
  agent: 'claude',
  accounts: [
    { id: 'account-1', email: 'one@example.com', plan: 'Max', lastUsage: [sevenDay(100, 3 * DAY)] },
    { id: 'account-2', email: 'two@example.com', plan: 'Max', lastUsage: [fiveHour(81, 2 * HOUR + 600), sevenDay(64, 26 * HOUR)] },
    { id: 'account-3', email: 'three@example.com', plan: 'Pro', status: 'signed-out' },
  ],
}];

async function openAccounts(page: Page): Promise<void> {
  await createProject(page, `settings-accounts-${Date.now()}`);
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(page.getByTestId('settings-card-accounts-claude')).toBeVisible();
}

function seedAccounts(cards: unknown): (page: Page) => Promise<void> {
  return (page) => page.addInitScript((seed) => {
    (window as unknown as { __mockAccountCards: unknown }).__mockAccountCards = seed;
  }, cards);
}

async function accountCalls(page: Page, name: string): Promise<MockCall[]> {
  const calls = await page.evaluate(() => (window as unknown as { __mockAccountCalls?: MockCall[] }).__mockAccountCalls ?? []);
  return calls.filter((call) => call.name === name);
}

test.describe('Settings > Accounts', () => {
  test('one account: its login and usage, no run order, nothing to switch or remove', async () => {
    const { browser, page } = await launchPage();
    try {
      await openAccounts(page);
      const row = page.getByTestId('account-row-account-claude-1');
      await expect(row.getByTestId('account-name')).toHaveText('dev@example.com');
      await expect(row.getByTestId('account-usage-line')).toHaveCount(2);
      await expect(page.getByTestId('settings-card-accounts-run-order')).toHaveCount(0);
      await expect(row.getByTestId('account-switch-to')).toHaveCount(0);
      await expect(row.getByTestId('account-menu')).toHaveCount(0);
      await expect(page.getByTestId('accounts-add-claude')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('three accounts: the first with room is Active, a full one is skipped, a signed-out one says so', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(THREE_ACCOUNTS) });
    try {
      await openAccounts(page);
      await expect(page.getByTestId('settings-card-accounts-run-order')).toBeVisible();

      const full = page.getByTestId('account-row-account-1');
      const withRoom = page.getByTestId('account-row-account-2');
      const signedOut = page.getByTestId('account-row-account-3');
      // At its weekly limit: skipped, and offered no switch it could not honor as the active one.
      await expect(full.getByTestId('account-place')).toHaveAttribute('data-skipped', '');
      await expect(full).not.toContainText('Active');
      await expect(withRoom).toContainText('Active');
      await expect(withRoom.getByTestId('account-place')).not.toHaveAttribute('data-skipped', '');
      await expect(withRoom.getByTestId('account-usage-line')).toHaveCount(2);
      await expect(signedOut).toContainText('Not signed in');
      await expect(signedOut.getByTestId('account-usage-line')).toHaveCount(0);
      await expect(signedOut.getByTestId('account-switch-to')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Switch to moves the account to #1', async () => {
    const cards = [{ agent: 'claude', accounts: [
      { id: 'account-1', email: 'one@example.com', plan: 'Max', lastUsage: [sevenDay(20, 3 * DAY)] },
      { id: 'account-2', email: 'two@example.com', plan: 'Max', lastUsage: [sevenDay(30, 2 * DAY)] },
    ] }];
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(cards) });
    try {
      await openAccounts(page);
      await page.getByTestId('account-row-account-2').getByTestId('account-switch-to').click();
      await expect.poll(async () => (await accountCalls(page, 'switchTo')).length, { timeout: 3000 }).toBe(1);
      const names = page.getByTestId('settings-card-accounts-claude').getByTestId('account-name');
      await expect(names.first()).toHaveText('two@example.com');
      await expect(page.getByTestId('account-row-account-2')).toContainText('Active');
      // With no session running, the toast says where new ones start.
      const toast = page.getByTestId('toast');
      await expect(toast.getByTestId('toast-title')).toHaveText('Switched account');
      await expect(toast.getByTestId('toast-body')).toHaveText(/^New .+ sessions start on two@example\.com\.$/);
    } finally {
      await browser.close();
    }
  });

  test('the switch toast counts the running sessions that moved, and says when some could not', async () => {
    const cards = [{ agent: 'claude', accounts: [
      { id: 'account-1', email: 'one@example.com', plan: 'Max', lastUsage: [sevenDay(20, 3 * DAY)] },
      { id: 'account-2', email: 'two@example.com', plan: 'Max', lastUsage: [sevenDay(30, 2 * DAY)] },
    ] }];
    const outcome = (page: Page, moved: number, failed: number) => page.evaluate((next) => {
      (window as unknown as { __mockAccountSwitchOutcome: { moved: number; failed: number } }).__mockAccountSwitchOutcome = next;
    }, { moved, failed });
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(cards) });
    try {
      await openAccounts(page);
      // Main answers once the running sessions have moved: three did.
      await outcome(page, 3, 0);
      await page.getByTestId('account-row-account-2').getByTestId('account-switch-to').click();
      const moved = page.getByTestId('toast').filter({ hasText: 'Switched account' });
      await expect(moved.getByTestId('toast-body')).toHaveText('3 running sessions moved to two@example.com.');

      // One could not be restarted, so the toast is the failure, not a success beside it.
      await outcome(page, 2, 1);
      await page.getByTestId('account-row-account-1').getByTestId('account-switch-to').click();
      const failed = page.getByTestId('toast').filter({ hasText: "Couldn't move every session" });
      await expect(failed.getByTestId('toast-body')).toHaveText('1 running session stays on its account.');
    } finally {
      await browser.close();
    }
  });

  test('with a session running on another account, Switch to switches at once with no menu', async () => {
    const cards = [{ agent: 'claude', accounts: [
      { id: 'account-1', email: 'one@example.com', plan: 'Max', lastUsage: [sevenDay(20, 3 * DAY)] },
      { id: 'account-2', email: 'two@example.com', plan: 'Max', lastUsage: [sevenDay(30, 2 * DAY)] },
    ] }];
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(cards) });
    try {
      await openAccounts(page);
      // A task session running on account 1, as main's registry would report it.
      await page.evaluate(() => {
        interface SessionStoreHandle { setState: (update: (state: { sessions: unknown[] }) => { sessions: unknown[] }) => void }
        const stores = (window as unknown as { __zustandStores: { session: SessionStoreHandle } }).__zustandStores;
        stores.session.setState((state) => ({
          sessions: [...state.sessions, {
            id: 'running-session', taskId: 'running-task', projectId: 'another-project', pid: 1, status: 'running', shell: 'bash',
            cwd: '/mock/project', startedAt: new Date().toISOString(), exitCode: null, resuming: false, isolatedSwimlaneId: null,
            agentSessionId: null, accountId: 'account-1',
          }],
        }));
      });

      await page.getByTestId('account-row-account-2').getByTestId('account-switch-to').click();
      // Main moves the running session; the renderer asks once and opens no menu.
      await expect.poll(async () => (await accountCalls(page, 'switchTo')).map((call) => call.args), { timeout: 3000 })
        .toEqual([['account-2']]);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.getByTestId('account-row-account-2')).toContainText('Active');
    } finally {
      await browser.close();
    }
  });

  test('Remove asks first, names the account, and takes it out of the list', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(THREE_ACCOUNTS) });
    try {
      await openAccounts(page);
      await page.getByTestId('account-row-account-2').getByTestId('account-menu').click();
      await page.getByTestId('account-remove').click();
      const confirm = page.getByTestId('account-remove-confirm');
      await expect(confirm).toContainText('Remove two@example.com?');
      expect(await accountCalls(page, 'remove')).toHaveLength(0);

      await page.getByTestId('account-remove-confirm-confirm').click();
      await expect(page.getByTestId('account-row-account-2')).toHaveCount(0);
      await expect(page.getByTestId('account-row-account-1')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('the agent own login has no Remove', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(THREE_ACCOUNTS) });
    try {
      await openAccounts(page);
      // The first seeded account is the agent's own login (`default`), signed in.
      await expect(page.getByTestId('account-row-account-1').getByTestId('account-menu')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Add account opens the sign-in terminal, and a finished sign-in adds the row and closes it', async () => {
    const { browser, page } = await launchPage();
    try {
      await openAccounts(page);
      await page.getByTestId('accounts-add-claude').click();
      const dialog = page.getByTestId('account-login-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('account-login-terminal')).toContainText('Opening your browser to sign in');

      await page.evaluate(() => {
        (window as unknown as { __mockFinishAccountLogin: (identity: { email: string; plan: string }) => void })
          .__mockFinishAccountLogin({ email: 'second@example.com', plan: 'Pro' });
      });
      await expect(dialog).toHaveCount(0);
      const names = page.getByTestId('settings-card-accounts-claude').getByTestId('account-name');
      await expect(names).toHaveText(['dev@example.com', 'second@example.com']);
      // Two accounts now, so the run order shows.
      await expect(page.getByTestId('settings-card-accounts-run-order')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a CLI that signs in on its own screen says to exit it, where a browser sign-in says how to pick the account', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts([
      { agent: 'claude', accounts: [{ id: 'account-1', email: 'one@example.com', plan: 'Max' }] },
      { agent: 'gemini', signInIsInteractive: true, reportsUsage: false, accounts: [{ id: 'account-g1', email: 'google@example.com' }] },
    ]) });
    try {
      await openAccounts(page);
      await page.getByTestId('accounts-add-gemini').click();
      await expect(page.getByTestId('account-login-hint')).toHaveText(/^Sign in here, then exit .+ to finish\.$/);
      await page.getByTestId('account-login-close').click();
      await expect(page.getByTestId('account-login-dialog')).toHaveCount(0);

      await page.getByTestId('accounts-add-claude').click();
      await expect(page.getByTestId('account-login-hint')).toContainText('use its Switch account');
    } finally {
      await browser.close();
    }
  });

  test('keys typed and text pasted into the sign-in terminal reach the sign-in', async () => {
    const { browser, page } = await launchPage();
    try {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await openAccounts(page);
      await page.getByTestId('accounts-add-claude').click();
      const terminal = page.getByTestId('account-login-terminal');
      await expect(terminal).toContainText('Opening your browser to sign in');
      const typed = async (): Promise<string> => (await accountCalls(page, 'loginInput')).map((call) => String(call.args[1])).join('');

      // The dialog opened for this sign-in, so its terminal has the keyboard with no click.
      await page.keyboard.type('abc');
      await expect.poll(typed, { timeout: 3000 }).toContain('abc');

      // A code the browser shows is pasted with Ctrl+V, which xterm alone sends as a control byte.
      await page.evaluate(() => navigator.clipboard.writeText('code-from-browser'));
      await page.keyboard.press('Control+v');
      await expect.poll(typed, { timeout: 3000 }).toContain('code-from-browser');
      expect(await typed()).not.toContain('\u0016');
    } finally {
      await browser.close();
    }
  });

  test('a sign-in that turns out to be an account already listed adds nothing and says which', async () => {
    const { browser, page } = await launchPage();
    try {
      await openAccounts(page);
      await page.getByTestId('accounts-add-claude').click();
      await expect(page.getByTestId('account-login-dialog')).toBeVisible();
      await page.evaluate(() => {
        (window as unknown as { __mockFinishAccountLogin: (identity: { email: string }) => void })
          .__mockFinishAccountLogin({ email: 'dev@example.com' });
      });
      await expect(page.getByTestId('account-login-result')).toHaveText('dev@example.com is already in the list.');
      await page.getByTestId('account-login-close').click();
      await expect(page.getByTestId('settings-card-accounts-claude').getByTestId('account-name')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('closing the dialog mid sign-in cancels it', async () => {
    const { browser, page } = await launchPage();
    try {
      await openAccounts(page);
      await page.getByTestId('accounts-add-claude').click();
      await expect(page.getByTestId('account-login-dialog')).toBeVisible();
      await page.getByTestId('account-login-close').click();
      await expect(page.getByTestId('account-login-dialog')).toHaveCount(0);
      await expect.poll(async () => (await accountCalls(page, 'cancelLogin')).length, { timeout: 3000 }).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('an environment key that overrides the accounts gets one line on the card', async () => {
    const cards = [{ agent: 'claude', overrides: [{ variable: 'ANTHROPIC_API_KEY', source: 'environment' }], accounts: [
      { id: 'account-1', email: 'one@example.com', plan: 'Max', lastUsage: [sevenDay(20, 3 * DAY)] },
    ] }];
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(cards) });
    try {
      await openAccounts(page);
      await expect(page.getByTestId('accounts-override-line')).toHaveText('ANTHROPIC_API_KEY overrides these accounts.');
    } finally {
      await browser.close();
    }
  });
});
