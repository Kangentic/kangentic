/**
 * The automation failure toast and its Run again button (App.tsx, the
 * `automations.onRunFailed` handler).
 *
 * - The failure toast is persistent and carries a Run again button with the
 *   retry icon, so the button is there when the user reaches for it.
 * - Clicking it dismisses the failure toast BEFORE the run is asked for, so a
 *   failure left up beside the result cannot invite a second run.
 * - The result raises one toast: "Ran again" (success for a run that
 *   succeeded, warning for any other status), or "Couldn't run again" (error)
 *   when the run never started (`{ ok: false }`) or the call rejects.
 *
 * `automations.runAgain` is replaced per test with a call that stays pending
 * until the test releases it. An answer that resolves at once cannot tell a
 * dismiss on click from a dismiss after the answer lands, and the ordering
 * is half of what the handler promises.
 *
 * Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page, Locator } from '@playwright/test';
import { launchPage, toastCountRightNow } from './helpers';
import type { AutomationRunAgainResult, AutomationRunFailure, AutomationRunStatus } from '../../src/shared/types';

test.describe.configure({ mode: 'parallel' });

const PROJECT_ID = 'proj-run-again';
const OTHER_PROJECT_ID = 'proj-run-again-other';
const TASK_ID = 'task-run-again';
const TASK_TITLE = 'Fix the drag ghost';
const AUTOMATION_ID = 'automation-run-again';
const AUTOMATION_NAME = 'Notify the channel';
const COLUMN_NAME = 'Code Review';

const FAILURE: AutomationRunFailure = {
  runId: 'run-run-again',
  automationId: AUTOMATION_ID,
  automationName: AUTOMATION_NAME,
  columnName: COLUMN_NAME,
  taskId: TASK_ID,
  taskTitle: TASK_TITLE,
  projectId: PROJECT_ID,
  status: 'failed',
  detail: 'Webhook returned 500',
};

/** The failure toast's body: the task first, then the automation and its column, then main's detail. */
const FAILURE_BODY = `"${TASK_TITLE}": "${AUTOMATION_NAME}" failed on ${COLUMN_NAME}. Webhook returned 500.`;

type RunAgainOutcome =
  | { kind: 'result'; result: AutomationRunAgainResult }
  | { kind: 'reject'; message: string };

/** The page-side record of the stubbed `automations.runAgain`. */
interface RunAgainProbe {
  __runAgainCalls: unknown[][];
  __releaseRunAgain?: () => void;
}

/**
 * The failure's project open on a board, so a failure pushed with its id is for
 * "the open project". A second project is there to switch to, and the failed
 * task is a real row, so a click that opens it has something to open.
 */
async function launchOnProject(): Promise<{ browser: Browser; page: Page }> {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => {
      await target.addInitScript(`
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Run Again Test',
            path: '/mock/run-again-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.projects.push({
            id: '${OTHER_PROJECT_ID}',
            name: 'Run Again Elsewhere',
            path: '/mock/run-again-other',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          var codeReviewLaneId = null;
          state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
            var laneId = 'lane-run-again-' + index;
            if (swimlane.name === '${COLUMN_NAME}') codeReviewLaneId = laneId;
            state.swimlanes.push(Object.assign({}, swimlane, { id: laneId, position: index, created_at: ts }));
          });
          state.tasks.push({
            id: '${TASK_ID}',
            title: '${TASK_TITLE}',
            description: 'The task the automation failed on',
            swimlane_id: codeReviewLaneId,
            position: 0,
            agent: 'claude',
            session_id: null,
            worktree_path: null,
            branch_name: null,
            pr_number: null,
            pr_url: null,
            base_branch: null,
            use_worktree: 0,
            labels: [],
            priority: 0,
            attachment_count: 0,
            archived_at: null,
            created_at: ts,
            updated_at: ts,
          });
          return { currentProjectId: '${PROJECT_ID}' };
        });
      `);
    },
  });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

