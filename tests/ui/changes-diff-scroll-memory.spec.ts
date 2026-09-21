/**
 * UI tests for the Changes view diff scroll memory.
 *
 * Verifies that opening a file for the first time reveals its first change
 * centered (so a change deep in the file is scrolled into view and the top of
 * the file is virtualized away), and that switching away and back restores the
 * previous scroll position instead of re-revealing the first change.
 *
 * The second test covers the shorter-layout case: a position saved against the
 * expanded diff, restored after unchanged regions were folded away, must stay
 * inside the scrollable range rather than leaving an offset past the end.
 *
 * The third test covers the asymmetric case, on the ORIGINAL side: after a
 * refold on a diff whose original half is shorter than its modified half, the
 * original editor's viewport must still resolve inside its own model. It is a
 * guard, not a reproduction of Sentry DESKTOP-19; the comment above the test
 * says what was measured and why.
 *
 * Monaco virtualizes lines: only visible lines exist as `.view-line` DOM nodes,
 * so DOM presence of a token is a proxy for "scrolled to that region". The diff
 * is computed client-side from the mock's original/modified strings, so no real
 * git is involved; the fixture is seeded via window.__mockGitDiff.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-diff-scroll';
const TASK_ID = 'task-diff-scroll';
const SESSION_ID = 'sess-diff-scroll';

const TOP_TOKEN = 'TOP_OF_FILE_TOKEN_AAA';
const MID_TOKEN = 'MID_CHANGE_TOKEN_ZZZ';
const TOTAL_LINES = 200;
const CHANGE_LINE = 100;

// delta.ts is long and almost entirely unchanged, with its single change near
// the top. Collapsing unchanged regions therefore removes nearly all of its
// height, which is what turns a position saved against the expanded layout into
// an offset past the end of the folded one.
const DELTA_TAIL_TOKEN = 'DELTA_TAIL_TOKEN_QQQ';
const DELTA_TOTAL_LINES = 3000;
const DELTA_CHANGE_LINE = 5;

// gamma.ts is the ASYMMETRIC file, and the asymmetry is its whole reason to
// exist.
//
// delta.ts above has the same 3000 lines on both sides, so any offset Monaco
// mirrors from the modified editor onto the original one
// (diffEditorViewZones.js's "update scroll original" autorun) is always a valid
// offset for the original too. gamma.ts inserts a large block instead: the
// original side is 1500 lines, the modified side 3000, and Monaco pads the
// original with an alignment view zone as tall as the insertion to keep the
// sides level. It also keeps large unchanged spans at both ends, so "Collapse
// unchanged" has real regions to fold.
//
// Measured on this fixture while investigating Sentry DESKTOP-19: a refold with
// a deep scroll live walks the ORIGINAL editor's viewport to model line 1500
// against a line count of exactly 1500 - the boundary of the throw, which is
// `lineNumber > getLineCount()` in textModel.js. delta.ts cannot get near that.
const GAMMA_TAIL_TOKEN = 'GAMMA_TAIL_TOKEN_WWW';
const GAMMA_ORIGINAL_LINES = 1500;
const GAMMA_INSERTED_LINES = 1500;
const GAMMA_INSERT_AFTER_LINE = 10;
// A pure insertion after line 10 reports modifiedStartLineNumber 11, distinct
// from alpha (100), beta (2) and delta (5), so it identifies gamma's own diff
// result (see readModifiedFirstChangeLine).
const GAMMA_CHANGE_LINE = GAMMA_INSERT_AFTER_LINE + 1;

// Build a long file whose only change sits deep in the middle (line 100), with a
// recognizable token on line 1 so we can tell whether the viewport is at the top.
function buildFixtureScript(): string {
  return `
    (function () {
      var lines = [];
      for (var i = 1; i <= ${TOTAL_LINES}; i++) {
        if (i === 1) { lines.push('// ${TOP_TOKEN} line ' + i); }
        else if (i === ${CHANGE_LINE}) { lines.push('const filler = ' + i + ';'); }
        else { lines.push('// filler line ' + i); }
      }
      var original = lines.join('\\n');
      var modifiedLines = lines.slice();
      modifiedLines[${CHANGE_LINE} - 1] = 'const value = "${MID_TOKEN}";';
      var modified = modifiedLines.join('\\n');
      var deltaLines = [];
      for (var deltaLineNumber = 1; deltaLineNumber <= ${DELTA_TOTAL_LINES}; deltaLineNumber++) {
        if (deltaLineNumber === ${DELTA_TOTAL_LINES}) { deltaLines.push('// ${DELTA_TAIL_TOKEN} ' + deltaLineNumber); }
        else { deltaLines.push('// delta line ' + deltaLineNumber); }
      }
      var deltaOriginal = deltaLines.join('\\n');
      var deltaModifiedLines = deltaLines.slice();
      deltaModifiedLines[${DELTA_CHANGE_LINE} - 1] = 'const deltaChanged = true;';
      var deltaModified = deltaModifiedLines.join('\\n');

      var gammaOriginalLines = [];
      for (var gammaLineNumber = 1; gammaLineNumber <= ${GAMMA_ORIGINAL_LINES}; gammaLineNumber++) {
        if (gammaLineNumber === ${GAMMA_ORIGINAL_LINES}) { gammaOriginalLines.push('// ${GAMMA_TAIL_TOKEN} ' + gammaLineNumber); }
        else { gammaOriginalLines.push('// gamma line ' + gammaLineNumber); }
      }
      var gammaInsertedLines = [];
      for (var gammaInsertIndex = 1; gammaInsertIndex <= ${GAMMA_INSERTED_LINES}; gammaInsertIndex++) {
        gammaInsertedLines.push('const gammaAdded' + gammaInsertIndex + ' = ' + gammaInsertIndex + ';');
      }
      var gammaModifiedLines = gammaOriginalLines
        .slice(0, ${GAMMA_INSERT_AFTER_LINE})
        .concat(gammaInsertedLines)
        .concat(gammaOriginalLines.slice(${GAMMA_INSERT_AFTER_LINE}));
      var gammaOriginal = gammaOriginalLines.join('\\n');
      var gammaModified = gammaModifiedLines.join('\\n');

      window.__mockGitDiff = {
        files: [
          { path: 'alpha.ts', status: 'M', insertions: 1, deletions: 1, original: original, modified: modified, language: 'typescript' },
          { path: 'beta.ts', status: 'M', insertions: 1, deletions: 0, original: 'const a = 1;', modified: 'const a = 1;\\nconst b = 2;', language: 'typescript' },
          { path: 'delta.ts', status: 'M', insertions: 1, deletions: 1, original: deltaOriginal, modified: deltaModified, language: 'typescript' },
          { path: 'gamma.ts', status: 'M', insertions: ${GAMMA_INSERTED_LINES}, deletions: 0, original: gammaOriginal, modified: gammaModified, language: 'typescript' },
        ],
      };
    })();
  `;
}

interface ModifiedEditorHandle {
  getScrollTop: () => number;
  getScrollHeight: () => number;
  getLayoutInfo: () => { height: number };
  setScrollTop: (scrollTop: number) => void;
}

interface OriginalEditorHandle {
  getModel: () => { getLineCount: () => number } | null;
  getVisibleRanges: () => { endLineNumber: number }[];
}

interface MonacoTestHandle {
  editor: {
    getDiffEditors: () => {
      getModifiedEditor: () => ModifiedEditorHandle;
      getOriginalEditor: () => OriginalEditorHandle;
      getLineChanges: () => { modifiedStartLineNumber: number }[] | null;
    }[];
  };
}

interface ModifiedScrollState {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}

/**
 * Read the live modified-side scroll geometry through the dev-only monaco
 * handle (`window.__monaco`, exposed by monacoConfig.ts in dev builds).
 * Returns -1s when no diff editor is mounted so a poll can wait it out.
 */
