/**
 * A card dragged into another column parts that column's cards under the ghost
 * and lands where the gap was, the way the card's own column already behaves
 * (src/renderer/utils/board-drop-preview.ts).
 *
 * Before, the target column moved nothing: the ghost sat on its cards and the
 * drop index was computed only on release. An earlier preview moved the card
 * into the target lane's task array mid-drag (`cd7b40c1b` removed it): the
 * layout shifted under dnd-kit's measured rects and `closestCenter` flipped
 * between columns at the boundary. This one parts the cards by transform only,
 * which dnd-kit's measuring ignores.
 *
 * What each case pins:
 *  - the gap opens at the slot nearest the ghost's center, follows it, and goes
 *    to the end past the last card;
 *  - it follows the ghost where `over` stays on the same card (red with the
 *    preview run from `onDragOver` alone, which fires only when `over` changes);
 *  - the drop lands at the slot the gap showed;
 *  - frame-sampled: a ghost held still at the column boundary moves no card
 *    from frame to frame (the `cd7b40c1b` oscillation), and the drop hands the
 *    gap over to the landed card with no card jumping (dnd-kit's own
 *    after-drop animation would otherwise pull the parted cards back to their
 *    drag-start places and slide them down again);
 *  - the blank slot card sits in the gap, and nothing parts over Done, after
 *    Escape, or in an empty lane, where the slot card sits at the top;
 *  - a card dragged out of Done is restored at the slot, and one the board
 *    filter hides closes the gap as soon as it lands.
 *
 * Each test launches its own page from a seeded state, so the file can fan out
 * across the UI workers.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-drop-gap-${RUN_SUFFIX}`;
const MOVER_ID = `task-drop-gap-mover-${RUN_SUFFIX}`;
const PLANNING_IDS = [0, 1, 2].map((index) => `task-drop-gap-planning-${index}-${RUN_SUFFIX}`);
const ARCHIVED_ID = `task-drop-gap-archived-${RUN_SUFFIX}`;

const PLANNING = '[data-swimlane-name="Planning"]';
const OVERLAY = '.drag-overlay';

function card(taskId: string): string {
  return `[data-swimlane-task-list] [data-task-id="${taskId}"]`;
}

/**
 * To Do with the card to drag and one more, Planning with three cards, an empty
 * Executing, and Done holding one completed card. Only those four columns, so
 * Done is on screen beside Planning, and none of them spawns an agent, so a
 * drop opens no terminal to reflow the board under the frame samplers.
 */
const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Drop Gap Test',
      path: '/mock/drop-gap-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES
      .filter(function (s) { return ['To Do', 'Planning', 'Executing', 'Done'].indexOf(s.name) >= 0; })
      .forEach(function (s, i) {
        var id = 'lane-dg-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts, auto_spawn: false }));
      });
    // Planning's cards carry a description long enough to wrap, so they stand
    // taller than the card dragged over them (see the same-\`over\` case).
    var LONG = 'A description long enough to wrap onto a second line of a board card, so this card stands taller than the one dragged over it.';
    function task(id, title, lane, position, archivedAt) {
      return {
        id: id, display_id: position + 1, title: title,
        description: lane === 'Planning' ? LONG : 'Short note',
        swimlane_id: laneIds[lane], position: position, agent: null, session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null, base_branch: null,
        archived_at: archivedAt, created_at: ts, updated_at: ts,
      };
    }
    // The card to drag is pushed LAST, after Planning's cards: the array order
    // an optimistic move used to sort it by when it tied with a Planning card.
    state.tasks.push(task('${PLANNING_IDS[0]}', 'Planning Zero', 'Planning', 0, null));
    state.tasks.push(task('${PLANNING_IDS[1]}', 'Planning One', 'Planning', 1, null));
    state.tasks.push(task('${PLANNING_IDS[2]}', 'Planning Two', 'Planning', 2, null));
    state.tasks.push(task('task-drop-gap-todo-other-${RUN_SUFFIX}', 'Todo Other', 'To Do', 1, null));
    state.tasks.push(task('${MOVER_ID}', 'Mover', 'To Do', 0, null));
    state.archivedTasks.push(task('${ARCHIVED_ID}', 'Restored Card', 'Done', 0, ts));
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator(card(MOVER_ID)).waitFor({ state: 'visible', timeout: 15000 });
  await page.locator(card(PLANNING_IDS[2])).waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

