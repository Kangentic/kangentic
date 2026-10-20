/**
 * Settings > Workflows > Workflow agent: the Agent, Model and Effort rows of the
 * card that chooses the agent every workflow's own agent runs on.
 *
 * The card shares `AnswerAgentRows` with the Automation agent card beside it, but
 * the Workflow agent is an INTERACTIVE agent (it runs in a terminal), so its rows
 * read different capabilities than a background answer run's:
 *   - Agent lists installed agents that `supportsWorkflowAgent`, and a stored
 *     choice the list cannot offer reads as unset (no project fallback).
 *   - Model shows when the CLI itself takes a model (`supportsModelOverride`), not
 *     when an answer run would (`answerCapabilities.model`).
 *   - Effort shows when the CLI reports effort levels, with no
 *     `answerCapabilities` needed, and unset it reads "Agent default": an
 *     interactive run has no recommended level, where the Automation agent
 *     placeholder names the adapter's.
 *
 * Each fixture is built so the interactive rule and the answer-run rule DISAGREE,
 * so a row that reverted to the answer-run rule reads red here. Every "row is
 * absent" check follows a positive one (the Agent row lists the fixture's agents,
 * or the other card's row is on screen), because a count of zero is also what an
 * agent list that has not loaded yet looks like.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'workflow-agent-rows-proj';

interface AgentChoiceSeed {
  agent: string | null;
  model: string | null;
  effort: string | null;
}

interface RowsSeed {
  /** The Workflow agent setting (`config.workflows`); unset for a first run with none chosen. */
  workflows?: AgentChoiceSeed;
  /** The Automation agent setting (`config.automation`). */
  automation?: AgentChoiceSeed;
  /** Patches over the mock's agent list, by agent name. */
  agentListOverrides?: Record<string, Record<string, unknown>>;
}

/**
 * A CLI that can be a workflow's agent and has effort levels but no `--model`
 * flag, whose ANSWER capabilities say the opposite on both counts (it would take
 * a model and no effort). The interactive rule hides Model and shows Effort; the
 * answer-run rule would show Model and hide Effort.
 */
const CLI_WITHOUT_MODEL_FLAG = {
  codex: {
    found: true,
    path: '/usr/bin/codex',
    version: '1.0.0',
    supportsWorkflowAgent: true,
    answerCapabilities: { streaming: false, search: false, model: true, effort: false },
    capabilities: { effortLevels: ['low', 'high'], supportsModelOverride: false, models: [] as string[] },
  },
};

/**
 * An installed agent that cannot be a workflow's agent (no `supportsWorkflowAgent`)
 * but is otherwise complete: a model flag and effort levels. Read off the full
 * agent list instead of the capable one, it would show a Model and an Effort row.
 */
const INSTALLED_BUT_NOT_WORKFLOW_CAPABLE = {
  droid: {
    found: true,
    path: '/usr/bin/droid',
    version: '1.0.0',
    capabilities: { effortLevels: ['low', 'high'], supportsModelOverride: true, models: ['droid-pro'] },
  },
};

