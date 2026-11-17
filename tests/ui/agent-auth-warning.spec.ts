import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with `__mockAgentListOverrides` applied for one or more
 * agents at once, so the agent grid renders each named agent with its own
 * given fields (e.g. `found:true, authenticated:false` for the "Not signed
 * in" variants).
 */
async function launchWithAgentOverrides(overrides: Record<string, Record<string, unknown>>): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Grant clipboard permission so navigator.clipboard.writeText resolves
  // instead of throwing NotAllowedError.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.addInitScript((agentOverrides: Record<string, Record<string, unknown>>) => {
    (window as Record<string, unknown>).__mockAgentListOverrides = agentOverrides;
  }, overrides);
  await page.addInitScript({ path: MOCK_SCRIPT });

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Launch a page with `__mockAgentListOverrides` applied for a single agent.
 * The mock's Claude Code stays found and signed in, so the named agent sits
 * beside a ready one.
 */
async function launchWithAgentOverride(agentId: string, override: Record<string, unknown>): Promise<{ browser: Browser; page: Page }> {
  return launchWithAgentOverrides({ [agentId]: override });
}

const CLAUDE_NOT_FOUND = { found: false, path: null, version: null };
const OPENCODE_SIGNED_OUT = { found: true, path: '/usr/bin/opencode', version: '1.14.25', authenticated: false };
const KIMI_SIGNED_OUT = { found: true, path: '/usr/bin/kimi', version: '1.37.0', authenticated: false };

async function expandSetup(page: Page): Promise<void> {
  const toggle = page.locator('[data-testid="welcome-setup-toggle"]');
  await expect(toggle).toHaveText(/Show setup/);
  await toggle.click();
  await expect(toggle).toHaveText(/Hide setup/);
}

