/**
 * The Changes panel's markdown preview renders a repository file the way GitHub
 * shows it (MarkdownRenderer's document variant): a README's HTML header, its
 * relative images read from the diff, its `<picture>` following the app's
 * theme, links that open other files in the panel, alerts, and highlighted code.
 *
 * Each test seeds `window.__mockGitDiff` with the files the panel lists, opens
 * the task's Changes panel on README.cs.md, flips the eye toggle, and closes the
 * window again, so no test depends on another's state.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-markdown-document';
const TASK_ID = 'task-markdown-document';
const SESSION_ID = 'sess-markdown-document';
const TASK_TITLE = 'Markdown Document Task';

/** A 30x30 PNG, served as the README's relative logo. */
const LOGO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAYAAAA7MK6iAAAANUlEQVR42u3PoQ0AMAwEsQz2+ytbpeoEZSkxOnhyJT2dzHbrx/S2iImJiYmJiYmJiYmJiZ89Sdzl5oWz0ucAAAAASUVORK5CYII=';

/** Screenshots on a reserved domain: nothing is fetched, only the chosen srcset is read. */
const DARK_SCREENSHOT = 'https://board.example.invalid/board-dark.png';
const LIGHT_SCREENSHOT = 'https://board.example.invalid/board-light.png';

const README = [
  '<!-- readme-translation source-blob=0123456789abcdef -->',
  '<p align="center">',
  '  <a href="https://example.invalid"><img src="docs/images/logo.png" alt="Logo" width="30" /></a>',
  '</p>',
  '',
  '<h1 align="center">Sample project</h1>',
  '',
  '<p align="center">',
  '  <a href="LICENSE">License</a> |',
  '  <a href="README.de.md">Deutsch</a>',
  '</p>',
  '',
  '<picture>',
  `  <source media="(prefers-color-scheme: dark)" srcset="${DARK_SCREENSHOT}" />`,
  `  <source media="(prefers-color-scheme: light)" srcset="${LIGHT_SCREENSHOT}" />`,
  `  <img src="${DARK_SCREENSHOT}" alt="The board" width="300" />`,
  '</picture>',
  '',
  '[Jump to the deep section](#deep-section), [jump to the named target](#named-target), or read [the docs](https://example.invalid/docs).',
  '',
  '> [!WARNING]',
  '> Careful with this one.',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1}.\n`),
  // The form a README writes a jump target in: a name, not an id.
  '<a name="named-target"></a>',
  '',
  'Named target paragraph.',
  '',
  ...Array.from({ length: 40 }, (_, index) => `More filler ${index + 1}.\n`),
  '## Deep section',
  '',
  // Enough below the heading that the pane can scroll it to its top.
  ...Array.from({ length: 80 }, (_, index) => `Closing paragraph ${index + 1}.\n`),
  '',
].join('\n');

const DIFF_FIXTURE = {
  files: [
    { path: 'README.cs.md', status: 'A', insertions: 100, deletions: 0, binary: false, original: '', modified: README, language: 'markdown' },
    { path: 'README.de.md', status: 'A', insertions: 1, deletions: 0, binary: false, original: '', modified: '# Deutsche Fassung\n\nHallo.\n', language: 'markdown' },
    { path: 'docs/images/logo.png', status: 'A', insertions: 0, deletions: 0, binary: true, original: '', modified: '', language: 'plaintext', modifiedImageBase64: LOGO_PNG },
  ],
};

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Markdown Document Test',
        path: '/mock/markdown-document-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'lane-md-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
      });
      // Running session so TaskDetailBody renders and the Changes pill shows.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 8888,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/markdown-document-test',
        startedAt: timestamp,
        exitCode: null,
      });
      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: '${TASK_TITLE}',
        description: 'Task used to exercise the markdown document preview',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/worktrees/markdown-document',
        branch_name: 'feature/markdown-document',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        archived_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.afterEach(async () => {
  // A test that failed before closeTaskWindow leaves its window open; close it
  // so the next test opens the task from the board, not into a stale window.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockGitDiff = null;
  });
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  if (await dialog.isVisible()) {
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  }
});

/** Open the task's Changes panel on README.cs.md and switch it to the rendered preview. */
async function openReadmePreview(): Promise<Locator> {
  await page.evaluate((fixture) => {
    (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = fixture;
    (window as unknown as { __openedExternalUrls: string[] }).__openedExternalUrls = [];
  }, DIFF_FIXTURE);

  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="changes-toggle"]').click();

  await page.locator('[data-testid="changes-file-row"][data-path="README.cs.md"] button').first().click();
  const previewToggle = page.locator('[data-testid="diff-markdown-preview"]');
  await expect(previewToggle).toBeVisible({ timeout: 8000 });
  await previewToggle.click();
  await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');

  const preview = page.locator('[data-testid="diff-markdown-preview-content"]');
  await expect(preview.locator('h1')).toHaveText('Sample project', { timeout: 8000 });
  return preview;
}

async function closeTaskWindow(): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockGitDiff = null;
  });
  await page.locator('[data-testid="changes-toggle"]').click();
  // Capture-phase close, as the sibling diff specs do: Escape can be taken by
  // whatever the test left focused.
  await page.keyboard.press('Control+Shift+W');
  await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
}

test.describe('Changes panel markdown preview renders a repository file like GitHub', () => {
  test('renders the README header: centered HTML, inline badges, the relative logo, no comment', async () => {
    const preview = await openReadmePreview();

    const centered = preview.locator('p[align="center"]').first();
    await expect(centered).toBeVisible();
    expect(await centered.evaluate((element) => getComputedStyle(element).textAlign)).toMatch(/center/);

    // Tailwind's preflight makes images blocks; the document keeps them inline
    // so a row of badges stays a row.
    const logo = preview.getByRole('img', { name: 'Logo' });
    expect(await logo.evaluate((element) => getComputedStyle(element).display)).toBe('inline');
    // The relative logo was read through git.fileImage at the diff's revision.
    await expect(logo).toHaveAttribute('src', /^data:image\/png;base64,/);

    await expect(preview).not.toContainText('readme-translation');
    await expect(preview).not.toContainText('<p align');

    await closeTaskWindow();
  });

  test('a <picture> source written for prefers-color-scheme follows the app theme', async () => {
    const preview = await openReadmePreview();
    const sources = preview.locator('picture source');
    await expect(sources).toHaveCount(1);
    await expect(sources.first()).toHaveAttribute('srcset', DARK_SCREENSHOT);

    // Hovering a light-base theme tile previews it app-wide (the shown theme),
    // and the preview, still mounted behind the settings panel, follows.
    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByTestId('theme-grid').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByTestId('theme-tile-clay').hover();
    await expect(sources.first()).toHaveAttribute('srcset', LIGHT_SCREENSHOT);

    await page.getByTestId('setting-row-theme').locator(':scope > div').first().hover();
    await expect(sources.first()).toHaveAttribute('srcset', DARK_SCREENSHOT);
    // The panel's backdrop covers the title bar's settings button; Escape closes it.
    await page.keyboard.press('Escape');
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 3000 });

    await closeTaskWindow();
  });

  test('a link to a listed file opens it in the panel, still on its preview', async () => {
    const preview = await openReadmePreview();
    await preview.getByRole('link', { name: 'Deutsch' }).click();

    await expect(page.locator('[data-testid="changes-file-row"][data-path="README.de.md"]')).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('[data-testid="diff-markdown-preview"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="diff-markdown-preview-content"] h1')).toHaveText('Deutsche Fassung');

    await closeTaskWindow();
  });

  test('a link to a file the panel does not list is inert and says why', async () => {
    const preview = await openReadmePreview();
    const license = preview.getByTestId('markdown-link-unlisted').filter({ hasText: 'License' });
    await expect(license).toBeVisible();
    await expect(preview.locator('a[href="LICENSE"]')).toHaveCount(0);
    await expect(license).toHaveAccessibleDescription('LICENSE has no changes in this view');

    await license.click();
    // Still README.cs.md, still its preview.
    await expect(preview.locator('h1')).toHaveText('Sample project');

    await closeTaskWindow();
  });

  test('an anchor link scrolls the preview pane, and an external link goes to the OS', async () => {
    const preview = await openReadmePreview();
    expect(await preview.evaluate((element) => element.scrollTop)).toBe(0);

    await preview.getByRole('link', { name: 'Jump to the deep section' }).click();
    await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    // The heading lands at the top of the pane, within a few pixels.
    const offset = await preview.evaluate((element) => {
      const heading = element.querySelector('#user-content-deep-section');
      return heading ? heading.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
    });
    expect(offset).not.toBeNull();
    expect(Math.abs(offset ?? 999)).toBeLessThan(8);

    // A README's `<a name>` target lands the same way as a heading's id.
    await preview.evaluate((element) => { element.scrollTop = 0; });
    await preview.getByRole('link', { name: 'jump to the named target' }).click();
    await expect.poll(() => preview.evaluate((element) => {
      const target = element.querySelector('[name="user-content-named-target"]');
      return target ? Math.abs(target.getBoundingClientRect().top - element.getBoundingClientRect().top) : null;
    })).toBeLessThan(8);

    await preview.evaluate((element) => { element.scrollTop = 0; });
    await preview.getByRole('link', { name: 'the docs' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __openedExternalUrls: string[] }).__openedExternalUrls))
      .toContain('https://example.invalid/docs');

    await closeTaskWindow();
  });

  test('in a file\'s own window, a link to a listed file opens that file in a window of its own', async () => {
    // The 'changes-file' pop-out booted in its own page from the descriptor
    // main would hand it, as in a real detached window.
    const popOutParams = {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      filePath: 'README.cs.md',
      scope: 'working',
      projectPath: '/mock/markdown-document-test',
      worktreePath: '/mock/worktrees/markdown-document',
      baseBranch: 'main',
      status: 'A',
      binary: false,
      taskDisplayId: 1,
      taskTitle: TASK_TITLE,
    };
    const popOutPage = await page.context().newPage();
    await popOutPage.addInitScript({ path: MOCK_SCRIPT });
    await popOutPage.addInitScript(`
      window.__mockGitDiff = ${JSON.stringify(DIFF_FIXTURE)};
      window.electronAPI.popOut.descriptor = { kind: 'changes-file', params: ${JSON.stringify(popOutParams)} };
    `);
    await gotoVite(popOutPage, VITE_URL);

    const previewToggle = popOutPage.locator('[data-testid="diff-markdown-preview"]');
    await expect(previewToggle).toBeVisible({ timeout: 15000 });
    await previewToggle.click();
    const preview = popOutPage.locator('[data-testid="diff-markdown-preview-content"]');
    await expect(preview.locator('h1')).toHaveText('Sample project', { timeout: 8000 });
    await popOutPage.evaluate(() => (window as unknown as { __mockPopOut: { reset: () => void } }).__mockPopOut.reset());

    await preview.getByRole('link', { name: 'Deutsch' }).click();
    await expect.poll(() => popOutPage.evaluate(() => (
      window as unknown as { __mockPopOut: { getCalls: () => Array<{ type: string; kind: string; params: Record<string, unknown> }> } }
    ).__mockPopOut.getCalls())).toEqual([
      { type: 'open', kind: 'changes-file', params: { ...popOutParams, filePath: 'README.de.md', status: 'A', binary: false } },
    ]);
    // This window keeps showing its own file.
    await expect(preview.locator('h1')).toHaveText('Sample project');

    await popOutPage.close();
  });

  test('draws a GitHub alert and highlights a fenced block', async () => {
    const preview = await openReadmePreview();
    const alert = preview.locator('[data-alert="warning"]');
    await expect(alert).toBeVisible();
    await expect(alert.locator('.markdown-alert-title')).toHaveText('Warning');
    await expect(alert).toContainText('Careful with this one.');
    await expect(preview).not.toContainText('[!WARNING]');

    // Monaco's colorizer tokenizes the block into its `mtk` spans.
    await expect.poll(() => preview.locator('pre code.language-ts span[class^="mtk"]').count(), { timeout: 8000 }).toBeGreaterThan(0);
    await expect(preview.locator('pre code.language-ts')).toContainText('const answer: number = 42;');

    await closeTaskWindow();
  });
});
