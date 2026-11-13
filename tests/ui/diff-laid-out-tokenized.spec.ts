/**
 * UI coverage for what DiffViewer's `laid-out` stamp promises on a TOKENIZED file, which
 * diff-laid-out-state.spec.ts (plaintext fixture) never runs: markDiffLaidOut force-tokenizes
 * both sides through monaco's private `tokenization.forceTokenization`, rebuilds the deleted-line
 * blocks with an empty view-zone toggle, then re-applies the file's first position
 * (appliedRevealRef) unless the user scrolled, clicked, typed or navigated to a change first.
 *
 * Hole A: a TypeScript diff that deletes lines reaches laid-out with the deleted lines drawn in
 * token colours (monaco's `mtkN` classes, `mtk1` is the default text colour). This is what breaks
 * when a monaco bump moves the private tokenization fields (readModelTokenization then returns
 * null and the deleted block paints plain) or when the view-zone toggle stops rebuilding it.
 *
 * Hole B: the first position holds across the stamp (the same scrollTop at laid-out, a frame
 * later and on a reopen), and a user wheel or a next/prev-change press that lands after the
 * file's diff arrives but BEFORE laid-out is not put back over by the re-apply.
 *
 * The interleave is driven with no production change: the page subscribes to the live diff
 * editor's onDidUpdateDiff AFTER the first file settled, so on the file switch that listener runs
 * after DiffViewer's own (which already armed the re-apply and queued the settle's setTimeout 0)
 * and before the settle's timeout and frame fire. The input it issues is therefore between "file
 * opened" and "laid-out" every run.
 *
 * Red checks (each run once, then restored): removing `reveal?.apply()` fails the "put back"
 * case; emptying dropAppliedReveal fails the wheel case; removing
 * `appliedRevealRef.current = null` in revealChangeLine fails the previous-change case.
 * The token-colour case did NOT go red with readModelTokenization returning null, nor with the
 * view-zone toggle removed as well, nor with a 900-line file: monaco's Monarch TypeScript
 * tokenizer is synchronous in this headless run, so the deleted block is coloured at the stamp
 * either way. It guards the end state (and a monaco bump that stops drawing coloured deleted
 * lines), not the up-front timing, which needs a tokenizer that loads late.
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-diff-tokenized';
const TASK_ID = 'task-diff-tokenized';
const SESSION_ID = 'sess-diff-tokenized';
const TASK_TITLE = 'Diff Tokenized Task';

const FIRST_FILE = 'first.ts';
const SECOND_FILE = 'second.ts';
const FILE_LINES = 120;

function preConfig(): string {
  return `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.config.diffCollapseUnchanged = false;
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Diff Tokenized Test', path: '/mock/diff-tokenized',
      github_url: null, default_agent: 'claude', last_opened: timestamp, created_at: timestamp,
    });
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
      var id = 'lane-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[swimlane.name] = id;
      state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: timestamp }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999,
      status: 'running', shell: 'bash', cwd: '/mock/diff-tokenized', startedAt: timestamp, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: '${TASK_TITLE}', description: 'Task for the tokenized diff tests',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/diff-tokenized', branch_name: 'feature/diff-tokenized',
      pr_number: null, pr_url: null, base_branch: 'main', archived_at: null, created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;
}

// first.ts deletes five lines starting at line 50. second.ts changes line 50 and line 110, so
// its first position (line 50 centred) and its last change (line 110) rest at different scroll
// offsets, and a deletion-free file keeps the two cases independent.
const fixture = `
  (function () {
    function source(prefix) {
      var lines = [];
      for (var lineNumber = 1; lineNumber <= ${FILE_LINES};lineNumber++) {
        lines.push('export const ' + prefix + lineNumber + ': number = ' + lineNumber + ';');
      }
      return lines;
    }
    var firstOriginal = source('alpha');
    var firstModified = firstOriginal.slice();
    firstModified.splice(49, 5);    var secondOriginal = source('beta');
    var secondModified = secondOriginal.slice();
    secondModified[49] = 'export const betaChangedFirst: string = "first";';
    secondModified[109] = 'export const betaChangedLast: string = "last";';
    window.__mockGitDiff = {
      files: [
        { path: '${FIRST_FILE}', status: 'M', insertions: 0, deletions: 5, original: firstOriginal.join('\\n'), modified: firstModified.join('\\n'), language: 'typescript' },
        { path: '${SECOND_FILE}', status: 'M', insertions: 2, deletions: 2, original: secondOriginal.join('\\n'), modified: secondModified.join('\\n'), language: 'typescript' },
      ],
    };
  })();
`;

// Snapshots the deleted lines' token classes in the same task the stamp turns laid-out (a
// MutationObserver callback runs in the microtask right after the attribute write), so a stamp
// that beats the colours is seen even when monaco paints them a moment later.
const stampSnapshot = `
  (function () {
    window.__stampSnapshot = null;
    new MutationObserver(function () {
      var area = document.querySelector('[data-testid="diff-editor-area"]');
      if (!area || area.getAttribute('data-diff-state') !== 'laid-out' || window.__stampSnapshot) return;
      var spans = document.querySelectorAll('.monaco-diff-editor .view-lines.line-delete .view-line span[class*="mtk"]');
      var classNames = [];
      spans.forEach(function (span) { classNames.push(span.className); });
      window.__stampSnapshot = classNames;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-diff-state'] });
  })();
`;

let browser: Browser;
let context: BrowserContext;
let page: Page;

test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  await browser?.close();
});

test.afterEach(async () => {
  await context?.close();
});

test.describe.configure({ timeout: 45_000 });

async function openChanges(): Promise<void> {
  const diffArea = page.locator('[data-testid="diff-editor-area"]');
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  try {
    await diffArea.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await page.locator('[data-testid="changes-toggle"]').click();
    await diffArea.waitFor({ state: 'visible', timeout: 10000 });
  }
}

async function launch(): Promise<void> {
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  await page.addInitScript(fixture);
  await page.addInitScript(stampSnapshot);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
  await openChanges();
}

async function waitForLaidOut(): Promise<void> {
  await expect(page.locator('[data-testid="diff-editor-area"]')).toHaveAttribute('data-diff-state', 'laid-out', { timeout: 15000 });
}

async function modifiedScrollTop(): Promise<number> {
  return page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: { editor: { getDiffEditors(): Array<{ getModifiedEditor(): { getScrollTop(): number } }> } } }).__monaco;
    return monaco?.editor.getDiffEditors()[0]?.getModifiedEditor().getScrollTop() ?? -1;
  });
}

/**
 * Runs `action` once, synchronously inside the live diff editor's next onDidUpdateDiff, which on
 * a file switch is after DiffViewer's own handler and before its settle's timeout and frame.
 * Resolves the action's name onto `window.__interleaved` so the test can prove it ran.
 */
