/**
 * UI tests for a task's artifacts (#1056): the chip on a board card, its menu,
 * the edit form's Artifacts field and the task window's header button.
 *
 * The rules (what a name is, what a save does to the list) are unit tests in
 * artifact-draft.test.ts and task-artifacts.test.ts. These pin what only a
 * browser proves: a click on the chip opens a link and not the task, the menu
 * portals out of the card and owns the keyboard (arrows, Escape, focus back),
 * "Edit artifacts" lands the keyboard in the add field, a name keeps its space as
 * it is typed, a paste adds a link, and a save changes the card.
 *
 * What a user loses if this goes: a card click that opens the task when they
 * meant the design, a menu clipped by its column or one Escape cannot close, a
 * name typed as "Filterchips", or an edit that saves nothing.
 *
 * Each test launches its own page with its own seed, so none leans on another.
 */
import { test, expect, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-artifacts';
const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';
const WIKI = 'https://wiki.example.com/spec';
const PASTED = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit';
const NOT_A_LINK_ERROR = 'That is not a link. Paste one that starts with http or https.';

interface SeedTask {
  id: string;
  title: string;
  lane: string;
  artifacts: string[];
  /** A running session, so the task window opens on its header and not the edit form. */
  running?: boolean;
  /** A linked pull request, so the card draws its PR pill beside the chip. */
  prNumber?: number;
  /** The task's own branch, as a started task has. */
  branchName?: string;
  /** A completed task: it sits in the Done column's archive, with a report to open. */
  archived?: boolean;
}

interface Seed {
  tasks: SeedTask[];
  config?: Record<string, unknown>;
  /** The window size; the default is wide enough that nothing folds. */
  viewport?: { width: number; height: number };
}

function preConfigScript(seed: Seed): string {
  return `
    window.__mockPreConfigure(function (state) {
      var seed = ${JSON.stringify(seed)};
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Artifacts Test', path: '/mock/artifacts-test', github_url: null,
        default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        var id = 'lane-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[lane.name] = id;
        state.swimlanes.push(Object.assign({}, lane, { id: id, position: index, created_at: timestamp }));
      });
      if (seed.config) Object.assign(state.config, seed.config);
      seed.tasks.forEach(function (entry, index) {
        var sessionId = entry.running ? 'sess-' + entry.id : null;
        if (sessionId) {
          state.sessions.push({
            id: sessionId, taskId: entry.id, projectId: '${PROJECT_ID}', pid: 9000 + index, status: 'running',
            shell: 'bash', cwd: '/mock/artifacts-test', startedAt: timestamp, exitCode: null,
          });
        }
        var row = {
          id: entry.id, display_id: index + 1, title: entry.title, description: '',
          swimlane_id: laneIds[entry.archived ? 'Done' : entry.lane], position: index, agent: 'claude', session_id: sessionId,
          worktree_path: null, branch_name: entry.branchName || null, base_branch: 'main',
          archived_at: entry.archived ? timestamp : null,
          created_at: timestamp, updated_at: timestamp,
          pr_number: entry.prNumber || null,
          pr_url: entry.prNumber ? 'https://github.com/owner/repo/pull/' + entry.prNumber : null,
          artifacts: entry.artifacts.map(function (url) {
            return { url: url, name: null, source: 'user', added_at: timestamp };
          }),
        };
        if (entry.archived) {
          state.archivedTasks.push(row);
          state.summaryCache[entry.id] = {
            sessionId: state.uuid(), totalCostUsd: 0.08, totalInputTokens: 12500, totalOutputTokens: 545,
            modelDisplayName: 'Opus 4.6', durationMs: 17000, toolCallCount: 5, compactionCount: 0,
            linesAdded: 469, linesRemoved: 181, filesChanged: 18,
            taskCreatedAt: '2026-03-13T15:40:00.000Z', startedAt: '2026-03-13T15:44:00.000Z',
            exitedAt: '2026-03-13T15:45:00.000Z', exitCode: 0, toolBreakdown: [],
          };
        } else {
          state.tasks.push(row);
        }
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

const browsers: Browser[] = [];

async function openBoard(seed: Seed): Promise<Page> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const context = await browser.newContext({ viewport: seed.viewport ?? { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript(seed));
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return page;
}

test.afterEach(async () => {
  while (browsers.length > 0) await browsers.pop()?.close();
});

type OpenedWindow = Window & { __openedUrls?: string[] };

/** Record what the app hands to the default browser. */
async function trackOpenExternal(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as OpenedWindow).__openedUrls = [];
    window.electronAPI.shell.openExternal = async (url: string) => {
      (window as OpenedWindow).__openedUrls?.push(url);
    };
  });
}

function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as OpenedWindow).__openedUrls ?? []);
}

const card = (page: Page, taskId: string) => page.locator(`[data-task-id="${taskId}"]`);
const chip = (page: Page, taskId: string) => card(page, taskId).getByTestId('task-card-artifacts');
const dialog = (page: Page) => page.getByTestId('task-detail-dialog');
const menu = (page: Page) => page.getByTestId('task-card-artifacts-menu');
const menuRows = (page: Page) => page.getByTestId('task-card-artifacts-menu-row');

/** Open the task's window on its edit form at Artifacts, through the card's menu. */
async function openEditor(page: Page, taskId: string): Promise<void> {
  await chip(page, taskId).click();
  await page.getByTestId('task-card-artifacts-menu-edit').click();
  await dialog(page).waitFor({ state: 'visible', timeout: 5000 });
  await expect(page.getByTestId('artifacts-field')).toBeVisible();
}

test.describe('Artifacts on a board card', () => {
  test('one artifact shows its name and opens it on a click, not the task', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-one', title: 'One link', lane: 'To Do', artifacts: [FIGMA] }] });
    await trackOpenExternal(page);
    const one = chip(page, 'task-one');

    await expect(one).toContainText('My File');
    // Its tip names it and where it goes, and says what a click does.
    await expect(one).toHaveAccessibleDescription(/My File, Figma/);
    await expect(one).toHaveAccessibleDescription(/Open in default browser/);

    await one.click();
    await expect.poll(() => openedUrls(page)).toEqual([FIGMA]);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('several artifacts show a count; a click opens a menu that is not inside the card, and Escape closes it', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-many', title: 'Many links', lane: 'To Do', artifacts: [FIGMA, MIRO, WIKI] }] });
    const many = chip(page, 'task-many');
    await expect(many).toHaveText('3 artifacts');

    await many.click();
    await expect(menu(page)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    // Portaled to the body, so a column or card never clips it.
    await expect(card(page, 'task-many').getByTestId('task-card-artifacts-menu')).toHaveCount(0);
    await expect(menuRows(page)).toHaveCount(3);
    await expect(page.getByRole('menuitem', { name: 'Edit artifacts' })).toBeVisible();

    // The first row takes focus on open; ArrowDown moves to the second.
    await expect(menuRows(page).nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menuRows(page).nth(1)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(dialog(page)).toHaveCount(0);
    await expect(many).toBeFocused();
  });

  test('a menu row opens its link in the default browser and closes the menu', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-row', title: 'Row click', lane: 'To Do', artifacts: [FIGMA, MIRO, WIKI] }] });
    await trackOpenExternal(page);
    await chip(page, 'task-row').click();
    await menuRows(page).nth(1).click();

    await expect.poll(() => openedUrls(page)).toEqual([MIRO]);
    await expect(menu(page)).toBeHidden();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('a link Kangentic does not recognise shows its host as the tool', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-wiki', title: 'Wiki link', lane: 'To Do', artifacts: [FIGMA, WIKI] }] });
    await chip(page, 'task-wiki').click();

    const row = page.locator(`[data-testid="task-card-artifacts-menu-row"][data-artifact-url="${WIKI}"]`);
    await expect(row).toContainText('wiki.example.com');
    await expect(row).toHaveAttribute('data-artifact-platform', '');
    // A recognised one carries its platform.
    await expect(page.locator(`[data-testid="task-card-artifacts-menu-row"][data-artifact-url="${FIGMA}"]`))
      .not.toHaveAttribute('data-artifact-platform', '');
  });

  test('a task with no artifacts renders no chip', async () => {
    const page = await openBoard({
      tasks: [
        { id: 'task-none', title: 'No links', lane: 'To Do', artifacts: [] },
        { id: 'task-some', title: 'Some links', lane: 'To Do', artifacts: [FIGMA] },
      ],
    });
    await expect(card(page, 'task-none')).toBeVisible();
    await expect(chip(page, 'task-some')).toBeVisible();
    await expect(card(page, 'task-none').getByTestId('task-card-artifacts')).toHaveCount(0);
  });

  for (const columnWidth of ['narrow', 'default'] as const) {
    test(`beside a PR pill at ${columnWidth} width, the count stays one line inside the card`, async () => {
      // At Narrow the pill and "3 artifacts" do not both fit, and the label
      // wrapped to two lines inside the chip, taller than the pill beside it.
      const page = await openBoard({
        tasks: [{ id: 'task-pr', title: 'Pill and chip', lane: 'To Do', artifacts: [FIGMA, MIRO, WIKI], prNumber: 1071 }],
        config: { columnWidth },
      });
      const many = chip(page, 'task-pr');
      await expect(many).toBeVisible();
      // Whatever it shows, it is still named for a screen reader.
      await expect(many).toHaveAccessibleName('3 artifacts');

      const measured = await page.evaluate(() => {
        const cardElement = document.querySelector('[data-task-id="task-pr"]') as HTMLElement;
        const pill = cardElement.querySelector('[data-testid="task-card-pr-link"]') as HTMLElement;
        const chipElement = cardElement.querySelector('[data-testid="task-card-artifacts"]') as HTMLElement;
        const pillBox = pill.getBoundingClientRect();
        const chipBox = chipElement.getBoundingClientRect();
        return {
          pillHeight: pillBox.height,
          chipHeight: chipBox.height,
          chipRight: chipBox.right,
          cardRight: cardElement.getBoundingClientRect().right,
          clipped: chipElement.scrollWidth > chipElement.clientWidth + 1,
          shown: chipElement.innerText.trim(),
        };
      });
      expect(Math.abs(measured.chipHeight - measured.pillHeight)).toBeLessThan(2);
      expect(measured.chipRight).toBeLessThanOrEqual(measured.cardRight);
      expect(measured.clipped).toBe(false);
      // The word shows where there is room for it, and the number alone where there is not.
      expect(measured.shown).toBe(columnWidth === 'narrow' ? '3' : '3 artifacts');
    });
  }

  test('compact density hides the chip', async () => {
    const page = await openBoard({
      tasks: [{ id: 'task-compact', title: 'Compact card', lane: 'To Do', artifacts: [FIGMA, MIRO] }],
      config: { cardDensity: 'compact' },
    });
    await expect(card(page, 'task-compact')).toBeVisible();
    await expect(card(page, 'task-compact').getByTestId('task-card-artifacts')).toHaveCount(0);
  });
});

test.describe('Editing artifacts', () => {
  test('Edit artifacts opens the form with the add field focused; renaming, removing, pasting and saving change the card', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-edit', title: 'Edit links', lane: 'To Do', artifacts: [FIGMA, MIRO, WIKI] }] });
    await openEditor(page, 'task-edit');

    const rows = page.getByTestId('artifact-row');
    await expect(rows).toHaveCount(3);
    // Edit artifacts opens the add field, not the dashed row it folds to.
    const addInput = page.getByTestId('artifact-add-input');
    await expect(addInput).toBeFocused();

    // A row is text, not a field: the name the link gives, then the link. One
    // with no name of its own shows its link once.
    await expect(rows.nth(0).getByTestId('artifact-name')).toHaveText('My File');
    await expect(rows.nth(0).getByTestId('artifact-name-input')).toHaveCount(0);
    await expect(rows.nth(2).getByTestId('artifact-name')).toHaveCount(0);
    await expect(rows.nth(2).getByTestId('artifact-link')).toContainText('wiki.example.com');

    // The pencil turns the name into a field in place. A name keeps the space
    // between its words as it is typed, and Enter keeps it.
    await rows.nth(0).getByTestId('artifact-rename').click();
    const firstName = rows.nth(0).getByTestId('artifact-name-input');
    await expect(firstName).toBeFocused();
    await firstName.pressSequentially('Filter chips');
    await expect(firstName).toHaveValue('Filter chips');
    await firstName.press('Enter');
    await expect(rows.nth(0).getByTestId('artifact-name')).toHaveText('Filter chips');
    await expect(dialog(page)).toBeVisible();

    // Escape puts a name back as it was, and closes the field, not the task window.
    await rows.nth(0).getByTestId('artifact-rename').click();
    await firstName.pressSequentially(' v2');
    await firstName.press('Escape');
    await expect(rows.nth(0).getByTestId('artifact-name')).toHaveText('Filter chips');
    await expect(dialog(page)).toBeVisible();

    // Remove the other two, then paste a link: a bare link is added at once.
    await rows.nth(2).getByTestId('artifact-remove').click();
    await rows.nth(1).getByTestId('artifact-remove').click();
    await expect(rows).toHaveCount(1);
    // The add field folded back to the dashed row when the keyboard left it empty.
    await expect(addInput).toHaveCount(0);
    await page.getByTestId('artifact-add').click();
    await expect(addInput).toBeFocused();
    await addInput.evaluate((element, text) => {
      const transfer = new DataTransfer();
      transfer.setData('text', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, PASTED);
    await expect(rows).toHaveCount(2);
    await expect(addInput).toHaveValue('');

    await dialog(page).getByRole('button', { name: 'Save' }).click();

    await expect(chip(page, 'task-edit')).toHaveText('2 artifacts');
    await chip(page, 'task-edit').click();
    await expect(menuRows(page)).toHaveCount(2);
    await expect(menuRows(page).nth(0)).toContainText('Filter chips');
    await expect(menuRows(page).nth(1)).toHaveAttribute('data-artifact-url', PASTED);
  });

  test('text that is not a link shows the error and adds nothing', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-bad', title: 'Bad link', lane: 'To Do', artifacts: [FIGMA, MIRO] }] });
    await openEditor(page, 'task-bad');

    const addInput = page.getByTestId('artifact-add-input');
    await expect(addInput).toBeFocused();
    await addInput.pressSequentially('the spec is in the wiki');
    await addInput.press('Enter');

    await expect(dialog(page).getByText(NOT_A_LINK_ERROR)).toBeVisible();
    await expect(page.getByTestId('artifact-row')).toHaveCount(2);
  });

  test('past To Do, Branch and Pull request share one row, and Branch shows the task branch as text', async () => {
    // The form stacked a full-width Pull Request field, the artifacts, then a
    // base-branch pill alone on a row. It now keeps New Task's Branch field.
    const page = await openBoard({
      tasks: [{
        id: 'task-git', title: 'Git row', lane: 'Code Review', artifacts: [FIGMA],
        prNumber: 1071, branchName: 'git-row-ab12cd34',
      }],
    });
    await page.locator('[data-task-id="task-git"]').getByText('Git row').first().click();
    await dialog(page).waitFor({ state: 'visible', timeout: 5000 });

    const gitRow = dialog(page).getByTestId('task-git-row');
    await expect(gitRow.getByTestId('task-branch-name')).toHaveText('git-row-ab12cd34');
    // The name is fixed: it is text, with the base picker still beside it.
    await expect(gitRow.getByTestId('custom-branch-name-input')).toHaveCount(0);
    await expect(gitRow.getByTestId('task-branch-shell').getByRole('button')).toBeVisible();
    await expect(gitRow.getByTestId('pr-url-input')).toHaveValue('https://github.com/owner/repo/pull/1071');

    const boxes = await gitRow.evaluate((row) => {
      const shell = row.querySelector('[data-testid="task-branch-shell"]') as HTMLElement;
      const pullRequest = row.querySelector('[data-testid="pr-url-input"]') as HTMLElement;
      const artifacts = document.querySelector('[data-testid="artifacts-field"]') as HTMLElement;
      return {
        shellTop: shell.getBoundingClientRect().top,
        shellRight: shell.getBoundingClientRect().right,
        pullRequestTop: pullRequest.getBoundingClientRect().top,
        pullRequestLeft: pullRequest.getBoundingClientRect().left,
        rowBottom: row.getBoundingClientRect().bottom,
        artifactsTop: artifacts.getBoundingClientRect().top,
      };
    });
    // Side by side, Branch first, and Artifacts under the row.
    expect(Math.abs(boxes.shellTop - boxes.pullRequestTop)).toBeLessThan(3);
    expect(boxes.shellRight).toBeLessThan(boxes.pullRequestLeft);
    expect(boxes.artifactsTop).toBeGreaterThanOrEqual(boxes.rowBottom - 1);
  });
});

/** Open a To Do task, which opens straight on its edit form. */
async function openForm(page: Page, taskId: string, title: string): Promise<void> {
  await card(page, taskId).getByText(title).first().click();
  await dialog(page).waitFor({ state: 'visible', timeout: 5000 });
  await expect(page.getByTestId('artifacts-field')).toBeVisible();
}

/** Paste a link into the add field the way a clipboard does. */
async function pasteInto(addInput: Locator, text: string): Promise<void> {
  await addInput.evaluate((element, pasted) => {
    const transfer = new DataTransfer();
    transfer.setData('text', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, text);
}

/** Escape at the document, which an xterm in the window cannot eat. */
async function pressEscapeAtDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

test.describe('Artifacts edit form: the add field', () => {
  test('a link pasted again can still be removed', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-dup', title: 'Dup link', lane: 'To Do', artifacts: [FIGMA] }] });
    await openForm(page, 'task-dup', 'Dup link');

    const rows = page.getByTestId('artifact-row');
    await expect(rows).toHaveCount(1);
    await page.getByTestId('artifact-add').click();
    const addInput = page.getByTestId('artifact-add-input');
    await expect(addInput).toBeFocused();
    await addInput.pressSequentially(FIGMA);
    await addInput.press('Enter');
    // The same link is the same artifact: still one row.
    await expect(rows).toHaveCount(1);

    await rows.nth(0).getByTestId('artifact-remove').click();
    await expect(rows).toHaveCount(0);
  });

  test('the 50 artifact limit says so, adds no row and keeps the text', async () => {
    const fifty = Array.from({ length: 50 }, (_, index) => `https://wiki.example.com/spec/${index}`);
    const page = await openBoard({ tasks: [{ id: 'task-full', title: 'Full list', lane: 'To Do', artifacts: fifty }] });
    await openEditor(page, 'task-full');

    const rows = page.getByTestId('artifact-row');
    await expect(rows).toHaveCount(50);
    const addInput = page.getByTestId('artifact-add-input');
    await expect(addInput).toBeFocused();
    await addInput.pressSequentially(PASTED);
    await addInput.press('Enter');

    await expect(dialog(page).getByText(/A task keeps at most 50 artifacts/)).toBeVisible();
    await expect(rows).toHaveCount(50);
    await expect(addInput).toHaveValue(PASTED);

    // With the field closed, the dashed row cannot open it again.
    await addInput.fill('');
    await addInput.press('Escape');
    await expect(addInput).toHaveCount(0);
    await expect(page.getByTestId('artifact-add')).toBeDisabled();
  });

  test('Escape throws a typed link away and leaves the task window open', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-esc', title: 'Escape link', lane: 'To Do', artifacts: [FIGMA] }] });
    await openForm(page, 'task-esc', 'Escape link');

    await page.getByTestId('artifact-add').click();
    const addInput = page.getByTestId('artifact-add-input');
    await expect(addInput).toBeFocused();
    await addInput.pressSequentially(PASTED);
    await addInput.press('Escape');

    await expect(addInput).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    // A blur after the discard must not add the link it held.
    await expect(page.getByTestId('artifact-add')).toBeVisible();
    await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  });
});

