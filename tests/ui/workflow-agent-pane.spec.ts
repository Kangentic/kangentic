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
import { waitForViteReady, gotoVite } from './helpers';

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
  await gotoVite(page, VITE_URL);
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

/** A CSS color as the page computes it, so a token and an element's own color compare as one string. */
async function computedColor(page: Page, cssColor: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, cssColor);
}

test('the pane\'s header sits on the raised fill, and its collapse control is named Collapse agent', async () => {
  const { browser, page } = await launch();
  try {
    const header = byTestId(page, 'workflow-agent-pane-header');
    await expect(header).toContainText('Workflow agent');
    expect(await header.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(await computedColor(page, 'var(--color-surface-raised)'));
    const collapse = byTestId(page, 'workflow-agent-pane-collapse');
    await expect(collapse).toHaveAttribute('title', 'Collapse agent');
    await expect(collapse).toHaveAttribute('aria-label', 'Collapse agent');
  } finally {
    await browser.close();
  }
});

test('an agent whose conversation could not be resumed says it started a new one, until closed or resumed', async () => {
  const { browser, page } = await launch();
  try {
    const firstSessionId = await agentSessionId(page);
    const line = byTestId(page, 'workflow-agent-started-over');
    await expect(line).toHaveCount(0);

    // Main starts the agent over while the pane is open, after its open has answered.
    const restartedSessionId = await page.evaluate((workflowId) => window.__mockWorkflowAgentStartOver(workflowId), WORKFLOW_ID);
    expect(restartedSessionId).not.toBe(firstSessionId);
    await expect(line).toHaveText('The earlier conversation could not be resumed, so the agent started a new one.');
    await expect(byTestId(page, 'workflow-agent-terminal-pane')).toHaveAttribute('data-session-id', restartedSessionId);

    // Closed, it stays closed when the view is left and opened again.
    await byTestId(page, 'workflow-agent-started-over-dismiss').click();
    await expect(line).toHaveCount(0);
    await page.locator('[data-testid="view-toggle-board"]').click();
    await page.locator('[data-testid="view-toggle-workflows"]').click();
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await expect(line).toHaveCount(0);

    // Another start-over says it again; pausing keeps it, and a normal resume ends it.
    await page.evaluate((workflowId) => window.__mockWorkflowAgentStartOver(workflowId), WORKFLOW_ID);
    await expect(line).toBeVisible();
    await byTestId(page, 'workflow-agent-toggle').click();
    await expect(byTestId(page, 'workflow-agent-resume')).toBeVisible();
    await expect(line).toBeVisible();
    await byTestId(page, 'workflow-agent-resume').click();
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    // Main pushes a change on each of the resumed agent's activity edges; the mock is told to.
    await page.evaluate(([projectId, workflowId]) => window.__mockFireWorkflowChanged({ projectId, workflowId }), [PROJECT_ID, WORKFLOW_ID]);
    await expect(line).toHaveCount(0);
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

    // Where each sits: the label top left, clear of Add task at the bottom
    // center, and the two view tools side by side at the bottom left.
    const boxes = await page.evaluate(() => {
      const rect = (testId: string) => {
        const box = document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, centerX: box.left + box.width / 2 };
      };
      return {
        canvas: rect('workflow-canvas'),
        label: rect('workflow-agent-working-label'),
        addTask: rect('workflow-add-task'),
        fitView: rect('workflow-fit-view'),
        autoLayout: rect('workflow-auto-layout'),
      };
    });
    expect(boxes.label.left - boxes.canvas.left).toBeLessThan(24);
    expect(boxes.label.top - boxes.canvas.top).toBeLessThan(24);
    expect(Math.abs(boxes.addTask.centerX - boxes.canvas.centerX)).toBeLessThan(4);
    expect(boxes.canvas.bottom - boxes.addTask.bottom).toBeLessThan(40);
    expect(boxes.autoLayout.left - boxes.fitView.right).toBeLessThan(12);
    expect(boxes.autoLayout.right).toBeLessThan(boxes.addTask.left);

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

test('a sidebar opened inside Workflows stays open for that visit, and the next visit folds it again', async () => {
  const { browser, page } = await launch();
  try {
    const sidebar = byTestId(page, 'sidebar-area');
    const savedVisible = () => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).sidebarVisible);
    await expect(sidebar).toHaveAttribute('data-open', 'false');
    // The fold is for the view only: the saved choice is still "open".
    expect(await savedVisible()).not.toBe(false);

    // Open it from the strip. It stays open through what else the view does,
    // here the agent pane folding to its strip and back (a re-layout of the view).
    await page.locator('[data-testid="sidebar-expand-button"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'true');
    await byTestId(page, 'workflow-agent-pane-collapse').click();
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-collapsed', 'true');
    await byTestId(page, 'workflow-agent-pane-expand').click();
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-collapsed', 'false');
    await expect(sidebar).toHaveAttribute('data-open', 'true');
    // Lifting the fold wrote nothing: it was never the saved choice.
    expect(await savedVisible()).not.toBe(false);

    // Back on the board it is the user's own choice, open.
    await page.locator('[data-testid="view-toggle-board"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'true');

    // A new visit folds it again, though it was open the last time.
    await page.locator('[data-testid="view-toggle-workflows"]').click();
    await expect(byTestId(page, 'workflows-view')).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-open', 'false');
    expect(await savedVisible()).not.toBe(false);
  } finally {
    await browser.close();
  }
});

/**
 * Drags the pane's edge by `distance` pixels inside the page, one mousemove per
 * animation frame over 20 frames, which is how Chromium delivers a real drag at
 * the display's rate. A move per CDP round trip is slower than a hand and hid
 * the error this catches. Returns the window error events raised meanwhile,
 * which is how the browser reports a ResizeObserver loop.
 */
async function dragPaneEdge(page: Page, distance: number): Promise<string[]> {
  return page.evaluate(async (dragDistance) => {
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener('error', onError);
    const handle = document.querySelector('[data-testid="workflow-agent-pane-resize"]') as HTMLElement;
    const box = handle.getBoundingClientRect();
    const startX = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const frames = 20;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: startX, clientY: y }));
    for (let frame = 1; frame <= frames; frame++) {
      await nextFrame();
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: startX + (dragDistance * frame) / frames, clientY: y }));
    }
    await nextFrame();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX + dragDistance, clientY: y }));
    await nextFrame();
    await nextFrame();
    window.removeEventListener('error', onError);
    return errors;
  }, distance);
}

