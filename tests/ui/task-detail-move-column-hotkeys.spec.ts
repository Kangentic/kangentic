/**
 * UI tests for the taskDetail.moveColumnLeft/Right hotkeys (Alt+Shift+Left /
 * Alt+Shift+Right): step the open task's column one lane left or right while
 * its task-detail window (and terminal) stays open.
 *
 * Patterned on task-detail-description-peek.spec.ts: one shared page across
 * tests, DEFAULT_SWIMLANES, a running session per fixture task so a card
 * click opens the dialog focused in view mode.
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

const PROJECT_ID = 'proj-move-column-hotkeys';

// Fixture 1: Executing lane, running session. Used for the round-trip
// Right/Left case, with the chord pressed while the TERMINAL is focused -
// the red-green case for the xterm-helper-textarea exemption in
// isTextFieldTarget (a verbatim isEditableTarget copy would refuse the press
// entirely, since xterm's helper is a real <textarea>).
const ROUNDTRIP_TASK_ID = 'task-move-column-roundtrip';
const ROUNDTRIP_SESSION_ID = 'sess-move-column-roundtrip';
const ROUNDTRIP_TASK_TITLE = 'Move Column Roundtrip Task';

// Fixture 2: Merge lane (the last non-archived board column on the default
// board - Done is always persisted is_archived: true). Proves the right
// hotkey is a no-op at the right edge (no wraparound into To Do), and that
// the left hotkey still steps normally from there.
const EDGE_TASK_ID = 'task-move-column-edge';
const EDGE_SESSION_ID = 'sess-move-column-edge';
const EDGE_TASK_TITLE = 'Move Column Edge Task';

// Fixture 3: Executing lane, running session, used to prove the hotkey is
// inert while the edit form is open, then fires normally once edit mode is
// left (the positive control for the same fixture).
const EDIT_TASK_ID = 'task-move-column-edit';
const EDIT_SESSION_ID = 'sess-move-column-edit';
const EDIT_TASK_TITLE = 'Move Column Edit Task';

// Fixture 4: Executing lane, running session. Used for the isTextFieldTarget
// REFUSAL branch: a real text field inside the dialog must keep
// Alt+Shift+ArrowRight (the `when` guard denies the match before it reaches
// the handler), and the xterm helper textarea is the positive control that
// proves the chord still fires once focus leaves the field.
const TEXTFIELD_TASK_ID = 'task-move-column-textfield';
const TEXTFIELD_SESSION_ID = 'sess-move-column-textfield';
const TEXTFIELD_TASK_TITLE = 'Move Column Textfield Task';

// Fixture 5: Executing lane, running session. Used for the event.repeat drop:
// a held-key repeat must not fire a move, and an identical non-repeat press is
// the positive control proving the synthetic event actually matches the combo
// (so the repeat check, not some unrelated mismatch, is what dropped the
// first press).
const REPEAT_TASK_ID = 'task-move-column-repeat';
const REPEAT_SESSION_ID = 'sess-move-column-repeat';
const REPEAT_TASK_TITLE = 'Move Column Repeat Task';

// Fixture 6: Executing lane, running session. Used for the keepOpen + failed
// move case: moveTask's IPC rejection must not also report a `Moved "..."`
// success toast underneath the store's own error toast, and the task must
// roll back to its pre-move lane.
const FAILMOVE_TASK_ID = 'task-move-column-failmove';
const FAILMOVE_SESSION_ID = 'sess-move-column-failmove';
const FAILMOVE_TASK_TITLE = 'Move Column Failmove Task';

// Fixture 7: Executing lane, running session. Used for the in-flight guard: a
// second press while a step is still in flight must be dropped, not queued,
// so the task lands exactly one column over rather than two.
const INFLIGHT_TASK_ID = 'task-move-column-inflight';
const INFLIGHT_SESSION_ID = 'sess-move-column-inflight';
const INFLIGHT_TASK_TITLE = 'Move Column Inflight Task';

// Fixture 8: Planning lane (adjacent to To Do), running session, with a
// worktree/branch so a step into To Do triggers the "Reset task?" confirm
// (board-store's moveTask gate: isColumnChange && targetLane.role === 'todo'
// && (worktree_path || branch_name)). Used for the confirm-pending case: the
// window must stay open with no success toast while the confirm is up, and
// Cancel must revert the optimistic move.
const CONFIRM_TASK_ID = 'task-move-column-confirm';
const CONFIRM_SESSION_ID = 'sess-move-column-confirm';
const CONFIRM_TASK_TITLE = 'Move Column Confirm Task';

// Fixture 9: Executing lane, running session. Used for the kebab's "Move to"
// item - the PRE-EXISTING default path (options.keepOpen unset) that this
// diff restructured `handleMoveTo` around. Every other test in this file
// drives the hotkey (keepOpen: true); nothing else in the suite exercises the
// unmodified default: window closes on success, toast still fires.
const KEBAB_TASK_ID = 'task-move-column-kebab';
const KEBAB_SESSION_ID = 'sess-move-column-kebab';
const KEBAB_TASK_TITLE = 'Move Column Kebab Task';

// Fixture 10: archived, in the Done lane. Used for the `!isArchived` half of
// columnStepEnabled: an archived task has no board card, so its window is
// only reachable via setDetailTaskId (mirrors
// tests/ui/task-detail-update-from-base.spec.ts's openDetailWindow).
const ARCHIVED_TASK_ID = 'task-move-column-archived';
const ARCHIVED_SESSION_ID = 'sess-move-column-archived';
const ARCHIVED_TASK_TITLE = 'Move Column Archived Task';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Move Column Hotkeys Test',
      path: '/mock/move-column-hotkeys-test',
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

    state.sessions.push({
      id: '${ROUNDTRIP_SESSION_ID}',
      taskId: '${ROUNDTRIP_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9001,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${ROUNDTRIP_TASK_ID}',
      title: '${ROUNDTRIP_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 0,
      agent: 'claude',
      session_id: '${ROUNDTRIP_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-roundtrip',
      branch_name: 'feature/move-column-roundtrip',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${EDGE_SESSION_ID}',
      taskId: '${EDGE_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9002,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${EDGE_TASK_ID}',
      title: '${EDGE_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Merge'],
      position: 0,
      agent: 'claude',
      session_id: '${EDGE_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-edge',
      branch_name: 'feature/move-column-edge',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${EDIT_SESSION_ID}',
      taskId: '${EDIT_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9003,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${EDIT_TASK_ID}',
      title: '${EDIT_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 1,
      agent: 'claude',
      session_id: '${EDIT_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-edit',
      branch_name: 'feature/move-column-edit',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${TEXTFIELD_SESSION_ID}',
      taskId: '${TEXTFIELD_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9004,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${TEXTFIELD_TASK_ID}',
      title: '${TEXTFIELD_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 2,
      agent: 'claude',
      session_id: '${TEXTFIELD_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-textfield',
      branch_name: 'feature/move-column-textfield',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${REPEAT_SESSION_ID}',
      taskId: '${REPEAT_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9005,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${REPEAT_TASK_ID}',
      title: '${REPEAT_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 3,
      agent: 'claude',
      session_id: '${REPEAT_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-repeat',
      branch_name: 'feature/move-column-repeat',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${FAILMOVE_SESSION_ID}',
      taskId: '${FAILMOVE_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9006,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${FAILMOVE_TASK_ID}',
      title: '${FAILMOVE_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 4,
      agent: 'claude',
      session_id: '${FAILMOVE_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-failmove',
      branch_name: 'feature/move-column-failmove',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${INFLIGHT_SESSION_ID}',
      taskId: '${INFLIGHT_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9007,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${INFLIGHT_TASK_ID}',
      title: '${INFLIGHT_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 5,
      agent: 'claude',
      session_id: '${INFLIGHT_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-inflight',
      branch_name: 'feature/move-column-inflight',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${CONFIRM_SESSION_ID}',
      taskId: '${CONFIRM_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9008,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${CONFIRM_TASK_ID}',
      title: '${CONFIRM_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Planning'],
      position: 0,
      agent: 'claude',
      session_id: '${CONFIRM_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-confirm',
      branch_name: 'feature/move-column-confirm',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${KEBAB_SESSION_ID}',
      taskId: '${KEBAB_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9009,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${KEBAB_TASK_ID}',
      title: '${KEBAB_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Executing'],
      position: 6,
      agent: 'claude',
      session_id: '${KEBAB_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-kebab',
      branch_name: 'feature/move-column-kebab',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    state.sessions.push({
      id: '${ARCHIVED_SESSION_ID}',
      taskId: '${ARCHIVED_TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9010,
      status: 'suspended',
      shell: 'bash',
      cwd: '/mock/move-column-hotkeys-test',
      startedAt: ts,
      exitCode: null,
    });
    state.archivedTasks.push({
      id: '${ARCHIVED_TASK_ID}',
      title: '${ARCHIVED_TASK_TITLE}',
      description: '',
      swimlane_id: laneIds['Done'],
      position: 0,
      agent: 'claude',
      session_id: '${ARCHIVED_SESSION_ID}',
      worktree_path: '/mock/worktrees/move-column-archived',
      branch_name: 'feature/move-column-archived',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: ts,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

/** Read a task's current swimlane_id from the live board store. */
function readSwimlaneId(currentPage: Page, taskId: string): Promise<string | undefined> {
  return currentPage.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { board?: { getState: () => { tasks: Array<{ id: string; swimlane_id: string }> } } };
    }).__zustandStores;
    return stores?.board?.getState().tasks.find((task) => task.id === id)?.swimlane_id;
  }, taskId);
}

