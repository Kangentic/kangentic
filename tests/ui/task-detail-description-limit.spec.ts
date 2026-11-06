/**
 * UI tests for the description length limit in the task window's edit form.
 *
 * A description past TASK_DESCRIPTION_MAX_LENGTH would save and then never start
 * (it rides the agent's command line), so the window refuses it: the over-limit
 * note shows, Save is disabled, Ctrl+S saves nothing, and the discard prompt
 * does not offer Save. A task already over the limit that does not grow keeps
 * every other edit. The session-context auto-save leaves an over-limit draft in
 * the form instead of saving it. The New Task dialog's version is covered in
 * dialog-save-hotkey.spec.ts.
 *
 * One shared page; every test owns a fixture task, so none depends on another's
 * leftovers. To Do tasks open straight into the edit form.
 */
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { launchPage, settleFrames } from './helpers';

const PROJECT_ID = 'proj-description-limit';
const LIMIT = 27_500;

interface Fixture {
  id: string;
  title: string;
  description: string;
}

const NEW_OVER: Fixture = { id: 'task-limit-new-over', title: 'Limit New Over Task', description: '' };
const LEGACY_LONG: Fixture = { id: 'task-limit-legacy-long', title: 'Limit Legacy Long Task', description: 'y'.repeat(LIMIT + 100) };
const PROMPT_OVER: Fixture = { id: 'task-limit-prompt-over', title: 'Limit Prompt Over Task', description: '' };
const SESSION_OVER: Fixture = { id: 'task-limit-session-over', title: 'Limit Session Over Task', description: '' };
const SESSION_UNDER: Fixture = { id: 'task-limit-session-under', title: 'Limit Session Under Task', description: '' };

const FIXTURES: Fixture[] = [NEW_OVER, LEGACY_LONG, PROMPT_OVER, SESSION_OVER, SESSION_UNDER];

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Description Limit Test',
      path: '/mock/description-limit-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: timestamp,
      created_at: timestamp,
    });

    var todoLaneId = null;
    state.DEFAULT_SWIMLANES.forEach(function (lane, laneIndex) {
      var id = 'lane-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
      if (lane.name === 'To Do') todoLaneId = id;
      state.swimlanes.push(Object.assign({}, lane, { id: id, position: laneIndex, created_at: timestamp }));
    });

    var fixtures = ${JSON.stringify(FIXTURES)};
    fixtures.forEach(function (fixture, index) {
      state.tasks.push({
        id: fixture.id,
        title: fixture.title,
        description: fixture.description,
        swimlane_id: todoLaneId,
        position: index,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        labels: [],
        run_mode: 'column_settings',
        archived_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

interface StoredTask {
  title: string;
  description: string;
}

function readStoredTask(taskId: string): Promise<StoredTask | undefined> {
  return page.evaluate(async (id) => {
    const tasks = await window.electronAPI.tasks.list();
    const task = tasks.find((candidate: { id: string }) => candidate.id === id);
    return task ? { title: task.title, description: task.description } : undefined;
  }, taskId);
}

function resetUpdateCount(): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __mockTaskUpdateCallCount: number }).__mockTaskUpdateCallCount = 0;
  });
}

/** The mock's `tasks.update` count. A save reaches the mock synchronously inside the
 *  input that starts it, so a read right after the input is exact for "saved nothing". */
function readUpdateCount(): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __mockTaskUpdateCallCount?: number }).__mockTaskUpdateCallCount ?? 0,
  );
}

async function openFixture(fixture: Fixture): Promise<Locator> {
  await page.locator('[data-swimlane-name="To Do"]').locator(`text=${fixture.title}`).first().click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible({ timeout: 5000 });
  return dialog;
}

function overLimitNote(dialog: Locator): Locator {
  return dialog.getByTestId('task-description-over-limit');
}

function saveButton(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: 'Save', exact: true });
}

/** Give a task a running session through the session store, as main's
 *  `session-changed` push does, while its edit form stays open. */
async function giveTaskASession(taskId: string): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { upsertSession: (session: object) => void } } };
    }).__zustandStores;
    stores.session.getState().upsertSession({
      id: 'sess-' + id,
      taskId: id,
      projectId: 'proj-description-limit',
      pid: 9300,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/description-limit-test',
      startedAt: new Date().toISOString(),
      exitCode: null,
    });
  }, taskId);
  await expect.poll(() => page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { sessions: Array<{ taskId: string }> } } };
    }).__zustandStores;
    return stores.session.getState().sessions.some((session) => session.taskId === id);
  }, taskId)).toBe(true);
}

/** Drop every task window through the store, so a failed test cannot leave a form
 *  open in the next one. A store close writes nothing. */
async function closeEverything(): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { window?: { getState: () => { windows: Record<string, unknown>; closeWindow: (id: string) => void } } };
    }).__zustandStores;
    const windowState = stores?.window?.getState();
    for (const windowId of Object.keys(windowState?.windows ?? {})) windowState?.closeWindow(windowId);
  });
  await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0, { timeout: 8000 });
}

