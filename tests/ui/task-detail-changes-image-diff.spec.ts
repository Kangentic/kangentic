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
 * its bytes differ while no pixel does. solidPng builds PNGs of any size and
 * colour on the spot (stored, uncompressed pixels), so the live-refresh test can
 * regenerate an image at the exact byte length it had, and speckledPng adds one
 * tiny hard-edged square so a pair can differ in only a handful of pixels.
 *
 * The "live refresh and change navigation" describe covers what happens around a
 * diff-changed push and the change keys: the refresh repaints an image whose
 * bytes changed, and rolling into an image leaves no pending first-change
 * request behind.
 *
 * The "Diff mode outcomes and copy" describe pins what the pixel comparison
 * reports: a remembered result is not compared again, a canvas over the pixel
 * cap reads as failed, an SVG compares at its scaled-up size, the stat and
 * size-change copy for the small-change and shrinking-file cases, and that a
 * raster image is decoded by the worker while an SVG is decoded on the page.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import zlib from 'node:zlib';
import { settleFrames, waitForViteReady } from './helpers';

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
// 5000 x 5000 is 25,000,000 pixels at scale 1, over the Diff mode's 4096 x 4096
// cap, yet two tiny strings: the over-cap path needs no heavy fixture.
const HUGE_SVG_BEFORE = '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000" viewBox="0 0 5000 5000"><rect width="5000" height="5000" fill="#1f2a1d"/></svg>\n';
const HUGE_SVG_AFTER = '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000" viewBox="0 0 5000 5000"><rect width="5000" height="5000" fill="#1f2a1d"/><circle cx="2500" cy="2500" r="400" fill="#f87171"/></svg>\n';

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

