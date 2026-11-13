/**
 * UI coverage for DiffViewer's `data-diff-state` on `[data-testid="diff-editor-area"]`.
 *
 * The web demo's Changes scenes report ready on `data-diff-state="laid-out"`, and the poster
 * gate depends on it meaning "the diff has landed and the unchanged-region fold, when on, is in
 * place". It is `pending` until then, goes back to `pending` at the start of a content swap, and
 * only reaches `laid-out` once the editor has a computed diff (`getLineChanges() !== null`).
 *
 * Each case runs with collapse-unchanged off and on, because the two take different branches in
 * applyCollapseFold (off marks at once, on marks after the fold's timeout or when already folded).
 *
 * Red checks: hard-coding the attribute to 'pending' fails every case; dropping the
 * markDiffLaidOut() call in the collapse-off branch fails the "off" cases only; dropping the
 * setDiffLaidOut(false) at the swap fails the swap case (no pending is recorded, or the state
 * reads laid-out while the old file's diff is still on screen).
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, readModifiedFirstChangeLine } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-diff-laid-out';
const TASK_ID = 'task-diff-laid-out';
const SESSION_ID = 'sess-diff-laid-out';
const TASK_TITLE = 'Diff Laid Out Task';

// Each file's first change sits on a line no other file uses, so the first change line names
// whose diff is on screen.
const FIRST_FILE = 'first.txt';
const FIRST_CHANGE_LINE = 20;
const SECOND_FILE = 'second.txt';
const SECOND_CHANGE_LINE = 45;
const FILE_LINES = 80;

function makePreConfig(collapseUnchanged: boolean): string {
  return `
  window.__mockPreConfigure(function (state) {
    var timestamp = new Date().toISOString();
    state.config.diffCollapseUnchanged = ${collapseUnchanged};
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Diff Laid Out Test', path: '/mock/diff-laid-out',
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
      status: 'running', shell: 'bash', cwd: '/mock/diff-laid-out', startedAt: timestamp, exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID}', title: '${TASK_TITLE}', description: 'Task for the diff laid-out state test',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/diff-laid-out', branch_name: 'feature/diff-laid-out',
      pr_number: null, pr_url: null, base_branch: 'main', archived_at: null, created_at: timestamp, updated_at: timestamp,
    });
    return { currentProjectId: '${PROJECT_ID}' };
  });
`;
}

const fixture = `
  (function () {
    function numberedLines(label, count) {
      var result = [];
      for (var lineNumber = 1; lineNumber <= count; lineNumber++) result.push('shared ' + label + ' line ' + lineNumber);
      return result;
    }
    function entry(name, label, changeLine) {
      var original = numberedLines(label, ${FILE_LINES});
      var modified = original.slice();
      modified[changeLine - 1] = label + ' line changed';
      return {
        path: name, status: 'M', insertions: 1, deletions: 1,
        original: original.join('\\n'), modified: modified.join('\\n'), language: 'plaintext',
      };
    }
    window.__mockGitDiff = {
      files: [
        entry('${FIRST_FILE}', 'first', ${FIRST_CHANGE_LINE}),
        entry('${SECOND_FILE}', 'second', ${SECOND_CHANGE_LINE}),
      ],
    };
  })();
`;

// Records every value the editor area's data-diff-state takes, with the first change line of the
// diff on screen at that moment, so a swap that never passed through pending, or that read
// laid-out against the previous file's diff, is visible after the fact.
const stateRecorder = `
  (function () {
    window.__diffStateLog = [];
    function firstChangeLine() {
      var monaco = window.__monaco;
      var editors = monaco ? monaco.editor.getDiffEditors() : [];
      if (editors.length === 0) return -1;
      var changes = editors[0].getLineChanges();
      return changes && changes[0] ? changes[0].modifiedStartLineNumber : -1;
    }
    function record(area) {
      var value = area.getAttribute('data-diff-state');
      var log = window.__diffStateLog;
      if (log.length === 0 || log[log.length - 1].state !== value) {
        log.push({ state: value, changeLine: firstChangeLine() });
      }
    }
    new MutationObserver(function () {
      var area = document.querySelector('[data-testid="diff-editor-area"]');
      if (area) record(area);
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-diff-state'] });
  })();
`;

interface StateLogEntry {
  state: string | null;
  changeLine: number;
}

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

async function launch(collapseUnchanged: boolean): Promise<void> {
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(makePreConfig(collapseUnchanged));
  await page.addInitScript(fixture);
  await page.addInitScript(stateRecorder);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  const diffArea = page.locator('[data-testid="diff-editor-area"]');
  try {
    await diffArea.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await page.locator('[data-testid="changes-toggle"]').click();
    await diffArea.waitFor({ state: 'visible', timeout: 10000 });
  }
}

async function readLog(): Promise<StateLogEntry[]> {
  return page.evaluate(() => (window as unknown as { __diffStateLog: StateLogEntry[] }).__diffStateLog.slice());
}

for (const collapseUnchanged of [false, true]) {
  const mode = collapseUnchanged ? 'collapse on' : 'collapse off';

  test.describe(`DiffViewer data-diff-state (${mode})`, () => {
    test('opening a Changes diff reaches laid-out for that file', async () => {
      await launch(collapseUnchanged);
      const area = page.locator('[data-testid="diff-editor-area"]');
      await expect(area).toHaveAttribute('data-diff-state', 'laid-out', { timeout: 15000 });
      expect(await readModifiedFirstChangeLine(page)).toBe(FIRST_CHANGE_LINE);
      if (collapseUnchanged) {
        // The fold is part of "laid out": the unchanged span must already be hidden.
        // Read at once, not polled: laid-out was already reached above.
        expect(await page.locator('.diff-hidden-lines').count()).toBeGreaterThan(0);
      }
    });

    test('switching files goes back to pending and reaches laid-out on the new file, never stale', async () => {
      await launch(collapseUnchanged);
      const area = page.locator('[data-testid="diff-editor-area"]');
      await expect(area).toHaveAttribute('data-diff-state', 'laid-out', { timeout: 15000 });
      const logLengthBeforeSwap = (await readLog()).length;

      await page.locator('button', { hasText: SECOND_FILE }).first().click();
      await expect(area).toHaveAttribute('data-diff-state', 'laid-out', { timeout: 15000 });
      // laid-out must describe the NEW file: its diff has landed, not the previous file's.
      expect(await readModifiedFirstChangeLine(page)).toBe(SECOND_CHANGE_LINE);

      const swapLog = (await readLog()).slice(logLengthBeforeSwap);
      expect(swapLog.map((entry) => entry.state), 'the swap must pass through pending').toContain('pending');
      const finalEntry = swapLog[swapLog.length - 1];
      expect(finalEntry.state).toBe('laid-out');
      // Every laid-out reading after the swap saw the new file's diff, or no diff at all.
      for (const entry of swapLog) {
        if (entry.state === 'laid-out') expect(entry.changeLine).toBe(SECOND_CHANGE_LINE);
      }
    });
  });
}
