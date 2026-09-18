/**
 * Escape inside an open combobox menu closes the menu and nothing else.
 *
 * The host's dismiss listener (SettingsPanelShell, BaseDialog) is a bubble-phase
 * keydown on `document`. The three comboboxes (Combobox, ModelCombobox,
 * FontCombobox) used to close their menu from a React key handler without
 * stopping the event, so the same keystroke reached the host and closed the
 * panel or dialog underneath the menu. BranchPicker and LabelInput already
 * stopped it; the comboboxes were the outliers. They now register a
 * capture-phase `document` listener while a menu is showing, which wins the
 * event ahead of the host, and unregister it when the menu closes so a plain
 * Escape on a closed combobox still reaches the host.
 *
 * Each test launches its own page (mode: 'parallel'), per the no-cross-test-state
 * convention used across this suite.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

const SETTINGS_PANEL = '[data-testid="settings-panel"]';

async function openSettingsTab(page: Page, tabName: string): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: tabName, exact: true }).click();
}

async function openMenu(page: Page, testId: string): Promise<void> {
  await page
    .locator(`input[data-testid="${testId}"]`)
    .locator('xpath=..')
    .locator('button[aria-label="Open dropdown"]')
    .click();
  await expect(page.locator(`[data-testid="${testId}-menu"]`)).toBeVisible({ timeout: 3000 });
}

/**
 * One Escape with the menu showing: the menu goes, the settings panel stays.
 * Before the fix the panel closed on the same keystroke.
 *
 * The panel plays an exit animation, so "still visible" alone is a race: it
 * passes whenever the panel's exit outlasts the menu's. The panel's content
 * element carries `overlay-panel-out` from the keystroke's own render until it
 * unmounts, so the deterministic check is that the class is absent once the
 * menu has finished hiding (by which time that render has long committed).
 */
