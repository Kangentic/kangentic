/**
 * UI coverage for pasted / dropped image delivery on a REAL task's terminal
 * (TerminalTab), as distinct from the command-bar/transient terminal covered by
 * write-batcher-integration.spec.ts.
 *
 * A captured image (Ctrl+V clipboard image, or a dropped image file) is delivered
 * through xterm's `terminal.paste()`, the way a native terminal delivers a drop.
 * xterm brackets the text (`ESC[200~ ... ESC[201~`) exactly when the foreground
 * app enabled mode 2004, and that packet is what lets an agent TUI attach the
 * image from its path (Claude Code's `[Image #N]` scan runs only on a paste).
 * WHAT is pasted comes from the adapter's `PastedImageCapability` (mirrored on
 * the mock 'claude' agents.list() entry): the bare quoted path for an extension
 * the CLI attaches natively, the `Read this image:` fallback for the rest
 * (bmp, svg). TerminalTab resolves it via session -> task -> agent -> agentList.
 *
 * The mock never sends `\x1b[?2004h` and its scrollback is empty, so every xterm
 * here starts with bracketed-paste mode OFF. Cases that assert a bracketed
 * packet enable the mode first through the shared `enableBracketedPaste`
 * helper. The mode-off cases are the bare-shell contract: a prompt that never
 * enabled the mode gets the plain path.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { TERMINAL_TEXT_LAUNCH_ARGS, enableBracketedPaste, waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-image-paste-reference';
const TASK_ID = 'task-image-paste-reference';
const SESSION_ID = 'sess-image-paste-reference';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const bracketed = (text: string) => `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;

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
    // resolves the paste capability via session.taskId -> task.agent.
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

/** Ctrl+V reaches the image path only when the text clipboard is empty; the
 *  image is read natively via the mock's clipboard.readImage. */
const IMAGE_PATH = '/tmp/kangentic-clipboard/pasted-image-test.png';
const clipboardImageScript = `
  try { navigator.clipboard.readText = function () { return Promise.resolve(''); }; } catch (e) {}
  window.electronAPI.clipboard.readImage = function () { return Promise.resolve('${IMAGE_PATH}'); };
`;

async function launchWithState(extraScript = ''): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  // DOM renderer, so the mode-2004 sentinel is assertable as text.
  const browser = await chromium.launch({ headless: true, args: TERMINAL_TEXT_LAUNCH_ARGS });
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
 *  dialog locator and the attached `.xterm-helper-textarea` scoped to it. */
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

  await page.evaluate(() => {
    window.electronAPI.sessions.__writeCalls.length = 0;
  });

  return { dialog, xtermTextarea };
}

/**
 * A real 1x1 24-bit BMP (58 bytes: 14-byte file header, 40-byte info header,
 * one red pixel plus row padding), so Chromium's `createImageBitmap` decodes
 * it and the drop hook's normalize branch runs. The other drop cases use
 * undecodable fake bytes on purpose: they exercise the paths that never touch
 * the decoder.
 */
const ONE_PIXEL_BMP = [
  0x42, 0x4d, 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0,
  40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 0, 4, 0, 0, 0,
  0x13, 0x0b, 0, 0, 0x13, 0x0b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0x00, 0x00, 0xff, 0x00,
];

/** Drop `files` on the terminal's file-drop overlay, with the mock resolving each
 *  file's path under /mock/dropped/. A file with `bytes` carries those bytes;
 *  the rest carry undecodable filler. */
async function dropFiles(page: Page, files: Array<{ name: string; type: string; bytes?: number[] }>) {
  await page.evaluate((droppedFiles) => {
    window.electronAPI.webUtils.getPathForFile = function (file: File) {
      return '/mock/dropped/' + file.name;
    };
    const textarea = document.querySelector('.xterm-helper-textarea');
    const overlay = textarea?.closest('[data-testid="terminal-tab-container"]')?.querySelector('.z-20');
    if (!overlay) throw new Error('file-drop overlay not found');

    const dataTransfer = new DataTransfer();
    for (const dropped of droppedFiles) {
      const content = dropped.bytes ? new Uint8Array(dropped.bytes) : 'fake-bytes';
      dataTransfer.items.add(new File([content], dropped.name, { type: dropped.type }));
    }
    overlay.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  }, files);
}

async function readSingleWrite(page: Page): Promise<{ sessionId: string; payload: string }> {
  await expect.poll(async () => {
    return page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
  }, { timeout: 3000 }).toBe(1);
  const writeCalls = await page.evaluate(() => window.electronAPI.sessions.__writeCalls);
  return (writeCalls as Array<{ sessionId: string; payload: string }>)[0];
}

