/**
 * UI spec: ImportDialog cache-first + reconcile behaviour.
 *
 * Covers scenarios that are purely renderer/React state - no PTY, no main
 * process, no real IPC - so the UI tier is the correct home.
 *
 * The dialog paints the persistent cache instantly on open (importGetCached),
 * then reconciles in the background (importReconcile) and swaps in the merged
 * set. All filtering/search/sort is client-side over that set, including the
 * open/closed/all state toggle (each item carries a normalized stateCategory).
 *
 * 1. Empty-state messaging via the client-side title search, no refetch.
 * 2. clearFilters clears client-side state without a reconcile.
 * 3. Typing narrows the visible list immediately (client-side, no reconcile).
 * 4. onToggle signature regression guard (single row checkbox).
 * 5. Filter facets populate from the loaded set (Status dropdown shows every value).
 * 6. The Status filter menu stays right-anchored to its trigger.
 * 7. A filter applied while the background reconcile is still in flight keeps
 *    matching items that land after the filter was set (live re-evaluation).
 * 8. Virtualization renders a windowed subset of a large list.
 * 9. The open/closed/all toggle filters client-side by stateCategory, instantly,
 *    with no reconcile round-trip.
 * 10. Closing the dialog while a reconcile is in flight fires no further
 *     reconcile and throws no unmounted-component warning.
 * 11. A reconcile failure shows the error banner with Retry; Retry clears it
 *     once it succeeds.
 * 12. Select-all checked against the cached set becomes unchecked once the
 *     reconcile adds more selectable items, without changing the selection.
 * 13. The all-imported empty state shows Refresh; clicking it re-runs reconcile.
 * 14. The all-imported empty-state message never renders while a reconcile is
 *     still in flight (the `!syncing` gate).
 * 15. A malformed reconcile response (a non-array `issues`) is caught and shows
 *     the error banner with Retry.
 * 16-21. The search box matches exactly the fields the row prints (id with/without
 *     '#', the URL-derived id for projects, label, assignee), never the body, and
 *     honors the field separators and the anchored leading-'#' strip.
 * 22. importExecute's `detailUnavailable` count (set when a per-item detail hydrate,
 *     e.g. Azure DevOps comments, failed for some imported items) is surfaced in the
 *     success toast rather than degrading silently.
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
  externalSource: string;
  externalUrl: string;
  title: string;
  body: string;
  state: string;
  stateCategory: 'open' | 'closed';
  workItemType: string;
  assignee: string | null;
  labels: string[];
  createdAt: string;
  alreadyImported: boolean;
}>) {
  const state = overrides.state ?? 'open';
  return {
    externalId: overrides.externalId ?? 'issue-1',
    // A github_projects item's externalId is an opaque project-item node id, so the
    // visible '#N' is parsed out of this URL instead. Overridable for that reason.
    externalSource: overrides.externalSource ?? 'github_issues',
    externalUrl: overrides.externalUrl ?? `https://github.com/org/repo/issues/${overrides.externalId ?? '1'}`,
    title: overrides.title ?? 'An issue',
    body: overrides.body ?? '',
    labels: overrides.labels ?? [],
    assignee: overrides.assignee ?? null,
    state,
    // Normalized open/closed bucket the dialog's state toggle filters on. Defaults
    // to open (mirroring the adapters' mappers) unless overridden or state==closed.
    stateCategory: overrides.stateCategory ?? (state === 'closed' ? 'closed' : 'open'),
    // Empty by default, so the Type dropdown stays absent for every spec that
    // does not opt in (the row and uniqueTypes both gate on truthiness).
    workItemType: overrides.workItemType ?? '',
    createdAt: overrides.createdAt ?? new Date('2025-01-01').toISOString(),
    updatedAt: overrides.createdAt ?? new Date('2025-01-01').toISOString(),
    alreadyImported: overrides.alreadyImported ?? false,
    fileAttachments: [],
    attachmentCount: 0,
  };
}

type SeededIssue = ReturnType<typeof makeIssue>;

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
 * Seed a GitHub Projects import source. Its items resolve their visible '#N' from
 * the external URL rather than from externalId, which is the branch `displayId`
 * takes for `github_projects`. Seeded on its own (never alongside the Issues
 * source) so the popover's source label stays unambiguous for `getByText`.
 */
