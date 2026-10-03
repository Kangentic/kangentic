/**
 * UI coverage for the renderer half of the kangentic.json refusal work: a team
 * file that exists but cannot be read (merge conflict markers, say) is never
 * overwritten, and the refusal has to reach the user.
 *
 *   - ShortcutsTab: a refused `boardConfig.setShortcuts` raises an error toast.
 *   - GitTab: a refused `boardConfig.setDefaultBaseBranch` raises an error toast.
 *   - App.tsx: the `boardConfig.onWarnings` push lands in the warning banner,
 *     and a push for a project that is not current is ignored.
 *   - useProjectSwitchEffect: a project switch clears the outgoing project's
 *     banner at once, without waiting on the incoming project's fetch.
 *
 * The mock's boardConfig methods are overridden from inside this spec (the
 * mock itself is untouched). The mock builds `window.electronAPI` synchronously
 * in its init script and the components read it at call time, so a method
 * replaced after load is what the next call sees. Only `onWarnings` has to be
 * replaced BEFORE App mounts, because App subscribes once, so that spec
 * installs a recording wrapper in an init script that runs after the mock.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import {
  launchPage,
  createProject,
  waitForBoard,
  settleFrames,
  gotoVite,
  waitForViteReady,
} from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');

const REFUSAL_MESSAGE = 'kangentic.json could not be read, so this change was not saved to it. Fix the file and try again.';
const OPEN_WARNING = 'kangentic.json could not be read, so board edits are not saved to it until it is fixed.';

async function openSettingsTab(page: Page, tabName: string): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: tabName, exact: true }).click();
}

async function readCurrentProjectId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { project: { getState: () => { currentProject: { id: string } | null } } };
    }).__zustandStores;
    const currentProject = stores.project.getState().currentProject;
    if (!currentProject) throw new Error('no current project');
    return currentProject.id;
  });
}

test.describe('kangentic.json save refusals reach the user', () => {
  test('a refused shortcut save raises an error toast', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `ShortcutRefusal ${Date.now()}`);

      await page.evaluate((refusal) => {
        const win = window as unknown as {
          __setShortcutsAttempts: number;
          electronAPI: { boardConfig: { setShortcuts: () => Promise<void> } };
        };
        win.__setShortcutsAttempts = 0;
        win.electronAPI.boardConfig.setShortcuts = async () => {
          win.__setShortcutsAttempts += 1;
          throw new Error(refusal);
        };
      }, REFUSAL_MESSAGE);

      await openSettingsTab(page, 'Shortcuts');
      await page.locator('[data-testid="add-shortcut"]').click();

      const toast = page.getByTestId('toast').filter({ hasText: 'Could not save shortcuts' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      // The refusal text is the sentence main authored, with no channel or class prefix.
      await expect(toast).toContainText(REFUSAL_MESSAGE);

      // The save really went through the rejecting write, so the toast is the
      // product of the catch and not of some other error path.
      const attempts = await page.evaluate(
        () => (window as unknown as { __setShortcutsAttempts: number }).__setShortcutsAttempts,
      );
      expect(attempts).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  test('a refused base branch save raises an error toast', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `BaseBranchRefusal ${Date.now()}`);

      await page.evaluate((refusal) => {
        const win = window as unknown as {
          __setDefaultBaseBranchCalls: string[];
          electronAPI: { boardConfig: { setDefaultBaseBranch: (branch: string) => Promise<void> } };
        };
        win.__setDefaultBaseBranchCalls = [];
        win.electronAPI.boardConfig.setDefaultBaseBranch = async (branch: string) => {
          win.__setDefaultBaseBranchCalls.push(branch);
          throw new Error(refusal);
        };
      }, REFUSAL_MESSAGE);

      await openSettingsTab(page, 'Git');
      await page.locator('[data-testid="branch-picker-input"]').click();
      const dropdown = page.locator('[data-testid="branch-picker-dropdown"]');
      await expect(dropdown).toBeVisible({ timeout: 3000 });
      // The mock lists main, develop, feature/auth, feature/dashboard, fix/login-bug.
      await dropdown.getByRole('button', { name: 'develop', exact: true }).click();

      const toast = page.getByTestId('toast').filter({ hasText: 'Could not save the base branch to kangentic.json' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toContainText(REFUSAL_MESSAGE);

      const calls = await page.evaluate(
        () => (window as unknown as { __setDefaultBaseBranchCalls: string[] }).__setDefaultBaseBranchCalls,
      );
      expect(calls).toEqual(['develop']);
    } finally {
      await browser.close();
    }
  });
});

test.describe('open-time config warnings', () => {
  /**
   * A launch that records every callback App registers through
   * `boardConfig.onWarnings`, so the spec can play the push main sends. The
   * wrapper runs after the mock's init script (init scripts run in the order
   * they were added) and before App mounts.
   */
  async function launchWithWarningsPushCapture(): Promise<{ browser: Browser; page: Page }> {
    await waitForViteReady();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(`
      (function () {
        window.__warningsPushListeners = [];
        window.electronAPI.boardConfig.onWarnings = function (callback) {
          window.__warningsPushListeners.push(callback);
          return function () {
            var index = window.__warningsPushListeners.indexOf(callback);
            if (index >= 0) window.__warningsPushListeners.splice(index, 1);
          };
        };
      })();
    `);
    await gotoVite(page);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    return { browser, page };
  }

  async function pushWarnings(page: Page, projectId: string, warnings: string[]): Promise<void> {
    await page.evaluate(
      ({ pushedProjectId, pushedWarnings }) => {
        const listeners = (window as unknown as {
          __warningsPushListeners: Array<(projectId: string, warnings: string[]) => void>;
        }).__warningsPushListeners.slice();
        for (const listener of listeners) listener(pushedProjectId, pushedWarnings);
      },
      { pushedProjectId: projectId, pushedWarnings: warnings },
    );
  }

  test('the onWarnings push shows in the banner for the current project and is ignored for another', async () => {
    const { browser, page } = await launchWithWarningsPushCapture();
    try {
      await createProject(page, `WarningsPush ${Date.now()}`);
      const currentProjectId = await readCurrentProjectId(page);

      // App subscribes in an effect, so wait for the subscription to exist
      // rather than assuming it has run.
      await expect
        .poll(
          () => page.evaluate(
            () => (window as unknown as { __warningsPushListeners: unknown[] }).__warningsPushListeners.length,
          ),
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);

      const banner = page.locator('text=kangentic.json could not be read');

      // A push for a project that is not current changes nothing. Settle two
      // frames so a wrongly shown banner would have rendered, then assert absence.
      await pushWarnings(page, 'proj-not-the-current-one', [OPEN_WARNING]);
      await settleFrames(page);
      await expect(banner).toHaveCount(0);

      // The same push for the current project is what the banner shows. This
      // also proves the listener was live during the ignored push above.
      await pushWarnings(page, currentProjectId, [OPEN_WARNING]);
      await expect(banner).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});

test.describe('project switch and the warning banner', () => {
  test('switching projects clears the outgoing banner before the incoming fetch resolves', async () => {
    const { browser, page } = await launchPage();
    try {
      await page.evaluate((warning) => {
        (window as unknown as { __mockLastConfigWarnings: string[] }).__mockLastConfigWarnings = [warning];
      }, OPEN_WARNING);

      await createProject(page, `WarnProjectA ${Date.now()}`);
      const banner = page.locator('text=kangentic.json could not be read');
      await expect(banner).toBeVisible({ timeout: 5000 });
      const projectAId = await readCurrentProjectId(page);

      // The incoming project's stored-warnings fetch never resolves, so the
      // fetch cannot be what hides the banner (an empty answer would clear it
      // through receiveOpenConfigWarnings). Only the synchronous clear on the
      // switch can. Calls are recorded to prove the fetch really started.
      await page.evaluate(() => {
        const win = window as unknown as {
          __lastWarningsFetchIds: string[];
          electronAPI: { boardConfig: { getLastWarnings: (projectId: string) => Promise<string[]> } };
        };
        win.__lastWarningsFetchIds = [];
        win.electronAPI.boardConfig.getLastWarnings = (projectId: string) => {
          win.__lastWarningsFetchIds.push(projectId);
          return new Promise<string[]>(() => {});
        };
      });

      await createProject(page, `WarnProjectB ${Date.now()}`);
      await waitForBoard(page);

      const projectBId = await readCurrentProjectId(page);
      expect(projectBId).not.toBe(projectAId);

      await expect
        .poll(
          () => page.evaluate(
            () => (window as unknown as { __lastWarningsFetchIds: string[] }).__lastWarningsFetchIds,
          ),
          { timeout: 5000 },
        )
        .toContain(projectBId);

      await expect(banner).toBeHidden({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
