/**
 * UI coverage for proactive recall in task detail (`TaskPriorWork`).
 *
 * The load-bearing case is the SILENT one. This panel appears on every task
 * detail, and most tasks have no prior work near them; a permanent empty
 * section (or a spinner, or a header with nothing under it) would be worse than
 * not having the feature. So "renders nothing" is a behaviour worth pinning,
 * not an absence of behaviour.
 */

import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

function hit(sessionId: string, title: string, snippet: string): string {
  return `{ docKey: 'conversation::${sessionId}', sessionId: '${sessionId}', taskId: 'other-task', taskTitle: ${JSON.stringify(title)}, agentName: 'claude', snippet: ${JSON.stringify(snippet)}, score: 0.9, matchKind: 'hybrid', matchCount: 2, turnTs: null }`;
}

const RUN_SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PROJECT_ID = `proj-prior-${RUN_SUFFIX}`;
const TASK_ID = `task-prior-${RUN_SUFFIX}`;

/** Seed a project, lanes, and one To Do task. Without a project the app shows
 *  the Welcome screen and there is no task card to open. */
function preConfig(relatedLiteral: string): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Prior Work Test',
        path: '/mock/prior-work-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-prior-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: 'Terminal drops scrollback on resize',
        description: 'Make the terminal stop dropping scrollback on resize.',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: null,
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

      return { currentProjectId: '${PROJECT_ID}', memoryRelatedToTask: ${relatedLiteral} };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/** Open the first task card's detail window. A single click opens it; the
 *  dialog mounting is what populates the window store. */
async function openFirstTask(page: Page): Promise<void> {
  const card = page.locator('[data-task-id]').first();
  await card.waitFor({ state: 'visible', timeout: 15000 });
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').first()
    .waitFor({ state: 'visible', timeout: 10000 });
}

test.describe('task prior work', () => {
  test('renders nothing when there is no prior work', async () => {
    const { browser, page } = await launchWithState(preConfig('[]'));
    try {
      await openFirstTask(page);
      // Give the async recall fetch time to resolve and (correctly) do nothing.
      await expect
        .poll(async () => page.evaluate(
          () => (window as unknown as { __mockRelatedToTaskCalls?: unknown[] }).__mockRelatedToTaskCalls?.length ?? 0,
        ))
        .toBeGreaterThan(0);
      await expect(page.locator('[data-testid="task-prior-work"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('summarises prior work and expands to the conversations', async () => {
    const related = `[${hit('s-1', 'Terminal resize debounce', 'the 200ms PTY resize debounce')}, ${hit('s-2', 'ConPTY width drift', 'grandchild geometry frozen')}]`;
    const { browser, page } = await launchWithState(preConfig(related));
    try {
      await openFirstTask(page);
      const panel = page.locator('[data-testid="task-prior-work"]');
      await expect(panel).toBeVisible();
      // Collapsed by default: it must not push the task's own content down.
      await expect(panel).toContainText('2 earlier conversations about this');
      await expect(page.locator('[data-testid="task-prior-work-item"]')).toHaveCount(0);

      await page.locator('[data-testid="task-prior-work-toggle"]').click();
      await expect(page.locator('[data-testid="task-prior-work-item"]')).toHaveCount(2);
      await expect(panel).toContainText('Terminal resize debounce');
      await expect(panel).toContainText('ConPTY width drift');
    } finally {
      await browser.close();
    }
  });

  test('opening a prior conversation hands its session to the viewer', async () => {
    const related = `[${hit('s-77', 'Terminal resize debounce', 'the 200ms PTY resize debounce')}]`;
    const { browser, page } = await launchWithState(preConfig(related));
    try {
      await openFirstTask(page);
      await page.locator('[data-testid="task-prior-work-toggle"]').click();
      await page.locator('[data-testid="task-prior-work-item"]').first().click();

      await expect
        .poll(async () => page.evaluate(
          () => (window as unknown as { __zustandStores?: { session?: { getState: () => { conversationSessionId: string | null } } } })
            .__zustandStores?.session?.getState().conversationSessionId ?? null,
        ))
        .toBe('s-77');
    } finally {
      await browser.close();
    }
  });

  test('renders one row per hit it is given, and adds none of its own', async () => {
    // Retrieval collapses to one hit per SESSION, and a task usually has
    // several, so the raw list repeats the same task title back at the user -
    // which reads as a bug. The unit here is the task. The mock returns what
    // main would already have deduped, so this pins only the rendering side:
    // two distinct hits become two rows with two distinct titles. The dedupe
    // itself is main's, and is not asserted here.
    const related = `[${hit('s-1', 'Terminal resize debounce', 'first session')}, ${hit('s-2', 'ConPTY width drift', 'other work')}]`;
    const { browser, page } = await launchWithState(preConfig(related));
    try {
      await openFirstTask(page);
      await page.locator('[data-testid="task-prior-work-toggle"]').click();
      const items = page.locator('[data-testid="task-prior-work-item"]');
      await expect(items).toHaveCount(2);
      const titles = await items.allInnerTexts();
      const firstLines = titles.map((text) => text.split('\n')[0]);
      expect(new Set(firstLines).size).toBe(firstLines.length);
    } finally {
      await browser.close();
    }
  });

  test('uses singular wording for a single result', async () => {
    const related = `[${hit('s-9', 'Only one', 'snippet')}]`;
    const { browser, page } = await launchWithState(preConfig(related));
    try {
      await openFirstTask(page);
      await expect(page.locator('[data-testid="task-prior-work"]')).toContainText('1 earlier conversation about this');
    } finally {
      await browser.close();
    }
  });
});
