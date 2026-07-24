/**
 * UI tests for the footer's agent-not-found warning (GitHub issue #199).
 *
 * The footer used to build its warning from two values keyed to different
 * agents: the condition came from a Claude-only detection probe while the
 * noun came from the project's `default_agent`. A project defaulted to a
 * non-Claude agent could show "<that agent> not found" even when the agent
 * was installed and working, as long as Claude itself was missing.
 *
 * The fix derives both the condition and the noun from the same
 * `agentList` entry (`s.agentList.find((a) => a.name === project.default_agent)`),
 * so they can no longer disagree. `window.__mockAgentListOverrides` lets a
 * test control per-agent `found` state; it must be injected before the app
 * boots (see `tests/ui/agent-tab-auth-warning.spec.ts`).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-status-bar-agent';

async function launchWithCodexProject(agentListOverrides: Record<string, unknown>): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // __mockAgentListOverrides must be set before the mock script installs
  // window.electronAPI, so the renderer's bootstrap agents.list() call sees it.
  await page.addInitScript((overrides) => {
    (window as unknown as { __mockAgentListOverrides?: unknown }).__mockAgentListOverrides = overrides;
  }, agentListOverrides);
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Codex Project',
        path: '/mock/status-bar-agent',
        github_url: null,
        default_agent: 'codex',
        last_opened: ts,
        created_at: ts,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Poll until the config store's agentList is non-empty (bootstrap agents.list()
 * has resolved). `toBeHidden` passes immediately when an element is absent, so
 * without this positive precondition a `toBeHidden` assertion on
 * `[data-testid="agent-not-found"]` would pass vacuously if it ran before the
 * bootstrap fetch resolved, proving nothing about the fix.
 */
async function waitForAgentListLoaded(page: Page): Promise<void> {
  await expect.poll(
    async () => page.evaluate(() => {
      const configStore = (window as unknown as {
        __zustandStores?: { config?: { getState: () => { agentList: unknown[] } } };
      }).__zustandStores?.config;
      return configStore?.getState().agentList.length ?? 0;
    }),
    { timeout: 10000, intervals: [200, 200, 200, 500] },
  ).toBeGreaterThan(0);
}

test.describe('StatusBar agent-not-found warning', () => {
  test('does not warn when the project default agent is found, even though Claude itself is not', async () => {
    const { browser, page } = await launchWithCodexProject({
      claude: { found: false, path: null, version: null },
      codex: { found: true, path: '/usr/bin/codex', version: '1.0.0' },
    });
    try {
      await page.locator('[data-testid="task-count"]').waitFor({ state: 'visible', timeout: 15000 });

      // Positive precondition: prove the bootstrap agents.list() call actually
      // resolved and populated agentList before asserting the warning is
      // hidden, so the hidden check below cannot pass vacuously.
      await waitForAgentListLoaded(page);

      // The regression: a Claude-only detection probe fed a project-agent-labelled
      // warning, so "Codex CLI not found" rendered even though Codex was installed.
      await expect(page.locator('[data-testid="agent-not-found"]')).toBeHidden({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('warns with the project default agent name when that agent is genuinely not found', async () => {
    const { browser, page } = await launchWithCodexProject({
      claude: { found: true, path: '/usr/bin/claude', version: '2.1.72' },
      codex: { found: false, path: null, version: null },
    });
    try {
      await page.locator('[data-testid="task-count"]').waitFor({ state: 'visible', timeout: 15000 });

      const warning = page.locator('[data-testid="agent-not-found"]');
      await expect(warning).toBeVisible({ timeout: 5000 });
      await expect(warning).toHaveText('Codex CLI not found');
    } finally {
      await browser.close();
    }
  });
});
