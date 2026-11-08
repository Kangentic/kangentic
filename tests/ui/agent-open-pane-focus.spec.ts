/**
 * UI tests for what an agent's `kangentic_browser_open_pane` may do to the user's
 * screen: nothing. See `.claude/rules/agent-driven-focus.md`.
 *
 * It arrives as an ordinary IPC push. Reported from live use: three agents each
 * opened their browser while their task windows were closed, and each window came
 * up on top of the task the user was working in, with the app raised behind it.
 * The agent needing a browser was fine; Kangentic deciding to show the task was
 * the bug. So the push mounts the pane in a window born parked, and it never asks
 * main to open a detail, because main's answer to that is `focusWindowOf`, a
 * `restore()` plus `focus()` on the app's window.
 *
 * The converse matters just as much, and is why the first test exists: a fix that
 * simply stopped windows opening would pass the rest and break the app. A USER
 * opening the same task still raises it and focuses its terminal.
 *
 * Headless notes: `<webview>` is an unknown HTMLElement here, so a guest is faked
 * by stubbing it and dispatching `dom-ready`. A hidden guest compositing has no
 * representation at this tier and is covered by the probe recorded in
 * `src/main/browser/cdp/guest-capture-hold.ts`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-agent-focus';
const PROJECT_PATH = '/mock/agent-focus-test';
const TASK_A = 'task-focus-a';
const TASK_B = 'task-focus-b';
const SESSION_A = 'sess-focus-a';
const SESSION_B = 'sess-focus-b';
const SEEDED_URL = 'http://localhost:5173/';
const GUEST_ID = 8141;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Agent Focus Test',
      path: '${PROJECT_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-af-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    [['${TASK_A}', '${SESSION_A}', 'Focus Task A', 0], ['${TASK_B}', '${SESSION_B}', 'Focus Task B', 1]]
      .forEach(function (entry) {
        state.sessions.push({
          id: entry[1], taskId: entry[0], projectId: '${PROJECT_ID}',
          pid: 9000 + entry[3], status: 'running', shell: 'bash',
          cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
        });
        state.tasks.push({
          id: entry[0], title: entry[2],
          description: 'Focus arbitration fixture',
          swimlane_id: laneIds['Code Review'], position: entry[3],
          agent: 'claude', session_id: entry[1],
          worktree_path: null, branch_name: null,
          pr_number: null, pr_url: null, base_branch: 'main',
          archived_at: null, created_at: ts, updated_at: ts,
        });
      });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let sharedBrowser: Browser;
let sharedPage: Page;

async function loadApp(page: Page): Promise<void> {
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate((url) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-focus-a', url);
    window.__mockBrowser?.seedTaskUrl('task-focus-b', url);
    // Everything that asks main to open a detail. Main's handler focuses and
    // restores the app window on every one, so an agent path must never add to it.
    const ownership = window.electronAPI.taskDetailOwnership;
    const requestOpen = ownership.requestOpen;
    const asked: string[] = [];
    (window as unknown as { __detailRequests: string[] }).__detailRequests = asked;
    ownership.requestOpen = (projectId, taskId, host) => {
      asked.push(taskId);
      return requestOpen(projectId, taskId, host);
    };
  }, SEEDED_URL);
}

/** Which task-detail window owns the focused element, by its visible title. */
async function focusedWindowTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return null;
    const dialog = active.closest('[data-testid="task-detail-dialog"]');
    if (!dialog) return 'OUTSIDE-ANY-WINDOW';
    return dialog.querySelector('[data-testid="task-detail-titlebar"]')?.textContent?.trim() ?? null;
  });
}

interface WindowView {
  id: string;
  parked: boolean;
  zIndex: number;
}

interface BoardWindows {
  byTask: Record<string, WindowView>;
  order: string[];
  focusedWindowId: string | null;
  topZIndex: number;
}

async function boardWindows(page: Page): Promise<BoardWindows> {
  return page.evaluate(() => {
    type StoreWindow = { id: string; kind: string; anchor: string; parked?: true; zIndex: number };
    const stores = (window as unknown as {
      __zustandStores: {
        window: { getState: () => { windows: Record<string, StoreWindow>; order: string[]; focusedWindowId: string | null; zCounter: number } };
      };
    }).__zustandStores;
    const state = stores.window.getState();
    const byTask: BoardWindows['byTask'] = {};
    for (const candidate of Object.values(state.windows)) {
      if (candidate.kind === 'task-detail') {
        byTask[candidate.anchor] = { id: candidate.id, parked: candidate.parked === true, zIndex: candidate.zIndex };
      }
    }
    return { byTask, order: state.order, focusedWindowId: state.focusedWindowId, topZIndex: state.zCounter };
  });
}

function detailRequests(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __detailRequests: string[] }).__detailRequests);
}

function emitAgentOpen(page: Page, taskId: string): Promise<void> {
  return page.evaluate(
    ([projectId, target]) => { window.__mockBrowser?.emitPaneOpenRequest(projectId, target); },
    [PROJECT_ID, taskId],
  );
}

/** Open a task detail the way a USER does. */
async function openTaskByClick(page: Page, title: string): Promise<void> {
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first().click();
  await expect
    .poll(() => focusedWindowTitle(page), { timeout: 10000 })
    .toContain(title);
}

/** Attach a stub guest to the one pane mounted, and wait for its registration. */
async function registerGuest(page: Page): Promise<void> {
  await page.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 10000 });
  await page.evaluate((guestId) => {
    const element = document.querySelector('[data-testid="browser-webview"]');
    if (!element) throw new Error('browser-webview element not found');
    const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
    stub.getWebContentsId = () => guestId;
    stub.getURL = () => 'http://localhost:5173/';
    element.dispatchEvent(new Event('dom-ready'));
  }, GUEST_ID);
  await expect
    .poll(() => paneCalls(page, 'register'), { timeout: 10000 })
    .toBeGreaterThan(0);
}