// A signed-out agent beside a ready one is most likely a tool the user tried and dropped, so it
// reads like an uninstalled one: no attention mark, and a plain Copy login link. The panel stays
// collapsed, because the user can already run tasks.
test.describe('Agent Auth Warning - Welcome Screen, another agent ready', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('a signed-out Kimi is a quiet card behind the collapsed panel, with a Copy login link', async () => {
    ({ browser, page } = await launchWithAgentOverride('kimi', KIMI_SIGNED_OUT));

    await expect(page.locator('[data-testid="welcome-readiness"]')).toContainText('Found');
    await expandSetup(page);

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard).toBeVisible();
    await expect(kimiCard.getByText('Not signed in')).toBeVisible();
    await expect(kimiCard.locator('.text-attention')).toHaveCount(0);

    const copyLink = page.locator('[data-testid="welcome-agent-kimi-copy-login"]');
    await expect(copyLink).toHaveText('Copy login');
    // The command is not on screen, so the control's name carries it.
    await expect(copyLink).toHaveAccessibleName(/kimi login/);

    // The command rides the shared Tooltip: hovering the link opens a tip that says it, and the
    // link's description carries it for keyboard and screen reader users.
    await copyLink.hover();
    await expect(page.locator('[data-tooltip]')).toHaveText('kimi login');
    await expect(copyLink).toHaveAccessibleDescription('kimi login');

    // The quiet row does not look ready: no check icon and a muted name, where a ready agent
    // (the mock's Claude Code) has the check icon and the full-strength name.
    const checkIcon = 'svg.lucide-circle-check-big';
    const claudeCard = page.locator('[data-testid="welcome-agent-claude"]');
    await expect(claudeCard.locator(checkIcon)).toHaveCount(1);
    await expect(kimiCard.locator(checkIcon)).toHaveCount(0);
    await expect(kimiCard.locator('div.text-sm.font-medium')).toHaveClass(/text-fg-muted/);
    await expect(claudeCard.locator('div.text-sm.font-medium')).not.toHaveClass(/text-fg-muted/);
  });

  test('clicking Copy login writes "kimi login" to the clipboard and flips to "Copied!"', async () => {
    ({ browser, page } = await launchWithAgentOverride('kimi', KIMI_SIGNED_OUT));
    await expandSetup(page);

    const copyLink = page.locator('[data-testid="welcome-agent-kimi-copy-login"]');
    await copyLink.click();

    await expect(copyLink).toContainText('Copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('kimi login');
  });

  test('signed-out cards follow the ready ones in list order, one third wide, each on one line', async () => {
    // kimi (list index 8) and opencode (list index 9) both define probeAuth,
    // so both can legitimately be signed out at once beside the mock's Claude.
    ({ browser, page } = await launchWithAgentOverrides({ kimi: KIMI_SIGNED_OUT, opencode: OPENCODE_SIGNED_OUT }));
    await expandSetup(page);
    await expect(page.locator('[data-testid="welcome-agent-opencode-copy-login"]')).toBeVisible();

    // "Not signed in - Copy login" has to fit a third of the grid. The fixed-height status line
    // hides a wrap from the card's own height, so compare each half against a one-line sibling
    // instead: Claude's version line.
    const geometry = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="welcome-agent-grid"]');
      const signedOutCard = document.querySelector('[data-testid="welcome-agent-opencode"]');
      const siblingCard = document.querySelector('[data-testid="welcome-agent-claude"]');
      const copyLink = document.querySelector('[data-testid="welcome-agent-opencode-copy-login"]');
      if (!grid || !signedOutCard || !siblingCard || !copyLink) return null;
      const statusLabel = Array.from(signedOutCard.querySelectorAll('span'))
        .find((span) => span.textContent === 'Not signed in');
      const siblingVersion = Array.from(siblingCard.querySelectorAll('span'))
        .find((span) => span.textContent === 'v2.1.72');
      if (!statusLabel || !siblingVersion) return null;
      const signedOutBox = signedOutCard.getBoundingClientRect();
      const copyBox = copyLink.getBoundingClientRect();
      return {
        firstThreeTestIds: Array.from(grid.children)
          .slice(0, 3)
          .map((child) => child.getAttribute('data-testid')),
        signedOutWidth: signedOutBox.width,
        siblingWidth: siblingCard.getBoundingClientRect().width,
        lineHeight: siblingVersion.getBoundingClientRect().height,
        statusHeight: statusLabel.getBoundingClientRect().height,
        copyHeight: copyBox.height,
        copyRight: copyBox.right,
        signedOutRight: signedOutBox.right,
      };
    });

    expect(geometry).not.toBeNull();
    if (!geometry) return;
    // Read the order off the grid's actual children. Signed-out first was the old order.
    expect(geometry.firstThreeTestIds).toEqual([
      'welcome-agent-claude',
      'welcome-agent-kimi',
      'welcome-agent-opencode',
    ]);
    // Soft, so a failure reports every property at once.
    expect.soft(geometry.signedOutWidth, 'the signed-out card spans more than its third').toBeLessThan(geometry.siblingWidth * 1.5);
    expect.soft(geometry.statusHeight, 'Not signed in wraps').toBeLessThan(geometry.lineHeight * 1.5);
    expect.soft(geometry.copyHeight, 'the Copy login link wraps').toBeLessThan(geometry.lineHeight * 1.5);
    expect.soft(geometry.copyRight, 'the Copy login link overflows the card').toBeLessThanOrEqual(geometry.signedOutRight);
  });

  test('a signed-out Claude Code beside a ready Codex does not block: the header names the ready agent', async () => {
    ({ browser, page } = await launchWithAgentOverrides({
      claude: { authenticated: false },
      codex: { found: true, path: '/usr/bin/codex', version: '1.0.0' },
    }));

    const readiness = page.locator('[data-testid="welcome-readiness"]');
    // The header counts only ready agents, so a lone ready one is named even though it is not the
    // first found agent in list order.
    await expect(readiness).toContainText('Codex CLI 1.0.0');
    await expect(readiness).not.toContainText('Claude Code');
    await expect(page.getByText('Sign in to Claude Code')).toHaveCount(0);
    await expect(page.locator('[data-testid="welcome-setup-toggle"]')).toHaveText(/Show setup/);
  });

  test('Kimi signed in shows its version and no sign-in line', async () => {
    ({ browser, page } = await launchWithAgentOverride('kimi', { ...KIMI_SIGNED_OUT, authenticated: true }));
    await expandSetup(page);

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard.getByText('v1.37.0')).toBeVisible();
    await expect(kimiCard.getByText('Not signed in')).toHaveCount(0);
    await expect(kimiCard.locator('.text-attention')).toHaveCount(0);
  });

  test('OpenCode with a null probe (it failed) or no probe at all is treated as signed in', async () => {
    // null = probeAuth ran but returned null (EACCES, malformed JSON, missing file); undefined =
    // the adapter has no probe. Neither may read as signed out.
    for (const authenticated of [null, undefined]) {
      const launched = await launchWithAgentOverride('opencode', { ...OPENCODE_SIGNED_OUT, authenticated });
      try {
        await expandSetup(launched.page);
        const opencodeCard = launched.page.locator('[data-testid="welcome-agent-opencode"]');
        await expect(opencodeCard.getByText('v1.14.25')).toBeVisible();
        await expect(opencodeCard.getByText('Not signed in')).toHaveCount(0);
      } finally {
        await launched.browser.close();
      }
    }
  });
});

