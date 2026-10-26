/**
 * UI tests for #655: the taskDetail.save hotkey (Ctrl+S) in the task-detail
 * edit form, and the unsaved-edits close prompt's Save choice.
 *
 * Ctrl+S is the edit form's Save button: a To Do task saves and its window
 * closes, a running task saves and returns to its terminal. The close prompt
 * (Escape, the X, Ctrl+Shift+W, click outside) offers Save, Discard and Keep
 * editing, and its Save closes the window even for a running task.
 *
 * Patterned on task-detail-move-column-hotkeys.spec.ts: one shared page,
 * DEFAULT_SWIMLANES, one fixture task per test so no test depends on another's
 * leftovers. To Do tasks have no session and open straight into the edit form;
 * Executing tasks carry a running session and open in view mode.
 */
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { launchPage } from './helpers';
import { launch as launchMonitorSeed, openMonitor, byTestId, sessionIdOf } from './monitor-writes-seed';

const PROJECT_ID = 'proj-save-hotkey';

interface Fixture {
  id: string;
  title: string;
  /** Present for a task with a session (Executing lane); absent for To Do. */
  sessionId?: string;
  /** With `sessionId`, the session is suspended and the task has no worktree yet,
   *  pinned to the project folder, so choosing Worktree in the edit form enables one. */
  paused?: boolean;
}

const TODO_SAVE: Fixture = { id: 'task-save-todo', title: 'Save Hotkey Todo Task' };
const TODO_LABEL: Fixture = { id: 'task-save-label', title: 'Save Hotkey Label Task' };
const TODO_BRANCH: Fixture = { id: 'task-save-branch', title: 'Save Hotkey Branch Task' };
const TODO_PROMPT_ENTER: Fixture = { id: 'task-save-prompt-enter', title: 'Save Hotkey Prompt Enter Task' };
const TODO_PROMPT_DISCARD: Fixture = { id: 'task-save-prompt-discard', title: 'Save Hotkey Prompt Discard Task' };
const TODO_PROMPT_KEEP: Fixture = { id: 'task-save-prompt-keep', title: 'Save Hotkey Prompt Keep Task' };
const TODO_BOARD_MANAGER: Fixture = { id: 'task-save-board-manager', title: 'Save Hotkey Board Manager Task' };
const RUNNING_SAVE: Fixture = { id: 'task-save-running', title: 'Save Hotkey Running Task', sessionId: 'sess-save-running' };
const RUNNING_VIEW: Fixture = { id: 'task-save-view', title: 'Save Hotkey View Mode Task', sessionId: 'sess-save-view' };
const RUNNING_PROMPT: Fixture = { id: 'task-save-running-prompt', title: 'Save Hotkey Running Prompt Task', sessionId: 'sess-save-running-prompt' };

const TODO_INERT_PROMPT: Fixture = { id: 'task-save-inert-prompt', title: 'Save Hotkey Inert Prompt Task' };
const TODO_INERT_DELETE: Fixture = { id: 'task-save-inert-delete', title: 'Save Hotkey Inert Delete Task' };
const TODO_DISCARD_ONLY: Fixture = { id: 'task-save-discard-only', title: 'Save Hotkey Discard Only Task' };
const TODO_REPEAT: Fixture = { id: 'task-save-repeat', title: 'Save Hotkey Repeat Task' };
const TODO_FAILED_SAVE: Fixture = { id: 'task-save-failed', title: 'Save Hotkey Failed Save Task' };
const RUNNING_IN_FLIGHT: Fixture = { id: 'task-save-in-flight', title: 'Save Hotkey In Flight Task', sessionId: 'sess-save-in-flight' };
const PAUSED_WORKTREE: Fixture = {
  id: 'task-save-paused-worktree',
  title: 'Save Hotkey Paused Worktree Task',
  sessionId: 'sess-save-paused-worktree',
  paused: true,
};