test.beforeAll(async () => {
  const result = await launchPage({ beforeLoad: (target) => target.addInitScript(preConfig) });
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterEach(async () => {
  await closeEverything();
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Task window description limit', () => {
  test('a description over the limit shows the note, disables Save, and Ctrl+S saves nothing', async () => {
    const dialog = await openFixture(NEW_OVER);
    await dialog.locator('input[placeholder="Task title"]').fill(`${NEW_OVER.title} (edited)`);
    await dialog.locator('[data-testid="task-description"]').fill('x'.repeat(LIMIT + 2));

    await expect(overLimitNote(dialog)).toHaveText('2 characters over the limit');
    await expect(saveButton(dialog)).toBeDisabled();

    await resetUpdateCount();
    await page.keyboard.press('Control+S');

    expect(await readUpdateCount()).toBe(0);
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
    expect((await readStoredTask(NEW_OVER.id))?.description).toBe('');

    // Positive control: back at the limit the same key saves, so the zero above
    // is the limit's doing and not a press that never matched.
    await dialog.locator('[data-testid="task-description"]').fill('x'.repeat(LIMIT));
    await expect(overLimitNote(dialog)).toHaveCount(0);
    await expect(saveButton(dialog)).toBeEnabled();
    await page.keyboard.press('Control+S');
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(NEW_OVER.id))?.description.length).toBe(LIMIT);
  });

  test('a task already over the limit keeps other edits until the description grows', async () => {
    const dialog = await openFixture(LEGACY_LONG);
    const description = dialog.locator('[data-testid="task-description"]');
    await expect(description).toHaveValue(LEGACY_LONG.description);

    // Not grown: no note, Save enabled.
    await expect(overLimitNote(dialog)).toHaveCount(0);
    await expect(saveButton(dialog)).toBeEnabled();

    // Grown by one character: the note shows and Save is disabled.
    await description.fill(`${LEGACY_LONG.description}z`);
    await expect(overLimitNote(dialog)).toHaveText('101 characters over the limit');
    await expect(saveButton(dialog)).toBeDisabled();

    // Back to its original length, then another edit (the title) saves.
    await description.fill(LEGACY_LONG.description);
    await expect(overLimitNote(dialog)).toHaveCount(0);
    await expect(saveButton(dialog)).toBeEnabled();
    await dialog.locator('input[placeholder="Task title"]').fill(`${LEGACY_LONG.title} (saved)`);
    await page.keyboard.press('Control+S');

    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(async () => (await readStoredTask(LEGACY_LONG.id))?.title).toBe(`${LEGACY_LONG.title} (saved)`);
    expect((await readStoredTask(LEGACY_LONG.id))?.description).toBe(LEGACY_LONG.description);
  });

  test('the discard prompt offers no Save while the description is over the limit', async () => {
    const dialog = await openFixture(PROMPT_OVER);
    await dialog.locator('[data-testid="task-description"]').fill('x'.repeat(LIMIT + 1));
    await expect(overLimitNote(dialog)).toBeVisible();

    await page.keyboard.press('Escape');
    const prompt = page.locator('[data-testid="task-detail-unsaved-confirm"]');
    await expect(prompt).toBeVisible({ timeout: 5000 });
    await expect(prompt.locator('h3')).toHaveText('Discard unsaved changes?');
    await expect(prompt.locator('button', { hasText: /^Save$/ })).toHaveCount(0);
    await expect(prompt.locator('button', { hasText: /^Discard$/ })).toBeVisible();

    await prompt.locator('button', { hasText: 'Keep editing' }).click();
    await expect(prompt).toBeHidden({ timeout: 5000 });
    await expect(overLimitNote(dialog)).toBeVisible();
  });
});

test.describe('Session-context auto-save', () => {
  test('a draft over the limit is not saved: the form stays open with the draft and the note', async () => {
    const dialog = await openFixture(SESSION_OVER);
    const description = dialog.locator('[data-testid="task-description"]');
    await description.fill('x'.repeat(LIMIT + 3));
    await expect(overLimitNote(dialog)).toBeVisible();

    await resetUpdateCount();
    await giveTaskASession(SESSION_OVER.id);
    // The effect runs on the commit after the session lands; let the frames settle
    // before asserting that nothing was saved.
    await settleFrames(page, 4);

    expect(await readUpdateCount()).toBe(0);
    expect((await readStoredTask(SESSION_OVER.id))?.description).toBe('');
    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeVisible();
    await expect(description).toHaveValue('x'.repeat(LIMIT + 3));
    await expect(overLimitNote(dialog)).toHaveText('3 characters over the limit');
  });

  test('a draft under the limit is saved and the form returns to view mode', async () => {
    const dialog = await openFixture(SESSION_UNDER);
    await dialog.locator('[data-testid="task-description"]').fill('a draft that fits');

    await resetUpdateCount();
    await giveTaskASession(SESSION_UNDER.id);

    await expect(dialog.locator('[data-testid="task-detail-edit-scroll"]')).toBeHidden({ timeout: 8000 });
    expect(await readUpdateCount()).toBe(1);
    await expect.poll(async () => (await readStoredTask(SESSION_UNDER.id))?.description).toBe('a draft that fits');
  });
});
