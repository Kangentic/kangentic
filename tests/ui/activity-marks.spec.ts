/**
 * UI coverage for the @kangentic/branding activity marks (`components/ActivityMark.tsx`).
 *
 * The per-feature specs (task-activity-indicators, command-terminal, sidebar-command-terminals)
 * already assert WHICH mark each state renders. This file covers the three things that are
 * properties of the packaged set itself, and that fail silently everywhere else:
 *
 *  1. The packaged `activity.css` reaches the renderer's cascade, and each working mark is on
 *     the primitive it is supposed to be on. `.kng-spin` / `.kng-march` are unscoped globals
 *     arriving from node_modules, so a mark can render perfectly and simply never move, and no
 *     `data-mark` assertion catches that. WHICH primitive matters too: only the rotation is
 *     composited, so a silent revert to the march would still animate here and still stall
 *     under load.
 *  1b. Every mark on screen is anchored to the document timeline. Invisible when it works,
 *     and when it breaks it looks exactly like the stall in (1).
 *  2. The marks render at the size their call site asked for. The packaged SVGs carry a
 *     hardcoded `width="24" height="24"`, so a regression in ActivityMark's root would silently
 *     paint every indicator at 24px.
 *  3. `prefers-reduced-motion` is honored for every primitive, that a stopped mark comes to rest
 *     in a readable state, and that `data-rest` survives into the DOM.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-mark-test';
const TASK_ID = 'task-mark-test';
const SESSION_ID = 'sess-mark-test';
const TRANSIENT_SESSION_ID = 'sess-mark-terminal';

/**
 * `transientActivity` seeds a running Command Terminal PTY in that state, which is what makes the
 * title-bar toggle render a `terminal-*` mark. Omit it and the toggle sits at `terminal-idle`.
 */
