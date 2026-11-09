/**
 * The Browser pane's annotations composer (task #1042): select elements and
 * draw on the page, write a note for each annotation, send them together.
 *
 * The UI tier has no real guest, so the `<webview>` stand-in gets a scripted
 * `executeJavaScript`: the Select element script answers from a queue of picks,
 * the page layer's render answers with an empty status, and everything else
 * resolves. That is enough to drive the composer, the floating bar, the keys,
 * the draft and Send through the real pane.
 *
 * The page layer runs in a guest, which is just a page: the last block runs the
 * real layer script in a plain Chromium page, the way `executeJavaScript` would.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';
import {
  ANNOTATION_LAYER_NEXT_BADGE_CLICK_SCRIPT,
  renderAnnotationLayerScript,
  type AnnotationLayerState,
  type AnnotationLayerStatus,
} from '../../src/renderer/components/browser/annotations/annotationLayerScript';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-annotations';
const TASK_ID = 'task-browser-annotations';
const SESSION_ID = 'sess-browser-annotations';
const PROJECT_PATH = '/mock/browser-annotations-test';
const PAGE_URL = 'http://localhost:5173/';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Browser Annotations Test', path: '${PROJECT_PATH}',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      var id = 'lane-an-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[lane.name] = id;
      state.swimlanes.push(Object.assign({}, lane, { id: id, position: index, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9997,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Annotations Browser Task', description: 'Drives the annotations composer',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: null, branch_name: null, pr_number: null, pr_url: null, base_branch: 'main',
      archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let sharedBrowser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

test.beforeEach(async () => {
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.evaluate((url) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-browser-annotations', url);
  }, PAGE_URL);
});

interface Pick { selector: string; name: string }

/** Opens the task's Browser pane and scripts its stand-in guest. */
async function openPane(): Promise<void> {
  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Annotations Browser Task').first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  const pane = page.locator('[data-testid="browser-pane"]');
  if (!(await pane.isVisible().catch(() => false))) await page.locator('[data-testid="browser-toggle"]').click();
  await pane.waitFor({ state: 'visible', timeout: 5000 });
  await page.evaluate((url) => {
    const webview = document.querySelector('[data-testid="browser-webview"]');
    if (!webview) throw new Error('no webview stub');
    const queue: Array<{ selector: string; name: string }> = [];
    let waiting: ((value: unknown) => void) | null = null;
    const pick = (selector: string, name: string) => ({
      selector, tagName: 'BUTTON', classes: [], role: 'button', accessibleName: name,
      rect: { x: 10, y: 10, width: 80, height: 30 }, computedStyles: {}, outerHTML: '', ancestors: [],
    });
    (window as unknown as { __queuePick: (next: { selector: string; name: string }) => void }).__queuePick = (next) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(pick(next.selector, next.name));
      } else {
        queue.push(next);
      }
    };
    Object.assign(webview, {
      getURL: () => url,
      canGoBack: () => false,
      canGoForward: () => false,
      capturePage: () => Promise.resolve({ toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', getSize: () => ({ width: 1, height: 1 }) }),
      executeJavaScript: (code: string) => {
        if (code.includes('__kangenticInspectActive = true')) {
          const next = queue.shift();
          if (next) return Promise.resolve(pick(next.selector, next.name));
          return new Promise((resolve) => { waiting = resolve; });
        }
        if (code.includes('__kangenticInspectActive = false')) {
          if (waiting) { const resolve = waiting; waiting = null; resolve(null); }
          return Promise.resolve();
        }
        if (code.includes('.nextBadgeClick()')) return new Promise(() => undefined);
        if (code.includes('.render(')) {
          return Promise.resolve({ scrollX: 0, scrollY: 0, width: 800, height: 600, url, items: {} });
        }
        if (code.includes('.scroll()')) return Promise.resolve({ x: 0, y: 0 });
        return Promise.resolve('');
      },
    });
  }, PAGE_URL);
}

async function selectElements(picks: Pick[]): Promise<void> {
  const toggle = page.locator('[data-testid="browser-inspect-toggle"]');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  for (const next of picks) {
    await page.evaluate((value) => (window as unknown as { __queuePick: (next: Pick) => void }).__queuePick(value), next);
  }
}

