/**
 * UI tests for a Command Terminal's Browser pane (parity with the task window's).
 *
 * The pane is NOT inside the Command Terminal window: `CommandTerminalBrowserHost`
 * keeps it mounted in a body portal and lays it over the empty slot the window
 * draws, so hiding the panel never unmounts the page. A DOM-presence check cannot
 * tell "survived" from "silently replaced by a new <webview>", so the identity
 * test reads the registered webContentsId and the unregister log instead (the
 * pattern from browser-pane-registration.spec.ts).
 *
 * Headless behaviour: <webview> is an unknown element here, so a guest is faked by
 * stubbing getWebContentsId/getURL on the element and dispatching 'dom-ready'.
 *
 * Each test owns its own context and page (state is never shared between tests),
 * so the file fans out across the UI workers.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-ct-browser';
const SLOT = 'slot-1';
const OWNER_KEY = `command-terminal::${PROJECT_ID}::${SLOT}`;
const PAGE_URL = 'http://localhost:5173/';
const GUEST_ID = 4343;

// Wide enough that the header never folds the Browser/Changes pills into the kebab.
const VIEWPORT = { width: 2560, height: 1440 };

const PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Command Browser Project',
      path: '/mock/command-browser',
      github_url: null,
      default_agent: 'claude',
      last_opened: timestamp,
      created_at: timestamp,
    });
    state.projectConfigs['/mock/command-browser'] = { browser: { enabled: true } };
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'lane-ctb-' + i, position: i, created_at: timestamp }));
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let sharedBrowser: Browser;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

let activeContext: BrowserContext | null = null;

test.afterEach(async () => {
  await activeContext?.close();
  activeContext = null;
});

/** A fresh page on the mock, with extra init-script source run after the mock loads. */
async function openFreshPage(extraInitScript = ''): Promise<Page> {
  activeContext = await sharedBrowser.newContext({ viewport: VIEWPORT });
  const page = await activeContext.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRECONFIG);
  if (extraInitScript) await page.addInitScript(extraInitScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  return page;
}

async function openPanel(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByTestId('command-terminal-window')).toBeVisible({ timeout: 10000 });
}

function seedUrl(page: Page): Promise<void> {
  return page.evaluate(({ ownerKey, url }) => {
    window.__mockBrowser?.seedTaskUrl(ownerKey, url);
  }, { ownerKey: OWNER_KEY, url: PAGE_URL });
}

/** Fake the guest attaching: stub the Electron-only methods and fire dom-ready. */
async function registerGuest(page: Page): Promise<void> {
  const webview = page.locator('[data-testid="browser-webview"]');
  await webview.waitFor({ state: 'attached', timeout: 10000 });
  await page.evaluate((webContentsId: number) => {
    const element = document.querySelector('[data-testid="browser-webview"]');
    if (!element) throw new Error('browser-webview element not found');
    const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
    stub.getWebContentsId = () => webContentsId;
    stub.getURL = () => 'http://localhost:5173/';
    element.dispatchEvent(new Event('dom-ready'));
  }, GUEST_ID);
  await expect.poll(() => page.evaluate((expectedId: number) =>
    (window.__mockBrowser?.getPaneCalls() ?? []).some((call) =>
      call.type === 'register' && call.input.webContentsId === expectedId), GUEST_ID),
  { timeout: 5000 }).toBe(true);
}

function unregisterCountForGuest(page: Page): Promise<number> {
  return page.evaluate((expectedId: number) =>
    (window.__mockBrowser?.getPaneCalls() ?? []).filter((call) =>
      call.type === 'unregister' && call.webContentsId === expectedId).length, GUEST_ID);
}

const hostedPane = (page: Page) =>
  page.locator(`[data-testid="command-terminal-browser-pane"][data-owner-key="${OWNER_KEY}"]`);

async function emitAgentOpen(page: Page): Promise<void> {
  await expect(page.getByTestId('command-terminal-window')).toHaveCount(0);
  await page.evaluate(({ projectId, ownerKey }) => {
    window.__mockBrowser?.emitPaneOpenRequest(projectId, ownerKey);
  }, { projectId: PROJECT_ID, ownerKey: OWNER_KEY });
}

