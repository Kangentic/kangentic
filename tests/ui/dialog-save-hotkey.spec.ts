/**
 * UI tests for the shared save key (`taskDetail.save`, Ctrl+S) in dialogs.
 *
 * A BaseDialog that passes `save` gets the key: it runs the same handler as the
 * dialog's Save, Create or Done button, and does nothing (but still consumes the
 * key) while that button is disabled. Only the topmost overlay acts, so a dialog
 * opened over another one takes the key and the one beneath leaves it alone.
 * The task window's own edit-form binding is covered in
 * task-detail-save-hotkey.spec.ts.
 *
 * Each test launches its own page: dialogs left open by a failed test would
 * otherwise sit in the next test's way, and the mock's state lives in the page.
 */
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { launchPage, createProject, createTask, waitForBoard, settleFrames } from './helpers';

test.describe.configure({ mode: 'parallel' });

let browser: Browser;
let page: Page;

test.beforeEach(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `DialogSave Test ${Date.now()}`);
  await waitForBoard(page);
});

test.afterEach(async () => {
  await browser?.close();
});

const newTaskDialog = () => page.locator('[data-testid="new-task-dialog"]');
const newTaskTitle = () => newTaskDialog().locator('input[placeholder="Task title"]');
const boardManager = () => page.locator('[data-testid="board-manager-dialog"]');
const editAutomation = () => page.locator('[data-testid="edit-automation-dialog"]');

/** Board task titles as the mock has them persisted. */
function storedTaskTitles(): Promise<string[]> {
  return page.evaluate(async () => (await window.electronAPI.tasks.list()).map((task) => task.title));
}

/** A board task's persisted labels, by title. */
function storedTaskLabels(title: string): Promise<string[] | undefined> {
  return page.evaluate(async (wanted) => {
    const task = (await window.electronAPI.tasks.list()).find((candidate) => candidate.title === wanted);
    return task?.labels;
  }, title);
}

/** Backlog item titles as the mock has them persisted. */
function storedBacklogTitles(): Promise<string[]> {
  return page.evaluate(async () => (await window.electronAPI.backlog.list()).map((item) => item.title));
}

/**
 * Dispatch Ctrl+S on an element. Returns false when a listener called
 * preventDefault, so a press that did nothing can still be shown to have been
 * consumed rather than never matched. Only for "consumed but nothing happened":
 * a script dispatch has no commit between listeners, so a nested case uses a
 * real `page.keyboard.press`.
 */
function dispatchControlS(target: Locator, init: KeyboardEventInit = {}): Promise<boolean> {
  return target.evaluate((element, eventInit) => element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true, ...eventInit }),
  ), init);
}

interface SubmitCounterWindow {
  __dialogSaveSubmits?: number;
}

/**
 * Count the form submits from here on. A save-enabled form dialog saves through
 * `requestSubmit`, which fires `submit` synchronously, so a count read right
 * after a dispatch shows whether the key reached the save. It is the check for a
 * press that must do nothing: the create itself is async, so "nothing stored
 * yet" would pass a save that is still on its way.
 */
async function watchFormSubmits(): Promise<void> {
  await page.evaluate(() => {
    const counter = window as unknown as SubmitCounterWindow;
    counter.__dialogSaveSubmits = 0;
    document.addEventListener('submit', () => {
      counter.__dialogSaveSubmits = (counter.__dialogSaveSubmits ?? 0) + 1;
    }, true);
  });
}

function formSubmitCount(): Promise<number> {
  return page.evaluate(() => (window as unknown as SubmitCounterWindow).__dialogSaveSubmits ?? 0);
}