async function expectEscapeClosesOnlyTheMenu(page: Page, testId: string): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-testid="${testId}-menu"]`)).toBeHidden({ timeout: 3000 });
  const panel = page.locator(SETTINGS_PANEL);
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveClass(/overlay-panel-out/);
}

test('Settings > Agent: Escape closes the agent menu, not the panel, from the input and from an option', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `EscapeLayering ${Date.now()}`);
    await openSettingsTab(page, 'Agent');
    const input = page.locator('input[data-testid="project-default-agent"]');
    await expect(input).toBeVisible({ timeout: 3000 });

    // From the input.
    await openMenu(page, 'project-default-agent');
    await expectEscapeClosesOnlyTheMenu(page, 'project-default-agent');

    // From a focused option: ArrowDown moves focus into the portaled menu, and
    // Escape there hands focus back to the input WITHOUT the focus handler
    // reopening the menu.
    await openMenu(page, 'project-default-agent');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="project-default-agent-option-claude"]')).toBeFocused();
    await expectEscapeClosesOnlyTheMenu(page, 'project-default-agent');
    await expect(input).toBeFocused();

    // With no menu showing, Escape reaches the panel again. This is also the
    // proof the refocus did not silently reopen the menu: an open menu would
    // have consumed this keystroke instead.
    await page.keyboard.press('Escape');
    await expect(page.locator(SETTINGS_PANEL)).toBeHidden({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

/**
 * Wraps `useConfigStore`'s `rescanModels` action in place, so every call
 * ModelCombobox's `onOpen` makes is counted directly.
 *
 * This does NOT count through `window.electronAPI.agents.list`'s
 * `forceRefresh` calls (the pattern `task-level-overrides.spec.ts` uses): that
 * count is confounded here by `rescanModels`'s OWN in-flight lock + 60s
 * cooldown (`config-store.ts`), which blocks a second real IPC call within the
 * window regardless of whether ModelCombobox's refocus guard exists - so a
 * `forcedCallCount` assertion cannot discriminate the guard being present from
 * it being removed. Wrapping the store action observes the call `onOpen` makes
 * BEFORE that cooldown gate runs, so it counts every invocation attempt.
 */
async function instrumentRescanModelsCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { rescanModels: () => void }; setState: (partial: object) => void } };
    }).__zustandStores;
    const store = stores?.config;
    if (!store) throw new Error('__zustandStores.config is not available (dev-mode only)');
    const original = store.getState().rescanModels;
    (window as Record<string, unknown>).__rescanModelsCallCount = 0;
    store.setState({
      rescanModels: () => {
        (window as Record<string, unknown>).__rescanModelsCallCount =
          ((window as Record<string, unknown>).__rescanModelsCallCount as number) + 1;
        return original();
      },
    });
  });
}

async function readRescanModelsCallCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as Record<string, unknown>).__rescanModelsCallCount as number ?? 0);
}

test('Settings > Agent: Escape closes the model menu, not the panel, from the input and from an option, without re-firing the rescan', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `EscapeLayeringModel ${Date.now()}`);
    await openSettingsTab(page, 'Agent');
    const input = page.locator('input[data-testid="project-default-model"]');
    await expect(input).toBeVisible({ timeout: 3000 });
    await instrumentRescanModelsCalls(page);

    // From the input. A user-driven open fires onOpen (the chevron currently
    // fires it twice: once from `handleToggleDropdown`, once more from the
    // `inputRef.focus()` it makes right after, which legitimately runs
    // `handleInputFocus`). The counts below are relative to that baseline
    // rather than pinned to it, since the double fire is not the contract here.
    await openMenu(page, 'project-default-model');
    await expect.poll(() => readRescanModelsCallCount(page)).toBeGreaterThan(0);
    // Escape from the input never refocuses (activeElement is already the
    // input, not a menu child), so it never touches the guard.
    const countAfterFirstOpen = await readRescanModelsCallCount(page);
    await expectEscapeClosesOnlyTheMenu(page, 'project-default-model');
    await expect.poll(() => readRescanModelsCallCount(page)).toBe(countAfterFirstOpen);

    // From a focused option: ArrowDown moves focus into the portaled menu.
    // Reopening the menu (a real user action) fires the rescan again.
    await openMenu(page, 'project-default-model');
    await expect.poll(() => readRescanModelsCallCount(page)).toBeGreaterThan(countAfterFirstOpen);
    await page.keyboard.press('ArrowDown');
    const firstOption = page.locator('[data-testid="project-default-model-menu"] [data-model-option]').first();
    await expect(firstOption).toBeFocused();
    const countBeforeEscape = await readRescanModelsCallCount(page);

    // Escape there hands focus back to the input WITHOUT the focus handler
    // re-firing onOpen (and so the rescan) for a focus the user did not give
    // it: the call count must not move.
    await expectEscapeClosesOnlyTheMenu(page, 'project-default-model');
    await expect(input).toBeFocused();
    await expect.poll(() => readRescanModelsCallCount(page)).toBe(countBeforeEscape);

    // With no menu showing, Escape reaches the panel again. This is also the
    // proof the refocus did not silently reopen the menu: an open menu would
    // have consumed this keystroke instead.
    await page.keyboard.press('Escape');
    await expect(page.locator(SETTINGS_PANEL)).toBeHidden({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('Settings > Terminal: Escape closes the font menu, not the panel', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `EscapeLayeringFont ${Date.now()}`);
    await openSettingsTab(page, 'Terminal');
    await expect(page.locator('input[data-testid="terminal-font-family"]')).toBeVisible({ timeout: 3000 });

    await openMenu(page, 'terminal-font-family');
    await expectEscapeClosesOnlyTheMenu(page, 'terminal-font-family');

    await page.keyboard.press('Escape');
    await expect(page.locator(SETTINGS_PANEL)).toBeHidden({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

/**
 * Same layering question against a BaseDialog host rather than
 * SettingsPanelShell. `NewTaskDialog`'s Escape binding (in `BaseDialog`) is
 * bubble-phase on `document` (`document.addEventListener('keydown', ...)`
 * with no capture flag), so it runs strictly after the combobox's
 * capture-phase listener - the same ordering that lets the Settings host
 * cases above work, just on a different host.
 */
test('NewTaskDialog: Escape closes the effort menu, not the dialog', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `EscapeLayeringDialog ${Date.now()}`);
    const dialog = page.locator('[data-testid="new-task-dialog"]');

    await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
    await expect(dialog).toBeVisible();
    await page.locator('[data-testid="task-advanced-toggle"]').click();

    await openMenu(page, 'task-effort-override');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="task-effort-override-menu"]')).toBeHidden({ timeout: 3000 });
    await expect(dialog).toBeVisible();

    // Expanding Advanced makes the form dirty (the branch itself persists as
    // run_mode), so the second Escape - now that no menu is open to consume it
    // - raises the discard confirm rather than closing the dialog directly.
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
  } finally {
    await browser.close();
  }
});