async function drawStroke(fromX: number, fromY: number): Promise<void> {
  const draw = page.locator('[data-testid="browser-draw-toggle"]');
  if ((await draw.getAttribute('aria-pressed')) !== 'true') await draw.click();
  const box = await page.locator('[data-testid="browser-overlay"]').boundingBox();
  if (!box) throw new Error('no draw canvas');
  await page.mouse.move(box.x + fromX, box.y + fromY);
  await page.mouse.down();
  await page.mouse.move(box.x + fromX + 90, box.y + fromY + 40, { steps: 4 });
  await page.mouse.up();
}

function draftOf(): Promise<{ annotations: Array<{ note: string; items: unknown[] }> } | null> {
  return page.evaluate((taskId) => window.__mockBrowser?.getAnnotationDraft(taskId) ?? null, TASK_ID);
}

test('selections and strokes join the active annotation, and Enter in its note starts the next', async () => {
  await openPane();
  await selectElements([{ selector: '#save', name: 'Save' }, { selector: '#cancel', name: 'Cancel' }]);
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('2');
  await drawStroke(60, 200);
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('21');

  const note = page.locator('[data-testid="annotation-note-1"]');
  await expect(note).toBeFocused();
  await note.fill('Swap these two');
  await note.press('Enter');

  await expect(page.locator('[data-testid="annotation-row-2"]')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-testid="annotation-note-2"]')).toBeFocused();
  await expect(page.locator('[data-testid="annotation-count"]')).toHaveText('1');

  // Saved as it changes, so a restart would bring it back.
  await expect.poll(async () => (await draftOf())?.annotations[0]?.note).toBe('Swap these two');
});

test('the summary opens the items, and one can go while the rest stay', async () => {
  await openPane();
  await selectElements([{ selector: '#save', name: 'Save' }, { selector: '#cancel', name: 'Cancel' }]);
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('2');

  await page.locator('[data-testid="annotation-items-1"]').click();
  const list = page.locator('[data-testid="annotation-item-list-1"]');
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: 'Remove button "Save"' }).click();
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('1');
  await expect(list.getByText('button "Cancel"')).toBeVisible();
});

test('removing an annotation closes up the numbers', async () => {
  await openPane();
  await selectElements([{ selector: '#a', name: 'A' }]);
  await page.locator('[data-testid="annotation-note-1"]').fill('first');
  await page.locator('[data-testid="annotation-note-1"]').press('Enter');
  await selectElements([{ selector: '#b', name: 'B' }]);
  await page.locator('[data-testid="annotation-note-2"]').fill('second');

  await page.locator('[data-testid="annotation-remove-1"]').click();
  await expect(page.locator('[data-testid="annotation-row-2"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="annotation-note-1"]')).toHaveValue('second');
});

test('at 20 annotations the New annotation row is gone and the count says why', async () => {
  const annotations = Array.from({ length: 20 }, (_unused, index) => ({
    id: `a${index}`, note: `note ${index}`, url: PAGE_URL, captureId: null,
    items: [{ id: `i${index}`, kind: 'drawing', strokes: [[{ x: 10, y: 10 }, { x: 80, y: 40 }]] }],
  }));
  await page.evaluate(({ taskId, draft }) => window.__mockBrowser?.seedAnnotationDraft(taskId, draft), {
    taskId: TASK_ID,
    draft: { version: 1, activeId: 'a19', annotations },
  });
  await openPane();

  await expect(page.locator('[data-testid="annotation-row-20"]')).toBeVisible();
  await expect(page.locator('[data-testid="annotation-new"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="annotation-header"]'))
    .toHaveAccessibleDescription('20 annotations is the most one send carries. Send these, then start again.');
  // Enter no longer moves on.
  await page.locator('[data-testid="annotation-note-20"]').press('Enter');
  await expect(page.locator('[data-testid="annotation-row-21"]')).toHaveCount(0);
});

