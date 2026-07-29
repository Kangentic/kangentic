import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, waitForBoard } from './helpers';

/** Mirrors STEP_COUNT. Not imported: pulling a renderer module into the Playwright
 *  node context drags in zustand and the whole store graph, which does not transpile here.
 *  A drift is caught immediately by the "listing five steps at 0 of 5" test below. */
const STEP_COUNT = 5;

// Each test launches its own page so onboardedProjectIds state never leaks across
// tests (mirrors agent-auth-warning.spec.ts's launchWithAgentOverride).
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  // The mock's default config omits `onboardedProjectIds`, and the page starts with no
  // projects, so App.tsx's backfill writes `[]` - an empty list, which is what lets the
  // checklist auto-open for the first project created here.
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Create a project WITHOUT dismissing the onboarding checklist - the shared
 * helpers.createProject skips past it, which is exactly what these tests need to keep.
 */
async function createProjectKeepingChecklist(page: Page, name: string): Promise<void> {
  await page.evaluate((projectName: string) => {
    (window as unknown as { __mockFolderPath: string }).__mockFolderPath = `/mock/projects/${projectName}`;
  }, name);

  const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
  const sidebarButton = page.locator('button[title="Open folder as project"]');
  if (await welcomeButton.isVisible()) await welcomeButton.click();
  else await sidebarButton.click();

  await waitForBoard(page);
}

/**
 * Press Escape until the checklist comes back.
 *
 * A dialog is in the DOM (and so passes `toBeVisible`) one commit BEFORE React runs the
 * passive effect that attaches its document keydown listener, so a single Escape can land in
 * that gap and be dropped - reliably so on a loaded CI runner, where it stops being a flake
 * and just fails.
 *
 * Each round CHECKS FIRST and only presses if the checklist is still absent. That ordering is
 * the point: Escape is idempotent while the dialog is open, but once the checklist is back an
 * extra press would dismiss it and fail the very thing being asserted.
 */
async function pressEscapeUntilChecklistReturns(page: Page): Promise<void> {
  const checklist = page.locator('[data-testid="onboarding-checklist"]');
  await expect.poll(async () => {
    if (await checklist.count() > 0) return true;
    await page.keyboard.press('Escape');
    return await checklist.count() > 0;
  }, { timeout: 10000 }).toBe(true);
}

/** Force a board-store resync after mutating the mock's data directly (the mock has no push). */
async function resyncBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as {
      __zustandStores?: { board: { getState: () => { loadBoard: () => void } } };
    }).__zustandStores;
    store?.board.getState().loadBoard();
  });
}