async function armInterleave(action: 'drift' | 'wheel' | 'previous-change'): Promise<void> {
  await page.evaluate((actionName) => {
    const pageWindow = window as unknown as {
      __monaco: { editor: { getDiffEditors(): Array<{ onDidUpdateDiff(listener: () => void): { dispose(): void }; getContainerDomNode(): HTMLElement; getLineChanges(): unknown[] | null; getModifiedEditor(): { setScrollTop(top: number): void; getModel(): { getValue(): string } | null } }> } };
      __interleaved?: string;
    };
    const diffEditor = pageWindow.__monaco.editor.getDiffEditors()[0];
    const subscription = diffEditor.onDidUpdateDiff(() => {
      // Only the update that carries the SECOND file's diff: an earlier one (the detached swap)
      // runs before the first position is armed, and an input then would prove nothing.
      const modifiedText = diffEditor.getModifiedEditor().getModel()?.getValue() ?? '';
      const changes = diffEditor.getLineChanges();
      if (!modifiedText.includes('betaChangedFirst') || changes === null || changes.length === 0) return;
      subscription.dispose();
      if (actionName === 'drift') {
        // Layout moving the position with no user input (what a late deleted-line block does).
        diffEditor.getModifiedEditor().setScrollTop(7);
      } else if (actionName === 'wheel') {
        diffEditor.getContainerDomNode().dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
        diffEditor.getModifiedEditor().setScrollTop(7);
      } else {
        (document.querySelector('[data-testid="diff-prev-change"]') as HTMLElement).click();
      }
      pageWindow.__interleaved = actionName;
    });
  }, action);
}