function crc32(bytes: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

type RgbColor = readonly [number, number, number];

/**
 * An opaque RGBA PNG whose pixel at (column, row) is `colorAt(column, row)`,
 * base64 encoded. zlib level 0 stores the pixels uncompressed, so the byte
 * length depends on the dimensions alone and never on the colours: two images
 * at one size are two files of the exact same length.
 */
function encodeRgbaPng(width: number, height: number, colorAt: (column: number, row: number) => RgbColor): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const scanlines: Buffer[] = [];
  for (let row = 0; row < height; row++) {
    const scanline = Buffer.alloc(1 + width * 4); // filter byte 0 (none), then the pixels
    for (let column = 0; column < width; column++) {
      const [red, green, blue] = colorAt(column, row);
      scanline.set([red, green, blue, 255], 1 + column * 4);
    }
    scanlines.push(scanline);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(scanlines), { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

/** A solid-colour RGBA PNG, base64 encoded. */
function solidPng(width: number, height: number, red: number, green: number, blue: number): string {
  return encodeRgbaPng(width, height, () => [red, green, blue]);
}

const SPECK_EDGE = 2;

/**
 * A solid `base` PNG with one hard-edged `SPECK_EDGE` x `SPECK_EDGE` square of
 * `speck` colour at the middle. Against a solid PNG of the `base` colour and the
 * same size it differs in exactly SPECK_EDGE squared pixels, as long as `speck`
 * is far from `base`: the square sits clear of every border, and a block that
 * size has no anti-aliased pixels to drop.
 */
function speckledPng(width: number, height: number, base: RgbColor, speck: RgbColor): string {
  const speckLeft = Math.floor(width / 2);
  const speckTop = Math.floor(height / 2);
  return encodeRgbaPng(width, height, (column, row) => {
    const insideSpeck = column >= speckLeft && column < speckLeft + SPECK_EDGE && row >= speckTop && row < speckTop + SPECK_EDGE;
    return insideSpeck ? speck : base;
  });
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

interface PixelDiffPostCounter {
  /** How many comparisons have been handed to the pixel-diff worker since the counter was installed. */
  posts: () => Promise<number>;
  /** Put the page's own postMessage back. Belongs in a `finally`, so a failed test cannot leave the shared page patched. */
  restore: () => Promise<void>;
}

/**
 * Count the requests the page posts to the pixel-diff worker (the only worker
 * messages that carry both a `before` and an `after` bitmap). Install it before
 * the Diff mode is first entered so no comparison goes uncounted.
 */
async function countPixelDiffPosts(): Promise<PixelDiffPostCounter> {
  await page.evaluate(() => {
    const counter = window as unknown as { __pixelDiffPosts: number; __restorePostMessage: () => void };
    counter.__pixelDiffPosts = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: unknown) {
      if (message !== null && typeof message === 'object' && 'before' in message && 'after' in message) counter.__pixelDiffPosts += 1;
      return (originalPostMessage as (this: Worker, message: unknown, transfer?: unknown) => void).call(this, message, transfer);
    } as Worker['postMessage'];
    counter.__restorePostMessage = () => { Worker.prototype.postMessage = originalPostMessage; };
  });
  return {
    posts: () => page.evaluate(() => (window as unknown as { __pixelDiffPosts: number }).__pixelDiffPosts),
    restore: () => page.evaluate(() => (window as unknown as { __restorePostMessage: () => void }).__restorePostMessage()),
  };
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
    expect(Math.abs((await areaTop()) - topInSideBySide)).toBeLessThan(2);
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

  test('an image whose read fails says so instead of spinning, and reads again when selected again', async () => {
    // The panel falls back to empty content when a fetch throws, and empty
    // content has no image: the view used to wait on it forever.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitFileImageReject = true;
    });
    await openChanges([pngFile('shots/gone.png'), pngFile('shots/other.png')], 'shots/gone.png');

    await expect(page.locator('[data-testid="diff-image-load-failed"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-load-failed"]')).toHaveText('Could not read this image');
    await expect(page.locator('[data-testid="diff-editor-area"] .animate-spin')).toHaveCount(0);

    // The failure is not cached: coming back reads the image again.
    await selectFile('shots/other.png');
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });
    await selectFile('shots/gone.png');
    await expect(page.locator('[data-testid="diff-image-before"] img')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-load-failed"]')).toHaveCount(0);

    await closeChanges();
  });

  test('a Diff view that mounts twice for one image pair runs one comparison, not two', async () => {
    // Stepping to an uncached image in Diff mode unmounts the view for the
    // loading spinner and mounts it again in Diff, and React StrictMode (on in
    // this dev build) runs that mount's effect twice. The second request must
    // join the first comparison rather than decode both images and queue a
    // second one behind it in the worker.
    await openChanges([pngFile('shots/first.png'), pngFile('shots/second.png')], 'shots/first.png');
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });
    const { posts, restore } = await countPixelDiffPosts();
    const pixelStat = page.locator('[data-testid="diff-image-pixel-stat"]');

    try {
      await page.locator('[data-testid="diff-image-mode-diff"]').click();
      await expect(pixelStat).toHaveAttribute('data-status', 'done', { timeout: 10000 });
      expect(await posts()).toBe(1);

      await selectFile('shots/second.png');
      await expect(page.locator('[data-testid="changes-file-row"][data-path="shots/second.png"]')).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
      await expect.poll(posts, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
      await expect(pixelStat).toHaveAttribute('data-status', 'done', { timeout: 10000 });
      expect(await posts()).toBe(2);
    } finally {
      await restore();
    }

    await closeChanges();
  });

  test('an SVG whose image read fails keeps its text diff, and only its preview reports the failure', async () => {
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitFileImageReject = true;
    });
    await openChanges([{ path: 'icons/broken.svg', status: 'M', binary: false, original: SVG_BEFORE, modified: SVG_AFTER, language: 'xml' }], 'icons/broken.svg');

    // The text diff is the SVG's own, not the empty diff a failed fetch leaves.
    await expect(page.locator('[data-testid="diff-editor-area"] .monaco-diff-editor')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-editor-area"]')).toContainText('circle', { timeout: 8000 });

    await page.locator('[data-testid="diff-svg-preview"]').click();
    await expect(page.locator('[data-testid="diff-image-load-failed"]')).toBeVisible({ timeout: 8000 });

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

interface RecordedFileImageCall {
  filePath: string;
  knownFingerprints?: { original?: string; modified?: string };
  result: { original: { kind: string } | null; modified: { kind: string } | null };
}

type MockGitWindow = {
  __mockGitDiff: { files: FixtureFile[] };
  __mockFireDiffChanged?: () => void;
  __mockGitFileContentDeferred?: boolean;
  __mockGitFileContentResolve?: () => void;
  __mockGitFileImageCalls?: RecordedFileImageCall[];
  __mockGitFileImageDeferred?: boolean;
  __mockGitFileImageResolve?: () => void;
};

/** What the fileImage mock recorded for one file, with each answered side reduced to its kind (bytes stay in the page). */
interface FileImageCallSummary {
  sentFingerprints: { original?: string; modified?: string } | undefined;
  answeredKinds: { original: string | null; modified: string | null };
}

async function readFileImageCalls(target: Page, filePath: string): Promise<FileImageCallSummary[]> {
  return target.evaluate((wantedPath) => {
    const calls = (window as unknown as MockGitWindow).__mockGitFileImageCalls ?? [];
    return calls
      .filter((call) => call.filePath === wantedPath)
      .map((call) => ({
        sentFingerprints: call.knownFingerprints
          ? { original: call.knownFingerprints.original, modified: call.knownFingerprints.modified }
          : undefined,
        answeredKinds: { original: call.result.original?.kind ?? null, modified: call.result.modified?.kind ?? null },
      }));
  }, filePath);
}

/** The next image read is held, so a test can observe the view while the content for a newly selected file is still on its way. */
async function holdNextImageRead(): Promise<void> {
  await page.evaluate(() => {
    const mockWindow = window as unknown as MockGitWindow;
    mockWindow.__mockGitFileImageResolve = undefined;
    mockWindow.__mockGitFileImageDeferred = true;
  });
}

async function releaseHeldImageRead(): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => typeof (window as unknown as MockGitWindow).__mockGitFileImageResolve === 'function'),
    { timeout: 8000 },
  ).toBe(true);
  await page.evaluate(() => (window as unknown as MockGitWindow).__mockGitFileImageResolve?.());
}

interface DiffEditorHandle {
  getModifiedEditor: () => {
    getScrollTop: () => number;
    getScrollHeight: () => number;
    setScrollTop: (scrollTop: number) => void;
  };
  getLineChanges: () => { modifiedStartLineNumber: number }[] | null;
}

interface MonacoTestHandle {
  editor: { getDiffEditors: () => DiffEditorHandle[] };
}

interface MountedDiffState {
  mounted: boolean;
  /** -1 until the mounted editor's diff has landed; 0 for an empty diff. */
  changeCount: number;
  /** Modified-side line of the first computed change, or -1. */
  firstChangeLine: number;
}

