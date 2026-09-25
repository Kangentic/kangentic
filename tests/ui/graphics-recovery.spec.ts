/**
 * UI tests for the graphics recovery surfaces (Sentry DESKTOP-18 / DESKTOP-W):
 * the one-time toast App.tsx raises from `gpuHealth.readStatus()`, and the
 * Settings > Performance row that is the standing record and the way back.
 *
 * Why the toast is PULLED and not pushed is the thing these tests protect. Both
 * facts are decided in main during boot, when a `webContents.send` can land
 * before the renderer has registered any listener and be dropped silently, and
 * the escalation record behind them is already cleared by then - so a dropped
 * push would lose the notice permanently. The mock mirrors main's consume-on-
 * read, so "fires exactly once" is a real assertion here rather than a
 * coincidence of test ordering.
 *
 * Every "no toast" case counts through `toastCountRightNow` rather than
 * `toHaveCount(0)`, for the same reason it does in idle-toast.spec.ts: a toast
 * that auto-dismisses inside the retry window makes a negative case pass
 * against code that raised one. That file also pushes `durationSeconds` out to
 * a minute; this one cannot, because the notice fires during bootstrap and a
 * post-load config patch arrives too late to reach it. The auto-dismiss case
 * below calibrates against a control toast instead.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, toastCountRightNow } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-graphics-recovery';

/** How long to let a toast that should NOT exist have to show up. */
const NEGATIVE_ASSERTION_BUDGET_MS = 300;

interface LaunchOptions {
  /** Arms main's one-shot notice for this launch. */
  noticePending?: boolean;
  /** Whether this launch is actually running without acceleration. */
  softwareRendering?: boolean;
  /** Seeds the persisted setting the Performance tab reads. */
  graphicsAccelerationEnabled?: boolean;
  graphicsAccelerationOffBy?: 'app' | 'user' | null;
  /**
   * Simulates main's whenReady write landing AFTER this renderer's first
   * config read: the mock's first config.get()/getGlobal() call reports the
   * seeded (stale) `graphicsAccelerationEnabled`, and every call after that
   * reports main's real write instead.
   */
  accelerationWriteLandsAfterBoot?: boolean;
  /** Makes the mock's gpuHealth.readStatus() invoke reject instead of resolving. */
  readStatusRejects?: boolean;
  /**
   * Skips seeding a current project, so `currentProject` stays null through
   * boot. `useProjectSwitchEffect` re-reads config as a side effect of ITS
   * OWN cold-path project switch, entirely independent of the GPU notice -
   * with a project seeded, that incidental re-read races the notice's own
   * re-read and can mask the very bug accelerationWriteLandsAfterBoot exists
   * to catch. Settings > Performance is a `category: 'system'` tab (see
   * settings-tab-scope.md) and renders with no project open, so this is safe
   * for a Performance-tab-only assertion.
   */
  omitProject?: boolean;
}

async function launchWithState(
  options: LaunchOptions = {},
): Promise<{ browser: Browser; page: Page; pageErrors: Error[] }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockGpuNoticePending = ${options.noticePending === true};
    window.__mockGpuSoftwareRendering = ${options.softwareRendering === true};
    window.__mockGraphicsAccelerationWriteLandsAfterBoot = ${options.accelerationWriteLandsAfterBoot === true};
    window.__mockGpuHealthReadStatusRejects = ${options.readStatusRejects === true};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Graphics Recovery Test',
        path: '/mock/graphics-recovery-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-gfx-' + s.name.toLowerCase().replace(/\\s+/g, '-'),
          position: i,
          created_at: ts,
        }));
      });

      state.config.graphicsAccelerationEnabled = ${options.graphicsAccelerationEnabled ?? true};
      state.config.graphicsAccelerationOffBy = ${
        options.graphicsAccelerationOffBy ? `'${options.graphicsAccelerationOffBy}'` : 'null'
      };
      // Seeded (not left undefined) so App.tsx's one-time onboardedProjectIds
      // backfill never fires an incidental updateConfig() during boot. That
      // call is otherwise a config-read confound for the re-read test below.
      state.config.onboardedProjectIds = [];

      return ${options.omitProject ? '{}' : `{ currentProjectId: '${PROJECT_ID}' }`};
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page, pageErrors };
}

