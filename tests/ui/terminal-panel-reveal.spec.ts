/**
 * Regression spec: an expanded bottom panel always shows its terminal, however it got
 * expanded.
 *
 * `useTerminalResize` unmounts the panel's content once a collapse finishes, and mounts it
 * again when an expand has finished its height animation. It used to wait for that
 * animation's `transitionend` and nothing else, which assumes the mounted container always
 * animates up from its 36px strip. Each case below expands the panel without that animation
 * ever ending, and each one left the panel at full height showing only its tab row:
 *
 * 1. Board -> Workflows -> Board. Workflows holds the panel collapsed and stops rendering its
 *    container, so coming back mounts a fresh container already at full height.
 * 2. Workflows -> Backlog -> Board. The expand happens while no container exists at all.
 * 3. A project's detail-window restore releasing after the switch's 250ms snap window. The
 *    snap was raised from an effect, one commit late, so the expand committed with the
 *    height-transition class still on and the next commit dropped it. If a style recalc
 *    landed between the two, a 200ms slide ran on a restore path, because the bare
 *    `transition-property` falls back to `all` and does not stop it. If none did, nothing
 *    started and the panel stayed blank. This case asserts both halves, so it is red
 *    either way the race goes.
 * 4. A view switch in the middle of an expand. Removing the container cancels its transition.
 *
 * The hook now asks the container for an in-flight height transition and reveals when it
 * settles, finished or cancelled, or at once when there is none. It raises the snap during
 * render, so a switch's own commit already lacks the transition class.
 *
 * Three more cases pin the edges of that design:
 *
 * 5. A collapse that lands while an expand's transition is still running. The collapse cancels
 *    the transition, and a cancelled transition settles the reveal too, so the reveal must
 *    check that the panel is still expanded. Otherwise the terminal mounts for the length of
 *    the collapse's hide timer, and an xterm is built and torn down for nothing.
 * 6. An animated expand mounts the terminal only AFTER the transition has settled, so it fits at
 *    the final height. A reveal that does not wait mounts it at the strip's height.
 * 7. A second project switch inside the snap window restarts the window, so the suppression
 *    lasts the full window past the LAST switch. This case runs on a paused fake clock, so it
 *    does not race the real 250ms window.
 *
 * How to verify RED / GREEN: run this file against `useTerminalResize.ts` and `AppLayout.tsx`
 * from before the fix. Cases 1 to 4 fail there. Cases 5 to 7 each fail against one revert in
 * `useTerminalResize.ts`: `revealIfExpanded` calling `setShowContent(true)` unconditionally (5),
 * `findHeightTransition` returning null (6), and `switchKey` dropped from the snap timer
 * effect's dependency array (7).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-panel-reveal-${RUN_ID}`;
const TASK_ID = `task-panel-reveal-${RUN_ID}`;
const SESSION_ID = `sess-panel-reveal-${RUN_ID}`;

const SESSION_PANE = '[data-testid="terminal-session-pane"]';
const PANEL_CONTAINER = '[data-testid="terminal-panel-container"]';

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Panel Reveal ${RUN_ID}',
        path: '/mock/panel-reveal-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-pr-${RUN_ID}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId, position: index, created_at: timestamp,
        }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 7200,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/panel-reveal-${RUN_ID}',
        startedAt: timestamp,
        exitCode: null,
        resuming: false,
      });
      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: 'Panel Reveal Task ${RUN_ID}',
        description: '',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      state.activityCache['${SESSION_ID}'] = 'thinking';

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/**
 * `fakeClock`: the page's timers are Playwright's, which run at real speed until the test
 * pauses them (`page.clock.pauseAt`), so a test can hold the snap window open for as long as
 * its assertions need. It has to be installed before the page loads.
 */
async function launch(options: { fakeClock?: boolean } = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  if (options.fakeClock) await page.clock.install();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  // The panel starts expanded with the running session's terminal mounted.
  await page.locator(SESSION_PANE).waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

/**
 * Stay in Workflows past the hook's 200ms `hide-after-collapse` timer, so the panel's
 * content really is unmounted on the way back. Leaving any sooner cancels that timer and
 * the case passes against the bug. A page timer registered after the hook's, with a later
 * deadline, fires after it: this is an ordering guarantee, not a guess at how long is long
 * enough.
 */
async function enterWorkflowsAndDwell(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-workflows"]').click();
  await page.locator('[data-testid="workflows-view"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
}

async function setPendingDetailWindowsProjectId(page: Page, projectId: string | null): Promise<void> {
  await page.evaluate((pendingProjectId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setPendingDetailWindowsProjectId: (pendingProjectId: string | null) => void } } };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    stores.session.getState().setPendingDetailWindowsProjectId(pendingProjectId);
  }, projectId);
}