function preConfig(activity: string, transientActivity?: string): string {
  const transientSession = transientActivity
    ? `
      state.sessions.push({
        id: '${TRANSIENT_SESSION_ID}', taskId: 'task-${TRANSIENT_SESSION_ID}',
        projectId: '${PROJECT_ID}', pid: 8888, status: 'running', shell: 'bash',
        cwd: '/mock/mark-test', startedAt: ts, exitCode: null, transient: true,
      });
      state.activityCache['${TRANSIENT_SESSION_ID}'] = '${transientActivity}';
      `
    : '';
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Mark Test', path: '/mock/mark-test',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        state.swimlanes.push({
          id: 'lane-mark-' + index, name: swimlane.name, role: swimlane.role, color: swimlane.color,
          icon: swimlane.icon, is_archived: swimlane.is_archived,
          permission_strategy: swimlane.permission_strategy ?? null,
          auto_spawn: swimlane.auto_spawn ?? false, position: index, created_at: ts,
        });
      });
      var execLane = state.swimlanes.find(function (swimlane) { return swimlane.name === 'Executing'; });
      state.sessions.push({
        id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999,
        status: 'running', shell: 'bash', cwd: '/mock/mark-test',
        startedAt: ts, exitCode: null,
      });
      state.activityCache['${SESSION_ID}'] = '${activity}';
      ${transientSession}
      state.tasks.push({
        id: '${TASK_ID}', title: 'Mark Test Task', description: '',
        swimlane_id: execLane.id, position: 0, agent: 'claude',
        model_override: null, effort_override: null, session_id: '${SESSION_ID}',
        worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
        base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function launch(
  activity: string,
  reducedMotion?: 'reduce',
  transientActivity?: string,
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(activity, transientActivity));
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

/**
 * Every computed-style read below goes through `expect.poll`, NOT a one-shot `locator.evaluate`.
 *
 * `evaluate` resolves the element and then runs the callback; if the board re-renders in that
 * gap the handle is detached, and `getComputedStyle` on a detached node returns `''` for every
 * property rather than throwing - so the assertion fails with an empty string instead of
 * retrying. The bare-`evaluate` form failed roughly one run in four at the UI tier's 3 workers
 * while passing 12/12 at `--workers=1`: exactly the load-dependent shape that is green locally
 * and red on CI. Polling re-resolves the element on each attempt.
 */

test.describe('Activity marks', () => {
  test('the packaged activity.css reaches the cascade and drives a COMPOSITED rotation', async () => {
    const { browser, page } = await launch('thinking', undefined, 'thinking');
    try {
      const readAnimation = (locator: ReturnType<Page['locator']>): Promise<unknown> =>
        locator.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            name: style.animationName,
            duration: style.animationDuration,
            timing: style.animationTimingFunction,
            iteration: style.animationIterationCount,
          };
        });

      const mark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(mark).toBeVisible({ timeout: 15000 });

      // The round working mark ROTATES. `transform` is the only reason this test names a
      // specific keyframe rather than just "something animates": Chromium composites transform
      // animations and cannot composite `stroke-dashoffset`, so a silent revert to the march
      // would keep this mark rendering and animating while reintroducing the stall it was
      // moved to escape. Nothing else in the suite would notice.
      await expect
        .poll(() => readAnimation(mark.locator('.kng-spin')), {
          message:
            'activity.css did not reach the cascade, or agent-working reverted to the '
            + 'non-composited march: the board indicator freezes whenever the renderer is busy',
        })
        .toEqual({
          name: 'kng-activity-spin',
          duration: '1.4s',
          timing: 'linear',
          iteration: 'infinite',
        });

      // The terminal chip is not radially symmetric, so it cannot rotate at all. Its working
      // state is a solid outline with a blinking cursor, on `opacity`, which composites. The
      // period must MATCH the rotation above: both are anchored to the document timeline, and a
      // mismatch drifts the sidebar's agent ring out of lockstep with the chip beside it.
      const terminalMark = page.getByTestId('quick-session-icon');
      await expect(terminalMark).toHaveAttribute('data-mark', 'terminal-working', { timeout: 10000 });
      await expect
        .poll(() => readAnimation(terminalMark.locator('.kng-blink')), {
          message: 'the terminal chip lost its blink, or its period drifted from the rotation',
        })
        .toEqual({
          name: 'kng-activity-blink',
          duration: '1.4s',
          timing: 'linear',
          iteration: 'infinite',
        });

      // The blink rides the WHOLE PROMPT and leaves the outline solid. Both halves matter and
      // neither is caught anywhere else: blinking less (the bar alone, as 2.8.0 shipped) draws
      // 2.7px at this size and is illegible, and blinking more (the outline, or the whole mark)
      // fades the tone that carries working-vs-resting. Either mistake still animates, still
      // composites, and sails past every other assertion in this file.
      await expect(terminalMark.locator('.kng-blink > path')).toHaveCount(2);
      await expect(terminalMark.locator('.kng-blink rect')).toHaveCount(0);
      await expect
        .poll(() => terminalMark.locator('rect').first().evaluate((node) => getComputedStyle(node).animationName), {
          message: 'the chip outline must not blink - a whole-mark fade dims the state tone',
        })
        .toBe('none');
    } finally {
      await browser.close();
    }
  });

  test('every mark on screen is anchored to the document timeline, so none can restart', async () => {
    // The anchor is what makes a rebuilt node resume where the survivors are. It is invisible
    // when it works and indistinguishable from the compositing stall when it breaks, so assert
    // it directly: startTime 0 on every animation, and one shared currentTime across all of
    // them. This is the guard for the selector regression - anchoring only `.kng-march` would
    // leave the rotating marks un-anchored, and everything else here would still pass.
    const { browser, page } = await launch('thinking', undefined, 'thinking');
    try {
      const mark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(mark).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('quick-session-icon'))
        .toHaveAttribute('data-mark', 'terminal-working', { timeout: 10000 });

      await expect
        .poll(
          () => page.evaluate(() => {
            const animated = Array.from(document.querySelectorAll('.kng-spin, .kng-march, .kng-blink'));
            const animations = animated.flatMap((node) => node.getAnimations());
            return {
              // Both shipped primitives must actually be on screen, or "all anchored" is vacuous.
              classes: [...new Set(animated.map((node) => node.getAttribute('class')))].sort(),
              unanchored: animations.filter((animation) => animation.startTime !== 0).length,
              phases: new Set(animations.map((animation) => String(animation.currentTime))).size,
            };
          }),
          { message: 'activity marks are not all anchored to the document timeline' },
        )
        .toEqual({ classes: ['kng-blink', 'kng-spin'], unanchored: 0, phases: 1 });
    } finally {
      await browser.close();
    }
  });

  test('a mark REBUILT after mount (idle -> working mid-session) re-anchors instead of keeping its own creation-time phase', async () => {
    // Every anchor assertion above seeds the card as agent-working from the very first paint,
    // so the only invocation of ActivityMark's layout effect they exercise is its FIRST one -
    // which always runs, dependency array or not, and would still pass even if a future edit
    // added one (e.g. `}, [mark])` still fires on this exact prop change; `}, [])` would not,
    // but neither shape is what this test is pinning). The actual defect class the anchor
    // exists to prevent is a SUBSEQUENT render swapping in fresh markup: `TaskCard` flips
    // `mark` from 'agent-idle' to 'agent-working' via `dangerouslySetInnerHTML`, which builds
    // a brand-new <g class="kng-spin"> with no React fiber and no animation history. This
    // drives that exact transition mid-session, after the page has been running long enough
    // that an unanchored animation could not land on startTime 0 by coincidence, and confirms
    // the freshly created animation is actively RE-anchored - not merely correctly anchored
    // because it happened to exist from the start.
    const { browser, page } = await launch('idle');
    try {
      const idleMark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-idle"]`);
      await expect(idleMark).toBeVisible({ timeout: 15000 });
      // agent-idle is static (see 'a static mark carries no motion group at all'), so nothing
      // is animating yet - the interesting event is what the rebuild does a moment from now.
      await expect(idleMark.locator('.kng-spin')).toHaveCount(0);

      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores: { session: { getState: () => { updateActivity: (id: string, state: string) => void } } };
        }).__zustandStores;
        stores.session.getState().updateActivity(sessionId, 'thinking');
      }, SESSION_ID);

      const workingMark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(workingMark).toBeVisible({ timeout: 10000 });

      await expect
        .poll(
          () => page.evaluate((taskId) => {
            const node = document.querySelector(
              `[data-task-id="${taskId}"] [data-mark="agent-working"] .kng-spin`,
            );
            if (!node) return null;
            const animations = node.getAnimations();
            return {
              // Turns the "enough real time has passed" precondition into an assertion rather
              // than a sleep-and-hope: a fresh, UNanchored animation's startTime is set to the
              // document timeline's current time at creation, so it can only read exactly 0 by
              // fluke if the timeline itself is still near its origin.
              documentTimeWellPastOrigin: (document.timeline.currentTime ?? 0) > 200,
              // Not just "no animation has drifted" - a mutation that dropped the motion group
              // entirely would otherwise pass this vacuously, the same failure mode the
              // sibling test above guards against with its `classes:` key.
              animationCount: animations.length,
              startTime: animations[0]?.startTime ?? null,
            };
          }, TASK_ID),
          {
            message:
              'the rebuilt working mark kept its own creation-time phase instead of '
              + 're-anchoring to the document timeline - it will visibly jump or restart '
              + 'against every mark that was already on screen',
          },
        )
        .toEqual({ documentTimeWellPastOrigin: true, animationCount: 1, startTime: 0 });
    } finally {
      await browser.close();
    }
  });

  test('marks render at their call site size, not the packaged 24px', async () => {
    // Computed style, not boundingBox: the task-detail window carries a scale transform, so
    // every measured rect inside it is uniformly smaller than its layout size.
    const { browser, page } = await launch('thinking');
    try {
      // 16, not 14: the branding envelope is 18 wide where lucide's Mail was 20, so keeping the
      // old number would have shrunk the drawn mark ~10% against what production shipped; 15
      // restored that size and 16 is a deliberate one-step legibility bump on top.
      const cardMark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(cardMark).toBeVisible({ timeout: 15000 });
      await expect
        .poll(() => cardMark.evaluate((node) => getComputedStyle(node).width))
        .toBe('16px');

      await page.locator('text=Mark Test Task').first().click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      const pauseButton = dialog.locator('button[title="Pause session"]');
      const ring = pauseButton.locator('[data-mark="control-pause-working"]');
      await expect(ring).toBeVisible({ timeout: 10000 });

      // The control mark is r=10, so 20 * (2*10+2)/24 = 18.33px of drawn ring - a pixel match
      // for the lucide Circle it replaced. No size compensation, and none should come back.
      await expect
        .poll(() => ring.evaluate((node) => getComputedStyle(node).width), {
          message: 'control marks must render at 20 to match the lucide Circle they replaced',
        })
        .toBe('20px');

      // The slot is pinned so the button does not resize as the activity state flips.
      await expect
        .poll(
          () => pauseButton.locator('span.grid').first()
            .evaluate((node) => getComputedStyle(node).width),
          { message: 'the icon slot must stay 20px' },
        )
        .toBe('20px');
    } finally {
      await browser.close();
    }
  });

  test('a static mark carries no motion group at all', async () => {
    const { browser, page } = await launch('idle');
    try {
      const mark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-idle"]`);
      await expect(mark).toBeVisible({ timeout: 15000 });
      await expect(mark).toHaveAttribute('data-rest', 'static');
      await expect(mark.locator('.kng-march, .kng-spin')).toHaveCount(0);
      // The idle branch carries its own `size={16}` literal in TaskCard, separate from the
      // thinking branch the size test above measures, so it can regress on its own.
      await expect
        .poll(() => mark.evaluate((node) => getComputedStyle(node).width))
        .toBe('16px');
    } finally {
      await browser.close();
    }
  });

  test('prefers-reduced-motion stops every primitive and leaves both marks readable', async () => {
    // The transient terminal is seeded 'thinking' on purpose: `terminal-working` renders only
    // when a running transient PTY is active, because `selectCommandTerminalSummary` counts
    // `transient && running` sessions, so the task's own (non-transient) session never drives
    // the toggle no matter what its activity is. Without this the toggle sits at `terminal-idle`
    // and the blink assertion below has nothing to check.
    const { browser, page } = await launch('thinking', 'reduce', 'thinking');
    try {
      const mark = page.locator(`[data-task-id="${TASK_ID}"] [data-mark="agent-working"]`);
      await expect(mark).toBeVisible({ timeout: 15000 });
      // Each time upstream added a primitive, a reduced-motion rule still naming only the
      // previous ones would have left the newest marks moving - silently, and only for the
      // users who asked for no motion. Both shipped primitives are checked here for that reason.
      await expect
        .poll(
          () => mark.locator('.kng-spin').evaluate((node) => getComputedStyle(node).animationName),
          { message: 'prefers-reduced-motion should disable the rotation' },
        )
        .toBe('none');

      const terminalMark = page.getByTestId('quick-session-icon');
      await expect(terminalMark).toHaveAttribute('data-mark', 'terminal-working', { timeout: 10000 });
      await expect
        .poll(
          () => terminalMark.locator('.kng-blink').evaluate((node) => getComputedStyle(node).animationName),
          { message: 'prefers-reduced-motion should disable the blink' },
        )
        .toBe('none');

      // And the prompt must come to rest VISIBLE, not stuck at the keyframe's 0.06 trough. The
      // packaged CSS deliberately ships no animation fill mode for exactly this reason, so a
      // stopped blink resolves to the element's own opacity rather than to its last keyframe.
      // Without this the mark would rest looking like it had lost its prompt.
      //
      // Read the GROUP, not a child path. The animation is on `<g class="kng-blink">`, and a
      // child <path> computes to opacity 1 no matter what the group is doing - so asserting on
      // the path would pass even with the group stuck at 0.06, which is the whole failure.
      await expect
        .poll(
          () => terminalMark.locator('.kng-blink').evaluate((node) => getComputedStyle(node).opacity),
          { message: 'a stopped prompt must rest visible, not at the blink trough' },
        )
        .toBe('1');

      // `data-rest` still has to survive the packaged-wrapper strip into the React-authored
      // root: it is the hook the packaged `svg[data-rest="drop-dash"] *` rule keys off. No
      // shipped mark declares drop-dash since the chip's dash was removed, so this asserts the
      // attribute is plumbed and correct rather than exercising that rule.
      await expect(terminalMark).toHaveAttribute('data-rest', 'static');
      await expect
        .poll(
          () => terminalMark.locator('rect').first()
            .evaluate((node) => getComputedStyle(node).strokeDasharray),
          { message: 'the working chip outline must be solid' },
        )
        .toBe('none');
    } finally {
      await browser.close();
    }
  });
});
