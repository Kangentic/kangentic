/**
 * UI spec: ImportDialog filter/streaming behaviour.
 *
 * Covers scenarios that are purely renderer/React state - no PTY, no
 * main process, no real IPC - so the UI tier is the correct home.
 *
 * The dialog has no manual pagination: it auto-loads every page of a source
 * in the background (streaming), and all filtering/search/sort is client-side
 * over the full loaded set, re-evaluating live as later pages land.
 *
 * 1. Empty-state messaging via the client-side title search
 *    Seed one issue, type a search term that matches nothing, assert
 *    "No items match your filters" and the Clear button - no new fetch.
 *
 * 2. clearFilters clears client-side state without a refetch
 *    Set a title search, click Clear filters, assert the fetch call count is
 *    unchanged (filtering never touches the network).
 *
 * 3. Typing narrows the visible list immediately (client-side, no server call)
 *    Seed multiple issues with distinct titles. Type a partial match. Assert
 *    non-matching rows disappear and no additional fetch fired.
 *
 * 4. onToggle signature regression guard
 *    Click an individual row checkbox (not select-all). Assert only that row's
 *    checkbox becomes checked; all other rows remain unchecked.
 *
 * 5. Filter facets populate as later pages stream in (the bug this dialog fixes)
 *    Seed two pages with distinct statuses. Assert the Status dropdown shows
 *    both values once streaming settles, without a "Load more" click.
 *
 * 6. A filter applied while a later page is still in flight keeps matching
 *    items that land after the filter was set (live re-evaluation).
 *
 * 7. Virtualization renders a windowed subset of a large list while the
 *    footer still reports the full loaded count.
 *
 * 8. Switching the state filter mid-stream cancels the previous filter's
 *    in-flight background page via fetchSequenceRef, so a stale page never
 *    lands in the new filter's list.
 *
 * 9. Closing the dialog while a background page-stream is in flight stops
 *    further fetches and does not throw an unmounted-component warning.
 *
 * 10. A fetch failure mid-stream shows the error banner with Retry; Retry
 *     re-runs the loader and clears the error once it succeeds.
 *
 * 11. Select-all checked against page 1 becomes unchecked (mixed state) once
 *     a later page streams in more selectable items, without changing the
 *     already-made selection.
 *
 * 12. The all-imported empty state ("All items have been imported") shows a
 *     Refresh button, and clicking it re-runs loadAllIssues (a real refetch,
 *     not a dead handler).
 *
 * 13. The all-imported empty-state message never renders while a later page
 *     is still streaming - the `!loadingMore` gate on the empty-state block
 *     prevents a transient "nothing left" result from asserting a completion
 *     claim that a later page could (and does) contradict.
 *
 * 14. A malformed page response (a non-array `issues` field) is caught by
 *     loadAllIssues's outer try/catch and shows the error banner with Retry,
 *     instead of an unhandled rejection or a silently-stuck loading state.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject, collectPageErrors } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

// ---------------------------------------------------------------------------
// Shared issue fixtures
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<{
  externalId: string;
  title: string;
  state: string;
  assignee: string | null;
  labels: string[];
  createdAt: string;
  alreadyImported: boolean;
}>) {
  return {
    externalId: overrides.externalId ?? 'issue-1',
    externalUrl: `https://github.com/org/repo/issues/${overrides.externalId ?? '1'}`,
    title: overrides.title ?? 'An issue',
    body: '',
    labels: overrides.labels ?? [],
    assignee: overrides.assignee ?? null,
    state: overrides.state ?? 'open',
    createdAt: overrides.createdAt ?? new Date('2025-01-01').toISOString(),
    updatedAt: overrides.createdAt ?? new Date('2025-01-01').toISOString(),
    alreadyImported: overrides.alreadyImported ?? false,
    fileAttachments: [],
    attachmentCount: 0,
  };
}

const ISSUE_ALPHA = makeIssue({ externalId: 'alpha-1', title: 'Alpha: fix the login bug', createdAt: new Date('2025-01-01').toISOString() });
const ISSUE_BETA = makeIssue({ externalId: 'beta-2', title: 'Beta: add dark mode', createdAt: new Date('2025-01-02').toISOString() });
const ISSUE_GAMMA = makeIssue({ externalId: 'gamma-3', title: 'Gamma: improve performance', createdAt: new Date('2025-01-03').toISOString() });

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

/** Wait for any background page streaming to finish. */
async function waitForStreamingSettled(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="import-loading-more"]')).toHaveCount(0, { timeout: 8000 });
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