const FIXTURES: Fixture[] = [
  TODO_SAVE, TODO_LABEL, TODO_BRANCH, TODO_PROMPT_ENTER, TODO_PROMPT_DISCARD, TODO_PROMPT_KEEP, TODO_BOARD_MANAGER,
  RUNNING_SAVE, RUNNING_VIEW, RUNNING_PROMPT,
  TODO_INERT_PROMPT, TODO_INERT_DELETE, TODO_DISCARD_ONLY, TODO_REPEAT, TODO_FAILED_SAVE,
  RUNNING_IN_FLIGHT, PAUSED_WORKTREE,
];

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Save Hotkey Test',
      path: '/mock/save-hotkey-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: timestamp,
      created_at: timestamp,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (lane, laneIndex) {
      var id = 'lane-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[lane.name] = id;
      state.swimlanes.push(Object.assign({}, lane, { id: id, position: laneIndex, created_at: timestamp }));
    });

    var fixtures = ${JSON.stringify(FIXTURES)};
    fixtures.forEach(function (fixture, index) {
      var running = Boolean(fixture.sessionId);
      // A paused task keeps its suspended session row but has no live session
      // pointer, no worktree and no branch yet, as a task paused before it ever
      // got a worktree does.
      var paused = Boolean(fixture.paused);
      var live = running && !paused;
      if (running) {
        state.sessions.push({
          id: fixture.sessionId,
          taskId: fixture.id,
          projectId: '${PROJECT_ID}',
          pid: 9100 + index,
          status: paused ? 'suspended' : 'running',
          shell: 'bash',
          cwd: '/mock/save-hotkey-test',
          startedAt: timestamp,
          exitCode: null,
        });
      }
      var seededTask = {
        id: fixture.id,
        title: fixture.title,
        description: '',
        swimlane_id: running ? laneIds['Executing'] : laneIds['To Do'],
        position: index,
        agent: 'claude',
        session_id: live ? fixture.sessionId : null,
        worktree_path: live ? '/mock/worktrees/' + fixture.id : null,
        branch_name: live ? 'feature/' + fixture.id : null,
        pr_number: null,
        pr_url: null,
        base_branch: live ? 'main' : null,
        labels: [],
        run_mode: 'column_settings',
        archived_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      // Pinned to the project folder, so choosing Worktree is a real change.
      // Unset, the project's Worktrees switch already reads as Worktree and
      // clicking it would change nothing.
      if (paused) seededTask.use_worktree = 0;
      state.tasks.push(seededTask);
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

/** The task as the mock has it persisted, read through the real IPC surface. */
function readStoredTask(
  currentPage: Page,
  taskId: string,
): Promise<{ title: string; labels?: string[]; worktreePath?: string | null } | undefined> {
  return currentPage.evaluate(async (id) => {
    const tasks = await window.electronAPI.tasks.list();
    const task = tasks.find((candidate: { id: string }) => candidate.id === id);
    return task ? { title: task.title, labels: task.labels, worktreePath: task.worktree_path } : undefined;
  }, taskId);
}

/** Zero the mock's count of `tasks.update` calls. */
function resetUpdateCount(currentPage: Page): Promise<void> {
  return currentPage.evaluate(() => {
    (window as unknown as { __mockTaskUpdateCallCount: number }).__mockTaskUpdateCallCount = 0;
  });
}

/** How many `tasks.update` calls the mock has taken since the last reset. A save
 *  from the non-switch-branch path reaches the mock synchronously inside the
 *  keydown or click that starts it, so a read right after the input is exact.
 *  That is what lets a test assert that a key or click saved NOTHING without
 *  waiting out a timer. */
function readUpdateCount(currentPage: Page): Promise<number> {
  return currentPage.evaluate(
    () => (window as unknown as { __mockTaskUpdateCallCount?: number }).__mockTaskUpdateCallCount ?? 0,
  );
}

/** The unsaved-edits close prompt. */
function unsavedPrompt(currentPage: Page): Locator {
  return currentPage.locator('[data-testid="task-detail-unsaved-confirm"]');
}

/** A ConfirmDialog with no test id of its own, found by its title. */
function confirmTitled(currentPage: Page, title: RegExp): Locator {
  return currentPage.locator('[data-base-dialog]').filter({ has: currentPage.locator('h3', { hasText: title }) });
}

/** Open a fixture's window from its board card. A To Do task lands in the edit
 *  form; a running task lands in view mode. */
async function openFixture(fixture: Fixture): Promise<Locator> {
  const laneName = fixture.sessionId ? 'Executing' : 'To Do';
  await page.locator(`[data-swimlane-name="${laneName}"]`).locator(`text=${fixture.title}`).first().click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

/** From view mode, enter the edit form through the kebab's Edit item. Works on
 *  any page, since the menu is found through the dialog's own page. */
async function enterEditFromKebab(dialog: Locator): Promise<void> {
  await dialog.locator('[aria-label="Actions"]').click();
  // Scoped to the portaled kebab menu with an exact match, so the board's
  // per-column "Edit <column> column" buttons cannot win (see
  // task-detail-move-column-hotkeys.spec.ts).
  await dialog.page().locator('[role="menu"]').locator('text=Edit', { exact: true }).click();
  await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible({ timeout: 5000 });
}

/** Rename the Board Manager's Planning column, so its own save has something to write. */
async function renamePlanningLane(boardManager: Locator): Promise<void> {
  await boardManager.locator('[data-testid="board-manager-tab"]', { hasText: 'Planning' }).click();
  await boardManager.locator('[data-testid="board-manager-name"]').fill('Planning Saved');
}

/** The board's column names, read from the live board store. */
function boardLaneNames(currentPage: Page): Promise<string[]> {
  return currentPage.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board?: { getState: () => { swimlanes: Array<{ name: string }> } } };
    }).__zustandStores;
    return stores?.board?.getState().swimlanes.map((lane) => lane.name) ?? [];
  });
}

