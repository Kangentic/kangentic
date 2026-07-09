/**
 * E2E regression guard: terminal input/focus disconnect at a fullscreen-TUI
 * select prompt across a scrollback replay.
 *
 * Reported live on task #290 (2026-07-08): at an interactive select prompt
 * (AskUserQuestion / plan approval) in Claude's default fullscreen (alt-screen)
 * TUI renderer, arrow keys and Enter appeared to do nothing. Clicking the
 * terminal instantly unfroze it, proving keys were never reaching the PTY
 * (the xterm textarea had lost DOM focus) rather than the display being
 * frozen. A second symptom - the real xterm cursor parked bottom-right,
 * disconnected from the TUI frame - showed the replay had painted into
 * xterm's NORMAL buffer instead of the alt buffer.
 *
 * Root cause (two coupled defects):
 *   1. A stale/overlapping scrollback replay's afterWrite callback could
 *      clobber a newer replay's pending flag before the newer one's own
 *      focus() ever ran (no generation guard inside afterWrite itself).
 *   2. getScrollback() re-asserted DEC private INPUT modes (#313) but never
 *      alt-screen (1049), so a fullscreen session's replay always landed in
 *      the normal buffer.
 *
 * `tests/fixtures/mock-claude.js` normally emits plain marker lines with no
 * terminal escape sequences at all, so it cannot reproduce a bug that only
 * exists in the alt-screen replay path. Setting MOCK_CLAUDE_FULLSCREEN_SELECT=1
 * switches it to a small interactive select-prompt harness: it enters the alt
 * screen buffer, turns on DECCKM, draws a 3-option menu, and moves the
 * highlight via a cursor-addressed, synchronized-output DIFF on arrow input --
 * never a full repaint - so a lost keystroke or a misplaced replay is
 * directly observable in the scrollback (the highlighted-option marker for
 * the NEXT option only ever appears if the keystroke actually reached the PTY).
 *
 * This spec drives real, focused Playwright keyboard events into the xterm
 * DOM (not a `sessions.write` IPC bypass), because the bug is specifically
 * about whether DOM focus lands - an IPC-direct write would pass regardless
 * of whether the fix is present.
 *
 * Manual ground-truth reproduction against the real Claude CLI:
 *   1. Launch Kangentic dev build. Start a task, park it at any interactive
 *      select prompt (AskUserQuestion, plan approval).
 *   2. Open/close the task-detail dialog (or resize the panel) to force a
 *      scrollback replay.
 *   3. Confirm arrow keys move the highlight and Enter selects, without
 *      needing to click the terminal first.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
  mockAgentPath,
  getTaskIdByTitle,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'terminal-fullscreen-select-replay-focus';
const runId = Date.now();
const PROJECT_NAME = `Fullscreen Select ${runId}`;

// Text mock-claude.js's fullscreen-select harness writes for the
// currently-highlighted option (a "> " marker; unhighlighted rows get "  ").
// Matched as plain text, not the surrounding SGR reverse-video codes: a real
// PTY (Windows ConPTY in particular) can re-serialize style sequences it
// relays (observed \x1b[27m in place of the \x1b[0m the mock wrote), so
// asserting on exact escape bytes is fragile. The marker text itself is
// unique per option, so its appearance in scrollback still unambiguously
// proves the corresponding arrow key reached the PTY and moved the highlight.
const HIGHLIGHT_FIRST = '> First option';
const HIGHLIGHT_SECOND = '> Second option';
const HIGHLIGHT_THIRD = '> Third option';

function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockAgentPath('claude'),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );
}

async function getSwimlaneByName(page: Page, name: string): Promise<string> {
  const swimlaneId = await page.evaluate(async (laneName) => {
    const swimlanes: Array<{ id: string; name: string }> =
      await window.electronAPI.swimlanes.list();
    return swimlanes.find((swimlane) => swimlane.name === laneName)?.id ?? null;
  }, name);
  if (!swimlaneId) throw new Error(`Swimlane "${name}" not found`);
  return swimlaneId;
}

/** Current raw scrollback for this task's session (any status - the mock
 *  exits on Enter, so the session may already be 'exited' by the last read). */
async function scrollbackForTask(page: Page, taskId: string): Promise<string> {
  return page.evaluate(async (tid) => {
    const sessions: Array<{ id: string; taskId: string }> = await window.electronAPI.sessions.list();
    const session = sessions.find((sessionEntry) => sessionEntry.taskId === tid);
    if (!session) return '';
    return window.electronAPI.sessions.getScrollback(session.id);
  }, taskId);
}

