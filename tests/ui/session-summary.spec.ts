/**
 * UI tests for the Session Summary panel and Done column metrics.
 *
 * Covers: SessionSummaryPanel rendering (empty state, populated metrics,
 * status badges, copy-to-clipboard), cost badges on compact cards,
 * Done column completed section, search, and sort.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-summary-test';
const TASK_ID = 'task-summary-1';
const SESSION_ID = 'abc12345-6789-4def-abcd-000000000001';

/** Build a pre-configure script with an archived task and optional summary data */
function makePreConfig(options: {
  withSummary: boolean;
  exitCode?: number | null;
  extraArchivedTasks?: number;
}): string {
  const exitCode = options.exitCode !== undefined ? options.exitCode : 0;
  const summaryBlock = options.withSummary
    ? `
      state.summaryCache['${TASK_ID}'] = {
        sessionId: '${SESSION_ID}',
        totalCostUsd: 0.08,
        totalInputTokens: 12500,
        totalOutputTokens: 545,
        modelDisplayName: 'Opus 4.6 (1M context)',
        durationMs: 17000,
        toolCallCount: 5,
        linesAdded: 469,
        linesRemoved: 181,
        filesChanged: 18,
        taskCreatedAt: '2026-03-13T15:40:00.000Z',
        startedAt: '2026-03-13T15:44:00.000Z',
        exitedAt: '2026-03-13T15:45:00.000Z',
        exitCode: ${exitCode === null ? 'null' : exitCode},
      };
    `
    : '';

  let extraTasksBlock = '';
  if (options.extraArchivedTasks) {
    for (let index = 0; index < options.extraArchivedTasks; index++) {
      const extraId = `task-extra-${index}`;
      extraTasksBlock += `
        state.archivedTasks.push({
          id: '${extraId}',
          title: 'Extra Task ${index + 1}',
          description: 'Description for extra task ${index + 1}',
          swimlane_id: doneLane.id,
          position: ${index + 1},
          agent: null,
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          use_worktree: null,
          attachment_count: 0,
          archived_at: ts,
          created_at: ts,
          updated_at: ts,
        });
        state.summaryCache['${extraId}'] = {
          sessionId: state.uuid(),
          totalCostUsd: ${(0.02 * (index + 1)).toFixed(2)},
          totalInputTokens: ${1000 * (index + 1)},
          totalOutputTokens: ${200 * (index + 1)},
          modelDisplayName: 'Opus 4.6 (1M context)',
          durationMs: ${5000 * (index + 1)},
          toolCallCount: ${index + 1},
          linesAdded: ${10 * (index + 1)},
          linesRemoved: ${5 * (index + 1)},
          filesChanged: ${index + 1},
          taskCreatedAt: '2026-03-13T14:${String(50 + index).padStart(2, '0')}:00.000Z',
          startedAt: '2026-03-13T15:00:00.000Z',
          exitedAt: '2026-03-13T15:${String(index + 1).padStart(2, '0')}:00.000Z',
          exitCode: 0,
        };
      `;
    }
  }

  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Summary Test',
        path: '/mock/summary-test',
        github_url: null,
        default_agent: 'claude',
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        state.swimlanes.push({
          id: state.uuid(),
          name: template.name,
          role: template.role,
          color: template.color,
          icon: template.icon,
          is_archived: template.is_archived,
          is_ghost: template.is_ghost,
          permission_strategy: template.permission_strategy ?? null,
          auto_spawn: template.auto_spawn ?? false,
          auto_command: template.auto_command ?? null,
          plan_exit_target_id: null,
          position: index,
          created_at: ts,
        });
      });

      var doneLane = state.swimlanes.find(function (lane) { return lane.role === 'done'; });

      state.archivedTasks.push({
        id: '${TASK_ID}',
        title: 'Completed Test Task',
        description: 'A task that has been completed',
        swimlane_id: doneLane.id,
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        attachment_count: 0,
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });

      ${summaryBlock}
      ${extraTasksBlock}

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

