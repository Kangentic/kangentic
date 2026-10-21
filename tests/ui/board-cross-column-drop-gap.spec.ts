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
 *  - the slot card, a dimmed copy of the dragged card, sits in the gap, and
 *    nothing parts over Done, after Escape, or in an empty lane, where the
 *    slot card sits at the top;
 *  - the slot card's copy is a picture only: no task id, test id, id, Tab stop,
 *    role or aria state on any element, no overlay lift (`shadow-xl`), and no
 *    inline transform, transition or opacity on its root;
 *  - a card dragged out of Done is restored at the slot, and one the board
 *    filter hides closes the gap as soon as it lands;
 *  - a ghost carried on from one column to the next closes the first column's
 *    gap (shifts, slot card and the gap value in each card's style) as the
 *    second opens;
 *  - the settle a drop holds on the parted cards is released, leaving no
 *    settle and no gap value in any card's style (page time is held still while
 *    the drop lands, to prove the hold is there, then let go);
 *  - a drag started inside that hold takes the hold away at once, and its own
 *    target column parts normally (page time stays held until the drag has
 *    started, which is the only way to start one inside a 50ms window);
 *  - a move that main rejects leaves no gap behind and puts the card back;
 *  - a move the workflow lock would refuse, of a card that is not locked (a
 *    paused workflow's card dragged into To Do), parts nothing over the refusing
 *    column, while the same card still parts a column that would take it;
 *  - in a lane whose stored positions have gaps (0, 5, 9), a drop at a slot
 *    lands there, in main's copy, the store and the drawn order alike, since a
 *    move writes a RAW position (`rawDropPosition`) and not the slot's index,
 *    and a card restored from Done to the end slot lands last.
 *
 * Not pinned here, and why:
 *  - `handleDragEnd`'s `catch` calls `clearDropGap()`, but `moveTask` and
 *    `unarchiveTask` both catch a rejected IPC call themselves and return, so
 *    no rejected `tasks.move` or `tasks.unarchive` reaches it. The move-fails
 *    case above passes through the normal handoff instead.
 *  - The 1s `DROP_HANDOFF_FALLBACK_MS` timer needs a dropped card that never
 *    enters its lane's bucket and is not hidden by the board filter. Every
 *    move and restore writes the card into the store before its IPC call, so
 *    no path through the UI leaves it out.
 *  - The board unmounting mid-drag: the remount builds fresh lane elements, so
 *    no gap attribute can survive it for an assertion to find. The cleanup only
 *    shows under HMR (`App.tsx`, Pattern D), which this tier cannot run.
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
const TODO_OTHER_ID = `task-drop-gap-todo-other-${RUN_SUFFIX}`;
const WORKFLOW_ID = `wf-drop-gap-${RUN_SUFFIX}`;

const TODO = '[data-swimlane-name="To Do"]';
const PLANNING = '[data-swimlane-name="Planning"]';
const EXECUTING = '[data-swimlane-name="Executing"]';
const OVERLAY = '.drag-overlay';

function card(taskId: string): string {
  return `[data-swimlane-task-list] [data-task-id="${taskId}"]`;
}

/**
 * To Do with the card to drag and one more, Planning with three cards, an empty
 * Executing, and Done holding one completed card. Only those four columns, so
 * Done is on screen beside Planning, and none of them spawns an agent, so a
 * drop opens no terminal to reflow the board under the frame samplers.
 *
 * `seedEdits` is script run on the seeded state before it is handed over, for
 * the one case that needs a different card. The base board is the empty string,
 * and the same-`over` case depends on its card heights, so it stays as is.
 */
function preConfig(seedEdits: string): string {
  return `
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
    state.tasks.push(task('${TODO_OTHER_ID}', 'Todo Other', 'To Do', 1, null));
    state.tasks.push(task('${MOVER_ID}', 'Mover', 'To Do', 0, null));
    state.archivedTasks.push(task('${ARCHIVED_ID}', 'Restored Card', 'Done', 0, ts));
    ${seedEdits}
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;
}

/**
 * Planning's first card joins a PAUSED workflow. A paused workflow's card is
 * not locked on the board (`isLockedOnBoard` needs it running), so it drags
 * anywhere, but `workflowMoveRefusal` still refuses a drag by hand into To Do,
 * which would delete its worktree and branch. That is a move the lock refuses
 * for a card that is not locked, the case `dropGapTarget`'s `refused` covers.
 */
const PAUSED_WORKFLOW_CARD_ID = PLANNING_IDS[0];
const PAUSED_WORKFLOW_INIT = `
  window.__mockWorkflows = [{
    workflow: { id: '${WORKFLOW_ID}', title: 'Drop Gap Plan', state: 'paused', color_slot: 5, agent_name: 'claude' },
  }];
`;
const PAUSED_WORKFLOW_SEED = `
  state.tasks.forEach(function (seeded) {
    if (seeded.id !== '${PAUSED_WORKFLOW_CARD_ID}') return;
    seeded.workflow_id = '${WORKFLOW_ID}';
    seeded.workflow_project_id = '${PROJECT_ID}';
    seeded.labels = [];
    seeded.priority = 0;
    seeded.attachment_count = 0;
    seeded.route_start_swimlane_id = null;
    seeded.route_last_swimlane_id = null;
    seeded.skipped_swimlane_ids = [];
  });
`;

/**
 * Planning's cards at stored positions 0, 5 and 9 instead of 0, 1 and 2. Live
 * cards sit at positions like these in production: archiving a card leaves its
 * position behind, and a new card takes the highest position plus one over
 * archived rows too. A move reads its target as a RAW stored position, so the
 * slot a drop shows (an index into the lane's order) is not the position to
 * write there.
 */
const GAPPED_PLANNING_POSITIONS = [0, 5, 9];
const GAPPED_PLANNING_SEED = `
  var gappedPositions = ${JSON.stringify(Object.fromEntries(PLANNING_IDS.map((id, index) => [id, GAPPED_PLANNING_POSITIONS[index]])))};
  state.tasks.forEach(function (seeded) {
    if (gappedPositions[seeded.id] !== undefined) seeded.position = gappedPositions[seeded.id];
  });
`;

interface LaunchOptions {
  /**
   * Install Playwright's fake clock before the app boots, so a test can hold
   * page time still (`freezePageTime`) across a drop. Time flows with real
   * time until it is held.
   */
  useClock?: boolean;
  /** Script run in the page before the app boots, ahead of the seed. */
  initScript?: string;
  /** Script run on the seeded state (see `preConfig`). */
  seedEdits?: string;
  /** Wait for this card's workflow strip: the board has loaded the workflow it asks the lock about. */
  workflowStripOn?: string;
}

async function launch(options: LaunchOptions = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    if (options.useClock) await page.clock.install();
    await page.addInitScript({ path: MOCK_SCRIPT });
    if (options.initScript) await page.addInitScript(options.initScript);
    await page.addInitScript(preConfig(options.seedEdits ?? ''));
    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.locator(card(MOVER_ID)).waitFor({ state: 'visible', timeout: 15000 });
    await page.locator(card(PLANNING_IDS[2])).waitFor({ state: 'visible', timeout: 15000 });
    if (options.workflowStripOn) {
      await page.locator(`${card(options.workflowStripOn)} [data-testid="workflow-card-strip"]`)
        .waitFor({ state: 'visible', timeout: 10000 });
    }
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
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

/** Which of these cards carry the attribute, in the order given. A card not on the board reads false. */
async function cardsWith(page: Page, attribute: string, taskIds: readonly string[]): Promise<boolean[]> {
  return page.evaluate(({ attributeName, ids }) => ids.map((id) => {
    const element = document.querySelector(`[data-swimlane-task-list] [data-task-id="${id}"]`);
    return element?.hasAttribute(attributeName) ?? false;
  }), { attributeName: attribute, ids: [...taskIds] });
}

/** Which Planning cards carry the shift, in Planning order. */
async function shifted(page: Page): Promise<boolean[]> {
  return cardsWith(page, 'data-drop-shift', PLANNING_IDS);
}

/**
 * Everything a drop gap writes, as one list of what is left: parted cards,
 * settled cards, a showing slot card, and a gap value in a card's own style.
 * `[]` is a lane with no trace of one. A name scopes it to that lane; none reads
 * the whole board.
 */
async function gapResidue(page: Page, laneName?: string): Promise<string[]> {
  return page.evaluate((name) => {
    let scope: ParentNode = document;
    if (name !== undefined) {
      const lane = document.querySelector(`[data-swimlane-name="${name}"]`);
      if (!lane) throw new Error(`no lane named ${name}`);
      scope = lane;
    }
    const found: string[] = [];
    const describe = (element: Element, what: string) => {
      const laneOf = element.closest('[data-swimlane-name]')?.getAttribute('data-swimlane-name') ?? 'no lane';
      found.push(`${laneOf}/${element.getAttribute('data-task-id') ?? 'slot card'}: ${what}`);
    };
    scope.querySelectorAll('[data-drop-shift]').forEach((element) => describe(element, 'data-drop-shift'));
    scope.querySelectorAll('[data-drop-settle]').forEach((element) => describe(element, 'data-drop-settle'));
    scope.querySelectorAll('[data-drop-slot][data-visible]').forEach((element) => describe(element, 'visible slot'));
    scope.querySelectorAll<HTMLElement>('[data-task-id]').forEach((element) => {
      if (element.style.getPropertyValue('--drop-gap') !== '') describe(element, 'inline --drop-gap');
    });
    return found;
  }, laneName);
}

/**
 * Hold page time still from just ahead of now: no page timer fires until
 * `page.clock.resume()`. Needs `launch({ useClock: true })`. The page's own
 * `requestAnimationFrame` is held too, so do not sample frames while it is.
 * Playwright's assertions poll on their own clock and keep working.
 */
async function freezePageTime(page: Page): Promise<void> {
  const pageNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(pageNow + 1000));
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
      .sort((firstTask, secondTask) => firstTask.position - secondTask.position)
      .map((task) => task.id);
  }, laneName);
}

/**
 * A lane's tasks as main's copy of the board holds them (the mock's
 * `tasks.list`, which applies a move with main's raw-position rule), in
 * position order. The store above is the renderer's copy.
 */
async function serverLaneTasks(page: Page, laneName: string): Promise<Array<{ id: string; position: number }>> {
  return page.evaluate(async (name) => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { swimlanes: Array<{ id: string; name: string }> } } };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const lane = stores.board.getState().swimlanes.find((swimlane) => swimlane.name === name);
    const listed = await window.electronAPI.tasks.list();
    return listed
      .filter((task) => task.swimlane_id === lane?.id)
      .sort((firstTask, secondTask) => firstTask.position - secondTask.position)
      .map((task) => ({ id: task.id, position: task.position }));
  }, laneName);
}

async function serverLaneOrder(page: Page, laneName: string): Promise<string[]> {
  return (await serverLaneTasks(page, laneName)).map((task) => task.id);
}

/** A lane's cards in the order they are drawn, top to bottom. The slot card carries no task id, so it is not among them. */
async function laneDomOrder(page: Page, laneName: string): Promise<string[]> {
  return page.locator(`[data-swimlane-name="${laneName}"] [data-swimlane-task-list] [data-task-id]`)
    .evaluateAll((cards) => cards.map((element) => element.getAttribute('data-task-id') ?? ''));
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
    // picture only (`inertCardCopy`): nothing in it answers to a card's task id,
    // test id, Tab, role or aria state, and it carries none of the overlay's
    // lift or dnd-kit's inline motion. The overlay's card has every one of them
    // (it is a sortable too), so each is a thing the copy had to shed.
    const slotCopy = await page.evaluate((selector) => {
      const slot = document.querySelector<HTMLElement>(selector)!;
      const liveAttributeNames = [
        'data-task-id', 'data-testid', 'id', 'tabindex', 'role',
        'aria-roledescription', 'aria-describedby', 'aria-description', 'aria-pressed', 'aria-disabled',
      ];
      const liveAttributes: string[] = [];
      for (const element of slot.querySelectorAll('*')) {
        for (const name of liveAttributeNames) {
          if (element.hasAttribute(name)) liveAttributes.push(`${element.tagName.toLowerCase()}[${name}]`);
        }
      }
      const copyRoot = slot.firstElementChild as HTMLElement | null;
      return {
        text: slot.textContent ?? '',
        opacity: getComputedStyle(slot).opacity,
        liveAttributes,
        hasCopyRoot: copyRoot !== null,
        liftedElements: slot.querySelectorAll('.shadow-xl').length,
        rootInlineMotion: copyRoot
          ? { transform: copyRoot.style.transform, transition: copyRoot.style.transition, opacity: copyRoot.style.opacity }
          : null,
      };
    }, `${PLANNING} [data-drop-slot][data-visible]`);
    expect(slotCopy.text).toContain('Mover');
    expect(slotCopy.opacity).toBe('0.4');
    expect(slotCopy.liveAttributes).toEqual([]);
    expect(slotCopy.hasCopyRoot).toBe(true);
    expect(slotCopy.liftedElements).toBe(0);
    expect(slotCopy.rootInlineMotion).toEqual({ transform: '', transition: '', opacity: '' });

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

test('a ghost carried on from one column to the next closes the first column\'s gap as the second opens', async () => {
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const drag = await pickUp(page, card(MOVER_ID));

    await moveGhostTo(page, drag, center(original[1]).x, center(original[1]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);
    await expect(page.locator(`${PLANNING} [data-drop-slot][data-visible]`)).toHaveCount(1, { timeout: 3000 });
    // The parted cards carry the gap value in their own style while it is open.
    expect(await gapResidue(page, 'Planning')).toContain(`Planning/${PLANNING_IDS[1]}: inline --drop-gap`);

    // Straight on to Executing: the next column to the right, passing neither
    // Done nor any space outside the lanes.
    const executingList = await box(page, `${EXECUTING} [data-swimlane-task-list]`);
    await moveGhostTo(page, drag, executingList.x + executingList.width / 2, executingList.y + 80);
    // Executing's slot first: it shows once the drag has reached Executing, so
    // Planning is judged closed only after the move that closes it has run. (An
    // empty list parts no card.)
    await expect(page.locator(`${EXECUTING} [data-drop-slot][data-visible]`)).toHaveCount(1, { timeout: 3000 });
    await expect(page.locator(`${PLANNING} [data-drop-slot][data-visible]`)).toHaveCount(0, { timeout: 3000 });
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, false, false]);
    // Nothing of the first gap is left on Planning's cards, the gap value in
    // their styles included.
    expect(await gapResidue(page, 'Planning')).toEqual([]);

    // And the drop goes where the second gap is.
    await page.mouse.up();
    await expect.poll(() => laneOrder(page, 'Executing'), { timeout: 3000 }).toEqual([MOVER_ID]);
    expect(await laneOrder(page, 'Planning')).toEqual(PLANNING_IDS);
  } finally {
    await browser.close();
  }
});

/**
 * Drag the mover onto Planning's second card's place, hold page time still, and
 * release it. The drop lands (the lane order is checked) with the settle hold
 * set and its 50ms release timer unable to fire: the hold stays for as long as
 * the test wants it, which a real 50ms never would.
 */
async function dropMoverWithTimeFrozen(page: Page): Promise<void> {
  const original = await planningBoxes(page);
  const drag = await pickUp(page, card(MOVER_ID));
  await moveGhostTo(page, drag, center(original[1]).x, center(original[1]).y);
  await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);
  await freezePageTime(page);
  await page.mouse.up();
  await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 })
    .toEqual([PLANNING_IDS[0], MOVER_ID, PLANNING_IDS[1], PLANNING_IDS[2]]);
}

/** Which of Planning's cards, in lane order after the mover has landed, are held by the settle. */
async function settled(page: Page): Promise<boolean[]> {
  return cardsWith(page, 'data-drop-settle', [PLANNING_IDS[0], MOVER_ID, PLANNING_IDS[1], PLANNING_IDS[2]]);
}

test('the settle a drop holds on the parted cards is released, leaving no settle and no gap value behind', async () => {
  const { browser, page } = await launch({ useClock: true });
  try {
    await dropMoverWithTimeFrozen(page);
    // The hold is there: the two cards the gap parted are pinned at rest, the
    // slot card is gone, and no card is parted any more. With page time held
    // the release cannot have run, so this is the state the release must undo.
    await expect.poll(() => settled(page), { timeout: 3000 }).toEqual([false, false, true, true]);
    expect(await shifted(page)).toEqual([false, false, false]);
    expect(await gapResidue(page, 'Planning')).toEqual([
      `Planning/${PLANNING_IDS[1]}: data-drop-settle`,
      `Planning/${PLANNING_IDS[2]}: data-drop-settle`,
      `Planning/${PLANNING_IDS[1]}: inline --drop-gap`,
      `Planning/${PLANNING_IDS[2]}: inline --drop-gap`,
    ]);

    // Time runs again: the 50ms timer and two frames pass, and the hold lifts.
    await page.clock.resume();
    await expect.poll(() => gapResidue(page), { timeout: 3000 }).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a drag started right after a drop takes the drop\'s hold away, and its own column parts normally', async () => {
  const { browser, page } = await launch({ useClock: true });
  try {
    await dropMoverWithTimeFrozen(page);
    // Inside the hold: Planning's two parted cards are still pinned, and time
    // is held, so only a drag start can take that away.
    await expect.poll(() => settled(page), { timeout: 3000 }).toEqual([false, false, true, true]);
    // The first card's overlay has finished its drop animation (a real-time
    // animation, which the held page clock does not stop).
    await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 3000 });

    // A second drag, out of Planning toward To Do.
    const secondDrag = await pickUp(page, card(PLANNING_IDS[0]));
    // Read once, with time still held: handleDragStart's clearDropGap() has run,
    // and the release timer it cancelled could not have. Not a poll, since the
    // settle would lift by itself the moment time ran again.
    expect(await gapResidue(page)).toEqual([]);

    await page.clock.resume();

    // The second drag parts its target as any drag does: Todo Other is To Do's
    // only card, and the ghost on its place opens the first slot.
    const secondGhostHeight = (await box(page, OVERLAY)).height;
    const todoOther = await box(page, card(TODO_OTHER_ID));
    await moveGhostTo(page, secondDrag, center(todoOther).x, todoOther.y + secondGhostHeight / 2);
    await expect.poll(() => cardsWith(page, 'data-drop-shift', [TODO_OTHER_ID]), { timeout: 3000 }).toEqual([true]);
    await expect(page.locator(`${TODO} [data-drop-slot][data-visible]`)).toHaveCount(1, { timeout: 3000 });
    // Planning, the first drop's lane and now this drag's own, stays clean.
    expect(await gapResidue(page, 'Planning')).toEqual([]);

    await page.mouse.up();
    await expect.poll(() => laneOrder(page, 'To Do'), { timeout: 3000 }).toEqual([PLANNING_IDS[0], TODO_OTHER_ID]);
  } finally {
    await browser.close();
  }
});

test('a move main rejects leaves no gap behind, and the card goes back', async () => {
  // The card is written into Planning before the IPC call, so the gap hands
  // over to it and settles as for any drop; the rejection then rolls the card
  // back. `moveTask` catches the rejection itself, so this is not
  // `handleDragEnd`'s catch (see the header).
  const { browser, page } = await launch();
  try {
    const original = await planningBoxes(page);
    const drag = await pickUp(page, card(MOVER_ID));
    await moveGhostTo(page, drag, center(original[1]).x, center(original[1]).y);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, true, true]);

    // Consumed by the next tasks.move.
    await page.evaluate(() => {
      (window as unknown as { __mockTaskMoveThrow: string }).__mockTaskMoveThrow = 'Working tree is dirty';
    });
    await page.mouse.up();

    // The rejection ran, and the card is back where it came from.
    await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Failed to move task: Working tree is dirty' }))
      .toBeVisible({ timeout: 3000 });
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 }).toEqual(PLANNING_IDS);
    await expect.poll(() => laneOrder(page, 'To Do'), { timeout: 3000 }).toContain(MOVER_ID);

    // And no trace of the gap: nothing parted, no slot card, no settle held,
    // no gap value in a card's style.
    await expect.poll(() => gapResidue(page), { timeout: 2500 }).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a move the workflow lock would refuse parts nothing, though the card is not locked', async () => {
  // Planning's first card is in a paused workflow: free to drag anywhere (the
  // lock holds a RUNNING workflow's card to its column), but a drag by hand
  // into To Do is refused. The board asks the lock as the ghost enters a
  // column, so a refused column parts nothing and shows no slot card.
  const { browser, page } = await launch({
    initScript: PAUSED_WORKFLOW_INIT,
    seedEdits: PAUSED_WORKFLOW_SEED,
    workflowStripOn: PAUSED_WORKFLOW_CARD_ID,
  });
  try {
    const todoFirst = await box(page, card(MOVER_ID));
    const drag = await pickUp(page, card(PAUSED_WORKFLOW_CARD_ID));
    const ghostHeight = (await box(page, OVERLAY)).height;

    // Over To Do's first card: To Do is the drop target (its highlight is the
    // positive signal that the drag-over, which asks for the gap, has run, since
    // a refusal cannot be polled for). A locked card could not get here at all.
    await moveGhostTo(page, drag, center(todoFirst).x, todoFirst.y + ghostHeight / 2);
    await expect(page.locator(`${TODO}.drop-highlight`)).toHaveCount(1, { timeout: 3000 });
    expect(await gapResidue(page)).toEqual([]);

    // The same card, over a column the lock allows, does part it. Without this
    // the seed could be what stops every gap.
    const executingList = await box(page, `${EXECUTING} [data-swimlane-task-list]`);
    await moveGhostTo(page, drag, executingList.x + executingList.width / 2, executingList.y + 80);
    await expect(page.locator(`${EXECUTING} [data-drop-slot][data-visible]`)).toHaveCount(1, { timeout: 3000 });
    expect(await gapResidue(page, 'To Do')).toEqual([]);

    // Back over To Do: Executing's gap closes and To Do parts nothing.
    await moveGhostTo(page, drag, center(todoFirst).x, todoFirst.y + ghostHeight / 2);
    await expect.poll(() => gapResidue(page), { timeout: 3000 }).toEqual([]);

    // Released there: the refusal says why, the card stays in Planning, and
    // still nothing is left parted.
    await page.mouse.up();
    await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Remove it from the workflow to move it to To Do.' }))
      .toBeVisible({ timeout: 3000 });
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 }).toEqual(PLANNING_IDS);
    await expect.poll(() => gapResidue(page), { timeout: 3000 }).toEqual([]);
  } finally {
    await browser.close();
  }
});

// A drop into a lane whose stored positions have gaps. The slot is an index into
// the lane's order, but a move writes its target as a RAW position (shifting the
// rows at or past it), so a bare index of 2 into a lane at 0, 5, 9 would put the
// card between the first and second card, one place early of where the gap showed
// it. The end slot is worse: an index of 3 is below the second card's position.
const GAPPED_DROPS = [
  {
    name: 'before the third card',
    ghostBelowLastCard: false,
    parted: [false, false, true],
    landed: [PLANNING_IDS[0], PLANNING_IDS[1], MOVER_ID, PLANNING_IDS[2]],
  },
  {
    name: 'past the last card',
    ghostBelowLastCard: true,
    parted: [false, false, false],
    landed: [PLANNING_IDS[0], PLANNING_IDS[1], PLANNING_IDS[2], MOVER_ID],
  },
];

for (const gappedDrop of GAPPED_DROPS) {
  test(`a drop ${gappedDrop.name} of a lane whose positions have gaps lands where the gap showed`, async () => {
    const { browser, page } = await launch({ seedEdits: GAPPED_PLANNING_SEED });
    try {
      const original = await planningBoxes(page);
      // The seed is what the case is about: the lane is not at 0, 1, 2.
      expect((await serverLaneTasks(page, 'Planning')).map((task) => task.position)).toEqual(GAPPED_PLANNING_POSITIONS);
      const drag = await pickUp(page, card(MOVER_ID));
      const ghostHeight = (await box(page, OVERLAY)).height;

      const lastCard = original[2];
      const ghostY = gappedDrop.ghostBelowLastCard
        ? lastCard.y + lastCard.height + 8 + ghostHeight / 2
        : center(lastCard).y;
      await moveGhostTo(page, drag, center(lastCard).x, ghostY);
      await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual(gappedDrop.parted);
      await expect(page.locator(`${PLANNING} [data-drop-slot][data-visible]`)).toHaveCount(1, { timeout: 3000 });

      await page.mouse.up();
      // Main's copy first (the move has been applied by then), then the renderer's
      // store and the drawn order, each after the move's reload has had its say.
      await expect.poll(() => serverLaneOrder(page, 'Planning'), { timeout: 3000 }).toEqual(gappedDrop.landed);
      await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 }).toEqual(gappedDrop.landed);
      await expect.poll(() => laneDomOrder(page, 'Planning'), { timeout: 3000 }).toEqual(gappedDrop.landed);
      await expect.poll(() => gapResidue(page), { timeout: 3000 }).toEqual([]);
      // Still so once the hold has lifted and nothing is left to settle.
      expect(await laneDomOrder(page, 'Planning')).toEqual(gappedDrop.landed);
      expect(await serverLaneOrder(page, 'Planning')).toEqual(gappedDrop.landed);
    } finally {
      await browser.close();
    }
  });
}

test('a card dragged out of Done to the end of a lane whose positions have gaps lands last', async () => {
  // The restore's IPC is held, so the card's optimistic placement is on screen
  // by itself: a lane at 0, 5, 9 would sort a card written at 3 second.
  const { browser, page } = await launch({ seedEdits: GAPPED_PLANNING_SEED });
  try {
    const original = await planningBoxes(page);
    const archivedCard = `[data-swimlane-name="Done"] [data-task-id="${ARCHIVED_ID}"]`;
    await page.locator(archivedCard).waitFor({ state: 'visible', timeout: 10000 });
    const drag = await pickUp(page, archivedCard);
    const ghostHeight = (await box(page, OVERLAY)).height;

    const lastCard = original[2];
    await moveGhostTo(page, drag, center(lastCard).x, lastCard.y + lastCard.height + 8 + ghostHeight / 2);
    await expect.poll(() => shifted(page), { timeout: 3000 }).toEqual([false, false, false]);
    await expect(page.locator(`${PLANNING} [data-drop-slot][data-visible]`)).toHaveCount(1, { timeout: 3000 });

    const landed = [...PLANNING_IDS, ARCHIVED_ID];
    await page.evaluate(() => {
      (window as unknown as { __mockTaskUnarchiveDeferred: boolean }).__mockTaskUnarchiveDeferred = true;
    });
    await page.mouse.up();
    // Held in flight: the card is in the lane, and last, on the renderer's own say-so.
    await expect.poll(() => laneOrder(page, 'Planning'), { timeout: 3000 }).toEqual(landed);
    await expect.poll(() => laneDomOrder(page, 'Planning'), { timeout: 3000 }).toEqual(landed);

    // Then main's answer: the same order.
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __mockTaskUnarchiveResolve?: unknown }).__mockTaskUnarchiveResolve), { timeout: 3000 })
      .toBe('function');
    await page.evaluate(() => {
      (window as unknown as { __mockTaskUnarchiveResolve: () => void }).__mockTaskUnarchiveResolve();
    });
    await expect.poll(() => serverLaneOrder(page, 'Planning'), { timeout: 3000 }).toEqual(landed);
    await expect.poll(() => laneDomOrder(page, 'Planning'), { timeout: 3000 }).toEqual(landed);
    await expect.poll(() => gapResidue(page), { timeout: 3000 }).toEqual([]);
  } finally {
    await browser.close();
  }
});
