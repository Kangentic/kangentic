/**
 * Tooltip, the one tooltip (src/renderer/components/Tooltip.tsx), through its live adopters:
 * the settings InfoTip (a label that wraps), the task window's header (icon buttons with keys, a
 * disabled pill with its reason), and the Edit automation dialog's wildcard examples (the rich
 * shape).
 *
 * Timing is read IN the page, never from the test's own clock: a MutationObserver stamps each
 * tip's mount and unmount with `performance.now()`, and capture listeners stamp the pointer and
 * focus events that start them. A negative window ("nothing opened") waits on the page clock
 * against the component's own constants, so the spec runs on the numbers the component uses.
 *
 * Each test owns its page (mode: 'parallel').
 */
import { test, expect, chromium, type Browser, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, launchPage, createProject } from './helpers';
import { TOOLTIP_DWELL_MS, TOOLTIP_WARM_MS, TIP_OFFSET, VIEWPORT_PADDING } from '../../src/renderer/utils/tooltip';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-hover-tip';
const TASK_ID = 'task-hover-tip';
const SETTINGS_PANEL = '[data-testid="settings-panel"]';
const TIP = '[data-tooltip]';

/** A project with one Code Review task that has no session, so its pill is disabled. */
const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Hover Tip', path: '/mock/hover-tip',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-hover-tip-' + index;
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
    });
    state.tasks.push({
      id: '${TASK_ID}', title: 'Hover tip task', description: '',
      swimlane_id: laneIds['Code Review'], position: 0, agent: null, session_id: null,
      worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
      base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchWithTask(configOverrides?: Record<string, unknown>): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  if (configOverrides) {
    await page.addInitScript((overrides) => {
      (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = overrides;
    }, configOverrides);
  }
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  await installTipLog(page);
  return { browser, page };
}

/** The task window, opened through the store so the pointer stays where the test left it. */
async function openTaskDetail(page: Page): Promise<Locator> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setDetailTaskId: (taskId: string) => void } } };
    }).__zustandStores;
    stores?.session.getState().setDetailTaskId(id);
  }, TASK_ID);
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
    const isTip = (node: Node): boolean => node instanceof Element && node.hasAttribute('data-tooltip');
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

