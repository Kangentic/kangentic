/**
 * E2E tests for task prompt delivery to agents.
 *
 * Verifies that the task title/description reaches the agent on first load
 * and that resumed sessions receive no extra prompt.
 *
 * Uses a mock Claude CLI (tests/fixtures/mock-claude) so these tests work
 * without a real Claude installation. The mock prints its own labeled
 * MOCK_CLAUDE_*: marker lines to stdout, which the tests match against -
 * see the shell-echo hazard note below for why that distinction matters.
 *
 * Encapsulated under "Claude Agent" -- future agent types (e.g. Codex, Aider)
 * should get their own describe blocks.
 *
 * NOT migrated to shared-app fixture: test 3 ("prompt includes full description
 * text, not just title") fails 8/10 in --repeat-each=10 after the first repeat.
 * Root cause: Playwright's --repeat-each re-evaluates the module, so runId
 * changes each repeat (new Date.now()), producing a unique task title per
 * repeat. In a warm shared Electron instance after many repeats, the
 * accumulated in-memory session registry (exited sessions, multiple projects)
 * slows PTY scrollback emission enough to exceed the 15s scrollback-wait
 * timeout. Tests 1 and 2 pass because they run before the accumulated load
 * reaches test 3. With its own boot, the Electron starts fresh every time.
 * Keeping own boot.
 *
 * Readiness waits are task-scoped and gate on a marker the mock itself
 * prints (never on the task title/description alone): the shell echoes the
 * spawn command line BEFORE the mock CLI actually runs, and that echo
 * contains the full <task> XML (title + description) verbatim as the
 * positional prompt argument. A poll for the title text alone is therefore
 * satisfiable by the pre-execution echo, not just by the mock's real output
 * - see waitForTaskPromptScrollback below.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  getTaskIdByTitle,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'task-prompt';
const runId = Date.now();
const PROJECT_NAME = `Prompt Test ${runId}`;
let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

/** Resolve the platform-appropriate mock Claude path */
function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  // Unix: use the .js file directly (has shebang)
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

  // Pre-write config with mock Claude CLI path
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false, // Avoid worktree overhead in prompt tests
      },
    }),
  );

  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await closeApp(app);
  cleanupTempProject(TEST_NAME);
});

/** Dismiss dialogs and ensure the board is visible */
async function ensureBoard() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

/**
 * Drag a task card to a target column.
 * Duplicated from drag-and-drop.spec.ts -- extracted here to keep tests
 * self-contained. A shared helper can be refactored later.
 */
async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col) => {
    const el = document.querySelector(`[data-swimlane-name="${col}"]`);
    if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);
  await page.waitForTimeout(100);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.waitForTimeout(100);
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/**
 * Wait for THIS task's own session to print its MOCK_CLAUDE_PROMPT:<text>
 * marker, then return that session's scrollback.
 *
 * Two failure modes this guards against (both hit in CI, not locally
 * reproducible on Windows - see the file header):
 *
 * 1. Echo-satisfiable readiness: a naive poll for the task TITLE in
 *    aggregate scrollback can be satisfied by the shell echoing the spawn
 *    command line before the mock CLI has even run - that command line
 *    embeds the full <task><title>...</title><description>...</description>
 *    </task> XML verbatim as the quoted positional prompt argument. Only a
 *    marker the mock process itself prints (MOCK_CLAUDE_PROMPT: - never
 *    part of the invoked command's own text) proves the mock actually
 *    executed and parsed the prompt.
 * 2. Cross-test scrollback bleed: this file shares one Electron instance
 *    across three tests via a single `page`. A naive poll that joins ALL
 *    sessions' scrollback can be satisfied by an EARLIER test's still-alive
 *    session (mock-claude stays up ~30s), well before this test's own
 *    session has produced any output. Filtering sessions by this task's own
 *    taskId scopes the read to the session THIS test just spawned. Each
 *    test creates exactly one task with a unique title and that task spawns
 *    exactly one session in this file, so taskId alone is unambiguous - no
 *    status filter is layered on top, so this does not wait on a
 *    'running' transition landing before polling scrollback.
 *
 * Mirrors the waitForTaskScrollback pattern used in
 * session-move-lifecycle.spec.ts / done-worktree-lifecycle.spec.ts /
 * window-light-dismiss-pty-survival.spec.ts (those additionally filter on
 * status='running' because they reuse a taskId across multiple spawns in
 * the same test; not needed here).
 */