/** Paste a 1x1 PNG into a description field, which adds one attachment chip. */
async function pasteImage(descriptionField: Locator): Promise<void> {
  await descriptionField.evaluate((element) => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const file = new File([new Blob([bytes], { type: 'image/png' })], 'shot.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
}

async function openNewTask(): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
  await expect(newTaskTitle()).toBeVisible();
}

/** Open the Column Manager on a column by clicking its board header. */
async function openColumnManager(columnName: string): Promise<void> {
  await page.locator(`[data-swimlane-name="${columnName}"]`).locator(`text=${columnName}`).click();
  await expect(boardManager()).toBeVisible({ timeout: 5000 });
}

/** The persisted automations of one column, by column name. */
function storedAutomationNames(columnName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const lane = lanes.find((swimlane) => swimlane.name === name);
    const rows = await window.electronAPI.automations.list();
    return rows.filter((row) => row.swimlane_id === lane?.id).map((row) => row.name);
  }, columnName);
}

test.describe('New Task', () => {
  test('Ctrl+S creates the task, keeping a label typed without Enter', async () => {
    await openNewTask();
    await newTaskTitle().fill('Saved With The Key');
    // LabelInput commits a typed label only on blur. Focus stays in it here, so
    // without the press's blur-and-flush the create would carry no labels.
    await newTaskDialog().locator('[data-testid="task-labels"]').fill('hotkey-label');

    await page.keyboard.press('Control+S');

    await expect(newTaskDialog()).toBeHidden({ timeout: 8000 });
    await expect.poll(storedTaskTitles).toContain('Saved With The Key');
    expect(await storedTaskLabels('Saved With The Key')).toEqual(['hotkey-label']);
  });

  test('with an empty title the key is consumed and creates nothing', async () => {
    await openNewTask();

    expect(await dispatchControlS(newTaskTitle())).toBe(false);

    await expect(newTaskDialog()).toBeVisible();
    expect(await storedTaskTitles()).toEqual([]);
  });

  test('the discard confirm on top keeps the key, so a press neither creates nor closes', async () => {
    await openNewTask();
    await newTaskTitle().fill('Behind The Confirm');
    await page.keyboard.press('Escape');
    const keepEditing = page.locator('button', { hasText: 'Keep editing' });
    await expect(keepEditing).toBeVisible({ timeout: 5000 });
    await watchFormSubmits();

    // The confirm has no save of its own, but the dialog under it still takes the
    // key and consumes it. Left un-prevented, the press would fall through to the
    // browser's Save Page in the web build.
    expect(await dispatchControlS(keepEditing)).toBe(false);
    expect(await formSubmitCount()).toBe(0);

    await page.keyboard.press('Control+S');

    expect(await formSubmitCount()).toBe(0);
    expect(await storedTaskTitles()).toEqual([]);
    await expect(keepEditing).toBeVisible();
    await expect(newTaskDialog()).toBeVisible();

    // Positive control: with the confirm gone the same key creates, so the
    // nothing above is the confirm's doing and not a press that never matched.
    await keepEditing.click();
    await expect(keepEditing).toBeHidden({ timeout: 5000 });
    await page.keyboard.press('Control+S');
    await expect(newTaskDialog()).toBeHidden({ timeout: 8000 });
    await expect.poll(storedTaskTitles).toContain('Behind The Confirm');
  });

  test('Settings opened over the dialog keeps the key', async () => {
    await openNewTask();
    await newTaskTitle().fill('Behind Settings');
    await newTaskDialog().locator('[data-testid="task-advanced-toggle"]').click();
    await newTaskDialog().locator('[data-testid="task-agent-edit"]').click();
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();
    await watchFormSubmits();

    // Settings has no save of its own, but the dialog under it still takes the
    // key and consumes it, so it never falls through to the browser.
    expect(await dispatchControlS(settingsPanel)).toBe(false);
    expect(await formSubmitCount()).toBe(0);

    await page.keyboard.press('Control+S');

    // Had the press created the task, the dialog under Settings would be gone.
    expect(await formSubmitCount()).toBe(0);
    expect(await storedTaskTitles()).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(settingsPanel).toBeHidden({ timeout: 5000 });
    await expect(newTaskTitle()).toHaveValue('Behind Settings');

    // Positive control: with Settings closed the dialog is on top again.
    await page.keyboard.press('Control+S');
    await expect(newTaskDialog()).toBeHidden({ timeout: 8000 });
    await expect.poll(storedTaskTitles).toContain('Behind Settings');
  });

  test('opened with Mod+N over a task edit form, it takes the key and the form stays unsaved', async () => {
    await createTask(page, 'Open Edit Form');
    await page.locator('[data-swimlane-name="To Do"]').locator('text=Open Edit Form').first().click();
    const taskWindow = page.locator('[data-testid="task-detail-dialog"]');
    await expect(taskWindow).toBeVisible({ timeout: 5000 });
    const windowTitle = taskWindow.locator('input[placeholder="Task title"]');
    await windowTitle.fill('Open Edit Form (edited)');

    await page.keyboard.press('Control+N');
    await expect(newTaskDialog()).toBeVisible({ timeout: 5000 });
    await newTaskTitle().fill('Created Over The Window');

    await page.keyboard.press('Control+S');

    await expect(newTaskDialog()).toBeHidden({ timeout: 8000 });
    await expect.poll(storedTaskTitles).toContain('Created Over The Window');
    // The task window under the dialog did not save its edit.
    expect(await storedTaskTitles()).toContain('Open Edit Form');
    await expect(windowTitle).toHaveValue('Open Edit Form (edited)');
  });

  test('with an empty title the press puts the caret back in the title and creates nothing', async () => {
    await openNewTask();
    // Start with focus somewhere else, so the title can only be focused by the
    // refusal itself and not because the dialog opened on it.
    const description = newTaskDialog().locator('[data-testid="task-description"]');
    await description.click();
    await expect(description).toBeFocused();
    await watchFormSubmits();

    await page.keyboard.press('Control+S');

    // The press blurs the focused field before it saves, so without the refusal
    // handing focus back, it would sit on nothing.
    await expect(newTaskTitle()).toBeFocused();
    expect(await formSubmitCount()).toBe(1);
    await expect(newTaskDialog()).toBeVisible();
    expect(await storedTaskTitles()).toEqual([]);
  });

  test('with the attachment preview open the key is consumed and does not submit', async () => {
    await openNewTask();
    await newTaskTitle().fill('Behind The Preview');
    await pasteImage(newTaskDialog().locator('[data-testid="task-description"]'));
    const chips = newTaskDialog().locator('[data-testid="attachment-chip"]');
    await expect(chips).toHaveCount(1);
    await chips.locator('[data-testid="attachment-open"]').click();
    const preview = page.locator('[data-testid="attachment-preview-overlay"]');
    await expect(preview).toBeVisible();
    await watchFormSubmits();

    // The preview is not a BaseDialog, so only the save option's disabled flag
    // keeps the key from creating the task under it.
    expect(await dispatchControlS(preview)).toBe(false);

    expect(await formSubmitCount()).toBe(0);

    // Positive control: with the preview closed the same key creates the task.
    await preview.click({ position: { x: 5, y: 5 } });
    await expect(preview).toBeHidden();
    await page.keyboard.press('Control+S');
    await expect(newTaskDialog()).toBeHidden({ timeout: 8000 });
    await expect.poll(storedTaskTitles).toEqual(['Behind The Preview']);
  });

  test('with an invalid branch name the key is consumed and does not submit', async () => {
    await openNewTask();
    await newTaskTitle().fill('Bad Branch');
    const branchInput = newTaskDialog().locator('[data-testid="custom-branch-name-input"]');
    await branchInput.fill('not a branch');
    const branchError = newTaskDialog().getByText('Invalid git branch name');
    await expect(branchError).toBeVisible();
    await watchFormSubmits();

    // handleSubmit refuses an invalid name too, so "nothing created" cannot tell
    // a disabled save from a refused one. The submit count can.
    expect(await dispatchControlS(branchInput)).toBe(false);

    expect(await formSubmitCount()).toBe(0);
    await expect(branchInput).toBeFocused();

    // Positive control: a valid name lifts the block, and the same key creates.
    await branchInput.fill('feature/fine');
    await expect(branchError).toHaveCount(0);
    await page.keyboard.press('Control+S');
    await expect(newTaskDialog()).toBeHidden({ timeout: 8000 });
    await expect.poll(storedTaskTitles).toEqual(['Bad Branch']);
  });

  test('a held key is consumed and does not submit; the next press does', async () => {
    await openNewTask();
    await newTaskTitle().fill('Held Key');
    await watchFormSubmits();

    expect(await dispatchControlS(newTaskTitle(), { repeat: true })).toBe(false);

    expect(await formSubmitCount()).toBe(0);
    await expect(newTaskTitle()).toBeFocused();

    // Positive control: the first press of the same key creates the task.
    await page.keyboard.press('Control+S');
    await expect(newTaskDialog()).toBeHidden({ timeout: 8000 });
    await expect.poll(storedTaskTitles).toEqual(['Held Key']);
  });
});