async function readModifiedScrollState(target: Page): Promise<ModifiedScrollState> {
  return target.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) return { scrollTop: -1, scrollHeight: -1, viewportHeight: -1 };
    const modifiedEditor = diffEditors[0].getModifiedEditor();
    return {
      scrollTop: modifiedEditor.getScrollTop(),
      scrollHeight: modifiedEditor.getScrollHeight(),
      viewportHeight: modifiedEditor.getLayoutInfo().height,
    };
  });
}

/**
 * The modified-side line of the diff editor's FIRST computed line change, or
 * -1 with no editor mounted or no change computed.
 *
 * A wait on this must name the line it expects, never just "non-empty".
 * Switching files swaps the model's content in place and Monaco recomputes
 * the diff asynchronously, so between the swap and the result landing
 * `getLineChanges()` still returns the PREVIOUS file's changes. Measured on
 * this fixture: 1 ms after the delta.ts click the model was already delta's
 * 3000 lines while the changes still read alpha's line 100, and delta's own
 * result (line 5) landed 154 ms later. A "length > 0" poll passes inside
 * that window. Every fixture file here has exactly one change at a distinct
 * line (alpha 100, beta 2, delta 5), so the line identifies whose diff it is.
 */
async function readModifiedFirstChangeLine(target: Page): Promise<number> {
  return target.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) return -1;
    return diffEditors[0].getLineChanges()?.[0]?.modifiedStartLineNumber ?? -1;
  });
}