test.describe('Artifacts edit form: unsaved edits', () => {
  test('an unsaved artifact edit raises the same discard prompt a title edit does', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-dirty', title: 'Dirty links', lane: 'To Do', artifacts: [FIGMA] }] });
    await openForm(page, 'task-dirty', 'Dirty links');

    await page.getByTestId('artifact-add').click();
    const addInput = page.getByTestId('artifact-add-input');
    await expect(addInput).toBeFocused();
    await pasteInto(addInput, PASTED);
    await expect(page.getByTestId('artifact-row')).toHaveCount(2);

    await pressEscapeAtDocument(page);
    const prompt = page.getByTestId('task-detail-unsaved-confirm');
    await expect(prompt).toBeVisible({ timeout: 5000 });
    // A saveable form asks to save first; a title edit raises this same prompt.
    await expect(prompt.locator('h3')).toHaveText('Save changes before closing?');

    // Keep editing leaves the added row in the form.
    await prompt.getByRole('button', { name: 'Keep editing' }).click();
    await expect(prompt).toBeHidden();
    await expect(page.getByTestId('artifact-row')).toHaveCount(2);

    // Discard closes the window and saves nothing.
    await pressEscapeAtDocument(page);
    await prompt.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0, { timeout: 8000 });
    await expect(chip(page, 'task-dirty')).toBeVisible();
  });

  test('Cancel discards an added artifact, so re-entering the form shows the saved list', async () => {
    // A running task opens on its header, so Cancel returns to the header and
    // the form can be entered again in the same window.
    const page = await openBoard({
      tasks: [{ id: 'task-cancel', title: 'Cancel links', lane: 'Code Review', artifacts: [FIGMA, MIRO], running: true }],
    });
    await card(page, 'task-cancel').getByText('Cancel links').first().click();
    await dialog(page).waitFor({ state: 'visible', timeout: 5000 });

    const headerButton = dialog(page).getByTestId('artifacts-button');
    await headerButton.click();
    await page.getByTestId('artifacts-button-menu-edit').click();
    await expect(page.getByTestId('artifacts-field')).toBeVisible();

    const rows = page.getByTestId('artifact-row');
    await expect(rows).toHaveCount(2);
    const addInput = page.getByTestId('artifact-add-input');
    await expect(addInput).toBeFocused();
    await pasteInto(addInput, PASTED);
    await expect(rows).toHaveCount(3);

    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('artifacts-field')).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    // The unsaved row never reached the task.
    await headerButton.click();
    await expect(page.getByTestId('artifacts-button-menu-row')).toHaveCount(2);

    await page.getByTestId('artifacts-button-menu-edit').click();
    await expect(page.getByTestId('artifacts-field')).toBeVisible();
    await expect(rows).toHaveCount(2);
  });
});

