/**
 * UI coverage for the @kangentic/branding activity marks (`components/ActivityMark.tsx`).
 *
 * The per-feature specs (task-activity-indicators, command-terminal, sidebar-command-terminals)
 * already assert WHICH mark each state renders. This file covers the three things that are
 * properties of the packaged set itself, and that fail silently everywhere else:
 *
 *  1. The packaged `activity.css` reaches the renderer's cascade. `.kng-march` is an unscoped
 *     global arriving from node_modules, so a mark can render perfectly and simply never move.
 *     No `data-mark` assertion catches that.
 *  2. The marks render at the size their call site asked for. The packaged SVGs carry a
 *     hardcoded `width="24" height="24"`, so a regression in ActivityMark's root would silently
 *     paint every indicator at 24px.
 *  3. `prefers-reduced-motion` is honored, including the `drop-dash` strategy that needs
 *     `data-rest` to survive into the DOM.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-mark-test';
const TASK_ID = 'task-mark-test';
const SESSION_ID = 'sess-mark-test';
const TRANSIENT_SESSION_ID = 'sess-mark-terminal';

/**
 * `transientActivity` seeds a running Command Terminal PTY in that state, which is what makes the
 * title-bar toggle render a `terminal-*` mark. Omit it and the toggle sits at `terminal-idle`.
 */
