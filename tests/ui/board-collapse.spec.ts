/**
 * Collapsible board columns (#1056).
 *
 * Eight columns did not fit the board, so an empty column narrows to its
 * header and a column can be collapsed to a strip. What only a browser proves:
 * the widths the flex row actually gives, that the strip is a button that
 * expands, and that a strip still takes a drop. The width rule itself is
 * `tests/unit/lane-widths.test.ts`.
 *
 * Widths are compared with each other, never against a pixel value: a header's
 * width depends on the platform's font.
 */

import path from 'node:path';
import { test, expect, chromium } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask, waitForViteReady, gotoVite } from './helpers';
import { FILL_FLOOR_PX, laneWidthRange } from '../../src/renderer/components/board/lane-widths';
import type { Browser, Locator, Page } from '@playwright/test';

const runId = Date.now();
const PROJECT_NAME = `Collapse Test ${runId}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME, '/tmp/collapse-test');
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

const lane = (name: string): Locator => page.locator(`[data-testid="swimlane"][data-swimlane-name="${name}"]`);
const strip = (name: string): Locator => page.locator(`[data-testid="swimlane"][data-swimlane-name="${name}"][data-collapsed]`);
const wrapper = (name: string): Locator => page.locator('[data-lane-wrapper]').filter({ has: lane(name) });

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('No bounding box');
  return box.width;
}

/**
 * Wait out the columns' width motion. A column eases to its new width over
 * 200ms, so a box read straight after a collapse is a moving one.
 */
async function widthsSettled(): Promise<void> {
  await page.evaluate(async () => {
    const running = Array.from(document.querySelectorAll('[data-lane-wrapper]'))
      .flatMap((wrapper) => wrapper.getAnimations({ subtree: true }));
    await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** Collapse a column from its header, unless it is a strip already. */
async function collapse(name: string): Promise<void> {
  if (await strip(name).count() === 0) {
    await lane(name).locator('[data-testid="collapse-column-btn"]').click();
    await expect(strip(name)).toBeVisible();
  }
  await widthsSettled();
}

/** Expand a column from its strip, unless it is open already. */
async function expand(name: string): Promise<void> {
  if (await strip(name).count() > 0) {
    await strip(name).click();
    await expect(strip(name)).toHaveCount(0);
  }
  await widthsSettled();
}

/** Drag a card onto a column, whatever shape the column is in. One attempt. */
async function dragCardTo(taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const cardBox = await card.boundingBox();
  const targetBox = await lane(targetColumn).boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for the drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.locator('.drag-overlay').filter({ hasText: taskTitle }).waitFor({ state: 'visible', timeout: 3000 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 120, { steps: 30 });
}

test.describe('Board columns: shrink and collapse', () => {
  test('an empty column is narrower than one with a task, and keeps its whole name', async () => {
    await createTask(page, `Fits ${runId}`);
    await expect(lane('To Do').locator(`text=Fits ${runId}`)).toBeVisible();

    await expect(wrapper('To Do')).toHaveAttribute('data-lane-shape', 'shared');
    await expect(wrapper('Planning')).toHaveAttribute('data-lane-shape', 'shrunk');
    expect(await widthOf(wrapper('Planning'))).toBeLessThan(await widthOf(wrapper('To Do')));

    // As wide as its header: the name is not cut short.
    const cutShort = await lane('Planning').locator('[data-testid="swimlane-header"] span.truncate').first()
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(cutShort).toBe(false);
  });

  test('every empty column is one width, and no header is cut short at it', async () => {
    // Columns of several widths side by side read as clutter and are harder
    // to aim a drag at, so the empty ones match: the widest header on the
    // board, which every one of them fits.
    const shrunk = page.locator('[data-lane-wrapper][data-lane-shape="shrunk"]');
    await expect.poll(async () => shrunk.count()).toBeGreaterThan(1);
    await widthsSettled();
    const widths = await shrunk.evaluateAll((wrappers) => wrappers.map((wrapper) => wrapper.getBoundingClientRect().width));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
    // And no name is cut short at that width.
    const anyCutShort = await page.locator('[data-lane-wrapper][data-lane-shape="shrunk"] [data-testid="swimlane-header"] span.truncate')
      .evaluateAll((names) => names.some((node) => node.scrollWidth > node.clientWidth + 1));
    expect(anyCutShort).toBe(false);
  });

  test('Collapse folds a column to a strip, and the strip expands it', async () => {
    await expand('To Do');
    const openWidth = await widthOf(wrapper('To Do'));

    await lane('To Do').locator('[data-testid="collapse-column-btn"]').click();

    await expect(strip('To Do')).toBeVisible();
    await expect(wrapper('To Do')).toHaveAttribute('data-lane-shape', 'collapsed');
    // The strip names the column and counts its tasks, and hides its cards.
    await expect(strip('To Do')).toHaveAccessibleName(/Expand To Do column, \d+ tasks?/);
    await expect(strip('To Do').locator('[data-task-id]')).toHaveCount(0);
    await expect.poll(async () => widthOf(wrapper('To Do'))).toBeLessThan(openWidth / 2);
    // Collapse is the button's own action: it does not open the Column Manager.
    await expect(page.locator('[data-testid="board-manager-tab"]')).toHaveCount(0);

    await strip('To Do').click();

    await expect(strip('To Do')).toHaveCount(0);
    await expect(wrapper('To Do')).toHaveAttribute('data-lane-shape', 'shared');
    await expect(lane('To Do').locator('[data-task-id]').first()).toBeVisible();
  });

  test('a card dropped on a collapsed column lands in it and opens it', async () => {
    await expand('To Do');
    const title = `Dropped ${runId}`;
    await createTask(page, title);
    await collapse('Planning');

    await dragCardTo(title, 'Planning');
    // Held over the strip, the strip lights up and stays a strip.
    await expect(strip('Planning')).toHaveClass(/drop-highlight/);
    await expect(wrapper('Planning')).toHaveAttribute('data-lane-shape', 'collapsed');
    await page.mouse.up();

    await expect(strip('Planning')).toHaveCount(0);
    await expect(lane('Planning').locator(`text=${title}`)).toBeVisible();
  });

  test('a task that arrives without a drop leaves the column collapsed and raises its count', async () => {
    await expand('To Do');
    const title = `Pushed ${runId}`;
    await createTask(page, title);
    await collapse('Executing');
    const before = await strip('Executing').locator('[data-testid="swimlane-task-count"]').innerText();

    // What an agent's move does: main writes it, then tells the board.
    await page.evaluate(async (taskTitle) => {
      const bridge = (window as unknown as {
        electronAPI: {
          projects: { getCurrent: () => Promise<{ id: string } | null> };
          tasks: {
            list: () => Promise<Array<{ id: string; title: string }>>;
            move: (input: { taskId: string; targetSwimlaneId: string; targetPosition: number }, projectId: string | null) => Promise<unknown>;
          };
          swimlanes: { list: () => Promise<Array<{ id: string; name: string }>> };
        };
        __mockFireTaskUpdatedByAgent: (taskId: string, taskTitle: string, projectId: string) => void;
      });
      const project = await bridge.electronAPI.projects.getCurrent();
      const task = (await bridge.electronAPI.tasks.list()).find((candidate) => candidate.title === taskTitle);
      const target = (await bridge.electronAPI.swimlanes.list()).find((candidate) => candidate.name === 'Executing');
      if (!project || !task || !target) throw new Error('Fixture rows missing');
      await bridge.electronAPI.tasks.move({ taskId: task.id, targetSwimlaneId: target.id, targetPosition: 0 }, project.id);
      bridge.__mockFireTaskUpdatedByAgent(task.id, task.title, project.id);
    }, title);

    await expect(lane('To Do').locator(`text=${title}`)).toHaveCount(0);
    await expect(strip('Executing')).toBeVisible();
    await expect(strip('Executing').locator('[data-testid="swimlane-task-count"]')).not.toHaveText(before);
  });

  test('a strip takes the drop highlight at once, with no colour easing into its outline', async () => {
    // The drag toggles `.drop-highlight` straight on the element. The strip
    // eased every colour, the outline's included, and an element with no
    // outline has the text colour there: the border flashed white first.
    await collapse('Executing');
    const colours = await strip('Executing').evaluate(async (element) => {
      element.classList.add('drop-highlight');
      const atOnce = getComputedStyle(element).outlineColor;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const settled = getComputedStyle(element).outlineColor;
      element.classList.remove('drop-highlight');
      return { atOnce, settled, text: getComputedStyle(element).color };
    });
    expect(colours.atOnce).toBe(colours.settled);
    // Not vacuous: the highlight's colour is not the colour an absent outline has.
    expect(colours.settled).not.toBe(colours.text);
    await expand('Executing');
  });

  test('while one column folds, no other column leaves the span between its old and new width', async () => {
    // A column eases from the width it had to the width it gets. When the
    // remembered width was wrong (0, from an element that was gone), every
    // column eased in from nothing and the whole board squashed to the left.
    await expand('To Do');
    await expand('Planning');
    await expand('Executing');
    await widthsSettled();

    const sampled = await page.evaluate(async () => {
      const wrappers = Array.from(document.querySelectorAll<HTMLElement>('[data-lane-wrapper]'));
      const widths = (): number[] => wrappers.map((wrapper) => wrapper.getBoundingClientRect().width);
      const target = document.querySelector<HTMLElement>('[data-testid="swimlane"][data-swimlane-name="To Do"]');
      const targetIndex = wrappers.findIndex((wrapper) => target !== null && wrapper.contains(target));
      const before = widths();
      target?.querySelector<HTMLElement>('[data-testid="collapse-column-btn"]')?.click();
      const frames: number[][] = [];
      // Sample until every running width animation has ended.
      for (;;) {
        frames.push(widths());
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const running = wrappers.flatMap((wrapper) => wrapper.getAnimations({ subtree: true }));
        if (frames.length > 2 && running.length === 0) break;
        if (frames.length > 600) break;
      }
      return { targetIndex, before, after: widths(), frames };
    });

    expect(sampled.targetIndex).toBeGreaterThanOrEqual(0);
    expect(sampled.frames.length).toBeGreaterThan(2);
    const tolerancePx = 2;
    sampled.before.forEach((beforeWidth, index) => {
      if (index === sampled.targetIndex) return;
      const low = Math.min(beforeWidth, sampled.after[index]) - tolerancePx;
      const high = Math.max(beforeWidth, sampled.after[index]) + tolerancePx;
      for (const frame of sampled.frames) {
        expect(frame[index], `column ${index} mid-motion`).toBeGreaterThanOrEqual(low);
        expect(frame[index], `column ${index} mid-motion`).toBeLessThanOrEqual(high);
      }
    });
    await expand('To Do');
  });
});

/**
 * Cases that need their own seeded board: a task filter over a populated
 * column, a Done column with a completed archive, and two strips side by side.
 * Each test launches its own page, so none leans on another's leftovers.
 */
test.describe('Board columns: filter, completed count and neighbouring strips', () => {
  const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
  const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
  const openBrowsers: Browser[] = [];

  interface SeedCard {
    id: string;
    title: string;
    lane: string;
  }

  test.afterEach(async () => {
    while (openBrowsers.length > 0) await openBrowsers.pop()?.close();
  });

  async function openSeeded(cards: SeedCard[], archivedCount = 0): Promise<Page> {
    await waitForViteReady(VITE_URL);
    const seededBrowser = await chromium.launch({ headless: true });
    openBrowsers.push(seededBrowser);
    const context = await seededBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    const seededPage = await context.newPage();
    await seededPage.addInitScript({ path: MOCK_SCRIPT });
    await seededPage.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var timestamp = new Date().toISOString();
        state.projects.push({
          id: 'proj-seeded', name: 'Seeded Columns', path: '/mock/seeded-columns', github_url: null,
          default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
        });
        var laneIds = {};
        state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
          laneIds[lane.name] = 'lane-seeded-' + index;
          state.swimlanes.push(Object.assign({}, lane, { id: laneIds[lane.name], position: index, created_at: timestamp }));
        });
        ${JSON.stringify(cards)}.forEach(function (entry, index) {
          state.tasks.push({
            id: entry.id, display_id: index + 1, title: entry.title, description: '',
            swimlane_id: laneIds[entry.lane], position: index, agent: 'claude', session_id: null,
            worktree_path: null, branch_name: null, base_branch: 'main', archived_at: null,
            created_at: timestamp, updated_at: timestamp, artifacts: [],
          });
        });
        for (var archivedIndex = 0; archivedIndex < ${archivedCount}; archivedIndex++) {
          state.archivedTasks.push({
            id: 'task-archived-' + archivedIndex, display_id: 100 + archivedIndex, title: 'Archived ' + archivedIndex,
            description: '', swimlane_id: laneIds['Done'], position: archivedIndex, agent: null, session_id: null,
            worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null,
            use_worktree: null, attachment_count: 0, archived_at: timestamp, created_at: timestamp, updated_at: timestamp,
          });
        }
        return { currentProjectId: 'proj-seeded' };
      });
    `);
    await gotoVite(seededPage, VITE_URL);
    await seededPage.waitForLoadState('load');
    await seededPage.locator('[data-lane-wrapper]').first().waitFor({ state: 'visible', timeout: 15000 });
    return seededPage;
  }

  const laneIn = (target: Page, name: string): Locator => target.locator(`[data-testid="swimlane"][data-swimlane-name="${name}"]`);
  const stripIn = (target: Page, name: string): Locator => target.locator(`[data-testid="swimlane"][data-swimlane-name="${name}"][data-collapsed]`);
  const wrapperIn = (target: Page, name: string): Locator => target.locator('[data-lane-wrapper]').filter({ has: laneIn(target, name) });

  test('a column whose cards are all filtered out keeps its width, and a truly empty one still shrinks', async () => {
    const seeded = await openSeeded([
      { id: 'task-alpha', title: 'Alpha work', lane: 'To Do' },
      { id: 'task-beta', title: 'Beta work', lane: 'Planning' },
    ]);
    await expect(laneIn(seeded, 'Planning').getByText('Beta work')).toBeVisible();
    await expect(wrapperIn(seeded, 'Planning')).toHaveAttribute('data-lane-shape', 'shared');
    await expect(wrapperIn(seeded, 'Executing')).toHaveAttribute('data-lane-shape', 'shrunk');

    await seeded.locator('[data-testid="board-search"]').fill('Alpha');
    await expect(laneIn(seeded, 'Planning').getByText('Beta work')).toHaveCount(0);
    await expect(laneIn(seeded, 'To Do').getByText('Alpha work')).toBeVisible();

    // Planning still holds Beta, only hidden: it does not shrink as an empty column does.
    await expect(wrapperIn(seeded, 'Planning')).toHaveAttribute('data-lane-shape', 'shared');
    await expect(wrapperIn(seeded, 'Executing')).toHaveAttribute('data-lane-shape', 'shrunk');
  });

  test('a collapsed Done strip counts the completed tasks as well as the ones still in the column', async () => {
    const seeded = await openSeeded([{ id: 'task-live-done', title: 'Live done', lane: 'Done' }], 2);
    const doneLane = laneIn(seeded, 'Done');
    await expect(doneLane.getByText('Live done')).toBeVisible();

    // What the open column showed: its own cards in the header, the archive beside "Completed".
    const headerCount = Number(await doneLane.locator('[data-testid="swimlane-task-count"]').innerText());
    await expect(doneLane.locator('[data-testid="view-all-completed-count"]')).toBeVisible();
    const completedCount = Number(await doneLane.locator('[data-testid="view-all-completed-count"]').innerText());
    expect(headerCount).toBe(1);
    expect(completedCount).toBe(2);

    await doneLane.locator('[data-testid="collapse-column-btn"]').click();
    await expect(stripIn(seeded, 'Done')).toBeVisible();
    await expect(stripIn(seeded, 'Done').locator('[data-testid="swimlane-task-count"]')).toHaveText(String(headerCount + completedCount));
    await expect(stripIn(seeded, 'Done')).toHaveAccessibleName('Expand Done column, 3 tasks');
  });

  test('with two strips side by side, a card dropped on the second lands there and opens it', async () => {
    const seeded = await openSeeded([{ id: 'task-mover', title: 'Mover card', lane: 'To Do' }]);
    for (const name of ['Planning', 'Executing']) {
      await laneIn(seeded, name).locator('[data-testid="collapse-column-btn"]').click();
      await expect(stripIn(seeded, name)).toBeVisible();
    }
    await seeded.evaluate(async () => {
      const running = Array.from(document.querySelectorAll('[data-lane-wrapper]'))
        .flatMap((element) => element.getAnimations({ subtree: true }));
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    });

    const card = laneIn(seeded, 'To Do').getByText('Mover card').first();
    await card.waitFor({ state: 'visible', timeout: 5000 });
    const cardBox = await card.boundingBox();
    const targetBox = await stripIn(seeded, 'Executing').boundingBox();
    if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for the drag');
    const startX = cardBox.x + cardBox.width / 2;
    const startY = cardBox.y + cardBox.height / 2;
    await seeded.mouse.move(startX, startY);
    await seeded.mouse.down();
    await seeded.mouse.move(startX + 10, startY, { steps: 3 });
    await seeded.locator('.drag-overlay').filter({ hasText: 'Mover card' }).waitFor({ state: 'visible', timeout: 3000 });
    await seeded.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 120, { steps: 30 });
    await expect(stripIn(seeded, 'Executing')).toHaveClass(/drop-highlight/);
    await expect(stripIn(seeded, 'Planning')).not.toHaveClass(/drop-highlight/);
    await seeded.mouse.up();

    await expect(stripIn(seeded, 'Executing')).toHaveCount(0);
    await expect(laneIn(seeded, 'Executing').getByText('Mover card')).toBeVisible();
    // The first strip was not the target: it stays a strip, with nothing dropped in it.
    await expect(stripIn(seeded, 'Planning')).toBeVisible();
    await expect(stripIn(seeded, 'Planning').locator('[data-testid="swimlane-task-count"]')).toHaveText('0');
  });
});

