/**
 * UI spec: ImportDialog filter behaviour introduced in the slow-filter perf fix.
 *
 * Covers four scenarios that are purely renderer/React state - no PTY, no
 * main process, no real IPC - so the UI tier is the correct home.
 *
 * 1. Empty-state messaging via serverSearchQuery
 *    Type a server search on a non-Projects source, seed importFetch to return
 *    zero results, assert "No items match your filters" and the Clear button.
 *
 * 2. clearFilters triggers a refetch when serverSearchQuery was non-empty
 *    Set a server search, click Clear filters, assert importFetch was called a
 *    second time and that the second call passed an empty searchQuery.
 *
 * 3. Stale-prefilter narrows the visible list immediately on non-Projects sources
 *    Seed multiple issues with distinct titles. Type a partial match. Assert
 *    non-matching rows disappear before the debounced refetch fires.
 *
 * 4. onToggle signature regression guard
 *    Click an individual row checkbox (not select-all). Assert only that row's
 *    checkbox becomes checked; all other rows remain unchecked.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

// ---------------------------------------------------------------------------
// Shared issue fixtures
// ---------------------------------------------------------------------------

const ISSUE_ALPHA = {
  externalId: 'alpha-1',
  externalUrl: 'https://github.com/org/repo/issues/1',
  title: 'Alpha: fix the login bug',
  body: '',
  labels: [],
  assignee: null,
  state: 'open',
  createdAt: new Date('2025-01-01').toISOString(),
  updatedAt: new Date('2025-01-01').toISOString(),
  alreadyImported: false,
  fileAttachments: [],
  attachmentCount: 0,
};

const ISSUE_BETA = {
  externalId: 'beta-2',
  externalUrl: 'https://github.com/org/repo/issues/2',
  title: 'Beta: add dark mode',
  body: '',
  labels: [],
  assignee: null,
  state: 'open',
  createdAt: new Date('2025-01-02').toISOString(),
  updatedAt: new Date('2025-01-02').toISOString(),
  alreadyImported: false,
  fileAttachments: [],
  attachmentCount: 0,
};

const ISSUE_GAMMA = {
  externalId: 'gamma-3',
  externalUrl: 'https://github.com/org/repo/issues/3',
  title: 'Gamma: improve performance',
  body: '',
  labels: [],
  assignee: null,
  state: 'open',
  createdAt: new Date('2025-01-03').toISOString(),
  updatedAt: new Date('2025-01-03').toISOString(),
  alreadyImported: false,
  fileAttachments: [],
  attachmentCount: 0,
};

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/**
 * Seed a GitHub Issues import source (non-Projects) so the dialog opens
 * immediately without going through the provider setup flow.
 */
async function seedGitHubSource(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mockImportSourcesPreset?: unknown }).__mockImportSourcesPreset = [
      {
        id: 'gh-issues-src',
        source: 'github_issues',
        label: 'org/repo GitHub Issues',
        repository: 'org/repo',
        url: 'https://github.com/org/repo',
        createdAt: new Date().toISOString(),
      },
    ];
  });
}

/**
 * Open the import dialog by clicking the pre-seeded source in the backlog popover.
 * Returns when the dialog is visible and the first fetch has settled (loading
 * spinner gone).
 */
async function openImportDialog(page: Page): Promise<void> {
  // Navigate to backlog view
  await page.locator('[data-testid="view-toggle-backlog"]').click();

  // Open the import popover
  const importSourcesButton = page.locator('[data-testid="import-sources-btn"]').first();
  await importSourcesButton.click();
  await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();

  // Click the pre-seeded source
  await page.getByText('org/repo GitHub Issues').click();

  // Wait for the dialog to appear
  await page.locator('[data-testid="import-dialog"]').waitFor({ state: 'visible', timeout: 8000 });

  // Wait for the initial loading spinner to disappear so the first fetch has settled
  await expect(page.locator('[data-testid="import-loading"]')).toHaveCount(0, { timeout: 8000 });
}

