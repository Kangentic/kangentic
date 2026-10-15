/**
 * HoverTip behaviour that tests/ui/hover-tip.spec.ts leaves open: the Escape exceptions, nested
 * triggers, the block a keyboard click leaves behind, a tip that is held shut and then not, every
 * way an open tip closes, a live rebind, pointers that cannot hover, an unmount while open, and
 * the two pills that must stay a plain span under a tip.
 *
 * It reads time the way hover-tip.spec.ts does. A MutationObserver stamps each tip's mount and
 * unmount with `performance.now()`, capture listeners stamp the pointer and focus events that
 * start one, and a window in which nothing may happen waits on the PAGE clock against the
 * component's own constants. A negative assertion has no condition to poll, so each one pins a
 * positive control in the same page that proves the trigger can show a tip.
 *
 * Each test owns its page (mode: 'parallel').
 */
import { test, expect, chromium, type Browser, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, launchPage, createProject, launchWithTransientTerminal, openTransientCommandTerminal } from './helpers';
import { HOVER_TIP_DWELL_MS, HOVER_TIP_WARM_MS } from '../../src/renderer/utils/hover-tip';
import { getKeybinding } from '../../src/shared/keybindings';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-hover-tip-behaviour';
const TIP_TASK_ID = 'task-tip-plain';
const BLOCKED_TASK_ID = 'task-tip-pr-blocked';
const MERGED_TASK_ID = 'task-tip-pr-merged';
const SETTINGS_PANEL = '[data-testid="settings-panel"]';
const TIP = '[data-hover-tip]';

/**
 * A project with a plain Code Review task (no session, so its window opens on the header) and two
 * linked PRs in Testing: one open and blocked (its state badge has a caveat) and one merged (its
 * badge has none).
 */
const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Hover Tip Behaviour', path: '/mock/hover-tip-behaviour',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-hover-tip-behaviour-' + index;
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });
    function seedTask(id, title, laneName, position, extra) {
      state.tasks.push(Object.assign({
        id: id, title: title, description: '',
        swimlane_id: laneIds[laneName], position: position, agent: 'claude', session_id: null,
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: 'main', archived_at: null, created_at: timestamp, updated_at: timestamp,
      }, extra));
    }
    seedTask('${TIP_TASK_ID}', 'Plain tip task', 'Code Review', 0, {});
    seedTask('${BLOCKED_TASK_ID}', 'Blocked PR task', 'Testing', 0, {
      branch_name: 'feature/pr-302', pr_number: 302, pr_url: 'https://github.com/owner/repo/pull/302',
      pr_state: 'open', pr_merge_readiness: 'blocked',
    });
    seedTask('${MERGED_TASK_ID}', 'Merged PR task', 'Testing', 1, {
      branch_name: 'feature/pr-305', pr_number: 305, pr_url: 'https://github.com/owner/repo/pull/305',
      pr_state: 'merged', pr_merge_readiness: null,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

interface LaunchOptions {
  configOverrides?: Record<string, unknown>;
  /** Runs after the mock is injected and before the app loads. */
  beforeLoad?: (page: Page) => Promise<void>;
}

async function launchSeeded(options: LaunchOptions = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  if (options.configOverrides) {
    await page.addInitScript((overrides) => {
      (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = overrides;
    }, options.configOverrides);
  }
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);
  if (options.beforeLoad) await options.beforeLoad(page);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Testing"]').waitFor({ state: 'visible', timeout: 10000 });
  await installTipLog(page);
  return { browser, page };
}

/** The task window, opened through the store so the pointer stays where the test left it. */
async function openTaskDetail(page: Page): Promise<Locator> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setDetailTaskId: (taskId: string | null) => void } } };
    }).__zustandStores;
    stores?.session.getState().setDetailTaskId(id);
  }, TIP_TASK_ID);
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

interface TipLogEvent {
  type: 'over' | 'focus' | 'open' | 'close';
  at: number;
}