test.describe('Onboarding checklist', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('opens for a freshly created project, listing five steps at 0 of 5', async () => {
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-fresh');

    const checklist = page.locator('[data-testid="onboarding-checklist"]');
    await expect(checklist).toBeVisible();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('0 of 5 done');

    for (const key of ['defaultsChosen', 'boardShaped', 'taskCreated', 'draggedToAutoSpawnLane', 'taskDetailOpened']) {
      await expect(page.locator(`[data-testid="onboarding-step-${key}"]`)).toBeVisible();
    }
  });

  test('does NOT reopen after an explicit skip, even on a backfill-shaped rewrite', async () => {
    // The invariant the old panel's undo-button test protected, re-pointed at the
    // checklist. onboardedProjectIds is seeded by the one-time backfill as well as by an
    // explicit skip, so anything keyed on it must not resurface onboarding for existing
    // users on projects they have used for months.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-backfilled');

    await page.locator('[data-testid="onboarding-skip"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    // Re-running the backfill-shaped write must not re-open it.
    await page.evaluate(async () => {
      const stores = (window as unknown as {
        __zustandStores?: {
          config: { getState: () => { updateConfig: (partial: unknown) => Promise<void> } };
          project: { getState: () => { currentProject: { id: string } | null } };
        };
      }).__zustandStores;
      const projectId = stores?.project.getState().currentProject?.id;
      await stores?.config.getState().updateConfig({ onboardedProjectIds: [projectId] });
    });

    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();
  });

  test('does NOT open for a project added to an install that already has one', async () => {
    // The reported regression: onboarding used to be keyed on per-project membership in
    // onboardedProjectIds, so a newly added project - which by definition has an id nobody
    // has dismissed - replayed the whole walkthrough. It teaches the app, not a repo.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-established-first');
    await page.locator('[data-testid="onboarding-skip"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    // A second, genuinely new project. Its id is a runtime uuid, so this asserts on the
    // checklist itself and never on ids.
    await createProjectKeepingChecklist(page, 'walkthrough-established-second');

    // waitForBoard inside the helper is the positive anchor; asserting absence straight
    // after the click would race the auto-open effect rather than prove it did not fire.
    //
    // The fixed settle window below is deliberate, not a missing conditional wait: there is
    // no event that fires when an effect declines to open a dialog, so proving a negative
    // costs real time. Same tool as the no-auto-dismiss and completed-flow assertions below.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toHaveCount(0);
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toHaveCount(0);
  });

  test('stays on screen with no auto-dismiss timer', async () => {
    // The original WelcomeOverlay auto-dismissed after 15s, which fails WCAG 2.2.1
    // (Timing Adjustable). There is no timer at all now, so the only way to prove a
    // negative is to wait and re-check.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-no-timer');

    const checklist = page.locator('[data-testid="onboarding-checklist"]');
    await expect(checklist).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(checklist).toBeVisible();
  });

  test('the title-bar button reopens it after it was skipped', async () => {
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-reopen');

    await page.locator('[data-testid="onboarding-skip"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await page.locator('[data-testid="get-started-button"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeVisible();
  });

  test('step 1 redirects to Settings, keeps its callout, and dims nothing', async () => {
    // Redirect, not spotlight. A ring here was worse than none: scoped to the inputs it
    // sliced through every dropdown chevron, and scoped wider it just outlined a panel
    // already filling half the screen. But the callout stays: the panel answers "where",
    // not "why am I here", and it is the only thing telling the user they are in a flow.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-step1');

    await page.locator('[data-testid="onboarding-step-defaultsChosen"]').click();

    await expect(page.locator('[data-testid="project-default-agent"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible();
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toContainText('Step 1 of 5');
    await expect(page.locator('[data-testid="walkthrough-ring"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="walkthrough-layer"]')).toHaveCount(0);
  });

  test('a redirect callout never lands on top of the panel it accompanies', async () => {
    // The callout is the one part of this overlay with pointer-events, so covering the
    // panel would make the settings it points at unclickable.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-callout-clear');

    await page.locator('[data-testid="onboarding-step-defaultsChosen"]').click();
    await expect(page.locator('[data-testid="project-default-agent"]')).toBeVisible({ timeout: 5000 });

    const callout = await page.locator('[data-testid="walkthrough-callout"]').boundingBox();
    const panel = await page.locator('[data-testid="settings-panel"]').boundingBox();
    expect(callout).not.toBeNull();
    expect(panel).not.toBeNull();
    const horizontallyClear = callout!.x + callout!.width <= panel!.x
      || callout!.x >= panel!.x + panel!.width;
    expect(horizontallyClear).toBe(true);
  });

  test('step 2 redirects to Board manager, keeps its callout, and dims nothing', async () => {
    // Same reasoning, plus the ring was actively misleading: it sat on the Name field
    // while this step is about the whole column editor - icon, colour, agent, and Save.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-step2');

    await page.locator('[data-testid="onboarding-step-boardShaped"]').click();

    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible();
    await expect(page.locator('[data-testid="walkthrough-ring"]')).toHaveCount(0);
  });

  test('ticking a redirect step confirms in place instead of jumping the checklist in front', async () => {
    // Changing one setting ticks step 1 instantly. The checklist used to reopen right then,
    // landing on top of the Settings panel the user was still working in - so a user who
    // wanted to set the model AND the effort got a modal in the face after the first one.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-tick-in-place');

    await page.locator('[data-testid="onboarding-step-defaultsChosen"]').click();
    await expect(page.locator('[data-testid="agent-permission-mode"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="agent-permission-mode"]').click();
    await page.locator('[data-testid="agent-permission-mode-option-plan"]').click();

    // The callout stays put with its instructions unchanged, and the checklist stays out of
    // the way. Rewriting the copy into a confirmation the moment one setting changed pulled
    // the instructions out from under a user still working in the panel.
    const callout = page.locator('[data-testid="walkthrough-callout"]');
    await expect(callout).toContainText('Change any one and this step is done', { timeout: 5000 });
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();
    await expect(page.locator('[data-testid="project-default-agent"]')).toBeVisible();

    // Closing the panel is what releases it - and since the step is DONE, that carries on to
    // the next one rather than back to the list.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });
    await expect(callout).toContainText('Step 2 of 5');
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toHaveCount(0);
  });

  test('activating "Choose your defaults" switches an already-open Settings panel to Agent', async () => {
    // useWalkthroughActivation now defers through requestAnimationFrame UNCONDITIONALLY,
    // not gated on whether Settings was already open. SettingsPanel picks its starting tab in
    // a mount-time initializer, and its only re-apply effect is keyed on the project PATH, not
    // the tab - so re-requesting a different tab for the SAME project while the panel is
    // already open used to land in the same render as the close this step also fires, never
    // actually remounting the panel, and the requested tab was silently dropped.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-settings-open-tab');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    // Open Settings by hand, on a tab that has nothing to do with this step.
    await page.locator('[data-testid="settings-button"]').click();
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="settings-tab-list"] button', { hasText: 'Git' }).click();
    await expect(page.locator('[data-testid="project-default-agent"]')).toHaveCount(0);

    // Bring the checklist back over Settings via the store directly - the title-bar reopen
    // button lives under Settings' own full-viewport backdrop, and clicking through it is not
    // what this test is about. AppLayout renders the checklist AFTER Settings, so it stacks on
    // top and its row is clickable, exactly like clicking "Get started" would leave it.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config: { getState: () => { setOnboardingChecklistOpen: (open: boolean) => void } } };
      }).__zustandStores;
      stores?.config.getState().setOnboardingChecklistOpen(true);
    });
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="onboarding-step-defaultsChosen"]').click();

    // The panel must land on Agent without the user closing it first.
    await expect(page.locator('[data-testid="project-default-agent"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
  });

  test('Next step goes straight to the next step, never back through the checklist', async () => {
    // Returning to the list between every step cost two clicks and two modal transitions per
    // step, and asked the user to re-find their place in a list they had just left.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-next-control');

    await page.locator('[data-testid="onboarding-step-defaultsChosen"]').click();
    await expect(page.locator('[data-testid="project-default-agent"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="walkthrough-next-step"]')).toHaveText('Next step');

    await page.locator('[data-testid="walkthrough-next-step"]').click();

    // Straight into step 2's surface, with the checklist never reappearing in between.
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="project-default-agent"]')).toBeHidden();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toContainText('Step 2 of 5');
  });

  test('walking the whole flow with Next alone ends, with nothing left on screen', async () => {
    // The whole point of not gating it: someone who would rather read than do can press Next
    // through the flow. Every step must therefore offer the control, including the board ones.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-next-all');

    await page.locator('[data-testid="onboarding-primary"]').click();
    for (let stepNumber = 1; stepNumber <= STEP_COUNT; stepNumber += 1) {
      const nextButton = page.locator('[data-testid="walkthrough-next-step"]');
      await expect(nextButton).toBeVisible({ timeout: 5000 });
      await expect(nextButton).toHaveText(stepNumber === STEP_COUNT ? 'Finish' : 'Next step');
      await nextButton.click();
    }

    // Finish means finished. Putting the list back up to be dismissed again would make the
    // final click of a five-step flow buy one more modal.
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toHaveCount(0);

    // And it does not come back on its own: completing every step retires onboarding for
    // this project the same way an explicit dismissal does.
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toHaveCount(0);
  });

  test('the checklist primary starts the next unfinished step', async () => {
    // Without it the only way in is to read five rows and pick one, which is work the flow
    // can do for you.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-primary');

    // "Start" on a list where nothing has been done: "Next step" would name a place the user
    // has not been yet.
    await expect(page.locator('[data-testid="onboarding-primary"]')).toHaveText('Start');
    await page.locator('[data-testid="onboarding-primary"]').click();
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toContainText('Step 1 of 5', { timeout: 5000 });

    // Skipping ahead by hand still works, and the primary picks up whatever is left.
    await page.locator('[data-testid="walkthrough-next-step"]').click();
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toContainText('Step 2 of 5', { timeout: 5000 });
  });

  test('closing the surface a step opened brings the checklist back', async () => {
    // The flow used to just end here: change a default, close Settings, and nothing
    // returned - no next step, nowhere to go. Dismissing the New Task dialog by clicking
    // outside it was worse, leaving a dimmed board with a ring and no way forward.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-return');

    await page.locator('[data-testid="onboarding-step-boardShaped"]').click();
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await pressEscapeUntilChecklistReturns(page);

    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeVisible();
  });

  test('step 5 rings the task card once one is running', async () => {
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-step5');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    // Put a task in the agent-starting lane so step 5 has a card to point at.
    await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((lane) => lane.name === 'Planning');
      const task = await window.electronAPI.tasks.create({ title: 'Running task', description: '' });
      await window.electronAPI.tasks.move({ taskId: task.id, targetSwimlaneId: planning!.id, targetPosition: 0 });
    });
    await resyncBoard(page);

    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config: { getState: () => { setWalkthroughStep: (step: string) => void } } };
      }).__zustandStores;
      stores?.config.getState().setWalkthroughStep('taskDetailOpened');
    });

    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible({ timeout: 5000 });
    const ring = page.locator('[data-testid="walkthrough-ring"]');
    await expect(ring).toBeVisible();
    const ringBox = await ring.boundingBox();
    const cardBox = await page.locator('[data-swimlane-name="Planning"] [data-task-id]').boundingBox();
    expect(ringBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    // Generous tolerance: the cutout carries a fixed stage padding and sub-pixel layout
    // differs across platforms (cross-platform-parity.md).
    expect(Math.abs(ringBox!.x - cardBox!.x)).toBeLessThan(24);
  });

  test('opening a task detail ticks step 5 on the checklist', async () => {
    // The ring and the checkbox are two separate wirings: the spotlight layer reads the
    // active step key, the checklist reads derived progress. Step 5 first shipped with a
    // working ring and a checkbox that could never tick, so both need covering.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-step5-tick');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((lane) => lane.name === 'Planning');
      const task = await window.electronAPI.tasks.create({ title: 'Running task', description: '' });
      await window.electronAPI.tasks.move({ taskId: task.id, targetSwimlaneId: planning!.id, targetPosition: 0 });
    });
    await resyncBoard(page);

    // Steps 3 and 4 only: the task exists and sits in an agent-starting column, but nobody
    // has opened it.
    const stepFive = page.locator('[data-testid="onboarding-step-taskDetailOpened"]');
    await page.locator('[data-testid="get-started-button"]').click();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('2 of 5 done', { timeout: 5000 });
    await expect(stepFive).toHaveAttribute('data-done', 'false');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await page.locator('[data-swimlane-name="Planning"] [data-task-id]').click();
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible({ timeout: 5000 });

    await page.locator('[data-testid="get-started-button"]').click();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('3 of 5 done', { timeout: 5000 });
    // The row itself, not just the counter - those are two independent wirings.
    await expect(stepFive).toHaveAttribute('data-done', 'true');

    // And it STAYS ticked once the window closes. The underlying signal is "a task-detail
    // window exists", which is live; a checklist records what you have done, so closing the
    // window the user was just told to open must not take the tick back.
    // Skip, not Escape: Escape is claimed by whichever dismissable layer registered last,
    // which here is the task-detail window the assertion below still needs open.
    await page.locator('[data-testid="onboarding-skip"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();
    await page.locator('[data-testid="task-detail-close"]').first().click();
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0);

    await page.locator('[data-testid="get-started-button"]').click();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('3 of 5 done', { timeout: 5000 });
    await expect(stepFive).toHaveAttribute('data-done', 'true');
  });

  test('opening a task detail in one project does not tick step 5 in another', async () => {
    // The switch transient: `currentProject` flips to the destination before the outgoing
    // project's detail windows are torn down, so a naive "a window is open" stamp credits
    // the wrong project. That matters twice over, because completing all five steps retires
    // onboarding - a false step 5 could retire a board the user has not seen yet.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-switch-tick');
    await page.locator('[data-testid="onboarding-skip"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((lane) => lane.name === 'Planning');
      const task = await window.electronAPI.tasks.create({ title: 'Running task', description: '' });
      await window.electronAPI.tasks.move({ taskId: task.id, targetSwimlaneId: planning!.id, targetPosition: 0 });
    });
    await resyncBoard(page);
    await page.locator('[data-swimlane-name="Planning"] [data-task-id]').click();
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeVisible({ timeout: 5000 });

    await page.evaluate(async () => {
      const stores = (window as unknown as {
        __zustandStores?: {
          project: {
            getState: () => {
              createProject: (input: { name: string; path: string }) => Promise<{ id: string }>;
              openProject: (id: string) => Promise<void>;
            };
          };
        };
      }).__zustandStores;
      const created = await stores!.project.getState()
        .createProject({ name: 'switch-tick-target', path: '/mock/projects/switch-tick-target' });
      await stores!.project.getState().openProject(created.id);
    });
    await waitForBoard(page);

    // Opened by hand, not by arriving: onboarding is install-scoped, so this second project
    // does not auto-open the checklist. The dev-only title-bar button bypasses that gate,
    // which is what makes the per-project step state below still observable.
    await page.locator('[data-testid="get-started-button"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="onboarding-step-taskDetailOpened"]'))
      .toHaveAttribute('data-done', 'false');
  });

  test('changing a default ticks step 1, but merely visiting Settings does not', async () => {
    // End-to-end proof of the baseline chain: capture on open -> real change -> re-derive.
    // The derivation itself is unit-tested against a hand-built baseline; this is the only
    // thing proving the three parts are actually wired to each other.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-baseline');
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('0 of 5 done');

    // Visit the surface and leave without touching anything.
    await page.locator('[data-testid="onboarding-step-defaultsChosen"]').click();
    await expect(page.locator('[data-testid="project-default-agent"]')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="get-started-button"]').click();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('0 of 5 done');

    // Now change one for real. Closing Settings then carries on to step 2, so back out of
    // THAT to read the count off the list.
    await page.locator('[data-testid="onboarding-step-defaultsChosen"]').click();
    await expect(page.locator('[data-testid="agent-permission-mode"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="agent-permission-mode"]').click();
    await page.locator('[data-testid="agent-permission-mode-option-plan"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });
    await pressEscapeUntilChecklistReturns(page);

    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('1 of 5 done');
  });

  test('creating a task ticks step 3 without any manual check-off', async () => {
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-step3');

    await page.locator('[data-testid="onboarding-step-taskCreated"]').click();

    // Clicking a row opens its surface AND arms its spotlight. Here the spotlight rings the
    // real Add task button so the user learns where tasks come from, while the New Task
    // dialog stays readable above the scrim.
    const activatedStep = await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config: { getState: () => { walkthroughStep: string | null } } };
      }).__zustandStores;
      return stores?.config.getState().walkthroughStep ?? null;
    });
    expect(activatedStep).toBe('taskCreated');

    // The ring must actually resolve, not just be armed. A step whose selector matches
    // nothing renders NOTHING and fails silently, so every step asserts real geometry.
    const ring = page.locator('[data-testid="walkthrough-ring"]');
    await expect(ring).toBeVisible({ timeout: 5000 });
    const ringBox = await ring.boundingBox();
    expect(ringBox?.width ?? 0).toBeGreaterThan(0);
    expect(ringBox?.height ?? 0).toBeGreaterThan(0);

    // The step opens the New Task dialog and closes the checklist behind it.
    const newTaskModal = page.locator('.fixed.inset-0');
    await newTaskModal.locator('input[placeholder="Task title"]').fill('First task');
    await page.locator('button[type="submit"]:has-text("Create")').click();

    // Doing the thing carries straight on to the next step, exactly as pressing Next does.
    // It used to land back on the checklist, leaving the user to find step 4 themselves -
    // which is a strange thing to ask of someone who just followed the instruction.
    await expect(page.locator('[data-testid="walkthrough-callout"]'))
      .toContainText('Step 4 of 5', { timeout: 5000 });
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toHaveCount(0);

    await page.locator('[data-testid="get-started-button"]').click();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('1 of 5 done', { timeout: 5000 });
  });

  test('backing out of a step returns to the checklist rather than pushing on', async () => {
    // The other half of the same rule. Completing a step means "keep going"; closing its
    // surface without completing it means "I want out of this one", and answering that by
    // opening the NEXT step would be the flow ignoring the user.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-back-out');

    await page.locator('[data-testid="onboarding-step-boardShaped"]').click();
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });

    await pressEscapeUntilChecklistReturns(page);

    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('0 of 5 done');
  });

  test('backing out of "Create a task" via Escape brings the checklist back, not a silent end', async () => {
    // Regression guard for a real bug the review just fixed. taskCreated both opens the New
    // Task dialog AND rings the real Add task button, so unlike step 2 above (Board manager,
    // no target - the listener never attaches) it resolves a rect too. The walkthrough's own
    // Escape listener used to gate on `!rect` alone, so it attached here as well as
    // BaseDialog's; neither stops propagation, so one Escape closed the dialog AND cleared
    // walkthroughStep in the same tick, and AppLayout's return-to-checklist effect (which
    // reads the step off a ref that the OTHER effect had already reset to null) never saw
    // which step to return to. Onboarding silently ended instead of the checklist reappearing.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-taskcreated-escape');

    await page.locator('[data-testid="onboarding-step-taskCreated"]').click();
    await expect(page.locator('[data-testid="new-task-dialog"]')).toBeVisible({ timeout: 5000 });
    // Wait for the ring, not just the dialog: the ring only paints once the layer's target
    // rect has actually resolved, which is the exact condition the reverted bug hinges on.
    // Pressing Escape before that would race the bug either way.
    await expect(page.locator('[data-testid="walkthrough-ring"]')).toBeVisible({ timeout: 5000 });

    await pressEscapeUntilChecklistReturns(page);

    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboarding-progress"]')).toHaveText('0 of 5 done');
  });
});