/**
 * A drop that empties one column and fills an empty one changes two shapes at
 * once. Its own page: one card alone in Planning, so the drag out leaves
 * Planning empty, and the other columns empty and shrunk.
 */
test.describe('Board columns: a drop that empties one column and fills another', () => {
  const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
  const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
  const CARD_TITLE = 'Lone card';
  let dropBrowser: Browser;
  let dropPage: Page;

  type FrameWindow = Window & {
    __laneFrames?: Array<{ phase: string; widths: Record<string, number> }>;
    __lanePhase?: string;
    __laneSampler?: number;
  };

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    dropBrowser = await chromium.launch({ headless: true });
    const context = await dropBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
    dropPage = await context.newPage();
    await dropPage.addInitScript({ path: MOCK_SCRIPT });
    await dropPage.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var timestamp = new Date().toISOString();
        state.projects.push({
          id: 'proj-drop', name: 'Drop Test', path: '/mock/drop-test', github_url: null,
          default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
        });
        var laneIds = {};
        state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
          laneIds[lane.name] = 'lane-drop-' + index;
          state.swimlanes.push(Object.assign({}, lane, { id: laneIds[lane.name], position: index, created_at: timestamp }));
        });
        [{ id: 'task-lone', title: '${CARD_TITLE}', lane: 'Planning' }, { id: 'task-stays', title: 'Stays put', lane: 'To Do' }]
          .forEach(function (entry, index) {
            state.tasks.push({
              id: entry.id, display_id: index + 1, title: entry.title, description: '',
              swimlane_id: laneIds[entry.lane], position: 0, agent: 'claude', session_id: null,
              worktree_path: null, branch_name: null, base_branch: 'main', archived_at: null,
              created_at: timestamp, updated_at: timestamp, artifacts: [],
            });
          });
        return { currentProjectId: 'proj-drop' };
      });
    `);
    await gotoVite(dropPage, VITE_URL);
    await dropPage.waitForLoadState('load');
    await dropPage.locator('[data-lane-wrapper]').first().waitFor({ state: 'visible', timeout: 15000 });
  });

  test.afterAll(async () => {
    await dropBrowser?.close();
  });

  test('the columns hold still while the card is in the air, and only the two that changed move after the drop', async () => {
    // Every empty column took the width of the widest EMPTY column's header,
    // so a drop that changed which columns were empty resized the others too:
    // columns that had nothing to do with the move grew or shrank under it.
    const dropLane = (name: string): Locator => dropPage.locator(`[data-testid="swimlane"][data-swimlane-name="${name}"]`);
    await expect(dropLane('Planning').locator(`text=${CARD_TITLE}`)).toBeVisible();
    await expect(dropPage.locator('[data-lane-wrapper][data-lane-shape="shrunk"]').first()).toBeVisible();
    // Past the arrival quiet period, so the drop's width change eases as it does in use.
    await dropPage.waitForFunction(() => performance.now() > 2500);

    await dropPage.evaluate(() => {
      const frameWindow = window as FrameWindow;
      frameWindow.__laneFrames = [];
      frameWindow.__lanePhase = 'air';
      const sample = (): void => {
        const widths: Record<string, number> = {};
        document.querySelectorAll('[data-lane-wrapper]').forEach((wrapperElement) => {
          const name = wrapperElement.querySelector('[data-swimlane-name]')?.getAttribute('data-swimlane-name');
          if (name) widths[name] = wrapperElement.getBoundingClientRect().width;
        });
        frameWindow.__laneFrames?.push({ phase: frameWindow.__lanePhase ?? 'air', widths });
        frameWindow.__laneSampler = requestAnimationFrame(sample);
      };
      sample();
    });

    const card = dropLane('Planning').locator(`text=${CARD_TITLE}`).first();
    const cardBox = await card.boundingBox();
    const targetBox = await dropLane('Code Review').boundingBox();
    if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for the drag');
    const startX = cardBox.x + cardBox.width / 2;
    const startY = cardBox.y + cardBox.height / 2;
    await dropPage.mouse.move(startX, startY);
    await dropPage.mouse.down();
    await dropPage.mouse.move(startX + 10, startY, { steps: 3 });
    await dropPage.locator('.drag-overlay').filter({ hasText: CARD_TITLE }).waitFor({ state: 'visible', timeout: 3000 });
    await dropPage.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 120, { steps: 30 });
    await expect(dropLane('Code Review')).toHaveClass(/drop-highlight/);

    await dropPage.evaluate(() => { (window as FrameWindow).__lanePhase = 'dropped'; });
    await dropPage.mouse.up();
    await expect(dropLane('Code Review').locator(`text=${CARD_TITLE}`)).toBeVisible();
    await expect(dropPage.locator('[data-lane-wrapper]').filter({ has: dropLane('Planning') })).toHaveAttribute('data-lane-shape', 'shrunk');

    const frames = await dropPage.evaluate(async () => {
      const frameWindow = window as FrameWindow;
      // Until every width animation has ended, then a few frames more.
      for (let quiet = 0; quiet < 5;) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const running = Array.from(document.querySelectorAll('[data-lane-wrapper]'))
          .flatMap((wrapperElement) => wrapperElement.getAnimations({ subtree: true }));
        quiet = running.length === 0 ? quiet + 1 : 0;
      }
      if (frameWindow.__laneSampler !== undefined) cancelAnimationFrame(frameWindow.__laneSampler);
      return frameWindow.__laneFrames ?? [];
    });

    const names = Object.keys(frames[0].widths);
    const spanOf = (phase: string, name: string): { low: number; high: number } => {
      const values = frames.filter((frame) => frame.phase === phase).map((frame) => frame.widths[name]);
      return { low: Math.min(...values), high: Math.max(...values) };
    };
    const tolerancePx = 2;
    expect(frames.filter((frame) => frame.phase === 'dropped').length).toBeGreaterThan(3);

    for (const name of names) {
      const air = spanOf('air', name);
      expect(air.high - air.low, `${name} while the card is in the air`).toBeLessThan(tolerancePx);

      const dropped = spanOf('dropped', name);
      const before = frames[0].widths[name];
      const after = frames[frames.length - 1].widths[name];
      if (name === 'Planning' || name === 'Code Review') {
        // The two that changed ease between the width they had and the one they get.
        expect(Math.abs(after - before), `${name} changes width`).toBeGreaterThan(tolerancePx);
        expect(dropped.low, `${name} after the drop`).toBeGreaterThanOrEqual(Math.min(before, after) - tolerancePx);
        expect(dropped.high, `${name} after the drop`).toBeLessThanOrEqual(Math.max(before, after) + tolerancePx);
      } else {
        expect(dropped.high - dropped.low, `${name} after the drop`).toBeLessThan(tolerancePx);
      }
    }
  });
});

/**
 * Column width: Fill. Its own page, seeded with the setting, so the cases
 * above keep the default.
 */
test.describe('Board columns: Fill', () => {
  const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
  const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
  let fillBrowser: Browser;
  let fillPage: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    fillBrowser = await chromium.launch({ headless: true });
    // 2000px wide: with the sidebar, the row is narrower than the columns need
    // at Narrow and wider than they need at Fill's floor. The test checks both.
    const context = await fillBrowser.newContext({ viewport: { width: 2000, height: 900 } });
    fillPage = await context.newPage();
    await fillPage.addInitScript({ path: MOCK_SCRIPT });
    await fillPage.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var timestamp = new Date().toISOString();
        state.projects.push({
          id: 'proj-fill', name: 'Fill Test', path: '/mock/fill-test', github_url: null,
          default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
        });
        state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
          state.swimlanes.push(Object.assign({}, lane, { id: 'lane-fill-' + index, position: index, created_at: timestamp }));
        });
        Object.assign(state.config, { columnWidth: 'fill', shrinkEmptyColumns: false });
        return { currentProjectId: 'proj-fill' };
      });
    `);
    await gotoVite(fillPage, VITE_URL);
    await fillPage.waitForLoadState('load');
    await fillPage.locator('[data-lane-wrapper]').first().waitFor({ state: 'visible', timeout: 15000 });
  });

  test.afterAll(async () => {
    await fillBrowser?.close();
  });

  test('fits a board that the same columns at Narrow would not, with even gutters', async () => {
    // Fill exists to fit the columns to the window. With a 256px floor it
    // stopped sharing exactly when it was needed, and the board scrolled with
    // Fill selected.
    const measured = await fillPage.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll<HTMLElement>('[data-lane-wrapper]'));
      const row = wrappers[0].parentElement as HTMLElement;
      const scroller = row.parentElement as HTMLElement;
      const box = scroller.getBoundingClientRect();
      const first = wrappers[0].getBoundingClientRect();
      const last = wrappers[wrappers.length - 1].getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      return {
        widths: wrappers.map((wrapper) => wrapper.getBoundingClientRect().width),
        rowWidth: row.clientWidth,
        scrolls: scroller.scrollWidth > scroller.clientWidth + 1,
        gap,
        leftGutter: first.left - box.left,
        rightGutter: box.right - last.right,
      };
    });

    // The fixture means something only if Narrow would overflow this row while
    // the columns at Fill's floor would not.
    const gaps = (measured.widths.length - 1) * measured.gap;
    expect(measured.widths.length * laneWidthRange('narrow').minPx + gaps).toBeGreaterThan(measured.rowWidth);
    expect(measured.widths.length * FILL_FLOOR_PX + gaps).toBeLessThan(measured.rowWidth);

    expect(measured.scrolls).toBe(false);
    // The columns split the row evenly.
    expect(Math.max(...measured.widths) - Math.min(...measured.widths)).toBeLessThan(1);
    // And the last column sits as far from the right edge as the first from the left.
    expect(Math.abs(measured.leftGutter - measured.rightGutter)).toBeLessThan(3);
  });
});