/** Stamp tip mounts and unmounts, and the pointer and focus events that start them. */
async function installTipLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const events: TipLogEvent[] = [];
    (window as unknown as { __tipLog: TipLogEvent[] }).__tipLog = events;
    const isTip = (node: Node): boolean => node instanceof Element && node.hasAttribute('data-hover-tip');
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (isTip(node)) events.push({ type: 'open', at: performance.now() });
        for (const node of record.removedNodes) if (isTip(node)) events.push({ type: 'close', at: performance.now() });
      }
    }).observe(document.body, { childList: true });
    document.addEventListener('pointerover', () => events.push({ type: 'over', at: performance.now() }), true);
    document.addEventListener('focusin', () => events.push({ type: 'focus', at: performance.now() }), true);
  });
}

async function readTipLog(page: Page): Promise<TipLogEvent[]> {
  return page.evaluate(() => (window as unknown as { __tipLog: TipLogEvent[] }).__tipLog.slice());
}

async function clearTipLog(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __tipLog: TipLogEvent[] }).__tipLog.length = 0; });
}

/** How long after the last `cause` event before it the first tip opened. */
function delayBeforeOpen(events: TipLogEvent[], cause: 'over' | 'focus'): number {
  const openIndex = events.findIndex((event) => event.type === 'open');
  if (openIndex < 0) throw new Error(`no tip opened: ${JSON.stringify(events)}`);
  const causes = events.slice(0, openIndex).filter((event) => event.type === cause);
  if (causes.length === 0) throw new Error(`no ${cause} before the tip opened: ${JSON.stringify(events)}`);
  return events[openIndex].at - causes[causes.length - 1].at;
}

/** Wait on the PAGE's clock, for a window in which something must not happen. */
async function waitPageMs(page: Page, milliseconds: number): Promise<void> {
  const until = await page.evaluate((span) => performance.now() + span, milliseconds);
  await page.waitForFunction((deadline) => performance.now() >= deadline, until);
}

/** Fail unless no tip mounted since the log was last cleared. */
async function expectNoTipOpened(page: Page): Promise<void> {
  expect((await readTipLog(page)).filter((event) => event.type === 'open')).toEqual([]);
}

/** Park the pointer on dead space, away from every trigger. */
/**
 * Focus `trigger` the way a keyboard user does, which is the only focus that opens a tip: step
 * off with Shift+Tab and back with Tab, so the last move is Tab's own. A script `focus()` opens
 * nothing, even right after a key.
 */
async function focusByTab(page: Page, trigger: Locator): Promise<void> {
  await trigger.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();
}

async function parkPointer(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  await page.mouse.move(viewport.width / 2, viewport.height - 20);
}

async function openSettingsTab(page: Page, tabId: string): Promise<Locator> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator(`[data-testid="settings-tab-${tabId}"]`).click();
  const panel = page.locator(SETTINGS_PANEL);
  await expect(panel).toBeVisible();
  return panel;
}

/** A project open on a settings tab full of `About ...` info buttons, each a label tip. */
async function launchOnSettingsInfoTips(tabId: string): Promise<{ browser: Browser; page: Page; infoTips: Locator }> {
  const { browser, page } = await launchPage();
  await createProject(page, `Hover tip behaviour ${Date.now()}`);
  await installTipLog(page);
  const panel = await openSettingsTab(page, tabId);
  const infoTips = panel.getByRole('button', { name: /^About / });
  await expect(infoTips.nth(1)).toBeVisible();
  await parkPointer(page);
  return { browser, page, infoTips };
}

/**
 * Count Escape keydowns that reach `document` in the CAPTURE phase. The capture phase on purpose:
 * an open tip stops the key at its `window` capture listener, which runs first, so this spy is
 * reached exactly when the tip did NOT stop the key. A bubble-phase spy cannot tell the cases
 * apart, because xterm and the rebind box's React handler both stop the key themselves before it
 * bubbles to `document`.
 */
async function spyOnEscape(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = { seen: 0 };
    (window as unknown as { __escapeProbe: { seen: number } }).__escapeProbe = probe;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') probe.seen += 1;
    }, true);
  });
}

async function escapesSeen(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __escapeProbe: { seen: number } }).__escapeProbe.seen);
}