test('a failed Send keeps every annotation, and one that lands clears back to the single row', async () => {
  await openPane();
  await selectElements([{ selector: '#save', name: 'Save' }]);
  await page.locator('[data-testid="annotation-note-1"]').fill('Make this primary');

  await page.evaluate(() => window.__mockBrowser?.failCaptureWith("The agent's terminal is not running."));
  await page.locator('[data-testid="browser-send"]').click();
  await expect(page.locator('[data-testid="browser-send-error"]')).toHaveText("The agent's terminal is not running.");
  await expect(page.locator('[data-testid="annotation-note-1"]')).toHaveValue('Make this primary');

  await page.evaluate(() => window.__mockBrowser?.failCaptureWith(null));
  // The draft is on disk before the Send, so its absence after says the Send
  // discarded it rather than that it was never saved.
  await expect.poll(async () => (await draftOf())?.annotations.length ?? 0).toBeGreaterThan(0);
  await page.locator('[data-testid="browser-send"]').click();
  await expect(page.locator('[data-testid="annotation-composer"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="browser-note-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="browser-inspect-toggle"]')).toHaveAttribute('aria-pressed', 'false');

  const calls = await page.evaluate(() => window.__mockBrowser?.getCaptureCalls() ?? []);
  const sent = calls[calls.length - 1] as { annotations: Array<{ number: number; note: string; items: unknown[] }>; projectId: string };
  expect(sent.projectId).toBe(PROJECT_ID);
  expect(sent.annotations).toHaveLength(1);
  expect(sent.annotations[0]).toMatchObject({ number: 1, note: 'Make this primary' });
  await expect.poll(draftOf).toBeNull();
});

test('Ctrl+Enter in a note sends the annotations and starts no row, where plain Enter starts the next and sends nothing', async () => {
  await openPane();
  await selectElements([{ selector: '#save', name: 'Save' }]);
  const note = page.locator('[data-testid="annotation-note-1"]');
  await note.fill('Make this primary');

  await note.press('Enter');
  await expect(page.locator('[data-testid="annotation-row-2"]')).toBeVisible();
  expect(await page.evaluate(() => window.__mockBrowser?.getCaptureCalls().length)).toBe(0);

  // Back in annotation 1's note, the Send key goes out with the whole review.
  await page.locator('[data-testid="annotation-note-1"]').focus();
  await page.locator('[data-testid="annotation-note-1"]').press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.__mockBrowser?.getCaptureCalls().length)).toBe(1);
  const calls = await page.evaluate(() => window.__mockBrowser?.getCaptureCalls() ?? []);
  const sent = calls[0] as { annotations: Array<{ number: number; note: string }> };
  expect(sent.annotations).toHaveLength(1);
  expect(sent.annotations[0]).toMatchObject({ number: 1, note: 'Make this primary' });
  await expect(page.locator('[data-testid="annotation-composer"]')).toHaveCount(0);
});

test('an annotation added while a Send is in flight survives the Send', async () => {
  await openPane();
  await selectElements([{ selector: '#first', name: 'First' }]);
  await page.locator('[data-testid="annotation-note-1"]').fill('Sent one');

  await page.evaluate(() => window.__mockBrowser?.holdCaptureUntilReleased());
  try {
    await page.locator('[data-testid="browser-send"]').click();
    // The call is logged and unanswered: the Send is in flight.
    await expect.poll(() => page.evaluate(() => window.__mockBrowser?.getCaptureCalls().length)).toBe(1);

    await page.locator('[data-testid="annotation-new"]').click();
    await selectElements([{ selector: '#second', name: 'Second' }]);
    await expect(page.locator('[data-testid="annotation-items-2"]')).toHaveText('1');
  } finally {
    await page.evaluate(() => window.__mockBrowser?.releaseCapture());
  }

  // The sent one is gone and the late one stays, now numbered 1 with its mark.
  await expect(page.locator('[data-testid="annotation-row-2"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="annotation-note-1"]')).toHaveValue('');
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('1');
  const calls = await page.evaluate(() => window.__mockBrowser?.getCaptureCalls() ?? []);
  const sent = calls[0] as { annotations: Array<{ note: string }> };
  expect(sent.annotations.map((annotation) => annotation.note)).toEqual(['Sent one']);
});

