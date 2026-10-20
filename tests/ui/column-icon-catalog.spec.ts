/**
 * Column icons outside the core set, now that lucide's whole icon map loads lazily.
 *
 * `src/renderer/utils/icon-registry.ts` resolves the icons a stock board names (the default
 * columns, Zap, the shortcut presets) from named imports, and loads the full map
 * (`icon-catalog.ts`) only when the icon picker opens, when the Icon button is hovered or focused,
 * or when a name outside that set has to paint. Several behaviors ride on the load being async:
 *
 * 1. The picker still lists every glyph, and a picked one renders in the Icon field. It says it is
 *    loading while the map is on its way and says it failed when the load does.
 * 2. A project switch onto a board whose column names a non-core icon paints that icon on its
 *    first frame (`.claude/rules/restore-no-animation-replay.md`). `loadBoard` awaits the map
 *    before it publishes the columns; without that await the column paints its dot and the icon
 *    pops in a beat later. A MutationObserver records every state the column header passes
 *    through, because the settled state is correct either way. `loadShortcuts` does the same for a
 *    shortcut pill's glyph.
 * 3. That wait widens the window in which the user switches away again. A load that a switch
 *    overtook must not publish its columns under the project that took over.
 * 4. A surface that meets a non-core name outside any load (a store write, as an agent's column
 *    edit makes) starts the map's load itself and repaints when it lands.
 * 5. The Board Manager's overview shows a dot, not the role default, for a custom icon that does
 *    not resolve, so a bad name stands out there.
 *
 * Where a test needs the map to be "on its way", it holds the request with `page.route`, which
 * makes the in-between state stable instead of a race. Where it needs to know the map has landed,
 * it asks the page's own registry module (`getLoadedIconCatalog`) rather than waiting a while.
 *
 * Tier: UI (headless Chromium). Each test owns its own browser.
 */
import { test, expect, chromium, type Browser, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors, gotoVite, settleFrames } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A = 'proj-icons-a';
const PROJECT_B = 'proj-icons-b';
/** A real lucide glyph outside the core set, on a column only project B has. */
const NON_CORE_ICON = 'rocket';
const B_COLUMN = 'Verify';
/** A name no icon set has: the MCP column tools take any string, so a board can persist one. */
const UNKNOWN_ICON = 'not-a-real-icon-xyz';

/** The shortcut and the card that shows it, on project B (whose board is all core icons there). */
const SHORTCUT_LABEL = 'Launch Pad';
const SHORTCUT_PILL_TESTID = 'shortcut-pill-launch-pad';
const SHORTCUT_TASK_ID = 'task-icons-shortcut';
const SHORTCUT_SESSION_ID = 'sess-icons-shortcut';
const SHORTCUT_TASK_TITLE = 'Plan the launch';
const SHORTCUT_TASK_LANE = 'Code Review';

interface LaneOverride {
  projectId: string;
  /** The stock column's name, before any patch renames it. */
  laneName: string;
  patch: Record<string, unknown>;
}

/**
 * Two projects with the stock seven columns each, and a patch per lane where a test needs one.
 * A's columns are stock, so opening it never loads the full map.
 */
function buildPreConfig(laneOverrides: LaneOverride[], extraScript = ''): string {
  return `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    var overrides = ${JSON.stringify(laneOverrides)};
    [['${PROJECT_A}', 'Icons A'], ['${PROJECT_B}', 'Icons B']].forEach(function (entry) {
      state.projects.push({ id: entry[0], name: entry[1], path: '/mock/projects/' + entry[0], github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts });
    });
    [${JSON.stringify(PROJECT_A)}, ${JSON.stringify(PROJECT_B)}].forEach(function (projectId) {
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        var seeded = Object.assign({}, lane, { id: projectId + '-lane-' + index, position: index, created_at: ts, projectId: projectId });
        overrides.forEach(function (override) {
          if (override.projectId === projectId && override.laneName === lane.name) Object.assign(seeded, override.patch);
        });
        state.swimlanes.push(seeded);
      });
    });
    return { currentProjectId: '${PROJECT_A}' };
  });
  ${extraScript}
`;
}

/** B's Testing column is renamed and carries a non-core icon. */
const preConfig = buildPreConfig([
  { projectId: PROJECT_B, laneName: 'Testing', patch: { name: B_COLUMN, icon: NON_CORE_ICON } },
]);

/**
 * Both projects stock. B owns one card, and a shortcut with a non-core icon that only B returns, so
 * a switch onto B is the first thing that needs the map and it needs it only for the pill.
 */