async function seedGitHubProjectsSource(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mockImportSourcesPreset?: unknown }).__mockImportSourcesPreset = [
      {
        id: 'gh-projects-src',
        source: 'github_projects',
        label: 'org/repo Roadmap Project',
        repository: 'org/repo',
        url: 'https://github.com/orgs/org/projects/7',
        createdAt: new Date().toISOString(),
      },
    ];
  });
}

/** Seed the background reconcile to return the given issues. */
async function seedReconcile(page: Page, issues: SeededIssue[]): Promise<void> {
  await page.evaluate((seeded) => {
    (window as unknown as { __mockImportReconcile?: unknown }).__mockImportReconcile = {
      issues: seeded, added: seeded.length, updated: 0, removed: 0,
    };
  }, issues);
}

/** Seed the instant (no-network) cache read to return the given issues. */
async function seedCached(page: Page, issues: SeededIssue[]): Promise<void> {
  await page.evaluate((seeded) => {
    (window as unknown as { __mockImportCached?: unknown }).__mockImportCached = { issues: seeded };
  }, issues);
}

/**
 * Open the import dialog by clicking the pre-seeded source in the backlog popover.
 * Returns when the dialog is visible and the initial load has settled (spinner gone).
 */
async function openImportDialog(page: Page, sourceLabel = 'org/repo GitHub Issues'): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();

  const importSourcesButton = page.locator('[data-testid="import-sources-btn"]').first();
  await importSourcesButton.click();
  await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();

  await page.getByText(sourceLabel).click();

  await page.locator('[data-testid="import-dialog"]').waitFor({ state: 'visible', timeout: 8000 });
  await expect(page.locator('[data-testid="import-loading"]')).toHaveCount(0, { timeout: 8000 });
}

/** Open the dialog to visibility only, without waiting for the load to settle. */
async function openImportDialogRaw(page: Page, sourceLabel = 'org/repo GitHub Issues'): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();
  await page.getByText(sourceLabel).click();
  await page.locator('[data-testid="import-dialog"]').waitFor({ state: 'visible', timeout: 8000 });
}

/** Wait for the background reconcile indicator to clear. */
async function waitForSyncSettled(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="import-syncing"]')).toHaveCount(0, { timeout: 8000 });
}

/** Read the mock's importReconcile call counter. Returns 0 if none. */
async function getReconcileCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { __mockImportReconcileCallCount?: number }).__mockImportReconcileCallCount || 0;
  });
}

