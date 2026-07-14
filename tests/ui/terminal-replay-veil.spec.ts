/**
 * UI coverage for TerminalTab's replay veil (`data-testid="terminal-replay-veil"`).
 *
 * The veil is a fixed-color overlay covering the mount-time replay window (fit,
 * chunked scrollback write, afterWrite refit, held-byte flush) so a task-detail
 * terminal appears once, fully settled, with no intermediate frame. It lifts on
 * the FIRST `onScrollbackSettled` firing (the `settleScrollback` chokepoint in
 * useTerminal.ts) and is never re-shown: `replaySettled` has no reset path, so a
 * later reload (resize cleanup, parked reveal, the ready-transition reload below)
 * repaints in place without re-veiling.
 *
 * Two tests, split by scenario because each needs a different IPC to control
 * deterministically:
 *
 *   1. A WARM (already-ready) session: terminalReady is seeded true BEFORE the
 *      dialog opens (real-world "reopening a task whose agent already reported
 *      output"), so initTerminal's scrollback fetch is NOT suppressed - the veil
 *      covers exactly the getScrollback round trip. getScrollback is overridden
 *      to hang until the test resolves it, making the veil-visible window
 *      deterministically observable (assertions a + b).
 *
 *   2. A COLD-then-ready session: terminalReady starts false (dialog opened
 *      before the agent's first output arrives - the initTerminal scrollback
 *      fetch is suppressed, so `sessions.resize` is the IPC that gates the FIRST
 *      settle). Once the veil has lifted, `markFirstOutput` flips terminalReady
 *      false->true, which fires TerminalTab's wasReadyRef effect and calls
 *      `reloadScrollback()` - a genuine SECOND scrollback settle, gated on a
 *      second `sessions.resize` + the first real `sessions.getScrollback` call.
 *      Both are held open so the test can assert the veil stays absent while the
 *      second reload is in flight and after it completes (assertion c). This is
 *      the actual "later reload repaints in place" path TerminalTab documents -
 *      more faithful than dispatching `terminal-panel-resize`, which for this
 *      dialog's `immediatePanelResize` config only fits/flushes and never
 *      reaches a scrollback reload at all.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own page/goto, so the file can fan out across UI workers.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

interface SessionFixture {
  projectId: string;
  taskId: string;
  sessionId: string;
  taskTitle: string;
  laneIdPrefix: string;
}

function basePreConfigScript(fixture: SessionFixture): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${fixture.projectId}',
        name: 'Terminal Replay Veil Test',
        path: '/mock/${fixture.projectId}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = '${fixture.laneIdPrefix}-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // A running session so TerminalTab mounts a real xterm (displayKind ===
      // 'running' inside TaskDetailBody), mirroring terminal-image-paste-reference.spec.ts.
      state.sessions.push({
        id: '${fixture.sessionId}',
        taskId: '${fixture.taskId}',
        projectId: '${fixture.projectId}',
        pid: 9999,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/${fixture.projectId}',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${fixture.taskId}',
        display_id: 1,
        title: '${fixture.taskTitle}',
        description: 'Task used for the terminal replay veil test',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${fixture.sessionId}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${fixture.projectId}' };
    });
  `;
}

async function launchWithState(extraScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(extraScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Click the task card and wait for the task-detail dialog to become visible.
 *  Returns the dialog locator so callers can scope selectors to it (multiple
 *  overlay-class dialogs can exist in the app - see anti-pattern 8). */
async function openTaskDialog(page: Page, laneName: string, taskTitle: string): Promise<ReturnType<Page['locator']>> {
  await page.locator(`[data-swimlane-name="${laneName}"]`).waitFor({ state: 'visible', timeout: 15000 });
  const card = page.locator(`[data-swimlane-name="${laneName}"]`).locator(`text=${taskTitle}`).first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

async function markFirstOutput(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { markFirstOutput: (sessionId: string) => void } } };
    }).__zustandStores;
    stores?.session?.getState().markFirstOutput(id);
  }, sessionId);
}

