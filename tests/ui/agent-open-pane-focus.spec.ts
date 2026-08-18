/**
 * UI tests for the focus half of `.claude/rules/agent-driven-focus.md`.
 *
 * `kangentic_browser_open_pane` arrives as an ordinary IPC push and opens (or
 * raises) a task-detail window. That sets `focusedWindowId`, which is what
 * `resolveArrivalFocus` reads to decide which terminal may take the keyboard on
 * mount - so before the fix, an agent opening its pane handed its OWN terminal
 * the keystrokes the user was typing into a different task.
 *
 * The converse matters just as much and is why the second test exists: a fix
 * that simply stopped arriving terminals from focusing would pass the first test
 * and break the app. A USER opening a task detail must still focus its terminal.
 *
 * Headless notes: `<webview>` is an unknown HTMLElement here, so no guest ever
 * attaches - these assert the RENDERER's focus decisions, which is the half the
 * main-process unit tests cannot see. The real Chromium focus steal (a CDP click
 * moving `document.activeElement` to the guest) has no representation at this
 * tier at all and is covered by the live probe recorded in the rule.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-agent-focus';
const PROJECT_PATH = '/mock/agent-focus-test';
const TASK_A = 'task-focus-a';
const TASK_B = 'task-focus-b';
const SESSION_A = 'sess-focus-a';
const SESSION_B = 'sess-focus-b';
const SEEDED_URL = 'http://localhost:5173/';

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
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate((url) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl('task-focus-a', url);
    window.__mockBrowser?.seedTaskUrl('task-focus-b', url);
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

/** Open a task detail the way a USER does, and wait for its terminal. */
async function openTaskByClick(page: Page, title: string): Promise<void> {
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').first().waitFor({ state: 'visible', timeout: 10000 });
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

test.describe('agent-driven window opens and keyboard focus', () => {
  test('a USER opening a task detail still focuses its terminal', async () => {
    // The converse guard, deliberately FIRST: a "fix" that just stopped arriving
    // terminals from focusing would pass the agent test below and break the app.
    await openTaskByClick(sharedPage, 'Focus Task A');

    await expect
      .poll(() => focusedWindowTitle(sharedPage), { timeout: 10000 })
      .toContain('Focus Task A');
  });

  test('an agent open_pane does not move focus out of the terminal the user is in', async () => {
    // The reported bug: the user is typing in task A, an agent opens its own
    // pane for task B, and B's arriving terminal takes the keyboard.
    await openTaskByClick(sharedPage, 'Focus Task A');
    await expect
      .poll(() => focusedWindowTitle(sharedPage), { timeout: 10000 })
      .toContain('Focus Task A');

    await sharedPage.evaluate(
      ([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId),
      [PROJECT_ID, TASK_B],
    );

    // B's window must actually open - the agent still needs a driveable pane.
    await expect
      .poll(async () => sharedPage.locator('[data-testid="task-detail-dialog"]').count(), { timeout: 10000 })
      .toBe(2);

    // Poll for a WHILE rather than asserting once: the steal this guards against
    // arrives with B's terminal mount and scrollback replay, which lands well
    // after the window appears. A single immediate assertion would pass against
    // the unfixed build.
    await expect
      .poll(() => focusedWindowTitle(sharedPage), { timeout: 3000, intervals: [200, 200, 200, 200, 200] })
      .toContain('Focus Task A');
  });

  test('the agent-opened window still raises and shows its pane', async () => {
    // Denying arrival FOCUS must not degrade into denying the open. The agent
    // needs the pane rendering to drive it.
    await sharedPage.evaluate(
      ([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId),
      [PROJECT_ID, TASK_B],
    );

    await sharedPage.locator('[data-testid="task-detail-dialog"]').first().waitFor({ state: 'visible', timeout: 10000 });
    await sharedPage.locator('[data-testid="browser-pane"]').first().waitFor({ state: 'visible', timeout: 10000 });
  });

  test('the user can still click into the agent-opened window and take focus back', async () => {
    // `openedByAgent` is cleared by `focusWindow`, i.e. by the user's first
    // pointer-down on the frame. Without that clear the stamp would be
    // permanent and that window's terminal could never take focus again.
    await sharedPage.evaluate(
      ([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId),
      [PROJECT_ID, TASK_B],
    );
    const agentWindow = sharedPage.locator('[data-testid="task-detail-dialog"]').first();
    await agentWindow.waitFor({ state: 'visible', timeout: 10000 });

    await agentWindow.locator('[data-testid="task-detail-titlebar"]').click();

    await expect
      .poll(() => focusedWindowTitle(sharedPage), { timeout: 10000 })
      .toContain('Focus Task B');
  });
});