function preConfig(activity: string, transientActivity?: string): string {
  const transientSession = transientActivity
    ? `
      state.sessions.push({
        id: '${TRANSIENT_SESSION_ID}', taskId: 'task-${TRANSIENT_SESSION_ID}',
        projectId: '${PROJECT_ID}', pid: 8888, status: 'running', shell: 'bash',
        cwd: '/mock/mark-test', startedAt: ts, exitCode: null, transient: true,
      });
      state.activityCache['${TRANSIENT_SESSION_ID}'] = '${transientActivity}';
      `
    : '';
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Mark Test', path: '/mock/mark-test',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push({
          id: 'lane-mark-' + index, name: swimlane.name, role: swimlane.role, color: swimlane.color,
          icon: swimlane.icon, is_archived: swimlane.is_archived,
          permission_strategy: swimlane.permission_strategy ?? null,
          auto_spawn: swimlane.auto_spawn ?? false, position: index, created_at: ts,
        });
      });
      var execLane = state.swimlanes.find(function (swimlane) { return swimlane.name === 'Executing'; });
      state.sessions.push({
        id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999,
        status: 'running', shell: 'bash', cwd: '/mock/mark-test',
        startedAt: ts, exitCode: null,
      });
      state.activityCache['${SESSION_ID}'] = '${activity}';
      ${transientSession}
      state.tasks.push({
        id: '${TASK_ID}', title: 'Mark Test Task', description: '',
        swimlane_id: execLane.id, position: 0, agent: 'claude',
        model_override: null, effort_override: null, session_id: '${SESSION_ID}',
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(
  activity: string,
  reducedMotion?: 'reduce',
  transientActivity?: string,
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(activity, transientActivity));
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Every computed-style read below goes through `expect.poll`, NOT a one-shot `locator.evaluate`.
 *
 * `evaluate` resolves the element and then runs the callback; if the board re-renders in that
 * gap the handle is detached, and `getComputedStyle` on a detached node returns `''` for every
 * property rather than throwing - so the assertion fails with an empty string instead of
 * retrying. The bare-`evaluate` form failed roughly one run in four at the UI tier's 3 workers
 * while passing 12/12 at `--workers=1`: exactly the load-dependent shape that is green locally
 * and red on CI. Polling re-resolves the element on each attempt.
 */

test.describe('Activity marks', () => {
  test('the packaged activity.css reaches the cascade and drives the march', async () => {
    const { browser, page } = await launch('thinking');
    try {
      const mark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(mark).toBeVisible({ timeout: 15000 });

      await expect
        .poll(
          () => mark.locator('.kng-march').evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              name: style.animationName,
              duration: style.animationDuration,
              timing: style.animationTimingFunction,
              iteration: style.animationIterationCount,
            };
          }),
          {
            message:
              'activity.css did not reach the cascade: .kng-march resolved to no animation, so every working mark is frozen',
          },
        )
        .toEqual({
          name: 'kng-activity-march',
          duration: '1.4s',
          timing: 'linear',
          iteration: 'infinite',
        });
    } finally {
      await browser.close();
    }
  });

  test('marks render at their call site size, not the packaged 24px', async () => {
    // Computed style, not boundingBox: the task-detail window carries a scale transform, so
    // every measured rect inside it is uniformly smaller than its layout size.
    const { browser, page } = await launch('thinking');
    try {
      // 15, not 14: the branding envelope is 18 wide where lucide's Mail was 20, so keeping the
      // old number would have shrunk the drawn mark ~10% against what production shipped.
      const cardMark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(cardMark).toBeVisible({ timeout: 15000 });
      await expect
        .poll(() => cardMark.evaluate((node) => getComputedStyle(node).width))
        .toBe('15px');

      await page.locator('text=Mark Test Task').first().click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      const pauseButton = dialog.locator('button[title="Pause session"]');
      const ring = pauseButton.locator('[data-mark="control-pause-working"]');
      await expect(ring).toBeVisible({ timeout: 10000 });

      // The control mark is r=10, so 20 * (2*10+2)/24 = 18.33px of drawn ring - a pixel match
      // for the lucide Circle it replaced. No size compensation, and none should come back.
      await expect
        .poll(() => ring.evaluate((node) => getComputedStyle(node).width), {
          message: 'control marks must render at 20 to match the lucide Circle they replaced',
        })
        .toBe('20px');

      // The slot is pinned so the button does not resize as the activity state flips.
      await expect
        .poll(
          () => pauseButton.locator('span.grid').first()
            .evaluate((node) => getComputedStyle(node).width),
          { message: 'the icon slot must stay 20px' },
        )
        .toBe('20px');
    } finally {
      await browser.close();
    }
  });

  test('a static mark carries no marching group at all', async () => {
    const { browser, page } = await launch('idle');
    try {
      const mark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-idle"]`);
      await expect(mark).toBeVisible({ timeout: 15000 });
      await expect(mark).toHaveAttribute('data-rest', 'static');
      await expect(mark.locator('.kng-march')).toHaveCount(0);
      // The idle branch carries its own `size={15}` literal in TaskCard, separate from the
      // thinking branch the size test above measures, so it can regress on its own.
      await expect
        .poll(() => mark.evaluate((node) => getComputedStyle(node).width))
        .toBe('15px');
    } finally {
      await browser.close();
    }
  });

  test('prefers-reduced-motion stops the march and drops the drop-dash dash', async () => {
    // The transient terminal is seeded 'thinking' on purpose. `terminal-working` is the ONLY
    // mark that declares `drop-dash`, and it renders only when a running transient PTY is
    // active: `selectCommandTerminalSummary` counts `transient && running` sessions, so the
    // task's own (non-transient) session never drives the toggle no matter what its activity
    // is. Without this the toggle sits at `terminal-idle` / `static` and the dash assertion
    // below has nothing to check.
    const { browser, page } = await launch('thinking', 'reduce', 'thinking');
    try {
      const mark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(mark).toBeVisible({ timeout: 15000 });
      await expect
        .poll(
          () => mark.locator('.kng-march').evaluate((node) => getComputedStyle(node).animationName),
          { message: 'prefers-reduced-motion should disable the march' },
        )
        .toBe('none');

      // Under reduced motion a `drop-dash` mark must lose its dash outright, not merely freeze
      // it mid-gap. That rule is `svg[data-rest="drop-dash"] *`, so it only fires if `data-rest`
      // survives the packaged-wrapper strip into the React-authored root.
      const terminalMark = page.getByTestId('quick-session-icon');
      await expect(terminalMark).toHaveAttribute('data-mark', 'terminal-working', { timeout: 10000 });
      await expect(terminalMark).toHaveAttribute('data-rest', 'drop-dash');
      await expect
        .poll(
          () => terminalMark.locator('rect').first()
            .evaluate((node) => getComputedStyle(node).strokeDasharray),
          { message: 'a drop-dash mark should lose its dash under reduced motion' },
        )
        .toBe('none');
    } finally {
      await browser.close();
    }
  });
});