test.describe('New Backlog Task', () => {
  async function openNewBacklogTask(): Promise<Locator> {
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();
    await page.locator('[data-testid="new-backlog-task-btn"]').click();
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('Ctrl+S creates the item', async () => {
    const dialog = await openNewBacklogTask();
    await page.locator('[data-testid="backlog-task-title"]').fill('Backlog Saved With The Key');

    await page.keyboard.press('Control+S');

    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(storedBacklogTitles).toContain('Backlog Saved With The Key');
  });

  test('with Create disabled (empty title) the key is consumed and creates nothing', async () => {
    const dialog = await openNewBacklogTask();
    await expect(page.locator('[data-testid="create-backlog-task-btn"]')).toBeDisabled();

    expect(await dispatchControlS(page.locator('[data-testid="backlog-task-title"]'))).toBe(false);

    await expect(dialog).toBeVisible();
    expect(await storedBacklogTitles()).toEqual([]);
  });

  test('with the attachment preview open the key is consumed and does not submit', async () => {
    const dialog = await openNewBacklogTask();
    await page.locator('[data-testid="backlog-task-title"]').fill('Backlog Behind The Preview');
    await pasteImage(page.locator('[data-testid="backlog-task-description"]'));
    const chips = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chips).toHaveCount(1);
    await chips.locator('[data-testid="attachment-open"]').click();
    const preview = page.locator('[data-testid="attachment-preview-overlay"]');
    await expect(preview).toBeVisible();
    await watchFormSubmits();

    expect(await dispatchControlS(preview)).toBe(false);

    expect(await formSubmitCount()).toBe(0);

    // Positive control: with the preview closed the same key creates the item.
    await preview.click({ position: { x: 5, y: 5 } });
    await expect(preview).toBeHidden();
    await page.keyboard.press('Control+S');
    await expect(dialog).toBeHidden({ timeout: 8000 });
    await expect.poll(storedBacklogTitles).toEqual(['Backlog Behind The Preview']);
  });
});

