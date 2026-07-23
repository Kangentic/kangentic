/**
 * UI regression coverage for LaunchOverlay's DEFAULT `variant="surface"` at
 * the TaskDetailBody.tsx pre-terminal pane (the "preparing" launch state -
 * worktree creation / CLI boot before a session exists).
 *
 * Mirrors launch-overlay-terminal-surface.spec.ts, which proves the
 * `variant="terminal"` wiring at TerminalTab.tsx / CommandTerminalWindow.tsx.
 * This spec proves the OTHER side: the untouched call sites in
 * TaskDetailBody.tsx (the `spawnLabel` pane) still get the theme-tracking
 * `bg-surface` treatment with no inline terminal-color style. Without this
 * test, nothing exercises LaunchOverlay's default/surface branch at all -
 * every existing LaunchOverlay test (unit + UI) passes `variant="terminal"`
 * explicitly, so a change to the default (or an edit to the surface branch)
 * that silently started painting terminal colors on these panes would go
 * undetected.
 *
 * Assertions target the class/inline-style discriminator (the `bg-surface`
 * class is present; no inline backgroundColor/color/opacity style is set),
 * not a computed rgb - `bg-surface` is a theme CSS variable that differs
 * across the app's themes, so asserting a computed color would be
 * theme-fragile (see .claude/rules/cross-platform-parity.md's
 * no-pixel-exact-assertions guidance). The terminal-variant spec can assert
 * exact rgb values because the terminal palette default is a fixed constant;
 * the surface variant's color is not.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-overlay-surface-variant';
const TASK_ID = 'task-overlay-surface-variant';
const TASK_TITLE = 'Overlay Surface Variant Task';

/**
 * Launch a headless page with a project and a task pre-seeded in Code
 * Review, with NO session (session_id null, no sessions[] entry) - the
 * pre-session "preparing" state that TaskDetailBody.tsx's spawnLabel pane
 * covers.
 */
async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Launch Overlay Surface Variant Test',
        path: '/mock/${PROJECT_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-overlay-surface-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: '${TASK_TITLE}',
        description: 'Task used for the launch overlay surface-variant regression test',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: null,
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

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Seed spawnProgress on the session store directly, driving displayKind to
 * 'preparing' (task-progress.ts: spawnProgressLabel truthy + no session)
 * without needing a real spawn/IPC round trip.
 */
async function seedSpawnProgress(page: Page, taskId: string, label: string): Promise<void> {
  await page.evaluate(
    ({ tid, label }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { setSpawnProgress: (id: string, label: string | null) => void } };
        };
      }).__zustandStores;
      if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
      stores.session.getState().setSpawnProgress(tid, label);
    },
    { tid: taskId, label },
  );
}

async function openTaskDialog(page: Page, laneName: string, taskTitle: string): Promise<ReturnType<Page['locator']>> {
  await page.locator(`[data-swimlane-name="${laneName}"]`).waitFor({ state: 'visible', timeout: 15000 });
  const card = page.locator(`[data-swimlane-name="${laneName}"]`).locator(`text=${taskTitle}`).first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

test.describe('LaunchOverlay surface-variant (default) regression', () => {
  test('the pre-session pane keeps the theme bg-surface treatment, not inline terminal colors', async () => {
    const { browser, page } = await launchWithState();
    try {
      // Seed the pre-session "preparing" state before opening the dialog so
      // it renders the LaunchOverlay pane on first paint (no post-open wait
      // needed).
      await seedSpawnProgress(page, TASK_ID, 'Starting agent...');

      const dialog = await openTaskDialog(page, 'Code Review', TASK_TITLE);
      const overlay = dialog.locator('[data-testid="launch-overlay"]');
      await expect(overlay).toBeVisible();
      await expect(overlay).toContainText('Starting agent...');

      // The default/surface variant must keep the theme-tracking class and
      // must NOT set an inline backgroundColor - this is the property that
      // goes red if the default variant is flipped to 'terminal' (or the
      // surface branch starts painting inline colors).
      const overlayClass = await overlay.evaluate((element) => element.className);
      expect(overlayClass).toContain('bg-surface');
      const overlayInlineBackground = await overlay.evaluate((element) => (element as HTMLElement).style.backgroundColor);
      expect(overlayInlineBackground).toBe('');

      // Same discriminator on the label: theme-tracking text-fg-muted class,
      // no inline color/opacity style (the terminal variant's dimming trick).
      const label = overlay.locator('span');
      const labelClass = await label.evaluate((element) => element.className);
      expect(labelClass).toContain('text-fg-muted');
      const labelInlineColor = await label.evaluate((element) => (element as HTMLElement).style.color);
      expect(labelInlineColor).toBe('');
      const labelInlineOpacity = await label.evaluate((element) => (element as HTMLElement).style.opacity);
      expect(labelInlineOpacity).toBe('');
    } finally {
      await browser.close();
    }
  });
});
