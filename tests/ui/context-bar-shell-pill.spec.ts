/**
 * UI test for the ContextBar's shell pill on a session of a remote project (#913).
 *
 * A host reports its login shell by program name, so a session on it carries `bash`, and the
 * pill named that "Git Bash" on a Windows desktop. What only a browser proves here is the wiring:
 * the bar reads the session's project, finds it lives on a host, and tells the label so.
 * `tests/unit/shell-display-name.test.ts` holds the label's own cases.
 *
 * The desktop's platform is forced to Windows before the app loads, since the label reads
 * `navigator.platform` and CI's runner is Linux, where a bash reads `bash` either way. The task
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

async function launchWithRemoteSession(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', configurable: true });
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Context Bar Shell Test',
        path: '/mock/remote-projects/${PROJECT_ID}',
        github_url: null,
        default_agent: 'claude',
        remote: { hostId: 'host-context-bar-shell', path: '/home/dev/api' },
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
        state.swimlanes.push({
          id: id,
          name: s.name,
          role: s.role,
          color: s.color,
          icon: s.icon,
          is_archived: s.is_archived,
          permission_strategy: s.permission_strategy ?? null,
          auto_spawn: s.auto_spawn ?? false,
          position: i,
          created_at: ts,
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
        startedAt: ts,
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
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('ContextBar shell pill for a session on a host', () => {
  test('a host\'s bash reads bash on a Windows desktop, never Git Bash', async () => {
    const { browser, page } = await launchWithRemoteSession();
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      // Vacuity guard: the desktop reads as Windows, where a local bash is named Git Bash.
      expect(await page.evaluate(() => navigator.platform)).toBe('Win32');

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
          });
        },
        SESSION_ID,
      );

      // A folded pill stays mounted, so the shell's own cell is read, not the bar's text.
      const shellPill = contextBar.locator('[data-fold-id="shell"]');
      await expect(shellPill).toHaveText('bash', { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