const shortcutPreConfig = buildPreConfig([], `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    var reviewLane = state.swimlanes.find(function (lane) { return lane.projectId === '${PROJECT_B}' && lane.name === '${SHORTCUT_TASK_LANE}'; });
    // A running session, so the card opens the task window with its header pills (a card with no
    // session opens the edit form, which has none).
    state.sessions.push({
      id: '${SHORTCUT_SESSION_ID}', taskId: '${SHORTCUT_TASK_ID}', projectId: '${PROJECT_B}', pid: 9999, status: 'running',
      shell: 'bash', cwd: '/mock/projects/${PROJECT_B}', startedAt: ts, exitCode: null,
    });
    state.tasks.push({
      id: '${SHORTCUT_TASK_ID}', projectId: '${PROJECT_B}', display_id: 1, title: '${SHORTCUT_TASK_TITLE}', description: '',
      swimlane_id: reviewLane.id, position: 0, agent: 'claude', session_id: '${SHORTCUT_SESSION_ID}',
      worktree_path: '/mock/worktrees/icons-shortcut', branch_name: 'feature/icons-shortcut',
      pr_number: null, pr_url: null, base_branch: 'main', archived_at: null, created_at: ts, updated_at: ts,
    });
  });
  window.electronAPI.boardConfig.getShortcuts = async function () {
    var current = await window.electronAPI.projects.getCurrent();
    if (!current || current.id !== '${PROJECT_B}') return [];
    return [{ id: 'shortcut-launch', label: '${SHORTCUT_LABEL}', icon: '${NON_CORE_ICON}', command: 'echo launch', display: 'header' }];
  };
`);

/**
 * A's To Do column (a role column) names an icon nothing resolves. Its Done column names none,
 * so it draws its role default, which is what the overview must still do.
 */
const unknownIconPreConfig = buildPreConfig([
  { projectId: PROJECT_A, laneName: 'To Do', patch: { icon: UNKNOWN_ICON } },
  { projectId: PROJECT_A, laneName: 'Done', patch: { icon: null } },
]);

interface StoreLane {
  id: string;
  name: string;
  icon: string | null;
}

interface PageStores {
  project: { getState: () => { openProject: (id: string) => Promise<string> } };
  board: {
    getState: () => { swimlanes: StoreLane[]; shortcuts: unknown[] };
    setState: (update: (state: { swimlanes: StoreLane[] }) => { swimlanes: StoreLane[] }) => void;
  };
}

interface SeededPage {
  browser: Browser;
  page: Page;
  getPageErrors: () => string[];
  catalogRequested: () => boolean;
  /** True once the PAGE's registry holds the full map (not merely once its request finished). */
  catalogLoaded: () => Promise<boolean>;
}

async function launchSeededPage(preConfigScript: string = preConfig): Promise<SeededPage> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const getPageErrors = collectPageErrors(page);
  // A request listener rather than resource timing: the dev server serves hundreds of modules,
  // past the 250 entries the resource timing buffer keeps.
  let requested = false;
  let registryUrl: string | null = null;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.includes('/icon-catalog')) requested = true;
    if (registryUrl === null && pathname.endsWith('/icon-registry.ts')) registryUrl = request.url();
  });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.locator('[data-swimlane-name="Testing"]').waitFor({ state: 'visible', timeout: 15000 });
  return {
    browser,
    page,
    getPageErrors,
    catalogRequested: () => requested,
    // Imports the registry by the exact URL the app loaded it from, so the page hands back the
    // same module instance. A different instance would read null forever, which fails the poll
    // that waits on this instead of passing it.
    catalogLoaded: async () => {
      if (registryUrl === null) throw new Error('the page never requested icon-registry');
      const loaded = await page.evaluate(
        `import(${JSON.stringify(registryUrl)}).then(function (registry) { return registry.getLoadedIconCatalog() !== null; })`,
      );
      return loaded === true;
    },
  };
}

/** Whether a request is for the full icon map (a path under Vite's dev server, a chunk in a build). */
function isCatalogUrl(url: URL): boolean {
  return url.pathname.includes('/icon-catalog');
}

interface CatalogHold {
  /** How many icon map requests the route is holding right now. */
  heldCount: () => number;
  /** Lets every held request through to the dev server. */
  release: () => Promise<void>;
  /** Fails every held request, as a dropped network would. */
  abort: () => Promise<void>;
}

/** Holds every request for the full icon map, neither answered nor failed, until told otherwise. */
async function holdCatalog(page: Page): Promise<CatalogHold> {
  const held: Route[] = [];
  const handler = (route: Route): void => {
    held.push(route);
  };
  await page.route(isCatalogUrl, handler);
  return {
    heldCount: () => held.length,
    release: async () => {
      for (const route of held.splice(0, held.length)) await route.continue();
    },
    abort: async () => {
      for (const route of held.splice(0, held.length)) await route.abort();
    },
  };
}