test.describe('Column Manager', () => {
  test('clean, the key is consumed and neither saves nor closes; with an edit it saves', async () => {
    await openColumnManager('Executing');
    const save = boardManager().locator('[data-testid="board-manager-save"]');
    await expect(save).toBeDisabled();

    // A clean Column Manager has nothing to save, and an ungated save would close
    // it at once (handleSave closes when nothing changed), so the dialog still
    // being up after the board has settled is the evidence.
    expect(await dispatchControlS(boardManager())).toBe(false);
    await settleFrames(page);
    await expect(boardManager()).toBeVisible();

    // Positive control: a new profile makes the board dirty, and the same key
    // then saves it and closes the dialog.
    await boardManager().locator('[data-testid="board-manager-profile-new"]').click();
    const nameInput = page.locator('[data-testid="profile-name-input"]');
    await nameInput.fill('Control');
    await page.keyboard.press('Control+S');
    await expect(nameInput).toBeHidden({ timeout: 5000 });
    await expect(save).toBeEnabled();
    await page.keyboard.press('Control+S');
    await expect(boardManager()).toBeHidden({ timeout: 8000 });
  });
});

test.describe('Column Manager sub-dialogs', () => {
  test('in Edit automation, Ctrl+S applies Done and leaves the board unsaved; the next press saves it', async () => {
    await openColumnManager('Executing');
    await boardManager().locator('[data-testid="column-automation-add"][data-trigger="enter"]').click();
    const picker = page.locator('[data-testid="column-automation-picker"]');
    await expect(picker).toBeVisible();
    await picker.locator('[data-testid="column-automation-picker-type"][data-type="run_script"]').click();
    await expect(editAutomation()).toBeVisible();
    await editAutomation().locator('[data-testid="edit-automation-name"]').fill('Install deps');
    await editAutomation().locator('[data-testid="automation-config-script"]').fill('npm ci');

    await page.keyboard.press('Control+S');

    // Done ran: the dialog closed and its row is in the Column Manager.
    await expect(editAutomation()).toBeHidden({ timeout: 5000 });
    await expect(boardManager().locator('[data-testid="column-automation-row"][data-name="Install deps"]')).toBeVisible();
    // The Column Manager underneath did not save or close on the same press.
    await expect(boardManager()).toBeVisible();
    expect(await storedAutomationNames('Executing')).toEqual([]);

    // Positive control: with the sub-dialog gone, the key saves the board.
    await expect(boardManager().locator('[data-testid="board-manager-save"]')).toBeEnabled();
    await page.keyboard.press('Control+S');
    await expect(boardManager()).toBeHidden({ timeout: 8000 });
    await expect.poll(() => storedAutomationNames('Executing')).toEqual(['Install deps']);
  });

  test('in the profile name dialog, Ctrl+S creates; a duplicate name refuses it', async () => {
    await openColumnManager('Executing');
    const nameInput = page.locator('[data-testid="profile-name-input"]');

    await boardManager().locator('[data-testid="board-manager-profile-new"]').click();
    await nameInput.fill('Simple');
    await page.keyboard.press('Control+S');
    await expect(nameInput).toBeHidden({ timeout: 5000 });
    await expect(boardManager()).toBeVisible();

    // A second profile with the same name: Create is disabled, and the key does
    // nothing but is still consumed. The error proves the first press created.
    await boardManager().locator('[data-testid="board-manager-profile-new"]').click();
    await nameInput.fill('Simple');
    await expect(page.locator('[data-testid="profile-name-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-name-confirm"]')).toBeDisabled();

    expect(await dispatchControlS(nameInput)).toBe(false);

    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('Simple');
    await expect(boardManager()).toBeVisible();
  });

  test('a dialog already closing ignores the key, so Escape then Ctrl+S does not create', async () => {
    await openColumnManager('Executing');
    const nameInput = page.locator('[data-testid="profile-name-input"]');
    await boardManager().locator('[data-testid="board-manager-profile-new"]').click();
    await nameInput.fill('Fading');

    // Escape starts the exit animation, which ends within useOverlayPhase's 300ms
    // fallback. Both keys go in one script so the Ctrl+S lands inside that window:
    // two frames after Escape the exiting phase has committed, and the content
    // carries its exit class.
    const result = await nameInput.evaluate(async (input) => {
      const dialogContent = input.closest('[data-base-dialog]')?.firstElementChild;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const exiting = dialogContent?.classList.contains('overlay-content-out') ?? false;
      const notConsumed = input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      return { exiting, consumed: !notConsumed };
    });
    expect(result).toEqual({ exiting: true, consumed: true });
    await expect(nameInput).toBeHidden({ timeout: 5000 });

    // Nothing was created: the same name is free.
    await boardManager().locator('[data-testid="board-manager-profile-new"]').click();
    await nameInput.fill('Fading');
    await expect(page.locator('[data-testid="profile-name-confirm"]')).toBeEnabled();
    await expect(page.locator('[data-testid="profile-name-error"]')).toHaveCount(0);

    // Positive control: on an open dialog the same key creates it.
    await page.keyboard.press('Control+S');
    await expect(nameInput).toBeHidden({ timeout: 5000 });
    await boardManager().locator('[data-testid="board-manager-profile-new"]').click();
    await nameInput.fill('Fading');
    await expect(page.locator('[data-testid="profile-name-error"]')).toBeVisible();
  });
});

