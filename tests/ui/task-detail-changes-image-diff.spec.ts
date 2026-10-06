/**
 * UI tests for the Changes panel's image view (ImageDiffView inside DiffViewer):
 * raster images and SVG previews in place of "Binary file - cannot display diff".
 *
 * Fixtures are real PNG bytes. The mock's git.fileImage decodes each entry's
 * `originalImageBase64` / `modifiedImageBase64` into a Uint8Array, mirroring
 * DiffService.getImageContent, and the renderer then decodes them for real in
 * headless Chromium, so dimensions and decode failures are genuine.
 *
 * BEFORE_PNG is 40x60 with one light block; AFTER_PNG is 40x80 with the block
 * moved down and a green strip added (so its dimensions differ);
 * BEFORE_PNG_REENCODED has BEFORE_PNG's exact pixels at another zlib level, so
 * its bytes differ while no pixel does.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const BEFORE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAA8CAYAAAAUufjgAAAATklEQVR42u3VOQEAMAzEsIDIUP64jksLo58G79pc3WOeXAECAgICXghMsiVAQEBAwFeAXgwICAgICAgICAgICAgICAgICAgICAgI+AFwAf9AaeNRFUGBAAAAAElFTkSuQmCC';
const AFTER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACgAAABQCAYAAABrjzfBAAAAZUlEQVR42u3VIREAIBAAQUIgSIUkFBm/C2TA8Ayz4vy6K7W29XIFEBAQEBAQEPAYGBEpAQICAgL+AvRiQEBAQEBAQEBAQEBAQEBAQEBAQEDALOCYPSVAQEDAV4BOAggICAgIeK0NdGQuLrRnD0gAAAAASUVORK5CYII=';
const BEFORE_PNG_REENCODED = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAA8CAYAAAAUufjgAAAAoklEQVR4Ae3UMQrAIBBEUQ9hkfufa+9isFiwsDGf4Ba/EANhcPMc0np/RuXVKg83Z3NAekMKKkgFaN4O/iIYEePG2n3M9opvDDfPdEAqr6CC2QEq8TWf56+7v5kTzVUun7eC+bLC7oD0FhRUkArQvB1UkArQvB1UkArQvB1UkArQvB1UkArQvB1UkArQvB1UkArQvB1UkArQvB1UkArQfPkOvv9AaeOMSrvdAAAAAElFTkSuQmCC';
const ADDED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAYAAAA7MK6iAAAANUlEQVR42u3PoQ0AMAwEsQz2+ytbpeoEZSkxOnhyJT2dzHbrx/S2iImJiYmJiYmJiYmJiZ89Sdzl5oWz0ucAAAAASUVORK5CYII=';
const NOT_AN_IMAGE = Buffer.from('this text is not image data').toString('base64');
const LFS_POINTER = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 12345\n').toString('base64');
const OVER_PREVIEW_CAP = 11 * 1024 * 1024;

const SVG_BEFORE = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1f2a1d"/></svg>\n';
const SVG_AFTER = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1f2a1d"/><circle cx="50" cy="50" r="7" fill="#f87171"/></svg>\n';

const PROJECT_ID = 'proj-image-diff';
const TASK_ID = 'task-image-diff';
const SESSION_ID = 'sess-image-diff';

interface FixtureFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
  binary: boolean;
  original?: string;
  modified?: string;
  language?: string;
  originalImageBase64?: string;
  modifiedImageBase64?: string;
  originalImageSize?: number;
  modifiedImageSize?: number;
}

function pngFile(filePath: string, overrides: Partial<FixtureFile> = {}): FixtureFile {
  return {
    path: filePath,
    status: 'M',
    binary: true,
    originalImageBase64: BEFORE_PNG,
    modifiedImageBase64: AFTER_PNG,
    ...overrides,
  };
}

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Image Diff Test', path: '/mock/image-diff-test',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-img-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });
    // A running session renders TaskDetailBody, where the Changes pill lives.
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 8889,
      status: 'running', shell: 'bash', cwd: '/mock/image-diff-test', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', display_id: 1, title: 'Image Diff Task', description: 'Exercises the image view',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/image-diff', branch_name: 'feature/image-diff', pr_number: null,
      pr_url: null, base_branch: 'main', archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

/** Seed the diff, open the task, open its Changes panel, and select `selectPath`. */
async function openChanges(files: FixtureFile[], selectPath: string): Promise<void> {
  await page.evaluate((seed) => {
    (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = { files: seed };
  }, files);
  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Image Diff Task').first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="changes-toggle"]').click();
  await selectFile(selectPath);
}