test.describe('ImportDialog - filter and streaming behaviour', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('typing a search term with no match shows "No items match your filters" with Clear button', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate((issue) => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: [issue],
        totalCount: 1,
        hasNextPage: false,
      };
    }, makeIssue({ externalId: 'issue-100', title: 'Some real issue' }));

    await createProject(page, 'import-empty-state-test');
    await openImportDialog(page);

    // The seeded issue should be visible after the first fetch
    await expect(page.locator('[data-testid="import-issue-issue-100"]')).toBeVisible({ timeout: 5000 });

    // Type a search that matches nothing - purely client-side, no refetch
    await page.locator('[data-testid="import-search"]').fill('xyzzy-no-match');

    await expect(page.locator('[data-testid="import-empty-state-message"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-clear-filters-btn"]')).toBeVisible();

    await browser.close();
  });

  test('clearFilters clears the client-side filter without triggering a refetch', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate(() => {
      (window as unknown as { __mockImportFetchCallCount?: number }).__mockImportFetchCallCount = 0;
    });
    await page.evaluate((issue) => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: [issue],
        totalCount: 1,
        hasNextPage: false,
      };
    }, makeIssue({ externalId: 'task-clear-test', title: 'Task that clears search' }));

    await createProject(page, 'import-clear-refetch-test');
    await openImportDialog(page);

    const countAfterOpen = await getFetchCallCount(page);
    expect(countAfterOpen).toBeGreaterThanOrEqual(1);

    // Type a title filter - client-side only, no network call
    await page.locator('[data-testid="import-search"]').fill('search term');
    await expect(page.locator('[data-testid="import-empty-state-message"]')).toBeVisible({ timeout: 3000 });

    const countAfterSearch = await getFetchCallCount(page);
    expect(countAfterSearch).toBe(countAfterOpen);

    // Click Clear filters
    await page.locator('[data-testid="import-clear-filters-btn"]').click();

    // The seeded row reappears once the filter clears
    await expect(page.locator('[data-testid="import-issue-task-clear-test"]')).toBeVisible({ timeout: 3000 });

    // Clearing filters never refetches - it is purely client-side state.
    const countAfterClear = await getFetchCallCount(page);
    expect(countAfterClear).toBe(countAfterOpen);

    await browser.close();
  });

  test('typing narrows visible rows immediately with no server round-trip', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

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

    await createProject(page, 'import-live-filter-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-gamma-3"]')).toBeVisible();

    const countBeforeTyping = await getFetchCallCount(page);

    await page.locator('[data-testid="import-search"]').fill('alpha');

    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-gamma-3"]')).toHaveCount(0, { timeout: 3000 });

    // Filtering is purely client-side - no new fetch should have fired.
    const countAfterTyping = await getFetchCallCount(page);
    expect(countAfterTyping).toBe(countBeforeTyping);

    await browser.close();
  });

  test('clicking a single row checkbox checks only that row', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

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

    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toBeVisible();

    const alphaRow = page.locator('[data-testid="import-issue-alpha-1"]');
    await alphaRow.locator('input[type="checkbox"]').click();

    await expect(alphaRow.locator('input[type="checkbox"]')).toBeChecked();

    const betaRow = page.locator('[data-testid="import-issue-beta-2"]');
    await expect(betaRow.locator('input[type="checkbox"]')).not.toBeChecked();

    await expect(page.locator('[data-testid="import-execute-btn"]')).toContainText('Import (1)');

    await browser.close();
  });

  test('filter facets populate as later pages stream in, with no manual load-more', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate(
      ([page1Issue, page2Issue]) => {
        (window as unknown as { __mockImportFetchPages?: unknown }).__mockImportFetchPages = [
          { issues: [page1Issue], totalCount: 2, hasNextPage: true },
          { issues: [page2Issue], totalCount: 2, hasNextPage: false },
        ];
      },
      [
        makeIssue({ externalId: 'page1-issue', title: 'Page one issue', state: 'open' }),
        makeIssue({ externalId: 'page2-issue', title: 'Page two issue', state: 'triaged' }),
      ],
    );

    await createProject(page, 'import-streaming-facets-test');
    await openImportDialog(page);

    // Both rows should be present once streaming settles
    await waitForStreamingSettled(page);
    await expect(page.locator('[data-testid="import-issue-page1-issue"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-page2-issue"]')).toBeVisible();

    // The Status filter must show both statuses without any "Load more" click
    await page.locator('button', { hasText: 'Status' }).click();
    await expect(page.locator('[data-testid="filter-option-status-open"]')).toBeVisible();
    await expect(page.locator('[data-testid="filter-option-status-triaged"]')).toBeVisible();

    await browser.close();
  });

  test('a filter set while a later page is still loading keeps matching items that arrive after', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate(
      ([page1Issue, page2Issue]) => {
        (window as unknown as { __mockImportFetchPageDelayMs?: number }).__mockImportFetchPageDelayMs = 2000;
        (window as unknown as { __mockImportFetchPages?: unknown }).__mockImportFetchPages = [
          { issues: [page1Issue], totalCount: 2, hasNextPage: true },
          { issues: [page2Issue], totalCount: 2, hasNextPage: false },
        ];
      },
      [
        makeIssue({ externalId: 'early-issue', title: 'Loaded first' }),
        makeIssue({ externalId: 'late-issue', title: 'Loaded later' }),
      ],
    );

    await createProject(page, 'import-live-reeval-test');
    await openImportDialog(page);

    // Page 1 has landed (loading spinner gone); page 2 is still in flight.
    await expect(page.locator('[data-testid="import-issue-early-issue"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-loading-more"]')).toBeVisible();

    // Apply a title filter that matches only the item that hasn't arrived yet.
    await page.locator('[data-testid="import-search"]').fill('Loaded later');

    // The not-yet-loaded item cannot match yet, but once streaming settles it
    // must appear - the filter must not have been frozen against page 1 only.
    await waitForStreamingSettled(page);
    await expect(page.locator('[data-testid="import-issue-late-issue"]')).toBeVisible({ timeout: 3000 });

    await browser.close();
  });

  test('virtualization renders a windowed subset of a large list', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // The dialog sorts newest-first, so index 0 gets the newest timestamp to
    // land at the top of the (visible) list.
    const issueCount = 60;
    const manyIssues = Array.from({ length: issueCount }, (_, index) =>
      makeIssue({
        externalId: `bulk-${index}`,
        title: `Bulk issue number ${index}`,
        createdAt: new Date(2025, 0, 1, 0, issueCount - index).toISOString(),
      }));

    await page.evaluate((issues) => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues,
        totalCount: issues.length,
        hasNextPage: false,
      };
    }, manyIssues);

    await createProject(page, 'import-virtualization-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-bulk-0"]')).toBeVisible();

    // The footer reports the full loaded count (hideImported defaults on, so
    // with nothing imported yet the label reads "60 of 60 items")...
    await expect(page.locator('text=/60 of 60 items/')).toBeVisible();

    // ...but the DOM only renders a windowed subset of rows, not all 60.
    const renderedRowCount = await page.locator('[data-testid^="import-issue-bulk-"]').count();
    expect(renderedRowCount).toBeGreaterThan(0);
    expect(renderedRowCount).toBeLessThan(issueCount);

    await browser.close();
  });

  test('switching the state filter mid-stream cancels the previous filter\'s in-flight page', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // A delay long enough that the "open" filter's page 2 is still in flight
    // by the time we switch to "closed", but short enough to keep the test fast.
    await page.evaluate(
      ([openPageOneIssue, openPageTwoStaleIssue, closedIssue]) => {
        (window as unknown as { __mockImportFetchPageDelayMs?: number }).__mockImportFetchPageDelayMs = 1500;
        (window as unknown as { __mockImportFetchPagesByState?: unknown }).__mockImportFetchPagesByState = {
          open: [
            { issues: [openPageOneIssue], totalCount: 2, hasNextPage: true },
            { issues: [openPageTwoStaleIssue], totalCount: 2, hasNextPage: false },
          ],
          closed: [
            { issues: [closedIssue], totalCount: 1, hasNextPage: false },
          ],
        };
      },
      [
        makeIssue({ externalId: 'open-page1-issue', title: 'Open page one issue', state: 'open' }),
        makeIssue({ externalId: 'open-page2-stale-issue', title: 'Open page two STALE issue', state: 'open' }),
        makeIssue({ externalId: 'closed-issue', title: 'Closed issue only', state: 'closed' }),
      ],
    );

    await createProject(page, 'import-stale-state-cancel-test');
    await openImportDialog(page);

    // Page 1 of "open" has landed; page 2 of "open" is now in flight.
    await expect(page.locator('[data-testid="import-issue-open-page1-issue"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-loading-more"]')).toBeVisible();

    // Switch to "closed" before the stale "open" page 2 resolves.
    const importDialog = page.locator('[data-testid="import-dialog"]');
    await importDialog.getByRole('button', { name: 'Closed' }).click();

    await waitForStreamingSettled(page);

    // The "closed" filter's data lands, and the stale "open" page 2 item (whose
    // fetch was already in flight when we switched away) is discarded by the
    // fetchSequenceRef token guard - it can never leak into the final list,
    // regardless of what the outgoing filter's already-loaded page 1 does.
    await expect(page.locator('[data-testid="import-issue-closed-issue"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="import-issue-open-page2-stale-issue"]')).toHaveCount(0);

    // The outgoing filter's own already-loaded page 1 must also be fully
    // replaced, not appended-to: "closed"'s first page should REPLACE the
    // "open" filter's page 1 rather than accumulate alongside it.
    await expect(page.locator('[data-testid="import-issue-open-page1-issue"]')).toHaveCount(0);

    await browser.close();
  });

  test('closing the dialog mid-stream stops further fetches with no unmounted-component error', async () => {
    const { browser, page } = await launchPage();

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const getPageErrors = collectPageErrors(page);

    await seedGitHubSource(page);

    // Three pages, all delayed, so we can close the dialog while page 2 is
    // in flight and prove page 3 is never requested afterward.
    await page.evaluate(
      ([pageOneIssue, pageTwoIssue, pageThreeIssue]) => {
        (window as unknown as { __mockImportFetchPageDelayMs?: number }).__mockImportFetchPageDelayMs = 1000;
        (window as unknown as { __mockImportFetchPages?: unknown }).__mockImportFetchPages = [
          { issues: [pageOneIssue], totalCount: 3, hasNextPage: true },
          { issues: [pageTwoIssue], totalCount: 3, hasNextPage: true },
          { issues: [pageThreeIssue], totalCount: 3, hasNextPage: false },
        ];
      },
      [
        makeIssue({ externalId: 'unmount-page1', title: 'Unmount test page one' }),
        makeIssue({ externalId: 'unmount-page2', title: 'Unmount test page two' }),
        makeIssue({ externalId: 'unmount-page3', title: 'Unmount test page three' }),
      ],
    );

    await createProject(page, 'import-unmount-cancel-test');
    await openImportDialog(page);

    // Page 1 landed; page 2's fetch has already been issued (loading-more visible
    // means the page-2 importFetch call has started, per the dialog's loop).
    // The exact call count is not asserted here: React StrictMode double-invokes
    // the mount effect in dev, which can issue an extra superseded page-1 call
    // before the "real" streaming loop begins. What matters is that the count
    // does not grow further once we close mid-stream (asserted below).
    await expect(page.locator('[data-testid="import-loading-more"]')).toBeVisible();
    const callCountBeforeClose = await getFetchCallCount(page);
    expect(callCountBeforeClose).toBeGreaterThanOrEqual(2);

    await page.locator('[data-testid="import-dialog"]').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0, { timeout: 3000 });

    // Intentional fixed wait: this proves a negative (no further fetch call
    // occurs after unmount), which cannot be expressed as a poll for a
    // condition to become true. The wait comfortably exceeds the 1000ms
    // per-page delay so page 2's in-flight promise has resolved and, if the
    // fetchSequenceRef guard were broken, page 3 would have been requested.
    await page.waitForTimeout(2000);

    const callCountAfterWait = await getFetchCallCount(page);
    expect(callCountAfterWait).toBe(callCountBeforeClose);

    expect(getPageErrors()).toEqual([]);
    expect(consoleErrors).toEqual([]);

    await browser.close();
  });

  test('a fetch failure mid-stream shows the error banner, and Retry clears it once it succeeds', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate(() => {
      (window as unknown as { __mockImportFetchFailUntilCleared?: boolean }).__mockImportFetchFailUntilCleared = true;
    });

    await createProject(page, 'import-error-retry-test');

    // Open the dialog directly (not via openImportDialog, which assumes the
    // first fetch succeeds): the forced failure resolves loading to false via
    // the error path rather than the happy path.
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    const importSourcesButton = page.locator('[data-testid="import-sources-btn"]').first();
    await importSourcesButton.click();
    await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();
    await page.getByText('org/repo GitHub Issues').click();
    await page.locator('[data-testid="import-dialog"]').waitFor({ state: 'visible', timeout: 8000 });

    const importDialog = page.locator('[data-testid="import-dialog"]');
    const errorBanner = page.getByText('Mock import fetch failure');
    await expect(errorBanner).toBeVisible({ timeout: 5000 });
    const retryButton = importDialog.getByRole('button', { name: 'Retry' });
    await expect(retryButton).toBeVisible();

    // Switch the mock to succeed, then retry.
    await page.evaluate((issue) => {
      (window as unknown as { __mockImportFetchFailUntilCleared?: boolean }).__mockImportFetchFailUntilCleared = false;
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: [issue],
        totalCount: 1,
        hasNextPage: false,
      };
    }, makeIssue({ externalId: 'retry-success-issue', title: 'Recovered after retry' }));
    await retryButton.click();

    await expect(errorBanner).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-testid="import-issue-retry-success-issue"]')).toBeVisible({ timeout: 5000 });

    await browser.close();
  });

  test('select-all becomes unchecked once a later page streams in more selectable items', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate(
      ([pageOneIssue, pageTwoIssue]) => {
        (window as unknown as { __mockImportFetchPageDelayMs?: number }).__mockImportFetchPageDelayMs = 1500;
        (window as unknown as { __mockImportFetchPages?: unknown }).__mockImportFetchPages = [
          { issues: [pageOneIssue], totalCount: 2, hasNextPage: true },
          { issues: [pageTwoIssue], totalCount: 2, hasNextPage: false },
        ];
      },
      [
        makeIssue({ externalId: 'select-all-page1', title: 'Select all page one issue' }),
        makeIssue({ externalId: 'select-all-page2', title: 'Select all page two issue' }),
      ],
    );

    await createProject(page, 'import-select-all-staleness-test');
    await openImportDialog(page);

    // Page 1 landed; page 2 is still in flight.
    await expect(page.locator('[data-testid="import-issue-select-all-page1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-loading-more"]')).toBeVisible();

    const selectAllCheckbox = page.locator('[data-testid="import-select-all"]');
    await selectAllCheckbox.click();

    await expect(selectAllCheckbox).toBeChecked();
    await expect(page.locator('[data-testid="import-execute-btn"]')).toContainText('Import (1)');

    await waitForStreamingSettled(page);
    await expect(page.locator('[data-testid="import-issue-select-all-page2"]')).toBeVisible();

    // The page-1 selection is unchanged, but selectableIssues grew, so
    // selectedIds.size (1) no longer equals selectableIssues.length (2).
    await expect(selectAllCheckbox).not.toBeChecked();
    await expect(page.locator('[data-testid="import-execute-btn"]')).toContainText('Import (1)');

    await browser.close();
  });

  test('the all-imported empty state shows Refresh, and clicking it re-streams via loadAllIssues', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate((issue) => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: [issue],
        totalCount: 1,
        hasNextPage: false,
      };
    }, makeIssue({ externalId: 'already-imported-1', title: 'Already imported issue', alreadyImported: true }));

    await createProject(page, 'import-all-imported-test');
    await openImportDialog(page);

    // hideImported defaults to true, so the single (already-imported) issue is
    // hidden from filteredIssues, leaving it empty - and every fetched issue
    // being alreadyImported makes `allImported` true, so the dialog must show
    // the all-imported branch rather than the generic "No items found" one.
    await expect(page.getByText('All items have been imported')).toBeVisible({ timeout: 3000 });
    const refreshButton = page.getByRole('button', { name: 'Refresh to check for new items' });
    await expect(refreshButton).toBeVisible();

    const countBeforeRefresh = await getFetchCallCount(page);
    await refreshButton.click();

    // Refresh must call loadAllIssues(stateFilter) again - a real re-stream,
    // not a dead handler - so the fetch call count must increase.
    await expect.poll(async () => getFetchCallCount(page), { timeout: 3000 }).toBeGreaterThan(countBeforeRefresh);

    await browser.close();
  });

  test('the all-imported empty-state message is suppressed while a later page is still streaming', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    await page.evaluate(
      ([page1Issue, page2Issue]) => {
        (window as unknown as { __mockImportFetchPageDelayMs?: number }).__mockImportFetchPageDelayMs = 1500;
        (window as unknown as { __mockImportFetchPages?: unknown }).__mockImportFetchPages = [
          { issues: [page1Issue], totalCount: 2, hasNextPage: true },
          { issues: [page2Issue], totalCount: 2, hasNextPage: false },
        ];
      },
      [
        makeIssue({ externalId: 'midstream-imported-1', title: 'Page one already-imported issue', alreadyImported: true }),
        makeIssue({ externalId: 'midstream-fresh-2', title: 'Page two fresh issue', alreadyImported: false }),
      ],
    );

    await createProject(page, 'import-allimported-midstream-test');
    await openImportDialog(page);

    // Page 1 has landed with only an already-imported item - hideImported
    // hides it, so filteredIssues is momentarily empty - while page 2 is
    // still in flight.
    await expect(page.locator('[data-testid="import-loading-more"]')).toBeVisible();

    // Non-occurrence check: this MUST be a single direct snapshot, not a
    // web-first `expect(locator).toHaveCount(0)`. That assertion polls and
    // retries for up to its timeout, so it would still pass once the message
    // naturally disappears after streaming settles a moment later -
    // silently proving nothing about this specific mid-stream instant (the
    // exact bug the `!loadingMore` gate exists to prevent). See anti-pattern
    // 6 in the test-builder catalogue: you cannot poll for "nothing happens".
    const completionClaimedMidStream = await page.getByText('All items have been imported').count();
    expect(completionClaimedMidStream).toBe(0);

    await waitForStreamingSettled(page);
    await expect(page.locator('[data-testid="import-issue-midstream-fresh-2"]')).toBeVisible({ timeout: 3000 });

    await browser.close();
  });

  test('a malformed page response (non-array issues) shows the error banner with Retry', async () => {
    const { browser, page } = await launchPage();

    const getPageErrors = collectPageErrors(page);

    await seedGitHubSource(page);

    // A response whose `issues` field is not an array (e.g. a malformed
    // adapter payload) makes sortByCreatedDesc(result.issues) throw inside
    // loadAllIssues's processing step, after the fetch itself succeeded.
    await page.evaluate(() => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: null,
        totalCount: 0,
        hasNextPage: false,
      };
    });

    await createProject(page, 'import-malformed-response-test');

    // Open the dialog directly (not via openImportDialog, which assumes the
    // first fetch's happy path): the malformed payload resolves loading to
    // false via the catch's error path instead.
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    const importSourcesButton = page.locator('[data-testid="import-sources-btn"]').first();
    await importSourcesButton.click();
    await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();
    await page.getByText('org/repo GitHub Issues').click();
    await page.locator('[data-testid="import-dialog"]').waitFor({ state: 'visible', timeout: 8000 });

    const importDialog = page.locator('[data-testid="import-dialog"]');
    const errorBanner = importDialog.locator('.text-danger').last();
    await expect(errorBanner).toBeVisible({ timeout: 5000 });
    await expect(importDialog.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Confirms the outer try/catch actually caught the malformed-payload
    // throw rather than it surfacing as an unhandled rejection (the failure
    // mode the catch exists to prevent, per the comment in loadAllIssues).
    expect(getPageErrors()).toEqual([]);

    await browser.close();
  });
});
