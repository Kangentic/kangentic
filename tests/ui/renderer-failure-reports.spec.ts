/**
 * The renderer's failure-report sites, driven the way a user reaches them.
 *
 * `reportRendererFailure(area, op, error)` sits in the catches of hooks and
 * handlers that no unit test can import (the unit tier has no DOM). What a user
 * loses if one goes quiet: a failure they saw as a toast never reaches Sentry,
 * and what a report carries is only its fixed words, so a regression there can
 * also leak what they typed. Each step makes one dependency fail, does what a
 * user does, and asserts four things: the sink got exactly one report with the
 * site's tags and fingerprint, its message is the fixed `Handled <area>_<op>
 * failure: <Name>`, nothing the case typed (`Fix Acme billing`) is in the
 * serialized report, and the user still sees the toast.
 *
 * Where a site's trigger is a defect in renderer code (a TypeError), the thrown
 * message quotes the user's text on purpose, the way V8 does, so the "no user
 * text" assertion can fail. A message like `No handler registered` never holds
 * it, so that assertion alone would pass against a reporter that sent messages.
 *
 * The store sites are covered in tests/unit/error-reporting-renderer-sites-behavior
 * and the importable modules in error-reporting-renderer-components-behavior.
 * board_manager/save is reached only through a synchronous throw from a store
 * action, so that step overrides one. command_terminal/stop is driven in the unit file.
 *
 * Lazy chunks (turndown, the markdown pipeline, the icon map) are failed with a route that
 * matches the chunk's NAME in the url path, never a dev-server source path, so the same
 * trigger works on the Vite dev server and on the static bundle CI serves.
 *
 * markdown/image_load is reported by DiffViewer's `loadImage`, the one host of a document: it
 * catches the read's rejection, reports it and answers null. `useRepoImage`'s own catch reports
 * under the same words for a reader that does reject, which no host does today.
 *
 * Not covered here, and why:
 * - knowledge_graph/scene_build: `createRenderer` turns every failure to build the WebGL
 *   renderer into WebglRendererUnavailableError, the one class that is not reported, and a
 *   throw from the code after it needs a machine with WebGL and a malformed snapshot. A
 *   test would pass or skip by machine, which CI's headless Linux would decide.
 */
import { test, expect, chromium, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { launchPage, createProject, waitForViteReady, gotoVite, fireSessionData, markSessionFirstOutput, expectNoFrameHold, toastCountRightNow } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/** A title only a user would write, so a leak into a report is recognisable. */
const USER_TEXT = 'Fix Acme billing';

/** What V8 says for a property it could not read: it quotes the user's text. */
const LEAKY_TYPE_ERROR_MESSAGE = `Cannot read properties of undefined (reading '${USER_TEXT}')`;

/** A rejection that never reached a handler, so main never saw it and the renderer reports it. */
function noHandlerMessage(channel: string): string {
  return `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`;
}

interface RecordedReport {
  message: string;
  name: string;
  stack: string;
  tags: Record<string, string>;
  contexts: unknown;
  fingerprint: string[];
}

interface ReportWindow {
  __failureReports: RecordedReport[];
  __kangenticTestModules: {
    rendererFailure: {
      setRendererFailureSink: (
        sink: ((error: Error, tags: Record<string, string>, contexts: unknown, fingerprint: string[]) => void) | null,
      ) => void;
      resetRendererFailureReports: () => void;
    };
  };
}

interface StoreWindow {
  __zustandStores: {
    board: { getState: () => Record<string, unknown>; setState: (patch: Record<string, unknown>) => void };
    toast: { getState: () => { toasts: Array<{ id: string }>; dismissToast: (id: string) => void } };
  };
}

/** Records every report the renderer makes. Installed after boot, so nothing else replaces it. */
async function installSink(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as Partial<ReportWindow>).__kangenticTestModules?.rendererFailure));
  await page.evaluate(() => {
    const reportWindow = window as unknown as ReportWindow;
    reportWindow.__failureReports = [];
    reportWindow.__kangenticTestModules.rendererFailure.setRendererFailureSink((error, tags, contexts, fingerprint) => {
      reportWindow.__failureReports.push({
        message: error.message,
        name: error.name,
        stack: error.stack ?? '',
        tags,
        contexts,
        fingerprint,
      });
    });
  });
}

/** Forgets what was reported and re-arms the once-per-key latch. */
async function clearReports(page: Page): Promise<void> {
  await page.evaluate(() => {
    const reportWindow = window as unknown as ReportWindow;
    reportWindow.__failureReports = [];
    reportWindow.__kangenticTestModules.rendererFailure.resetRendererFailureReports();
  });
}

async function readReports(page: Page): Promise<RecordedReport[]> {
  return page.evaluate(() => (window as unknown as ReportWindow).__failureReports.slice());
}

/** Dismisses every toast, so the next step's toast is the only one and none covers a button. */
async function clearToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { toast } = (window as unknown as StoreWindow).__zustandStores;
    for (const entry of toast.getState().toasts) toast.getState().dismissToast(entry.id);
  });
}

interface ExpectedReport { area: string; operation: string; errorName: string }

/** Exactly these reports, in this order, each with the site's fixed words and none of the user's text. */
async function expectReports(page: Page, expectedReports: ExpectedReport[]): Promise<void> {
  await expect.poll(async () => (await readReports(page)).length, { timeout: 5000 }).toBe(expectedReports.length);
  const reports = await readReports(page);
  expectedReports.forEach((expected, index) => {
    const report = reports[index];
    expect(report.tags).toEqual({
      source: 'renderer',
      area: expected.area,
      op: expected.operation,
      error_name: expected.errorName,
    });
    expect(report.message).toBe(`Handled ${expected.area}_${expected.operation} failure: ${expected.errorName}`);
    expect(report.fingerprint).toEqual(['renderer', expected.area, expected.operation, expected.errorName]);
    expect(JSON.stringify(report)).not.toMatch(/acme/i);
  });
}

