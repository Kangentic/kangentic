/**
 * UI coverage for the `loading` half of the `hasResolvedRef` guard in
 * useBrowserUrl.ts: `if (!hasResolvedRef.current) setLoading(true);`.
 *
 * useBrowserUrl re-fetches whenever its `projectId` argument changes. A
 * task-detail window can only receive a NEW `projectId` for an already-open
 * task in one real scenario: the retained-Browser-pane project switch. When
 * the outgoing project is backgrounded, `TaskDetailBody` computes
 * `paneProjectId = retainedProjectId ?? projectId` on every render, and
 * `retainedProjectId` is not set until `useProjectSwitchEffect`'s effect runs
 * `retainWindows(...)`. React fires child effects before parent effects
 * within the same commit, so `BrowserPaneActive`'s registration effect and
 * `useBrowserUrl`'s fetch effect (both descendants of the window whose
 * ancestor mounts `useProjectSwitchEffect`) see the WRONG (incoming) project
 * before the parent effect corrects `retainedProjectId` back to the outgoing
 * project. This is not a synthetic reproduction: it is the literal mechanism
 * the guard's own code comment describes ("a project switch re-runs this
 * effect... the resulting one-commit flicker recreated the guest with a new
 * webContentsId"), driven end-to-end through a real project switch rather
 * than by forcing internal hook state.
 *
 * Without the guard, `setLoading(true)` fires unconditionally on the
 * wrong-project re-fetch, and `BrowserPane` renders its active subtree only
 * while `!loading` - so the spinner branch unmounts `BrowserPaneActive`,
 * destroying the `<webview>` guest. The remount gets a FRESH `<webview>`
 * with no injected `getWebContentsId`, so its own immediate registration
 * call silently no-ops (`typeof webview.getWebContentsId !== 'function'`).
 * The result, established empirically (see the two rows below), is that the
 * LAST `registerPane` call recorded for this pane never reflects the
 * settled project once the guard is broken - the discriminator this test
 * asserts on, per browser-pane-registration.spec.ts's established oracle
 * that a DOM-presence check cannot tell "the same guest survived" from "a
 * new guest was silently swapped in".
 *
 * Why NOT "no unregister for this webContentsId" (browser-pane-registration
 * .spec.ts's oracle for a *synthetic* zoom broadcast): the registration
 * effect here is independently keyed on `[sessionId, taskId, projectId]`
 * (BrowserPane.tsx), so it re-registers on every `paneProjectId` flip even
 * when the guard is fully intact and the underlying <webview> never moves -
 * that is correct behavior (the MCP routing metadata must track the owning
 * project), not a defect. A guarded run produces THREE register calls
 * (A, B, A), all for the SAME webContentsId, via legitimate
 * unregister+register metadata refreshes; asserting "exactly one register"
 * or "zero unregisters" fails against the correct implementation. What
 * distinguishes broken from correct is whether the pane's registration ever
 * stops tracking reality - i.e. whether the LAST register call settles on
 * the right project and the right (never-replaced) guest:
 *
 *   guarded (correct):  registers = [A, B, A]  -> last = { A, 8181 } (PASS)
 *   loading guard removed: registers = [A, B]     -> last = { B, 8181 } (FAIL)
 *
 * Coverage note (guard 2, NOT covered here): the sibling line -
 * `if (hasResolvedRef.current && result.projectDefault === null &&
 * result.taskOverride === null) return;` - guards against a stale fetch's
 * result blanking an already-resolved pane. Empirically, removing ONLY that
 * line against this exact retained-pane-switch scenario produces a
 * byte-identical call log to the guarded run: the whole A -> B -> A
 * `projectId` flip completes synchronously inside one effect flush
 * (`retainWindows` is a synchronous `setState` call inside
 * `useProjectSwitchEffect`), so by the time the wrong-project fetch's
 * `.then()` microtask runs, that effect run's own cleanup has already set
 * `cancelled = true` - the existing `if (cancelled) return;` (unrelated to
 * `hasResolvedRef`) already discards the stale result before guard 2's line
 * is ever reached. Guard 2 is therefore NOT reachable via this project-switch
 * path; it may exist for a different settle path this test does not
 * construct (e.g. a mount that lands on a null-null project and stays
 * there, on a host other than the board's retained window). That gap is
 * unaddressed here and is a candidate for follow-up if such a path exists.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'proj-browser-refetch-a';
const PROJECT_B_ID = 'proj-browser-refetch-b';
const PROJECT_A_NAME = 'Browser Refetch Guard Origin';
const PROJECT_B_NAME = 'Browser Refetch Guard Elsewhere';
const PROJECT_A_PATH = '/mock/browser-refetch-guard-a';
const PROJECT_B_PATH = '/mock/browser-refetch-guard-b';
const TASK_ID = 'task-browser-refetch-guard';
const SESSION_ID = 'sess-browser-refetch-guard';
const PROJECT_DEFAULT_URL = 'http://localhost:5173/';
// Synthetic webContentsId injected onto the <webview> stub to simulate a real
// Electron guest attaching. Must be a positive integer (the real guard checks
// `Number.isInteger(webContentsId) && webContentsId > 0`).
const MOCK_WEB_CONTENTS_ID = 8181;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_A_ID}',
      name: '${PROJECT_A_NAME}',
      path: '${PROJECT_A_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.projects.push({
      id: '${PROJECT_B_ID}',
      name: '${PROJECT_B_NAME}',
      path: '${PROJECT_B_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    // Project A resolves the pane's effective URL from its project default,
    // never from a task override (see the file-header comment on why).
    state.projectConfigs['${PROJECT_A_PATH}'] = {
      browser: { enabled: true, defaultUrl: '${PROJECT_DEFAULT_URL}' },
    };
    // Project B deliberately has no browser override at all, so a fetch
    // resolved against it returns { projectDefault: null, taskOverride: null }.

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-refetch-guard-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_A_ID}',
      pid: 8180,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_A_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    // Explicit projectId so the mock's task list correctly scopes this task
    // to project A and it never appears on project B's board.
    state.tasks.push({
      id: '${TASK_ID}',
      projectId: '${PROJECT_A_ID}',
      title: 'Browser Refetch Guard Task',
      description: 'Used to drive the useBrowserUrl refetch-guard race',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_A_ID}' };
  });
`;

/** Minimal typed view of the window-manager store surface this spec reads. */
interface TestWindow {
  __zustandStores?: {
    window?: {
      getState: () => {
        windows: Record<string, { anchor: string; retainedProjectId?: string }>;
      };
    };
  };
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

test.describe('useBrowserUrl refetch guard (retained-pane project switch)', () => {
  test('a resolved pane survives the outgoing-project switch race: same guest, no reload', async () => {
    const { browser, page } = await launch();

    try {
      const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Browser Refetch Guard Task').first();
      await card.click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // The project default is already seeded, so the pane resolves straight
      // into the active branch on the first toggle - no empty-state detour.
      await page.locator('[data-testid="browser-toggle"]').click();
      await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });

      // Register the guest exactly like browser-pane-registration.spec.ts:
      // inject getWebContentsId/getURL onto the plain HTMLElement stub, then
      // fire the dom-ready listener the registration effect attached on mount.
      await page.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 5000 });
      await page.evaluate((webContentsId: number) => {
        const element = document.querySelector('[data-testid="browser-webview"]');
        if (!element) throw new Error('browser-webview element not found in DOM');
        const stub = element as HTMLElement & { getWebContentsId: () => number; getURL: () => string };
        stub.getWebContentsId = () => webContentsId;
        stub.getURL = () => PROJECT_DEFAULT_URL;
        element.dispatchEvent(new Event('dom-ready'));
      }, MOCK_WEB_CONTENTS_ID);

      await expect
        .poll(
          () => page.evaluate((expectedId: number) => {
            const calls = window.__mockBrowser?.getPaneCalls() ?? [];
            return calls.some((call) => call.type === 'register' && call.input.webContentsId === expectedId);
          }, MOCK_WEB_CONTENTS_ID),
          { timeout: 5000 },
        )
        .toBe(true);

      // Switch to Project B. This is a real project switch through the same
      // sidebar interaction a user makes - the retention race described in
      // the file header comment is a byproduct of this switch, not something
      // the test has to force.
      await page.locator(`[role="button"]:has-text("${PROJECT_B_NAME}")`).click();

      // Settle signal: `retainWindows` marks the window synchronously inside
      // useProjectSwitchEffect's effect, in the SAME commit's effect flush as
      // the wrong-project child effect that triggers the stray refetch. By
      // the time this resolves true, both the wrong-project fetch and the
      // corrective re-fetch (both plain microtask-resolved mock promises)
      // have already run to completion, since a page.evaluate round trip
      // cannot observe state until the page's microtask queue has drained.
      await expect
        .poll(
          () => page.evaluate((taskId: string) => {
            const testWindow = window as unknown as TestWindow;
            const windows = testWindow.__zustandStores?.window?.getState().windows ?? {};
            const match = Object.values(windows).find((candidate) => candidate.anchor === taskId);
            return match?.retainedProjectId ?? null;
          }, TASK_ID),
          { timeout: 5000 },
        )
        .toBe(PROJECT_A_ID);

      // The discriminator (see the file header for why "register count" and
      // "unregister count" are both wrong invariants here): the LAST
      // registerPane call must reflect the settled project (A) on the SAME
      // never-replaced guest. A guarded run re-registers legitimately as
      // projectId flips (A, B, A) and always lands here; with the loading
      // guard broken, the pane unmounts on the B leg, its remount's webview
      // has no injected getWebContentsId, and B is left as the final entry.
      await expect
        .poll(
          async () => {
            const log = await page.evaluate(() => window.__mockBrowser?.getPaneCalls() ?? []);
            const lastRegister = log.filter((call) => call.type === 'register').at(-1);
            if (!lastRegister || lastRegister.type !== 'register') return null;
            return { projectId: lastRegister.input.projectId, webContentsId: lastRegister.input.webContentsId };
          },
          { timeout: 5000 },
        )
        .toEqual({ projectId: PROJECT_A_ID, webContentsId: MOCK_WEB_CONTENTS_ID });
    } finally {
      await browser.close();
    }
  });
});
