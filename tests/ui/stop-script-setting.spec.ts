/**
 * UI tests for the project's Stop script: the Git tab's "Stop script" row
 * (src/renderer/components/settings/tabs/GitTab.tsx) and the toast a failed run
 * raises (src/renderer/App.tsx, src/renderer/lib/stop-script-toast.ts).
 *
 * The row sits in its own card, not the Worktrees card, because the script also
 * runs in the project folder for a task with no worktree. It saves to
 * `kangentic.json` through `boardConfig.setStopScript`, never to the project's
 * config file. Each test owns its page, so a panel or draft left by one test
 * cannot reach the next.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

const ROW_TEST_ID = 'setting-row-git.stopScript';
const INIT_SCRIPT_ROW_TEST_ID = 'setting-row-git.initScript';

interface StopScriptWindow {
  __mockStopScriptSaves?: Array<string | null>;
  __mockStopScriptSaveError?: string;
  __mockFireStopScriptFailed?: (event: unknown) => void;
}

let browser: Browser;
let page: Page;

test.beforeEach(async () => {
  ({ browser, page } = await launchPage());
  await createProject(page, `stop-script-${Date.now()}`);
});

test.afterEach(async () => {
  await browser?.close();
});

async function openGitTab(): Promise<void> {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-panel').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Git', exact: true }).click();
  await expect(page.getByTestId(ROW_TEST_ID)).toBeVisible();
}

async function commitStopScript(script: string): Promise<void> {
  const input = page.getByTestId(ROW_TEST_ID).locator('input');
  await input.fill(script);
  await input.press('Enter');
}

async function savedScripts(): Promise<Array<string | null>> {
  return page.evaluate(() => (window as unknown as StopScriptWindow).__mockStopScriptSaves ?? []);
}

test.describe('Git tab: Stop script row', () => {
  test('starts empty, with its placeholder, in a card of its own', async () => {
    await openGitTab();

    const input = page.getByTestId(ROW_TEST_ID).locator('input');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', 'npm run stop');
    await expect(page.getByText('Leftover processes', { exact: true })).toBeVisible();
    await expect(page.getByText('How this project stops what a task leaves running.', { exact: true })).toBeVisible();
  });

  test('still shows with worktrees off, when the Worktrees card has closed', async () => {
    await openGitTab();
    await expect(page.getByTestId(INIT_SCRIPT_ROW_TEST_ID)).toBeVisible();

    await page.getByTestId('setting-row-git.worktreesEnabled').click();

    await expect(page.getByTestId(INIT_SCRIPT_ROW_TEST_ID)).toHaveCount(0);
    await expect(page.getByTestId(ROW_TEST_ID)).toBeVisible();
  });

  test('saves to kangentic.json, and the row reads it back after a reopen', async () => {
    await openGitTab();

    await commitStopScript('npm run stack:stop');
    await expect.poll(savedScripts).toEqual(['npm run stack:stop']);

    await page.keyboard.press('Escape');
    await page.getByTestId('settings-panel').waitFor({ state: 'hidden', timeout: 5000 });
    await openGitTab();
    await expect(page.getByTestId(ROW_TEST_ID).locator('input')).toHaveValue('npm run stack:stop');
  });

  test('a cleared field saves null, which removes the key', async () => {
    await openGitTab();
    await commitStopScript('npm run stop');
    await expect.poll(savedScripts).toEqual(['npm run stop']);

    await commitStopScript('');

    await expect.poll(savedScripts).toEqual(['npm run stop', null]);
  });

  test('a refused save tells the user', async () => {
    await openGitTab();
    await page.evaluate(() => {
      (window as unknown as StopScriptWindow).__mockStopScriptSaveError = 'kangentic.json has merge conflict markers';
    });

    await commitStopScript('npm run stop');

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: "Couldn't save Stop script" });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast.getByTestId('toast-body')).toContainText('merge conflict markers');
  });
});

test.describe('Stop script failed toast', () => {
  async function fireFailure(failure: unknown, projectId?: string): Promise<void> {
    await page.evaluate(([failedWith, explicitProjectId]) => {
      const scoped = window as unknown as StopScriptWindow & {
        electronAPI: { projects: { getCurrent: () => Promise<{ id: string } | null> } };
      };
      return scoped.electronAPI.projects.getCurrent().then((project) => {
        scoped.__mockFireStopScriptFailed?.({
          projectId: explicitProjectId ?? project?.id,
          taskId: 'task-1',
          taskTitle: 'Fix login',
          failure: failedWith,
        });
      });
    }, [failure, projectId] as const);
  }

  test('reads as a timed warning naming the task, the exit code and the script\'s last line', async () => {
    await fireFailure({ kind: 'exit-code', exitCode: 1, detail: "'stack:stop' is not recognized as an internal or external command." });

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Stop script failed' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toHaveAttribute('data-variant', 'warning');
    await expect(toast).toHaveAttribute('data-persistent', 'false');
    await expect(toast.getByTestId('toast-title')).toHaveText('Stop script failed');
    await expect(toast.getByTestId('toast-body')).toHaveText(`"Fix login": exited with code 1. 'stack:stop' is not recognized as an internal or external command.`);
    await expect(toast.getByTestId('toast-countdown')).toHaveCount(1);
    await expect(toast.getByTestId('toast-action')).toHaveCount(0);
  });

  test('says how long a script that timed out was given', async () => {
    await fireFailure({ kind: 'timeout', timeoutMs: 120000 });

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Stop script failed' });
    await expect(toast.getByTestId('toast-body')).toHaveText('"Fix login": timed out after 2 minutes.');
  });

  test('stays out of a project the user is not looking at', async () => {
    await fireFailure({ kind: 'timeout', timeoutMs: 30000 }, 'another-project');

    // Fired synchronously inside the evaluate above, so nothing is on its way.
    await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Stop script failed' })).toHaveCount(0);
  });
});