function seedScript(seed: RowsSeed): string {
  return `
    ${seed.agentListOverrides ? `window.__mockAgentListOverrides = ${JSON.stringify(seed.agentListOverrides)};` : ''}
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      ${seed.workflows ? `state.config.workflows = ${JSON.stringify(seed.workflows)};` : ''}
      ${seed.automation ? `state.config.automation = ${JSON.stringify(seed.automation)};` : ''}
      state.projects.push({ id: '${PROJECT_ID}', name: 'kangentic', path: '/mock/kangentic', github_url: null, default_agent: 'claude', group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-' + index, position: index, created_at: ts }));
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

const byTestId = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);

/** Open Settings > Workflows, retrying the clicks until the Workflow agent card is on screen. */
async function openWorkflowsSettings(page: Page): Promise<void> {
  const panel = byTestId(page, 'settings-panel');
  await expect(async () => {
    if (!(await panel.isVisible())) await byTestId(page, 'settings-button').click();
    await expect(panel).toBeVisible({ timeout: 2000 });
    await byTestId(page, 'settings-tab-workflows').click({ timeout: 2000 });
    await expect(byTestId(page, 'settings-card-workflow-agent')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 12_000 });
}

async function launch(seed: RowsSeed = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1700, height: 950 } })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(seedScript(seed));
  await gotoVite(page, VITE_URL);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await openWorkflowsSettings(page);
  return { browser, page };
}

/** Pick an agent in the Workflow agent card's Agent row. */
async function chooseWorkflowAgent(page: Page, agentName: string): Promise<void> {
  await byTestId(page, 'workflow-agent-setting-agent').click();
  await byTestId(page, `workflow-agent-setting-agent-option-${agentName}`).click();
}

test('Model follows the CLI\'s own --model support and Effort its effort levels, not an answer run\'s capabilities', async () => {
  const { browser, page } = await launch({ agentListOverrides: CLI_WITHOUT_MODEL_FLAG });
  try {
    const agentRow = byTestId(page, 'workflow-agent-setting-agent');
    const model = byTestId(page, 'workflow-agent-setting-model');
    const effort = byTestId(page, 'workflow-agent-setting-effort');

    // Nothing chosen: only the Agent row, and its menu lists both installed workflow agents.
    await expect(agentRow).toHaveValue('');
    await agentRow.click();
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-claude')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-codex')).toBeVisible();
    await expect(model).toHaveCount(0);
    await expect(effort).toHaveCount(0);

    // Claude takes a model: both rows show.
    await byTestId(page, 'workflow-agent-setting-agent-option-claude').click();
    await expect(agentRow).toHaveValue('Claude Code');
    await expect(model).toBeVisible();
    await expect(effort).toBeVisible();

    // The Codex-like CLI has no model flag, so no Model row, though an answer run
    // on it would take one. It reports effort levels, so Effort shows, though an
    // answer run on it would not take one.
    await chooseWorkflowAgent(page, 'codex');
    await expect(agentRow).toHaveValue('Codex CLI');
    await expect(effort).toBeVisible();
    await expect(model).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('Effort reads "Agent default" for the Workflow agent, while the Automation agent names its recommended level', async () => {
  const choice: AgentChoiceSeed = { agent: 'claude', model: 'haiku', effort: null };
  const { browser, page } = await launch({ workflows: choice, automation: choice });
  try {
    const workflowEffort = byTestId(page, 'workflow-agent-setting-effort');
    const automationEffort = byTestId(page, 'automation-agent-effort');
    // The same agent on both cards, with no effort chosen on either.
    await expect(workflowEffort).toBeVisible();
    await expect(automationEffort).toBeVisible();
    await expect(workflowEffort).toHaveValue('');
    await expect(automationEffort).toHaveValue('');
    // An answer run is recommended a level by its adapter. An interactive run is not.
    await expect(automationEffort).toHaveAttribute('placeholder', 'low');
    await expect(workflowEffort).toHaveAttribute('placeholder', 'Agent default');
  } finally {
    await browser.close();
  }
});

test('a Workflow agent set to an installed agent that cannot be one reads as unset, with no Model or Effort row', async () => {
  const { browser, page } = await launch({
    workflows: { agent: 'droid', model: 'droid-pro', effort: 'low' },
    agentListOverrides: INSTALLED_BUT_NOT_WORKFLOW_CAPABLE,
  });
  try {
    // The precondition this stands on: the agent list is in, and holds Droid as an
    // installed agent that does not claim to be a workflow agent.
    await expect.poll(() => page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { config: { getState: () => { agentList: Array<{ name: string; found: boolean; supportsWorkflowAgent?: boolean }> } } };
      }).__zustandStores;
      const droid = stores.config.getState().agentList.find((agent) => agent.name === 'droid');
      return droid ? { found: droid.found, workflowCapable: droid.supportsWorkflowAgent === true } : null;
    })).toEqual({ found: true, workflowCapable: false });

    const agentRow = byTestId(page, 'workflow-agent-setting-agent');
    await expect(agentRow).toHaveValue('');
    await expect(agentRow).toHaveAttribute('placeholder', 'Choose an agent');
    await expect(byTestId(page, 'workflow-agent-setting-model')).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-setting-effort')).toHaveCount(0);

    // The menu offers Claude, the one installed agent that can be a workflow's agent, and not Droid.
    await agentRow.click();
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-claude')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-droid')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// Any installed agent that reaches Kangentic's MCP server with a URL of its own
// can be the Workflow agent; read-only launch is an enhancement, not a gate.
// Codex cannot launch read-only and is offered. Droid writes the server URL into
// a file its folder shares, and Aider has no MCP client: neither is offered.
test('the Agent menu offers every installed agent that reaches the MCP server per session, read-only or not', async () => {
  const { browser, page } = await launch({
    agentListOverrides: {
      codex: { found: true, path: '/usr/bin/codex', version: '1.0.0' },
      droid: { found: true, path: '/usr/bin/droid', version: '1.0.0' },
      aider: { found: true, path: '/usr/bin/aider', version: '1.0.0' },
    },
  });
  try {
    // The precondition this stands on: all four are installed, and only Claude can launch read-only.
    await expect.poll(() => page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { config: { getState: () => { agentList: Array<{ name: string; found: boolean }> } } };
      }).__zustandStores;
      return stores.config.getState().agentList.filter((agent) => agent.found).map((agent) => agent.name).sort();
    })).toEqual(['aider', 'claude', 'codex', 'droid']);

    await byTestId(page, 'workflow-agent-setting-agent').click();
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-claude')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-codex')).toBeVisible();
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-droid')).toHaveCount(0);
    await expect(byTestId(page, 'workflow-agent-setting-agent-option-aider')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