/** Read the live diff editor through the dev-only monaco handle (`window.__monaco`). */
async function readDiffState(): Promise<MountedDiffState> {
  return page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) return { mounted: false, changeCount: -1, firstChangeLine: -1 };
    const lineChanges = diffEditors[0].getLineChanges();
    return {
      mounted: true,
      changeCount: lineChanges === null ? -1 : lineChanges.length,
      firstChangeLine: lineChanges?.[0]?.modifiedStartLineNumber ?? -1,
    };
  });
}

/** Drive the modified side to its bottom; Monaco saturates an over-large offset at the real maximum. */
async function scrollModifiedToBottom(): Promise<void> {
  await page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
    const modifiedEditor = monaco?.editor.getDiffEditors()[0]?.getModifiedEditor();
    modifiedEditor?.setScrollTop(modifiedEditor.getScrollHeight());
  });
}

const LONG_FILE_LINES = 400;
const LONG_FILE_CHANGE_LINE = 100;
const LONG_FILE_CHANGE_TOKEN = 'FIRST_HUNK_TOKEN_AAA';
const LONG_FILE_TAIL_TOKEN = 'TAIL_OF_FILE_TOKEN_ZZZ';

/**
 * A file far taller than the pane, with one change at line 100 and an unchanged
 * tail token on its last line. Monaco virtualizes lines, so which token has a
 * `.view-line` in the DOM says which end of the file the viewport is on: the
 * first-change reveal centers line 100, a restored bottom position shows the tail.
 */
function longTextFile(filePath: string): FixtureFile {
  const originalLines: string[] = [];
  for (let lineNumber = 1; lineNumber <= LONG_FILE_LINES; lineNumber++) {
    originalLines.push(lineNumber === LONG_FILE_LINES ? `// ${LONG_FILE_TAIL_TOKEN} ${lineNumber}` : `// filler line ${lineNumber}`);
  }
  const modifiedLines = originalLines.slice();
  modifiedLines[LONG_FILE_CHANGE_LINE - 1] = `const value = "${LONG_FILE_CHANGE_TOKEN}";`;
  return {
    path: filePath, status: 'M', binary: false, language: 'typescript',
    original: originalLines.join('\n'), modified: modifiedLines.join('\n'),
  };
}

