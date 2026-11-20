/**
 * The bottom panel's session tabs draw exactly what each task's board card draws
 * in its title row (#1135, signed-off design board 1 to 5).
 *
 * The owner's rule is 1:1 parity with the cards, so the load-bearing check is the
 * comparison: each tab's mark against its own card's mark, from one seeded state
 * per kind of wait. A tab that drifted from the card fails here whichever side
 * moved. Around it: every tab is a fixed 28px (an Isolated badge used to grow its
 * tab to 29px and the row to 30px), the mark is 14px, nothing pulses, and the
 * tab's tip leads with the card's reason, with the shell below it.
 *
 * One boot; each check is a step, since they only read.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-tab-marks';

interface SeededSession {
  key: string;
  activity: 'thinking' | 'idle' | 'permission';
  /** A JS expression for the reason, evaluated in the page (it reads `since`). */
  reason: string;
  isolated?: boolean;
  expectedMark: string;
}

const SEEDED: SeededSession[] = [
  { key: 'working', activity: 'thinking', reason: "{ kind: 'turn-active' }", expectedMark: 'agent-working' },
  { key: 'question', activity: 'permission', reason: "{ kind: 'permission', since: since, waitKind: 'question' }", expectedMark: 'agent-question' },
  { key: 'approval', activity: 'permission', reason: "{ kind: 'permission', since: since, waitKind: 'approval' }", expectedMark: 'agent-approval' },
  { key: 'finished', activity: 'idle', reason: "{ kind: 'idle', since: since }", expectedMark: 'agent-idle' },
  { key: 'stopped', activity: 'idle', reason: "{ kind: 'idle', since: since, stopped: true }", expectedMark: 'agent-stopped' },
  { key: 'isolated', activity: 'thinking', reason: "{ kind: 'turn-active' }", isolated: true, expectedMark: 'agent-working' },
  // The engine has reported no reason yet: the mark's name falls back to the state.
  { key: 'bare', activity: 'thinking', reason: 'undefined', expectedMark: 'agent-working' },
];

const sessionIdOf = (key: string): string => `sess-tab-${key}`;
const taskIdOf = (key: string): string => `task-tab-${key}`;

function preConfig(): string {
  const seeds = SEEDED.map((seed, index) => `
      state.sessions.push({
        id: '${sessionIdOf(seed.key)}', taskId: '${taskIdOf(seed.key)}', projectId: '${PROJECT_ID}',
        pid: ${5000 + index}, status: 'running', shell: 'bash', cwd: '/mock/tab-marks',
        startedAt: ts, exitCode: null, resuming: false,
        isolatedSwimlaneId: ${seed.isolated ? "'lane-review-isolated'" : 'null'},
      });
      state.activityCache['${sessionIdOf(seed.key)}'] = '${seed.activity}';
      state.activityReasonCache['${sessionIdOf(seed.key)}'] = ${seed.reason};
      state.tasks.push({
        id: '${taskIdOf(seed.key)}', display_id: ${index + 1}, title: 'tab-${seed.key}', description: '',
        swimlane_id: execLane.id, position: ${index}, agent: 'claude',
        model_override: null, effort_override: null, session_id: '${sessionIdOf(seed.key)}',
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, labels: [], priority: 0, attachment_count: 0,
        archived_at: null, created_at: ts, updated_at: ts,
      });`).join('\n');
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      // Two minutes into each wait, so a tip reads a real duration.
      var since = Date.now() - 120000;
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Tab Marks', path: '/mock/tab-marks',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-tab-' + index, position: index, created_at: ts }));
      });
      var execLane = state.swimlanes.find(function (swimlane) { return swimlane.name === 'Executing'; });
      ${seeds}
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

const tabFor = (page: Page, key: string) =>
  page.locator(`[data-testid="terminal-session-tab"][data-session-id="${sessionIdOf(key)}"]`);

