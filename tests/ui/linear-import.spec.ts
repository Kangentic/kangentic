/**
 * UI spec: importing from Linear, through the headless mock bridge.
 *
 * Covers what only the browser shows: the Connect Linear dialog's two ways in
 * (sign-in and API key), its waiting state and Back, the team picker in the
 * Import Sources popover, Linear rows in the Import dialog (the ENG-214 id, the
 * Status menu in board order, and alphabetical for a provider with no stateOrder,
 * the priority in the import payload), a team list that rejects showing its
 * message inline without opening Connect, and the error
 * banner's Connect button, which reopens a provider's Connect dialog for Linear
 * and for Asana alike.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

interface LinearPreset {
  state?: { connected: boolean; kind?: string; userName?: string };
  signInAvailable?: boolean;
  invalidKey?: string;
  listTeamsError?: string;
  listTeamsRejects?: string;
  signInResult?: { ok: boolean; cancelled?: boolean; error?: string };
}

async function seedLinear(page: Page, preset: LinearPreset): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __mockLinearPreset?: unknown }).__mockLinearPreset = value;
  }, preset);
}

async function openLinearProvider(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.locator('[data-testid="add-import-source-btn"]').first().click();
  await page.getByRole('button', { name: /Linear/ }).click();
}

function linearIssue(overrides: Record<string, unknown>) {
  return {
    externalSource: 'linear',
    externalUrl: 'https://linear.app/acme/issue/ENG-1/title',
    title: 'A Linear issue',
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

async function seedLinearSourceWithIssues(page: Page): Promise<void> {
  await page.evaluate((issues) => {
    const target = window as unknown as Record<string, unknown>;
    target.__mockImportSourcesPreset = [{
      id: 'linear-src',
      source: 'linear',
      label: 'Engineering',
      repository: 'ENG',
      url: 'https://linear.app/acme/team/ENG/all',
      createdAt: new Date().toISOString(),
    }];
    target.__mockImportReconcile = { issues, added: issues.length, updated: 0, removed: 0 };
  }, [
    linearIssue({ externalId: 'uuid-todo', displayId: 'ENG-201', title: 'Add CSV export to the audit log', state: 'Todo', stateOrder: 1 }),
    linearIssue({ externalId: 'uuid-review', displayId: 'ENG-198', title: 'Rate limit the public search endpoint', state: 'In Review', stateOrder: 3 }),
    linearIssue({ externalId: 'uuid-backlog', displayId: 'ENG-187', title: 'Migrate the session store', state: 'Backlog', stateOrder: 0 }),
    linearIssue({ externalId: 'uuid-progress', displayId: 'ENG-214', title: 'Retry webhook delivery', state: 'In Progress', stateOrder: 2, priority: 'High' }),
  ]);
}

async function openSourceDialog(page: Page, label: string): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.getByText(label).click();
  await page.locator('[data-testid="import-dialog"]').waitFor({ state: 'visible', timeout: 8000 });
}

test.describe('Connect Linear', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('picking Linear with no sign-in opens the two ways in', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { signInAvailable: true });
    await createProject(page, 'linear-connect');
    await openLinearProvider(page);

    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="linear-setup-sign-in-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="linear-setup-api-key-btn"]')).toBeVisible();

    await browser.close();
  });

  test('a working API key closes the dialog and lists the teams', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { signInAvailable: true });
    await createProject(page, 'linear-key');
    await openLinearProvider(page);

    await page.locator('[data-testid="linear-setup-api-key-btn"]').click();
    await page.locator('[data-testid="linear-setup-key-input"]').fill('lin_api_valid');
    await page.locator('[data-testid="linear-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="linear-team-ENG"]')).toContainText('Engineering');
    await expect(page.locator('[data-testid="linear-team-DES"]')).toContainText('Design');

    await page.locator('[data-testid="linear-team-ENG"]').click();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('a key Linear refuses keeps the dialog open with Linear\'s message', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { signInAvailable: true, invalidKey: 'lin_api_revoked' });
    await createProject(page, 'linear-bad-key');
    await openLinearProvider(page);

    await page.locator('[data-testid="linear-setup-api-key-btn"]').click();
    await page.locator('[data-testid="linear-setup-key-input"]').fill('lin_api_revoked');
    await page.locator('[data-testid="linear-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="linear-setup-error"]')).toHaveText('Authentication required, not authenticated');
    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('sign-in waits for the browser, and Back cancels it and returns to the choices', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { signInAvailable: true });
    await createProject(page, 'linear-sign-in');
    await openLinearProvider(page);

    await page.locator('[data-testid="linear-setup-sign-in-btn"]').click();
    await expect(page.locator('[data-testid="linear-setup-waiting"]')).toBeVisible();
    await page.locator('[data-testid="linear-setup-reopen-btn"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mockLinearReopenCount?: number }).__mockLinearReopenCount ?? 0)).toBe(1);

    await page.locator('[data-testid="linear-setup-back-btn"]').click();
    await expect(page.locator('[data-testid="linear-setup-sign-in-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="linear-setup-error"]')).toHaveCount(0);

    await browser.close();
  });

  test('a finished sign-in closes the dialog and lists the teams', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { signInAvailable: true, signInResult: { ok: true } });
    await createProject(page, 'linear-sign-in-ok');
    await openLinearProvider(page);

    await page.locator('[data-testid="linear-setup-sign-in-btn"]').click();
    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="linear-team-picker"]')).toBeVisible();

    await browser.close();
  });

  test('a build with no sign-in opens straight on the key steps, with no Back', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { signInAvailable: false });
    await createProject(page, 'linear-key-only');
    await openLinearProvider(page);

    await expect(page.locator('[data-testid="linear-setup-key-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="linear-setup-sign-in-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="linear-setup-back-btn"]')).toHaveCount(0);

    await browser.close();
  });
});

test.describe('Linear team picker', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('a team already saved says Added and opens its source', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { state: { connected: true, kind: 'api_key' } });
    await page.evaluate(() => {
      (window as unknown as { __mockImportSourcesPreset?: unknown }).__mockImportSourcesPreset = [{
        id: 'linear-eng', source: 'linear', label: 'Engineering', repository: 'ENG',
        url: 'https://linear.app/acme/team/ENG/all', createdAt: new Date().toISOString(),
      }];
    });
    await createProject(page, 'linear-picker-added');
    await openLinearProvider(page);

    await expect(page.locator('[data-testid="linear-team-ENG"]')).toContainText('Added');
    await expect(page.locator('[data-testid="linear-team-DES"]')).not.toContainText('Added');
    await page.locator('[data-testid="linear-team-ENG"]').click();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('a team list that fails on sign-in reopens Connect with Linear\'s message', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { state: { connected: true, kind: 'api_key' }, listTeamsError: 'Authentication required, not authenticated' });
    await createProject(page, 'linear-picker-auth');
    await openLinearProvider(page);

    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="linear-setup-error"]')).toHaveText('Authentication required, not authenticated');

    await browser.close();
  });

  test('a team list that rejects shows the message inline and does not open Connect', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { state: { connected: true, kind: 'api_key' }, listTeamsRejects: 'fetch failed' });
    await createProject(page, 'linear-picker-rejects');
    await openLinearProvider(page);

    await expect(page.locator('[data-testid="linear-team-picker-load-error"]')).toHaveText('fetch failed');
    await expect(page.locator('[data-testid="linear-team-picker-loading"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toHaveCount(0);

    await browser.close();
  });
});

test.describe('Linear issues in the Import dialog', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('rows show the issue key, and the search finds it', async () => {
    const { browser, page } = await launchPage();
    await seedLinearSourceWithIssues(page);
    await createProject(page, 'linear-rows');
    await openSourceDialog(page, 'Engineering');

    const row = page.locator('[data-testid="import-issue-uuid-progress"]');
    await expect(row).toContainText('ENG-214');
    await expect(row).not.toContainText('#uuid-progress');

    await page.locator('[data-testid="import-search"]').fill('ENG-214');
    await expect(page.locator('[data-testid^="import-issue-"]')).toHaveCount(1);

    await browser.close();
  });

  test('the Status menu lists states in board order', async () => {
    const { browser, page } = await launchPage();
    await seedLinearSourceWithIssues(page);
    await createProject(page, 'linear-status-order');
    await openSourceDialog(page, 'Engineering');

    await page.getByRole('button', { name: /^Status/ }).click();
    const options = page.locator('[data-testid^="filter-option-status-"]');
    await expect(options).toHaveText(['Backlog', 'Todo', 'In Progress', 'In Review']);

    await browser.close();
  });

  test('the Status menu stays alphabetical for a provider with no stateOrder', async () => {
    const { browser, page } = await launchPage();
    const issueBase = {
      externalSource: 'github_issues',
      externalUrl: 'https://github.com/org/repo/issues/1',
      body: '',
      labels: [],
      assignee: null,
      stateCategory: 'open',
      createdAt: new Date('2026-11-01').toISOString(),
      updatedAt: new Date('2026-11-01').toISOString(),
      alreadyImported: false,
      attachmentCount: 0,
    };
    await page.evaluate((base) => {
      const target = window as unknown as Record<string, unknown>;
      target.__mockImportSourcesPreset = [{
        id: 'gh-src', source: 'github_issues', label: 'org/repo', repository: 'org/repo',
        url: 'https://github.com/org/repo', createdAt: new Date().toISOString(),
      }];
      const issues = [
        { ...base, externalId: 'gh-triage', title: 'Triage item', state: 'Triage' },
        { ...base, externalId: 'gh-backlog', title: 'Backlog item', state: 'Backlog' },
        { ...base, externalId: 'gh-review', title: 'Review item', state: 'In Review' },
        { ...base, externalId: 'gh-active', title: 'Active item', state: 'Active' },
      ];
      target.__mockImportReconcile = { issues, added: issues.length, updated: 0, removed: 0 };
    }, issueBase);
    await createProject(page, 'github-status-order');
    await openSourceDialog(page, 'org/repo');

    await page.getByRole('button', { name: /^Status/ }).click();
    const options = page.locator('[data-testid^="filter-option-status-"]');
    await expect(options).toHaveText(['Active', 'Backlog', 'In Review', 'Triage']);

    await browser.close();
  });

  test('importing passes the issue\'s priority name', async () => {
    const { browser, page } = await launchPage();
    await seedLinearSourceWithIssues(page);
    await createProject(page, 'linear-priority');
    await openSourceDialog(page, 'Engineering');

    await page.locator('[data-testid="import-issue-uuid-progress"]').click();
    await page.locator('[data-testid="import-execute-btn"]').click();
    await expect.poll(() => page.evaluate(() => {
      const input = (window as unknown as { __lastImportExecuteInput?: { issues: Array<{ priority?: string }> } }).__lastImportExecuteInput;
      return input?.issues[0]?.priority ?? null;
    })).toBe('High');

    await browser.close();
  });
});

test.describe('Import dialog Connect button', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('a refused Linear sign-in offers Connect Linear, and a new key clears the banner', async () => {
    const { browser, page } = await launchPage();
    await seedLinear(page, { signInAvailable: true });
    await seedLinearSourceWithIssues(page);
    await page.evaluate(() => {
      (window as unknown as { __mockImportCheckCli?: unknown }).__mockImportCheckCli = {
        linear: { available: true, authenticated: false, error: 'Authentication required, not authenticated' },
      };
    });
    await createProject(page, 'linear-reconnect');
    await openSourceDialog(page, 'Engineering');

    await expect(page.locator('[data-testid="import-cli-error"]')).toContainText('Authentication required, not authenticated');
    await page.locator('[data-testid="import-connect-provider-btn"]').click();
    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="linear-setup-error"]')).toHaveText('Authentication required, not authenticated');

    // The next check passes, as it would with a working key saved.
    await page.evaluate(() => {
      (window as unknown as { __mockImportCheckCli?: unknown }).__mockImportCheckCli = null;
    });
    await page.locator('[data-testid="linear-setup-api-key-btn"]').click();
    await page.locator('[data-testid="linear-setup-key-input"]').fill('lin_api_new');
    await page.locator('[data-testid="linear-setup-save-btn"]').click();

    await expect(page.locator('[data-testid="linear-setup-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="import-cli-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="import-issue-uuid-progress"]')).toBeVisible();

    await browser.close();
  });

  test('Asana gets the same button, and a CLI provider gets none', async () => {
    const { browser, page } = await launchPage();
    await page.evaluate(() => {
      const target = window as unknown as Record<string, unknown>;
      target.__mockImportSourcesPreset = [
        { id: 'asana-src', source: 'asana', label: 'Launch plan', repository: '123', url: 'https://app.asana.com/0/123/list', createdAt: new Date().toISOString() },
        { id: 'gh-src', source: 'github_issues', label: 'org/repo', repository: 'org/repo', url: 'https://github.com/org/repo', createdAt: new Date().toISOString() },
      ];
      target.__mockImportCheckCli = { available: true, authenticated: false, error: 'Not authenticated' };
    });
    await createProject(page, 'asana-reconnect');

    await openSourceDialog(page, 'Launch plan');
    await expect(page.locator('[data-testid="import-connect-provider-btn"]')).toHaveText('Connect Asana');
    await page.locator('[data-testid="import-connect-provider-btn"]').click();
    await expect(page.locator('[data-testid="asana-setup-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="asana-setup-error"]')).toHaveText('Not authenticated');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="asana-setup-dialog"]')).toBeHidden();
    // The Escape closed only the Connect dialog on top.
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="import-dialog"]')).toBeHidden();
    await page.locator('[data-testid="import-sources-btn"]').first().click();
    await page.getByText('org/repo', { exact: true }).click();
    await expect(page.locator('[data-testid="import-cli-error"]')).toContainText('Not authenticated');
    await expect(page.locator('[data-testid="import-connect-provider-btn"]')).toHaveCount(0);

    await browser.close();
  });
});
