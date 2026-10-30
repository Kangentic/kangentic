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
import { waitForViteReady, gotoVite, computedColor, settleFrames } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflow-agent-proj';
const WORKFLOW_ID = 'wf-draft';

/** Settings > Workflows > Workflow agent, complete, which every start needs. */
const WORKFLOW_AGENT = { agent: 'claude', model: 'haiku', effort: 'low' };

interface SeedOptions {
  unavailable?: string;
  /** The Workflow agent setting: complete by default, null for a first run with none chosen. */
  workflowAgent?: { agent: string | null; model: string | null; effort: string | null } | null;
  /** Main refuses the pane's first open with `setupNeeded`, though the setting is complete. */
  setupNeededOnce?: boolean;
  /** Patches over the mock's agent list, by agent name (`found: false` for a CLI that is not installed). */
  agentListOverrides?: Record<string, Record<string, unknown>>;
  /** Every agent-list read the renderer makes rejects, so its list never loads. Main's own start check still reads it. */
  rejectAgentList?: boolean;
  /**
   * The workflow as main left it after an earlier run: the agent it ran on and the
   * conversation id it kept (null when the id is not known), with that agent's
   * session already live. A live session is what keeps the mock's open from
   * recording the Workflow agent setting over the seeded agent, as it does for a
   * workflow with no conversation yet.
   */
  recordedRun?: { agentName: string; agentSessionId: string | null };
  /**
   * Another session created and planned the workflow over MCP: it has its task
   * and no agent recorded. Every other seed is a workflow its own agent planned.
   */
  plannedElsewhere?: boolean;
  /**
   * A second draft workflow, listed after the first, so the picker has two to
   * move between inside one launch. Planned by its own agent unless
   * `plannedElsewhere`, the same as the first.
   */
  secondWorkflow?: { plannedElsewhere: boolean };
}

const RECORDED_SESSION_ID = 'wf-draft-agent-session';
const SECOND_WORKFLOW_ID = 'wf-second';

/** A draft with one planned task. `agentFields` is what main recorded for its agent: nothing when another session planned it. */
function plannedDraftSeed(identity: { id: string; title: string; colorSlot: number; taskKey: string; taskTitle: string }, agentFields: Record<string, unknown>) {
  return {
    workflow: {
      id: identity.id, title: identity.title, state: 'draft', color_slot: identity.colorSlot,
      ...agentFields,
      draft: {
        tasks: [{
          key: identity.taskKey, title: identity.taskTitle, description: 'Planned.', project_id: null, existing_task_id: null,
          route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
          labels: [], priority: 0, canvas_x: null, canvas_y: null,
        }],
        links: [],
      },
    },
  };
}