test.describe('Command Terminal Browser pane', () => {
  test('the Globe pill opens a half-width slot with the hosted pane over it, exclusive with Changes', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    await openPanel(page);

    const slot = page.getByTestId('command-bar-browser-slot');
    // Converse first: nothing is open until the user asks.
    await expect(slot).toHaveCount(0);
    await expect(hostedPane(page)).toHaveCount(0);

    await page.getByTestId('command-bar-browser-toggle').click();
    await expect(slot).toBeVisible();
    await expect(page.locator(`[data-command-terminal-browser-slot="${OWNER_KEY}"]`)).toBeVisible();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });

    // The slot takes about half of the terminal row (seam 50/50 by default).
    await expect.poll(async () => {
      const slotBox = await slot.boundingBox();
      const rowBox = await slot.locator('xpath=..').boundingBox();
      if (!slotBox || !rowBox || rowBox.width === 0) return 0;
      return slotBox.width / rowBox.width;
    }, { timeout: 5000 }).toBeGreaterThan(0.4);
    const slotBox = await slot.boundingBox();
    const rowBox = await slot.locator('xpath=..').boundingBox();
    expect(slotBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(slotBox!.width / rowBox!.width).toBeLessThan(0.6);

    // The portaled pane is laid over the slot, within a few pixels.
    await expect.poll(async () => {
      const paneBox = await hostedPane(page).boundingBox();
      const currentSlot = await slot.boundingBox();
      if (!paneBox || !currentSlot) return false;
      return Math.abs(paneBox.x - currentSlot.x) < 6
        && Math.abs(paneBox.width - currentSlot.width) < 6
        && Math.abs(paneBox.y - currentSlot.y) < 6
        && Math.abs(paneBox.height - currentSlot.height) < 6;
    }, { timeout: 5000 }).toBe(true);

    const changesOpenCount = () => page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { session: { getState: () => { changesOpenTasks: Set<string> } } };
      }).__zustandStores;
      return stores.session.getState().changesOpenTasks.size;
    });

    // Changes opens: Browser closes (held or discarded, the slot goes either way).
    await page.getByTestId('command-bar-changes-toggle').click();
    await expect(slot).toHaveCount(0);
    expect(await changesOpenCount()).toBe(1);

    // And back: Browser opens, Changes closes.
    await page.getByTestId('command-bar-browser-toggle').click();
    await expect(slot).toBeVisible();
    expect(await changesOpenCount()).toBe(0);
  });

  test('hiding and reopening the panel keeps the same guest, and the pane stays mounted but hidden', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    await openPanel(page);
    await page.getByTestId('command-bar-browser-toggle').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await registerGuest(page);

    // Hide the whole panel. The window leaves the DOM; the pane must not.
    await page.keyboard.press('Control+Shift+P');
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
    await expect(hostedPane(page)).toHaveCount(1);
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'hidden', { timeout: 5000 });
    expect(await unregisterCountForGuest(page)).toBe(0);

    // Reopen: the same pane element shows again over a fresh slot.
    await openPanel(page);
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await expect(page.getByTestId('command-bar-browser-slot')).toBeVisible();

    const log = await page.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
    const registeredIds = new Set(
      log.filter((call) => call.type === 'register').map((call) => (call.type === 'register' ? call.input.webContentsId : -1)),
    );
    expect([...registeredIds]).toEqual([GUEST_ID]);
    // Scoped to this guest's id on purpose: StrictMode's throwaway first mount
    // unregisters `undefined`. What must never appear is an unregister for the live id.
    expect(await unregisterCountForGuest(page)).toBe(0);
    await expect(page.locator('[data-testid="browser-webview"]')).toHaveCount(1);
  });

  test('an agent open_pane leaves a hidden panel hidden, and the user opening it shows the pane', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    // A live terminal behind a hidden panel: what an agent's open_pane has to be
    // running from, since a terminal that is not running is refused in main.
    await openPanel(page);
    await page.keyboard.press('Control+Shift+P');
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });

    await emitAgentOpen(page);

    // The pane mounts, composited and out of sight, and the panel stays away.
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'hidden', { timeout: 5000 });
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(0);

    await openPanel(page);
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
  });

  test('the Running row globe follows a registered guest and goes away on Close browser', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    await openPanel(page);

    const runningGlobe = page.getByTestId('command-terminal-running-browser');
    const aliveDot = page.getByTestId('command-bar-browser-toggle-alive');
    await expect(page.getByTestId('command-terminal-running-row')).toBeVisible();
    // No page yet, no globe.
    await expect(runningGlobe).toHaveCount(0);
    await expect(aliveDot).toHaveCount(0);

    await page.getByTestId('command-bar-browser-toggle').click();
    await registerGuest(page);
    await expect(runningGlobe).toBeVisible({ timeout: 5000 });
    await expect(aliveDot).toBeVisible();

    // Close browser from the kebab discards the guest.
    await page.getByTestId('command-terminal-window').getByRole('button', { name: 'Actions' }).click();
    await page.getByTestId('command-bar-kebab-close-browser').click();
    await expect(runningGlobe).toHaveCount(0, { timeout: 5000 });
    await expect(aliveDot).toHaveCount(0);
    await expect(page.getByTestId('command-bar-browser-slot')).toHaveCount(0);
  });

  test('a branch switch keeps the same guest bound through the respawn', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    await openPanel(page);
    await page.getByTestId('command-bar-browser-toggle').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await registerGuest(page);

    const sessionIdOf = () => page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { session: { getState: () => { sessions: Array<{ id: string; transient?: boolean; status: string }> } } };
      }).__zustandStores;
      return stores.session.getState().sessions
        .filter((candidate) => candidate.transient && candidate.status === 'running')
        .map((candidate) => candidate.id).join(',');
    });
    const sessionBefore = await sessionIdOf();

    // Sample every frame through the switch, so the gap between the old session
    // dying and the new one arriving is observed rather than raced.
    await page.evaluate((guestId: number) => {
      type Sample = { webviews: number; panes: number; unregisters: number };
      const samples: Sample[] = [];
      const holder = window as unknown as { __respawnSamples: Sample[]; __respawnStop: boolean };
      holder.__respawnSamples = samples;
      holder.__respawnStop = false;
      const tick = (): void => {
        samples.push({
          webviews: document.querySelectorAll('[data-testid="browser-webview"]').length,
          panes: document.querySelectorAll('[data-testid="command-terminal-browser-pane"]').length,
          unregisters: (window.__mockBrowser?.getPaneCalls() ?? [])
            .filter((call) => call.type === 'unregister' && call.webContentsId === guestId).length,
        });
        if (!holder.__respawnStop) requestAnimationFrame(tick);
      };
      tick();
    }, GUEST_ID);

    await page.getByTestId('branch-picker-chip').click();
    const developButton = page.locator('button:has-text("develop")');
    await developButton.waitFor({ state: 'visible' });
    await developButton.click();

    await expect.poll(async () => {
      const current = await sessionIdOf();
      return current !== '' && current !== sessionBefore;
    }, { timeout: 10000 }).toBe(true);
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await page.evaluate(() => { (window as unknown as { __respawnStop: boolean }).__respawnStop = true; });

    const samples = await page.evaluate(() =>
      (window as unknown as { __respawnSamples: Array<{ webviews: number; panes: number; unregisters: number }> }).__respawnSamples);
    expect(samples.length).toBeGreaterThan(0);
    // One pane and one webview at every frame, and the guest never unregistered.
    expect(Math.min(...samples.map((sample) => sample.panes))).toBe(1);
    expect(Math.min(...samples.map((sample) => sample.webviews))).toBe(1);
    expect(Math.max(...samples.map((sample) => sample.webviews))).toBe(1);
    expect(Math.max(...samples.map((sample) => sample.unregisters))).toBe(0);

    // A re-register under the new session is fine; a different guest is not.
    const log = await page.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
    const registeredIds = new Set(
      log.filter((call) => call.type === 'register').map((call) => (call.type === 'register' ? call.input.webContentsId : -1)),
    );
    expect([...registeredIds]).toEqual([GUEST_ID]);
    expect(await unregisterCountForGuest(page)).toBe(0);
    await expect(page.locator('[data-testid="browser-webview"]')).toHaveCount(1);
  });

  test('Expand on another terminal hides the pane at opacity 0, and Restore shows it over its slot', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    await openPanel(page);
    await page.getByTestId('command-terminal-new').click();
    const firstWindow = page.locator('[data-testid="command-terminal-window"][data-command-slot="slot-1"]');
    const secondWindow = page.locator('[data-testid="command-terminal-window"][data-command-slot="slot-2"]');
    await expect(secondWindow).toBeVisible({ timeout: 10000 });

    await firstWindow.getByTestId('command-bar-browser-toggle').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await expect(hostedPane(page)).toHaveCSS('opacity', '1');

    await secondWindow.getByTestId('command-bar-expand').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'hidden', { timeout: 5000 });
    await expect(hostedPane(page)).toHaveCSS('opacity', '0');
    await expect(hostedPane(page)).toHaveCount(1);

    await secondWindow.getByTestId('command-bar-expand').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await expect(hostedPane(page)).toHaveCSS('opacity', '1');
    const slot = firstWindow.getByTestId('command-bar-browser-slot');
    await expect.poll(async () => {
      const paneBox = await hostedPane(page).boundingBox();
      const slotBox = await slot.boundingBox();
      if (!paneBox || !slotBox) return false;
      return Math.abs(paneBox.x - slotBox.x) < 6 && Math.abs(paneBox.y - slotBox.y) < 6
        && Math.abs(paneBox.width - slotBox.width) < 6 && Math.abs(paneBox.height - slotBox.height) < 6;
    }, { timeout: 5000 }).toBe(true);
  });

  test('a hidden pane takes no clicks, with the panel hidden or behind an Expand', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    await openPanel(page);
    await page.getByTestId('command-terminal-new').click();
    const firstWindow = page.locator('[data-testid="command-terminal-window"][data-command-slot="slot-1"]');
    const secondWindow = page.locator('[data-testid="command-terminal-window"][data-command-slot="slot-2"]');
    await expect(secondWindow).toBeVisible({ timeout: 10000 });
    await firstWindow.getByTestId('command-bar-browser-toggle').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await registerGuest(page);

    const paneBox = await hostedPane(page).boundingBox();
    expect(paneBox).not.toBeNull();
    const centerX = paneBox!.x + paneBox!.width / 2;
    const centerY = paneBox!.y + paneBox!.height / 2;
    const hitsPane = () => page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit.closest('[data-testid="command-terminal-browser-pane"]') !== null;
    }, { x: centerX, y: centerY });

    // Positive control: while showing, the point does resolve inside the pane.
    await expect.poll(hitsPane, { timeout: 5000 }).toBe(true);

    // Behind an Expand.
    await secondWindow.getByTestId('command-bar-expand').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'hidden', { timeout: 5000 });
    await expect(hostedPane(page)).toHaveAttribute('inert', '');
    expect(await hitsPane()).toBe(false);
    await secondWindow.getByTestId('command-bar-expand').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await expect.poll(hitsPane, { timeout: 5000 }).toBe(true);

    // Panel hidden.
    await page.keyboard.press('Control+Shift+P');
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'hidden', { timeout: 5000 });
    await expect(hostedPane(page)).toHaveAttribute('inert', '');
    expect(await hitsPane()).toBe(false);
  });

  test('Stop ends the pane: it unmounts, the guest unregisters, and the saved layout is cleared', async () => {
    const page = await openFreshPage();
    await seedUrl(page);
    await openPanel(page);
    await page.getByTestId('command-bar-browser-toggle').click();
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
    await registerGuest(page);
    const layoutKey = `${PROJECT_ID}::${SLOT}`;
    // The layout was saved while the terminal ran, so clearing it below is real.
    await expect.poll(() => page.evaluate((key: string) =>
      key in (window.__mockBrowser?.getCommandTerminalStates() ?? {}), layoutKey), { timeout: 5000 }).toBe(true);
    expect(await unregisterCountForGuest(page)).toBe(0);

    await page.getByTestId('command-bar-terminate-button').click();

    await expect(hostedPane(page)).toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => unregisterCountForGuest(page), { timeout: 5000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate((key: string) =>
      key in (window.__mockBrowser?.getCommandTerminalStates() ?? {}), layoutKey), { timeout: 5000 }).toBe(false);
  });

  test('a Browser pop-out of a Command Terminal owner mounts the pane and registers under the owner key', async () => {
    activeContext = await sharedBrowser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await activeContext.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(PRECONFIG);
    await page.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var timestamp = new Date().toISOString();
        state.sessions.push({
          id: 'ct-popout-session', taskId: 'ct-popout-session', projectId: '${PROJECT_ID}', pid: 4002,
          status: 'running', shell: 'bash', cwd: '/mock/command-browser', startedAt: timestamp, exitCode: null,
          resuming: false, transient: true, commandTerminalSlot: '${SLOT}', commandTerminalBranch: 'main',
          commandTerminalLabel: 'Checkout flow',
        });
        return { currentProjectId: '${PROJECT_ID}' };
      });
      window.__mockBrowser.seedTaskUrl('${OWNER_KEY}', '${PAGE_URL}');
      window.electronAPI.popOut.descriptor = ${JSON.stringify({ kind: 'browser', params: { projectId: PROJECT_ID, taskId: OWNER_KEY } })};
    `);
    await gotoVite(page, VITE_URL);

    await registerGuest(page);
    const registered = await page.evaluate(() => {
      const entry = (window.__mockBrowser?.getPaneCalls() ?? []).find((call) => call.type === 'register');
      return entry && entry.type === 'register'
        ? { taskId: entry.input.taskId, sessionId: entry.input.sessionId, projectId: entry.input.projectId }
        : null;
    });
    expect(registered).toEqual({ taskId: OWNER_KEY, sessionId: 'ct-popout-session', projectId: PROJECT_ID });
    await expect(page.getByText('No active session for this task')).toHaveCount(0);
    // The window is named for its terminal, as a task's is for its task, not
    // the surface's generic "Browser".
    await expect(page).toHaveTitle('Checkout flow');
  });

  /** A page booted as the project's detached Command Terminal window with a live slot-1 terminal. */
  async function openDetachedWindow(extraInitScript = ''): Promise<Page> {
    activeContext = await sharedBrowser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await activeContext.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(PRECONFIG);
    await page.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var timestamp = new Date().toISOString();
        state.sessions.push({
          id: 'ct-detached-session', taskId: 'ct-detached-session', projectId: '${PROJECT_ID}', pid: 4003,
          status: 'running', shell: 'bash', cwd: '/mock/command-browser', startedAt: timestamp, exitCode: null,
          resuming: false, transient: true, commandTerminalSlot: '${SLOT}', commandTerminalBranch: 'main',
          commandTerminalLabel: null,
        });
        return { currentProjectId: '${PROJECT_ID}' };
      });
      window.__mockBrowser.seedTaskUrl('${OWNER_KEY}', '${PAGE_URL}');
      window.electronAPI.popOut.descriptor = {
        kind: 'command-terminal',
        params: { projectId: '${PROJECT_ID}', projectName: 'Command Browser Project' },
      };
    `);
    if (extraInitScript) await page.addInitScript(extraInitScript);
    await gotoVite(page, VITE_URL);
    await expect(page.getByTestId('command-terminal-detached')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 10000 });
    return page;
  }

  test('the detached window hosts the saved pane over its slot', async () => {
    const page = await openDetachedWindow(
      `window.__mockBrowser.seedCommandTerminalState('${PROJECT_ID}', '${SLOT}', { open: true });`,
    );
    const host = page.getByTestId('command-terminal-browser-host');
    await expect(host.locator(`[data-testid="command-terminal-browser-pane"][data-owner-key="${OWNER_KEY}"]`)).toHaveAttribute('data-visibility', 'showing', { timeout: 10000 });
    const slot = page.locator(`[data-command-terminal-browser-slot="${OWNER_KEY}"]`);
    await expect(slot).toBeVisible();
    await expect.poll(async () => {
      const paneBox = await hostedPane(page).boundingBox();
      const slotBox = await slot.boundingBox();
      if (!paneBox || !slotBox) return false;
      return Math.abs(paneBox.x - slotBox.x) < 6 && Math.abs(paneBox.y - slotBox.y) < 6
        && Math.abs(paneBox.width - slotBox.width) < 6 && Math.abs(paneBox.height - slotBox.height) < 6;
    }, { timeout: 5000 }).toBe(true);
  });

  test('in the detached window an open_pane request opens a closed pane', async () => {
    const page = await openDetachedWindow();
    // Converse of the saved-layout case: nothing is saved, so nothing is open.
    await expect(page.getByTestId('command-bar-browser-slot')).toHaveCount(0);
    await expect(hostedPane(page)).toHaveCount(0);

    await page.evaluate(({ projectId, ownerKey }) => {
      window.__mockBrowser?.emitPaneOpenRequest(projectId, ownerKey);
    }, { projectId: PROJECT_ID, ownerKey: OWNER_KEY });

    await expect(page.getByTestId('command-bar-browser-slot')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('command-terminal-browser-host').locator(`[data-owner-key="${OWNER_KEY}"]`))
      .toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });
  });

  test('a saved layout reopens the pane on first mount of its slot', async () => {
    const page = await openFreshPage(`
      window.__mockBrowser.seedTaskUrl('${OWNER_KEY}', '${PAGE_URL}');
      window.__mockBrowser.seedCommandTerminalState('${PROJECT_ID}', '${SLOT}', { open: true, ratio: 0.6 });
    `);
    await openPanel(page);

    // Nobody clicked the pill: the saved layout opened it.
    const slot = page.getByTestId('command-bar-browser-slot');
    await expect(slot).toBeVisible({ timeout: 10000 });
    await expect(hostedPane(page)).toHaveAttribute('data-visibility', 'showing', { timeout: 5000 });

    // The terminal keeps 60 percent of the row, so the slot is about 40.
    await expect.poll(async () => {
      const slotBox = await slot.boundingBox();
      const rowBox = await slot.locator('xpath=..').boundingBox();
      if (!slotBox || !rowBox || rowBox.width === 0) return 0;
      return slotBox.width / rowBox.width;
    }, { timeout: 5000 }).toBeLessThan(0.47);
    const slotBox = await slot.boundingBox();
    const rowBox = await slot.locator('xpath=..').boundingBox();
    expect(slotBox!.width / rowBox!.width).toBeGreaterThan(0.3);
  });
});
