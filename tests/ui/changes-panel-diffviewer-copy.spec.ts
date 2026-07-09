/**
 * UI tests for the DiffViewer copy / select-all behavior added to fix the
 * Changes panel's Monaco diff viewer copy and context-menu handling
 * (src/renderer/components/dialogs/task-detail/changes/DiffViewer.tsx).
 *
 * Two independent paths are covered:
 *
 *  1. The `changes.copy` keybinding (Mod+C), which calls copyDiffSelection()
 *     directly when a diff sub-editor holds text focus. Scoped via a `when`
 *     predicate so it never hijacks Ctrl+C elsewhere in the dialog.
 *
 *  2. The `window.addEventListener('diff-copy' | 'diff-select-all', ...)`
 *     handlers that the main process's native context menu drives (see
 *     showTerminalAwareContextMenu in src/main/index.ts). These resolve which
 *     DiffViewer instance and which Monaco sub-editor (original vs modified) a
 *     click point falls in, purely from the CustomEvent's `{ x, y }` detail -
 *     there is no real Electron context menu in this headless-Chromium tier,
 *     so the CustomEvent is dispatched directly, exactly mirroring what the
 *     main process would send.
 *
 * A real @monaco-editor/react DiffEditor is mounted (via the __mockGitDiff
 * hook), so selections are read and written through the actual monaco API
 * (window.__monaco, a dev-only debug handle - see monacoConfig.ts), not
 * simulated. Clipboard writes are asserted via the mock's
 * window.electronAPI.clipboard.__writeTextCalls log (same pattern as
 * tests/ui/terminal-osc52-copy.spec.ts).
 *
 * The `showTerminalAwareContextMenu` main-process wiring itself (which
 * CustomEvent name fires for which click target) is not covered here - it is
 * plain Electron.Menu template construction with no branch of its own logic
 * worth a heavy Menu/webContents mock; see the test-builder report for that
 * call.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-diffviewer-copy-${RUN_ID}`;
const TASK_ID = `task-diffviewer-copy-${RUN_ID}`;
const SESSION_ID = `sess-diffviewer-copy-${RUN_ID}`;
const TASK_TITLE = `DiffViewer Copy Test ${RUN_ID}`;

// Distinct original vs modified line 2 content so a test can prove WHICH pane
// a click point resolved to, rather than merely that "some" text was copied.
const ORIGINAL_LINE_2 = 'second original line';
const MODIFIED_LINE_2 = 'SECOND MODIFIED LINE';
const DIFF_FIXTURE = {
  files: [
    {
      path: 'src/copy-test-file.ts',
      status: 'M',
      insertions: 1,
      deletions: 1,
      binary: false,
      original: `first original line\n${ORIGINAL_LINE_2}\nthird original line\n`,
      modified: `first original line\n${MODIFIED_LINE_2}\nthird original line\n`,
      language: 'typescript',
    },
  ],
};

interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
interface MonacoModelHandle {
  getFullModelRange(): MonacoRangeLike;
  getLineMaxColumn(lineNumber: number): number;
}
interface MonacoSubEditorHandle {
  getDomNode(): HTMLElement | null;
  hasTextFocus(): boolean;
  focus(): void;
  setSelection(range: MonacoRangeLike): void;
  getSelection(): MonacoRangeLike | null;
  getModel(): MonacoModelHandle | null;
}
interface MonacoDiffEditorHandle {
  getOriginalEditor(): MonacoSubEditorHandle;
  getModifiedEditor(): MonacoSubEditorHandle;
}
type MonacoTestWindow = Window & {
  __monaco?: { editor: { getDiffEditors(): MonacoDiffEditorHandle[] } };
  electronAPI: { clipboard: { __writeTextCalls: string[]; writeText: (text: string) => Promise<void> } };
};

async function launchWithDiffTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockGitDiff = ${JSON.stringify(DIFF_FIXTURE)};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'DiffViewer Copy Test ${RUN_ID}',
        path: '/mock/diffviewer-copy-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-copy-' + s.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // Running session so TaskDetailBody renders the live body (with the
      // Changes pill) rather than the edit form.
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 8888,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/diffviewer-copy-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: '${TASK_TITLE}',
        description: 'Task used to exercise DiffViewer copy / select-all',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/worktrees/diffviewer-copy',
        branch_name: 'feature/diffviewer-copy',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/** Open the task dialog and the Changes panel, and wait for the real Monaco
 *  DiffEditor to finish mounting (a single diff editor registered with
 *  monaco's global editor registry). */