test.describe('TerminalPanel: session tabs follow the board card', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfig());
    // A fake clock that keeps running, so the tick step can fast-forward a waiting tab's
    // clock instead of waiting a real minute.
    await page.clock.install();
    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
    await expect(page.locator('[data-testid="terminal-session-tab"]')).toHaveCount(SEEDED.length, { timeout: 15000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('each tab draws its card\'s mark, at 14px in a 28px tab, with no pulse', async () => {
    await test.step('parity: every tab wears the mark its own card wears', async () => {
      for (const seed of SEEDED) {
        const tabMark = tabFor(page, seed.key).locator('svg[data-mark]');
        const cardMark = page
          .locator(`[data-swimlane-name="Executing"] [data-task-id="${taskIdOf(seed.key)}"] svg[data-mark]`)
          .first();
        await expect(tabMark, seed.key).toHaveAttribute('data-mark', seed.expectedMark);
        await expect(cardMark, seed.key).toHaveAttribute('data-mark', seed.expectedMark);
      }
    });

    await test.step('tone: working is green, every wait is amber, as on the card', async () => {
      await expect(tabFor(page, 'working').locator('svg[data-mark]')).toHaveClass(/text-active/);
      for (const key of ['question', 'approval', 'finished', 'stopped']) {
        await expect(tabFor(page, key).locator('svg[data-mark]'), key).toHaveClass(/text-attention/);
      }
    });

    await test.step('size: the mark is 14px and every tab is 28px, the Isolated one included', async () => {
      for (const seed of SEEDED) {
        await expect(tabFor(page, seed.key).locator('svg[data-mark]'), seed.key).toHaveAttribute('width', '14');
      }
      await expect(tabFor(page, 'isolated').locator('[data-testid="terminal-tab-isolated-badge"]')).toBeVisible();
      await expect.poll(async () => page.evaluate(() => {
        const tabs = [
          ...document.querySelectorAll('[data-testid="terminal-session-tab"], [data-testid="terminal-activity-tab"]'),
        ];
        return tabs.map((tab) => Math.round(tab.getBoundingClientRect().height * 2) / 2);
      })).toEqual(Array(SEEDED.length + 1).fill(28));
    });

    await test.step('no pulse: nothing in the tab row animates its opacity', async () => {
      await expect(page.locator('[data-testid="terminal-session-tab"] .animate-pulse')).toHaveCount(0);
    });
  });

  test('a tab\'s tip leads with the card\'s reason, with the shell below it', async () => {
    await test.step('a question names itself and how long it has waited, with the shell after it', async () => {
      const tab = tabFor(page, 'question');
      await tab.hover();
      // One match, anchored: the reason leads and the shell follows (a shell-first or
      // reason-less tip fails it).
      await expect(tab).toHaveAccessibleDescription(/^Asking you a question for 2m\b.*\bbash$/i, { timeout: 5000 });
    });

    await test.step('the open tip leads with the reason\'s own glyph', async () => {
      const tab = tabFor(page, 'question');
      await tab.hover();
      const tip = page.getByRole('tooltip').filter({ hasText: 'Asking you a question' });
      await expect(tip).toBeVisible({ timeout: 5000 });
      // activityReasonIcon draws the wait's mark at 12px; Tooltip puts `icon` in its first span.
      const glyph = tip.locator('svg[data-mark]');
      await expect(glyph).toHaveCount(1);
      await expect(glyph).toHaveAttribute('data-mark', 'agent-question');
      await expect(glyph).toHaveAttribute('width', '12');
    });

    await test.step('a stopped turn shows only the shell, as its card shows no tip', async () => {
      const tab = tabFor(page, 'stopped');
      await tab.hover();
      await expect(tab).toHaveAccessibleDescription(/^(Git )?bash$/i, { timeout: 5000 });
      await expect(page.getByRole('tooltip').filter({ hasText: /bash/i })).toBeVisible();
      await expect(page.getByRole('tooltip').locator('svg[data-mark]')).toHaveCount(0);
    });
  });

  test('a tab\'s mark is named like its card\'s mark, and a waiting tab keeps its clock', async () => {
    await test.step('the mark is named by the reason, or by the state when there is none', async () => {
      await expect(tabFor(page, 'question').locator('svg[data-mark]')).toHaveAttribute('aria-label', /^Asking you a question for 2m\b/);
      await expect(tabFor(page, 'bare').locator('svg[data-mark]')).toHaveAttribute('aria-label', 'Thinking');
    });

    await test.step('tab and card name one session the same way', async () => {
      for (const key of ['question', 'approval', 'finished', 'stopped', 'bare']) {
        await expect.poll(async () => {
          const tabName = await tabFor(page, key).locator('svg[data-mark]').getAttribute('aria-label');
          const cardName = await page
            .locator(`[data-swimlane-name="Executing"] [data-task-id="${taskIdOf(key)}"] svg[data-mark]`)
            .first()
            .getAttribute('aria-label');
          return tabName !== null && tabName === cardName;
        }, { message: key }).toBe(true);
      }
    });

    await test.step('a waiting tab\'s time advances with the clock', async () => {
      const mark = tabFor(page, 'question').locator('svg[data-mark]');
      await expect(mark).toHaveAttribute('aria-label', /for 2m\b/);
      await page.clock.fastForward(60_000);
      await expect(mark).toHaveAttribute('aria-label', /for 3m\b/, { timeout: 5000 });
      const tab = tabFor(page, 'question');
      await tab.hover();
      await expect(tab).toHaveAccessibleDescription(/^Asking you a question for 3m\b/, { timeout: 5000 });
    });
  });
});