/** Opens the settings panel straight to Performance, the way the toast's own
 *  action does (setLastSettingsTab + setSettingsOpen). */
async function openPerformanceTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => Record<string, unknown> } };
    }).__zustandStores;
    const state = stores.config.getState();
    (state.setLastSettingsTab as (tab: string) => void)('performance');
    (state.setSettingsOpen as (open: boolean) => void)(true);
  });
}

test.describe('the graphics recovery toast', () => {
  test('fires on the launch that recovered, and carries the action to Performance settings', async () => {
    const { browser, page } = await launchWithState({ noticePending: true, softwareRendering: true });
    try {
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast).toContainText('Graphics acceleration is off');
      await expect(toast).toContainText('Repeated failures shut down your last run');

      // No cause claim and no tally. Both were cut deliberately: we never
      // established what killed the GPU process, and a failure count is
      // evidence for us rather than guidance for the reader.
      await expect(toast).not.toContainText(/driver/i);
      await expect(toast).not.toContainText(/\d/);

      // The action is the only route the toast offers, and the value it leads
      // to IS the undo.
      await expect(toast.getByRole('button', { name: 'Performance settings' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('renders the action inside the message, not beside it as a flex sibling', async () => {
    // Structural, not pixel-based: cross-platform-parity.md forbids
    // pixel-exact layout assertions (they differ across OS and CI), so this
    // checks DOM nesting instead of coordinates. As a flex sibling under
    // `items-start` the button pinned to the top right, detached from a
    // message that wraps to three lines; inline, it trails the last line of
    // the sentence it belongs to.
    const { browser, page } = await launchWithState({ noticePending: true, softwareRendering: true });
    try {
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      const actionButton = toast.getByRole('button', { name: 'Performance settings' });
      await expect(actionButton).toBeVisible();

      const isInsideMessageSpan = await actionButton.evaluate((buttonElement) => {
        const messageSpan = buttonElement.closest('span');
        return messageSpan !== null && (messageSpan.textContent ?? '').includes('Graphics acceleration is off');
      });
      expect(
        isInsideMessageSpan,
        'the action button must be a descendant of the span carrying the toast message, not a sibling that only renders beside it',
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('never auto-dismisses, while an ordinary toast raised beside it does', async () => {
    // Calibrated against a CONTROL toast rather than against a wait alone.
    // Seeding the config duration before boot does not reach the store in
    // time (the notice fires during bootstrap), and asserting "still here
    // after N seconds" against an unknown default is how a test like this
    // passes vacuously - it did, on the first version of this case. A control
    // raised with no duration takes whatever the default is, so if it is gone
    // and the notice is not, the difference is the notice's own `duration: 0`.
    const { browser, page } = await launchWithState({ noticePending: true, softwareRendering: true });
    try {
      await expect(page.getByTestId('toast')).toHaveCount(1);

      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores: { toast: { getState: () => Record<string, unknown> } };
        }).__zustandStores;
        (stores.toast.getState().addToast as (input: Record<string, unknown>) => void)({
          message: 'CONTROL: ordinary toast',
        });
      });
      await expect(page.getByTestId('toast')).toHaveCount(2);

      // Past the mock's 4s default plus its exit transition and the 1s
      // removal fallback.
      await page.waitForTimeout(6500);

      const toasts = page.getByTestId('toast');
      await expect(
        toasts,
        'the control toast should have auto-dismissed on the configured default; if it is still here the calibration is broken and this test proves nothing',
      ).toHaveCount(1);
      await expect(
        toasts,
        'the recovery notice must outlive an ordinary toast raised beside it, which it can only do by passing duration: 0',
      ).toContainText('Graphics acceleration is off');
    } finally {
      await browser.close();
    }
  });

  test('stays silent on a normal launch', async () => {
    const { browser, page } = await launchWithState();
    try {
      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('stays silent on a later software-rendered launch, once main has consumed the notice', async () => {
    // The standing record from here on is the Settings row, not a toast on
    // every start.
    const { browser, page } = await launchWithState({ noticePending: false, softwareRendering: true });
    try {
      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('boots cleanly with no toast when gpuHealth.readStatus() rejects', async () => {
    // The overwhelming majority of users never have a graphics problem, so
    // this is the one bootstrap invoke every one of them still makes.
    // App.tsx guards it with a `.catch` on the invoke AND a trailing `.catch`
    // on the handler body; this pins that neither leaves a hole a missing or
    // throwing handler could break boot through.
    const { browser, page, pageErrors } = await launchWithState({ readStatusRejects: true });
    try {
      // launchWithState() already waited for `text=Kangentic` to render before
      // returning, which is itself proof the boot effect ran to completion
      // past the rejection - a hung or crashed boot would have timed that out.
      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);
      expect(
        pageErrors.map((error) => error.message),
        'a rejected readStatus() must not surface as an unhandled page error',
      ).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('opens Settings on Performance when the action is clicked', async () => {
    const { browser, page } = await launchWithState({ noticePending: true, softwareRendering: true });
    try {
      await page.getByTestId('toast').getByRole('button', { name: 'Performance settings' }).click();
      await expect(page.getByText('Graphics acceleration', { exact: true })).toBeVisible();
      await expect(page.getByText('Animations', { exact: true })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

test.describe('Settings > Performance', () => {
  test('re-reads config after the notice fires, so the toggle is not stale', async () => {
    // Main writes graphicsAccelerationEnabled: false during whenReady, which
    // may land AFTER this renderer already read config at boot. App.tsx's
    // notice handler re-reads config before raising the toast for exactly
    // this reason - without it, Settings > Performance would keep showing
    // the toggle ON for the rest of a session that is demonstrably running
    // without acceleration.
    //
    // Seeding graphicsAccelerationEnabled: false into the mock's INITIAL
    // config (as the other cases in this describe block do) cannot tell
    // "the re-read happened" apart from "config was already correct at
    // boot" - deleting the re-read would not fail that case. Seeding the
    // STALE `true` value and arming accelerationWriteLandsAfterBoot makes the
    // mock's config.get()/getGlobal() report the seeded value for their own
    // documented stale-call budget and main's real write after that, so only
    // a genuine extra read beyond that budget can produce the corrected
    // toggle.
    //
    // omitProject: true is load-bearing, not incidental. With a project open,
    // useProjectSwitchEffect's cold-path switch re-reads config a SECOND time
    // once the project resolves - entirely unrelated to the GPU notice - and
    // that incidental read would consume the mock's stale-call budget on its
    // own, making this pass whether or not App.tsx's own re-read exists. With
    // no project, that hook only ever runs its inert null branch once, on
    // mount, and never again (see the mock's comment on the budget for the
    // exact accounting).
    const { browser, page } = await launchWithState({
      noticePending: true,
      softwareRendering: true,
      graphicsAccelerationEnabled: true,
      accelerationWriteLandsAfterBoot: true,
      omitProject: true,
    });
    try {
      await expect(page.getByTestId('toast')).toHaveCount(1);
      await openPerformanceTab(page);
      await expect(page.getByRole('switch', { name: 'Graphics acceleration' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    } finally {
      await browser.close();
    }
  });

  test('explains the downgrade only when Kangentic was the one that made it', async () => {
    const { browser, page } = await launchWithState({
      softwareRendering: true,
      graphicsAccelerationEnabled: false,
      graphicsAccelerationOffBy: 'app',
    });
    try {
      await openPerformanceTab(page);
      const notice = page.getByTestId('graphics-acceleration-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Kangentic turned this off after repeated failures.');
    } finally {
      await browser.close();
    }
  });

  test('says nothing when the user turned it off themselves', async () => {
    // The whole reason `graphicsAccelerationOffBy` exists. Explaining a choice
    // back to the person who made it is noise, and a later GPU failure must
    // not rewrite it either.
    const { browser, page } = await launchWithState({
      softwareRendering: true,
      graphicsAccelerationEnabled: false,
      graphicsAccelerationOffBy: 'user',
    });
    try {
      await openPerformanceTab(page);
      await expect(page.getByText('Graphics acceleration', { exact: true })).toBeVisible();
      await expect(page.getByTestId('graphics-acceleration-notice')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