test.describe('Artifacts menu keyboard', () => {
  test('arrows wrap round the rows, and Enter on a row closes the menu and returns focus to the chip', async () => {
    const page = await openBoard({ tasks: [{ id: 'task-keys', title: 'Keys links', lane: 'To Do', artifacts: [FIGMA, MIRO, WIKI] }] });
    await trackOpenExternal(page);
    const many = chip(page, 'task-keys');

    await many.focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    const items = menu(page).getByRole('menuitem');
    // Three links, then Edit artifacts.
    await expect(items).toHaveCount(4);
    await expect(items.first()).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(() => openedUrls(page)).toEqual([MIRO]);
    await expect(menu(page)).toBeHidden();
    await expect(many).toBeFocused();
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe('Artifacts on the other surfaces', () => {
  test('a completed task shows its artifacts as a count in the header strip, and the count opens the rows', async () => {
    const page = await openBoard({
      tasks: [{ id: 'task-done', title: 'Finished links', lane: 'Done', artifacts: [FIGMA, MIRO, WIKI], archived: true }],
    });
    await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('Finished links').first().click();
    await expect(page.getByTestId('completed-task-view')).toBeVisible({ timeout: 5000 });

    const metric = page.getByTestId('completed-artifacts');
    await expect(metric).toBeVisible();
    await expect(metric).toHaveText('3');
    await expect(metric).toHaveAccessibleName('Artifacts');

    await metric.click();
    const metricMenu = page.getByTestId('completed-artifacts-menu');
    await expect(metricMenu).toBeVisible();
    await expect(page.getByTestId('completed-artifacts-menu-row')).toHaveCount(3);
    await expect(page.locator(`[data-testid="completed-artifacts-menu-row"][data-artifact-url="${WIKI}"]`)).toBeVisible();
  });

  test('the actions menu lists the artifacts once the header button has folded into it', async () => {
    const longTitle = 'A task whose title is long enough to claim the header at the narrowest window the app allows';
    const page = await openBoard({
      tasks: [{ id: 'task-fold', title: longTitle, lane: 'Code Review', artifacts: [FIGMA, MIRO, WIKI], running: true }],
      viewport: { width: 900, height: 700 },
    });
    await card(page, 'task-fold').getByText(longTitle).first().click();
    await dialog(page).waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog(page).getByTestId('artifacts-button')).toHaveCount(0);

    await dialog(page).getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByTestId('kebab-artifacts-button').click();
    const flyout = page.getByTestId('kebab-artifacts-flyout');
    await expect(flyout).toBeVisible();
    await expect(flyout.locator('[data-artifact-url]')).toHaveCount(3);
  });
});

test.describe('Artifacts in the task window header', () => {
  test('the header button shows for a task with artifacts and its menu opens and closes with Escape', async () => {
    const page = await openBoard({
      tasks: [{ id: 'task-header', title: 'Header links', lane: 'Code Review', artifacts: [FIGMA, MIRO, WIKI], running: true }],
    });
    await page.locator('[data-task-id="task-header"]').getByText('Header links').first().click();
    await dialog(page).waitFor({ state: 'visible', timeout: 5000 });

    const button = dialog(page).getByTestId('artifacts-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName('Artifacts');
    await expect(button).toHaveAccessibleDescription(/3 artifacts/);

    await button.click();
    const headerMenu = page.getByTestId('artifacts-button-menu');
    await expect(headerMenu).toBeVisible();
    await expect(headerMenu.getByTestId('artifacts-button-menu-row')).toHaveCount(3);

    // Escape closes the menu and leaves the window.
    await page.keyboard.press('Escape');
    await expect(headerMenu).toBeHidden();
    await expect(dialog(page)).toBeVisible();

    // Same close as pr-link-badge.spec.ts: a running session's xterm can eat a bubble-phase Escape.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog(page)).not.toBeVisible({ timeout: 8000 });
  });
});