/** Drop every task window and the Board Manager through their stores, so a test
 *  that fails part way cannot leave either in the next test's way. A store close
 *  writes nothing, so a dirty form's edits never reach a later test's fixture. */
async function closeEverything(currentPage: Page): Promise<void> {
  await currentPage.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board?: { getState: () => { closeBoardManager: () => void } };
        window?: { getState: () => { windows: Record<string, unknown>; closeWindow: (id: string) => void } };
      };
    }).__zustandStores;
    stores?.board?.getState().closeBoardManager();
    const windowState = stores?.window?.getState();
    for (const windowId of Object.keys(windowState?.windows ?? {})) windowState?.closeWindow(windowId);
  });
  await expect(currentPage.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0, { timeout: 8000 });
  await expect(currentPage.locator('[data-testid="board-manager-dialog"]')).toHaveCount(0, { timeout: 8000 });
}

test.beforeAll(async () => {
  const result = await launchPage({ beforeLoad: (target) => target.addInitScript(preConfig) });
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterEach(async () => {
  await closeEverything(page);
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task detail Ctrl+S', () => {
  test('a To Do task saves and its window closes, like the Save button', async () => {
    const dialog = await openFixture(TODO_SAVE);
    const titleInput = dialog.locator('input[placeholder="Task title"]');
    await titleInput.fill(`${TODO_SAVE.title} (saved)`);

    await page.keyboard.press('Control+S');

    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_SAVE.id))?.title).toBe(`${TODO_SAVE.title} (saved)`);
  });

  test('a label typed without Enter is saved, because the press blurs the field first as a click on Save does', async () => {
    const dialog = await openFixture(TODO_LABEL);
    // LabelInput commits a typed label only on blur. Focus stays in it here, so
    // without the handler's blur-and-flush the save would read the old labels.
    await dialog.locator('[data-testid="task-labels"]').fill('hotkey-label');

    await page.keyboard.press('Control+S');

    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_LABEL.id))?.labels).toEqual(['hotkey-label']);
  });

  test('a running task saves and returns to its terminal; the window stays open', async () => {
    const dialog = await openFixture(RUNNING_SAVE);
    await enterEditFromKebab(dialog);
    await dialog.locator('input[placeholder="Task title"]').fill(`${RUNNING_SAVE.title} (saved)`);

    await page.keyboard.press('Control+S');

    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeHidden({ timeout: 8000 });
    await expect(dialog).toBeVisible();
    await expect.poll(async () => (await readStoredTask(page, RUNNING_SAVE.id))?.title).toBe(`${RUNNING_SAVE.title} (saved)`);

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).toBeHidden({ timeout: 8000 });
  });

  test('view mode leaves Ctrl+S alone; the edit form consumes it', async () => {
    const dialog = await openFixture(RUNNING_VIEW);
    await expect(dialog.locator('[aria-label="Actions"]')).toBeVisible({ timeout: 8000 });

    // dispatchEvent returns false when any listener called preventDefault. A
    // listener of our own would pass vacuously if something earlier had stopped
    // the event; the return value cannot.
    const dispatchControlS = (target: Locator) => target.evaluate((element) => element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }),
    ));

    expect(await dispatchControlS(dialog)).toBe(true);

    // Positive control: the same synthetic event IS consumed by the edit form,
    // so the view-mode result above is the gate, not a combo mismatch.
    await enterEditFromKebab(dialog);
    expect(await dispatchControlS(dialog.locator('input[placeholder="Task title"]'))).toBe(false);
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeHidden({ timeout: 8000 });

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).toBeHidden({ timeout: 8000 });
  });

  test('an invalid branch name refuses the save, as the disabled Save button does', async () => {
    const dialog = await openFixture(TODO_BRANCH);
    await dialog.locator('input[placeholder="Task title"]').fill(`${TODO_BRANCH.title} (saved)`);
    const branchInput = dialog.locator('[data-testid="custom-branch-name-input"]');
    await branchInput.fill('..bad-branch');
    await expect(dialog.locator('text=Invalid git branch name')).toBeVisible();

    await page.keyboard.press('Control+S');

    // Had that press saved, the To Do window would have closed and the fill
    // below would find no input, so this sequence cannot pass on a save.
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
    expect((await readStoredTask(page, TODO_BRANCH.id))?.title).toBe(TODO_BRANCH.title);

    // Positive control: clear the error and the same key saves.
    await branchInput.fill('');
    await expect(dialog.locator('text=Invalid git branch name')).toBeHidden();
    await page.keyboard.press('Control+S');
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_BRANCH.id))?.title).toBe(`${TODO_BRANCH.title} (saved)`);
  });
});

