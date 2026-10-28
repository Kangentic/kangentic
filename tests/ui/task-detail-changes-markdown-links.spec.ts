/**
 * The Changes panel's markdown preview follows links and reads images for the
 * file it shows. This spec pins the paths the sibling spec
 * (task-detail-changes-markdown-document.spec.ts) leaves open:
 *
 *  - a link to another listed file lands on that file's preview and scrolls to
 *    its `#anchor` once it renders, a same-file anchor scrolls the pane, and a
 *    tree click after a followed link still opens the diff;
 *  - a middle click on a listed link is cancelled, so nothing opens;
 *  - a relative `<source srcset>` reads its repo image, and one that names a
 *    file the diff does not hold is dropped;
 *  - image reads are cached while the preview is open and dropped when it closes;
 *  - a fenced block that holds HTML stays text through the highlighter;
 *  - while a followed link's file loads, the previous document is not painted.
 *
 * Each test seeds `window.__mockGitDiff`, opens the task's Changes panel on
 * README.cs.md, turns the preview on, and closes the window again, so no test
 * depends on another's state. Its project, task and session ids are its own.
 */
import { test, expect, chromium, type Browser, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-markdown-links';
const TASK_ID = 'task-markdown-links';
const SESSION_ID = 'sess-markdown-links';
const TASK_TITLE = 'Markdown Links Task';

/** A 30x30 PNG, served for every listed image. */
const LOGO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAYAAAA7MK6iAAAANUlEQVR42u3PoQ0AMAwEsQz2+ytbpeoEZSkxOnhyJT2dzHbrx/S2iImJiYmJiYmJiYmJiZ89Sdzl5oWz0ucAAAAASUVORK5CYII=';

const LOGO_PATH = 'docs/images/logo.png';
const WIDE_PATH = 'docs/images/wide.png';
/** Named by README.cs.md but absent from the fixture, so the mock finds no bytes for it. */
const ABSENT_PATH = 'docs/images/absent.png';

/** Screenshots on a reserved domain: nothing is fetched, only the chosen srcset is read. */
const DARK_SCREENSHOT = 'https://board.example.invalid/board-dark.png';
const LIGHT_SCREENSHOT = 'https://board.example.invalid/board-light.png';

/** A hostile fence body: if the highlighter's output were parsed as HTML this would run. */
const HOSTILE_FENCE_LINE = '</code><img src=x onerror="window.__fenceXss=1">';

const README_CS = [
  '<p align="center">',
  `  <img src="${LOGO_PATH}" alt="Logo" width="30" height="30" />`,
  '</p>',
  '',
  '<h1 align="center">Sample project</h1>',
  '',
  '[Deutsch](README.de.md), [German install](README.de.md#install) and [Back to deep](README.cs.md#deep-section).',
  '',
  '<picture>',
  `  <source media="(prefers-color-scheme: dark)" srcset="${DARK_SCREENSHOT}" />`,
  `  <source media="(prefers-color-scheme: light)" srcset="${LIGHT_SCREENSHOT}" />`,
  `  <source media="(min-width: 1px)" srcset="${WIDE_PATH}" />`,
  `  <source media="(min-width: 1px)" srcset="${ABSENT_PATH}" />`,
  `  <img src="${LOGO_PATH}" alt="Logo in picture" width="30" height="30" />`,
  '</picture>',
  '',
  '```ts',
  HOSTILE_FENCE_LINE,
  '```',
  '',
  ...Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1}.\n`),
  '## Deep section',
  '',
  // Enough below the heading that the pane can scroll it to its top.
  ...Array.from({ length: 80 }, (_, index) => `Closing paragraph ${index + 1}.\n`),
  '',
].join('\n');

/** Text only, so nothing loads above `## Install` and shifts the layout after the anchor lands. */
const README_DE = [
  '# Deutsche Fassung',
  '',
  'Hallo.',
  '',
  ...Array.from({ length: 60 }, (_, index) => `Fuellabsatz ${index + 1}.\n`),
  '## Install',
  '',
  // Enough below the heading that the pane can scroll it to its top.
  ...Array.from({ length: 80 }, (_, index) => `Schlussabsatz ${index + 1}.\n`),
  '',
].join('\n');

const DIFF_FIXTURE = {
  files: [
    { path: 'README.cs.md', status: 'A', insertions: 100, deletions: 0, binary: false, original: '', modified: README_CS, language: 'markdown' },
    { path: 'README.de.md', status: 'A', insertions: 100, deletions: 0, binary: false, original: '', modified: README_DE, language: 'markdown' },
    { path: LOGO_PATH, status: 'A', insertions: 0, deletions: 0, binary: true, original: '', modified: '', language: 'plaintext', modifiedImageBase64: LOGO_PNG },
    { path: WIDE_PATH, status: 'A', insertions: 0, deletions: 0, binary: true, original: '', modified: '', language: 'plaintext', modifiedImageBase64: LOGO_PNG },
  ],
};

/** How many `git.fileImage` reads the page made per repo path, and how many of them have answered. */
interface ImageReadLog {
  requested: Record<string, number>;
  settled: Record<string, number>;
}

/** The page-side state this spec reads and writes, typed once instead of cast at each call. */
interface PageProbeWindow {
  electronAPI: { git: { fileImage: (request: { filePath: string }) => Promise<unknown> } };
  __mockGitDiff: unknown;
  __openedExternalUrls: string[];
  __mockGitFileContentDeferred?: boolean;
  __mockGitFileContentResolve?: (() => void) | undefined;
  __imageReadLog?: ImageReadLog;
  __restoreFileImage?: (() => void) | undefined;
  __fenceXss?: number | undefined;
}

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
        name: 'Markdown Links Test',
        path: '/mock/markdown-links-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var laneId = 'lane-ml-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = laneId;
        state.swimlanes.push(Object.assign({}, swimlane, { id: laneId, position: index, created_at: timestamp }));
      });
      // Running session so TaskDetailBody renders and the Changes pill shows.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 8889,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/markdown-links-test',
        startedAt: timestamp,
        exitCode: null,
      });
      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: '${TASK_TITLE}',
        description: 'Task used to exercise links and images in the markdown document preview',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/worktrees/markdown-links',
        branch_name: 'feature/markdown-links',
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