/**
 * The ORIGINAL (left) editor's model line count and the furthest line its
 * viewport currently resolves. `threw: true` when the read itself raised.
 *
 * The original side is where Sentry DESKTOP-19 throws, and it is never the side
 * app code scrolls: Monaco mirrors the modified editor's scrollTop onto it
 * (diffEditorViewZones.js's "update scroll original" autorun), and on a diff
 * that inserts lines the original is the shorter of the two. `getVisibleRanges`
 * walks the same viewport data the throwing `getModelVisibleRanges` does, so a
 * read that raises here is the condition itself rather than a proxy for it.
 *
 * `visibleRangeCount` exists so a caller can tell "the viewport resolved to
 * line N" from "the viewport reported nothing": `getVisibleRanges()` can
 * return an empty array before the original pane has laid out, and an empty
 * array folds into `maxVisibleLine: 0` via the reduce's seed below, which is
 * trivially `<= lineCount` for any positive line count. Without this field a
 * caller cannot distinguish that false pass from an actual walk to the
 * model's last line.
 */
async function readOriginalViewportState(
  target: Page,
): Promise<{ lineCount: number; maxVisibleLine: number; visibleRangeCount: number; threw: boolean }> {
  return target.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) {
      return { lineCount: -1, maxVisibleLine: -1, visibleRangeCount: -1, threw: false };
    }
    const originalEditor = diffEditors[0].getOriginalEditor();
    try {
      const lineCount = originalEditor.getModel()?.getLineCount() ?? -1;
      const visibleRanges = originalEditor.getVisibleRanges();
      const maxVisibleLine = visibleRanges.reduce(
        (furthest, range) => Math.max(furthest, range.endLineNumber),
        0,
      );
      return { lineCount, maxVisibleLine, visibleRangeCount: visibleRanges.length, threw: false };
    } catch {
      return { lineCount: -1, maxVisibleLine: -1, visibleRangeCount: -1, threw: true };
    }
  });
}

/**
 * Drive the modified side to its bottom. Programmatic rather than Ctrl+End
 * because a click to focus could land in either pane, and Monaco saturates an
 * over-large offset at the real maximum for the current layout.
 */
async function scrollModifiedToBottom(target: Page): Promise<void> {
  await target.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: MonacoTestHandle }).__monaco;
    const diffEditors = monaco?.editor.getDiffEditors() ?? [];
    if (diffEditors.length === 0) return;
    const modifiedEditor = diffEditors[0].getModifiedEditor();
    modifiedEditor.setScrollTop(modifiedEditor.getScrollHeight());
  });
}

