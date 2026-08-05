import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own page so __mockAgentListOverrides never leaks
// across tests (mirrors agent-auth-warning.spec.ts's launchWithAgentOverride).
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

interface LaunchMotionOptions {
  /** Emulate the OS-level `prefers-reduced-motion: reduce` preference. */
  reducedMotion?: boolean;
  /** Add `.no-motion` to `<html>` before React paints, which is what the app's
   *  Animations-off setting does (`config-store.ts`). Set the class directly
   *  rather than seeding `animationsEnabled: false`: that subscription fires
   *  only on a CHANGE, so a pre-seeded false never toggles the class on. */
  noMotionClass?: boolean;
}

async function launchWithOverrides(
  overrides: Record<string, unknown>,
  configOverrides?: Record<string, unknown>,
  motion?: LaunchMotionOptions,
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ...(motion?.reducedMotion ? { reducedMotion: 'reduce' as const } : {}),
  });
  const page = await context.newPage();
  await page.addInitScript((args: { agents: Record<string, unknown>; config: Record<string, unknown> | null }) => {
    (window as unknown as { __mockAgentListOverrides: Record<string, unknown> }).__mockAgentListOverrides = args.agents;
    if (args.config) {
      (window as unknown as { __mockConfigOverrides: Record<string, unknown> }).__mockConfigOverrides = args.config;
    }
  }, { agents: overrides, config: configOverrides ?? null });
  if (motion?.noMotionClass) {
    await page.addInitScript(() => {
      // Applied twice on purpose. DOMContentLoaded is the reliable pass, because an init script
      // runs at document-start where `documentElement` may not exist yet; it still lands before
      // the mascot's first paint, since React's initial commit is scheduled asynchronously and
      // runs after that event even though the deferred module script executes before it. The
      // immediate pass just removes the dependency on that ordering.
      const applyNoMotion = () => document.documentElement?.classList.add('no-motion');
      applyNoMotion();
      document.addEventListener('DOMContentLoaded', applyNoMotion);
    });
  }
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

  // The mount set comes from each sequence's `mountFrames` in the branding package, which is NOT
  // the set its `clip` plays: a sequence rests on `restFrame` when it ends and under reduced
  // motion even when the clip never names that frame. Mount only the played poses and the mascot
  // renders NOTHING once motion is off, because `.overseer-frame` is `visibility: hidden` by
  // default and only `.overseer-frame--rest` unhides. These two tests are the guard: they assert
  // the rest frame is actually VISIBLE (Playwright honors `visibility: hidden`), which is what a
  // mount-set regression would break. Upstream shipped this bug twice, so pin both motion paths -
  // they are not equivalent (`.no-motion` zeroes `animation-duration`; the media query sets
  // `animation: none`).
  test('with the Animations setting off, the mascot rests on the canonical frame', async () => {
    ({ browser, page } = await launchWithOverrides({}, undefined, { noMotionClass: true }));

    const mascot = page.getByRole('img', { name: 'Pixel-art Kangentic mascot' });
    await expect(mascot).toBeVisible();
    await expect(mascot.locator('.overseer-frame--rest')).toBeVisible();

    // The intro is a one-shot whose animationend still fires at 0s, so it must have handed off
    // rather than leaving the hero frozen mid-wave.
    await expect.poll(
      async () => mascot.getAttribute('class'),
      { timeout: 5000 },
    ).toContain('overseer--blink-loop');
    await expect(mascot.locator('.overseer-frame--rest')).toBeVisible();

    // Prove the setting is actually in force, or this test cannot go red for its own premise: the
    // 600ms intro hands off well inside the poll above and the rest frame is visible for most of
    // both cycles, so every assertion so far passes identically on the normal animated path.
    // blink-loop's rest track reads '3.807s' there.
    const restFrameDuration = await mascot.locator('.overseer-frame--rest')
      .evaluate((element) => getComputedStyle(element).animationDuration);
    expect(
      restFrameDuration,
      '.no-motion never took effect, so this test was exercising the normal animated path',
    ).toBe('0s');
  });

  test('under prefers-reduced-motion, the mascot rests on the canonical frame', async () => {
    ({ browser, page } = await launchWithOverrides({}, undefined, { reducedMotion: true }));

    const mascot = page.getByRole('img', { name: 'Pixel-art Kangentic mascot' });
    await expect(mascot).toBeVisible();
    // The packaged CSS sets `animation: none` here, so no animationend ever fires and the intro
    // never hands off. Resting is reached by doing nothing, which is the correct rendering.
    await expect(mascot.locator('.overseer-frame--rest')).toBeVisible();
    // Count first: `toBeHidden` also passes for an ABSENT element, so on its own it would survive
    // the very mount-set regression these two tests exist to catch.
    await expect(mascot.locator('.overseer-frame--wave')).toHaveCount(1);
    await expect(mascot.locator('.overseer-frame--wave')).toBeHidden();

    // Prove the emulation is actually in force, mirroring the `.no-motion` test above: without
    // this, every assertion so far also passes on the normal animated path, since blink-loop
    // rests on this same frame between blinks and wave-once ends on it too. The packaged CSS
    // reduced-motion query sets `animation: none` (not just a zeroed duration, which is
    // `.no-motion`'s distinct mechanism), so `animationName` reads the literal string 'none'.
    const restFrameAnimationName = await mascot.locator('.overseer-frame--rest')
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(
      restFrameAnimationName,
      'prefers-reduced-motion emulation never took effect, so this test was exercising the normal animated path',
    ).toBe('none');
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

  test('the footer links sit on one row and each opens its own URL externally', async () => {
    ({ browser, page } = await launchWithOverrides({}));

    const setupGuide = page.locator('[data-testid="welcome-setup-guide"]');
    const pairPhone = page.locator('[data-testid="welcome-pair-phone"]');
    await expect(setupGuide).toBeVisible();
    await expect(pairPhone).toBeVisible();

    // Pinning the row's geometry mechanically, not by eye. The container is
    // `flex` with no `flex-wrap`, so it cannot break onto a second line: what
    // this actually guards is the row surviving as a row (a switch to
    // flex-col, or the buttons going block-level, splits the y values by a
    // full line box), and the two links staying side by side in order rather
    // than overlapping or reordering.
    // Compared with a tolerance rather than exactly: Blink lays out in 1/64px
    // units and `items-center` halves the leftover cross-axis space, so two
    // children whose heights ever diverge by an odd sub-pixel amount get y
    // values differing in the last digit. Zero-tolerance geometry assertions
    // are banned by .claude/rules/cross-platform-parity.md; a real break moves
    // y far past 1px, so the guard keeps its teeth.
    const [setupGuideBox, pairPhoneBox] = await Promise.all([
      setupGuide.boundingBox(),
      pairPhone.boundingBox(),
    ]);
    expect(setupGuideBox).not.toBeNull();
    expect(pairPhoneBox).not.toBeNull();
    expect(Math.abs(pairPhoneBox!.y - setupGuideBox!.y)).toBeLessThanOrEqual(1);
    // gap-4 (16px) makes the ordering strict, so this needs no tolerance.
    expect(pairPhoneBox!.x).toBeGreaterThan(setupGuideBox!.x + setupGuideBox!.width);

    // Both links are clicked, so each one's URL is pinned to its own button.
    // Asserting the accumulated array in order also catches a handler wired to
    // the wrong constant, which asserting only the last call would miss.
    await setupGuide.click();
    await pairPhone.click();
    await expect
      .poll(() => page.evaluate(() => window.__openedExternalUrls ?? []))
      .toEqual([
        'https://www.kangentic.com/getting-started/',
        'https://www.kangentic.com/mobile/pairing/',
      ]);
  });
});