/** Exactly one report, with the site's fixed words and none of the user's text. */
async function expectOneReport(page: Page, expected: ExpectedReport): Promise<void> {
  await expectReports(page, [expected]);
}

/** A chunk the app loads lazily, by name: a dev-server source path and a hashed bundle chunk both match. */
function chunkNamed(name: string): (url: URL) => boolean {
  return (url) => url.pathname.includes(name);
}

function toastTitled(page: Page, title: string) {
  return page.locator('[data-testid="toast"]').filter({ has: page.getByTestId('toast-title').filter({ hasText: title }) });
}

test.describe.configure({ mode: 'serial' });

test.describe('failure reports from the renderer, on a board with a project', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;
    await createProject(page, `Renderer Failure Reports ${Date.now()}`);
    await installSink(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('New Task: a failed create, a refusal main saw, and an unreadable attachment', async () => {
    const newTaskDialog = page.locator('.fixed.inset-0');
    const createButton = newTaskDialog.locator('button[type="submit"]:has-text("Create")');

    await page.evaluate((message) => {
      window.electronAPI.tasks.create = async () => { throw new TypeError(message); };
    }, LEAKY_TYPE_ERROR_MESSAGE);
    await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
    await newTaskDialog.locator('input[placeholder="Task title"]').fill(USER_TEXT);

    await test.step('new_task/create reports a renderer defect and still toasts', async () => {
      await createButton.click();
      await expect(toastTitled(page, "Couldn't create task")).toBeVisible({ timeout: 5000 });
      await expectOneReport(page, { area: 'new_task', operation: 'create', errorName: 'TypeError' });
      // The dialog stays open so the title is not lost.
      await expect(newTaskDialog.locator('input[placeholder="Task title"]')).toHaveValue(USER_TEXT);
    });

    await test.step('a rejection main already saw is not reported again, and still toasts', async () => {
      await clearReports(page);
      await clearToasts(page);
      await page.evaluate(() => {
        window.electronAPI.tasks.create = async () => {
          throw new Error("Error invoking remote method 'task:create': RefusalError: Nope");
        };
      });
      await createButton.click();
      await expect(toastTitled(page, "Couldn't create task")).toBeVisible({ timeout: 5000 });
      expect(await readReports(page)).toEqual([]);
    });

    await test.step('a file the page cannot read toasts "Couldn\'t attach file" and reports nothing', async () => {
      await clearToasts(page);
      await page.evaluate(() => {
        // A file that is moved or locked fails the read: the reader raises its error event.
        const reader = FileReader.prototype as { readAsDataURL: (blob: Blob) => void };
        (window as unknown as { __readAsDataURL: unknown }).__readAsDataURL = reader.readAsDataURL;
        reader.readAsDataURL = function failingRead(this: FileReader) {
          queueMicrotask(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>));
        };
        const textarea = document.querySelector('.fixed.inset-0 textarea');
        if (!textarea) throw new Error('no description textarea');
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'notes.png', { type: 'image/png' }));
        textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      try {
        await expect(toastTitled(page, "Couldn't attach file")).toBeVisible({ timeout: 5000 });
      } finally {
        await page.evaluate(() => {
          (FileReader.prototype as { readAsDataURL: unknown }).readAsDataURL = (window as unknown as { __readAsDataURL: unknown }).__readAsDataURL;
        });
      }
      expect(await readReports(page)).toEqual([]);
    });

    await test.step('description/paste_markdown reports a converter that did not load, and the paste lands as plain text', async () => {
      await clearReports(page);
      await clearToasts(page);
      const description = newTaskDialog.locator('textarea').first();
      await description.focus();
      // turndown is a lazy chunk, so a pasted fragment is the first thing that asks for it.
      const turndownChunk = chunkNamed('turndown');
      const abortChunk = (route: Route): Promise<void> => route.abort();
      await page.route(turndownChunk, abortChunk);
      try {
        await page.evaluate(() => {
          const textarea = document.querySelector('.fixed.inset-0 textarea');
          if (!textarea) throw new Error('no description textarea');
          const transfer = new DataTransfer();
          transfer.setData('text/html', '<h2>Fix Acme billing</h2><ul><li>first item</li></ul>');
          transfer.setData('text/plain', 'Fix Acme billing\nfirst item');
          textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
        });
        // The user keeps what they copied, without its headings and lists.
        await expect(description).toHaveValue('Fix Acme billing\nfirst item', { timeout: 5000 });
        await expectOneReport(page, { area: 'description', operation: 'paste_markdown', errorName: 'TypeError' });
      } finally {
        await page.unroute(turndownChunk, abortChunk);
      }
    });

    // Leave the board clean for the next test: close the dialog without creating.
    await page.keyboard.press('Escape');
    const discard = page.locator('button', { hasText: 'Discard' });
    if (await discard.isVisible({ timeout: 500 }).catch(() => false)) await discard.click();
    await expect(newTaskDialog).toBeHidden({ timeout: 5000 });
    await clearToasts(page);
  });

  test('Board Manager: profiles, save and reorder each report their own failure', async () => {
    await clearReports(page);
    await page.locator('[data-swimlane-name="Planning"]').locator('text=Planning').click();
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    const saveButton = page.locator('[data-testid="board-manager-save"]');
    const nameInput = page.locator('[data-testid="board-manager-name"]');

    const originals = await page.evaluate(() => {
      const { board } = (window as unknown as StoreWindow).__zustandStores;
      const state = board.getState();
      (window as unknown as { __boardOriginals: Record<string, unknown> }).__boardOriginals = {
        saveBoardProfiles: state.saveBoardProfiles,
        updateSwimlane: state.updateSwimlane,
        reorderSwimlanes: state.reorderSwimlanes,
      };
      return Object.keys((window as unknown as { __boardOriginals: Record<string, unknown> }).__boardOriginals);
    });
    expect(originals).toEqual(['saveBoardProfiles', 'updateSwimlane', 'reorderSwimlanes']);

    await test.step('board_manager/profiles: a profile write that throws in the renderer', async () => {
      await page.locator('[data-testid="board-manager-profile-new"]').click();
      await page.locator('[data-testid="profile-name-input"]').fill(USER_TEXT);
      await page.locator('[data-testid="profile-name-confirm"]').click();
      await expect(page.locator('[data-testid="profile-name-input"]')).toBeHidden({ timeout: 3000 });
      await page.evaluate((message) => {
        (window as unknown as StoreWindow).__zustandStores.board.setState({
          saveBoardProfiles: async () => { throw new TypeError(message); },
        });
      }, LEAKY_TYPE_ERROR_MESSAGE);
      await saveButton.click();
      await expect(toastTitled(page, "Couldn't save")).toBeVisible({ timeout: 5000 });
      await expectOneReport(page, { area: 'board_manager', operation: 'profiles', errorName: 'TypeError' });
    });

    await test.step('board_manager/save: a store action that throws before its promise exists', async () => {
      await clearReports(page);
      await clearToasts(page);
      await page.locator('[data-testid="board-manager-profile-select"]').selectOption('');
      await nameInput.fill('Planning edited');
      await page.evaluate((message) => {
        (window as unknown as StoreWindow).__zustandStores.board.setState({
          updateSwimlane: () => { throw new TypeError(message); },
        });
      }, LEAKY_TYPE_ERROR_MESSAGE);
      await saveButton.click();
      await expect(toastTitled(page, "Couldn't save")).toBeVisible({ timeout: 5000 });
      await expectOneReport(page, { area: 'board_manager', operation: 'save', errorName: 'TypeError' });
      // The save did not strand: the dialog is still there and Save answers again.
      await expect(dialog).toBeVisible();
      await expect(saveButton).toBeEnabled();
    });

    await test.step('board_manager/reorder: a reorder that throws in the renderer after a column was created', async () => {
      await clearReports(page);
      await clearToasts(page);
      await page.evaluate(() => {
        const { board } = (window as unknown as StoreWindow).__zustandStores;
        const originalsMap = (window as unknown as { __boardOriginals: Record<string, unknown> }).__boardOriginals;
        board.setState({
          updateSwimlane: originalsMap.updateSwimlane,
          reorderSwimlanes: async () => { throw new TypeError("Cannot read properties of undefined (reading 'Fix Acme billing')"); },
        });
      });
      // Put the rename back first so the real update path has nothing to write.
      await nameInput.fill('Planning');
      await page.locator('[data-testid="board-manager-add-column"]').click();
      await nameInput.fill('Triage');
      await saveButton.click();
      await expect(toastTitled(page, 'Save stopped partway')).toBeVisible({ timeout: 5000 });
      await expectOneReport(page, { area: 'board_manager', operation: 'reorder', errorName: 'TypeError' });
    });

    // Cleanup: restore the store, drop the created column, leave the dialog.
    await page.evaluate(async () => {
      const { board } = (window as unknown as StoreWindow).__zustandStores;
      board.setState((window as unknown as { __boardOriginals: Record<string, unknown> }).__boardOriginals);
      const lanes = await window.electronAPI.swimlanes.list();
      const triage = lanes.find((lane) => lane.name === 'Triage');
      if (triage) await window.electronAPI.swimlanes.delete(triage.id);
    });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    const discardButton = page.locator('button', { hasText: 'Discard' });
    if (await discardButton.isVisible({ timeout: 500 }).catch(() => false)) await discardButton.click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
    await clearToasts(page);
  });

  test('Settings: a write that never reached a handler reports, and the knowledge graph rebuild toasts', async () => {
    await clearReports(page);
    await page.locator('[data-testid="settings-button"]').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
    const tabs = page.getByTestId('settings-tab-list');

    await test.step('settings/write reports a rejection main never saw, and toasts', async () => {
      await page.evaluate((message) => {
        (window as unknown as { __configSet: unknown }).__configSet = window.electronAPI.config.set;
        window.electronAPI.config.set = async () => { throw new Error(message); };
      }, noHandlerMessage('config:set'));
      await tabs.getByRole('button', { name: 'Board', exact: true }).click();
      try {
        await page.getByTestId('setting-row-skipBoardConfigConfirm').click();
        await expect(toastTitled(page, 'Setting not saved')).toBeVisible({ timeout: 5000 });
        await expectOneReport(page, { area: 'settings', operation: 'write', errorName: 'Error' });
      } finally {
        await page.evaluate(() => {
          window.electronAPI.config.set = (window as unknown as { __configSet: typeof window.electronAPI.config.set }).__configSet;
        });
      }
    });

    await test.step('a failed knowledge graph rebuild toasts "Couldn\'t rebuild the index"', async () => {
      await clearToasts(page);
      await page.evaluate(() => {
        window.electronAPI.knowledgeGraph.rebuildIndex = async () => {
          throw new Error("Error invoking remote method 'knowledgeGraph:rebuildIndex': Error: index is locked");
        };
        window.electronAPI.knowledgeGraph.rebuildPlan = async () => ({ summariesToRewrite: 0 });
      });
      await tabs.getByRole('button', { name: 'Knowledge Graph', exact: true }).click();
      await page.locator('[data-testid="knowledge-graph-rebuild-index"]').click();
      await expect(toastTitled(page, "Couldn't rebuild the index")).toBeVisible({ timeout: 5000 });
    });

    // Close the panel at document level, since focus may sit in a control.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(page.locator('h2:has-text("Settings")')).toBeHidden({ timeout: 5000 });
    await clearToasts(page);
  });

  test('Command Terminal: command_terminal/spawn reports a start that never reached a handler', async () => {
    await clearReports(page);
    await page.evaluate((message) => {
      window.electronAPI.sessions.spawnTransient = async () => { throw new Error(message); };
    }, noHandlerMessage('session:spawnTransient'));
    await page.keyboard.press('Control+Shift+P');
    await expect(toastTitled(page, "Couldn't start Command Terminal")).toBeVisible({ timeout: 5000 });
    await expectOneReport(page, { area: 'command_terminal', operation: 'spawn', errorName: 'Error' });
  });

  test('Board Manager: an icon map that did not load reports icon_picker/catalog_load, and the picker says so', async () => {
    await clearReports(page);
    await clearToasts(page);
    const catalogChunk = chunkNamed('/icon-catalog');
    const abortChunk = (route: Route): Promise<void> => route.abort();
    await page.route(catalogChunk, abortChunk);
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    try {
      await page.locator('[data-swimlane-name="Planning"]').locator('text=Planning').click();
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await page.locator('[data-testid="board-manager-icon"]').click();
      await expect(page.getByTestId('icon-picker-failed')).toBeVisible({ timeout: 5000 });
      await expectOneReport(page, { area: 'icon_picker', operation: 'catalog_load', errorName: 'TypeError' });
    } finally {
      await page.unroute(catalogChunk, abortChunk);
    }
    // Close the picker, then the manager, at document level since focus may sit in a control.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(page.getByTestId('icon-picker-failed')).toBeHidden({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    const discardButton = page.locator('button', { hasText: 'Discard' });
    if (await discardButton.isVisible({ timeout: 500 }).catch(() => false)) await discardButton.click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });

  test('Projects: a config load that throws in the renderer reports projects/switch_load, and the new board still paints', async () => {
    await clearReports(page);
    await clearToasts(page);
    await page.evaluate((message) => {
      const { config } = (window as unknown as {
        __zustandStores: { config: { getState: () => { loadConfig: unknown }; setState: (patch: Record<string, unknown>) => void } };
      }).__zustandStores;
      (window as unknown as { __loadConfig: unknown }).__loadConfig = config.getState().loadConfig;
      config.setState({ loadConfig: async () => { throw new TypeError(message); } });
    }, LEAKY_TYPE_ERROR_MESSAGE);
    try {
      // Opening another project is a cold switch: its board, backlog and config load together.
      await createProject(page, `Renderer Failure Switch ${Date.now()}`);
      await expect.poll(
        async () => (await readReports(page)).filter((report) => report.tags.op === 'switch_load').length,
        { timeout: 8000 },
      ).toBe(1);
      const report = (await readReports(page)).find((candidate) => candidate.tags.op === 'switch_load');
      expect(report?.tags).toEqual({ source: 'renderer', area: 'projects', op: 'switch_load', error_name: 'TypeError' });
      expect(report?.message).toBe('Handled projects_switch_load failure: TypeError');
      expect(report?.fingerprint).toEqual(['renderer', 'projects', 'switch_load', 'TypeError']);
      expect(JSON.stringify(report)).not.toMatch(/acme/i);
      // The failed load costs the project its restored windows, never the board.
      await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();
    } finally {
      await page.evaluate(() => {
        const { config } = (window as unknown as {
          __zustandStores: { config: { setState: (patch: Record<string, unknown>) => void } };
        }).__zustandStores;
        config.setState({ loadConfig: (window as unknown as { __loadConfig: unknown }).__loadConfig });
      });
    }
  });
});