/** Let a cold tip's entrance (a scale from 0.96) finish, so its box is its final size. */
async function settleTip(tip: Locator): Promise<void> {
  await tip.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

/** Park the pointer on dead space, away from every trigger. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(960, 1060);
}

async function openSettingsTab(page: Page, tabId: string): Promise<Locator> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator(`[data-testid="settings-tab-${tabId}"]`).click();
  const panel = page.locator(SETTINGS_PANEL);
  await expect(panel).toBeVisible();
  return panel;
}

async function launchOnSettingsInfoTips(): Promise<{ browser: Browser; page: Page; infoTips: Locator }> {
  const { browser, page } = await launchPage();
  await createProject(page, `Hover tip ${Date.now()}`);
  await installTipLog(page);
  const panel = await openSettingsTab(page, 'task');
  const infoTips = panel.getByRole('button', { name: /^About / });
  await expect(infoTips.nth(1)).toBeVisible();
  await parkPointer(page);
  return { browser, page, infoTips };
}

test('a label tip opens after the dwell, wraps its prose, and opens no overlay', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips();
  try {
    const trigger = infoTips.first();
    const layersBefore = await page.locator('[data-dismissable-layer]').count();
    await clearTipLog(page);
    await trigger.hover();
    const tip = page.locator(TIP);
    await expect(tip).toBeVisible();
    expect(delayBeforeOpen(await readTipLog(page), 'over')).toBeGreaterThanOrEqual(TOOLTIP_DWELL_MS - 5);

    await expect(tip).toHaveAttribute('role', 'tooltip');
    await expect(tip).toHaveAttribute('data-shape', 'label');
    expect(await tip.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    await settleTip(tip);
    const box = await tip.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(281);
    // The tip says what the button's description says, and the button keeps its own name.
    const description = (await tip.textContent()) ?? '';
    await expect(trigger).toHaveAccessibleDescription(description);
    await expect(trigger).toHaveAccessibleName(/^About /);
    expect(await page.locator('[data-dismissable-layer]').count()).toBe(layersBefore);

    await parkPointer(page);
    await expect(tip).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('Tab focus opens a tip at once, and a script focus after a key and a mouse click do not', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips();
  try {
    const trigger = infoTips.first();
    const tip = page.locator(TIP);

    // A script's focus right after a key is `:focus-visible` to Chromium, which is how a confirm
    // focusing its close button used to pop that button's tip and take the next Escape. Only a
    // Tab move opens one.
    await clearTipLog(page);
    await page.keyboard.press('Shift');
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await waitPageMs(page, 150);
    expect((await readTipLog(page)).filter((event) => event.type === 'open')).toEqual([]);

    // Step off with Shift+Tab and back with Tab: that last move is Tab's own.
    await page.keyboard.press('Shift+Tab');
    await expect(trigger).not.toBeFocused();
    await clearTipLog(page);
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await expect(tip).toBeVisible();
    expect(delayBeforeOpen(await readTipLog(page), 'focus')).toBeLessThan(150);
    await trigger.blur();
    await expect(tip).toHaveCount(0);
    // The blur started the warm window, in which the click's own pointer move would open a tip
    // at once. Outside it, only the focus the click gives could open one, and it must not.
    await waitPageMs(page, TOOLTIP_WARM_MS + 50);

    const other = infoTips.nth(1);
    await clearTipLog(page);
    await other.click();
    await waitPageMs(page, TOOLTIP_DWELL_MS + 200);
    expect((await readTipLog(page)).filter((event) => event.type === 'open')).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('Escape closes only the tip, and the next Escape closes the settings panel', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips();
  try {
    await infoTips.first().hover();
    const tip = page.locator(TIP);
    await expect(tip).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    const panel = page.locator(SETTINGS_PANEL);
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveClass(/overlay-panel-out/);

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('Escape closes only the tip in a task window, and the next Escape closes the window', async () => {
  const { browser, page } = await launchWithTask();
  try {
    const dialog = await openTaskDetail(page);
    await page.getByTestId('task-detail-close').hover();
    const tip = page.locator(TIP);
    await expect(tip).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await parkPointer(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('an Escape pressed the moment a tip mounts closes the tip and never reaches the window', async () => {
  const { browser, page } = await launchWithTask();
  try {
    const dialog = await openTaskDetail(page);
    // React's scheduler runs a commit's passive effects in the same macrotask unless the commit
    // used up its 5ms slice, which a loaded CI runner does and a quiet machine does not. Inserting
    // the tip is made to spend that slice here, so the scheduler yields after the commit and a
    // MutationObserver callback (a microtask) runs after the tip's layout effects but before its
    // passive ones. The Escape listener has to be attached by then, or the press lands between a
    // visible tip and its listener and closes the window as well. Playwright's own press cannot
    // aim at that gap, so the key is fired in page.
    await page.evaluate((tipSelector) => {
      const win = window as unknown as { __escapesReachingDocument: number; __escapeDispatchedAtMount: boolean };
      win.__escapesReachingDocument = 0;
      win.__escapeDispatchedAtMount = false;
      const spendSlice = (node: Node): void => {
        if (!(node instanceof Element) || !node.hasAttribute('data-tooltip')) return;
        const until = performance.now() + 12;
        while (performance.now() < until) { /* hold the commit past the scheduler's slice */ }
      };
      const insertChild = document.body.appendChild.bind(document.body);
      const insertBefore = document.body.insertBefore.bind(document.body);
      document.body.appendChild = <T extends Node>(node: T): T => {
        const inserted = insertChild(node);
        spendSlice(node);
        return inserted;
      };
      document.body.insertBefore = <T extends Node>(node: T, reference: Node | null): T => {
        const inserted = insertBefore(node, reference);
        spendSlice(node);
        return inserted;
      };
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') win.__escapesReachingDocument += 1;
      });
      const observer = new MutationObserver(() => {
        if (document.querySelector(tipSelector) === null) return;
        observer.disconnect();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        win.__escapeDispatchedAtMount = true;
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, TIP);

    await page.getByTestId('task-detail-close').hover();
    // Without this the assertions below hold before the tip has opened, and the test proves nothing.
    await page.waitForFunction(() => (window as unknown as { __escapeDispatchedAtMount: boolean }).__escapeDispatchedAtMount);
    await expect(page.locator(TIP)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __escapesReachingDocument: number }).__escapesReachingDocument)).toBe(0);
  } finally {
    await browser.close();
  }
});

test('a tip at the window edge is clamped inside it, and its keys follow the user binding', async () => {
  const { browser, page } = await launchWithTask({ hotkeyOverrides: { 'panel.close': 'Mod+Alt+K' } });
  try {
    await openTaskDetail(page);
    await page.getByTestId('task-detail-maximize').click();
    const close = page.getByTestId('task-detail-close');
    await close.hover();
    const tip = page.locator(TIP);
    await expect(tip).toBeVisible();
    await settleTip(tip);

    const viewport = page.viewportSize();
    const tipBox = await tip.boundingBox();
    const closeBox = await close.boundingBox();
    if (!viewport || !tipBox || !closeBox) throw new Error('no geometry');
    // The close button sits at the right edge, so a centred tip would cross it.
    expect(Math.abs(tipBox.x + tipBox.width - (viewport.width - VIEWPORT_PADDING))).toBeLessThanOrEqual(1);
    const roomAbove = closeBox.y - TIP_OFFSET - tipBox.height >= VIEWPORT_PADDING;
    await expect(tip).toHaveAttribute('data-side', roomAbove ? 'above' : 'below');

    const chips = await tip.locator('kbd').allTextContents();
    expect(chips[chips.length - 1]).toBe('K');
    const joined = chips[0] === '⌘' ? chips.join('') : chips.join('+');
    await expect(close).toHaveAccessibleName('Close');
    await expect(close).toHaveAccessibleDescription(joined);
  } finally {
    await browser.close();
  }
});

