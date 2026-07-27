import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, createTask, waitForViteReady } from './helpers';
import type { Browser, Locator, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_NAME = `TaskOverrides Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openNewTaskDialog() {
  const column = page.locator('[data-swimlane-name="To Do"]');
  await column.locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

async function closeDialog() {
  await page.keyboard.press('Escape');
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
}

/**
 * Close a New Task dialog whose form is DIRTY, clearing the discard confirm on
 * the way out.
 *
 * Selecting the Agent Override branch is itself a change - it persists as
 * `run_mode`, so the branch survives a save even with all four fields left on
 * inherit - which means it counts toward `isDirty` and Escape prompts. Any test
 * that expands Advanced therefore closes through here, not `closeDialog`.
 */
async function discardDialog(target: Page) {
  await target.keyboard.press('Escape');
  await target.locator('button:has-text("Discard")').click();
  await target.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
}

/**
 * Open a closed-enumeration Combobox (Agent/Effort/Permission - see
 * src/renderer/components/dialogs/Combobox.tsx) and click a specific option
 * by its exact value (not label - Agent/Permission display a friendly label
 * that differs from the stored value, e.g. "Codex CLI" -> "codex").
 */
async function selectCombobox(target: Page, testId: string, optionValue: string) {
  await target.locator(`input[data-testid="${testId}"]`).click();
  await target.locator(`[data-testid="${testId}-option-${optionValue}"]`).click();
}

test.describe('NewTaskDialog Advanced section', () => {
  test('Agent Override is offered as the unselected half of the run-mode choice', async () => {
    await openNewTaskDialog();

    // "How this task runs" is one either/or: Column Settings (the default) or
    // Agent Override. The two are mutually exclusive in storage, so the UI is a
    // radio group rather than two independently-settable controls.
    const toggle = page.locator('[data-testid="task-advanced-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('[data-testid="task-run-mode-profile"]')).toBeChecked();

    // The override fields stay hidden until that branch is chosen.
    await expect(page.locator('[data-testid="task-advanced-section"]')).not.toBeVisible();

    await closeDialog();
  });

  test('with no saved profiles the Profile picker shows Default, disabled, beside an edit button', async () => {
    await openNewTaskDialog();

    // The branch is named for the mechanism (the board's column configuration);
    // Profile is the variant selector inside it.
    await expect(page.locator('[data-testid="task-run-mode-profile"]')).toContainText('Column Settings');

    // Disabled rather than hidden: it shows the concept exists and that Default
    // is what this task will use. The edit button beside it is the only route to
    // authoring, so it stays enabled even with nothing to pick yet.
    const select = page.locator('[data-testid="task-profile-select"]');
    await expect(select).toBeDisabled();
    expect(await select.locator('option').allTextContents()).toEqual(['Default']);
    await expect(page.locator('[data-testid="task-profile-edit"]')).toBeEnabled();

    await closeDialog();
  });

  test('the profile edit button opens the Board Manager over the dialog, and Escape closes only that', async () => {
    await openNewTaskDialog();
    await page.locator('input[placeholder="Task title"]').fill('Draft Survives Task');

    await page.locator('[data-testid="task-profile-edit"]').click();
    const boardManager = page.locator('text=Edit Columns').first();
    await expect(boardManager).toBeVisible();

    // The New Task dialog suppresses its own Escape while the manager is over it.
    // Without that, this keypress would reach the capture-phase panel.close first
    // and raise the discard confirm over a draft the user never tried to abandon.
    await page.keyboard.press('Escape');
    await expect(boardManager).toBeHidden();
    await expect(page.locator('input[placeholder="Task title"]')).toHaveValue('Draft Survives Task');
    await expect(page.locator('button:has-text("Discard")')).toHaveCount(0);

    // Now that the manager is gone, Escape reaches the dialog again.
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('with one agent detected the Agent picker renders locked, beside an enabled edit button', async () => {
    await openNewTaskDialog();
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    // Disabled rather than hidden (the Profile select's treatment one card up):
    // the field still names the agent this task will run on, and it keeps the
    // edit pencil in the same place it occupies on a multi-agent machine.
    const agentInput = page.locator('input[data-testid="task-agent-override"]');
    await expect(agentInput).toBeVisible();
    await expect(agentInput).toBeDisabled();
    await expect(agentInput).toHaveAttribute('placeholder', 'Claude Code');

    // Three-state tooltip on the field wrapper (agentFieldTitle): with exactly
    // one agent detected this must be the "install another" copy, not the
    // "none detected yet" copy the zero-agent fixture gets below - a single
    // fixed string for both non-pickable states would be silently wrong here.
    await expect(page.locator('[data-testid="task-agent-field"]')).toHaveAttribute(
      'title',
      'Only one agent CLI detected - install another to choose',
    );

    // The pencil is the card's only route to Settings > Agent, so it stays live
    // even while the field beside it is locked.
    await expect(page.locator('[data-testid="task-agent-edit"]')).toBeEnabled();

    await discardDialog(page);
  });

  test('the agent edit button opens Settings on the Agent tab over the dialog, and Escape closes only that', async () => {
    await openNewTaskDialog();
    await page.locator('input[placeholder="Task title"]').fill('Draft Survives Settings');
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    await page.locator('[data-testid="task-agent-edit"]').click();
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();
    // The tab buttons carry no testid, so assert on the Agent tab's own
    // section header - it holds the four defaults this card falls back to.
    await expect(settingsPanel.locator('text=Project Defaults')).toBeVisible();

    // The New Task dialog suppresses its own Escape while Settings is over it.
    // Without that, this keypress would also reach the dialog and raise the
    // discard confirm over a draft the user never tried to abandon.
    await page.keyboard.press('Escape');
    await expect(settingsPanel).toBeHidden();
    await expect(page.locator('input[placeholder="Task title"]')).toHaveValue('Draft Survives Settings');
    await expect(page.locator('button:has-text("Discard")')).toHaveCount(0);

    // Two presses, not one: Settings closes through useOverlayPhase, so
    // `settingsOpen` (and the suppression it drives) survives until the exit
    // animation ends. The retrying assertion above is what makes this second
    // press land after suppression lifts.
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('the agent edit button opens Settings scoped to THIS project, so a picked default actually persists', async () => {
    // Distinct failure mode from the visibility test above: `openSettingsToTab`
    // (the sibling action on config-store.ts) never sets `projectSettingsPath`,
    // and `updateProjectOverride` returns early when that path is null - so
    // swapping the pencil's call from `openProjectSettings` to
    // `openSettingsToTab('agent')` would open the SAME-LOOKING Agent tab (the
    // "Project Defaults" header above renders unconditionally from
    // project-store's currentProject, not from projectSettingsPath) while
    // silently dropping every write made from it. Permission Mode
    // (agent.permissionMode, scope: 'project' in settings-registry.ts) is the
    // concrete probe: prove the pick lands in THIS project's stored overrides,
    // not just that the combobox's own on-screen value changed.
    await openNewTaskDialog();
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    await page.locator('[data-testid="task-agent-edit"]').click();
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();

    const permissionInput = page.locator('input[data-testid="agent-permission-mode"]');
    await selectCombobox(page, 'agent-permission-mode', 'plan');
    await expect(permissionInput).toHaveValue('Plan (Read-Only)');

    const persistedPermissionMode = await page.evaluate(async () => {
      const stores = (window as unknown as {
        __zustandStores?: { project: { getState: () => { currentProject: { path: string } | null } } };
      }).__zustandStores;
      const projectPath = stores?.project.getState().currentProject?.path;
      if (!projectPath) throw new Error('No current project to read overrides for');
      const overrides = await window.electronAPI.config.getProjectOverridesByPath(projectPath);
      return (overrides as { agent?: { permissionMode?: string } } | null)?.agent?.permissionMode ?? null;
    });
    expect(persistedPermissionMode).toBe('plan');

    // Reset to the fixture's original value before closing: the Permission
    // picker test below (and the placeholderVariant block further down) both
    // assert the Accept Edits global default resolves through, and a leaked
    // project override here would make that read this project's now-pinned
    // 'plan' instead.
    await selectCombobox(page, 'agent-permission-mode', 'acceptEdits');
    await expect(permissionInput).toHaveValue('Accept Edits');

    await page.keyboard.press('Escape');
    await expect(settingsPanel).toBeHidden();
    await discardDialog(page);
  });

  test('the panel.close hotkey (Control+Shift+W) is suppressed while Settings is open over the dialog, same as Escape', async () => {
    // Escape and panel.close are TWO SEPARATE mechanisms here: Escape is
    // suppressed ad hoc inside BaseDialog via `suppressEscape` (covered above),
    // while panel.close is the Mod+Shift+W keybinding bound directly on
    // NewTaskDialog with its own `enabled: !boardManagerOpen && !settingsOpen`
    // gate. Deleting just the `&& !settingsOpen` half of that gate would leave
    // every Escape assertion in this file green while this combo still tore
    // the dialog down (or worse, raised the discard confirm) out from under
    // the Settings panel it opened.
    await openNewTaskDialog();
    await page.locator('input[placeholder="Task title"]').fill('Draft Survives Panel Close Hotkey');
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    await page.locator('[data-testid="task-agent-edit"]').click();
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();

    await page.keyboard.press('Control+Shift+W');

    // With the listener correctly disabled, this keypress reaches nothing: the
    // panel stays up, and the dialog underneath neither closes nor raises the
    // discard confirm.
    await expect(settingsPanel).toBeVisible();
    await expect(page.locator('input[placeholder="Task title"]')).toHaveValue('Draft Survives Panel Close Hotkey');
    await expect(page.locator('button:has-text("Discard")')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(settingsPanel).toBeHidden();
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('expanding Advanced reveals model combobox and effort select with a resolved-default placeholder', async () => {
    await openNewTaskDialog();

    await page.locator('[data-testid="task-advanced-toggle"]').click();

    // Effort: same closed-enumeration Combobox widget Model uses (opens on
    // click/focus, typing filters, a click commits the pick).
    const effortRow = page.locator('div:has(> input[data-testid="task-effort-override"])');
    const effortInput = page.locator('input[data-testid="task-effort-override"]');
    await expect(effortInput).toBeVisible();
    await expect(effortInput).toHaveAttribute('placeholder', 'Agent default');
    await effortInput.click();
    const effortOptions = page.locator('[data-combobox-option]');
    await expect(effortOptions.first()).toBeVisible();
    const effortOptionTexts = await effortOptions.allTextContents();
    expect(effortOptionTexts).toEqual(expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'max']));
    // Close via the chevron toggle, NOT Escape: the form isn't dirty yet (no
    // field has been picked), so Escape would bubble past the dropdown and
    // trip NewTaskDialog's close-on-Escape guard, tearing down the whole
    // dialog instead of just this popover (see the identical pitfall called
    // out in the "Model dropdown open triggers a rescan" test below).
    await effortRow.locator('button[title="Close dropdown"]').click();
    await expect(effortOptions.first()).not.toBeVisible();

    // Model: free-text combobox seeded by `useKnownModels` (capabilities.models
    // union discoveredModelsByAgent cache). Empty value shows the resolved
    // fallback (column override -> project default -> agent default; this
    // fixture has neither of the first two set, so plain "Agent default" -
    // a concrete fallback would show that bare value, muted, instead);
    // focusing the input reveals the suggestion list.
    const modelRow = page.locator('div:has(> input[data-testid="task-model-override"])');
    const modelInput = page.locator('input[data-testid="task-model-override"]');
    await expect(modelInput).toBeVisible();
    await expect(modelInput).toHaveAttribute('placeholder', 'Agent default');
    await modelInput.click();
    const modelOptions = page.locator('[data-model-option]');
    await expect(modelOptions.first()).toBeVisible();
    const modelOptionTexts = await modelOptions.allTextContents();
    expect(modelOptionTexts).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));
    await modelRow.locator('button[title="Close dropdown"]').click();

    await discardDialog(page);
  });

  test('Permission picker shows a bare, muted inherit placeholder with no clear button until a value is picked', async () => {
    await openNewTaskDialog();

    await page.locator('[data-testid="task-advanced-toggle"]').click();

    const permissionRow = page.locator('div:has(> input[data-testid="task-permission-override"])');
    const permissionInput = page.locator('input[data-testid="task-permission-override"]');
    await expect(permissionInput).toBeVisible();
    // Mock fixture's global default permission mode is 'acceptEdits' -> "Accept
    // Edits", shown bare (no "Inherit (...)" framing): the muted weight plus
    // the absent clear-X are the inherited-not-pinned signals.
    await expect(permissionInput).toHaveAttribute('placeholder', 'Accept Edits');
    await expect(permissionRow.locator('button[title="Clear"]')).toHaveCount(0);

    await permissionInput.click();
    const permissionOptions = page.locator('[data-combobox-option]');
    await expect(permissionOptions.first()).toBeVisible();
    await page.locator('[data-testid="task-permission-override-option-plan"]').click();

    // A concrete pick shows the bare value at full weight with a visible clear button.
    await expect(permissionInput).toHaveValue('Plan (Read-Only)');
    await expect(permissionRow.locator('button[title="Clear"]')).toBeVisible();

    // The form is now dirty (a real override was committed): Escape opens the discard confirm.
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('selected overrides persist on the created task row', async () => {
    await openNewTaskDialog();

    await page.locator('input[placeholder="Task title"]').fill('Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    // Pick a model via the combobox suggestion list
    await page.locator('input[data-testid="task-model-override"]').click();
    await page.locator('[data-model-option]:has-text("opus")').click();

    await selectCombobox(page, 'task-effort-override', 'high');
    await selectCombobox(page, 'task-permission-override', 'plan');

    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Override Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('opus');
    expect(task!.effort_override).toBe('high');
    expect(task!.permission_mode).toBe('plan');
  });

  test('leaving overrides on column default omits them from the row', async () => {
    await openNewTaskDialog();

    await page.locator('input[placeholder="Task title"]').fill('Default Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    // Don't change any select - keep "Inherit"

    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Default Override Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBeNull();
    expect(task!.effort_override).toBeNull();
    expect(task!.permission_mode).toBeNull();
  });
});

test.describe('TaskDetailEditForm Advanced section (edit-mode overrides)', () => {
  test('Advanced section is available in edit mode when the task has no live session', async () => {
    await createTask(page, 'Edit Advanced Task');

    const card = page.locator('text=Edit Advanced Task').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // To Do tasks open in edit mode by default. The Advanced section sits
    // inside the edit form so the user can change model/effort before
    // moving the task to a spawning column.
    const toggle = page.locator('[data-testid="task-advanced-toggle"]');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('[data-testid="task-advanced-section"]')).toBeVisible();
    await expect(page.locator('input[data-testid="task-model-override"]')).toBeVisible();

    // Close without saving
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('a To Do task opens with its run-mode controls reachable without scrolling', async () => {
    // The how-this-task-runs cards sit at the BOTTOM of the edit form, so any
    // growth above them pushes them under the fold - and a control you have to
    // scroll to find on every open is one users stop using. The description
    // editor is the elastic element (`flex-1` with a min-height floor); its floor
    // is what decides whether the fields below it fit.
    const column = page.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('No Scroll Task');
    await page.locator('[data-testid="task-description"]').fill(
      'A description long enough to be realistic.\n\n'.repeat(4),
    );
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    await page.locator('text=No Scroll Task').first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const scroller = page.locator('[data-testid="task-detail-edit-scroll"]');
    await expect(page.locator('[data-testid="task-run-mode"]')).toBeVisible();

    // Asserts the BEHAVIOR (does this pane scroll), not a pixel height. An
    // overflow regression is tens of pixels, well clear of the rounding
    // tolerance, so this stays stable across platforms and font stacks.
    const overflow = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(overflow).toBeLessThanOrEqual(8);

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('Advanced section pre-fills from the task and persists changes on save', async () => {
    // Seed via the UI flow (create dialog) so the renderer store hydrates
    // the new row. Set model + effort overrides at create time, then
    // re-open the task and verify the edit-mode Advanced section reflects
    // the saved values.
    const column = page.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Seeded Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    await page.locator('input[data-testid="task-model-override"]').click();
    await page.locator('[data-model-option]:has-text("opus")').click();
    await selectCombobox(page, 'task-effort-override', 'high');
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Re-open the freshly created task
    const card = page.locator('text=Seeded Override Task').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Section opens automatically because the task already has overrides set
    await expect(page.locator('[data-testid="task-advanced-section"]')).toBeVisible();
    await expect(page.locator('input[data-testid="task-model-override"]')).toHaveValue('opus');
    // Effort's value and label are identical strings (no id<->display mapping
    // like models have), so the input's displayed text still equals the raw value.
    await expect(page.locator('input[data-testid="task-effort-override"]')).toHaveValue('high');

    // Change model to sonnet and effort to medium
    const modelInput = page.locator('input[data-testid="task-model-override"]');
    await modelInput.click();
    await modelInput.fill('');
    await page.locator('[data-model-option]:has-text("sonnet")').click();
    await selectCombobox(page, 'task-effort-override', 'medium');

    await page.locator('button:has-text("Save")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });

    const updated = await page.evaluate(async () => {
      const list = await window.electronAPI.tasks.list();
      return list.find((task: { title: string }) => task.title === 'Seeded Override Task');
    });
    expect(updated!.model_override).toBe('sonnet');
    expect(updated!.effort_override).toBe('medium');
  });

  test('the agent edit button opens Settings over the task window, and Escape closes only that', async () => {
    // The task-detail window has its OWN Escape gates (a capture-phase
    // panel.close binding and a bubble-phase listener), separate from
    // BaseDialog's suppressEscape, so the New Task coverage above does not
    // reach this path.
    await createTask(page, 'Window Draft Survives Settings');

    await page.locator('text=Window Draft Survives Settings').first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    await page.locator('[data-testid="task-agent-edit"]').click();
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();
    await expect(settingsPanel.locator('text=Project Defaults')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(settingsPanel).toBeHidden();
    // The window survived, still in edit mode with its run-mode choice intact.
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="task-advanced-section"]')).toBeVisible();
    await expect(page.locator('button:has-text("Discard")')).toHaveCount(0);

    await page.locator('button:has-text("Cancel")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('the panel.close hotkey (Control+Shift+W) is suppressed while Settings is open over the task window, same as Escape', async () => {
    // TaskDetailWindow's OWN panel.close binding (capture-phase, `enabled:
    // isFocused && !boardManagerOpen && !settingsOpen`) is a SEPARATE mechanism
    // from the bubble-phase document Escape listener covered above - deleting
    // just the `&& !settingsOpen` half of that gate would leave the Escape
    // coverage green while this combo still tore the window down (or raised
    // the discard confirm) out from under the Settings panel it opened.
    await createTask(page, 'Window Draft Survives Panel Close Hotkey');

    await page.locator('text=Window Draft Survives Panel Close Hotkey').first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Window Draft Survives Panel Close Hotkey (edited)');
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    await page.locator('[data-testid="task-agent-edit"]').click();
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();

    await page.keyboard.press('Control+Shift+W');

    // With the listener correctly disabled, this keypress reaches nothing: the
    // panel stays up, and the window underneath neither closes nor raises the
    // discard confirm.
    await expect(settingsPanel).toBeVisible();
    await expect(titleInput).toHaveValue('Window Draft Survives Panel Close Hotkey (edited)');
    await expect(page.locator('button:has-text("Discard")')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(settingsPanel).toBeHidden();
    await page.keyboard.press('Escape');
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible();
    await page.locator('button:has-text("Discard")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('clearing an override in edit mode persists the cleared value', async () => {
    // Seed via the UI flow with a model override set.
    const column = page.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Clear Override Task');
    await page.locator('[data-testid="task-advanced-toggle"]').click();
    await page.locator('input[data-testid="task-model-override"]').click();
    await page.locator('[data-model-option]:has-text("haiku")').click();
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Re-open and clear via the combobox's X button (rendered when value is non-empty)
    const card = page.locator('text=Clear Override Task').first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });
    await expect(page.locator('input[data-testid="task-model-override"]')).toHaveValue('haiku');

    await page.locator('button[title="Clear"]').click();
    await expect(page.locator('input[data-testid="task-model-override"]')).toHaveValue('');

    await page.locator('button:has-text("Save")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });

    const updated = await page.evaluate(async () => {
      const list = await window.electronAPI.tasks.list();
      return list.find((task: { title: string }) => task.title === 'Clear Override Task');
    });
    expect(updated!.model_override).toBeNull();
  });
});

