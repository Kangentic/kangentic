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

/**
 * True once the main process has LATCHED first output for this task's
 * session: `FirstOutputTracker.consume()` has succeeded and `'first-output'`
 * has been emitted (session-manager.ts). Read via `SESSION_GET_FIRST_OUTPUT`
 * (`sessionManager.getFirstOutputCache()`, a plain snapshot of the tracker's
 * emitted-session set) - deliberately NOT via `scrollbackForTask()` /
 * `getScrollback()`.
 *
 * That distinction is load-bearing, not stylistic - it is the actual fix for
 * a CI-only flake (33.6s timeout on the launch-overlay wait below, then a
 * 1.9s pass on retry: a missed edge, not slowness). PtyBufferManager batches
 * raw PTY output behind a fixed 16ms flush timer, and only INSIDE that flush
 * does session-manager.ts feed the chunk to `firstOutputTracker.consume()`
 * and emit `'first-output'`. `getScrollback()` drains the session's pending
 * (not-yet-flushed) buffer as a side effect - `state.buffer = ''` in
 * `PtyBufferManager.getScrollback`, pinned by the "getScrollback drains
 * pending buffer" case in tests/unit/pty-buffer-manager.test.ts. A
 * `getScrollback()` call that lands inside that 16ms window makes the flush
 * timer find an empty buffer and skip its callback entirely
 * (`if (!current.buffer) return;` in pty-buffer-manager.ts) - so first-output
 * detection silently never sees the bytes that would have latched it.
 *
 * mock-claude's fullscreen-select harness writes its ENTIRE frame (including
 * the `\x1b[?25l` first-output trigger) in one `stdout.write()` and then
 * parks on stdin, so this is a one-shot, all-or-nothing race per spawn: lose
 * it and the session NEVER latches first output (`consume()` short-circuits
 * once emitted, so there is no second chance), and the renderer's
 * LaunchOverlay - gated on `terminalReady`, which flips only via this same
 * latch or a `hasUsage` / session-`exited` fallback, neither of which this
 * mock ever produces - stays up forever (see TerminalTab.tsx). This raced
 * not just a test-added scrollback poll, but ALSO TerminalTab's own
 * mount-time `getScrollback()` call (`useTerminal.ts`'s `initTerminal`),
 * which is why previously raising the poll timeout below (15000 -> 30000)
 * only made the flake rarer, not gone, and it recurred on CI.
 *
 * Polling this instead of scrollback content is structurally race-free: this
 * read never touches the PTY buffer, so it can never be the call that starves
 * the latch, and once it observes `true` the latch can never un-latch
 * (`consume()` short-circuits on every later chunk). ORDERING IS LOAD-BEARING:
 * do not call `getScrollback()` for this session - directly, or indirectly by
 * mounting/reloading a terminal - before this resolves `true`, or the race
 * this closes comes back.
 */
async function hasFirstOutputForTask(page: Page, taskId: string): Promise<boolean> {
  return page.evaluate(async (tid) => {
    const sessions: Array<{ id: string; taskId: string }> = await window.electronAPI.sessions.list();
    const session = sessions.find((sessionEntry) => sessionEntry.taskId === tid);
    if (!session) return false;
    const firstOutputCache = await window.electronAPI.sessions.getFirstOutput();
    return !!firstOutputCache[session.id];
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

    // Wait for the main process to LATCH first output before this test (or
    // the dialog it opens next) ever calls getScrollback() - see
    // hasFirstOutputForTask's doc comment for why that ordering is what
    // actually closes the race, not extra patience. 30000: depends on
    // mock-claude's spawn landing under CI's contended, sharded xvfb runners,
    // the same "compound, multi-hop" class session-resume.spec.ts budgets at
    // 30000 for.
    await expect
      .poll(() => hasFirstOutputForTask(page, taskId), {
        timeout: 30000,
        message: 'Expected the session to latch first output for the fullscreen select prompt',
      })
      .toBe(true);

    // Now safe to read scrollback: the flush that latches first output has
    // already happened (consume() short-circuits on every later chunk), so
    // this read cannot race it. Confirms the mock's initial frame actually
    // rendered with option 1 highlighted, not just that first output arrived.
    await expect
      .poll(() => scrollbackForTask(page, taskId), {
        timeout: 10000,
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
    // By the time this dialog mounts, hasFirstOutputForTask above has already
    // confirmed the main process latched first output, and the
    // SESSION_FIRST_OUTPUT push (sent synchronously the moment the latch
    // fired - see App.tsx's onFirstOutput listener) has already set
    // sessionFirstOutput[sessionId] in the renderer store. TerminalTab seeds
    // terminalReady from that same flag at mount (TerminalTab.tsx), so the
    // LaunchOverlay should never even render here. This wait is a defensive
    // backstop for a slow store propagation, not a missed-edge guard: if it
    // ever times out, the fix is upstream, in preserving
    // hasFirstOutputForTask's ordering guarantee (no getScrollback() call
    // before the latch resolves) - NOT in raising this budget. Raising this
    // exact budget (15000 -> 30000) previously papered over the real missed
    // edge and the flake recurred; see hasFirstOutputForTask's doc comment.
    await dialog.locator('[data-testid="launch-overlay"]').waitFor({ state: 'hidden', timeout: 30000 });
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

    // The freshly re-fetched replay must carry the alt-screen switch, so it
    // paints into the alt buffer, not the normal buffer (the secondary defect:
    // the cursor left disconnected from the TUI frame). An alt-screen session's
    // replay is now a parsed-grid serialized frame
    // (PtyBufferManager.getReplaySnapshot): the serialize addon emits the
    // serialized normal buffer first and the \x1b[?1049h switch mid-stream, so
    // the sequence is contained, not leading. The post-replay ArrowDown below
    // (no manual re-click) is the functional proof the replay landed in the
    // right buffer with focus intact.
    const freshScrollback = await scrollbackForTask(page, taskId);
    expect(freshScrollback).toContain('\x1b[?1049h');

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