test('Escape closes a tip but keeps going to a focused terminal', async () => {
  const sessionId = 'sess-tip-terminal';
  const { browser, page } = await launchWithTransientTerminal({ projectId: 'proj-tip-terminal', projectName: 'Tip Terminal', sessionId });
  try {
    const versionPill = page.getByTestId('status-bar-version-pill');
    const tip = page.locator(TIP);
    await spyOnEscape(page);

    // Control, BEFORE any terminal exists, so no late arrival can take focus back from a blur:
    // with focus on the page, the tip takes the key and nothing else sees it.
    expect(await page.evaluate(() => document.activeElement === document.body), 'focus is on the page').toBe(true);
    await versionPill.hover();
    await expect(tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    expect(await escapesSeen(page)).toBe(0);

    // With focus in a terminal the tip still closes, and the key reaches the terminal: Escape
    // is the agent's interrupt, and the user is typing into the terminal, not at the tip.
    await parkPointer(page);
    const commandWindow = await openTransientCommandTerminal(page, sessionId);
    const textarea = commandWindow.locator('.xterm-helper-textarea').first();
    await textarea.focus();
    await expect(textarea).toBeFocused();
    await versionPill.hover();
    await expect(tip).toBeVisible();
    expect(await textarea.evaluate((node) => document.activeElement === node), 'focus is in the terminal').toBe(true);
    const writesBefore = await page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    expect(await escapesSeen(page)).toBe(1);
    await expect.poll(() => page.evaluate((before) => (
      window.electronAPI.sessions.__writeCalls.slice(before).map((call: { payload: string }) => call.payload).join('')
    ), writesBefore)).toContain('\x1b');
  } finally {
    await browser.close();
  }
});

test('Escape closes a tip but keeps going to a hotkey rebind capture', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips('hotkeys');
  try {
    const panel = page.locator(SETTINGS_PANEL);
    const tip = page.locator(TIP);
    const captureBox = page.getByTestId('key-capture-box');
    await spyOnEscape(page);

    // Control: no capture, so the tip takes the key. The panel stays open, as the tip owns it.
    await infoTips.first().hover();
    await expect(tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    expect(await escapesSeen(page)).toBe(0);
    await expect(panel).toBeVisible();

    // Recording a hotkey: the tip closes and the key goes on to the capture box, which cancels.
    await page.getByTestId('key-capture-input').first().click();
    await expect(captureBox).toBeFocused();
    await parkPointer(page);
    await infoTips.nth(1).hover();
    await expect(tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    expect(await escapesSeen(page)).toBe(1);
    await expect(captureBox).toHaveCount(0);
    await expect(panel).toBeVisible();
  } finally {
    await browser.close();
  }
});

/** The PR link pill on a board card, and the state badge nested inside it. */
function prLinkOf(page: Page, taskId: string): { pill: Locator; badge: Locator } {
  const pill = page.locator(`[data-task-id="${taskId}"] [data-testid="task-card-pr-link"]`);
  return { pill, badge: pill.locator('[data-testid="pr-state-badge"]') };
}

test('a state badge with a caveat shows the caveat, and the link text beside it shows the link tip', async () => {
  const { browser, page } = await launchSeeded();
  try {
    const { pill, badge } = prLinkOf(page, BLOCKED_TASK_ID);
    const tip = page.locator(TIP);
    await expect(badge).toHaveText('blocked');
    const caveat = await badge.evaluate((node) => node.getAttribute('aria-description') ?? '');
    expect(caveat).toMatch(/^Merge blocked/);

    await badge.hover();
    await expect(tip).toHaveCount(1);
    await expect(tip).toHaveText(caveat);

    // Off the badge and onto the pill's own text: its tip takes over at once and there is still one.
    await clearTipLog(page);
    await pill.hover({ position: { x: 4, y: 4 } });
    await expect(tip).toHaveText('Open PR #302 in browser');
    await expect(tip).toHaveCount(1);
    expect(delayBeforeOpen(await readTipLog(page), 'over')).toBeLessThan(150);
  } finally {
    await browser.close();
  }
});

test('a state badge with no caveat lets the link tip show over it', async () => {
  const { browser, page } = await launchSeeded();
  try {
    const { pill, badge } = prLinkOf(page, MERGED_TASK_ID);
    const tip = page.locator(TIP);
    await expect(badge).toHaveText('merged');
    // Nothing to say, so the badge claims no tip of its own.
    expect(await badge.evaluate((node) => node.getAttribute('aria-description'))).toBeNull();

    await badge.hover();
    await expect(tip).toHaveText('Open PR #305 in browser');
    await expect(tip).toHaveCount(1);

    // Onto the pill's text: the same tip, still one.
    await pill.hover({ position: { x: 4, y: 4 } });
    await expect(tip).toHaveText('Open PR #305 in browser');
    await expect(tip).toHaveCount(1);
  } finally {
    await browser.close();
  }
});

test('a keyboard click made with the pointer elsewhere does not keep the next hover shut', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips('hotkeys');
  try {
    const trigger = infoTips.first();
    const tip = page.locator(TIP);

    // Tab focus opens the tip at once. Enter is the trigger's click.
    await focusByTab(page, trigger);
    await expect(tip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(tip).toHaveCount(0);

    // The pointer was parked the whole time. Now it arrives, and the earlier click must not matter.
    await clearTipLog(page);
    await trigger.hover();
    await expect(tip).toBeVisible();
    expect(delayBeforeOpen(await readTipLog(page), 'over')).toBeGreaterThanOrEqual(HOVER_TIP_DWELL_MS - 5);
  } finally {
    await browser.close();
  }
});

// A tip keyboard focus opened is held open by the focus, so a pointer leave does not close it. The
// flag that records that has to go when the tip closes some other way (Escape here), or the NEXT
// tip, opened by a hover on the same still-focused trigger, would never close on pointer leave.
test('a tip closed by Escape with focus still on the trigger does not keep the next hover open', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips('hotkeys');
  try {
    const trigger = infoTips.first();
    const tip = page.locator(TIP);
    // Text inside the panel that nothing listens to, so leaving the trigger lands on no tip.
    const deadSpace = page.locator(SETTINGS_PANEL).getByRole('heading').first();

    // Tab focus opens the tip at once.
    await focusByTab(page, trigger);
    await expect(tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // The pointer now arrives on the focused trigger, and its hover tip opens.
    await trigger.hover();
    await expect(tip).toBeVisible();

    // Leaving closes it, focus or no focus: the Escape already ended the tip focus opened.
    await clearTipLog(page);
    await deadSpace.hover();
    await expect(tip).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // Closed for good, not a flicker that reopens: the dead space has no tip to claim the warm
    // window. Read after more than a dwell, so a late reopen is in the log.
    await waitPageMs(page, HOVER_TIP_DWELL_MS + 200);
    await expectNoTipOpened(page);
  } finally {
    await browser.close();
  }
});

test('a trigger whose menu is open shows no tip, and shows it again once the menu closes', async () => {
  const { browser, page } = await launchSeeded();
  try {
    const dialog = await openTaskDetail(page);
    const actions = dialog.getByRole('button', { name: 'Actions' });
    const tip = page.locator(TIP);
    await actions.click();
    await expect(actions).toHaveAttribute('aria-expanded', 'true');

    // The click that opened it blocks the tip until the pointer leaves, so leave and come back:
    // only the trigger's own `enabled={!open}` can hold the tip shut now.
    await parkPointer(page);
    await clearTipLog(page);
    await actions.hover();
    await expect.poll(() => actions.evaluate((node) => node.matches(':hover'))).toBe(true);
    await waitPageMs(page, HOVER_TIP_DWELL_MS + 200);
    await expectNoTipOpened(page);

    // Positive control: the same pointer on the same trigger shows its tip once the menu is gone.
    await page.keyboard.press('Escape');
    await expect(actions).toHaveAttribute('aria-expanded', 'false');
    await actions.hover({ position: { x: 3, y: 3 } });
    await expect(tip).toHaveText('Actions');
  } finally {
    await browser.close();
  }
});

/** Write one task's merge readiness through the board store, the way a PR refresh does. */
async function setMergeReadiness(page: Page, taskId: string, readiness: string): Promise<void> {
  await page.evaluate(([id, value]) => {
    interface BoardTask { id: string; pr_merge_readiness?: string | null }
    const stores = (window as unknown as {
      __zustandStores?: { board: { setState: (update: (state: { tasks: BoardTask[] }) => { tasks: BoardTask[] }) => void } };
    }).__zustandStores;
    stores?.board.setState((state) => ({
      tasks: state.tasks.map((task) => (task.id === id ? { ...task, pr_merge_readiness: value } : task)),
    }));
  }, [taskId, readiness]);
}

test('a tip that goes from shut to open under a resting pointer opens on the next move', async () => {
  const { browser, page } = await launchSeeded();
  try {
    const { badge } = prLinkOf(page, BLOCKED_TASK_ID);
    const tip = page.locator(TIP);
    await expect(badge).toHaveText('blocked');
    await badge.evaluate((node) => node.setAttribute('data-test-tag', 'same-node'));

    await badge.hover();
    await expect(tip).toHaveText(/^Merge blocked/);

    // A PR refresh finds no verdict: the badge has nothing to say and the tip goes with it.
    await setMergeReadiness(page, BLOCKED_TASK_ID, 'unknown');
    await expect(badge).toHaveText('open');
    await expect(tip).toHaveCount(0);

    // The verdict returns. The pointer has not moved, so nothing re-opens until it does.
    await setMergeReadiness(page, BLOCKED_TASK_ID, 'blocked');
    await expect(badge).toHaveText('blocked');
    await expect(badge).toHaveAttribute('aria-description', /^Merge blocked/);
    await clearTipLog(page);
    await waitPageMs(page, HOVER_TIP_DWELL_MS + 200);
    await expectNoTipOpened(page);
    const box = await badge.boundingBox();
    if (!box) throw new Error('no badge box');
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await expect(tip).toHaveText(/^Merge blocked/);

    // Nothing remounted, so the refs that decide this were the same ones all along.
    await expect(badge).toHaveAttribute('data-test-tag', 'same-node');
  } finally {
    await browser.close();
  }
});

/** The nearest ancestor of `trigger` that really scrolls, tagged so the test can drive it. */
async function tagScrollableAncestor(trigger: Locator): Promise<void> {
  const found = await trigger.evaluate((node) => {
    let ancestor: Element | null = node.parentElement;
    while (ancestor) {
      const overflowY = getComputedStyle(ancestor).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && ancestor.scrollHeight > ancestor.clientHeight + 40) {
        ancestor.setAttribute('data-test-scroller', 'trigger-holder');
        return true;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  });
  expect(found, 'the trigger sits in a scroller with room to scroll').toBe(true);
}

/**
 * Scroll the tagged holder by two pixels. Two, not a screenful: the trigger is a few pixels wide,
 * so it stays under a pointer resting on it, and the only thing that can close the tip is the
 * scroll listener. A larger scroll carries the trigger out from under the pointer, and the pointer
 * leave closes the tip first (and starts the warm window), so the test would pass without the
 * scroll listener at all.
 */
async function nudgeTriggerHolder(trigger: Locator): Promise<void> {
  await trigger.evaluate((node) => {
    const holder = node.closest('[data-test-scroller="trigger-holder"]');
    if (holder) holder.scrollTop += 2;
  });
}

test('a scroll of the trigger holder closes the tip and a scroll of anything else does not', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips('hotkeys');
  try {
    const tip = page.locator(TIP);
    await tagScrollableAncestor(infoTips.first());
    // A scroller that holds no trigger, in a corner the pointer is not in.
    await page.evaluate(() => {
      const unrelated = document.createElement('div');
      unrelated.setAttribute('data-test-scroller', 'unrelated');
      unrelated.style.cssText = 'position:fixed;left:4px;bottom:4px;width:80px;height:40px;overflow:auto;z-index:1';
      const filler = document.createElement('div');
      filler.style.height = '400px';
      unrelated.appendChild(filler);
      document.body.appendChild(unrelated);
      const probe = { seen: 0 };
      (window as unknown as { __unrelatedScrolls: { seen: number } }).__unrelatedScrolls = probe;
      window.addEventListener('scroll', (event) => {
        if (event.target === unrelated) probe.seen += 1;
      }, true);
    });

    await infoTips.first().hover();
    await expect(tip).toBeVisible();

    await page.evaluate(() => {
      const unrelated = document.querySelector('[data-test-scroller="unrelated"]');
      if (unrelated) unrelated.scrollTop = 120;
    });
    // The scroll event is real and delivered, and the tip, which has already seen it, stays.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __unrelatedScrolls: { seen: number } }).__unrelatedScrolls.seen)).toBeGreaterThan(0);
    // A negative assertion has no condition to poll: give the tip's own close a budget to land.
    await waitPageMs(page, 150);
    await expect(tip).toHaveCount(1);

    await nudgeTriggerHolder(infoTips.first());
    await expect(tip).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

/** Every way a tip closes cold. After any of them the next tip waits its full dwell again. */
interface ColdCloser {
  name: string;
  /** Open on keyboard focus instead of a hover. */
  byFocus?: boolean;
  close(page: Page, trigger: Locator): Promise<void>;
}

const COLD_CLOSERS: ColdCloser[] = [
  {
    name: 'Escape',
    close: async (page) => { await page.keyboard.press('Escape'); },
  },
  {
    name: 'a press of the trigger',
    close: async (page) => {
      await page.mouse.down();
      await page.mouse.up();
    },
  },
  {
    name: 'a keyboard click of the focused trigger',
    byFocus: true,
    close: async (page) => { await page.keyboard.press('Enter'); },
  },
  {
    name: 'a scroll of the trigger holder',
    close: async (_page, trigger) => {
      await tagScrollableAncestor(trigger);
      await nudgeTriggerHolder(trigger);
    },
  },
  {
    // Synthetic on purpose: a real viewport change can move the trigger out from under the
    // pointer, and then a pointer leave closes the tip and the test passes for the wrong reason.
    name: 'a window resize',
    close: async (page) => { await page.evaluate(() => window.dispatchEvent(new Event('resize'))); },
  },
  {
    name: 'the window losing focus',
    close: async (page) => { await page.evaluate(() => window.dispatchEvent(new Event('blur'))); },
  },
];

for (const closer of COLD_CLOSERS) {
  test(`${closer.name} closes the tip, and the next tip waits its full dwell`, async () => {
    const { browser, page, infoTips } = await launchOnSettingsInfoTips('hotkeys');
    try {
      const first = infoTips.first();
      const tip = page.locator(TIP);
      if (closer.byFocus) {
        await focusByTab(page, first);
      } else {
        await first.hover();
      }
      await expect(tip).toBeVisible();

      await closer.close(page, first);
      await expect(tip).toHaveCount(0);

      // Park first, so the next hover is a fresh enter and not the old trigger's resting pointer.
      await parkPointer(page);
      await clearTipLog(page);
      await infoTips.nth(1).hover();
      await expect(tip).toBeVisible();
      expect(delayBeforeOpen(await readTipLog(page), 'over')).toBeGreaterThanOrEqual(HOVER_TIP_DWELL_MS - 5);
    } finally {
      await browser.close();
    }
  });
}

/** The chips of the open tip, and the text a screen reader hears for the same combo. */
async function readKeyChips(tip: Locator): Promise<{ chips: string[]; spoken: string }> {
  const chips = await tip.locator('kbd').allTextContents();
  // macOS draws modifiers as glyphs with no separator; every other platform joins with a plus.
  return { chips, spoken: chips[0] === '⌘' || chips[0] === '⌃' || chips[0] === '⌥' || chips[0] === '⇧' ? chips.join('') : chips.join('+') };
}

test('the close button follows a live rebind, in its chips and in what a screen reader hears', async () => {
  const { browser, page } = await launchSeeded();
  try {
    const dialog = await openTaskDetail(page);
    const close = dialog.getByTestId('task-detail-close');
    const tip = page.locator(TIP);
    const defaultCombo = getKeybinding('panel.close')?.defaultCombo ?? '';
    const defaultKey = defaultCombo.split('+').pop() ?? '';
    await close.evaluate((node) => node.setAttribute('data-test-tag', 'same-node'));

    await close.hover();
    await expect(tip).toBeVisible();
    const before = await readKeyChips(tip);
    expect(before.chips[before.chips.length - 1]).toBe(defaultKey);
    await expect(close).toHaveAccessibleDescription(before.spoken);

    await parkPointer(page);
    await expect(tip).toHaveCount(0);
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config: { getState: () => { updateConfig: (partial: Record<string, unknown>) => Promise<unknown> } } };
      }).__zustandStores;
      return stores?.config.getState().updateConfig({ hotkeyOverrides: { 'panel.close': 'Mod+Alt+K' } });
    });

    await close.hover();
    await expect(tip).toBeVisible();
    const after = await readKeyChips(tip);
    expect(after.chips[after.chips.length - 1]).toBe('K');
    expect(after.chips).not.toEqual(before.chips);
    await expect(close).toHaveAccessibleDescription(after.spoken);
    // The window never remounted: the same button simply read the new binding.
    await expect(close).toHaveAttribute('data-test-tag', 'same-node');
  } finally {
    await browser.close();
  }
});