test.describe('Changes panel image view: live refresh and change navigation', () => {
  test('a diff refresh repaints an image regenerated at the same byte size, though its text is empty both times', async () => {
    // Same dimensions, same byte length, different pixels. Everything the
    // refresh could compare short of the decoded bytes is therefore equal: the
    // text is '' on both sides of the swap, and so are the size and the
    // dimensions.
    const regeneratedBefore = solidPng(24, 16, 220, 38, 38);
    const regeneratedAfter = solidPng(24, 16, 37, 99, 235);
    expect(Buffer.from(regeneratedAfter, 'base64').length).toBe(Buffer.from(regeneratedBefore, 'base64').length);
    expect(regeneratedAfter).not.toBe(regeneratedBefore);

    await openChanges(
      [pngFile('shots/regenerated.png', { modifiedImageBase64: regeneratedBefore })],
      'shots/regenerated.png',
    );
    const afterImage = page.locator('[data-testid="diff-image-after"] img');
    const afterDimensions = page.locator('[data-testid="diff-image-info-after-dimensions"]');
    await expect(afterImage).toHaveAttribute('src', `data:image/png;base64,${regeneratedBefore}`, { timeout: 8000 });
    await expect(afterDimensions).toHaveText('24 x 16');

    // The agent regenerates the screenshot: new pixels land on disk and the
    // watcher pushes a diff-changed event. The mock reads its fixture on every
    // fileImage call, so editing the entry in place is the new file on disk.
    await page.evaluate((regeneratedBase64) => {
      const mockWindow = window as unknown as MockGitWindow;
      if (!mockWindow.__mockFireDiffChanged) throw new Error('the Changes panel has not subscribed to diff changes');
      mockWindow.__mockGitDiff.files[0].modifiedImageBase64 = regeneratedBase64;
      mockWindow.__mockFireDiffChanged();
    }, regeneratedAfter);

    // The cached entry is served at once, then the background refetch decides
    // whether to repaint. Only the decoded bytes differ, so only a byte
    // comparison of the image repaints it; a text-only (or size-only) one
    // leaves the stale pixels on screen and this poll times out.
    await expect(afterImage).toHaveAttribute('src', `data:image/png;base64,${regeneratedAfter}`, { timeout: 8000 });
    await expect(afterDimensions).toHaveText('24 x 16');

    await closeChanges();
  });

  // The next two tests share a fixture, in tree order: a text file with no text
  // changes (the change key rolls out of it on the first press, so there is no
  // diff to time), an image, and the long text file whose scroll is remembered.
  // Scroll memory is module scope and keyed by task and path, so it outlives a
  // test on this shared page: each test gets its own long file path, or the
  // second would open its file on the first one's remembered position.
  const LONG_PATH = 'c-long.ts';
  const CONTROL_LONG_PATH = 'c-long-control.ts';
  const rollFiles = (longPath: string): FixtureFile[] => [
    {
      path: 'a-unchanged.ts', status: 'M', binary: false, language: 'typescript',
      original: 'const unchanged = 1;\n', modified: 'const unchanged = 1;\n',
    },
    pngFile('b-shot.png'),
    longTextFile(longPath),
  ];
  const unchangedLine = () => page.locator('.view-line', { hasText: 'const unchanged' }).first();
  const changeLine = () => page.locator('.view-line', { hasText: LONG_FILE_CHANGE_TOKEN });
  const tailLine = () => page.locator('.view-line', { hasText: LONG_FILE_TAIL_TOKEN });

  /**
   * Visit the long file, leave it scrolled to its bottom, and commit that
   * position by moving to another text file (the editor stays mounted across a
   * text to text switch). Then reopen the panel on `selectPath`: its content
   * cache starts empty, so the long file is uncached again, while the remembered
   * scroll (module scope) survives.
   */
  async function rememberLongFileBottomThenReopen(longPath: string, selectPath: string): Promise<void> {
    // The long file leads the list so it is the one the panel selects on its own: a
    // second switch right after the first can consume its first-change reveal
    // against the previous file's diff (DiffViewer's known imperfection).
    const [unchangedFile, imageFile, longFile] = rollFiles(longPath);
    await openChanges([longFile, unchangedFile, imageFile], longPath);
    await expect.poll(async () => (await readDiffState()).firstChangeLine, { timeout: 10000 }).toBe(LONG_FILE_CHANGE_LINE);
    await expect(changeLine().first()).toBeVisible({ timeout: 10000 });
    await scrollModifiedToBottom();
    await expect(tailLine().first()).toBeVisible({ timeout: 10000 });
    await selectFile('a-unchanged.ts');
    await expect(unchangedLine()).toBeVisible({ timeout: 10000 });
    await closeChanges();
    await openChanges(rollFiles(longPath), selectPath);
  }

  /** The next file read is held, so the click that triggers it can be observed before its content arrives. */
  async function holdNextFileContent(): Promise<void> {
    await page.evaluate(() => {
      (window as unknown as MockGitWindow).__mockGitFileContentDeferred = true;
    });
  }

  /**
   * Let the held read through once the app owns a mounted editor that has
   * computed the empty diff of the previous content. While the read is held the
   * content cannot match the file, so a pending request survives both the mount
   * and that empty diff, and what the test then sees is what the real content's
   * diff does with it.
   *
   * "Mounted" means the app has been handed the editor, not that Monaco has
   * built it: @monaco-editor/react creates the editor, and only one render
   * later calls onMount, which is where DiffViewer starts listening for diffs
   * and consuming a pending request. Releasing before that lets onMount run
   * against content that has just arrived and a diff that still reads empty,
   * and a request consumed there is dropped without positioning anything, which
   * hides exactly the leak under test. The boot spinner leaves in the render
   * that precedes onMount, so wait for it and then for the frames its effects
   * need.
   */
  async function releaseHeldFileContent(): Promise<void> {
    await expect.poll(async () => (await readDiffState()).mounted, { timeout: 10000 }).toBe(true);
    await expect(page.locator('[data-testid="diff-editor-area"] .animate-spin')).toHaveCount(0, { timeout: 10000 });
    await settleFrames(page);
    await expect.poll(async () => (await readDiffState()).changeCount, { timeout: 10000 }).toBe(0);
    await page.evaluate(() => {
      const resolve = (window as unknown as MockGitWindow).__mockGitFileContentResolve;
      if (!resolve) throw new Error('no file read is being held');
      resolve();
    });
    // The long file's OWN diff is the only one with a change at line 100, so once
    // it lands whatever positioning it triggers has already run (Monaco fires
    // the update event with the result).
    await expect.poll(async () => (await readDiffState()).firstChangeLine, { timeout: 10000 }).toBe(LONG_FILE_CHANGE_LINE);
  }

  test('rolling from a text file into an image leaves no stale request to jump a later text file to its first change', async () => {
    // Two dialog opens, a held fetch and Monaco throughout.
    test.slow();
    await rememberLongFileBottomThenReopen(LONG_PATH, 'a-unchanged.ts');
    await expect(unchangedLine()).toBeVisible({ timeout: 10000 });

    // Roll out of the text file into the image with the change key. The roll asks
    // the next file to land on its first change; an image has no editor to do it.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator('[data-testid="changes-file-row"][data-path="b-shot.png"]')).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });

    // Then CLICK the long file (nothing rolled into it), with its content held
    // until after the editor mounts. A cached file would show nothing here, red or
    // green: its mount clears any pending request itself (see the control below).
    await holdNextFileContent();
    await selectFile(LONG_PATH);
    await releaseHeldFileContent();

    // Restored: the bottom it was left at. A request that outlived the roll would
    // have jumped to line 100 centered instead (the control below), which leaves
    // the tail unrendered, so this wait would time out.
    await expect(tailLine().first()).toBeVisible({ timeout: 10000 });
    await expect(changeLine()).toHaveCount(0);

    await closeChanges();
  });

  // The control for the test above. It runs the same interleaving, but the long
  // file is rolled INTO from the image, so a request really is pending when its
  // diff lands. That has to win over the remembered scroll (a roll-in lands on the
  // file's first change), which is what proves the held-fetch interleaving can
  // tell a pending request from none: without it the test above could pass
  // vacuously, e.g. if a change to when the request is consumed hid a leak.
  //
  // It pins only the case its name says: content that arrives AFTER the editor
  // mounted. The next test covers a file whose content is already cached.
  test('rolling from an image into a text file whose content arrives after the editor mounts lands on its first change, not on its remembered scroll', async () => {
    test.slow();
    await rememberLongFileBottomThenReopen(CONTROL_LONG_PATH, 'b-shot.png');
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 10000 });

    await holdNextFileContent();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator(`[data-testid="changes-file-row"][data-path="${CONTROL_LONG_PATH}"]`)).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
    await releaseHeldFileContent();

    await expect(changeLine().first()).toBeVisible({ timeout: 10000 });
    await expect(tailLine()).toHaveCount(0);

    await closeChanges();
  });

  // The other arrival order: the file was visited in this panel, so its content is
  // cached and matches the moment the editor mounts, while the fresh editor's diff
  // has not computed (null, not empty). The roll's request must survive that mount
  // and land the file on its change once the diff arrives, instead of being dropped
  // there and leaving the remembered scroll to win.
  //
  // Rolls backward (Alt+ArrowUp, the 'last' request) so the long file can lead the
  // list and be the one the panel selects on its own: a second switch right after
  // the first can consume a first-change reveal against the previous file's diff.
  // Its single change makes last and first the same line. Paths are unique to this
  // test, so neither the remembered scroll nor the persisted selection of an
  // earlier test on this shared page leaks in.
  test('rolling back from an image into a cached text file lands on its change, not on its remembered scroll', async () => {
    test.slow();
    const cachedLongPath = 'd-cached-long.ts';
    const cachedShotPath = 'e-cached-shot.png';
    const cachedOtherPath = 'f-cached-other.ts';
    await openChanges([
      longTextFile(cachedLongPath),
      pngFile(cachedShotPath),
      {
        path: cachedOtherPath, status: 'M', binary: false, language: 'typescript',
        original: 'const other = 1;\n', modified: 'const other = 1;\n',
      },
    ], cachedLongPath);

    // Visit the long file and leave it scrolled to its bottom, then commit that
    // position by moving to another text file. Nothing closes the panel, so the
    // long file stays cached.
    await expect.poll(async () => (await readDiffState()).firstChangeLine, { timeout: 10000 }).toBe(LONG_FILE_CHANGE_LINE);
    await expect(changeLine().first()).toBeVisible({ timeout: 10000 });
    await scrollModifiedToBottom();
    await expect(tailLine().first()).toBeVisible({ timeout: 10000 });
    await selectFile(cachedOtherPath);
    await expect(page.locator('.view-line', { hasText: 'const other' }).first()).toBeVisible({ timeout: 10000 });
    await selectFile(cachedShotPath);
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 10000 });

    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator(`[data-testid="changes-file-row"][data-path="${cachedLongPath}"]`)).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
    // The long file's own diff is the only one with a change at line 100, so once
    // it lands whatever positioning it triggers has already run.
    await expect.poll(async () => (await readDiffState()).firstChangeLine, { timeout: 10000 }).toBe(LONG_FILE_CHANGE_LINE);

    // On its change, not back at the bottom it was left at.
    await expect(changeLine().first()).toBeVisible({ timeout: 10000 });
    await expect(tailLine()).toHaveCount(0);

    await closeChanges();
  });
});

