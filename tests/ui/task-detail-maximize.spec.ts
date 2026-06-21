/**
 * UI tests for the Task Detail maximize / restore toggle.
 *
 * Covers:
 * - Maximize button toggle: window frame transitions between floating (rounded-lg)
 *   and maximized (rounded-none, fills the window-overlay area between app chrome)
 * - Ctrl/Cmd+Shift+M keyboard toggle (maximize/restore)
 * - Ctrl/Cmd+Shift+W closes the window
 * - Ctrl/Cmd+Shift+B toggles the Browser pane when canShowBrowser is true
 * - Edit mode: maximize button is present and the hotkey maximizes/restores
 * - Create dialog (New Task): maximize button + hotkey toggle the layout
 * - BaseDialog default-prop non-regression: plain consumers keep inset-0 / rounded-lg
 *
 * Window model notes: the task-detail surface is now a MODELESS window rendered
 * inside WindowFrame on a WindowLayer portal overlay. There is no modal backdrop.
 * The dialog content div (`data-testid="task-detail-dialog"`) is always
 * `flex h-full w-full flex-col` regardless of maximized state; sizing is expressed
 * on the FRAME (`data-testid="window-frame-<id>"`) via inline absolute positioning
 * and corner-radius classes: `rounded-lg` = floating/restored, `rounded-none` =
 * maximized (or tiled). The overlay itself is always `top-10 bottom-9` (constrained
 * to the space between the title bar and status bar) - the frame fills it when maximized.
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

const PROJECT_ID = 'proj-maximize';
const TASK_ID = 'task-maximize';
const SESSION_ID = 'sess-maximize';

// A second task in To Do opens in edit mode by default (no session context).
const EDIT_TASK_ID = 'task-maximize-edit';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Maximize Test',
      path: '/mock/maximize-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so displayState.kind === 'running' -> dialog opens in
    // non-editing mode (large layout) and the maximize button is rendered.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/maximize-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Maximize Task',
      description: 'Task used for the maximize toggle test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/maximize',
      branch_name: 'feature/maximize',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // A To Do task with no session - opens in edit mode (initialEdit = true
    // is forced by useTaskSessionState when role=todo and no session context).
    state.tasks.push({
      id: '${EDIT_TASK_ID}',
      display_id: 2,
      title: 'Edit Mode Task',
      description: 'Task used to reach edit mode for the maximize guard test',
      swimlane_id: laneIds['To Do'],
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task Detail: maximize / restore', () => {
  test('maximize fills the screen and insets the backdrop; restore returns to windowed size', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Maximize Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The window frame is the direct parent of task-detail-dialog. It carries
    // rounded-lg (floating) or rounded-none (maximized/tiled) so tests can assert
    // the window's maximize state without inspecting pixel geometry.
    const frame = page.locator('[data-testid^="window-frame-"]').filter({
      has: page.locator('[data-testid="task-detail-dialog"]'),
    });

    const maximizeButton = page.locator('[data-testid="task-detail-maximize"]');
    await expect(maximizeButton).toBeVisible();

    // Starts windowed (running session -> floating state): action is "Maximize",
    // frame has rounded corners. The dialog content is always w-full h-full inside
    // the frame - sizing is expressed on the frame, not the content div.
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Maximize -> frame fills the window-overlay area (between title bar and status
    // bar), corners squared so the border meets the overlay edges flush.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('title', /^Restore/);
    await expect(frame).toHaveClass(/rounded-none/);
    await expect(frame).not.toHaveClass(/rounded-lg/);
    // The window overlay is always top-10 bottom-9 (between app chrome) in the
    // window model - that's the boundary the maximized frame fills.
    const overlay = page.locator('[data-testid="window-overlay"]');
    await expect(overlay).toHaveClass(/top-10/);
    await expect(overlay).toHaveClass(/bottom-9/);

    // Restore -> frame back to floating with rounded corners.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Hotkey: Ctrl/Cmd+Shift+M toggles maximize (terminal-safe combo).
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAttribute('title', /^Restore/);
    await expect(frame).toHaveClass(/rounded-none/);
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);

    // Hotkey: Ctrl/Cmd+Shift+W closes the window (terminal-safe combo).
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible();
  });

  test('Ctrl+Shift+B toggles the Browser pane when canShowBrowser is true', async () => {
    // The Code Review task has a running session, no browser.enabled override in
    // projectConfigs (so browserEnabled = undefined !== false = true), and the
    // session display state is 'running'. All three canShowBrowser conditions are met.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Maximize Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The Browser toggle pill is visible (canShowBrowser = true).
    const browserToggle = dialog.locator('[data-testid="browser-toggle"]');
    await expect(browserToggle).toBeVisible();

    // Browser pane is closed initially - the pill shows "Show browser" title
    // (now suffixed with the live hotkey combo).
    await expect(browserToggle).toHaveAttribute('title', /^Show browser/);

    // Ctrl+Shift+B opens the browser pane.
    await page.keyboard.press('Control+Shift+B');
    await expect(browserToggle).toHaveAttribute('title', /^Hide browser/);

    // Ctrl+Shift+B again closes the browser pane.
    await page.keyboard.press('Control+Shift+B');
    await expect(browserToggle).toHaveAttribute('title', /^Show browser/);

    // Close the dialog so subsequent tests start clean.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible();
  });

  // The terminal-aware Escape policy (view mode: Escape over the PTY goes to the
  // agent, Escape with the pointer elsewhere closes the dialog) is covered
  // deterministically in tests/unit/terminal-escape-release.test.ts. Driving the
  // real xterm focus + :hover + propagation from the UI tier is flaky, so it is
  // verified manually instead.

  test('edit mode: maximize button is present and Ctrl+Shift+M toggles the layout', async () => {
    // A To Do task with no session opens in edit mode (initialEdit=true, forced
    // by the component when role='todo' and hasSessionContext=false). Maximize
    // is now available in edit mode (the #184 gate was removed).
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Edit Mode Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // To Do tasks open in edit mode - a title input is visible.
    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

    // The window frame is the direct parent of task-detail-dialog.
    const frame = page.locator('[data-testid^="window-frame-"]').filter({
      has: page.locator('[data-testid="task-detail-dialog"]'),
    });

    // The maximize button is surfaced in the edit header.
    const maximizeButton = page.locator('[data-testid="task-detail-maximize"]');
    await expect(maximizeButton).toBeVisible();
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    // Starts floating: frame has rounded corners.
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Ctrl+Shift+M maximizes: frame fills the overlay area, corners squared.
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAttribute('title', /^Restore/);
    await expect(frame).toHaveClass(/rounded-none/);
    await expect(frame).not.toHaveClass(/rounded-lg/);

    // Restore via the hotkey so the window state does not leak into the next test.
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(frame).toHaveClass(/rounded-lg/);
    await expect(frame).not.toHaveClass(/rounded-none/);

    // Close the window to leave a clean state for the next test.
    // Use the dedicated panel.close hotkey (capture-phase, isFocused-gated) rather
    // than Escape: after Ctrl+Shift+M restore, the keyboard focus on some Linux
    // headless Chromium builds lands on an intermediate element whose Escape
    // handler intercepts before the bubble-phase window listener fires, leaving
    // the dialog stuck open (CI flake). Control+Shift+W is capture-phase and
    // cannot be intercepted. Mirrors the cleanup in the other tests in this file.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('edit mode: discarding unsaved changes confirms, layered over the still-visible dialog', async () => {
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Edit Mode Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Edit Mode Task (changed)');

    // Escape on a dirty edit form shows the discard confirm ON TOP, with the
    // edit dialog still mounted/visible behind it (not replaced).
    await page.keyboard.press('Escape');
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible();
    await expect(dialog).toBeVisible();

    // Keep editing returns to the form with the edit intact.
    await page.locator('button:has-text("Keep editing")').click();
    await expect(confirmHeading).not.toBeVisible();
    await expect(titleInput).toHaveValue('Edit Mode Task (changed)');

    // Discard abandons the edit and closes the dialog (no save).
    await page.keyboard.press('Escape');
    await expect(confirmHeading).toBeVisible();
    await page.locator('button:has-text("Discard")').click();
    await expect(dialog).not.toBeVisible();
  });

  test('New Task create dialog: maximize button and Ctrl+Shift+M toggle the layout', async () => {
    const todoColumn = page.locator('[data-swimlane-name="To Do"]');
    await todoColumn.locator('text=Add task').click();

    // Wait for the dialog to mount.
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.waitFor({ state: 'visible', timeout: 5000 });

    // The content box is the rounded dialog container around the title input.
    const contentBox = titleInput.locator('xpath=ancestor::div[contains(@class,"shadow-2xl")][1]');
    await expect(contentBox).toHaveClass(/w-\[840px\]/);
    await expect(contentBox).toHaveClass(/rounded-lg/);
    const backdropWindowed = await contentBox.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropWindowed).toContain('inset-0');
    expect(backdropWindowed).not.toContain('top-10');

    // The standard-header close button advertises the panel.close hotkey
    // (Escape is the hidden universal closer and is deliberately not shown).
    const closeButton = page.locator('[aria-label="Close dialog"]');
    await expect(closeButton).toHaveAttribute('title', /^Close \(/);

    // Maximize via the header button.
    const maximizeButton = page.locator('[data-testid="dialog-maximize"]');
    await expect(maximizeButton).toBeVisible();
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('title', /^Restore/);
    await expect(contentBox).toHaveClass(/w-full/);
    await expect(contentBox).toHaveClass(/h-full/);
    await expect(contentBox).toHaveClass(/rounded-none/);
    const backdropMaximized = await contentBox.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropMaximized).toContain('top-10');
    expect(backdropMaximized).toContain('bottom-9');

    // Restore via the hotkey so the sentinel-keyed flag does not leak.
    await page.keyboard.press('Control+Shift+M');
    await expect(maximizeButton).toHaveAttribute('title', /^Maximize/);
    await expect(contentBox).toHaveClass(/w-\[840px\]/);

    // Dismiss the dialog.
    await page.keyboard.press('Escape');
    await expect(titleInput).not.toBeVisible();
  });

  test('BaseDialog default props: non-maximize consumer keeps inset-0 and rounded-lg', async () => {
    // The delete-confirm dialog (ConfirmDialog) uses BaseDialog with no
    // backdropPositionClass or contentRadiusClass overrides. This proves the
    // optional maximize props default safely for plain BaseDialog consumers.
    const card = page
      .locator('[data-swimlane-name="To Do"]')
      .locator('text=Edit Mode Task')
      .first();
    await card.click();

    const editDialog = page.locator('[data-testid="task-detail-dialog"]');
    await editDialog.waitFor({ state: 'visible', timeout: 5000 });

    // To Do tasks show a Delete button in the edit footer; it opens ConfirmDialog.
    await page.locator('button:has-text("Delete")').first().click();

    // The confirm dialog heading identifies the plain BaseDialog consumer.
    const heading = page.locator('h3:has-text("Delete task")');
    await heading.waitFor({ state: 'visible', timeout: 5000 });
    const contentBox = heading.locator('xpath=ancestor::div[contains(@class,"shadow-2xl")][1]');
    await expect(contentBox).toHaveClass(/rounded-lg/);
    await expect(contentBox).not.toHaveClass(/rounded-none/);

    const backdropClass = await contentBox.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropClass).toContain('inset-0');
    expect(backdropClass).not.toContain('top-10');

    // Dismiss the confirm dialog, then the edit dialog.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(editDialog).not.toBeVisible();
  });
});
