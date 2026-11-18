/**
 * GitLab import in the browser: which ways in
 * Connect GitLab offers per server, GitLab's refusal text shown as sent, a link
 * whose server is not GitLab refused in the popover, the saved source's
 * subtitle, and the Import dialog's GitLab rows. Driven against the headless
 * mock (`window.__mockGitLabPreset`, `__mockImportSourcesPreset`).
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

async function openGitLabLinkStep(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.locator('[data-testid="add-import-source-btn"]').first().click();
  await page.getByRole('button', { name: /GitLab/ }).click();
  await expect(page.locator('[data-testid="import-source-url-input"]')).toBeVisible();
}

async function pasteAndConnect(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="import-source-url-input"]').fill(text);
  await page.locator('[data-testid="import-source-connect-btn"]').click();
}

async function setGitLabPreset(page: Page, preset: unknown): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __mockGitLabPreset?: unknown }).__mockGitLabPreset = value;
  }, preset);
}

test.describe('GitLab in Add Source', () => {
  test('a gitlab.com link in a build with no sign-in opens straight on the token steps, and connecting adds the source', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-com-token');
    await openGitLabLinkStep(page);
    await pasteAndConnect(page, 'https://gitlab.com/acme/web/-/issues');

    const dialog = page.locator('[data-testid="gitlab-connect-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-connect-open-tokens-btn"]')).toContainText('gitlab.com');
    // gitlab.com is implied: no Server field, and no choices to go Back to.
    await expect(page.locator('[data-testid="gitlab-connect-server-input"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-connect-back-btn"]')).toHaveCount(0);

    await page.locator('[data-testid="gitlab-connect-token-input"]').fill('glpat-good');
    await page.locator('[data-testid="gitlab-connect-connect-btn"]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
    const sent = await page.evaluate(() => (window as unknown as { __lastGitLabConnectInput?: unknown }).__lastGitLabConnectInput);
    expect(sent).toEqual({ site: 'gitlab.com', token: 'glpat-good' });
    await browser.close();
  });

  test('gitlab.com with the browser sign-in offers two choices; the waiting state goes Back to them', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-com-choices');
    await setGitLabPreset(page, { signInAvailable: true });
    await openGitLabLinkStep(page);
    await pasteAndConnect(page, 'https://gitlab.com/acme/web');

    await page.locator('[data-testid="gitlab-connect-choice-sign-in"]').click();
    await expect(page.locator('[data-testid="gitlab-connect-waiting"]')).toContainText('Waiting for GitLab in your browser');
    await page.locator('[data-testid="gitlab-connect-back-btn"]').click();
    await expect(page.locator('[data-testid="gitlab-connect-choice-token"]')).toBeVisible();

    await page.locator('[data-testid="gitlab-connect-choice-token"]').click();
    await expect(page.locator('[data-testid="gitlab-connect-token-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-connect-back-btn"]')).toBeVisible();
    await browser.close();
  });

  test('a self-managed link opens on the token steps with the server filled in, even when sign-in exists on gitlab.com', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-self-managed');
    await setGitLabPreset(page, { signInAvailable: true });
    await openGitLabLinkStep(page);
    await pasteAndConnect(page, 'https://git.example.com/platform/api');

    await expect(page.locator('[data-testid="gitlab-connect-server-input"]')).toHaveValue('git.example.com');
    await expect(page.locator('[data-testid="gitlab-connect-choice-sign-in"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gitlab-connect-open-tokens-btn"]')).toContainText('git.example.com');
    await browser.close();
  });

  test("a refused token shows GitLab's own text and keeps the dialog open", async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-rejected');
    await setGitLabPreset(page, { rejectToken: 'glpat-bad', rejectMessage: '401 Unauthorized' });
    await openGitLabLinkStep(page);
    await pasteAndConnect(page, 'https://gitlab.com/acme/web');

    await page.locator('[data-testid="gitlab-connect-token-input"]').fill('glpat-bad');
    await page.locator('[data-testid="gitlab-connect-connect-btn"]').click();
    await expect(page.locator('[data-testid="gitlab-connect-error"]')).toHaveText('401 Unauthorized');
    await expect(page.locator('[data-testid="gitlab-connect-dialog"]')).toBeVisible();
    await browser.close();
  });

  test('a link whose server is not GitLab is refused in the popover, with no Connect dialog', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-not-gitlab');
    await setGitLabPreset(page, { notGitLab: ['github.com'] });
    await openGitLabLinkStep(page);
    await pasteAndConnect(page, 'https://github.com/acme/web');

    await expect(page.locator('[data-testid="import-source-error"]')).toHaveText('github.com is not a GitLab instance.');
    await expect(page.locator('[data-testid="gitlab-connect-dialog"]')).toHaveCount(0);
    await browser.close();
  });
});

function gitLabIssue(id: number, displayId: string, title: string, state: string, stateOrder: number, workItemType: string) {
  return {
    externalId: `gitlab.com:${id}`,
    externalSource: 'gitlab',
    externalUrl: `https://gitlab.com/acme/web/-/work_items/${id}`,
    title,
    body: '',
    labels: ['backend'],
    assignee: 'dana',
    state,
    stateOrder,
    stateCategory: state === 'Closed' ? 'closed' : 'open',
    workItemType,
    displayId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    alreadyImported: false,
    attachmentCount: 0,
  };
}

test.describe('Saved GitLab sources and the Import dialog', () => {
  test("a group source on a self-managed server says so, and its rows use GitLab's group-relative ids in board order", async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-group-source');
    await page.evaluate((issues) => {
      const host = window as unknown as Record<string, unknown>;
      host.__mockImportSourcesPreset = [{
        id: 'gitlab-src',
        source: 'gitlab',
        label: 'acme',
        repository: 'https://git.example.com|acme',
        url: 'https://git.example.com/groups/acme/-/issues',
        createdAt: new Date().toISOString(),
        scopeKind: 'group',
        host: 'git.example.com',
      }];
      host.__mockImportCached = { issues };
      host.__mockImportReconcile = { issues };
      host.__mockGitLabPreset = { servers: { 'git.example.com': { account: 'dana' } } };
    }, [
      gitLabIssue(3, 'api#88', 'Closed thing', 'Closed', 2, 'Task'),
      gitLabIssue(1, 'web#214', 'Doing thing', 'workflow::doing', 1, 'Issue'),
      gitLabIssue(2, 'web#231', 'Open thing', 'Open', 0, 'Incident'),
    ]);

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="import-sources-btn"]').first().click();
    await expect(page.locator('[data-testid="import-source-gitlab-src"]')).toContainText('GitLab Group on git.example.com');
    await page.getByText('acme', { exact: true }).click();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();

    await expect(page.locator('[data-testid="import-issue-gitlab.com:1"]')).toContainText('web#214');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    const statusButton = page.getByRole('button', { name: 'Status' });
    await statusButton.click();
    await expect(page.locator('[data-testid^="filter-option-status-"]')).toHaveText(['Open', 'workflow::doing', 'Closed']);
    await browser.close();
  });

  test('a gitlab.com project source has no "on <host>" part, and a source with no scope or host keeps its plain type label', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-subtitles');
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>;
      const createdAt = new Date().toISOString();
      host.__mockImportSourcesPreset = [
        {
          id: 'gl-project',
          source: 'gitlab',
          label: 'acme/web',
          repository: 'https://gitlab.com|acme/web',
          url: 'https://gitlab.com/acme/web',
          createdAt,
          scopeKind: 'project',
        },
        {
          id: 'gh-plain',
          source: 'github_issues',
          label: 'acme/site',
          repository: 'acme/site',
          url: 'https://github.com/acme/site',
          createdAt,
        },
        {
          id: 'jira-plain',
          source: 'jira',
          label: 'PLAT',
          repository: 'PLAT',
          url: 'https://example.atlassian.net/jira/software/projects/PLAT',
          createdAt,
        },
      ];
    });

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="import-sources-btn"]').first().click();

    const subtitle = (sourceId: string) => page.locator(`[data-testid="import-source-${sourceId}"] span.text-fg-faint`);
    await expect(subtitle('gl-project')).toHaveText('GitLab Project');
    await expect(subtitle('gh-plain')).toHaveText('GitHub Issues');
    await expect(subtitle('jira-plain')).toHaveText('Jira Issues');
    await browser.close();
  });

  test("an expired token offers Connect GitLab, which reopens on the server's token steps with GitLab's text", async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'gitlab-reconnect');
    const expired = 'Token is expired. You can either do re-authorization or token refresh.';
    await page.evaluate((expiredText) => {
      const host = window as unknown as Record<string, unknown>;
      host.__mockImportSourcesPreset = [{
        id: 'gitlab-src',
        source: 'gitlab',
        label: 'platform/api',
        repository: 'https://git.example.com|platform/api',
        url: 'https://git.example.com/platform/api',
        createdAt: new Date().toISOString(),
        scopeKind: 'project',
        host: 'git.example.com',
      }];
      host.__mockImportCached = { issues: [] };
      host.__mockImportReconcile = { issues: [] };
      host.__mockGitLabPreset = { servers: { 'git.example.com': { account: 'dana' } } };
      host.__mockImportCheckCli = (source: string) => (source === 'gitlab'
        ? { available: true, authenticated: false, error: expiredText }
        : null);
    }, expired);

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="import-sources-btn"]').first().click();
    await page.getByText('platform/api', { exact: true }).click();
    await expect(page.locator('[data-testid="import-cli-error"]')).toContainText(expired);
    await page.locator('[data-testid="import-connect-provider-btn"]').click();

    await expect(page.locator('[data-testid="gitlab-connect-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-connect-server-input"]')).toHaveValue('git.example.com');
    await expect(page.locator('[data-testid="gitlab-connect-error"]')).toHaveText(expired);
    await browser.close();
  });
});