test.describe('Workflow agent prompt editor', () => {
  const settingsPanel = () => page.locator('[data-testid="settings-panel"]');
  const promptDialog = () => page.locator('[data-testid="workflow-agent-prompt-dialog"]');
  const promptDialogField = () => page.locator('[data-testid="workflow-agent-prompt-dialog-field"]');

  function storedPrompt(): Promise<string | null> {
    return page.evaluate(async () => {
      const config = await window.electronAPI.config.getGlobal();
      return config.workflows?.agentPrompt ?? null;
    });
  }

  /** From an open Settings panel: Workflows tab, then the card's Expand. */
  async function expandPromptEditor(): Promise<void> {
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await page.locator('[data-testid="workflow-agent-prompt-expand"]').click();
    await expect(promptDialog()).toBeVisible();
  }

  test('Ctrl+S saves the prompt and closes the editor, leaving Settings open', async () => {
    await page.locator('[data-testid="settings-button"]').click();
    await expect(settingsPanel()).toBeVisible();
    await expandPromptEditor();
    expect(await storedPrompt()).toBeNull();
    await promptDialogField().fill('Plan it small, then press the key.');

    await page.keyboard.press('Control+S');

    await expect(promptDialog()).toBeHidden({ timeout: 5000 });
    await expect.poll(storedPrompt).toBe('Plan it small, then press the key.');
    await expect(settingsPanel()).toBeVisible();
  });

  test('opened over Settings over New Task, the editor saves and New Task does not submit', async () => {
    await openNewTask();
    await newTaskTitle().fill('Two Layers Down');
    await newTaskDialog().locator('[data-testid="task-advanced-toggle"]').click();
    await newTaskDialog().locator('[data-testid="task-agent-edit"]').click();
    await expect(settingsPanel()).toBeVisible();
    await expandPromptEditor();
    await promptDialogField().fill('Saved from the top of the stack.');
    await watchFormSubmits();

    await page.keyboard.press('Control+S');

    // The editor, topmost, saved and closed. New Task, two layers down, did not
    // submit. That it consumes the key is pinned by the Settings case above.
    await expect(promptDialog()).toBeHidden({ timeout: 5000 });
    await expect.poll(storedPrompt).toBe('Saved from the top of the stack.');
    expect(await formSubmitCount()).toBe(0);
    await expect(settingsPanel()).toBeVisible();
    await expect(newTaskTitle()).toHaveValue('Two Layers Down');
    expect(await storedTaskTitles()).toEqual([]);
  });
});