/** Replace `automations.runAgain` with a call that records its arguments and stays pending until released. */
async function holdRunAgain(page: Page, outcome: RunAgainOutcome): Promise<void> {
  await page.evaluate((heldOutcome) => {
    const probe = window as unknown as RunAgainProbe;
    probe.__runAgainCalls = [];
    const automations = window.electronAPI.automations as unknown as { runAgain: (...args: unknown[]) => Promise<unknown> };
    automations.runAgain = (...args: unknown[]) => {
      probe.__runAgainCalls.push(args);
      return new Promise((resolve, reject) => {
        probe.__releaseRunAgain = () => {
          if (heldOutcome.kind === 'reject') reject(new Error(heldOutcome.message));
          else resolve(heldOutcome.result);
        };
      });
    };
  }, outcome);
}

async function runAgainCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as unknown as RunAgainProbe).__runAgainCalls);
}

/** Stand in for main's `automation:runFailed` push, after the guard that App.tsx has subscribed. */
async function fireRunFailed(page: Page, failure: AutomationRunFailure): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__mockFireAutomationRunFailed === 'function'), {
      message: 'App.tsx is not subscribed to automations.onRunFailed',
    })
    .toBe(true);
  await page.evaluate((payload) => {
    if (!window.__mockFireAutomationRunFailed) throw new Error('window.__mockFireAutomationRunFailed is not installed');
    window.__mockFireAutomationRunFailed(payload);
  }, failure);
}

function toastTitled(page: Page, title: string): Locator {
  return page.getByTestId('toast').filter({ has: page.getByTestId('toast-title').getByText(title, { exact: true }) });
}

interface StoreProbe {
  __zustandStores?: {
    project?: { getState: () => { currentProject: { id: string } | null; openProject: (id: string) => Promise<unknown> } };
    session?: { getState: () => { detailTaskId: string | null } };
  };
}

async function currentProjectId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as StoreProbe).__zustandStores?.project?.getState().currentProject?.id ?? null);
}

/** Switch the board to another project the way the sidebar does, and wait for it to land. */
async function switchToProject(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (targetProjectId) => {
    const projectStore = (window as unknown as StoreProbe).__zustandStores?.project;
    if (!projectStore) throw new Error('project store not exposed on __zustandStores');
    await projectStore.getState().openProject(targetProjectId);
  }, projectId);
  await expect.poll(() => currentProjectId(page), { timeout: 10000 }).toBe(projectId);
}

async function projectOpenCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.electronAPI.projects as unknown as { __openCalls: string[] }).__openCalls.slice());
}

async function detailTaskId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as StoreProbe).__zustandStores?.session?.getState().detailTaskId ?? null);
}

/**
 * Fire the failure, press Run again with `runAgain` held, and check the two
 * things that happen before the answer: the failure toast is gone and nothing
 * else has taken its place. Returns once the held call has been released.
 */
async function pressRunAgain(page: Page, outcome: RunAgainOutcome): Promise<void> {
  await holdRunAgain(page, outcome);
  await fireRunFailed(page, FAILURE);

  const failureToast = toastTitled(page, 'Automation failed');
  await expect(failureToast).toBeVisible();
  await expect(failureToast.getByTestId('toast-body')).toHaveText(FAILURE_BODY);
  await expect(failureToast).toHaveAttribute('data-variant', 'warning');
  // Stays until the user acts: a timed toast would take the button with it.
  await expect(failureToast).toHaveAttribute('data-persistent', 'true');
  const action = failureToast.getByTestId('toast-action');
  await expect(action).toHaveText('Run again');
  await expect(action.locator('svg.lucide-rotate-cw')).toHaveCount(1);

  await action.click();

  // The held call has not answered, so the failure toast going away can only be
  // the click's own dismiss, not the result taking over.
  await expect.poll(() => toastCountRightNow(page, 'Automation failed')).toBe(0);
  expect(await toastCountRightNow(page)).toBe(0);
  // Run again re-runs THIS automation against THIS task, on the open project.
  expect(await runAgainCalls(page)).toEqual([[AUTOMATION_ID, TASK_ID, PROJECT_ID]]);

  await page.evaluate(() => (window as unknown as RunAgainProbe).__releaseRunAgain?.());
}