/**
 * Wait until the panel container has no height transition running, so the next expand or
 * collapse starts a fresh one from a resting height instead of reversing a live one.
 */
async function waitForNoHeightTransition(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => {
      const panelContainer = document.querySelector<HTMLElement>('[data-testid="terminal-panel-container"]');
      if (!panelContainer) throw new Error('panel container not rendered');
      return panelContainer.getAnimations().some(
        (animation) => 'transitionProperty' in animation && animation.transitionProperty === 'height',
      );
    }), { timeout: 5000 })
    .toBe(false);
}

/**
 * Count every terminal session pane added under the panel container from now on. The wrapper
 * the panel mounts its panes inside arrives as ONE inserted element with the pane already in
 * it, so an added node counts when it is the pane or holds one. Records are tallied inside the
 * observer callback and read together with `takeRecords()` at read time: a callback that
 * discards its records leaves `takeRecords()` nothing to return.
 */
async function installPaneAdditionRecorder(page: Page): Promise<void> {
  await page.evaluate((paneSelector) => {
    const panelContainer = document.querySelector('[data-testid="terminal-panel-container"]');
    if (!panelContainer) throw new Error('panel container not rendered');
    const recorder = {
      count: 0,
      observer: null as MutationObserver | null,
      tally(records: MutationRecord[]): void {
        for (const record of records) {
          for (const addedNode of Array.from(record.addedNodes)) {
            if (addedNode instanceof Element && (addedNode.matches(paneSelector) || addedNode.querySelector(paneSelector) !== null)) {
              recorder.count += 1;
            }
          }
        }
      },
    };
    recorder.observer = new MutationObserver((records) => recorder.tally(records));
    recorder.observer.observe(panelContainer, { childList: true, subtree: true });
    (window as unknown as { __paneAdditionRecorder?: typeof recorder }).__paneAdditionRecorder = recorder;
  }, SESSION_PANE);
}

async function readPaneAdditions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const recorder = (window as unknown as {
      __paneAdditionRecorder?: { count: number; observer: MutationObserver; tally: (records: MutationRecord[]) => void };
    }).__paneAdditionRecorder;
    if (!recorder) throw new Error('pane addition recorder not installed');
    recorder.tally(recorder.observer.takeRecords());
    return recorder.count;
  });
}

/**
 * Set or clear the detail-window restore arm, then read the panel once React has applied
 * everything the change scheduled. The set and the settle share one evaluate, so the hook's
 * passive effects (which arm the snap timer) have run before the caller advances the paused
 * clock, and the read cannot beat a render queued on the real scheduler, which a fake clock
 * does not touch. The message round trip queues behind React's own message.
 */
async function setRestoreArmAndSettle(
  page: Page,
  projectId: string | null,
): Promise<{ collapsed: string | undefined; hasHeightTransitionClass: boolean }> {
  return page.evaluate(async (pendingProjectId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setPendingDetailWindowsProjectId: (pendingProjectId: string | null) => void } } };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    stores.session.getState().setPendingDetailWindowsProjectId(pendingProjectId);
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
    const panelContainer = document.querySelector<HTMLElement>('[data-testid="terminal-panel-container"]');
    if (!panelContainer) throw new Error('panel container not rendered');
    return {
      collapsed: panelContainer.dataset.collapsed,
      hasHeightTransitionClass: panelContainer.classList.contains('transition-[height]'),
    };
  }, projectId);
}

/** The same settled read, taken without changing anything (after the paused clock moves). */
async function readHeightTransitionClassSettled(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
    const panelContainer = document.querySelector('[data-testid="terminal-panel-container"]');
    if (!panelContainer) throw new Error('panel container not rendered');
    return panelContainer.classList.contains('transition-[height]');
  });
}