function seedScript(options: SeedOptions): string {
  const workflowAgent = options.workflowAgent === undefined ? WORKFLOW_AGENT : options.workflowAgent;
  const recordedRun = options.recordedRun ?? null;
  // Planned by its own workflow agent unless `plannedElsewhere`: a plan with
  // no agent recorded opens with nothing started (main's planNoAgentHasSeen).
  const draft = plannedDraftSeed(
    { id: WORKFLOW_ID, title: 'Theme tokens', colorSlot: 2, taskKey: 'task-1', taskTitle: 'Token table' },
    recordedRun
      ? { agent_name: recordedRun.agentName, agent_session_id: recordedRun.agentSessionId, agent_cwd: '/mock/project' }
      : options.plannedElsewhere ? {} : { agent_name: 'claude' },
  );
  const seededWorkflows = [draft];
  if (options.secondWorkflow) {
    seededWorkflows.push(plannedDraftSeed(
      { id: SECOND_WORKFLOW_ID, title: 'Icon set', colorSlot: 3, taskKey: 'task-2', taskTitle: 'Icon table' },
      options.secondWorkflow.plannedElsewhere ? {} : { agent_name: 'claude' },
    ));
  }
  // The session row as main's workflow-agent.ts produces it (see the mock's makeMockWorkflowAgentSession).
  const recordedSession = {
    id: RECORDED_SESSION_ID, taskId: WORKFLOW_ID, projectId: PROJECT_ID, pid: null, status: 'running', shell: '/bin/bash',
    cwd: '/mock/project', startedAt: new Date().toISOString(), exitCode: null, resuming: false, transient: true,
    workflowId: WORKFLOW_ID, commandTerminalSlot: null, commandTerminalBranch: null, commandTerminalLabel: null,
    isolatedSwimlaneId: null, agentSessionId: recordedRun?.agentSessionId ?? null,
  };
  return `
    window.__mockWorkflows = ${JSON.stringify(seededWorkflows)};
    ${options.unavailable ? `window.__mockWorkflowAgentUnavailable = ${JSON.stringify(options.unavailable)};` : ''}
    ${options.setupNeededOnce ? 'window.__mockWorkflowAgentSetupNeededOnce = true;' : ''}
    ${options.agentListOverrides ? `window.__mockAgentListOverrides = ${JSON.stringify(options.agentListOverrides)};` : ''}
    ${options.rejectAgentList ? 'window.__mockAgentListRejects = true;' : ''}
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      ${workflowAgent ? `state.config.workflows = ${JSON.stringify(workflowAgent)};` : ''}
      ${recordedRun ? `state.sessions.push(${JSON.stringify(recordedSession)});` : ''}
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(options: SeedOptions & { width?: number; awaitAgentList?: boolean } = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: options.width ?? 1700, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(options));
  await gotoVite(page, VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  // The pane reads the Workflow agent setting only once the agent list is in
  // (its setup gap and its Settings hold are both null before then). A test that
  // pins what the pane does with the setting waits here, so its first read is
  // the real one and not a race against the boot's list load.
  if (options.awaitAgentList) {
    await page.waitForFunction(() => (window as unknown as { __zustandStores: { config: { getState: () => { agentListLoaded: boolean } } } })
      .__zustandStores.config.getState().agentListLoaded === true);
  }
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

test('the pane\'s header sits on the raised fill, and its collapse control is named Collapse agent', async () => {
  const { browser, page } = await launch();
  try {
    const header = byTestId(page, 'workflow-agent-pane-header');
    await expect(header).toContainText('Workflow agent');
    expect(await header.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(await computedColor(page, 'var(--color-surface-raised)'));
    const collapse = byTestId(page, 'workflow-agent-pane-collapse');
    await expect(collapse).toHaveAccessibleName('Collapse agent');
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

/**
 * Main's SESSION_ACTIVITY push for the workflow agent's session. A working
 * session carries no reason; a wait carries the state's own kind, started two
 * seconds ago, and the kind of a permission wait when the agent reported one.
 */
async function fireAgentActivity(page: Page, sessionId: string, state: 'thinking' | 'idle' | 'permission', waitKind?: 'question' | 'approval'): Promise<void> {
  await page.evaluate(({ id, projectId, workflowId, activityState, reportedKind }) => {
    const reason = activityState === 'thinking'
      ? null
      : { kind: activityState, since: Date.now() - 2000, ...(reportedKind ? { waitKind: reportedKind } : {}) };
    window.__mockFireActivity(id, activityState, reason, projectId, workflowId);
  }, { id: sessionId, projectId: PROJECT_ID, workflowId: WORKFLOW_ID, activityState: state, reportedKind: waitKind });
}

// The strip is what a folded pane leaves of the agent: its mark says what the
// agent needs, by the same function the board card asks (`agentActivityMark`).
// A wait of unknown kind and a question draw the same bubble, so the approval
// is the case that goes red when the strip stops reading the session's reason.
test('the folded strip draws the agent\'s wait as the card does: bubble for a question, shield for an approval, envelope for a finished turn', async () => {
  const { browser, page } = await launch();
  try {
    const sessionId = await agentSessionId(page);
    await byTestId(page, 'workflow-agent-pane-collapse').click();
    const pane = byTestId(page, 'workflow-agent-pane');
    await expect(pane).toHaveAttribute('data-collapsed', 'true');
    const strip = pane.locator('span[role="img"]');
    const mark = strip.locator('svg[data-mark]');
    // An agent nothing has pushed activity for rests as a finished turn.
    await expect(mark).toHaveAttribute('data-mark', 'agent-idle');
    await expect(strip).toHaveAccessibleName('Workflow agent is waiting for you');

    const waits: Array<{ label: string; waitKind?: 'question' | 'approval'; mark: string }> = [
      { label: 'a question', waitKind: 'question', mark: 'agent-question' },
      { label: 'an approval', waitKind: 'approval', mark: 'agent-approval' },
      { label: 'a wait of unknown kind', mark: 'agent-question' },
    ];
    for (const wait of waits) {
      await fireAgentActivity(page, sessionId, 'permission', wait.waitKind);
      await expect(mark, wait.label).toHaveAttribute('data-mark', wait.mark);
      await expect(strip, wait.label).toHaveAccessibleName('Workflow agent is waiting for you');
    }

    // The controls: a finished turn is the envelope, and a working agent the ring.
    await fireAgentActivity(page, sessionId, 'idle');
    await expect(mark).toHaveAttribute('data-mark', 'agent-idle');
    await fireAgentActivity(page, sessionId, 'thinking');
    await expect(mark).toHaveAttribute('data-mark', 'agent-working');
    await expect(strip).toHaveAccessibleName('Workflow agent is working');
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
    await expect(byTestId(page, 'workflow-start')).toHaveAccessibleDescription(/Available when the workflow agent finishes/);
    await expect(byTestId(page, 'workflow-add-task')).toBeDisabled();
    await expect(byTestId(page, 'workflow-add-task')).toHaveAccessibleDescription('Available when the workflow agent finishes');

    // Where each sits: the label top left, Add task in the bottom right corner,
    // and the two view tools side by side at the bottom left.
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
    expect(boxes.canvas.right - boxes.addTask.right).toBeLessThan(24);
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
  const reason = 'The workflow agent works through Kangentic\'s MCP server, which is off. Turn it on in Settings, MCP Server.';
  const { browser, page } = await launch({ unavailable: reason });
  try {
    await expect(byTestId(page, 'workflow-agent-unavailable')).toHaveText(reason);
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-toggle')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

/** Settings > Workflows > Workflow agent, written the way the settings card writes it. */
async function setWorkflowAgent(page: Page, workflows: { agent: string | null; model: string | null; effort: string | null }): Promise<void> {
  await page.evaluate((value) => window.electronAPI.config.set({ workflows: value }), workflows);
  await page.evaluate(() => (window as unknown as { __zustandStores: { config: { getState: () => { loadConfig: () => Promise<void> } } } })
    .__zustandStores.config.getState().loadConfig());
}

/** Open Settings from the pane's setup state, retrying until the Workflow agent card is on screen. */
async function openSettingsFromPane(page: Page): Promise<void> {
  await expect(async () => {
    if (!(await byTestId(page, 'settings-panel').isVisible())) await byTestId(page, 'workflow-agent-setup-open-settings').click();
    await expect(byTestId(page, 'settings-card-workflow-agent')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 12_000 });
}

test.describe('with no Workflow agent chosen', () => {
  // The bug this replaced: the pane started on the project's default agent at its
  // default model and effort (Opus at xhigh) while the user had set Haiku at low
  // for the Automation agent. Nothing starts until the Workflow agent is chosen.
  test('the pane asks for one in place of the terminal, and starts no agent', async () => {
    const { browser, page } = await launch({ workflowAgent: null });
    try {
      const setup = byTestId(page, 'workflow-agent-setup');
      await expect(setup).toBeVisible();
      await expect(setup).toContainText('Choose a workflow agent');
      await expect(setup).toContainText('It plans your workflows, and starts when you close Settings.');
      await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-agent-state', 'setup');
      await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
      await expect(byTestId(page, 'workflow-agent-toggle')).toHaveCount(0);
      const agentSessions = await page.evaluate(async () => (await window.electronAPI.sessions.list())
        .filter((session) => session.workflowId).length);
      expect(agentSessions).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('Open Settings lands on Workflows, Workflow agent first, and choosing an agent shows Model and Effort', async () => {
    const { browser, page } = await launch({ workflowAgent: null });
    try {
      await openSettingsFromPane(page);
      const cards = page.locator('[data-testid="settings-panel"] section[data-testid^="settings-card-"]');
      await expect(cards.first()).toHaveAttribute('data-testid', 'settings-card-workflow-agent');
      await expect(byTestId(page, 'workflow-agent-setting-model')).toHaveCount(0);

      await byTestId(page, 'workflow-agent-setting-agent').click();
      await byTestId(page, 'workflow-agent-setting-agent-option-claude').click();

      await expect(byTestId(page, 'workflow-agent-setting-model')).toBeVisible();
      await expect(byTestId(page, 'workflow-agent-setting-effort')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('the agent starts when Settings closes with the choice made, not while it is open', async () => {
    const { browser, page } = await launch({ workflowAgent: null });
    try {
      await openSettingsFromPane(page);
      await setWorkflowAgent(page, { agent: 'claude', model: 'haiku', effort: 'low' });
      // Complete, but Settings is still open: an Effort picked next must make the first run.
      await expect(byTestId(page, 'settings-card-workflow-agent').locator('[data-testid="workflow-agent-setting-effort"]')).toBeVisible();
      const setup = byTestId(page, 'workflow-agent-setup');
      await expect(setup).toBeVisible();
      // The held state says the choice is made and when the agent starts, and has no way
      // into the Settings panel that is already open. The "needed" state says neither: its
      // line reads "and starts", not "It starts".
      await expect(setup).toHaveAttribute('data-setting', 'chosen');
      await expect(setup).toContainText('Workflow agent chosen');
      await expect(setup).toContainText('It starts when you close Settings.');
      await expect(byTestId(page, 'workflow-agent-setup-open-settings')).toHaveCount(0);
      await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-agent-state', 'setup');
      await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect(byTestId(page, 'settings-panel')).toHaveCount(0);

      await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
      await expect(byTestId(page, 'workflow-agent-setup')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

/** How many times the pane has opened its agent. A Resume is not an open. */
async function agentOpenCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__mockWorkflowAgentOpenCount ?? 0);
}

/** Open Settings from the title bar, as a user does with the agent already running. */
async function openSettingsFromTitleBar(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await expect(byTestId(page, 'settings-panel')).toBeVisible();
}

/** Close Settings with Escape, and wait for the panel to go. */
async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(byTestId(page, 'settings-panel')).toHaveCount(0);
}

// Main checks the Workflow agent setting itself, so it can refuse a start the
// pane's own read let through (the pane's agent list was out of date). The pane
// then asks for the setting like a first run. Settings is where a refusal is
// fixed, so opening it forgets the refusal and the close that follows tries the
// open once more. Nothing else retries.
test('when main refuses a start the pane expected to run, it asks for the setting, and a Settings round trip retries the open once', async () => {
  const { browser, page } = await launch({ setupNeededOnce: true });
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    const setup = byTestId(page, 'workflow-agent-setup');
    // The setting is complete, so the pane opened the agent and main refused it.
    await expect(setup).toHaveAttribute('data-setting', 'needed');
    await expect(pane).toHaveAttribute('data-agent-state', 'setup');
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    expect(await agentOpenCount(page)).toBe(1);
    // A refusal is not retried on its own: a few frames is room for any effect to run.
    await settleFrames(page, 5);
    expect(await agentOpenCount(page)).toBe(1);

    // Opening Settings forgets the refusal and holds the start until it closes.
    await openSettingsFromPane(page);
    await expect(setup).toHaveAttribute('data-setting', 'chosen');
    expect(await agentOpenCount(page)).toBe(1);

    // Closing it tries once more, and main accepts.
    await closeSettings(page);
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await expect(setup).toHaveCount(0);
    await expect(pane).not.toHaveAttribute('data-agent-state', 'setup');
    expect(await agentOpenCount(page)).toBe(2);

    // The agent is running now, so another visit to Settings opens nothing.
    await openSettingsFromTitleBar(page);
    await closeSettings(page);
    await settleFrames(page, 5);
    expect(await agentOpenCount(page)).toBe(2);
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
  } finally {
    await browser.close();
  }
});

// Pause leaves the session in the list, so a Resume button stands in for the
// terminal. If the setting has since become incomplete, a Resume is one main
// would refuse, so the pane asks for the setting instead and offers neither.
test('a paused agent whose setting becomes incomplete shows the setup state, with no Pause or Resume', async () => {
  const { browser, page } = await launch();
  try {
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await byTestId(page, 'workflow-agent-toggle').click();
    await expect(byTestId(page, 'workflow-agent-resume')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-toggle')).toHaveCount(1);

    await setWorkflowAgent(page, { agent: null, model: null, effort: null });

    await expect(byTestId(page, 'workflow-agent-setup')).toHaveAttribute('data-setting', 'needed');
    await expect(byTestId(page, 'workflow-agent-pane')).toHaveAttribute('data-agent-state', 'setup');
    await expect(byTestId(page, 'workflow-agent-toggle')).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-resume')).toHaveCount(0);

    // Choosing the agent again gives the paused agent its Resume back.
    await setWorkflowAgent(page, WORKFLOW_AGENT);
    await expect(byTestId(page, 'workflow-agent-resume')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-toggle')).toHaveCount(1);
    await expect(byTestId(page, 'workflow-agent-setup')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// Main answers `setupNeeded` for an incomplete setting, so a pane that never gets
// an agent list is not stranded: it opens on the setting alone. Every agent-list
// read the renderer makes rejects here (the boot load, which dev StrictMode runs
// twice), so the store keeps its empty, not-loaded list for the whole page.
test('the pane starts its agent without waiting for the agent list', async () => {
  const { browser, page } = await launch({ rejectAgentList: true });
  try {
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    // The precondition this stands on: the pane never had a list to run its own check on.
    const listState = await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { config: { getState: () => { agentListLoaded: boolean; agentList: unknown[] } } };
      }).__zustandStores;
      const { agentListLoaded, agentList } = stores.config.getState();
      return { agentListLoaded, agentCount: agentList.length };
    });
    expect(listState).toEqual({ agentListLoaded: false, agentCount: 0 });
    await expect(byTestId(page, 'workflow-agent-setup')).toHaveCount(0);
    expect(await agentOpenCount(page)).toBe(1);
  } finally {
    await browser.close();
  }
});

// An agent whose CLI is not installed is no setup gap: the choice is made, and
// main's own detection says what is missing. The pane shows that reason, and a
// Settings round trip (where the user installs it or picks another) tries again.
test('an agent that is not installed says so, and a Settings round trip after installing it starts the agent', async () => {
  const { browser, page } = await launch({ agentListOverrides: { claude: { found: false } } });
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    const unavailable = byTestId(page, 'workflow-agent-unavailable');
    await expect(unavailable).toHaveText('Kangentic cannot find Claude Code on this machine.');
    await expect(pane).toHaveAttribute('data-agent-state', 'unavailable');
    await expect(byTestId(page, 'workflow-agent-setup')).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    expect(await agentOpenCount(page)).toBe(1);

    // The CLI is installed: main's next detection finds it. The pane's own agent list
    // is not refreshed, so the retry must not depend on it.
    await page.evaluate(() => { window.__mockAgentListOverrides = {}; });
    await openSettingsFromTitleBar(page);
    // Opening Settings drops the stale reason and holds the start.
    await expect(byTestId(page, 'workflow-agent-setup')).toHaveAttribute('data-setting', 'chosen');
    await expect(unavailable).toHaveCount(0);
    expect(await agentOpenCount(page)).toBe(1);

    await closeSettings(page);
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await expect(unavailable).toHaveCount(0);
    expect(await agentOpenCount(page)).toBe(2);
    await settleFrames(page, 5);
    expect(await agentOpenCount(page)).toBe(2);
  } finally {
    await browser.close();
  }
});

// Any agent that reaches Kangentic's MCP server per session can be the Workflow
// agent, read-only or not. A workflow planned by Codex starts its terminal and
// records Codex as the agent holding its conversation.
test('a Workflow agent that cannot launch read-only starts, and the workflow records it', async () => {
  const { browser, page } = await launch({
    workflowAgent: { agent: 'codex', model: 'gpt-5', effort: null },
    agentListOverrides: {
      codex: { found: true, path: '/usr/bin/codex', version: '1.0.0', capabilities: { supportsModelOverride: true, models: ['gpt-5'], effortLevels: [] } },
    },
  });
  try {
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-setup')).toHaveCount(0);
    // The workflow as main records it after the start (the store's summary is read before it).
    const recordedAgent = await page.evaluate(async ({ projectId, workflowId }) => {
      const summaries = await window.electronAPI.workflows.list(projectId);
      return summaries.find((summary) => summary.workflow.id === workflowId)?.workflow.agent_name ?? null;
    }, { projectId: PROJECT_ID, workflowId: WORKFLOW_ID });
    expect(recordedAgent).toBe('codex');
  } finally {
    await browser.close();
  }
});

/** The agent and conversation id the seeded workflow's summary carries, as the pane's store reads them. */
async function recordedRunOf(page: Page): Promise<{ agentName: string | null; agentSessionId: string | null }> {
  return page.evaluate(async ({ projectId, workflowId }) => {
    const summaries = await window.electronAPI.workflows.list(projectId);
    const workflow = summaries.find((summary) => summary.workflow.id === workflowId)?.workflow;
    return { agentName: workflow?.agent_name ?? null, agentSessionId: workflow?.agent_session_id ?? null };
  }, { projectId: PROJECT_ID, workflowId: WORKFLOW_ID });
}

// The terminal runs the agent main would resume: the one holding a conversation
// it can resume (its id is known), else the Workflow agent setting's. A workflow
// that ran on another agent but kept no id has nothing to resume, so main starts
// it on the setting's agent, and the terminal (whose image paste follows the
// agent) has to match it, not the stale name.
test('a workflow whose agent ran but kept no conversation id gets a terminal for the Workflow agent setting', async () => {
  const { browser, page } = await launch({
    workflowAgent: { agent: 'claude', model: 'haiku', effort: 'low' },
    recordedRun: { agentName: 'codex', agentSessionId: null },
  });
  try {
    // The seed took: the summary names codex as the agent that ran and holds no conversation.
    expect(await recordedRunOf(page)).toEqual({ agentName: 'codex', agentSessionId: null });
    const terminalPane = byTestId(page, 'workflow-agent-terminal-pane');
    await expect(terminalPane).toHaveAttribute('data-session-id', RECORDED_SESSION_ID);
    await expect(terminalPane).toHaveAttribute('data-agent-name', 'claude');
  } finally {
    await browser.close();
  }
});

test('a workflow whose conversation id is known gets a terminal for the agent that holds it, not the setting', async () => {
  const { browser, page } = await launch({
    workflowAgent: { agent: 'claude', model: 'haiku', effort: 'low' },
    recordedRun: { agentName: 'codex', agentSessionId: 'recorded-codex-conversation' },
  });
  try {
    expect(await recordedRunOf(page)).toEqual({ agentName: 'codex', agentSessionId: 'recorded-codex-conversation' });
    const terminalPane = byTestId(page, 'workflow-agent-terminal-pane');
    await expect(terminalPane).toHaveAttribute('data-session-id', RECORDED_SESSION_ID);
    await expect(terminalPane).toHaveAttribute('data-agent-name', 'codex');
  } finally {
    await browser.close();
  }
});

// The pane opens once per visit. Closing Settings starts only a pane that was
// waiting on the setting: an open on an agent that has exited resumes its
// conversation, which a Settings close (a theme change, say) must not do unasked.
test('an agent that exited stays exited when Settings opens and closes', async () => {
  const { browser, page } = await launch();
  try {
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await page.evaluate((workflowId) => window.__mockWorkflowAgentExit(workflowId), WORKFLOW_ID);
    await expect(byTestId(page, 'workflow-agent-resume')).toBeVisible();

    await page.locator('[data-testid="settings-button"]').click();
    await expect(byTestId(page, 'settings-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(byTestId(page, 'settings-panel')).toHaveCount(0);

    await expect(byTestId(page, 'workflow-agent-resume')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    const liveAgents = await page.evaluate(async () => (await window.electronAPI.sessions.list())
      .filter((session) => session.workflowId && session.status !== 'exited').length);
    expect(liveAgents).toBe(0);
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
    await page.locator('button[aria-label="Hide sidebar"]').click();
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

// Found dogfooding: every visit to Workflows began with the sidebar sliding
// shut over 200 ms and the view moving under it. The view's fold now lands in
// one frame both ways; the user's own toggle keeps its slide. The slide is three
// transitions, not one: the area's width and the fade of each of its two layers
// (the full sidebar and the collapsed rail over it). A layer left fading while
// the width snaps shows the sidebar's contents ghosting through the switch.
test('the view\'s fold lands in one frame both ways, and the sidebar\'s own toggle still slides', async () => {
  const { browser, page } = await launch();
  try {
    const sidebar = byTestId(page, 'sidebar-area');
    await expect(sidebar).toHaveAttribute('data-open', 'false');
    /**
     * Click a view toggle, then read the sidebar two frames later, inside one
     * task: the area's transition duration, then its two layers'.
     */
    const twoFramesAfter = (toggleTestId: string) => page.evaluate(async (testId) => {
      const area = document.querySelector<HTMLElement>('[data-testid="sidebar-area"]')!;
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        width: area.getBoundingClientRect().width,
        layerCount: area.children.length,
        durations: [area, ...Array.from(area.children)].map((element) => getComputedStyle(element).transitionDuration),
      };
    }, toggleTestId);
    /** The area's transition duration, then its two layers' (the full sidebar, the collapsed rail). */
    const slideDurations = () => sidebar.evaluate((element) => [element, ...Array.from(element.children)]
      .map((layer) => getComputedStyle(layer).transitionDuration));
    const SLIDING = ['0.2s', '0.2s', '0.2s'];
    const SNAPPED = ['0s', '0s', '0s'];

    // Board: back at its open width at once, with no transition running.
    await expect.poll(slideDurations).toEqual(SLIDING);
    const toBoard = await twoFramesAfter('view-toggle-board');
    // Two layers, so a markup change cannot leave the check reading none.
    expect(toBoard.layerCount).toBe(2);
    expect(toBoard.durations).toEqual(SNAPPED);
    await expect(sidebar).toHaveAttribute('data-open', 'true');
    const openWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(toBoard.width - openWidth)).toBeLessThan(2);

    // Workflows: the strip at once.
    await expect.poll(slideDurations).toEqual(SLIDING);
    const toWorkflows = await twoFramesAfter('view-toggle-workflows');
    expect(toWorkflows.layerCount).toBe(2);
    expect(toWorkflows.durations).toEqual(SNAPPED);
    expect(toWorkflows.width).toBeLessThan(40);

    // Once the switch settles the slide is back, on the width and both fades, for the toggle the user presses.
    await expect.poll(slideDurations).toEqual(SLIDING);
    await page.locator('[data-testid="sidebar-expand-button"]').click();
    await expect(sidebar).toHaveAttribute('data-open', 'true');
  } finally {
    await browser.close();
  }
});

// The bug: a plan saved with kangentic_save_workflow from a Command Terminal
// opened in the view with a new agent planning from the brief again, which held
// Start for its whole turn and could save over the finished plan.
test('a workflow another session created opens with no agent and the pane folded, and Ask for changes starts it', async () => {
  const { browser, page } = await launch({ plannedElsewhere: true });
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    const notice = byTestId(page, 'workflow-agent-plan-saved');
    // Folded to its strip for the plan's room, with no agent started.
    await expect(pane).toHaveAttribute('data-folded', 'true');
    await expect(notice).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    // Nothing holds the plan: Start and Add task are the user's from the first frame.
    await expect(byTestId(page, 'workflow-agent-working')).toHaveAttribute('data-working', 'false');
    await expect(byTestId(page, 'workflow-start')).toBeEnabled();
    await expect(byTestId(page, 'workflow-add-task')).toBeEnabled();

    // Expanded, the pane says why no agent runs, with no Pause or Resume and no conversation yet.
    await byTestId(page, 'workflow-agent-pane-expand').click();
    await expect(pane).toHaveAttribute('data-collapsed', 'false');
    await expect(pane).toHaveAttribute('data-agent-state', 'starts-on-request');
    await expect(notice.getByRole('heading')).toHaveText('The workflow agent has not seen this plan');
    await expect(byTestId(page, 'workflow-agent-toggle')).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-conversation')).toBeDisabled();

    // The next visit folds it again, and still starts nothing.
    await page.locator('[data-testid="view-toggle-board"]').click();
    await page.locator('[data-testid="view-toggle-workflows"]').click();
    await expect.poll(() => page.evaluate(() => window.__mockWorkflowAgentOpenCount)).toBeGreaterThanOrEqual(2);
    await expect(pane).toHaveAttribute('data-folded', 'true');
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);

    // Ask for changes starts the agent; once one has run, the pane opens as the user left it.
    await byTestId(page, 'workflow-agent-pane-expand').click();
    await byTestId(page, 'workflow-agent-ask-for-changes').click();
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await expect(notice).toHaveCount(0);
    await page.locator('[data-testid="view-toggle-board"]').click();
    await page.locator('[data-testid="view-toggle-workflows"]').click();
    await expect(pane).toHaveAttribute('data-collapsed', 'false');
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
  } finally {
    await browser.close();
  }
});

/** The workflow the view has selected, read off the workflow store. */
async function selectedWorkflowId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __zustandStores: { workflow: { getState: () => { selectedWorkflowId: string | null } } } })
    .__zustandStores.workflow.getState().selectedWorkflowId);
}

/** The pane's own collapse (the user's), which the fold never writes. */
async function agentPaneCollapsed(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __zustandStores: { workflow: { getState: () => { agentPaneCollapsed: boolean } } } })
    .__zustandStores.workflow.getState().agentPaneCollapsed);
}

/** Choose a workflow in the header's picker, and wait for the view to have it selected. */
async function pickWorkflow(page: Page, workflowId: string): Promise<void> {
  await byTestId(page, 'workflow-picker').click();
  await page.locator(`[data-testid="workflow-picker-option"][data-workflow-id="${workflowId}"]`).click();
  await expect.poll(() => selectedWorkflowId(page)).toBe(workflowId);
}

/** How many workflow agents have a session at all. A plan no agent has seen starts none. */
async function workflowAgentSessionCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.electronAPI.sessions.list()).filter((session) => session.workflowId).length);
}

// The fold is the workflow's, never the pane's own collapse. A workflow folded
// for its unseen plan, which the user never expands, leaves the pane open on the
// next workflow its own agent planned. And the collapse the user made on that one
// is theirs, so it survives a trip to the board and back.
test('the fold leaves the pane\'s own collapse alone', async () => {
  const { browser, page } = await launch({ plannedElsewhere: true, secondWorkflow: { plannedElsewhere: false } });
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    // The first workflow is another session's plan: folded to its strip, never expanded here.
    await expect.poll(() => selectedWorkflowId(page)).toBe(WORKFLOW_ID);
    await expect(pane).toHaveAttribute('data-collapsed', 'true');
    await expect(pane).toHaveAttribute('data-folded', 'true');
    expect(await agentPaneCollapsed(page)).toBe(false);

    // A workflow its own agent planned opens expanded with its agent: the fold wrote no collapse.
    await pickWorkflow(page, SECOND_WORKFLOW_ID);
    await expect(pane).toHaveAttribute('data-collapsed', 'false');
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    expect(await agentPaneCollapsed(page)).toBe(false);

    // The user's own collapse is a strip that is not folded, and it outlasts a visit to the board.
    await byTestId(page, 'workflow-agent-pane-collapse').click();
    await expect(pane).toHaveAttribute('data-collapsed', 'true');
    await expect(pane).toHaveAttribute('data-folded', 'false');
    await page.locator('[data-testid="view-toggle-board"]').click();
    await page.locator('[data-testid="view-toggle-workflows"]').click();
    // Still this workflow, so the strip is the collapse and not a fold.
    await expect.poll(() => selectedWorkflowId(page)).toBe(SECOND_WORKFLOW_ID);
    await expect(pane).toHaveAttribute('data-collapsed', 'true');
    await expect(pane).toHaveAttribute('data-folded', 'false');
  } finally {
    await browser.close();
  }
});

// A workflow can be folded for its unseen plan while the user has also collapsed
// the pane. One press on the strip's expand button lifts both, so the notice
// shows at once and the user is not left pressing it twice.
test('one expand click lifts both the fold and the pane\'s own collapse', async () => {
  const { browser, page } = await launch({ secondWorkflow: { plannedElsewhere: true } });
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    // The first workflow's own agent planned it: open, then collapsed by the user.
    await expect(byTestId(page, 'workflow-agent-terminal')).toBeVisible();
    await byTestId(page, 'workflow-agent-pane-collapse').click();
    await expect(pane).toHaveAttribute('data-collapsed', 'true');
    await expect(pane).toHaveAttribute('data-folded', 'false');

    // The second is another session's plan: the strip now holds the user's collapse and the fold.
    await pickWorkflow(page, SECOND_WORKFLOW_ID);
    await expect(pane).toHaveAttribute('data-collapsed', 'true');
    await expect(pane).toHaveAttribute('data-folded', 'true');
    expect(await agentPaneCollapsed(page)).toBe(true);

    // One click, no retry: both are lifted, and the pane says why no agent runs.
    await byTestId(page, 'workflow-agent-pane-expand').click();
    await expect(pane).toHaveAttribute('data-collapsed', 'false');
    await expect(pane).toHaveAttribute('data-agent-state', 'starts-on-request');
    await expect(byTestId(page, 'workflow-agent-plan-saved').getByRole('heading')).toHaveText('The workflow agent has not seen this plan');
    expect(await agentPaneCollapsed(page)).toBe(false);
  } finally {
    await browser.close();
  }
});

// The agent list gates the pane's read of the Workflow agent setting, so a
// launch that pins that read waits for it (`awaitAgentList`). With the setting
// empty the pane never asks main to open, so the fold on arrival can only come
// from the picker's summary, and the setup state must not promise a start on close.
test('a plan no agent has seen, with no Workflow agent chosen, arrives folded and asks main for nothing', async () => {
  const { browser, page } = await launch({ plannedElsewhere: true, workflowAgent: null, awaitAgentList: true });
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    // Folded on the first frame, though main was never asked and so never said so.
    await expect(pane).toHaveAttribute('data-folded', 'true');
    await settleFrames(page, 5);
    expect(await agentOpenCount(page)).toBe(0);
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    expect(await workflowAgentSessionCount(page)).toBe(0);

    // Expanded, it asks for the setting, and its line promises a start on request, not on close.
    await byTestId(page, 'workflow-agent-pane-expand').click();
    await expect(pane).toHaveAttribute('data-collapsed', 'false');
    const setup = byTestId(page, 'workflow-agent-setup');
    await expect(setup).toHaveAttribute('data-setting', 'needed');
    await expect(setup).toContainText('It plans your workflows, and starts when you ask for changes.');
    await expect(setup).not.toContainText('close Settings');
    await expect(byTestId(page, 'workflow-agent-plan-saved')).toHaveCount(0);

    // Choosing the setting with Settings still open: the notice, and the open is held until the close.
    await openSettingsFromPane(page);
    await setWorkflowAgent(page, WORKFLOW_AGENT);
    await expect(byTestId(page, 'workflow-agent-plan-saved')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-setup')).toHaveCount(0);
    expect(await agentOpenCount(page)).toBe(0);

    // Closing Settings opens once, and main answers that no agent starts until asked.
    await closeSettings(page);
    await expect.poll(() => agentOpenCount(page)).toBeGreaterThanOrEqual(1);
    await expect(byTestId(page, 'workflow-agent-plan-saved')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-ask-for-changes')).toBeEnabled();
    await expect(pane).toHaveAttribute('data-agent-state', 'starts-on-request');
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    expect(await workflowAgentSessionCount(page)).toBe(0);
  } finally {
    await browser.close();
  }
});

// The bug this replaced: with Settings open, a plan no agent has seen read as held
// for Settings ("Workflow agent chosen. It starts when you close Settings."), though
// closing Settings starts nothing on it. The notice and Ask for changes stay.
test('a plan no agent has seen keeps its notice with Settings open, and is not held for the close', async () => {
  const { browser, page } = await launch({ plannedElsewhere: true, awaitAgentList: true });
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    await expect(pane).toHaveAttribute('data-folded', 'true');
    await byTestId(page, 'workflow-agent-pane-expand').click();
    await expect(byTestId(page, 'workflow-agent-plan-saved')).toBeVisible();
    // The open on arrival has been answered: nothing started.
    await expect.poll(() => agentOpenCount(page)).toBe(1);

    await openSettingsFromTitleBar(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __zustandStores: { config: { getState: () => { settingsOpen: boolean } } } })
      .__zustandStores.config.getState().settingsOpen)).toBe(true);
    // Settings does not remount the pane, so the lifted fold holds.
    await expect(pane).toHaveAttribute('data-collapsed', 'false');
    await expect(pane).toHaveAttribute('data-agent-state', 'starts-on-request');
    await expect(byTestId(page, 'workflow-agent-plan-saved')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-ask-for-changes')).toBeEnabled();
    await expect(byTestId(page, 'workflow-agent-setup')).toHaveCount(0);
    await expect(pane).not.toContainText('Workflow agent chosen');
    await expect(pane).not.toContainText('It starts when you close Settings.');

    // The close starts nothing either.
    await closeSettings(page);
    await expect(byTestId(page, 'workflow-agent-plan-saved')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-terminal')).toHaveCount(0);
    expect(await workflowAgentSessionCount(page)).toBe(0);
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

test('a width that fails to save snaps back to the stored width, with no unhandled rejection', async () => {
  const { browser, page } = await launch();
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    await expect(pane).toHaveAttribute('data-floating', 'false');
    const widthOf = () => pane.evaluate((element) => element.getBoundingClientRect().width);
    const before = await widthOf();

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.evaluate(() => {
      // A rejection that nothing catches is a promise event, not a window error,
      // so `dragPaneEdge`'s error listener cannot see it.
      const watched = window as unknown as { __unhandledRejections: string[]; __refusedWidthSaves: number[] };
      watched.__unhandledRejections = [];
      watched.__refusedWidthSaves = [];
      window.addEventListener('unhandledrejection', (event) => { watched.__unhandledRejections.push(String(event.reason)); });
      // Armed here, after boot, for the pane's own save only: the first
      // `agentPaneWidth` write fails, the way a refused config write does.
      const set = window.electronAPI.config.set;
      window.electronAPI.config.set = async (partial) => {
        const requested = partial.workflows?.agentPaneWidth;
        if (requested !== undefined && watched.__refusedWidthSaves.length === 0) {
          watched.__refusedWidthSaves.push(requested);
          throw new Error('The settings file is read only');
        }
        return set(partial);
      };
    });

    expect(await dragPaneEdge(page, 120)).toEqual([]);
    // The drag asked for a wider pane, and that save was the one refused.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __refusedWidthSaves: number[] }).__refusedWidthSaves.length)).toBe(1);
    const refused = await page.evaluate(() => (window as unknown as { __refusedWidthSaves: number[] }).__refusedWidthSaves[0]);
    expect(refused).toBeGreaterThan(before + 100);
    // Nothing was stored, so the pane is back at the width it had.
    await expect.poll(async () => Math.abs((await widthOf()) - before) <= 1).toBe(true);
    expect(await page.evaluate(async () => (await window.electronAPI.config.getGlobal()).workflows?.agentPaneWidth ?? null)).toBeNull();
    // Two frames past the snap-back, for the page to report a rejection nobody caught.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => (window as unknown as { __unhandledRejections: string[] }).__unhandledRejections)).toEqual([]);
    expect(pageErrors).toEqual([]);
    // The refusal is not swallowed: the pane logs that the width was not saved, with the reason.
    // Console events cross the debugging protocol after the page logs them, so poll for the one.
    await expect.poll(() => warnings.some((warning) => warning.includes('Could not save the pane width'))).toBe(true);
    expect(warnings.find((warning) => warning.includes('Could not save the pane width'))).toContain('The settings file is read only');
  } finally {
    await browser.close();
  }
});

/**
 * Hold every pane-width save in the page until the test lets it go. The patch is
 * made after boot and takes only a payload that carries `workflows.agentPaneWidth`,
 * so the app's other config writes pass straight through. Each held save is
 * recorded in `__widthSaves` (the width it asks for) and released by its index in
 * that list; a released save goes through to the mock unchanged.
 */
async function holdWidthSaves(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = window as unknown as { __widthSaves: number[]; __widthSaveGates: Array<() => void> };
    held.__widthSaves = [];
    held.__widthSaveGates = [];
    const set = window.electronAPI.config.set;
    window.electronAPI.config.set = async (partial) => {
      const requested = partial.workflows?.agentPaneWidth;
      if (requested === undefined) return set(partial);
      held.__widthSaves.push(requested);
      await new Promise<void>((resolve) => { held.__widthSaveGates.push(resolve); });
      return set(partial);
    };
  });
}

/** The widths the held saves ask for, in the order they were made. */
async function heldWidthSaves(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __widthSaves: number[] }).__widthSaves);
}

/** Let the held save at `index` go through to the mock. */
async function releaseWidthSave(page: Page, index: number): Promise<void> {
  await page.evaluate((gateIndex) => (window as unknown as { __widthSaveGates: Array<() => void> }).__widthSaveGates[gateIndex](), index);
}

/** The width the config store holds for the pane: what a save has stored and the store has read back. */
async function storedPaneWidth(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { config: { workflows?: { agentPaneWidth?: number } } } } };
    }).__zustandStores;
    return stores.config.getState().config.workflows?.agentPaneWidth ?? null;
  });
}

test('a drag pressed while the last one\'s save is pending starts from the width on screen, and only the newest save lets go of it', async () => {
  const { browser, page } = await launch();
  try {
    const pane = byTestId(page, 'workflow-agent-pane');
    await expect(pane).toHaveAttribute('data-floating', 'false');
    const widthOf = () => pane.evaluate((element) => element.getBoundingClientRect().width);
    // 0 when the pane is within a pixel of `expected`, else how far off it is, so a failure names the width.
    const offBy = (expected: number) => async () => {
      const difference = (await widthOf()) - expected;
      return Math.abs(difference) <= 1 ? 0 : difference;
    };
    const start = await widthOf();
    await holdWidthSaves(page);

    // Drag 1 widens the pane by 100 and releases; its save is held, so nothing is stored yet.
    expect(await dragPaneEdge(page, 100)).toEqual([]);
    await expect.poll(async () => (await heldWidthSaves(page)).length).toBe(1);
    const [firstSave] = await heldWidthSaves(page);
    expect(Math.abs(firstSave - (start + 100))).toBeLessThanOrEqual(1);
    await expect.poll(offBy(start + 100)).toBe(0);
    expect(await storedPaneWidth(page)).toBeNull();

    // Drag 2 is pressed while save 1 is still pending. It starts from the width
    // on screen, so it ends 10 past it. Started from the stored width (none, so
    // the default) it would end 10 past that, and the pane would shrink.
    await settleFrames(page);
    expect(await dragPaneEdge(page, 10)).toEqual([]);
    await expect.poll(async () => (await heldWidthSaves(page)).length).toBe(2);
    const [, secondSave] = await heldWidthSaves(page);
    expect(Math.abs(secondSave - (start + 110))).toBeLessThanOrEqual(1);
    await expect.poll(offBy(start + 110)).toBe(0);

    // Save 1 lands while save 2 is pending. Only the newest save lets go of the
    // width a drag set, so the pane stays where drag 2 left it. Wait for the
    // store to read save 1 back (the step before the save's `finally`), then the
    // frames a snap-back would need, then look once.
    await releaseWidthSave(page, 0);
    await expect.poll(() => storedPaneWidth(page)).toBe(firstSave);
    await settleFrames(page, 3);
    expect(await offBy(start + 110)()).toBe(0);

    // Save 2 lands: the newest save lets go, and the setting it stored is the width.
    await releaseWidthSave(page, 1);
    await expect.poll(() => storedPaneWidth(page)).toBe(secondSave);
    await settleFrames(page, 3);
    expect(await offBy(start + 110)()).toBe(0);
    expect(await page.evaluate(async () => (await window.electronAPI.config.getGlobal()).workflows?.agentPaneWidth ?? null)).toBe(secondSave);
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
