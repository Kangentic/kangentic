import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/**
 * Launch a page with `__mockAgentListOverrides` applied for one or more
 * agents at once, so the agent grid renders each named agent with its own
 * given fields (e.g. `found:true, authenticated:false` for the amber "Not
 * signed in" variant).
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

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Launch a page with `__mockAgentListOverrides` applied for a single agent,
 * so the agent grid renders the named agent with the given fields (e.g.
 * `found:true, authenticated:false` for the amber "Not signed in" variant).
 */
async function launchWithAgentOverride(agentId: string, override: Record<string, unknown>): Promise<{ browser: Browser; page: Page }> {
  return launchWithAgentOverrides({ [agentId]: override });
}

test.describe('Agent Auth Warning - Welcome Screen', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('Kimi card shows amber "Not signed in" state when found but unauthenticated', async () => {
    ({ browser, page } = await launchWithAgentOverride('kimi', {
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      authenticated: false,
    }));

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard).toBeVisible();
    await expect(kimiCard).toHaveClass(/border-l-attention/);
    await expect(kimiCard.getByText('Not signed in')).toBeVisible();

    const copyButton = page.locator('[data-testid="welcome-agent-kimi-copy-login"]');
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toContainText('kimi login');
  });

  test('clicking the Copy button writes "kimi login" to the clipboard and flips to "Copied!"', async () => {
    ({ browser, page } = await launchWithAgentOverride('kimi', {
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      authenticated: false,
    }));

    const copyButton = page.locator('[data-testid="welcome-agent-kimi-copy-login"]');
    await copyButton.click();

    await expect(copyButton).toContainText('Copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('kimi login');
  });

  test('Kimi card stays green (authenticated:true) when login succeeded', async () => {
    ({ browser, page } = await launchWithAgentOverride('kimi', {
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      authenticated: true,
    }));

    // Every agent is found and none is signed out, so the setup panel starts
    // collapsed behind the readiness line; expand it to reach the card.
    await page.locator('[data-testid="welcome-setup-toggle"]').click();

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard).toBeVisible();
    // Found + signed in is the expected state, so it carries no colored edge -
    // only a state wanting attention does. The check icon is the found signal.
    await expect(kimiCard).not.toHaveClass(/border-l-attention/);
    await expect(kimiCard.getByText('Not signed in')).not.toBeVisible();
    await expect(kimiCard.getByText('v1.37.0')).toBeVisible();
  });

  test('Kimi card stays in default green state when authenticated is undefined (other agents)', async () => {
    // No override = default fixture has Kimi found:false. Use a different
    // agent (claude) which is the default-detected agent in the mock.
    ({ browser, page } = await launchWithAgentOverride('kimi', {
      found: true,
      path: '/usr/bin/kimi',
      version: '1.37.0',
      // authenticated intentionally omitted
    }));

    // Every agent is found and none is signed out, so the setup panel starts
    // collapsed behind the readiness line; expand it to reach the card.
    await page.locator('[data-testid="welcome-setup-toggle"]').click();

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    await expect(kimiCard).toBeVisible();
    // No amber treatment when authenticated is undefined
    await expect(kimiCard).not.toHaveClass(/border-l-attention/);
    await expect(kimiCard.getByText('Not signed in')).not.toBeVisible();
  });
});

