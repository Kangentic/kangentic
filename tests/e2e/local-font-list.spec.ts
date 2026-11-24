/**
 * E2E: the Terminal Font Family picker's list comes from Chromium in the built app.
 *
 * The list is `window.queryLocalFonts()`, read in the preload
 * (src/preload/local-fonts.ts), so listing fonts starts no process. It needs
 * the `local-fonts` permission the default session grants the app window, and
 * it has to answer on the `file://` page a built app loads. The unit tier
 * injects the query, and the UI tier runs the mock bridge in a plain browser,
 * so neither can tell a denied permission or a refused origin from a machine
 * with no fonts. Only a real Electron window on the real build can, which is
 * the wiring this spec exists for.
 */
import { test, expect } from '@playwright/test';
import { launchApp, closeApp, getTestDataDir, cleanupTestDataDir } from './helpers';

const TEST_NAME = 'local-font-list';

test('the built app lists installed fonts for the font picker', async () => {
  const dataDir = getTestDataDir(TEST_NAME);
  const { app, page } = await launchApp({ dataDir });
  try {
    const answer = await page.evaluate(async () => ({
      protocol: window.location.protocol,
      permission: (await navigator.permissions.query({ name: 'local-fonts' as PermissionName })).state,
      fonts: await window.electronAPI.font.getAvailable(),
    }));
    expect(answer.protocol).toBe('file:');
    expect(answer.permission).toBe('granted');
    expect(answer.fonts.length).toBeGreaterThan(0);
  } finally {
    await closeApp(app);
    cleanupTestDataDir(TEST_NAME);
  }
});