/** Reset the page's hooks and wrap `git.fileImage` so each read is counted per repo path. */
async function resetPageProbes(): Promise<void> {
  await page.evaluate((fixture) => {
    const probeWindow = window as unknown as PageProbeWindow;
    probeWindow.__mockGitDiff = fixture;
    probeWindow.__openedExternalUrls = [];
    probeWindow.__fenceXss = undefined;
    probeWindow.__mockGitFileContentDeferred = false;
    probeWindow.__mockGitFileContentResolve = undefined;
    probeWindow.__imageReadLog = { requested: {}, settled: {} };
    if (probeWindow.__restoreFileImage) return;

    const gitApi = probeWindow.electronAPI.git;
    const originalFileImage = gitApi.fileImage;
    const count = (kind: 'requested' | 'settled', filePath: string) => {
      const log = probeWindow.__imageReadLog;
      if (log) log[kind][filePath] = (log[kind][filePath] ?? 0) + 1;
    };
    gitApi.fileImage = async (request) => {
      count('requested', request.filePath);
      try {
        return await originalFileImage.call(gitApi, request);
      } finally {
        count('settled', request.filePath);
      }
    };
    probeWindow.__restoreFileImage = () => {
      gitApi.fileImage = originalFileImage;
      probeWindow.__restoreFileImage = undefined;
    };
  }, DIFF_FIXTURE);
}

async function readImageLog(): Promise<ImageReadLog> {
  return page.evaluate(() => {
    const log = (window as unknown as PageProbeWindow).__imageReadLog;
    return { requested: { ...(log?.requested ?? {}) }, settled: { ...(log?.settled ?? {}) } };
  });
}

function fileRow(filePath: string): Locator {
  return page.locator(`[data-testid="changes-file-row"][data-path="${filePath}"]`);
}

function previewToggle(): Locator {
  return page.locator('[data-testid="diff-markdown-preview"]');
}