const PROJECT_ID = 'proj-renderer-failure';
const TASK_ID = 'task-renderer-failure';
const SESSION_ID = 'sess-renderer-failure';
const PROJECT_PATH = '/mock/renderer-failure-test';
const PAGE_URL = 'http://localhost:5173/';

/** One project with the Browser pane on and one running task named with the user's text. */
const SEEDED_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}', name: 'Renderer Failure Seeded', path: '${PROJECT_PATH}',
      github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
    });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };
    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      var id = 'lane-rf-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[lane.name] = id;
      state.swimlanes.push(Object.assign({}, lane, { id: id, position: index, created_at: ts }));
    });
    state.sessions.push({
      id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9996,
      status: 'running', shell: 'bash', cwd: '${PROJECT_PATH}', startedAt: ts, exitCode: null,
    });
    state.activityCache['${SESSION_ID}'] = 'idle';
    state.tasks.push({
      id: '${TASK_ID}', title: '${USER_TEXT}', description: 'A running task',
      swimlane_id: laneIds['Code Review'], position: 0, agent: 'claude', session_id: '${SESSION_ID}',
      worktree_path: '/mock/renderer-failure-worktree', branch_name: 'feature/renderer-failure', pr_number: null, pr_url: null, base_branch: 'main',
      labels: [], priority: 0, archived_at: null, created_at: ts, updated_at: ts,
    });
    // The running task's conversation, which the viewer polls while the session lives.
    var transcriptSeeds = {};
    transcriptSeeds['${SESSION_ID}'] = {
      sessionId: '${SESSION_ID}', taskId: '${TASK_ID}', taskTitle: '${USER_TEXT}',
      agentName: 'Claude Code', startedAt: ts, sessionStatus: 'running',
      source: 'live', sourcePath: '/mock/renderer-failure.jsonl',
      entries: [{ kind: 'user', uuid: 'turn-rf-1', ts: Date.now(), text: 'First turn of the conversation' }],
      degraded: false,
      sessions: [
        { sessionId: '${SESSION_ID}', agentName: 'Claude Code', startedAt: ts, exitedAt: null, isolatedSwimlaneId: null, status: 'running' },
      ],
    };
    return { currentProjectId: '${PROJECT_ID}', transcriptSeeds: transcriptSeeds };
  });
