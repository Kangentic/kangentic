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

// Fifth fixture task: NO session and NO spawn progress at all (displayState.kind
// === 'none'), but a non-empty description (hasDescriptionContent is true).
// hasSessionContext is false here, so canShowDescription is false (no kebab
// toggle) - but TaskDetailBody's own descriptionBar condition
// (`!hasSessionContext || descriptionPeekOpen`) is independently satisfied
// whenever there is no session at all, and renders the description bar
// UNCAPPED (no ' max-h-[25vh] overflow-y-auto' suffix). Contrasts the capped
// in-session peek strip covered by the running fixture above.
const NO_SESSION_TASK_ID = 'task-desc-peek-no-session';
const NO_SESSION_TASK_DESCRIPTION = 'A description that renders uncapped because there is no session at all';

// Sixth fixture task: a running session (hasSessionContext === true) and a
// non-zero priority, but an EMPTY description and no attachments.
// taskHasDescriptionContent is task.description || attachments>0 ||
// priority>0 || labels>0 - this task satisfies ONLY the priority disjunct,
// proving canShowDescription's affordance is gated on the full OR, not on
// task.description alone.
const PRIORITY_TASK_ID = 'task-desc-peek-priority';
const PRIORITY_SESSION_ID = 'sess-desc-peek-priority';