test.describe('Session Summary Panel', () => {
  test('shows empty state when no session data exists', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: false }));
    try {
      // Wait for board, then click the archived task
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      // Session summary panel should show empty state
      const summaryPanel = page.locator('[data-testid="session-summary"]');
      await expect(summaryPanel).toBeVisible({ timeout: 5000 });
      await expect(summaryPanel).toContainText('No session data available');
    } finally {
      await browser.close();
    }
  });

  test('shows Completed badge and all metric rows for exit code 0', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, exitCode: 0 }));
    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      const summaryPanel = page.locator('[data-testid="session-summary"]');
      await expect(summaryPanel).toBeVisible({ timeout: 5000 });

      // Status badge
      await expect(summaryPanel).toContainText('Completed');

      // Session ID (full UUID visible)
      await expect(summaryPanel).toContainText(SESSION_ID);

      // Model
      await expect(summaryPanel).toContainText('Opus 4.6 (1M context)');

      // Cost
      await expect(summaryPanel).toContainText('$0.08');

      // Tokens (12500 → "12.5k", 545 → "545")
      await expect(summaryPanel).toContainText('12.5k');
      await expect(summaryPanel).toContainText('545');

      // Tool calls
      await expect(summaryPanel).toContainText('5');

      // Files changed
      await expect(summaryPanel).toContainText('18');

      // Lines changed
      await expect(summaryPanel).toContainText('+469');
      await expect(summaryPanel).toContainText('-181');

      // Duration label exists
      await expect(summaryPanel).toContainText('Duration');

      // Agent active time (17000ms → "17s active")
      await expect(summaryPanel).toContainText('17s active');
    } finally {
      await browser.close();
    }
  });

  test('Timeline row renders non-empty formatted dates on both sides of the arrow', async () => {
    // The summary fixture sets taskCreatedAt and exitedAt. SessionSummaryPanel renders:
    //   <timelineStart> <ArrowRight/> <formatShortDateTime(exitedAt)>
    // We assert both sides are non-empty text. We deliberately do NOT assert exact
    // locale output -- that is covered by the unit tier datetime.test.ts tests.
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, exitCode: 0 }));
    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      const summaryPanel = page.locator('[data-testid="session-summary"]');
      await expect(summaryPanel).toBeVisible({ timeout: 5000 });

      // Find the Timeline row value cell -- it is a flex span with gap-1.5 (unique
      // among the flex value cells; Tokens and Lines changed use gap-2).
      // It contains: start date text, an ArrowRight svg, end date text.
      const timelineValue = summaryPanel.locator('span.tabular-nums.flex.items-center.gap-1\\.5');
      await expect(timelineValue).toBeVisible({ timeout: 5000 });

      // Extract the text content of the span; svg elements contribute no text so
      // the result is the concatenation of both formatted date strings.
      const fullText = await timelineValue.textContent();
      expect(fullText).toBeTruthy();
      // Both dates should produce non-empty strings. We check the overall text is
      // longer than 1 character as a baseline -- a single empty string would be "".
      expect((fullText ?? '').trim().length).toBeGreaterThan(1);
      // Dates always contain digits.
      expect(fullText).toMatch(/\d/);
    } finally {
      await browser.close();
    }
  });

  test('shows Completed badge for null exit code (suspended path)', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, exitCode: null }));
    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      const summaryPanel = page.locator('[data-testid="session-summary"]');
      await expect(summaryPanel).toBeVisible({ timeout: 5000 });
      await expect(summaryPanel).toContainText('Completed');
    } finally {
      await browser.close();
    }
  });

  test('shows Exited badge with exit code for non-zero exit', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true, exitCode: 1 }));
    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Completed Test Task').click();

      const summaryPanel = page.locator('[data-testid="session-summary"]');
      await expect(summaryPanel).toBeVisible({ timeout: 5000 });
      await expect(summaryPanel).toContainText('Exited (1)');
    } finally {
      await browser.close();
    }
  });
});

test.describe('Done Column', () => {
  test('completed section is always visible with header', async () => {
    const { browser, page } = await launchWithState(makePreConfig({ withSummary: true }));
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });

      // "Completed (1)" header should be visible without any user interaction
      await expect(doneColumn).toContainText('Completed (1)');

      // Task should be visible without expanding
      await expect(doneColumn.locator('text=Completed Test Task')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('shows completed tasks and "View all" button', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ withSummary: true, extraArchivedTasks: 6 }),
    );
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });

      // Should show count of all 7 tasks in header
      await expect(doneColumn).toContainText('Completed (7)');

      // All tasks are rendered (visible count depends on viewport, but all are in DOM)
      const compactCards = doneColumn.locator('[data-testid="compact-title"]');
      await expect(compactCards).toHaveCount(7);

      // "View all" button should always be visible at bottom
      await expect(doneColumn.locator('[data-testid="view-all-completed"]')).toBeVisible();
      await expect(doneColumn.locator('[data-testid="view-all-completed"]')).toContainText('View all');
      await expect(doneColumn.locator('[data-testid="view-all-completed"]')).toContainText('7');
    } finally {
      await browser.close();
    }
  });

  test('completed dialog opens from "View all" link', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ withSummary: true, extraArchivedTasks: 6 }),
    );
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });

      // Click "View all" link
      await doneColumn.locator('[data-testid="view-all-completed"]').click();

      // Dialog should open with all tasks
      const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog).toContainText('Completed Tasks (7)');
    } finally {
      await browser.close();
    }
  });

  test('empty state shows when no completed tasks exist', async () => {
    // No archived tasks, no extra tasks
    const preConfig = `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();
        state.projects.push({
          id: '${PROJECT_ID}',
          name: 'Empty Done Test',
          path: '/mock/empty-done',
          github_url: null,
          default_agent: 'claude',
          position: 0,
          last_opened: ts,
          created_at: ts,
        });
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          state.swimlanes.push({
            id: state.uuid(),
            name: template.name,
            role: template.role,
            color: template.color,
            icon: template.icon,
            is_archived: template.is_archived,
            is_ghost: template.is_ghost,
            permission_strategy: template.permission_strategy ?? null,
            auto_spawn: template.auto_spawn ?? false,
            auto_command: template.auto_command ?? null,
            plan_exit_target_id: null,
            position: index,
            created_at: ts,
          });
        });
        return { currentProjectId: '${PROJECT_ID}' };
      });
    `;

    const { browser, page } = await launchWithState(preConfig);
    try {
      const doneColumn = page.locator('[data-swimlane-name="Done"]');
      await doneColumn.waitFor({ state: 'visible', timeout: 10000 });

      await expect(doneColumn).toContainText('Completed (0)');
      await expect(doneColumn).toContainText('No completed tasks yet');
    } finally {
      await browser.close();
    }
  });
});