`;

test.describe('failure reports from the renderer, on a running task', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(SEEDED_CONFIG);
    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.evaluate((url) => {
      window.__mockBrowser?.reset();
      window.__mockBrowser?.seedTaskUrl('task-renderer-failure', url);
    }, PAGE_URL);
    await installSink(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('Browser pane and task window: annotations_load keeps the draft, toggle_session reports', async () => {
    const dialog = page.locator('[data-testid="task-detail-dialog"]');

    await test.step('browser/annotations_load reports, and the draft is never discarded on its own', async () => {
      await page.evaluate((message) => {
        const calls: string[] = [];
        (window as unknown as { __discardCalls: string[] }).__discardCalls = calls;
        window.electronAPI.browser.loadAnnotations = async () => { throw new Error(message); };
        window.electronAPI.browser.discardAnnotations = async (taskId: string) => { calls.push(taskId); };
      }, noHandlerMessage('browser:loadAnnotations'));

      await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${USER_TEXT}`).first().click();
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      const pane = page.locator('[data-testid="browser-pane"]');
      if (!(await pane.isVisible().catch(() => false))) await page.locator('[data-testid="browser-toggle"]').click();
      await pane.waitFor({ state: 'visible', timeout: 5000 });

      await expectOneReport(page, { area: 'browser', operation: 'annotations_load', errorName: 'Error' });

      // The failed read leaves the session empty. The old catch let the save effect treat that
      // as "the user cleared everything" and discard the draft on disk. A pending save is sent
      // the moment the pane unmounts, so closing the pane makes a discard happen at once rather
      // than after the debounce, and the assertion needs no fixed wait.
      await page.locator('[data-testid="browser-close"]').click();
      await expect(pane).toBeHidden({ timeout: 5000 });
      const discardCalls = await page.evaluate(() => (window as unknown as { __discardCalls: string[] }).__discardCalls);
      expect(discardCalls).toEqual([]);
    });

    await test.step('task_detail/toggle_session reports a pause that never reached a handler, and toasts', async () => {
      await clearReports(page);
      await clearToasts(page);
      await page.evaluate((message) => {
        window.electronAPI.sessions.suspend = async () => { throw new Error(message); };
      }, noHandlerMessage('session:suspend'));
      await expect(dialog.locator('[data-testid="header-toggle-session-btn"][data-session-state="active"]')).toBeVisible({ timeout: 10000 });
      await dialog.locator('button[aria-label="Pause session"]').click();
      await expect(toastTitled(page, "Couldn't pause session")).toBeVisible({ timeout: 10000 });
      await expectOneReport(page, { area: 'task_detail', operation: 'toggle_session', errorName: 'Error' });
    });
  });

  /** Closes the task's window at the capture-phase shortcut, since an xterm inside it keeps Escape. */
  async function closeTaskWindow(): Promise<void> {
    await page.keyboard.press('Control+Shift+W');
    await expect(page.locator('[data-testid="task-detail-dialog"]')).toBeHidden({ timeout: 8000 });
  }

  /** The task's window, opened fresh from its card: a window an earlier test left behind is closed first. */
  async function openTaskWindow(): Promise<Locator> {
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    if (await dialog.isVisible()) await closeTaskWindow();
    await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${USER_TEXT}`).first().click();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    return dialog;
  }

  test('Task window: a frame hold whose resize fails reports terminal/frame_hold_answer, and the terminal is let go', async () => {
    const dialog = await openTaskWindow();
    await clearToasts(page);
    await dialog.locator('.xterm-screen').waitFor({ timeout: 10000 });
    // The agent on screen, so the terminal mounts, and a full screen, so a grid change has a frame to hold.
    await markSessionFirstOutput(page, SESSION_ID);
    await expect(dialog.locator('[data-testid="launch-overlay"]')).toHaveCount(0);
    let screen = '';
    for (let row = 0; row < 24; row += 1) screen += `frame text line ${row} `.padEnd(100, '.') + '\r\n';
    await fireSessionData(page, SESSION_ID, `${screen}\x1b[?25l`);
    await expect.poll(() => page.evaluate((sessionId) => (window as unknown as {
      __kangenticTerminalGridRows: (id: string) => Array<{ viewportRows: string[] }>;
    }).__kangenticTerminalGridRows(sessionId)[0]?.viewportRows.some((row) => row.startsWith('frame text line 23')) ?? false, SESSION_ID), { timeout: 8000 }).toBe(true);
    // The startup fits have all reached the PTY: the resize log stops growing.
    let previousCount = -1;
    await expect.poll(async () => {
      const count = await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length);
      const settled = count === previousCount;
      previousCount = count;
      return settled;
    }, { intervals: [300], timeout: 8000 }).toBe(true);

    await clearReports(page);
    await page.evaluate((message) => {
      const sessionsApi = window.electronAPI.sessions;
      const realResize = sessionsApi.resize;
      (window as unknown as { __realResize: unknown }).__realResize = realResize;
      // Only the first resize fails, which is the hold's. Failing every one leaves the terminal's own
      // re-assert retrying a resize that never lands, which can wedge the page.
      let failed = false;
      sessionsApi.resize = (sessionId, cols, rows) => {
        if (failed) return realResize.call(sessionsApi, sessionId, cols, rows);
        failed = true;
        return Promise.reject(new TypeError(message));
      };
    }, LEAKY_TYPE_ERROR_MESSAGE);
    const maximize = page.locator('[data-testid="task-detail-maximize"]');
    try {
      await maximize.click();
      await expectOneReport(page, { area: 'terminal', operation: 'frame_hold_answer', errorName: 'TypeError' });
      // The hold ends without an answer, as it does at its cap, and the terminal is not left frozen.
      await expectNoFrameHold(page, 8000);
    } finally {
      await page.evaluate(() => {
        window.electronAPI.sessions.resize = (window as unknown as { __realResize: typeof window.electronAPI.sessions.resize }).__realResize;
      });
    }
    await maximize.click();
    await expectNoFrameHold(page, 8000);
  });

  test('Browser pane: Select element, Draw and Send each report their own failure and keep the user in the pane', async () => {
    const dialog = await openTaskWindow();
    await clearToasts(page);
    // The pane's draft load answered with a failure in the first test, which this one does not drive.
    await page.evaluate(() => { window.electronAPI.browser.loadAnnotations = async () => null; });
    const pane = page.locator('[data-testid="browser-pane"]');
    if (!(await pane.isVisible().catch(() => false))) await dialog.locator('[data-testid="browser-toggle"]').click();
    await pane.waitFor({ state: 'visible', timeout: 5000 });
    await clearReports(page);

    // The UI tier has no guest, so the stand-in gets a scripted `executeJavaScript` whose answers a mode switches.
    await page.evaluate((message) => {
      const webview = document.querySelector('[data-testid="browser-webview"]');
      if (!webview) throw new Error('no webview stub');
      const mode = { inspect: 'wait', scroll: 'plain' };
      (window as unknown as { __guestMode: typeof mode }).__guestMode = mode;
      Object.assign(webview, {
        getURL: () => 'http://localhost:5173/',
        canGoBack: () => false,
        canGoForward: () => false,
        capturePage: () => Promise.resolve({
          toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          getSize: () => ({ width: 1, height: 1 }),
        }),
        executeJavaScript: (code: string) => {
          if (code.includes('__kangenticInspectActive = true')) {
            return mode.inspect === 'fail' ? Promise.reject(new TypeError(message)) : new Promise(() => undefined);
          }
          if (code.includes('__kangenticInspectActive = false')) return Promise.resolve();
          if (code.includes('.render(')) return Promise.resolve({ scrollX: 0, scrollY: 0, width: 800, height: 600, url: 'http://localhost:5173/', items: {} });
          // A scroll position whose arithmetic is a TypeError: BigInt does not mix with a number.
          if (code.includes('.scroll()')) return Promise.resolve(mode.scroll === 'bigint' ? { x: BigInt(1), y: BigInt(1) } : { x: 0, y: 0 });
          return Promise.resolve('');
        },
      });
    }, LEAKY_TYPE_ERROR_MESSAGE);
    const sendError = page.locator('[data-testid="browser-send-error"]');

    await test.step('browser/inspect reports a pick script that throws, and the mode ends with a line saying so', async () => {
      await page.evaluate(() => { (window as unknown as { __guestMode: { inspect: string } }).__guestMode.inspect = 'fail'; });
      await page.locator('[data-testid="browser-inspect-toggle"]').click();
      await expectOneReport(page, { area: 'browser', operation: 'inspect', errorName: 'TypeError' });
      await expect(sendError).toBeVisible();
      await expect(page.locator('[data-testid="browser-inspect-toggle"]')).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('browser/stroke_end reports a stroke that cannot become a mark, and no annotation appears', async () => {
      await clearReports(page);
      await page.evaluate(() => { (window as unknown as { __guestMode: { scroll: string } }).__guestMode.scroll = 'bigint'; });
      const draw = page.locator('[data-testid="browser-draw-toggle"]');
      await draw.click();
      await expect(draw).toHaveAttribute('aria-pressed', 'true');
      const box = await page.locator('[data-testid="browser-overlay"]').boundingBox();
      if (!box) throw new Error('no draw canvas');
      await page.mouse.move(box.x + 60, box.y + 120);
      await page.mouse.down();
      await page.mouse.move(box.x + 150, box.y + 160, { steps: 4 });
      await page.mouse.up();
      await expectOneReport(page, { area: 'browser', operation: 'stroke_end', errorName: 'TypeError' });
      await expect(page.locator('[data-testid="annotation-row-1"]')).toHaveCount(0);
      await draw.click();
      await expect(draw).toHaveAttribute('aria-pressed', 'false');
      await page.evaluate(() => { (window as unknown as { __guestMode: { scroll: string } }).__guestMode.scroll = 'plain'; });
    });

    await test.step('browser/send_to_agent reports a send that never reached a handler, and toasts', async () => {
      await clearReports(page);
      await clearToasts(page);
      await page.evaluate((message) => window.__mockBrowser?.failCaptureWith(message), noHandlerMessage('browser:captureAndSend'));
      try {
        await pane.locator('[data-testid="browser-send"]').click();
        await expect(toastTitled(page, "Couldn't send to agent")).toBeVisible({ timeout: 5000 });
        await expectOneReport(page, { area: 'browser', operation: 'send_to_agent', errorName: 'Error' });
        await expect(sendError).toBeVisible();
      } finally {
        await page.evaluate(() => window.__mockBrowser?.failCaptureWith(null));
      }
    });

    await page.locator('[data-testid="browser-close"]').click();
    await expect(pane).toBeHidden({ timeout: 5000 });
  });

  const NOTES_MARKDOWN = '# Notes heading\n\n```ts\nconst answer = 42;\n```\n';
  /** A second file whose preview asks for one repo image, named as a user would name it. */
  const SHOTS_MARKDOWN = `# Shots heading\n\n![${USER_TEXT} diagram](diagram.png)\n`;
  const NOTES_DIFF = {
    files: [
      { path: 'NOTES.md', status: 'A', insertions: 5, deletions: 0, binary: false, original: '', modified: NOTES_MARKDOWN, language: 'markdown' },
      { path: 'SHOTS.md', status: 'A', insertions: 3, deletions: 0, binary: false, original: '', modified: SHOTS_MARKDOWN, language: 'markdown' },
    ],
  };

  test('Changes panel: a markdown preview reports a pipeline that did not load, then a colorizer that throws, and shows the text', async () => {
    const dialog = await openTaskWindow();
    await clearToasts(page);
    await clearReports(page);
    // Set before the file is picked: picking a markdown file starts the pipeline's load at once.
    const pipelineChunk = chunkNamed('markdown-document-pipeline');
    const abortChunk = (route: Route): Promise<void> => route.abort();
    await page.route(pipelineChunk, abortChunk);
    await page.evaluate((fixture) => {
      (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = fixture;
    }, NOTES_DIFF);
    const previewToggle = page.locator('[data-testid="diff-markdown-preview"]');
    const preview = page.locator('[data-testid="diff-markdown-preview-content"]');
    try {
      await dialog.locator('[data-testid="changes-toggle"]').click();
      await page.locator('[data-testid="changes-file-row"][data-path="NOTES.md"] button').first().click();
      await expect(previewToggle).toBeVisible({ timeout: 8000 });

      await test.step('markdown/pipeline_load reports the lazy chunk, and the preview renders without it', async () => {
        await previewToggle.click();
        await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(preview.locator('h1')).toHaveText('Notes heading', { timeout: 8000 });
        await expectOneReport(page, { area: 'markdown', operation: 'pipeline_load', errorName: 'TypeError' });
      });
    } finally {
      await page.unroute(pipelineChunk, abortChunk);
    }

    await test.step('markdown/code_colorize reports a colorizer that throws, and the code still shows uncolored', async () => {
      await clearReports(page);
      // The preview mounts again, so the pipeline loads this time and the fenced block asks the colorizer.
      await previewToggle.click();
      await expect(previewToggle).toHaveAttribute('aria-pressed', 'false');
      await page.evaluate((message) => {
        const monaco = (window as unknown as { __monaco?: { editor: { colorize: unknown } } }).__monaco;
        if (!monaco) throw new Error('window.__monaco not exposed');
        (window as unknown as { __realColorize: unknown }).__realColorize = monaco.editor.colorize;
        monaco.editor.colorize = async () => { throw new TypeError(message); };
      }, LEAKY_TYPE_ERROR_MESSAGE);
      try {
        await previewToggle.click();
        await expect(previewToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(preview.locator('h1')).toHaveText('Notes heading', { timeout: 8000 });
        await expectOneReport(page, { area: 'markdown', operation: 'code_colorize', errorName: 'TypeError' });
        await expect(preview.locator('pre')).toContainText('const answer = 42;');
      } finally {
        await page.evaluate(() => {
          const monaco = (window as unknown as { __monaco?: { editor: { colorize: unknown } } }).__monaco;
          if (monaco) monaco.editor.colorize = (window as unknown as { __realColorize: unknown }).__realColorize;
        });
      }
    });

    // The image read is an IPC call and then the renderer's own work on the answer. An answer
    // the renderer cannot read fails in that second half, which main never sees.
    await test.step('markdown/image_load reports an image answer the preview cannot read, and shows the alt text', async () => {
      await clearReports(page);
      await page.evaluate(() => {
        const git = window.electronAPI.git as unknown as { fileImage: unknown };
        (window as unknown as { __realFileImage: unknown }).__realFileImage = git.fileImage;
        git.fileImage = async () => undefined;
      });
      try {
        await page.locator('[data-testid="changes-file-row"][data-path="SHOTS.md"] button').first().click();
        await expect(previewToggle).toBeVisible({ timeout: 8000 });
        if ((await previewToggle.getAttribute('aria-pressed')) !== 'true') await previewToggle.click();
        await expect(preview.locator('h1')).toHaveText('Shots heading', { timeout: 8000 });
        await expectOneReport(page, { area: 'markdown', operation: 'image_load', errorName: 'TypeError' });
        await expect(preview).toContainText(`${USER_TEXT} diagram`);
        await expect(preview.locator('img')).toHaveCount(0);
      } finally {
        await page.evaluate(() => {
          const git = window.electronAPI.git as unknown as { fileImage: unknown };
          git.fileImage = (window as unknown as { __realFileImage: unknown }).__realFileImage;
        });
      }
    });

    await page.evaluate(() => { (window as unknown as { __mockGitDiff: unknown }).__mockGitDiff = null; });
    await dialog.locator('[data-testid="changes-toggle"]').click();
    await closeTaskWindow();
  });

  test('Conversation viewer: a live poll that throws in the renderer reports conversation/live_poll', async () => {
    // The first poll tick is 2.5 s after the viewer mounts.
    test.slow();
    await clearToasts(page);
    await page.evaluate((sessionId) => {
      (window as unknown as { __zustandStores: { session: { getState: () => { setConversationSessionId: (id: string | null) => void } } } })
        .__zustandStores.session.getState().setConversationSessionId(sessionId);
    }, SESSION_ID);
    const viewer = page.getByTestId('conversation-window');
    await expect(viewer.getByTestId('conversation-view')).toBeVisible({ timeout: 5000 });
    await clearReports(page);
    await page.evaluate((message) => {
      const transcriptsApi = window.electronAPI.transcripts;
      (window as unknown as { __realTranscriptsGet: unknown }).__realTranscriptsGet = transcriptsApi.get;
      transcriptsApi.get = async () => { throw new TypeError(message); };
    }, LEAKY_TYPE_ERROR_MESSAGE);
    try {
      await expect.poll(async () => (await readReports(page)).length, { timeout: 12_000 }).toBe(1);
      await expectOneReport(page, { area: 'conversation', operation: 'live_poll', errorName: 'TypeError' });
      // What the viewer already holds stays on screen.
      await expect(viewer.getByTestId('conversation-view')).toBeVisible();
    } finally {
      await page.evaluate(() => {
        window.electronAPI.transcripts.get = (window as unknown as { __realTranscriptsGet: typeof window.electronAPI.transcripts.get }).__realTranscriptsGet;
      });
    }
    // Close it the way a user does, so the next test starts on the board.
    await page.keyboard.press('Control+Shift+W');
    await expect(viewer).toHaveCount(0, { timeout: 5000 });
  });

  test('Command Terminal: a resume, its fresh start and a branch switch each report their own failure', async () => {
    if (await page.locator('[data-testid="task-detail-dialog"]').isVisible()) await closeTaskWindow();
    await clearToasts(page);
    await clearReports(page);
    // A spawn that fails by mode: any, only a resume, or only a start on `develop`.
    await page.evaluate(({ message, projectId }) => {
      const sessionsApi = window.electronAPI.sessions;
      const realSpawn = sessionsApi.spawnTransient;
      const host = window as unknown as { __spawnMode: string };
      host.__spawnMode = 'none';
      sessionsApi.spawnTransient = async (input) => {
        const mode = host.__spawnMode;
        const refused = mode === 'all'
          || (mode === 'resume' && Boolean(input.resumeAgentSessionId))
          || (mode === 'branch' && input.branch === 'develop');
        if (refused) throw new TypeError(message);
        return realSpawn(input);
      };
      const now = Date.now();
      (window as unknown as { __mockCommandTerminalHistory: Record<string, unknown[]> }).__mockCommandTerminalHistory = {
        [projectId]: [1, 2].map((index) => ({
          agentSessionId: `conversation-${index}`,
          label: `Conversation ${index}`,
          firstPrompt: null,
          agentName: 'claude',
          endedAt: new Date(now - index * 60 * 60 * 1000).toISOString(),
        })),
      };
    }, { message: LEAKY_TYPE_ERROR_MESSAGE, projectId: PROJECT_ID });
    const setSpawnMode = (mode: string) => page.evaluate((next) => {
      (window as unknown as { __spawnMode: string }).__spawnMode = next;
    }, mode);
    const commandWindow = page.getByTestId('command-terminal-window');
    const resumeRow = async (agentSessionId: string): Promise<void> => {
      const row = page.locator(`[data-testid="command-terminal-earlier-row"][data-agent-session-id="${agentSessionId}"]`);
      await row.click({ button: 'right' });
      await page.getByTestId('command-terminal-earlier-menu-resume').click();
    };

    await page.keyboard.press('Control+Shift+P');
    await expect(commandWindow).toHaveCount(1, { timeout: 5000 });
    await expect(page.getByTestId('command-terminal-earlier-row')).toHaveCount(2, { timeout: 5000 });

    await test.step('command_terminal/resume_in_place reports a resume that throws, and a fresh terminal takes its place', async () => {
      await setSpawnMode('resume');
      await resumeRow('conversation-1');
      await expect(toastTitled(page, "Couldn't resume conversation")).toBeVisible({ timeout: 5000 });
      await expectOneReport(page, { area: 'command_terminal', operation: 'resume_in_place', errorName: 'TypeError' });
      await expect(commandWindow).toHaveCount(1);
    });

    await test.step('command_terminal/start_after_refused_resume reports the fresh start that fails too, and the window goes', async () => {
      await clearReports(page);
      await clearToasts(page);
      await setSpawnMode('all');
      await resumeRow('conversation-2');
      await expectReports(page, [
        { area: 'command_terminal', operation: 'resume_in_place', errorName: 'TypeError' },
        { area: 'command_terminal', operation: 'start_after_refused_resume', errorName: 'TypeError' },
      ]);
      await expect(commandWindow).toHaveCount(0, { timeout: 5000 });
    });

    await test.step('command_terminal/branch_switch reports a respawn that throws', async () => {
      await clearReports(page);
      await clearToasts(page);
      await setSpawnMode('none');
      await page.keyboard.press('Control+Shift+P');
      await expect(commandWindow).toHaveCount(1, { timeout: 5000 });
      await setSpawnMode('branch');
      await page.getByTestId('branch-picker-chip').click();
      await page.locator('button:has-text("develop")').click();
      await expect(toastTitled(page, "Couldn't switch branch")).toBeVisible({ timeout: 5000 });
      await expectOneReport(page, { area: 'command_terminal', operation: 'branch_switch', errorName: 'TypeError' });
    });
  });
});

test.describe('failure reports from the renderer, on a first launch', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    // The suggestion asks main at mount, before any sink can be installed, so the answer is
    // held until the test lets it fail. Every call gets the one held answer.
    const result = await launchPage({
      beforeLoad: async (launchedPage) => {
        await launchedPage.addInitScript((message) => {
          let fail: (error: Error) => void = () => undefined;
          const held = new Promise<never>((_resolve, reject) => { fail = reject; });
          held.catch(() => undefined);
          (window as unknown as { __failLanguageInfo: () => void }).__failLanguageInfo = () => fail(new TypeError(message));
          window.electronAPI.language.getInfo = () => held;
        }, LEAKY_TYPE_ERROR_MESSAGE);
      },
    });
    browser = result.browser;
    page = result.page;
    await installSink(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('language/suggestion reports a system language that could not be read, and the app starts as it was', async () => {
    await page.evaluate(() => (window as unknown as { __failLanguageInfo: () => void }).__failLanguageInfo());
    await expectOneReport(page, { area: 'language', operation: 'suggestion', errorName: 'TypeError' });
    // No offer is raised, and nothing else about the first launch changed.
    expect(await toastCountRightNow(page)).toBe(0);
  });
});