// A button held while the pointer arrives is a drag crossing the control, not a hover.
test('a pointer that arrives with a mouse button held opens no tip, and does once it is released', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips('hotkeys');
  try {
    const trigger = infoTips.first();
    const tip = page.locator(TIP);
    // Press on text inside the panel that nothing listens to, then drag across the trigger.
    const heading = page.locator(SETTINGS_PANEL).getByRole('heading').first();
    await heading.hover();
    await page.mouse.down();
    await clearTipLog(page);
    await trigger.hover();
    await expect.poll(() => trigger.evaluate((node) => node.matches(':hover'))).toBe(true);
    await waitPageMs(page, HOVER_TIP_DWELL_MS + 200);
    await expectNoTipOpened(page);

    // Released over the trigger, the next move is an ordinary hover and the tip opens.
    await page.mouse.up();
    const box = await trigger.boundingBox();
    if (!box) throw new Error('no trigger box');
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await expect(tip).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a touch pointer opens no tip, and a mouse pointer on the same trigger does', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips('hotkeys');
  try {
    const trigger = infoTips.first();
    const tip = page.locator(TIP);
    const arriveAs = (pointerType: 'touch' | 'mouse') => trigger.evaluate((node, type) => {
      const init = { bubbles: true, cancelable: true, composed: true, pointerType: type, pointerId: 7, isPrimary: true, buttons: 0 };
      node.dispatchEvent(new PointerEvent('pointerover', init));
      node.dispatchEvent(new PointerEvent('pointermove', init));
    }, pointerType);

    await clearTipLog(page);
    await arriveAs('touch');
    await waitPageMs(page, HOVER_TIP_DWELL_MS + 200);
    await expectNoTipOpened(page);

    await arriveAs('mouse');
    await expect(tip).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a tip open when its window unmounts goes with it, and frees the shared slot', async () => {
  const { browser, page } = await launchSeeded();
  try {
    const dialog = await openTaskDetail(page);
    const tip = page.locator(TIP);
    await dialog.getByTestId('task-detail-close').hover();
    await expect(tip).toBeVisible();

    // Dropped through the window store, not a click, so no press or leave closes the tip first.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { window: { getState: () => { windows: Record<string, unknown>; closeWindow: (id: string) => void } } };
      }).__zustandStores;
      const windowState = stores?.window.getState();
      if (!windowState) throw new Error('no window store');
      for (const windowId of Object.keys(windowState.windows)) windowState.closeWindow(windowId);
    });
    await expect(dialog).toBeHidden({ timeout: 5000 });
    await expect(tip).toHaveCount(0);

    // The unmount closed warm, so wait that window out. A slot the dead tip still held would
    // keep every later tip warm for good.
    await waitPageMs(page, HOVER_TIP_WARM_MS + 50);
    await clearTipLog(page);
    await page.getByTestId('status-bar-version-pill').hover();
    await expect(tip).toBeVisible();
    expect(delayBeforeOpen(await readTipLog(page), 'over')).toBeGreaterThanOrEqual(HOVER_TIP_DWELL_MS - 5);
  } finally {
    await browser.close();
  }
});