async function openProjectInStore(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (targetProjectId) => {
    const stores = (window as unknown as { __zustandStores?: PageStores }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    await stores.project.getState().openProject(targetProjectId);
  }, projectId);
}

async function readLaneNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as { __zustandStores?: PageStores }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    return stores.board.getState().swimlanes.map((lane) => lane.name);
  });
}

/** Open the Board Manager on a column by clicking its board header. */
async function openBoardManager(page: Page, columnName: string): Promise<void> {
  await page.locator(`[data-swimlane-name="${columnName}"]`).locator(`text=${columnName}`).click();
  await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 5000 });
}

test.describe('column icons outside the core set', () => {
  let browser: Browser;
  let page: Page;
  let getPageErrors: () => string[];
  let catalogRequested: () => boolean;
  let catalogLoaded: () => Promise<boolean>;

  test.beforeEach(async () => {
    ({ browser, page, getPageErrors, catalogRequested, catalogLoaded } = await launchSeededPage());
  });

  test.afterEach(async () => {
    await browser?.close();
  });

  test('a stock board never loads the full map, and the icon picker does', async () => {
    expect(catalogRequested()).toBe(false);

    await openBoardManager(page, 'Testing');
    await page.locator('[data-testid="board-manager-icon"]').click();
    const rocket = page.getByRole('button', { name: 'Rocket', exact: true });
    await expect(rocket).toBeVisible({ timeout: 5000 });
    expect(catalogRequested()).toBe(true);

    await rocket.click();
    await expect(page.locator('[data-testid="board-manager-icon"] svg.lucide-rocket')).toBeVisible();

    // Reopened with the map in hand, the picker paints its grid with the dialog: its loading line
    // never shows, not even for the frame an effect would take to fill the grid.
    await expect(rocket).toBeHidden();
    await page.evaluate(() => {
      const record = window as unknown as { __pickerLoadingSeen: boolean };
      record.__pickerLoadingSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="icon-picker-loading"]')) record.__pickerLoadingSeen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.locator('[data-testid="board-manager-icon"]').click();
    await expect(rocket).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pickerLoadingSeen: boolean }).__pickerLoadingSeen)).toBe(false);
    expect(getPageErrors()).toEqual([]);
  });

  test('a project switch paints a non-core column icon on its first frame', async () => {
    // Project A names only core icons, so the map is not loaded yet; a loaded map would make the
    // switch below pass whatever loadBoard does.
    expect(catalogRequested()).toBe(false);

    // Record every state the B column's header passes through, from the moment it mounts.
    await page.evaluate((columnName) => {
      const record = window as unknown as { __iconStates: string[] };
      record.__iconStates = [];
      const sample = () => {
        const column = document.querySelector(`[data-swimlane-name="${columnName}"]`);
        if (!column) return;
        record.__iconStates.push(column.querySelector('svg.lucide-rocket') ? 'icon' : 'fallback');
      };
      new MutationObserver(sample).observe(document.body, { childList: true, subtree: true, attributes: true });
    }, B_COLUMN);

    await openProjectInStore(page, PROJECT_B);

    const column = page.locator(`[data-swimlane-name="${B_COLUMN}"]`);
    await expect(column.locator('svg.lucide-rocket')).toBeVisible({ timeout: 5000 });
    const states = await page.evaluate(() => (window as unknown as { __iconStates: string[] }).__iconStates);
    expect(states.length, 'the observer saw the column mount').toBeGreaterThan(0);
    expect(states.filter((state) => state === 'fallback'), 'the column painted its fallback before its icon').toEqual([]);
    expect(getPageErrors()).toEqual([]);
  });

  test('a board load that a project switch overtook does not publish under the project that took over', async () => {
    expect(catalogRequested()).toBe(false);
    const hold = await holdCatalog(page);

    // B's columns name a rocket, so its loadBoard parks on the held map after it has fetched B's
    // lanes. openProject does not wait for the board (the load starts in the switch effect), so
    // this resolves while B's load is still parked. The held request is the proof the load
    // reached its wait: switching back before it did would leave nothing to overtake.
    await openProjectInStore(page, PROJECT_B);
    await expect.poll(() => hold.heldCount(), { timeout: 5000 }).toBeGreaterThan(0);

    // Back to A before the map lands. A is the project the user is now looking at.
    await openProjectInStore(page, PROJECT_A);
    await expect(page.locator('[data-swimlane-name="Testing"]')).toBeVisible();

    // Let the map land, then B's parked load resumes. Waiting on the page's own registry (not on
    // a clock) is what proves the window B could have published in has opened and gone.
    await hold.release();
    await expect.poll(catalogLoaded, { timeout: 10000 }).toBe(true);
    await settleFrames(page, 3);

    // Right-now reads: a retrying toHaveCount(0) would pass before a stale publish landed.
    const laneNames = await readLaneNames(page);
    expect(laneNames, 'B\'s columns reached the store under A').not.toContain(B_COLUMN);
    expect(laneNames).toContain('Testing');
    expect(await page.locator(`[data-swimlane-name="${B_COLUMN}"]`).count(), 'B\'s column is on the board under A').toBe(0);
    await expect(page.locator('[data-swimlane-name="Testing"]')).toBeVisible();

    // And B was never cached as loaded: its load never landed, so the switch away from it took a
    // snapshot of A's board. Were B marked seen anyway, going back would paint that snapshot (A's
    // columns under B) instead of loading B.
    await openProjectInStore(page, PROJECT_B);
    await expect(page.locator(`[data-swimlane-name="${B_COLUMN}"]`)).toBeVisible({ timeout: 5000 });
    expect(await readLaneNames(page)).toContain(B_COLUMN);
    expect(getPageErrors()).toEqual([]);
  });

  test('a column whose icon changes outside any load starts the map itself and repaints when it lands', async () => {
    expect(catalogRequested()).toBe(false);
    const hold = await holdCatalog(page);
    const column = page.locator('[data-swimlane-name="Testing"]');
    await expect(column.locator('svg.lucide-flask-conical')).toBeVisible();

    // A store write, not a board load: the way an edit made elsewhere (an agent's column tool,
    // a pushed update) reaches a mounted column. Nobody here calls loadIconCatalog.
    await page.evaluate((iconName) => {
      const stores = (window as unknown as { __zustandStores?: PageStores }).__zustandStores;
      if (!stores) throw new Error('window.__zustandStores not exposed');
      stores.board.setState((state) => ({
        swimlanes: state.swimlanes.map((lane) => (lane.name === 'Testing' ? { ...lane, icon: iconName } : lane)),
      }));
    }, NON_CORE_ICON);

    // The write landed (the old glyph is gone) and the name cannot resolve yet, so the column
    // shows its fallback. The column asked for the map on its own: its request is the one held.
    await expect(column.locator('svg.lucide-flask-conical')).toHaveCount(0);
    await expect.poll(() => hold.heldCount(), { timeout: 5000 }).toBeGreaterThan(0);
    expect(await column.locator('svg.lucide-rocket').count()).toBe(0);

    await hold.release();
    await expect.poll(catalogLoaded, { timeout: 10000 }).toBe(true);
    await expect(column.locator('svg.lucide-rocket')).toBeVisible({ timeout: 2000 });
    expect(getPageErrors()).toEqual([]);
  });

  test('the icon picker says it is loading while the map is on its way, and says so when it fails', async () => {
    const hold = await holdCatalog(page);
    await openBoardManager(page, 'Testing');
    await page.locator('[data-testid="board-manager-icon"]').click();

    const loading = page.locator('[data-testid="icon-picker-loading"]');
    const failed = page.locator('[data-testid="icon-picker-failed"]');
    const noMatch = page.getByText('No icons match');
    const search = page.getByPlaceholder('Search icons...');
    await expect(loading).toBeVisible();
    await expect.poll(() => hold.heldCount(), { timeout: 5000 }).toBeGreaterThan(0);

    // An empty list while the map is on its way is not "no icons match".
    await search.fill('rock');
    await expect(search).toHaveValue('rock');
    expect(await noMatch.count()).toBe(0);
    expect(await failed.count()).toBe(0);

    // The load fails: the picker names it, and still does not claim the query matched nothing.
    await hold.abort();
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('Restart Kangentic to try again');
    expect(await loading.count()).toBe(0);
    expect(await noMatch.count()).toBe(0);

    // There is deliberately no "reopen and it loads" leg, and the failure line says restart for the
    // same reason. Chromium keeps a failed module fetch for the life of the document: with the
    // route removed and the picker reopened, no second request is made and the import rejects from
    // that record, so the picker reads "failed" again. Measured in this tier.
    expect(getPageErrors()).toEqual([]);
  });

  test('hovering the Icon button starts the map without opening the picker', async () => {
    await openBoardManager(page, 'Testing');
    // The dialog itself must not load the map, or the hover below proves nothing.
    expect(catalogRequested()).toBe(false);

    await page.locator('[data-testid="board-manager-icon"]').hover();
    await expect.poll(() => catalogRequested(), { timeout: 5000 }).toBe(true);
    await expect.poll(catalogLoaded, { timeout: 10000 }).toBe(true);
    expect(await page.getByRole('heading', { name: 'Choose Icon' }).count()).toBe(0);
    expect(getPageErrors()).toEqual([]);
  });

  test('focusing the Icon button starts the map without opening the picker', async () => {
    await openBoardManager(page, 'Testing');
    expect(catalogRequested()).toBe(false);

    await page.locator('[data-testid="board-manager-icon"]').focus();
    await expect.poll(() => catalogRequested(), { timeout: 5000 }).toBe(true);
    await expect.poll(catalogLoaded, { timeout: 10000 }).toBe(true);
    expect(await page.getByRole('heading', { name: 'Choose Icon' }).count()).toBe(0);
    expect(getPageErrors()).toEqual([]);
  });
});