async function selectFile(filePath: string): Promise<void> {
  const row = page.locator(`[data-testid="changes-file-row"][data-path="${filePath}"]`);
  await row.waitFor({ state: 'visible', timeout: 8000 });
  await row.locator('button').first().click();
}

async function closeChanges(): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockGitDiff = null;
  });
  await page.locator('[data-testid="changes-toggle"]').click();
  await page.keyboard.press('Control+Shift+W');
  await expect(page.locator('[data-testid="task-detail-dialog"]')).not.toBeVisible({ timeout: 8000 });
}

test.describe('Changes panel image view', () => {
  test('a modified PNG shows both images, with the info bar beside the stage, never inside it', async () => {
    await openChanges([pngFile('shots/home.png')], 'shots/home.png');

    const view = page.locator('[data-testid="diff-image-view"]');
    await expect(view).toBeVisible({ timeout: 8000 });
    await expect(page.locator('text=Binary file - cannot display diff')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-image-before"] img')).toBeVisible();
    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible();

    // Dimensions come from a real decode; the taller After flags its change.
    await expect(page.locator('[data-testid="diff-image-info-before-dimensions"]')).toHaveText('40 x 60');
    const afterDimensions = page.locator('[data-testid="diff-image-info-after-dimensions"]');
    await expect(afterDimensions).toHaveText('40 x 80');
    await expect(afterDimensions).toHaveClass(/text-modified/);
    await expect(page.locator('[data-testid="diff-image-info-before-dimensions"]')).not.toHaveClass(/text-modified/);
    // 158 - 135 bytes.
    await expect(page.locator('[data-testid="diff-image-size-delta"]')).toHaveText('+23 B');

    // The metadata lives in its own bar, a sibling of the stage.
    await expect(page.locator('[data-testid="diff-image-stage"] [data-testid="diff-image-info"]')).toHaveCount(0);
    await expect(view.locator('> [data-testid="diff-image-info"]')).toHaveCount(1);

    // Toolbar: only the layout toggle; the text-diff controls do not apply.
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-prev-change"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-view-options"]')).toHaveCount(0);

    await closeChanges();
  });

  test('Slider, Overlay and Diff draw both images on one canvas, and only Side by side keeps the layout toggle', async () => {
    await openChanges([pngFile('shots/modes.png')], 'shots/modes.png');
    const view = page.locator('[data-testid="diff-image-view"]');
    await expect(view).toBeVisible({ timeout: 8000 });
    const areaTop = () => page.locator('[data-testid="diff-editor-area"]').evaluate((element) => element.getBoundingClientRect().top);
    const topInSideBySide = await areaTop();

    await page.locator('[data-testid="diff-image-mode-slider"]').click();
    await expect(view).toHaveAttribute('data-mode', 'slider');
    // The toolbar loses its layout toggle here; its row must not shrink and shift the pane.
    expect(Math.abs((await areaTop()) - topInSideBySide)).toBeLessThan(1);
    await expect(page.locator('[data-testid="diff-image-composite"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-view-split"]')).toHaveCount(0);
    await page.locator('[data-testid="diff-image-slider"]').fill('25');
    await expect.poll(() => page.locator('[data-testid="diff-image-after-layer"]').evaluate((element) => (element as HTMLElement).style.clipPath))
      .toBe('inset(0px 0px 0px 25%)');

    await page.locator('[data-testid="diff-image-mode-overlay"]').click();
    await expect(view).toHaveAttribute('data-mode', 'overlay');
    await page.locator('[data-testid="diff-image-overlay-opacity"]').fill('80');
    await expect.poll(() => page.locator('[data-testid="diff-image-after-layer"]').evaluate((element) => (element as HTMLElement).style.opacity))
      .toBe('0.8');

    await page.locator('[data-testid="diff-image-mode-diff"]').click();
    await expect(view).toHaveAttribute('data-mode', 'diff');
    const stat = page.locator('[data-testid="diff-image-pixel-stat"]');
    await expect(stat).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    // Derived from the fixtures, the way the worker counts. The canvas both
    // images fit is 40 x 80 = 3,200 pixels. Where both exist (40 x 60) the light
    // block moved down 4 rows, so 2 bands of 4 rows x 30 columns differ: 240.
    // The 40 x 20 strip only After covers is changed by definition: 800.
    // 1,040 / 3,200 = 32.5%. Hard-edged blocks have no anti-aliased pixels to drop.
    await expect(stat).toHaveText('32.5% of pixels changed');
    await expect(stat).toHaveAttribute('title', /^1,?040 of 3,?200 pixels differ$/);
    await expect(page.locator('[data-testid="diff-image-diff-mask"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-image-stage"] [data-testid="diff-image-pixel-stat"]')).toHaveCount(0);

    await page.locator('[data-testid="diff-image-mode-side-by-side"]').click();
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();

    await closeChanges();
  });

  test('the mode persists across files, two encodings of the same pixels read as no change, and the change keys roll between images', async () => {
    await openChanges([
      pngFile('shots/a.png'),
      pngFile('shots/b.png', { modifiedImageBase64: BEFORE_PNG_REENCODED }),
    ], 'shots/a.png');
    const view = page.locator('[data-testid="diff-image-view"]');
    await expect(view).toBeVisible({ timeout: 8000 });
    await page.locator('[data-testid="diff-image-mode-diff"]').click();
    await expect(page.locator('[data-testid="diff-image-pixel-stat"]')).toHaveAttribute('data-status', 'done', { timeout: 10000 });

    // Next change from an image: no hunks to visit, so it rolls to the next file.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator('[data-testid="changes-file-row"][data-path="shots/b.png"]')).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
    await expect(view).toHaveAttribute('data-mode', 'diff');
    const stat = page.locator('[data-testid="diff-image-pixel-stat"]');
    await expect(stat).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await expect(stat).toHaveText('No pixel changes');
    // Same pixels, different bytes: the size still changed.
    await expect(page.locator('[data-testid="diff-image-size-delta"]')).toBeVisible();

    await closeChanges();
  });

  test('Added and Deleted images show one side, one unlabelled tile, and no mode row', async () => {
    await openChanges([
      { path: 'shots/new.png', status: 'U', binary: true, modifiedImageBase64: ADDED_PNG },
      { path: 'shots/old.png', status: 'D', binary: true, originalImageBase64: BEFORE_PNG },
    ], 'shots/new.png');

    await expect(page.locator('[data-testid="diff-image-single"] img')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-info-before"]')).toHaveCount(0);
    const addedTile = page.locator('[data-testid="diff-image-info-after"]');
    await expect(page.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('30 x 30');
    await expect(addedTile).not.toContainText('After');
    await expect(page.locator('[data-testid="diff-image-modes"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-view-split"]')).toHaveCount(0);

    await selectFile('shots/old.png');
    await expect(page.locator('[data-testid="diff-image-info-before-dimensions"]')).toHaveText('40 x 60', { timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-info-after"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-image-single"] img')).toBeVisible();

    await closeChanges();
  });

  test('too large, undecodable and Git LFS sides fall back without breaking the view', async () => {
    await openChanges([
      pngFile('shots/huge.png', { originalImageSize: OVER_PREVIEW_CAP, modifiedImageSize: OVER_PREVIEW_CAP }),
      pngFile('shots/broken.png', { originalImageBase64: NOT_AN_IMAGE }),
      pngFile('shots/lfs.png', { originalImageBase64: LFS_POINTER }),
    ], 'shots/huge.png');

    await expect(page.locator('[data-testid="diff-image-too-large"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-info-before-size"]')).toHaveText('11 MB');
    await expect(page.locator('[data-testid="diff-image-modes"]')).toHaveCount(0);

    await selectFile('shots/broken.png');
    await expect(page.locator('[data-testid="diff-image-before"] [data-testid="diff-image-placeholder"]')).toHaveAttribute('data-reason', 'undecodable', { timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible();
    // Comparing on one canvas needs both images, so only Side by side is offered.
    await expect(page.locator('[data-testid="diff-image-mode-slider"]')).toBeDisabled();
    await expect(page.locator('[data-testid="diff-image-mode-overlay"]')).toBeDisabled();
    await expect(page.locator('[data-testid="diff-image-mode-diff"]')).toBeDisabled();
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();

    await selectFile('shots/lfs.png');
    await expect(page.locator('[data-testid="diff-image-before"] [data-testid="diff-image-placeholder"]')).toHaveAttribute('data-reason', 'lfs-pointer', { timeout: 8000 });

    await closeChanges();
  });

  test('an SVG opens on its text diff, and the Eye toggle swaps in the image view until the file changes', async () => {
    const svgFile = (filePath: string): FixtureFile => ({
      path: filePath, status: 'M', binary: false, original: SVG_BEFORE, modified: SVG_AFTER, language: 'xml',
    });
    await openChanges([svgFile('assets/icon.svg'), svgFile('assets/other.svg')], 'assets/icon.svg');

    const toggle = page.locator('[data-testid="diff-svg-preview"]');
    await expect(toggle).toBeVisible({ timeout: 8000 });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveAttribute('title', 'Preview image');
    await expect(page.locator('[data-testid="diff-prev-change"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-image-view"]')).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('title', 'Show text diff');
    await expect(page.locator('[data-testid="diff-image-before"] img')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible();
    await expect(page.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('64 x 64');
    await expect(page.locator('[data-testid="diff-prev-change"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-view-options"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diff-view-split"]')).toBeVisible();

    await selectFile('assets/other.svg');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-testid="diff-image-view"]')).toHaveCount(0);

    await closeChanges();
  });

  test('an SVG git treats as binary opens straight into the image view, with no toggle', async () => {
    await openChanges([
      { path: 'assets/badge.svg', status: 'M', binary: true, original: SVG_BEFORE, modified: SVG_AFTER, language: 'xml' },
    ], 'assets/badge.svg');

    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-svg-preview"]')).toHaveCount(0);
    await expect(page.locator('text=Binary file - cannot display diff')).toHaveCount(0);

    await closeChanges();
  });

  test('below 300px the mode row drops to named icons and the info tiles stack without clipping', async () => {
    await openChanges([pngFile('shots/narrow.png')], 'shots/narrow.png');
    const view = page.locator('[data-testid="diff-image-view"]');
    await expect(view).toBeVisible({ timeout: 8000 });

    // The view is its own container, so its width alone drives the collapse.
    await view.evaluate((element) => { (element as HTMLElement).style.width = '240px'; });
    const sideBySide = page.locator('[data-testid="diff-image-mode-side-by-side"]');
    await expect(sideBySide.locator('span')).toBeHidden();
    await expect(sideBySide).toHaveAttribute('aria-label', 'Side by side');
    await expect(sideBySide).toHaveAttribute('title', 'Side by side');

    const layout = async () => page.evaluate(() => {
      const box = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
      const clips = (testId: string) => {
        const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
        return element.scrollWidth > element.clientWidth + 1;
      };
      const before = box('diff-image-info-before');
      const after = box('diff-image-info-after');
      return {
        stacked: before.bottom <= after.top + 1,
        sameRow: Math.abs(before.top - after.top) < 2,
        clipped: clips('diff-image-info-before') || clips('diff-image-info-after'),
      };
    });
    await expect.poll(layout).toEqual({ stacked: true, sameRow: false, clipped: false });

    // Narrower than one line (a pane whose rail is already at its 160px floor):
    // the size pill wraps, and the tile must grow to hold it rather than clip it.
    await view.evaluate((element) => { (element as HTMLElement).style.width = '190px'; });
    await expect.poll(() => page.evaluate(() => {
      const tile = document.querySelector('[data-testid="diff-image-info-after"]')!.getBoundingClientRect();
      const pill = document.querySelector('[data-testid="diff-image-size-delta"]')!.getBoundingClientRect();
      return pill.bottom <= tile.bottom + 0.5 && pill.right <= tile.right + 0.5;
    })).toBe(true);

    await view.evaluate((element) => { (element as HTMLElement).style.width = '330px'; });
    await expect(sideBySide.locator('span')).toBeVisible();
    await expect.poll(layout).toEqual({ stacked: false, sameRow: true, clipped: false });

    await view.evaluate((element) => { (element as HTMLElement).style.width = ''; });
    await closeChanges();
  });

  test('dragging the rail to its limit keeps the diff pane inside the window', async () => {
    // A long path: the toolbar's full path width used to set the pane's minimum
    // width, so a narrow pane overflowed the task window's right edge.
    const longPath = 'store/screenshots/android/phone/seven-inch/landscape/01-agents-overview.png';
    await openChanges([pngFile(longPath)], longPath);
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });

    const divider = page.locator('[data-testid="changes-tree-resize"]');
    const dividerBox = await divider.boundingBox();
    const dialogBox = await page.locator('[data-testid="task-detail-dialog"]').boundingBox();
    expect(dividerBox).not.toBeNull();
    expect(dialogBox).not.toBeNull();
    await page.mouse.move(dividerBox!.x + dividerBox!.width / 2, dividerBox!.y + dividerBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(dialogBox!.x + dialogBox!.width - 5, dividerBox!.y + dividerBox!.height / 2, { steps: 12 });
    await page.mouse.up();

    const overflow = async () => page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="task-detail-dialog"]')!.getBoundingClientRect();
      const pane = document.querySelector('[data-testid="diff-image-view"]')!.getBoundingClientRect();
      return { insideWindow: pane.right <= dialog.right + 1, narrow: pane.width < 300 };
    });
    await expect.poll(overflow).toEqual({ insideWindow: true, narrow: true });
    await expect(page.locator('[data-testid="diff-image-mode-side-by-side"] span')).toBeHidden();

    // Put the rail back so later tests (and the persisted width) start from the default.
    await divider.dblclick();
    await closeChanges();
  });
});

test.describe('per-file pop-out', () => {
  test('a changes-file window renders the image view through its own fetch path', async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const popOutPage = await context.newPage();
    await popOutPage.addInitScript({ path: MOCK_SCRIPT });
    await popOutPage.addInitScript(preConfig);
    await popOutPage.addInitScript(`
      window.__mockGitDiff = { files: ${JSON.stringify([pngFile('shots/popout.png')])} };
      window.electronAPI.popOut.descriptor = {
        kind: 'changes-file',
        params: {
          taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', filePath: 'shots/popout.png', scope: 'branch',
          projectPath: '/mock/image-diff-test', worktreePath: '/mock/worktrees/image-diff', baseBranch: 'main',
          status: 'M', binary: true, taskDisplayId: 1, taskTitle: 'Image Diff Task',
        },
      };
    `);
    await popOutPage.goto(VITE_URL);
    await expect(popOutPage.locator('[data-testid="diff-image-before"] img')).toBeVisible({ timeout: 15000 });
    await expect(popOutPage.locator('[data-testid="diff-image-after"] img')).toBeVisible();
    await expect(popOutPage.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('40 x 80');
    await context.close();
  });
});
