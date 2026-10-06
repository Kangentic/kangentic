/**
 * A Workflows canvas card is laid out at a fixed height per density
 * (`CANVAS_CARD_HEIGHT`), so the layout knows every card's height before React
 * Flow measures it. That height has to hold the busiest card the board draws:
 * a PR row, the agent's trail, a row of labels and the context bar together.
 * When it did not, the labels lost their bottom edge at default density and
 * were cut in half at comfortable (the sign-off review's finding 1).
 *
 * The check is relative, never a pixel value: each card's content, laid out
 * with its height lifted, must fit the height the canvas gives it
 * (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflows-card-fit-proj';

interface SeedTask {
  id: number;
  title: string;
  description: string;
  /** Index into the default columns: 0 To Do, 2 Executing, 3 Code Review, 5 Merge, 6 Done. */
  lane: number;
  labels: string[];
  pr?: number;
  session?: { activity: 'thinking' | 'idle'; trail: string[] };
}

const TASKS: SeedTask[] = [
  { id: 411, title: 'Budget table and repository', description: 'Add a budgets table with per-task limits.', lane: 6, labels: [] },
  {
    id: 413, title: 'Cost roll-up per task', description: 'Roll each session\'s cost up to its task.', lane: 5, labels: ['budgets', 'stats'], pr: 1291,
    session: { activity: 'thinking', trail: ['Reading the cost roll-up.', 'Summing each session into its task, and writing the migration test against a real database now.'] },
  },
  {
    id: 416, title: 'MCP: budgets in board_summary', description: 'Add budget, spent and remaining to the summary.', lane: 3, labels: ['mcp'],
    session: { activity: 'idle', trail: ['Reviewed the summary serializer.', 'Two findings need your call: show remaining as a percent or in dollars, and whether archived tasks count.'] },
  },
  { id: 415, title: 'Card badge when a task passes its budget', description: 'Show spent against budget in the card footer: amber at 80 percent, red once the hard cap pauses the agent.', lane: 0, labels: ['ui', 'budgets'] },
];

function seedScript(): string {
  return `
    window.__mockWorkflows = [{ workflow: { id: 'wf-fit', title: 'Usage budgets', state: 'running', draft: null, color_slot: 5 } }];
    window.__mockWorkflowLinks = [
      { workflow_id: 'wf-fit', blocker_task_id: 't411', blocked_task_id: 't413' },
      { workflow_id: 'wf-fit', blocker_task_id: 't411', blocked_task_id: 't416' },
      { workflow_id: 'wf-fit', blocker_task_id: 't413', blocked_task_id: 't415' },
    ];
    window.__mockPreConfigure(function (state) {
      var ts = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'card-fit', path: '/mock/card-fit', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'fit-lane-' + index, position: index, created_at: ts }));
      });
      ${JSON.stringify(TASKS)}.forEach(function (spec, index) {
        var sessionId = spec.session ? 'fit-sess-' + spec.id : null;
        var task = {
          id: 't' + spec.id, display_id: spec.id, title: spec.title, description: spec.description,
          swimlane_id: 'fit-lane-' + spec.lane, position: index, agent: 'claude', session_id: sessionId, worktree_path: null, branch_name: null,
          pr_number: spec.pr || null, pr_url: spec.pr ? 'https://github.com/example/repo/pull/' + spec.pr : null,
          pr_state: spec.pr ? 'open' : null, pr_merge_readiness: spec.pr ? 'ready' : null,
          base_branch: null, use_worktree: 0, labels: spec.labels, priority: 0, attachment_count: 0,
          archived_at: spec.lane === 6 ? ts : null, workflow_id: 'wf-fit', workflow_project_id: '${PROJECT_ID}',
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
          created_at: ts, updated_at: ts,
        };
        if (task.archived_at) state.archivedTasks.push(task); else state.tasks.push(task);
        if (spec.session) {
          state.sessions.push({ id: sessionId, taskId: task.id, projectId: '${PROJECT_ID}', pid: 4000 + spec.id, status: 'running', shell: 'bash', cwd: '/mock/card-fit', startedAt: ts, exitCode: null, resuming: false, agentSessionId: 'agent-' + spec.id });
          state.activityCache[sessionId] = spec.session.activity;
          state.messageTrailCache[sessionId] = spec.session.trail.map(function (text, line) { return { uuid: sessionId + '-' + line, ts: line + 1, text: text }; });
        }
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript());
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => typeof (window as unknown as { __mockFireUsage?: unknown }).__mockFireUsage === 'function');
  // Each running session's context bar.
  for (const task of TASKS) {
    if (!task.session) continue;
    await page.evaluate(({ sessionId, projectId }) => {
      (window as unknown as { __mockFireUsage: (id: string, usage: unknown, projectId: string) => void }).__mockFireUsage(sessionId, {
        model: { id: 'claude-opus-5', displayName: 'Opus 5' },
        contextWindow: { usedPercentage: 42, usedTokens: 420000, cacheTokens: 0, totalInputTokens: 411600, totalOutputTokens: 8400, contextWindowSize: 1000000 },
        cost: { totalCostUsd: 0.5, totalDurationMs: 18000 },
      }, projectId);
    }, { sessionId: `fit-sess-${task.id}`, projectId: PROJECT_ID });
  }
  return { browser, page };
}

const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

/** Every canvas card's own height against the height its content needs with that height lifted. */
async function fits(page: Page): Promise<Array<{ key: string; fixed: number; natural: number }>> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workflow-canvas-card"]')).map((element) => {
    const fixed = element.offsetHeight;
    const previous = element.style.height;
    element.style.height = 'auto';
    const natural = element.offsetHeight;
    element.style.height = previous;
    return { key: element.dataset.workflowTaskKey ?? '', fixed, natural };
  }));
}

test.describe('Workflows canvas card height', () => {
  for (const density of ['compact', 'default', 'comfortable'] as const) {
    test(`the busiest card fits its fixed height at ${density} density: PR, trail, labels and context bar`, async () => {
      test.setTimeout(30000);
      const { browser, page } = await launch();
      try {
        await page.evaluate((value) => {
          const stores = (window as unknown as { __zustandStores: { config: { getState: () => { updateConfig: (partial: object) => Promise<unknown> } } } }).__zustandStores;
          return stores.config.getState().updateConfig({ cardDensity: value });
        }, density);
        await page.locator('[data-testid="view-toggle-workflows"]').click();
        await expect(page.locator('[data-testid="workflow-canvas-card"]')).toHaveCount(4);
        // The busiest card is drawn whole before it is measured: its trail, and
        // (above compact, which drops both) its PR row and context bar.
        await expect(card(page, 't413').getByText('Summing each session', { exact: false })).toBeVisible();
        if (density !== 'compact') {
          await expect(card(page, 't413').locator('[data-testid="task-card-pr-link"]')).toBeVisible();
          await expect(card(page, 't413')).toContainText('42%');
        }
        await expect.poll(async () => (await fits(page)).filter((row) => row.natural > row.fixed)).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }
});