test('a restored draft does not pull focus out of where the user was', async () => {
  await page.evaluate(({ taskId, url }) => window.__mockBrowser?.seedAnnotationDraft(taskId, {
    version: 1,
    activeId: 'kept',
    annotations: [{ id: 'kept', note: 'From before the restart', url, captureId: null, items: [] }],
  }), { taskId: TASK_ID, url: PAGE_URL });
  await openPane();
  const note = page.locator('[data-testid="annotation-note-1"]');
  await expect(note).toHaveValue('From before the restart');
  // The restore's focus effect runs in the commit that mounts the note, so the
  // note is already on screen here and focus has either moved or it has not.
  const focusInsidePane = await page.evaluate(
    () => !!document.activeElement?.closest('[data-testid="browser-pane"]'),
  );
  expect(focusInsidePane).toBe(false);
  await expect(note).not.toBeFocused();
});

test('a saved draft comes back when the pane opens', async () => {
  await page.evaluate(({ taskId, url }) => window.__mockBrowser?.seedAnnotationDraft(taskId, {
    version: 1,
    activeId: 'kept',
    annotations: [{ id: 'kept', note: 'From before the restart', url, captureId: null, items: [] }],
  }), { taskId: TASK_ID, url: PAGE_URL });
  await openPane();
  await expect(page.locator('[data-testid="annotation-note-1"]')).toHaveValue('From before the restart');
});

test('a note typed before the first mark becomes annotation 1\'s note', async () => {
  await openPane();
  await page.locator('[data-testid="browser-note-input"]').fill('The header is too tall');
  await drawStroke(60, 200);
  await expect(page.locator('[data-testid="annotation-note-1"]')).toHaveValue('The header is too tall');
  await expect(page.locator('[data-testid="browser-note-input"]')).toHaveCount(0);
});

test('Ctrl+Z in an empty note takes the last mark, and in a note with text it does not', async () => {
  await openPane();
  await selectElements([{ selector: '#a', name: 'A' }, { selector: '#b', name: 'B' }]);
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('2');
  const note = page.locator('[data-testid="annotation-note-1"]');

  await note.fill('keep');
  await note.press('Control+z');
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('2');

  await note.fill('');
  await note.press('Control+z');
  await expect(page.locator('[data-testid="annotation-items-1"]')).toHaveText('1');
});

test('the list gives way on a short pane, so the page keeps its floor, and shows four rows on a tall one', async () => {
  const annotations = Array.from({ length: 3 }, (_unused, index) => ({
    id: `r${index}`, note: `row ${index}`, url: PAGE_URL, captureId: null, items: [],
  }));
  await page.evaluate(({ taskId, draft }) => window.__mockBrowser?.seedAnnotationDraft(taskId, draft), {
    taskId: TASK_ID,
    draft: { version: 1, activeId: 'r2', annotations },
  });
  await openPane();
  const rows = page.locator('[data-testid="annotation-rows"]');
  await expect(rows).toHaveAttribute('data-compact', 'false');
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(rows).toHaveAttribute('data-compact', 'true');
    const paneBox = await page.locator('[data-testid="browser-pane"]').boundingBox();
    const pageBox = await page.locator('[data-testid="browser-webview"]').boundingBox();
    if (!paneBox || !pageBox) throw new Error('no pane geometry');
    // At the floor the list is down to its one row, the least it shows so the
    // active note stays in reach, and the page keeps the rest (the header folds
    // the list for more).
    const rowsBox = await rows.boundingBox();
    if (!rowsBox) throw new Error('no rows geometry');
    expect(rowsBox.height).toBeLessThanOrEqual(46);
    expect(pageBox.height).toBeGreaterThan(100);
  } finally {
    await page.setViewportSize({ width: 1920, height: 1080 });
  }
});

