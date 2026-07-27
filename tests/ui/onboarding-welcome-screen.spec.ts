import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own page so __mockAgentListOverrides never leaks
// across tests (mirrors agent-auth-warning.spec.ts's launchWithAgentOverride).
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithOverrides(
  overrides: Record<string, unknown>,
  configOverrides?: Record<string, unknown>,
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript((args: { agents: Record<string, unknown>; config: Record<string, unknown> | null }) => {
    (window as unknown as { __mockAgentListOverrides: Record<string, unknown> }).__mockAgentListOverrides = args.agents;
    if (args.config) {
      (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = args.config;
    }
  }, { agents: overrides, config: configOverrides ?? null });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

test.describe('Welcome screen readiness', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('ready: names the found agent, collapses the setup panel, and enables the CTA with the ready subtext', async () => {
    ({ browser, page } = await launchWithOverrides({}));

    // The ready state renders the two facts as scannable pills, not prose.
    const readiness = page.locator('[data-testid="welcome-readiness"]');
    await expect(readiness).toContainText('Found');
    await expect(readiness).toContainText('Git 2.43.0');
    await expect(readiness).toContainText('Claude Code 2.1.72');
    await expect(page.locator('[data-testid="welcome-setup-toggle"]')).toHaveText(/Show setup/);
    await expect(page.locator('[data-testid="welcome-git-status"]')).toBeHidden();

    const cta = page.locator('[data-testid="welcome-open-project"]');
    await expect(cta).toBeEnabled();
    // No subtext when ready: the button plus its folder icon already says it,
    // and the native picker repeats the same line one click later.
    await expect(page.getByText('You can look around now and install an agent later.')).toHaveCount(0);
  });

  test('blocked (no agent found): CTA stays enabled, panel auto-expands, blocked subtext shown', async () => {
    ({ browser, page } = await launchWithOverrides({ claude: { found: false, path: null, version: null } }));

    await expect(page.getByText('Install one agent CLI to run tasks.')).toBeVisible();
    await expect(page.locator('[data-testid="welcome-setup-toggle"]')).toHaveText(/Hide setup/);
    await expect(page.locator('[data-testid="welcome-git-status"]')).toBeVisible();

    // The deadlock fix: detection resolving to "nothing found" must never
    // disable the CTA, or there is no way back into the app.
    const cta = page.locator('[data-testid="welcome-open-project"]');
    await expect(cta).toBeEnabled();
    await expect(page.getByText('You can look around now and install an agent later.')).toBeVisible();
  });

  test('signed out: readiness line names the specific agent and the panel auto-expands', async () => {
    ({ browser, page } = await launchWithOverrides({ claude: { authenticated: false } }));

    await expect(page.getByText('Sign in to Claude Code to run tasks.')).toBeVisible();
    await expect(page.locator('[data-testid="welcome-setup-toggle"]')).toHaveText(/Hide setup/);

    const cta = page.locator('[data-testid="welcome-open-project"]');
    await expect(cta).toBeEnabled();
  });

  test('multiple agents found: readiness line summarizes by count, not by naming each one', async () => {
    ({ browser, page } = await launchWithOverrides({ codex: { found: true, path: '/usr/bin/codex', version: '1.0.0' } }));

    const readiness = page.locator('[data-testid="welcome-readiness"]');
    await expect(readiness).toContainText('Git 2.43.0');
    await expect(readiness).toContainText('2 agents');
    await expect(readiness).not.toContainText('Claude Code');
  });

  test('the mascot waves once on arrival then settles into the idle blink loop', async () => {
    ({ browser, page } = await launchWithOverrides({}));

    const mascot = page.getByRole('img', { name: 'Pixel-art Kangentic mascot' });
    await expect(mascot).toBeVisible();

    // The greeting is a one-shot; if it were the final state the hero would sit
    // frozen forever. Poll for the handoff rather than timing the wave, whose
    // duration belongs to the branding package.
    await expect.poll(
      async () => mascot.getAttribute('class'),
      { timeout: 5000 },
    ).toContain('overseer--blink-loop');

    // blink-loop is infinite, so this is a resting state, not another one-shot.
    await expect(mascot).not.toHaveClass(/overseer--wave-once/);
    // Both frames the two sequences use stay mounted across the handoff.
    await expect(mascot.locator('.overseer-frame--rest')).toHaveCount(1);
    await expect(mascot.locator('.overseer-frame--blink')).toHaveCount(1);
    await expect(mascot.locator('.overseer-frame--wave')).toHaveCount(1);
  });

  test('the app version renders as a pill, not near-invisible micro text', async () => {
    ({ browser, page } = await launchWithOverrides({}));

    const versionPill = page.locator('[data-testid="welcome-app-version"]');
    await expect(versionPill).toBeVisible();
    await expect(versionPill).toHaveText('v0.1.0');
  });

  test('ember theme: the CTA text uses the accent-on token, not hardcoded white', async () => {
    // Regression guard for a real contrast bug. --kng-accent-on is #ffffff on
    // nine themes but #1f1a17 on ember, whose accent is a light amber - so the
    // hardcoded `text-white` this replaced rendered white-on-#d49850, roughly
    // 1.9:1. Asserting the COMPUTED color (not the class) means any future
    // hardcoded light value fails here too, not just `text-white` specifically.
    ({ browser, page } = await launchWithOverrides({}, { theme: 'ember' }));

    const cta = page.locator('[data-testid="welcome-open-project"]');
    await expect(cta).toBeEnabled();

    const color = await cta.evaluate((element) => getComputedStyle(element).color);
    expect(color).toBe('rgb(31, 26, 23)');
  });

  test('the setup panel separates core tooling from agent CLIs', async () => {
    ({ browser, page } = await launchWithOverrides({}));
    await page.locator('[data-testid="welcome-setup-toggle"]').click();

    // Git is a different kind of prerequisite from the interchangeable agent
    // CLIs, and the core list will grow, so it must not be tiled in among them.
    const panel = page.locator('#welcome-setup-panel');
    await expect(panel.getByText('Core', { exact: true })).toBeVisible();
    await expect(panel.getByText('Agents', { exact: true })).toBeVisible();

    // Git sits outside the agent grid entirely.
    await expect(page.locator('[data-testid="welcome-git-status"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="welcome-agent-grid"] [data-testid="welcome-git-status"]'),
    ).toHaveCount(0);
  });

  test('clicking anywhere on the readiness row toggles the panel', async () => {
    ({ browser, page } = await launchWithOverrides({}));

    const panel = page.locator('#welcome-setup-panel');
    await expect(panel).toBeHidden();

    // Click the readiness TEXT, not the "Show setup" label - the whole row is
    // the control, so a click on the status half must open it too.
    await page.locator('[data-testid="welcome-readiness"]').click();
    await expect(panel).toBeVisible();

    await page.locator('[data-testid="welcome-readiness"]').click();
    await expect(panel).toBeHidden();
  });

  test('the setup toggle expands and collapses the panel manually', async () => {
    ({ browser, page } = await launchWithOverrides({}));

    const toggle = page.locator('[data-testid="welcome-setup-toggle"]');
    await expect(page.locator('[data-testid="welcome-git-status"]')).toBeHidden();

    await toggle.click();
    await expect(page.locator('[data-testid="welcome-git-status"]')).toBeVisible();
    await expect(toggle).toHaveText(/Hide setup/);

    await toggle.click();
    await expect(page.locator('[data-testid="welcome-git-status"]')).toBeHidden();
    await expect(toggle).toHaveText(/Show setup/);
  });
});
