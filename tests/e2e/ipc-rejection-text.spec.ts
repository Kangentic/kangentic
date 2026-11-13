/**
 * The text Electron gives the renderer when an `ipcMain.handle` handler throws.
 *
 * Main reports a handler's failure itself (the IPC wrap,
 * src/main/analytics/ipc-handler-report.ts), so main's Sentry drops the
 * renderer's copy of the same rejection by its text
 * (`IPC_REJECTION_DUPLICATE_PATTERN`, src/shared/ipc-rejection.ts). If Electron
 * ever words that rejection differently, every IPC defect arrives twice, or a
 * real renderer error goes missing. The UI tier's mock writes the text by hand,
 * so only real Electron can say what it is.
 *
 * Real wiring: Electron's IPC serializing a handler's throw into the renderer's
 * rejection.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, closeApp, getTestDataDir } from './helpers';
import { IPC_REJECTION_DUPLICATE_PATTERN } from '../../src/shared/ipc-rejection';
import { PROJECT_NOT_FOUND_PREFIX } from '../../src/shared/ipc-channels';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp({ dataDir: getTestDataDir('ipc-rejection-text') }));
});

test.afterAll(async () => {
  await closeApp(app);
});

test('a handler that throws reaches the renderer as the text main filters on', async () => {
  const message = await page.evaluate(async () => {
    try {
      await window.electronAPI.projects.open('no-such-project');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(message).toBe(`Error invoking remote method 'project:open': RefusalError: ${PROJECT_NOT_FOUND_PREFIX}no-such-project`);
  expect(message).toMatch(IPC_REJECTION_DUPLICATE_PATTERN);
});
