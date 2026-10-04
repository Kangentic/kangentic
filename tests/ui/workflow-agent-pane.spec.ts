/**
 * The Workflows view's agent pane (#732, boards 1b, 2c and J2): opening a
 * workflow opens its agent in the left pane, the pane pauses and resumes it,
 * folds to a strip, says why when the agent cannot run, and while the agent is
 * mid-turn the plan waits: Start and Add task are disabled with the reason and
 * the canvas says the agent is working.
 *
 * The mock's agentOpen answers as main's workflow-agent.ts does: a transient
 * session carrying `workflowId`. Activity is driven with __mockFireActivity.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflow-agent-proj';
const WORKFLOW_ID = 'wf-draft';

function seedScript(options: { unavailable?: string }): string {
  const draft = {
    workflow: {
      id: WORKFLOW_ID, title: 'Theme tokens', state: 'draft', color_slot: 2,
      draft: {
        tasks: [{
          key: 'task-1', title: 'Token table', description: 'Planned.', project_id: null, existing_task_id: null,
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
          labels: [], priority: 0, canvas_x: null, canvas_y: null,
        }],
        links: [],
      },
    },
  };
  return `
    window.__mockWorkflows = ${JSON.stringify([draft])};
    ${options.unavailable ? `window.__mockWorkflowAgentUnavailable = ${JSON.stringify(options.unavailable)};` : ''}
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(options: { unavailable?: string; width?: number } = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: options.width ?? 1700, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(options));
  await page.goto(VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);

/** The workflow agent's session id, read off its mounted terminal. */
async function agentSessionId(page: Page): Promise<string> {
  const handle = await page.waitForFunction(() => (
    document.querySelector('[data-testid="workflow-agent-terminal-pane"]')?.getAttribute('data-session-id') ?? null
  ));
  return String(await handle.jsonValue());
}