function paneCalls(page: Page, type: 'register' | 'unregister'): Promise<number> {
  return page.evaluate(({ callType, guestId }) => {
    const calls = window.__mockBrowser?.getPaneCalls() ?? [];
    return calls.filter((call) => call.type === callType
      && (call.type === 'register' ? call.input.webContentsId : call.webContentsId) === guestId).length;
  }, { callType: type, guestId: GUEST_ID });
}

async function frameStyle(page: Page, windowId: string): Promise<{ opacity: string; visibility: string; inert: boolean }> {
  return page.locator(`[data-testid="window-frame-${windowId}"]`).evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    visibility: getComputedStyle(element).visibility,
    inert: element.hasAttribute('inert'),
  }));
}

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  sharedBrowser = await chromium.launch({ headless: true });
  const context = await sharedBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  sharedPage = await context.newPage();
  await sharedPage.addInitScript({ path: MOCK_SCRIPT });
  await sharedPage.addInitScript(preConfig);
  await loadApp(sharedPage);
});

test.afterAll(async () => {
  await sharedBrowser?.close();
});

test.beforeEach(async () => {
  // Full navigation resets both mock state and React state, so no test inherits
  // another's focus or open windows (cross-platform-parity.md).
  await loadApp(sharedPage);
});

test.describe("an agent's open_pane shows nothing", () => {
  test('a USER opening a task detail still focuses its terminal', async () => {
    // The converse guard, deliberately FIRST: a "fix" that just stopped windows
    // or terminals taking focus would pass the agent tests and break the app.
    await openTaskByClick(sharedPage, 'Focus Task A');
    await expect.poll(() => detailRequests(sharedPage), { timeout: 5000 }).toContain(TASK_A);
  });

  test('a closed task stays closed, and the task the user is in stays on top', async () => {
    await openTaskByClick(sharedPage, 'Focus Task A');
    const before = await boardWindows(sharedPage);
    const asked = (await detailRequests(sharedPage)).length;

    await emitAgentOpen(sharedPage, TASK_B);
    await registerGuest(sharedPage);

    const after = await boardWindows(sharedPage);
    expect(after.byTask[TASK_B]?.parked).toBe(true);
    // A keeps everything it had: focus, top of the stack, and the only place in
    // the order. Any one of these moving is the reported bug.
    expect(after.focusedWindowId).toBe(before.byTask[TASK_A].id);
    expect(after.order).toEqual([before.byTask[TASK_A].id]);
    expect(after.topZIndex).toBe(before.topZIndex);
    expect(after.byTask[TASK_A].zIndex).toBe(before.byTask[TASK_A].zIndex);

    // Hidden the retained way, so its guest goes on compositing.
    expect(await frameStyle(sharedPage, after.byTask[TASK_B].id)).toEqual({ opacity: '0', visibility: 'visible', inert: true });

    // This is what keeps `focusWindowOf` unreachable: main's handler runs it on
    // every request, so an agent open must not make one.
    expect((await detailRequests(sharedPage)).length).toBe(asked);

    // Poll for a WHILE rather than asserting once: a steal would arrive with a
    // terminal's mount and replay, which land well after the window does.
    await expect
      .poll(() => focusedWindowTitle(sharedPage), { timeout: 3000, intervals: [200, 200, 200, 200, 200] })
      .toContain('Focus Task A');
  });

  test('a task with no window at all opens nothing the user can see', async () => {
    await emitAgentOpen(sharedPage, TASK_B);
    await registerGuest(sharedPage);

    const after = await boardWindows(sharedPage);
    expect(after.byTask[TASK_B]?.parked).toBe(true);
    expect(after.focusedWindowId).toBeNull();
    expect(after.order).toEqual([]);
    expect(await detailRequests(sharedPage)).toEqual([]);
  });

  test('a window already parked stays parked through repeated opens, on the same guest', async () => {
    // `open_pane` is also how an agent navigates, so the warm path fires this push
    // over and over. One live report saw three in a second.
    await emitAgentOpen(sharedPage, TASK_B);
    await registerGuest(sharedPage);
    const parked = (await boardWindows(sharedPage)).byTask[TASK_B];

    await emitAgentOpen(sharedPage, TASK_B);
    await emitAgentOpen(sharedPage, TASK_B);

    expect((await boardWindows(sharedPage)).byTask[TASK_B]).toEqual(parked);
    expect(await detailRequests(sharedPage)).toEqual([]);
    expect(await paneCalls(sharedPage, 'unregister')).toBe(0);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
  });

  test("the user's click on the task raises it, on the same guest, with its terminal focused", async () => {
    await emitAgentOpen(sharedPage, TASK_B);
    await registerGuest(sharedPage);
    const parked = (await boardWindows(sharedPage)).byTask[TASK_B];

    await openTaskByClick(sharedPage, 'Focus Task B');

    const after = await boardWindows(sharedPage);
    expect(after.byTask[TASK_B]).toMatchObject({ id: parked.id, parked: false });
    expect(after.focusedWindowId).toBe(parked.id);
    expect((await frameStyle(sharedPage, parked.id)).opacity).toBe('1');
    expect(await paneCalls(sharedPage, 'register')).toBe(1);
    expect(await paneCalls(sharedPage, 'unregister')).toBe(0);
    await expect(sharedPage.locator('[data-testid="browser-webview"]')).toHaveCount(1);
  });
});