/** Reset the mock's move-call log, so a later count reads only what follows. */
function resetMoveCount(currentPage: Page): Promise<void> {
  return currentPage.evaluate(() => { (window as unknown as Record<string, unknown>).__mockMoveProjectIds = []; });
}

/** How many move IPC calls the mock has seen since the last reset. */
function readMoveCount(currentPage: Page): Promise<number> {
  return currentPage.evaluate(
    () => ((window as unknown as Record<string, unknown>).__mockMoveProjectIds as unknown[] | undefined)?.length ?? 0,
  );
}

/** How many tasks.unarchive IPC calls the mock has seen in total (no reset
 *  hook - callers diff against a captured baseline, as the counter is
 *  cumulative for the page's whole lifetime). */
function readUnarchiveCount(currentPage: Page): Promise<number> {
  return currentPage.evaluate(
    () => ((window as unknown as Record<string, unknown>).__mockUnarchiveCallIds as unknown[] | undefined)?.length ?? 0,
  );
}

/** Open a task-detail window by driving the store directly - the only way to
 *  reach an archived task's window, since it has no board card (mirrors
 *  task-detail-update-from-base.spec.ts's openDetailWindow). */
async function openArchivedDetailWindow(currentPage: Page, taskId: string): Promise<void> {
  await currentPage.evaluate((detailTaskId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { setDetailTaskId: (id: string) => void } } };
    }).__zustandStores;
    stores?.session?.getState().setDetailTaskId(detailTaskId);
  }, taskId);
}

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task Detail move-column hotkeys', () => {
  test('Alt+Shift+Right/Left step the task while the terminal is focused, keeping the window open', async () => {
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator(`text=${ROUNDTRIP_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Lift the LaunchOverlay so xterm actually calls terminal.open() and
    // .xterm-helper-textarea attaches (established pattern - see
    // task-detail-description-peek.spec.ts's remount-stability test), then
    // focus it: pressing the chord with the terminal focused is what proves
    // the xterm-helper-textarea exemption actually works, rather than merely
    // proving the hotkey fires when focus sits elsewhere.
    await page.evaluate((sessionId) => {
      const stores = (window as unknown as {
        __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
      }).__zustandStores;
      stores?.session?.getState().markFirstOutput(sessionId);
    }, ROUNDTRIP_SESSION_ID);

    const xtermTextarea = dialog.locator('.xterm-helper-textarea').first();
    await xtermTextarea.waitFor({ state: 'attached', timeout: 8000 });
    await xtermTextarea.focus();

    await page.keyboard.press('Alt+Shift+ArrowRight');

    await expect.poll(
      () => readSwimlaneId(page, ROUNDTRIP_TASK_ID),
      { timeout: 8000 },
    ).toBe('lane-code-review');

    // The window stayed open with the same task, and the card followed to
    // its new column.
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="task-title-text"]')).toHaveText(ROUNDTRIP_TASK_TITLE);
    await expect(
      page.locator('[data-swimlane-name="Code Review"]').locator(`text=${ROUNDTRIP_TASK_TITLE}`),
    ).toBeVisible();

    const movedToast = page.locator('[data-testid="toast"]')
      .filter({ hasText: `Moved "${ROUNDTRIP_TASK_TITLE}" to Code Review` });
    await expect(movedToast).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Alt+Shift+ArrowLeft');

    await expect.poll(
      () => readSwimlaneId(page, ROUNDTRIP_TASK_ID),
      { timeout: 8000 },
    ).toBe('lane-executing');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="task-title-text"]')).toHaveText(ROUNDTRIP_TASK_TITLE);

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('Alt+Shift+Right is a no-op at the last board column; Alt+Shift+Left still steps', async () => {
    const card = page
      .locator('[data-swimlane-name="Merge"]')
      .locator(`text=${EDGE_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    // The dialog opens focused; give it a beat before asserting a negative
    // rather than racing the mount.
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    await resetMoveCount(page);

    await page.keyboard.press('Alt+Shift+ArrowRight');

    // adjacentSwimlane returns null synchronously at the edge, so stepColumn
    // never reaches the await - no move IPC call, no lane change, ever.
    expect(await readMoveCount(page)).toBe(0);
    expect(await readSwimlaneId(page, EDGE_TASK_ID)).toBe('lane-merge');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Alt+Shift+ArrowLeft');

    await expect.poll(
      () => readSwimlaneId(page, EDGE_TASK_ID),
      { timeout: 8000 },
    ).toBe('lane-testing');

    // Exactly one move IPC call total: the earlier Right press made none.
    expect(await readMoveCount(page)).toBe(1);

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('the hotkey is inert while the edit form is open, and fires again after Cancel', async () => {
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator(`text=${EDIT_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await dialog.locator('[title="Actions"]').click();
    // Scoped to the portaled kebab menu (role="menu") with an EXACT match: an
    // unscoped/substring "text=Edit" also matches the board's per-column
    // "Edit <column> column" buttons, which sit earlier in the DOM and win
    // .first() - that clicked a column edit control instead of this task's
    // Edit item.
    await page.locator('[role="menu"]').locator('text=Edit', { exact: true }).click();
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible({ timeout: 5000 });

    // Move focus off the terminal (and off any form field) without touching
    // an interactive control, so only the `!isEditing` gate is under test.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await resetMoveCount(page);
    await page.keyboard.press('Alt+Shift+ArrowRight');

    // The edit form is still up (no move fired: useKeybinding's `enabled` was
    // false, so the listener was never even attached).
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
    expect(await readMoveCount(page)).toBe(0);
    expect(await readSwimlaneId(page, EDIT_TASK_ID)).toBe('lane-executing');

    // Positive control: leave edit mode, then the same chord moves the task.
    await dialog.locator('button', { hasText: 'Cancel' }).click();
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).not.toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Alt+Shift+ArrowRight');

    await expect.poll(
      () => readSwimlaneId(page, EDIT_TASK_ID),
      { timeout: 8000 },
    ).toBe('lane-code-review');

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('a real text field inside the dialog keeps the chord; blurring it lets the chord fire', async () => {
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator(`text=${TEXTFIELD_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    // isTextFieldTarget is DOM-generic (tagName / isContentEditable), so an
    // injected plain <input> is a valid probe for the `when` guard: view mode
    // has no reachable EDITABLE text field of its own (the description peek
    // renders read-only text, and the edit form is a different code path,
    // gated on !isEditing rather than isTextFieldTarget - see the sibling
    // "inert while editing" test above).
    await dialog.evaluate((dialogEl) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('data-testid', 'move-column-probe-input');
      dialogEl.appendChild(input);
    });
    const probeInput = dialog.locator('[data-testid="move-column-probe-input"]');
    await probeInput.focus();

    await resetMoveCount(page);
    await page.keyboard.press('Alt+Shift+ArrowRight');

    // The field kept the key: `when` denied the match, so stepColumn never ran.
    expect(await readMoveCount(page)).toBe(0);
    expect(await readSwimlaneId(page, TEXTFIELD_TASK_ID)).toBe('lane-executing');
    await expect(dialog).toBeVisible();

    // A contenteditable surface (a rich-text note/description editor) is a
    // SEPARATE branch in isTextFieldTarget (target.isContentEditable, its own
    // early return) from the tagName OR-chain the <input> probe above already
    // proves - a plain <div> would not match that OR-chain at all, so without
    // this branch a contenteditable field would lose its selection to the
    // hotkey exactly like the <input> case above.
    await dialog.evaluate((dialogEl) => {
      const editable = document.createElement('div');
      editable.contentEditable = 'true';
      editable.setAttribute('data-testid', 'move-column-probe-contenteditable');
      dialogEl.appendChild(editable);
    });
    const probeContentEditable = dialog.locator('[data-testid="move-column-probe-contenteditable"]');
    await probeContentEditable.focus();

    await resetMoveCount(page);
    await page.keyboard.press('Alt+Shift+ArrowRight');

    expect(await readMoveCount(page)).toBe(0);
    expect(await readSwimlaneId(page, TEXTFIELD_TASK_ID)).toBe('lane-executing');
    await expect(dialog).toBeVisible();

    // Positive control: move focus to the one exempt text field (xterm's
    // helper textarea - a real <textarea>, proving the exemption is keyed on
    // the class, not on "not a text field"), then the identical chord fires.
    await page.evaluate((sessionId) => {
      const stores = (window as unknown as {
        __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
      }).__zustandStores;
      stores?.session?.getState().markFirstOutput(sessionId);
    }, TEXTFIELD_SESSION_ID);

    const xtermTextarea = dialog.locator('.xterm-helper-textarea').first();
    await xtermTextarea.waitFor({ state: 'attached', timeout: 8000 });
    await xtermTextarea.focus();

    await page.keyboard.press('Alt+Shift+ArrowRight');

    await expect.poll(
      () => readSwimlaneId(page, TEXTFIELD_TASK_ID),
      { timeout: 8000 },
    ).toBe('lane-code-review');

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('a held-key repeat does not fire a move; a fresh press of the same combo does', async () => {
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator(`text=${REPEAT_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    await resetMoveCount(page);

    // useKeybinding listens on `window` (the default target) for
    // taskDetail.moveColumnRight, so a window-dispatched synthetic keydown
    // reaches its capture-phase listener directly: the event's target IS
    // window, so capture vs. bubble is moot. matchesCombo reads
    // key/altKey/shiftKey/ctrlKey/metaKey only - it has no opinion on
    // `repeat` - so this event matches the combo and reaches stepColumn,
    // which is where the repeat check actually lives (useTaskActions.ts
    // comment: "checked in the HANDLER, not `when`").
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', code: 'ArrowRight', altKey: true, shiftKey: true,
        repeat: true, bubbles: true, cancelable: true,
      }));
    });

    expect(await readMoveCount(page)).toBe(0);
    expect(await readSwimlaneId(page, REPEAT_TASK_ID)).toBe('lane-executing');
    await expect(dialog).toBeVisible();

    // Positive control: the identical combo with repeat: false proves both
    // that the synthetic event genuinely matches the registered combo, and
    // that the repeat check (not some unrelated gate) was what dropped the
    // first press.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', code: 'ArrowRight', altKey: true, shiftKey: true,
        repeat: false, bubbles: true, cancelable: true,
      }));
    });

    await expect.poll(
      () => readSwimlaneId(page, REPEAT_TASK_ID),
      { timeout: 8000 },
    ).toBe('lane-code-review');
    expect(await readMoveCount(page)).toBe(1);

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('keepOpen suppresses the success toast when the move fails, and the task rolls back', async () => {
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator(`text=${FAILMOVE_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    const errorMessage = 'boom: simulated spawn failure';
    await page.evaluate((msg) => {
      (window as unknown as { __mockTaskMoveThrow?: string }).__mockTaskMoveThrow = msg;
    }, errorMessage);

    await page.keyboard.press('Alt+Shift+ArrowRight');

    // The store's own error toast (moveTask's catch block) is added strictly
    // BEFORE moveTask returns { ok: false } to handleMoveTo, and handleMoveTo
    // returns immediately on `!result.ok` with no toast of its own - the two
    // are sequential in the same await chain, so there is no race to poll for
    // the negative half of this assertion.
    await expect(
      page.locator('[data-testid="toast"]').filter({ hasText: `Failed to move task: ${errorMessage}` }),
    ).toBeVisible({ timeout: 5000 });
    // An immediate, non-retrying count check, not `await expect(...).toHaveCount(0)`:
    // toasts auto-dismiss after notifications.toasts.durationSeconds (default 4s -
    // see src/shared/types.ts), and toHaveCount's default 5s retry window is long
    // enough that a genuinely-added "Moved" toast would auto-dismiss DURING the
    // retry and the assertion would pass anyway, masking the very regression this
    // test exists to catch. The decision not to add it is made synchronously by
    // the time the error toast above is visible (see comment above), so a single
    // immediate read is the correct - and only non-racy - way to assert absence.
    expect(
      await page.locator('[data-testid="toast"]').filter({ hasText: `Moved "${FAILMOVE_TASK_TITLE}"` }).count(),
    ).toBe(0);

    // The window stayed open on the same task, and the rollback (loadBoard()
    // in moveTask's catch) restores the pre-move lane.
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="task-title-text"]')).toHaveText(FAILMOVE_TASK_TITLE);
    await expect.poll(
      () => readSwimlaneId(page, FAILMOVE_TASK_ID),
      { timeout: 5000 },
    ).toBe('lane-executing');

    await page.evaluate(() => {
      (window as unknown as { __mockTaskMoveThrow?: string | null }).__mockTaskMoveThrow = null;
    });

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('a second press while a step is in flight is dropped, not queued', async () => {
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator(`text=${INFLIGHT_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    await resetMoveCount(page);
    await page.evaluate(() => {
      (window as unknown as { __mockTaskMoveDeferred?: boolean }).__mockTaskMoveDeferred = true;
    });

    await page.keyboard.press('Alt+Shift+ArrowRight');

    // The mock's tasks.move records the call before awaiting the deferred
    // promise, so one recorded call is the signal that the first press
    // reached the IPC and is now suspended mid-flight.
    await expect.poll(() => readMoveCount(page), { timeout: 5000 }).toBe(1);

    // Second press while columnStepInFlightRef is still set: dropped before
    // it ever reaches handleMoveTo, so no second IPC call.
    await page.keyboard.press('Alt+Shift+ArrowRight');
    expect(await readMoveCount(page)).toBe(1);

    // Release the first (and only) move.
    await page.evaluate(() => {
      (window as unknown as { __mockTaskMoveResolve?: () => void }).__mockTaskMoveResolve?.();
    });

    await expect.poll(
      () => readSwimlaneId(page, INFLIGHT_TASK_ID),
      { timeout: 8000 },
    ).toBe('lane-code-review');
    // Exactly one move landed - the task stepped ONE column, not two.
    expect(await readMoveCount(page)).toBe(1);

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('stepping into a confirm-gated column keeps the window open with no success toast', async () => {
    const card = page
      .locator('[data-swimlane-name="Planning"]')
      .locator(`text=${CONFIRM_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[title="Actions"]')).toBeVisible({ timeout: 8000 });

    await page.evaluate(() => {
      (window as unknown as { __mockPendingChangesResult?: unknown }).__mockPendingChangesResult = {
        hasPendingChanges: true, uncommittedFileCount: 2, unpushedCommitCount: 1, currentBranch: null,
      };
    });
    await resetMoveCount(page);

    await page.keyboard.press('Alt+Shift+ArrowLeft');

    const confirmDialog = page.locator('text=Reset task?');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    // Deferred to the confirm dialog: no IPC call, no success toast, the
    // task-detail window stays open on the same task. An immediate,
    // non-retrying count check (see the failed-move test above for why
    // `await expect(...).toHaveCount(0)` is the wrong tool here: a toast that
    // auto-dismisses after notifications.toasts.durationSeconds would defeat
    // toHaveCount's own retry window and mask a real regression).
    expect(await readMoveCount(page)).toBe(0);
    expect(
      await page.locator('[data-testid="toast"]').filter({ hasText: `Moved "${CONFIRM_TASK_TITLE}"` }).count(),
    ).toBe(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="task-title-text"]')).toHaveText(CONFIRM_TASK_TITLE);

    await page.locator('button:has-text("Keep Working")').click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });

    // Cancel reverts the optimistic move (cancelPendingMove's loadBoard());
    // the task is back in Planning and the window is still open on it.
    await expect.poll(
      () => readSwimlaneId(page, CONFIRM_TASK_ID),
      { timeout: 5000 },
    ).toBe('lane-planning');
    await expect(dialog).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __mockPendingChangesResult?: unknown }).__mockPendingChangesResult = null;
    });

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test("the kebab's Move to (keepOpen unset) still closes the window and shows the toast", async () => {
    // This diff restructured handleMoveTo around a keepOpen branch, but every
    // other test in this file drives the hotkey path (keepOpen: true). This
    // is the only coverage of the PRE-EXISTING default the kebab's "Move to"
    // still calls: the else branch (input.onClose()) and the unconditional
    // toast underneath it.
    const card = page
      .locator('[data-swimlane-name="Executing"]')
      .locator(`text=${KEBAB_TASK_TITLE}`)
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.locator('[title="Actions"]').click();

    const menu = page.locator('[role="menu"]');
    const moveToTrigger = menu.locator('button', { hasText: 'Move to' });
    await moveToTrigger.waitFor({ state: 'visible', timeout: 5000 });
    await moveToTrigger.hover();

    const moveTarget = menu.locator('button', { hasText: 'Code Review' });
    await moveTarget.waitFor({ state: 'visible', timeout: 5000 });
    await moveTarget.click();

    // Unlike every hotkey-driven test above, the window closes on success
    // here - options.keepOpen is unset, so handleMoveTo takes the `else`
    // branch (input.onClose()) instead of returning early on `!result.ok`.
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('[data-testid="toast"]').filter({ hasText: `Moved "${KEBAB_TASK_TITLE}" to Code Review` }),
    ).toBeVisible({ timeout: 5000 });
    await expect.poll(
      () => readSwimlaneId(page, KEBAB_TASK_ID),
      { timeout: 5000 },
    ).toBe('lane-code-review');
  });

  test('the hotkey is inert for an archived task, which has no board card and would otherwise close on the archived branch', async () => {
    // columnStepEnabled's `!isArchived` half: without it, the archived branch
    // of handleMoveTo (input.onClose() followed by unarchiveTask) would run
    // on the very first press, closing this window and unarchiving the task -
    // the opposite of what the hotkey is for on a task that is not even on
    // the board.
    await openArchivedDetailWindow(page, ARCHIVED_TASK_ID);

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[data-testid="task-title-text"]')).toHaveText(ARCHIVED_TASK_TITLE);

    await resetMoveCount(page);
    const unarchiveCountBefore = await readUnarchiveCount(page);

    await page.keyboard.press('Alt+Shift+ArrowRight');
    await page.keyboard.press('Alt+Shift+ArrowLeft');

    // columnStepEnabled is false, so useKeybinding never attached a listener
    // for either combo: no move call, no unarchive call, window still open.
    expect(await readMoveCount(page)).toBe(0);
    expect(await readUnarchiveCount(page)).toBe(unarchiveCountBefore);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="task-title-text"]')).toHaveText(ARCHIVED_TASK_TITLE);

    await dialog.locator('[data-testid="task-detail-close"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});
