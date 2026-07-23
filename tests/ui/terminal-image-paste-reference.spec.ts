/**
 * UI coverage for the Ctrl+V image-paste / image-drop bug fix on a REAL task's
 * terminal (TerminalTab), as distinct from the command-bar/transient terminal
 * already covered by write-batcher-integration.spec.ts.
 *
 * Root cause (see task description): a pasted or dropped image was injected
 * into the PTY as a bare quoted file path, which the agent CLI reads as inert
 * text rather than an image attachment. The fix surfaces an adapter-declared
 * `pastedImageReferenceTemplate` (see AgentAdapter.pastedImageReferenceTemplate,
 * mirrored on the mock 'claude' agents.list() entry here) that TerminalTab
 * resolves via session -> task -> agent -> agentList, and threads into both
 * the Ctrl+V paste path (terminal-clipboard.ts) and the drag-drop path
 * (useTerminalFileDrop.ts, image files only - a dropped non-image file keeps
 * the bare quoted path).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-image-paste-reference';
const TASK_ID = 'task-image-paste-reference';
const SESSION_ID = 'sess-image-paste-reference';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Image Paste Reference Test',
      path: '/mock/image-paste-reference',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-ipr-' + i;
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running claude-agent session so TerminalTab mounts a real xterm and
    // resolves pastedImageReferenceTemplate via session.taskId -> task.agent.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/image-paste-reference',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Image Paste Reference Task',
      description: 'Task used for the image-paste reference test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchWithState(extraScript = ''): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  if (extraScript) await page.addInitScript(extraScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Open the task-detail dialog and wait for its xterm to mount, returning the
 *  attached `.xterm-helper-textarea` locator scoped to that dialog. */
async function openTaskTerminal(page: Page) {
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

  const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Image Paste Reference Task').first();
  await card.click();

  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  // Lift the LaunchOverlay shimmer so TerminalTab's xterm.open() runs.
  await page.evaluate((sessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
    }).__zustandStores;
    stores?.session?.getState().markFirstOutput(sessionId);
  }, SESSION_ID);

  const xtermTextarea = dialog.locator('.xterm-helper-textarea').first();
  await xtermTextarea.waitFor({ state: 'attached', timeout: 8000 });
  await xtermTextarea.focus();

  return { dialog, xtermTextarea };
}

test.describe('Image paste/drop on a real task terminal - adapter reference template', () => {
  test('Ctrl+V with a clipboard image writes the adapter-templated reference, not a bare path', async () => {
    const IMAGE_PATH = '/tmp/kangentic-clipboard/pasted-image-test.png';
    const clipboardOverrideScript = `
      try { navigator.clipboard.readText = function () { return Promise.resolve(''); }; } catch (e) {}
      window.electronAPI.clipboard.readImage = function () { return Promise.resolve('${IMAGE_PATH}'); };
    `;
    const { browser, page } = await launchWithState(clipboardOverrideScript);
    try {
      await openTaskTerminal(page);

      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      await page.keyboard.press('Control+v');

      await expect.poll(async () => {
        return page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      }, { timeout: 3000 }).toBe(1);

      const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls);
      const call = (writeCalls as Array<{ sessionId: string; payload: string }>)[0];
      expect(call.sessionId).toBe(SESSION_ID);
      // 'claude' mock agents.list() entry declares pastedImageReferenceTemplate:
      // 'Read this image: {path} ' - the bare path must NOT be injected verbatim.
      expect(call.payload).toBe(`Read this image: ${IMAGE_PATH} `);
    } finally {
      await browser.close();
    }
  });

  test('dropping a .png file writes the adapter-templated reference', async () => {
    const { browser, page } = await launchWithState();
    try {
      await openTaskTerminal(page);

      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
        window.electronAPI.webUtils.getPathForFile = function (file: File) {
          return '/mock/dropped/' + file.name;
        };
      });

      await page.evaluate(() => {
        const textarea = document.querySelector('.xterm-helper-textarea');
        const overlay = textarea?.closest('[data-testid="terminal-tab-container"]')?.querySelector('.z-20');
        if (!overlay) throw new Error('file-drop overlay not found');

        const file = new File(['fake-png-bytes'], 'screenshot.png', { type: 'image/png' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        overlay.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
      });

      await expect.poll(async () => {
        return page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      }, { timeout: 3000 }).toBe(1);

      const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls);
      const call = (writeCalls as Array<{ sessionId: string; payload: string }>)[0];
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe('Read this image: /mock/dropped/screenshot.png ');
    } finally {
      await browser.close();
    }
  });

  test('dropping a file with empty MIME type but an image extension writes the adapter-templated reference', async () => {
    // Some drag sources (notably the Windows file explorer via Electron's
    // webUtils path) hand xterm's drop handler a File whose `.type` is the
    // empty string. isImageFile() falls back to the IMAGE_FILE_EXTENSIONS
    // regex against file.name for exactly this case - this test pins that
    // fallback branch, which no other case in this file exercises (the other
    // drop tests use an explicit 'image/png' or 'text/plain' MIME type).
    const { browser, page } = await launchWithState();
    try {
      await openTaskTerminal(page);

      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
        window.electronAPI.webUtils.getPathForFile = function (file: File) {
          return '/mock/dropped/' + file.name;
        };
      });

      await page.evaluate(() => {
        const textarea = document.querySelector('.xterm-helper-textarea');
        const overlay = textarea?.closest('[data-testid="terminal-tab-container"]')?.querySelector('.z-20');
        if (!overlay) throw new Error('file-drop overlay not found');

        const file = new File(['fake-png-bytes'], 'screenshot.png', { type: '' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        overlay.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
      });

      await expect.poll(async () => {
        return page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      }, { timeout: 3000 }).toBe(1);

      const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls);
      const call = (writeCalls as Array<{ sessionId: string; payload: string }>)[0];
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe('Read this image: /mock/dropped/screenshot.png ');
    } finally {
      await browser.close();
    }
  });

  test('dropping a non-image .txt file writes the bare quoted path (unchanged legacy behavior)', async () => {
    const { browser, page } = await launchWithState();
    try {
      await openTaskTerminal(page);

      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
        window.electronAPI.webUtils.getPathForFile = function (file: File) {
          return '/mock/dropped/' + file.name;
        };
      });

      await page.evaluate(() => {
        const textarea = document.querySelector('.xterm-helper-textarea');
        const overlay = textarea?.closest('[data-testid="terminal-tab-container"]')?.querySelector('.z-20');
        if (!overlay) throw new Error('file-drop overlay not found');

        const file = new File(['plain text'], 'notes.txt', { type: 'text/plain' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        overlay.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
      });

      await expect.poll(async () => {
        return page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      }, { timeout: 3000 }).toBe(1);

      const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls);
      const call = (writeCalls as Array<{ sessionId: string; payload: string }>)[0];
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe('/mock/dropped/notes.txt');
    } finally {
      await browser.close();
    }
  });
});