async function openTaskWindow(page: Page, taskTitle: string): Promise<void> {
  const card = page.locator(`text=${taskTitle}`).first();
  await card.click();
  await page
    .locator('[data-testid="task-detail-dialog"]')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
}

/** Dispatch Escape directly on `document` to close the dialog, bypassing
 *  xterm's own key capture (xterm intercepts Escape as an ANSI sequence when
 *  its textarea has focus, so page.keyboard.press('Escape') would not reach
 *  the dialog's listener). */
async function closeTaskWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page
    .locator('[data-testid="task-detail-dialog"]')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 });
}

test.describe('Fullscreen TUI select prompt - input/focus survives a scrollback replay', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);

    const result = await launchApp({
      dataDir,
      extraEnv: { MOCK_CLAUDE_FULLSCREEN_SELECT: '1' },
    });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('arrow-key navigation reaches the PTY and tracks the highlight, including immediately after a dialog reattach with no manual re-focus', async () => {
    // Session spawn + two replay cycles + several polls comfortably exceeds
    // the 30s Electron default.
    test.slow();

    const taskTitle = `Fullscreen Select ${runId}`;
    await createTask(page, taskTitle, 'Fullscreen select-prompt input/focus regression guard');

    const executingId = await getSwimlaneByName(page, 'Executing');
    const taskId = await getTaskIdByTitle(page, taskTitle);
    await moveTaskIpc(page, taskId, executingId);

    // Wait for the mock's initial fullscreen frame: option 0 highlighted.
    await expect
      .poll(() => scrollbackForTask(page, taskId), {
        timeout: 15000,
        message: 'Expected the fullscreen select prompt to render with option 1 highlighted',
      })
      .toContain(HIGHLIGHT_FIRST);

    // Open the task-detail window and focus its terminal with a real click on
    // the OUTER xterm container, mirroring an actual user click. xterm's own
    // mousedown handler then focuses its hidden helper textarea. Clicking the
    // textarea directly is not viable here: xterm deliberately renders it
    // near-invisible (it exists only to capture keystrokes), so Playwright's
    // actionability check ("element is not visible") can time out on it,
    // particularly under CI's headless Linux/xvfb renderer.
    await openTaskWindow(page, taskTitle);
    const dialog = page.locator('[data-testid="task-detail-dialog"]').first();
    await dialog.locator('.xterm').first().click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? null), {
        timeout: 5000,
        message: 'Expected the click to focus the xterm textarea',
      })
      .toContain('xterm-helper-textarea');

    // First arrow-down: highlight moves option 1 -> 2. A real, focused
    // keyboard event through xterm's own key handler - the exact path the
    // bug broke.
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => scrollbackForTask(page, taskId), {
        timeout: 10000,
        message: 'Expected the highlight to advance to option 2 after the first ArrowDown',
      })
      .toContain(HIGHLIGHT_SECOND);

    // Close and reopen the task-detail window. TerminalTab is keyed by
    // sessionId, so this remounts it and re-runs the scrollback replay path
    // (initTerminal) this fix hardens - the exact trigger from the reported
    // freeze (task #290): a dialog open/close.
    await closeTaskWindow(page);
    await openTaskWindow(page, taskTitle);

    // The freshly re-fetched scrollback must lead with the alt-screen
    // re-assert, so the replay paints into the alt buffer, not the normal
    // buffer (the secondary defect: the cursor left disconnected from the
    // TUI frame).
    const freshScrollback = await scrollbackForTask(page, taskId);
    expect(freshScrollback.startsWith('\x1b[?1049h')).toBe(true);

    // Second arrow-down WITHOUT an explicit click: proves focus landed
    // automatically after the replay (the primary defect - previously, keys
    // only reached the PTY again after a manual click to re-focus the
    // terminal).
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => scrollbackForTask(page, taskId), {
        timeout: 10000,
        message: 'Expected the highlight to advance to option 3 after a post-replay ArrowDown with no manual re-focus',
      })
      .toContain(HIGHLIGHT_THIRD);

    // Enter still reaches the PTY and completes the prompt at the final option.
    await page.keyboard.press('Enter');
    await expect
      .poll(() => scrollbackForTask(page, taskId), {
        timeout: 10000,
        message: 'Expected Enter to select the currently-highlighted option (index 2)',
      })
      .toContain('MOCK_CLAUDE_SELECTED:2');
  });
});
