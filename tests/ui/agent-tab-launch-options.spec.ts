/**
 * UI tests for the launch-option toggles inside the Agent settings tab
 * (`agent-launch-option-fields.tsx`): one `SettingToggleRow` per
 * `AgentDetectionInfo.launchOptions` entry declared by the currently-selected
 * agent's adapter (e.g. Codex's "Disable ChatGPT Apps"), stored at the global
 * `AppConfig.agent.launchOptions[agentName][optionId]`.
 *
 * Structure and setup mirror `agent-tab-remote-execution.spec.ts`, the sibling
 * capability (adapter-declared -> AgentDetectionInfo -> a settings-tab
 * sub-component) that already has UI coverage.
 *
 * Covers:
 *  - A launch-option row renders for Codex (the mock fixture's only agent
 *    with `launchOptions`, mirroring CodexAdapter.launchOptions), showing the
 *    adapter-authored label and description.
 *  - No launch-option row renders for an agent that declares none.
 *  - The toggle reflects the adapter's `default` when nothing is stored, and
 *    a stored value that differs from the default.
 *  - Toggling writes the correct nested `config.set` payload: the touched
 *    option flips, the same agent's other options survive, and other agents'
 *    entries survive. This is pinned by capturing the exact argument passed
 *    to `window.electronAPI.config.set` rather than reading back through
 *    `config.get()`, because the mock's `deepMerge` (see mock-electron-api.js)
 *    recurses unconditionally at every depth and would silently mask a
 *    dropped `...stored` or `...globalConfig.agent.launchOptions` spread in
 *    the component's onChange handler.
 *
 * Tier: UI (headless Chromium). Pure React driven by Zustand store state
 * seeded from mock-electron-api.js. No PTY, no real Electron main process.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, dismissOnboardingChecklist } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const LAUNCH_OPTION_LABEL = 'Disable ChatGPT Apps';
const LAUNCH_OPTION_DESCRIPTION =
  "Skips Codex's optional ChatGPT Apps connector, which can hang startup. Doesn't touch your global config.";

interface CapturedLaunchOptionsPayload {
  agent?: {
    launchOptions?: Record<string, Record<string, boolean>>;
  };
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Open a project, switch its default agent, and navigate to Settings > Agent.
 * Mirrors `agent-tab-remote-execution.spec.ts`'s `openAgentSettingsTabAs`.
 */
async function openAgentSettingsTabAs(page: Page, agentId: string): Promise<void> {
  await page.evaluate((agent: string) => {
    (window as Record<string, unknown>).__mockFolderPath = `/mock/projects/${agent}-launch-option-test`;
  }, agentId);

  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');
  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await sidebarButton.click();
  }
  await dismissOnboardingChecklist(page);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  // Switch the project default agent via the mock API, then resync the
  // renderer's project store so AgentTab's effectiveAgent picks up it.
  await page.evaluate(async (agent: string) => {
    const projects = await window.electronAPI.projects.list();
    if (projects.length === 0) return;
    await window.electronAPI.projects.setDefaultAgent(projects[0].id, agent);
    const projectStore = (window as unknown as {
      __zustandStores?: { project?: { getState: () => { loadCurrent: () => Promise<void> } } };
    }).__zustandStores?.project;
    if (projectStore) await projectStore.getState().loadCurrent();
  }, agentId);

  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

/**
 * Seed `AppConfig.agent.launchOptions` directly via the mock IPC (bypassing
 * the component under test), then resync the renderer's config store so the
 * next AgentTab render reads the seeded value. Must run before
 * `openAgentSettingsTabAs` so the initial render already reflects it.
 */
async function seedStoredLaunchOptions(page: Page, launchOptions: Record<string, Record<string, boolean>>): Promise<void> {
  await page.evaluate(async (options: Record<string, Record<string, boolean>>) => {
    await window.electronAPI.config.set({ agent: { launchOptions: options } });
    const configStore = (window as unknown as {
      __zustandStores?: { config?: { getState: () => { loadConfig: () => Promise<void> } } };
    }).__zustandStores?.config;
    if (configStore) await configStore.getState().loadConfig();
  }, launchOptions);
}