test.describe('Walkthrough spotlight', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  /**
   * Rename the agent-starting column, then activate step 4's spotlight.
   *
   * Activation goes through the store rather than clicking the checklist row. These tests
   * are about what the SPOTLIGHT does; that a row click activates it is covered separately
   * by "clicking a step activates its spotlight". Clicking here would additionally race the
   * dialog's entrance animation, since the click also unmounts the dialog.
   */
  async function renameLaneAndSpotlight(page: Page, newName: string): Promise<void> {
    await page.evaluate(async (name: string) => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((lane) => lane.name === 'Planning');
      if (planning) await window.electronAPI.swimlanes.update({ id: planning.id, name });
    }, newName);
    await resyncBoard(page);
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: {
          config: { getState: () => { setWalkthroughStep: (step: string) => void } };
        };
      }).__zustandStores;
      stores?.config.getState().setWalkthroughStep('draggedToAutoSpawnLane');
    });
  }

  test('anchors to the agent-starting column AFTER it has been renamed', async () => {
    // The highest-value guard here. Step 2 invites the user to rename columns, so
    // resolving step 4 by the literal name "Planning" would break for exactly the users
    // who did what the checklist asked. Both the ring and the copy resolve from
    // auto_spawn / permission_mode instead.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-rename');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await renameLaneAndSpotlight(page, 'Design first');

    const callout = page.locator('[data-testid="walkthrough-callout"]');
    await expect(callout).toBeVisible({ timeout: 5000 });
    await expect(callout).toContainText('Design first');
    await expect(callout).not.toContainText('Planning');
    // The board steps carry the control too, so the flow can be walked end to end.
    await expect(page.locator('[data-testid="walkthrough-next-step"]')).toBeVisible();

    // The cutout must span BOTH ends of the drag. Lighting only the destination leaves the
    // task the user is told to drag sitting in a dimmed column, which makes the instruction
    // impossible to follow.
    const ring = page.locator('[data-testid="walkthrough-ring"]');
    await expect(ring).toBeVisible();
    const ringBox = await ring.boundingBox();
    const todoBox = await page.locator('[data-swimlane-name="To Do"]').boundingBox();
    const laneBox = await page.locator('[data-swimlane-name="Design first"]').boundingBox();
    expect(ringBox).not.toBeNull();
    expect(todoBox).not.toBeNull();
    expect(laneBox).not.toBeNull();
    // Generous tolerance rather than exact geometry: the cutout carries a fixed stage
    // padding and sub-pixel layout differs across platforms (cross-platform-parity.md).
    expect(ringBox!.x).toBeLessThanOrEqual(todoBox!.x + 2);
    expect(ringBox!.x + ringBox!.width).toBeGreaterThanOrEqual(laneBox!.x + laneBox!.width - 2);
  });

  test('the callout stays fully on screen when its target fills the board', async () => {
    // Step 4 lights two whole columns from the top of the board down, so there is no room
    // above and placement has to fall sideways. It used to give up and hang the callout off
    // the top of the window - and the overlay's OWN scrim counted as an obstacle to avoid,
    // so which position won depended on whether the scrim had painted yet that frame.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-onscreen');
    await page.locator('[data-testid="onboarding-skip"]').click();
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await renameLaneAndSpotlight(page, 'Design first');
    const callout = page.locator('[data-testid="walkthrough-callout"]');
    await expect(callout).toBeVisible({ timeout: 5000 });

    const box = await callout.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);

    // And beside the cutout, never on it: covering the columns the copy is telling the user
    // to drag between defeats the point of lighting them.
    const ringBox = await page.locator('[data-testid="walkthrough-ring"]').boundingBox();
    expect(ringBox).not.toBeNull();
    const overlapsRing = box!.x < ringBox!.x + ringBox!.width
      && box!.x + box!.width > ringBox!.x
      && box!.y < ringBox!.y + ringBox!.height
      && box!.y + box!.height > ringBox!.y;
    expect(overlapsRing).toBe(false);
  });

  test('the ring sits centred on the control it points at', async () => {
    // The cutout is the target plus a fixed padding on every side, so its centre and the
    // target's centre are the same point. Any drift means the padding is being applied
    // unevenly, which reads as a ring that missed.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-ring-centre');

    await page.locator('[data-testid="onboarding-step-taskCreated"]').click();
    await expect(page.locator('[data-testid="walkthrough-ring"]')).toBeVisible({ timeout: 5000 });

    const ring = await page.locator('[data-testid="walkthrough-ring"]').boundingBox();
    const target = await page.locator('[data-testid="swimlane-add-task"]').boundingBox();
    expect(ring).not.toBeNull();
    expect(target).not.toBeNull();
    // Tolerance, not equality: sub-pixel layout differs across platforms
    // (cross-platform-parity.md).
    expect(Math.abs((ring!.x + ring!.width / 2) - (target!.x + target!.width / 2))).toBeLessThan(2);
    expect(Math.abs((ring!.y + ring!.height / 2) - (target!.y + target!.height / 2))).toBeLessThan(2);
  });

  test('the scrim never blocks a click on the app underneath it', async () => {
    // Every scrim band is pointer-events:none, which is what makes "the user is never at
    // the mercy of the tutorial" true rather than merely promised. Clicking through the
    // CUTOUT would prove nothing (no scrim covers it), so this clicks the To Do column's
    // Add task button while the spotlight sits on a different column entirely.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-clickthrough');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await renameLaneAndSpotlight(page, 'Design first');
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible({ timeout: 5000 });

    const addTask = page.locator('[data-swimlane-name="To Do"] [data-testid="swimlane-add-task"]');
    await expect(addTask).toBeVisible();
    await addTask.click();

    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible({ timeout: 5000 });
  });

  test('a drag in progress dismisses the walkthrough', async () => {
    // Once the user picks a card up the explanation has done its job, and a dimmed,
    // blurred board is the worst thing to be aiming a drop through.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-drag-dismiss');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await renameLaneAndSpotlight(page, 'Design first');
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible({ timeout: 5000 });

    // The layer watches for dnd-kit's drag overlay rather than hooking into the board's
    // drag hook, so injecting one exercises the real signal. Driving an actual dnd-kit
    // drag here would be flaky (see the dnd-kit/Playwright notes in the repo).
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.className = 'drag-overlay';
      document.body.appendChild(overlay);
    });

    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeHidden();
    await expect(page.locator('[data-testid="walkthrough-layer"]')).toHaveCount(0);
  });

  test('a project switch clears the walkthrough instead of pointing at the old board', async () => {
    // The layer re-mounts on a project switch, and column ids do not survive it. Without
    // the explicit clear the spotlight would keep ringing coordinates belonging to the
    // previous project's board.
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-switch-a');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();
    await renameLaneAndSpotlight(page, 'Design first');
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible({ timeout: 5000 });

    await page.evaluate(async () => {
      const stores = (window as unknown as {
        __zustandStores?: {
          project: {
            getState: () => {
              projects: Array<{ id: string; name: string }>;
              currentProject: { id: string } | null;
              createProject: (input: { name: string; path: string }) => Promise<{ id: string }>;
              openProject: (id: string) => Promise<void>;
            };
          };
        };
      }).__zustandStores;
      const projectState = stores!.project.getState();
      const created = await projectState.createProject({ name: 'switch-target', path: '/mock/projects/switch-target' });
      await stores!.project.getState().openProject(created.id);
    });

    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeHidden();
    await expect(page.locator('[data-testid="walkthrough-ring"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="walkthrough-layer"]')).toHaveCount(0);
  });

  test('Escape ends the walkthrough', async () => {
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-escape');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await renameLaneAndSpotlight(page, 'Design first');
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible({ timeout: 5000 });

    // Poll the keypress rather than firing once. The callout is in the DOM (and so passes
    // toBeVisible) one commit BEFORE React runs the passive effect that attaches the
    // document keydown listener, and on a loaded CI runner that gap is wide enough for a
    // single Escape to land in it and be dropped. Escape is idempotent here - once the step
    // is cleared, later presses do nothing - so retrying costs nothing and removes the race.
    await expect.poll(
      async () => {
        await page.keyboard.press('Escape');
        return page.locator('[data-testid="walkthrough-callout"]').count();
      },
      { timeout: 5000 },
    ).toBe(0);
  });

  test('the skip control on the callout ends the walkthrough', async () => {
    ({ browser, page } = await launch());
    await createProjectKeepingChecklist(page, 'walkthrough-callout-skip');
    await page.locator('[data-testid="onboarding-skip"]').click();
    // Wait for the dismissal to land. BaseDialog defers onClose behind its exit
    // animation, and that onClose clears walkthroughStep - so a step armed before it
    // lands is silently wiped.
    await expect(page.locator('[data-testid="onboarding-checklist"]')).toBeHidden();

    await renameLaneAndSpotlight(page, 'Design first');
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeVisible({ timeout: 5000 });

    await page.locator('[data-testid="walkthrough-skip"]').click();
    await expect(page.locator('[data-testid="walkthrough-callout"]')).toBeHidden();
    await expect(page.locator('[data-testid="walkthrough-ring"]')).toBeHidden();
  });
});
