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
import { launchPage, createProject, createTask } from './helpers';

const ROW_TEST_ID = 'setting-row-git.stopScript';
const INIT_SCRIPT_ROW_TEST_ID = 'setting-row-git.initScript';

interface StopScriptWindow {
  __mockStopScriptSaves?: Array<string | null>;
  __mockStopScriptSaveProjects?: string[];
  __mockStopScriptByProject?: Record<string, string | null>;
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

  test('stays disabled until its value has loaded, so a blur cannot clear the script', async () => {
    await openGitTab();
    await commitStopScript('npm run stop');
    await expect.poll(savedScripts).toEqual(['npm run stop']);
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-panel').waitFor({ state: 'hidden', timeout: 5000 });

    await page.evaluate(() => {
      const scoped = window as unknown as {
        electronAPI: { config: { get: (...args: unknown[]) => Promise<unknown> } };
        __releaseConfigRead?: () => void;
      };
      const readConfig = scoped.electronAPI.config.get;
      const released = new Promise<void>((resolve) => { scoped.__releaseConfigRead = resolve; });
      scoped.electronAPI.config.get = async (...args: unknown[]) => {
        await released;
        return readConfig(...args);
      };
    });
    await openGitTab();

    const input = page.getByTestId(ROW_TEST_ID).locator('input');
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue('');

    await page.evaluate(() => (window as unknown as { __releaseConfigRead: () => void }).__releaseConfigRead());

    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('npm run stop');
    expect(await savedScripts()).toEqual(['npm run stop']);
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

test.describe('Git tab: Stop script row, per project', () => {
  interface ProjectHandle {
    id: string;
    name: string;
    path: string;
  }

  async function listProjects(): Promise<ProjectHandle[]> {
    return page.evaluate(async () => {
      const projects = await (window as unknown as {
        electronAPI: { projects: { list: () => Promise<ProjectHandle[]> } };
      }).electronAPI.projects.list();
      return projects.map((project) => ({ id: project.id, name: project.name, path: project.path }));
    });
  }

  async function targetSettingsAt(project: ProjectHandle): Promise<void> {
    await page.evaluate((target) => {
      const stores = (window as unknown as {
        __zustandStores: { config: { getState: () => { openProjectSettings: (path: string, name: string, tab?: string) => void } } };
      }).__zustandStores;
      stores.config.getState().openProjectSettings(target.path, target.name, 'git');
    }, project);
  }

  async function savedProjects(): Promise<string[]> {
    return page.evaluate(() => (window as unknown as StopScriptWindow).__mockStopScriptSaveProjects ?? []);
  }

  test('edits the project the panel targets, not the open board', async () => {
    const openProjectName = `stop-script-second-${Date.now()}`;
    await createProject(page, openProjectName);
    const projects = await listProjects();
    const openProject = projects.find((project) => project.name === openProjectName);
    const otherProject = projects.find((project) => project.name !== openProjectName);
    expect(openProject).toBeDefined();
    expect(otherProject).toBeDefined();
    if (!openProject || !otherProject) return;

    // Each project keeps its own script, as main's per-project board config does.
    await page.evaluate(([otherId, openId]) => {
      (window as unknown as StopScriptWindow).__mockStopScriptByProject = {
        [otherId]: 'npm run other:stop',
        [openId]: 'npm run open:stop',
      };
    }, [otherProject.id, openProject.id] as const);

    // The board stays on the second project while the panel is pointed at the first.
    await targetSettingsAt(otherProject);
    const input = page.getByTestId(ROW_TEST_ID).locator('input');
    await expect(input).toHaveValue('npm run other:stop');

    await commitStopScript('npm run other:edited');
    await expect.poll(savedScripts).toEqual(['npm run other:edited']);
    expect(await savedProjects()).toEqual([otherProject.id]);
    await expect(input).toHaveValue('npm run other:edited');

    // Back on the open project: its own value, and no write for the switch.
    await targetSettingsAt(openProject);
    await expect(input).toHaveValue('npm run open:stop');
    expect(await savedProjects()).toEqual([otherProject.id]);
    expect(await savedScripts()).toEqual(['npm run other:edited']);
  });
});

test.describe('Stop script failed toast', () => {
  interface FailureOverrides {
    projectId?: string;
    taskId?: string;
    taskTitle?: string;
  }

  async function fireFailure(failure: unknown, overrides: FailureOverrides = {}): Promise<void> {
    await page.evaluate(([failedWith, fixedValues]) => {
      const scoped = window as unknown as StopScriptWindow & {
        electronAPI: { projects: { getCurrent: () => Promise<{ id: string } | null> } };
      };
      return scoped.electronAPI.projects.getCurrent().then((project) => {
        scoped.__mockFireStopScriptFailed?.({
          projectId: fixedValues.projectId ?? project?.id,
          taskId: fixedValues.taskId ?? 'task-1',
          taskTitle: fixedValues.taskTitle ?? 'Fix login',
          failure: failedWith,
        });
      });
    }, [failure, overrides] as const);
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

  test('says how long a script that timed out was given, in seconds under a minute', async () => {
    await fireFailure({ kind: 'timeout', timeoutMs: 30000 });

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Stop script failed' });
    await expect(toast.getByTestId('toast-body')).toHaveText('"Fix login": timed out after 30 seconds.');
  });

  test('shows a script that could not run as the raw detail, in a sentence', async () => {
    await fireFailure({ kind: 'error', detail: 'the shell could not be started' });

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Stop script failed' });
    await expect(toast.getByTestId('toast-body')).toHaveText('"Fix login": The shell could not be started.');
  });

  test('stays out of a project the user is not looking at', async () => {
    // A toast cannot be polled for non-occurrence. The foreign event goes first,
    // then one for the open project: the toasts render in order, so once the
    // matching one is up, a foreign one that had been let through would be too.
    await fireFailure({ kind: 'timeout', timeoutMs: 30000 }, { projectId: 'another-project', taskTitle: 'Foreign task' });
    await fireFailure({ kind: 'timeout', timeoutMs: 30000 }, { taskTitle: 'Matching task' });

    const toasts = page.locator('[data-testid="toast"]').filter({ hasText: 'Stop script failed' });
    await expect(toasts.getByTestId('toast-body').filter({ hasText: 'Matching task' })).toBeVisible({ timeout: 5000 });
    await expect(toasts).toHaveCount(1);
    await expect(toasts.getByTestId('toast-body')).toHaveText('"Matching task": timed out after 30 seconds.');
  });

  test('a click on the toast opens the task', async () => {
    await createTask(page, 'Fix login');
    const taskId = await page.evaluate(async () => {
      const tasks = await (window as unknown as {
        electronAPI: { tasks: { list: () => Promise<Array<{ id: string; title: string }>> } };
      }).electronAPI.tasks.list();
      return tasks.find((task) => task.title === 'Fix login')?.id ?? null;
    });
    expect(taskId).not.toBeNull();

    await fireFailure({ kind: 'exit-code', exitCode: 1 }, { taskId: taskId ?? undefined });
    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Stop script failed' });
    await expect(toast).toBeVisible({ timeout: 5000 });

    await toast.getByTestId('toast-body').click();

    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __zustandStores: { session: { getState: () => { detailTaskId: string | null } } };
    }).__zustandStores.session.getState().detailTaskId)).toBe(taskId);
  });
});
