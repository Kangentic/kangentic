import { test, expect, type Browser, type Page } from '@playwright/test';
import { launchSharedBrowser, resetPage, createProject } from './helpers';

// Each describe is isolated per worker (separate process; goto reset in beforeEach),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

test.describe('Project Sidebar Search', () => {
  // Pins this describe to ONE group, so the shared browser below is actually shared.
  // Without it these tests land in Playwright's `parallelWithHooks` bucket, chunked
  // into `ceil(tests / shardTotal)` groups - one group per test at CI's shardTotal=9.
  test.describe.configure({ mode: 'default' });

  let browser: Browser;
  let page: Page;

  // One browser per worker group instead of one per test, and scoped to THIS
  // describe: the group edge cases below bring their own pre-configured browser,
  // so a file-level hook would make them pay for three project creations they
  // immediately discard.
  test.beforeAll(async () => {
    ({ browser, page } = await launchSharedBrowser());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetPage(page);
    await createProject(page, 'Alpha');
    await createProject(page, 'Beta');
    await createProject(page, 'Gamma');
  });

  test('typing filters the project list by name', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();
    const search = page.locator('[data-testid="project-sidebar-search"]');

    await search.fill('alp');

    await expect(sidebar.locator('[role="button"]:has-text("Alpha")')).toBeVisible();
    await expect(sidebar.locator('[role="button"]:has-text("Beta")')).toHaveCount(0);
    await expect(sidebar.locator('[role="button"]:has-text("Gamma")')).toHaveCount(0);
  });

  test('clearing the search restores the full list', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();
    const search = page.locator('[data-testid="project-sidebar-search"]');

    await search.fill('alp');
    await page.locator('[data-testid="project-sidebar-search-clear"]').click();

    await expect(sidebar.locator('[role="button"]:has-text("Alpha")')).toBeVisible();
    await expect(sidebar.locator('[role="button"]:has-text("Beta")')).toBeVisible();
    await expect(sidebar.locator('[role="button"]:has-text("Gamma")')).toBeVisible();
  });

  test('Escape clears the search input', async () => {
    const search = page.locator('[data-testid="project-sidebar-search"]');

    await search.fill('alp');
    await search.press('Escape');

    await expect(search).toHaveValue('');
  });

  test('no matches shows the empty-state hint', async () => {
    const search = page.locator('[data-testid="project-sidebar-search"]');
    await search.fill('zzzzzz');

    await expect(page.locator('text=No projects match')).toBeVisible();
  });
});

// ─── Group + search edge cases ─────────────────────────────────────────────

/**
 * Pre-configure a collapsed group containing "InGroup" project, plus an
 * ungrouped "Ungrouped" project. Active project is InGroup.
 */
function collapsedGroupPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      // Group
      var groupId = 'search-group-1';
      state.projectGroups.push({
        id: groupId,
        name: 'MyGroup',
        position: 0,
        is_collapsed: true,
      });

      // Grouped project
      var projId = 'search-proj-in';
      state.projects.push({
        id: projId,
        name: 'InGroup',
        path: '/mock/in-group',
        github_url: null,
        default_agent: 'claude',
        group_id: groupId,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      // Ungrouped project
      var ungroupedId = 'search-proj-out';
      state.projects.push({
        id: ungroupedId,
        name: 'Ungrouped',
        path: '/mock/ungrouped',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 1,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'search-lane-' + i,
          position: i,
          created_at: ts,
        }));
      });

      return { currentProjectId: projId };
    });
  `;
}

test.describe('Project Sidebar Search - group edge cases', () => {
  test.describe.configure({ mode: 'default' });

  let groupBrowser: Browser;
  let groupPage: Page;

  // Both tests want the same pre-configured state, so they share one browser and
  // reset via page.goto() (which re-runs the preconfig init script) rather than
  // launching per test.
  test.beforeAll(async () => {
    ({ browser: groupBrowser, page: groupPage } = await launchSharedBrowser(
      collapsedGroupPreConfig(),
    ));
  });

  test.afterAll(async () => {
    await groupBrowser?.close();
  });

  test.beforeEach(async () => {
    await resetPage(groupPage);
    // Wait for the board (project is open)
    await groupPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  });

  test('collapsed group force-expands when its children match the search query', async () => {
    // Initially the group is collapsed so InGroup is hidden
    const sidebar = groupPage.locator('.bg-surface-raised').first();
    await expect(sidebar.locator('[role="button"]:has-text("InGroup")')).toBeHidden();

    // Searching for the project name should force-expand the group
    const search = groupPage.locator('[data-testid="project-sidebar-search"]');
    await search.fill('InGroup');

    await expect(sidebar.locator('[role="button"]:has-text("InGroup")')).toBeVisible();
  });

  test('group with zero matching children is hidden entirely during search', async () => {
    // The group header should be visible before filtering
    await expect(groupPage.locator('[data-testid^="project-group-"]')).toBeVisible();

    // Search for a term that only matches the ungrouped project
    const search = groupPage.locator('[data-testid="project-sidebar-search"]');
    await search.fill('Ungrouped');

    // Group header should be hidden (no matching children)
    await expect(groupPage.locator('[data-testid^="project-group-"]')).toBeHidden();

    // But the ungrouped project is still visible
    const sidebar = groupPage.locator('.bg-surface-raised').first();
    await expect(sidebar.locator('[role="button"]:has-text("Ungrouped")')).toBeVisible();
  });
});