/**
 * Agent picker tests use their own browser instance with a multi-agent mock
 * fixture. The default fixture only has Claude `found: true`, so the picker
 * renders locked (nothing to choose between - covered in the shared-page block
 * above). Enabling Codex here gives us two `found` agents, which is what makes
 * it interactive.
 */
test.describe('NewTaskDialog Advanced - Agent picker (multi-agent fixture)', () => {
  let multiBrowser: Browser;
  let multiPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    multiBrowser = await chromium.launch({ headless: true });
    const context = await multiBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    multiPage = await context.newPage();

    // Inject the override BEFORE the mock script so the mock picks it up
    // when defining `agents.list()`.
    await multiPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        codex: {
          found: true,
          path: '/usr/bin/codex',
          version: '1.0.0',
          capabilities: {
            supportsModelOverride: true,
            models: ['gpt-5', 'gpt-5-mini'],
          },
        },
      };
    });
    await multiPage.addInitScript({ path: MOCK_SCRIPT });
    await multiPage.goto(VITE_URL);
    await multiPage.waitForLoadState('load');
    await multiPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(multiPage, `MultiAgent ${Date.now()}`);
  });

  test.afterAll(async () => {
    await multiBrowser?.close();
  });

  async function openDialog() {
    const column = multiPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await multiPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  // `openDialog` above always expands Advanced, so every dialog in this
  // describe is dirty (the branch itself persists as run_mode) and closes
  // through the discard confirm.
  async function closeDialog() {
    await discardDialog(multiPage);
  }

  test('Agent dropdown lists every found agent with a resolved-default option', async () => {
    await openDialog();

    const agentInput = multiPage.locator('input[data-testid="task-agent-override"]');
    await expect(agentInput).toBeVisible();
    // Two found agents, so this one is interactive (the single-agent fixture
    // renders the same field disabled).
    await expect(agentInput).toBeEnabled();
    // The interactive branch of the three-state tooltip - distinct copy from
    // both non-pickable states (single-agent and zero-agent fixtures).
    await expect(multiPage.locator('[data-testid="task-agent-field"]')).toHaveAttribute(
      'title',
      'The agent CLI this task runs on',
    );
    // The edit pencil rides the same row here as it does when the field is
    // locked - one place on every machine.
    await expect(multiPage.locator('[data-testid="task-agent-edit"]')).toBeEnabled();

    // No column or project agent override is set in this fixture, so the
    // inherit placeholder resolves to the app default (Claude Code), shown
    // bare and muted - no "Inherit (...)" framing.
    await expect(agentInput).toHaveAttribute('placeholder', 'Claude Code');

    await agentInput.click();
    const optionTexts = await multiPage.locator('[data-combobox-option]').allTextContents();
    expect(optionTexts).toEqual(expect.arrayContaining(['Claude Code', 'Codex CLI']));

    // One Escape, not two: the dialog's binding is capture-phase, so it reaches
    // the dirty guard past the open dropdown and raises the confirm directly. A
    // second Escape would dismiss that confirm instead of the dropdown.
    await closeDialog();
  });

  test('picking a different agent re-filters the model list and resets the model + effort state', async () => {
    await openDialog();

    // Pick a Claude model first
    await multiPage.locator('input[data-testid="task-model-override"]').click();
    await multiPage.locator('[data-model-option]:has-text("opus")').click();

    // Switch agent to Codex
    await selectCombobox(multiPage, 'task-agent-override', 'codex');

    // Model state was reset (Codex doesn't have 'opus')
    const modelInput = multiPage.locator('input[data-testid="task-model-override"]');
    await expect(modelInput).toHaveValue('');

    // The combobox now shows Codex's models
    await modelInput.click();
    const codexOptionTexts = await multiPage.locator('[data-model-option]').allTextContents();
    expect(codexOptionTexts).toEqual(expect.arrayContaining(['gpt-5', 'gpt-5-mini']));
    expect(codexOptionTexts).not.toContain('opus');

    // Escape closes the suggestion popover and (the form is dirty) opens the
    // discard confirm; Discard then closes the dialog.
    await multiPage.keyboard.press('Escape');
    await multiPage.locator('button:has-text("Discard")').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('selected agent persists on the created task row as agent_override', async () => {
    await openDialog();

    await multiPage.locator('input[placeholder="Task title"]').fill('Agent Override Task');
    await selectCombobox(multiPage, 'task-agent-override', 'codex');
    await multiPage.locator('input[data-testid="task-model-override"]').click();
    await multiPage.locator('[data-model-option]:has-text("gpt-5-mini")').click();

    await multiPage.locator('button[type="submit"]:has-text("Create")').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await multiPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Agent Override Task');
    expect(task).toBeDefined();
    expect(task!.agent_override).toBe('codex');
    expect(task!.model_override).toBe('gpt-5-mini');
  });

  test('leaving agent on column default omits agent_override from the row', async () => {
    await openDialog();

    await multiPage.locator('input[placeholder="Task title"]').fill('No Agent Override Task');
    // Don't touch the agent dropdown

    await multiPage.locator('button[type="submit"]:has-text("Create")').click();
    await multiPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await multiPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'No Agent Override Task');
    expect(task).toBeDefined();
    expect(task!.agent_override).toBeNull();
  });
});

