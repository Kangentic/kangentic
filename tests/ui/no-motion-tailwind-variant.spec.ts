/**
 * UI tests for the compiled `[.no-motion_&]:transition-none` Tailwind variant.
 *
 * The desktop app never matches `prefers-reduced-motion: reduce` (main forces
 * Chromium's no-preference switch), so `.no-motion` on <html>, which the
 * Animations setting toggles, is the only thing that can stop a transition
 * there. Three components pair `motion-reduce:transition-none` with the
 * arbitrary variant `[.no-motion_&]:transition-none`.
 * `tests/unit/no-motion-parity.test.ts` checks the class STRING is present.
 * These tests prove the COMPILED rule matches under `.no-motion` and wins the
 * cascade over the element's own `transition-*` utility.
 *
 *  - FileTreePanel: the real `changes-viewed-progress` bar in the Changes panel.
 *  - ChangesHistorySection and TaskDetailBody: the class only exists mid-toggle
 *    (`animateHeight`, `expandTransition`), so a probe element carries the class
 *    literal read from the component source. Reading it from source means
 *    dropping the variant from a component turns exactly its own test red.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchPage } from './helpers';

const PROJECT_ID = 'proj-no-motion';
const TASK_ID = 'task-no-motion';
const SESSION_ID = 'sess-no-motion';

const TASK_DETAIL_DIRECTORY = path.join(
  __dirname, '..', '..', 'src', 'renderer', 'components', 'dialogs', 'task-detail',
);

const NO_MOTION_CLASS_PATTERN = /(^|\s)no-motion(\s|$)/;

const preConfig = `
  window.__mockGitDiff = {
    files: [
      { path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1, original: 'old a', modified: 'new a', language: 'typescript' },
      { path: 'src/b.ts', status: 'M', insertions: 2, deletions: 0, original: 'old b', modified: 'new b', language: 'typescript' },
    ],
    totalInsertions: 5,
    totalDeletions: 1,
  };

  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'No Motion Test',
      path: '/mock/no-motion-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: timestamp,
      created_at: timestamp,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-nm-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/no-motion-test',
      startedAt: timestamp,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'No Motion Task',
      description: 'Task used for the no-motion Tailwind variant test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/no-motion',
      branch_name: 'feature/no-motion',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage({
    beforeLoad: async (launchedPage) => {
      await launchedPage.addInitScript(preConfig);
    },
  });
  browser = result.browser;
  page = result.page;
  // Match the desktop app, where the media query never reports reduce. Without
  // this an OS-level reduced-motion setting would let `motion-reduce:` stop
  // the transition and the `.no-motion` assertions would pass for the wrong reason.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

/**
 * Assert a locator's computed `transition-property` is a real property with
 * motion on, then `none` once `.no-motion` is on <html>. The class is removed
 * in `finally` so the shared page is left clean.
 */
async function expectNoMotionStopsTransition(target: Locator): Promise<void> {
  const html = page.locator('html');
  await expect(html).not.toHaveClass(NO_MOTION_CLASS_PATTERN);

  const transitionProperty = () => target.evaluate((node) => getComputedStyle(node).transitionProperty);
  await expect.poll(transitionProperty).not.toBe('none');

  await page.evaluate(() => document.documentElement.classList.add('no-motion'));
  try {
    await expect.poll(transitionProperty).toBe('none');
  } finally {
    await page.evaluate(() => document.documentElement.classList.remove('no-motion'));
  }
}

/** The first quoted class literal in a component source file that matches `literalPattern`. */
function readClassLiteral(sourceFile: string, literalPattern: RegExp): string {
  const source = fs.readFileSync(path.join(TASK_DETAIL_DIRECTORY, sourceFile), 'utf8');
  const match = literalPattern.exec(source);
  if (!match) {
    throw new Error(`${sourceFile} has no class literal matching ${literalPattern}; update this test to follow the component`);
  }
  return match[1];
}

test.describe('.no-motion Tailwind variant', () => {
  test('FileTreePanel viewed progress bar stops transitioning', async () => {
    await page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=No Motion Task')
      .first()
      .click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });

    const fileTree = page.locator('[data-testid="changes-file-tree"]');
    if (!(await fileTree.isVisible())) {
      await page.locator('[data-testid="changes-toggle"]').click();
    }

    // The bar mounts only while at least one file is viewed.
    const toggleA = fileTree.locator('[data-testid="changes-viewed-toggle"][data-path="src/a.ts"]');
    await toggleA.waitFor({ state: 'visible', timeout: 8000 });
    if ((await toggleA.getAttribute('aria-pressed')) === 'true') {
      await toggleA.click();
      await expect(toggleA).toHaveAttribute('aria-pressed', 'false', { timeout: 3000 });
    }
    await toggleA.click();
    await expect(toggleA).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });

    const progressBar = fileTree.locator('[data-testid="changes-viewed-progress"]');
    await progressBar.waitFor({ state: 'attached', timeout: 3000 });

    await expectNoMotionStopsTransition(progressBar);

    // Close the panel and dialog so state does not leak into the next test.
    await page.locator('[data-testid="changes-toggle"]').click();
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  const probeSites = [
    {
      name: 'ChangesHistorySection height transition',
      sourceFile: path.join('changes', 'ChangesHistorySection.tsx'),
      literalPattern: /'(transition-\[height\][^']*)'/,
    },
    {
      name: 'TaskDetailBody flex-basis transition',
      sourceFile: 'TaskDetailBody.tsx',
      literalPattern: /'(transition-\[flex-basis\][^']*)'/,
    },
  ];

  for (const site of probeSites) {
    test(`${site.name} stops under .no-motion`, async () => {
      const classLiteral = readClassLiteral(site.sourceFile, site.literalPattern);
      const probeTestId = 'no-motion-variant-probe';

      await page.evaluate(({ classes, testId }) => {
        const probe = document.createElement('span');
        probe.setAttribute('data-testid', testId);
        probe.className = classes;
        document.body.appendChild(probe);
      }, { classes: classLiteral, testId: probeTestId });

      try {
        await expectNoMotionStopsTransition(page.locator(`[data-testid="${probeTestId}"]`));
      } finally {
        await page.evaluate((testId) => {
          document.querySelector(`[data-testid="${testId}"]`)?.remove();
        }, probeTestId);
      }
    });
  }
});