test.describe('Connect Asana', () => {
  // A synthetic token in Asana's PAT shape, not a real credential.
  const SAMPLE_TOKEN = '1/12345678901234:abcdefghijklmnopqrstuvwxyz1234567890';

  async function openAsanaSetup(): Promise<Locator> {
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="import-sources-btn"]').first().click();
    await page.locator('[data-testid="add-import-source-btn"]').first().click();
    await page.getByRole('button', { name: /Asana/ }).click();
    const dialog = page.locator('[data-testid="asana-setup-dialog"]');
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('Ctrl+S connects, as the Connect button does', async () => {
    const dialog = await openAsanaSetup();
    await page.locator('[data-testid="asana-setup-pat-input"]').fill(SAMPLE_TOKEN);

    await page.keyboard.press('Control+S');

    await expect(dialog).toBeHidden({ timeout: 5000 });
    await expect(page.locator('[data-testid="import-source-url-input"]')).toBeVisible();
  });

  test('with no token the key is consumed and does not try to connect', async () => {
    const dialog = await openAsanaSetup();
    const tokenInput = page.locator('[data-testid="asana-setup-pat-input"]');
    await tokenInput.fill('   ');
    await expect(page.locator('[data-testid="asana-setup-save-btn"]')).toBeDisabled();

    expect(await dispatchControlS(tokenInput)).toBe(false);
    await settleFrames(page);

    // An ungated save would answer a blank token with this error before it
    // reached the service, and nothing else here shows it.
    await expect(page.locator('[data-testid="asana-setup-error"]')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="import-source-url-input"]')).toBeHidden();

    // Positive control: a real token lifts the block, and the same key connects.
    await tokenInput.fill(SAMPLE_TOKEN);
    await page.keyboard.press('Control+S');
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });
});