test.describe('Changes panel image view: refresh fingerprints, layout toggle and SVG reads', () => {
  test('a diff refresh of an unchanged image sends its fingerprints, gets unchanged back, and leaves the view alone', async () => {
    const filePath = 'shots/unchanged.png';
    await openChanges([pngFile(filePath)], filePath);
    const afterImage = page.locator('[data-testid="diff-image-after"] img');
    await expect(afterImage).toBeVisible({ timeout: 8000 });
    const paintedSource = await afterImage.getAttribute('src');
    expect(paintedSource).toMatch(/^data:image\/png;base64,/);

    // The first read has nothing to compare against, so it sends no fingerprints
    // and gets the bytes. That is the premise the refresh is measured against.
    const callsBeforeRefresh = await readFileImageCalls(page, filePath);
    expect(callsBeforeRefresh.length).toBeGreaterThan(0);
    expect(callsBeforeRefresh[0].sentFingerprints?.original).toBeUndefined();
    expect(callsBeforeRefresh[0].answeredKinds).toEqual({ original: 'bytes', modified: 'bytes' });

    // The watcher fires, and nothing on disk changed.
    await page.evaluate(() => {
      const mockWindow = window as unknown as MockGitWindow;
      if (!mockWindow.__mockFireDiffChanged) throw new Error('the Changes panel has not subscribed to diff changes');
      mockWindow.__mockFireDiffChanged();
    });

    await expect.poll(async () => (await readFileImageCalls(page, filePath)).length, { timeout: 8000 })
      .toBeGreaterThan(callsBeforeRefresh.length);
    const refresh = (await readFileImageCalls(page, filePath))[callsBeforeRefresh.length];
    // The refetch names the sides the panel already holds (the cached entry is
    // passed as `previous`), so main answers for each with no bytes at all. A
    // refetch that passed nothing would send no fingerprints and get bytes back.
    expect(refresh.sentFingerprints?.original).toEqual(expect.stringMatching(/\S/));
    expect(refresh.sentFingerprints?.modified).toEqual(expect.stringMatching(/\S/));
    expect(refresh.answeredKinds).toEqual({ original: 'unchanged', modified: 'unchanged' });

    await expect(afterImage).toHaveAttribute('src', paintedSource!);
    await expect(page.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('40 x 80');

    await closeChanges();
  });

  test('the layout toggle changes together with the content, not ahead of it, while the next image loads', async () => {
    const pairOne = 'shots/toggle-pair-one.png';
    const added = 'shots/toggle-added.png';
    const pairTwo = 'shots/toggle-pair-two.png';
    await openChanges([
      pngFile(pairOne),
      { path: added, status: 'U', binary: true, modifiedImageBase64: ADDED_PNG },
      pngFile(pairTwo),
    ], pairOne);
    const layoutToggle = page.locator('[data-testid="diff-view-split"]');
    const loadingSpinner = page.locator('[data-testid="diff-editor-area"] .animate-spin');
    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible({ timeout: 8000 });
    await expect(layoutToggle).toBeVisible();

    // A modified pair to an Added image: the toggle belongs to the pair on
    // screen until the Added image's own content lands. It used to follow the new
    // file's status, so it vanished while the old pair was still painted.
    await holdNextImageRead();
    await selectFile(added);
    await expect(page.locator(`[data-testid="changes-file-row"][data-path="${added}"]`)).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
    await expect(loadingSpinner).toBeVisible();
    await expect(layoutToggle).toBeVisible();
    await releaseHeldImageRead();
    await expect(page.locator('[data-testid="diff-image-single"] img')).toBeVisible({ timeout: 8000 });
    await expect(layoutToggle).toHaveCount(0);

    // The converse: an Added image to a modified pair stays without it until the
    // pair's content lands, then gets it. (An uncached file, so its read is held.)
    await holdNextImageRead();
    await selectFile(pairTwo);
    await expect(page.locator(`[data-testid="changes-file-row"][data-path="${pairTwo}"]`)).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
    await expect(loadingSpinner).toBeVisible();
    await expect(layoutToggle).toHaveCount(0);
    await releaseHeldImageRead();
    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible({ timeout: 8000 });
    await expect(layoutToggle).toBeVisible();

    await closeChanges();
  });

  test('an SVG emptied on its new side previews as not image data, not as unreadable', async () => {
    // An empty file is a successful read of zero bytes, which no browser decodes.
    // Only a failed read is "Could not read".
    await openChanges([
      { path: 'assets/emptied.svg', status: 'M', binary: false, original: SVG_BEFORE, modified: '', language: 'xml' },
    ], 'assets/emptied.svg');

    const toggle = page.locator('[data-testid="diff-svg-preview"]');
    await expect(toggle).toBeVisible({ timeout: 8000 });
    await toggle.click();
    await expect(page.locator('[data-testid="diff-image-before"] img')).toBeVisible({ timeout: 8000 });
    const afterPlaceholder = page.locator('[data-testid="diff-image-after"] [data-testid="diff-image-placeholder"]');
    await expect(afterPlaceholder).toHaveAttribute('data-reason', 'undecodable');
    await expect(afterPlaceholder).toContainText('Not image data');

    await closeChanges();
  });
});

test.describe('Changes panel image view: Diff mode outcomes and copy', () => {
  const diffModeButton = () => page.locator('[data-testid="diff-image-mode-diff"]');
  const pixelStat = () => page.locator('[data-testid="diff-image-pixel-stat"]');

  test('stepping back to an already compared pair in Diff mode reads its remembered result instead of comparing it again', async () => {
    // The two pairs read differently ("32.5%" against "No pixel changes"), so the
    // stat's text says which pair is on screen: a "done" left over from the other
    // file cannot pass for this one.
    const pairA = 'shots/remembered-a.png';
    const pairB = 'shots/remembered-b.png';
    await openChanges([
      pngFile(pairA),
      pngFile(pairB, { modifiedImageBase64: BEFORE_PNG_REENCODED }),
    ], pairA);
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });
    const { posts, restore } = await countPixelDiffPosts();

    try {
      await diffModeButton().click();
      await expect(pixelStat()).toHaveText('32.5% of pixels changed', { timeout: 10000 });
      expect(await posts()).toBe(1);

      await selectFile(pairB);
      await expect(pixelStat()).toHaveText('No pixel changes', { timeout: 10000 });
      expect(await posts()).toBe(2);

      // Back to the first pair, still in Diff mode: its result is already known.
      // Without the remembered outcome the stat would pass through "comparing"
      // and only read 32.5% after a third post.
      await selectFile(pairA);
      await expect(page.locator(`[data-testid="changes-file-row"][data-path="${pairA}"]`)).toHaveAttribute('data-selected', 'true', { timeout: 8000 });
      await expect(pixelStat()).toHaveText('32.5% of pixels changed', { timeout: 10000 });
      await expect(pixelStat()).toHaveAttribute('data-status', 'done');
      await expect(page.locator('[data-testid="diff-image-diff-mask"]')).toBeVisible();
      expect(await posts()).toBe(2);
    } finally {
      await restore();
    }

    await closeChanges();
  });

  test('a pair too large to compare says so, draws no mask, and never reaches the worker', async () => {
    // An SVG sized 5000 x 5000 compares at scale 1 (floor(1024 / 5000) is 0, kept
    // at 1), so its canvas is 25,000,000 pixels: over the 4096 x 4096 cap. The
    // canvas is refused before either image is decoded, which is why this needs
    // no heavy fixture. Git marks the SVG binary so it opens straight on the image view.
    const filePath = 'assets/too-large-to-compare.svg';
    await openChanges([
      { path: filePath, status: 'M', binary: true, original: HUGE_SVG_BEFORE, modified: HUGE_SVG_AFTER, language: 'xml' },
    ], filePath);
    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('5000 x 5000');
    const { posts, restore } = await countPixelDiffPosts();

    try {
      await diffModeButton().click();
      await expect(pixelStat()).toHaveAttribute('data-status', 'failed', { timeout: 10000 });
      await expect(pixelStat()).toHaveText('Could not compare pixels');
      await expect(page.locator('[data-testid="diff-image-diff-mask"]')).toHaveCount(0);
      await expect(page.getByLabel('Comparing pixels')).toHaveCount(0);
      // The refusal came from the size cap, not from a decode or worker error.
      expect(await posts()).toBe(0);
    } finally {
      await restore();
    }

    await closeChanges();
  });

  test('a few changed pixels in a large image read as under 0.1%, not as 0.0%', async () => {
    // 100 x 100 is 10,000 pixels and the speck is 2 x 2: 4 changed pixels is
    // 0.04%, which toFixed(1) alone would print as "0.0%".
    const filePath = 'shots/speck.png';
    const base: RgbColor = [240, 240, 240];
    const speck: RgbColor = [220, 38, 38];
    await openChanges([
      pngFile(filePath, { originalImageBase64: solidPng(100, 100, ...base), modifiedImageBase64: speckledPng(100, 100, base, speck) }),
    ], filePath);
    await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });

    await diffModeButton().click();
    await expect(pixelStat()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    await expect(pixelStat()).toHaveText('Under 0.1% of pixels changed');
    await expect(pixelStat()).toHaveAttribute('title', /^4 of 10,?000 pixels differ$/);
    await expect(page.locator('[data-testid="diff-image-diff-mask"]')).toBeVisible();

    await closeChanges();
  });

  test('a new image with fewer bytes than the old one shows its size change as a minus', async () => {
    // The mirror of the modified PNG test's "+23 B": the same two files, swapped.
    // AFTER_PNG is 158 bytes and BEFORE_PNG 135.
    const filePath = 'shots/shrunk.png';
    await openChanges([
      pngFile(filePath, { originalImageBase64: AFTER_PNG, modifiedImageBase64: BEFORE_PNG }),
    ], filePath);

    await expect(page.locator('[data-testid="diff-image-size-delta"]')).toHaveText('-23 B', { timeout: 8000 });
    // The new image is the shorter one, so its dimensions flag the change too.
    await expect(page.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('40 x 60');

    await closeChanges();
  });

  test('Diff mode on an SVG pair compares at the scaled-up size, so the circle counts at that size', async () => {
    // A 64 x 64 SVG compares at scale floor(1024 / 64) = 16, a canvas of
    // 1024 x 1024 = 1,048,576 pixels. Dropping the scale shrinks that total to
    // 4,096; dropping the resize leaves both images 64 x 64 in the corner of the
    // big canvas, so the total holds while the changed count collapses to a few
    // pixels. The only change is the circle (r 7 in 64 units, so r 112 at 16x):
    // pi * 112^2 is about 39,400 pixels, and the anti-aliased rim is not counted.
    const filePath = 'assets/scaled-up.svg';
    await openChanges([
      { path: filePath, status: 'M', binary: true, original: SVG_BEFORE, modified: SVG_AFTER, language: 'xml' },
    ], filePath);
    await expect(page.locator('[data-testid="diff-image-after"] img')).toBeVisible({ timeout: 8000 });

    await diffModeButton().click();
    await expect(pixelStat()).toHaveAttribute('data-status', 'done', { timeout: 10000 });
    const title = await pixelStat().getAttribute('title');
    const match = /^([\d,]+) of 1,?048,?576 pixels differ$/.exec(title ?? '');
    expect(match, `pixel stat title was ${title}`).not.toBeNull();
    const changedPixels = Number(match![1].replace(/,/g, ''));
    expect(changedPixels).toBeGreaterThan(35000);
    expect(changedPixels).toBeLessThan(42000);
    await expect(pixelStat()).toHaveText(/^3\.\d% of pixels changed$/);
    await expect(page.locator('[data-testid="diff-image-diff-mask"]')).toBeVisible();

    await closeChanges();
  });

  test('a raster pair reaches the worker undecoded and an SVG pair decoded, so no raster decode runs on the main thread', async () => {
    // createImageBitmap on an <img> decodes on the calling thread, which drops
    // frames on a large screenshot. A raster side is posted as its data URL
    // for the worker to decode. An SVG,
    // which no worker can decode, is posted as the bitmap this thread drew.
    await page.evaluate(() => {
      const recorder = window as unknown as { __pixelDiffSources: string[]; __restoreSourcesPostMessage: () => void };
      recorder.__pixelDiffSources = [];
      const originalPostMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: unknown) {
        if (message !== null && typeof message === 'object' && 'before' in message && 'after' in message) {
          const { before, after } = message as { before: unknown; after: unknown };
          for (const source of [before, after]) {
            if (typeof source === 'string') recorder.__pixelDiffSources.push(source.startsWith('data:image/png;base64,') ? 'png data URL' : 'other string');
            else recorder.__pixelDiffSources.push(source instanceof ImageBitmap ? 'bitmap' : 'other object');
          }
        }
        return (originalPostMessage as (this: Worker, message: unknown, transfer?: unknown) => void).call(this, message, transfer);
      } as Worker['postMessage'];
      recorder.__restoreSourcesPostMessage = () => { Worker.prototype.postMessage = originalPostMessage; };
    });
    const postedSources = () => page.evaluate(() => (window as unknown as { __pixelDiffSources: string[] }).__pixelDiffSources);
    const rasterPath = 'shots/posted-raster.png';
    const vectorPath = 'assets/posted-vector.svg';

    try {
      await openChanges([
        pngFile(rasterPath),
        { path: vectorPath, status: 'M', binary: true, original: SVG_BEFORE, modified: SVG_AFTER, language: 'xml' },
      ], rasterPath);
      await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });
      await diffModeButton().click();
      await expect(pixelStat()).toHaveText('32.5% of pixels changed', { timeout: 10000 });
      expect(await postedSources()).toEqual(['png data URL', 'png data URL']);

      // Diff mode stays on across files, so the SVG is compared as soon as it shows.
      await selectFile(vectorPath);
      await expect(pixelStat()).toHaveAttribute('title', /of 1,?048,?576 pixels differ$/, { timeout: 10000 });
      expect(await postedSources()).toEqual(['png data URL', 'png data URL', 'bitmap', 'bitmap']);
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreSourcesPostMessage: () => void }).__restoreSourcesPostMessage());
    }

    await closeChanges();
  });

  test('a raster side the worker cannot decode reads as a failed comparison, and the next comparison still runs', async () => {
    // The page decodes both images before Diff mode starts, so only the
    // worker's own decode can fail here: the first request's before side is
    // swapped, on its way to the worker, for bytes that are not an image.
    await page.evaluate(() => {
      const patch = window as unknown as { __restoreCorruptingPostMessage: () => void };
      const originalPostMessage = Worker.prototype.postMessage;
      let corrupted = false;
      Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: unknown) {
        let outgoing = message;
        if (!corrupted && message !== null && typeof message === 'object' && 'before' in message && typeof message.before === 'string') {
          corrupted = true;
          outgoing = { ...message, before: 'data:image/png;base64,AAAA' };
        }
        return (originalPostMessage as (this: Worker, message: unknown, transfer?: unknown) => void).call(this, outgoing, transfer);
      } as Worker['postMessage'];
      patch.__restoreCorruptingPostMessage = () => { Worker.prototype.postMessage = originalPostMessage; };
    });
    const brokenPath = 'shots/worker-cannot-decode.png';
    const healthyPath = 'shots/worker-recovers.png';

    try {
      await openChanges([
        pngFile(brokenPath),
        pngFile(healthyPath, { modifiedImageBase64: BEFORE_PNG_REENCODED }),
      ], brokenPath);
      await expect(page.locator('[data-testid="diff-image-view"]')).toBeVisible({ timeout: 8000 });
      await diffModeButton().click();
      await expect(pixelStat()).toHaveAttribute('data-status', 'failed', { timeout: 10000 });
      await expect(pixelStat()).toHaveText('Could not compare pixels');
      await expect(page.locator('[data-testid="diff-image-diff-mask"]')).toHaveCount(0);

      // The failure did not wedge the worker: the next pair compares as usual.
      await selectFile(healthyPath);
      await expect(pixelStat()).toHaveText('No pixel changes', { timeout: 10000 });
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreCorruptingPostMessage: () => void }).__restoreCorruptingPostMessage());
    }

    await closeChanges();
  });
});