// With no agent ready, signing in is the user's next step: the panel opens, the row leads the grid
// at full width with the attention mark, and its button shows the whole command.
test.describe('Agent Auth Warning - Welcome Screen, no agent ready', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('a signed-out OpenCode as the only agent asks for sign-in with the attention mark', async () => {
    ({ browser, page } = await launchWithAgentOverrides({ claude: CLAUDE_NOT_FOUND, opencode: OPENCODE_SIGNED_OUT }));

    await expect(page.getByText('Sign in to OpenCode to run tasks.')).toBeVisible();
    await expect(page.locator('[data-testid="welcome-setup-toggle"]')).toHaveText(/Hide setup/);

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard.getByText('Not signed in')).toBeVisible();
    await expect(opencodeCard.locator('.text-attention')).toHaveCount(1);

    const copyButton = page.locator('[data-testid="welcome-agent-opencode-copy-login"]');
    await expect(copyButton).toContainText('opencode auth login');
  });

  test('the sign-in row leads the grid and spans it, so its button and status stay on one line', async () => {
    ({ browser, page } = await launchWithAgentOverrides({ claude: CLAUDE_NOT_FOUND, opencode: OPENCODE_SIGNED_OUT }));
    await expect(page.locator('[data-testid="welcome-agent-opencode-copy-login"]')).toBeVisible();

    // Compare against a one-line sibling: the not-installed Claude card's status line.
    const geometry = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="welcome-agent-grid"]');
      const signedOutCard = document.querySelector('[data-testid="welcome-agent-opencode"]');
      const siblingCard = document.querySelector('[data-testid="welcome-agent-claude"]');
      const copyButton = document.querySelector('[data-testid="welcome-agent-opencode-copy-login"]');
      if (!grid || !signedOutCard || !siblingCard || !copyButton) return null;
      const statusLabel = Array.from(signedOutCard.querySelectorAll('span'))
        .find((span) => span.textContent === 'Not signed in');
      const siblingStatus = Array.from(siblingCard.querySelectorAll('span'))
        .find((span) => span.textContent === 'Not installed');
      if (!statusLabel || !siblingStatus) return null;
      const signedOutBox = signedOutCard.getBoundingClientRect();
      const copyBox = copyButton.getBoundingClientRect();
      return {
        leadsGrid: grid.firstElementChild === signedOutCard,
        signedOutWidth: signedOutBox.width,
        siblingWidth: siblingCard.getBoundingClientRect().width,
        lineHeight: siblingStatus.getBoundingClientRect().height,
        statusHeight: statusLabel.getBoundingClientRect().height,
        copyRight: copyBox.right,
        signedOutRight: signedOutBox.right,
      };
    });

    expect(geometry).not.toBeNull();
    if (!geometry) return;
    expect.soft(geometry.leadsGrid, 'the card does not lead the grid').toBe(true);
    expect.soft(geometry.signedOutWidth, 'the card does not span the grid').toBeGreaterThan(geometry.siblingWidth * 2);
    expect.soft(geometry.statusHeight, 'Not signed in wraps').toBeLessThan(geometry.lineHeight * 1.5);
    expect.soft(geometry.copyRight, 'the Copy button overflows the card').toBeLessThanOrEqual(geometry.signedOutRight);
  });

  test('clicking the Copy button writes "opencode auth login" to the clipboard and flips to "Copied!"', async () => {
    ({ browser, page } = await launchWithAgentOverrides({ claude: CLAUDE_NOT_FOUND, opencode: OPENCODE_SIGNED_OUT }));

    const copyButton = page.locator('[data-testid="welcome-agent-opencode-copy-login"]');
    await copyButton.click();

    await expect(copyButton).toContainText('Copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('opencode auth login');
  });
});
