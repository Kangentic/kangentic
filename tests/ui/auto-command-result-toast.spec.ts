/**
 * UI tests for the `task:autoCommandResult` push event's renderer surface.
 *
 * `App.tsx`'s `onAutoCommandResult` listener (added by the auto_command
 * injection rebuild) is the only consumer of this IPC channel: it decides
 * whether a delivered/failed auto_command is worth interrupting the user for,
 * and builds the toast text. That branching (failed vs a discarded draft vs
 * silence, plus the current-project filter) is pure renderer logic with no
 * PTY or Electron main process involved, so it belongs at the UI tier - driven
 * directly via the mock's `__mockFireAutoCommandResult`, exactly the pattern
 * `agent-driven-invalidation.spec.ts` uses for its sibling `on*ByAgent` pushes.
 *
 * The main-side construction of the notice itself (`shouldNotify`, `toState`)
 * is covered by `tests/unit/auto-command-outcome.test.ts`; these tests cover
 * only what the renderer does once the notice arrives.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';

test.describe.configure({ mode: 'parallel' });

interface AutoCommandResultNoticeOverrides {
  state: 'confirmed' | 'unconfirmed' | 'escalated' | 'failed' | 'cancelled';
  command?: string;
  reason?: string;
  discardedDraft?: string;
  interruptedTurn?: boolean;
  escalated?: boolean;
  projectId?: string;
}

async function fireResult(page: Page, overrides: AutoCommandResultNoticeOverrides): Promise<void> {
  await page.evaluate((notice) => {
    (window as unknown as {
      __mockFireAutoCommandResult: (notice: unknown) => void;
    }).__mockFireAutoCommandResult(notice);
  }, {
    taskId: 'task-auto-cmd',
    taskTitle: 'Ship the feature',
    command: '/code-review',
    interruptedTurn: false,
    escalated: false,
    ...overrides,
  });
}

test('a failed auto_command raises a warning toast naming the command and reason', async () => {
  const { browser, page } = await launchPage();
  await createProject(page, 'AutoCmdToastFailed');
  await waitForBoard(page);

  await fireResult(page, {
    state: 'failed',
    reason: 'the agent never confirmed delivery',
  });

  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible({ timeout: 3000 });
  await expect(toast).toContainText('Ship the feature');
  await expect(toast).toContainText('/code-review');
  await expect(toast).toContainText('the agent never confirmed delivery');

  await browser.close();
});

test('a delivered auto_command that discarded a draft quotes the discarded text', async () => {
  const { browser, page } = await launchPage();
  await createProject(page, 'AutoCmdToastDraft');
  await waitForBoard(page);

  await fireResult(page, {
    state: 'confirmed',
    discardedDraft: 'instead can we',
  });

  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible({ timeout: 3000 });
  await expect(toast).toContainText('Ship the feature');
  await expect(toast).toContainText('instead can we');

  await browser.close();
});

test('a result targeting a different project raises no toast', async () => {
  const { browser, page } = await launchPage();
  await createProject(page, 'AutoCmdToastOtherProject');
  await waitForBoard(page);

  // A failed result would toast unconditionally if the project filter did not
  // fire first - this makes the filter's absence observable rather than
  // vacuously true.
  await fireResult(page, {
    state: 'failed',
    reason: 'should never surface for this project',
    projectId: 'not-the-open-project',
  });

  // Give any (incorrect) toast a budget to fire, then assert none did.
  // (intentional fixed wait - negative assertion; cannot poll for
  // non-occurrence)
  await page.waitForTimeout(500);
  expect(await page.getByTestId('toast').count()).toBe(0);

  await browser.close();
});

test('a plain delivery with nothing worth reporting raises no toast', async () => {
  const { browser, page } = await launchPage();
  await createProject(page, 'AutoCmdToastSilent');
  await waitForBoard(page);

  // Confirmed, no discarded draft, no interruption, no escalation: the
  // renderer's own notes-array guard must stay silent even though this state
  // reached it (in production `shouldNotify` filters this out before the
  // push is even sent, but the renderer's guard is a second, independent
  // line of defense and is what this test pins).
  await fireResult(page, { state: 'confirmed' });

  await page.waitForTimeout(500);
  expect(await page.getByTestId('toast').count()).toBe(0);

  await browser.close();
});