/** Open the task's Changes panel on README.cs.md and switch it to the rendered preview. */
async function openReadmePreview(): Promise<Locator> {
  await resetPageProbes();

  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="changes-toggle"]').click();

  await fileRow('README.cs.md').locator('button').first().click();
  await expect(previewToggle()).toBeVisible({ timeout: 8000 });
  await previewToggle().click();
  await expect(previewToggle()).toHaveAttribute('aria-pressed', 'true');

  const preview = page.locator('[data-testid="diff-markdown-preview-content"]');
  await expect(preview.locator('h1')).toHaveText('Sample project', { timeout: 8000 });
  return preview;
}

async function closeTaskWindow(): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as PageProbeWindow).__mockGitDiff = null;
  });
  await page.locator('[data-testid="changes-toggle"]').click();
  // Capture-phase close, as the sibling diff specs do: Escape can be taken by
  // whatever the test left focused.
  await page.keyboard.press('Control+Shift+W');
  await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
}

test.afterEach(async () => {
  // A failed test leaves its window, its image wrapper and maybe a held
  // fileContent read behind. Undo all three so the next test starts clean.
  await page.evaluate(() => {
    const probeWindow = window as unknown as PageProbeWindow;
    probeWindow.__mockGitDiff = null;
    probeWindow.__mockGitFileContentDeferred = false;
    probeWindow.__mockGitFileContentResolve?.();
    probeWindow.__restoreFileImage?.();
  });
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  if (await dialog.isVisible()) {
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  }
});

/** The pane's scroll offset of the heading `#id`, relative to the pane's top, or a large number before it exists. */
function headingOffset(preview: Locator, headingId: string): Promise<number> {
  return preview.evaluate((pane, id) => {
    const heading = pane.querySelector(`#${id}`);
    return heading ? Math.abs(heading.getBoundingClientRect().top - pane.getBoundingClientRect().top) : 9999;
  }, headingId);
}

/** Both of README.cs.md's logos have read their image. */
async function waitForLogosLoaded(preview: Locator): Promise<void> {
  const logos = preview.locator(`img[alt^="Logo"]`);
  await expect(logos).toHaveCount(2);
  for (const logo of await logos.all()) {
    await expect(logo).toHaveAttribute('src', /^data:image\/png;base64,/);
  }
}