interface Box { x: number; y: number; width: number; height: number }

async function box(page: Page, selector: string): Promise<Box> {
  const measured = await page.locator(selector).first().boundingBox();
  if (!measured) throw new Error(`no box for ${selector}`);
  return measured;
}

/** A drag in progress: where the pointer is, and how far the ghost's center sits from it. */
interface Drag { pointerX: number; pointerY: number; ghostOffsetX: number; ghostOffsetY: number }

/** Press on the card's center and move far enough for dnd-kit's 5px activation. */
async function pickUp(page: Page, selector: string): Promise<Drag> {
  const source = await box(page, selector);
  const startX = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 3000 });
  const ghost = await box(page, OVERLAY);
  return {
    pointerX: startX + 10,
    pointerY: startY,
    ghostOffsetX: ghost.x + ghost.width / 2 - (startX + 10),
    ghostOffsetY: ghost.y + ghost.height / 2 - startY,
  };
}

/** Move the pointer so the ghost's center lands on (x, y). */
async function moveGhostTo(page: Page, drag: Drag, x: number, y: number): Promise<void> {
  drag.pointerX = x - drag.ghostOffsetX;
  drag.pointerY = y - drag.ghostOffsetY;
  await page.mouse.move(drag.pointerX, drag.pointerY, { steps: 12 });
}

/** Which Planning cards carry the shift, in Planning order. */
async function shifted(page: Page): Promise<boolean[]> {
  return page.evaluate((ids) => ids.map((id) => {
    const element = document.querySelector(`[data-swimlane-task-list] [data-task-id="${id}"]`);
    return element?.hasAttribute('data-drop-shift') ?? false;
  }), PLANNING_IDS);
}

/** A lane's task ids in the board store, in position order. */
async function laneOrder(page: Page, laneName: string): Promise<string[]> {
  return page.evaluate((name) => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => {
        tasks: Array<{ id: string; swimlane_id: string; position: number }>;
        swimlanes: Array<{ id: string; name: string }>;
      } } };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    const lane = state.swimlanes.find((swimlane) => swimlane.name === name);
    return state.tasks
      .filter((task) => task.swimlane_id === lane?.id)
      .sort((a, b) => a.position - b.position)
      .map((task) => task.id);
  }, laneName);
}

/** The original (unshifted) boxes of Planning's three cards. */
async function planningBoxes(page: Page): Promise<Box[]> {
  return Promise.all(PLANNING_IDS.map((id) => box(page, card(id))));
}

function center(target: Box): { x: number; y: number } {
  return { x: target.x + target.width / 2, y: target.y + target.height / 2 };
}