/** The version pill's own tag and cursor, read from the element the user would click. */
async function readPill(pill: Locator): Promise<{ tagName: string; cursor: string }> {
  return pill.evaluate((node) => ({ tagName: node.tagName, cursor: getComputedStyle(node).cursor }));
}

test('the version pill is a button with a pointer cursor while the build has release notes', async () => {
  const { browser, page } = await launchPage();
  try {
    const pill = page.getByTestId('status-bar-version-pill');
    await expect(pill).toBeVisible();
    expect(await readPill(pill)).toEqual({ tagName: 'BUTTON', cursor: 'pointer' });
  } finally {
    await browser.close();
  }
});

test('the version pill stays a plain span, with no tip, when the build has no release notes', async () => {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => {
      // The notes are inlined at build time (lib/baked-release-notes.ts), so a build without
      // them is one whose module is empty.
      await target.route(/RELEASE_NOTES\.md\?.*raw/, (route) => route.fulfill({
        contentType: 'text/javascript',
        body: 'export default "";',
      }));
    },
  });
  try {
    const pill = page.getByTestId('status-bar-version-pill');
    await expect(pill).toBeVisible();
    const { tagName, cursor } = await readPill(pill);
    expect(tagName).toBe('SPAN');
    expect(cursor).not.toBe('pointer');
    await expect(pill).toHaveAccessibleDescription('');
  } finally {
    await browser.close();
  }
});

