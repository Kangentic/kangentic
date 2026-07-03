/**
 * UI tests for the description peek in the task detail header.
 *
 * Opens a dialog on a task with an active session and a description, toggles
 * the description strip on/off via the kebab menu item ("Show description" /
 * "Hide description") and the Mod+Shift+K hotkey, and confirms the affordance
 * is absent when the task has no description content or the session is
 * suspended/queued.
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

const PROJECT_ID = 'proj-desc-peek';
const TASK_ID = 'task-desc-peek';
const SESSION_ID = 'sess-desc-peek';
const TASK_DESCRIPTION = 'Implement the OAuth login flow with PKCE';

// Second fixture task: a running session (hasSessionContext === true) but no
// description, attachments, labels, or priority (hasDescriptionContent ===
// false). Proves canShowDescription requires BOTH conditions, not just a
// running session.
const EMPTY_TASK_ID = 'task-desc-peek-empty';
const EMPTY_SESSION_ID = 'sess-desc-peek-empty';

// Third fixture task: hasDescriptionContent is true (non-empty description),
// but the session is SUSPENDED, so displayState.kind === 'suspended'. Proves
// canShowDescription also excludes the suspended state (mirroring
// canShowBrowser), since the suspended body branch renders a resume prompt
// and never consumes descriptionPeekOpen.
const SUSPENDED_TASK_ID = 'task-desc-peek-suspended';
const SUSPENDED_SESSION_ID = 'sess-desc-peek-suspended';

// Fourth fixture task: hasDescriptionContent is true, but the session is
// QUEUED, so displayState.kind === 'queued'. canShowDescription's OTHER
// exclusion clause (`!== 'queued'`) is a separate boolean branch from the
// suspended one above and needs its own coverage - the queued body branch
// renders QueuedPlaceholder and never consumes descriptionPeekOpen either.
const QUEUED_TASK_ID = 'task-desc-peek-queued';
const QUEUED_SESSION_ID = 'sess-desc-peek-queued';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Description Peek Test',
      path: '/mock/desc-peek-test',
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

    // Running session so displayState.kind === 'running' -> hasSessionContext is true.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/desc-peek-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Description Peek Task',
      description: '${TASK_DESCRIPTION}',
      swimlane_id: laneIds['Executing'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/desc-peek',
      branch_name: 'feature/desc-peek',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // Running session so hasSessionContext is true, but no description,
    // attachments, labels, or priority, so hasDescriptionContent is false.
    state.sessions.push({
      id: '${EMPTY_SESSION_ID}',
      taskId: '${EMPTY_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/desc-peek-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${EMPTY_TASK_ID}',
      title: 'No Description Task',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 1,
      agent: 'claude',
      session_id: '${EMPTY_SESSION_ID}',
      worktree_path: '/mock/worktrees/desc-peek-empty',
      branch_name: 'feature/desc-peek-empty',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // Suspended session (user-paused) so hasSessionContext is true
    // (displayState.kind === 'suspended' is not 'none'/'exited'), and the
    // task has a description, so hasDescriptionContent is true too - but
    // the fix must still exclude the suspended kind.
    state.sessions.push({
      id: '${SUSPENDED_SESSION_ID}',
      taskId: '${SUSPENDED_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: null,
      status: 'suspended',
      shell: 'bash',
      cwd: '/mock/desc-peek-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${SUSPENDED_TASK_ID}',
      title: 'Suspended Description Task',
      description: 'A description that should stay hidden while suspended',
      swimlane_id: laneIds['Executing'],
      position: 2,
      agent: 'claude',
      session_id: '${SUSPENDED_SESSION_ID}',
      worktree_path: '/mock/worktrees/desc-peek-suspended',
      branch_name: 'feature/desc-peek-suspended',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // Queued session (waiting for a concurrency slot) so hasSessionContext is
    // true and the task has a description, but canShowDescription must still
    // exclude the queued kind (a separate boolean clause from suspended).
    state.sessions.push({
      id: '${QUEUED_SESSION_ID}',
      taskId: '${QUEUED_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: null,
      status: 'queued',
      shell: 'bash',
      cwd: '/mock/desc-peek-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${QUEUED_TASK_ID}',
      title: 'Queued Description Task',
      description: 'A description that should stay hidden while queued',
      swimlane_id: laneIds['Executing'],
      position: 3,
      agent: 'claude',
      session_id: '${QUEUED_SESSION_ID}',
      worktree_path: '/mock/worktrees/desc-peek-queued',
      branch_name: 'feature/desc-peek-queued',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
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
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task Detail description peek', () => {
  test('kebab menu item toggles description strip', async () => {
    // Open the task detail dialog fresh for this test (cross-test state isolation)
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Description not visible initially
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible();

    // Open kebab and click "Show description"
    await dialog.locator('[title="Actions"]').click();
    await page.locator('text=Show description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // Open kebab again -> item now reads "Hide description"
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Hide description')).toBeVisible({ timeout: 5000 });
    await page.locator('text=Hide description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('kebab item is absent when there is no description content', async () => {
    // Open the task detail dialog for the task with a running session but no
    // description, attachments, labels, or priority (canShowDescription is
    // hasSessionContext && hasDescriptionContent - this task satisfies only
    // the first half).
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=No Description Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Give the header time to render before asserting a negative (no element
    // ever appears rather than "hasn't appeared yet").
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    // No "Show description" item in the kebab menu.
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Show description')).toHaveCount(0);

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('Mod+Shift+K toggles the description strip', async () => {
    // Open the task detail dialog fresh for this test (cross-test state
    // isolation) on the task that has description content.
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Description not visible initially
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible();

    // Newly opened windows are focused, so the keybinding fires without an
    // explicit focus step (mirrors browser-empty-state.spec.ts's Mod+Shift+B
    // pattern). The suite runs headless Chromium on Linux CI + Windows local,
    // so Control+Shift+K is the correct (non-mac) combo for taskDetail.toggleDescription.
    await page.keyboard.press('Control+Shift+K');
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // Press again -> toggles hidden.
    await page.keyboard.press('Control+Shift+K');
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('kebab item is absent when the session is suspended', async () => {
    // Open the task detail dialog for the task with a non-empty description
    // (hasDescriptionContent is true) but a SUSPENDED session (displayState.kind
    // === 'suspended'). canShowDescription must exclude the suspended state
    // even though the task has content to peek at.
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Suspended Description Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Give the header time to render before asserting a negative (no element
    // ever appears rather than "hasn't appeared yet").
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    // No "Show description" item in the kebab menu, despite the task having a description.
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Show description')).toHaveCount(0);

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('kebab item is absent when the session is queued', async () => {
    // Open the task detail dialog for the task with a non-empty description
    // (hasDescriptionContent is true) but a QUEUED session (displayState.kind
    // === 'queued'). canShowDescription has two separate exclusion clauses
    // (`!== 'queued'` and `!== 'suspended'`) - the suspended clause is covered
    // above, this covers the queued clause, which the queued body branch
    // (QueuedPlaceholder) never consumes either.
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Queued Description Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Give the header time to render before asserting a negative (no element
    // ever appears rather than "hasn't appeared yet").
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    // No "Show description" item in the kebab menu, despite the task having a description.
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Show description')).toHaveCount(0);

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('toggling the peek does not remount the terminal', async () => {
    // Load-bearing acceptance criterion for this feature: the description
    // strip must reveal/hide ABOVE the terminal without tearing the terminal
    // down. TaskDetailBody renders `{descriptionBar}` as a sibling BEFORE the
    // `<TerminalTab key={sessionId}>` container (not a wrapper around it), so
    // toggling descriptionPeekOpen must never change the terminal's position
    // or key in the tree. Proven here via DOM node identity: a custom probe
    // attribute stamped on the live xterm textarea survives the toggle only
    // if React reused the same node (no unmount/remount of TerminalTab).
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Lift the LaunchOverlay so xterm actually calls terminal.open() and
    // .xterm-helper-textarea attaches (mirrors task-detail-maximize.spec.ts's
    // maximize-focus-restore test, the established pattern for this mock).
    await page.evaluate((sessionId) => {
      const stores = (window as unknown as {
        __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
      }).__zustandStores;
      stores?.session?.getState().markFirstOutput(sessionId);
    }, SESSION_ID);

    const xtermTextarea = dialog.locator('.xterm-helper-textarea').first();
    await xtermTextarea.waitFor({ state: 'attached', timeout: 8000 });

    const PROBE_VALUE = 'peek-toggle-stability-probe';
    await xtermTextarea.evaluate(
      (el, probeValue) => el.setAttribute('data-remount-probe', probeValue),
      PROBE_VALUE,
    );
    const probedTextarea = dialog.locator(`.xterm-helper-textarea[data-remount-probe="${PROBE_VALUE}"]`);

    // Open the peek via the kebab menu item - description appears, probed
    // node must still be the same one.
    await dialog.locator('[title="Actions"]').click();
    await page.locator('text=Show description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });
    await expect(probedTextarea).toHaveCount(1);

    // Close the peek via the kebab menu item - description hides, probed node still unchanged.
    await dialog.locator('[title="Actions"]').click();
    await page.locator('text=Hide description').click();
    await expect(dialog.locator(`text=${TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });
    await expect(probedTextarea).toHaveCount(1);

    // Close the dialog
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