async function waitForTaskPromptScrollback(taskId: string, timeoutMs = 15000): Promise<string> {
  const marker = 'MOCK_CLAUDE_PROMPT:';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const session = sessions.find((s) => s.taskId === tid);
      if (!session) return '';
      return window.electronAPI.sessions.getScrollback(session.id);
    }, taskId);

    if (scrollback.includes(marker)) {
      return scrollback;
    }

    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for task ${taskId} to print ${marker}`);
}

test.describe('Claude Agent -- Task Prompt', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('fresh session receives task title and description as prompt', async () => {
    const title = `Prompt Fresh ${runId}`;
    const description = 'Implement the login feature with OAuth support';
    await createTask(page, title, description);
    const taskId = await getTaskIdByTitle(page, title);

    // Drag to Code Review (To Do → Code Review triggers spawn_agent)
    await dragTaskToColumn(title, 'Code Review');

    // Wait for THIS task's own session to print its MOCK_CLAUDE_PROMPT:
    // marker (mock-owned, task-scoped - see waitForTaskPromptScrollback).
    const scrollback = await waitForTaskPromptScrollback(taskId);

    // Verify both title and description are in the prompt
    expect(scrollback).toContain(title);
    expect(scrollback).toContain(description);
  });

  test('fresh session to Planning receives prompt in plan mode', async () => {
    const title = `Prompt Plan ${runId}`;
    const description = 'Design the authentication architecture';
    await createTask(page, title, description);
    const taskId = await getTaskIdByTitle(page, title);

    await dragTaskToColumn(title, 'Planning');

    // waitForTaskPromptScrollback gates on MOCK_CLAUDE_PROMPT:, which
    // mock-claude.js writes AFTER MOCK_CLAUDE_PERMISSION_MODE: in the same
    // synchronous burst (see the marker order in mock-claude.js). A stream
    // preserves write order, so anything a terminal replay can show for a
    // later write it can also show for an earlier one from the same
    // process - by the time this resolves, the permission-mode marker is
    // already earlier in that same ordered stream.
    const scrollback = await waitForTaskPromptScrollback(taskId);

    expect(scrollback).toContain(title);
    expect(scrollback).toContain(description);
    // Planning column uses --permission-mode plan. Assert on the mock's own
    // labeled marker line (MOCK_CLAUDE_PERMISSION_MODE:plan), not on the raw
    // "permission-mode" substring appearing anywhere in scrollback: that
    // substring can only land in scrollback via the shell's echo of the
    // invoked command line (mock-claude.js parses and discards
    // --permission-mode without printing it), and that shell echo is
    // non-deterministic under CI's loaded 8-worker Linux runner: it can be
    // pushed out of the ring buffer by a later SIGWINCH repaint stacking a
    // second banner (this test's own spawn on top of a leftover previous
    // session), or wiped outright by an ESC[2J ESC[3J clear the shell/ConPTY
    // emits before the poll observes it. mock-claude.js prints this marker
    // itself, synchronously, so it is immune to both failure modes.
    expect(scrollback).toContain('MOCK_CLAUDE_PERMISSION_MODE:plan');
  });

  test('prompt includes full description text, not just title', async () => {
    const title = `Prompt Desc ${runId}`;
    const description = 'Build a REST API with pagination and filtering';
    await createTask(page, title, description);
    const taskId = await getTaskIdByTitle(page, title);

    await dragTaskToColumn(title, 'Code Review');

    const scrollback = await waitForTaskPromptScrollback(taskId);

    // The full description should be in the prompt
    expect(scrollback).toContain(title);
    expect(scrollback).toContain(description);
  });
});