function runResult(status: AutomationRunStatus, detail: string | null): AutomationRunAgainResult {
  return { ok: true, runId: 'run-again-result', automationName: AUTOMATION_NAME, columnName: COLUMN_NAME, status, detail };
}

test.describe('Automation failure toast: Run again', () => {
  test('a run that succeeds raises a success toast naming the automation', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await pressRunAgain(page, { kind: 'result', result: runResult('succeeded', null) });

      const resultToast = toastTitled(page, 'Ran again');
      await expect(resultToast).toBeVisible();
      await expect(resultToast).toHaveAttribute('data-variant', 'success');
      await expect(resultToast.getByTestId('toast-body')).toHaveText(`"${AUTOMATION_NAME}" succeeded against the task's current state.`);
      // A timed result: no button, and the failure toast did not come back.
      expect(await resultToast.getByTestId('toast-action').count()).toBe(0);
      expect(await toastCountRightNow(page, 'Automation failed')).toBe(0);
    } finally {
      await browser.close();
    }
  });

  // Every status that is not `succeeded` is a warning, each with its own phrase,
  // and a detail main wrote follows as a second sentence.
  const NOT_SUCCEEDED: Array<{ status: AutomationRunStatus; phrase: string; detail: string | null; tail: string }> = [
    { status: 'failed', phrase: 'failed', detail: 'Webhook returned 500', tail: ' Webhook returned 500.' },
    { status: 'skipped', phrase: 'was skipped', detail: 'The column has no webhook.', tail: ' The column has no webhook.' },
    { status: 'interrupted', phrase: 'was interrupted', detail: null, tail: '' },
    { status: 'running', phrase: 'is still running', detail: null, tail: '' },
  ];
  for (const { status, phrase, detail, tail } of NOT_SUCCEEDED) {
    test(`a run that ends ${status} raises a warning toast with its reason`, async () => {
      const { browser, page } = await launchOnProject();
      try {
        await pressRunAgain(page, { kind: 'result', result: runResult(status, detail) });

        const resultToast = toastTitled(page, 'Ran again');
        await expect(resultToast).toBeVisible();
        await expect(resultToast).toHaveAttribute('data-variant', 'warning');
        await expect(resultToast.getByTestId('toast-body')).toHaveText(`"${AUTOMATION_NAME}" ${phrase} against the task's current state.${tail}`);
      } finally {
        await browser.close();
      }
    });
  }

  test('a run that never started toasts why, as an error', async () => {
    const { browser, page } = await launchOnProject();
    try {
      const error = 'That automation no longer exists. It was probably deleted or renamed in the Column Manager.';
      await pressRunAgain(page, { kind: 'result', result: { ok: false, error } });

      const resultToast = toastTitled(page, "Couldn't run again");
      await expect(resultToast).toBeVisible();
      await expect(resultToast).toHaveAttribute('data-variant', 'error');
      await expect(resultToast.getByTestId('toast-body')).toHaveText(error);
      expect(await toastCountRightNow(page, 'Ran again')).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('a call that rejects toasts the reason as an error, without the IPC wrapping', async () => {
    const { browser, page } = await launchOnProject();
    try {
      // As Electron decorates a main-process throw: the channel, then the class.
      await pressRunAgain(page, {
        kind: 'reject',
        message: "Error invoking remote method 'automation:runAgain': Error: the project closed first",
      });

      const resultToast = toastTitled(page, "Couldn't run again");
      await expect(resultToast).toBeVisible();
      await expect(resultToast).toHaveAttribute('data-variant', 'error');
      await expect(resultToast.getByTestId('toast-body')).toHaveText('The project closed first.');
      expect(await toastCountRightNow(page, 'Ran again')).toBe(0);
    } finally {
      await browser.close();
    }
  });

  // Main pushes `projectId: ''` when it had none (automation-failures.ts). The
  // handler lets that through as "the open project's", and the fallback is what
  // hands the open project's id to both actions. Without it the card opens
  // nothing and Run again asks main to look the automation up in no project.
  test('a failure pushed with no project belongs to the open one, for the card and for Run again', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await holdRunAgain(page, { kind: 'result', result: runResult('succeeded', null) });
      await fireRunFailed(page, { ...FAILURE, projectId: '' });
      const failureToast = toastTitled(page, 'Automation failed');
      await expect(failureToast).toBeVisible();
      await expect(failureToast.getByTestId('toast-body')).toHaveText(FAILURE_BODY);

      // A card with nothing to open is inert (pointer-events: none), so this is
      // the card having a task to open. Asserted first so a missing project
      // fails here, not as a click that waits out the test timeout.
      await expect(failureToast).toHaveCSS('pointer-events', 'auto');
      await failureToast.getByTestId('toast-body').click();
      await expect.poll(() => detailTaskId(page), { timeout: 5000 }).toBe(TASK_ID);

      // Opening the task is not running it again, and the toast stays.
      expect(await runAgainCalls(page)).toEqual([]);
      await expect(failureToast).toBeVisible();

      await failureToast.getByTestId('toast-action').click();
      await expect.poll(() => runAgainCalls(page)).toEqual([[AUTOMATION_ID, TASK_ID, PROJECT_ID]]);
      await page.evaluate(() => (window as unknown as RunAgainProbe).__releaseRunAgain?.());
      await expect(toastTitled(page, 'Ran again')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});

// The toast is persistent, so it outlives a project switch: the user can be
// looking at another board when they reach for it. Both of its actions belong
// to the failure's project, never to whichever project is open at the click.
test.describe('Automation failure toast after a project switch', () => {
  test('Run again runs in the failure\'s project, not the one open at the click', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await holdRunAgain(page, { kind: 'result', result: runResult('succeeded', null) });
      await fireRunFailed(page, FAILURE);
      const failureToast = toastTitled(page, 'Automation failed');
      await expect(failureToast).toBeVisible();

      await switchToProject(page, OTHER_PROJECT_ID);
      await expect(failureToast).toBeVisible();

      await failureToast.getByTestId('toast-action').click();

      // Main looks the automation up in the project it is handed. Handed the
      // open one, it answers "That automation no longer exists."
      await expect.poll(() => runAgainCalls(page)).toEqual([[AUTOMATION_ID, TASK_ID, PROJECT_ID]]);
      await page.evaluate(() => (window as unknown as RunAgainProbe).__releaseRunAgain?.());
      await expect(toastTitled(page, 'Ran again')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('a click on the card opens the failed task in its own project and leaves Run again up', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await holdRunAgain(page, { kind: 'result', result: runResult('succeeded', null) });
      await fireRunFailed(page, FAILURE);
      const failureToast = toastTitled(page, 'Automation failed');
      await expect(failureToast).toBeVisible();

      await switchToProject(page, OTHER_PROJECT_ID);
      expect(await projectOpenCalls(page)).toEqual([OTHER_PROJECT_ID]);

      await failureToast.getByTestId('toast-body').click();

      // The task is not on this board, so the click goes back to its project
      // first and opens it there.
      await expect.poll(() => projectOpenCalls(page), { timeout: 5000 }).toEqual([OTHER_PROJECT_ID, PROJECT_ID]);
      await expect.poll(() => currentProjectId(page), { timeout: 10000 }).toBe(PROJECT_ID);
      await expect.poll(() => detailTaskId(page), { timeout: 10000 }).toBe(TASK_ID);

      // Opening the task is not running it again, and the toast stays so the
      // user can press Run again once they have looked, with the task open.
      expect(await runAgainCalls(page)).toEqual([]);
      await expect(failureToast).toBeVisible();
      const action = failureToast.getByTestId('toast-action');
      await expect(action).toHaveText('Run again');
      await action.click();
      await expect.poll(() => runAgainCalls(page)).toEqual([[AUTOMATION_ID, TASK_ID, PROJECT_ID]]);
      await page.evaluate(() => (window as unknown as RunAgainProbe).__releaseRunAgain?.());
      await expect(toastTitled(page, 'Ran again')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