/**
 * Patch `window.electronAPI.config.set` to record every payload it is called
 * with (still forwarding to the real mock implementation), so a test can
 * assert exactly what the component computed rather than what the mock's
 * lenient recursive `deepMerge` happens to produce afterward.
 */
async function captureConfigSetCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const configApi = window.electronAPI.config as unknown as {
      set: (partial: unknown) => Promise<void>;
    };
    const original = configApi.set.bind(configApi);
    (window as unknown as { __capturedConfigSetCalls: unknown[] }).__capturedConfigSetCalls = [];
    configApi.set = async (partial: unknown) => {
      (window as unknown as { __capturedConfigSetCalls: unknown[] }).__capturedConfigSetCalls.push(partial);
      return original(partial);
    };
  });
}

async function getCapturedConfigSetCalls(page: Page): Promise<CapturedLaunchOptionsPayload[]> {
  return page.evaluate(() => (window as unknown as { __capturedConfigSetCalls: CapturedLaunchOptionsPayload[] }).__capturedConfigSetCalls);
}

test.describe('AgentTab - Launch Option fields', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('shows the adapter-authored label and description for Codex', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'codex');

    const toggle = page.getByRole('switch', { name: LAUNCH_OPTION_LABEL, exact: true });
    await expect(toggle).toBeVisible();
    await expect(page.getByText(LAUNCH_OPTION_DESCRIPTION)).toBeVisible();

    await closeSettings(page);
  });

  test('renders no launch-option row for an agent that declares none', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'claude');

    await expect(page.getByRole('switch', { name: LAUNCH_OPTION_LABEL, exact: true })).toHaveCount(0);
    await expect(page.getByText(LAUNCH_OPTION_DESCRIPTION)).toHaveCount(0);

    await closeSettings(page);
  });

  test('reflects the adapter default when nothing is stored', async () => {
    ({ browser, page } = await launch());
    await openAgentSettingsTabAs(page, 'codex');

    // Mock fixture declares default: false for disableApps and the store
    // starts with an empty agent.launchOptions map, so nothing is stored.
    const toggle = page.getByRole('switch', { name: LAUNCH_OPTION_LABEL, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await closeSettings(page);
  });

  test('reflects a stored value that differs from the default', async () => {
    ({ browser, page } = await launch());
    await seedStoredLaunchOptions(page, { codex: { disableApps: true } });
    await openAgentSettingsTabAs(page, 'codex');

    const toggle = page.getByRole('switch', { name: LAUNCH_OPTION_LABEL, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await closeSettings(page);
  });

  test('toggling flips only the touched option, preserving this agent\'s other options and other agents\' entries', async () => {
    ({ browser, page } = await launch());
    // Seed a value the component did not itself set (a hypothetical future
    // launch option already stored for codex) and an unrelated agent's
    // entry, so a dropped `...stored` or dropped outer spread in the
    // onChange handler would show up as a missing key in the captured
    // payload below.
    await seedStoredLaunchOptions(page, {
      codex: { disableApps: true, futureOption: true },
      gemini: { someGeminiOption: true },
    });
    await openAgentSettingsTabAs(page, 'codex');
    await captureConfigSetCalls(page);

    const toggle = page.getByRole('switch', { name: LAUNCH_OPTION_LABEL, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();

    await expect.poll(async () => (await getCapturedConfigSetCalls(page)).length, { timeout: 5000 }).toBe(1);
    const [payload] = await getCapturedConfigSetCalls(page);

    expect(payload).toEqual({
      agent: {
        launchOptions: {
          codex: { disableApps: false, futureOption: true },
          gemini: { someGeminiOption: true },
        },
      },
    });

    await closeSettings(page);
  });
});