test.describe('terminal panel reveal', () => {
  test('Board -> Workflows -> Board shows the terminal again', async () => {
    const { browser, page } = await launch();
    try {
      await enterWorkflowsAndDwell(page);
      await page.locator('[data-testid="view-toggle-board"]').click();

      const container = page.locator(PANEL_CONTAINER);
      await expect(container).toHaveAttribute('data-collapsed', 'false');
      await expect(page.locator(SESSION_PANE)).toBeAttached({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('Workflows -> Backlog -> Board shows the terminal again', async () => {
    const { browser, page } = await launch();
    try {
      await enterWorkflowsAndDwell(page);
      // The release from Workflows happens here, with no panel container rendered.
      await page.locator('[data-testid="view-toggle-backlog"]').click();
      await page.locator('[data-testid="view-toggle-board"]').click();

      const container = page.locator(PANEL_CONTAINER);
      await expect(container).toHaveAttribute('data-collapsed', 'false');
      await expect(page.locator(SESSION_PANE)).toBeAttached({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a detail-window restore that releases after the snap window shows the terminal', async () => {
    const { browser, page } = await launch();
    try {
      const container = page.locator(PANEL_CONTAINER);
      await expect(container).toHaveClass(/transition-\[height\]/, { timeout: 5000 });

      // Arm the restore for the project now shown, as a switch into a project with
      // persisted detail windows does: the panel holds collapsed and unmounts its content.
      await setPendingDetailWindowsProjectId(page, PROJECT_ID);
      await expect(container).toHaveAttribute('data-collapsed', 'true');
      await page.locator(SESSION_PANE).waitFor({ state: 'detached', timeout: 5000 });
      // Wait out the switch's snap window. Inside it the height transition is suppressed and
      // the expand reveals at once, which is the path that already worked.
      await expect(container).toHaveClass(/transition-\[height\]/, { timeout: 5000 });

      // Record any height transition the release starts, then let the restore finish. The
      // session still has a tab, so the panel expands. The listener goes on first, in the
      // same task as the release, so nothing can start before it is there.
      await page.evaluate(() => {
        const pageWindow = window as unknown as {
          __panelHeightTransitionRan?: boolean;
          __zustandStores: { session: { getState: () => { setPendingDetailWindowsProjectId: (pendingProjectId: string | null) => void } } };
        };
        const panelContainer = document.querySelector('[data-testid="terminal-panel-container"]');
        if (!panelContainer) throw new Error('panel container not rendered');
        pageWindow.__panelHeightTransitionRan = false;
        panelContainer.addEventListener('transitionrun', (event) => {
          if (event.target === panelContainer && (event as TransitionEvent).propertyName === 'height') {
            pageWindow.__panelHeightTransitionRan = true;
          }
        });
        pageWindow.__zustandStores.session.getState().setPendingDetailWindowsProjectId(null);
      });
      await expect(container).toHaveAttribute('data-collapsed', 'false');
      await expect(page.locator(SESSION_PANE)).toBeAttached({ timeout: 5000 });

      // A restore paints flat (.claude/rules/restore-no-animation-replay.md): the release
      // snaps the panel open instead of sliding it. `transitionrun` is dispatched on the
      // frame after a transition starts, so two frames later it has had its chance.
      const heightTransitionRan = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return (window as unknown as { __panelHeightTransitionRan?: boolean }).__panelHeightTransitionRan;
      });
      expect(heightTransitionRan).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('leaving the board in the middle of an expand shows the terminal on return', async () => {
    const { browser, page } = await launch();
    try {
      const container = page.locator(PANEL_CONTAINER);
      await expect(container).toHaveClass(/transition-\[height\]/, { timeout: 5000 });
      await page.locator('button[title^="Collapse terminal panel"]').click();
      await page.locator(SESSION_PANE).waitFor({ state: 'detached', timeout: 5000 });

      // Expand, yield one microtask so React commits it, then leave for Backlog in the same
      // task. Two back-to-back clicks would batch into one render with no transition in
      // flight. The document timeline advances only between frames, so the transition is
      // still running when the switch lands, however loaded the runner is.
      const expandState = await page.evaluate(async () => {
        const expandButton = document.querySelector<HTMLElement>('button[title^="Expand terminal panel"]');
        const backlogToggle = document.querySelector<HTMLElement>('[data-testid="view-toggle-backlog"]');
        const panelContainer = document.querySelector<HTMLElement>('[data-testid="terminal-panel-container"]');
        if (!expandButton || !backlogToggle || !panelContainer) throw new Error('panel controls not rendered');
        expandButton.click();
        await Promise.resolve();
        const committed = panelContainer.dataset.collapsed === 'false';
        const transitionRunning = panelContainer.getAnimations().some(
          (animation) => 'transitionProperty' in animation && animation.transitionProperty === 'height',
        );
        backlogToggle.click();
        return { committed, transitionRunning };
      });
      // Proves the case drove the cancel path: the expand committed and its transition was
      // still running when the container went away.
      expect(expandState).toEqual({ committed: true, transitionRunning: true });

      await page.locator('[data-testid="view-toggle-board"]').click();
      await expect(container).toHaveAttribute('data-collapsed', 'false');
      await expect(page.locator(SESSION_PANE)).toBeAttached({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a collapse that lands during an expand never mounts the terminal', async () => {
    const { browser, page } = await launch();
    try {
      const container = page.locator(PANEL_CONTAINER);
      await expect(container).toHaveClass(/transition-\[height\]/, { timeout: 5000 });
      await page.locator('button[title^="Collapse terminal panel"]').click();
      await page.locator(SESSION_PANE).waitFor({ state: 'detached', timeout: 5000 });
      await waitForNoHeightTransition(page);
      await installPaneAdditionRecorder(page);

      // Expand, let React commit it, then collapse again before a frame can move the
      // transition. The same one-task technique as the case above: the document timeline only
      // advances between frames, so the expand's transition is still at its start when the
      // collapse commits, however loaded the runner is. The collapse's after-change height
      // equals that start, so reading the animations (which flushes style) cancels the
      // transition, and its `finished` rejects. That rejection is the settle this case is
      // about, and it is awaited here so the case cannot end before it has been delivered.
      const sequence = await page.evaluate(async () => {
        const panelContainer = document.querySelector<HTMLElement>('[data-testid="terminal-panel-container"]');
        const expandButton = document.querySelector<HTMLElement>('button[title^="Expand terminal panel"]');
        if (!panelContainer || !expandButton) throw new Error('panel controls not rendered');
        expandButton.click();
        await Promise.resolve();
        const expandCommitted = panelContainer.dataset.collapsed === 'false';
        const expandTransition = panelContainer.getAnimations().find(
          (animation) => 'transitionProperty' in animation && animation.transitionProperty === 'height',
        ) ?? null;
        // `finished` is read NOW, before the cancel. A cancelled animation swaps in a fresh
        // promise that never settles, and one that nobody had read yet has nothing to reject,
        // so reading it afterwards would hang whenever the hook under test had not read it first.
        const expandSettled = expandTransition
          ? expandTransition.finished.then(() => 'finished', () => 'cancelled')
          : Promise.resolve('none');
        const collapseButton = document.querySelector<HTMLElement>('button[title^="Collapse terminal panel"]');
        if (!collapseButton) throw new Error('collapse control not rendered');
        collapseButton.click();
        await Promise.resolve();
        const collapseCommitted = panelContainer.dataset.collapsed === 'true';
        panelContainer.getAnimations();
        const expandOutcome = await expandSettled;
        return { expandCommitted, transitionRunning: expandTransition !== null, collapseCommitted, expandOutcome };
      });
      expect(sequence).toEqual({
        expandCommitted: true,
        transitionRunning: true,
        collapseCommitted: true,
        expandOutcome: 'cancelled',
      });

      // A non-occurrence cannot be polled for, so this is a fixed budget. The collapse armed
      // the hook's 200ms hide timer in the same task as the click; a page timer armed after
      // it with a later deadline fires after it. By then a reveal that wrongly mounted the
      // terminal on the cancel has also mounted AND unmounted it, and the observer has seen it.
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
      await expect(container).toHaveAttribute('data-collapsed', 'true');
      await expect(page.locator(SESSION_PANE)).toHaveCount(0);
      expect(await readPaneAdditions(page)).toBe(0);

      // The recorder works and the panel is not stuck: a later expand mounts the terminal.
      await page.locator('button[title^="Expand terminal panel"]').click();
      await expect(page.locator(SESSION_PANE)).toBeAttached({ timeout: 5000 });
      expect(await readPaneAdditions(page)).toBeGreaterThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });

  test('an animated expand mounts the terminal only after its height transition has settled', async () => {
    const { browser, page } = await launch();
    try {
      const container = page.locator(PANEL_CONTAINER);
      await expect(container).toHaveClass(/transition-\[height\]/, { timeout: 5000 });
      await page.locator('button[title^="Collapse terminal panel"]').click();
      await page.locator(SESSION_PANE).waitFor({ state: 'detached', timeout: 5000 });
      await waitForNoHeightTransition(page);

      // The observer goes on first and reads the transition at the moment the pane is added.
      // It runs as a microtask right after the commit that inserts the pane, so what it sees
      // is the state the terminal mounts into: a transition still running means the terminal
      // would fit at a height the panel is still moving away from.
      const expandState = await page.evaluate((paneSelector) => {
        const panelContainer = document.querySelector<HTMLElement>('[data-testid="terminal-panel-container"]');
        const expandButton = document.querySelector<HTMLElement>('button[title^="Expand terminal panel"]');
        if (!panelContainer || !expandButton) throw new Error('panel controls not rendered');
        const pageWindow = window as unknown as {
          __paneMountState?: { capturedTransitionState: string; heightTransitionRunning: boolean };
        };
        const isHeightTransition = (animation: Animation): boolean =>
          'transitionProperty' in animation && animation.transitionProperty === 'height';
        let expandTransition: Animation | null = null;
        const observer = new MutationObserver((records) => {
          if (pageWindow.__paneMountState) return;
          const paneAdded = records.some((record) => Array.from(record.addedNodes).some(
            (addedNode) => addedNode instanceof Element && (addedNode.matches(paneSelector) || addedNode.querySelector(paneSelector) !== null),
          ));
          if (!paneAdded) return;
          pageWindow.__paneMountState = {
            capturedTransitionState: expandTransition?.playState ?? 'none',
            heightTransitionRunning: panelContainer.getAnimations().some(isHeightTransition),
          };
          observer.disconnect();
        });
        observer.observe(panelContainer, { childList: true, subtree: true });
        expandButton.click();
        // Same commit-then-ask technique as the cases above.
        return Promise.resolve().then(() => {
          expandTransition = panelContainer.getAnimations().find(isHeightTransition) ?? null;
          return {
            committed: panelContainer.dataset.collapsed === 'false',
            transitionRunning: expandTransition !== null,
          };
        });
      }, SESSION_PANE);
      // Proves the expand animates, so waiting on a settle is the path under test.
      expect(expandState).toEqual({ committed: true, transitionRunning: true });

      await expect(page.locator(SESSION_PANE)).toBeAttached({ timeout: 5000 });
      const mountState = await page.evaluate(() => (window as unknown as {
        __paneMountState?: { capturedTransitionState: string; heightTransitionRunning: boolean };
      }).__paneMountState ?? null);
      expect(mountState).toEqual({ capturedTransitionState: 'finished', heightTransitionRunning: false });
    } finally {
      await browser.close();
    }
  });

  test('a second project switch inside the snap window restarts the window', async () => {
    // The snap window is 250ms. Two switches 200ms apart must keep the suppression up until
    // 250ms after the SECOND one, so a read 100ms after it (300ms after the first) still
    // sees no transition class, and a read 200ms later (500ms) sees it back. A timer that
    // was not restarted would lift at 250ms. The page's clock is paused, so those offsets
    // are exact and the case does not race the real window.
    const { browser, page } = await launch({ fakeClock: true });
    try {
      const container = page.locator(PANEL_CONTAINER);
      await expect(container).toHaveClass(/transition-\[height\]/, { timeout: 5000 });
      await page.clock.pauseAt(new Date(Date.now() + 1000));

      // First switch: the restore arm for the shown project is raised, which changes the
      // switch key. The panel holds collapsed and drops its transition class at once.
      const afterFirstSwitch = await setRestoreArmAndSettle(page, PROJECT_ID);
      expect(afterFirstSwitch).toEqual({ collapsed: 'true', hasHeightTransitionClass: false });

      await page.clock.runFor(200);

      // Second switch, still inside the first window: the arm is released, which changes the
      // key again. The window restarts from here.
      const afterSecondSwitch = await setRestoreArmAndSettle(page, null);
      expect(afterSecondSwitch.hasHeightTransitionClass).toBe(false);

      // 300ms after the first switch, 100ms after the second: past the first window's end,
      // inside the second's.
      await page.clock.runFor(100);
      expect(await readHeightTransitionClassSettled(page)).toBe(false);

      // 500ms after the first switch, 300ms after the second: past both.
      await page.clock.runFor(200);
      await expect(container).toHaveClass(/transition-\[height\]/, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