test.describe('Unsaved-edits close prompt', () => {
  test('offers Save, Discard and Keep editing; a plain Enter saves and closes', async () => {
    const dialog = await openFixture(TODO_PROMPT_ENTER);
    await dialog.locator('input[placeholder="Task title"]').fill(`${TODO_PROMPT_ENTER.title} (saved)`);

    await page.keyboard.press('Escape');
    const prompt = page.locator('[data-testid="task-detail-unsaved-confirm"]');
    await expect(prompt).toBeVisible({ timeout: 5000 });
    await expect(prompt.locator('h3')).toHaveText('Save changes before closing?');
    await expect(prompt.locator('button', { hasText: 'Keep editing' })).toBeVisible();
    await expect(prompt.locator('[data-testid="task-detail-unsaved-discard"]')).toBeVisible();
    const saveButton = prompt.locator('button', { hasText: /^Save$/ });
    // Save holds initial focus, so Enter saves rather than discarding.
    await expect(saveButton).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_PROMPT_ENTER.id))?.title).toBe(`${TODO_PROMPT_ENTER.title} (saved)`);
  });

  test('Enter on a focused Discard discards, since Enter follows the focused button', async () => {
    const dialog = await openFixture(TODO_PROMPT_DISCARD);
    await dialog.locator('input[placeholder="Task title"]').fill(`${TODO_PROMPT_DISCARD.title} (edited)`);

    await page.keyboard.press('Escape');
    const prompt = page.locator('[data-testid="task-detail-unsaved-confirm"]');
    await expect(prompt).toBeVisible({ timeout: 5000 });
    const discardButton = prompt.locator('[data-testid="task-detail-unsaved-discard"]');

    // Save starts focused and Discard sits just before it.
    await page.keyboard.press('Shift+Tab');
    await expect(discardButton).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden({ timeout: 8000 });
    expect((await readStoredTask(page, TODO_PROMPT_DISCARD.id))?.title).toBe(TODO_PROMPT_DISCARD.title);
  });

  test('Keep editing returns focus to the field the user was typing in', async () => {
    const dialog = await openFixture(TODO_PROMPT_KEEP);
    const titleInput = dialog.locator('input[placeholder="Task title"]');
    await titleInput.fill(`${TODO_PROMPT_KEEP.title} (edited)`);
    await expect(titleInput).toBeFocused();

    await page.keyboard.press('Escape');
    const prompt = page.locator('[data-testid="task-detail-unsaved-confirm"]');
    await expect(prompt).toBeVisible({ timeout: 5000 });
    await prompt.locator('button', { hasText: 'Keep editing' }).click();
    await expect(prompt).toBeHidden({ timeout: 5000 });

    // The prompt moves focus to its Save button. Closing it has to hand focus
    // back to the form, not leave it on the body.
    await expect(titleInput).toBeFocused();
    await expect(titleInput).toHaveValue(`${TODO_PROMPT_KEEP.title} (edited)`);

    await page.keyboard.press('Escape');
    await expect(prompt).toBeVisible({ timeout: 5000 });
    await prompt.locator('[data-testid="task-detail-unsaved-discard"]').click();
    await expect(dialog).toBeHidden({ timeout: 8000 });
  });

  test("a running task's Save closes the window too, because the user asked to close", async () => {
    const dialog = await openFixture(RUNNING_PROMPT);
    await enterEditFromKebab(dialog);
    await dialog.locator('input[placeholder="Task title"]').fill(`${RUNNING_PROMPT.title} (saved)`);

    await page.keyboard.press('Escape');
    const prompt = page.locator('[data-testid="task-detail-unsaved-confirm"]');
    await expect(prompt).toBeVisible({ timeout: 5000 });
    await prompt.locator('button', { hasText: /^Save$/ }).click();

    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, RUNNING_PROMPT.id))?.title).toBe(`${RUNNING_PROMPT.title} (saved)`);
  });
});

