/**
 * UI test for the ContextBar's shell pill on a session of a remote project (#913).
 *
 * A host reports its login shell by program name, so a session on it carries `bash`, and the
 * pill named that "Git Bash" on a Windows desktop. What only a browser proves here is the wiring:
 * the bar reads the session's project, finds it lives on a host, and tells the label so.
 * `tests/unit/shell-display-name.test.ts` holds the label's own cases.
 *
 * The desktop's platform is pinned to Windows before the app loads (the mock bridge's `platform`,
 * through `__mockPlatform`), since the label reads `window.electronAPI.platform` and on Linux a
 * bash reads `bash` either way. The task
 * and session are seeded through `__mockPreConfigure`, with usage pushed through
 * `session-store.updateUsage` so the bar renders past its "Starting agent..." line, the pattern
 * of `tests/ui/context-bar-version-pill.spec.ts`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-context-bar-shell';
const TASK_ID = 'task-context-bar-shell';
const SESSION_ID = 'sess-context-bar-shell';
const SWIMLANE_ID = 'lane-context-bar-shell-todo';

/** The viewport width at which the shell pill folds out of the bar into its +N list. */
const FOLDED_VIEWPORT_WIDTH = 760;

async function launchWithRemoteSession(
  options: { remote: boolean } = { remote: true },
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript(() => {
    (window as unknown as { __mockPlatform?: string }).__mockPlatform = 'win32';
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Context Bar Shell Test',
        path: '/mock/remote-projects/${PROJECT_ID}',
        github_url: null,
        default_agent: 'claude',
        remote: ${options.remote ? "{ hostId: 'host-context-bar-shell', path: '/home/dev/api' }" : 'null'},
        last_opened: timestamp,
        created_at: timestamp,
      });

      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        var id = index === 0 ? '${SWIMLANE_ID}' : state.uuid();
        state.swimlanes.push({
          id: id,
          name: lane.name,
          role: lane.role,
          color: lane.color,
          icon: lane.icon,
          is_archived: lane.is_archived,
          permission_strategy: lane.permission_strategy ?? null,
          auto_spawn: lane.auto_spawn ?? false,
          position: index,
          created_at: timestamp,
        });
      });

      // What main reports for a session on a host: no pid here, the host's folder, and the
      // login shell by its program name.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: null,
        status: 'running',
        shell: 'bash',
        cwd: '/home/dev/api',
        startedAt: timestamp,
        exitCode: null,
        resuming: false,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Shell Pill Task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Reads the three places a session's shell is named, in the order a user meets them: the bottom
 * panel's session tab (its tip), the bar's inline pill, and the pill's copy in the +N list once
 * the bar folds it away. Each site passes `onHost` to `shellDisplayName` itself, so each is
 * checked on its own.
 */
async function expectShellNamedEverywhere(page: Page, expectedName: string): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  // Vacuity guard: the desktop reads as Windows, where a local bash is named Git Bash.
  expect(await page.evaluate(() => (window as unknown as { electronAPI: { platform: string } }).electronAPI.platform)).toBe('win32');

  await test.step('the session tab\'s tip names the shell', async () => {
    const sessionTab = page.locator(`[data-testid="terminal-session-tab"][data-session-id="${SESSION_ID}"]`);
    await expect(sessionTab).toBeVisible({ timeout: 10000 });
    await expect(sessionTab).toHaveAccessibleDescription(expectedName);
  });

  // The bottom panel's bar, as the other ContextBar specs find it.
  const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
  await expect(contextBar).toBeVisible({ timeout: 10000 });
  await page.evaluate(
    (sessionId: string) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
        };
      }).__zustandStores;
      stores?.session.getState().updateUsage(sessionId, {
        model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
        contextWindow: {
          usedPercentage: 5,
          usedTokens: 200,
          cacheTokens: 0,
          totalInputTokens: 150,
          totalOutputTokens: 50,
          contextWindowSize: 200000,
        },
        cost: { totalCostUsd: 0.001, totalDurationMs: 500 },
        toolCallCount: 42,
      });
    },
    SESSION_ID,
  );

  await test.step('the bar\'s inline pill names the shell', async () => {
    // A folded pill stays mounted, so the shell's own cell is read, not the bar's text.
    const shellPill = contextBar.locator('[data-fold-id="shell"]');
    await expect(shellPill).toHaveText(expectedName, { timeout: 5000 });
  });

  await test.step('the +N list\'s copy of the pill names the shell', async () => {
    await page.setViewportSize({ width: FOLDED_VIEWPORT_WIDTH, height: 700 });
    await expect(contextBar.locator('[data-fold-id="shell"][data-folded]')).toHaveCount(1, { timeout: 5000 });
    await contextBar.getByTestId('context-bar-overflow').click();
    const overflowList = page.getByTestId('context-bar-overflow-list');
    await expect(overflowList).toBeVisible();
    // An exact match: a regex on /bash/ would pass for "Git Bash" too.
    await expect(overflowList.locator('[data-overflow-item="shell"]')).toHaveText(expectedName);
  });
}

test.describe('Shell naming on a Windows desktop', () => {
  test('a host\'s bash reads bash on every surface, never Git Bash', async () => {
    const { browser, page } = await launchWithRemoteSession({ remote: true });
    try {
      await expectShellNamedEverywhere(page, 'bash');
    } finally {
      await browser.close();
    }
  });

  // The control. It needs its own boot because the project is the seed: it proves the pinned
  // win32 platform really turns a local bash into Git Bash at all three sites, so the test
  // above cannot pass only because nothing ever said Git Bash.
  test('a local project\'s bash still reads Git Bash on every surface', async () => {
    const { browser, page } = await launchWithRemoteSession({ remote: false });
    try {
      await expectShellNamedEverywhere(page, 'Git Bash');
    } finally {
      await browser.close();
    }
  });
});

