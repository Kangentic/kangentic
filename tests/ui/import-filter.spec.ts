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
 *
 * 15. An issue whose externalId reappears on a later streamed page (its
 *     ordering shifted between sequential fetches) is deduped to a single
 *     row instead of double-rendering it, and the footer's loaded count
 *     reflects the deduped total, not the raw sum of both pages' arrays.
 *
 * 16. The search box matches the ID the row prints, for a plain github_issues
 *     source, with the leading '#', without it, and with surrounding whitespace
 *     (the paste case). The seeded item's number appears nowhere in its title, so
 *     a title-only predicate fails this.
 *
 * 17. The same, for a github_projects source, whose externalId is an opaque
 *     project-item node id - the visible '#N' comes from the external URL. The
 *     node id deliberately does not contain the number, so matching externalId
 *     instead of the rendered ID still fails this one.
 *
 * 18. The search box matches the other fields the row prints - a label and an
 *     assignee - so a hit is always explainable from the row.
 *
 * 18b. The search box does NOT match the issue description (body), which no row
 *     renders. Guards the rule directly: issue bodies cross-reference each other
 *     by number ("Fixed by #332"), so a body in the haystack made an ID search
 *     return every issue MENTIONING a number alongside the one that IS it.
 *
 * 19. The '\n' field separators inside searchHaystack keep a query from
 *     spanning two fields, at both boundaries (id/title and title/type): a
 *     query that only forms a contiguous substring when two fields are
 *     concatenated without a separator (e.g. '501z' spanning '#501' and
 *     'zebra...', or 'designb' spanning '...redesign' and 'Bug') must match
 *     nothing, while a query entirely within one field still matches.
 *
 * 20. The leading-'#' strip on the search term is anchored ('^#'), not
 *     global: a literal internal '#' in the query (e.g. 'c#') must be
 *     preserved rather than degrading to a bare letter that would over-match.
 *
 * 21. hasActiveFilters reads the normalized search term, not the raw input:
 *     a query that normalizes to empty (a lone '#') must not flip the empty
 *     state to the "filters excluded everything" branch when nothing was
 *     actually excluded.
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
  workItemType: string;
  assignee: string | null;
  labels: string[];
  createdAt: string;
  alreadyImported: boolean;
}>) {
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
    state: overrides.state ?? 'open',
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

/**
 * Open the import dialog by clicking the pre-seeded source in the backlog popover.
 * Returns when the dialog is visible and the first fetch has settled (loading
 * spinner gone).
 */
async function openImportDialog(page: Page, sourceLabel = 'org/repo GitHub Issues'): Promise<void> {
  // Navigate to backlog view
  await page.locator('[data-testid="view-toggle-backlog"]').click();

  // Open the import popover
  const importSourcesButton = page.locator('[data-testid="import-sources-btn"]').first();
  await importSourcesButton.click();
  await expect(page.locator('[data-testid="import-popover"]')).toBeVisible();

  // Click the pre-seeded source
  await page.getByText(sourceLabel).click();

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

  test('the Status filter menu stays right-anchored to its trigger (MultiSelectDropdown\'s default align)', async () => {
    // MultiSelectDropdown defaults `align` to 'right': the Import dialog's
    // filter cluster sits at the dialog's right edge, so its menus hang left
    // of the trigger with their RIGHT edges glued together - the mirror image
    // of the agent monitor toolbar's align="left" assertion (its LEFT edges
    // glued together instead), which is the only other geometry check on this
    // component. Nothing in this file asserted alignment before this, so
    // flipping the default (or inverting the `align !== 'left'` ternary that
    // derives `preferRight`) passed every existing test here.
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
        makeIssue({ externalId: 'align-page1-issue', title: 'Align check page one', state: 'open' }),
        makeIssue({ externalId: 'align-page2-issue', title: 'Align check page two', state: 'triaged' }),
      ],
    );

    await createProject(page, 'import-status-align-right-test');
    await openImportDialog(page);
    await waitForStreamingSettled(page);

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

  test('a duplicate externalId across two streamed pages is deduped, not double-rendered', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // A source can return the same item on two pages when its ordering shifts
    // between sequential fetches (the exact scenario loadAllIssues's seenIds
    // dedup exists to guard against - see the comment above setIssues in
    // ImportDialog.tsx). Without it, the item would render twice (colliding
    // the virtualizer's item key) and risk a double-submit on import.
    await page.evaluate(
      ([duplicateIssue, uniquePageOneIssue, uniquePageTwoIssue]) => {
        (window as unknown as { __mockImportFetchPages?: unknown }).__mockImportFetchPages = [
          { issues: [duplicateIssue, uniquePageOneIssue], totalCount: 3, hasNextPage: true },
          { issues: [duplicateIssue, uniquePageTwoIssue], totalCount: 3, hasNextPage: false },
        ];
      },
      [
        makeIssue({ externalId: 'dup-shared', title: 'Item that shifted between pages' }),
        makeIssue({ externalId: 'unique-page1', title: 'Unique page one issue' }),
        makeIssue({ externalId: 'unique-page2', title: 'Unique page two issue' }),
      ],
    );

    await createProject(page, 'import-dedupe-test');
    await openImportDialog(page);

    await waitForStreamingSettled(page);

    // The duplicated item renders exactly once, not twice.
    await expect(page.locator('[data-testid="import-issue-dup-shared"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="import-issue-unique-page1"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-unique-page2"]')).toBeVisible();

    // The footer's loaded count reflects the deduped total (3 unique issues),
    // not the raw sum of both pages' issues arrays (4).
    await expect(page.locator('text=/3 of 3 items/')).toBeVisible();

    await browser.close();
  });

  test('searching an issue number matches the ID the row prints, with or without the "#"', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // The target's number appears nowhere in its title or body, so it is reachable
    // only through the '#276' the row renders. The sibling is the control: it proves
    // the filter actually ran rather than simply listing everything.
    await page.evaluate(
      ([target, sibling]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [target, sibling],
          totalCount: 2,
          hasNextPage: false,
        };
      },
      [
        makeIssue({ externalId: '276', title: 'Stop a close during the entrance animation sticking open' }),
        makeIssue({ externalId: '981', title: 'Unrelated sibling issue' }),
      ],
    );

    await createProject(page, 'import-id-search-issues-test');
    await openImportDialog(page);

    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-issue-981"]')).toBeVisible();

    // Bare number
    await page.locator('[data-testid="import-search"]').fill('276');
    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-981"]')).toHaveCount(0, { timeout: 3000 });

    // Same number as it is rendered, with the leading '#'
    await page.locator('[data-testid="import-search"]').fill('#276');
    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-981"]')).toHaveCount(0, { timeout: 3000 });

    // A pasted ID often carries surrounding whitespace, which the query trims off.
    await page.locator('[data-testid="import-search"]').fill('  #276  ');
    await expect(page.locator('[data-testid="import-issue-276"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-issue-981"]')).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('searching a number on a github_projects source matches the URL-derived ID, not externalId', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubProjectsSource(page);

    // A project item's externalId is an opaque node id that does NOT contain the
    // issue number - the '#512' the row prints is parsed out of externalUrl. The
    // node ids below deliberately contain neither '512' nor '640', so a predicate
    // matching externalId instead of the rendered ID fails this test.
    await page.evaluate(
      ([target, sibling]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [target, sibling],
          totalCount: 2,
          hasNextPage: false,
        };
      },
      [
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
      ],
    );

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

    // Neither term appears in either row's ID or title, so each hit can only come
    // from the label or the assignee - both of which the row renders.
    await page.evaluate(
      ([target, sibling]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [target, sibling],
          totalCount: 2,
          hasNextPage: false,
        };
      },
      [
        makeIssue({
          externalId: '701',
          title: 'Drag target keeps its position',
          labels: ['regression'],
          assignee: 'Ryan-Tuck',
        }),
        makeIssue({ externalId: '702', title: 'Unrelated sibling issue', labels: ['docs'], assignee: 'someone-else' }),
      ],
    );

    await createProject(page, 'import-label-assignee-search-test');
    await openImportDialog(page);

    const targetRow = page.locator('[data-testid="import-issue-701"]');
    const siblingRow = page.locator('[data-testid="import-issue-702"]');
    await expect(targetRow).toBeVisible();
    await expect(siblingRow).toBeVisible();

    // Label
    await page.locator('[data-testid="import-search"]').fill('regression');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    // Assignee, bare
    await page.locator('[data-testid="import-search"]').fill('ryan-tuck');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    // Assignee, as the row renders it (with the '@')
    await page.locator('[data-testid="import-search"]').fill('@ryan-tuck');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('searching text that appears only in an issue description matches nothing', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // The body is NOT searchable: no row renders it, so a body hit would look like
    // a phantom match. The realistic failure this guards is the cross-reference
    // case - '#332' in a body is how issues cite each other, so a body-inclusive
    // haystack made a number search return every issue that merely mentions it.
    await page.evaluate(
      ([crossReferencing, plainBody]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [crossReferencing, plainBody],
          totalCount: 2,
          hasNextPage: false,
        };
      },
      [
        makeIssue({
          externalId: '335',
          title: 'Creating a new task should open the task modal directly',
          body: 'Fixed by #332.',
        }),
        makeIssue({
          externalId: '336',
          title: 'Unrelated sibling issue',
          body: 'Mentions the swimlane reordering behaviour.',
        }),
      ],
    );

    await createProject(page, 'import-description-excluded-test');
    await openImportDialog(page);

    const crossReferencingRow = page.locator('[data-testid="import-issue-335"]');
    const plainBodyRow = page.locator('[data-testid="import-issue-336"]');
    await expect(crossReferencingRow).toBeVisible();
    await expect(plainBodyRow).toBeVisible();

    // '332' appears only inside #335's body, as a cross-reference. Nothing matches.
    await page.locator('[data-testid="import-search"]').fill('332');
    await expect(crossReferencingRow).toHaveCount(0, { timeout: 3000 });
    await expect(plainBodyRow).toHaveCount(0, { timeout: 3000 });

    // Ordinary body prose is unreachable too, not just a '#'-prefixed reference.
    await page.locator('[data-testid="import-search"]').fill('swimlane');
    await expect(crossReferencingRow).toHaveCount(0, { timeout: 3000 });
    await expect(plainBodyRow).toHaveCount(0, { timeout: 3000 });

    // The ID that IS the row still matches, so the row is reachable - this is not
    // a vacuous "everything is filtered out" pass.
    await page.locator('[data-testid="import-search"]').fill('335');
    await expect(crossReferencingRow).toBeVisible({ timeout: 3000 });
    await expect(plainBodyRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('a query spanning two haystack fields (no separator) matches nothing, but a query within one field still matches', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // The target's rendered id is '#501', its title ends with 'redesign', and its
    // work item type is 'Bug'. searchHaystack joins the row's fields with '\n', so
    // a query spanning either boundary ('501' into 'zebra...', or 'redesign' into
    // 'bug') only forms a contiguous substring if that separator is dropped - both
    // boundaries are exercised below. The sibling never contains either spanning
    // query through any field, so it is the control that proves the filter actually
    // ran rather than everything matching.
    await page.evaluate(
      ([target, sibling]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [target, sibling],
          totalCount: 2,
          hasNextPage: false,
        };
      },
      [
        makeIssue({
          externalId: '501',
          title: 'Zebra crossing needs a redesign',
          workItemType: 'Bug',
        }),
        makeIssue({ externalId: '999', title: 'Unrelated sibling issue' }),
      ],
    );

    await createProject(page, 'import-id-search-separator-test');
    await openImportDialog(page);

    const targetRow = page.locator('[data-testid="import-issue-501"]');
    const siblingRow = page.locator('[data-testid="import-issue-999"]');
    await expect(targetRow).toBeVisible();
    await expect(siblingRow).toBeVisible();

    // A query spanning the id/title boundary ('501' + the 'z' from 'zebra')
    // only forms a contiguous substring if the '\n' separator between fields
    // is dropped. With the separator present, this must match nothing.
    await page.locator('[data-testid="import-search"]').fill('501z');
    await expect(targetRow).toHaveCount(0, { timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    // A query entirely within the id field alone still matches the row - the
    // separator only blocks a query from spanning fields, not from matching
    // inside one.
    await page.locator('[data-testid="import-search"]').fill('501');
    await expect(targetRow).toBeVisible({ timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    // Same guard at the title/type boundary: 'designb' spans 'redesign' and
    // 'Bug', so it only forms a contiguous substring if that separator is
    // dropped too. Run last, so this observes a real visible-to-absent
    // transition from the prior '501' step rather than a vacuous "already
    // absent" check.
    await page.locator('[data-testid="import-search"]').fill('designb');
    await expect(targetRow).toHaveCount(0, { timeout: 3000 });
    await expect(siblingRow).toHaveCount(0, { timeout: 3000 });

    await browser.close();
  });

  test('a literal internal "#" in the query is preserved, not globally stripped', async () => {
    const { browser, page } = await launchPage();

    await seedGitHubSource(page);

    // The target's title contains a literal 'c#'; the sibling's title contains a
    // bare 'c' (several times, via 'references'/'cache') but never 'c#'. Both
    // externalIds are numeric, so neither row's id can contribute a 'c#' or stray
    // 'c' hit - only the titles are exercised. Only a LEADING '#' should be
    // stripped from the query; stripping every '#' would degrade 'c#' down to
    // a bare 'c', which the sibling's title would then also match.
    await page.evaluate(
      ([target, sibling]) => {
        (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
          issues: [target, sibling],
          totalCount: 2,
          hasNextPage: false,
        };
      },
      [
        makeIssue({
          externalId: '601',
          title: 'Cannot detect the c# compiler on PATH',
        }),
        makeIssue({
          externalId: '602',
          title: 'References the cache subsystem',
        }),
      ],
    );

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

    await page.evaluate(() => {
      (window as unknown as { __mockImportFetchPreset?: unknown }).__mockImportFetchPreset = {
        issues: [],
        totalCount: 0,
        hasNextPage: false,
      };
    });

    await createProject(page, 'import-empty-normalized-filter-test');
    await openImportDialog(page);

    // Baseline: no issues, no filters - the plain empty state.
    await expect(page.getByText('No items found')).toBeVisible({ timeout: 3000 });

    // A lone '#' normalizes to '' (the leading '#' is stripped, leaving
    // nothing), so it must not flip the empty state to the "filters excluded
    // everything" branch - nothing was actually excluded, since there was
    // nothing to filter in the first place.
    await page.locator('[data-testid="import-search"]').fill('#');
    await expect(page.getByText('No items found')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="import-empty-state-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="import-clear-filters-btn"]')).toHaveCount(0);

    await browser.close();
  });
});