test.describe('Ctrl+S with the Board Manager over the edit form', () => {
  test('the key saves the Board Manager, and the task edit stays unsaved', async () => {
    const dialog = await openFixture(TODO_BOARD_MANAGER);
    await dialog.locator('input[placeholder="Task title"]').fill(`${TODO_BOARD_MANAGER.title} (edited)`);

    await dialog.locator('[data-testid="task-profile-edit"]').click();
    const boardManager = page.locator('[data-testid="board-manager-dialog"]');
    await expect(boardManager).toBeVisible({ timeout: 5000 });

    await renamePlanningLane(boardManager);

    await page.keyboard.press('Control+S');

    await expect.poll(() => boardLaneNames(page), { timeout: 8000 }).toContain('Planning Saved');

    // The task window did not take the key: its edit is still unsaved.
    expect((await readStoredTask(page, TODO_BOARD_MANAGER.id))?.title).toBe(TODO_BOARD_MANAGER.title);
    await expect(dialog.locator('input[placeholder="Task title"]')).toHaveValue(`${TODO_BOARD_MANAGER.title} (edited)`);
  });

  test("the Agent Monitor's task window yields the key to the Board Manager too", async () => {
    // The monitor hosts the same window through its own host, which has to fold
    // the Board Manager into `shortcutsSuppressed` as the board's host does. A
    // paused task is the case: its edit form shows the profile pencil.
    const taskId = 'task-monitor-save-hotkey';
    const taskTitle = 'Monitor Save Hotkey Task';
    const own = await launchMonitorSeed({
      tasks: [{ id: taskId, displayId: 71, title: taskTitle, lane: 'Executing', session: true, sessionStatus: 'suspended' }],
    });
    try {
      const ownPage = own.page;
      await openMonitor(ownPage);
      await byTestId(ownPage, 'monitor-page')
        .locator(`[data-session-id="${sessionIdOf(taskId)}"] [data-testid="monitor-card-title"]`)
        .click();
      const dialog = ownPage.locator('#monitor-detail-layer-root [data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await enterEditFromKebab(dialog);
      await dialog.locator('input[placeholder="Task title"]').fill(`${taskTitle} (edited)`);
      // The seeded row has no run mode, so pick Column Settings to show its pencil.
      await dialog.locator('[data-testid="task-run-mode-profile"]').click();
      await dialog.locator('[data-testid="task-profile-edit"]').click();

      const boardManager = byTestId(ownPage, 'board-manager-dialog');
      await expect(boardManager).toBeVisible({ timeout: 5000 });
      await renamePlanningLane(boardManager);

      await ownPage.keyboard.press('Control+S');

      await expect.poll(() => boardLaneNames(ownPage), { timeout: 8000 }).toContain('Planning Saved');
      expect((await readStoredTask(ownPage, taskId))?.title).toBe(taskTitle);
    } finally {
      await own.browser.close();
    }
  });
});

test.describe("Ctrl+S yields to the window's own overlays", () => {
  test('the unsaved-edits prompt keeps the key, so a stray press neither saves nor closes', async () => {
    const dialog = await openFixture(TODO_INERT_PROMPT);
    await dialog.locator('input[placeholder="Task title"]').fill(`${TODO_INERT_PROMPT.title} (edited)`);
    await page.keyboard.press('Escape');
    const prompt = unsavedPrompt(page);
    await expect(prompt).toBeVisible({ timeout: 5000 });

    await resetUpdateCount(page);
    await page.keyboard.press('Control+S');

    // A save reaches the mock inside the keydown, so a count of zero read right
    // now is exact. Checking only that the prompt is still up would pass in the
    // instant before a save's close lands.
    expect(await readUpdateCount(page)).toBe(0);
    await expect(prompt).toBeVisible();
    await expect(dialog).toBeVisible();
    expect((await readStoredTask(page, TODO_INERT_PROMPT.id))?.title).toBe(TODO_INERT_PROMPT.title);

    // Positive control: with the prompt dismissed the same key saves, so the zero
    // above is the prompt's doing and not a press that never matched.
    await prompt.locator('button', { hasText: 'Keep editing' }).click();
    await expect(prompt).toBeHidden({ timeout: 5000 });
    await page.keyboard.press('Control+S');
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_INERT_PROMPT.id))?.title).toBe(`${TODO_INERT_PROMPT.title} (edited)`);
  });

  test('the delete confirm keeps the key, so a stray press cannot save under it', async () => {
    const dialog = await openFixture(TODO_INERT_DELETE);
    await dialog.locator('input[placeholder="Task title"]').fill(`${TODO_INERT_DELETE.title} (edited)`);
    // The edit form's footer Delete. The mock has "don't ask again" off, so it
    // opens the confirm rather than deleting.
    await dialog.locator('button', { hasText: /^Delete$/ }).click();
    const deleteConfirm = confirmTitled(page, /^Delete task$/);
    await expect(deleteConfirm).toBeVisible({ timeout: 5000 });

    await resetUpdateCount(page);
    await page.keyboard.press('Control+S');

    expect(await readUpdateCount(page)).toBe(0);
    await expect(deleteConfirm).toBeVisible();
    await expect(dialog).toBeVisible();
    expect((await readStoredTask(page, TODO_INERT_DELETE.id))?.title).toBe(TODO_INERT_DELETE.title);

    // Positive control: Cancel puts the confirm away and the same key saves.
    await deleteConfirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(deleteConfirm).toBeHidden({ timeout: 5000 });
    await page.keyboard.press('Control+S');
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_INERT_DELETE.id))?.title).toBe(`${TODO_INERT_DELETE.title} (edited)`);
  });
});