test('the picker\'s row says what the workflow agent is doing', async () => {
  const { browser, page } = await launch();
  try {
    await agentSessionId(page);
    // Main pushes a change on each of the agent's activity edges; the mock is told to.
    await page.evaluate(([projectId, workflowId]) => window.__mockFireWorkflowChanged({ projectId, workflowId }), [PROJECT_ID, WORKFLOW_ID]);
    await byTestId(page, 'workflow-picker').click();
    const row = page.locator(`[data-testid="workflow-picker-option"][data-workflow-id="${WORKFLOW_ID}"]`);
    await expect(row.locator('[data-testid="workflow-picker-note"]')).toHaveText('Agent idle');

    await page.keyboard.press('Escape');
    await byTestId(page, 'workflow-agent-toggle').click();
    await expect(byTestId(page, 'workflow-agent-resume')).toBeVisible();
    await page.evaluate(([projectId, workflowId]) => window.__mockFireWorkflowChanged({ projectId, workflowId }), [PROJECT_ID, WORKFLOW_ID]);
    await byTestId(page, 'workflow-picker').click();
    await expect(row.locator('[data-testid="workflow-picker-note"]')).toHaveText('Agent paused');
  } finally {
    await browser.close();
  }
});

test('the pane opens the agent\'s conversation once it has one', async () => {
  const { browser, page } = await launch();
  try {
    await agentSessionId(page);
    // The summary carries the conversation the workflow now keeps.
    await page.evaluate(([projectId, workflowId]) => window.__mockFireWorkflowChanged({ projectId, workflowId }), [PROJECT_ID, WORKFLOW_ID]);
    const button = byTestId(page, 'workflow-agent-conversation');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(byTestId(page, 'conversation-window')).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('Workflows hides the bottom panel, and the board gets it back', async () => {
  const { browser, page } = await launch();
  try {
    await expect(byTestId(page, 'terminal-panel-container')).toHaveCount(0);
    await page.locator('[data-testid="view-toggle-board"]').click();
    await expect(byTestId(page, 'terminal-panel-container')).toHaveCount(1);
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
    expect(await dragPaneEdge(page, 120)).toEqual([]);
    await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).workflows?.agentPaneWidth ?? null))
      .toBeGreaterThan(before + 100);
    const after = await pane.evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before + 100);
  } finally {
    await browser.close();
  }
});

test('a docked drag stops where the canvas keeps its minimum, so the pane stays docked', async () => {
  const { browser, page } = await launch();
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    await expect(pane).toHaveAttribute('data-floating', 'false');
    expect(await dragPaneEdge(page, 700)).toEqual([]);
    await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).workflows?.agentPaneWidth ?? null))
      .not.toBeNull();
    await expect(pane).toHaveAttribute('data-floating', 'false');
    // 400 is the canvas minimum beside a docked pane (WORKFLOW_CANVAS_MIN_WIDTH).
    const canvasWidth = await page.locator('.workflow-canvas').evaluate((element) => element.getBoundingClientRect().width);
    expect(canvasWidth).toBeGreaterThanOrEqual(399);
    await expect(byTestId(page, 'workflow-inspector')).toBeInViewport({ ratio: 1 });
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
