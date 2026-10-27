/**
 * The Agent tab's CLI path status for a WSL path (#286, design 1B):
 *   - a CLI found inside a distro shows a "WSL: <distro>" tag before its version;
 *   - a probe that failed shows "Not found" and the error it hit, in its own
 *     words, in sentence case, in a square pill like the row's tags;
 *   - an agent that does not run from WSL shows "No WSL support", with no line
 *     under the field; the agents that do, read from the list's own flags, are
 *     in the status's tip.
 *
 * Tier: UI. The states come from the mock's agents.list() via
 * __mockAgentListOverrides, set before the mock loads.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, dismissOnboardingChecklist, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const WSL_CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';

async function launchWithOverrides(overrides: Record<string, Record<string, unknown>>): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript((agentOverrides: Record<string, Record<string, unknown>>) => {
    (window as Record<string, unknown>).__mockAgentListOverrides = agentOverrides;
  }, overrides);
  await page.addInitScript({ path: MOCK_SCRIPT });
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

async function openAgentTab(page: Page, slug: string): Promise<void> {
  await page.evaluate((projectSlug: string) => {
    (window as Record<string, unknown>).__mockFolderPath = `/mock/projects/${projectSlug}`;
  }, slug);
  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  if (await welcomeButton.isVisible()) {
    await welcomeButton.click();
  } else {
    await page.locator('[data-testid="sidebar-new-project-button"]').click();
  }
  await dismissOnboardingChecklist(page);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
}

test.describe('AgentTab - CLI path status for a WSL path', () => {
  let browser: Browser;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('a CLI found in a distro shows the WSL tag before its version', async () => {
    let page: Page;
    ({ browser, page } = await launchWithOverrides({
      claude: { found: true, path: WSL_CLI_PATH, version: '2.1.311', cliTarget: { kind: 'wsl', distro: 'Ubuntu' }, supportsWslCli: true },
    }));
    await openAgentTab(page, 'wsl-status-found');

    const status = page.getByTestId('agent-cli-status-claude');
    await expect(status).toContainText('WSL: Ubuntu');
    await expect(status).toContainText('v2.1.311');
    await expect(page.getByTestId('agent-cli-detail-claude')).toHaveCount(0);
  });

  test('a failed probe shows Not found and the error it hit, as selectable text', async () => {
    let page: Page;
    ({ browser, page } = await launchWithOverrides({
      claude: {
        found: false,
        path: WSL_CLI_PATH,
        version: null,
        cliTarget: { kind: 'wsl', distro: 'Ubuntu' },
        detectionError: "/usr/bin/env: 'node': No such file or directory",
        supportsWslCli: true,
      },
    }));
    await openAgentTab(page, 'wsl-status-error');

    await expect(page.getByTestId('agent-cli-status-claude')).toContainText('Not found');
    const detail = page.getByTestId('agent-cli-detail-claude');
    await expect(detail).toHaveText("/usr/bin/env: 'node': No such file or directory");
    await expect(detail).toHaveCSS('user-select', 'text');
  });

  // Red-green: the loose lowercase line it replaced reads "the file does not
  // exist on disk" with no border, and fails both assertions.
  test('a probe error reads in sentence case, in a square pill like the row\'s tags', async () => {
    let page: Page;
    ({ browser, page } = await launchWithOverrides({
      claude: { found: false, path: 'C:\\Tools\\claude.exe', version: null, detectionError: 'the file does not exist on disk' },
    }));
    await openAgentTab(page, 'wsl-status-sentence-case');

    const detail = page.getByTestId('agent-cli-detail-claude');
    await expect(detail).toHaveText('The file does not exist on disk');
    await expect(detail).toHaveCSS('border-top-style', 'solid');
  });

  // Red-green: the line it replaced stood under the field, so the detail count
  // was 1 and the status had no description.
  test('an agent without WSL support says so, with no line under the field, and names the agents that run from WSL in the status tip', async () => {
    let page: Page;
    ({ browser, page } = await launchWithOverrides({
      claude: { found: false, path: WSL_CLI_PATH, version: null, cliTarget: { kind: 'wsl', distro: 'Ubuntu' }, unsupportedTarget: true, supportsWslCli: false },
      codex: { supportsWslCli: true },
    }));
    await openAgentTab(page, 'wsl-status-unsupported');

    const status = page.getByTestId('agent-cli-status-claude');
    await expect(status).toHaveText('No WSL support');
    await expect(page.getByTestId('agent-cli-detail-claude')).toHaveCount(0);
    await expect(status).toHaveAccessibleDescription(/^Kangentic runs .*Codex.* from WSL\.$/);
  });
});