test.describe('Unsaved-edits close prompt, further cases', () => {
  test('a branch-name error leaves Discard as the only way out, and Keep editing returns to the form', async () => {
    const dialog = await openFixture(TODO_DISCARD_ONLY);
    const titleInput = dialog.locator('input[placeholder="Task title"]');
    const branchInput = dialog.locator('[data-testid="custom-branch-name-input"]');
    await branchInput.fill('..bad-branch');
    await expect(dialog.locator('text=Invalid git branch name')).toBeVisible();
    await titleInput.fill(`${TODO_DISCARD_ONLY.title} (edited)`);

    await page.keyboard.press('Escape');
    const prompt = unsavedPrompt(page);
    await expect(prompt).toBeVisible({ timeout: 5000 });

    // The form cannot save with that branch name, so the prompt must not offer a
    // Save that would do nothing. It asks only whether to discard.
    await expect(prompt.locator('h3')).toHaveText('Discard unsaved changes?');
    await expect(prompt.locator('button', { hasText: /^Discard$/ })).toBeVisible();
    await expect(prompt.locator('button', { hasText: 'Keep editing' })).toBeVisible();
    await expect(prompt.locator('button', { hasText: /^Save$/ })).toHaveCount(0);
    await expect(prompt.locator('[data-testid="task-detail-unsaved-discard"]')).toHaveCount(0);

    await prompt.locator('button', { hasText: 'Keep editing' }).click();

    await expect(prompt).toBeHidden({ timeout: 5000 });
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
    await expect(titleInput).toHaveValue(`${TODO_DISCARD_ONLY.title} (edited)`);
    await expect(branchInput).toHaveValue('..bad-branch');
    expect((await readStoredTask(page, TODO_DISCARD_ONLY.id))?.title).toBe(TODO_DISCARD_ONLY.title);
  });

  test("the prompt's Save still closes the window when it has to go through the Enable worktree confirm", async () => {
    // A paused task has session context and no worktree. Choosing Worktree makes
    // its save an enable-worktree save, which waits on a confirm of its own. The
    // close the prompt's Save asked for has to survive that wait: without it a
    // task with a session returns to its terminal instead of closing.
    const dialog = await openFixture(PAUSED_WORKTREE);
    await enterEditFromKebab(dialog);
    await dialog.locator('[data-testid="worktree-option-worktree"]').click();
    await dialog.locator('input[placeholder="Task title"]').fill(`${PAUSED_WORKTREE.title} (saved)`);

    await page.keyboard.press('Escape');
    const prompt = unsavedPrompt(page);
    await expect(prompt).toBeVisible({ timeout: 5000 });
    await prompt.locator('button', { hasText: /^Save$/ }).click();

    const enableConfirm = confirmTitled(page, /^Enable worktree\?$/);
    await expect(enableConfirm).toBeVisible({ timeout: 5000 });
    // Nothing is written until the user accepts.
    expect((await readStoredTask(page, PAUSED_WORKTREE.id))?.title).toBe(PAUSED_WORKTREE.title);
    await enableConfirm.getByRole('button', { name: 'Enable', exact: true }).click();

    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, PAUSED_WORKTREE.id))?.title).toBe(`${PAUSED_WORKTREE.title} (saved)`);
    // The enable itself went through, so this was the worktree save and not a
    // plain one.
    expect((await readStoredTask(page, PAUSED_WORKTREE.id))?.worktreePath).toBeTruthy();
  });

  test("the prompt's Save does nothing while an earlier save is in flight, and closes the window once it lands", async () => {
    const dialog = await openFixture(RUNNING_IN_FLIGHT);
    await enterEditFromKebab(dialog);
    await dialog.locator('input[placeholder="Task title"]').fill(`${RUNNING_IN_FLIGHT.title} (saved)`);
    try {
      // The mock holds the next tasks.update until the test releases it.
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUpdateDeferred: boolean }).__mockTaskUpdateDeferred = true;
      });
      await resetUpdateCount(page);
      await page.keyboard.press('Control+S');
      // The footer Save disables while the save is in flight.
      await expect(dialog.locator('button', { hasText: /^Save$/ })).toBeDisabled({ timeout: 5000 });
      expect(await readUpdateCount(page)).toBe(1);

      await page.keyboard.press('Escape');
      const prompt = unsavedPrompt(page);
      await expect(prompt).toBeVisible({ timeout: 5000 });
      await prompt.locator('button', { hasText: /^Save$/ }).click();

      // The click is refused. A second save would be dropped by the in-flight
      // guard and take the close with it, so the prompt has to stay up for the
      // user to try again, and nothing else is written.
      await expect(prompt).toBeVisible();
      expect(await readUpdateCount(page)).toBe(1);

      // Release the held update. The first save lands (a running task returns
      // to its terminal), and the form leaves edit in the same commit that
      // clears the in-flight flag.
      await page.evaluate(() => {
        (window as unknown as { __mockTaskUpdateResolve?: () => void }).__mockTaskUpdateResolve?.();
      });
      await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeHidden({ timeout: 8000 });
      await expect.poll(async () => (await readStoredTask(page, RUNNING_IN_FLIGHT.id))?.title).toBe(`${RUNNING_IN_FLIGHT.title} (saved)`);

      // With nothing in flight the prompt's Save works, and it closes the window.
      await expect(prompt).toBeVisible();
      await prompt.locator('button', { hasText: /^Save$/ }).click();
      await expect(dialog).toBeHidden({ timeout: 8000 });
    } finally {
      // An armed hold would stall the next test's save, and an unreleased one
      // would leave this test's save hanging.
      await page.evaluate(() => {
        const mockHooks = window as unknown as { __mockTaskUpdateDeferred?: boolean; __mockTaskUpdateResolve?: () => void };
        mockHooks.__mockTaskUpdateDeferred = false;
        mockHooks.__mockTaskUpdateResolve?.();
      });
    }
  });
});