test('the gap opens under the ghost, follows it, goes to the end past the last card, and the card lands there', async () => {
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const drag = await pickUp(page, card(MOVER_ID));
    const ghostHeight = (await box(page, OVERLAY)).height;

    // Ghost on the second card's place: it and the third part, the first stays.
    await moveGhostTo(page, drag, center(original[1]).x, center(original[1]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);
    // The second card slid down by the ghost's height plus the gap (after its 200ms ease).
    await expect.poll(async () => {
      const moved = (await box(page, card(PLANNING_IDS[1]))).y - original[1].y;
      return Math.abs(moved - (ghostHeight + 8)) <= 2;
    }, { timeout: 3000 }).toBe(true);
    // The slot card sits in the gap, where the second card was, once its
    // slide from any slot the ghost crossed on the way in has finished.
    await expect.poll(async () => {
      const slot = await box(page, `${PLANNING} [data-drop-slot][data-visible]`);
      return Math.abs(slot.y - original[1].y) <= 2 && Math.abs(slot.height - ghostHeight) <= 2;
    }, { timeout: 3000 }).toBe(true);
    // It is the dragged card, dimmed as it is in its own column's slot, and a
    // picture only: nothing in it answers to a card's task id, test id or Tab.
    const slotCopy = await page.evaluate((selector) => {
      const slot = document.querySelector(selector)!;
      return {
        text: slot.textContent ?? '',
        opacity: getComputedStyle(slot).opacity,
        liveAttributes: slot.querySelectorAll('[data-task-id], [data-testid], [tabindex], [id]').length,
      };
    }, `${PLANNING} [data-drop-slot][data-visible]`);
    expect(slotCopy.text).toContain('Mover');
    expect(slotCopy.opacity).toBe('0.4');
    expect(slotCopy.liveAttributes).toBe(0);

    // Ghost on the third card's place: the second comes back up.
    await moveGhostTo(page, drag, center(original[2]).x, center(original[2]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, false, true]);

    // Ghost just past the last card: the end slot, so nothing parts.
    await moveGhostTo(page, drag, center(original[2]).x, original[2].y + original[2].height + 8 + ghostHeight / 2);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, false, false]);
    // The slot card slides there on the same 200ms ease as the cards.
    await expect.poll(async () => {
      const endSlot = await box(page, `${PLANNING} [data-drop-slot][data-visible]`);
      return Math.abs(endSlot.y - (original[2].y + original[2].height + 8)) <= 3;
    }, { timeout: 3000 }).toBe(true);

    await page.mouse.up();
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 }).toEqual([...PLANNING_IDS, MOVER_ID]);
    await expect(page.locator('[data-drop-shift], [data-drop-slot][data-visible]')).toHaveCount(0, { timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('the gap follows the ghost where `over` stays on the same card', async () => {
  // dnd-kit fires onDragOver only when `over` changes. Where the target cards
  // stand taller than the ghost, the slot swaps a few pixels before `over`
  // does, so a preview run from onDragOver alone leaves the gap a slot behind
  // the ghost there. This case aims the ghost into that window.
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const list = await box(page, `${PLANNING} [data-swimlane-task-list]`);
    const drag = await pickUp(page, card(MOVER_ID));
    const ghostHeight = (await box(page, OVERLAY)).height;
    const [first, second] = original;

    // The slot swaps 0 to 1 halfway between the two slots' centers; `over`
    // swaps from the first card to the second halfway between the two cards'
    // centers.
    const slotSwap = (first.y + second.y) / 2 + ghostHeight / 2;
    const overSwap = (first.y + first.height / 2 + second.y + second.height / 2) / 2;
    expect(overSwap - slotSwap, 'the Planning cards must stand taller than the dragged card').toBeGreaterThanOrEqual(4);
    const inWindow = (slotSwap + overSwap) / 2;
    // And the first card, not the lane's own droppable, is nearest the ghost there.
    const listCenter = list.y + list.height / 2;
    expect(Math.abs(inWindow - center(first).y)).toBeLessThan(Math.abs(inWindow - listCenter));

    // On the first card's place: slot 0, every card parted.
    await moveGhostTo(page, drag, center(first).x, first.y + ghostHeight / 2);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([true, true, true]);

    // Into the window, with `over` still on the first card: slot 1.
    await moveGhostTo(page, drag, center(first).x, inWindow);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);

    await page.mouse.up();
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 })
      .toEqual([PLANNING_IDS[0], MOVER_ID, PLANNING_IDS[1], PLANNING_IDS[2]]);
  } finally {
    await browser.close();
  }
});

test('a drop lands at the slot the gap showed', async () => {
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const drag = await pickUp(page, card(MOVER_ID));
    await moveGhostTo(page, drag, center(original[1]).x, center(original[1]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);

    await page.mouse.up();
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 })
      .toEqual([PLANNING_IDS[0], MOVER_ID, PLANNING_IDS[1], PLANNING_IDS[2]]);
  } finally {
    await browser.close();
  }
});

