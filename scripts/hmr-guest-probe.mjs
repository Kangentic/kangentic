/**
 * HMR guest-survival probe.
 *
 * Answers one question empirically, before and after a fix: does editing a
 * renderer source file destroy a live Browser pane guest?
 *
 * Why this exists. The dogfooded `npm start` app resets an agent's browser
 * whenever certain source files are saved. The suspected cause (a Zustand store
 * re-eval handing part of the tree a SECOND, empty store) turned out to be wrong:
 * the renderer PAGE fully reloads, which destroys every guest and every
 * `import.meta.hot.data` pin along with it. Distinguishing those two mechanisms
 * by eye is not possible - a remounted pane looks identical on screen - so this
 * probe reads the registered `webContentsId` instead, exactly as the
 * browser-pane UI specs do.
 *
 * What it does:
 *   1. Starts a Vite dev server on the real renderer config (the same one
 *      `npx vite` and the UI test tier use), with a logger that captures Vite's
 *      OWN reload reason. That reason prints to the dev-server terminal, which
 *      is why a /preview session cannot show it.
 *   2. Loads the renderer in headless Chromium against tests/ui/mock-electron-api.js,
 *      opens a task, mounts its Browser pane, and registers a guest webContents.
 *   3. Optionally HIDES the pane, which is the state #568 widened: the guest stays
 *      mounted behind the terminal, so a reload kills a pane the user cannot see.
 *   4. Stamps a sentinel on `window`, makes a COMMENT-ONLY edit to the target
 *      source file, waits for HMR to settle, and reports what survived.
 *
 * The verdict is the sentinel plus the webContentsId, not a screenshot: a page
 * reload wipes the sentinel, and a remount changes the id.
 *
 * Usage (from the repo root):
 *   node scripts/hmr-guest-probe.mjs
 *   node scripts/hmr-guest-probe.mjs --file src/renderer/stores/board-store/task-slice.ts
 *   node scripts/hmr-guest-probe.mjs --show      (leave the pane visible instead of held)
 *   node scripts/hmr-guest-probe.mjs --keep-edit (skip the file restore, for bisecting)
 *
 * Exit code 0 means the guest survived, 1 means it was destroyed, 2 means the
 * probe could not set up its fixture.
 */
import { createServer, createLogger } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const mockScript = path.join(projectRoot, 'tests', 'ui', 'mock-electron-api.js');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
}
const targetRelativePath = argValue(
  '--file',
  'src/renderer/stores/session-store/task-changes-panel-slice.ts',
);
const holdPane = !args.includes('--show');
const keepEdit = args.includes('--keep-edit');
const settleMs = Number(argValue('--settle', '5000'));

const targetPath = path.join(projectRoot, targetRelativePath);
if (!fs.existsSync(targetPath)) {
  console.error(`[probe] target file not found: ${targetRelativePath}`);
  process.exit(2);
}

const PROJECT_ID = 'proj-hmr-probe';
const TASK_ID = 'task-hmr-probe';
const SESSION_ID = 'sess-hmr-probe';
const PROJECT_PATH = '/mock/hmr-probe';
const GUEST_WEB_CONTENTS_ID = 7373;
const TASK_TITLE = 'HMR Probe Task';

const preConfigScript = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'HMR Probe',
      path: '${PROJECT_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.projectConfigs['${PROJECT_PATH}'] = { browser: { enabled: true } };

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      var id = 'lane-probe-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[lane.name] = id;
      state.swimlanes.push(Object.assign({}, lane, { id: id, position: index, created_at: ts }));
    });

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9871,
      status: 'running',
      shell: 'bash',
      cwd: '${PROJECT_PATH}',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: '${TASK_TITLE}',
      description: 'Holds a registered Browser pane guest across an HMR edit.',
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

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

/** Vite prints its reload decision through the logger, not to the HMR socket. */
const serverLogLines = [];
const baseLogger = createLogger('info', { allowClearScreen: false });
const capturingLogger = {
  ...baseLogger,
  info(message, options) {
    serverLogLines.push(message);
    baseLogger.info(message, options);
  },
  warn(message, options) {
    serverLogLines.push(message);
    baseLogger.warn(message, options);
  },
  error(message, options) {
    serverLogLines.push(message);
    baseLogger.error(message, options);
  },
};

const originalSource = fs.readFileSync(targetPath, 'utf-8');
let server;
let browser;
let restored = false;

function restoreTarget() {
  if (restored || keepEdit) return;
  fs.writeFileSync(targetPath, originalSource, 'utf-8');
  restored = true;
}
process.on('SIGINT', () => { restoreTarget(); process.exit(130); });