test.describe('Ctrl+S save guards', () => {
  test('a repeated keydown from a held key is ignored, while the first press saves', async () => {
    const dialog = await openFixture(TODO_REPEAT);
    const titleInput = dialog.locator('input[placeholder="Task title"]');
    await titleInput.fill(`${TODO_REPEAT.title} (saved)`);
    await resetUpdateCount(page);

    // dispatchEvent returns false when a listener called preventDefault.
    const dispatchControlS = (repeat: boolean) => titleInput.evaluate((element, isRepeat) => element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, repeat: isRepeat, bubbles: true, cancelable: true }),
    ), repeat);

    // The repeat is still consumed, so a held key never falls through to the
    // browser's own Save Page, but it saves nothing.
    expect(await dispatchControlS(true)).toBe(false);
    expect(await readUpdateCount(page)).toBe(0);
    await expect(dialog).toBeVisible();
    await expect(titleInput).toHaveValue(`${TODO_REPEAT.title} (saved)`);
    expect((await readStoredTask(page, TODO_REPEAT.id))?.title).toBe(TODO_REPEAT.title);

    // Positive control: the same event without `repeat` saves and closes.
    expect(await dispatchControlS(false)).toBe(false);
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_REPEAT.id))?.title).toBe(`${TODO_REPEAT.title} (saved)`);
    expect(await readUpdateCount(page)).toBe(1);
  });

  test('a save the main process refuses toasts and leaves the form open with the edit', async () => {
    const dialog = await openFixture(TODO_FAILED_SAVE);
    const titleInput = dialog.locator('input[placeholder="Task title"]');
    await titleInput.fill(`${TODO_FAILED_SAVE.title} (saved)`);
    try {
      await page.evaluate(() => {
        const tasksApi = window.electronAPI.tasks as unknown as { update: (...args: unknown[]) => Promise<unknown> };
        (window as unknown as { __realTasksUpdate?: unknown }).__realTasksUpdate = tasksApi.update;
        tasksApi.update = async () => { throw new Error('Mock task write failure'); };
      });

      await page.keyboard.press('Control+S');

      const failureToast = page.locator('[data-testid="toast"]').filter({
        has: page.locator('[data-testid="toast-title"]', { hasText: "Couldn't save task" }),
      });
      await expect(failureToast).toBeVisible({ timeout: 5000 });
      // The window is still on the edit form with what the user typed.
      await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
      await expect(titleInput).toHaveValue(`${TODO_FAILED_SAVE.title} (saved)`);
      expect((await readStoredTask(page, TODO_FAILED_SAVE.id))?.title).toBe(TODO_FAILED_SAVE.title);
    } finally {
      await page.evaluate(() => {
        const holder = window as unknown as { __realTasksUpdate?: (...args: unknown[]) => Promise<unknown> };
        if (holder.__realTasksUpdate) {
          (window.electronAPI.tasks as unknown as { update: unknown }).update = holder.__realTasksUpdate;
          delete holder.__realTasksUpdate;
        }
      });
    }

    // With the write working again, the same edit saves from the same form.
    await page.keyboard.press('Control+S');
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(page, TODO_FAILED_SAVE.id))?.title).toBe(`${TODO_FAILED_SAVE.title} (saved)`);
  });
});
