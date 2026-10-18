/**
 * A Workflows canvas card is as tall as its content, as a board card is (the
 * user's call, 2026-10-07: one fixed height per density left a planned card
 * half empty). The layout stacks each column from the heights React Flow
 * measures, so a card that grows re-spaces its column instead of running
 * into the card below it.
 *
 * Every check is relative, never a pixel value: a card against its own
 * content, two cards against each other (.claude/rules/cross-platform-parity.md).
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

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

// #413 and #416 both wait for #411, so the layout stacks them in one column.
const TASKS: SeedTask[] = [
  { id: 411, title: 'Budget table and repository', description: 'Add a budgets table with per-task limits.', lane: 6, labels: [] },
  {
    id: 413, title: 'Cost roll-up per task', description: 'Roll each session\'s cost up to its task.', lane: 5, labels: ['budgets', 'stats'], pr: 1291,
    session: { activity: 'thinking', trail: ['Reading the cost roll-up.', 'Summing each session into its task, and writing the migration test against a real database now.'] },
  },
  {
    id: 416, title: 'MCP: budgets in board_summary', description: 'Add budget, spent and remaining to the summary.', lane: 3, labels: [],
    session: { activity: 'idle', trail: ['Reviewed the summary serializer.', 'Two findings need your call: show remaining as a percent or in dollars, and whether archived tasks count.'] },
  },
  { id: 415, title: 'Card badge when a task passes its budget', description: 'Show spent against budget in the card footer.', lane: 0, labels: [] },
];

function seedScript(): string {
  return `
    // Planned by its own workflow agent, so the pane starts it on open.
    window.__mockWorkflows = [{ workflow: { id: 'wf-fit', title: 'Usage budgets', state: 'running', draft: null, color_slot: 5, agent_name: 'claude' } }];
    window.__mockWorkflowLinks = [
      { workflow_id: 'wf-fit', blocker_task_id: 't411', blocked_task_id: 't413' },
      { workflow_id: 'wf-fit', blocker_task_id: 't411', blocked_task_id: 't416' },
      { workflow_id: 'wf-fit', blocker_task_id: 't413', blocked_task_id: 't415' },
    ];
    window.__mockPreConfigure(function (state) {
      var seededAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'card-fit', path: '/mock/card-fit', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: seededAt, created_at: seededAt });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'fit-lane-' + index, position: index, created_at: seededAt }));
      });
      ${JSON.stringify(TASKS)}.forEach(function (spec, index) {
        var sessionId = spec.session ? 'fit-sess-' + spec.id : null;
        var task = {
          id: 't' + spec.id, display_id: spec.id, title: spec.title, description: spec.description,
          swimlane_id: 'fit-lane-' + spec.lane, position: index, agent: 'claude', session_id: sessionId, worktree_path: null, branch_name: null,
          pr_number: spec.pr || null, pr_url: spec.pr ? 'https://github.com/example/repo/pull/' + spec.pr : null,
          pr_state: spec.pr ? 'open' : null, pr_merge_readiness: spec.pr ? 'ready' : null,
          base_branch: null, use_worktree: 0, labels: spec.labels, priority: 0, attachment_count: 0,
          archived_at: spec.lane === 6 ? seededAt : null, workflow_id: 'wf-fit', workflow_project_id: '${PROJECT_ID}',
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], canvas_x: null, canvas_y: null,
          created_at: seededAt, updated_at: seededAt,
        };
        if (task.archived_at) state.archivedTasks.push(task); else state.tasks.push(task);
        if (spec.session) {
          state.sessions.push({ id: sessionId, taskId: task.id, projectId: '${PROJECT_ID}', pid: 4000 + spec.id, status: 'running', shell: 'bash', cwd: '/mock/card-fit', startedAt: seededAt, exitCode: null, resuming: false, agentSessionId: 'agent-' + spec.id });
          state.activityCache[sessionId] = spec.session.activity;
          state.messageTrailCache[sessionId] = spec.session.trail.map(function (text, line) { return { uuid: sessionId + '-' + line, ts: line + 1, text: text }; });
        }
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(density: 'compact' | 'default' | 'comfortable'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript());
  // A ResizeObserver loop reaches the page as a window error event, not an exception.
  await page.addInitScript(() => {
    const win = window as unknown as { __windowErrors: string[] };
    win.__windowErrors = [];
    window.addEventListener('error', (event) => { win.__windowErrors.push(event.message); });
  });
  await gotoVite(page, VITE_URL);
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
  return { browser, page };
}

const card = (page: Page, key: string) => page.locator(`[data-testid="workflow-canvas-card"][data-workflow-task-key="${key}"]`);

interface CardBox { key: string; top: number; bottom: number; left: number; height: number; natural: number }

/** Every card's box on screen, and the height its content needs with any height lifted. */
async function cardBoxes(page: Page): Promise<CardBox[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workflow-canvas-card"]')).map((element) => {
    const box = element.getBoundingClientRect();
    const height = element.offsetHeight;
    const previous = element.style.height;
    element.style.height = 'auto';
    const natural = element.offsetHeight;
    element.style.height = previous;
    return { key: element.dataset.workflowTaskKey ?? '', top: box.top, bottom: box.bottom, left: box.left, height, natural };
  }));
}

