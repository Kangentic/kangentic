/**
 * Regression spec: a COLLAPSED bottom panel must not keep its session in the focused
 * set.
 *
 * The focused set is what main gates PTY emission on. A collapsed panel renders no
 * `TerminalTab` at all (`TerminalPanel` mounts its panes behind `showContent`), so
 * there is no xterm and therefore no incoming-write queue to acknowledge the bytes -
 * yet the panel session was still published as focused. Measured live: an agent that
 * produced output while the panel was collapsed left ~6KB permanently un-acknowledged
 * in main's in-flight accounting. At `BACKPRESSURE_HIGH_WATER` (1MiB) that pauses the
 * PTY, which stalls the agent, until some unrelated focus change resets the counters.
 *
 * After the fix: collapsing drops the session from the focused set, main stops
 * emitting, the bytes accumulate safely in its scrollback ring, and expanding both
 * re-focuses the session and replays the ring into the fresh terminal.
 *
 * The pure half is covered in `tests/unit/focused-sessions.test.ts`
 * (`panelShowsTerminal`). This spec covers the WIRING - that `AppLayout` actually
 * threads `useTerminalResize`'s `showContent` into `useFocusedSessionsSync` - which a
 * unit test cannot see and which is exactly where a future edit would silently drop it.
 *
 * How to verify RED / GREEN: in `AppLayout.tsx`, call `useFocusedSessionsSync(true)`.
 * The collapse assertion goes red; the expanded one stays green.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-collapsed-focus-${RUN_ID}`;
const TASK_ID = `task-collapsed-focus-${RUN_ID}`;
const SESSION_ID = `sess-collapsed-focus-${RUN_ID}`;

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Collapsed Focus ${RUN_ID}',
        path: '/mock/collapsed-focus-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-cf-${RUN_ID}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId, position: index, created_at: ts,
        }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 7100,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/collapsed-focus-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });
      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: 'Collapsed Focus Task ${RUN_ID}',
        description: '',
        swimlane_id: executingLaneId,
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
      state.activityCache['${SESSION_ID}'] = 'thinking';

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/** The most recent focused set the renderer published to main. */
const latestFocusedSet = (page: Page) => page.evaluate(() => {
  const calls = (window as unknown as {
    electronAPI: { sessions: { __setFocusedCalls: string[][] } };
  }).electronAPI.sessions.__setFocusedCalls;
  return calls.length > 0 ? calls[calls.length - 1] : [];
});

test('a collapsed terminal panel drops its session from the focused set', async () => {
  await waitForViteReady(VITE_URL);
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfig());
    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });

    // Expanded: the panel has a live terminal, so main must stream to it.
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => latestFocusedSet(page), { timeout: 10000 }).toContain(SESSION_ID);

    // Collapse via the real chevron, the way a user does.
    await page.locator('button[title^="Collapse terminal panel"]').click();
    // The panel unmounts its terminal ~200ms after the collapse starts (the height
    // animation), and the focused set is republished off that.
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'hidden', timeout: 10000 });

    await expect.poll(() => latestFocusedSet(page), { timeout: 10000 }).not.toContain(SESSION_ID);

    // Expanding brings it back, or the terminal would stay silent after reopening.
    await page.locator('button[title^="Expand terminal panel"]').click();
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => latestFocusedSet(page), { timeout: 10000 }).toContain(SESSION_ID);
  } finally {
    await browser.close();
  }
});