async function main() {
  console.log(`[probe] target        : ${targetRelativePath}`);
  console.log(`[probe] pane state    : ${holdPane ? 'HIDDEN (held)' : 'showing'}`);

  // Mirror scripts/dev.js's inline worktree config rather than vite.config.mts.
  // That is not a preference, it is required for the probe to see anything:
  // vite.config.mts ignores the RELATIVE glob '**/.kangentic/**', and a worktree
  // checkout lives at <repo>/.kangentic/worktrees/<n>, so that glob swallows the
  // entire source tree and the watcher never fires. dev.js builds the same
  // ignores from ABSOLUTE paths, so it only ignores <worktree>/.kangentic. The
  // dogfooded `npm start` runs dev.js, so this is also the faithful config.
  const optimizeDepsInclude = JSON.parse(
    fs.readFileSync(path.join(scriptDir, 'renderer-optimize-deps.json'), 'utf-8'),
  );
  const ignored = ['.kangentic', '.claude', '.codex', '.aider', '.vite', 'docs', 'tests']
    .map((dir) => `${path.join(projectRoot, dir).replace(/\\/g, '/')}/**`);

  server = await createServer({
    configFile: false,
    root: projectRoot,
    cacheDir: path.join(projectRoot, '.kangentic', 'vite-cache-probe'),
    customLogger: capturingLogger,
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: { '@shared': '/src/shared', '@kangentic/protocol': '/packages/protocol/src' },
      preserveSymlinks: true,
    },
    optimizeDeps: { include: optimizeDepsInclude },
    define: { __KANGENTIC_DEV__: 'true' },
    server: { port: 5399, strictPort: false, watch: { ignored } },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('Vite did not report a local URL');
  console.log(`[probe] dev server    : ${url}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const clientConsole = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('[vite]') || text.includes('Fast Refresh')) clientConsole.push(text);
  });
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

  await page.addInitScript({ path: mockScript });
  await page.addInitScript(preConfigScript);
  await page.goto(url);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 30000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 20000 });

  // Mount the pane and register a guest, mirroring tests/ui/browser-pane-hold-on-hide.spec.ts.
  await page.evaluate((taskId) => {
    window.__mockBrowser?.reset();
    window.__mockBrowser?.seedTaskUrl(taskId, 'http://localhost:1/');
  }, TASK_ID);

  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${TASK_TITLE}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 10000 });

  const pane = page.locator('[data-testid="browser-pane"]');
  if (!(await pane.isVisible().catch(() => false))) {
    await page.locator('[data-testid="browser-toggle"]').click();
  }
  await pane.waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('[data-testid="browser-webview"]').waitFor({ state: 'attached', timeout: 10000 });

  await page.evaluate((webContentsId) => {
    const element = document.querySelector('[data-testid="browser-webview"]');
    if (!element) throw new Error('browser-webview not in DOM');
    const stub = element;
    stub.getWebContentsId = () => webContentsId;
    stub.getURL = () => 'http://localhost:1/';
    element.dispatchEvent(new Event('dom-ready'));
  }, GUEST_WEB_CONTENTS_ID);

  const readState = () => page.evaluate((taskId) => {
    const stores = window.__zustandStores;
    const session = stores.session.getState();
    const guest = session.browserGuestTasks.get(taskId);
    return {
      guestWebContentsId: guest === undefined ? null : guest,
      open: session.browserOpenTasks.has(taskId),
      held: session.browserHeldTasks.has(taskId),
      sentinel: window.__hmrProbeSentinel ?? null,
      unregisters: (window.__mockBrowser?.getPaneCalls() ?? [])
        .filter((call) => call.type === 'unregister').length,
      registers: (window.__mockBrowser?.getPaneCalls() ?? [])
        .filter((call) => call.type === 'register').length,
      // The raw tail tells unmount (unregister, no re-register) apart from an
      // effect RE-RUN (unregister then register of the same id) - which look
      // identical in the counts but are completely different bugs.
      calls: (window.__mockBrowser?.getPaneCalls() ?? []).slice(-6).map((call) =>
        `${call.type}:${call.webContentsId ?? call.input?.webContentsId ?? '?'}`),
      paneMounted: !!document.querySelector('[data-testid="browser-webview"]'),
      // The probe injects getWebContentsId onto the guest stub AFTER mount. If the
      // element in the DOM no longer carries it, React built a NEW one - i.e. the
      // pane remounted, which in real Electron kills the guest. Same element with
      // the stub intact means the DOM survived and only the effect re-ran.
      sameElement: typeof document.querySelector('[data-testid="browser-webview"]')
        ?.getWebContentsId === 'function',
    };
  }, TASK_ID);

  await page.waitForFunction((taskId) => {
    const stores = window.__zustandStores;
    return stores?.session.getState().browserGuestTasks.has(taskId);
  }, TASK_ID, { timeout: 10000 });

  if (holdPane) {
    await page.locator('[data-testid="browser-toggle"]').click();
    await page.waitForFunction((taskId) => {
      const stores = window.__zustandStores;
      return stores.session.getState().browserHeldTasks.has(taskId);
    }, TASK_ID, { timeout: 10000 });
  }

  await page.evaluate(() => {
    window.__hmrProbeSentinel = 'alive';
    // Record the exact commit at which the guest node leaves the DOM, together
    // with the store flags that decide whether the slot renders. A remount is
    // otherwise indistinguishable from a survivor after the fact.
    window.__paneWatch = [];
    const stores = window.__zustandStores;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (!node.matches?.('[data-testid="browser-webview"]')
            && !node.querySelector?.('[data-testid="browser-webview"]')) continue;
          const state = stores.session.getState();
          window.__paneWatch.push({
            open: [...state.browserOpenTasks],
            held: [...state.browserHeldTasks],
            guests: [...state.browserGuestTasks.keys()],
            removedTag: node.tagName,
          });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const before = await readState();
  if (before.guestWebContentsId === null) {
    console.error('[probe] fixture failed: no guest registered');
    return 2;
  }
  console.log(`[probe] before        : guest=${before.guestWebContentsId} open=${before.open} held=${before.held}`);

  const navigationsBefore = navigations;
  clientConsole.length = 0;
  serverLogLines.length = 0;

  // The trigger: a comment-only edit. Nothing about the module's behavior changes.
  fs.writeFileSync(
    targetPath,
    `${originalSource}\n// hmr-guest-probe touch ${Date.now()}\n`,
    'utf-8',
  );
  console.log('[probe] edit written  : comment-only append');

  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const after = await readState();

  const reloaded = after.sentinel !== 'alive' || navigations > navigationsBefore;
  const guestSurvived = after.guestWebContentsId === before.guestWebContentsId;

  const invalidations = clientConsole.filter((line) => line.includes('invalidate'));
  const hotUpdates = clientConsole.filter((line) => line.includes('hot updated')).length;
  const reloadReasons = serverLogLines.filter((line) => /reload|circular/i.test(line));

  console.log('');
  console.log('=== RESULT ===============================================');
  console.log(`page reloaded         : ${reloaded ? 'YES' : 'no'}`);
  console.log(`guest survived        : ${guestSurvived ? 'YES' : 'NO'}  (${before.guestWebContentsId} -> ${after.guestWebContentsId ?? 'gone'})`);
  console.log(`held flag survived    : ${before.held ? (after.held ? 'YES' : 'NO') : 'n/a'}`);
  console.log(`pane unregisters      : ${after.unregisters - before.unregisters}`);
  console.log(`pane re-registers     : ${after.registers - before.registers}`);
  console.log(`webview still in DOM  : ${after.paneMounted ? 'yes' : 'NO'}`);
  console.log(`same webview element  : ${after.sameElement ? 'yes (effect re-ran)' : 'NO (pane REMOUNTED)'}`);
  console.log(`pane call tail        : ${after.calls.join(' -> ') || '(none)'}`);
  const watch = await page.evaluate(() => window.__paneWatch ?? []);
  console.log(`guest node removals   : ${watch.length}`);
  for (const record of watch) {
    console.log(`   removed <${record.removedTag}> with open=[${record.open}] held=[${record.held}] guests=[${record.guests}]`);
  }
  console.log(`modules hot updated   : ${hotUpdates}`);
  console.log('');
  console.log(`vite reload reason    : ${reloadReasons.length ? '' : '(none logged)'}`);
  for (const line of reloadReasons) console.log(`   ${line.trim()}`);
  console.log('');
  console.log(`fast-refresh bailouts : ${invalidations.length}`);
  for (const line of invalidations) console.log(`   ${line.replace(/\s+Learn more.*$/, '').trim()}`);
  console.log('==========================================================');

  return guestSurvived ? 0 : 1;
}

let exitCode = 2;
try {
  exitCode = await main();
} catch (error) {
  console.error('[probe] failed:', error);
  exitCode = 2;
} finally {
  restoreTarget();
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}
process.exit(exitCode);