const windowErrors = (page: Page) => page.evaluate(() => (window as unknown as { __windowErrors: string[] }).__windowErrors);

/** Every card's own height and its node's place on the canvas, by task key. */
async function heightsAndPlaces(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).map((element) => {
    const cardElement = element.querySelector<HTMLElement>('[data-testid="workflow-canvas-card"]');
    return [element.dataset.id ?? '', `${cardElement?.offsetHeight} at ${element.style.transform}`];
  })));
}

/** Pairs of cards in one column (same left edge) whose boxes overlap. */
function overlaps(boxes: CardBox[]): string[] {
  const found: string[] = [];
  for (const upper of boxes) {
    for (const lower of boxes) {
      if (upper === lower || Math.abs(upper.left - lower.left) > 1 || upper.top > lower.top) continue;
      if (upper.bottom > lower.top + 0.5) found.push(`${upper.key} over ${lower.key}`);
    }
  }
  return found;
}

test.describe('Workflows canvas card height', () => {
  for (const density of ['compact', 'default', 'comfortable'] as const) {
    test(`a card is as tall as its content at ${density} density, and no two in a column overlap`, async () => {
      test.setTimeout(30000);
      const { browser, page } = await launch(density);
      try {
        await expect.poll(async () => (await cardBoxes(page)).filter((box) => Math.abs(box.natural - box.height) > 1).map((box) => box.key)).toEqual([]);
        const boxes = await cardBoxes(page);
        const height = (key: string) => boxes.find((box) => box.key === key)!.height;
        // A task waiting in To Do carries no agent message or context bar, so it
        // is shorter than the busy one, as on the board.
        expect(height('t415')).toBeLessThan(height('t413'));
        expect(overlaps(boxes)).toEqual([]);
        expect(await windowErrors(page)).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }

  test('a card that grows re-spaces its column instead of running into the card below', async () => {
    test.setTimeout(30000);
    const { browser, page } = await launch('default');
    try {
      await expect.poll(async () => overlaps(await cardBoxes(page))).toEqual([]);
      const before = (await cardBoxes(page)).find((box) => box.key === 't416')!.height;
      // Labels land on #416, which shares a column with #413: its card gains a row.
      await page.evaluate(async (projectId) => {
        await window.electronAPI.tasks.update({ id: 't416', labels: ['mcp', 'summary', 'budgets'] });
        (window as unknown as { __mockFireTaskUpdatedByAgent: (taskId: string, title: string, project: string) => void })
          .__mockFireTaskUpdatedByAgent('t416', 'MCP: budgets in board_summary', projectId);
      }, PROJECT_ID);
      await expect.poll(async () => (await cardBoxes(page)).find((box) => box.key === 't416')!.height).toBeGreaterThan(before);
      await expect.poll(async () => overlaps(await cardBoxes(page))).toEqual([]);
      expect(await windowErrors(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  for (const density of ['default', 'comfortable'] as const) {
    test(`selecting a card moves nothing at ${density} density: every border is 1px`, async () => {
      test.setTimeout(30000);
      const { browser, page } = await launch(density);
      try {
        await expect.poll(async () => overlaps(await cardBoxes(page))).toEqual([]);
        // #416's session is the active one, which the board marks with a 2px
        // border; the canvas leaves that off (its terminal is the bottom
        // panel, which Workflows hides), so the selection is the one mark.
        await expect(card(page, 't416')).toHaveAttribute('data-selected', 'false');
        await expect(card(page, 't416')).toHaveCSS('border-top-width', '1px');
        const settled = await heightsAndPlaces(page);
        // Each click moves the selection to another card, the Done card among
        // them, so a height that follows the selection shows up as a change.
        for (const key of ['t415', 't416', 't411', 't413']) {
          await card(page, key).click();
          await expect(card(page, key)).toHaveAttribute('data-selected', 'true');
          await expect.poll(() => heightsAndPlaces(page)).toEqual(settled);
        }
        expect(await windowErrors(page)).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }
});