// Seventh fixture task: NO session record exists for this task at fixture
// time. The corresponding test drives it into displayState.kind ===
// 'preparing' at runtime by injecting a spawnProgress label directly into
// the session store (getTaskProgress's `spawnProgressLabel && !session`
// branch) - mirrors task-detail-prespawn-layout.spec.ts and
// spawn-progress-clear-on-todo-move.spec.ts. A description is set here so
// hasDescriptionContent is true once 'preparing' is reached.
const PREPARING_TASK_ID = 'task-desc-peek-preparing';
const PREPARING_TASK_DESCRIPTION = 'Streaming OAuth token refresh telemetry to the dashboard';

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

    // No session, no spawn progress -> displayState.kind === 'none'.
    state.tasks.push({
      id: '${NO_SESSION_TASK_ID}',
      title: 'No Session Description Task',
      description: '${NO_SESSION_TASK_DESCRIPTION}',
      swimlane_id: laneIds['Executing'],
      position: 4,
      agent: 'claude',
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // Running session (hasSessionContext true), empty description, priority > 0.
    state.sessions.push({
      id: '${PRIORITY_SESSION_ID}',
      taskId: '${PRIORITY_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9997,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/desc-peek-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${PRIORITY_TASK_ID}',
      title: 'Priority Only Task',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 5,
      agent: 'claude',
      session_id: '${PRIORITY_SESSION_ID}',
      worktree_path: '/mock/worktrees/desc-peek-priority',
      branch_name: 'feature/desc-peek-priority',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      priority: 3,
      labels: [],
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // No session record at fixture time - the test injects spawnProgress at
    // runtime to reach displayState.kind === 'preparing'.
    state.tasks.push({
      id: '${PREPARING_TASK_ID}',
      title: 'Preparing Description Task',
      description: '${PREPARING_TASK_DESCRIPTION}',
      swimlane_id: laneIds['Executing'],
      position: 6,
      agent: 'claude',
      session_id: null,
      worktree_path: null,
      branch_name: null,
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

  test('preparing state peek is available and toggles the strip', async () => {
    // Drive the task into displayState.kind === 'preparing' by injecting a
    // spawnProgress label directly into the session store. spawnProgress is
    // normally pushed by the main process via tasks.onSpawnProgress (which
    // the mock exposes as window.__mockFireSpawnProgress), but setting the
    // store directly is the established, faster pattern used by
    // task-detail-prespawn-layout.spec.ts and
    // spawn-progress-clear-on-todo-move.spec.ts. This task has NO session
    // record at all (getTaskProgress's `spawnProgressLabel && !session`
    // branch), which is what distinguishes 'preparing' from 'running'.
    await page.evaluate((taskId) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session?: { getState: () => { setSpawnProgress: (id: string, label: string | null) => void } };
        };
      }).__zustandStores;
      if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
      stores.session.getState().setSpawnProgress(taskId, 'Creating worktree...');
    }, PREPARING_TASK_ID);

    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Preparing Description Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The pre-session launch spinner is showing (no active terminal yet).
    // Scoped to the LaunchOverlay's own wrapper because the header ALSO
    // renders an `.animate-spin` lifecycle icon while isSessionActive is
    // true (preparing counts as active) - a bare `.animate-spin` locator
    // would be ambiguous (strict-mode violation).
    const overlaySpinner = dialog.locator('div.flex-1.min-h-0.relative .animate-spin');
    await expect(overlaySpinner).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('text=Creating worktree...')).toBeVisible();

    // Description not visible initially - the strip is gated on descriptionPeekOpen.
    await expect(dialog.locator(`text=${PREPARING_TASK_DESCRIPTION}`)).not.toBeVisible();

    // "Show description" IS present in the kebab even though there is no
    // session yet - this is the base hasSessionContext gate (kind is not
    // 'none'/'exited'), which INCLUDES 'preparing'. A regression that gated
    // canShowDescription on a live session?.id (like canShowBrowser does)
    // would hide this item and fail this assertion.
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Show description')).toBeVisible({ timeout: 5000 });
    await page.locator('text=Show description').click();
    await expect(dialog.locator(`text=${PREPARING_TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // The description strip reveals ABOVE the launch overlay: TaskDetailBody's
    // 'preparing' branch renders `{descriptionBar}` as a sibling immediately
    // BEFORE the `<div className="flex-1 min-h-0 relative">` wrapper around
    // LaunchOverlay. This adjacency selector (mirrors the
    // `div.flex-1 + [data-testid="prespawn-context-bar"]` pattern in
    // task-detail-prespawn-layout.spec.ts) only matches when the description
    // bar immediately precedes the overlay wrapper in the DOM.
    const descriptionBeforeOverlay = dialog.locator(
      'div.px-4.py-3.border-b.border-edge.flex-shrink-0.space-y-2 + div.flex-1.min-h-0.relative',
    );
    await expect(descriptionBeforeOverlay).toBeVisible();

    // The overlay is still showing - a preparing session never grew a terminal.
    await expect(overlaySpinner).toBeVisible();

    // Toggle back off via the kebab.
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Hide description')).toBeVisible({ timeout: 5000 });
    await page.locator('text=Hide description').click();
    await expect(dialog.locator(`text=${PREPARING_TASK_DESCRIPTION}`)).not.toBeVisible({ timeout: 8000 });

    // Close the dialog. No terminal is mounted in the 'preparing' branch (only
    // LaunchOverlay), so a plain Escape is safe here (mirrors
    // task-detail-prespawn-layout.spec.ts) - unlike the running-session tests
    // above, which use Control+Shift+W because their xterm would otherwise
    // capture the Escape keydown (anti-pattern 10).
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // Split into two tests (rather than one test covering both fixtures) so
  // each stays well inside the UI project's 15s per-test timeout - opening
  // and closing two separate dialogs back-to-back in a single test pushed it
  // right up against the budget.
  test('description peek strip has a height cap during an active session', async () => {
    // Open the RUNNING fixture task and reveal the peek via the kebab.
    const runningCard = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Description Peek Task')
      .first();
    await runningCard.click();

    const runningDialog = page.locator('[data-testid="task-detail-dialog"]');
    await runningDialog.waitFor({ state: 'visible', timeout: 5000 });

    await runningDialog.locator('[title="Actions"]').click();
    await page.locator('text=Show description').click();
    await expect(runningDialog.locator(`text=${TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    // The peek strip's container carries the height cap ONLY when
    // hasSessionContext is true (an active session): TaskDetailBody appends
    // ' max-h-[25vh] overflow-y-auto' to the container className in that
    // case. This is what keeps a long description from pushing the terminal
    // off-screen while a session is live.
    const runningDescriptionContainer = runningDialog.locator(
      'div.px-4.py-3.border-b.border-edge.flex-shrink-0.space-y-2',
    );
    const runningClassName = await runningDescriptionContainer.getAttribute('class');
    expect(runningClassName).toContain('max-h-[25vh]');
    expect(runningClassName).toContain('overflow-y-auto');

    // Close the running-session dialog via Control+Shift+W - it has an active
    // xterm terminal, so a plain Escape would be captured by the terminal
    // instead of the dialog (anti-pattern 10).
    await page.keyboard.press('Control+Shift+W');
    await expect(runningDialog).not.toBeVisible({ timeout: 8000 });
  });

  test('description-only view has no height cap when there is no session at all', async () => {
    // Open the NO-SESSION fixture task: hasSessionContext is false (no
    // session, no spawnProgress -> displayState.kind === 'none'), so
    // TaskDetailBody's final fallback branch renders descriptionBar
    // unconditionally and WITHOUT the session-only height-cap suffix. This
    // is the contrast case for the capped in-session strip covered by the
    // sibling test above.
    //
    // Opened via the session store's setDetailTaskId (not a card click):
    // TaskCard.tsx's onClick sets `initialEdit: displayState.kind === 'none'`,
    // so clicking this card would land in the edit form instead of the view
    // body we need to assert on. Driving the store directly (mirrors the
    // Zustand-store-drive pattern used for E2E dialogs with competing
    // overlays) opens straight into view mode with initialEdit: false.
    await page.evaluate((taskId) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session?: { getState: () => { setDetailTaskId: (id: string | null) => void } };
        };
      }).__zustandStores;
      if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
      stores.session.getState().setDetailTaskId(taskId);
    }, NO_SESSION_TASK_ID);

    const noSessionDialog = page.locator('[data-testid="task-detail-dialog"]');
    await noSessionDialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(noSessionDialog.locator(`text=${NO_SESSION_TASK_DESCRIPTION}`)).toBeVisible({ timeout: 8000 });

    const noSessionDescriptionContainer = noSessionDialog.locator(
      'div.px-4.py-3.border-b.border-edge.flex-shrink-0.space-y-2',
    );
    const noSessionClassName = await noSessionDescriptionContainer.getAttribute('class');
    expect(noSessionClassName).not.toContain('max-h-[25vh]');
    expect(noSessionClassName).not.toContain('overflow-y-auto');

    // Close the dialog. No terminal is mounted here either (no session at
    // all), so a plain Escape is safe (mirrors task-detail-prespawn-layout.spec.ts).
    await page.keyboard.press('Escape');
    await expect(noSessionDialog).not.toBeVisible({ timeout: 8000 });
  });

  test('kebab item appears when hasDescriptionContent is satisfied by priority alone', async () => {
    // This task has a running session (hasSessionContext true) and a
    // non-zero priority, but an EMPTY description and no attachments.
    // taskHasDescriptionContent's OR includes priority > 0, so
    // canShowDescription should still be true - proving the affordance is
    // gated on the full disjunct, not on task.description alone.
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator('text=Priority Only Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });
    await dialog.locator('[title="Actions"]').click();
    await expect(page.locator('text=Show description')).toBeVisible({ timeout: 5000 });

    // Toggle it open: the strip renders the priority badge ("High"), not any
    // description text, since task.description is empty. The task-detail
    // TITLE BAR also always shows a PriorityBadge (unconditionally, not
    // gated on the peek), so a bare `[title="High"]` locator resolves to two
    // elements - scope to the description-peek container specifically (the
    // same container asserted on above) to target only the strip's copy.
    const descriptionContainer = dialog.locator(
      'div.px-4.py-3.border-b.border-edge.flex-shrink-0.space-y-2',
    );
    await page.locator('text=Show description').click();
    await expect(descriptionContainer.locator('[title="High"]')).toBeVisible({ timeout: 8000 });

    // Close the dialog (active session -> Control+Shift+W, not Escape).
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