/**
 * Zero agents detected: `canPickAgent` is false the same way it is with
 * exactly one agent installed, but `agentFieldTitle`'s ternary in
 * AdvancedOverridesSection has a THIRD branch for this case ("no agent CLI
 * detected yet" vs "only one agent CLI detected"). Own browser instance,
 * same recipe as the multi-agent block above: the override must be injected
 * before the mock script runs, and every non-Claude agent already defaults
 * to `found: false` in the fixture, so overriding Claude alone is enough to
 * empty `availableAgents`.
 */
test.describe('NewTaskDialog Advanced - Agent picker (no agent detected fixture)', () => {
  let noAgentBrowser: Browser;
  let noAgentPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    noAgentBrowser = await chromium.launch({ headless: true });
    const context = await noAgentBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    noAgentPage = await context.newPage();

    await noAgentPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        claude: { found: false, path: null, version: null },
      };
    });
    await noAgentPage.addInitScript({ path: MOCK_SCRIPT });
    await noAgentPage.goto(VITE_URL);
    await noAgentPage.waitForLoadState('load');
    await noAgentPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(noAgentPage, `NoAgent ${Date.now()}`);
  });

  test.afterAll(async () => {
    await noAgentBrowser?.close();
  });

  test('with no agent detected the Agent picker renders locked with "none detected" copy, distinct from the single-agent case', async () => {
    const column = noAgentPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await noAgentPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await noAgentPage.locator('[data-testid="task-advanced-toggle"]').click();

    // Same disabled treatment as the single-agent fixture (nothing to pick
    // between either way), but the copy must differ - this is the state the
    // single fixed "install another" string would silently mislabel.
    const agentInput = noAgentPage.locator('input[data-testid="task-agent-override"]');
    await expect(agentInput).toBeVisible();
    await expect(agentInput).toBeDisabled();
    await expect(noAgentPage.locator('[data-testid="task-agent-field"]')).toHaveAttribute(
      'title',
      'No agent CLI detected yet',
    );

    // The pencil is still the only route to Settings > Agent, so it stays
    // live even with nothing installed - same as the single-agent case.
    await expect(noAgentPage.locator('[data-testid="task-agent-edit"]')).toBeEnabled();

    await discardDialog(noAgentPage);
  });
});

/**
 * Grouped model dropdown tests use their own browser instance with a fixture
 * whose model list contains the duplicate spellings real Claude transcripts
 * produce: a bare alias, its [1m] context-window variant, a dated pinned
 * build, AND a superseded generation (`claude-opus-4-7`, older than the
 * `claude-opus-4-8` also present). The combobox must collapse the base-model
 * duplicates to one row, demote the superseded generation alongside the
 * dated pin into "Older versions", and label every row from the
 * adapter-provided `modelDisplayNames` map (falling back to the raw id)
 * while every selectable value stays the exact discovered string (the spawn
 * value).
 */