/** Sample every Planning card's box on each animation frame, `frames` times. */
async function sampleFrames(page: Page, frames: number): Promise<Array<Array<{ x: number; y: number }>>> {
  return page.evaluate(({ ids, count }) => new Promise<Array<Array<{ x: number; y: number }>>>((resolve) => {
    const samples: Array<Array<{ x: number; y: number }>> = [];
    const sample = () => {
      samples.push(ids.map((id) => {
        const rect = document.querySelector(`[data-swimlane-task-list] [data-task-id="${id}"]`)!.getBoundingClientRect();
        return { x: Math.round(rect.left * 10) / 10, y: Math.round(rect.top * 10) / 10 };
      }));
      if (samples.length < count) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }), { ids: PLANNING_IDS, count: frames });
}

/** Wait until the cards' 200ms ease has finished: six frames in a row with no card moving. */
async function waitForCardsAtRest(page: Page): Promise<void> {
  await expect.poll(async () => {
    const frames = await sampleFrames(page, 6);
    return frames.every((frame) => JSON.stringify(frame) === JSON.stringify(frames[0]));
  }, { timeout: 3000 }).toBe(true);
}

test('frame-sampled: a ghost held at the column boundary moves no card from frame to frame', async () => {
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const planningColumn = await box(page, PLANNING);
    const drag = await pickUp(page, card(MOVER_ID));

    // The ghost's center just inside Planning's left edge, on the second card's
    // place: where the old mid-drag membership change flipped between columns.
    await moveGhostTo(page, drag, planningColumn.x + 12, center(original[1]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);
    // Let the 200ms ease finish, then hold still.
    await waitForCardsAtRest(page);

    const held = await sampleFrames(page, 30);
    for (const frame of held) expect(frame).toEqual(held[0]);

    // Small moves that stay inside the same slot move nothing either.
    const sampling = sampleFrames(page, 30);
    for (const offset of [3, -3, 5, -5, 0]) {
      await page.mouse.move(drag.pointerX + offset, drag.pointerY + offset, { steps: 2 });
    }
    const jittered = await sampling;
    for (const frame of jittered) expect(frame).toEqual(held[0]);

    await page.keyboard.press('Escape');
  } finally {
    await browser.close();
  }
});

test('frame-sampled: the drop hands the gap to the landed card with no card jumping', async () => {
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const drag = await pickUp(page, card(MOVER_ID));
    await moveGhostTo(page, drag, center(original[1]).x, center(original[1]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);
    await waitForCardsAtRest(page);
    const parted = (await sampleFrames(page, 1))[0];

    // From the release on, every frame for about half a second: the parted
    // cards must hold their places through the handoff, since their places in
    // the new layout are exactly where the gap had put them.
    const sampling = page.evaluate(({ ids, moverId }) => new Promise<Array<{ tops: number[]; landed: boolean; slotVisible: boolean }>>((resolve) => {
      const frames: Array<{ tops: number[]; landed: boolean; slotVisible: boolean }> = [];
      const startedAt = performance.now();
      const sample = () => {
        frames.push({
          tops: ids.map((id) => document.querySelector(`[data-swimlane-task-list] [data-task-id="${id}"]`)!.getBoundingClientRect().top),
          landed: document.querySelector(`[data-swimlane-name="Planning"] [data-swimlane-task-list] [data-task-id="${moverId}"]`) !== null,
          slotVisible: document.querySelector('[data-swimlane-name="Planning"] [data-drop-slot][data-visible]') !== null,
        });
        if (performance.now() - startedAt < 500) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    }), { ids: PLANNING_IDS, moverId: MOVER_ID });
    await page.mouse.up();
    const frames = await sampling;

    expect(frames.some((frame) => frame.landed)).toBe(true);
    for (const frame of frames) {
      frame.tops.forEach((top, index) => {
        expect(Math.abs(top - parted[index].y), `card ${index} moved ${top - parted[index].y}px in a frame after the drop`).toBeLessThanOrEqual(2);
      });
      if (frame.landed) expect(frame.slotVisible).toBe(false);
    }
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 })
      .toEqual([PLANNING_IDS[0], MOVER_ID, PLANNING_IDS[1], PLANNING_IDS[2]]);
  } finally {
    await browser.close();
  }
});