test.describe('DiffViewer laid-out on a tokenized file', () => {
  test('a deleted line is drawn in token colours by the time it is laid out', async () => {
    await launch();
    await waitForLaidOut();
    // Laid-out is the promise that the deleted block is already coloured, so read what the page
    // saw in the very task the stamp landed, not what it looks like a poll later.
    const classNames = await page.evaluate(() => (window as unknown as { __stampSnapshot: string[] | null }).__stampSnapshot);
    expect(classNames, 'the stamp was observed').not.toBeNull();
    expect((classNames as string[]).length, 'the deleted block is drawn at the stamp').toBeGreaterThan(0);
    const coloured = (classNames as string[]).filter((className) => /\bmtk(?!1\b)\d+\b/.test(className));
    expect(coloured.length, `deleted-line token classes at the stamp: ${(classNames as string[]).slice(0, 6).join(' | ')}`).toBeGreaterThan(0);
  });

  test('the first position rests: the same at laid-out, a frame later and on a reopen', async () => {
    await launch();
    await waitForLaidOut();
    const atLaidOut = await modifiedScrollTop();
    expect(atLaidOut, 'the first change is below the first screen, so the position is not the top').toBeGreaterThan(100);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await modifiedScrollTop()).toBe(atLaidOut);

    // Close the task window (document-level Escape: a focused xterm would swallow the key), reopen.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 5000 });
    await openChanges();
    await waitForLaidOut();
    expect(Math.abs((await modifiedScrollTop()) - atLaidOut)).toBeLessThanOrEqual(1);
  });

  test('a position knocked off by layout before laid-out is put back with no user input', async () => {
    await launch();
    await waitForLaidOut();
    await armInterleave('drift');
    await page.locator('button', { hasText: SECOND_FILE }).first().click();
    await waitForLaidOut();
    expect(await page.evaluate(() => (window as unknown as { __interleaved?: string }).__interleaved), 'the drift landed before the stamp').toBe('drift');
    // Line 50 centred is hundreds of pixels down; only the re-apply gets it from 7 back there.
    expect(await modifiedScrollTop()).toBeGreaterThan(100);
  });

  test('a wheel in the editor before laid-out is not overridden by the first position', async () => {
    await launch();
    await waitForLaidOut();
    await armInterleave('wheel');
    await page.locator('button', { hasText: SECOND_FILE }).first().click();
    await waitForLaidOut();
    expect(await page.evaluate(() => (window as unknown as { __interleaved?: string }).__interleaved), 'the wheel landed before the stamp').toBe('wheel');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Without the drop the re-apply puts line 50 back in the centre (hundreds of pixels down).
    expect(await modifiedScrollTop()).toBe(7);
  });

  test('a previous-change press before laid-out is not overridden by the first position', async () => {
    await launch();
    await waitForLaidOut();
    await armInterleave('previous-change');
    await page.locator('button', { hasText: SECOND_FILE }).first().click();
    await waitForLaidOut();
    expect(await page.evaluate(() => (window as unknown as { __interleaved?: string }).__interleaved), 'the press landed before the stamp').toBe('previous-change');
    // The press goes to the LAST change (line 110), well below the first position (line 50). The
    // smooth scroll finishes on its own, so poll for it; a re-apply of the first position would
    // cancel it and rest near line 50.
    const lineHeight = 18;
    await expect.poll(modifiedScrollTop, { timeout: 5000 }).toBeGreaterThan(80 * lineHeight);
  });
});