test.describe('NewTaskDialog Advanced - grouped model dropdown (suffixed fixture)', () => {
  let groupedBrowser: Browser;
  let groupedPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    groupedBrowser = await chromium.launch({ headless: true });
    const context = await groupedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    groupedPage = await context.newPage();

    await groupedPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        claude: {
          capabilities: {
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsModelOverride: true,
            models: [
              'claude-haiku-4-5',
              'claude-haiku-4-5-20251001',
              'claude-opus-4-7',
              'claude-opus-4-8',
              'claude-opus-4-8[1m]',
            ],
            // Mirrors what the Claude adapter's discoverCapabilities()
            // populates via humanizeClaudeModelId(): the headless mock does
            // not run real main-process discovery, so this must be supplied
            // explicitly or every row falls back to its raw id.
            modelDisplayNames: {
              'claude-haiku-4-5': 'Haiku 4.5',
              'claude-haiku-4-5-20251001': 'Haiku 4.5',
              'claude-opus-4-7': 'Opus 4.7',
              'claude-opus-4-8': 'Opus 4.8',
              'claude-opus-4-8[1m]': 'Opus 4.8 (1M)',
            },
          },
        },
      };
    });
    await groupedPage.addInitScript({ path: MOCK_SCRIPT });
    await groupedPage.goto(VITE_URL);
    await groupedPage.waitForLoadState('load');
    await groupedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(groupedPage, `GroupedModels ${Date.now()}`);
  });

  test.afterAll(async () => {
    await groupedBrowser?.close();
  });

  async function openDialog() {
    const column = groupedPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await groupedPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  // Same as the agent-picker describe: `openDialog` expands Advanced, so every
  // dialog here is dirty and closes through the discard confirm.
  async function closeDialog() {
    await discardDialog(groupedPage);
  }

  test('collapses variants to one humanized row per current-generation model, demoting the superseded generation and the dated pin', async () => {
    await openDialog();

    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    const optionTexts = await groupedPage.locator('[data-model-option]').allTextContents();
    // One primary row per current-generation base model, humanized. The [1m]
    // variant never gets its own row; the older Opus 4.7 generation and the
    // dated Haiku pin are demoted, so they are not present while collapsed.
    expect(optionTexts).toEqual(['Haiku 4.5', 'Opus 4.8']);

    // The opus row carries an always-visible 1M chip.
    await expect(groupedPage.locator('[data-model-1m]')).toHaveCount(1);

    // Opus 4.7 (superseded) and the dated Haiku pin sit behind a collapsed
    // "Older versions" toggle.
    const olderToggle = groupedPage.locator('[data-model-pinned-toggle]');
    await expect(olderToggle).toHaveText(/Older versions \(2\)/);
    await expect(groupedPage.locator('[data-model-pinned-option]')).toHaveCount(0);
    await expect(groupedPage.locator('[title="claude-opus-4-7"]')).toHaveCount(0);

    // One Escape, not two: the dialog's binding is capture-phase, so it reaches
    // the dirty guard past the open dropdown and raises the confirm directly. A
    // second Escape would dismiss that confirm instead of the dropdown.
    await closeDialog();
  });

  test('clicking the 1M chip persists the exact [1m] string', async () => {
    await openDialog();

    await groupedPage.locator('input[placeholder="Task title"]').fill('One Million Task');
    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    await groupedPage.locator('[data-model-1m]').click();
    // The closed input shows the committed value's friendly label (from the
    // fixture's modelDisplayNames), not the raw spawn id - matches the
    // dropdown row and the inherited-default placeholder.
    await expect(groupedPage.locator('input[data-testid="task-model-override"]')).toHaveValue('Opus 4.8 (1M)');

    await groupedPage.locator('button[type="submit"]:has-text("Create")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await groupedPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'One Million Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('claude-opus-4-8[1m]');
  });

  test('expanding Older versions and selecting the dated pin persists the exact dated string, humanized with its date', async () => {
    await openDialog();

    await groupedPage.locator('input[placeholder="Task title"]').fill('Pinned Build Task');
    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    await groupedPage.locator('[data-model-pinned-toggle]').click();
    // The dated pin's row is humanized but keeps its date appended (the
    // humanizer drops the date, so it is re-appended generically); the raw
    // id is still selectable via its title attribute.
    const pinnedRow = groupedPage.locator('[data-model-pinned-option][title="claude-haiku-4-5-20251001"]');
    await expect(pinnedRow).toHaveText('Haiku 4.5 · 2025-10-01');
    await pinnedRow.click();
    // Closed input shows the same humanized-with-date label as the row did,
    // not the raw dated id.
    await expect(groupedPage.locator('input[data-testid="task-model-override"]')).toHaveValue('Haiku 4.5 · 2025-10-01');

    await groupedPage.locator('button[type="submit"]:has-text("Create")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await groupedPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Pinned Build Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('claude-haiku-4-5-20251001');
  });

  test('expanding Older versions and selecting the superseded generation persists its exact id', async () => {
    await openDialog();

    await groupedPage.locator('input[placeholder="Task title"]').fill('Older Generation Task');
    await groupedPage.locator('input[data-testid="task-model-override"]').click();
    await groupedPage.locator('[data-model-pinned-toggle]').click();
    const olderOpusRow = groupedPage.locator('[data-model-option][title="claude-opus-4-7"]');
    await expect(olderOpusRow).toHaveText('Opus 4.7');
    await olderOpusRow.click();
    // Closed input shows the friendly label, not the raw superseded id.
    await expect(groupedPage.locator('input[data-testid="task-model-override"]')).toHaveValue('Opus 4.7');

    await groupedPage.locator('button[type="submit"]:has-text("Create")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await groupedPage.evaluate(() => window.electronAPI.tasks.list());
    const task = taskData.find((t: { title: string }) => t.title === 'Older Generation Task');
    expect(task).toBeDefined();
    expect(task!.model_override).toBe('claude-opus-4-7');
  });

  test('a query that only matches a demoted row auto-expands the Older versions section', async () => {
    await openDialog();

    const modelInput = groupedPage.locator('input[data-testid="task-model-override"]');
    await modelInput.click();
    await modelInput.fill('20251001');

    // No primary row matches, so the section opens by itself and the dated
    // build is selectable without touching the toggle.
    await expect(groupedPage.locator('[data-model-pinned-option]')).toHaveText(['Haiku 4.5 · 2025-10-01']);
    await groupedPage.locator('[data-model-pinned-option]').click();
    // Closed input shows the humanized-with-date label, not the raw dated id.
    await expect(modelInput).toHaveValue('Haiku 4.5 · 2025-10-01');

    // Escape closes the suggestion popover and (the form is dirty) opens the
    // discard confirm; Discard then closes the dialog.
    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('button:has-text("Discard")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('a query matching a superseded generation\'s humanized label (not its raw id) filters to that row and auto-expands', async () => {
    await openDialog();

    const modelInput = groupedPage.locator('input[data-testid="task-model-override"]');
    await modelInput.click();
    // "Opus 4.7" matches ONLY the superseded generation's humanized label
    // (modelRowLabel), not its raw id "claude-opus-4-7" (no dot, no space)
    // and not the current-generation "Opus 4.8" label. This exercises the
    // matchesQuery branch that checks the humanized label, distinct from the
    // raw-id / dated-pin substring matches covered elsewhere.
    await modelInput.fill('Opus 4.7');

    // No primary (current-generation) row matches, so the section auto-opens
    // and the ONLY visible option is the demoted Opus 4.7 generation.
    await expect(groupedPage.locator('[data-model-option]')).toHaveCount(1);
    const supersededRow = groupedPage.locator('[data-model-option][title="claude-opus-4-7"]');
    await expect(supersededRow).toHaveText('Opus 4.7');
    await supersededRow.click();
    // Closed input shows the friendly label, not the raw superseded id.
    await expect(modelInput).toHaveValue('Opus 4.7');

    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('button:has-text("Discard")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('opening the dropdown on a task already set to a superseded generation auto-expands Older versions', async () => {
    await openDialog();

    const titleInput = groupedPage.locator('input[placeholder="Task title"]');
    const modelInput = groupedPage.locator('input[data-testid="task-model-override"]');
    // Simulate an existing selection of the superseded generation (as if the
    // task was created before Opus 4.8 shipped). Close the suggestion popover
    // by clicking elsewhere in the dialog (not Escape, to avoid any ambiguity
    // with the dialog's own Escape-to-discard handling), leaving the value set.
    await modelInput.fill('claude-opus-4-7');
    await titleInput.click();
    // Closed input shows the friendly label for the committed raw id.
    await expect(modelInput).toHaveValue('Opus 4.7');

    // Reopen the dropdown: the section is expanded WITHOUT the user touching
    // the toggle, and the toggle stays visible (still collapsible) since this
    // is value-driven, not the query-driven force-open.
    await modelInput.click();
    await expect(groupedPage.locator('[data-model-pinned-toggle]')).toBeVisible();
    await expect(groupedPage.locator('[data-model-option][title="claude-opus-4-7"]')).toBeVisible();

    // Close the dropdown via an outside click, then discard the dirty form.
    await titleInput.click();
    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('button:has-text("Discard")').click();
    await titleInput.waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('reopening the dropdown on an already-selected model shows the friendly label immediately, with no raw-id flash', async () => {
    await openDialog();

    const modelInput = groupedPage.locator('input[data-testid="task-model-override"]');
    await modelInput.click();
    await groupedPage.locator('[data-model-option][title="claude-haiku-4-5"]').click();
    await expect(modelInput).toHaveValue('Haiku 4.5');

    // Reopen: filterText is empty until the user types, so the open-state
    // display (`filterText || selectedLabel`) falls back to the friendly
    // label - never the raw id - the instant the dropdown opens, before any
    // typing happens.
    await modelInput.click();
    await expect(modelInput).toHaveValue('Haiku 4.5');
    await expect(groupedPage.locator('[data-model-option]').first()).toBeVisible();

    // Close the dropdown via an outside click, then discard the dirty form.
    await groupedPage.locator('input[placeholder="Task title"]').click();
    await groupedPage.keyboard.press('Escape');
    await groupedPage.locator('button:has-text("Discard")').click();
    await groupedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });
});

/**
 * Opening the Model dropdown fires a forced, on-demand agent-list rescan
 * (config-store's `rescanModels()`) so a newly shipped model appears without a
 * Kangentic restart. `rescanModels()` is throttled by a MODULE-SCOPE in-flight
 * lock plus a 60s cooldown, so this block gets its OWN browser instance: every
 * other test in this file also opens `task-model-override`, and reusing a
 * shared page would mean an earlier test silently "spends" the cooldown before
 * these assertions ever run (cross-test state leakage the cooldown itself
 * would then hide, not just slow down).
 */
test.describe('NewTaskDialog Advanced - Model dropdown open triggers a rescan', () => {
  let rescanBrowser: Browser;
  let rescanPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    rescanBrowser = await chromium.launch({ headless: true });
    const context = await rescanBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    rescanPage = await context.newPage();
    await rescanPage.addInitScript({ path: MOCK_SCRIPT });
    await rescanPage.goto(VITE_URL);
    await rescanPage.waitForLoadState('load');
    await rescanPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(rescanPage, `ModelRescan ${Date.now()}`);
  });

  test.afterAll(async () => {
    await rescanBrowser?.close();
  });

  async function openDialog() {
    const column = rescanPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await rescanPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await rescanPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  /**
   * Wrap window.electronAPI.agents.list to record every call's forceRefresh
   * argument. Always wraps the PRISTINE mock implementation (cached in
   * window.__originalAgentsListFn on first use), so re-instrumenting never
   * compounds an earlier call's artificial delay.
   *
   * `delayMs`, when set, holds the mock's resolution back so a test can prove
   * the dropdown paints BEFORE the rescan settles (rescanModels() is
   * fire-and-forget and must never gate the render).
   */
  async function instrumentAgentListCalls(page: Page, delayMs = 0): Promise<void> {
    await page.evaluate(({ delayMs }) => {
      const api = window.electronAPI as unknown as {
        agents: { list: (forceRefresh?: boolean) => Promise<unknown> };
      };
      const globalWindow = window as unknown as {
        __originalAgentsListFn?: (forceRefresh?: boolean) => Promise<unknown>;
      };
      if (!globalWindow.__originalAgentsListFn) {
        globalWindow.__originalAgentsListFn = api.agents.list.bind(api.agents);
      }
      const original = globalWindow.__originalAgentsListFn;
      (window as Record<string, unknown>).__rescanAgentListCalls = {
        callCount: 0,
        forcedCallCount: 0,
      };
      api.agents.list = async function instrumentedList(forceRefresh?: boolean) {
        const state = (window as Record<string, unknown>).__rescanAgentListCalls as {
          callCount: number;
          forcedCallCount: number;
        };
        state.callCount += 1;
        if (forceRefresh === true) state.forcedCallCount += 1;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return original(forceRefresh);
      };
    }, { delayMs });
  }

  async function readAgentListCalls(page: Page): Promise<{ callCount: number; forcedCallCount: number }> {
    return page.evaluate(() => {
      const calls = (window as Record<string, unknown>).__rescanAgentListCalls as
        | { callCount: number; forcedCallCount: number }
        | undefined;
      return calls ?? { callCount: 0, forcedCallCount: 0 };
    });
  }

  test('focusing the model input fires a forced rescan without blocking the dropdown, and a reopen within the cooldown does not fire a second one', async () => {
    await openDialog();

    // Delay the mock's resolution well past any legitimate render time, so the
    // visibility assertion below can only pass if the dropdown renders
    // BEFORE the rescan settles.
    await instrumentAgentListCalls(rescanPage, 1000);

    const modelInput = rescanPage.locator('input[data-testid="task-model-override"]');
    await modelInput.click();

    const modelOptions = rescanPage.locator('[data-model-option]');
    await expect(modelOptions.first()).toBeVisible({ timeout: 500 });

    // The forced rescan call did fire; it just hasn't resolved yet.
    await expect
      .poll(async () => (await readAgentListCalls(rescanPage)).forcedCallCount, {
        timeout: 3000,
        intervals: [100, 100, 200, 300, 500],
      })
      .toBe(1);

    // Close and reopen the dropdown via its own chevron toggle (not Escape):
    // the form has no other field set (isDirty stays false), so Escape would
    // route through NewTaskDialog's close guard and animate-close the WHOLE
    // dialog, not just the suggestion popover. The chevron toggle is a plain
    // mouse click scoped to ModelCombobox's own open/close state, so it
    // exercises the cooldown in isolation from that unrelated close path.
    // Scoped to the model input's own row: Effort/Permission/Agent are the
    // same Combobox widget and render an identically-titled toggle button.
    const modelRow = rescanPage.locator('div:has(> input[data-testid="task-model-override"])');
    const chevronToggle = modelRow.locator('button[title="Close dropdown"]');
    await chevronToggle.click();
    await expect(modelOptions.first()).not.toBeVisible();

    const reopenToggle = modelRow.locator('button[title="Open dropdown"]');
    await reopenToggle.click();
    await expect(modelOptions.first()).toBeVisible();

    // Intentional fixed wait: this asserts a NON-occurrence (no second forced
    // call within the 60s cooldown window), which cannot be expressed as a
    // poll condition.
    await rescanPage.waitForTimeout(500);
    const calls = await readAgentListCalls(rescanPage);
    expect(calls.forcedCallCount).toBe(1);
  });
});

/**
 * The model-dropdown context-window badge is learned entirely from live
 * telemetry (`rememberModelContextWindow`, fed by a real session's
 * status.json) - never hardcoded per model. These specs seed
 * `config.discoveredContextWindowsByAgent` directly via
 * `window.__mockConfigOverrides`, which `mock-electron-api.js` merges into
 * its config object at init (mirroring how the real store persists a
 * learned window), so nothing here asserts a hardcoded context-size
 * assumption - the seeded value IS the expectation. Own browser instance:
 * the override must be injected before the mock script runs, so it cannot
 * be layered onto the shared `page` without restarting the app.
 */
test.describe('NewTaskDialog Advanced - context-window badge (telemetry-learned)', () => {
  let contextWindowBrowser: Browser;
  let contextWindowPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    contextWindowBrowser = await chromium.launch({ headless: true });
    const context = await contextWindowBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    contextWindowPage = await context.newPage();

    await contextWindowPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockConfigOverrides = {
        discoveredContextWindowsByAgent: {
          claude: {
            opus: 1_000_000,
            sonnet: 200_000,
            // haiku intentionally has no observed window: expect no badge.
          },
        },
      };
    });
    await contextWindowPage.addInitScript({ path: MOCK_SCRIPT });
    await contextWindowPage.goto(VITE_URL);
    await contextWindowPage.waitForLoadState('load');
    await contextWindowPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(contextWindowPage, `ContextWindowBadge ${Date.now()}`);
  });

  test.afterAll(async () => {
    await contextWindowBrowser?.close();
  });

  test('badges rows with a learned context window and omits rows with none observed', async () => {
    const column = contextWindowPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await contextWindowPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await contextWindowPage.locator('[data-testid="task-advanced-toggle"]').click();
    await contextWindowPage.locator('input[data-testid="task-model-override"]').click();

    const opusRow = contextWindowPage.locator('[data-model-row]').filter({ hasText: 'opus' });
    await expect(opusRow.locator('[data-model-context-window]')).toHaveText('1M');

    const sonnetRow = contextWindowPage.locator('[data-model-row]').filter({ hasText: 'sonnet' });
    await expect(sonnetRow.locator('[data-model-context-window]')).toHaveText('200K');

    const haikuRow = contextWindowPage.locator('[data-model-row]').filter({ hasText: 'haiku' });
    await expect(haikuRow.locator('[data-model-context-window]')).toHaveCount(0);

    // The dialog's Escape binding is capture-phase, so one press reaches the
    // dirty check past the open dropdown. Expanding Advanced selected the
    // override branch, so that check now prompts.
    await discardDialog(contextWindowPage);
  });
});

/**
 * Companion to the block above: proves the suppression half of the badge
 * rule. A row that already carries a selectable `[1m]` chip must NOT also
 * show the context-window badge (no redundant double "1M"), while a
 * sibling row with a learned window but no `[1m]` chip still badges
 * normally. Own browser + own `__mockAgentListOverrides` fixture (the
 * suffixed-id shape from the grouped-model-dropdown block above), seeded
 * with a learned window for both rows.
 */
test.describe('NewTaskDialog Advanced - context-window badge suppressed by a 1M chip', () => {
  let suppressedBrowser: Browser;
  let suppressedPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    suppressedBrowser = await chromium.launch({ headless: true });
    const context = await suppressedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    suppressedPage = await context.newPage();

    await suppressedPage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        claude: {
          capabilities: {
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsModelOverride: true,
            models: [
              'claude-haiku-4-5',
              'claude-opus-4-8',
              'claude-opus-4-8[1m]',
            ],
          },
        },
      };
      (window as Record<string, unknown>).__mockConfigOverrides = {
        discoveredContextWindowsByAgent: {
          claude: {
            'claude-opus-4-8': 1_000_000,
            'claude-haiku-4-5': 200_000,
          },
        },
      };
    });
    await suppressedPage.addInitScript({ path: MOCK_SCRIPT });
    await suppressedPage.goto(VITE_URL);
    await suppressedPage.waitForLoadState('load');
    await suppressedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(suppressedPage, `ContextWindowSuppressed ${Date.now()}`);
  });

  test.afterAll(async () => {
    await suppressedBrowser?.close();
  });

  test('omits the badge on a row with a selectable 1M chip, but shows it on a row without one', async () => {
    const column = suppressedPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await suppressedPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await suppressedPage.locator('[data-testid="task-advanced-toggle"]').click();
    await suppressedPage.locator('input[data-testid="task-model-override"]').click();

    const opusRow = suppressedPage.locator('[data-model-row]').filter({ hasText: 'claude-opus-4-8' });
    await expect(opusRow.locator('[data-model-1m]')).toHaveCount(1);
    await expect(opusRow.locator('[data-model-context-window]')).toHaveCount(0);

    const haikuRow = suppressedPage.locator('[data-model-row]').filter({ hasText: 'claude-haiku-4-5' });
    await expect(haikuRow.locator('[data-model-context-window]')).toHaveText('200K');

    await discardDialog(suppressedPage);
  });
});

