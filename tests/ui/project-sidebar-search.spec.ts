import { test, expect, type Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

let page: Page;

test.beforeEach(async () => {
  const launched = await launchPage();
  page = launched.page;
  await createProject(page, 'Alpha');
  await createProject(page, 'Beta');
  await createProject(page, 'Gamma');
});

test.afterEach(async () => {
  await page.context().browser()?.close();
});

test.describe('Project Sidebar Search', () => {
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

async function launchWithGroupSearch(preConfigScript: string): Promise<{ browser: any; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const newPage = await context.newPage();

  await newPage.addInitScript({ path: MOCK_SCRIPT });
  await newPage.addInitScript(preConfigScript);

  await newPage.goto(VITE_URL);
  await newPage.waitForLoadState('load');
  await newPage.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page: newPage };
}

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
  test('collapsed group force-expands when its children match the search query', async () => {
    const { browser, page: groupPage } = await launchWithGroupSearch(collapsedGroupPreConfig());

    try {
      // Wait for the board (project is open)
      await groupPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Initially the group is collapsed so InGroup is hidden
      const sidebar = groupPage.locator('.bg-surface-raised').first();
      await expect(sidebar.locator('[role="button"]:has-text("InGroup")')).toBeHidden();

      // Searching for the project name should force-expand the group
      const search = groupPage.locator('[data-testid="project-sidebar-search"]');
      await search.fill('InGroup');

      await expect(sidebar.locator('[role="button"]:has-text("InGroup")')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('group with zero matching children is hidden entirely during search', async () => {
    const { browser, page: groupPage } = await launchWithGroupSearch(collapsedGroupPreConfig());

    try {
      await groupPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

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
    } finally {
      await browser.close();
    }
  });
});