async function openDiffTask(page: Page): Promise<void> {
  const card = page
    .locator('[data-swimlane-name="Code Review"]')
    .locator(`text=${TASK_TITLE}`)
    .first();
  await card.click();

  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  const changesPill = page.locator('[data-testid="changes-toggle"]');
  await expect(changesPill).toBeVisible();
  await changesPill.click();

  await page.locator('[data-testid="diff-editor-area"]').waitFor({ state: 'visible', timeout: 8000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
          return monacoHandle ? monacoHandle.editor.getDiffEditors().length : 0;
        }),
      { timeout: 8000 },
    )
    .toBe(1);
}

/** Close the Changes panel and the task dialog, mirroring the teardown used by
 *  the sibling DiffViewer toolbar spec, so the next test starts from a clean,
 *  fully-unmounted DiffEditor. */
async function closeDiffTask(page: Page): Promise<void> {
  const changesPill = page.locator('[data-testid="changes-toggle"]');
  await changesPill.click();
  await page.keyboard.press('Control+Shift+W');
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 8000 });
}

/** Read a point at the center of a sub-editor's real DOM node, computed inside
 *  the page (no locator-index assumption about original-vs-modified DOM
 *  order). */
async function centerOf(page: Page, pane: 'original' | 'modified'): Promise<{ x: number; y: number }> {
  return page.evaluate((which) => {
    const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
    if (!monacoHandle) throw new Error('monaco debug handle not present');
    const diffEditor = monacoHandle.editor.getDiffEditors()[0];
    const editor = which === 'original' ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
    const node = editor.getDomNode();
    if (!node) throw new Error(`${which} editor has no DOM node`);
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, pane);
}

/** Select line 2 (the only differing line in the fixture) in full, on BOTH
 *  sub-editors, so a test can prove which pane a click point resolved to by
 *  which pane's line-2 text ends up in the clipboard. */
async function selectLine2OnBothPanes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
    const diffEditor = monacoHandle!.editor.getDiffEditors()[0];
    for (const editor of [diffEditor.getOriginalEditor(), diffEditor.getModifiedEditor()]) {
      const model = editor.getModel()!;
      editor.setSelection({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: model.getLineMaxColumn(2) });
    }
  });
}

