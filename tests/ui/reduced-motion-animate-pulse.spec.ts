/**
 * Coverage for the `prefers-reduced-motion` rule added to `src/renderer/index.css`
 * that stops Tailwind's stock `.animate-pulse` utility (`@media (prefers-reduced-motion:
 * reduce) { .animate-pulse { animation: none } }`). Every current consumer (the
 * dictation recording dot, TerminalPanel's unseen-attention dot, WindowFrame's focus
 * hairline, QueuedPlaceholder's waiting clock, and the loading skeletons) shares this
 * one rule, so the coverage lives here at the generic-rule level rather than on any
 * one consumer - asserting the dictation dot specifically would prove nothing about
 * the other five sites, and none of them are needed to prove the rule itself works.
 *
 * The probe is a bare synthetic element carrying only the Tailwind class, appended to
 * the already-booted app page so it inherits the real `index.css` cascade. Mirrors the
 * CSS-custom-property probe in `task-card-context-window.spec.ts`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own browser so no in-page state (or the reducedMotion
// context option itself) can leak across tests.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launch(reducedMotion?: 'reduce'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/** Append a bare `.animate-pulse` div to the booted page, read its computed
 *  `animation-name`, then remove it. No component under test - just the utility
 *  class against the real cascade. */
async function probeAnimatePulseName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'animate-pulse';
    document.body.appendChild(probe);
    const animationName = getComputedStyle(probe).animationName;
    probe.remove();
    return animationName;
  });
}

test.describe('prefers-reduced-motion: Tailwind stock .animate-pulse', () => {
  test('animates normally without the OS preference', async () => {
    const { browser, page } = await launch();
    try {
      // Baseline: proves the utility itself resolves to a real animation in this
      // build, so the reduced-motion test's 'none' result below means the rule
      // fired, not that `.animate-pulse` never animated to begin with. 'pulse' is
      // Tailwind's own keyframe name for this utility (`--animate-pulse: pulse 2s
      // ...` in tailwindcss/theme.css) - a future Tailwind major that renames it
      // would legitimately red this baseline, unrelated to the rule under test.
      const animationName = await probeAnimatePulseName(page);
      expect(animationName).toBe('pulse');
    } finally {
      await browser.close();
    }
  });

  test('stops animating under prefers-reduced-motion: reduce', async () => {
    const { browser, page } = await launch('reduce');
    try {
      // Prove the emulation is actually in force (mirrors activity-marks.spec.ts /
      // onboarding-welcome-screen.spec.ts's reduced-motion tests): without this, a
      // context option that silently failed to apply would still let every
      // assertion below pass on the normal animated path for the wrong reason.
      const mediaMatches = await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
      expect(mediaMatches, 'prefers-reduced-motion emulation never took effect').toBe(true);

      const animationName = await probeAnimatePulseName(page);
      expect(animationName).toBe('none');
    } finally {
      await browser.close();
    }
  });
});
