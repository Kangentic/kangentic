/**
 * Settings > Accounts, the flows settings-accounts.spec.ts does not reach (task #1057): a drag
 * reorders and the bridge hears the new order, the Order control and the auto-switch switch write
 * their config keys, a key-file agent's failed Add account raises its toast, the empty and remote
 * cards, which rows have a menu, the context bar's tip naming the session's account, and the
 * sign-in terminal's backlog handoff. Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

interface MockCall { name: string; args: unknown[] }

async function openAccountsTab(page: Page): Promise<void> {
  await createProject(page, `settings-accounts-flows-${Date.now()}`);
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(page.getByTestId('accounts-tab')).toBeVisible();
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

const TWO_ACCOUNTS = [{
  agent: 'claude',
  accounts: [
    { id: 'account-1', email: 'one@example.com', plan: 'Max' },
    { id: 'account-2', email: 'two@example.com', plan: 'Max' },
  ],
}];

test.describe('Settings > Accounts: order and switches', () => {
  test('dragging a grip reorders the two accounts and the bridge receives the new order', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(TWO_ACCOUNTS) });
    try {
      await openAccountsTab(page);
      const firstGrip = page.getByTestId('account-row-account-1').getByLabel('Reorder');
      const secondRow = page.getByTestId('account-row-account-2');
      const gripBox = await firstGrip.boundingBox();
      const targetBox = await secondRow.boundingBox();
      if (!gripBox || !targetBox) throw new Error('The grip or the second row has no box');
      const startX = gripBox.x + gripBox.width / 2;
      const startY = gripBox.y + gripBox.height / 2;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 4, startY + 12, { steps: 4 });
      await page.mouse.move(startX, targetBox.y + targetBox.height * 0.7, { steps: 15 });
      await page.mouse.up();

      await expect.poll(async () => (await accountCalls(page, 'reorder')).map((call) => call.args), { timeout: 3000 })
        .toEqual([['claude', ['account-2', 'account-1']]]);
      const names = page.getByTestId('settings-card-accounts-claude').getByTestId('account-name');
      await expect(names).toHaveText(['two@example.com', 'one@example.com']);
    } finally {
      await browser.close();
    }
  });

  test('the Order control writes agent.accounts.orderMode', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(TWO_ACCOUNTS) });
    try {
      await openAccountsTab(page);
      const control = page.getByTestId('accounts-order-mode');
      await expect(control.getByRole('radio', { name: 'Automatic' })).toBeChecked();

      await control.getByRole('radio', { name: 'Manual' }).click();
      await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).agent.accounts.orderMode), { timeout: 3000 })
        .toBe('manual');
      await expect(control.getByRole('radio', { name: 'Manual' })).toBeChecked();

      await control.getByRole('radio', { name: 'Automatic' }).click();
      await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).agent.accounts.orderMode), { timeout: 3000 })
        .toBe('automatic');
    } finally {
      await browser.close();
    }
  });

  test('the auto-switch switch writes agent.accounts.autoSwitchAtLimit', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(TWO_ACCOUNTS) });
    try {
      await openAccountsTab(page);
      const readValue = () => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).agent.accounts.autoSwitchAtLimit);
      expect(await readValue()).toBe(true);
      const toggle = page.getByTestId('setting-row-accounts.autoSwitchAtLimit');
      await toggle.click();
      await expect.poll(readValue, { timeout: 3000 }).toBe(false);
      await toggle.click();
      await expect.poll(readValue, { timeout: 3000 }).toBe(true);
    } finally {
      await browser.close();
    }
  });
});

test.describe('Settings > Accounts: key-file Add account failures', () => {
  const failures: Array<{ reason: string; body: string | RegExp }> = [
    { reason: 'unsupported', body: /does not take a key file\.$/ },
    { reason: 'unreadable', body: 'The file could not be read.' },
    { reason: 'no-keys', body: /^The file sets none of the keys .+ reads\.$/ },
    { reason: 'duplicate', body: 'That file is already in the list.' },
  ];
  for (const failure of failures) {
    test(`a ${failure.reason} answer raises the Couldn't add account toast`, async () => {
      const cards = [{ agent: 'codex', kind: 'key-file', accounts: [{ id: 'account-k1' }] }];
      const { browser, page } = await launchPage({
        beforeLoad: async (target) => {
          await seedAccounts(cards)(target);
          await target.addInitScript((reason) => {
            (window as unknown as { __mockAccountKeyFileResult: unknown }).__mockAccountKeyFileResult = { ok: false, reason };
          }, failure.reason);
        },
      });
      try {
        await openAccountsTab(page);
        await page.getByTestId('accounts-add-codex').click();
        const toast = page.getByTestId('toast').filter({ hasText: "Couldn't add account" });
        await expect(toast.getByTestId('toast-title')).toHaveText("Couldn't add account");
        await expect(toast.getByTestId('toast-body')).toHaveText(failure.body);
        expect(await accountCalls(page, 'addKeyFile')).toHaveLength(1);
      } finally {
        await browser.close();
      }
    });
  }
});

test.describe('Settings > Accounts: cards and rows', () => {
  test('a card for a target that cannot hold accounts shows the remote note and no Add account', async () => {
    const cards = [{ agent: 'claude', unsupportedTarget: true, accounts: [{ id: 'account-1', email: 'one@example.com' }] }];
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(cards) });
    try {
      await openAccountsTab(page);
      await expect(page.getByTestId('accounts-remote-note')).toBeVisible();
      await expect(page.getByTestId('accounts-add-claude')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('no cards shows the empty card', async () => {
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts([]) });
    try {
      await openAccountsTab(page);
      await expect(page.getByTestId('settings-card-accounts-empty')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a signed-out folder row signs in from its menu; a signed-out default row has no menu button', async () => {
    const cards = [{ agent: 'claude', accounts: [
      { id: 'account-1', status: 'signed-out' },
      { id: 'account-2', email: 'two@example.com', status: 'signed-out' },
    ] }];
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(cards) });
    try {
      await openAccountsTab(page);
      // The agent's own login is signed in from its CLI, so its row has nothing to open.
      await expect(page.getByTestId('account-row-account-1')).toContainText('Not signed in');
      await expect(page.getByTestId('account-row-account-1').getByTestId('account-menu')).toHaveCount(0);

      await page.getByTestId('account-row-account-2').getByTestId('account-menu').click();
      await page.getByTestId('account-sign-in').click();
      await expect.poll(async () => (await accountCalls(page, 'startLogin')).map((call) => call.args), { timeout: 3000 })
        .toEqual([[{ accountId: 'account-2' }]]);
      await expect(page.getByTestId('account-login-dialog')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a key-file agent shows each key file with its key count, and "No key file" for its own row', async () => {
    const cards = [{ agent: 'codex', kind: 'key-file', accounts: [
      { id: 'account-own' },
      { id: 'account-key', kind: 'key-file', keyFilePath: '/keys/work.env', keyNames: ['FIRST_KEY', 'SECOND_KEY'] },
    ] }];
    const { browser, page } = await launchPage({ beforeLoad: seedAccounts(cards) });
    try {
      await openAccountsTab(page);
      await expect(page.getByTestId('account-row-account-own').getByTestId('account-name')).toHaveText('No key file');
      const keyRow = page.getByTestId('account-row-account-key');
      await expect(keyRow.getByTestId('account-name')).toHaveText('work.env');
      await expect(keyRow).toContainText('2');
    } finally {
      await browser.close();
    }
  });
});

const PROJECT_ID = 'proj-account-tip';
const TASK_ID = 'task-account-tip';
const SESSION_ID = 'sess-account-tip';
const SWIMLANE_ID = 'lane-account-tip';

/** One running Claude session on `account-a`, with usage and rate limits, as rate-limits-sync seeds it. */
function seedSessionOnAccount(page: Page): Promise<void> {
  return page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'Account Tip', path: '/mock/account-tip', github_url: null,
        default_agent: 'claude', last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push({ id: i === 0 ? '${SWIMLANE_ID}' : state.uuid(), name: s.name, role: s.role, color: s.color,
          icon: s.icon, is_archived: s.is_archived, permission_strategy: s.permission_strategy ?? null,
          auto_spawn: s.auto_spawn ?? false, position: i, created_at: ts });
      });
      state.sessions.push({ id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999, status: 'running',
        shell: 'bash', cwd: '/mock/account-tip', startedAt: ts, exitCode: null, accountId: 'account-a' });
      state.activityCache['${SESSION_ID}'] = 'idle';
      state.tasks.push({ id: '${TASK_ID}', title: 'Account tip task', description: '', swimlane_id: '${SWIMLANE_ID}', position: 0,
        agent: 'claude', session_id: '${SESSION_ID}', worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts });
      return { currentProjectId: '${PROJECT_ID}' };
    });
    window.electronAPI.sessions.getUsage = async function () {
      var nowSeconds = Math.floor(Date.now() / 1000);
      var result = {};
      result['${SESSION_ID}'] = {
        model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
        contextWindow: { usedPercentage: 25, usedTokens: 1500, cacheTokens: 0, totalInputTokens: 1000, totalOutputTokens: 500, contextWindowSize: 200000 },
        cost: { totalCostUsd: 0.01, totalDurationMs: 5000 },
        rateLimits: [{ id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 41, resetsAt: nowSeconds + 86400 * 5, windowDurationSeconds: 7 * 24 * 60 * 60 }],
      };
      return result;
    };
  `);
}

async function openRateLimitsTip(page: Page) {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator(`[data-task-id="${TASK_ID}"]`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });
  const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
  await expect(contextBar).toBeVisible({ timeout: 10000 });
  const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
  await expect(pill).toBeVisible();
  await pill.hover();
  const tip = page.locator('[data-testid="rate-limits-tip"]');
  await expect(tip).toBeVisible();
  return tip;
}

test.describe('Context bar rate-limits tip names the account', () => {
  test('an agent with two accounts: the tip names the session account', async () => {
    const { browser, page } = await launchPage({
      beforeLoad: async (target) => {
        await seedAccounts([{ agent: 'claude', accounts: [
          { id: 'account-b', email: 'other@example.com' },
          { id: 'account-a', email: 'session@example.com' },
        ] }])(target);
        await seedSessionOnAccount(target);
      },
    });
    try {
      const tip = await openRateLimitsTip(page);
      await expect(tip.getByTestId('rate-limits-tip-account')).toHaveText('session@example.com');
    } finally {
      await browser.close();
    }
  });

  test('an agent with one account: the tip names no account', async () => {
    const { browser, page } = await launchPage({
      beforeLoad: async (target) => {
        await seedAccounts([{ agent: 'claude', accounts: [{ id: 'account-a', email: 'session@example.com' }] }])(target);
        await seedSessionOnAccount(target);
      },
    });
    try {
      const tip = await openRateLimitsTip(page);
      await expect(tip.getByTestId('rate-limits-tip-window')).toHaveCount(1);
      await expect(tip.getByTestId('rate-limits-tip-account')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

type BacklogWindow = {
  __backlogRequested?: boolean;
  __settleBacklog?: (outcome: { backlog: string } | { error: true }) => void;
  __mockAccountLoginOutput: (data: string) => void;
};

/** Holds the sign-in terminal's backlog read open until the spec settles it. */
async function holdBacklog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as BacklogWindow;
    window.electronAPI.accounts.loginBacklog = () => new Promise<string>((resolve, reject) => {
      target.__backlogRequested = true;
      target.__settleBacklog = (outcome) => {
        if ('backlog' in outcome) resolve(outcome.backlog);
        else reject(new Error('no backlog'));
      };
    });
  });
}

async function terminalText(page: Page): Promise<string> {
  return page.getByTestId('account-login-terminal').locator('.xterm-rows').innerText();
}

test.describe('Sign-in terminal backlog handoff', () => {
  test('output that arrives before the backlog is not written twice, and live output follows in order', async () => {
    const { browser, page } = await launchPage();
    try {
      await openAccountsTab(page);
      await holdBacklog(page);
      await page.getByTestId('accounts-add-claude').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as BacklogWindow).__backlogRequested === true), { timeout: 5000 }).toBe(true);

      // Main already kept this chunk in the backlog it is about to answer with.
      await page.evaluate(() => (window as unknown as BacklogWindow).__mockAccountLoginOutput('HELD-CHUNK\r\n'));
      await page.evaluate(() => (window as unknown as BacklogWindow).__settleBacklog?.({ backlog: 'OLD-LINE\r\nHELD-CHUNK\r\n' }));
      await expect(page.getByTestId('account-login-terminal')).toContainText('HELD-CHUNK');
      await page.evaluate(() => (window as unknown as BacklogWindow).__mockAccountLoginOutput('LIVE-LINE\r\n'));
      await expect(page.getByTestId('account-login-terminal')).toContainText('LIVE-LINE');

      const text = await terminalText(page);
      expect(text.split('HELD-CHUNK')).toHaveLength(2);
      expect(text.indexOf('OLD-LINE')).toBeLessThan(text.indexOf('HELD-CHUNK'));
      expect(text.indexOf('HELD-CHUNK')).toBeLessThan(text.indexOf('LIVE-LINE'));
    } finally {
      await browser.close();
    }
  });

  test('when the backlog cannot be read, the held output is written, once and in order', async () => {
    const { browser, page } = await launchPage();
    try {
      await openAccountsTab(page);
      await holdBacklog(page);
      await page.getByTestId('accounts-add-claude').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as BacklogWindow).__backlogRequested === true), { timeout: 5000 }).toBe(true);

      await page.evaluate(() => {
        const target = window as unknown as BacklogWindow;
        target.__mockAccountLoginOutput('HELD-FIRST\r\n');
        target.__mockAccountLoginOutput('HELD-SECOND\r\n');
        target.__settleBacklog?.({ error: true });
      });
      await expect(page.getByTestId('account-login-terminal')).toContainText('HELD-SECOND');

      const text = await terminalText(page);
      expect(text.split('HELD-FIRST')).toHaveLength(2);
      expect(text.split('HELD-SECOND')).toHaveLength(2);
      expect(text.indexOf('HELD-FIRST')).toBeLessThan(text.indexOf('HELD-SECOND'));
    } finally {
      await browser.close();
    }
  });
});
