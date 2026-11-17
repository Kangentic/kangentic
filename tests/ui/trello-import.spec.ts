/**
 * UI spec: importing from Trello, through the headless mock bridge.
 *
 * Covers what only the browser shows: the Connect Trello dialog's two ways in (Kangentic's key,
 * where Trello shows the token to paste, and the user's own key), Trello's refusal text under the
 * field it blames, the board picker grouped by Workspace with Added, Trello rows in the Import
 * dialog (the #138 card number and the Status menu in list order), and the error banner's Connect
 * Trello button. The Connect dialog's choices and steps are drawn on the signed-off canvas, board 2.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

interface TrelloPreset {
  state?: { connected: boolean; kind?: string };
  signInAvailable?: boolean;
  invalidKey?: string;
  invalidToken?: string;
  listBoardsError?: string;
  listBoardsRejects?: string;
  connectRejects?: string;
  openApprovalRejects?: string;
  authStatusRejects?: string;
  boards?: Array<{ id: string; shortLink: string; name: string; url: string; workspaceName: string | null }>;
}

async function seedTrello(page: Page, preset: TrelloPreset): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __mockTrelloPreset?: unknown }).__mockTrelloPreset = value;
  }, preset);
}

async function openTrelloProvider(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.locator('[data-testid="add-import-source-btn"]').first().click();
  await page.getByRole('button', { name: /Trello/ }).click();
}

function trelloCard(overrides: Record<string, unknown>) {
  return {
    externalSource: 'trello',
    externalUrl: 'https://trello.com/c/Xk92LmQa',
    title: 'A Trello card',
    body: '',
    labels: [],
    assignee: null,
    stateCategory: 'open',
    createdAt: new Date('2026-11-01').toISOString(),
    updatedAt: new Date('2026-11-01').toISOString(),
    alreadyImported: false,
    attachmentCount: 0,
    ...overrides,
  };
}

async function seedTrelloSourceWithCards(page: Page): Promise<void> {
  await page.evaluate((issues) => {
    const target = window as unknown as Record<string, unknown>;
    target.__mockImportSourcesPreset = [{
      id: 'trello-src',
      source: 'trello',
      label: 'Sprint board',
      repository: 'AbC123xy',
      url: 'https://trello.com/b/AbC123xy/sprint-board',
      createdAt: new Date().toISOString(),
    }];
    target.__mockImportReconcile = { issues, added: issues.length, updated: 0, removed: 0 };
  }, [
    trelloCard({ externalId: '6731f2a00000000000000101', displayId: '#138', title: 'Invite emails land in spam', state: 'To Do', stateOrder: 1, labels: ['bug', 'green'] }),
    trelloCard({ externalId: '6731f2a00000000000000102', displayId: '#142', title: 'Export the weekly report as CSV', state: 'Doing', stateOrder: 2 }),
    trelloCard({ externalId: '6731f2a00000000000000103', displayId: '#121', title: 'Dark mode for the billing page', state: 'Backlog', stateOrder: 0 }),
    trelloCard({ externalId: '6731f2a00000000000000104', displayId: '#140', title: 'Shipped the onboarding email', state: 'Done', stateOrder: 3 }),
  ]);
}

async function openSourceDialog(page: Page, label: string): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.getByText(label).click();
  await page.locator('[data-testid="import-dialog"]').waitFor({ state: 'visible', timeout: 8000 });
}

test.describe('Connect Trello', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('a build with no Kangentic key opens straight on the own-key steps, with no Back', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: false });
    await createProject(page, 'trello-own-key-only');
    await openTrelloProvider(page);

    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="trello-setup-key-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="trello-setup-sign-in-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="trello-setup-back-btn"]')).toHaveCount(0);
    // There is no key to approve yet.
    await expect(page.locator('[data-testid="trello-setup-open-approval-btn"]')).toBeDisabled();

    await browser.close();
  });

  test('with a Kangentic key it opens on the two ways in, and sign-in asks only for the token', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: true });
    await createProject(page, 'trello-sign-in');
    await openTrelloProvider(page);

    await expect(page.locator('[data-testid="trello-setup-sign-in-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="trello-setup-own-key-btn"]')).toBeVisible();

    await page.locator('[data-testid="trello-setup-sign-in-btn"]').click();
    await expect(page.locator('[data-testid="trello-setup-key-input"]')).toHaveCount(0);
    await page.locator('[data-testid="trello-setup-open-approval-btn"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mockTrelloApprovalCount?: number }).__mockTrelloApprovalCount ?? 0)).toBe(1);

    await page.locator('[data-testid="trello-setup-token-input"]').fill('ATTAvalidtoken');
    await page.locator('[data-testid="trello-setup-save-btn"]').click();
    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="trello-board-picker"]')).toBeVisible();

    await browser.close();
  });

  test('a key Trello refuses shows Trello\'s text under the key, and the dialog stays open', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: false, invalidKey: 'made-up-key' });
    await createProject(page, 'trello-bad-key');
    await openTrelloProvider(page);

    await page.locator('[data-testid="trello-setup-key-input"]').fill('made-up-key');
    await page.locator('[data-testid="trello-setup-token-input"]').fill('ATTAtoken');
    await page.locator('[data-testid="trello-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="trello-setup-key-error"]')).toHaveText('invalid key');
    await expect(page.locator('[data-testid="trello-setup-token-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('Back from the sign-in step returns to the two ways in', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: true });
    await createProject(page, 'trello-back');
    await openTrelloProvider(page);

    await page.locator('[data-testid="trello-setup-sign-in-btn"]').click();
    await page.locator('[data-testid="trello-setup-back-btn"]').click();
    await expect(page.locator('[data-testid="trello-setup-own-key-btn"]')).toBeVisible();

    await browser.close();
  });

  test('Back from the own-key steps returns to the two ways in when sign-in is offered', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: true });
    await createProject(page, 'trello-own-key-back');
    await openTrelloProvider(page);

    await page.locator('[data-testid="trello-setup-own-key-btn"]').click();
    await expect(page.locator('[data-testid="trello-setup-key-input"]')).toBeVisible();
    await page.locator('[data-testid="trello-setup-back-btn"]').click();
    await expect(page.locator('[data-testid="trello-setup-sign-in-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="trello-setup-key-input"]')).toHaveCount(0);

    await browser.close();
  });

  test('a list refusal opens the two ways in with Trello\'s text above them', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { state: { connected: true, kind: 'own-key' }, signInAvailable: true, listBoardsError: 'invalid token' });
    await createProject(page, 'trello-initial-error');
    await openTrelloProvider(page);

    await expect(page.locator('[data-testid="trello-setup-error"]')).toHaveText('invalid token');
    await expect(page.locator('[data-testid="trello-setup-sign-in-btn"]')).toBeVisible();

    await browser.close();
  });

  test('a Connect that rejects shows the message under the token', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: false, connectRejects: 'Keychain unavailable' });
    await createProject(page, 'trello-connect-rejects');
    await openTrelloProvider(page);

    await page.locator('[data-testid="trello-setup-key-input"]').fill('key-1');
    await page.locator('[data-testid="trello-setup-token-input"]').fill('ATTAtoken');
    await page.locator('[data-testid="trello-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="trello-setup-token-error"]')).toHaveText('Keychain unavailable');
    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('an approval page that fails to open shows the message under the API key', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: false, openApprovalRejects: 'No browser' });
    await createProject(page, 'trello-approval-rejects');
    await openTrelloProvider(page);

    await page.locator('[data-testid="trello-setup-key-input"]').fill('key-1');
    await page.locator('[data-testid="trello-setup-open-approval-btn"]').click();

    await expect(page.locator('[data-testid="trello-setup-key-error"]')).toHaveText('No browser');
    await expect(page.locator('[data-testid="trello-setup-token-error"]')).toHaveCount(0);

    await browser.close();
  });

  test('an auth status that rejects falls back to the own-key steps', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: true, authStatusRejects: 'status failed' });
    await createProject(page, 'trello-status-rejects');
    await openTrelloProvider(page);

    await expect(page.locator('[data-testid="trello-setup-key-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="trello-setup-sign-in-btn"]')).toHaveCount(0);

    await browser.close();
  });

  test('a key or token with a space is refused under its own field', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: false });
    await createProject(page, 'trello-spaces');
    await openTrelloProvider(page);

    await page.locator('[data-testid="trello-setup-key-input"]').fill('key with space');
    await page.locator('[data-testid="trello-setup-token-input"]').fill('ATTAtoken');
    await page.locator('[data-testid="trello-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="trello-setup-key-error"]')).toHaveText('A key or token has no spaces. Copy it again from Trello.');
    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeVisible();

    await browser.close();
  });
});

test.describe('Trello board picker', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('boards sit under their Workspace, and a board already saved says Added and opens it', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { state: { connected: true, kind: 'own-key' } });
    await page.evaluate(() => {
      (window as unknown as { __mockImportSourcesPreset?: unknown }).__mockImportSourcesPreset = [{
        id: 'trello-bugs', source: 'trello', label: 'Bugs', repository: 'DeF456zw',
        url: 'https://trello.com/b/DeF456zw/bugs', createdAt: new Date().toISOString(),
      }];
    });
    await createProject(page, 'trello-picker');
    await openTrelloProvider(page);

    const groups = page.locator('[data-testid="trello-workspace-group"]');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toContainText('Acme Product');
    await expect(groups.nth(0).locator('[data-testid^="trello-board-"]')).toHaveCount(2);
    await expect(groups.nth(1)).toContainText('Marketing');

    await expect(page.locator('[data-testid="trello-board-DeF456zw"]')).toContainText('Added');
    await expect(page.locator('[data-testid="trello-board-AbC123xy"]')).not.toContainText('Added');
    await page.locator('[data-testid="trello-board-DeF456zw"]').click();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('a board that is not saved yet is added by its own URL', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { state: { connected: true, kind: 'own-key' } });
    await createProject(page, 'trello-picker-pick');
    await openTrelloProvider(page);

    await page.locator('[data-testid="trello-board-GhI789uv"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __lastImportSourcesAddInput?: { source: string; url: string } }).__lastImportSourcesAddInput ?? null))
      .toEqual({ source: 'trello', url: 'https://trello.com/b/GhI789uv/launch-checklist' });

    await browser.close();
  });

  test('a board with no Workspace sits under Other boards', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, {
      state: { connected: true, kind: 'own-key' },
      boards: [
        { id: 'board-a', shortLink: 'AbC123xy', name: 'Sprint board', url: 'https://trello.com/b/AbC123xy/sprint-board', workspaceName: 'Acme Product' },
        { id: 'board-solo', shortLink: 'ZzZ000aa', name: 'Personal', url: 'https://trello.com/b/ZzZ000aa/personal', workspaceName: null },
      ],
    });
    await createProject(page, 'trello-picker-other');
    await openTrelloProvider(page);

    const groups = page.locator('[data-testid="trello-workspace-group"]');
    await expect(groups).toHaveCount(2);
    await expect(groups.filter({ hasText: 'Other boards' }).locator('[data-testid="trello-board-ZzZ000aa"]')).toBeVisible();

    await browser.close();
  });

  test('a board list Trello refuses reopens Connect with Trello\'s text', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { state: { connected: true, kind: 'own-key' }, listBoardsError: 'invalid token' });
    await createProject(page, 'trello-picker-refused');
    await openTrelloProvider(page);

    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="trello-setup-token-error"]')).toHaveText('invalid token');

    await browser.close();
  });

  test('a board list that rejects shows the message inline and does not open Connect', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { state: { connected: true, kind: 'own-key' }, listBoardsRejects: 'fetch failed' });
    await createProject(page, 'trello-picker-rejects');
    await openTrelloProvider(page);

    await expect(page.locator('[data-testid="trello-board-picker-load-error"]')).toHaveText('fetch failed');
    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toHaveCount(0);

    await browser.close();
  });
});

test.describe('Trello cards in the Import dialog', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('rows show the card number, and the search finds it', async () => {
    const { browser, page } = await launchPage();
    await seedTrelloSourceWithCards(page);
    await createProject(page, 'trello-rows');
    await openSourceDialog(page, 'Sprint board');

    const row = page.locator('[data-testid="import-issue-6731f2a00000000000000101"]');
    await expect(row).toContainText('#138');
    await expect(row).not.toContainText('6731f2a00000000000000101');

    await page.locator('[data-testid="import-search"]').fill('#142');
    await expect(page.locator('[data-testid^="import-issue-"]')).toHaveCount(1);

    await browser.close();
  });

  test('the Status menu lists the board\'s lists in board order', async () => {
    const { browser, page } = await launchPage();
    await seedTrelloSourceWithCards(page);
    await createProject(page, 'trello-status-order');
    await openSourceDialog(page, 'Sprint board');

    await page.getByRole('button', { name: /^Status/ }).click();
    await expect(page.locator('[data-testid^="filter-option-status-"]')).toHaveText(['Backlog', 'To Do', 'Doing', 'Done']);

    await browser.close();
  });

  test('a refused token offers Connect Trello, and a new token clears the banner', async () => {
    const { browser, page } = await launchPage();
    await seedTrello(page, { signInAvailable: false });
    await seedTrelloSourceWithCards(page);
    await page.evaluate(() => {
      (window as unknown as { __mockImportCheckCli?: unknown }).__mockImportCheckCli = {
        trello: { available: true, authenticated: false, error: 'invalid token' },
      };
    });
    await createProject(page, 'trello-reconnect');
    await openSourceDialog(page, 'Sprint board');

    await expect(page.locator('[data-testid="import-cli-error"]')).toContainText('invalid token');
    await expect(page.locator('[data-testid="import-connect-provider-btn"]')).toHaveText('Connect Trello');
    await page.locator('[data-testid="import-connect-provider-btn"]').click();
    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="trello-setup-token-error"]')).toHaveText('invalid token');

    // The next check passes, as it would with a working token saved.
    await page.evaluate(() => {
      (window as unknown as { __mockImportCheckCli?: unknown }).__mockImportCheckCli = null;
    });
    await page.locator('[data-testid="trello-setup-key-input"]').fill('key-1');
    await page.locator('[data-testid="trello-setup-token-input"]').fill('ATTAnewtoken');
    await page.locator('[data-testid="trello-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="trello-setup-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="import-cli-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="import-issue-6731f2a00000000000000102"]')).toBeVisible();

    await browser.close();
  });
});