test.describe('TerminalTab replay veil', () => {
  test('covers a warm (already-ready) session mount until getScrollback settles, then lifts', async () => {
    const fixture: SessionFixture = {
      projectId: 'proj-replay-veil-warm',
      taskId: 'task-replay-veil-warm',
      sessionId: 'sess-replay-veil-warm',
      taskTitle: 'Replay Veil Warm Task',
      laneIdPrefix: 'lane-trv-warm',
    };
    // getScrollback hangs until the test resolves it, so the veil's visible
    // window is fully under test control (deterministic assertion a + b).
    const delayedScrollbackScript = `
      window.__mockScrollbackResolvers = [];
      window.electronAPI.sessions.getScrollback = function () {
        return new Promise(function (resolve) {
          window.__mockScrollbackResolvers.push(function (value) { resolve(value); });
        });
      };
    `;
    const { browser, page } = await launchWithState(
      basePreConfigScript(fixture) + delayedScrollbackScript,
    );
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      // Seed terminalReady=true BEFORE the dialog (and TerminalTab) mounts, so
      // initTerminal's scrollback fetch is NOT suppressed - the warm-session path.
      await markFirstOutput(page, fixture.sessionId);

      const dialog = await openTaskDialog(page, 'Code Review', fixture.taskTitle);
      const veil = dialog.locator('[data-testid="terminal-replay-veil"]');

      // getScrollback has been called (queued, hanging) - initTerminal is past
      // its fit() and is now awaiting the replay data.
      await expect
        .poll(async () => page.evaluate(() => window.__mockScrollbackResolvers.length), { timeout: 5000 })
        .toBeGreaterThan(0);

      // (a) The veil covers the terminal while the replay is in flight. The
      // warm session never shows the LaunchOverlay shimmer (terminalReady is
      // already true), so the veil is the only thing masking the mount.
      await expect(veil).toBeVisible();
      await expect(dialog.locator('[data-testid="launch-overlay"]')).toHaveCount(0);

      // Resolve the replay.
      await page.evaluate(() => {
        const resolvers = (window as unknown as { __mockScrollbackResolvers: Array<(value: string) => void> })
          .__mockScrollbackResolvers.splice(0);
        resolvers.forEach((resolve) => resolve(''));
      });

      // (b) The veil lifts once the first scrollback settle completes.
      await veil.waitFor({ state: 'hidden', timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('does not reappear across a later scrollback reload (ready-transition reload)', async () => {
    const fixture: SessionFixture = {
      projectId: 'proj-replay-veil-reload',
      taskId: 'task-replay-veil-reload',
      sessionId: 'sess-replay-veil-reload',
      taskTitle: 'Replay Veil Reload Task',
      laneIdPrefix: 'lane-trv-reload',
    };
    // Both IPCs the replay path depends on are held open so the test can drive
    // two distinct settles deterministically: resize gates the FIRST (cold,
    // suppressed-scrollback) settle; the second reload (triggered below by the
    // ready transition) is gated on both a fresh resize and the first real
    // getScrollback call.
    const delayedIpcScript = `
      window.__mockResizeResolvers = [];
      window.electronAPI.sessions.resize = function () {
        return new Promise(function (resolve) {
          window.__mockResizeResolvers.push(function () { resolve({ colsChanged: false }); });
        });
      };
      window.__mockScrollbackResolvers = [];
      window.electronAPI.sessions.getScrollback = function () {
        return new Promise(function (resolve) {
          window.__mockScrollbackResolvers.push(function (value) { resolve(value); });
        });
      };
    `;
    const { browser, page } = await launchWithState(
      basePreConfigScript(fixture) + delayedIpcScript,
    );
    try {
      // Dialog opens COLD (terminalReady starts false): no markFirstOutput yet,
      // so initTerminal's scrollback fetch is suppressed and the first settle
      // is gated on the resize IPC alone.
      const dialog = await openTaskDialog(page, 'Code Review', fixture.taskTitle);
      const veil = dialog.locator('[data-testid="terminal-replay-veil"]');

      await expect
        .poll(async () => page.evaluate(() => window.__mockResizeResolvers.length), { timeout: 5000 })
        .toBeGreaterThan(0);
      await expect(veil).toBeVisible();

      // Resolve every pending resize (drains any stray debounced xterm-driven
      // resize alongside the explicit mount-time one - harmless, fire-and-forget).
      await page.evaluate(() => {
        const resolvers = (window as unknown as { __mockResizeResolvers: Array<() => void> })
          .__mockResizeResolvers.splice(0);
        resolvers.forEach((resolve) => resolve());
      });

      // First settle: the veil lifts.
      await veil.waitFor({ state: 'hidden', timeout: 5000 });

      // Ready transition: fires TerminalTab's wasReadyRef effect, which calls
      // reloadScrollback() - a genuine second settle, distinct from the mount-time
      // one. getScrollback is called for the FIRST time here (the mount-time
      // fetch was suppressed while cold), so its resolver count is an
      // unambiguous "the second reload has started" signal.
      await markFirstOutput(page, fixture.sessionId);
      await expect
        .poll(async () => page.evaluate(() => window.__mockScrollbackResolvers.length), { timeout: 5000 })
        .toBeGreaterThan(0);

      // (c, mid-flight) The second reload is in flight; the veil must not have
      // reappeared - replaySettled has no reset path once true.
      await expect(veil).toHaveCount(0);

      // Resolve the second reload's resize + scrollback.
      await page.evaluate(() => {
        const resizeResolvers = (window as unknown as { __mockResizeResolvers: Array<() => void> })
          .__mockResizeResolvers.splice(0);
        resizeResolvers.forEach((resolve) => resolve());
        const scrollbackResolvers = (window as unknown as { __mockScrollbackResolvers: Array<(value: string) => void> })
          .__mockScrollbackResolvers.splice(0);
        scrollbackResolvers.forEach((resolve) => resolve(''));
      });

      // Intentional fixed wait - this is a negative assertion (the veil must
      // NOT reappear); there is no positive condition to poll for completion of
      // "nothing happened", so give the settle a budget before the final check.
      await page.waitForTimeout(500);

      // (c, after) Still absent once the second reload has fully settled.
      await expect(veil).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