/** Read the `mode` argument of the most recent importReconcile call, if any. */
async function getLastReconcileMode(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    return (window as unknown as { __mockImportReconcileLastArgs?: { mode?: string } })
      .__mockImportReconcileLastArgs?.mode;
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('ImportDialog - filter and reconcile behaviour', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('typing a search term with no match shows "No items match your filters" with Clear button', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [makeIssue({ externalId: 'issue-100', title: 'Some real issue' })]);

    await createProject(page, 'import-empty-state-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-issue-100"]')).toBeVisible({ timeout: 5000 });

    await page.locator('[data-testid="import-search"]').fill('xyzzy-no-match');

    await expect(page.locator('[data-testid="import-empty-state-message"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-clear-filters-btn"]')).toBeVisible();

    await browser.close();
  });

  // The cache read is an optimization, not a dependency: it runs alongside the CLI
  // check now, so a failure there must not strand the dialog on its spinner. The
  // reconcile is what actually has to populate it.
  test('a cache-read failure is non-fatal and the reconcile still populates the list', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await page.evaluate(() => { window.__mockImportGetCachedFailUntilCleared = true; });
    await seedReconcile(page, [makeIssue({ externalId: 'issue-501', title: 'Arrived via reconcile' })]);

    await createProject(page, 'import-cache-read-failure');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-issue-501"]')).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('[data-testid="import-dialog"]').getByRole('button', { name: 'Retry' }),
    ).toHaveCount(0);

    await browser.close();
  });

  test('clearFilters clears the client-side filter without triggering a reconcile', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [makeIssue({ externalId: 'task-clear-test', title: 'Task that clears search' })]);

    await createProject(page, 'import-clear-refetch-test');
    await openImportDialog(page);

    const countAfterOpen = await getReconcileCallCount(page);
    expect(countAfterOpen).toBeGreaterThanOrEqual(1);

    await page.locator('[data-testid="import-search"]').fill('search term');
    await expect(page.locator('[data-testid="import-empty-state-message"]')).toBeVisible({ timeout: 3000 });

    expect(await getReconcileCallCount(page)).toBe(countAfterOpen);

    await page.locator('[data-testid="import-clear-filters-btn"]').click();
    await expect(page.locator('[data-testid="import-issue-task-clear-test"]')).toBeVisible({ timeout: 3000 });

    // Clearing filters never reconciles - it is purely client-side state.
    expect(await getReconcileCallCount(page)).toBe(countAfterOpen);

    await browser.close();
  });

  test('typing narrows visible rows immediately with no reconcile round-trip', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [ISSUE_ALPHA, ISSUE_BETA, ISSUE_GAMMA]);

    await createProject(page, 'import-live-filter-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-gamma-3"]')).toBeVisible();

    const countBeforeTyping = await getReconcileCallCount(page);

    await page.locator('[data-testid="import-search"]').fill('alpha');

    await expect(page.locator('[data-testid="import-issue-alpha-1"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-beta-2"]')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-gamma-3"]')).toHaveCount(0, { timeout: 3000 });

    expect(await getReconcileCallCount(page)).toBe(countBeforeTyping);

    await browser.close();
  });

  test('clicking a single row checkbox checks only that row', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [ISSUE_ALPHA, ISSUE_BETA]);

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

  test('filter facets populate from the loaded set, with no manual load-more', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: 'facet-1', title: 'First facet issue', state: 'open' }),
      makeIssue({ externalId: 'facet-2', title: 'Second facet issue', state: 'triaged' }),
    ]);

    await createProject(page, 'import-facets-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-facet-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-facet-2"]')).toBeVisible();

    // The Status filter must show both statuses.
    await page.locator('button', { hasText: 'Status' }).click();
    await expect(page.locator('[data-testid="filter-option-status-open"]')).toBeVisible();
    await expect(page.locator('[data-testid="filter-option-status-triaged"]')).toBeVisible();

    await browser.close();
  });

  test('the Status filter menu stays right-anchored to its trigger (MultiSelectDropdown\'s default align)', async () => {
    // MultiSelectDropdown defaults `align` to 'right': the Import dialog's filter
    // cluster sits at the dialog's right edge, so its menus hang left of the trigger
    // with their RIGHT edges glued together.
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: 'align-1', title: 'Align check one', state: 'open' }),
      makeIssue({ externalId: 'align-2', title: 'Align check two', state: 'triaged' }),
    ]);

    await createProject(page, 'import-status-align-right-test');
    await openImportDialog(page);

    const statusTrigger = page.locator('button', { hasText: 'Status' });
    const menu = page.locator('[data-testid="filter-menu-status"]');
    await statusTrigger.click();
    await expect(menu).toBeVisible();

    const triggerBox = await statusTrigger.boundingBox();
    const menuBox = await menu.boundingBox();
    if (!triggerBox || !menuBox) throw new Error('missing geometry for the alignment check');
    expect(Math.abs((menuBox.x + menuBox.width) - (triggerBox.x + triggerBox.width))).toBeLessThanOrEqual(2);

    await browser.close();
  });

  test('a filter set while the reconcile is still in flight keeps matching items that arrive after', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    // Cache paints one item instantly; the delayed reconcile adds a second.
    await seedCached(page, [makeIssue({ externalId: 'early-issue', title: 'Loaded first' })]);
    await page.evaluate((issues) => {
      (window as unknown as { __mockImportReconcileDelayMs?: number }).__mockImportReconcileDelayMs = 2000;
      (window as unknown as { __mockImportReconcile?: unknown }).__mockImportReconcile = {
        issues, added: 1, updated: 0, removed: 0,
      };
    }, [makeIssue({ externalId: 'early-issue', title: 'Loaded first' }), makeIssue({ externalId: 'late-issue', title: 'Loaded later' })]);

    await createProject(page, 'import-live-reeval-test');
    await openImportDialog(page);

    // Cache is painted; the reconcile is still running.
    await expect(page.locator('[data-testid="import-issue-early-issue"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-syncing"]')).toBeVisible();

    // Apply a title filter that matches only the item that hasn't arrived yet.
    await page.locator('[data-testid="import-search"]').fill('Loaded later');

    // Once the reconcile settles, the late item must appear - the filter must not
    // have been frozen against the cached set only.
    await waitForSyncSettled(page);
    await expect(page.locator('[data-testid="import-issue-late-issue"]')).toBeVisible({ timeout: 3000 });

    await browser.close();
  });

  test('virtualization renders a windowed subset of a large list', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    const issueCount = 60;
    const manyIssues = Array.from({ length: issueCount }, (_, index) =>
      makeIssue({
        externalId: `bulk-${index}`,
        title: `Bulk issue number ${index}`,
        createdAt: new Date(2025, 0, 1, 0, issueCount - index).toISOString(),
      }));

    await seedReconcile(page, manyIssues);

    await createProject(page, 'import-virtualization-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-bulk-0"]')).toBeVisible();

    // The footer reports the full loaded count (hideImported defaults on, so with
    // nothing imported yet the label reads "60 of 60 items")...
    await expect(page.locator('text=/60 of 60 items/')).toBeVisible();

    // ...but the DOM only renders a windowed subset of rows, not all 60.
    const renderedRowCount = await page.locator('[data-testid^="import-issue-bulk-"]').count();
    expect(renderedRowCount).toBeGreaterThan(0);
    expect(renderedRowCount).toBeLessThan(issueCount);

    await browser.close();
  });

  test('the open/closed/all toggle filters client-side by stateCategory with no reconcile', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: 'open-1', title: 'An open item', state: 'open', stateCategory: 'open' }),
      makeIssue({ externalId: 'closed-1', title: 'A closed item', state: 'closed', stateCategory: 'closed' }),
    ]);

    await createProject(page, 'import-state-toggle-test');
    await openImportDialog(page);

    // Default filter is Open.
    await expect(page.locator('[data-testid="import-issue-open-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-closed-1"]')).toHaveCount(0);

    const countAfterOpen = await getReconcileCallCount(page);
    const importDialog = page.locator('[data-testid="import-dialog"]');

    // Switch to Closed - client-side, instant, no reconcile.
    await importDialog.getByRole('button', { name: 'Closed' }).click();
    await expect(page.locator('[data-testid="import-issue-closed-1"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-open-1"]')).toHaveCount(0);

    // Switch to All - both show.
    await importDialog.getByRole('button', { name: 'All' }).click();
    await expect(page.locator('[data-testid="import-issue-open-1"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-closed-1"]')).toBeVisible();

    // No state toggle ever refetched.
    expect(await getReconcileCallCount(page)).toBe(countAfterOpen);

    await browser.close();
  });

  test('closing the dialog mid-reconcile stops further reconciles with no unmounted-component error', async () => {
    const { browser, page } = await launchPage();

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const getPageErrors = collectPageErrors(page);

    await seedGitHubSource(page);
    // Empty cache + a long-delayed reconcile, so the reconcile is in flight when we close.
    await seedCached(page, []);
    await page.evaluate((issues) => {
      (window as unknown as { __mockImportReconcileDelayMs?: number }).__mockImportReconcileDelayMs = 2000;
      (window as unknown as { __mockImportReconcile?: unknown }).__mockImportReconcile = {
        issues, added: 1, updated: 0, removed: 0,
      };
    }, [makeIssue({ externalId: 'unmount-1', title: 'Unmount test issue' })]);

    await createProject(page, 'import-unmount-cancel-test');
    await openImportDialogRaw(page);

    // The spinner is up (empty cache) and the reconcile is in flight.
    await expect(page.locator('[data-testid="import-loading"]')).toBeVisible();
    const countBeforeClose = await getReconcileCallCount(page);
    expect(countBeforeClose).toBeGreaterThanOrEqual(1);

    await page.locator('[data-testid="import-dialog"]').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0, { timeout: 3000 });

    // Intentional fixed wait: proves a negative (no further reconcile after unmount),
    // which cannot be expressed as a poll. The margin over the seeded 2000ms delay is
    // deliberately wide, not just clear: this spec runs in parallel mode, and a worker
    // starved for a few hundred milliseconds would otherwise read "the reconcile has
    // not fired yet" as "it never will" and pass for the wrong reason.
    await page.waitForTimeout(4000);

    expect(await getReconcileCallCount(page)).toBe(countBeforeClose);
    expect(getPageErrors()).toEqual([]);
    expect(consoleErrors).toEqual([]);

    await browser.close();
  });

  test('a reconcile failure shows the error banner, and Retry clears it once it succeeds', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await page.evaluate(() => {
      (window as unknown as { __mockImportReconcileFailUntilCleared?: boolean }).__mockImportReconcileFailUntilCleared = true;
    });

    await createProject(page, 'import-error-retry-test');
    await openImportDialogRaw(page);

    const importDialog = page.locator('[data-testid="import-dialog"]');
    const errorBanner = page.getByText('Mock import reconcile failure');
    await expect(errorBanner).toBeVisible({ timeout: 5000 });
    const retryButton = importDialog.getByRole('button', { name: 'Retry' });
    await expect(retryButton).toBeVisible();

    // Switch the mock to succeed, then retry.
    await page.evaluate((issue) => {
      (window as unknown as { __mockImportReconcileFailUntilCleared?: boolean }).__mockImportReconcileFailUntilCleared = false;
      (window as unknown as { __mockImportReconcile?: unknown }).__mockImportReconcile = {
        issues: [issue], added: 1, updated: 0, removed: 0,
      };
    }, makeIssue({ externalId: 'retry-success-issue', title: 'Recovered after retry' }));
    await retryButton.click();

    await expect(errorBanner).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-testid="import-issue-retry-success-issue"]')).toBeVisible({ timeout: 5000 });

    // Retry re-runs the same incremental reconcile the banner was already
    // doing, not a full re-prune (that is Refresh's job, asserted above).
    expect(await getLastReconcileMode(page)).toBe('incremental');

    await browser.close();
  });

  test('select-all becomes unchecked once the reconcile adds more selectable items', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    // Cache paints one item; the delayed reconcile adds a second selectable item.
    await seedCached(page, [makeIssue({ externalId: 'select-cached', title: 'Cached selectable' })]);
    await page.evaluate((issues) => {
      (window as unknown as { __mockImportReconcileDelayMs?: number }).__mockImportReconcileDelayMs = 1500;
      (window as unknown as { __mockImportReconcile?: unknown }).__mockImportReconcile = {
        issues, added: 1, updated: 0, removed: 0,
      };
    }, [makeIssue({ externalId: 'select-cached', title: 'Cached selectable' }), makeIssue({ externalId: 'select-new', title: 'Reconciled selectable' })]);

    await createProject(page, 'import-select-all-staleness-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-select-cached"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-syncing"]')).toBeVisible();

    const selectAllCheckbox = page.locator('[data-testid="import-select-all"]');
    await selectAllCheckbox.click();

    await expect(selectAllCheckbox).toBeChecked();
    await expect(page.locator('[data-testid="import-execute-btn"]')).toContainText('Import (1)');

    await waitForSyncSettled(page);
    await expect(page.locator('[data-testid="import-issue-select-new"]')).toBeVisible();

    // The selection is unchanged, but selectableIssues grew, so selectedIds.size (1)
    // no longer equals selectableIssues.length (2).
    await expect(selectAllCheckbox).not.toBeChecked();
    await expect(page.locator('[data-testid="import-execute-btn"]')).toContainText('Import (1)');

    await browser.close();
  });

  test('the all-imported empty state shows Refresh, and clicking it re-runs reconcile', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [makeIssue({ externalId: 'already-imported-1', title: 'Already imported issue', alreadyImported: true })]);

    await createProject(page, 'import-all-imported-test');
    await openImportDialog(page);

    // hideImported defaults on, so the single imported issue is hidden, and every
    // fetched issue being imported makes `allImported` true.
    await expect(page.getByText('All items have been imported')).toBeVisible({ timeout: 3000 });
    const refreshButton = page.getByRole('button', { name: 'Refresh to check for new items' });
    await expect(refreshButton).toBeVisible();

    const countBeforeRefresh = await getReconcileCallCount(page);
    await refreshButton.click();

    // Refresh must run a real reconcile, not a dead handler.
    await expect.poll(async () => getReconcileCallCount(page), { timeout: 3000 }).toBeGreaterThan(countBeforeRefresh);

    // Refresh is a deliberate re-prune-everything, so it must reconcile in
    // 'full' mode, not 'incremental' (which is what the Retry banner uses).
    expect(await getLastReconcileMode(page)).toBe('full');

    await browser.close();
  });

  test('the all-imported empty-state message is suppressed while a reconcile is still in flight', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    // Cache holds only an already-imported item (filtered out by hideImported), and
    // the delayed reconcile adds a fresh one.
    await seedCached(page, [makeIssue({ externalId: 'midstream-imported-1', title: 'Cached imported issue', alreadyImported: true })]);
    await page.evaluate((issues) => {
      (window as unknown as { __mockImportReconcileDelayMs?: number }).__mockImportReconcileDelayMs = 1500;
      (window as unknown as { __mockImportReconcile?: unknown }).__mockImportReconcile = {
        issues, added: 1, updated: 0, removed: 0,
      };
    }, [
      makeIssue({ externalId: 'midstream-imported-1', title: 'Cached imported issue', alreadyImported: true }),
      makeIssue({ externalId: 'midstream-fresh-2', title: 'Reconciled fresh issue', alreadyImported: false }),
    ]);

    await createProject(page, 'import-allimported-midstream-test');
    await openImportDialog(page);

    // Cache painted (loading gone), reconcile in flight (syncing).
    await expect(page.locator('[data-testid="import-syncing"]')).toBeVisible();

    // Non-occurrence check: a single direct snapshot, not a polling toHaveCount(0),
    // which would pass once the message naturally disappears. See anti-pattern 6 in
    // the test-builder catalogue: you cannot poll for "nothing happens".
    const completionClaimedMidStream = await page.getByText('All items have been imported').count();
    expect(completionClaimedMidStream).toBe(0);

    await waitForSyncSettled(page);
    await expect(page.locator('[data-testid="import-issue-midstream-fresh-2"]')).toBeVisible({ timeout: 3000 });

    await browser.close();
  });

  test('a malformed reconcile response (non-array issues) shows the error banner with Retry', async () => {
    const { browser, page } = await launchPage();

    const getPageErrors = collectPageErrors(page);

    await seedGitHubSource(page);
    // A response whose `issues` field is not an array makes sortByCreatedDesc throw
    // inside reconcile, after the call itself resolved.
    await page.evaluate(() => {
      (window as unknown as { __mockImportReconcile?: unknown }).__mockImportReconcile = { issues: null };
    });

    await createProject(page, 'import-malformed-response-test');
    await openImportDialogRaw(page);

    const importDialog = page.locator('[data-testid="import-dialog"]');
    const errorBanner = importDialog.locator('.text-danger').last();
    await expect(errorBanner).toBeVisible({ timeout: 5000 });
    await expect(importDialog.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Confirms the try/catch caught the malformed-payload throw rather than it
    // surfacing as an unhandled rejection.
    expect(getPageErrors()).toEqual([]);

    await browser.close();
  });

  test('searching an issue number matches the ID the row prints, with or without the "#"', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: '276', title: 'Stop a close during the entrance animation sticking open' }),
      makeIssue({ externalId: '981', title: 'Unrelated sibling issue' }),
    ]);

    await createProject(page, 'import-id-search-issues-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-981"]')).toBeVisible();

    await page.locator('[data-testid="import-search"]').fill('276');
    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-981"]')).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('#276');
    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-981"]')).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('  #276  ');
    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-981"]')).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('searching a number on a github_projects source matches the URL-derived ID, not externalId', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubProjectsSource(page);
    await seedReconcile(page, [
      makeIssue({
        externalId: 'PVTI_lADOAAAAAAB1c2zgABCDEF',
        externalSource: 'github_projects',
        externalUrl: 'https://github.com/org/repo/issues/512',
        title: 'Project item whose number lives in the URL',
      }),
      makeIssue({
        externalId: 'PVTI_lADOAAAAAAB1c2zgUVWXYZ',
        externalSource: 'github_projects',
        externalUrl: 'https://github.com/org/repo/issues/640',
        title: 'Unrelated project item',
      }),
    ]);

    await createProject(page, 'import-id-search-projects-test');
    await openImportDialog(page, 'org/repo Roadmap Project');

    const targetRow = page.locator('[data-testid="import-issue-PVTI_lADOAAAAAAB1c2zgABCDEF"]');
    const siblingRow = page.locator('[data-testid="import-issue-PVTI_lADOAAAAAAB1c2zgUVWXYZ"]');

    await expect(targetRow).toBeVisible();
    await expect(siblingRow).toBeVisible();

    await page.locator('[data-testid="import-search"]').fill('512');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('#512');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('searching matches the other fields the row prints - a label and an assignee', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: '701', title: 'Drag target keeps its position', labels: ['regression'], assignee: 'Ryan-Tuck' }),
      makeIssue({ externalId: '702', title: 'Unrelated sibling issue', labels: ['docs'], assignee: 'someone-else' }),
    ]);

    await createProject(page, 'import-label-assignee-search-test');
    await openImportDialog(page);

    const targetRow = page.locator('[data-testid="import-issue-701"]');
    const siblingRow = page.locator('[data-testid="import-issue-702"]');
    await expect(targetRow).toBeVisible();
    await expect(siblingRow).toBeVisible();

    await page.locator('[data-testid="import-search"]').fill('regression');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('ryan-tuck');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('@ryan-tuck');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('searching text that appears only in an issue description matches nothing', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: '335', title: 'Creating a new task should open the task modal directly', body: 'Fixed by #332.' }),
      makeIssue({ externalId: '336', title: 'Unrelated sibling issue', body: 'Mentions the swimlane reordering behaviour.' }),
    ]);

    await createProject(page, 'import-description-excluded-test');
    await openImportDialog(page);

    const crossReferencingRow = page.locator('[data-testid="import-issue-335"]');
    const plainBodyRow = page.locator('[data-testid="import-issue-336"]');
    await expect(crossReferencingRow).toBeVisible();
    await expect(plainBodyRow).toBeVisible();

    await page.locator('[data-testid="import-search"]').fill('332');
    await expect(crossReferencingRow).toHaveCount(0, { timeout: 3000 });
    await expect(plainBodyRow).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('swimlane');
    await expect(crossReferencingRow).toHaveCount(0, { timeout: 3000 });
    await expect(plainBodyRow).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('335');
    await expect(crossReferencingRow).toBeVisible({ timeout: 3000 });
    await expect(plainBodyRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('a query spanning two haystack fields (no separator) matches nothing, but a query within one field still matches', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: '501', title: 'Zebra crossing needs a redesign', workItemType: 'Bug' }),
      makeIssue({ externalId: '999', title: 'Unrelated sibling issue' }),
    ]);

    await createProject(page, 'import-id-search-separator-test');
    await openImportDialog(page);

    const targetRow = page.locator('[data-testid="import-issue-501"]');
    const siblingRow = page.locator('[data-testid="import-issue-999"]');
    await expect(targetRow).toBeVisible();
    await expect(siblingRow).toBeVisible();

    await page.locator('[data-testid="import-search"]').fill('501z');
    await expect(targetRow).toHaveCount(0, { timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('501');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await page.locator('[data-testid="import-search"]').fill('designb');
    await expect(targetRow).toHaveCount(0, { timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('a literal internal "#" in the query is preserved, not globally stripped', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: '601', title: 'Cannot detect the c# compiler on PATH' }),
      makeIssue({ externalId: '602', title: 'References the cache subsystem' }),
    ]);

    await createProject(page, 'import-hash-anchor-search-test');
    await openImportDialog(page);

    const targetRow = page.locator('[data-testid="import-issue-601"]');
    const siblingRow = page.locator('[data-testid="import-issue-602"]');
    await expect(targetRow).toBeVisible();
    await expect(siblingRow).toBeVisible();

    await page.locator('[data-testid="import-search"]').fill('c#');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('a query that normalizes to empty (a lone "#") is not treated as an active filter', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, []);

    await createProject(page, 'import-empty-normalized-filter-test');
    await openImportDialog(page);

    await expect(page.getByText('No items found')).toBeVisible({ timeout: 3000 });

    // A lone '#' normalizes to '' (the leading '#' is stripped), so it must not flip
    // the empty state to the "filters excluded everything" branch.
    await page.locator('[data-testid="import-search"]').fill('#');
    await expect(page.getByText('No items found')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-empty-state-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="import-clear-filters-btn"]')).toHaveCount(0);

    await browser.close();
  });
});

