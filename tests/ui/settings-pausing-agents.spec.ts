/**
 * Settings > Performance > Pausing agents.
 *
 * Two switches: When memory runs low (on by default) and When idle (off by
 * default). The idle timer's minutes are When idle's own value, so they sit on
 * a second line of its tile, under a hairline, and show only while it is on. A
 * click on that line must never flip the switch above it. Idle timeout left
 * Behavior > Sessions for this card.
 *
 * Each case owns its page, so no case relies on a switch an earlier case left on.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

interface AgentConfigSlice {
  agent: { pauseIdleAgentsOnLowMemory: boolean; idleTimeoutEnabled: boolean; idleTimeoutMinutes: number };
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByTestId('settings-tab-list').getByRole('button', { name, exact: true }).click();
}

async function readAgentConfig(page: Page): Promise<AgentConfigSlice['agent']> {
  const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
  return (globalConfig as AgentConfigSlice).agent;
}

async function openPausingAgents(page: Page): Promise<void> {
  await createProject(page, `settings-pausing-agents-${Date.now()}`);
  await openSettings(page);
  await openTab(page, 'Performance');
  await expect(page.getByTestId('settings-card-pausing-agents')).toBeVisible();
}

test.describe('Settings > Performance > Pausing agents', () => {
  test('starts with the memory pause on and the idle timer off, its minutes hidden', async () => {
    const { browser, page } = await launchPage();
    try {
      await openPausingAgents(page);

      await expect(page.getByTestId('setting-row-agent.pauseIdleAgentsOnLowMemory')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('setting-row-agent.idleTimeoutEnabled')).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByTestId('setting-row-agent.idleTimeoutMinutes')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the memory pause switch persists', async () => {
    const { browser, page } = await launchPage();
    try {
      await openPausingAgents(page);

      await page.getByTestId('setting-row-agent.pauseIdleAgentsOnLowMemory').click();

      await expect.poll(async () => (await readAgentConfig(page)).pauseIdleAgentsOnLowMemory, { timeout: 3000 }).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('turning When idle on shows Minutes idle at 30, and the stepper writes the minutes', async () => {
    const { browser, page } = await launchPage();
    try {
      await openPausingAgents(page);

      await page.getByTestId('setting-row-agent.idleTimeoutEnabled').click();
      await expect.poll(async () => (await readAgentConfig(page)).idleTimeoutEnabled, { timeout: 3000 }).toBe(true);

      const minutesLine = page.getByTestId('setting-row-agent.idleTimeoutMinutes');
      await expect(minutesLine).toBeVisible();
      await expect(minutesLine).toContainText('Minutes idle');
      await expect(page.getByTestId('idle-timeout-minutes-value')).toHaveValue('30');

      await page.getByTestId('idle-timeout-minutes-increment').click();
      await expect.poll(async () => (await readAgentConfig(page)).idleTimeoutMinutes, { timeout: 3000 }).toBe(31);

      // A typed value commits on Enter.
      const value = page.getByTestId('idle-timeout-minutes-value');
      await value.fill('45');
      await value.press('Enter');
      await expect.poll(async () => (await readAgentConfig(page)).idleTimeoutMinutes, { timeout: 3000 }).toBe(45);
    } finally {
      await browser.close();
    }
  });

  test('a click on the Minutes idle line never flips When idle', async () => {
    const { browser, page } = await launchPage();
    try {
      await openPausingAgents(page);
      await page.getByTestId('setting-row-agent.idleTimeoutEnabled').click();
      const minutesLine = page.getByTestId('setting-row-agent.idleTimeoutMinutes');
      await expect(minutesLine).toBeVisible();

      // The line's label, away from the stepper.
      await minutesLine.getByText('Minutes idle').click();

      await expect(page.getByTestId('setting-row-agent.idleTimeoutEnabled')).toHaveAttribute('aria-checked', 'true');
      await expect(minutesLine).toBeVisible();
      expect((await readAgentConfig(page)).idleTimeoutEnabled).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('turning When idle off hides the minutes and keeps their value for next time', async () => {
    const { browser, page } = await launchPage();
    try {
      await openPausingAgents(page);
      const idleSwitch = page.getByTestId('setting-row-agent.idleTimeoutEnabled');
      await idleSwitch.click();
      await page.getByTestId('idle-timeout-minutes-increment').click();
      await expect.poll(async () => (await readAgentConfig(page)).idleTimeoutMinutes, { timeout: 3000 }).toBe(31);

      await idleSwitch.click();

      await expect(page.getByTestId('setting-row-agent.idleTimeoutMinutes')).toHaveCount(0);
      await expect.poll(async () => (await readAgentConfig(page)).idleTimeoutEnabled, { timeout: 3000 }).toBe(false);
      expect((await readAgentConfig(page)).idleTimeoutMinutes).toBe(31);
    } finally {
      await browser.close();
    }
  });

  test('Behavior no longer lists an idle timeout', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-pausing-agents-behavior-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Behavior');
      await expect(page.getByTestId('setting-row-agent.maxConcurrentSessions')).toBeVisible();

      await expect(page.getByText('Idle timeout', { exact: false })).toHaveCount(0);
      await expect(page.getByTestId('settings-card-pausing-agents')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