test('nothing parts over Done or after Escape, and an empty column shows the slot card at its top', async () => {
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const drag = await pickUp(page, card(MOVER_ID));

    const executingList = await box(page, '[data-swimlane-name="Executing"] [data-swimlane-task-list]');
    await moveGhostTo(page, drag, executingList.x + executingList.width / 2, executingList.y + 80);
    const emptySlot = page.locator('[data-swimlane-name="Executing"] [data-drop-slot][data-visible]');
    await expect(emptySlot).toHaveCount(1, { timeout: 3000 });
    expect(Math.abs((await box(page, '[data-swimlane-name="Executing"] [data-drop-slot]')).y - (executingList.y + 8))).toBeLessThanOrEqual(3);
    await expect(page.locator('[data-drop-shift]')).toHaveCount(0);

    const doneZone = await box(page, '[data-done-drop-zone]');
    await moveGhostTo(page, drag, doneZone.x + doneZone.width / 2, doneZone.y + doneZone.height / 2);
    await expect(page.locator('[data-drop-shift], [data-drop-slot][data-visible]')).toHaveCount(0, { timeout: 3000 });

    await moveGhostTo(page, drag, center(original[1]).x, center(original[1]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);
    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('[data-drop-shift], [data-drop-slot][data-visible]')).toHaveCount(0, { timeout: 3000 });
    expect(await laneOrder(page, 'Planning')).toEqual(PLANNING_IDS);
    // A hidden slot card takes no layout. A transparent one left where the
    // ghost last put it kept a nearly full lane's scrollbar, and its narrower
    // cards, after the gap had closed.
    const slotDisplays = await page.evaluate(() => [...document.querySelectorAll('[data-drop-slot]')]
      .map((slot) => getComputedStyle(slot).display));
    expect(slotDisplays.length).toBeGreaterThan(0);
    expect(slotDisplays.every((display) => display === 'none')).toBe(true);
  } finally {
    await browser.close();
  }
});

test('a card dragged out of Done is restored at the slot the gap showed', async () => {
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const archivedCard = `[data-swimlane-name="Done"] [data-task-id="${ARCHIVED_ID}"]`;
    await page.locator(archivedCard).waitFor({ state: 'visible', timeout: 10000 });
    const drag = await pickUp(page, archivedCard);

    // The overlay draws the full card, taller than Done's compact row, so the
    // ghost is aimed by its own center.
    await moveGhostTo(page, drag, center(original[0]).x, original[0].y + (await box(page, OVERLAY)).height / 2);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([true, true, true]);

    await page.mouse.up();
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 })
      .toEqual([ARCHIVED_ID, ...PLANNING_IDS]);
  } finally {
    await browser.close();
  }
});

test('a card the board filter hides closes the gap as soon as it lands, not at the fallback', async () => {
  // Done's completed list ignores the board filter, so a card the filter hides
  // can still be dragged out of it. It lands in the lane's tasks but never in
  // the board's buckets, so the gap cannot hand over to it and must close as
  // soon as the store has it, rather than hang for the 1s fallback.
  const { browser, page } = await launch();
  try {
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { board: { getState: () => { setBoardSearchQuery: (query: string) => void } } };
      }).__zustandStores;
      stores?.board.getState().setBoardSearchQuery('Planning');
    });
    const archivedCard = `[data-swimlane-name="Done"] [data-task-id="${ARCHIVED_ID}"]`;
    await page.locator(archivedCard).waitFor({ state: 'visible', timeout: 10000 });
    const original = await planningBoxes(page);
    const drag = await pickUp(page, archivedCard);
    await moveGhostTo(page, drag, center(original[0]).x, original[0].y + (await box(page, OVERLAY)).height / 2);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([true, true, true]);

    const releasedAt = Date.now();
    await page.mouse.up();
    await expect(page.locator('[data-drop-shift], [data-drop-slot][data-visible]')).toHaveCount(0, { timeout: 3000 });
    expect(Date.now() - releasedAt, 'the gap waited for the 1s fallback').toBeLessThan(700);
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 })
      .toEqual([ARCHIVED_ID, ...PLANNING_IDS]);
    await expect(page.locator(`${PLANNING} [data-task-id="${ARCHIVED_ID}"]`)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