test.describe('ImportDialog - execute result toast', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  // The whole user-visible payoff of reporting a failed per-item detail hydrate
  // (e.g. Azure DevOps comments) instead of degrading silently: the import still
  // succeeds, but the toast has to say which items are missing their detail so
  // it does not read as a clean, complete import.
  test('a truthy detailUnavailable on the execute result is reported in the success toast', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: 'detail-unavailable-1', title: 'Item whose comment hydrate failed' }),
    ]);
    await page.evaluate(() => {
      (window as unknown as { __mockImportExecutePreset?: unknown }).__mockImportExecutePreset = {
        imported: 1,
        skippedDuplicates: 0,
        skippedAttachments: 0,
        detailUnavailable: 1,
        items: [],
      };
    });

    await createProject(page, 'import-detail-unavailable-test');
    await openImportDialog(page);

    const issueRow = page.locator('[data-testid="import-issue-detail-unavailable-1"]');
    await expect(issueRow).toBeVisible();
    await issueRow.locator('input[type="checkbox"]').click();

    const importButton = page.locator('[data-testid="import-execute-btn"]');
    await expect(importButton).toBeEnabled();
    await importButton.click();

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'comments unavailable for 1' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText('Imported 1 item');

    await browser.close();
  });

  test('an absent detailUnavailable on the execute result reports no comment-unavailable segment', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);
    await seedReconcile(page, [
      makeIssue({ externalId: 'detail-available-1', title: 'Item whose comment hydrate succeeded' }),
    ]);
    await page.evaluate(() => {
      (window as unknown as { __mockImportExecutePreset?: unknown }).__mockImportExecutePreset = {
        imported: 1,
        skippedDuplicates: 0,
        skippedAttachments: 0,
        items: [],
      };
    });

    await createProject(page, 'import-detail-available-test');
    await openImportDialog(page);

    const issueRow = page.locator('[data-testid="import-issue-detail-available-1"]');
    await expect(issueRow).toBeVisible();
    await issueRow.locator('input[type="checkbox"]').click();

    const importButton = page.locator('[data-testid="import-execute-btn"]');
    await expect(importButton).toBeEnabled();
    await importButton.click();

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Imported 1 item' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).not.toContainText('comments unavailable');

    await browser.close();
  });
});