test.describe('DiffViewer copy and select-all', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithDiffTask());
  });

  test.afterAll(async () => {
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockGitDiff = null;
    });
    await browser?.close();
  });

  test('Ctrl+C copies the selection from whichever sub-editor holds text focus', async () => {
    await openDiffTask(page);

    await page.evaluate(() => {
      const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
      const diffEditor = monacoHandle!.editor.getDiffEditors()[0];
      const modifiedEditor = diffEditor.getModifiedEditor();
      const model = modifiedEditor.getModel()!;
      modifiedEditor.setSelection({
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: model.getLineMaxColumn(2),
      });
      modifiedEditor.focus();
    });

    await expect
      .poll(() => page.evaluate(() => {
        const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
        return monacoHandle!.editor.getDiffEditors()[0].getModifiedEditor().hasTextFocus();
      }))
      .toBe(true);

    await page.evaluate(() => {
      (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.length = 0;
    });

    await page.keyboard.press('Control+c');

    await expect
      .poll(() => page.evaluate(() => (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.length))
      .toBeGreaterThan(0);
    const calls = await page.evaluate(() => (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls);
    expect(calls).toContain(MODIFIED_LINE_2);

    await closeDiffTask(page);
  });

  test('Ctrl+C does nothing when no diff sub-editor holds text focus (does not hijack Ctrl+C elsewhere)', async () => {
    await openDiffTask(page);

    // A selection MUST exist (on the modified pane) without focus, so this
    // proves the "when" focus gate itself blocks the fire - not merely that
    // there was nothing to copy. getDiffSelectionText's no-preferredEditor
    // fallback returns a non-focused pane's selection when NEITHER pane has
    // focus, so if the gate were dropped, this selection would still reach
    // the clipboard.
    await selectLine2OnBothPanes(page);

    // Blur whatever currently holds focus (a fresh dialog open, plus never
    // having called .focus() on either editor above, already leaves nothing
    // focused inside either sub-editor) without clicking any interactive
    // control, so this test does not rely on a specific unrelated element
    // being safely clickable.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await expect
      .poll(() => page.evaluate(() => {
        const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
        const diffEditor = monacoHandle!.editor.getDiffEditors()[0];
        return diffEditor.getOriginalEditor().hasTextFocus() || diffEditor.getModifiedEditor().hasTextFocus();
      }))
      .toBe(false);

    await page.evaluate(() => {
      (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.length = 0;
    });

    await page.keyboard.press('Control+c');

    // Intentional fixed wait - cannot poll for non-occurrence (test-builder
    // anti-pattern 6). Mod+C's handler runs synchronously on keydown, so this
    // budget is far more than enough for either the "when" gate to reject it
    // or copyDiffSelection to have already pushed onto the mock's call log.
    await page.waitForTimeout(500);

    const count = await page.evaluate(() => (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.length);
    expect(count).toBe(0);

    await closeDiffTask(page);
  });

  test('a diff-copy event resolves the ORIGINAL pane by click point, not the modified pane', async () => {
    await openDiffTask(page);

    // Distinct selections on both panes (line 2 in each, the ONLY differing
    // line between original and modified in this fixture).
    await selectLine2OnBothPanes(page);

    await page.evaluate(() => {
      (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.length = 0;
    });

    const point = await centerOf(page, 'original');
    const calls = await page.evaluate(({ x, y }) => {
      window.dispatchEvent(new CustomEvent('diff-copy', { detail: { x, y } }));
      return (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.slice();
    }, point);

    expect(calls).toEqual([ORIGINAL_LINE_2]);

    await closeDiffTask(page);
  });

  test('a diff-copy event resolves the MODIFIED pane by click point', async () => {
    await openDiffTask(page);

    await selectLine2OnBothPanes(page);

    await page.evaluate(() => {
      (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.length = 0;
    });

    const point = await centerOf(page, 'modified');
    const calls = await page.evaluate(({ x, y }) => {
      window.dispatchEvent(new CustomEvent('diff-copy', { detail: { x, y } }));
      return (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.slice();
    }, point);

    expect(calls).toEqual([MODIFIED_LINE_2]);

    await closeDiffTask(page);
  });

  test('a diff-select-all event focuses and selects the full range of the resolved (original) pane', async () => {
    await openDiffTask(page);

    const point = await centerOf(page, 'original');
    const result = await page.evaluate(({ x, y }) => {
      window.dispatchEvent(new CustomEvent('diff-select-all', { detail: { x, y } }));
      const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
      const diffEditor = monacoHandle!.editor.getDiffEditors()[0];
      const originalEditor = diffEditor.getOriginalEditor();
      const modifiedEditor = diffEditor.getModifiedEditor();
      // getSelection() returns a Selection (extends Range with cursor/anchor
      // fields); narrow to the plain Range shape so this compares only what
      // setSelection(model.getFullModelRange()) actually guarantees.
      const selection = originalEditor.getSelection();
      const fullRange = originalEditor.getModel()!.getFullModelRange();
      return {
        originalFocused: originalEditor.hasTextFocus(),
        modifiedFocused: modifiedEditor.hasTextFocus(),
        selectionRange: selection && {
          startLineNumber: selection.startLineNumber,
          startColumn: selection.startColumn,
          endLineNumber: selection.endLineNumber,
          endColumn: selection.endColumn,
        },
        fullRange,
      };
    }, point);

    expect(result.originalFocused).toBe(true);
    expect(result.modifiedFocused).toBe(false);
    expect(result.selectionRange).toEqual(result.fullRange);

    await closeDiffTask(page);
  });

  test('diff-copy and diff-select-all are ignored when the click point falls outside this DiffViewer instance', async () => {
    await openDiffTask(page);

    const editorArea = page.locator('[data-testid="diff-editor-area"]');
    const areaBox = await editorArea.boundingBox();
    if (!areaBox) throw new Error('diff-editor-area has no bounding box');
    // A point above the editor area (in the toolbar row that sits directly
    // above it in the same DiffViewer flex column) - real geometry, not a
    // pixel-exact assumption, and clearly outside editorContainerRef's rect.
    const outsidePoint = { x: areaBox.x + 10, y: Math.max(0, areaBox.y - 30) };

    await page.evaluate(() => {
      const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
      const diffEditor = monacoHandle!.editor.getDiffEditors()[0];
      diffEditor.getOriginalEditor().setSelection({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 3 });
    });
    await page.evaluate(() => {
      (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.length = 0;
    });

    const before = await page.evaluate(() => {
      const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
      return monacoHandle!.editor.getDiffEditors()[0].getOriginalEditor().getSelection();
    });

    const result = await page.evaluate(({ x, y }) => {
      window.dispatchEvent(new CustomEvent('diff-copy', { detail: { x, y } }));
      window.dispatchEvent(new CustomEvent('diff-select-all', { detail: { x, y } }));
      const monacoHandle = (window as unknown as MonacoTestWindow).__monaco;
      const diffEditor = monacoHandle!.editor.getDiffEditors()[0];
      return {
        writeTextCalls: (window as unknown as MonacoTestWindow).electronAPI.clipboard.__writeTextCalls.slice(),
        selectionAfter: diffEditor.getOriginalEditor().getSelection(),
      };
    }, outsidePoint);

    expect(result.writeTextCalls).toEqual([]);
    expect(result.selectionAfter).toEqual(before);

    await closeDiffTask(page);
  });
});