test('opening a workflow opens its agent in the pane, and Pause and Resume stop and restart it', async () => {
  const { browser, page } = await launch();
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    await expect(pane).toBeVisible();
    await expect(pane).toContainText('Workflow agent');
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    const sessionId = await agentSessionId(page);
    // Its bytes are streamed here: the pane's session is in the focused set.
    await expect.poll(() => page.evaluate((id) => {
      const calls = window.electronAPI.sessions.__setFocusedCalls;
      return calls.length > 0 && calls[calls.length - 1].includes(id);
    }, sessionId)).toBe(true);

    await byTestId(page, 'workflow-agent-toggle').click();
    await expect(byTestId(page, 'workflow-agent-resume')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    await byTestId(page, 'workflow-agent-resume').click();
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('the pane folds to a strip, which unmounts its terminal, and back', async () => {
  const { browser, page } = await launch();
  try {
    await byTestId(page, 'workflow-agent-pane-collapse').click();
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-collapsed', 'true');
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    await byTestId(page, 'workflow-agent-pane-expand').click();
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-collapsed', 'false');
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('while the agent works, Start and Add task wait with the reason, and the canvas says why', async () => {
  const { browser, page } = await launch();
  try {
    const sessionId = await agentSessionId(page);
    await expect(byTestId(page, 'workflow-agent-working')).toHaveAttribute('data-working', 'false');

    await page.evaluate(([id, projectId, workflowId]) => {
      window.__mockFireActivity(id, 'thinking', null, projectId, workflowId);
    }, [sessionId, PROJECT_ID, WORKFLOW_ID]);
    await expect(byTestId(page, 'workflow-agent-working')).toHaveAttribute('data-working', 'true');
    await expect(byTestId(page, 'workflow-agent-working')).toContainText('Workflow agent is working');
    await expect(byTestId(page, 'workflow-start')).toBeDisabled();
    await expect(byTestId(page, 'workflow-start')).toHaveAttribute('title', /Available when the workflow agent finishes/);
    await expect(byTestId(page, 'workflow-add-task')).toBeDisabled();
    await expect(byTestId(page, 'workflow-add-task')).toHaveAttribute('title', 'Available when the workflow agent finishes');

    await page.evaluate(([id, projectId, workflowId]) => {
      window.__mockFireActivity(id, 'idle', null, projectId, workflowId);
    }, [sessionId, PROJECT_ID, WORKFLOW_ID]);
    await expect(byTestId(page, 'workflow-agent-working')).toHaveAttribute('data-working', 'false');
    await expect(byTestId(page, 'workflow-start')).toBeEnabled();
    await expect(byTestId(page, 'workflow-add-task')).toBeEnabled();
  } finally {
    await browser.close();
  }
});

test('an agent that cannot run says why, with no terminal', async () => {
  const reason = 'Codex cannot be a workflow\'s agent, because Kangentic cannot launch it read-only. Plan on the canvas, or choose another default agent in Settings.';
  const { browser, page } = await launch({ unavailable: reason });
  try {
    await expect(byTestId(page, 'workflow-agent-unavailable')).toHaveText(reason);
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-toggle')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('Workflows folds the project sidebar, and leaving restores it at the width it had', async () => {
  const { browser, page } = await launch();
  try {
    const sidebar = byTestId(page, 'sidebar-area');
    await expect(sidebar).toHaveAttribute('data-open', 'false');
    await page.locator('[data-testid="view-toggle-board"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'true');
    const openWidth = await sidebar.evaluate((element) => (element as HTMLElement).style.width);

    // Open it inside Workflows: the fold lifts for that visit only.
    await page.locator('[data-testid="view-toggle-workflows"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'false');
    await page.locator('[data-testid="sidebar-expand-button"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'true');
    await expect.poll(() => sidebar.evaluate((element) => (element as HTMLElement).style.width)).toBe(openWidth);

    // A sidebar the user had closed stays closed in and out.
    await page.locator('[data-testid="view-toggle-board"]').click();
    await page.locator('button[title^="Hide sidebar"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'false');
    await page.locator('[data-testid="view-toggle-workflows"]').click();
    await page.locator('[data-testid="view-toggle-board"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'false');
  } finally {
    await browser.close();
  }
});

test('dragging the pane\'s edge widens it, and the width is kept', async () => {
  const { browser, page } = await launch();
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    await expect(pane).toHaveAttribute('data-floating', 'false');
    const before = await pane.evaluate((element) => element.getBoundingClientRect().width);
    // Window error events, which is how the browser reports a ResizeObserver
    // loop: resizing the canvas under React Flow must not raise one.
    await page.evaluate(() => {
      const errors: string[] = [];
      (window as unknown as { __paneDragErrors: string[] }).__paneDragErrors = errors;
      window.addEventListener('error', (event) => errors.push(event.message));
    });
    const handle = byTestId(page, 'workflow-agent-pane-resize');
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle has no box');
    const centerY = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, centerY);
    await page.mouse.down();
    // Paced one move per frame, as a hand moves; a burst of synthetic moves in
    // one frame is not a gesture a person can make.
    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(box.x + box.width / 2 + step * 20, centerY);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await page.mouse.up();
    expect(await page.evaluate(() => (window as unknown as { __paneDragErrors: string[] }).__paneDragErrors)).toEqual([]);
    await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).workflows?.agentPaneWidth ?? null))
      .toBeGreaterThan(before + 100);
    const after = await pane.evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before + 100);
  } finally {
    await browser.close();
  }
});

test('a window that jumps narrower floats the pane without a frame of zero-width canvas', async () => {
  const { browser, page } = await launch();
  try {
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-floating', 'false');
    // React Flow warns when its container has no width, which a docked pane
    // caused for the one layout pass before the body row's observer ran.
    const zeroSizeWarnings: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('parent container needs a width')) zeroSizeWarnings.push(message.text());
    });
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-floating', 'true');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(zeroSizeWarnings).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('in a narrow view the open pane lies over the canvas instead of taking its width', async () => {
  const { browser, page } = await launch({ width: 1100 });
  try {
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-floating', 'true');
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    // The canvas keeps a real width under it.
    const canvasWidth = await page.locator('.workflow-canvas').evaluate((element) => element.getBoundingClientRect().width);
    expect(canvasWidth).toBeGreaterThan(200);
  } finally {
    await browser.close();
  }
});