/** Read the mock's importFetch call counter. Returns 0 if no calls have been made. */
async function getFetchCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { __mockImportFetchCallCount?: number }).__mockImportFetchCallCount || 0;
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('ImportDialog - filter behaviour', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('server search empty result shows "No items match your filters" with Clear button', async () => {
    const { browser, page } = await launchPage();

    // importCheckCli returns available by default; seed the source
    await seedGitHubSource(page);

    // Seed an issue for the initial load so the dialog opens with content.
    // We switch to an empty response after the initial fetch by clearing the
    // preset and relying on the default empty response in the mock.
    await page.evaluate(() => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: [
          {
            externalId: 'issue-100',
            externalUrl: 'https://github.com/org/repo/issues/100',
            title: 'Some real issue',
            body: '',
            labels: [],
            assignee: null,
            state: 'open',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            alreadyImported: false,
            fileAttachments: [],
            attachmentCount: 0,
          },
        ],
        totalCount: 1,
        hasNextPage: false,
      };
    });

    await createProject(page, 'import-empty-state-test');
    await openImportDialog(page);

    // The initial issue should be visible after the first fetch
    await expect(page.locator('[data-testid="import-issue-issue-100"]')).toBeVisible({ timeout: 5000 });

    // Switch the preset to empty so the next fetch (triggered by typing) returns nothing
    await page.evaluate(() => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = null;
    });

    // Type a search - for a non-Projects source this triggers a debounced refetch
    await page.locator('[data-testid="import-search"]').fill('xyzzy-no-match');

    // Wait for the debounced fetch to fire and the loading spinner to disappear
    await expect(page.locator('[data-testid="import-loading"]')).toHaveCount(0, { timeout: 5000 });

    // The empty-state message for active-filter path should appear.
    // hasActiveFilters is true because serverSearchQuery is 'xyzzy-no-match'.
    await expect(page.locator('[data-testid="import-empty-state-message"]')).toBeVisible({ timeout: 3000 });

    // The Clear filters button should be present
    await expect(page.locator('[data-testid="import-clear-filters-btn"]')).toBeVisible();

    await browser.close();
  });

  test('clearFilters triggers a refetch with empty searchQuery when serverSearchQuery was set', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // Reset the call counter before the dialog opens so we count accurately
    // from mount. The initial fetch on mount will be call 1.
    await page.evaluate(() => {
      (window as unknown as { __mockImportFetchCallCount?: number }).__mockImportFetchCallCount = 0;
      // All calls return one issue so the Clear button is always enabled after typing
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: [
          {
            externalId: 'task-clear-test',
            externalUrl: 'https://github.com/org/repo/issues/10',
            title: 'Task that clears search',
            body: '',
            labels: [],
            assignee: null,
            state: 'open',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            alreadyImported: false,
            fileAttachments: [],
            attachmentCount: 0,
          },
        ],
        totalCount: 1,
        hasNextPage: false,
      };
    });

    await createProject(page, 'import-clear-refetch-test');
    await openImportDialog(page);

    // Verify the initial fetch happened (call 1)
    const countAfterOpen = await getFetchCallCount(page);
    expect(countAfterOpen).toBeGreaterThanOrEqual(1);

    // Type a server search - this will trigger call 2 after the 200ms debounce
    await page.locator('[data-testid="import-search"]').fill('search term');

    // Wait for the debounced fetch to fire and settle
    await expect.poll(() => getFetchCallCount(page), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

    // Wait for loading to finish
    await expect(page.locator('[data-testid="import-loading"]')).toHaveCount(0, { timeout: 5000 });

    const countAfterSearch = await getFetchCallCount(page);

    // Click Clear filters
    await page.locator('[data-testid="import-clear-filters-btn"]').click();

    // Wait for the refetch triggered by clearFilters (call count should increment)
    await expect.poll(() => getFetchCallCount(page), { timeout: 5000 }).toBeGreaterThan(countAfterSearch);

    // Wait for loading to finish
    await expect(page.locator('[data-testid="import-loading"]')).toHaveCount(0, { timeout: 5000 });

    // Verify the last call used an empty searchQuery
    const lastArgs = await page.evaluate(() => {
      return (window as unknown as {
        __mockImportFetchLastArgs?: { searchQuery?: string };
      }).__mockImportFetchLastArgs;
    });

    expect(lastArgs).not.toBeNull();
    // searchQuery should be undefined or empty string (importFetch passes undefined for empty search)
    const searchQuery = lastArgs?.searchQuery;
    expect(searchQuery == null || searchQuery === '').toBe(true);

    await browser.close();
  });

  test('stale-prefilter narrows visible rows immediately before the debounced refetch', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // Seed three issues with distinct title prefixes
    await page.evaluate(
      ([alpha, beta, gamma]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [alpha, beta, gamma],
          totalCount: 3,
          hasNextPage: false,
        };
      },
      [ISSUE_ALPHA, ISSUE_BETA, ISSUE_GAMMA],
    );

    await createProject(page, 'import-stale-prefilter-test');
    await openImportDialog(page);

    // All three rows should be visible after the initial fetch
    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-gamma-3"]')).toBeVisible();

    // Type "alpha" into the search box. For a GitHub Issues (non-Projects) source
    // this updates serverSearchQuery, which immediately drives the client-side
    // titleSearchTerm filter via useDeferredValue - the visible list narrows
    // before the 200ms-debounced remote refetch could even fire.
    await page.locator('[data-testid="import-search"]').fill('alpha');

    // The alpha row should remain visible; the others should disappear.
    // We assert the positive row-removal invariant rather than "no refetch fired",
    // because "no event occurred" is a negative-occurrence race (anti-pattern 6).
    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-gamma-3"]')).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('clicking a single row checkbox checks only that row', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // Seed two selectable issues
    await page.evaluate(
      ([alpha, beta]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [alpha, beta],
          totalCount: 2,
          hasNextPage: false,
        };
      },
      [ISSUE_ALPHA, ISSUE_BETA],
    );

    await createProject(page, 'import-toggle-signature-test');
    await openImportDialog(page);

    // Wait for both rows to render
    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toBeVisible();

    // Click the checkbox inside the alpha row only
    const alphaRow = page.locator('[data-testid="import-issue-alpha-1"]');
    await alphaRow.locator('input[type="checkbox"]').click();

    // Alpha's checkbox should now be checked
    await expect(alphaRow.locator('input[type="checkbox"]')).toBeChecked();

    // Beta's checkbox must remain unchecked - this guards the onToggle(externalId)
    // signature: if the callback received the wrong id (or no id), either both
    // rows would be toggled or neither would.
    const betaRow = page.locator('[data-testid="import-issue-beta-2"]');
    await expect(betaRow.locator('input[type="checkbox"]')).not.toBeChecked();

    // The import button should reflect exactly 1 selected item
    await expect(page.locator('[data-testid="import-execute-btn"]')).toContainText('Import (1)');

    await browser.close();
  });
});