test.describe('Changes panel markdown preview: links and images', () => {
  test('a link to another listed file with an anchor opens its preview scrolled to that heading', async () => {
    const preview = await openReadmePreview();
    expect(await preview.evaluate((pane) => pane.scrollTop)).toBe(0);

    await preview.getByRole('link', { name: 'German install' }).click();

    await expect(fileRow('README.de.md')).toHaveAttribute('data-selected', 'true');
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'true');
    await expect(preview.locator('h1')).toHaveText('Deutsche Fassung');
    // The pane scrolled, and the heading ends at its top within a few pixels.
    await expect.poll(() => preview.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => headingOffset(preview, 'user-content-install')).toBeLessThan(8);

    await closeTaskWindow();
  });

  test('a same-file anchor link scrolls the pane and keeps the file selected', async () => {
    const preview = await openReadmePreview();
    // Wait for the logos, so no image loads in after the scroll and moves the heading.
    await waitForLogosLoaded(preview);
    expect(await preview.evaluate((pane) => pane.scrollTop)).toBe(0);

    await preview.getByRole('link', { name: 'Back to deep' }).click();

    await expect.poll(() => preview.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => headingOffset(preview, 'user-content-deep-section')).toBeLessThan(8);
    await expect(fileRow('README.cs.md')).toHaveAttribute('data-selected', 'true');
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'true');
    await expect(preview.locator('h1')).toHaveText('Sample project');

    await closeTaskWindow();
  });

  test('a tree click after a followed link opens the diff, even on the file the link named', async () => {
    const preview = await openReadmePreview();
    await preview.getByRole('link', { name: 'Deutsch' }).click();
    await expect(fileRow('README.de.md')).toHaveAttribute('data-selected', 'true');
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'true');
    // The link has landed: its file's document shows.
    await expect(preview.locator('h1')).toHaveText('Deutsche Fassung');

    await fileRow('README.cs.md').locator('button').first().click();
    await expect(fileRow('README.cs.md')).toHaveAttribute('data-selected', 'true');
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'false');
    await expect(preview).toHaveCount(0);

    // The link's target was let go of when its file opened. Clicking that file
    // in the tree is a tree click like any other, so it opens its diff too.
    await fileRow('README.de.md').locator('button').first().click();
    await expect(fileRow('README.de.md')).toHaveAttribute('data-selected', 'true');
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'false');
    await expect(preview).toHaveCount(0);

    await closeTaskWindow();
  });

  test('a middle click on a listed link is cancelled and opens nothing', async () => {
    const context = page.context();
    const preview = await openReadmePreview();
    const link = preview.getByRole('link', { name: 'Deutsch' });

    // An untrusted auxclick, recorded in a bubble-phase window listener: it runs
    // after React's root listener, so it sees the handler's preventDefault. It
    // must be cancelable, or defaultPrevented stays false whatever a handler does.
    const dispatchAuxClick = (target: Locator) => target.evaluate((element) => {
      let defaultPrevented: boolean | null = null;
      const record = (event: Event) => { defaultPrevented = event.defaultPrevented; };
      window.addEventListener('auxclick', record);
      element.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
      window.removeEventListener('auxclick', record);
      return defaultPrevented;
    });
    // Control: an element with no handler leaves the event alone, so the probe tells the two apart.
    expect(await dispatchAuxClick(preview.locator('h1'))).toBe(false);
    expect(await dispatchAuxClick(link)).toBe(true);

    // Control for the trusted check below: a plain link that nothing cancels
    // does open a page on a real middle click in this browser.
    await page.evaluate(() => {
      const plainLink = document.createElement('a');
      plainLink.id = 'aux-click-control';
      plainLink.href = 'about:blank';
      plainLink.textContent = 'aux-click control';
      plainLink.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483647; padding: 4px; background: #fff; color: #000;';
      document.body.appendChild(plainLink);
    });
    const controlPagePromise = context.waitForEvent('page', { timeout: 5000 });
    await page.locator('#aux-click-control').click({ button: 'middle' });
    const controlPage = await controlPagePromise;
    await controlPage.close();
    await page.evaluate(() => document.getElementById('aux-click-control')?.remove());

    // A trusted middle click on the app's link. A non-occurrence cannot be
    // polled for, so the page event gets a fixed one-second budget, a span in
    // which the control above opened its page.
    const openedPagePromise = context.waitForEvent('page', { timeout: 1000 }).then(() => true, () => false);
    await link.click({ button: 'middle' });
    expect(await openedPagePromise).toBe(false);

    // Nothing else happened either: still README.cs.md, no OS hand-off.
    await expect(fileRow('README.cs.md')).toHaveAttribute('data-selected', 'true');
    await expect(fileRow('README.de.md')).toHaveAttribute('data-selected', 'false');
    await expect(preview.locator('h1')).toHaveText('Sample project');
    expect(await page.evaluate(() => (window as unknown as PageProbeWindow).__openedExternalUrls)).toEqual([]);

    await closeTaskWindow();
  });

  test('a relative <source srcset> reads its repo image, and one the diff does not hold is dropped', async () => {
    const preview = await openReadmePreview();
    await waitForLogosLoaded(preview);

    // Both relative sources have been asked for and answered, so neither is
    // still "loading", which also renders nothing. Whether a read is repeated
    // is the cache test's business, not this one's.
    await expect.poll(async () => {
      const { settled } = await readImageLog();
      return [(settled[WIDE_PATH] ?? 0) > 0, (settled[ABSENT_PATH] ?? 0) > 0];
    }).toEqual([true, true]);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    const relativeSources = preview.locator('picture source[media="(min-width: 1px)"]');
    await expect(relativeSources).toHaveCount(1);
    await expect(relativeSources.first()).toHaveAttribute('srcset', /^data:image\/png;base64,/);
    // Nothing of the missing file reaches the DOM, as a source or as anything else.
    const pictureHtml = await preview.locator('picture').evaluate((element) => element.outerHTML);
    expect(pictureHtml).not.toContain('absent.png');

    await closeTaskWindow();
  });

  test('image reads are cached while the preview is open and dropped when it closes', async () => {
    const preview = await openReadmePreview();
    await waitForLogosLoaded(preview);

    // The logo appears twice in the document and is read once.
    const readsAtOpen = (await readImageLog()).requested;
    expect(readsAtOpen[LOGO_PATH]).toBe(1);

    // A theme preview re-renders the document with new options, and the text
    // and revision stay the same.
    const pictureScheme = preview.locator('picture source:not([media])');
    await expect(pictureScheme).toHaveAttribute('srcset', DARK_SCREENSHOT);
    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByTestId('theme-grid').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByTestId('theme-tile-clay').hover();
    // The document followed the theme, so its components did re-render.
    await expect(pictureScheme).toHaveAttribute('srcset', LIGHT_SCREENSHOT);
    await page.getByTestId('setting-row-theme').locator(':scope > div').first().hover();
    await expect(pictureScheme).toHaveAttribute('srcset', DARK_SCREENSHOT);
    // The panel's backdrop covers the title bar's settings button; Escape closes it.
    await page.keyboard.press('Escape');
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 3000 });
    expect((await readImageLog()).requested).toEqual(readsAtOpen);

    // Turning the preview off drops the cache, so turning it on reads again.
    await previewToggle().click();
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'false');
    await expect(preview).toHaveCount(0);
    await previewToggle().click();
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'true');
    await waitForLogosLoaded(preview);
    expect((await readImageLog()).requested[LOGO_PATH]).toBe(2);

    await closeTaskWindow();
  });

  test('a fenced block that holds HTML stays text after it is highlighted', async () => {
    const preview = await openReadmePreview();
    const hostileBlock = preview.locator('pre code.language-ts');

    // Monaco's colorizer tokenizes the block into its `mtk` spans. Only after
    // that is the highlighter's output in the DOM, so the checks below look at it.
    await expect.poll(() => hostileBlock.locator('span[class^="mtk"]').count(), { timeout: 8000 }).toBeGreaterThan(0);
    await expect(preview.locator('pre img')).toHaveCount(0);
    await expect(preview.locator('img[src="x"]')).toHaveCount(0);
    await expect(hostileBlock).toContainText('<img');
    await expect(hostileBlock).toContainText('window.__fenceXss=1');
    expect(await page.evaluate(() => (window as unknown as PageProbeWindow).__fenceXss)).toBeUndefined();

    await closeTaskWindow();
  });

  test('while a followed link\'s file loads, the previous document is not painted', async () => {
    const preview = await openReadmePreview();
    await expect(preview.locator('h1')).toHaveText('Sample project');

    // Hold the next file read (the mock holds one call at a time), then follow the link.
    await page.evaluate(() => {
      const probeWindow = window as unknown as PageProbeWindow;
      probeWindow.__mockGitFileContentResolve = undefined;
      probeWindow.__mockGitFileContentDeferred = true;
    });
    await preview.getByRole('link', { name: 'Deutsch' }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as PageProbeWindow).__mockGitFileContentResolve)).toBe('function');

    // README.de.md is selected with its preview on, but its text has not arrived:
    // a spinner stands where the document goes, and README.cs.md's h1 is gone.
    const editorArea = page.locator('[data-testid="diff-editor-area"]');
    await expect(fileRow('README.de.md')).toHaveAttribute('data-selected', 'true');
    await expect(previewToggle()).toHaveAttribute('aria-pressed', 'true');
    await expect(editorArea.locator('.animate-spin')).toBeVisible();
    await expect(preview).toHaveCount(0);
    await expect(editorArea.getByRole('heading', { name: 'Sample project' })).toHaveCount(0);

    await page.evaluate(() => (window as unknown as PageProbeWindow).__mockGitFileContentResolve?.());
    await expect(preview.locator('h1')).toHaveText('Deutsche Fassung');
    await expect(editorArea.getByRole('heading', { name: 'Sample project' })).toHaveCount(0);

    await closeTaskWindow();
  });
});