const MONITOR_PROJECT_ID = 'proj-tip-monitor';

/** One finished session, whose activity line is "Finished ...". */
const MONITOR_PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${MONITOR_PROJECT_ID}', name: 'Tip Monitor', path: '/mock/tip-monitor',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      state.swimlanes.push(Object.assign({}, lane, { id: 'lane-tip-monitor-' + index, position: index, created_at: timestamp }));
    });
    state.tasks.push({
      id: 'task-tip-monitor', title: 'Finished work', description: '', display_id: 11,
      swimlane_id: 'lane-tip-monitor-0', position: 0, labels: [], priority: 0, run_mode: 'agent',
      archived_at: null, created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${MONITOR_PROJECT_ID}' };
  });
  window.__mockMonitorRows = [
    {
      sessionId: 'sess-tip-monitor', projectId: '${MONITOR_PROJECT_ID}', projectName: 'Tip Monitor',
      taskId: 'task-tip-monitor', taskTitle: 'Finished work', outputPeek: [], displayId: 11,
      columnName: 'To Do', commandTerminalBranch: null, labels: [], prUrl: null, prNumber: null, prState: null,
      agentName: 'claude', modelDisplayName: 'Opus 5', effort: null, permissionMode: null,
      startedAt: '2026-01-01T00:00:00.000Z', exitedAt: '2026-01-01T00:30:00.000Z',
      status: 'exited', activity: null, activityReason: null,
      lastEvent: null, contextPercent: null, isolated: false, isCommandTerminal: false
    }
  ];
`;

test('the Monitor card activity pill stays a plain span under its tip', async () => {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => { await target.addInitScript(MONITOR_PRE_CONFIG); },
  });
  try {
    await page.locator('[data-testid="agent-monitor-button"]').click();
    await page.locator('[data-testid="monitor-grid"]').waitFor({ state: 'visible', timeout: 10000 });
    const pill = page.locator('[data-testid="monitor-card-activity"]');
    await expect(pill).toHaveText(/^Finished/);
    expect((await readPill(pill)).tagName).toBe('SPAN');
    // The card around it is clickable, so the cursor is inherited and says nothing: Pill adds
    // its own `cursor-pointer` class only when it renders as a button.
    await expect(pill).not.toHaveClass(/cursor-pointer/);

    // It still has its tip: the whole line the pill cuts short.
    await installTipLog(page);
    await pill.hover();
    await expect(page.locator(TIP)).toHaveText((await pill.textContent()) ?? '');
  } finally {
    await browser.close();
  }
});
