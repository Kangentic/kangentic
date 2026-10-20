/**
 * The OS reduced-motion preference never reaches Kangentic's renderers.
 *
 * Main appends Chromium's `force-prefers-no-reduced-motion` switch
 * (src/main/index.ts), because Chromium caches the OS value in the browser
 * process and once held a stale `reduce` that froze every activity mark until a
 * relaunch. The only motion off switch is Settings > Performance > Animations.
 *
 * Linux only. Chromium takes the OS value there from GTK's
 * `gtk-enable-animations`, which a `settings.ini` under a temporary
 * XDG_CONFIG_DIRS turns off for this one launch. Windows and macOS read a
 * system-wide setting a test cannot scope to one process. CI runs this tier on
 * Linux, so the red-green lives there: without the switch Chromium reports
 * `reduce` here.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, getTestDataDir, cleanupTestDataDir, closeApp } from './helpers';

const TEST_NAME = 'os-reduced-motion';

test.describe('OS reduced-motion preference', () => {
  test.skip(
    process.platform !== 'linux',
    'Chromium reads the OS animation setting from GTK only on Linux; CI runs this tier there',
  );

  let app: ElectronApplication | undefined;
  let page: Page;
  let gtkConfigDirs: string | undefined;

  test.beforeAll(async () => {
    gtkConfigDirs = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-gtk-'));
    // GTK 3 and GTK 4 each read their own directory; Electron picks one.
    for (const gtkVersion of ['gtk-3.0', 'gtk-4.0']) {
      fs.mkdirSync(path.join(gtkConfigDirs, gtkVersion), { recursive: true });
      fs.writeFileSync(
        path.join(gtkConfigDirs, gtkVersion, 'settings.ini'),
        '[Settings]\ngtk-enable-animations=false\n',
      );
    }
    // XDG_CONFIG_DIRS rather than XDG_CONFIG_HOME, so Electron's userData
    // path (derived from XDG_CONFIG_HOME on Linux) stays where it always is.
    const launched = await launchApp({
      dataDir: getTestDataDir(TEST_NAME),
      extraEnv: { XDG_CONFIG_DIRS: gtkConfigDirs },
    });
    app = launched.app;
    page = launched.page;
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTestDataDir(TEST_NAME);
    if (gtkConfigDirs) fs.rmSync(gtkConfigDirs, { recursive: true, force: true });
  });

  test('Chromium reports no reduced-motion preference while the OS asks for one', async () => {
    const animationSettings = await app!.evaluate(({ systemPreferences }) =>
      systemPreferences.getAnimationSettings(),
    );

    // The switch does not touch this value, so it shows whether GTK really
    // turned animations off for this launch. Without it a pass would prove
    // nothing. A desktop session's XSETTINGS daemon overrides settings.ini, so
    // run this under xvfb, as CI does.
    expect(
      animationSettings.shouldRenderRichAnimation,
      'precondition: GTK must report animations off for this launch',
    ).toBe(false);

    // gfx::Animation::PrefersReducedMotion(), the value Chromium copies into
    // every web contents' preferences, read where Playwright's media emulation
    // cannot reach it. With GTK animations off it reads true without the switch
    // and false with it (measured on Electron 44.5.1 under Playwright).
    expect(animationSettings.prefersReducedMotion).toBe(false);

    // Playwright emulates `prefers-reduced-motion: no-preference` on every page
    // it drives unless told otherwise, so the renderer read false even without
    // the switch until this override was lifted. Lifted, it reads true without
    // the switch and false with it (same measurement).
    await page.emulateMedia({ reducedMotion: null });
    const rendererReducesMotion = await page.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    expect(rendererReducesMotion).toBe(false);
  });
});