test.describe('per-file pop-out', () => {
  const POP_OUT_PATH = 'shots/popout.png';

  /** A pop-out page for one changed image, booted the way the window engine boots it. */
  async function openPopOutPage(): Promise<{ context: BrowserContext; popOutPage: Page }> {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const popOutPage = await context.newPage();
    await popOutPage.addInitScript({ path: MOCK_SCRIPT });
    await popOutPage.addInitScript(preConfig);
    await popOutPage.addInitScript(`
      window.__mockGitDiff = { files: ${JSON.stringify([pngFile(POP_OUT_PATH)])} };
      window.electronAPI.popOut.descriptor = {
        kind: 'changes-file',
        params: {
          taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', filePath: '${POP_OUT_PATH}', scope: 'branch',
          projectPath: '/mock/image-diff-test', worktreePath: '/mock/worktrees/image-diff', baseBranch: 'main',
          status: 'M', binary: true, taskDisplayId: 1, taskTitle: 'Image Diff Task',
        },
      };
    `);
    await popOutPage.goto(VITE_URL);
    return { context, popOutPage };
  }

  test('a changes-file window renders the image view through its own fetch path', async () => {
    const { context, popOutPage } = await openPopOutPage();
    await expect(popOutPage.locator('[data-testid="diff-image-before"] img')).toBeVisible({ timeout: 15000 });
    await expect(popOutPage.locator('[data-testid="diff-image-after"] img')).toBeVisible();
    await expect(popOutPage.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('40 x 80');
    await context.close();
  });

  test('a changes-file window refreshes with the fingerprints of the image it shows', async () => {
    const { context, popOutPage } = await openPopOutPage();
    await expect(popOutPage.locator('[data-testid="diff-image-after"] img')).toBeVisible({ timeout: 15000 });
    const callsBeforeRefresh = await readFileImageCalls(popOutPage, POP_OUT_PATH);
    expect(callsBeforeRefresh.length).toBeGreaterThan(0);

    // The window subscribes to diff changes once it mounts; wait for that, then push.
    await expect.poll(
      () => popOutPage.evaluate(() => typeof (window as unknown as MockGitWindow).__mockFireDiffChanged === 'function'),
      { timeout: 8000 },
    ).toBe(true);
    await popOutPage.evaluate(() => (window as unknown as MockGitWindow).__mockFireDiffChanged?.());

    await expect.poll(async () => (await readFileImageCalls(popOutPage, POP_OUT_PATH)).length, { timeout: 8000 })
      .toBeGreaterThan(callsBeforeRefresh.length);
    const refresh = (await readFileImageCalls(popOutPage, POP_OUT_PATH))[callsBeforeRefresh.length];
    expect(refresh.sentFingerprints?.original).toEqual(expect.stringMatching(/\S/));
    expect(refresh.sentFingerprints?.modified).toEqual(expect.stringMatching(/\S/));
    expect(refresh.answeredKinds).toEqual({ original: 'unchanged', modified: 'unchanged' });
    await expect(popOutPage.locator('[data-testid="diff-image-info-after-dimensions"]')).toHaveText('40 x 80');
    await context.close();
  });
});