/**
 * A superseded generation demoted into "Older versions" is rendered through
 * the SAME `renderGroupRow` helper as a top-level row (just with `indent:
 * true`), so it can still carry its own telemetry-learned context-window
 * badge. This is a distinct render path from the top-level badge tests above
 * (own browser + fixture, mirroring the grouped-model-dropdown block) since
 * the badge only becomes visible once the "Older versions" section is
 * expanded.
 */
test.describe('NewTaskDialog Advanced - context-window badge on a demoted superseded row', () => {
  let demotedBadgeBrowser: Browser;
  let demotedBadgePage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    demotedBadgeBrowser = await chromium.launch({ headless: true });
    const context = await demotedBadgeBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    demotedBadgePage = await context.newPage();

    await demotedBadgePage.addInitScript(() => {
      (window as Record<string, unknown>).__mockAgentListOverrides = {
        claude: {
          capabilities: {
            effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsModelOverride: true,
            // Opus 4.7 is superseded by Opus 4.8 (both present), so it is
            // demoted into "Older versions".
            models: ['claude-opus-4-7', 'claude-opus-4-8'],
          },
        },
      };
      (window as Record<string, unknown>).__mockConfigOverrides = {
        discoveredContextWindowsByAgent: {
          claude: {
            // Learned window on the DEMOTED generation. Opus 4.8 (the
            // primary, non-demoted row) deliberately has no learned window,
            // so its absence of a badge stays a clean signal.
            'claude-opus-4-7': 200_000,
          },
        },
      };
    });
    await demotedBadgePage.addInitScript({ path: MOCK_SCRIPT });
    await demotedBadgePage.goto(VITE_URL);
    await demotedBadgePage.waitForLoadState('load');
    await demotedBadgePage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(demotedBadgePage, `DemotedContextBadge ${Date.now()}`);
  });

  test.afterAll(async () => {
    await demotedBadgeBrowser?.close();
  });

  test('badges a demoted superseded row from its own learned context window once expanded', async () => {
    const column = demotedBadgePage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await demotedBadgePage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await demotedBadgePage.locator('[data-testid="task-advanced-toggle"]').click();
    await demotedBadgePage.locator('input[data-testid="task-model-override"]').click();

    // Opus 4.8 (primary, top-level) has no learned window: no badge.
    const opus48Row = demotedBadgePage.locator('[data-model-row]').filter({ hasText: 'claude-opus-4-8' });
    await expect(opus48Row.locator('[data-model-context-window]')).toHaveCount(0);

    // The demoted Opus 4.7 row is not rendered until "Older versions" expands.
    await expect(demotedBadgePage.locator('[title="claude-opus-4-7"]')).toHaveCount(0);
    await demotedBadgePage.locator('[data-model-pinned-toggle]').click();

    const opus47Row = demotedBadgePage.locator('[data-model-row]').filter({ hasText: 'claude-opus-4-7' });
    await expect(opus47Row.locator('[data-model-context-window]')).toHaveText('200K');

    await discardDialog(demotedBadgePage);
  });
});

/**
 * The closed-enumeration `Combobox` (Effort/Agent/Permission) is a CLOSED set:
 * unlike `ModelCombobox`'s free-form model ids, typed text is never a valid
 * value by itself. Typing only filters the option list; a selection commits
 * exclusively via a click or an Enter press on a keyboard-focused option
 * button (native button activation). Enter pressed while the INPUT itself is
 * focused (not an option) just closes the popover and reverts the display -
 * it does not commit the typed text. These specs exercise that contract via
 * the Effort field, which is the same `Combobox` widget Agent/Permission use.
 * Own browser instance: the assertions require an undirtied dialog so Escape
 * closes cleanly, and no other test in this file should share that state.
 */
test.describe('Combobox (Effort field) - typing filters, never auto-commits', () => {
  let filterBrowser: Browser;
  let filterPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    filterBrowser = await chromium.launch({ headless: true });
    const context = await filterBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    filterPage = await context.newPage();
    await filterPage.addInitScript({ path: MOCK_SCRIPT });
    await filterPage.goto(VITE_URL);
    await filterPage.waitForLoadState('load');
    await filterPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(filterPage, `ComboboxFilter ${Date.now()}`);
  });

  test.afterAll(async () => {
    await filterBrowser?.close();
  });

  async function openDialog() {
    const column = filterPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await filterPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await filterPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  test('typing filters the option list; clicking away without picking one leaves the value uncommitted', async () => {
    await openDialog();

    const effortInput = filterPage.locator('input[data-testid="task-effort-override"]');
    await effortInput.click();
    await effortInput.fill('xh');

    const options = filterPage.locator('[data-combobox-option]');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveText('xhigh');

    // Click elsewhere in the dialog (the outside-click handler just closes
    // the popover and clears filterText - it never calls onChange), so the
    // typed "xh" never became the committed value.
    await filterPage.locator('input[placeholder="Task title"]').click();
    await expect(effortInput).toHaveValue('');
    await expect(effortInput).toHaveAttribute('placeholder', 'Agent default');

    // No effort was committed, but expanding Advanced selected the override
    // branch, which is itself persisted state - so the form is dirty.
    await discardDialog(filterPage);
  });

  test('pressing Enter while the input itself is focused reverts without committing the typed text', async () => {
    await openDialog();

    const effortInput = filterPage.locator('input[data-testid="task-effort-override"]');
    await effortInput.click();
    await effortInput.fill('not-a-real-effort-level');
    await effortInput.press('Enter');

    await expect(filterPage.locator('[data-combobox-option]')).toHaveCount(0);
    await expect(effortInput).toHaveValue('');
    await expect(effortInput).toHaveAttribute('placeholder', 'Agent default');

    await discardDialog(filterPage);
  });

  test('pressing Enter on a keyboard-focused option commits it, same as a mouse click', async () => {
    await openDialog();

    const effortInput = filterPage.locator('input[data-testid="task-effort-override"]');
    await effortInput.click();
    // ArrowDown moves focus off the input onto the first option button
    // (handleInputKeyDown blurs the input and focuses the first
    // `[data-combobox-option]`).
    await effortInput.press('ArrowDown');
    await filterPage.keyboard.press('Enter');

    await expect(effortInput).toHaveValue('low');
    await expect(filterPage.locator('[data-combobox-option]')).toHaveCount(0);

    // The form is now dirty (a real override was committed); discard on close.
    await filterPage.keyboard.press('Escape');
    await filterPage.locator('button:has-text("Discard")').click();
    await filterPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });
});

