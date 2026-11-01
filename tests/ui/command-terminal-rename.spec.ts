/**
 * UI tests for renaming a Command Terminal (#684): the pencil right after the
 * header's title, Rename first in the terminal's ... menu, and the right-click
 * menu on a Running row in the rail, which is the terminal's whole ... menu.
 *
 * The mock's `renameTransient` mirrors `SessionManager.renameCommandTerminal`
 * and pushes the row back on the status push, so the header reads the new name
 * from the session replica exactly as it does against main.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'proj-cmd-rename';
/** Wide enough for two terminals side by side at the 630px floor. */
const GRID_VIEWPORT = { width: 2560, height: 1440 };

/** One project, on the mock's own `spawnTransient`, whose rows `renameTransient` finds. */
function preConfig(options: { holdSpawn?: boolean } = {}): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Rename Project',
        path: '/mock/rename-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-rename-' + i, position: i, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
    ${options.holdSpawn ? `
    // Holds the first start until the test releases it, so the terminal is
    // still starting (no session id) while the test looks at it.
    var startTerminal = window.electronAPI.sessions.spawnTransient;
    window.electronAPI.sessions.spawnTransient = function (input) {
      return new Promise(function (resolve, reject) {
        window.__releaseTerminalStart = function () { startTerminal(input).then(resolve, reject); };
      });
    };` : ''}
  `;
}

async function launch(options: { holdSpawn?: boolean } = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: GRID_VIEWPORT });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(options));
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

async function openTerminals(page: Page, count: number): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
  for (let opened = 2; opened <= count; opened += 1) {
    await page.getByTestId('command-terminal-new').click();
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(opened, { timeout: 5000 });
  }
}

const terminalOf = (page: Page, slot: string) => page.locator(`[data-testid="command-terminal-window"][data-command-slot="${slot}"]`);
const frameOf = (page: Page, slot: string) =>
  page.locator('[data-testid^="window-frame-"]', { has: page.locator(`[data-command-slot="${slot}"]`) });
const runningRowOf = (page: Page, slot: string) =>
  page.locator(`[data-testid="command-terminal-running-row"][data-command-slot="${slot}"]`);

async function renameCalls(page: Page): Promise<Array<{ sessionId: string; name: string | null }>> {
  return page.evaluate(() => (window as unknown as { __mockRenameTransientCalls?: Array<{ sessionId: string; name: string | null }> })
    .__mockRenameTransientCalls ?? []);
}

/** Whether the replica holds this slot's terminal as named by its user, which the status push carries. */
async function terminalIsNamedByUser(page: Page, slot: string): Promise<boolean> {
  return page.evaluate((slot) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session?: {
          getState: () => { sessions: Array<{ commandTerminalSlot?: string; commandTerminalNamedByUser?: boolean }> };
        };
      };
    }).__zustandStores;
    return (stores?.session?.getState().sessions ?? []).some((session) =>
      session.commandTerminalSlot === slot && session.commandTerminalNamedByUser === true);
  }, slot);
}

/** Whether keyboard focus sits in this terminal's xterm. */
async function terminalHasFocus(page: Page, slot: string): Promise<boolean> {
  return page.evaluate((slot) => {
    const active = document.activeElement;
    return !!active
      && active.classList.contains('xterm-helper-textarea')
      && !!active.closest(`[data-testid="command-terminal-window"][data-command-slot="${slot}"]`);
  }, slot);
}

test.describe('Renaming a Command Terminal', () => {
  test('the pencil opens the field with the name selected, nothing shifts, and Enter saves and returns to the terminal', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 1);
      const terminal = terminalOf(page, 'slot-1');
      const pencil = terminal.getByTestId('command-bar-rename');
      await expect(pencil).toBeEnabled({ timeout: 5000 });
      await expect(pencil).toHaveAccessibleName('Rename terminal');
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Command Terminal 1');

      const header = terminal.getByTestId('command-bar-header');
      const headerBefore = await header.boundingBox();
      const folderBefore = await terminal.getByTestId('command-bar-folder-button').boundingBox();
      const changesBefore = await terminal.getByTestId('command-bar-changes-toggle').boundingBox();
      const titleBefore = await terminal.getByTestId('command-bar-label').boundingBox();

      await pencil.click();
      const field = terminal.getByTestId('command-bar-name-field');
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('Command Terminal 1');
      const selection = await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.value.length]);
      expect(selection[0]).toBe(0);
      expect(selection[1]).toBe(selection[2]);

      // The field takes the title's place; the header and its pills stay put.
      const headerOpen = await header.boundingBox();
      const folderOpen = await terminal.getByTestId('command-bar-folder-button').boundingBox();
      const changesOpen = await terminal.getByTestId('command-bar-changes-toggle').boundingBox();
      expect(Math.abs((headerOpen?.height ?? 0) - (headerBefore?.height ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((folderOpen?.x ?? 0) - (folderBefore?.x ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((changesOpen?.x ?? 0) - (changesBefore?.x ?? 0))).toBeLessThanOrEqual(1);
      // The name's text starts where the title's did.
      const textStart = await field.evaluate((input: HTMLInputElement) =>
        input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft));
      expect(Math.abs(textStart - (titleBefore?.x ?? 0))).toBeLessThanOrEqual(1);

      // Typing replaces the selected name.
      await page.keyboard.type('Auth refactor');
      await page.keyboard.press('Enter');

      await expect(field).toHaveCount(0);
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Auth refactor');
      expect((await renameCalls(page)).map((call) => call.name)).toEqual(['Auth refactor']);
      await expect.poll(() => terminalHasFocus(page, 'slot-1'), { timeout: 3000 }).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('Escape puts the old name back and sends nothing', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 1);
      const terminal = terminalOf(page, 'slot-1');
      await terminal.getByTestId('command-bar-rename').click();
      await page.keyboard.type('Something else');
      await page.keyboard.press('Escape');

      await expect(terminal.getByTestId('command-bar-name-field')).toHaveCount(0);
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Command Terminal 1');
      expect(await renameCalls(page)).toEqual([]);
      // Escape closed the field, not the panel.
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('an empty name returns the title to Command Terminal N', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 1);
      const terminal = terminalOf(page, 'slot-1');
      await terminal.getByTestId('command-bar-rename').click();
      await page.keyboard.type('Auth refactor');
      await page.keyboard.press('Enter');
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Auth refactor');

      await terminal.getByTestId('command-bar-rename').click();
      const field = terminal.getByTestId('command-bar-name-field');
      await page.keyboard.press('Delete');
      await expect(field).toHaveValue('');
      // An empty field shows what the title goes back to.
      await expect(field).toHaveAttribute('placeholder', 'Command Terminal 1');
      await page.keyboard.press('Enter');

      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Command Terminal 1');
      expect((await renameCalls(page)).map((call) => call.name)).toEqual(['Auth refactor', null]);
    } finally {
      await browser.close();
    }
  });

  test('an input method\'s Enter and Escape belong to its composition: the field neither saves nor cancels', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 1);
      const terminal = terminalOf(page, 'slot-1');
      await terminal.getByTestId('command-bar-rename').click();
      const field = terminal.getByTestId('command-bar-name-field');
      await expect(field).toBeFocused();
      // A changed name, so the outcome of the Enter below never rests on the
      // unchanged-Enter save (an unnamed terminal's Enter saves its own number).
      await page.keyboard.type('Auth refactor');
      await expect(field).toHaveValue('Auth refactor');

      // The Enter that picks an input method's candidate.
      await field.evaluate((input) => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      });
      await expect(field).toBeVisible();
      await expect(field).toHaveValue('Auth refactor');
      expect(await renameCalls(page)).toEqual([]);

      // The Escape that drops the composition does not close the field either.
      await field.evaluate((input) => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
      });
      await expect(field).toBeVisible();
      await expect(field).toHaveValue('Auth refactor');
      expect(await renameCalls(page)).toEqual([]);

      // The same key with no composition running commits, so the two above were
      // held back by the composition and not by the field ignoring them.
      await page.keyboard.press('Enter');
      await expect(field).toHaveCount(0);
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Auth refactor');
      expect((await renameCalls(page)).map((call) => call.name)).toEqual(['Auth refactor']);
    } finally {
      await browser.close();
    }
  });

  test('Enter on a terminal nobody named saves its number as the user\'s choice, once; a click away with nothing changed sends nothing', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 1);
      const terminal = terminalOf(page, 'slot-1');
      const pencil = terminal.getByTestId('command-bar-rename');
      const field = terminal.getByTestId('command-bar-name-field');
      const title = terminal.getByTestId('command-bar-label');
      await expect(pencil).toBeEnabled({ timeout: 5000 });
      expect(await terminalIsNamedByUser(page, 'slot-1')).toBe(false);

      // Enter without typing: the field opened holding the slot's own title.
      await pencil.click();
      await expect(field).toHaveValue('Command Terminal 1');
      await page.keyboard.press('Enter');
      await expect(field).toHaveCount(0);
      // One save, a clear (null: the slot's own title), so main marks the terminal
      // named by its user and the auto-namer stands down. The title is unchanged.
      expect(await renameCalls(page)).toEqual([{ sessionId: expect.any(String), name: null }]);
      await expect(title).toHaveText('Command Terminal 1');

      // Once main's push has marked it, there is nothing left to save.
      await expect.poll(() => terminalIsNamedByUser(page, 'slot-1'), { timeout: 3000 }).toBe(true);
      await pencil.click();
      await expect(field).toHaveValue('Command Terminal 1');
      await page.keyboard.press('Enter');
      await expect(field).toHaveCount(0);
      expect(await renameCalls(page)).toHaveLength(1);
      await expect(title).toHaveText('Command Terminal 1');
    } finally {
      await browser.close();
    }
  });

  test('a click elsewhere with nothing changed closes the field and sends nothing, and still saves a changed name', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 1);
      const terminal = terminalOf(page, 'slot-1');
      const pencil = terminal.getByTestId('command-bar-rename');
      const field = terminal.getByTestId('command-bar-name-field');
      await expect(pencil).toBeEnabled({ timeout: 5000 });
      // The Running heading: inside the rail, no control, so the click only moves focus off the field.
      const runningHeading = page.getByTestId('command-terminal-running').locator('xpath=preceding-sibling::div[1]');
      await expect(runningHeading).toHaveText('Running');

      await pencil.click();
      await expect(field).toHaveValue('Command Terminal 1');
      await runningHeading.click();
      // The click ended the edit (the blur committed), and the commit sent nothing.
      await expect(field).toHaveCount(0);
      expect(await renameCalls(page)).toEqual([]);
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Command Terminal 1');
      expect(await terminalIsNamedByUser(page, 'slot-1')).toBe(false);

      // The same click after typing a name does save it, so the blur above was a
      // commit that chose to send nothing and not a field that ignored the click.
      await pencil.click();
      await expect(field).toBeFocused();
      await page.keyboard.type('Auth refactor');
      await runningHeading.click();
      await expect(field).toHaveCount(0);
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('Auth refactor');
      expect((await renameCalls(page)).map((call) => call.name)).toEqual(['Auth refactor']);
    } finally {
      await browser.close();
    }
  });

  test('Rename is first in the ... menu and opens the same field', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 1);
      const terminal = terminalOf(page, 'slot-1');
      await terminal.getByRole('button', { name: 'Actions' }).click();
      const firstItem = page.locator('[role="menu"] button').first();
      await expect(firstItem).toHaveAttribute('data-testid', 'command-bar-kebab-rename');
      await firstItem.click();

      const field = terminal.getByTestId('command-bar-name-field');
      await expect(field).toBeFocused();
      await page.keyboard.type('From the menu');
      await page.keyboard.press('Enter');
      await expect(terminal.getByTestId('command-bar-label')).toHaveText('From the menu');
    } finally {
      await browser.close();
    }
  });

  test('Rename is off with its reason while the terminal is still starting', async () => {
    const { browser, page } = await launch({ holdSpawn: true });
    try {
      await page.keyboard.press('Control+Shift+P');
      const terminal = terminalOf(page, 'slot-1');
      const pencil = terminal.getByTestId('command-bar-rename');
      await expect(pencil).toBeDisabled({ timeout: 5000 });
      await expect(pencil).toHaveAccessibleDescription('Available once the terminal starts');

      await page.evaluate(() => (window as unknown as { __releaseTerminalStart: () => void }).__releaseTerminalStart());
      await expect(pencil).toBeEnabled({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a Running row\'s right-click is the terminal\'s whole ... menu, and its Rename edits the row in place', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 2);
      await terminalOf(page, 'slot-1').getByTestId('command-bar-expand').click();
      await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');

      await runningRowOf(page, 'slot-2').click({ button: 'right' });
      const menu = page.getByTestId('command-terminal-row-menu');
      await expect(menu).toBeVisible();
      const items = await menu.locator('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-testid')));
      expect(items).toEqual([
        'command-terminal-row-menu-rename',
        'command-terminal-row-menu-open-folder',
        'command-terminal-row-menu-commands',
        'command-terminal-row-menu-switch-branch',
        'command-terminal-row-menu-toggle-changes',
        'command-terminal-row-menu-stop',
      ]);

      await menu.getByTestId('command-terminal-row-menu-rename').click();
      await expect(menu).toHaveCount(0);
      const field = runningRowOf(page, 'slot-2').getByTestId('command-terminal-running-name-field');
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('Command Terminal 2');
      await page.keyboard.type('DB migration review');
      await page.keyboard.press('Enter');

      await expect(runningRowOf(page, 'slot-2').getByTestId('command-terminal-running-expand')).toHaveText('DB migration review');
      // The rename happened in the row: the expanded terminal is still the first.
      await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
      // And the terminal's own header carries the name too.
      await expect(terminalOf(page, 'slot-2').getByTestId('command-bar-label')).toHaveText('DB migration review');
    } finally {
      await browser.close();
    }
  });

  test('Show changes from a Running row brings that terminal up with its Changes open', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 2);
      await terminalOf(page, 'slot-1').getByTestId('command-bar-expand').click();
      await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');

      await runningRowOf(page, 'slot-2').click({ button: 'right' });
      await page.getByTestId('command-terminal-row-menu-toggle-changes').click();

      await expect(frameOf(page, 'slot-2')).toHaveAttribute('data-expanded', 'true');
      await expect.poll(() => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { getState: () => { changesOpenTasks: Set<string> } } };
        }).__zustandStores;
        return Array.from(stores?.session?.getState().changesOpenTasks ?? []);
      }), { timeout: 3000 }).toContainEqual(expect.stringContaining('slot-2'));
      // Running moves its front mark to the terminal the menu brought up.
      await expect(runningRowOf(page, 'slot-2')).toHaveAttribute('data-front', 'true');
      await expect(runningRowOf(page, 'slot-1')).toHaveAttribute('data-front', 'false');
    } finally {
      await browser.close();
    }
  });

  test('Escape closes the row menu and nothing under it', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 2);
      await terminalOf(page, 'slot-1').getByTestId('command-bar-expand').click();
      await runningRowOf(page, 'slot-2').click({ button: 'right' });
      await expect(page.getByTestId('command-terminal-row-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('command-terminal-row-menu')).toHaveCount(0);
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(2);
      await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
    } finally {
      await browser.close();
    }
  });

  test('a click outside the row menu closes it and runs none of its items', async () => {
    const { browser, page } = await launch();
    try {
      await openTerminals(page, 2);
      await terminalOf(page, 'slot-1').getByTestId('command-bar-expand').click();
      await runningRowOf(page, 'slot-2').click({ button: 'right' });
      const menu = page.getByTestId('command-terminal-row-menu');
      await expect(menu).toBeVisible();
      // The Running heading: inside the rail, outside the menu, and no control.
      const runningHeading = page.getByTestId('command-terminal-running').locator('xpath=preceding-sibling::div[1]');
      await expect(runningHeading).toHaveText('Running');
      await runningHeading.click();
      await expect(menu).toHaveCount(0);
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(2);
      await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
      await expect(runningRowOf(page, 'slot-2').getByTestId('command-terminal-running-name-field')).toHaveCount(0);
      expect(await renameCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