test('the rich shape draws a header band over its body', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `Hover tip rich ${Date.now()}`);
    const column = page.locator('[data-swimlane-name="Executing"]');
    await column.locator('text=Executing').click();
    const manager = page.locator('[data-testid="board-manager-dialog"]');
    await expect(manager).toBeVisible({ timeout: 3000 });
    await manager.locator('[data-testid="column-automation-add"][data-trigger="turn_end"]').click();
    await page.locator('[data-testid="column-automation-picker-type"][data-type="notify"]').click();
    const info = page.locator('[data-testid="edit-automation-wildcard-info"]');
    await expect(info).toBeVisible();

    await info.hover();
    const tip = page.locator('[data-testid="edit-automation-wildcard-tip"]');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute('data-shape', 'rich');
    await expect(tip.locator('[data-tooltip-part="header"]')).toHaveText('Wildcard examples');
    await expect(tip.locator('[data-tooltip-part="body"] code')).toHaveCount(4);
    await expect(info).toHaveAccessibleName('Wildcard examples');
    await expect(info).toHaveAccessibleDescription(/^Wildcard examples\. Ready for review: exactly this line/);
  } finally {
    await browser.close();
  }
});

test('the next tip opens at once while one shows, and waits its dwell again after the warm window', async () => {
  const { browser, page } = await launchWithTask();
  try {
    await openTaskDetail(page);
    const first = page.getByTestId('branch-pill');
    const second = page.getByTestId('conversation-pill');
    const tip = page.locator(TIP);

    await first.hover();
    await expect(tip).toBeVisible();
    await clearTipLog(page);
    await second.hover();
    await expect(tip).toHaveText('No conversation history for this task yet');
    expect(delayBeforeOpen(await readTipLog(page), 'over')).toBeLessThan(150);

    await parkPointer(page);
    await expect(tip).toHaveCount(0);
    await waitPageMs(page, TOOLTIP_WARM_MS + 50);
    await clearTipLog(page);
    await first.hover();
    await expect(tip).toBeVisible();
    expect(delayBeforeOpen(await readTipLog(page), 'over')).toBeGreaterThanOrEqual(TOOLTIP_DWELL_MS - 5);
  } finally {
    await browser.close();
  }
});

test('a press closes the tip and keeps it shut until the pointer leaves', async () => {
  const { browser, page, infoTips } = await launchOnSettingsInfoTips();
  try {
    const trigger = infoTips.first();
    await trigger.hover();
    const tip = page.locator(TIP);
    await expect(tip).toBeVisible();

    await page.mouse.down();
    await expect(tip).toHaveCount(0);
    await page.mouse.up();
    // A move over the trigger is what arms the dwell, so the pointer moves on the trigger after
    // the press and the dwell is given its full time to open the tip.
    const box = await trigger.boundingBox();
    if (!box) throw new Error('no trigger geometry');
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    await clearTipLog(page);
    await page.mouse.move(centerX + 1, centerY);
    await page.mouse.move(centerX - 1, centerY);
    await waitPageMs(page, TOOLTIP_DWELL_MS + 200);
    expect((await readTipLog(page)).filter((event) => event.type === 'open')).toEqual([]);

    // Leaving ends the press, so the next hover opens the tip again.
    await parkPointer(page);
    await trigger.hover();
    await expect(tip).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a disabled control still shows why it is off', async () => {
  const { browser, page } = await launchWithTask();
  try {
    await openTaskDetail(page);
    const pill = page.getByTestId('conversation-pill');
    await expect(pill).toBeDisabled();
    await pill.hover();
    const tip = page.locator(TIP);
    await expect(tip).toHaveText('No conversation history for this task yet');
    await expect(pill).toHaveAccessibleName('View conversation');
    await expect(pill).toHaveAccessibleDescription('No conversation history for this task yet');
  } finally {
    await browser.close();
  }
});

test('a trigger that appears under a resting pointer opens nothing, so Escape reaches its window', async () => {
  const { browser, page } = await launchWithTask();
  try {
    // Where the window's close button lands, measured once with the window open.
    const dialog = await openTaskDetail(page);
    const closeBox = await page.getByTestId('task-detail-close').boundingBox();
    if (!closeBox) throw new Error('no close button');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 3000 });

    // Rest the pointer there with the window gone, then bring the window back under it.
    await page.mouse.move(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
    await openTaskDetail(page);
    // The pointer really rests on the close button, or the negative wait below proves nothing.
    const close = page.getByTestId('task-detail-close');
    await expect.poll(() => close.evaluate((element) => element.matches(':hover'))).toBe(true);
    await clearTipLog(page);
    await waitPageMs(page, TOOLTIP_DWELL_MS + 200);
    expect((await readTipLog(page)).filter((event) => event.type === 'open')).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});