test.describe('Agent Auth Warning - OpenCode Welcome Screen', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('OpenCode card shows amber "Not signed in" state when found but unauthenticated', async () => {
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: false,
    }));

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    await expect(opencodeCard).toHaveClass(/border-l-attention/);
    await expect(opencodeCard.getByText('Not signed in')).toBeVisible();

    const copyButton = page.locator('[data-testid="welcome-agent-opencode-copy-login"]');
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toContainText('opencode auth login');
  });

  test('a signed-out card leads the agent grid and spans it, so its sign-in line stays on one row', async () => {
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: false,
    }));

    await expect(page.locator('[data-testid="welcome-agent-opencode-copy-login"]')).toBeVisible();

    // Every agent with an auth probe has a login command, and "Not signed in - Copy <command>"
    // is wider than a third of the grid. In a one-column cell both halves wrapped over the
    // agent's name. The fixed-height status line hides that from the card's own height, so
    // compare each half against a one-line sibling instead: Claude's version line.
    const geometry = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="welcome-agent-grid"]');
      const signedOutCard = document.querySelector('[data-testid="welcome-agent-opencode"]');
      const siblingCard = document.querySelector('[data-testid="welcome-agent-claude"]');
      const copyButton = document.querySelector('[data-testid="welcome-agent-opencode-copy-login"]');
      if (!grid || !signedOutCard || !siblingCard || !copyButton) return null;
      const statusLabel = Array.from(signedOutCard.querySelectorAll('span'))
        .find((span) => span.textContent === 'Not signed in');
      const siblingVersion = Array.from(siblingCard.querySelectorAll('span'))
        .find((span) => span.textContent === 'v2.1.72');
      if (!statusLabel || !siblingVersion) return null;
      const signedOutBox = signedOutCard.getBoundingClientRect();
      const copyBox = copyButton.getBoundingClientRect();
      return {
        leadsGrid: grid.firstElementChild === signedOutCard,
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
    // Soft, so a failure reports every property at once. The wrap and the order are separate facts.
    expect.soft(geometry.statusHeight, 'Not signed in wraps').toBeLessThan(geometry.lineHeight * 1.5);
    expect.soft(geometry.copyHeight, 'the Copy control wraps').toBeLessThan(geometry.lineHeight * 1.5);
    expect.soft(geometry.copyRight, 'the Copy control overflows the card').toBeLessThanOrEqual(geometry.signedOutRight);
    expect.soft(geometry.signedOutWidth, 'the card does not span the grid').toBeGreaterThan(geometry.siblingWidth * 2);
    expect.soft(geometry.leadsGrid, 'the card does not lead the grid').toBe(true);
  });

  test('every signed-out agent leads the grid together, in their original list order, each spanning it', async () => {
    // kimi (list index 8) and opencode (list index 9) both define probeAuth,
    // so both can legitimately be signed out at once. This pins that the
    // reorder moves the WHOLE signed-out group, in its original relative
    // order, not just the first signed-out agent found.
    ({ browser, page } = await launchWithAgentOverrides({
      kimi: {
        found: true,
        path: '/usr/bin/kimi',
        version: '1.37.0',
        authenticated: false,
      },
      opencode: {
        found: true,
        path: '/usr/bin/opencode',
        version: '1.14.25',
        authenticated: false,
      },
    }));

    const kimiCard = page.locator('[data-testid="welcome-agent-kimi"]');
    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    const claudeCard = page.locator('[data-testid="welcome-agent-claude"]');
    await expect(kimiCard).toBeVisible();
    await expect(opencodeCard).toBeVisible();
    await expect(claudeCard).toBeVisible();

    const geometry = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="welcome-agent-grid"]');
      const kimi = document.querySelector('[data-testid="welcome-agent-kimi"]');
      const opencode = document.querySelector('[data-testid="welcome-agent-opencode"]');
      const claude = document.querySelector('[data-testid="welcome-agent-claude"]');
      if (!grid || !kimi || !opencode || !claude) return null;
      return {
        firstThreeTestIds: Array.from(grid.children)
          .slice(0, 3)
          .map((child) => child.getAttribute('data-testid')),
        kimiWidth: kimi.getBoundingClientRect().width,
        opencodeWidth: opencode.getBoundingClientRect().width,
        claudeWidth: claude.getBoundingClientRect().width,
      };
    });

    expect(geometry).not.toBeNull();
    if (!geometry) return;
    // Read the order off the grid's actual children rather than two fixed
    // locators. Reverting the reorder renders claude first (list order), and
    // moving only the first signed-out agent renders kimi, claude, opencode.
    expect(geometry.firstThreeTestIds).toEqual([
      'welcome-agent-kimi',
      'welcome-agent-opencode',
      'welcome-agent-claude',
    ]);
    expect.soft(geometry.kimiWidth, 'the kimi card does not span the grid').toBeGreaterThan(geometry.claudeWidth * 2);
    expect.soft(geometry.opencodeWidth, 'the opencode card does not span the grid').toBeGreaterThan(geometry.claudeWidth * 2);
  });

  test('clicking the Copy button writes "opencode auth login" to the clipboard and flips to "Copied!"', async () => {
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: false,
    }));

    const copyButton = page.locator('[data-testid="welcome-agent-opencode-copy-login"]');
    await copyButton.click();

    await expect(copyButton).toContainText('Copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('opencode auth login');
  });

  test('OpenCode card stays green when authenticated:true (provider configured)', async () => {
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: true,
    }));

    // Every agent is found and none is signed out, so the setup panel starts
    // collapsed behind the readiness line; expand it to reach the card.
    await page.locator('[data-testid="welcome-setup-toggle"]').click();

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    // Found + signed in is the expected state, so it carries no colored edge -
    // only a state wanting attention does. The check icon is the found signal.
    await expect(opencodeCard).not.toHaveClass(/border-l-attention/);
    await expect(opencodeCard.getByText('Not signed in')).not.toBeVisible();
    await expect(opencodeCard.getByText('v1.14.25')).toBeVisible();
  });

  test('OpenCode card stays in default state when authenticated is null (probe failed)', async () => {
    // null = probeAuth ran but returned null (e.g. EACCES, malformed JSON, missing file).
    // The renderer treats null identically to undefined: no amber warning.
    // This pins the silent-fail intent so a future change that accidentally
    // treats null as unauthenticated will trip this test.
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      authenticated: null,
    }));

    // Every agent is found and none is signed out, so the setup panel starts
    // collapsed behind the readiness line; expand it to reach the card.
    await page.locator('[data-testid="welcome-setup-toggle"]').click();

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    await expect(opencodeCard).not.toHaveClass(/border-l-attention/);
    await expect(opencodeCard.getByText('Not signed in')).not.toBeVisible();
  });

  test('OpenCode card stays in default state when authenticated is undefined (no probe ran)', async () => {
    // No authenticated field at all = the adapter has no probeAuth or did not
    // set the field. Renderer must not show the amber warning.
    ({ browser, page } = await launchWithAgentOverride('opencode', {
      found: true,
      path: '/usr/bin/opencode',
      version: '1.14.25',
      // authenticated intentionally omitted
    }));

    // Every agent is found and none is signed out, so the setup panel starts
    // collapsed behind the readiness line; expand it to reach the card.
    await page.locator('[data-testid="welcome-setup-toggle"]').click();

    const opencodeCard = page.locator('[data-testid="welcome-agent-opencode"]');
    await expect(opencodeCard).toBeVisible();
    await expect(opencodeCard).not.toHaveClass(/border-l-attention/);
    await expect(opencodeCard.getByText('Not signed in')).not.toBeVisible();
  });
});