test.describe('the page layer, run in a real page', () => {
  const GUEST_HTML = `
    <html><body style="margin:0;height:3000px;font:14px sans-serif">
      <div class="field" style="padding:20px"><input placeholder="First"></div>
      <div class="field" style="padding:20px"><input placeholder="Second"></div>
      <button data-testid="save" style="position:absolute;left:200px;top:300px;width:120px;height:32px">Save</button>
    </body></html>`;

  /** Runs a layer script the way the pane's `executeJavaScript` does: its last value is the answer. */
  const run = <T,>(guest: Page, script: string): Promise<T> =>
    guest.evaluate((source) => (0, eval)(source) as T, script);

  const state: AnnotationLayerState = {
    hidden: false,
    barRect: null,
    hoveredNumber: null,
    hoveredItemId: null,
    annotations: [
      { number: 1, emphasis: 'strong', items: [{ id: 'save', kind: 'element', selector: 'button[data-testid="save"]', tag: 'button', name: 'Save' }] },
      { number: 2, emphasis: 'faded', items: [{ id: 'ink', kind: 'drawing', strokes: [[{ x: 500, y: 500 }, { x: 600, y: 540 }]] }] },
      { number: 3, emphasis: 'faded', items: [{ id: 'gone', kind: 'element', selector: '#not-here', tag: 'div' }] },
    ],
  };

  test('draws into a closed shadow root and reports what is on the page and in view', async () => {
    const guest = await page.context().newPage();
    try {
      await guest.setViewportSize({ width: 1000, height: 700 });
      await guest.setContent(GUEST_HTML);
      const divsBefore = await guest.evaluate(() => document.querySelectorAll('div').length);

      const status = await run<AnnotationLayerStatus>(guest, renderAnnotationLayerScript(state));
      expect(status.items.save).toEqual({ onPage: true, inViewport: true });
      expect(status.items.ink).toEqual({ onPage: true, inViewport: true });
      expect(status.items.gone).toEqual({ onPage: false, inViewport: false });

      // One host, and nothing the page (or an agent's DOM lookup) can query inside it.
      const host = await guest.evaluate(() => {
        const hosts = document.querySelectorAll('[data-kangentic-annotations]');
        return { count: hosts.length, shadowVisible: hosts[0]?.shadowRoot !== null };
      });
      expect(host).toEqual({ count: 1, shadowVisible: false });
      expect(await guest.evaluate(() => document.querySelectorAll('div').length)).toBe(divsBefore + 1);

      // The marks are part of the page: scrolled past, the button leaves the view.
      await guest.evaluate(() => window.scrollTo(0, 1200));
      const scrolled = await run<AnnotationLayerStatus>(guest, renderAnnotationLayerScript(state));
      expect(scrolled.scrollY).toBe(1200);
      expect(scrolled.items.save.inViewport).toBe(false);
      expect(scrolled.items.save.onPage).toBe(true);
    } finally {
      await guest.close();
    }
  });

  test('a click on a badge answers the armed call with its number, and the page never sees it', async () => {
    const guest = await page.context().newPage();
    try {
      await guest.setViewportSize({ width: 1000, height: 700 });
      await guest.setContent(GUEST_HTML);
      await guest.evaluate(() => {
        (window as unknown as { __pageClicks: number }).__pageClicks = 0;
        document.querySelector('button')?.addEventListener('click', () => {
          (window as unknown as { __pageClicks: number }).__pageClicks += 1;
        });
      });
      await run(guest, renderAnnotationLayerScript(state));

      // Arm the call, keeping its answer in the page, and only then click: an
      // evaluate still in flight could otherwise miss a click that beat it.
      await guest.evaluate((source) => {
        const holder = window as unknown as { __badgeAnswer?: unknown };
        holder.__badgeAnswer = 'pending';
        void ((0, eval)(source) as Promise<unknown>).then((value) => { holder.__badgeAnswer = value; });
      }, ANNOTATION_LAYER_NEXT_BADGE_CLICK_SCRIPT);
      // Annotation 1's badge is centred on the button's top-left corner.
      await guest.mouse.click(202, 302);
      await expect.poll(() => guest.evaluate(() => (window as unknown as { __badgeAnswer?: unknown }).__badgeAnswer))
        .toEqual({ activate: 1 });
      expect(await guest.evaluate(() => (window as unknown as { __pageClicks: number }).__pageClicks)).toBe(0);
    } finally {
      await guest.close();
    }
  });
});
