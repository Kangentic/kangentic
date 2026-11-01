/**
 * UI tests for the Command Terminal feature.
 *
 * Tests the TitleBar button visibility, transient session filtering from
 * the terminal panel, and the Ctrl+Shift+P hotkey toggle behavior.
 *
 * Performance note: tests that share the same pre-configured mock state are
 * grouped into a shared browser instance via beforeAll/afterAll. Each test
 * still gets a fresh page state via page.goto() in beforeEach, which re-runs
 * all registered addInitScript callbacks on the context. This avoids the
 * ~1-2 s overhead of chromium.launch() per test while still providing full
 * state isolation between tests.
 *
 * Tests with unique per-test spawnTransient overrides (ContextBar group) and
 * tests with different base pre-configs (TitleBar Button group) keep their
 * own per-test browser launches.
 *
 * Phase 2 change (Multiple terminals): the pulsing `transient-session-indicator`
 * dot was removed. Activity is now surfaced as the COLOR of the title-bar
 * terminal icon (`data-testid="quick-session-icon"`, `data-activity` attribute
 * of `'rest' | 'thinking' | 'idle'`). Tests that previously asserted the dot
 * now assert the icon's data-activity attribute instead:
 *   - "session alive in background" -> data-activity = 'idle' (or NOT 'rest')
 *   - "session killed / no background session" -> data-activity = 'rest'
 * The icon is visible whether the command bar is open OR closed (activity-based,
 * not existence-based).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import {
  waitForViteReady, gotoVite, toastCountRightNow, recordLayoutChange, expectHoldThenDraw, expectNoFrameHold, expectNoFrameHoldRecovery,
  TERMINAL_FRAME_HOLD_SELECTOR, isManagerResizeGateOpen, readTerminalTrace,
} from './helpers';

// Each describe is isolated per worker (separate process; page.goto() in beforeEach resets
// state), so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-cmd-term';
const PROJECT_A_ID = 'proj-cmd-a';
const PROJECT_B_ID = 'proj-cmd-b';
const TASK_SESSION_ID = 'sess-task-1';
const TASK_ID = 'task-1';
const TRANSIENT_SESSION_ID = 'sess-transient-1';

/**
 * Pre-configure mock state with a project, a task session, and a transient session.
 * The transient session has activityCache set to 'idle', so the icon should show
 * data-activity="idle" once the store is hydrated.
 */
function preConfigWithTransientSession(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Test Project',
        path: '/mock/test-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-cmd-' + i,
          position: i,
          created_at: ts,
        }));
      });

      // Regular task session
      state.sessions.push({
        id: '${TASK_SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 2001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/test-project',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });

      // Transient session (command terminal)
      state.sessions.push({
        id: '${TRANSIENT_SESSION_ID}',
        taskId: 'ephemeral-uuid',
        projectId: '${PROJECT_ID}',
        pid: 2002,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/test-project',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        transient: true,
      });

      state.activityCache['${TASK_SESSION_ID}'] = 'idle';
      state.activityCache['${TRANSIENT_SESSION_ID}'] = 'idle';

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Regular Task',
        description: '',
        swimlane_id: 'lane-cmd-0',
        position: 0,
        agent: null,
        session_id: '${TASK_SESSION_ID}',
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
}

/**
 * Pre-configure mock state with two projects for cross-project transient session tests.
 * Starts with Project A active. No transient sessions pre-spawned - tests open them via hotkey.
 */
function twoProjectPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Project Alpha',
        path: '/mock/project-alpha',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Project Beta',
        path: '/mock/project-beta',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-cmd-multi-' + i,
          position: i,
          created_at: ts,
        }));
      });

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

/**
 * The window most of this spec runs in. At 2560 the panel's default place (58%
 * of the area, plus the rail) gives its terminals about 1485px, well over two at
 * the 630px floor, so a seam drag has room either way. The cases for a panel at
 * its minimum and a window too small for the grid set their own viewport.
 */
const GRID_VIEWPORT = { width: 2560, height: 1440 };

/**
 * Launch a fresh browser+context with the given preconfig registered as an init
 * script. The returned browser and context are shared across multiple tests via
 * beforeAll/afterAll. Each test navigates to VITE_URL in beforeEach so the
 * init scripts re-run and state is fully fresh for every test.
 */
async function launchSharedBrowser(preConfigScript: string): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: GRID_VIEWPORT });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, context, page };
}

/**
 * Launch a one-off browser for a single test with a unique preconfig.
 * Used when the preconfig is test-specific (e.g. custom spawnTransient overrides)
 * or when sharing is not safe.
 */
async function launchWithState(
  preConfigScript: string,
  viewport: { width: number; height: number } = GRID_VIEWPORT,
): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * The message a renderer really receives when main throws `errorName` from a Command Terminal
 * start: Electron's invoke wrapper, then the error class, then main's sentence. The UI mock does
 * not decorate a rejection, so a spec whose assertion is the stripped sentence builds the
 * decorated form itself: a plain mock rejection would pass against code that strips nothing.
 */
function decoratedInvokeMessage(errorName: string, sentence: string): string {
  return `Error invoking remote method 'session:spawnTransient': ${errorName}: ${sentence}`;
}

const MULTI_PROJECT_ID = 'proj-multi-term';

/**
 * One project with a counter-based deterministic spawnTransient: each call
 * returns a unique session id, so spawning a 2nd/3rd terminal gets a distinct
 * session. Shared by the "Multiple terminals" and "Window layout parity" groups.
 */
function multiTerminalPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${MULTI_PROJECT_ID}',
        name: 'Multi Terminal Project',
        path: '/mock/multi-terminal',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-multi-' + i,
          position: i,
          created_at: ts,
        }));
      });
      return { currentProjectId: '${MULTI_PROJECT_ID}' };
    });

    // Counter-based deterministic spawn: each call returns a unique session id
    // so the second window gets a different session than the first.
    var spawnCounter = 0;
    window.electronAPI.sessions.spawnTransient = async function (input) {
      spawnCounter += 1;
      var id = 'multi-transient-' + spawnCounter;
      var session = {
        id: id,
        taskId: id,
        projectId: input.projectId,
        pid: null,
        status: 'running',
        shell: '/bin/bash',
        cwd: '/mock/multi-terminal',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        transient: true,
        isolatedSwimlaneId: null,
        agentSessionId: null,
      };
      // Push into mock sessions list so sessions.list() and sessions.killTransient()
      // can find it.
      window.electronAPI.sessions.__mockSessions = window.electronAPI.sessions.__mockSessions || [];
      window.electronAPI.sessions.__mockSessions.push(session);
      return { session: session, branch: 'main' };
    };
  `;
}

const RECONCILE_PROJECT_ID = 'proj-cmd-restart';
const HARD_RELOAD_PROJECT_ID = 'proj-cmd-hard-reload';
const SLOT_MISMATCH_PROJECT_ID = 'proj-cmd-slot-mismatch';
const ORPHAN_RACE_PROJECT_ID = 'proj-cmd-orphan-race';
const BACKGROUND_FOREGROUND_PROJECT_ID = 'proj-cmd-bg-foreground';
const BACKGROUND_PROJECT_ID = 'proj-cmd-bg-background';
const ADOPT_PROJECT_ID = 'proj-cmd-adopt';

/**
 * Init-script fragment that decorates the DEFAULT mock spawnTransient (which
 * returns unique ids and pushes into the real sessions array) to tally spawns
 * per project on `window.__transientSpawnsByProject`. Lets a test assert exactly
 * how many fresh PTYs a project got. page.goto in the shared-browser beforeEach
 * re-runs it, resetting the tally per test.
 */
function spawnCounterSource(): string {
  return `
    var __originalSpawnTransient = window.electronAPI.sessions.spawnTransient;
    window.__transientSpawnsByProject = {};
    window.electronAPI.sessions.spawnTransient = async function (input) {
      window.__transientSpawnsByProject[input.projectId] =
        (window.__transientSpawnsByProject[input.projectId] || 0) + 1;
      return __originalSpawnTransient(input);
    };
  `;
}

/** A version-1 serialized command workspace with two tiled windows, as
 *  `serializeWorkspace` writes the panel's two-up layout after the user dragged
 *  its seam: slot-2 on the LEFT at 0.3 of the width, slot-1 on the right.
 *  Neither is what a fresh layout would give (slot-1 first, an even split), so
 *  a restore that kept them proves the blob was applied. `taskId` is the on-disk
 *  field that carries the slot anchor. */
function twoWindowBlobSource(): string {
  return `{
    version: 1,
    windows: [
      { taskId: 'slot-1', title: 'Command Terminal', geometry: { x: 0, y: 0, w: 1, h: 1 }, restoreGeometry: null, state: 'tiled' },
      { taskId: 'slot-2', title: 'Command Terminal', geometry: { x: 0, y: 0, w: 1, h: 1 }, restoreGeometry: null, state: 'tiled' }
    ],
    tileTree: {
      kind: 'split',
      direction: 'horizontal',
      children: [{ kind: 'leaf', taskId: 'slot-2' }, { kind: 'leaf', taskId: 'slot-1' }],
      sizes: [0.3, 0.7]
    },
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: 'slot-1'
  }`;
}

/** twoProjectPreConfig plus the spawn counter, for the cross-project repro tests. */
function twoProjectSpawnCountingPreConfig(): string {
  return `
    ${twoProjectPreConfig()}
    ${spawnCounterSource()}
  `;
}

/** One project with a persisted 2-window layout blob but NO live sessions: the
 *  app-restart path. On first open the blob restores two windows and reconcile
 *  trims to one (no live session to keep the second). */
function restartBlobPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${RECONCILE_PROJECT_ID}',
        name: 'Restart Project',
        path: '/mock/restart-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-restart-' + i, position: i, created_at: ts }));
      });
      return { currentProjectId: '${RECONCILE_PROJECT_ID}' };
    });
    window.electronAPI.config.set({ commandTerminalWorkspace: ${twoWindowBlobSource()} });
    ${spawnCounterSource()}
  `;
}

/** One project with the same 2-window blob PLUS two surviving running transient
 *  PTYs: the hard-reload path. Each survivor carries the slot main recorded for
 *  it, so syncSessions re-pairs them EXACTLY and on first open both windows
 *  restore and reattach. */
/** The layout a user saved before the panel: two FLOATING windows, as every
 *  existing config holds it. The panel must re-tile it into its preset. */
function legacyFloatingBlobSource(): string {
  return `{
    version: 1,
    windows: [
      { taskId: 'slot-1', title: 'Command Terminal', geometry: { x: 0.1, y: 0.1, w: 0.4, h: 0.6 }, restoreGeometry: null, state: 'floating' },
      { taskId: 'slot-2', title: 'Command Terminal', geometry: { x: 0.5, y: 0.1, w: 0.4, h: 0.6 }, restoreGeometry: null, state: 'floating' }
    ],
    tileTree: null,
    tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
    focusedTaskId: 'slot-1'
  }`;
}

function hardReloadPreConfig(blobSource: string = twoWindowBlobSource()): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${HARD_RELOAD_PROJECT_ID}',
        name: 'Hard Reload Project',
        path: '/mock/hard-reload-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-hr-' + i, position: i, created_at: ts }));
      });
      state.sessions.push({
        id: 'hr-sess-1', taskId: 'hr-sess-1', projectId: '${HARD_RELOAD_PROJECT_ID}', pid: 3001,
        status: 'running', shell: 'bash', cwd: '/mock/hard-reload-project', startedAt: ts,
        exitCode: null, resuming: false, transient: true,
        commandTerminalSlot: 'slot-1', commandTerminalBranch: 'main',
      });
      state.sessions.push({
        id: 'hr-sess-2', taskId: 'hr-sess-2', projectId: '${HARD_RELOAD_PROJECT_ID}', pid: 3002,
        status: 'running', shell: 'bash', cwd: '/mock/hard-reload-project', startedAt: ts,
        exitCode: null, resuming: false, transient: true,
        commandTerminalSlot: 'slot-2', commandTerminalBranch: 'feature/two',
      });
      return { currentProjectId: '${HARD_RELOAD_PROJECT_ID}' };
    });
    window.electronAPI.config.set({ commandTerminalWorkspace: ${blobSource} });
    ${spawnCounterSource()}
  `;
}

/** Survivors on NON-CONSECUTIVE slots whose ids sort the OPPOSITE way to those
 *  slots. This is the fixture shape `hardReloadPreConfig` cannot express: there,
 *  `hr-sess-1` / `hr-sess-2` happen to sort into slot order, so a positional
 *  `slot-${index + 1}` guess over an id-sorted list lands correctly by accident.
 *  Here it pairs `slot-1`->`sm-zzz` and `slot-2`->`sm-aaa`, i.e. each window shows
 *  the other terminal's conversation under a title that says otherwise. */
function slotMismatchPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${SLOT_MISMATCH_PROJECT_ID}',
        name: 'Slot Mismatch Project',
        path: '/mock/slot-mismatch-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-sm-' + i, position: i, created_at: ts }));
      });
      state.sessions.push({
        id: 'sm-zzz', taskId: 'sm-zzz', projectId: '${SLOT_MISMATCH_PROJECT_ID}', pid: 3101,
        status: 'running', shell: 'bash', cwd: '/mock/slot-mismatch-project', startedAt: ts,
        exitCode: null, resuming: false, transient: true,
        commandTerminalSlot: 'slot-2', commandTerminalBranch: 'main',
      });
      state.sessions.push({
        id: 'sm-aaa', taskId: 'sm-aaa', projectId: '${SLOT_MISMATCH_PROJECT_ID}', pid: 3102,
        status: 'running', shell: 'bash', cwd: '/mock/slot-mismatch-project', startedAt: ts,
        exitCode: null, resuming: false, transient: true,
        commandTerminalSlot: 'slot-3', commandTerminalBranch: 'main',
      });
      return { currentProjectId: '${SLOT_MISMATCH_PROJECT_ID}' };
    });
    ${spawnCounterSource()}
  `;
}

/** One project with no seeded sessions. The test spawns a terminal itself and then
 *  injects a survivor, which is how it reproduces the "a fresh spawn won the race"
 *  shape that a pre-seeded fixture cannot: the map must already hold an entry for
 *  the project when recovery runs. */
function orphanRacePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${ORPHAN_RACE_PROJECT_ID}',
        name: 'Orphan Race Project',
        path: '/mock/orphan-race-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-or-' + i, position: i, created_at: ts }));
      });
      return { currentProjectId: '${ORPHAN_RACE_PROJECT_ID}' };
    });
    ${spawnCounterSource()}
  `;
}

/** Two projects, the FIRST current, with a surviving PTY belonging to the second.
 *  The background project's terminal must still be re-paired: recovery used to be
 *  wrapped in `if (currentProjectId)` and scoped to it, so switching to that
 *  project found nothing and spawned over the live terminal. */
function backgroundProjectPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      ['${BACKGROUND_FOREGROUND_PROJECT_ID}', '${BACKGROUND_PROJECT_ID}'].forEach(function (id, index) {
        state.projects.push({
          id: id,
          name: index === 0 ? 'Foreground Project' : 'Background Project',
          path: '/mock/bg-project-' + index,
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-bg-' + i, position: i, created_at: ts }));
      });
      state.sessions.push({
        id: 'bg-sess-1', taskId: 'bg-sess-1', projectId: '${BACKGROUND_PROJECT_ID}', pid: 3201,
        status: 'running', shell: 'bash', cwd: '/mock/bg-project-1', startedAt: ts,
        exitCode: null, resuming: false, transient: true,
        commandTerminalSlot: 'slot-2', commandTerminalBranch: 'main',
      });
      return { currentProjectId: '${BACKGROUND_FOREGROUND_PROJECT_ID}' };
    });
    ${spawnCounterSource()}
  `;
}

/** One project with a single surviving PTY on slot-1. The test drops the pairing
 *  map by hand afterwards, which is the one state recovery cannot produce for
 *  itself: `sessions` holding a live terminal while the map holds nothing. */
function adoptPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${ADOPT_PROJECT_ID}',
        name: 'Adopt Project',
        path: '/mock/adopt-project',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-ad-' + i, position: i, created_at: ts }));
      });
      state.sessions.push({
        id: 'ad-sess-1', taskId: 'ad-sess-1', projectId: '${ADOPT_PROJECT_ID}', pid: 3301,
        status: 'running', shell: 'bash', cwd: '/mock/adopt-project', startedAt: ts,
        exitCode: null, resuming: false, transient: true,
        commandTerminalSlot: 'slot-1', commandTerminalBranch: 'main',
      });
      return { currentProjectId: '${ADOPT_PROJECT_ID}' };
    });
    ${spawnCounterSource()}
  `;
}

/** Drop every transient pairing entry, leaving the sessions list untouched. */
async function clearTransientPairings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { setState: (partial: { transientSessions: Record<string, unknown> }) => void } };
    }).__zustandStores;
    stores?.session?.setState({ transientSessions: {} });
  });
}

/** Transient-session entries (slot + sessionId + branch) tracked for a project. */
async function transientEntriesFor(
  page: Page,
  projectId: string,
): Promise<Array<{ slot: string; sessionId: string; branch: string | null }>> {
  return page.evaluate((projectId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string; slot: string; sessionId: string; branch: string | null }> } } };
    }).__zustandStores;
    const map = stores?.session?.getState().transientSessions ?? {};
    return Object.values(map)
      .filter((entry) => entry.projectId === projectId)
      .map((entry) => ({ slot: entry.slot, sessionId: entry.sessionId, branch: entry.branch }));
  }, projectId);
}

/** A project's slot-to-sessionId pairing, as a plain sorted object. The pairing is
 *  what the recovery has to get RIGHT: a count-only assertion passes just as
 *  happily when a window is showing another terminal's conversation. */
async function transientPairingFor(page: Page, projectId: string): Promise<Record<string, string>> {
  const entries = await transientEntriesFor(page, projectId);
  const pairing: Record<string, string> = {};
  for (const entry of entries) pairing[entry.slot] = entry.sessionId;
  return pairing;
}

/** Push a running Command Terminal PTY into the mock AFTER boot, then re-run the
 *  renderer's session sync, modelling main having kept a terminal alive that the
 *  renderer does not yet know about.
 *
 *  `__mockPreConfigure` hands out the mock's own `sessions` array by reference, so
 *  a post-boot push lands in `sessions.list()`. The caller asserts the row arrived
 *  before relying on it. */
async function injectRunningTerminal(
  page: Page,
  session: { id: string; projectId: string; slot: string; branch?: string },
): Promise<void> {
  await page.evaluate((session) => {
    const configure = (window as unknown as {
      __mockPreConfigure?: (fn: (state: { sessions: unknown[] }) => void) => void;
    }).__mockPreConfigure;
    configure?.((state) => {
      state.sessions.push({
        id: session.id,
        taskId: session.id,
        projectId: session.projectId,
        pid: 4242,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/project',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        transient: true,
        commandTerminalSlot: session.slot,
        commandTerminalBranch: session.branch ?? 'main',
      });
    });
  }, session);
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { syncSessions: () => Promise<boolean> } } };
    }).__zustandStores;
    return stores?.session?.getState().syncSessions();
  });
}

/** Push main's `session-removed` for a Command Terminal: the second push of an
 *  end main started (a phone's Stop, the agent exiting), sent once the row is
 *  gone from main's registry. The payload is the row's last snapshot. */
async function fireTerminalRemoved(
  page: Page,
  session: { id: string; projectId: string; slot: string },
): Promise<void> {
  await page.evaluate((session) => {
    const win = window as unknown as { __mockFireRemoved: (id: string, session: unknown, projectId: string) => void };
    win.__mockFireRemoved(
      session.id,
      { id: session.id, projectId: session.projectId, transient: true, commandTerminalSlot: session.slot },
      session.projectId,
    );
  }, session);
}

/** Push main's PTY exit for a session (`session-exit`), the first push of an end
 *  main started. Runs App.tsx's real exit handler through the mock's listeners. */
async function fireTerminalExit(
  page: Page,
  exit: { sessionId: string; projectId: string; exitCode: number; intentional: boolean },
): Promise<void> {
  await page.evaluate((exit) => {
    const win = window as unknown as {
      __mockFireExit: (sessionId: string, exitCode: number, projectId: string, intentional: boolean) => void;
    };
    win.__mockFireExit(exit.sessionId, exit.exitCode, exit.projectId, exit.intentional);
  }, exit);
}

/** The session replica's row for an id, narrowed to what these tests read, or null
 *  when the replica holds none. */
async function replicaSessionRow(
  page: Page,
  sessionId: string,
): Promise<{ status: string; exitCode: number | null; transient: boolean } | null> {
  return page.evaluate((sessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session?: {
          getState: () => {
            sessions: Array<{ id: string; status: string; exitCode: number | null; transient?: boolean }>;
          };
        };
      };
    }).__zustandStores;
    const row = stores?.session?.getState().sessions.find((candidate) => candidate.id === sessionId);
    return row ? { status: row.status, exitCode: row.exitCode, transient: row.transient === true } : null;
  }, sessionId);
}

/** Push a `session-changed` status for a live Command Terminal that carries the
 *  name main derived for it (`commandTerminalLabel`), the way main stamps it. */
async function fireTerminalLabel(
  page: Page,
  session: { id: string; projectId: string; slot: string; label: string },
): Promise<void> {
  await page.evaluate((session) => {
    const win = window as unknown as { __mockFireStatus: (sessionId: string, session: unknown) => void };
    win.__mockFireStatus(session.id, {
      id: session.id,
      taskId: session.id,
      projectId: session.projectId,
      pid: null,
      status: 'running',
      shell: '/bin/bash',
      cwd: '/mock/multi-terminal',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: true,
      commandTerminalSlot: session.slot,
      commandTerminalBranch: 'main',
      commandTerminalLabel: session.label,
    });
  }, session);
}

/** The count the sidebar's per-project Command Terminal indicator is printing, or
 *  0 when it is absent (the indicator hides itself at zero). */
async function sidebarTerminalCount(page: Page, projectId: string): Promise<number> {
  const indicator = page.getByTestId(`project-terminals-${projectId}`);
  if (await indicator.count() === 0) return 0;
  return Number(await indicator.first().getAttribute('data-count'));
}

/** Count of fresh spawnTransient calls recorded for a project. */
async function spawnCountFor(page: Page, projectId: string): Promise<number> {
  return page.evaluate((projectId) => {
    const counts = (window as unknown as { __transientSpawnsByProject?: Record<string, number> }).__transientSpawnsByProject ?? {};
    return counts[projectId] ?? 0;
  }, projectId);
}

/** Slot anchors of the command-terminal windows currently in the singleton store, sorted. */
async function commandWindowAnchors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { commandWindow?: { getState: () => { windows: Record<string, { anchor: string }> } } };
    }).__zustandStores;
    const windows = stores?.commandWindow?.getState().windows ?? {};
    return Object.values(windows).map((managedWindow) => managedWindow.anchor).sort();
  });
}

/** The command layer's tile tree as the panel lays it out: the slots in the
 *  order the root split holds them, and the root split's sizes. Used to verify
 *  a restored layout carries the PERSISTED blob (its order and its dragged seam)
 *  rather than a fresh preset - a population-count assertion alone cannot
 *  distinguish "restored from the blob" from "reconciled open in a fresh
 *  layout", which is exactly the bug this covers. */
async function commandTileLayout(page: Page): Promise<{ slots: string[]; sizes: number[] } | null> {
  return page.evaluate(() => {
    interface StoreTile { kind: 'leaf' | 'split'; windowId?: string; children?: StoreTile[]; sizes?: number[] }
    const stores = (window as unknown as {
      __zustandStores?: {
        commandWindow?: { getState: () => { windows: Record<string, { anchor: string }>; tileTree: StoreTile | null } };
      };
    }).__zustandStores;
    const state = stores?.commandWindow?.getState();
    const tree = state?.tileTree;
    if (!state || !tree || tree.kind !== 'split') return null;
    const slots = (tree.children ?? []).map((child) => (child.windowId ? state.windows[child.windowId]?.anchor ?? '?' : 'split'));
    return { slots, sizes: tree.sizes ?? [] };
  });
}

/** Numeric tolerance for fractional size comparisons. Per the cross-platform
 *  rule, never compare a freshly-measured/derived float with zero tolerance. */
const GEOMETRY_TOLERANCE = 0.001;

/** Of the given session ids, which are present and still running in the session store. */
async function runningSessionIds(page: Page, sessionIds: string[]): Promise<string[]> {
  return page.evaluate((ids) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { sessions: Array<{ id: string; status: string }> } } };
    }).__zustandStores;
    const sessions = stores?.session?.getState().sessions ?? [];
    return sessions.filter((session) => ids.includes(session.id) && session.status === 'running').map((session) => session.id);
  }, sessionIds);
}

/** The active project's id (null when none). Used to wait for a project switch to
 *  settle before opening the layer, since open() reconciles against the current
 *  project the instant it runs. */
async function activeProjectId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { project?: { getState: () => { currentProject: { id: string } | null } } };
    }).__zustandStores;
    return stores?.project?.getState().currentProject?.id ?? null;
  });
}

/** Command-terminal window ids in the singleton store, keyed by slot anchor. Lets
 *  a test scope a Playwright locator to one specific window's WindowFrame
 *  (`data-testid="window-frame-<id>"`) when two windows are open side by side. */
async function commandWindowIdBySlot(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { commandWindow?: { getState: () => { windows: Record<string, { anchor: string }> } } };
    }).__zustandStores;
    const windows = stores?.commandWindow?.getState().windows ?? {};
    const bySlot: Record<string, string> = {};
    for (const [id, managedWindow] of Object.entries(windows)) {
      bySlot[managedWindow.anchor] = id;
    }
    return bySlot;
  });
}

/** The Changes-panel entity ids currently marked open in the session store
 *  (`changesOpenTasks`), as a plain array for assertion. */
async function changesOpenEntityIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { changesOpenTasks: Set<string> } } };
    }).__zustandStores;
    const set = stores?.session?.getState().changesOpenTasks ?? new Set<string>();
    return Array.from(set);
  });
}

test.describe('Command Terminal', () => {
  // ---------------------------------------------------------------------------
  // TitleBar Button - these two tests use different base preconfigs so each
  // gets its own browser launch.
  // ---------------------------------------------------------------------------
  test.describe('TitleBar Button', () => {
    test('Command Terminal button is visible when a project is open', async () => {
      const { browser, page } = await launchWithState(preConfigWithTransientSession());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(page.getByTestId('quick-session-button')).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('Command Terminal button is hidden when no project is open', async () => {
      await waitForViteReady();
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      await page.addInitScript({ path: MOCK_SCRIPT });
      await gotoVite(page, VITE_URL);
      await page.waitForLoadState('load');
      await page.waitForSelector('text=Kangentic', { timeout: 15000 });

      try {
        // No project open - welcome screen visible, button should be hidden
        await expect(page.locator('[data-testid="welcome-open-project"]')).toBeVisible();
        await expect(page.getByTestId('quick-session-button')).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Shared browser: Terminal Panel Filtering + Hotkey + Background Session
  // Indicator + Overlay Header Controls - all use preConfigWithTransientSession()
  // and do not mutate state in ways that would affect sibling tests after a
  // full page navigation in beforeEach.
  // ---------------------------------------------------------------------------
  test.describe('Transient Session - shared browser group', () => {
    let sharedBrowser: Browser;
    let sharedPage: Page;

    test.beforeAll(async () => {
      ({ browser: sharedBrowser, page: sharedPage } = await launchSharedBrowser(
        preConfigWithTransientSession(),
      ));
    });

    test.afterAll(async () => {
      await sharedBrowser?.close();
    });

    test.beforeEach(async () => {
      await gotoVite(sharedPage, VITE_URL);
      await sharedPage.waitForLoadState('load');
      await sharedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
      await sharedPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test.describe('Terminal Panel Filtering', () => {
      test('transient sessions are excluded from the terminal panel tabs', async () => {
        // The regular task session tab should be visible
        const taskTab = sharedPage.locator('button:has-text("regular-task")');
        await expect(taskTab).toBeVisible();

        // The transient session should NOT appear as a tab
        const transientTab = sharedPage.locator('button:has-text("ephemeral-uuid")');
        await expect(transientTab).not.toBeVisible();
      });
    });

    test.describe('Hotkey', () => {
      test('Ctrl+Shift+P opens the command bar overlay', async () => {
        // Command bar should not be visible initially
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible();

        // Press Ctrl+Shift+P
        await sharedPage.keyboard.press('Control+Shift+P');

        // Command bar should appear. The title carries the window's durable slot
        // number so two terminals are tellable apart, hence "Command Terminal 1"
        // rather than the bare name for the first slot.
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();
        await expect(sharedPage.getByTestId('command-bar-label')).toHaveText('Command Terminal 1');
      });

      test('Ctrl+Shift+P toggles the command bar closed', async () => {
        // Open
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Close
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });
      });
    });

    test.describe('Background Session Indicator', () => {
      // Phase 2: the pulsing dot (`transient-session-indicator`) was removed.
      // Activity is now shown as the COLOR of the terminal icon (`quick-session-icon`),
      // via a `data-activity` attribute. The icon is ALWAYS visible when a project is
      // open (activity-based, not existence-based). When a transient session with
      // 'idle' activity is in the background, the icon gets data-activity="idle".
      // After all transient sessions are killed (no current-project entries in the map),
      // the icon falls back to data-activity="rest".
      //
      // preConfigWithTransientSession() pre-seeds activityCache[TRANSIENT_SESSION_ID]='idle',
      // so the icon should show idle as soon as the store is hydrated - REGARDLESS of
      // whether the bar is open or closed. This is the key semantic change from Phase 1.

      test('icon shows idle activity while transient session is alive (bar closed)', async () => {
        // The icon should be visible (project is open)
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).toBeVisible();

        // The preConfig seeds activityCache with 'idle' for the transient session.
        // The icon should reflect that, whether or not the bar is open.
        // Poll to allow the activity store to hydrate.
        await expect(icon).toHaveAttribute('data-activity', 'idle', { timeout: 5000 });
        // Needs-you renders the static geometry. The branding set ships no `-rest` mark by
        // design (rest is the `-idle` geometry in a muted tone), so both the 'idle' and 'rest'
        // tones land on terminal-idle and only the color differs - pin that here.
        await expect(icon).toHaveAttribute('data-mark', 'terminal-idle');

        // Open overlay and close it - session stays alive
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

        // Icon still reflects the alive background session
        await expect(icon).toHaveAttribute('data-activity', 'idle', { timeout: 3000 });
      });
    });

    test.describe('Overlay Header Controls', () => {
      // The command terminal has NO per-window X/hide button (removed to avoid the
      // "close this window" confusion with the task-detail X). Hiding the layer is
      // covered by the Ctrl+Shift+W and backdrop tests below; Stop destroys a terminal.

      test('stop button terminates the session and closes overlay', async () => {
        // Open overlay
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Click the stop button
        await sharedPage.getByTestId('command-bar-terminate-button').click();
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

        // Session was killed: icon should revert to 'rest' (no current-project transient sessions remain).
        // Poll because the store cleanup is async after killTransient resolves.
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });
      });

      test('kebab menu renders with expected items', async () => {
        // Open overlay
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Click the kebab menu button
        await sharedPage.locator('[aria-label="Actions"]').click();

        // Verify menu items. Commands is kebab-only now (no header pill), so it is the
        // sole "Commands" button.
        await expect(sharedPage.locator('button:has-text("Open folder")')).toBeVisible();
        await expect(sharedPage.getByRole('button', { name: 'Commands' })).toBeVisible();
        await expect(sharedPage.getByTestId('command-bar-kebab-stop')).toBeVisible();
      });

      test('the panel maximize button and Ctrl+Shift+M/W hotkeys toggle and hide the panel', async () => {
        await sharedPage.keyboard.press('Control+Shift+P');
        const windowContent = sharedPage.getByTestId('command-terminal-window');
        await expect(windowContent).toBeVisible();

        // Maximize belongs to the PANEL, which holds every terminal; a terminal
        // has no maximize of its own.
        await expect(windowContent.getByRole('button', { name: /maximize/i })).toHaveCount(0);
        const panel = sharedPage.getByTestId('command-terminal-panel');
        const maximizeButton = sharedPage.getByTestId('command-terminal-panel-maximize');
        await expect(maximizeButton).toHaveAccessibleName('Maximize panel');
        await expect(panel).toHaveAttribute('data-maximized', 'false');

        await maximizeButton.click();
        await expect(panel).toHaveAttribute('data-maximized', 'true');
        await expect(maximizeButton).toHaveAccessibleName('Restore panel');

        // Ctrl+Shift+M restores (terminal-safe combo).
        await sharedPage.keyboard.press('Control+Shift+M');
        await expect(panel).toHaveAttribute('data-maximized', 'false');

        // Ctrl+Shift+W hides the layer; the transient session stays alive.
        await sharedPage.keyboard.press('Control+Shift+W');
        await expect(windowContent).not.toBeVisible({ timeout: 5000 });

        // Session alive in background: icon should NOT be 'rest'.
        // (The preConfig seeds activity='idle', so the icon stays non-rest.)
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).not.toHaveAttribute('data-activity', 'rest', { timeout: 3000 });
      });

      test('a clean backdrop click hides the layer without killing the session', async () => {
        // The CommandBackdrop (data-testid="command-window-backdrop") uses a
        // press-then-release guard: onMouseDown records pressedOnSelf=true only when
        // both events target the backdrop directly (not a child). A clean click on
        // the empty region beside the window satisfies this and fires onHide().
        //
        // Mirrors the X-button and Ctrl+Shift+W behavior: the PTY stays alive and
        // the icon stays non-rest after the layer closes.
        await sharedPage.keyboard.press('Control+Shift+P');
        await expect(sharedPage.getByTestId('command-terminal-window')).toBeVisible();

        // Click the backdrop directly (not on the window frame). The backdrop is a
        // fixed full-screen div below the window frame; a top-left-corner point is
        // safely outside the window content (which is centered or near the center).
        const backdrop = sharedPage.getByTestId('command-window-backdrop');
        await expect(backdrop).toBeVisible();
        await backdrop.click({ position: { x: 5, y: 5 } });

        // Layer must hide (the window content is no longer visible)
        await expect(sharedPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

        // Session stays alive: icon is non-rest.
        const icon = sharedPage.getByTestId('quick-session-icon');
        await expect(icon).not.toHaveAttribute('data-activity', 'rest', { timeout: 3000 });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-Project Transient Session Persistence - shared browser group.
  // All four tests use twoProjectPreConfig() and get fresh state via beforeEach.
  //
  // Phase 2 change: assertions replaced from transient-session-indicator to
  // icon data-activity. "Session alive in background" is now data-activity != 'rest';
  // "no session for this project" is data-activity = 'rest'.
  //
  // Note on timing: Unlike the old dot (which only appeared when the bar was
  // CLOSED), the new icon reflects activity even while the bar is OPEN. When we
  // spawn a transient session via Ctrl+Shift+P the store's transientSessions map
  // is updated, and if the mock's activityCache has a value for that session the
  // icon transitions immediately on store hydration. The mock's spawnTransient
  // pushes the new session into sessions[] but does NOT seed activityCache for it,
  // so freshly spawned sessions will be 'rest' until activity arrives. However,
  // the icon is still non-'rest' if a prior session with activity exists in the
  // map. Tests must therefore close the bar (hide, not stop) to assert "background
  // but alive" vs open the bar and assert something else.
  // ---------------------------------------------------------------------------
  test.describe('Cross-Project Transient Session Persistence', () => {
    let crossProjectBrowser: Browser;
    let crossProjectPage: Page;

    test.beforeAll(async () => {
      ({ browser: crossProjectBrowser, page: crossProjectPage } = await launchSharedBrowser(
        twoProjectPreConfig(),
      ));
    });

    test.afterAll(async () => {
      await crossProjectBrowser?.close();
    });

    test.beforeEach(async () => {
      await gotoVite(crossProjectPage, VITE_URL);
      await crossProjectPage.waitForLoadState('load');
      await crossProjectPage.waitForSelector('text=Kangentic', { timeout: 15000 });
      await crossProjectPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test('transient session survives project switch and reattaches on return', async () => {
      // Open command terminal in Project A and close overlay (session stays in background).
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Icon must show that Project A has a transient session.
      // After spawn the session is 'rest' (no activityCache entry from mock) so we
      // assert the session is present via Zustand store rather than icon color.
      // The transient map should have an entry for PROJECT_A_ID.
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - Playwright's retry handles the settle wait
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();

      // No transient session for Project B; icon should be 'rest'.
      const icon = crossProjectPage.getByTestId('quick-session-icon');
      await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });

      // Switch back to Project A - the session is still in the map (stashed, not killed).
      await crossProjectPage.locator('[role="button"]:has-text("Project Alpha")').click();

      // Project A has a live transient entry; verify via store.
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Opening the command bar should reattach to the existing session (no new spawn)
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
    });

    test('command bar overlay closes automatically on project switch', async () => {
      // Open command terminal in Project A
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();

      // Trigger project switch programmatically (overlay backdrop blocks sidebar clicks)
      await crossProjectPage.evaluate(async () => {
        const store = (window as unknown as { __zustandStores?: { project?: { getState: () => { openProject: (id: string) => Promise<void> } } } }).__zustandStores?.project;
        if (store) {
          await store.getState().openProject('proj-cmd-b');
        }
      });

      // Overlay should close automatically via useCommandBar's currentProjectId effect
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });
    });

    test('each project gets its own independent transient session', async () => {
      // Open and close command terminal in Project A
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Project A has a transient session in the store
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - Playwright's retry handles the settle wait
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();

      // No transient session for Project B yet; icon should be 'rest'.
      const icon = crossProjectPage.getByTestId('quick-session-icon');
      await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });

      // Open and close command terminal in Project B (spawns a new session)
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Project B now has a transient session
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_B_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch back to Project A - its session should still be in the map
      await crossProjectPage.locator('[role="button"]:has-text("Project Alpha")').click();
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - its session should also still be in the map
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_B_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);
    });

    test('deleting a project kills its transient session', async () => {
      // Open and close command terminal in Project A (creates a background transient)
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).toBeVisible();
      await crossProjectPage.keyboard.press('Control+Shift+P');
      await expect(crossProjectPage.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Project A has a transient session
      await expect.poll(
        async () => crossProjectPage.evaluate((projId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { transientSessions: Record<string, { projectId: string }> } } } }).__zustandStores;
          const sessions = stores?.session?.getState().transientSessions ?? {};
          return Object.values(sessions).some((entry) => entry.projectId === projId);
        }, PROJECT_A_ID),
        { timeout: 5000, intervals: [100, 200, 500] },
      ).toBe(true);

      // Switch to Project B - Playwright's retry handles the settle wait
      await crossProjectPage.locator('[role="button"]:has-text("Project Beta")').click();

      // Project B has no transient session; icon should be 'rest'
      const icon = crossProjectPage.getByTestId('quick-session-icon');
      await expect(icon).toHaveAttribute('data-activity', 'rest', { timeout: 5000 });

      // Delete Project A via context menu
      await crossProjectPage.locator('[role="button"]:has-text("Project Alpha")').click({ button: 'right' });
      await crossProjectPage.locator('button:has-text("Delete")').click();

      // Confirm deletion
      const confirmButton = crossProjectPage.locator('button:has-text("Delete"):not([disabled])');
      await confirmButton.last().click();

      // Project A should be gone from sidebar
      await expect(crossProjectPage.locator('[role="button"]:has-text("Project Alpha")')).not.toBeVisible();
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple terminals (Phase 2) - exercises the headline new behavior:
  // multiple Command Terminal windows per project, spawned via the title-bar
  // "New terminal" button (a separate control from the open/close toggle).
  //
  // Uses a per-test browser with a deterministic spawnTransient override
  // that returns a unique session id per call (counter incremented in closure),
  // since spawning a 2nd terminal calls spawnTransient again.
  // ---------------------------------------------------------------------------
  test.describe('Multiple terminals', () => {
    test('the title-bar button only toggles the panel; Add terminal lives at the head of the rail', async () => {
      // The title-bar terminal button is a plain open/close toggle - it never
      // spawns a terminal, so its own glyph always shows the shell prompt
      // (data-plus=false), and the title bar holds no other terminal control.
      // A new terminal starts from Add terminal at the top of the rail; the
      // panel's header holds only its window controls.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        const titleBarActions = page.getByTestId('titlebar-actions');
        await expect(page.getByTestId('quick-session-icon')).toHaveAttribute('data-plus', 'false');
        await expect(page.getByTestId('command-terminal-new')).toHaveCount(0);

        await page.getByTestId('quick-session-button').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);
        await expect(page.getByTestId('command-terminal-new')).toHaveCount(1);
        await expect(page.getByTestId('command-terminal-panel-header').getByTestId('command-terminal-new')).toHaveCount(0);
        await expect(titleBarActions.getByTestId('command-terminal-new')).toHaveCount(0);
        const railNew = page.getByTestId('command-terminal-rail').getByTestId('command-terminal-new');
        await expect(railNew).toHaveText('Add terminal');
        const railBox = await page.getByTestId('command-terminal-rail').boundingBox();
        const railNewBox = await railNew.boundingBox();
        if (!railBox || !railNewBox) throw new Error('no rail');
        expect(railNewBox.y - railBox.y).toBeLessThan(24);
        await expect(page.getByTestId('quick-session-icon')).toHaveAttribute('data-plus', 'false');

        // Click again hides the panel, the one-click close even when it is maximized.
        await page.getByTestId('quick-session-button').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
        await expect(page.getByTestId('command-terminal-new')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('New terminal spawns a second terminal', async () => {
      // With the layer open, the rail's Add terminal button calls
      // spawnAdditionalCommandTerminal, which opens a new window in the next
      // free slot and tiles them side by side.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the layer (creates first window)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // Wait for one window to be present
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);

        // Click Add terminal to spawn a second terminal
        await page.getByTestId('command-terminal-new').click();

        // Second window should appear; total count goes 1 -> 2
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        // Both windows are visible (tiled)
        const windows = page.getByTestId('command-terminal-window');
        await expect(windows.nth(0)).toBeVisible();
        await expect(windows.nth(1)).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('two terminals carry distinct, slot-numbered titles', async () => {
      // The defect this fixes: two tiled Command Terminals had byte-identical
      // title bars, and every other fact in that header (agent, model, branch,
      // cwd) is identical across a project's terminals by construction, so the
      // slot number is the only thing that can tell them apart.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect(page.getByTestId('command-bar-label')).toHaveText('Command Terminal 1');

        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        // Assert the SET, not each index: window order is the engine's business,
        // and pinning it here would make this test fail on an unrelated tiling
        // change while still not proving the titles differ.
        const titles = await page.getByTestId('command-bar-label').allTextContents();
        expect(titles).toHaveLength(2);
        expect(new Set(titles).size).toBe(2);
        expect([...titles].sort()).toEqual(['Command Terminal 1', 'Command Terminal 2']);
      } finally {
        await browser.close();
      }
    });

    test('a window titles itself from its own terminal\'s name once main pushes one', async () => {
      // Main derives a terminal's name from its first prompt and stamps it on the
      // session row (`commandTerminalLabel`), then pushes the row. The title
      // reads it from the replica, so no renderer-side label can drift from the
      // Monitor row and the phone. Until then the slot title stands in, and a
      // sibling terminal with no name keeps its own.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect.poll(async () => (await transientEntriesFor(page, MULTI_PROJECT_ID)).length).toBe(2);

        const firstWindowTitle = page
          .locator('[data-testid="command-terminal-window"][data-command-slot="slot-1"]')
          .getByTestId('command-bar-label');
        const secondWindowTitle = page
          .locator('[data-testid="command-terminal-window"][data-command-slot="slot-2"]')
          .getByTestId('command-bar-label');
        await expect(firstWindowTitle).toHaveText('Command Terminal 1');
        await expect(secondWindowTitle).toHaveText('Command Terminal 2');

        const firstEntry = (await transientEntriesFor(page, MULTI_PROJECT_ID)).find((entry) => entry.slot === 'slot-1')!;
        await fireTerminalLabel(page, {
          id: firstEntry.sessionId,
          projectId: MULTI_PROJECT_ID,
          slot: 'slot-1',
          label: 'Fix the login redirect',
        });

        await expect(firstWindowTitle).toHaveText('Fix the login redirect', { timeout: 3000 });
        // Only the named terminal's window changes: the lookup is per session.
        await expect(secondWindowTitle).toHaveText('Command Terminal 2');
      } finally {
        await browser.close();
      }
    });

    test('stopping one of two terminals leaves the other visible and the layer open', async () => {
      // Per-window Stop closes THAT window only. With two windows, stopping one
      // leaves count=1 and the layer stays open.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open and spawn two terminals
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        // Click Stop on the FIRST window
        const firstWindow = page.getByTestId('command-terminal-window').first();
        await firstWindow.getByTestId('command-bar-terminate-button').click();

        // Count goes 2 -> 1; the layer stays open
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect(page.getByTestId('command-terminal-window').first()).toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('stopping the last terminal hides the whole layer', async () => {
      // When the LAST command terminal window is stopped, the layer bridge fires
      // onHide and the overlay disappears entirely.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the layer (one window)
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        // Stop the only terminal
        await page.getByTestId('command-bar-terminate-button').click();

        // Whole layer hides
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
        // The backdrop should also be gone
        await expect(page.getByTestId('command-window-backdrop')).not.toBeVisible({ timeout: 3000 });
        // "New terminal" is gone too (it only exists while the layer is open)
        await expect(page.getByTestId('command-terminal-new')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('a terminal main ends (a phone\'s Stop, its agent exiting) closes just its own window', async () => {
      // Main announces every end as a removal push. An end the window did not
      // start leaves its (project, slot) entry in place, which is how the
      // removal subscriber knows to close that window as Stop would.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect.poll(async () => (await transientEntriesFor(page, MULTI_PROJECT_ID)).length).toBe(2);

        const entries = await transientEntriesFor(page, MULTI_PROJECT_ID);
        const ended = entries.find((entry) => entry.slot === 'slot-1')!;
        await page.evaluate(({ sessionId, projectId }) => {
          const win = window as unknown as { __mockFireRemoved: (id: string, session: unknown, projectId: string) => void };
          win.__mockFireRemoved(sessionId, { id: sessionId, projectId, transient: true, commandTerminalSlot: 'slot-1' }, projectId);
        }, { sessionId: ended.sessionId, projectId: MULTI_PROJECT_ID });

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        expect(await commandWindowAnchors(page)).toEqual(['slot-2']);
        expect((await transientEntriesFor(page, MULTI_PROJECT_ID)).map((entry) => entry.slot)).toEqual(['slot-2']);
      } finally {
        await browser.close();
      }
    });

    test('when main ends the last terminal, the layer hides as it does after Stop', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect.poll(async () => (await transientEntriesFor(page, MULTI_PROJECT_ID)).length).toBe(1);

        const [only] = await transientEntriesFor(page, MULTI_PROJECT_ID);
        await page.evaluate(({ sessionId, projectId }) => {
          const win = window as unknown as { __mockFireRemoved: (id: string, session: unknown, projectId: string) => void };
          win.__mockFireRemoved(sessionId, { id: sessionId, projectId, transient: true }, projectId);
        }, { sessionId: only.sessionId, projectId: MULTI_PROJECT_ID });

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
        await expect(page.getByTestId('command-window-backdrop')).not.toBeVisible({ timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('a terminal whose agent exits keeps its window until main announces the removal', async () => {
      // Main ends a terminal in two pushes: the PTY exit, then session-removed once
      // the row is gone. The exit handler must leave the (project, slot) entry in
      // place for the removal subscriber to find. Dropping it on the exit leaves
      // that subscriber with nothing to match, so the window outlives a dead
      // terminal for good.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect.poll(async () => (await transientEntriesFor(page, MULTI_PROJECT_ID)).length).toBe(1);

        const [ended] = await transientEntriesFor(page, MULTI_PROJECT_ID);
        // The exit handler takes its transient branch only for a row the replica
        // knows as a live transient terminal.
        expect(await replicaSessionRow(page, ended.sessionId)).toEqual({ status: 'running', exitCode: null, transient: true });

        await fireTerminalExit(page, { sessionId: ended.sessionId, projectId: MULTI_PROJECT_ID, exitCode: 1, intentional: false });

        // The exit handler runs synchronously inside the push, so these reads need
        // no wait. The window and its pairing both survive the exit.
        expect(await transientPairingFor(page, MULTI_PROJECT_ID)).toEqual({ 'slot-1': ended.sessionId });
        expect(await commandWindowAnchors(page)).toEqual(['slot-1']);
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);
        // Proof the exit really ran: the replica row now reads exited with that code.
        expect(await replicaSessionRow(page, ended.sessionId)).toEqual({ status: 'exited', exitCode: 1, transient: true });

        await fireTerminalRemoved(page, { id: ended.sessionId, projectId: MULTI_PROJECT_ID, slot: 'slot-1' });

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
        expect(await commandWindowAnchors(page)).toEqual([]);
        expect(await transientEntriesFor(page, MULTI_PROJECT_ID)).toEqual([]);
        await expect.poll(() => replicaSessionRow(page, ended.sessionId)).toBeNull();
      } finally {
        await browser.close();
      }
    });

    test('a removal push for another project\'s terminal closes none of this project\'s windows', async () => {
      // A slot is only unique within a project, so another project's terminal can
      // hold the same slot id as one of this project's open windows. The removal
      // subscriber drops the other project's pairing, and must not close the
      // current project's window that happens to sit at that slot.
      const { browser, page } = await launchWithState(backgroundProjectPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        // The background project's surviving PTY holds slot-2 and is re-paired
        // while the foreground project is open.
        await expect
          .poll(() => transientPairingFor(page, BACKGROUND_PROJECT_ID), { timeout: 8000, intervals: [100, 200, 500] })
          .toEqual({ 'slot-2': 'bg-sess-1' });

        // Give the foreground project windows at slot-1 AND slot-2, so a removal
        // for the background project's slot-2 terminal has a window to wrongly close.
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect
          .poll(async () => (await transientEntriesFor(page, BACKGROUND_FOREGROUND_PROJECT_ID)).length, { timeout: 5000, intervals: [100, 200, 500] })
          .toBe(2);
        const foregroundPairing = await transientPairingFor(page, BACKGROUND_FOREGROUND_PROJECT_ID);
        expect(Object.keys(foregroundPairing).sort()).toEqual(['slot-1', 'slot-2']);
        expect(Object.values(foregroundPairing)).not.toContain('bg-sess-1');

        await fireTerminalRemoved(page, { id: 'bg-sess-1', projectId: BACKGROUND_PROJECT_ID, slot: 'slot-2' });

        // The subscriber ran: the background project's pairing is dropped. Its
        // window close (if any) is part of the same synchronous handler, so the
        // reads below need no further wait.
        await expect
          .poll(() => transientPairingFor(page, BACKGROUND_PROJECT_ID), { timeout: 5000, intervals: [100, 200, 500] })
          .toEqual({});
        expect(await commandWindowAnchors(page)).toEqual(['slot-1', 'slot-2']);
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2);
        expect(await transientPairingFor(page, BACKGROUND_FOREGROUND_PROJECT_ID)).toEqual(foregroundPairing);
      } finally {
        await browser.close();
      }
    });

    test('a desktop Stop closes exactly its own window, even with main\'s removal push arriving mid-kill', async () => {
      // Real main announces the removal while the kill IPC is in flight. The
      // window let go of its entry first, so the push is not read as an end
      // main started, and nothing closes a second window.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        await page.evaluate((projectId) => {
          const win = window as unknown as {
            __mockFireRemoved: (id: string, session: unknown, projectId: string) => void;
            electronAPI: { sessions: { killTransient: (sessionId: string) => Promise<void> } };
          };
          win.electronAPI.sessions.killTransient = async (sessionId: string) => {
            win.__mockFireRemoved(sessionId, { id: sessionId, projectId, transient: true }, projectId);
          };
        }, MULTI_PROJECT_ID);

        await page.getByTestId('command-terminal-window').first().getByTestId('command-bar-terminate-button').click();

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        // Settle, then confirm the survivor stays.
        await expect.poll(async () => (await commandWindowAnchors(page)).length, { timeout: 2000 }).toBe(1);
      } finally {
        await browser.close();
      }
    });

    test('New terminal skips a slot a phone-started terminal already holds', async () => {
      // Main gave a phone's terminal slot-2 with this layer showing only
      // slot-1. Asking main for slot-2 again would be refused, so the next free
      // slot reads the project's live terminals as well as the open windows.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        await injectRunningTerminal(page, { id: 'phone-started-terminal', projectId: MULTI_PROJECT_ID, slot: 'slot-2' });
        await page.getByTestId('command-terminal-new').click();

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        expect(await commandWindowAnchors(page)).toEqual(['slot-1', 'slot-3']);
      } finally {
        await browser.close();
      }
    });

    test('New terminal disables when phone-started terminals fill the slots, with one window open', async () => {
      // Main caps a project at MAX_COMMAND_TERMINALS counting EVERY live terminal,
      // and a phone's terminals have no window here. A button that counted windows
      // alone would stay enabled at one window while main refuses the next start.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        const newTerminalButton = page.getByTestId('command-terminal-new');
        await expect(newTerminalButton).toBeEnabled();

        // Three phone-started terminals on slots 2 to 4, none with a window.
        for (const slotNumber of [2, 3, 4]) {
          await injectRunningTerminal(page, {
            id: `phone-started-terminal-${slotNumber}`,
            projectId: MULTI_PROJECT_ID,
            slot: `slot-${slotNumber}`,
          });
        }
        await expect
          .poll(async () => (await runningSessionIds(page, [
            'phone-started-terminal-2', 'phone-started-terminal-3', 'phone-started-terminal-4',
          ])).length, { timeout: 5000, intervals: [100, 200, 500] })
          .toBe(3);

        // Four slots are held (one window plus three phone terminals), so the button
        // is disabled even though only ONE window is open.
        await expect(newTerminalButton).toBeDisabled({ timeout: 3000 });
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);

        // A phone's Stop frees its slot, and the button follows.
        await fireTerminalRemoved(page, { id: 'phone-started-terminal-3', projectId: MULTI_PROJECT_ID, slot: 'slot-3' });
        await expect(newTerminalButton).toBeEnabled({ timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('New terminal disables at the cap (MAX_COMMAND_TERMINALS = 4) and says why', async () => {
      // When 4 windows are open (the cap), the rail's New terminal button disables.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the first window
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect(page.getByTestId('command-terminal-new')).toBeEnabled();

        // Spawn up to 4 windows total (3 more clicks)
        for (let iteration = 0; iteration < 3; iteration += 1) {
          await page.getByTestId('command-terminal-new').click();
          await expect(page.getByTestId('command-terminal-window')).toHaveCount(iteration + 2, { timeout: 5000 });
        }

        // At cap (4 windows) - New terminal is disabled, and its tip says why.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(4);
        await expect(page.getByTestId('command-terminal-new')).toBeDisabled({ timeout: 3000 });
        await expect(page.getByTestId('command-terminal-new')).toHaveAccessibleDescription('Stop one of the four to add another');
      } finally {
        await browser.close();
      }
    });

  });

  // ---------------------------------------------------------------------------
  // Launch overlay - CommandTerminalWindow.tsx and CommandTerminalPane.tsx
  // render LaunchOverlay, which paints the resolved terminal background (no
  // flash when the overlay lifts and the real terminal is revealed). These are
  // SEPARATE call sites from TerminalTab.tsx (covered by
  // launch-overlay-terminal-surface.spec.ts), so an overlay swapped for another
  // cover here alone would go undetected by that spec.
  // ---------------------------------------------------------------------------
  test.describe('Launch overlay', () => {
    test('a cold command-terminal spawn paints the launch overlay with the resolved terminal background', async () => {
      // multiTerminalPreConfig's spawnTransient never fires onFirstOutput, so
      // `terminalReady` (CommandTerminalWindow.tsx) stays false and the pane's
      // launch overlay stays mounted after the window opens - mirrors the
      // cold-session setup in launch-overlay-terminal-surface.spec.ts.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.getByTestId('quick-session-button').click();
        const commandWindow = page.getByTestId('command-terminal-window');
        await expect(commandWindow).toBeVisible();

        const overlay = commandWindow.locator('[data-testid="launch-overlay"]');
        await expect(overlay).toBeVisible();

        // Resolved default (#0c0c0c), not the theme-tracking bg-surface color.
        const overlayBackground = await overlay.evaluate((element) => getComputedStyle(element).backgroundColor);
        expect(overlayBackground).toBe('rgb(12, 12, 12)');
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Window population reconciliation (per project) - the headline bug fix: the
  // GLOBAL window store's population is reconciled to the CURRENT project's live
  // transient sessions on open, so a window count carried from one project never
  // spawns that many fresh PTYs in the next.
  // ---------------------------------------------------------------------------
  test.describe('Window population reconciliation (per project)', () => {
    let reconcileBrowser: Browser;
    let reconcilePage: Page;

    test.beforeAll(async () => {
      ({ browser: reconcileBrowser, page: reconcilePage } = await launchSharedBrowser(
        twoProjectSpawnCountingPreConfig(),
      ));
    });

    test.afterAll(async () => {
      await reconcileBrowser?.close();
    });

    test.beforeEach(async () => {
      await gotoVite(reconcilePage, VITE_URL);
      await reconcilePage.waitForLoadState('load');
      await reconcilePage.waitForSelector('text=Kangentic', { timeout: 15000 });
      await reconcilePage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test('two terminals in project A collapse to one fresh terminal in project B', async () => {
      const page = reconcilePage;

      // Two terminals in Project A (2 windows, 2 tracked A sessions).
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      await page.getByTestId('command-terminal-new').click();
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
      await expect
        .poll(async () => (await transientEntriesFor(page, PROJECT_A_ID)).length, { timeout: 5000, intervals: [100, 200, 500] })
        .toBe(2);

      // Hide the layer, then switch to Project B (wait for the switch to settle).
      // Two windows are mounted until the hide lands, so a visibility check on the
      // bare locator would be a strict-mode violation; the count is the question.
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
      await page.locator('[role="button"]:has-text("Project Beta")').click();
      await expect.poll(() => activeProjectId(page), { timeout: 5000, intervals: [100, 200, 500] }).toBe(PROJECT_B_ID);

      // Open in Project B: reconcile trims the 2 carried windows to 1, which
      // spawns exactly one fresh PTY for B.
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      await expect
        .poll(() => spawnCountFor(page, PROJECT_B_ID), { timeout: 5000, intervals: [100, 200, 500] })
        .toBe(1);
      await expect
        .poll(async () => (await transientEntriesFor(page, PROJECT_B_ID)).length, { timeout: 5000, intervals: [100, 200, 500] })
        .toBe(1);

      // A's two sessions were never touched: both still tracked and running.
      const aEntries = await transientEntriesFor(page, PROJECT_A_ID);
      expect(aEntries).toHaveLength(2);
      const aSessionIds = aEntries.map((entry) => entry.sessionId).sort();
      const stillRunning = await runningSessionIds(page, aSessionIds);
      expect(stillRunning.sort()).toEqual(aSessionIds);

      // Exactly one window, on a slot with a live B session; B never got a 2nd spawn.
      const anchors = await commandWindowAnchors(page);
      expect(anchors).toHaveLength(1);
      const bSlots = (await transientEntriesFor(page, PROJECT_B_ID)).map((entry) => entry.slot);
      expect(bSlots).toContain(anchors[0]);
      expect(await spawnCountFor(page, PROJECT_B_ID)).toBe(1);
    });

    test('returning to a project reopens a window per live session and reattaches without spawning', async () => {
      const page = reconcilePage;

      // Two terminals in Project A; capture their session ids.
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      await page.getByTestId('command-terminal-new').click();
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
      await expect
        .poll(async () => (await transientEntriesFor(page, PROJECT_A_ID)).length, { timeout: 5000, intervals: [100, 200, 500] })
        .toBe(2);
      const originalASessionIds = (await transientEntriesFor(page, PROJECT_A_ID)).map((entry) => entry.sessionId).sort();

      // Hide, switch to B, open (spawns B's one terminal), hide again. Two windows
      // are mounted until the first hide lands, so it asserts the count (a bare
      // visibility check on two matches is a strict-mode violation).
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
      await page.locator('[role="button"]:has-text("Project Beta")').click();
      await expect.poll(() => activeProjectId(page), { timeout: 5000, intervals: [100, 200, 500] }).toBe(PROJECT_B_ID);
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

      // Switch back to A and reopen: both windows return and reattach, no new spawns.
      await page.locator('[role="button"]:has-text("Project Alpha")').click();
      await expect.poll(() => activeProjectId(page), { timeout: 5000, intervals: [100, 200, 500] }).toBe(PROJECT_A_ID);
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
      await expect.poll(() => commandWindowAnchors(page), { timeout: 5000, intervals: [100, 200, 500] }).toEqual(['slot-1', 'slot-2']);

      // The two A entries carry the ORIGINAL session ids (reattach, not respawn),
      // and A never got a spawn beyond the initial two.
      await expect
        .poll(async () => (await transientEntriesFor(page, PROJECT_A_ID)).map((entry) => entry.sessionId).sort().join(','), { timeout: 5000, intervals: [100, 200, 500] })
        .toBe(originalASessionIds.join(','));
      expect(await spawnCountFor(page, PROJECT_A_ID)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Window population reconciliation (restart and hard reload) - the app-restart
  // path restores the GLOBAL geometry blob, then reconciles the population to the
  // project's live sessions before the layer mounts.
  // ---------------------------------------------------------------------------
  test.describe('Window population reconciliation (restart and hard reload)', () => {
    test('a persisted multi-window layout is trimmed to one window on first open', async () => {
      const { browser, page } = await launchWithState(restartBlobPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // The seeded 2-window blob is in global config BEFORE opening, so a trim
        // to one window proves reconcile ran (not merely an empty layout).
        await expect
          .poll(() => page.evaluate(() => {
            const stores = (window as unknown as {
              __zustandStores?: { config?: { getState: () => { globalConfig: { commandTerminalWorkspace: { windows?: unknown[] } | null } } } };
            }).__zustandStores;
            return stores?.config?.getState().globalConfig.commandTerminalWorkspace?.windows?.length ?? 0;
          }), { timeout: 5000, intervals: [100, 200, 500] })
          .toBe(2);

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect
          .poll(() => spawnCountFor(page, RECONCILE_PROJECT_ID), { timeout: 5000, intervals: [100, 200, 500] })
          .toBe(1);
      } finally {
        await browser.close();
      }
    });

    test('a hard reload with surviving PTYs restores a window per survivor and reattaches', async () => {
      const { browser, page } = await launchWithState(hardReloadPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // syncSessions re-pairs the two surviving transient PTYs to slot-1 /
        // slot-2 at boot; wait for that before opening (avoids the boot race).
        await expect
          .poll(async () => (await transientEntriesFor(page, HARD_RELOAD_PROJECT_ID)).length, { timeout: 8000, intervals: [100, 200, 500] })
          .toBe(2);

        // Each survivor is paired to the slot MAIN recorded for it. A length check
        // alone cannot tell a correct pairing from a window quietly showing the
        // other terminal's conversation, which is the failure this guards.
        expect(await transientPairingFor(page, HARD_RELOAD_PROJECT_ID)).toEqual({
          'slot-1': 'hr-sess-1',
          'slot-2': 'hr-sess-2',
        });
        // The branch survives recovery too, so the header pill is not blank.
        const recoveredBranches = (await transientEntriesFor(page, HARD_RELOAD_PROJECT_ID))
          .sort((first, second) => first.slot.localeCompare(second.slot))
          .map((entry) => entry.branch);
        expect(recoveredBranches).toEqual(['main', 'feature/two']);

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        // Both reattached: no fresh spawns for the project.
        expect(await spawnCountFor(page, HARD_RELOAD_PROJECT_ID)).toBe(0);

        // Regression guard: a count/spawn match alone does not prove the SAVED
        // layout blob was restored - a reconcile that pre-populated the empty
        // store with fresh windows (before `useEnsureCommandWindow` got a chance
        // to `applyWorkspace`) also reattaches both slots with 0 spawns, just in
        // a fresh layout: slot-1 first, an even split. The blob puts slot-2 first
        // at 0.3, and the panel keeps a layout that is already its preset.
        await expect
          .poll(async () => (await commandTileLayout(page))?.slots ?? [], { timeout: 5000, intervals: [100, 200, 500] })
          .toEqual(['slot-2', 'slot-1']);
        const restoredLayout = await commandTileLayout(page);
        expect(Math.abs((restoredLayout?.sizes[0] ?? 0) - 0.3)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
      } finally {
        await browser.close();
      }
    });

    test('a layout saved before the panel (floating windows) opens tiled in the panel and reattaches', async () => {
      // Every existing user's config holds the floating-window blob. The panel
      // restores it, reconciles it to the live terminals, then tiles it into
      // its two-up preset: both survivors reattach and nothing spawns.
      const { browser, page } = await launchWithState(hardReloadPreConfig(legacyFloatingBlobSource()));
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect
          .poll(async () => (await transientEntriesFor(page, HARD_RELOAD_PROJECT_ID)).length, { timeout: 8000, intervals: [100, 200, 500] })
          .toBe(2);

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect
          .poll(async () => (await commandTileLayout(page))?.slots ?? [], { timeout: 5000, intervals: [100, 200, 500] })
          .toEqual(['slot-1', 'slot-2']);
        const layout = await commandTileLayout(page);
        expect(Math.abs((layout?.sizes[0] ?? 0) - 0.5)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
        expect(await spawnCountFor(page, HARD_RELOAD_PROJECT_ID)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('survivors are paired to their own slots, not to a position in a sorted list', async () => {
      const { browser, page } = await launchWithState(slotMismatchPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await expect
          .poll(() => transientPairingFor(page, SLOT_MISMATCH_PROJECT_ID), { timeout: 8000, intervals: [100, 200, 500] })
          .toEqual({ 'slot-2': 'sm-zzz', 'slot-3': 'sm-aaa' });

        // Slots 2 and 3 with nothing on slot 1: the numbering is the terminal's own
        // durable identity, not a rank, so a window keeps its name when a sibling
        // is closed. Renumbering here would rename a window the user is looking at.
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect
          .poll(() => commandWindowAnchors(page), { timeout: 5000, intervals: [100, 200, 500] })
          .toEqual(['slot-2', 'slot-3']);
        expect(await spawnCountFor(page, SLOT_MISMATCH_PROJECT_ID)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('a survivor is still recovered when a fresh spawn already tracked the project', async () => {
      // The reported production failure. Recovery used to bail the moment the
      // project had ANY tracked entry, so the terminal that won the post-reload
      // race permanently hid every other survivor: the PTY kept running with its
      // pending question and nothing could reach it.
      const { browser, page } = await launchWithState(orphanRacePreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // A real spawn puts slot-1 in the map, so the project is "already tracked".
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect
          .poll(async () => (await transientEntriesFor(page, ORPHAN_RACE_PROJECT_ID)).length, { timeout: 5000, intervals: [100, 200, 500] })
          .toBe(1);
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).not.toBeVisible({ timeout: 5000 });

        // Main was keeping a second terminal alive all along, stamped with the same
        // slot the fresh spawn took (a slot is reused as soon as its window closes).
        await injectRunningTerminal(page, {
          id: 'orphaned-pty', projectId: ORPHAN_RACE_PROJECT_ID, slot: 'slot-1', branch: 'main',
        });
        await expect
          .poll(async () => (await runningSessionIds(page, ['orphaned-pty'])).length, { timeout: 5000, intervals: [100, 200, 500] })
          .toBe(1);

        // The live window keeps slot-1; the survivor re-homes rather than being
        // dropped, so both PTYs stay reachable.
        await expect
          .poll(async () => (await transientEntriesFor(page, ORPHAN_RACE_PROJECT_ID)).length, { timeout: 5000, intervals: [100, 200, 500] })
          .toBe(2);
        const pairing = await transientPairingFor(page, ORPHAN_RACE_PROJECT_ID);
        expect(Object.values(pairing)).toContain('orphaned-pty');

        // The symptom the bug report opens with: the sidebar counted both PTYs
        // (it reads main's rows) while only one window existed. A pairing-only
        // assertion can pass while the layer still shows one window for two PTYs.
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        expect(await sidebarTerminalCount(page, ORPHAN_RACE_PROJECT_ID)).toBe(2);
        // Adopted, not respawned: still the one spawn from the top of the test.
        expect(await spawnCountFor(page, ORPHAN_RACE_PROJECT_ID)).toBe(1);
      } finally {
        await browser.close();
      }
    });

    test('a window mounting with no pairing adopts the live PTY for its slot instead of spawning', async () => {
      // The mount effect's own guard, isolated. Recovery normally re-pairs before
      // any window mounts, so the only way to reach this is to hand the renderer
      // the state it protects against: main still running a terminal for slot-1
      // while the pairing map holds nothing. Spawning here would BOTH manufacture
      // a duplicate PTY and strand the live one.
      const { browser, page } = await launchWithState(adoptPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect
          .poll(async () => (await transientEntriesFor(page, ADOPT_PROJECT_ID)).length, { timeout: 8000, intervals: [100, 200, 500] })
          .toBe(1);

        await clearTransientPairings(page);
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        // Bound to the SURVIVOR, and the map re-points at it. A fresh spawn would
        // satisfy the window count just as well, which is why neither assertion
        // alone is enough.
        await expect
          .poll(() => transientPairingFor(page, ADOPT_PROJECT_ID), { timeout: 5000, intervals: [100, 200, 500] })
          .toEqual({ 'slot-1': 'ad-sess-1' });
        expect(await spawnCountFor(page, ADOPT_PROJECT_ID)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('a background project keeps its surviving terminal', async () => {
      const { browser, page } = await launchWithState(backgroundProjectPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Recovered while the OTHER project is open. Scoping recovery to the current
        // project left this PTY unpaired until the user switched, by which point the
        // layer had already spawned a fresh terminal over the top of it.
        await expect
          .poll(() => transientPairingFor(page, BACKGROUND_PROJECT_ID), { timeout: 8000, intervals: [100, 200, 500] })
          .toEqual({ 'slot-2': 'bg-sess-1' });

        await page.locator('[role="button"]:has-text("Background Project")').click();
        await expect.poll(() => activeProjectId(page), { timeout: 5000, intervals: [100, 200, 500] }).toBe(BACKGROUND_PROJECT_ID);
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect
          .poll(() => commandWindowAnchors(page), { timeout: 5000, intervals: [100, 200, 500] })
          .toEqual(['slot-2']);
        expect(await spawnCountFor(page, BACKGROUND_PROJECT_ID)).toBe(0);
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Panel layout - the terminals are tiles of ONE panel (CommandTerminalPanel),
  // laid out by the panel in a preset for their count (`arrangeTiles`): one
  // fills the terminal area, two sit side by side, three are one tall beside two
  // stacked, four are a two by two grid. A terminal never floats on its own.
  // ---------------------------------------------------------------------------
  test.describe('Panel layout', () => {
    /** Pixel tolerance for layout comparisons (sub-pixel rounding differs by platform). */
    const PIXEL_TOLERANCE = 3;

    interface Box { left: number; top: number; width: number; height: number }

    /** Every terminal's frame box, keyed by slot, and the terminal area's box. */
    async function layoutBoxes(page: Page): Promise<{ area: Box; panes: Record<string, Box> }> {
      return page.evaluate(() => {
        const toBox = (element: Element): { left: number; top: number; width: number; height: number } => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        };
        const panes: Record<string, { left: number; top: number; width: number; height: number }> = {};
        for (const content of document.querySelectorAll('[data-testid="command-terminal-window"]')) {
          const frame = content.closest('[data-testid^="window-frame-"]') ?? content;
          panes[content.getAttribute('data-command-slot') ?? '?'] = toBox(frame);
        }
        return { area: toBox(document.querySelector('[data-testid="command-terminal-area"]')!), panes };
      });
    }

    function expectNear(actual: number, expected: number, label: string): void {
      expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(PIXEL_TOLERANCE);
    }

    test('terminals tile in the preset for their count, and re-tile when one stops', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        // One terminal fills the terminal area.
        await expect.poll(async () => {
          const { area, panes } = await layoutBoxes(page);
          return Math.abs(panes['slot-1'].width - area.width) <= PIXEL_TOLERANCE
            && Math.abs(panes['slot-1'].height - area.height) <= PIXEL_TOLERANCE;
        }, { timeout: 3000 }).toBe(true);

        // Two sit side by side, each the full height.
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        // Poll for the settled two-up (slot-2 at the area's horizontal middle), not for
        // the frame merely existing: the tiles reach their halves a hop after they mount.
        await expect.poll(async () => {
          const layout = await layoutBoxes(page);
          const second = layout.panes['slot-2'];
          return !!second && Math.abs(second.left - (layout.area.left + layout.area.width / 2)) <= PIXEL_TOLERANCE;
        }, { timeout: 3000 }).toBe(true);
        let { area, panes } = await layoutBoxes(page);
        expectNear(panes['slot-1'].left, area.left, 'slot-1 left');
        expectNear(panes['slot-2'].left, area.left + area.width / 2, 'slot-2 left');
        expectNear(panes['slot-1'].height, area.height, 'slot-1 height');
        expectNear(panes['slot-2'].height, area.height, 'slot-2 height');

        // Three: one tall on the left, two stacked on the right.
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(3, { timeout: 5000 });
        await expect.poll(async () => (await layoutBoxes(page)).panes['slot-3']?.top ?? 0, { timeout: 3000 }).toBeGreaterThan(area.top + area.height / 4);
        ({ area, panes } = await layoutBoxes(page));
        expectNear(panes['slot-1'].height, area.height, 'slot-1 tall');
        expectNear(panes['slot-2'].top, area.top, 'slot-2 top');
        expectNear(panes['slot-3'].top, area.top + area.height / 2, 'slot-3 below');
        expectNear(panes['slot-3'].left, panes['slot-2'].left, 'slot-3 under slot-2');

        // Four: a two by two grid that reads 1 2 / 3 4.
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(4, { timeout: 5000 });
        await expect.poll(async () => (await layoutBoxes(page)).panes['slot-1'].height, { timeout: 3000 }).toBeLessThan(area.height * 0.75);
        ({ area, panes } = await layoutBoxes(page));
        expectNear(panes['slot-1'].left, area.left, 'slot-1 left column');
        expectNear(panes['slot-3'].left, area.left, 'slot-3 left column');
        expectNear(panes['slot-2'].top, area.top, 'slot-2 top row');
        expectNear(panes['slot-4'].left, panes['slot-2'].left, 'slot-4 right column');
        expectNear(panes['slot-3'].top, area.top + area.height / 2, 'slot-3 bottom row');

        // Stopping one re-tiles the other three into the three-terminal preset.
        await page.locator('[data-command-slot="slot-2"]').getByTestId('command-bar-terminate-button').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(3, { timeout: 5000 });
        await expect.poll(async () => {
          const layout = await layoutBoxes(page);
          return Object.values(layout.panes).filter((pane) => Math.abs(pane.height - layout.area.height) <= PIXEL_TOLERANCE).length;
        }, { timeout: 3000 }).toBe(1);
      } finally {
        await browser.close();
      }
    });

    test('a terminal has no window controls of its own, and its focus border shows only beside another', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        const firstTerminal = page.getByTestId('command-terminal-window');
        await expect(firstTerminal).toHaveCount(1, { timeout: 5000 });

        // The panel moves, resizes and maximizes; a terminal does none of these.
        await expect(page.locator('[data-testid^="window-resize-"]')).toHaveCount(0);
        await expect(firstTerminal.getByRole('button', { name: /pop out|maximize|restore/i })).toHaveCount(0);

        // A lone terminal is plainly the one taking keys, so it draws no focus border.
        const framesWithFocusBorder = page.locator('[data-testid^="window-frame-"][class*="focus-within:border-accent"]');
        await expect(framesWithFocusBorder).toHaveCount(0);

        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect(framesWithFocusBorder).toHaveCount(2);

        // The cue is the still border alone: the focused frame's border differs from
        // its neighbor's, and no pulsing line is drawn along its top.
        const frames = page.locator('[data-testid^="window-frame-"]');
        await frames.first().locator('.xterm-helper-textarea').focus();
        await expect.poll(async () => frames.evaluateAll((elements) => {
          const colors = elements.map((element) => getComputedStyle(element).borderTopColor);
          return colors.length === 2 && colors[0] !== colors[1];
        })).toBe(true);
        await expect(page.locator('[data-testid^="window-frame-"] > [class*="animate-pulse"]')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('a panel never moved opens centered, its lone terminal as large as one before the panel', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        expect(await page.evaluate(async () => (await window.electronAPI.config.getGlobal()).commandTerminalPanel ?? null)).toBeNull();

        const area = await page.getByTestId('command-terminal-panel-area').boundingBox();
        const panel = await page.getByTestId('command-terminal-panel').boundingBox();
        if (!area || !panel) throw new Error('no panel');
        // The release opened a Command Terminal at 58% by 70% of this area.
        await expect.poll(async () => {
          const pane = (await layoutBoxes(page)).panes['slot-1'];
          if (!pane) return 'no pane';
          const off = Math.max(Math.abs(pane.width - area.width * 0.58), Math.abs(pane.height - area.height * 0.7));
          return off <= 2 ? 'released size' : `${pane.width} x ${pane.height}`;
        }, { timeout: 3000 }).toBe('released size');
        expectNear(panel.x - area.x, area.x + area.width - (panel.x + panel.width), 'left and right margins');
        expectNear(panel.y - area.y, area.y + area.height - (panel.y + panel.height), 'top and bottom margins');
      } finally {
        await browser.close();
      }
    });

    test('a terminal\'s text sits 8px in from its pane\'s left, top and bottom, the scrollbar gutter on its right', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        await expect.poll(() => page.evaluate(() => {
          const panes = [...document.querySelectorAll('[data-testid="command-bar-terminal-pane"]')];
          if (panes.length !== 2) return 'not mounted';
          const problems: string[] = [];
          for (const pane of panes) {
            const screen = pane.querySelector('.xterm-screen');
            const viewport = pane.querySelector<HTMLElement>('.xterm-viewport');
            if (!screen || !viewport) return 'no screen';
            const paneBox = pane.getBoundingClientRect();
            const screenBox = screen.getBoundingClientRect();
            if (screenBox.width === 0) return 'no screen yet';
            // A generous cell bound: the leftover is under one row or column.
            const cellHeight = 30;
            const gutter = viewport.offsetWidth - viewport.clientWidth;
            const left = screenBox.left - paneBox.left;
            const top = screenBox.top - paneBox.top;
            const bottom = paneBox.bottom - screenBox.bottom;
            const right = paneBox.right - screenBox.right;
            if (Math.abs(left - 8) > 0.5) problems.push(`left ${left}`);
            if (Math.abs(top - 8) > 0.5) problems.push(`top ${top}`);
            // The rows end on whole cells, so the bottom takes the 8px plus under a row.
            if (bottom < 7.5 || bottom > 8 + cellHeight) problems.push(`bottom ${bottom}`);
            // The gutter is the right side's inset, plus under a column of leftover.
            if (right < gutter - 0.5 || right > gutter + 20) problems.push(`right ${right} (gutter ${gutter})`);
          }
          return problems.length ? problems.join('; ') : 'inset';
        }), { timeout: 5000 }).toBe('inset');
      } finally {
        await browser.close();
      }
    });

    test('the panel sits on whole pixels, so no terminal border is cut by its clip', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        // Fractions of the area that land between pixels, as a dragged panel's do.
        await page.evaluate(() => {
          const stores = (window as unknown as {
            __zustandStores: { config: { getState: () => { saveCommandTerminalPanel: (geometry: { x: number; y: number; w: number; h: number; maximized: boolean }) => void } } };
          }).__zustandStores;
          stores.config.getState().saveCommandTerminalPanel({ x: 0.0371, y: 0.0517, w: 0.8913, h: 0.8677, maximized: false });
        });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        await expect.poll(() => page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>('[data-testid="command-terminal-panel"]');
          const area = document.querySelector('[data-testid="command-window-overlay"]')?.getBoundingClientRect();
          const frames = [...document.querySelectorAll('[data-testid^="window-frame-"]')]
            .filter((frame) => frame.querySelector('[data-command-slot]'))
            .map((frame) => frame.getBoundingClientRect());
          if (!panel || !area || frames.length !== 2) return 'not laid out';
          const whole = [panel.style.left, panel.style.top, panel.style.width, panel.style.height]
            .every((value) => Number.isInteger(parseFloat(value)));
          if (!whole) return `panel off whole pixels: ${panel.style.cssText}`;
          // Every frame's edge, its focus border included, inside the area the panel clips to.
          const overhang = Math.max(...frames.map((frame) => Math.max(frame.bottom - area.bottom, frame.right - area.right)));
          return overhang <= 0.01 ? 'fits' : `frame overhangs the area by ${overhang}px`;
        }), { timeout: 3000 }).toBe('fits');
      } finally {
        await browser.close();
      }
    });

    test('the panel moves by its header, and keeps and saves its place across a hide', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        const panel = page.getByTestId('command-terminal-panel');
        const before = await panel.boundingBox();
        const header = await page.getByTestId('command-terminal-panel-header').boundingBox();
        expect(before && header).toBeTruthy();
        if (!before || !header) return;
        // Press on the header's empty middle, clear of its buttons.
        const startX = header.x + header.width / 2;
        const startY = header.y + header.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX - 20, startY + 30, { steps: 6 });
        await page.mouse.up();

        await expect.poll(async () => (await panel.boundingBox())?.y ?? 0, { timeout: 3000 }).toBeGreaterThan(before.y + 20);
        const moved = await panel.boundingBox();
        await expect.poll(() => page.evaluate(async () => {
          const config = await window.electronAPI.config.getGlobal();
          return config.commandTerminalPanel !== null;
        }), { timeout: 3000 }).toBe(true);

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        const reopened = await panel.boundingBox();
        expectNear(reopened?.x ?? 0, moved?.x ?? 0, 'panel x after reopen');
        expectNear(reopened?.y ?? 0, moved?.y ?? 0, 'panel y after reopen');
      } finally {
        await browser.close();
      }
    });

    test('an edge drag resizes the panel and its terminal live, and the PTY resizes once, on release', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        // The terminal settles first: its mount fit, then a refit once its footer
        // mounts, each reaching the PTY after a debounce. Only the drag's count.
        let previousCount = -1;
        await expect.poll(async () => {
          const count = await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length);
          const settled = count > 0 && count === previousCount;
          previousCount = count;
          return settled;
        }, { intervals: [500], timeout: 10000 }).toBe(true);
        await page.evaluate(() => { window.electronAPI.sessions.__resizeCalls.length = 0; });

        const panel = page.getByTestId('command-terminal-panel');
        const areaBefore = (await layoutBoxes(page)).area;
        const before = await panel.boundingBox();
        const edge = await page.getByTestId('command-terminal-panel-resize-e').boundingBox();
        expect(before && edge).toBeTruthy();
        if (!before || !edge) return;
        const startX = edge.x + edge.width / 2;
        const startY = edge.y + edge.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX - 120, startY, { steps: 6 });

        // Mid-drag the panel and the terminal in it already have the new width,
        // with no outline drawn, and no resize has reached the PTY.
        await expect.poll(async () => (await panel.boundingBox())?.width ?? 0, { timeout: 3000 }).toBeLessThan(before.width - 100);
        await expect.poll(async () => {
          const { area, panes } = await layoutBoxes(page);
          return Math.abs(panes['slot-1'].width - area.width) <= PIXEL_TOLERANCE && area.width < areaBefore.width - 100;
        }, { timeout: 3000 }).toBe(true);
        await expect(page.getByTestId('command-terminal-panel-resize-preview')).toHaveCount(0);
        await page.mouse.move(startX - 200, startY, { steps: 6 });
        expect(await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length)).toBe(0);

        await page.mouse.up();
        await expect.poll(() => page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length), { timeout: 3000 }).toBe(1);
        expectNear((await panel.boundingBox())?.width ?? 0, before.width - 200, 'panel width after release');
        await expect.poll(() => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).commandTerminalPanel !== null), { timeout: 3000 }).toBe(true);
      } finally {
        await browser.close();
      }
    });

    /** The panel open on one terminal whose startup fits have reached the PTY, with the resize log cleared. */
    async function openPanelSettled(page: Page): Promise<void> {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      let previousCount = -1;
      await expect.poll(async () => {
        const count = await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length);
        const settled = count > 0 && count === previousCount;
        previousCount = count;
        return settled;
      }, { intervals: [500], timeout: 10000 }).toBe(true);
      await page.evaluate(() => { window.electronAPI.sessions.__resizeCalls.length = 0; });
    }

    const resizeCallCount = (page: Page) => page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length);

    /** The panel's saved place in global config, or null until it is moved or resized. */
    const savedPanelPlace = (page: Page) => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).commandTerminalPanel ?? null);

    /** The grab point at the middle of one of the panel's resize edges. */
    async function edgePoint(page: Page, edge: string): Promise<{ x: number; y: number }> {
      const box = await page.getByTestId(`command-terminal-panel-resize-${edge}`).boundingBox();
      if (!box) throw new Error(`no ${edge} edge`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    /** Where `expectNear` finds a panel box that was put back: its own start, edge to edge. */
    function expectSameBox(actual: Box | null, expected: Box, label: string): void {
      if (!actual) throw new Error(`${label}: no box`);
      expectNear(actual.left, expected.left, `${label} left`);
      expectNear(actual.top, expected.top, `${label} top`);
      expectNear(actual.width, expected.width, `${label} width`);
      expectNear(actual.height, expected.height, `${label} height`);
    }

    const boxOf = async (locator: Locator): Promise<Box> => {
      const box = await locator.boundingBox();
      if (!box) throw new Error('no box');
      return { left: box.x, top: box.y, width: box.width, height: box.height };
    };

    test('a panel edge drag whose release went unseen ends where it stood: the gate frees, the box is kept and saved, and the terminal refits', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openPanelSettled(page);
        expect(await savedPanelPlace(page)).toBeNull();
        const panel = page.getByTestId('command-terminal-panel');
        const before = await boxOf(panel);
        const since = Date.now();

        // Press the east edge and drag it 80px in, then lose the release: nothing
        // closes the drag but the gate, which watches the pointer for it.
        await page.evaluate(() => {
          const edge = document.querySelector<HTMLElement>('[data-testid="command-terminal-panel-resize-e"]');
          if (!edge) throw new Error('no east edge');
          const box = edge.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const init = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
          edge.dispatchEvent(new PointerEvent('pointerdown', { ...init, button: 0, buttons: 1, clientX: x, clientY: y }));
          edge.dispatchEvent(new PointerEvent('pointermove', { ...init, button: -1, buttons: 1, clientX: x - 80, clientY: y }));
        });
        // The drag is live: the gate is held, the panel follows the pointer, and the PTY has heard nothing.
        await expect.poll(() => isManagerResizeGateOpen(page)).toBe(true);
        await expect.poll(async () => (await boxOf(panel)).width, { timeout: 3000 }).toBeLessThan(before.width - 60);
        expect(await resizeCallCount(page)).toBe(0);

        // The pointer moves on with no button held: the drag is over, and the gate commits it as it stands.
        await page.mouse.move(20, 20);
        await expect.poll(() => isManagerResizeGateOpen(page)).toBe(false);
        // The gate named the panel as the owner it abandoned, on the buttonless pointer event
        // (the browser sends a pointerover ahead of the move when the pointer lands on a new element).
        const abandoned = (await readTerminalTrace(page, since, ['manager-resize-abandoned'])).map((entry) => entry.detail);
        expect(abandoned).toHaveLength(1);
        expect(abandoned[0]).toMatchObject({ owner: 'command-terminal-panel' });
        expect(['pointermove', 'pointerover']).toContain(abandoned[0]?.reason);
        expectNear((await boxOf(panel)).width, before.width - 80, 'panel width kept');
        await expect.poll(() => savedPanelPlace(page), { timeout: 3000 }).not.toBeNull();
        await expect.poll(() => resizeCallCount(page), { timeout: 3000 }).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    });

    test('Escape mid-resize puts the panel back where it started, saves nothing, frees the gate and leaves the panel open', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openPanelSettled(page);
        expect(await savedPanelPlace(page)).toBeNull();
        const panel = page.getByTestId('command-terminal-panel');
        const before = await boxOf(panel);
        const grab = await edgePoint(page, 'e');
        await page.mouse.move(grab.x, grab.y);
        await page.mouse.down();
        await page.mouse.move(grab.x - 120, grab.y, { steps: 6 });
        await expect.poll(async () => (await boxOf(panel)).width, { timeout: 3000 }).toBeLessThan(before.width - 100);
        await expect.poll(() => isManagerResizeGateOpen(page)).toBe(true);

        await page.keyboard.press('Escape');

        // Read with the button still down: a release would let the gate sweep up a
        // gesture Escape had leaked, and hide it.
        await expect.poll(() => isManagerResizeGateOpen(page)).toBe(false);
        expectSameBox(await boxOf(panel), before, 'panel after Escape');
        // Escape cancelled the gesture, not the layer.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);

        await page.mouse.up();
        // Frames, not a timer: long enough for a save, were there one, to land.
        await settleFrames(page, 20);
        expect(await savedPanelPlace(page)).toBeNull();
        expectSameBox(await boxOf(panel), before, 'panel after the release');
      } finally {
        await browser.close();
      }
    });

    test('Escape mid-move puts the panel back where it started, saves nothing and leaves the panel open', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openPanelSettled(page);
        expect(await savedPanelPlace(page)).toBeNull();
        const panel = page.getByTestId('command-terminal-panel');
        const before = await boxOf(panel);
        const header = await page.getByTestId('command-terminal-panel-header').boundingBox();
        if (!header) throw new Error('no panel header');
        // The header's empty middle, clear of its buttons.
        const grabX = header.x + header.width / 2;
        const grabY = header.y + header.height / 2;
        await page.mouse.move(grabX, grabY);
        await page.mouse.down();
        await page.mouse.move(grabX - 40, grabY + 60, { steps: 6 });
        await expect.poll(async () => (await boxOf(panel)).top, { timeout: 3000 }).toBeGreaterThan(before.top + 40);

        await page.keyboard.press('Escape');

        await expect.poll(async () => (await boxOf(panel)).top, { timeout: 3000 }).toBeLessThanOrEqual(before.top + 3);
        expectSameBox(await boxOf(panel), before, 'panel after Escape');
        await expect(panel).toHaveCSS('transform', 'none');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);

        await page.mouse.up();
        await settleFrames(page, 20);
        expect(await savedPanelPlace(page)).toBeNull();
        expectSameBox(await boxOf(panel), before, 'panel after the release');
      } finally {
        await browser.close();
      }
    });

    for (const hide of [
      { way: 'Hide button', act: (page: Page) => page.getByTestId('command-terminal-panel-hide').dispatchEvent('click') },
      { way: 'panel.close shortcut', act: (page: Page) => page.keyboard.press('Control+Shift+W') },
    ]) {
      test(`hiding the panel with its ${hide.way} mid-resize frees the gate, so a later refit lands`, async () => {
        const { browser, page } = await launchWithState(multiTerminalPreConfig());
        try {
          await openPanelSettled(page);
          const panel = page.getByTestId('command-terminal-panel');
          const before = await boxOf(panel);
          const grab = await edgePoint(page, 'e');
          await page.mouse.move(grab.x, grab.y);
          await page.mouse.down();
          await page.mouse.move(grab.x - 120, grab.y, { steps: 6 });
          await expect.poll(async () => (await boxOf(panel)).width, { timeout: 3000 }).toBeLessThan(before.width - 100);
          await expect.poll(() => isManagerResizeGateOpen(page)).toBe(true);

          await hide.act(page);

          await expect(page.getByTestId('command-terminal-layer')).toHaveCount(0, { timeout: 3000 });
          // Read with the button still down, so a leaked gesture cannot be swept up by a release.
          await expect.poll(() => isManagerResizeGateOpen(page)).toBe(false);

          // The button stays down, so the gate can only be free because the unmount freed it: the
          // reopened panel's terminals refit when it maximizes (keyboard only, no pointer event).
          await page.keyboard.press('Control+Shift+P');
          await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
          await settleResizes(page);
          await page.keyboard.press('Control+Shift+M');
          await expect(page.getByTestId('command-terminal-panel')).toHaveAttribute('data-maximized', 'true');
          await expect.poll(() => resizeCallCount(page), { timeout: 3000 }).toBeGreaterThan(0);
          await page.mouse.up();
        } finally {
          await browser.close();
        }
      });
    }
  });

  /** Each slot's session id, with its agent marked on screen and its terminal initialized. */
  async function markTerminalsReady(page: Page, slots: readonly string[]): Promise<Record<string, string>> {
    const sessions: Record<string, string> = {};
    for (const slot of slots) {
      const sessionId = await page.locator(`[data-command-slot="${slot}"]`)
        .getByTestId('command-bar-terminal-pane').getAttribute('data-session-id');
      if (!sessionId) throw new Error(`no session in ${slot}`);
      sessions[slot] = sessionId;
    }
    await page.evaluate((ids) => {
      const store = (window as unknown as {
        __zustandStores: { session: { getState: () => { markFirstOutput: (id: string) => void } } };
      }).__zustandStores.session.getState();
      for (const id of ids) store.markFirstOutput(id);
    }, Object.values(sessions));
    await expect(page.locator('[data-testid="command-terminal-window"] [data-testid="launch-overlay"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="command-terminal-window"] .xterm-helper-textarea')).toHaveCount(slots.length, { timeout: 8000 });
    return sessions;
  }

  /** Wait until no terminal resize has reached a PTY for a beat, then forget the ones that did. */
  async function settleResizes(page: Page): Promise<void> {
    let previousCount = -1;
    await expect.poll(async () => {
      const count = await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length);
      const settled = count === previousCount;
      previousCount = count;
      return settled;
    }, { intervals: [400], timeout: 8000 }).toBe(true);
    await page.evaluate(() => { window.electronAPI.sessions.__resizeCalls.length = 0; });
  }

  /** The panel's layout-change scope: a user's change lands in it, and its terminals hold their frames until they repaint. */
  const PANEL_SCOPE = '[data-testid="command-terminal-panel-area"]';

  /**
   * Record every frame hold the panel's terminals go through from now on, as the
   * span while any of them holds one: a final read cannot see one that came
   * and went.
   */
  const watchFrameHolds = (page: Page) => page.evaluate(({ selector, holdSelector }) => {
    const holder = window as unknown as { __frameHolds: Array<{ held: number; drawn: number | null }> };
    holder.__frameHolds = [];
    const scope = document.querySelector(selector);
    if (!scope) throw new Error('no panel area');
    new MutationObserver(() => {
      const holding = scope.querySelector(holdSelector) !== null;
      const last = holder.__frameHolds.at(-1);
      if (holding && (!last || last.drawn !== null)) holder.__frameHolds.push({ held: performance.now(), drawn: null });
      if (!holding && last && last.drawn === null) last.drawn = performance.now();
    }).observe(scope, { subtree: true, attributes: true, attributeFilter: ['data-terminal-frame-hold'] });
  }, { selector: PANEL_SCOPE, holdSelector: TERMINAL_FRAME_HOLD_SELECTOR });
  const frameHolds = (page: Page) => page.evaluate(() =>
    (window as unknown as { __frameHolds: Array<{ held: number; drawn: number | null }> }).__frameHolds);

  /** A screen of text in each terminal, the cursor hidden (it blinks) and motion off: only a layout change can move a pixel. */
  const stillTerminals = (page: Page, sessionIds: string[]) => page.evaluate((ids) => {
    const fire = (window as unknown as { __mockFireSessionData: (id: string, data: string) => void }).__mockFireSessionData;
    let screen = '';
    for (let row = 0; row < 16; row += 1) screen += `frame text line ${row} `.padEnd(60, '.') + '\r\n';
    for (const id of ids) fire(id, `${screen}\x1b[?25l`);
    document.documentElement.classList.add('no-motion');
  }, sessionIds);

  /** Frames, not a timer: long enough for any refit or PTY resize a gesture could send. */
  const settleFrames = (page: Page, frames: number) => page.evaluate((count) => new Promise<void>((resolve) => {
    let left = count;
    const step = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), frames);

  /** The grids a session's PTY was resized to, in order. */
  const resizesOf = (page: Page, sessionId: string) => page.evaluate((id) => {
    const calls = (window as unknown as {
      electronAPI: { sessions: { __resizeCalls: Array<{ sessionId: string; cols: number; rows: number }> } };
    }).electronAPI.sessions.__resizeCalls;
    return calls.filter((call) => call.sessionId === id).map((call) => ({ cols: call.cols, rows: call.rows }));
  }, sessionId);

  // ---------------------------------------------------------------------------
  // Expand - a terminal's Expand fills the panel with it; the others keep
  // running behind it at the same size, hidden, and list in the rail's Running
  // section, each with its own Stop. Restore brings the grid back.
  // ---------------------------------------------------------------------------
  test.describe('Expand', () => {
    async function openTerminals(page: Page, count: number): Promise<void> {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      for (let opened = 2; opened <= count; opened += 1) {
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(opened, { timeout: 5000 });
      }
    }

    const frameOf = (page: Page, slot: string) =>
      page.locator('[data-testid^="window-frame-"]', { has: page.locator(`[data-command-slot="${slot}"]`) });
    const runningSlots = (page: Page) => page.getByTestId('command-terminal-running-row').evaluateAll(
      (rows) => rows.map((row) => row.getAttribute('data-command-slot')),
    );
    /** The Running row marked as the terminal in front: the expanded one, else the focused tile. */
    const frontSlot = (page: Page) => page.locator('[data-testid="command-terminal-running-row"][data-front="true"]').getAttribute('data-command-slot');

    test('Expand shows only beside another terminal, fills the panel, and Restore brings the grid back', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTerminals(page, 1);
        await expect(page.getByTestId('command-bar-expand')).toHaveCount(0);

        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect(page.getByTestId('command-bar-expand')).toHaveCount(2);

        const firstExpand = page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand');
        await firstExpand.click();
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        await expect(firstExpand).toHaveAccessibleName('Restore the grid');
        const areaBox = await page.getByTestId('command-terminal-area').boundingBox();
        const expandedBox = await frameOf(page, 'slot-1').boundingBox();
        expect(Math.abs((expandedBox?.width ?? 0) - (areaBox?.width ?? 0))).toBeLessThanOrEqual(3);
        // The other keeps running behind it, hidden from the pointer and the keyboard.
        await expect(frameOf(page, 'slot-2')).toHaveAttribute('aria-hidden', 'true');
        await expect(frameOf(page, 'slot-2')).toHaveAttribute('inert', '');
        await expect(page.locator('[data-testid^="tile-splitter-"]')).toHaveCount(0);
        // Running lists both in the order they tile, the expanded one marked in front.
        expect(await runningSlots(page)).toEqual(['slot-1', 'slot-2']);
        expect(await frontSlot(page)).toBe('slot-1');

        await firstExpand.click();
        await expect(page.locator('[data-testid^="window-frame-"][aria-hidden="true"]')).toHaveCount(0);
        // Tiled again, Running still lists both.
        expect(await runningSlots(page)).toEqual(['slot-1', 'slot-2']);
        await expect(page.locator('[data-testid^="tile-splitter-"]')).toHaveCount(1);
      } finally {
        await browser.close();
      }
    });

    /** A terminal's floor is 630px wide; tiles sit flush, so the grid's minimum is whole floors. */
    const TERMINAL_FLOOR_WIDTH = 630;
    /** The panel's minimum with two side by side: the rail at its 200px drag minimum, two floors, the 1px border each side. */
    const TWO_TERMINAL_PANEL_MIN_WIDTH = 200 + 2 * TERMINAL_FLOOR_WIDTH + 2;
    /** With one terminal, or one expanded. */
    const ONE_TERMINAL_PANEL_MIN_WIDTH = 200 + TERMINAL_FLOOR_WIDTH + 2;
    /** The header (40) over the floor's 200px height, and the border. */
    const ONE_ROW_PANEL_MIN_HEIGHT = 40 + 200 + 2;
    const TWO_ROW_PANEL_MIN_HEIGHT = 40 + 2 * 200 + 2;
    const EDGE_TOLERANCE = 3;

    const panelBox = async (page: Page) => {
      const box = await page.getByTestId('command-terminal-panel').boundingBox();
      if (!box) throw new Error('no panel');
      return box;
    };

    /** Drag one of the panel's resize edges to a point, far past wherever it stops. */
    async function dragPanelEdgeTo(page: Page, edge: 'e' | 's', target: { x?: number; y?: number }): Promise<void> {
      const box = await page.getByTestId(`command-terminal-panel-resize-${edge}`).boundingBox();
      if (!box) throw new Error(`no ${edge} edge`);
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(target.x ?? startX, target.y ?? startY, { steps: 8 });
      await page.mouse.up();
    }

    /**
     * Every slot tiled at the floor or wider. Polled: the tiles follow the panel once the
     * engine's ResizeObserver sees the new area, which is before paint but after the commit
     * that grew the panel (sampled: one frame of 270 + 270 in a panel already 1282 wide).
     */
    async function expectTiledAtFloor(page: Page, slots: string[], minHeight = 200): Promise<void> {
      await expect(page.locator('[data-testid^="window-frame-"][data-expanded]')).toHaveCount(0);
      for (const slot of slots) {
        await expect.poll(async () => (await frameOf(page, slot).boundingBox())?.width ?? 0, { message: `${slot} width`, timeout: 3000 })
          .toBeGreaterThanOrEqual(TERMINAL_FLOOR_WIDTH - EDGE_TOLERANCE);
        await expect.poll(async () => (await frameOf(page, slot).boundingBox())?.height ?? 0, { message: `${slot} height`, timeout: 3000 })
          .toBeGreaterThanOrEqual(minHeight - EDGE_TOLERANCE);
      }
    }

    test('two terminals tile at 1920, and the panel edge stops where they still fit side by side', async () => {
      // The panel's default place at 1920 leaves about 1113px for terminals, just short of two at the
      // 630px floor, so the second grows the panel to fit.
      const { browser, page } = await launchWithState(multiTerminalPreConfig(), { width: 1920, height: 1080 });
      try {
        await openTerminals(page, 2);
        await expect(page.locator('[data-testid^="tile-splitter-"]')).toHaveCount(1);
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);

        // A seam dragged to one side first: the panel at its minimum still holds both at the floor,
        // where the seam's own ratio would leave one terminal under it (found driving a live preview).
        const seam = await page.locator('[data-testid^="tile-splitter-"]').boundingBox();
        if (!seam) throw new Error('no seam');
        await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
        await page.mouse.down();
        await page.mouse.move(seam.x + seam.width / 2 + 600, seam.y + seam.height / 2, { steps: 8 });
        await page.mouse.up();

        // Dragged far past it, the edge stops at the grid beside the narrowest rail, and nothing expands.
        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 })
          .toBeLessThanOrEqual(TWO_TERMINAL_PANEL_MIN_WIDTH + EDGE_TOLERANCE);
        expect((await panelBox(page)).width).toBeGreaterThanOrEqual(TWO_TERMINAL_PANEL_MIN_WIDTH - EDGE_TOLERANCE);
        await expect(page.getByTestId('command-terminal-rail')).toHaveJSProperty('offsetWidth', 200);
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);
        expect(await runningSlots(page)).toEqual(['slot-1', 'slot-2']);
      } finally {
        await browser.close();
      }
    });

    test('expanded, the panel may shrink to one terminal; Restore grows it back to fit the grid and keeps that size', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig(), { width: 1920, height: 1080 });
      try {
        await openTerminals(page, 2);
        const toggle = page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand');
        await toggle.click();
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        const left = (await panelBox(page)).x;

        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 })
          .toBeLessThanOrEqual(ONE_TERMINAL_PANEL_MIN_WIDTH + EDGE_TOLERANCE);

        // Restore is never off: the panel grows back to fit two side by side, its left edge kept.
        await expect(toggle).toBeEnabled();
        await toggle.click();
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 })
          .toBeGreaterThanOrEqual(TWO_TERMINAL_PANEL_MIN_WIDTH - EDGE_TOLERANCE);
        expect(Math.abs((await panelBox(page)).x - left)).toBeLessThanOrEqual(EDGE_TOLERANCE);
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);

        // The grown size is saved, so expanding again leaves the panel as it is.
        const grownWidth = (await panelBox(page)).width;
        await toggle.click();
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        expect(Math.abs((await panelBox(page)).width - grownWidth)).toBeLessThanOrEqual(EDGE_TOLERANCE);
      } finally {
        await browser.close();
      }
    });

    test('Add terminal grows a panel too small for the next grid: wider for two, taller for three', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig(), { width: 1920, height: 1080 });
      try {
        await openTerminals(page, 1);
        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await dragPanelEdgeTo(page, 's', { y: 10 });
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 })
          .toBeLessThanOrEqual(ONE_TERMINAL_PANEL_MIN_WIDTH + EDGE_TOLERANCE);
        await expect.poll(async () => (await panelBox(page)).height, { timeout: 3000 })
          .toBeLessThanOrEqual(ONE_ROW_PANEL_MIN_HEIGHT + EDGE_TOLERANCE);

        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 })
          .toBeGreaterThanOrEqual(TWO_TERMINAL_PANEL_MIN_WIDTH - EDGE_TOLERANCE);
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);

        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(3, { timeout: 5000 });
        await expect.poll(async () => (await panelBox(page)).height, { timeout: 3000 })
          .toBeGreaterThanOrEqual(TWO_ROW_PANEL_MIN_HEIGHT - EDGE_TOLERANCE);
        await expectTiledAtFloor(page, ['slot-1', 'slot-2', 'slot-3']);
      } finally {
        await browser.close();
      }
    });

    test('a window too small for the grid keeps every terminal tiled, under the floor', async () => {
      // A 1000px window cannot hold two at the floor beside the rail (1462px), whatever the panel does.
      const { browser, page } = await launchWithState(multiTerminalPreConfig(), { width: 1000, height: 700 });
      try {
        await openTerminals(page, 2);
        await expect(page.locator('[data-testid^="window-frame-"][data-expanded]')).toHaveCount(0);
        await expect(page.locator('[data-testid^="window-frame-"][aria-hidden="true"]')).toHaveCount(0);
        await expect(page.locator('[data-testid^="tile-splitter-"]')).toHaveCount(1);
        const area = await page.getByTestId('command-terminal-panel-area').boundingBox();
        expect(Math.abs((await panelBox(page)).width - (area?.width ?? 0))).toBeLessThanOrEqual(EDGE_TOLERANCE);
        for (const slot of ['slot-1', 'slot-2']) {
          const tile = await frameOf(page, slot).boundingBox();
          expect(tile?.width ?? 0, `${slot} width`).toBeGreaterThan(300);
          expect(tile?.width ?? 0, `${slot} width`).toBeLessThan(TERMINAL_FLOOR_WIDTH);
        }
      } finally {
        await browser.close();
      }
    });

    test('a terminal the user expanded stays expanded when the panel grows', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTerminals(page, 2);
        await page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click();
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        await page.getByTestId('command-terminal-panel-maximize').click();
        await expect(page.getByTestId('command-terminal-panel')).toHaveAttribute('data-maximized', 'true');
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        await expect(page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand')).toBeEnabled();
      } finally {
        await browser.close();
      }
    });

    test('a Running row expands its terminal, and its Stop ends it while the expanded one stays', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTerminals(page, 3);
        await page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click();
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        expect(await runningSlots(page)).toEqual(['slot-1', 'slot-2', 'slot-3']);
        expect(await frontSlot(page)).toBe('slot-1');

        // A row's title expands that terminal in its place.
        await page.locator('[data-testid="command-terminal-running-row"][data-command-slot="slot-3"]')
          .getByTestId('command-terminal-running-expand').click();
        await expect(frameOf(page, 'slot-3')).toHaveAttribute('data-expanded', 'true');
        expect(await frontSlot(page)).toBe('slot-3');

        // A row's mark is that terminal's own Stop: it ends without being brought back.
        const stopButton = page.locator('[data-testid="command-terminal-running-row"][data-command-slot="slot-2"]')
          .getByTestId('command-terminal-running-stop');
        await expect(stopButton).toHaveAccessibleDescription('Ends the terminal, and Earlier keeps its conversation if it was used');
        await stopButton.click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        await expect(frameOf(page, 'slot-3')).toHaveAttribute('data-expanded', 'true');
        await expect.poll(() => runningSlots(page), { timeout: 3000 }).toEqual(['slot-1', 'slot-3']);

        // With one left beside it, stopping that one leaves nothing to expand over.
        await page.locator('[data-testid="command-terminal-running-row"][data-command-slot="slot-1"]')
          .getByTestId('command-terminal-running-stop').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect(page.locator('[data-testid^="window-frame-"][data-expanded]')).toHaveCount(0);
        await expect.poll(() => runningSlots(page), { timeout: 3000 }).toEqual(['slot-3']);
        await expect(page.getByTestId('command-bar-expand')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    /** Two terminals, both agents on screen and initialized, and each one's session id. */
    async function openTwoReady(page: Page): Promise<{ first: string; second: string }> {
      await openTerminals(page, 2);
      const sessions = await markTerminalsReady(page, ['slot-1', 'slot-2']);
      // Adding the second terminal re-tiled the first, which held its frame: let it draw first.
      await expectNoFrameHold(page);
      return { first: sessions['slot-1'], second: sessions['slot-2'] };
    }

    const tileWidth = async (page: Page, slot: string): Promise<number> => (await frameOf(page, slot).boundingBox())?.width ?? 0;

    test('a press on the seam that never moves leaves both terminals where they were', async () => {
      // The seam committed its drag ratio on release whether or not it had
      // moved, and an unmoved ratio was 0, which clamps to the narrowest tile.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        const before = await tileWidth(page, 'slot-1');
        const sizesBefore = (await commandTileLayout(page))?.sizes ?? [];
        expect(sizesBefore).toHaveLength(2);
        const seam = await page.locator('[data-testid^="tile-splitter-"]').boundingBox();
        if (!seam) throw new Error('no seam');
        await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
        await page.mouse.down();
        // The press holds the resize gate, which is how a test sees it landed on the seam.
        await expect.poll(() => isManagerResizeGateOpen(page)).toBe(true);
        await page.mouse.up();
        // The release closes it, and a commit would run in that same handler. Frames, not a
        // timer, give any commit's re-render time to show before the ratio is read.
        await expect.poll(() => isManagerResizeGateOpen(page)).toBe(false);
        await settleFrames(page, 10);
        const sizesAfter = (await commandTileLayout(page))?.sizes ?? [];
        expect(sizesAfter).toHaveLength(2);
        sizesAfter.forEach((size, index) => expect(Math.abs(size - sizesBefore[index])).toBeLessThanOrEqual(GEOMETRY_TOLERANCE));
        expect(Math.abs((await tileWidth(page, 'slot-1')) - before)).toBeLessThanOrEqual(2);
      } finally {
        await browser.close();
      }
    });

    test('a double-click on a dragged seam evens the two terminals, 50/50', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        const seamLocator = page.locator('[data-testid^="tile-splitter-"]');
        const seam = await seamLocator.boundingBox();
        if (!seam) throw new Error('no seam');
        await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
        await page.mouse.down();
        await page.mouse.move(seam.x + seam.width / 2 + 160, seam.y + seam.height / 2, { steps: 6 });
        await page.mouse.up();
        // The drag took: the first terminal holds more than half of the pair.
        await expect.poll(async () => (await commandTileLayout(page))?.sizes[0] ?? 0, { timeout: 3000 })
          .toBeGreaterThan(0.5 + GEOMETRY_TOLERANCE);

        const moved = await seamLocator.boundingBox();
        if (!moved) throw new Error('no seam after the drag');
        await page.mouse.dblclick(moved.x + moved.width / 2, moved.y + moved.height / 2);
        await expect.poll(async () => (await commandTileLayout(page))?.sizes[0] ?? 0, { timeout: 3000 })
          .toBeCloseTo(0.5, 3);
        await expect.poll(async () => Math.abs((await tileWidth(page, 'slot-1')) - (await tileWidth(page, 'slot-2'))), { timeout: 3000 })
          .toBeLessThanOrEqual(2);
      } finally {
        await browser.close();
      }
    });

    /** Drag the tile seam by `deltaX`, from its live center. */
    async function dragSeamBy(page: Page, deltaX: number): Promise<void> {
      const seam = await page.locator('[data-testid^="tile-splitter-"]').boundingBox();
      if (!seam) throw new Error('no seam');
      await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
      await page.mouse.down();
      await page.mouse.move(seam.x + seam.width / 2 + deltaX, seam.y + seam.height / 2, { steps: 8 });
      await page.mouse.up();
    }

    /** The gap between the terminals and the terminal area's edges, and the overlap or gap between neighbors. */
    const tileFit = (page: Page) => page.evaluate(() => {
      const area = document.querySelector('[data-testid="command-terminal-area"]')?.getBoundingClientRect();
      const frames = Array.from(document.querySelectorAll('[data-testid="command-terminal-panel"] [data-testid^="window-frame-"]'))
        .map((frame) => frame.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .sort((first, second) => first.left - second.left);
      if (!area || frames.length === 0) return null;
      return {
        leftGap: Math.round(frames[0].left - area.left),
        rightGap: Math.round(area.right - frames[frames.length - 1].right),
        widths: frames.map((box) => Math.round(box.width)),
      };
    });

    async function expectTilesFillArea(page: Page): Promise<void> {
      await expect.poll(async () => {
        const fit = await tileFit(page);
        return fit !== null && Math.abs(fit.leftGap) <= EDGE_TOLERANCE && Math.abs(fit.rightGap) <= EDGE_TOLERANCE;
      }, { timeout: 3000, message: 'the terminals fill the area' }).toBe(true);
    }

    test('after a double-click evens the seam, a panel grown from its west edge fills with the terminals and the seam still drags its full range', async () => {
      // Two terminals, a panel edge drag and a seam drag the full range, each recorded
      // frame by frame: 7 s locally, so the 15 s default has no room on a CI runner.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        await dragSeamBy(page, 160);
        const seamLocator = page.locator('[data-testid^="tile-splitter-"]');
        const moved = await seamLocator.boundingBox();
        if (!moved) throw new Error('no seam');
        await page.mouse.dblclick(moved.x + moved.width / 2, moved.y + moved.height / 2);
        await expect.poll(async () => (await commandTileLayout(page))?.sizes[0] ?? 0, { timeout: 3000 }).toBeCloseTo(0.5, 3);

        // Grow the panel from its west edge, as far as the window lets it.
        const before = await panelBox(page);
        const west = await page.getByTestId('command-terminal-panel-resize-w').boundingBox();
        if (!west) throw new Error('no west edge');
        await page.mouse.move(west.x + west.width / 2, west.y + west.height / 2);
        await page.mouse.down();
        await page.mouse.move(5, west.y + west.height / 2, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 }).toBeGreaterThan(before.width + 100);
        await expectTilesFillArea(page);

        // The seam takes a long drag in the grown panel, not a few pixels.
        const seamBefore = await seamLocator.boundingBox();
        if (!seamBefore) throw new Error('no seam');
        await dragSeamBy(page, 250);
        await expect.poll(async () => ((await seamLocator.boundingBox())?.x ?? 0) - seamBefore.x, { timeout: 3000 })
          .toBeGreaterThanOrEqual(240);
        await expectTilesFillArea(page);
      } finally {
        await browser.close();
      }
    });

    test('a panel grown from the minimum, where the floor evened the terminals, grows them evenly whatever the seam held before', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        // The seam dragged as far left as it goes in the wide panel: the first terminal at its floor.
        await dragSeamBy(page, -900);
        await expect.poll(async () => (await commandTileLayout(page))?.sizes[0] ?? 1, { timeout: 3000 }).toBeLessThan(0.45);
        await expect.poll(async () => tileWidth(page, 'slot-1'), { timeout: 3000 }).toBeLessThanOrEqual(TERMINAL_FLOOR_WIDTH + EDGE_TOLERANCE);

        // Shrunk to the minimum, the floor shows them even.
        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);
        await expect.poll(async () => Math.abs((await tileWidth(page, 'slot-1')) - (await tileWidth(page, 'slot-2'))), { timeout: 3000 })
          .toBeLessThanOrEqual(2);

        // Grown back from that edge, both grow by the same amount, as they looked.
        await dragPanelEdgeTo(page, 'e', { x: 2500 });
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 }).toBeGreaterThan(2000);
        await expect.poll(async () => Math.abs((await tileWidth(page, 'slot-1')) - (await tileWidth(page, 'slot-2'))), { timeout: 3000 })
          .toBeLessThanOrEqual(2);
        await expectTilesFillArea(page);
      } finally {
        await browser.close();
      }
    });

    test('at the panel minimum the seam has no room, so it shows no resize cursor or line and takes no drag; with room it does again', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        const seamLocator = page.locator('[data-testid^="tile-splitter-"]');
        const seamLook = () => seamLocator.evaluate((element) => ({
          cursor: getComputedStyle(element).cursor,
          line: getComputedStyle(element.firstElementChild as Element).backgroundColor,
        }));
        await expect(seamLocator).toHaveAttribute('data-movable', 'true');
        expect((await seamLook()).cursor).toBe('col-resize');

        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);
        await expect(seamLocator).toHaveAttribute('data-movable', 'false');
        const seam = await seamLocator.boundingBox();
        if (!seam) throw new Error('no seam');
        // Hovered: neither the resize cursor nor the accent line.
        await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
        const atMinimum = await seamLook();
        expect(atMinimum.cursor).not.toBe('col-resize');
        expect(atMinimum.line).toBe('rgba(0, 0, 0, 0)');
        // A press opens no drag.
        await page.mouse.down();
        expect(await isManagerResizeGateOpen(page)).toBe(false);
        await page.mouse.up();

        await dragPanelEdgeTo(page, 'e', { x: 2500 });
        await expect(seamLocator).toHaveAttribute('data-movable', 'true', { timeout: 3000 });
        expect((await seamLook()).cursor).toBe('col-resize');
      } finally {
        await browser.close();
      }
    });

    test('maximizing a panel the floor holds even grows its terminals evenly', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        await dragSeamBy(page, -900);
        await expect.poll(async () => tileWidth(page, 'slot-1'), { timeout: 3000 }).toBeLessThanOrEqual(TERMINAL_FLOOR_WIDTH + EDGE_TOLERANCE);
        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);

        await page.getByTestId('command-terminal-panel-maximize').click();
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 }).toBeGreaterThan(2000);
        await expect.poll(async () => Math.abs((await tileWidth(page, 'slot-1')) - (await tileWidth(page, 'slot-2'))), { timeout: 3000 })
          .toBeLessThanOrEqual(2);
      } finally {
        await browser.close();
      }
    });

    test('a panel grown back from its minimum gives the seam its full range again, both ways', async () => {
      // Grows the panel from its minimum, then drags the seam both ways: 8 s locally,
      // so the 15 s default has no room on a CI runner.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);
        // At the minimum the seam has no room either way, and a double-click there changes nothing.
        const seamLocator = page.locator('[data-testid^="tile-splitter-"]');
        const atMinimum = await seamLocator.boundingBox();
        if (!atMinimum) throw new Error('no seam');
        await page.mouse.dblclick(atMinimum.x + atMinimum.width / 2, atMinimum.y + atMinimum.height / 2);

        await dragPanelEdgeTo(page, 'e', { x: 2500 });
        await expect.poll(async () => (await panelBox(page)).width, { timeout: 3000 }).toBeGreaterThan(2000);
        await expectTilesFillArea(page);

        const seamBefore = await seamLocator.boundingBox();
        if (!seamBefore) throw new Error('no seam');
        await dragSeamBy(page, 250);
        await expect.poll(async () => ((await seamLocator.boundingBox())?.x ?? 0) - seamBefore.x, { timeout: 3000 })
          .toBeGreaterThanOrEqual(240);
        await dragSeamBy(page, -500);
        await expect.poll(async () => seamBefore.x - ((await seamLocator.boundingBox())?.x ?? 0), { timeout: 3000 })
          .toBeGreaterThanOrEqual(240);
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);
        await expectTilesFillArea(page);
      } finally {
        await browser.close();
      }
    });

    test('shrinking a panel with an uneven seam refits each terminal once on release, holds no frame mid-drag, and keeps the terminals filling it', async () => {
      // Records every frame of a panel shrink: 10 s locally, so the 15 s default has
      // no room on a CI runner.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        const { first, second } = await openTwoReady(page);
        await dragSeamBy(page, -200);
        await stillTerminals(page, [first, second]);
        await settleResizes(page);
        await expectNoFrameHold(page);
        await watchFrameHolds(page);

        const widthsBefore = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="command-terminal-panel"] [data-testid^="window-frame-"]'))
          .map((frame) => Math.round(frame.getBoundingClientRect().width)));
        // Every frame of the drag, not only where the steps land: a terminal that shrinks and
        // grows back inside one step is the jitter a final read cannot see.
        await page.evaluate(() => {
          const holder = window as unknown as { __dragFrames: number[][]; __recording: boolean };
          holder.__dragFrames = [];
          holder.__recording = true;
          const record = () => {
            if (!holder.__recording) return;
            holder.__dragFrames.push(Array.from(document.querySelectorAll('[data-testid="command-terminal-panel"] [data-testid^="window-frame-"]'))
              .map((frame) => Math.round(frame.getBoundingClientRect().width)));
            requestAnimationFrame(record);
          };
          requestAnimationFrame(record);
        });

        const east = await page.getByTestId('command-terminal-panel-resize-e').boundingBox();
        if (!east) throw new Error('no east edge');
        const startX = east.x + east.width / 2;
        const y = east.y + east.height / 2;
        await page.mouse.move(startX, y);
        await page.mouse.down();
        const midDrag: Array<{ step: number; resizes: number; holds: number; gateOpen: boolean; fit: Awaited<ReturnType<typeof tileFit>> }> = [];
        for (let step = 1; step <= 14; step += 1) {
          await page.mouse.move(startX - step * 60, y, { steps: 4 });
          await settleFrames(page, 3);
          midDrag.push({
            step,
            resizes: await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length),
            holds: (await frameHolds(page)).length,
            gateOpen: await isManagerResizeGateOpen(page),
            fit: await tileFit(page),
          });
        }
        await page.mouse.up();
        const dragFrames = await page.evaluate(() => {
          const holder = window as unknown as { __dragFrames: number[][]; __recording: boolean };
          holder.__recording = false;
          return holder.__dragFrames;
        });
        // A shrinking panel never grows a terminal, frame to frame.
        for (let frameIndex = 1; frameIndex < dragFrames.length; frameIndex += 1) {
          dragFrames[frameIndex].forEach((width, tileIndex) => {
            expect(width, `frame ${frameIndex} tile ${tileIndex}: ${JSON.stringify(dragFrames.slice(Math.max(0, frameIndex - 2), frameIndex + 2))}`)
              .toBeLessThanOrEqual(dragFrames[frameIndex - 1][tileIndex] + 1);
          });
        }

        // Mid-drag: the gate held every refit, no terminal held a frame, and the tiles kept filling the panel.
        for (const sample of midDrag) {
          expect(sample, `step ${sample.step}`).toMatchObject({ resizes: 0, holds: 0, gateOpen: true });
          expect(Math.abs(sample.fit?.leftGap ?? 99), `step ${sample.step} left gap`).toBeLessThanOrEqual(EDGE_TOLERANCE);
          expect(Math.abs(sample.fit?.rightGap ?? 99), `step ${sample.step} right gap`).toBeLessThanOrEqual(EDGE_TOLERANCE);
        }
        // Released: one refit for each terminal the shrink resized, none for one it left alone, one layout change.
        await expectNoFrameHold(page);
        await settleFrames(page, 10);
        const widthsAfter = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="command-terminal-panel"] [data-testid^="window-frame-"]'))
          .map((frame) => Math.round(frame.getBoundingClientRect().width)));
        const sessionsInOrder = [first, second];
        for (const [index, sessionId] of sessionsInOrder.entries()) {
          const resized = Math.abs(widthsAfter[index] - widthsBefore[index]) > 8;
          expect((await resizesOf(page, sessionId)).length, `terminal ${index + 1}, ${widthsBefore[index]} to ${widthsAfter[index]}px`)
            .toBe(resized ? 1 : 0);
        }
        expect(widthsAfter.some((width, index) => width < widthsBefore[index] - 8)).toBe(true);
        expect((await frameHolds(page)).length).toBeLessThanOrEqual(1);
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);
        await expectTilesFillArea(page);
      } finally {
        await browser.close();
      }
    });

    test('growing a panel back keeps the terminals filling it and refits each once on release', async () => {
      // Records every frame of growing the panel back: 5 s locally, so the 15 s default
      // has no room on a CI runner.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        const { first, second } = await openTwoReady(page);
        await dragPanelEdgeTo(page, 'e', { x: 10 });
        await expectTiledAtFloor(page, ['slot-1', 'slot-2']);
        await stillTerminals(page, [first, second]);
        await settleResizes(page);
        await expectNoFrameHold(page);

        const east = await page.getByTestId('command-terminal-panel-resize-e').boundingBox();
        if (!east) throw new Error('no east edge');
        const startX = east.x + east.width / 2;
        const y = east.y + east.height / 2;
        await page.mouse.move(startX, y);
        await page.mouse.down();
        for (let step = 1; step <= 8; step += 1) {
          await page.mouse.move(startX + step * 60, y);
          await settleFrames(page, 3);
          const fit = await tileFit(page);
          expect(Math.abs(fit?.rightGap ?? 99), `step ${step} right gap`).toBeLessThanOrEqual(EDGE_TOLERANCE);
          expect(await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length), `step ${step} resizes`).toBe(0);
        }
        await page.mouse.up();
        await expect.poll(async () => (await resizesOf(page, first)).length, { timeout: 3000 }).toBe(1);
        await expect.poll(async () => (await resizesOf(page, second)).length, { timeout: 3000 }).toBe(1);
        await expectTilesFillArea(page);
      } finally {
        await browser.close();
      }
    });

    test('a seam drag whose release went unseen ends where it stood, and the seam takes the next drag', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        const before = await tileWidth(page, 'slot-1');
        // Press the seam and drag it 80px left, then lose its capture: the
        // release never reaches the seam.
        await page.evaluate(() => {
          const seam = document.querySelector<HTMLElement>('[data-testid^="tile-splitter-"]');
          if (!seam) throw new Error('no seam');
          const box = seam.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const init = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
          seam.dispatchEvent(new PointerEvent('pointerdown', { ...init, button: 0, buttons: 1, clientX: x, clientY: y }));
          seam.dispatchEvent(new PointerEvent('pointermove', { ...init, button: -1, buttons: 1, clientX: x - 80, clientY: y }));
          if (seam.hasPointerCapture(1)) seam.releasePointerCapture(1);
        });
        // The pointer moves on with no button held: the seam stays where it was dragged.
        await page.mouse.move(20, 20);
        await expect.poll(() => tileWidth(page, 'slot-1')).toBeLessThan(before - 60);
        const dragged = await tileWidth(page, 'slot-1');

        // The seam is not left holding the lost drag: the next one moves it, once
        // the commit's terminals have drawn their new frames.
        await expectNoFrameHold(page);
        const seam = await page.locator('[data-testid^="tile-splitter-"]').boundingBox();
        if (!seam) throw new Error('no seam');
        const seamX = seam.x + seam.width / 2;
        const seamY = seam.y + seam.height / 2;
        await page.mouse.move(seamX, seamY);
        await page.mouse.down();
        await page.mouse.move(seamX + 120, seamY, { steps: 4 });
        await page.mouse.up();
        await expect.poll(() => tileWidth(page, 'slot-1')).toBeGreaterThan(dragged + 100);
      } finally {
        await browser.close();
      }
    });

    test('switching which terminal is expanded resizes nothing and holds no frame', async () => {
      // Its own browser and two terminals: about 3.8 s locally, 13.1 s on one CI run and a
      // timeout at 15 s on another. At an 8x CPU throttle it takes 14 to 16 s with every wait
      // met (the page load is most of it), so the 15 s default is the cause, not a hang.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        await page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click();
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        // The one behind is the panel's size too, so there is nothing left to change.
        const expandedBox = await frameOf(page, 'slot-1').boundingBox();
        const behindBox = await frameOf(page, 'slot-2').boundingBox();
        expect(Math.abs((behindBox?.width ?? 0) - (expandedBox?.width ?? 0))).toBeLessThanOrEqual(3);
        await expectNoFrameHold(page);
        await settleResizes(page);
        await watchFrameHolds(page);

        await page.locator('[data-testid="command-terminal-running-row"][data-command-slot="slot-2"]')
          .getByTestId('command-terminal-running-expand').click();
        await expect(frameOf(page, 'slot-2')).toHaveAttribute('data-expanded', 'true');
        await settleFrames(page, 20);
        expect(await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length)).toBe(0);
        expect(await frameHolds(page)).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test('Expand and Restore hold a terminal\'s output with its frame until it goes quiet, then draw it', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        const { first } = await openTwoReady(page);
        const since = Date.now();
        await watchFrameHolds(page);

        // Expand: the terminal holds its frame, its PTY is resized, and it holds
        // through the agent's output until a quiet beat after the last of it. The
        // output is timed from the hold, as an agent's repaint is
        // timed from the resize.
        await page.evaluate(({ sessionId, holdSelector }) => {
          const fire = (window as unknown as { __mockFireSessionData: (id: string, data: string) => void }).__mockFireSessionData;
          const observer = new MutationObserver(() => {
            if (!document.querySelector(holdSelector)) return;
            observer.disconnect();
            // Output every 10 ms from 100 to 400 ms: never quiet for the 40 ms beat until it stops.
            for (let at = 100; at <= 400; at += 10) setTimeout(() => fire(sessionId, at === 400 ? 'last held output\r\n' : 'x'), at);
          });
          observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-terminal-frame-hold'] });
        }, { sessionId: first, holdSelector: TERMINAL_FRAME_HOLD_SELECTOR });
        await page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click();
        // The change shows at once: the panel is expanded while the terminal still holds its frame.
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        await expect.poll(async () => (await frameHolds(page))[0]?.drawn ?? null, { timeout: 3000 }).not.toBeNull();
        const [expand] = await frameHolds(page);
        const held = (expand.drawn ?? 0) - expand.held;
        // Held well past the 190 ms floor while the output kept coming (with no
        // output it lets go near 200 ms), and ended by the cap. The exact rule is
        // the unit test's; this pins that the output reaches it.
        expect(held).toBeGreaterThanOrEqual(300);
        expect(held).toBeLessThanOrEqual(1500);
        // What was held is drawn when the hold ends.
        await expect.poll(async () => {
          const rows = await page.evaluate((sessionId) => (window as unknown as {
            __kangenticTerminalGridRows: (id: string) => Array<{ viewportRows: string[] }>;
          }).__kangenticTerminalGridRows(sessionId)[0], first);
          return rows?.viewportRows.some((row) => row.includes('last held output')) ?? false;
        }, { timeout: 3000 }).toBe(true);

        // Restore: every terminal goes back into its tile, holding its frame until it repaints.
        await page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click();
        await expect.poll(async () => (await frameHolds(page)).length, { timeout: 3000 }).toBe(2);
        await expect(page.locator('[data-testid^="window-frame-"][data-expanded]')).toHaveCount(0);
        await expectNoFrameHold(page);
        await expectNoFrameHoldRecovery(page, since);
      } finally {
        await browser.close();
      }
    });

    test('a click right after Expand reaches the layout on screen: nothing holds the pointer', async () => {
      // The freeze this replaced showed the old layout over a live new one, so it
      // took the pointer until its swap. A frame hold shows the new layout at once,
      // so a press on the Running row's Stop, there on the next frame, stops that
      // terminal while the expanded one still holds its frame.
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openTwoReady(page);
        await page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click();
        const stop = page.locator('[data-testid="command-terminal-running-row"][data-command-slot="slot-2"]')
          .getByTestId('command-terminal-running-stop');
        await expect(stop).toBeVisible();
        const stopBox = await stop.boundingBox();
        if (!stopBox) throw new Error('no Running Stop');
        // Pressed as soon as the row is laid out, with no wait for the terminal to
        // draw its new frame. The freeze held this press on its shield.
        await page.mouse.click(stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2);
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      } finally {
        await browser.close();
      }
    });

    test('Expand and Restore show at once, each terminal holding its frame, then the new one, with one PTY resize each', async () => {
      // Its own browser plus a screencast whose frames are decoded in the page:
      // measured at 9 to 14 s locally, too close to the 15 s default for CI.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        const { first, second } = await openTwoReady(page);
        await stillTerminals(page, [first, second]);
        await settleFrames(page, 10);
        await settleResizes(page);
        const since = Date.now();

        const expand = await recordLayoutChange(page, PANEL_SCOPE, () =>
          page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click());
        expectHoldThenDraw(expand, 2);
        await expect(frameOf(page, 'slot-1')).toHaveAttribute('data-expanded', 'true');
        expect(await resizesOf(page, first)).toHaveLength(1);

        await settleResizes(page);
        const restore = await recordLayoutChange(page, PANEL_SCOPE, () =>
          page.locator('[data-command-slot="slot-1"]').getByTestId('command-bar-expand').click());
        expectHoldThenDraw(restore, 2);
        await expect(page.locator('[data-testid^="window-frame-"][data-expanded]')).toHaveCount(0);
        expect(await resizesOf(page, first)).toHaveLength(1);
        await expectNoFrameHoldRecovery(page, since);
      } finally {
        await browser.close();
      }
    });

    test('maximizing the panel shows at once, its terminals holding their frames, then the new ones, with one PTY resize each', async () => {
      // Its own browser plus a screencast whose frames are decoded in the page:
      // measured at 9 to 14 s locally, too close to the 15 s default for CI.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        const { first, second } = await openTwoReady(page);
        await stillTerminals(page, [first, second]);
        await settleFrames(page, 10);
        await settleResizes(page);
        const since = Date.now();
        const recording = await recordLayoutChange(page, PANEL_SCOPE, () =>
          page.getByTestId('command-terminal-panel-maximize').click());
        expectHoldThenDraw(recording, 2);
        // The change reaches the terminals in hops a frame apart, and each sends
        // the grid it lands on once.
        expect(await resizesOf(page, first)).toHaveLength(1);
        expect(await resizesOf(page, second)).toHaveLength(1);
        await expectNoFrameHoldRecovery(page, since);
        await expect(page.getByTestId('command-terminal-panel')).toHaveAttribute('data-maximized', 'true');
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Swap - drag a terminal by its header onto another's tile: a picture of it
  // follows the pointer, and the real terminals preview the swap, each in the
  // other's tile, until the release makes it.
  // ---------------------------------------------------------------------------
  test.describe('Swap', () => {
    async function openThree(page: Page): Promise<void> {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      for (let opened = 2; opened <= 3; opened += 1) {
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(opened, { timeout: 5000 });
      }
      await expect.poll(async () => (await commandTileLayout(page))?.slots.length ?? 0, { timeout: 3000 }).toBe(2);
      // Each Add re-tiled the others, which held their frames: let the last of
      // them draw before a drag starts.
      await expectNoFrameHold(page);
    }

    /** The slots in reading order, from the store's tile tree. */
    const readingOrder = (page: Page) => page.evaluate(() => {
      interface StoreTile { kind: 'leaf' | 'split'; windowId?: string; children?: StoreTile[] }
      const state = (window as unknown as {
        __zustandStores?: { commandWindow?: { getState: () => { windows: Record<string, { anchor: string }>; tileTree: StoreTile | null } } };
      }).__zustandStores?.commandWindow?.getState();
      const slots: string[] = [];
      const walk = (node: StoreTile | null | undefined): void => {
        if (!node) return;
        if (node.kind === 'leaf' && node.windowId) slots.push(state?.windows[node.windowId]?.anchor ?? '?');
        else node.children?.forEach(walk);
      };
      walk(state?.tileTree);
      return slots;
    });

    const frameOf = (page: Page, slot: string) =>
      page.locator('[data-testid^="window-frame-"]', { has: page.locator(`[data-command-slot="${slot}"]`) });

    async function pressOnHeader(page: Page, slot: string): Promise<{ x: number; y: number }> {
      const title = await page.locator(`[data-command-slot="${slot}"]`).getByTestId('command-bar-label').boundingBox();
      if (!title) throw new Error(`no title for ${slot}`);
      const start = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      return start;
    }

    test('dragging a header onto another tile previews the swap with the real terminals, and the release swaps them', async () => {
      // Its own browser, three terminals and a drag: about 4.5 s locally, mostly the page load
      // and the three spawns, which a slow runner stretches together. The 15 s default failed
      // it on CI, run and retry. At an 8x CPU throttle it takes 15 to 18 s with every wait met,
      // so the budget is the cause, not a hang.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openThree(page);
        const sessions = await markTerminalsReady(page, ['slot-1', 'slot-2', 'slot-3']);
        await settleResizes(page);
        // Three tile as 1 tall on the left, 2 above 3 on the right.
        expect(await readingOrder(page)).toEqual(['slot-1', 'slot-2', 'slot-3']);
        // What main's capture of the pressed terminal hands back: any picture will do.
        await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 4;
          canvas.height = 4;
          (window as unknown as { __mockCaptureRegion: string }).__mockCaptureRegion = canvas.toDataURL('image/jpeg');
        });
        await watchFrameHolds(page);

        // The tiles are read live, right before the press: the drag aims at where the tall
        // tile is now, not where it was before the setup above settled.
        const tallBox = await frameOf(page, 'slot-1').boundingBox();
        const sourceBox = await frameOf(page, 'slot-3').boundingBox();
        if (!tallBox || !sourceBox) throw new Error('no frames');
        await pressOnHeader(page, 'slot-3');
        await page.mouse.move(tallBox.x + tallBox.width / 2, tallBox.y + tallBox.height / 2, { steps: 8 });

        // Mid-drag: the picture of terminal 3 follows the pointer at the
        // smallest tile's size (its own), upright; terminal 3 itself sits live
        // in the tall tile and terminal 1 in terminal 3's old one.
        const float = page.getByTestId('command-terminal-swap-float');
        await expect(float.getByTestId('command-terminal-swap-picture')).toBeVisible();
        await expect(float).toHaveCSS('transform', /^matrix\(1, 0, 0, 1, /);
        const floatBox = await float.boundingBox();
        if (!floatBox) throw new Error('no float');
        expect(Math.abs(floatBox.width - sourceBox.width)).toBeLessThanOrEqual(3);
        expect(Math.abs(floatBox.height - sourceBox.height)).toBeLessThanOrEqual(3);
        // Nothing else swap-related is on screen: the picture, the float holding it and
        // the landing mark, with no second copy of the terminal beside them.
        await expect.poll(() => page.locator('[data-testid^="command-terminal-swap-"]').evaluateAll(
          (elements) => elements.map((element) => element.getAttribute('data-testid')).sort(),
        ), { timeout: 3000 }).toEqual([
          'command-terminal-swap-float',
          'command-terminal-swap-landing',
          'command-terminal-swap-picture',
        ]);
        // The landing tile is marked: the accent ring, over the tall tile.
        const landing = page.getByTestId('command-terminal-swap-landing');
        await expect(landing).toBeVisible();
        const landingBox = await landing.boundingBox();
        expect(Math.abs((landingBox?.y ?? 0) - tallBox.y)).toBeLessThanOrEqual(3);
        expect(Math.abs((landingBox?.height ?? 0) - tallBox.height)).toBeLessThanOrEqual(3);
        await expect(landing).toHaveCSS('pointer-events', 'none');
        // An empty terminal: the terminals' own background, opaque, so the live
        // terminal refitting under it does not show twice beside the picture.
        const backgrounds = await page.evaluate(() => {
          const mark = document.querySelector('[data-testid="command-terminal-swap-landing"]');
          const pane = document.querySelector('[data-command-slot="slot-2"] [data-testid="command-bar-terminal-pane"]');
          return {
            mark: mark ? getComputedStyle(mark).backgroundColor : '',
            terminal: pane?.parentElement ? getComputedStyle(pane.parentElement).backgroundColor : '',
          };
        });
        expect(backgrounds.mark).toBe(backgrounds.terminal);
        expect(backgrounds.mark).toMatch(/^rgb\(/);
        const draggedBox = await frameOf(page, 'slot-3').boundingBox();
        expect(Math.abs((draggedBox?.y ?? 0) - tallBox.y)).toBeLessThanOrEqual(3);
        expect(Math.abs((draggedBox?.height ?? 0) - tallBox.height)).toBeLessThanOrEqual(3);
        await expect(frameOf(page, 'slot-3')).toHaveCSS('opacity', '1');
        const previewBox = await frameOf(page, 'slot-1').boundingBox();
        expect(Math.abs((previewBox?.y ?? 0) - sourceBox.y)).toBeLessThanOrEqual(3);
        expect(Math.abs((previewBox?.height ?? 0) - sourceBox.height)).toBeLessThanOrEqual(3);
        // Both previewing terminals are refit to the tiles they now show in, so
        // the preview is the result (terminal 3 taller than terminal 1 now). The
        // preview is a layout change of its own, so each terminal it resizes keeps
        // its frame until its agent has repainted, then draws the new one.
        await expect.poll(async () => {
          const dragged = (await resizesOf(page, sessions['slot-3'])).at(-1);
          const displaced = (await resizesOf(page, sessions['slot-1'])).at(-1);
          return dragged && displaced ? dragged.rows > displaced.rows : false;
        }, { timeout: 3000 }).toBe(true);
        await expectNoFrameHold(page);
        // The preview held them: a refit that reflowed instead would never mark one.
        expect((await frameHolds(page)).length).toBeGreaterThan(0);
        // One resize each for the step: the preview sends no grid twice.
        expect(await resizesOf(page, sessions['slot-3'])).toHaveLength(1);
        expect(await resizesOf(page, sessions['slot-1'])).toHaveLength(1);
        // Nothing is committed until the release.
        expect(await readingOrder(page)).toEqual(['slot-1', 'slot-2', 'slot-3']);

        await settleResizes(page);
        await page.mouse.up();
        // The picture goes at the release, with no settle: the live terminals
        // are already where the preview put them.
        expect(await page.evaluate(() => document.querySelectorAll('[data-testid="command-terminal-swap-float"]').length)).toBe(0);
        await expect.poll(() => readingOrder(page), { timeout: 3000 }).toEqual(['slot-3', 'slot-2', 'slot-1']);
        await expect(landing).toHaveCount(0);
        // Each terminal took the other's size, and the drag left no style behind.
        const landedBox = await frameOf(page, 'slot-3').boundingBox();
        expect(Math.abs((landedBox?.height ?? 0) - tallBox.height)).toBeLessThanOrEqual(3);
        await expect(frameOf(page, 'slot-3')).toHaveCSS('pointer-events', 'auto');
        // The preview had already sized them, so the drop resizes nothing.
        await settleFrames(page, 20);
        expect(await page.evaluate(() => window.electronAPI.sessions.__resizeCalls.length)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('a taller terminal floats at the smallest tile\'s size, cut from its top at its own scale', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openThree(page);
        const tallBox = await frameOf(page, 'slot-1').boundingBox();
        const smallBox = await frameOf(page, 'slot-3').boundingBox();
        if (!tallBox || !smallBox) throw new Error('no frames');
        await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 4;
          canvas.height = 4;
          (window as unknown as { __mockCaptureRegion: string }).__mockCaptureRegion = canvas.toDataURL('image/jpeg');
        });
        const target = { x: smallBox.x + smallBox.width / 2, y: smallBox.y + smallBox.height / 2 };
        await pressOnHeader(page, 'slot-1');
        await page.mouse.move(target.x, target.y, { steps: 8 });

        const float = page.getByTestId('command-terminal-swap-float');
        const picture = float.getByTestId('command-terminal-swap-picture');
        await expect(picture).toBeVisible();
        const floatBox = await float.boundingBox();
        const pictureBox = await picture.boundingBox();
        if (!floatBox || !pictureBox) throw new Error('no float');
        // The float is the small tile's size, not the tall terminal's.
        expect(Math.abs(floatBox.height - smallBox.height)).toBeLessThanOrEqual(3);
        expect(Math.abs(floatBox.width - smallBox.width)).toBeLessThanOrEqual(3);
        // The picture keeps the tall terminal's size, shown from its top.
        expect(Math.abs(pictureBox.height - tallBox.height)).toBeLessThanOrEqual(3);
        expect(Math.abs(pictureBox.y - floatBox.y)).toBeLessThanOrEqual(3);
        // The grab point stays on the float.
        expect(target.x).toBeGreaterThan(floatBox.x);
        expect(target.x).toBeLessThan(floatBox.x + floatBox.width);
        expect(target.y).toBeGreaterThan(floatBox.y);
        expect(target.y).toBeLessThan(floatBox.y + floatBox.height);

        await page.mouse.up();
        await expect(float).toHaveCount(0);
        await expect.poll(() => readingOrder(page), { timeout: 3000 }).toEqual(['slot-3', 'slot-2', 'slot-1']);
      } finally {
        await browser.close();
      }
    });

    test('without a picture the float shows the terminal\'s title, never an empty box', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openThree(page);
        const tallBox = await frameOf(page, 'slot-1').boundingBox();
        if (!tallBox) throw new Error('no frame');
        await pressOnHeader(page, 'slot-3');
        await page.mouse.move(tallBox.x + tallBox.width / 2, tallBox.y + tallBox.height / 2, { steps: 8 });
        const float = page.getByTestId('command-terminal-swap-float');
        await expect(float).toContainText('Command Terminal 3');
        await expect(float.getByTestId('command-terminal-swap-picture')).toHaveCount(0);
        // The capture answered (with nothing), so the real terminals still preview.
        await expect.poll(async () => Math.abs(((await frameOf(page, 'slot-3').boundingBox())?.height ?? 0) - tallBox.height), { timeout: 3000 }).toBeLessThanOrEqual(3);
        await page.mouse.up();
        await expect.poll(() => readingOrder(page), { timeout: 3000 }).toEqual(['slot-3', 'slot-2', 'slot-1']);
      } finally {
        await browser.close();
      }
    });

    test('Escape mid-drag puts everything back, refit, and swaps nothing', async () => {
      // Opens three terminals and waits out two resize settles before it presses Escape. On
      // CI's loaded UI shard that setup alone ran 14.8 s and then 15.0 s on the retry, and the
      // 15 s default ended both mid-poll (the failure read as "expected < 53, received 53": the
      // refit had not landed yet). The Expand tests above take 45 s for the same reason.
      test.setTimeout(45000);
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openThree(page);
        const sessions = await markTerminalsReady(page, ['slot-1', 'slot-2', 'slot-3']);
        await settleResizes(page);
        const tallBox = await frameOf(page, 'slot-1').boundingBox();
        if (!tallBox) throw new Error('no frame');
        await pressOnHeader(page, 'slot-3');
        await page.mouse.move(tallBox.x + tallBox.width / 2, tallBox.y + tallBox.height / 2, { steps: 8 });
        await expect(page.getByTestId('command-terminal-swap-float')).toBeVisible();
        await expect.poll(async () => (await resizesOf(page, sessions['slot-3'])).length, { timeout: 3000 }).toBeGreaterThan(0);
        const previewedRows = (await resizesOf(page, sessions['slot-3'])).at(-1)?.rows ?? 0;
        await settleResizes(page);

        await expect(page.getByTestId('command-terminal-swap-landing')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('command-terminal-swap-landing')).toHaveCount(0);
        // Put back, the dragged terminal refits to its own, shorter tile.
        await expect.poll(async () => (await resizesOf(page, sessions['slot-3'])).at(-1)?.rows ?? previewedRows, { timeout: 3000 })
          .toBeLessThan(previewedRows);
        await expect(page.getByTestId('command-terminal-swap-float')).toHaveCount(0);
        await page.mouse.up();
        expect(await readingOrder(page)).toEqual(['slot-1', 'slot-2', 'slot-3']);
        const restoredBox = await frameOf(page, 'slot-1').boundingBox();
        expect(Math.abs((restoredBox?.height ?? 0) - tallBox.height)).toBeLessThanOrEqual(3);
        await expect(frameOf(page, 'slot-3')).toHaveCSS('pointer-events', 'auto');
        // The panel is still open: the Escape cancelled the drag, not the layer.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(3);
      } finally {
        await browser.close();
      }
    });

    test('a terminal\'s menu offers no swap: the header drag is the one way', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await openThree(page);
        await page.locator('[data-command-slot="slot-3"]').locator('[aria-label="Actions"]').click();
        await expect(page.getByTestId('command-bar-kebab-stop')).toBeVisible();
        await expect(page.getByText(/^Swap with/)).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Earlier - the rail lists the project's ended conversations (main's
  // `commandTerminalHistory:list`, seeded here through
  // `window.__mockCommandTerminalHistory`) and resumes one: in place of a
  // terminal nothing has reached yet, beside one that has been used.
  // ---------------------------------------------------------------------------
  test.describe('Earlier conversations', () => {
    const EARLIER_PROJECT_ID = 'proj-earlier';

    interface SeededEntry { agentSessionId: string; label: string | null; firstPrompt: string | null; agentName: string; endedAt: string }

    /** Named rows, except the second (never named, nothing typed) and the third (never named, its first prompt kept). */
    function earlierEntries(count: number): SeededEntry[] {
      const now = Date.now();
      return Array.from({ length: count }, (_, index) => ({
        agentSessionId: `conversation-${index + 1}`,
        label: index === 1 || index === 2 ? null : `Conversation ${index + 1}`,
        firstPrompt: index === 2 ? 'why does the sidebar count lag?' : null,
        agentName: 'claude',
        endedAt: new Date(now - (index + 1) * 60 * 60 * 1000).toISOString(),
      }));
    }

    /** One project, the default mock spawn (which records each start), and the given history. */
    function earlierPreConfig(entries: SeededEntry[]): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${EARLIER_PROJECT_ID}',
            name: 'Earlier Project',
            path: '/mock/earlier',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, { id: 'lane-earlier-' + i, position: i, created_at: ts }));
          });
          return { currentProjectId: '${EARLIER_PROJECT_ID}' };
        });
        window.__mockCommandTerminalHistory = { '${EARLIER_PROJECT_ID}': ${JSON.stringify(entries)} };
      `;
    }

    async function spawnCalls(page: Page): Promise<Array<{ slot?: string; resumeAgentSessionId?: string }>> {
      return page.evaluate(() => (window as unknown as {
        __mockSpawnTransientCalls?: Array<{ slot?: string; resumeAgentSessionId?: string }>;
      }).__mockSpawnTransientCalls ?? []);
    }

    async function openWithOneTerminal(page: Page): Promise<string> {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      await expect.poll(async () => (await transientEntriesFor(page, EARLIER_PROJECT_ID)).length, { timeout: 5000 }).toBe(1);
      return (await transientEntriesFor(page, EARLIER_PROJECT_ID))[0].sessionId;
    }

    test('shows no heading and no hint while nothing has ended, and the first end brings the heading back', async () => {
      const { browser, page } = await launchWithState(earlierPreConfig([]));
      try {
        await openWithOneTerminal(page);
        const rail = page.getByTestId('command-terminal-rail');
        await expect(page.getByTestId('command-terminal-earlier-row')).toHaveCount(0);
        await expect(page.getByTestId('command-terminal-earlier-heading')).toHaveCount(0);
        await expect(rail).not.toContainText('Earlier');
        await expect(rail).not.toContainText('resume it from here');
        // The rail holds Add terminal, its one terminal under Running, and its fold row: nothing for Earlier.
        await expect(rail).toHaveText('Add terminalRunningCommand Terminal 1Hide');
        const railBox = await rail.boundingBox();
        if (!railBox) throw new Error('no rail');
        const terminalWidth = (await page.getByTestId('command-terminal-window').boundingBox())?.width ?? 0;

        // A conversation ends: main's push brings the heading back with its row.
        await page.evaluate((projectId) => {
          const host = window as unknown as {
            __mockCommandTerminalHistory: Record<string, unknown[]>;
            __mockFireCommandTerminalHistoryChanged: (id: string) => void;
          };
          host.__mockCommandTerminalHistory = {
            [projectId]: [{ agentSessionId: 'conversation-1', agentName: 'claude', label: 'Conversation 1', firstPrompt: null, endedAt: new Date().toISOString() }],
          };
          host.__mockFireCommandTerminalHistoryChanged(projectId);
        }, EARLIER_PROJECT_ID);
        await expect(page.getByTestId('command-terminal-earlier-heading')).toHaveText('Earlier');
        await expect(page.getByTestId('command-terminal-earlier-row')).toHaveCount(1);
        // The rail kept its width, so the terminal did not resize.
        expect(Math.abs(((await rail.boundingBox())?.width ?? 0) - railBox.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(((await page.getByTestId('command-terminal-window').boundingBox())?.width ?? 0) - terminalWidth)).toBeLessThanOrEqual(1);
      } finally {
        await browser.close();
      }
    });

    test('lists conversations newest first, as many as fit, and never scrolls', async () => {
      const { browser, page } = await launchWithState(earlierPreConfig(earlierEntries(40)));
      try {
        await openWithOneTerminal(page);
        const rows = page.getByTestId('command-terminal-earlier-row');
        await expect(rows.first()).toHaveAttribute('data-agent-session-id', 'conversation-1', { timeout: 5000 });
        await expect(rows.first()).toContainText('Conversation 1');
        // A conversation never named reads as its first prompt, and with no
        // prompt kept, a fallback rather than a blank row.
        await expect(rows.nth(1)).toContainText('Untitled conversation');
        await expect(rows.nth(2)).toContainText('why does the sidebar count lag?');

        const visibleRows = await rows.count();
        expect(visibleRows).toBeGreaterThan(2);
        expect(visibleRows).toBeLessThan(40);
        const fits = await page.getByTestId('command-terminal-earlier').evaluate((list) => {
          const listBox = list.getBoundingClientRect();
          const lastRow = list.lastElementChild?.getBoundingClientRect();
          return list.scrollHeight <= list.clientHeight + 1 && !!lastRow && lastRow.bottom <= listBox.bottom + 1;
        });
        expect(fits).toBe(true);
      } finally {
        await browser.close();
      }
    });

    /** Watch for the resume's start screen, which can lift before a later check would look. */
    async function watchForResumeLabel(page: Page): Promise<() => Promise<boolean>> {
      await page.evaluate(() => {
        const host = window as unknown as { __sawResumeLabel?: boolean };
        host.__sawResumeLabel = false;
        new MutationObserver(() => {
          if (document.body.textContent?.includes('Resuming conversation...')) host.__sawResumeLabel = true;
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      return () => page.evaluate(() => (window as unknown as { __sawResumeLabel?: boolean }).__sawResumeLabel === true);
    }

    test('a row resumes in place of the unused terminal', async () => {
      const { browser, page } = await launchWithState(earlierPreConfig(earlierEntries(3)));
      try {
        const freshSessionId = await openWithOneTerminal(page);
        const firstRow = page.getByTestId('command-terminal-earlier-row').first();
        // No tip while it can be clicked: the row reads as what it resumes.
        await firstRow.hover();
        await expect(firstRow).toHaveAccessibleDescription('');
        const sawResumeLabel = await watchForResumeLabel(page);

        await firstRow.click();
        // The respawn says it is resuming, not starting.
        await expect.poll(sawResumeLabel, { timeout: 5000 }).toBe(true);
        await expect.poll(async () => (await spawnCalls(page)).at(-1)?.resumeAgentSessionId, { timeout: 5000 }).toBe('conversation-1');
        expect((await spawnCalls(page)).at(-1)?.slot).toBe('slot-1');
        // The same window holds the resumed conversation; the fresh one is gone.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);
        await expect.poll(async () => (await transientEntriesFor(page, EARLIER_PROJECT_ID))[0]?.sessionId, { timeout: 5000 }).not.toBe(freshSessionId);
        // A live terminal holds it now, so it leaves Earlier.
        await expect(page.locator('[data-agent-session-id="conversation-1"]')).toHaveCount(0, { timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('a row opens beside a terminal someone has used, never over it', async () => {
      const { browser, page } = await launchWithState(earlierPreConfig(earlierEntries(3)));
      try {
        const usedSessionId = await openWithOneTerminal(page);
        // Main marks the terminal used and pushes it once, as it does on a keystroke.
        await page.evaluate((sessionId) => {
          const mockWindow = window as unknown as { __mockFireStatus: (id: string, session: Record<string, unknown>) => void };
          void window.electronAPI.sessions.list().then((sessions) => {
            const session = sessions.find((candidate) => candidate.id === sessionId);
            if (session) mockWindow.__mockFireStatus(sessionId, { ...session, hasUserInput: true });
          });
        }, usedSessionId);
        const firstRow = page.getByTestId('command-terminal-earlier-row').first();
        await firstRow.hover();
        await expect(firstRow).toHaveAccessibleDescription('');
        const sawResumeLabel = await watchForResumeLabel(page);

        await firstRow.click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
        // The new terminal says it is resuming, not starting.
        await expect.poll(sawResumeLabel, { timeout: 5000 }).toBe(true);
        const lastCall = (await spawnCalls(page)).at(-1);
        expect(lastCall).toMatchObject({ slot: 'slot-2', resumeAgentSessionId: 'conversation-1' });
        // The used terminal kept its session.
        expect(await transientPairingFor(page, EARLIER_PROJECT_ID)).toMatchObject({ 'slot-1': usedSessionId });
      } finally {
        await browser.close();
      }
    });

    const CONVERSATION_OPEN_SENTENCE = 'That conversation is already open in another terminal.';

    /** Every spawnTransient the page made, the refused ones too, in order. */
    async function spawnAttempts(page: Page): Promise<Array<{ slot: string | null; resumeAgentSessionId: string | null }>> {
      return page.evaluate(() => (window as unknown as {
        __spawnAttempts?: Array<{ slot: string | null; resumeAgentSessionId: string | null }>;
      }).__spawnAttempts ?? []);
    }

    /**
     * The default mock spawn, logged, with a start that names a conversation refused the way main
     * refuses one another terminal holds. `window.__refuseFreshStarts`, once set, refuses a start
     * that names none too, which is how a test makes the fresh start behind a refused resume fail.
     */
    function refuseResumeStarts(): string {
      return `
        (function () {
          var spawnBeforeRefusal = window.electronAPI.sessions.spawnTransient;
          window.__spawnAttempts = [];
          window.__refuseFreshStarts = false;
          window.electronAPI.sessions.spawnTransient = function (input) {
            window.__spawnAttempts.push({ slot: input.slot || null, resumeAgentSessionId: input.resumeAgentSessionId || null });
            if (input.resumeAgentSessionId) {
              return Promise.reject(new Error(${JSON.stringify(decoratedInvokeMessage('CommandTerminalStartError', CONVERSATION_OPEN_SENTENCE))}));
            }
            if (window.__refuseFreshStarts) {
              return Promise.reject(new Error(${JSON.stringify(decoratedInvokeMessage('CommandTerminalStartError', 'The terminal shell did not start.'))}));
            }
            return spawnBeforeRefusal(input);
          };
        })();
      `;
    }

    test('a resume main refuses starts a fresh terminal in the same slot and says why', async () => {
      // Main refuses a conversation another terminal holds only after the slot's unused terminal
      // has ended, so the window used to close with nothing in it. A fresh terminal takes its place.
      const { browser, page } = await launchWithState(earlierPreConfig(earlierEntries(3)) + refuseResumeStarts());
      try {
        const coldSessionId = await openWithOneTerminal(page);
        const coldStarts = (await spawnAttempts(page)).length;
        expect(coldStarts).toBe(1);

        await page.getByTestId('command-terminal-earlier-row').first().click();

        const refusalToast = page.getByTestId('toast').filter({ hasText: "Couldn't resume conversation" });
        await expect(refusalToast.getByTestId('toast-title')).toHaveText("Couldn't resume conversation");
        await expect(refusalToast.getByTestId('toast-body')).toHaveText(CONVERSATION_OPEN_SENTENCE);
        // The refused resume, then a fresh start in the same slot that names no conversation.
        await expect.poll(async () => (await spawnAttempts(page)).slice(coldStarts), { timeout: 5000 }).toEqual([
          { slot: 'slot-1', resumeAgentSessionId: 'conversation-1' },
          { slot: 'slot-1', resumeAgentSessionId: null },
        ]);
        // Frames, not a timer: long enough for a third start, were there one, to go out.
        await settleFrames(page, 20);
        expect((await spawnAttempts(page)).length).toBe(coldStarts + 2);

        // The window stayed, and a new terminal runs in its slot.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);
        await expect.poll(async () => {
          const pairedSessionId = (await transientPairingFor(page, EARLIER_PROJECT_ID))['slot-1'];
          return !!pairedSessionId && pairedSessionId !== coldSessionId && (await runningSessionIds(page, [pairedSessionId])).length === 1;
        }, { timeout: 5000 }).toBe(true);
      } finally {
        await browser.close();
      }
    });

    test('a refused resume whose fresh start fails too closes the window', async () => {
      const { browser, page } = await launchWithState(earlierPreConfig(earlierEntries(3)) + refuseResumeStarts());
      try {
        await openWithOneTerminal(page);
        const coldStarts = (await spawnAttempts(page)).length;
        // From here on every start is refused: the resume, and the fresh one behind it.
        await page.evaluate(() => { (window as unknown as { __refuseFreshStarts: boolean }).__refuseFreshStarts = true; });

        await page.getByTestId('command-terminal-earlier-row').first().click();

        await expect(page.getByTestId('toast').filter({ hasText: "Couldn't resume conversation" }).getByTestId('toast-body'))
          .toHaveText(CONVERSATION_OPEN_SENTENCE);
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
        // Both starts went out, the resume and the fresh one, and no third.
        await settleFrames(page, 20);
        expect((await spawnAttempts(page)).slice(coldStarts)).toEqual([
          { slot: 'slot-1', resumeAgentSessionId: 'conversation-1' },
          { slot: 'slot-1', resumeAgentSessionId: null },
        ]);
      } finally {
        await browser.close();
      }
    });

    test('at the cap the rows are off and say why', async () => {
      const { browser, page } = await launchWithState(earlierPreConfig(earlierEntries(3)));
      try {
        await openWithOneTerminal(page);
        for (let count = 2; count <= 4; count += 1) {
          await page.getByTestId('command-terminal-new').click();
          await expect(page.getByTestId('command-terminal-window')).toHaveCount(count, { timeout: 5000 });
        }
        const firstRow = page.getByTestId('command-terminal-earlier-row').first();
        await expect(firstRow).toBeDisabled({ timeout: 3000 });
        await expect(firstRow).toHaveAccessibleDescription('Stop one of the four to add another');
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Open in new window: the panel moves into a window of its own for its
  // project. The in-app panel never shows beside it, every way of opening the
  // panel brings the window forward instead, and closing the window brings the
  // panel back while a terminal still runs. The window itself is a renderer of
  // its own, booted here the way main boots it: with the pop-out descriptor.
  // ---------------------------------------------------------------------------
  test.describe('Open in new window', () => {
    const DETACHED_PROJECT_ID = 'proj-detached';
    const DETACHED_PROJECT_NAME = 'Detached Project';
    const WINDOW_KEY = `command-terminal:${DETACHED_PROJECT_ID}`;
    const LIVE_TERMINAL_ID = 'sess-detached-live';

    /** One project; with `liveTerminal`, a Command Terminal already running in slot-1. */
    function detachedPreConfig(options: { liveTerminal: boolean }): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${DETACHED_PROJECT_ID}',
            name: '${DETACHED_PROJECT_NAME}',
            path: '/mock/detached',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, { id: 'lane-detached-' + i, position: i, created_at: ts }));
          });
          if (${options.liveTerminal}) {
            state.sessions.push({
              id: '${LIVE_TERMINAL_ID}',
              taskId: '${LIVE_TERMINAL_ID}',
              projectId: '${DETACHED_PROJECT_ID}',
              pid: 4001,
              status: 'running',
              shell: 'bash',
              cwd: '/mock/detached',
              startedAt: ts,
              exitCode: null,
              resuming: false,
              transient: true,
              commandTerminalSlot: 'slot-1',
              commandTerminalBranch: 'main',
              commandTerminalLabel: null,
            });
          }
          return { currentProjectId: '${DETACHED_PROJECT_ID}' };
        });
      `;
    }

    async function popOutCalls(page: Page): Promise<Array<{ type: string; kind: string; params: Record<string, unknown> }>> {
      return page.evaluate(() => (window as unknown as {
        __mockPopOut: { getCalls: () => Array<{ type: string; kind: string; params: Record<string, unknown> }> };
      }).__mockPopOut.getCalls());
    }

    async function firePopOutChanged(page: Page, keys: string[]): Promise<void> {
      await page.evaluate((openKeys) => {
        (window as unknown as { __mockFirePopOutChanged: (keys: string[]) => void }).__mockFirePopOutChanged(openKeys);
      }, keys);
    }

    async function spawnCount(page: Page): Promise<number> {
      return page.evaluate(() => ((window as unknown as { __mockSpawnTransientCalls?: unknown[] }).__mockSpawnTransientCalls ?? []).length);
    }

    async function openPanelWithOneTerminal(page: Page): Promise<void> {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
      await expect.poll(async () => (await transientEntriesFor(page, DETACHED_PROJECT_ID)).length, { timeout: 5000 }).toBe(1);
    }

    /**
     * A page booted as a project's detached window, as main boots one. The window names
     * `windowProjectId`, the seeded project's unless a test names another to stand for one
     * that was removed after the window's descriptor was written.
     */
    async function launchDetachedWindow(
      preConfig: string,
      windowProjectId: string = DETACHED_PROJECT_ID,
    ): Promise<{ browser: Browser; page: Page }> {
      await waitForViteReady();
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.addInitScript({ path: MOCK_SCRIPT });
      await page.addInitScript(`${preConfig}
        window.electronAPI.popOut.descriptor = {
          kind: 'command-terminal',
          params: { projectId: '${windowProjectId}', projectName: '${DETACHED_PROJECT_NAME}' },
        };`);
      await gotoVite(page, VITE_URL);
      return { browser, page };
    }

    test('the header button hides the panel and opens the project\'s window', async () => {
      const { browser, page } = await launchWithState(detachedPreConfig({ liveTerminal: false }));
      try {
        await openPanelWithOneTerminal(page);
        await page.getByTestId('command-terminal-panel-pop-out').click();

        await expect(page.getByTestId('command-terminal-layer')).toHaveCount(0, { timeout: 3000 });
        expect(await popOutCalls(page)).toContainEqual({
          type: 'open',
          kind: 'command-terminal',
          params: { projectId: DETACHED_PROJECT_ID, projectName: DETACHED_PROJECT_NAME },
        });
      } finally {
        await browser.close();
      }
    });

    // Main holds a starting terminal's slot reserved until its start lands, so
    // a window opened then could neither find that terminal nor take its slot.
    test('the header button stays off while a terminal is still starting', async () => {
      const { browser, page } = await launchWithState(`${detachedPreConfig({ liveTerminal: false })}
        window.electronAPI.sessions.spawnTransient = function () {
          return new Promise(function () {});
        };`);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        const popOutButton = page.getByTestId('command-terminal-panel-pop-out');
        await expect(popOutButton).toBeDisabled();
        await expect(popOutButton).toHaveAccessibleDescription('Wait for the terminals to start.');
        await popOutButton.click({ force: true });
        expect((await popOutCalls(page)).filter((call) => call.type === 'open')).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test('while the window is open, Ctrl+Shift+P and the title-bar toggle bring it forward', async () => {
      const { browser, page } = await launchWithState(detachedPreConfig({ liveTerminal: true }));
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await firePopOutChanged(page, [WINDOW_KEY]);

        await page.keyboard.press('Control+Shift+P');
        await page.getByTestId('quick-session-button').click();

        await expect.poll(async () => (await popOutCalls(page)).filter((call) => call.type === 'focus').length, { timeout: 3000 }).toBe(2);
        expect((await popOutCalls(page)).find((call) => call.type === 'focus')).toMatchObject({
          kind: 'command-terminal',
          params: { projectId: DETACHED_PROJECT_ID },
        });
        await expect(page.getByTestId('command-terminal-layer')).toHaveCount(0);
        expect(await spawnCount(page)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('the window opening hides a panel that was showing', async () => {
      const { browser, page } = await launchWithState(detachedPreConfig({ liveTerminal: true }));
      try {
        await openPanelWithOneTerminal(page);
        await firePopOutChanged(page, [WINDOW_KEY]);
        await expect(page.getByTestId('command-terminal-layer')).toHaveCount(0, { timeout: 3000 });
        // Its open flag is what asks main for the terminals' output; it is down.
        await expect.poll(() => page.evaluate(() => (window as unknown as {
          __zustandStores: { session: { getState: () => { commandBarVisible: boolean } } };
        }).__zustandStores.session.getState().commandBarVisible), { timeout: 3000 }).toBe(false);
      } finally {
        await browser.close();
      }
    });

    test('closing the window brings the panel back with the running terminal, and starts nothing', async () => {
      const { browser, page } = await launchWithState(detachedPreConfig({ liveTerminal: true }));
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await firePopOutChanged(page, [WINDOW_KEY]);
        await firePopOutChanged(page, []);

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect.poll(async () => (await transientPairingFor(page, DETACHED_PROJECT_ID))['slot-1'], { timeout: 5000 }).toBe(LIVE_TERMINAL_ID);
        expect(await spawnCount(page)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('a window closed by stopping its last terminal leaves the panel closed', async () => {
      const { browser, page } = await launchWithState(detachedPreConfig({ liveTerminal: true }));
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await firePopOutChanged(page, [WINDOW_KEY]);
        // The window's Stop ends the terminal in main, which announces the removal.
        await page.evaluate((sessionId) => window.electronAPI.sessions.killTransient(sessionId), LIVE_TERMINAL_ID);
        await expect.poll(() => page.evaluate((sessionId) => (window as unknown as {
          __zustandStores: { session: { getState: () => { sessions: Array<{ id: string }> } } };
        }).__zustandStores.session.getState().sessions.some((session) => session.id === sessionId), LIVE_TERMINAL_ID), { timeout: 3000 }).toBe(false);
        await firePopOutChanged(page, []);

        // The push decides the reopen as it lands, by arming the pending-open
        // flag or not, so reading the flag right after it is the whole answer.
        expect(await page.evaluate(() => (window as unknown as {
          __zustandStores: { session: { getState: () => { _pendingOpenCommandTerminal: boolean } } };
        }).__zustandStores.session.getState()._pendingOpenCommandTerminal)).toBe(false);
        await expect(page.getByTestId('command-terminal-layer')).toHaveCount(0);
        expect(await spawnCount(page)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('the window shows its project\'s running terminal once the sessions have synced, and starts no second one', async () => {
      const { browser, page } = await launchDetachedWindow(detachedPreConfig({ liveTerminal: true }));
      try {
        await expect(page.getByTestId('command-terminal-detached')).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await expect.poll(async () => (await transientPairingFor(page, DETACHED_PROJECT_ID))['slot-1'], { timeout: 5000 }).toBe(LIVE_TERMINAL_ID);
        expect(await spawnCount(page)).toBe(0);
        await expect(page.getByTestId('command-terminal-rail')).toBeVisible();
        // The OS frame moves, sizes and closes it, so the panel's own chrome is absent.
        await expect(page.getByTestId('command-terminal-panel')).toHaveCount(0);
        await expect(page.getByTestId('command-window-backdrop')).toHaveCount(0);
        await expect(page.getByText(`Command Terminal - ${DETACHED_PROJECT_NAME}`)).toBeVisible();
        // It asks main for that terminal's output itself.
        await expect.poll(() => page.evaluate(() => {
          const calls = (window.electronAPI.sessions as unknown as { __setFocusedCalls: string[][] }).__setFocusedCalls;
          return calls.at(-1) ?? null;
        }), { timeout: 5000 }).toEqual([LIVE_TERMINAL_ID]);
      } finally {
        await browser.close();
      }
    });

    test('the window\'s rail holds Add terminal, as the panel\'s does', async () => {
      const { browser, page } = await launchDetachedWindow(detachedPreConfig({ liveTerminal: true }));
      try {
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 15000 });
        const newTerminal = page.getByTestId('command-terminal-rail').getByTestId('command-terminal-new');
        await expect(newTerminal).toBeVisible();
        await expect(page.getByTestId('command-terminal-new')).toHaveCount(1);

        await newTerminal.click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });
      } finally {
        await browser.close();
      }
    });

    test('stopping the window\'s last terminal closes the window', async () => {
      const { browser, page } = await launchDetachedWindow(detachedPreConfig({ liveTerminal: true }));
      try {
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 15000 });
        await page.getByTestId('command-bar-terminate-button').click();

        await expect.poll(() => page.evaluate(() => (window as unknown as {
          __mockWindowControls: { getCalls: () => string[] };
        }).__mockWindowControls.getCalls()), { timeout: 5000 }).toContain('close');
      } finally {
        await browser.close();
      }
    });

    test('a window whose project has since been removed says so, and starts no terminal', async () => {
      // The seeded project is in the list and the window names another one.
      const { browser, page } = await launchDetachedWindow(detachedPreConfig({ liveTerminal: false }), 'proj-removed-since');
      try {
        await expect(page.getByTestId('command-terminal-window-missing')).toHaveText('This project is no longer in Kangentic.', { timeout: 10000 });
        await expect(page.getByTestId('command-terminal-detached')).toHaveCount(0);
        // Frames, not a timer: long enough for a start, were the layer mounted, to go out.
        await settleFrames(page, 20);
        expect(await spawnCount(page)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    // A read the window needs that fails reports `failed`, never `ready`: mounting the
    // terminals without the session list starts a second terminal in a slot that has one.
    const FAILED_WINDOW_TEXT = "Couldn't load the terminals for this window.";
    for (const unreadable of [
      { read: 'project list', script: `window.electronAPI.projects.list = function () { return Promise.reject(new Error('projects unavailable')); };` },
      { read: 'config', script: `window.electronAPI.config.get = function () { return Promise.reject(new Error('config unavailable')); };` },
      { read: 'agent list', script: 'window.__mockAgentListRejects = true;' },
      { read: 'session list', script: `window.electronAPI.sessions.list = function () { return Promise.reject(new Error('sessions unavailable')); };` },
    ]) {
      test(`a window that cannot read the ${unreadable.read} says so, and starts no terminal`, async () => {
        // No terminal is running, so a window that mounted anyway would start one: a spawn
        // count of zero then means it never mounted.
        const { browser, page } = await launchDetachedWindow(`${detachedPreConfig({ liveTerminal: false })}
          ${unreadable.script}`);
        try {
          await expect(page.getByTestId('command-terminal-window-failed')).toHaveText(FAILED_WINDOW_TEXT, { timeout: 10000 });
          await expect(page.getByTestId('command-terminal-detached')).toHaveCount(0);
          await settleFrames(page, 20);
          expect(await spawnCount(page)).toBe(0);
        } finally {
          await browser.close();
        }
      });
    }

    // The header button hides the panel first, then asks main for the window. A window that
    // does not open would leave the running terminals with nothing showing them.
    for (const refusal of [
      { outcome: 'refuses', arm: async (page: Page) => { await page.evaluate(() => (window as unknown as {
        __mockPopOut: { setOpenResult: (opened: boolean) => void };
      }).__mockPopOut.setOpenResult(false)); } },
      { outcome: 'fails', arm: async (page: Page) => { await page.evaluate(() => {
        window.electronAPI.popOut.open = () => Promise.reject(new Error('no window could be created'));
      }); } },
    ]) {
      test(`when main ${refusal.outcome} the window, the panel comes back with its terminal, and a toast says so`, async () => {
        const { browser, page } = await launchWithState(detachedPreConfig({ liveTerminal: false }));
        try {
          await openPanelWithOneTerminal(page);
          const startsBefore = await spawnCount(page);
          await refusal.arm(page);

          await page.getByTestId('command-terminal-panel-pop-out').click();

          const toast = page.getByTestId('toast').filter({ hasText: "Couldn't open the window" });
          await expect(toast.getByTestId('toast-title')).toHaveText("Couldn't open the window");
          await expect(toast.getByTestId('toast-body')).toHaveText('The terminals are back in the panel.');
          // The pending-open flag reopened the panel, over the terminal that kept running.
          await expect(page.getByTestId('command-terminal-panel')).toBeVisible({ timeout: 5000 });
          await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);
          await settleFrames(page, 20);
          expect(await spawnCount(page)).toBe(startsBefore);
        } finally {
          await browser.close();
        }
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Per-window Changes panel isolation - each Command Terminal window derives its
  // own Changes-panel entity id from its durable slot
  // (`commandTerminalChangesEntityId(slot)` => 'command-terminal::slot-N'), so
  // toggling Changes on one window must not affect another window's panel. Uses
  // the kebab "Show changes" / "Hide changes" menu item rather than the header
  // pill: the pill can fold into the kebab once two windows are docked
  // side-by-side and narrower than the priority-plus floor, but the kebab trigger
  // is a protected trailing control (see useHeaderPillOverflow) and is always
  // rendered, so it is the stable way to drive this regardless of window width.
  // ---------------------------------------------------------------------------
  test.describe('Per-window Changes panel isolation', () => {
    test('toggling Changes on one window does not open it on another window', async () => {
      const { browser, page } = await launchWithState(multiTerminalPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });
        await page.getByTestId('command-terminal-new').click();
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(2, { timeout: 5000 });

        const idsBySlot = await commandWindowIdBySlot(page);
        expect(Object.keys(idsBySlot).sort()).toEqual(['slot-1', 'slot-2']);
        const windowOneFrame = page.getByTestId(`window-frame-${idsBySlot['slot-1']}`);
        const windowTwoFrame = page.getByTestId(`window-frame-${idsBySlot['slot-2']}`);

        // Open window 1's Changes panel via its own kebab menu.
        await windowOneFrame.getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByText('Show changes', { exact: true }).click();

        // Store-level assertion: only window 1's per-slot entity id is open -
        // proves the toggle scheduled against 'command-terminal::slot-1', not a
        // shared 'command-terminal' id that would also cover window 2.
        await expect.poll(() => changesOpenEntityIds(page), { timeout: 3000 }).toEqual(['command-terminal::slot-1']);

        // UI-level assertion: window 2's own kebab still reads "Show changes"
        // (unaffected). This exercises the real render path (the changesOpen
        // selector read inside CommandTerminalWindow), not just the store.
        await windowTwoFrame.getByRole('button', { name: 'Actions', exact: true }).click();
        await expect(page.getByText('Show changes', { exact: true })).toBeVisible();

        // And window 1's own kebab now reads "Hide changes", confirming its
        // toggle round-tripped through the real component, not just the store.
        await windowTwoFrame.getByRole('button', { name: 'Actions', exact: true }).click(); // close window 2's menu first
        await windowOneFrame.getByRole('button', { name: 'Actions', exact: true }).click();
        await expect(page.getByText('Hide changes', { exact: true })).toBeVisible();
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // ContextBar in overlay - each test has a unique spawnTransient override
  // injected AFTER the init scripts run. These cannot share a browser context
  // (addInitScript is fixed at context creation; per-test overrides are added
  // inline in launchWithState). Each test uses its own browser instance.
  // ---------------------------------------------------------------------------
  test.describe('ContextBar in overlay', () => {
    // These tests verify the two changes introduced by the branch:
    //
    // 1. CommandTerminalWindow renders <ContextBar sessionId={sessionId} agentFallback={projectAgent} />
    //    only AFTER sessionId is set (i.e. after spawnTransient resolves).
    //    Before the session is spawned, no [data-testid="usage-bar"] should appear
    //    inside the window.
    //
    // 2. ContextBar receives agentFallback=projectAgent. Transient sessions have no
    //    task row in the board store, so the board-store lookup for session_id yields
    //    undefined. The nullish-coalesce (?? agentFallback) must then fall through to
    //    projectAgent, so the version pill shows the project's agent display name
    //    (e.g. "Claude Code") instead of the generic "Agent" string.

    test('ContextBar is absent while spawnTransient is pending', async () => {
      // Use a preconfig with NO pre-existing transient session so the overlay
      // has no transientSessionId to reattach to. Then intercept spawnTransient
      // with a promise that never resolves, keeping sessionId === null.
      // The ContextBar should not mount at all during this window.
      //
      // We use twoProjectPreConfig() as the base because it has no pre-injected
      // transient sessions in the session list, unlike preConfigWithTransientSession().
      const preConfigWithHangingSpawn = twoProjectPreConfig() + `
        window.electronAPI.sessions.spawnTransient = function () {
          // Never resolves - keeps the overlay in the pre-spawn phase indefinitely.
          return new Promise(function () {});
        };
      `;
      const { browser, page } = await launchWithState(preConfigWithHangingSpawn);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the overlay
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // ContextBar should NOT be present - sessionId is still null.
        // Intentional fixed wait: we cannot poll for non-occurrence.
        // 800ms is enough for the microtask queue to flush if the spawn had resolved.
        await page.waitForTimeout(800);
        await expect(
          page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]')
        ).not.toBeVisible();
      } finally {
        await browser.close();
      }
    });

    test('ContextBar mounts inside overlay once session is spawned', async () => {
      // The transient session ID is generated at runtime by spawnTransient.
      // We override spawnTransient to return a deterministic ID, then use
      // page.evaluate() to push usage data directly into the Zustand store
      // for that ID. This avoids the Proxy-spread problem (a Proxy is not
      // enumerable, so { ...proxy } produces an empty object and the store
      // never sees the usage) and avoids relying on the onUsage IPC event
      // (which the mock returns as noop and never fires).
      const TRANSIENT_ID = 'transient-overlay-test-1';
      const preConfigWithDeterministicSpawn = twoProjectPreConfig() + `
        window.electronAPI.sessions.spawnTransient = async function (input) {
          var session = {
            id: '${TRANSIENT_ID}',
            taskId: '${TRANSIENT_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          };
          return { session: session, branch: 'main' };
        };
      `;

      const { browser, page } = await launchWithState(preConfigWithDeterministicSpawn);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        // Open the overlay - spawnTransient fires immediately with our deterministic ID.
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // ContextBar mounts (showing the spinner pill) once sessionId is set.
        const overlayContextBar = page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]');
        await expect(overlayContextBar).toBeVisible({ timeout: 5000 });

        // Push usage directly into the session store using the known session ID.
        // This simulates what the onUsage IPC event would do in production.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus', displayName: 'Claude Opus' },
            contextWindow: {
              usedPercentage: 10,
              usedTokens: 500,
              cacheTokens: 0,
              totalInputTokens: 400,
              totalOutputTokens: 100,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.002, totalDurationMs: 1200 },
          });
        }, TRANSIENT_ID);

        // After usage lands the ContextBar should show the model name, not the spinner.
        await expect(overlayContextBar).toContainText('Claude Opus', { timeout: 3000 });
        await expect(overlayContextBar).not.toContainText('Starting agent...');
      } finally {
        await browser.close();
      }
    });

    test('ContextBar version pill shows project agent name via agentFallback', async () => {
      // The key regression this tests: transient sessions have no task row in the
      // board store. Before the agentFallback fix, the version pill showed "Agent"
      // because agentDisplayName(null) was called. After the fix it shows the
      // project's default_agent display name ("Claude Code" for agent="claude").
      //
      // The board store lookup:
      //   tasks.find(t => t.session_id === sessionId)?.agent
      // returns undefined for transient sessions (no task row in the board store).
      // The nullish coalesce (undefined ?? agentFallback) uses agentFallback = "claude".
      // agentDisplayName("claude") = "Claude Code".
      const TRANSIENT_ID = 'transient-overlay-test-2';
      const preConfigForFallback = twoProjectPreConfig() + `
        // Ensure Project Alpha's default_agent is "claude".
        window.__mockPreConfigure(function (state) {
          var project = state.projects.find(function (p) { return p.id === '${PROJECT_A_ID}'; });
          if (project) project.default_agent = 'claude';
        });

        window.electronAPI.sessions.spawnTransient = async function (input) {
          var session = {
            id: '${TRANSIENT_ID}',
            taskId: '${TRANSIENT_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          };
          return { session: session, branch: 'main' };
        };
      `;

      const { browser, page } = await launchWithState(preConfigForFallback);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const overlayContextBar = page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]');
        await expect(overlayContextBar).toBeVisible({ timeout: 5000 });

        // Push usage so the version pill renders (it only shows when resolvedModelName is set).
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus', displayName: 'Claude Opus' },
            contextWindow: {
              usedPercentage: 5,
              usedTokens: 200,
              cacheTokens: 0,
              totalInputTokens: 150,
              totalOutputTokens: 50,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.001, totalDurationMs: 500 },
          });
        }, TRANSIENT_ID);

        // The version pill shows agentDisplayName(taskAgent ?? agentFallback).
        // taskAgent: board store has no task with session_id === TRANSIENT_ID -> undefined.
        // agentFallback: projectAgent from useProjectStore = "claude".
        // agentDisplayName("claude") = "Claude Code".
        await expect(overlayContextBar).toContainText('Claude Code', { timeout: 3000 });
        await expect(overlayContextBar).not.toContainText('Starting agent...');
      } finally {
        await browser.close();
      }
    });

    test('version pill shows "Agent" when project has no default_agent set', async () => {
      // Baseline: if projectAgent is null, agentFallback is null, and the board
      // store finds no task row, then agentDisplayName(null) returns "Agent".
      // This confirms the test above is not a false positive - the component
      // actually reads agentFallback and uses it when the project agent is null.
      const TRANSIENT_ID = 'transient-overlay-test-3';
      const preConfigWithNullAgent = twoProjectPreConfig() + `
        window.__mockPreConfigure(function (state) {
          var project = state.projects.find(function (p) { return p.id === '${PROJECT_A_ID}'; });
          if (project) project.default_agent = null;
        });

        window.electronAPI.sessions.spawnTransient = async function (input) {
          var session = {
            id: '${TRANSIENT_ID}',
            taskId: '${TRANSIENT_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          };
          return { session: session, branch: 'main' };
        };
      `;

      const { browser, page } = await launchWithState(preConfigWithNullAgent);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const overlayContextBar = page.getByTestId('command-terminal-window').locator('[data-testid="usage-bar"]');
        await expect(overlayContextBar).toBeVisible({ timeout: 5000 });

        // Push usage so the version pill renders.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus', displayName: 'Claude Opus' },
            contextWindow: {
              usedPercentage: 5,
              usedTokens: 200,
              cacheTokens: 0,
              totalInputTokens: 150,
              totalOutputTokens: 50,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.001, totalDurationMs: 500 },
          });
        }, TRANSIENT_ID);

        // null agentFallback -> agentDisplayName(null) -> "Agent"
        await expect(overlayContextBar).toContainText('Agent', { timeout: 3000 });
      } finally {
        await browser.close();
      }
    });

    test('transient ContextBar picker injects model/effort via session-keyed IPC (no task override)', async () => {
      // Command Terminal sessions are transient (no task row). The ContextBar
      // renders the picker in session-inject mode: selecting a value calls
      // sessions.injectSettings (session-keyed, no DB persistence) rather than
      // the task-keyed tasks.setRuntimeOverride. This is the fix for the
      // reported "can't change model/effort from the Command Terminal".
      const TRANSIENT_ID = 'transient-overlay-picker-1';
      const preConfig = twoProjectPreConfig() + `
        window.__mockPreConfigure(function (state) {
          var project = state.projects.find(function (p) { return p.id === '${PROJECT_A_ID}'; });
          if (project) project.default_agent = 'claude';
        });

        window.electronAPI.sessions.spawnTransient = async function (input) {
          var session = {
            id: '${TRANSIENT_ID}',
            taskId: '${TRANSIENT_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          };
          return { session: session, branch: 'main' };
        };
      `;

      const { browser, page } = await launchWithState(preConfig);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const overlay = page.getByTestId('command-terminal-window');
        await expect(overlay.locator('[data-testid="usage-bar"]')).toBeVisible({ timeout: 5000 });

        // Push usage with a model + effort so both pills resolve to interactive triggers.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as { __zustandStores?: { session?: { getState: () => { updateUsage: (id: string, data: object) => void } } } }).__zustandStores;
          stores?.session?.getState().updateUsage(sessionId, {
            model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8 (1M context)', effort: 'xhigh' },
            contextWindow: {
              usedPercentage: 5,
              usedTokens: 200,
              cacheTokens: 0,
              totalInputTokens: 150,
              totalOutputTokens: 50,
              contextWindowSize: 200000,
            },
            cost: { totalCostUsd: 0.001, totalDurationMs: 500 },
          });
        }, TRANSIENT_ID);

        // Both triggers render as interactive buttons inside the overlay.
        const modelTrigger = overlay.locator('[data-testid="context-bar-model-trigger"]');
        const effortTrigger = overlay.locator('[data-testid="context-bar-effort-trigger"]');
        await expect(modelTrigger).toBeVisible({ timeout: 5000 });
        await expect(effortTrigger).toBeVisible({ timeout: 5000 });

        // Pick a model -> session-keyed inject, not the task override path. The
        // popover body-portals (strategy: 'fixed') to escape the footer's compositing
        // layer, so the option lives at the page root, not inside the overlay element.
        await modelTrigger.click();
        await page.locator('[data-testid="context-bar-model-popover-option-sonnet"]').click();

        const injectCalls = await page.evaluate(() =>
          (window as unknown as { electronAPI: { sessions: { __injectSettingsCalls?: Array<Record<string, unknown>> } } }).electronAPI.sessions.__injectSettingsCalls,
        );
        expect(injectCalls?.length).toBe(1);
        expect(injectCalls?.[0]).toMatchObject({ sessionId: TRANSIENT_ID, agent: 'claude', model: 'sonnet' });

        // The task-keyed override path must NOT have been used for a transient session.
        const overrideCalls = await page.evaluate(() =>
          (window as unknown as { __mockSetRuntimeOverrideCalls?: unknown[] }).__mockSetRuntimeOverrideCalls,
        );
        expect(overrideCalls ?? []).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Maximize focus restore - keyboard focus stays in the terminal across the
  // panel's maximize and restore (the PR #33 bug: focus left on the button).
  // Uses a per-test browser with a deterministic spawn so xterm actually mounts.
  // ---------------------------------------------------------------------------
  test.describe('Maximize focus restore', () => {
    // These tests require the terminal to be fully mounted (xterm.open() called).
    // We use the same deterministic-spawn + markFirstOutput pattern as
    // write-batcher-integration.spec.ts and terminal-ctrl-c-interrupt.spec.ts.

    const FOCUS_PROJECT_ID = 'proj-maximize-focus-test';
    const FOCUS_TRANSIENT_SESSION_ID = 'sess-maximize-focus-1';

    function basePreConfigForFocusTest(): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${FOCUS_PROJECT_ID}',
            name: 'Maximize Focus Test Project',
            path: '/mock/maximize-focus-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, {
              id: 'lane-mf-' + i,
              position: i,
              created_at: ts,
            }));
          });
          return { currentProjectId: '${FOCUS_PROJECT_ID}' };
        });
      `;
    }

    const deterministicSpawnForFocusTest = `
      window.electronAPI.sessions.spawnTransient = async function (input) {
        return {
          session: {
            id: '${FOCUS_TRANSIENT_SESSION_ID}',
            taskId: '${FOCUS_TRANSIENT_SESSION_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/maximize-focus-test',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          },
          branch: 'main',
        };
      };
    `;

    /**
     * Open the command bar overlay and wait for xterm to mount.
     * Mirrors the openCommandBarWithTerminal helper used by
     * write-batcher-integration.spec.ts and terminal-ctrl-c-interrupt.spec.ts.
     */
    async function openCommandBarWithMountedTerminal(page: Page): Promise<void> {
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toBeVisible();

      // Inject sessionFirstOutput so terminalReady flips to true immediately,
      // lifting the shimmer overlay and allowing xterm.open() to run.
      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            session?: { getState: () => { markFirstOutput: (id: string) => void } };
          };
        }).__zustandStores;
        stores?.session?.getState().markFirstOutput(sessionId);
      }, FOCUS_TRANSIENT_SESSION_ID);

      // Wait for xterm to open: .xterm-helper-textarea is the focusable element
      // xterm attaches immediately after terminal.open() completes.
      await expect(
        page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first()
      ).toBeAttached({ timeout: 8000 });
    }

    test('the panel maximize button and Ctrl+Shift+M leave focus in the terminal', async () => {
      // This pins the behavior fixed in PR #33: toggling maximize left DOM focus
      // on the maximize button, so the next keystroke hit the button instead of
      // the terminal. The panel's header refuses focus on a press (its mousedown
      // is prevented), so a click on Maximize never takes it from the terminal.
      //
      // toBeFocused() has built-in retry via Playwright's actionability assertions,
      // which absorbs the requestAnimationFrame and effect timing.
      const { browser, page } = await launchWithState(
        basePreConfigForFocusTest() + deterministicSpawnForFocusTest
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openCommandBarWithMountedTerminal(page);

        const xtermTextarea = page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first();
        await xtermTextarea.focus();
        await expect(xtermTextarea).toBeFocused();

        const panel = page.getByTestId('command-terminal-panel');
        const maximizeButton = page.getByTestId('command-terminal-panel-maximize');
        await maximizeButton.click();
        await expect(panel).toHaveAttribute('data-maximized', 'true');
        await expect(xtermTextarea).toBeFocused({ timeout: 3000 });

        // The keybinding path restores, and the terminal keeps focus there too.
        await page.keyboard.press('Control+Shift+M');
        await expect(panel).toHaveAttribute('data-maximized', 'false');
        await expect(xtermTextarea).toBeFocused({ timeout: 3000 });
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Stop activity ring - the Stop button in CommandTerminalWindow carries the
  // same ring affordance as the task-detail pause button, but with a stop square
  // instead of pause bars. Three ring states:
  //   thinking (isActive)          -> the control-stop-working mark, tinted text-active
  //   idle/permission (requiresUI) -> the control-stop-idle mark, tinted text-attention
  //   no session / not running     -> plain lucide CircleStop, no mark at all
  //
  // Ring and square are ONE packaged @kangentic/branding mark, so `data-mark` carries both
  // "a ring is showing" and "which state it is": there is no separate stop-square element to
  // assert, and no lucide `animate-spin` class - the working ring rotates via the packaged
  // `.kng-spin`, whose own contract (period, composited property, reduced motion) is pinned in
  // tests/ui/activity-marks.spec.ts rather than re-asserted here.
  //
  // Each test uses a deterministic spawnTransient override (known session id) so
  // page.evaluate can call updateActivity + markFirstOutput on that exact id
  // without racing against a randomly-generated uuid from the default mock.
  // ---------------------------------------------------------------------------
  test.describe('Stop activity ring', () => {
    const RING_PROJECT_ID = 'proj-ring-test';
    const RING_SESSION_ID = 'sess-ring-test-1';

    /** Base preconfig: one project, no pre-existing sessions (the overlay will spawn one). */
    function ringBasePreConfig(): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${RING_PROJECT_ID}',
            name: 'Ring Test Project',
            path: '/mock/ring-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, {
              id: 'lane-ring-' + i,
              position: i,
              created_at: ts,
            }));
          });
          return { currentProjectId: '${RING_PROJECT_ID}' };
        });
      `;
    }

    /** Override spawnTransient to return a deterministic session id so we can
     *  push activity state into the store for that exact id. */
    const deterministicSpawn = `
      window.electronAPI.sessions.spawnTransient = async function (input) {
        return {
          session: {
            id: '${RING_SESSION_ID}',
            taskId: '${RING_SESSION_ID}',
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/ring-test',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
          },
          branch: 'main',
        };
      };
    `;

    /**
     * Open the command bar and flip terminalReady by calling markFirstOutput so
     * sessionRunning=true. Without this, isThinking and isIdle are always false
     * (the ring only shows for a live session), and the ring tests would pass
     * trivially against the wrong state.
     */
    async function openOverlayAndMarkSessionReady(page: Page): Promise<void> {
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toBeVisible();

      // markFirstOutput flips sessionFirstOutput[id] -> true, which sets
      // hasSessionStarted=true -> terminalReady=true via a useEffect.
      // This mirrors the pattern used by write-batcher-integration.spec.ts and
      // terminal-ctrl-c-interrupt.spec.ts for xterm tests.
      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            session?: { getState: () => { markFirstOutput: (id: string) => void } };
          };
        }).__zustandStores;
        stores?.session?.getState().markFirstOutput(sessionId);
      }, RING_SESSION_ID);

      // Poll until terminalReady is reflected: the stop button must lose its
      // lucide-circle-stop class (the default rest-state icon) once the session
      // starts, confirming the sessionRunning gate is now true.
      // We assert the activity-specific state in each individual test instead.
    }

    test('thinking activity shows the rotating active stop ring', async () => {
      // Derives expected behavior from the contract in CommandTerminalWindow.tsx:
      //   isThinking = sessionRunning && isActive(activity)
      //   -> the control-stop-working mark, tinted text-active
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openOverlayAndMarkSessionReady(page);

        // Push 'thinking' activity into the store for the known session id.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session?: { getState: () => { updateActivity: (id: string, state: string) => void } };
            };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'thinking');
        }, RING_SESSION_ID);

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // The working mark: ring + stop square in one SVG, tinted active-green.
        const ring = stopButton.locator('[data-mark="control-stop-working"]');
        await expect(ring).toBeVisible({ timeout: 3000 });
        await expect(ring).toHaveClass(/text-active/);

        // Neither the idle ring nor the plain rest-state icon may be present when thinking.
        await expect(stopButton.locator('[data-mark="control-stop-idle"]')).toHaveCount(0);
        await expect(stopButton.locator('.lucide-circle-stop')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('idle activity shows the static attention stop ring', async () => {
      // Derives expected behavior from the contract in CommandTerminalWindow.tsx:
      //   isIdle = sessionRunning && requiresUserInteraction(activity)
      //   requiresUserInteraction('idle') = true (ACTIVITY_DISPOSITION idle -> 'idle')
      //   -> the control-stop-idle mark, tinted text-attention, with no march
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openOverlayAndMarkSessionReady(page);

        // Push 'idle' activity (requiresUserInteraction = true, isActive = false)
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session?: { getState: () => { updateActivity: (id: string, state: string) => void } };
            };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'idle');
        }, RING_SESSION_ID);

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // The idle mark: ring + stop square in one SVG, tinted attention-amber.
        const ring = stopButton.locator('[data-mark="control-stop-idle"]');
        await expect(ring).toBeVisible({ timeout: 3000 });
        await expect(ring).toHaveClass(/text-attention/);

        // Idle is static. The animated variant is a DIFFERENT mark, so its absence is the
        // assertion - there is no motion class to check on the idle one.
        await expect(stopButton.locator('[data-mark="control-stop-working"]')).toHaveCount(0);

        // The plain rest-state icon (CircleStop) must NOT be present when idle
        await expect(stopButton.locator('.lucide-circle-stop')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('permission activity shows static attention ring (same as idle)', async () => {
      // requiresUserInteraction('permission') = true (ACTIVITY_DISPOSITION maps
      // 'permission' -> 'idle'). The ring is identical to the idle ring.
      // This pins the activity-state-classification contract in the UI layer:
      // 'permission' must be treated as "needs user" (attention) not "working" (active).
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openOverlayAndMarkSessionReady(page);

        // Push 'permission' activity
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session?: { getState: () => { updateActivity: (id: string, state: string) => void } };
            };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'permission');
        }, RING_SESSION_ID);

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // Static attention ring - permission maps to the idle disposition, so it renders the
        // SAME mark as idle, not the animated one.
        const ring = stopButton.locator('[data-mark="control-stop-idle"]');
        await expect(ring).toBeVisible({ timeout: 3000 });
        await expect(ring).toHaveClass(/text-attention/);
        await expect(stopButton.locator('[data-mark="control-stop-working"]')).toHaveCount(0);

        // No plain CircleStop for permission state
        await expect(stopButton.locator('.lucide-circle-stop')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('no active session shows plain CircleStop (no activity mark at all)', async () => {
      // When the session has not yet started (terminalReady=false, so sessionRunning=false),
      // or activity is undefined, StopButtonIcon renders the rest-state <CircleStop>.
      // This test opens the overlay WITHOUT calling markFirstOutput, so terminalReady
      // stays false and the ring must not render.
      //
      // Intent: confirm the ring only appears for a live session. If the rest-state
      // icon were absent, every close-up would look like the ring was working even
      // when there is nothing to show.
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        // Do NOT call markFirstOutput -> terminalReady stays false -> sessionRunning=false
        // -> isThinking=false, isIdle=false -> StopButtonIcon returns <CircleStop>

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // Plain rest-state icon must be present
        await expect(stopButton.locator('.lucide-circle-stop')).toBeVisible({ timeout: 3000 });

        // No activity mark of either state.
        // Intentional fixed wait: we cannot poll for non-occurrence.
        // 800ms is enough for any pending microtask queue to flush.
        await page.waitForTimeout(800);
        await expect(stopButton.locator('[data-mark^="control-stop-"]')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('Stop still fires when the icon changes ELEMENT TYPE mid-press', async () => {
      // The harder half of the same bug class, and the one IconSlot exists for.
      // StopButtonIcon's branches return different ELEMENT TYPES, so crossing between
      // them makes React unmount the whole subtree the press landed on - a lucide
      // <CircleStop> becomes an <ActivityMark> <svg>. Making the injected <g>
      // non-hit-testable cannot help here: the node carrying that style is itself
      // destroyed. Only a stable ancestor that every branch renders through survives,
      // which is IconSlot.
      //
      // Driven in the lucide -> mark direction on purpose. A session that has started
      // but not yet reported activity leaves `activity` undefined, so isThinking and
      // isIdle are both false and the lucide branch is what renders; seeding 'thinking'
      // then crosses to the mark. The reverse direction has no legal drive: every member
      // of ActivityState ('thinking' | 'idle' | 'permission') maps to one of the two
      // branches, so leaving the mark would mean feeding updateActivity a string outside
      // its own union and relying on the classifier's undefined lookup falling through.
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await openOverlayAndMarkSessionReady(page);

        const stopButton = page.getByTestId('command-bar-terminate-button');
        await expect(stopButton.locator('.lucide-circle-stop')).toBeVisible({ timeout: 3000 });

        const box = await stopButton.boundingBox();
        if (!box) throw new Error('stop button has no bounding box');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();

        // Cross to the mark branch mid-press. Awaiting the data-mark is the commit
        // barrier, so the element-type swap has definitely landed before mouseup.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: { session?: { getState: () => { updateActivity: (id: string, next: string) => void } } };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'thinking');
        }, RING_SESSION_ID);
        await expect(stopButton.locator('[data-mark="control-stop-working"]')).toBeVisible({ timeout: 3000 });

        await page.mouse.up();

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
      } finally {
        await browser.close();
      }
    });

    test('Stop still fires when the activity mark changes mid-press', async () => {
      // Regression guard for a dropped first click. ActivityMark injects the packaged
      // mark with dangerouslySetInnerHTML on an inner <g>, so changing `mark` destroys
      // every child of that <g>. control-stop's geometry is a FILLED rect covering the
      // centre of the button, so a press landing where people actually click has its
      // mousedown target torn out the moment activity flips, and Chromium drops the
      // click: the handler never runs, no kill IPC is issued, and the window stays open.
      //
      // The fix makes the injected subtree non-hit-testable, so the surviving
      // React-authored <svg> is the event target across a mark change. Without it this
      // test fails on the final assertion.
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await openOverlayAndMarkSessionReady(page);

        const setActivity = (activityState: string) => page.evaluate(({ sessionId, activityState }) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session?: { getState: () => { updateActivity: (id: string, next: string) => void } };
            };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, activityState);
        }, { sessionId: RING_SESSION_ID, activityState });

        const stopButton = page.getByTestId('command-bar-terminate-button');

        await setActivity('thinking');
        await expect(stopButton.locator('[data-mark="control-stop-working"]')).toBeVisible({ timeout: 3000 });

        // Press dead centre, which is inside the mark's filled stop square.
        const box = await stopButton.boundingBox();
        if (!box) throw new Error('stop button has no bounding box');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();

        // Flip the mark mid-press. Awaiting the new data-mark is the commit barrier:
        // the attribute and the <g>'s innerHTML are written in the same React commit,
        // so once the attribute is observable the injected children have been replaced
        // underneath the cursor. Never swap this await for a fixed wait - it is what
        // makes the race deterministic rather than intermittent.
        await setActivity('idle');
        await expect(stopButton.locator('[data-mark="control-stop-idle"]')).toBeVisible({ timeout: 3000 });

        await page.mouse.up();

        // Stop destroys this terminal and closes its window. It was the only one, so
        // the layer hides with it.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
      } finally {
        await browser.close();
      }
    });

    test('Stop shows a pending state while the kill is in flight, then closes', async () => {
      // Stop awaits a kill IPC before closing. With no pending state the button looked
      // inert for that whole window, which is indistinguishable from the dropped click
      // above - that is why the bug read as "nothing happened" rather than as an error.
      //
      // The kill is held open here so the in-between state is observable at all; the real
      // one measured ~10ms. This also covers the recovery ordering in handleTerminate: the
      // `stopping` flag is cleared after closeWindow so a close that does not unmount
      // cannot strand the button disabled with a spinner and no way back.
      const holdKill = `
        window.__resolveKill = null;
        window.electronAPI.sessions.killTransient = function () {
          return new Promise(function (resolve) { window.__resolveKill = resolve; });
        };
      `;
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn + holdKill
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await openOverlayAndMarkSessionReady(page);

        const stopButton = page.getByTestId('command-bar-terminate-button');

        // Seed a live activity mark FIRST, so the "marks are gone" assertion below is
        // about `stopping` pre-empting the ring rather than about a ring that was never
        // rendered. Without this the count-0 assertion passes vacuously.
        await page.evaluate((sessionId) => {
          const stores = (window as unknown as {
            __zustandStores?: { session?: { getState: () => { updateActivity: (id: string, next: string) => void } } };
          }).__zustandStores;
          stores?.session?.getState().updateActivity(sessionId, 'thinking');
        }, RING_SESSION_ID);
        await expect(stopButton.locator('[data-mark="control-stop-working"]')).toBeVisible({ timeout: 3000 });

        await stopButton.click();

        // In flight: disabled, spinner, and the activity mark is gone (the pending
        // branch pre-empts it).
        await expect(stopButton).toBeDisabled({ timeout: 3000 });
        await expect(stopButton.locator('.lucide-loader-circle')).toBeVisible();
        await expect(stopButton.locator('[data-mark^="control-stop-"]')).toHaveCount(0);
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);

        // Releasing the kill lets the close run.
        await page.evaluate(() => {
          const resolve = (window as unknown as { __resolveKill?: () => void }).__resolveKill;
          if (resolve) resolve();
        });
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });

        // A successful kill is silent - the error toast below is the OTHER outcome's
        // signal (see "Stop shows an error toast when the kill fails" just below), and
        // this is the negative half that pairs with it: nothing here reruns the mock's
        // kill IPC to fail, so a broadened `if (outcome === 'failed')` (e.g. dropped to
        // always show) would still slip past this file undetected without this
        // assertion.
        //
        // This is a fixed, non-polling read, not `expect(...).toHaveCount(0)`: a real
        // toast's own auto-dismiss lifecycle (config default 4s) sits inside
        // Playwright's default 5s assertion-retry window, so a polling assertion would
        // pass vacuously by waiting out an ACTUAL wrongly-fired toast rather than
        // proving one was never shown (this was verified empirically - a broadened,
        // unconditional `addToast` call still passed a polling `toHaveCount(0)` here).
        // The window's disappearance is the ordering barrier instead: addToast and
        // closeWindow are consecutive synchronous statements in handleTerminate with no
        // await between them, so once the window is confirmed gone above, any toast
        // this Stop click was going to add has already committed to the DOM - a single
        // synchronous count read is enough. The title is the failure toast's own words.
        expect(await toastCountRightNow(page, "Couldn't stop the terminal")).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('Stop shows an error toast when the kill fails, but still closes the window', async () => {
      // handleTerminate surfaces a toast only when killTransientSessionBySlot
      // resolves 'failed' (the kill IPC rejected). The window closes on every
      // outcome regardless - the user asked for this terminal to go away - so
      // the toast is the only observable signal that something went wrong.
      // Deleting the `if (outcome === 'failed')` block in CommandTerminalWindow.tsx
      // currently fails no test; this pins both halves of that behavior.
      const rejectKill = `
        window.electronAPI.sessions.killTransient = function () {
          return Promise.reject(new Error('kill failed'));
        };
      `;
      const { browser, page } = await launchWithState(
        ringBasePreConfig() + deterministicSpawn + rejectKill
      );
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await openOverlayAndMarkSessionReady(page);

        const stopButton = page.getByTestId('command-bar-terminate-button');
        await stopButton.click();

        const errorToast = page.getByTestId('toast').filter({ hasText: "Couldn't stop the terminal" });
        await expect(errorToast).toBeVisible({ timeout: 5000 });
        await expect(errorToast.getByTestId('toast-title')).toHaveText("Couldn't stop the terminal");
        await expect(errorToast.getByTestId('toast-body')).toHaveText('Its process may still be running.');

        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // setFocused IPC contract - shared browser group.
  // All three tests use preConfigWithOpenCommandBar() and get fresh state via
  // beforeEach page navigation.
  // ---------------------------------------------------------------------------
  test.describe('setFocused IPC contract', () => {
    /**
     * Pre-configure with one running task session and one pre-existing transient
     * session (command bar already open). This avoids the async spawnTransient
     * path and lets us directly observe setFocused calls for the steady state.
     */
    function preConfigWithOpenCommandBar(): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();

          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Test Project',
            path: '/mock/test-project',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });

          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, {
              id: 'lane-focused-' + i,
              position: i,
              created_at: ts,
            }));
          });

          // Regular task session
          state.sessions.push({
            id: '${TASK_SESSION_ID}',
            taskId: '${TASK_ID}',
            projectId: '${PROJECT_ID}',
            pid: 3001,
            status: 'running',
            shell: 'bash',
            cwd: '/mock/test-project',
            startedAt: ts,
            exitCode: null,
            resuming: false,
          });

          // Pre-existing transient session (command bar was already open)
          state.sessions.push({
            id: '${TRANSIENT_SESSION_ID}',
            taskId: '${TRANSIENT_SESSION_ID}',
            projectId: '${PROJECT_ID}',
            pid: 3002,
            status: 'running',
            shell: 'bash',
            cwd: '/mock/test-project',
            startedAt: ts,
            exitCode: null,
            resuming: false,
            transient: true,
          });

          state.activityCache['${TASK_SESSION_ID}'] = 'idle';
          state.activityCache['${TRANSIENT_SESSION_ID}'] = 'idle';

          state.tasks.push({
            id: '${TASK_ID}',
            title: 'Regular Task',
            description: '',
            swimlane_id: 'lane-focused-0',
            position: 0,
            agent: null,
            session_id: '${TASK_SESSION_ID}',
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
    }

    let focusedBrowser: Browser;
    let focusedPage: Page;

    test.beforeAll(async () => {
      ({ browser: focusedBrowser, page: focusedPage } = await launchSharedBrowser(
        preConfigWithOpenCommandBar(),
      ));
    });

    test.afterAll(async () => {
      await focusedBrowser?.close();
    });

    test.beforeEach(async () => {
      await gotoVite(focusedPage, VITE_URL);
      await focusedPage.waitForLoadState('load');
      await focusedPage.waitForSelector('text=Kangentic', { timeout: 15000 });
      await focusedPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    });

    test('transient session enters focused set when command bar opens from Backlog view', async () => {
      // This is the regression test for the bug fixed in this branch.
      // Before the fix: TerminalPanel was unmounted on Backlog, so the
      // setFocused effect never ran for the transient session, and PTY output
      // was silently dropped - the overlay appeared frozen.
      //
      // After the fix: useFocusedSessionsSync lives in AppLayout (always
      // mounted), so it fires setFocused even when the Backlog view is active.
      //
      // Phase 2: setFocused now receives ALL current-project transient session IDs
      // (transientSessionIds: string[]) instead of a single transientSessionId.
      // The assertion uses `callArgs.includes(TRANSIENT_SESSION_ID)` which works
      // for both Phase 1 (single id in array) and Phase 2 (multiple ids).

      // Clear any calls that fired during initial mount so we start fresh.
      await focusedPage.evaluate(() => {
        window.electronAPI.sessions.__setFocusedCalls.length = 0;
      });

      // Switch to Backlog view.
      await focusedPage.locator('[data-testid="view-toggle-backlog"]').click();
      await focusedPage.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

      // Open the command bar overlay (Ctrl+Shift+P).
      await focusedPage.keyboard.press('Control+Shift+P');
      await expect(focusedPage.getByTestId('command-terminal-window')).toBeVisible();

      // Poll until setFocused is called with the transient session ID included.
      // useFocusedSessionsSync fires as a useEffect after each render, so there
      // may be a short async gap between state update and the IPC call.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.some(
            (callArgs) => callArgs.includes(TRANSIENT_SESSION_ID),
          );
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);
    });

    test('panel session leaves focused set when switching to Backlog with no dialog', async () => {
      // Reverse regression: switching from Board to Backlog must remove the panel
      // session from the focused set (no terminal is visible on Backlog without
      // the command bar open). The session manager should stop forwarding PTY
      // data for that session to avoid wasting IPC budget.

      // On Board view the panel session should be in the focused set.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.some(
            (callArgs) => callArgs.includes(TASK_SESSION_ID),
          );
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);

      // Clear the call log.
      await focusedPage.evaluate(() => {
        window.electronAPI.sessions.__setFocusedCalls.length = 0;
      });

      // Switch to Backlog. No command bar, no dialog.
      await focusedPage.locator('[data-testid="view-toggle-backlog"]').click();
      await focusedPage.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

      // setFocused should be called without the panel session ID.
      // Poll until at least one call arrives, then assert the task session
      // was not included in the latest call.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.length > 0;
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);

      const lastCall = await focusedPage.evaluate((): string[] => {
        const allCalls = window.electronAPI.sessions.__setFocusedCalls;
        return allCalls[allCalls.length - 1] ?? [];
      });
      expect(lastCall).not.toContain(TASK_SESSION_ID);
    });

    test('panel session re-enters focused set when switching back to Board view', async () => {
      // Board -> Backlog -> Board round-trip: the panel session must be restored
      // to the focused set when the user returns to the Board view.

      // Switch to Backlog.
      await focusedPage.locator('[data-testid="view-toggle-backlog"]').click();
      await focusedPage.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

      // Clear the log at the midpoint.
      await focusedPage.evaluate(() => {
        window.electronAPI.sessions.__setFocusedCalls.length = 0;
      });

      // Switch back to Board.
      await focusedPage.locator('[data-testid="view-toggle-board"]').click();
      await focusedPage.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 5000 });

      // Panel session must be back in the focused set.
      await expect.poll(
        async () => {
          const allCalls = await focusedPage.evaluate(
            (): string[][] => window.electronAPI.sessions.__setFocusedCalls,
          );
          return allCalls.some(
            (callArgs) => callArgs.includes(TASK_SESSION_ID),
          );
        },
        { timeout: 5000, intervals: [100, 100, 200, 200, 500] },
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Container-only pane resize refit - regression tests for the clipped TUI
  // bottom rows. The Command Terminal's terminal pane is overflow-hidden, so a
  // pane-height change that is NOT a window-engine commit (the footer ContextBar
  // growing as its pills populate or wrap) used to leave the xterm too tall and
  // silently clip its bottom rows - exactly where the fullscreen Claude TUI
  // anchors its input box and the model-switch prompt. The fix is the shared
  // useTerminalRefit hook's persistent ResizeObserver. These tests assert on the
  // instrumented sessions.resize IPC (programmatic state, relative comparisons)
  // rather than pixels, per cross-platform-parity.
  // ---------------------------------------------------------------------------
  test.describe('Container-only pane resize refit', () => {
    const REFIT_PROJECT_ID = 'proj-refit-test';
    const REFIT_SESSION_ID = 'sess-refit-test-1';

    interface RefitInstrumentation {
      __terminalResizeCalls: Array<{ sessionId: string; cols: number; rows: number }>;
      __panelResizeEventCount: number;
    }

    function refitPreConfig(): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${REFIT_PROJECT_ID}',
            name: 'Refit Test Project',
            path: '/mock/refit-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, {
              id: 'lane-refit-' + i,
              position: i,
              created_at: ts,
            }));
          });
          return { currentProjectId: '${REFIT_PROJECT_ID}' };
        });

        // Deterministic spawn so markFirstOutput can target a known session id.
        window.electronAPI.sessions.spawnTransient = async function (input) {
          return {
            session: {
              id: '${REFIT_SESSION_ID}',
              taskId: '${REFIT_SESSION_ID}',
              projectId: input.projectId,
              pid: null,
              status: 'running',
              shell: '/bin/bash',
              cwd: '/mock/refit-test',
              startedAt: new Date().toISOString(),
              exitCode: null,
              resuming: false,
              transient: true,
            },
            branch: 'main',
          };
        };

        // Record every PTY resize forward so the tests can assert refits on
        // programmatic state instead of pixels.
        window.__terminalResizeCalls = [];
        var originalResize = window.electronAPI.sessions.resize;
        window.electronAPI.sessions.resize = async function (sessionId, cols, rows) {
          window.__terminalResizeCalls.push({ sessionId: sessionId, cols: cols, rows: rows });
          return originalResize.call(this, sessionId, cols, rows);
        };

        // Count engine-commit dispatches so the tests can prove a refit came
        // from the ResizeObserver path, not a terminal-panel-resize event.
        window.__panelResizeEventCount = 0;
        window.addEventListener('terminal-panel-resize', function () {
          window.__panelResizeEventCount += 1;
        });
      `;
    }

    /**
     * Open the Command Terminal, mount xterm (markFirstOutput lifts the shimmer,
     * same pattern as the Maximize focus restore group), wait for the initial
     * resize-first replay to record a baseline, then clear the instrumentation
     * so the next recorded call is caused by the test's own container change.
     * Returns the baseline cols/rows.
     */
    async function openTerminalAndSettleBaseline(page: Page): Promise<{ cols: number; rows: number }> {
      await page.keyboard.press('Control+Shift+P');
      await expect(page.getByTestId('command-terminal-window')).toBeVisible();

      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            session?: { getState: () => { markFirstOutput: (id: string) => void } };
          };
        }).__zustandStores;
        stores?.session?.getState().markFirstOutput(sessionId);
      }, REFIT_SESSION_ID);

      await expect(
        page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first(),
      ).toBeAttached({ timeout: 8000 });

      // initTerminal's resize-first replay always records at least one call.
      await expect.poll(
        () => page.evaluate(
          () => (window as unknown as RefitInstrumentation).__terminalResizeCalls.length,
        ),
        { timeout: 8000, intervals: [100, 100, 200, 200, 500] },
      ).toBeGreaterThan(0);

      const baseline = await page.evaluate(() => {
        const calls = (window as unknown as RefitInstrumentation).__terminalResizeCalls;
        const lastCall = calls[calls.length - 1];
        return { cols: lastCall.cols, rows: lastCall.rows };
      });

      await page.evaluate(() => {
        const instrumentation = window as unknown as RefitInstrumentation;
        instrumentation.__terminalResizeCalls.length = 0;
        instrumentation.__panelResizeEventCount = 0;
      });

      return baseline;
    }

    /** Rows (or cols) of the most recent recorded resize call, or a sentinel
     *  larger than any real terminal dimension while none has arrived yet. */
    function lastResizeDimension(page: Page, dimension: 'cols' | 'rows'): Promise<number> {
      return page.evaluate((dimensionKey) => {
        const calls = (window as unknown as {
          __terminalResizeCalls: Array<{ cols: number; rows: number }>;
        }).__terminalResizeCalls;
        const lastCall = calls[calls.length - 1];
        return lastCall ? lastCall[dimensionKey] : Number.MAX_SAFE_INTEGER;
      }, dimension);
    }

    test('footer ContextBar growth refits the terminal via the ResizeObserver path', async () => {
      const { browser, page } = await launchWithState(refitPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const baseline = await openTerminalAndSettleBaseline(page);

        // Container-only change: grow the footer ContextBar (as when its pills
        // populate or wrap to a second row), shrinking the flex-1 terminal pane
        // while the window frame's own rect stays identical - so no
        // terminal-panel-resize event can fire; only the persistent
        // ResizeObserver can catch it.
        await page.evaluate(() => {
          const contextBar = document.querySelector<HTMLElement>(
            '[data-testid="command-terminal-window"] [data-testid="usage-bar"]',
          );
          if (!contextBar) throw new Error('ContextBar (usage-bar) not found in the command terminal window');
          contextBar.style.minHeight = '160px';
        });

        // Observer debounce (200ms) + PTY forward debounce (200ms), so poll for
        // the resulting resize call. Strictly-fewer-rows, never an exact value.
        await expect.poll(
          () => lastResizeDimension(page, 'rows'),
          { timeout: 8000, intervals: [100, 200, 200, 500, 500] },
        ).toBeLessThan(baseline.rows);

        // Prove the refit came from the ResizeObserver path: no engine commit
        // dispatched a terminal-panel-resize during the container-only change.
        const panelResizeEvents = await page.evaluate(
          () => (window as unknown as RefitInstrumentation).__panelResizeEventCount,
        );
        expect(panelResizeEvents).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('Changes panel toggle refits via the observer (pane width change)', async () => {
      // Covers the responsibility of the deleted bespoke changesOpen effect: the
      // pane flips flex-1 -> w-1/2, and the shared observer must catch the
      // width change (no terminal-panel-resize fires for it either).
      const { browser, page } = await launchWithState(refitPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        const baseline = await openTerminalAndSettleBaseline(page);

        // Toggle via the kebab menu (always reachable, unlike the header pill
        // which can fold at narrow widths).
        await page.getByTestId('command-terminal-window').getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByText('Show changes', { exact: true }).click();

        await expect.poll(
          () => lastResizeDimension(page, 'cols'),
          { timeout: 8000, intervals: [100, 200, 200, 500, 500] },
        ).toBeLessThan(baseline.cols);

        const panelResizeEvents = await page.evaluate(
          () => (window as unknown as RefitInstrumentation).__panelResizeEventCount,
        );
        expect(panelResizeEvents).toBe(0);
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Branch switch (regression lock): CommandTerminalWindow used to swap
  // sessionId in place on a live useTerminal instance, leaving onData/onResize
  // permanently bound to the killed session (initTerminal's
  // `if (xtermRef.current) return` guard). CommandTerminalPane now mounts
  // keyed-and-gated by session id, so a branch switch remounts the xterm host
  // instead. See CommandTerminalPane.tsx.
  // ---------------------------------------------------------------------------
  test.describe('Branch switch', () => {
    const BRANCH_SWITCH_PROJECT_ID = 'proj-branch-switch';

    /** One project; a counter-based deterministic spawnTransient that records
     *  every input (for the cols/rows assertion) and never auto-fires first
     *  output - the test drives that explicitly via markFirstOutput, mirroring
     *  openCommandBarWithMountedTerminal above, for both the initial spawn and
     *  the branch respawn. */
    function branchSwitchPreConfig(): string {
      return `
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${BRANCH_SWITCH_PROJECT_ID}',
            name: 'Branch Switch Project',
            path: '/mock/branch-switch-project',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (s, i) {
            state.swimlanes.push(Object.assign({}, s, {
              id: 'lane-branch-switch-' + i,
              position: i,
              created_at: ts,
            }));
          });
          return { currentProjectId: '${BRANCH_SWITCH_PROJECT_ID}' };
        });

        var branchSwitchSpawnCounter = 0;
        window.__branchSwitchSpawnCalls = [];
        window.electronAPI.sessions.spawnTransient = async function (input) {
          branchSwitchSpawnCounter += 1;
          var id = 'branch-switch-session-' + branchSwitchSpawnCounter;
          window.__branchSwitchSpawnCalls.push(input);
          var session = {
            id: id,
            taskId: id,
            projectId: input.projectId,
            pid: null,
            status: 'running',
            shell: '/bin/bash',
            cwd: '/mock/branch-switch-project',
            startedAt: new Date().toISOString(),
            exitCode: null,
            resuming: false,
            transient: true,
            isolatedSwimlaneId: null,
            agentSessionId: null,
          };
          return { session: session, branch: input.branch || 'main' };
        };
      `;
    }

    /** Flip sessionFirstOutput for `sessionId` so CommandTerminalPane mounts
     *  (see CommandTerminalWindow's terminalReady gate). Mirrors
     *  openCommandBarWithMountedTerminal's injection above. */
    async function markFirstOutput(page: Page, sessionId: string): Promise<void> {
      await page.evaluate((id) => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { getState: () => { markFirstOutput: (id: string) => void } } };
        }).__zustandStores;
        stores?.session?.getState().markFirstOutput(id);
      }, sessionId);
    }

    /** Every input passed to the mock's spawnTransient so far. */
    async function branchSwitchSpawnCalls(page: Page): Promise<Array<{ branch?: string; cols?: number; rows?: number }>> {
      return page.evaluate(() => (window as unknown as { __branchSwitchSpawnCalls: Array<{ branch?: string; cols?: number; rows?: number }> }).__branchSwitchSpawnCalls);
    }

    /** The most recent sessions.resize(sessionId, cols, rows) call recorded by
     *  the mock for `sessionId`, or undefined if none yet. initTerminal calls
     *  sessions.resize synchronously (before any await) right after fitting the
     *  xterm host to its container, so the last entry for a mounted pane's
     *  session id is that pane's live grid. */
    async function lastResizeCallFor(
      page: Page,
      sessionId: string,
    ): Promise<{ sessionId: string; cols: number; rows: number } | undefined> {
      return page.evaluate((id) => {
        const calls = (window as unknown as {
          electronAPI: { sessions: { __resizeCalls: Array<{ sessionId: string; cols: number; rows: number }> } };
        }).electronAPI.sessions.__resizeCalls;
        return calls.filter((call) => call.sessionId === id).at(-1);
      }, sessionId);
    }

    test('typing after a branch switch reaches the NEW session, not the killed one', async () => {
      const { browser, page } = await launchWithState(branchSwitchPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();
        await markFirstOutput(page, 'branch-switch-session-1');

        const pane = page.getByTestId('command-bar-terminal-pane');
        await expect(pane).toBeAttached({ timeout: 8000 });
        await expect(pane).toHaveAttribute('data-session-id', 'branch-switch-session-1');

        // Switch branch via the header chip.
        await page.getByTestId('branch-picker-chip').click();
        const developButton = page.locator('button:has-text("develop")');
        await developButton.waitFor({ state: 'visible' });
        await developButton.click();

        // The store's transientSessions entry must carry the NEW session id
        // before the pane can be expected to have remounted.
        await expect.poll(async () => {
          const entries = await transientEntriesFor(page, BRANCH_SWITCH_PROJECT_ID);
          return entries[0]?.sessionId;
        }, { timeout: 8000, intervals: [50, 100, 200, 500] }).toBe('branch-switch-session-2');

        await markFirstOutput(page, 'branch-switch-session-2');

        // The pane remounted (React key changed): data-session-id updates, and
        // there is still exactly one xterm instance (the old one was disposed,
        // not left running alongside a second one).
        await expect(pane).toHaveAttribute('data-session-id', 'branch-switch-session-2', { timeout: 8000 });
        await expect(page.getByTestId('command-terminal-window').locator('.xterm')).toHaveCount(1);

        // Type into the terminal and assert the write landed on the NEW
        // session id, not the killed one - the positive assertion the vacuous
        // "no write to the old id" check would miss if the pane never mounted.
        // .focus() (not a click) is deterministic - xterm's own focus() call
        // happens inside initTerminal's requestAnimationFrame.
        const textarea = pane.locator('.xterm-helper-textarea').first();
        await expect(textarea).toBeAttached({ timeout: 8000 });
        await page.evaluate(() => { window.electronAPI.sessions.__writeCalls.length = 0; });
        await textarea.focus();
        await page.keyboard.type('echo hi');

        await expect.poll(async () => {
          const calls = await page.evaluate(
            () => (window as unknown as { electronAPI: { sessions: { __writeCalls: Array<{ sessionId: string; payload: string }> } } })
              .electronAPI.sessions.__writeCalls,
          );
          const last = calls[calls.length - 1];
          return last?.sessionId;
        }, { timeout: 8000, intervals: [50, 100, 200, 500] }).toBe('branch-switch-session-2');
      } finally {
        await browser.close();
      }
    });

    test('a branch switch keeps its window when main\'s removal push for the old terminal arrives mid-kill', async () => {
      // Main ends the old terminal (endCommandTerminal) and announces the
      // removal before the kill IPC returns. The window let go of its entry
      // before the kill, so the removal subscriber does not read that push as
      // an end main started and close the window the respawn is about to fill.
      //
      // Red-green: scrubbing the entry AFTER the kill IPC (the old order)
      // closes the window here and the count drops to 0.
      const { browser, page } = await launchWithState(branchSwitchPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();
        await markFirstOutput(page, 'branch-switch-session-1');
        await expect(page.getByTestId('command-bar-terminal-pane')).toBeAttached({ timeout: 8000 });

        await page.evaluate((projectId) => {
          const win = window as unknown as {
            __mockFireRemoved: (id: string, session: unknown, projectId: string) => void;
            electronAPI: { sessions: { killTransient: (sessionId: string) => Promise<void> } };
          };
          win.electronAPI.sessions.killTransient = async (sessionId: string) => {
            win.__mockFireRemoved(sessionId, { id: sessionId, projectId, transient: true, commandTerminalSlot: 'slot-1' }, projectId);
          };
        }, BRANCH_SWITCH_PROJECT_ID);

        await page.getByTestId('branch-picker-chip').click();
        const developButton = page.locator('button:has-text("develop")');
        await developButton.waitFor({ state: 'visible' });
        await developButton.click();

        await expect.poll(async () => {
          const entries = await transientEntriesFor(page, BRANCH_SWITCH_PROJECT_ID);
          return entries[0]?.sessionId;
        }, { timeout: 8000, intervals: [50, 100, 200, 500] }).toBe('branch-switch-session-2');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1);
      } finally {
        await browser.close();
      }
    });

    test('branch respawn seeds the new PTY with the pre-switch grid', async () => {
      const { browser, page } = await launchWithState(branchSwitchPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();
        await markFirstOutput(page, 'branch-switch-session-1');
        await expect(page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first())
          .toBeAttached({ timeout: 8000 });

        await page.getByTestId('branch-picker-chip').click();
        const developButton = page.locator('button:has-text("develop")');
        await developButton.waitFor({ state: 'visible' });

        // Snapshot the pre-switch pane's live grid via the resize call its
        // mount-time fit() already sent, immediately before triggering the
        // switch. This is the SAME grid handleBranchChange reads via
        // gridGetterRef right before the kill, so equating the two proves the
        // respawn was seeded from the pane's ACTUAL live grid - not merely
        // "some positive number" (a regression hardcoding {cols: 80, rows: 24}
        // in handleBranchChange would pass the old >0 assertions unchanged,
        // but fails this equality unless it coincidentally matched).
        await expect.poll(
          async () => (await lastResizeCallFor(page, 'branch-switch-session-1')) !== undefined,
          { timeout: 8000, intervals: [50, 100, 200, 500] },
        ).toBe(true);
        const preSwitchGrid = await lastResizeCallFor(page, 'branch-switch-session-1');

        await developButton.click();

        await expect.poll(async () => (await branchSwitchSpawnCalls(page)).length, { timeout: 8000 }).toBe(2);

        const calls = await branchSwitchSpawnCalls(page);
        const respawnCall = calls[1];
        expect(respawnCall.branch).toBe('develop');
        // Grid was read from the still-mounted pane before the kill (see
        // handleBranchChange), so it must equal the pre-switch pane's actual
        // live grid, not merely be some positive number.
        expect(preSwitchGrid).toBeDefined();
        expect(respawnCall.cols).toBe(preSwitchGrid!.cols);
        expect(respawnCall.rows).toBe(preSwitchGrid!.rows);
      } finally {
        await browser.close();
      }
    });

    test('a branch switch never fires the dev-only session-swap-without-remount tripwire', async () => {
      // useTerminal's dev-only tripwire (isSessionSwapWithoutRemount,
      // useTerminal.ts) console.errors if a host's sessionId changes to a
      // different LIVE session without remounting. UI specs run against the
      // real Vite dev server, so import.meta.env.DEV is true here - the
      // tripwire is live in this test the same way it is in `npm start`
      // dogfooding. This is the wiring the pure-predicate unit test
      // (terminal-session-swap-contract.test.ts) cannot reach: it exercises
      // real refs across real re-renders, not a copy of the effect's logic.
      const { browser, page } = await launchWithState(branchSwitchPreConfig());
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();
        await markFirstOutput(page, 'branch-switch-session-1');
        await expect(page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first())
          .toBeAttached({ timeout: 8000 });

        await page.getByTestId('branch-picker-chip').click();
        const developButton = page.locator('button:has-text("develop")');
        await developButton.waitFor({ state: 'visible' });
        await developButton.click();

        await expect.poll(async () => {
          const entries = await transientEntriesFor(page, BRANCH_SWITCH_PROJECT_ID);
          return entries[0]?.sessionId;
        }, { timeout: 8000, intervals: [50, 100, 200, 500] }).toBe('branch-switch-session-2');

        await markFirstOutput(page, 'branch-switch-session-2');
        await expect(page.getByTestId('command-terminal-window').locator('.xterm-helper-textarea').first())
          .toBeAttached({ timeout: 8000 });

        // Negative assertion, so a fixed budget rather than a poll: give the
        // tripwire's effect (and any deferred console output) time to have
        // fired by now if it was going to.
        await page.waitForTimeout(500);

        const tripwireErrors = consoleErrors.filter((text) => text.includes('[useTerminal] sessionId changed'));
        expect(tripwireErrors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test('the pill keeps the pre-switch branch while the respawn is pending, not the project default', async () => {
      // CommandTerminalWindow reads the branch from the transientSessions map
      // entry, never a local copy - EXCEPT for one gap: killTransientSessionBySlot
      // deletes the map entry synchronously (before handleBranchChange's second
      // await even starts), and the entry does not reappear until the respawn's
      // IPC round trip resolves. Without `lastKnownBranchRef`, the pill would fall
      // through to BranchPicker's `defaultBranch` fallback for that whole window.
      //
      // The project's configured default ('trunk') is deliberately different from
      // the pre-switch branch ('main'): a broken implementation (no ref, falls to
      // defaultBranch) and the fixed one (holds 'main') then assert to different
      // strings instead of coincidentally agreeing.
      const preConfigWithHeldRespawn = branchSwitchPreConfig() + `
        window.__mockPreConfigure(function (state) {
          state.config.git.defaultBaseBranch = 'trunk';
        });

        // Wrap the counter-based spawnTransient from branchSwitchPreConfig: the
        // FIRST call (cold spawn) passes straight through; the SECOND call (the
        // branch-switch respawn) is held open until the test explicitly releases
        // it via window.__resolveHeldRespawn(), so the gap between the kill's
        // scrub and the respawn's write is observable instead of a same-tick
        // flicker.
        var __originalSpawnTransient = window.electronAPI.sessions.spawnTransient;
        var __spawnAttempts = 0;
        window.__respawnPending = false;
        window.electronAPI.sessions.spawnTransient = function (input) {
          __spawnAttempts += 1;
          if (__spawnAttempts === 1) return __originalSpawnTransient(input);
          window.__respawnPending = true;
          return new Promise(function (resolve) {
            window.__resolveHeldRespawn = function () {
              __originalSpawnTransient(input).then(function (result) {
                window.__respawnPending = false;
                resolve(result);
              });
            };
          });
        };
      `;

      const { browser, page } = await launchWithState(preConfigWithHeldRespawn);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toBeVisible();

        const chip = page.getByTestId('branch-picker-chip');
        await expect(chip).toContainText('main', { timeout: 8000 });

        await chip.click();
        const developButton = page.locator('button:has-text("develop")');
        await developButton.waitFor({ state: 'visible' });
        await developButton.click();

        // The respawn attempt has been made and is now held pending. Because
        // handleBranchChange awaits the kill before ever calling
        // spawnTransientSession, reaching this point proves the kill's
        // synchronous map-entry scrub has already run.
        await expect.poll(
          async () => page.evaluate(() => (window as unknown as { __respawnPending?: boolean }).__respawnPending === true),
          { timeout: 8000 },
        ).toBe(true);

        // The map entry is genuinely gone during the gap - this is not a
        // same-tick flicker a poll could race past.
        const entriesDuringGap = await transientEntriesFor(page, BRANCH_SWITCH_PROJECT_ID);
        expect(entriesDuringGap).toEqual([]);

        // The pill still names the branch the terminal was actually on, not the
        // project's configured default and not empty.
        await expect(chip).toContainText('main');
        await expect(chip).not.toContainText('trunk');

        // Release the held respawn: the new entry lands and the pill follows it.
        await page.evaluate(() => (window as unknown as { __resolveHeldRespawn: () => void }).__resolveHeldRespawn());

        await expect.poll(async () => {
          const entries = await transientEntriesFor(page, BRANCH_SWITCH_PROJECT_ID);
          return entries[0]?.branch;
        }, { timeout: 8000 }).toBe('develop');
        await expect(chip).toContainText('develop', { timeout: 8000 });
      } finally {
        await browser.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Refused spawns. Main refuses a start with a sentence written for the user
  // (a shell that did not start, a slot already in use), and the window toasts
  // it. Electron decorates a rejected invoke before the renderer sees it, so the
  // raw Error message carries the channel name and the error class in front of
  // that sentence. The UI mock does not decorate, so each test builds the
  // decorated message itself: a plain mock rejection would pass against code
  // that never strips anything.
  // ---------------------------------------------------------------------------
  test.describe('Refused spawn toasts', () => {
    const SHELL_REFUSAL_SENTENCE = 'The terminal\'s shell "pwsh" did not start; check it in Settings > Terminal.';
    const SLOT_REFUSAL_SENTENCE = 'Command Terminal slot-1 is already in use.';

    test('a refused cold start toasts main\'s sentence without the IPC decoration and closes the window', async () => {
      // The cold-start effect's catch: it toasts the rejection and drops just
      // this window. The exact-text assertion is the point: the decorated
      // message still contains the sentence, so a contains-match cannot tell
      // the stripped toast from the raw one.
      const refuseEveryStart = `
        window.electronAPI.sessions.spawnTransient = function () {
          return Promise.reject(new Error(${JSON.stringify(decoratedInvokeMessage('CommandTerminalStartError', SHELL_REFUSAL_SENTENCE))}));
        };
      `;
      const { browser, page } = await launchWithState(multiTerminalPreConfig() + refuseEveryStart);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');

        // The filter only finds the toast; the exact match on the body is the assertion.
        const refusalToast = page.getByTestId('toast').filter({ hasText: 'did not start' });
        await expect(refusalToast.getByTestId('toast-body')).toHaveText(SHELL_REFUSAL_SENTENCE, { timeout: 3000 });
        await expect(refusalToast.getByTestId('toast-title')).toHaveText("Couldn't start Command Terminal");

        // The toast proves the window's mount effect ran and its catch fired, so
        // a count of 0 here means the window closed rather than never opened.
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(0, { timeout: 5000 });
      } finally {
        await browser.close();
      }
    });

    test('a refused branch-switch respawn toasts main\'s sentence without the IPC decoration', async () => {
      // handleBranchChange's catch. The cold start succeeds (first spawn call
      // passes through to the counter-based mock), then the respawn the branch
      // switch asks for is refused.
      const refuseSecondStart = `
        (function () {
          var spawnBeforeRefusal = window.electronAPI.sessions.spawnTransient;
          var spawnAttempts = 0;
          window.electronAPI.sessions.spawnTransient = function (input) {
            spawnAttempts += 1;
            if (spawnAttempts === 1) return spawnBeforeRefusal(input);
            return Promise.reject(new Error(${JSON.stringify(decoratedInvokeMessage('CommandTerminalStartError', SLOT_REFUSAL_SENTENCE))}));
          };
        })();
      `;
      const { browser, page } = await launchWithState(multiTerminalPreConfig() + refuseSecondStart);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

        await page.keyboard.press('Control+Shift+P');
        await expect(page.getByTestId('command-terminal-window')).toHaveCount(1, { timeout: 5000 });

        // The cold spawn has resolved and paired its slot. Switching before this
        // would find no entry to kill and exercise a different path.
        await expect.poll(
          async () => (await transientEntriesFor(page, MULTI_PROJECT_ID)).length,
          { timeout: 8000, intervals: [50, 100, 200, 500] },
        ).toBe(1);

        // Switch branch the way a user does, through the header chip.
        await page.getByTestId('branch-picker-chip').click();
        const developButton = page.locator('button:has-text("develop")');
        await developButton.waitFor({ state: 'visible' });
        await developButton.click();

        const refusalToast = page.getByTestId('toast').filter({ hasText: 'is already in use' });
        await expect(refusalToast.getByTestId('toast-body')).toHaveText(SLOT_REFUSAL_SENTENCE, { timeout: 3000 });
        await expect(refusalToast.getByTestId('toast-title')).toHaveText("Couldn't switch branch");
      } finally {
        await browser.close();
      }
    });
  });
});