/**
 * Structural check for `placeholderVariant`. The prop only changes the
 * placeholder's CSS class (`placeholder-fg-faint` for 'muted' vs
 * `placeholder-fg` for 'resolved' - see Combobox.tsx / ModelCombobox.tsx), so
 * a hover-style assertion is unnecessary here; reading the class list is a
 * reliable, non-flaky structural signal. Covers both the AgentTab call site
 * (Settings > Agent's Default Model/Effort are hardcoded 'muted' - top of the
 * resolution chain) and the AdvancedOverridesSection call site (New Task's
 * Agent/Model/Effort are ALWAYS muted, regardless of whether a concrete
 * fallback exists - only the placeholder TEXT changes, from the generic
 * "Agent default" to the bare resolved value once a project/column default
 * resolves to something concrete. The muted weight plus the absent clear-X
 * are what distinguish an inherited value from one the user actually picked,
 * which is what let a task's Advanced overrides go unset while looking
 * pinned), closing the gap that neither call site had any coverage.
 * Own browser instance: mutates the project's default_model/default_effort,
 * which no other test in this file may observe.
 */
test.describe('placeholderVariant: muted vs resolved', () => {
  let variantBrowser: Browser;
  let variantPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    variantBrowser = await chromium.launch({ headless: true });
    const context = await variantBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    variantPage = await context.newPage();
    await variantPage.addInitScript({ path: MOCK_SCRIPT });
    await variantPage.goto(VITE_URL);
    await variantPage.waitForLoadState('load');
    await variantPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(variantPage, `PlaceholderVariant ${Date.now()}`);
  });

  test.afterAll(async () => {
    await variantBrowser?.close();
  });

  /** Reads which placeholder-weight class is present: 'placeholder-fg-faint'
   *  is the exact muted class; 'resolved' is everything else that carries
   *  the plain 'placeholder-fg' token (checked as a whitespace-delimited
   *  class, not a substring match, since 'placeholder-fg' is itself a
   *  substring of 'placeholder-fg-faint'). */
  async function placeholderVariantOf(input: Locator): Promise<'resolved' | 'muted'> {
    const classAttribute = (await input.getAttribute('class')) ?? '';
    const classes = classAttribute.split(/\s+/);
    if (classes.includes('placeholder-fg-faint')) return 'muted';
    if (classes.includes('placeholder-fg')) return 'resolved';
    throw new Error(`Neither placeholder-weight class found on input: "${classAttribute}"`);
  }

  async function openSettingsAgentTab() {
    await variantPage.locator('[data-testid="settings-button"]').click();
    await variantPage.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await variantPage.getByRole('button', { name: 'Agent', exact: true }).click();
  }

  async function closeSettings() {
    await variantPage.keyboard.press('Escape');
    await variantPage.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
  }

  async function openNewTaskAdvanced() {
    const column = variantPage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await variantPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await variantPage.locator('[data-testid="task-advanced-toggle"]').click();
  }

  // `openNewTaskAdvanced` expands Advanced, which selects the override branch
  // and so marks the form dirty even with nothing typed.
  async function closeNewTaskDialog() {
    await discardDialog(variantPage);
  }

  test('with no project default set, Settings > Agent Default Model/Effort and New Task Advanced Model/Effort are all muted', async () => {
    await openSettingsAgentTab();

    const settingsModelInput = variantPage.locator('input[data-testid="project-default-model"]');
    const settingsEffortInput = variantPage.locator('input[data-testid="project-default-effort"]');
    await expect(settingsModelInput).toHaveAttribute('placeholder', 'Agent default');
    await expect(settingsEffortInput).toHaveAttribute('placeholder', 'Agent default');
    expect(await placeholderVariantOf(settingsModelInput)).toBe('muted');
    expect(await placeholderVariantOf(settingsEffortInput)).toBe('muted');

    await closeSettings();

    await openNewTaskAdvanced();
    const taskModelInput = variantPage.locator('input[data-testid="task-model-override"]');
    const taskEffortInput = variantPage.locator('input[data-testid="task-effort-override"]');

    // Model/Effort have no column or project default here, so their
    // fallback computation bottoms out with no concrete value: plain
    // "Agent default", muted. (Agent's inherit label always resolves to a
    // concrete app default and is muted too; this single-agent fixture
    // renders that field locked on it. Its interactive form is covered in
    // the "Agent picker" describe block above.)
    await expect(taskModelInput).toHaveAttribute('placeholder', 'Agent default');
    await expect(taskEffortInput).toHaveAttribute('placeholder', 'Agent default');
    expect(await placeholderVariantOf(taskModelInput)).toBe('muted');
    expect(await placeholderVariantOf(taskEffortInput)).toBe('muted');

    await closeNewTaskDialog();
  });

  test('setting a project default model/effort shows the bare resolved values as New Task Advanced placeholders, still muted', async () => {
    await openSettingsAgentTab();

    // Pick a project default model (raw id 'opus', no display-name fixture
    // here, so its friendly label equals the raw id).
    await variantPage.locator('input[data-testid="project-default-model"]').click();
    await variantPage.locator('[data-model-option]:has-text("opus")').click();
    await variantPage.locator('input[data-testid="project-default-effort"]').click();
    await variantPage.locator('[data-testid="project-default-effort-option-medium"]').click();

    await closeSettings();

    await openNewTaskAdvanced();
    const taskModelInput = variantPage.locator('input[data-testid="task-model-override"]');
    const taskEffortInput = variantPage.locator('input[data-testid="task-effort-override"]');

    // The inherit placeholder now names the concrete project default as the
    // bare value - muted, since leaving the field alone still means "not
    // pinned"; the muted weight (not any text framing) is the signal.
    await expect(taskModelInput).toHaveAttribute('placeholder', 'opus');
    await expect(taskEffortInput).toHaveAttribute('placeholder', 'medium');
    expect(await placeholderVariantOf(taskModelInput)).toBe('muted');
    expect(await placeholderVariantOf(taskEffortInput)).toBe('muted');

    // Distinguishing guard: while inherited, neither field renders a clear
    // (X) button (its value is still ''). Picking a concrete option shows
    // the bare value in the input AND a visible clear button - the one
    // signal that actually separates "not pinned" from "pinned", since the
    // muted placeholder alone is no longer visible once a value is set.
    const effortRow = variantPage.locator('div:has(> input[data-testid="task-effort-override"])');
    await expect(effortRow.locator('button[title="Clear"]')).toHaveCount(0);
    await selectCombobox(variantPage, 'task-effort-override', 'high');
    await expect(taskEffortInput).toHaveValue('high');
    await expect(effortRow.locator('button[title="Clear"]')).toBeVisible();

    // A real override was committed, so the form is dirty: Escape opens the
    // discard confirm instead of closing directly.
    await variantPage.keyboard.press('Escape');
    await variantPage.locator('button:has-text("Discard")').click();
    await variantPage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });

    // Cleanup: clear both project defaults directly via IPC + a store
    // reload (mirroring AgentTab's own refreshCurrentProject() call), rather
    // than the Combobox clear (X) buttons - clicking Clear on ModelCombobox
    // refocuses its input, which reopens its own suggestion dropdown
    // (handleInputFocus) and then overlaps/intercepts the Effort field's
    // Clear button directly below it in the settings list.
    await variantPage.evaluate(async () => {
      const stores = (window as unknown as {
        __zustandStores?: { project: { getState: () => { currentProject: { id: string } | null; loadCurrent: () => Promise<void> } } };
      }).__zustandStores;
      const projectId = stores?.project.getState().currentProject?.id;
      if (!projectId) throw new Error('No current project to clean up');
      await window.electronAPI.projects.setDefaultModel(projectId, null);
      await window.electronAPI.projects.setDefaultEffort(projectId, null);
      await stores?.project.getState().loadCurrent();
    });

    await openSettingsAgentTab();
    await expect(variantPage.locator('input[data-testid="project-default-model"]')).toHaveAttribute('placeholder', 'Agent default');
    await expect(variantPage.locator('input[data-testid="project-default-effort"]')).toHaveAttribute('placeholder', 'Agent default');
    await closeSettings();
  });
});

/**
 * "How this task runs" is ONE either/or: ride a Board Profile's per-column
 * ladder, or pin an agent for the task's whole life. The two are mutually
 * exclusive in storage (`applyProfileExclusivity` in task-repository.ts), so
 * these tests assert the dialog clears the other branch on switch rather than
 * letting a user assemble a state the repository will silently rewrite.
 *
 * Needs its own fixture: the default mock board has no profiles, which is the
 * Default-only case covered in the first describe.
 */