/**
 * Drive "Collapse unchanged" to an explicit state through the diff view-options
 * menu.
 *
 * Set-to-a-state rather than toggle, and therefore idempotent: the preference is
 * GLOBAL, so a test that leaves it on poisons every sibling in this shared-page
 * file (cross-platform-parity.md forbids that cascade). A blind toggle in a
 * cleanup path cannot be made safe, because it has no way to tell "the test
 * enabled this" from "the enabling click itself threw before it landed" and
 * would switch the preference ON while trying to restore it.
 */
async function setCollapseUnchanged(target: Page, enabled: boolean): Promise<void> {
  const optionsTrigger = target.locator('[data-testid="diff-view-options"]');
  const optionsMenu = target.locator('[data-testid="diff-view-options-menu"]');
  await optionsTrigger.click();
  await optionsMenu.waitFor({ state: 'visible', timeout: 5000 });
  const collapseItem = optionsMenu.locator('[data-testid="diff-collapse-unchanged"]');
  await collapseItem.waitFor({ state: 'visible', timeout: 5000 });
  if ((await collapseItem.getAttribute('aria-checked')) !== String(enabled)) {
    await collapseItem.click();
    await expect(collapseItem).toHaveAttribute('aria-checked', String(enabled), { timeout: 5000 });
  }
  // The menu is a checklist and stays open after a check, so close it through
  // its own trigger rather than Escape, which the task-detail window also uses.
  await optionsTrigger.click();
  await optionsMenu.waitFor({ state: 'hidden', timeout: 5000 });
}

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Diff Scroll Test',
      path: '/mock/diff-scroll-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/diff-scroll-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Diff Scroll Task',
      description: 'Task used for diff scroll memory test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/diff-scroll',
      branch_name: 'feature/diff-scroll',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.addInitScript(buildFixtureScript());

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Changes view: diff scroll memory', () => {
  test('first open reveals the first change centered; revisit restores scroll', async () => {
    // This test chains 8 sequential waits (dialog mount, Changes panel mount,
    // Monaco diff-editor construction, two file switches, two scroll-position
    // reveals, dialog close), each individually budgeted up to 10000ms to
    // absorb CI worker contention (see the diff-editor-area comment below and
    // its history in a523964b). Bumping an individual waitFor timeout does
    // nothing for the ENCLOSING test: the ui project's default per-test
    // timeout is 15000ms, so a single slow step (observed: Monaco construction
    // taking 6.5-10.7s under contention) already exhausts the whole test's
    // budget before the remaining steps run, independent of their own
    // per-step timeouts. test.slow() triples the enclosing budget to 45000ms,
    // which is what actually needed to change - every wait here is already a
    // conditional poll on real DOM/programmatic state, not a fixed sleep, so
    // there is no further step to restructure.
    test.slow();
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Diff Scroll Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Open the Changes panel; alpha.ts is auto-selected (first file).
    await page.locator('[data-testid="changes-toggle"]').click();
    // 10s, matching every other visibility wait in this test (below) and the
    // sibling commit-detail-selection.spec.ts: under CI worker contention the
    // panel mount + Monaco diff-editor construction can take longer than a
    // tight 5s budget (observed flake: failed at 6.5s, passed at 10.7s on
    // retry), so a fixed 5000ms here was simply tighter than everywhere else
    // that waits on the same locator.
    await page.locator('[data-testid="diff-editor-area"]').waitFor({ state: 'visible', timeout: 10000 });
    // Wait for Monaco to render diff content (rendered line nodes exist).
    await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });

    const midLine = page.locator('.view-line', { hasText: MID_TOKEN });
    const topLine = page.locator('.view-line', { hasText: TOP_TOKEN });

    // First visit: the change deep in the file is revealed (centered), so its
    // line is rendered and the virtualized top of the file is not.
    await expect(midLine).toBeVisible({ timeout: 10000 });
    await expect(topLine).toHaveCount(0);

    // Scroll to the top of the file so the saved position differs from the
    // first-change reveal. Focus the modified editor by clicking the revealed
    // change line, then jump to the top with Ctrl+Home (deterministic, unlike
    // wheel delta math which depends on the editor's height).
    await midLine.click();
    await page.keyboard.press('Control+Home');
    // TOP_TOKEN renders in both diff panes once at the top, so match the first.
    await expect(topLine.first()).toBeVisible({ timeout: 10000 });

    // Switch to beta.ts, then back to alpha.ts.
    await page.locator('button', { hasText: 'beta.ts' }).click();
    await expect(page.locator('.view-line', { hasText: 'const b = 2;' })).toBeVisible({ timeout: 10000 });

    await page.locator('button', { hasText: 'alpha.ts' }).click();

    // Revisit restores the saved top position: the top token is visible again
    // and the first-change line is NOT re-revealed.
    await expect(topLine.first()).toBeVisible({ timeout: 10000 });
    await expect(midLine).toHaveCount(0);

    // Use Control+Shift+W (capture-phase) rather than Escape: Monaco captured
    // focus via the click+Ctrl+Home sequence, so the bubble-phase Escape listener
    // on the task-detail window can be intercepted by Monaco on CI Linux.
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // Regression guard for Sentry DESKTOP-8 ("Illegal value for lineNumber"),
  // NOT a reproduction of it. The reported throw comes from Monaco's own
  // scroll-synchronisation autorun while it updates a diff's alignment view
  // zones, and it could not be reproduced here: measured against this fixture,
  // Monaco saturates a deep restore at the bottom of the collapsed layout
  // (54000px of scroll height down to 528px) without throwing. What this test
  // does pin is the app-side contract around that crash path - a position saved
  // against the expanded layout, restored onto a folded one, must stay inside
  // the scrollable range and must not surface a renderer error.
  test('restoring a deep position onto a diff that folds stays in range and does not throw', async () => {
    // Same chained-wait budget as the test above: dialog mount, panel mount,
    // Monaco construction, three file switches and their diff recomputes.
    test.slow();

    // Registered here rather than in beforeAll so the preceding test's errors
    // (if any) are not attributed to this one.
    const getPageErrors = collectPageErrors(page);

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Diff Scroll Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The Changes panel's open state survives the preceding test's dialog
    // close, so toggle only when it did NOT come back open - an unconditional
    // click would close it. Waiting first (rather than probing visibility)
    // keeps this correct while the panel is still mounting.
    const diffArea = page.locator('[data-testid="diff-editor-area"]');
    try {
      await diffArea.waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      await page.locator('[data-testid="changes-toggle"]').click();
      await diffArea.waitFor({ state: 'visible', timeout: 10000 });
    }
    await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });

    // Open delta.ts expanded (collapse is off by default) and go to its bottom,
    // which is only reachable while the unchanged bulk is shown.
    await page.locator('button', { hasText: 'delta.ts' }).click();
    await page.locator('.view-line', { hasText: 'delta line' }).first().waitFor({ state: 'visible', timeout: 10000 });

    // Wait for the expanded layout before capturing: a file this long is far
    // taller than the pane, so a real scroll range exists.
    await expect
      .poll(async () => (await readModifiedScrollState(page)).scrollHeight, { timeout: 10000 })
      .toBeGreaterThan(DELTA_TOTAL_LINES * 5);

    // And wait for delta.ts's OWN diff: the scroll height above grows as soon
    // as the model loads, but the first-visit reveal (DiffViewer's
    // consumePendingReveal, centring delta.ts's change at line 5) fires from
    // onDidUpdateDiff once the diff has computed. Scrolling before that lets
    // the reveal land AFTER the scroll and put scrollTop back to 0, which is
    // what the poll below then reads for its whole budget. Once delta's
    // result is what getLineChanges reports, the reveal has already been
    // consumed, since Monaco fires the update event synchronously with the
    // result. "Any change" is not enough: until then the call still reports
    // the previous file's diff (see readModifiedFirstChangeLine), and that
    // stale read is how this test flaked on UI shard 3 after aae810ac.
    await expect
      .poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 })
      .toBe(DELTA_CHANGE_LINE);

    await scrollModifiedToBottom(page);
    await expect(page.locator('.view-line', { hasText: DELTA_TAIL_TOKEN }).first()).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => (await readModifiedScrollState(page)).scrollTop, { timeout: 10000 })
      .toBeGreaterThan(1000);

    // Switch away so the deep position is committed under delta.ts's key.
    await page.locator('button', { hasText: 'beta.ts' }).click();
    await expect(page.locator('.view-line', { hasText: 'const b = 2;' })).toBeVisible({ timeout: 10000 });

    // Turn on "Collapse unchanged" while delta.ts is NOT the open file, so the
    // next visit restores a position saved against the expanded layout onto a
    // folded one that is a fraction of the height.
    //
    // The enable is INSIDE the try, so a throw part-way through it is still
    // followed by the cleanup below. That is only safe because the helper sets
    // an explicit state instead of toggling.
    try {
      await setCollapseUnchanged(page, true);
      await page.locator('button', { hasText: 'delta.ts' }).click();
      await page.locator('.view-line', { hasText: 'delta' }).first().waitFor({ state: 'visible', timeout: 10000 });

      // Wait for the fold to actually land. Monaco renders each folded unchanged
      // region as a .diff-hidden-lines widget; without this the assertions below
      // would run against the still-expanded layout and prove nothing.
      await expect
        .poll(async () => page.locator('.diff-hidden-lines').count(), { timeout: 10000 })
        .toBeGreaterThan(0);

      // Restoring past the end must saturate inside the folded layout rather than
      // leaving an out-of-range offset for Monaco to resolve into a line past the
      // model's end.
      await expect
        .poll(
          async () => {
            const state = await readModifiedScrollState(page);
            if (state.scrollHeight < 0) return false;
            const maxScrollTop = Math.max(0, state.scrollHeight - state.viewportHeight);
            // One line of slack: the assertion is "inside the scrollable range",
            // not a pixel-exact offset (cross-platform-parity.md).
            return state.scrollTop <= maxScrollTop + 20;
          },
          { timeout: 10000 },
        )
        .toBe(true);

      // monacoConfig's funnel only swallows the DiffEditor disposal error, so a
      // genuine internal throw would still surface here.
      expect(getPageErrors()).toHaveLength(0);
    } finally {
      // Leave the shared page as this test found it for any later spec run.
      await setCollapseUnchanged(page, false);
    }
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // The ASYMMETRIC counterpart to the DESKTOP-8 guard above, and like it a
  // guard rather than a reproduction. Read this before trusting it as coverage.
  //
  // Sentry DESKTOP-19 ("Illegal value for lineNumber", the recurrence that
  // survived the clamp) throws on the ORIGINAL editor, from a scrollTop Monaco
  // mirrors onto it rather than one any app code sets. Its stack resolves to
  // Monaco reading a viewport line past the original model's end while
  // `hideUnchangedRegions` rebuilds hidden areas - a window that exists because
  // ViewModel.setHiddenAreas shrinks the view-line projections several
  // statements before it updates the layout's line count.
  //
  // This test does NOT reproduce that throw, and it is not a coin flip away
  // from doing so. It was attempted and measured: on this fixture the original
  // viewport reaches model line 1500 against a line count of exactly 1500, the
  // boundary and never past it. Async content arrival, rapid file alternation,
  // CPU throttling at several rates, and a fixture large enough to force the
  // legacy diff algorithm's 2000ms budget were all tried; the only thing that
  // ever produced a throw was unrelated instrumentation slowing the main
  // thread, which is a flake and not a test.
  //
  // What it does pin is the app-side contract on the side that throws: after a
  // refold on a diff whose original side is half the length of its modified
  // side, the original editor's viewport still resolves inside its own model,
  // and no renderer error surfaces. The fixture is the durable part - delta.ts
  // cannot get near that boundary because both its sides are the same length.
  test('refolding an asymmetric diff leaves the original viewport inside its own model', async () => {
    test.slow();

    const getPageErrors = collectPageErrors(page);

    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=Diff Scroll Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const diffArea = page.locator('[data-testid="diff-editor-area"]');
    try {
      await diffArea.waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      await page.locator('[data-testid="changes-toggle"]').click();
      await diffArea.waitFor({ state: 'visible', timeout: 10000 });
    }
    await page.locator('.view-line').first().waitFor({ state: 'visible', timeout: 10000 });

    try {
      // Open gamma.ts and wait for its OWN diff, not just any diff: the reveal
      // that positions a first visit fires from onDidUpdateDiff, and scrolling
      // before it lands lets the reveal reset scrollTop afterwards (the flake
      // aae810ac and c604886e fixed on the test above).
      await page.locator('button', { hasText: 'gamma.ts' }).click();
      await page.locator('.view-line', { hasText: 'gammaAdded' }).first().waitFor({ state: 'visible', timeout: 10000 });
      await expect
        .poll(() => readModifiedFirstChangeLine(page), { timeout: 10000 })
        .toBe(GAMMA_CHANGE_LINE);

      // Drive deep, so the position committed under gamma's key is one the
      // folded layout cannot reach and the mirrored offset is large.
      await scrollModifiedToBottom(page);
      await expect(page.locator('.view-line', { hasText: GAMMA_TAIL_TOKEN }).first()).toBeVisible({ timeout: 10000 });
      await expect
        .poll(async () => (await readModifiedScrollState(page)).scrollTop, { timeout: 10000 })
        .toBeGreaterThan(1000);

      // Switch away so the deep position is committed, then turn collapse on
      // while gamma.ts is NOT the open file, so returning to it restores the
      // deep position and forces the refold in the same diff-update turn.
      await page.locator('button', { hasText: 'beta.ts' }).click();
      await expect(page.locator('.view-line', { hasText: 'const b = 2;' })).toBeVisible({ timeout: 10000 });

      await setCollapseUnchanged(page, true);
      await page.locator('button', { hasText: 'gamma.ts' }).click();
      await page.locator('.view-line', { hasText: 'gamma' }).first().waitFor({ state: 'visible', timeout: 10000 });

      // Wait for the fold to land, otherwise the assertions below run against
      // the still-expanded layout and prove nothing.
      await expect
        .poll(async () => page.locator('.diff-hidden-lines').count(), { timeout: 10000 })
        .toBeGreaterThan(0);

      // Wait for the original pane's viewport to actually resolve before
      // trusting maxVisibleLine: getVisibleRanges() can return an empty array
      // before layout catches up, and an empty array folds into
      // maxVisibleLine: 0 via the reduce's seed, which is trivially <=
      // lineCount for any positive line count. Capture the state that
      // satisfied the poll rather than re-reading afterward, so the
      // assertions below cannot land on a later, different snapshot.
      let originalState = await readOriginalViewportState(page);
      await expect
        .poll(
          async () => {
            originalState = await readOriginalViewportState(page);
            return originalState.visibleRangeCount;
          },
          { timeout: 10000 },
        )
        .toBeGreaterThan(0);

      expect(originalState.threw).toBe(false);
      expect(originalState.lineCount).toBeGreaterThan(0);
      expect(originalState.maxVisibleLine).toBeLessThanOrEqual(originalState.lineCount);

      // A throw on this path escapes a setTimeout to window.onerror and never
      // reaches monacoConfig's funnel, so it surfaces here as a page error.
      expect(getPageErrors()).toHaveLength(0);
    } finally {
      await setCollapseUnchanged(page, false);
    }
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