test.describe('Image paste/drop on a real task terminal - bracketed paste delivery', () => {
  test('Ctrl+V with a clipboard image pastes the bare path as ONE bracketed packet under mode 2004', async () => {
    const { browser, page } = await launchWithState(clipboardImageScript);
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      await page.keyboard.press('Control+v');

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      // png is in the mock claude entry's pastedImageNativeExtensions, so the
      // payload is the bare path (unquoted: no spaces) inside a paste packet.
      // No "Read this image:" prefix: the TUI's own path scan attaches it.
      expect(call.payload).toBe(bracketed(IMAGE_PATH));
    } finally {
      await browser.close();
    }
  });

  test('Ctrl+V with a clipboard image at a prompt that never enabled mode 2004 writes the plain path', async () => {
    // The bare-shell contract: xterm brackets only when the foreground app asked
    // for it, so a shell prompt receives the plain quoted path as text and
    // nothing executes.
    const { browser, page } = await launchWithState(clipboardImageScript);
    try {
      await openTaskTerminal(page);

      await page.keyboard.press('Control+v');

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe(IMAGE_PATH);
    } finally {
      await browser.close();
    }
  });

  test('dropping a .png file pastes the bare path as a bracketed packet', async () => {
    const { browser, page } = await launchWithState();
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      await dropFiles(page, [{ name: 'screenshot.png', type: 'image/png' }]);

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe(bracketed('/mock/dropped/screenshot.png'));
    } finally {
      await browser.close();
    }
  });

  test('dropping a file with empty MIME type but an image extension is still delivered as an image', async () => {
    // Some drag sources (notably the Windows file explorer via Electron's
    // webUtils path) hand xterm's drop handler a File whose `.type` is the
    // empty string. isImageFile() falls back to the IMAGE_FILE_EXTENSIONS
    // regex against file.name for exactly this case, and the native-extension
    // decision reads the extension off the path, never the MIME type.
    const { browser, page } = await launchWithState();
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      await dropFiles(page, [{ name: 'screenshot.png', type: '' }]);

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe(bracketed('/mock/dropped/screenshot.png'));
    } finally {
      await browser.close();
    }
  });

  test('dropping a .bmp file pastes the PNG copy main saved, so the CLI attaches it natively', async () => {
    // bmp is outside Claude's native set and its Read tool refuses the file as
    // binary, so the fallback text never reached a bmp. The hook re-encodes the
    // dropped bytes as PNG in the renderer (Chromium decodes bmp) and hands them
    // to clipboard.saveImage, which lands them beside the clipboard captures;
    // the PNG copy's bare path is what gets pasted. Real bytes here, or the
    // decoder refuses and this case would silently test the fallback instead.
    const { browser, page } = await launchWithState();
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
        window.electronAPI.clipboard.__saveImageCalls.length = 0;
      });

      await dropFiles(page, [{ name: 'diagram.bmp', type: 'image/bmp', bytes: ONE_PIXEL_BMP }]);

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe(bracketed('/tmp/kangentic-clipboard/pasted-image-normalized.png'));
      // The bytes handed to main are a PNG encode of the decoded bitmap, not the
      // bmp bytes passed through: a PNG of one pixel is a few dozen bytes and
      // starts with the PNG signature length, never the 58-byte bmp.
      const saved = await page.evaluate(() => window.electronAPI.clipboard.__saveImageCalls);
      expect(saved).toHaveLength(1);
      expect((saved as number[])[0]).toBeGreaterThan(0);
      expect((saved as number[])[0]).not.toBe(ONE_PIXEL_BMP.length);
    } finally {
      await browser.close();
    }
  });

  test('dropping a decodable .bmp whose saveImage write fails falls back to the template on the original path', async () => {
    // The bmp decodes fine (createImageBitmap succeeds), but main could not
    // write the PNG copy (disk full, permission denied, etc.): saveImage
    // resolves null, so normalizeImageForPaste returns null too and the hook
    // must fall back to the fallback template on the ORIGINAL dropped path,
    // exactly like the never-decodes case below, but distinguished here by
    // saveImage having actually been called once (proving the decode branch
    // ran) rather than never called at all.
    const { browser, page } = await launchWithState();
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
        window.electronAPI.clipboard.__saveImageCalls.length = 0;
        window.electronAPI.clipboard.saveImage = function (pngBytes) {
          window.electronAPI.clipboard.__saveImageCalls.push(pngBytes ? pngBytes.byteLength : 0);
          return Promise.resolve(null);
        };
      });

      await dropFiles(page, [{ name: 'diagram.bmp', type: 'image/bmp', bytes: ONE_PIXEL_BMP }]);

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe(bracketed('Read this image: /mock/dropped/diagram.bmp '));
      const saved = await page.evaluate(() => window.electronAPI.clipboard.__saveImageCalls);
      expect(saved).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('dropping an image outside the native set that does not decode falls back to the template', async () => {
    // A .bmp by name whose bytes are not an image at all: createImageBitmap
    // rejects, no PNG copy exists, and the explicit Read instruction with the
    // ORIGINAL path is pasted, so the agent still hears about the file.
    const { browser, page } = await launchWithState();
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
        window.electronAPI.clipboard.__saveImageCalls.length = 0;
      });

      await dropFiles(page, [{ name: 'diagram.bmp', type: 'image/bmp' }]);

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe(bracketed('Read this image: /mock/dropped/diagram.bmp '));
      const saved = await page.evaluate(() => window.electronAPI.clipboard.__saveImageCalls);
      expect(saved).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('dropping two .png files pastes one packet per path', async () => {
    // One paste() per item: a single space-joined paste would hand the TUI's
    // path scan `"a.png" "b.png"` as one token and attach neither. The separator
    // rides inside the preceding packet, so a shell prompt still reads
    // `a.png b.png`. The contract is the packet sequence, so the assertion joins
    // every write: the batcher happens to merge the same-microtask onData events
    // into one sessions.write today, but how the bytes are chunked is the
    // batcher's business, not this feature's.
    const { browser, page } = await launchWithState();
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
      });

      await dropFiles(page, [
        { name: 'first.png', type: 'image/png' },
        { name: 'second.png', type: 'image/png' },
      ]);

      await expect.poll(async () => {
        return page.evaluate(() =>
          window.electronAPI.sessions.__writeCalls.map((c: { payload: string }) => c.payload).join(''),
        );
      }, { timeout: 3000 }).toBe(
        bracketed('/mock/dropped/first.png ') + bracketed('/mock/dropped/second.png'),
      );
      const sessionIds = await page.evaluate(() =>
        window.electronAPI.sessions.__writeCalls.map((c: { sessionId: string }) => c.sessionId),
      );
      expect(new Set(sessionIds as string[])).toEqual(new Set([SESSION_ID]));
    } finally {
      await browser.close();
    }
  });

  test('a second drop landing while the first is mid-normalize queues behind it, so both arrive in order', async () => {
    // deliveryQueueRef chains each drop event's delivery behind the previous
    // one. A bmp drop's normalize+saveImage round trip is async, so a second
    // drop landing before it settles must queue rather than start its own
    // delivery and race the first one to the terminal. Overriding saveImage
    // with a promise this test controls holds the first delivery open, so
    // "nothing written yet" and "written in order once released" are both
    // proven deterministically instead of by timing.
    const { browser, page } = await launchWithState();
    try {
      const { dialog } = await openTaskTerminal(page);
      await enableBracketedPaste(page, dialog, SESSION_ID);
      await page.evaluate(() => {
        window.electronAPI.sessions.__writeCalls.length = 0;
        window.electronAPI.clipboard.__saveImageCalls.length = 0;
        window.electronAPI.clipboard.saveImage = function (pngBytes) {
          window.electronAPI.clipboard.__saveImageCalls.push(pngBytes ? pngBytes.byteLength : 0);
          return new Promise((resolve) => {
            (window as unknown as { __releaseSaveImage: (path: string) => void }).__releaseSaveImage = resolve;
          });
        };
      });

      await dropFiles(page, [{ name: 'diagram.bmp', type: 'image/bmp', bytes: ONE_PIXEL_BMP }]);
      await dropFiles(page, [{ name: 'after.png', type: 'image/png' }]);

      // Proves the bmp's delivery is genuinely paused awaiting the round trip
      // (saveImage was called), not merely that we haven't checked yet.
      await expect
        .poll(async () => page.evaluate(() => window.electronAPI.clipboard.__saveImageCalls.length), {
          timeout: 3000,
        })
        .toBe(1);

      // The png is queued behind the still-pending bmp delivery, not delivered
      // ahead of it.
      const writesBeforeRelease = await page.evaluate(() => window.electronAPI.sessions.__writeCalls.length);
      expect(writesBeforeRelease).toBe(0);

      await page.evaluate(() => {
        (window as unknown as { __releaseSaveImage: (path: string) => void }).__releaseSaveImage(
          '/tmp/kangentic-clipboard/pasted-image-normalized.png',
        );
      });

      await expect
        .poll(async () => page.evaluate(() => window.electronAPI.sessions.__writeCalls.length), { timeout: 3000 })
        .toBe(2);
      const payloads = await page.evaluate(() =>
        window.electronAPI.sessions.__writeCalls.map((call: { payload: string }) => call.payload),
      );
      expect(payloads.join('')).toBe(
        bracketed('/tmp/kangentic-clipboard/pasted-image-normalized.png') + bracketed('/mock/dropped/after.png'),
      );
    } finally {
      await browser.close();
    }
  });

  test('dropping a non-image .txt file at a prompt without mode 2004 writes the bare quoted path (unchanged)', async () => {
    const { browser, page } = await launchWithState();
    try {
      await openTaskTerminal(page);

      await dropFiles(page, [{ name: 'notes.txt', type: 'text/plain' }]);

      const call = await readSingleWrite(page);
      expect(call.sessionId).toBe(SESSION_ID);
      expect(call.payload).toBe('/mock/dropped/notes.txt');
    } finally {
      await browser.close();
    }
  });
});