test.describe('NewTaskDialog run-mode choice (profiles fixture)', () => {
  let profileBrowser: Browser;
  let profilePage: Page;

  test.beforeAll(async () => {
    await waitForViteReady();
    profileBrowser = await chromium.launch({ headless: true });
    const context = await profileBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    profilePage = await context.newPage();

    // Seeded BEFORE the mock script so `boardConfig.getBoardProfiles()` is
    // already populated when board hydration calls it.
    await profilePage.addInitScript(() => {
      (window as Record<string, unknown>).__mockBoardProfiles = [
        { id: 'profile-light', name: 'Light', columns: {} },
        { id: 'profile-heavy', name: 'Heavy', columns: {} },
      ];
    });
    await profilePage.addInitScript({ path: MOCK_SCRIPT });
    await profilePage.goto(VITE_URL);
    await profilePage.waitForLoadState('load');
    await profilePage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await createProject(profilePage, `Profiles ${Date.now()}`);
  });

  test.afterAll(async () => {
    await profileBrowser?.close();
  });

  /** Omit the title for a read-only assertion: an untouched form closes on a
   *  bare Escape, with no discard confirm to clear first. */
  async function openDialog(title?: string) {
    const column = profilePage.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();
    await profilePage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    if (title) await profilePage.locator('input[placeholder="Task title"]').fill(title);
  }

  async function submitAndRead(title: string) {
    await profilePage.locator('button[type="submit"]:has-text("Create")').click();
    await profilePage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });
    const tasks = await profilePage.evaluate(() => window.electronAPI.tasks.list());
    const created = tasks.find((task: { title: string }) => task.title === title);
    expect(created).toBeDefined();
    return created!;
  }

  test('the Profile branch is selected by default and lists Default plus every saved profile', async () => {
    await openDialog();

    await expect(profilePage.locator('[data-testid="task-run-mode-profile"]')).toBeChecked();
    const select = profilePage.locator('[data-testid="task-profile-select"]');
    await expect(select).toBeEnabled();
    expect(await select.locator('option').allTextContents()).toEqual(['Default', 'Light', 'Heavy']);

    await profilePage.keyboard.press('Escape');
    await profilePage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('picking a profile stores profile_id and leaves every lifetime pin null', async () => {
    await openDialog('Profile Ride Task');
    await profilePage.locator('[data-testid="task-profile-select"]').selectOption('profile-heavy');

    const created = await submitAndRead('Profile Ride Task');
    expect(created.profile_id).toBe('profile-heavy');
    expect(created.model_override).toBeNull();
    expect(created.effort_override).toBeNull();
    expect(created.permission_mode).toBeNull();
  });

  test('switching to Agent Override discards the chosen profile', async () => {
    await openDialog('Override Wins Task');
    await profilePage.locator('[data-testid="task-profile-select"]').selectOption('profile-light');

    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();
    // The Profile branch's control is gone, not merely ignored.
    await expect(profilePage.locator('[data-testid="task-profile-select"]')).toHaveCount(0);
    await selectCombobox(profilePage, 'task-effort-override', 'high');

    const created = await submitAndRead('Override Wins Task');
    expect(created.profile_id).toBeNull();
    expect(created.effort_override).toBe('high');
  });

  test('switching back to Profile discards the lifetime pins', async () => {
    await openDialog('Profile Wins Task');
    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();
    await selectCombobox(profilePage, 'task-effort-override', 'high');
    await selectCombobox(profilePage, 'task-permission-override', 'plan');

    await profilePage.locator('[data-testid="task-run-mode-profile"]').click();
    await expect(profilePage.locator('[data-testid="task-advanced-section"]')).toHaveCount(0);
    await profilePage.locator('[data-testid="task-profile-select"]').selectOption('profile-light');

    const created = await submitAndRead('Profile Wins Task');
    expect(created.profile_id).toBe('profile-light');
    expect(created.effort_override).toBeNull();
    expect(created.permission_mode).toBeNull();
  });

  /** Re-tiering a parked To Do task is the flow the feature exists for, and it
   *  goes through tasks.update, not tasks.create. A mode switch changes no field
   *  the user typed into, so it has to reach the edit form's dirty check on its
   *  own for Save to be enabled at all. */
  async function openTaskDetail(title: string) {
    await profilePage.locator(`text=${title}`).first().click();
    await profilePage.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });
  }

  async function saveAndRead(title: string) {
    await profilePage.locator('button:has-text("Save")').click();
    await profilePage.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
    const tasks = await profilePage.evaluate(() => window.electronAPI.tasks.list());
    const saved = tasks.find((task: { title: string }) => task.title === title);
    expect(saved).toBeDefined();
    return saved!;
  }

  /**
   * Open a task's detail window in VIEW mode via the session store's
   * setDetailTaskId, bypassing the forced-edit-mode a card click applies to
   * a no-session task (TaskCard.tsx: `initialEdit: displayState.kind ===
   * 'none'`). Two distinct callers need this:
   *   - ProfilePicker only renders in the view-mode body (TaskDetailBody /
   *     PreSpawnContextBar), never in the edit form.
   *   - handleCancel's real revert branch requires `initialEdit` to be
   *     false; a card-click-forced `initialEdit: true` makes it take the
   *     early-return "just close" path instead (see the profile-revert test
   *     below for why that matters).
   */
  async function openTaskDetailInViewMode(taskId: string) {
    await profilePage.evaluate((id) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session?: { getState: () => { setDetailTaskId: (taskId: string) => void } };
        };
      }).__zustandStores;
      if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
      stores.session.getState().setDetailTaskId(id);
    }, taskId);
    const dialog = profilePage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    return dialog;
  }

  /**
   * Enter edit mode on a VIEW-mode task-detail window via its Actions menu.
   *
   * Pairs with `openTaskDetailInViewMode`: together they are the only route to
   * `handleCancel`'s real revert branch, since a card-click open sets
   * `initialEdit: true` and Cancel then early-returns to a plain close.
   *
   * The Actions MENU portals outside the dialog subtree, so its items stay
   * page-scoped (narrowed by the pencil icon) while the in-dialog controls are
   * scoped to `dialog` - this describe shares one page, so an unscoped
   * in-dialog locator can resolve against a sibling window and the click then
   * lands nowhere. Waiting for the portalled item rather than clicking blind
   * keeps the pair from racing the menu's state update under load.
   */
  async function enterEditModeVia(dialog: Locator) {
    const editMenuItem = profilePage
      .locator('button:has-text("Edit")')
      .filter({ has: profilePage.locator('.lucide-pencil') });
    await dialog.locator('[title="Actions"]').click();
    await expect(editMenuItem).toBeVisible({ timeout: 5000 });
    await editMenuItem.click();
    await expect(dialog.locator('[data-testid="task-run-mode"]')).toBeVisible({ timeout: 5000 });
  }

  test('switching an existing profile task to Agent Override saves the swap', async () => {
    await openDialog('Edit To Override Task');
    await profilePage.locator('[data-testid="task-profile-select"]').selectOption('profile-heavy');
    await submitAndRead('Edit To Override Task');

    await openTaskDetail('Edit To Override Task');
    // Reopens on the branch the task is riding, with its profile pre-selected.
    await expect(profilePage.locator('[data-testid="task-run-mode-profile"]')).toBeChecked();
    await expect(profilePage.locator('[data-testid="task-profile-select"]')).toHaveValue('profile-heavy');

    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();
    await selectCombobox(profilePage, 'task-effort-override', 'high');

    const saved = await saveAndRead('Edit To Override Task');
    expect(saved.profile_id).toBeNull();
    expect(saved.effort_override).toBe('high');
  });

  test('switching an existing pinned task to a profile saves the swap', async () => {
    await openDialog('Edit To Profile Task');
    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();
    await selectCombobox(profilePage, 'task-effort-override', 'high');
    await submitAndRead('Edit To Profile Task');

    await openTaskDetail('Edit To Profile Task');
    // A pinned task reopens on the Agent Override branch, already expanded.
    await expect(profilePage.locator('[data-testid="task-advanced-toggle"]')).toBeChecked();
    await expect(profilePage.locator('input[data-testid="task-effort-override"]')).toHaveValue('high');

    await profilePage.locator('[data-testid="task-run-mode-profile"]').click();
    await profilePage.locator('[data-testid="task-profile-select"]').selectOption('profile-heavy');

    const saved = await saveAndRead('Edit To Profile Task');
    expect(saved.profile_id).toBe('profile-heavy');
    expect(saved.effort_override).toBeNull();
  });

  // The bug this column exists for. Every case above commits a concrete pin,
  // which is what let the mode be inferred from the pins for so long: with all
  // four left on inherit the row is identical to a Column Settings task, so
  // only a persisted mode can carry the choice across a save.

  test('creating in Agent Override with nothing picked persists the mode and no pins', async () => {
    await openDialog('Override No Picks Task');
    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();
    // Deliberately touch none of the four fields.

    const created = await submitAndRead('Override No Picks Task');
    expect(created.run_mode).toBe('agent_override');
    expect(created.agent_override).toBeNull();
    expect(created.model_override).toBeNull();
    expect(created.effort_override).toBeNull();
    expect(created.permission_mode).toBeNull();
    expect(created.profile_id).toBeNull();

    await openTaskDetail('Override No Picks Task');
    await expect(profilePage.locator('[data-testid="task-advanced-toggle"]')).toBeChecked();
    await expect(profilePage.locator('[data-testid="task-run-mode-profile"]')).not.toBeChecked();
    await profilePage.locator('button:has-text("Cancel")').click();
    await profilePage.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('editing a bare task to Agent Override survives a reopen', async () => {
    // The exact repro: a task with no pins, edited to Agent Override with
    // nothing else changed, used to reopen on Column Settings / Default.
    await openDialog('Edit Bare To Override Task');
    await submitAndRead('Edit Bare To Override Task');

    await openTaskDetail('Edit Bare To Override Task');
    await expect(profilePage.locator('[data-testid="task-run-mode-profile"]')).toBeChecked();
    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();

    const saved = await saveAndRead('Edit Bare To Override Task');
    expect(saved.run_mode).toBe('agent_override');
    expect(saved.effort_override).toBeNull();

    await openTaskDetail('Edit Bare To Override Task');
    await expect(profilePage.locator('[data-testid="task-advanced-toggle"]')).toBeChecked();
    await profilePage.locator('button:has-text("Cancel")').click();
    await profilePage.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden' });
  });

  test('cancelling an edit reverts the branch to the persisted mode', async () => {
    // Opened in VIEW mode on purpose. A card click (`openTaskDetail`) on a
    // no-session task sets `initialEdit: true` (TaskCard.tsx), and
    // handleCancel's first branch is `if (initialEdit && !session) { onClose();
    // return; }` - so Cancel would just close the window and the
    // setRunMode/setProfileId revert lines would never run at all. Reopening
    // then re-reads from the DB, which the abandoned edit never touched, so the
    // assertion would pass no matter what those lines did.
    await openDialog('Cancel Reverts Mode Task');
    const created = await submitAndRead('Cancel Reverts Mode Task');

    const dialog = await openTaskDetailInViewMode(created!.id);
    const columnSettingsCard = dialog.locator('[data-testid="task-run-mode-profile"]');
    const overrideCard = dialog.locator('[data-testid="task-advanced-toggle"]');
    const cancelButton = dialog.locator('button:has-text("Cancel")');

    await enterEditModeVia(dialog);
    await expect(columnSettingsCard).toBeChecked();

    // Switch to Agent Override, then abandon it.
    await overrideCard.click();
    await expect(overrideCard).toBeChecked();
    await cancelButton.click();

    // Left edit mode rather than closing - proof this reached the revert
    // branch instead of the early-return.
    await expect(dialog).toBeVisible();
    await expect(overrideCard).toBeHidden({ timeout: 3000 });

    // The branch lives in the WINDOW's state, which outlives the edit form, so
    // an abandoned switch must not still be selected on re-entry.
    await enterEditModeVia(dialog);
    await expect(columnSettingsCard).toBeChecked();
    await expect(overrideCard).not.toBeChecked();

    await dialog.locator('[data-testid="task-detail-close"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  });

  test('cancelling an edit reverts a changed profile to the persisted value, not merely to null', async () => {
    // The sibling test above uses a BARE task (profile_id already null), so
    // reverting it to null is indistinguishable from never having called
    // input.setProfileId at all - deleting that line would leave it green.
    // This pins the real case: a task riding a concrete profile, edited to a
    // DIFFERENT profile, then cancelled.
    await openDialog('Cancel Reverts Profile Task');
    await profilePage.locator('[data-testid="task-profile-select"]').selectOption('profile-heavy');
    const created = await submitAndRead('Cancel Reverts Profile Task');

    // Open in VIEW mode via the store, not a card click: a no-session card
    // click bakes `initialEdit: true` into the window, and handleCancel's
    // early-return (`initialEdit && !session`) then just closes the window
    // without ever reaching input.setProfileId - the DB is never written
    // either way, so an abandoned edit and a real revert look identical.
    // Opening with `initialEdit` false forces handleCancel through its
    // actual revert branch instead.
    const dialog = await openTaskDetailInViewMode(created!.id);

    const profileSelect = dialog.locator('[data-testid="task-profile-select"]');
    const cancelButton = dialog.locator('button:has-text("Cancel")');

    await enterEditModeVia(dialog);
    await expect(profileSelect).toHaveValue('profile-heavy');

    // Switch the profile within edit, then Cancel WITHOUT saving.
    await profileSelect.selectOption('profile-light');
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    // The window stays open (Cancel reverts to view mode; it does not
    // close) - proof this did not take the early-return "just close" path.
    await expect(dialog).toBeVisible();
    // And it actually LEFT edit mode: the Advanced section only renders in the
    // edit form, so its select disappearing is what proves handleCancel ran
    // rather than the click missing. Window visibility alone cannot show this -
    // the window is visible in both modes.
    await expect(profileSelect).toBeHidden({ timeout: 3000 });

    // Re-enter edit: the select must show the ORIGINAL profile-heavy, not
    // the abandoned profile-light pick.
    await enterEditModeVia(dialog);
    await expect(profileSelect).toHaveValue('profile-heavy');

    // The DB itself was never touched by the abandoned edit either.
    const afterCancel = await profilePage.evaluate(async () => {
      const list = await window.electronAPI.tasks.list();
      return list.find((task: { title: string }) => task.title === 'Cancel Reverts Profile Task');
    });
    expect(afterCancel!.profile_id).toBe('profile-heavy');

    await dialog.locator('[data-testid="task-detail-close"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  });

  test('selecting Agent Override alone makes a fresh dialog dirty', async () => {
    // Selecting the branch pins nothing, so without the mode in isDirty this
    // Escape discarded the choice with no prompt at all.
    await openDialog();
    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();

    await profilePage.keyboard.press('Escape');
    await profilePage.locator('button:has-text("Discard")').click();
    await profilePage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('picking a profile alone makes a fresh dialog dirty', async () => {
    await openDialog();
    await profilePage.locator('[data-testid="task-profile-select"]').selectOption('profile-light');

    await profilePage.keyboard.press('Escape');
    await profilePage.locator('button:has-text("Discard")').click();
    await profilePage.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('switching only the run-mode branch makes the task-detail window dirty, so Escape prompts to discard', async () => {
    // TaskDetailWindow has its OWN isEditDirty (distinct from NewTaskDialog's,
    // which is covered by the two tests above), which gained
    // `|| runMode !== task.run_mode`. Every existing run-mode test in this
    // file clicks Save directly, which is never gated by isEditDirty -
    // nothing pins that an UNGUARDED close (Escape) treats a runMode-only
    // change as dirty too.
    await openDialog('Escape Guards RunMode Task');
    await submitAndRead('Escape Guards RunMode Task');

    // A card click on this bare, no-session task opens directly into edit
    // mode (kind === 'none') and focuses the window, so Escape reaches its
    // bubble-phase close handler (TaskDetailWindow.tsx).
    await openTaskDetail('Escape Guards RunMode Task');
    // Captured once and reused below: an unscoped `[data-testid="task-detail-
    // dialog"]` re-query risks a strict-mode multi-match if a sibling window
    // from an earlier test were ever left open (same hazard the profile-revert
    // test above scopes against).
    const dialog = profilePage.locator('[data-testid="task-detail-dialog"]');

    // Switch the branch; touch nothing else.
    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();

    await profilePage.keyboard.press('Escape');
    const confirmHeading = profilePage.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible({ timeout: 3000 });

    // The window itself must still be mounted behind the confirm - Escape
    // did not silently close it.
    await expect(dialog).toBeVisible();

    await profilePage.locator('button:has-text("Discard")').click();
    await dialog.waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('ProfilePicker pill reads Custom for an Agent-Override task with no pins, and Default for a Column-Settings task', async () => {
    // ProfilePicker.tsx has no dedicated coverage anywhere in the suite. Its
    // pill label is gated on `task.run_mode === 'agent_override'`
    // (isOverrideMode), NOT on whether any of the four pins is set - the
    // exact bug this whole feature exists to fix: an Agent-Override task
    // with everything left on inherit must still read "Custom", not
    // "Default". Reverting that gate to the old pins-based check would
    // silently mislabel this exact task and produce zero test signal
    // anywhere else in the suite.
    await openDialog('Pill Override Task');
    await profilePage.locator('[data-testid="task-advanced-toggle"]').click();
    // Deliberately touch none of the four override fields.
    const overrideTask = await submitAndRead('Pill Override Task');

    await openDialog('Pill Default Task');
    // Leave on Column Settings, no profile picked.
    const defaultTask = await submitAndRead('Pill Default Task');

    // ProfilePicker lives in TaskDetailBody/PreSpawnContextBar, which never
    // renders in edit mode - open each task in VIEW mode via the store (a
    // card click on a no-session task forces edit mode, see TaskCard.tsx).
    const overrideDialog = await openTaskDetailInViewMode(overrideTask!.id);
    const overridePill = overrideDialog.locator('[data-testid="context-bar-profile-trigger"]');
    await expect(overridePill).toBeVisible();
    await expect(overridePill).toContainText('Custom');
    await overrideDialog.locator('[data-testid="task-detail-close"]').click();
    await overrideDialog.waitFor({ state: 'hidden', timeout: 5000 });

    const defaultDialog = await openTaskDetailInViewMode(defaultTask!.id);
    const defaultPill = defaultDialog.locator('[data-testid="context-bar-profile-trigger"]');
    await expect(defaultPill).toContainText('Default');
    await expect(defaultPill).not.toContainText('Custom');
    await defaultDialog.locator('[data-testid="task-detail-close"]').click();
    await defaultDialog.waitFor({ state: 'hidden', timeout: 5000 });
  });
});

test.describe('TaskDetailEditForm save gate: run_mode + pins omitted while a session is active', () => {
  // Own launch (mirrors the "multi-agent fixture" / "profiles fixture" describes
  // above): needs a task pre-seeded with a RUNNING session, which the shared
  // `page` at the top of this file never has (createTask/openDialog here never
  // spawn a real session).
  let gatedBrowser: Browser;
  let gatedPage: Page;

  const RUN_ID = Date.now();
  const PROJECT_ID = `proj-run-mode-gate-${RUN_ID}`;
  const TASK_ID = `task-run-mode-gate-${RUN_ID}`;
  const SESSION_ID = `sess-run-mode-gate-${RUN_ID}`;

  test.beforeAll(async () => {
    await waitForViteReady();
    gatedBrowser = await chromium.launch({ headless: true });
    const context = await gatedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    gatedPage = await context.newPage();

    await gatedPage.addInitScript({ path: MOCK_SCRIPT });
    // Seed a task that already carries a lifetime pin (model_override) and
    // run_mode: 'agent_override', WITH a running session - the same
    // { taskId, status: 'running' } shape context-bar-tool-breakdown.spec.ts
    // uses to reach isSessionActive === true without a real PTY.
    await gatedPage.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${PROJECT_ID}',
          name: 'Run Mode Gate ${RUN_ID}',
          path: '/mock/run-mode-gate-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        var todoLaneId = null;
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          var laneId = 'lane-rmg-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
          if (template.role === 'todo') todoLaneId = laneId;
          state.swimlanes.push(Object.assign({}, template, {
            id: laneId,
            position: index,
            created_at: ts,
          }));
        });

        state.sessions.push({
          id: '${SESSION_ID}',
          taskId: '${TASK_ID}',
          projectId: '${PROJECT_ID}',
          pid: 4242,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/run-mode-gate-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
        });

        state.tasks.push({
          id: '${TASK_ID}',
          title: 'Run Mode Gate Task',
          description: 'Seeded with a running session and a lifetime pin.',
          swimlane_id: todoLaneId,
          position: 0,
          agent: 'claude',
          session_id: '${SESSION_ID}',
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          use_worktree: null,
          labels: [],
          priority: 0,
          agent_override: null,
          model_override: 'opus',
          effort_override: null,
          permission_mode: null,
          profile_id: null,
          run_mode: 'agent_override',
          auto_command: null,
          attachment_count: 0,
          archived_at: null,
          detail_view_state: null,
          created_at: ts,
          updated_at: ts,
        });

        return { currentProjectId: '${PROJECT_ID}' };
      });
    `);

    await gatedPage.goto(VITE_URL);
    await gatedPage.waitForLoadState('load');
    await gatedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
    await gatedPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  });

  test.afterAll(async () => {
    await gatedBrowser?.close();
  });

  test('Save sends the title change but omits run_mode and every override pin from the update payload', async () => {
    // A running session both (a) forces the dialog open in VIEW mode
    // (TaskCard.tsx only sets initialEdit when displayState.kind === 'none')
    // and (b) hides AdvancedOverridesSection from the edit form (the
    // `!isSessionActive && !isArchived` gate in TaskDetailEditForm.tsx) -
    // confirmed below via the run-mode control's absence.
    const card = gatedPage.locator(`[data-task-id="${TASK_ID}"]`);
    await card.waitFor({ state: 'visible', timeout: 10000 });
    await card.click();

    const dialog = gatedPage.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await dialog.locator('[title="Actions"]').click();
    const editMenuItem = gatedPage
      .locator('button:has-text("Edit")')
      .filter({ has: gatedPage.locator('.lucide-pencil') });
    await expect(editMenuItem).toBeVisible({ timeout: 5000 });
    await editMenuItem.click();

    const titleInput = gatedPage.locator('input[placeholder="Task title"]');
    await titleInput.waitFor({ state: 'visible', timeout: 5000 });
    // Confirms isSessionActive really is true for this task (not a fixture
    // mistake): the run-mode control must not have re-appeared in edit mode.
    await expect(dialog.locator('[data-testid="task-run-mode"]')).toHaveCount(0);

    await titleInput.fill('Run Mode Gate Task (edited)');

    // Reset the call log immediately before the save under test - this page
    // is fresh (only this describe uses it), but resetting here keeps the
    // assertion below independent of anything upstream in this test.
    await gatedPage.evaluate(() => {
      window.electronAPI.tasks.__updateCalls.length = 0;
    });

    await gatedPage.locator('button:has-text("Save")').click();

    await expect
      .poll(() => gatedPage.evaluate(() => window.electronAPI.tasks.__updateCalls.length), { timeout: 5000 })
      .toBe(1);
    const payload = await gatedPage.evaluate(() => window.electronAPI.tasks.__updateCalls[0]);

    // Positive control: this is the save under test, not a stray earlier call.
    expect(payload.title).toBe('Run Mode Gate Task (edited)');

    // The regression this guards: run_mode rides INSIDE useTaskActions.ts's
    // `overrideFields`, built only when `!isSessionActive && !isArchived`.
    // The seeded task's model_override ('opus') and run_mode
    // ('agent_override') are still live in the edit form's React state (it is
    // seeded from the task row on mount, regardless of whether
    // AdvancedOverridesSection ever rendered), so the only way to prove they
    // were not SENT is the raw IPC payload - the persisted task would look
    // identical afterward either way, since nothing changed those values.
    for (const key of ['run_mode', 'model_override', 'agent_override', 'effort_override', 'permission_mode', 'profile_id']) {
      expect(payload).not.toHaveProperty(key);
    }

    await dialog.locator('[data-testid="task-detail-close"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  });
});