test.describe('icons outside the core set, on surfaces with their own seed', () => {
  test('a shortcut pill with a non-core icon paints it on its first frame after a project switch', async () => {
    const { browser, page, getPageErrors, catalogRequested } = await launchSeededPage(shortcutPreConfig);
    try {
      // Nothing on A or at boot needs the map, so the switch below is the first thing that might.
      expect(catalogRequested()).toBe(false);

      await openProjectInStore(page, PROJECT_B);
      // B's board is all core icons, so only loadShortcuts can have a reason to load the map. The
      // shortcuts reach the store only once the map is in hand, so this poll is also the wait.
      await expect
        .poll(
          () => page.evaluate(() => {
            const stores = (window as unknown as { __zustandStores?: PageStores }).__zustandStores;
            return stores ? stores.board.getState().shortcuts.length : -1;
          }),
          { timeout: 10000 },
        )
        .toBe(1);

      // Record every state the pill passes through, from the moment it mounts.
      await page.evaluate((pillTestId) => {
        const record = window as unknown as { __pillStates: string[] };
        record.__pillStates = [];
        const sample = () => {
          const pill = document.querySelector(`[data-testid="${pillTestId}"]`);
          if (!pill) return;
          record.__pillStates.push(pill.querySelector('svg.lucide-rocket') ? 'icon' : 'fallback');
        };
        new MutationObserver(sample).observe(document.body, { childList: true, subtree: true, attributes: true });
      }, SHORTCUT_PILL_TESTID);

      await page.locator(`[data-swimlane-name="${SHORTCUT_TASK_LANE}"]`).locator(`text=${SHORTCUT_TASK_TITLE}`).first().click();
      await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      const pill = page.locator(`[data-testid="${SHORTCUT_PILL_TESTID}"]`);
      await expect(pill).toBeVisible({ timeout: 5000 });
      await expect(pill.locator('svg.lucide-rocket')).toBeVisible();

      const states = await page.evaluate(() => (window as unknown as { __pillStates: string[] }).__pillStates);
      expect(states.length, 'the observer saw the pill mount').toBeGreaterThan(0);
      expect(states.filter((state) => state === 'fallback'), 'the pill painted Zap before its icon').toEqual([]);
      expect(catalogRequested()).toBe(true);
      expect(getPageErrors()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('the Board Manager overview draws a dot, not the role default, for an icon that does not resolve', async () => {
    const { browser, page, getPageErrors } = await launchSeededPage(unknownIconPreConfig);
    try {
      await openBoardManager(page, 'Testing');
      await page.locator('[data-testid="board-manager-tab-all"]').click();
      const overviewRows = page.locator('[data-testid="board-manager-overview-row"]');
      await expect(overviewRows.first()).toBeVisible();

      // To Do is a role column, so the board's header falls back to the role default for the bad
      // name. The overview deliberately does not: it shows a dot so the bad name stands out.
      const todoNameCell = overviewRows.filter({ hasText: 'To Do' }).first().locator('td').first();
      await expect(todoNameCell).toBeVisible();
      await expect(todoNameCell.locator('[class*="w-2.5"][class*="rounded-full"]')).toHaveCount(1);
      expect(await todoNameCell.locator('svg').count(), 'the role default drew over a name that does not resolve').toBe(0);

      // The other half, so the row above is not simply a row that never draws an icon: a column
      // with no custom icon of its own still draws its role default.
      const doneNameCell = overviewRows.filter({ hasText: 'Done' }).first().locator('td').first();
      await expect(doneNameCell.locator('svg.lucide-circle-check-big')).toBeVisible();
      expect(getPageErrors()).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
