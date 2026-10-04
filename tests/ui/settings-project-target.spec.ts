/**
 * UI tests for WHICH project the Settings panel edits.
 *
 * The panel's project switcher (and the sidebar gear) move `projectSettingsPath`,
 * while the board stays on `currentProject`. Three bugs came from mixing the two:
 *
 * 1. Settings > Agent > Project defaults read and wrote the BOARD's project row,
 *    so every project in the switcher showed the same Agent, Model and Effort, a
 *    Model change landed on the wrong project, and an agent change split across
 *    two projects (the row on the board's, the permission mode on the switcher's).
 * 2. After a defaults write only `currentProject` was refreshed. `projects[]` kept
 *    the old row, and `openProject` copied it back into `currentProject` on the
 *    next switch, so the old value came back while spawns used the saved one.
 * 3. `setSettingsOpen(true)` (the Performance toast, the Changes kebab, the
 *    Knowledge Graph, the queued placeholder) opened with no target, so project
 *    tab edits returned `{ persisted: true }` without writing anything.
 *
 * Every test owns its page, seeded with two projects whose defaults and
 * overrides differ, so each precondition can fail on its own.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A = { id: 'proj-settings-target-a', name: 'Target Alpha', path: '/mock/target-alpha' };
const PROJECT_B = { id: 'proj-settings-target-b', name: 'Target Beta', path: '/mock/target-beta' };

interface ProjectRow {
  id: string;
  default_agent: string | null;
  default_model: string | null;
  default_effort: string | null;
}

interface SeededOverrides {
  agent?: { permissionMode?: string };
  git?: { prAutoRefresh?: boolean; prBypassCountsAsReady?: boolean };
}

/**
 * Boots the mock with both projects registered. The board opens on project A
 * unless `boardProjectId` says otherwise; `null` boots with no project open, the
 * state a Settings panel opened before any project exists starts from.
 */
async function launchTwoProjects(options: { boardProjectId?: string | null } = {}): Promise<{ browser: Browser; page: Page }> {
  const boardProjectId = options.boardProjectId === undefined ? PROJECT_A.id : options.boardProjectId;
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();

      // Distinct defaults per project: a tab bound to the wrong row shows the
      // other project's values, not a coincidentally equal one.
      state.projects.push({
        id: '${PROJECT_A.id}', name: '${PROJECT_A.name}', path: '${PROJECT_A.path}',
        github_url: null, default_agent: 'claude', default_model: 'opus', default_effort: 'high',
        group_id: null, position: 0, last_opened: timestamp, created_at: timestamp,
      });
      state.projects.push({
        id: '${PROJECT_B.id}', name: '${PROJECT_B.name}', path: '${PROJECT_B.path}',
        github_url: null, default_agent: 'claude', default_model: 'sonnet', default_effort: 'low',
        group_id: null, position: 1, last_opened: timestamp, created_at: timestamp,
      });

      // Neither permission mode is Kimi's 'default', so switching B to Kimi
      // really writes one (the Agent tab only writes when the mode changes).
      // A's prAutoRefresh is the OPPOSITE of the global default (true), so a
      // switch that reads it proves the overrides loaded.
      state.projectConfigs['${PROJECT_A.path}'] = {
        agent: { permissionMode: 'plan' },
        git: { prAutoRefresh: false, prBypassCountsAsReady: true },
      };
      state.projectConfigs['${PROJECT_B.path}'] = {
        agent: { permissionMode: 'auto' },
        git: { prAutoRefresh: true, prBypassCountsAsReady: true },
      };

      state.DEFAULT_SWIMLANES.forEach(function (defaultSwimlane, swimlaneIndex) {
        state.swimlanes.push(Object.assign({}, defaultSwimlane, {
          id: 'lane-settings-target-' + swimlaneIndex,
          position: swimlaneIndex,
          created_at: timestamp,
        }));
      });

      // Both already onboarded, so the Get started checklist never covers the board.
      state.config.onboardedProjectIds = ['${PROJECT_A.id}', '${PROJECT_B.id}'];

      return { currentProjectId: ${JSON.stringify(boardProjectId)} };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  if (boardProjectId === null) {
    // No board project means no To Do lane to wait on. The sidebar row and the title
    // bar gear are what a project-less launch with registered projects shows.
    await page.getByTestId(`project-row-${PROJECT_A.id}`).waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-testid="settings-button"]').waitFor({ state: 'visible', timeout: 15000 });
    await expect.poll(() => readCurrentProjectId(page)).toBeNull();
  } else {
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    await expect.poll(() => readCurrentProjectId(page)).toBe(boardProjectId);
  }
  return { browser, page };
}

/** The path the Settings panel is editing, or null while it has no target. */
async function readSettingsProjectPath(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { projectSettingsPath: string | null } } };
    }).__zustandStores;
    return stores.config.getState().projectSettingsPath;
  });
}

async function readCurrentProjectId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { project: { getState: () => { currentProject: { id: string } | null } } };
    }).__zustandStores;
    return stores.project.getState().currentProject?.id ?? null;
  });
}

async function readCurrentProjectModel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { project: { getState: () => { currentProject: { default_model: string | null } | null } } };
    }).__zustandStores;
    return stores.project.getState().currentProject?.default_model ?? null;
  });
}

/** The mock's own rows (main's DB), not the renderer's copies. */
async function readProjectRow(page: Page, projectId: string): Promise<ProjectRow | null> {
  return page.evaluate(async (id: string) => {
    const rows = await window.electronAPI.projects.list();
    const row = rows.find((candidate) => candidate.id === id);
    return row
      ? { id: row.id, default_agent: row.default_agent, default_model: row.default_model, default_effort: row.default_effort }
      : null;
  }, projectId);
}

async function readOverrides(page: Page, projectPath: string): Promise<SeededOverrides | null> {
  return page.evaluate(
    async (target: string) => (await window.electronAPI.config.getProjectOverridesByPath(target)) as SeededOverrides | null,
    projectPath,
  );
}

async function switchBoardProject(page: Page, project: { id: string; name: string }): Promise<void> {
  await page.getByTestId(`project-row-${project.id}`).click();
  await expect.poll(() => readCurrentProjectId(page)).toBe(project.id);
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
}

async function openSettingsAgentTabViaGear(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.locator('input[data-testid="project-default-model"]')).toBeVisible({ timeout: 3000 });
}

async function openSettingsGeneralTabViaGear(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByTestId('project-location-path')).toBeVisible({ timeout: 3000 });
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 3000 });
}

async function pickDefaultModel(page: Page, model: string): Promise<void> {
  await page.locator('input[data-testid="project-default-model"]').click();
  const menu = page.locator('[data-testid="project-default-model-menu"]');
  await expect(menu).toBeVisible({ timeout: 3000 });
  await menu.locator(`[data-model-option]:has-text("${model}")`).first().click();
}

test.describe('Settings panel project target', () => {
  test('the Agent tab reads and writes the project picked in the switcher, not the board project', async () => {
    const { browser, page } = await launchTwoProjects();
    try {
      await openSettingsAgentTabViaGear(page);
      const modelInput = page.locator('input[data-testid="project-default-model"]');
      const effortInput = page.locator('input[data-testid="project-default-effort"]');

      // The gear opens on the board project, A.
      await expect(modelInput).toHaveValue('opus');
      await expect(effortInput).toHaveValue('high');

      // The switcher moves the panel to B while the board stays on A.
      await page.getByTestId('settings-project-switcher').selectOption(PROJECT_B.path);
      await expect(modelInput).toHaveValue('sonnet');
      await expect(effortInput).toHaveValue('low');
      expect(await readCurrentProjectId(page)).toBe(PROJECT_A.id);

      // A Model change lands on B's row only.
      await pickDefaultModel(page, 'haiku');
      await expect(modelInput).toHaveValue('haiku');
      await expect.poll(async () => (await readProjectRow(page, PROJECT_B.id))?.default_model).toBe('haiku');
      expect((await readProjectRow(page, PROJECT_A.id))?.default_model).toBe('opus');

      // Back to A: A's own value, untouched.
      await page.getByTestId('settings-project-switcher').selectOption(PROJECT_A.path);
      await expect(modelInput).toHaveValue('opus');
      await expect(effortInput).toHaveValue('high');

      // An agent change on B writes the row AND the permission mode to B, never A.
      await page.getByTestId('settings-project-switcher').selectOption(PROJECT_B.path);
      await expect(modelInput).toHaveValue('haiku');
      await page.locator('input[data-testid="project-default-agent"]').click();
      await page.locator('[data-testid="project-default-agent-option-kimi"]').click();

      await expect.poll(async () => readProjectRow(page, PROJECT_B.id)).toEqual({
        id: PROJECT_B.id, default_agent: 'kimi', default_model: null, default_effort: null,
      });
      await expect.poll(async () => (await readOverrides(page, PROJECT_B.path))?.agent?.permissionMode).toBe('default');
      expect(await readProjectRow(page, PROJECT_A.id)).toEqual({
        id: PROJECT_A.id, default_agent: 'claude', default_model: 'opus', default_effort: 'high',
      });
      expect((await readOverrides(page, PROJECT_A.path))?.agent?.permissionMode).toBe('plan');
    } finally {
      await browser.close();
    }
  });

  test('an agent change keeps its permission mode on its own project when the switcher moves during the write', async () => {
    const { browser, page } = await launchTwoProjects();
    try {
      await openSettingsAgentTabViaGear(page);
      const modelInput = page.locator('input[data-testid="project-default-model"]');
      await page.getByTestId('settings-project-switcher').selectOption(PROJECT_B.path);
      await expect(modelInput).toHaveValue('sonnet');

      // Hold main's agent write open until released, so the switcher can move
      // inside the await the Agent tab makes before it writes the permission mode.
      await page.evaluate(() => {
        const holder = window as unknown as {
          electronAPI: { projects: { setDefaultAgent: (id: string, agentName: string) => Promise<unknown> } };
          __setDefaultAgentHeld?: boolean;
          __releaseSetDefaultAgent?: () => void;
        };
        const projectsApi = holder.electronAPI.projects;
        const original = projectsApi.setDefaultAgent;
        const gate = new Promise<void>((resolve) => { holder.__releaseSetDefaultAgent = resolve; });
        projectsApi.setDefaultAgent = async (id, agentName) => {
          holder.__setDefaultAgentHeld = true;
          await gate;
          return original.call(projectsApi, id, agentName);
        };
      });

      await page.locator('input[data-testid="project-default-agent"]').click();
      await page.locator('[data-testid="project-default-agent-option-kimi"]').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __setDefaultAgentHeld?: boolean }).__setDefaultAgentHeld === true)).toBe(true);

      // The panel moves to A while B's agent write is still in flight.
      await page.getByTestId('settings-project-switcher').selectOption(PROJECT_A.path);
      await expect(modelInput).toHaveValue('opus');
      await page.evaluate(() => (window as unknown as { __releaseSetDefaultAgent: () => void }).__releaseSetDefaultAgent());

      // The agent and its permission mode both land on B, the project the user changed.
      await expect.poll(async () => (await readProjectRow(page, PROJECT_B.id))?.default_agent).toBe('kimi');
      await expect.poll(async () => (await readOverrides(page, PROJECT_B.path))?.agent?.permissionMode).toBe('default');
      const projectAOverrides = await readOverrides(page, PROJECT_A.path);
      expect(projectAOverrides?.agent?.permissionMode, 'A is only where the panel happened to be').toBe('plan');
      expect(projectAOverrides?.git?.prAutoRefresh).toBe(false);
      // B's other keys survive: the write merged over B's own overrides, not A's.
      expect((await readOverrides(page, PROJECT_B.path))?.git?.prAutoRefresh).toBe(true);
      expect((await readProjectRow(page, PROJECT_A.id))?.default_agent).toBe('claude');
    } finally {
      await browser.close();
    }
  });

  test('a setSettingsOpen(true) entry point edits and persists the board project overrides', async () => {
    const { browser, page } = await launchTwoProjects();
    try {
      // Exactly what the Performance toast's action runs (the Changes kebab and
      // the Knowledge Graph open the same way, with their own tab).
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores: { config: { getState: () => { setLastSettingsTab: (tabId: string) => void; setSettingsOpen: (open: boolean) => void } } };
        }).__zustandStores;
        stores.config.getState().setLastSettingsTab('git');
        stores.config.getState().setSettingsOpen(true);
      });
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

      // A's seeded false, not the global true: the overrides loaded, so the
      // write below merges over them instead of over nothing.
      const toggle = page.getByRole('switch', { name: 'Auto-refresh PRs' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect.poll(async () => (await readOverrides(page, PROJECT_A.path))?.git?.prAutoRefresh).toBe(true);
      const projectAOverrides = await readOverrides(page, PROJECT_A.path);
      expect(projectAOverrides?.agent?.permissionMode).toBe('plan');
      expect(projectAOverrides?.git?.prBypassCountsAsReady).toBe(true);
      // B is not the board project and was never touched.
      expect((await readOverrides(page, PROJECT_B.path))?.git?.prAutoRefresh).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a project that opens while the panel is already up with no target becomes its target', async () => {
    // The mount-time seed is covered above. This is the other entry: the panel mounts
    // with no project (the title bar gear, or the Performance toast at boot, before
    // any project is open) and main then auto-opens one with Settings still showing.
    // Only the effect's re-run on `currentProject` can seed it; a seed that runs on
    // mount alone leaves the target null.
    const { browser, page } = await launchTwoProjects({ boardProjectId: null });
    try {
      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

      // Up with nothing to edit yet: no board project and no target. Asserting this
      // first is what makes the seed below a change rather than a leftover.
      expect(await readCurrentProjectId(page)).toBeNull();
      expect(await readSettingsProjectPath(page)).toBeNull();

      // The same push main sends for a launch-time auto-open (App.tsx onAutoOpened).
      await page.evaluate((projectId: string) => {
        (window as unknown as { __mockFireProjectAutoOpened: (id: string) => void }).__mockFireProjectAutoOpened(projectId);
      }, PROJECT_A.id);
      await expect.poll(() => readCurrentProjectId(page)).toBe(PROJECT_A.id);

      // The panel stayed up and now targets the project that opened.
      await expect.poll(() => readSettingsProjectPath(page)).toBe(PROJECT_A.path);
      await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

      // A project-tab write now persists. An unseeded panel resolves { persisted: true }
      // without writing, so the poll on the stored overrides is the discriminating
      // assertion, not the toggle's own state.
      await page.getByRole('button', { name: 'Git', exact: true }).click();
      const toggle = page.getByRole('switch', { name: 'Auto-refresh PRs' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expect.poll(async () => (await readOverrides(page, PROJECT_A.path))?.git?.prAutoRefresh).toBe(true);
      const projectAOverrides = await readOverrides(page, PROJECT_A.path);
      expect(projectAOverrides?.agent?.permissionMode, 'merged over A\'s loaded overrides, not over nothing').toBe('plan');
      expect(projectAOverrides?.git?.prBypassCountsAsReady).toBe(true);
      expect((await readOverrides(page, PROJECT_B.path))?.git?.prAutoRefresh).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('a saved default model survives a board project switch away and back', async () => {
    const { browser, page } = await launchTwoProjects();
    try {
      await openSettingsAgentTabViaGear(page);
      await expect(page.locator('input[data-testid="project-default-model"]')).toHaveValue('opus');
      await pickDefaultModel(page, 'haiku');
      await expect.poll(async () => (await readProjectRow(page, PROJECT_A.id))?.default_model).toBe('haiku');
      await closeSettings(page);

      await switchBoardProject(page, PROJECT_B);
      await switchBoardProject(page, PROJECT_A);

      // openProject takes the row from the renderer's project list, so the list
      // has to carry the write too, not just currentProject.
      expect(await readCurrentProjectModel(page)).toBe('haiku');
      await openSettingsAgentTabViaGear(page);
      await expect(page.locator('input[data-testid="project-default-model"]')).toHaveValue('haiku');
    } finally {
      await browser.close();
    }
  });

  test('the General tab shows the location of the project picked in the switcher, not the board project', async () => {
    const { browser, page } = await launchTwoProjects();
    try {
      await openSettingsGeneralTabViaGear(page);
      const locationField = page.getByTestId('project-location-path');

      // The gear opens on the board project, A. Asserting this first is what makes
      // the switch below prove something: a field that never left A would fail it.
      await expect(locationField).toHaveText(PROJECT_A.path);

      // The switcher moves the panel to B while the board stays on A.
      await page.getByTestId('settings-project-switcher').selectOption(PROJECT_B.path);
      await expect(locationField).toHaveText(PROJECT_B.path);
      expect(await readCurrentProjectId(page)).toBe(PROJECT_A.id);

      // And back: the field follows the switcher in both directions.
      await page.getByTestId('settings-project-switcher').selectOption(PROJECT_A.path);
      await expect(locationField).toHaveText(PROJECT_A.path);
    } finally {
      await browser.close();
    }
  });

  test('a target that matches no project row hides the General location card instead of showing the board project', async () => {
    const { browser, page } = await launchTwoProjects();
    try {
      await openSettingsGeneralTabViaGear(page);
      const panel = page.getByTestId('settings-panel');
      const locationField = page.getByTestId('project-location-path');

      // Present first, so the absence below is a real change and not a card that
      // never rendered. The board project, A, is what a fallback would show.
      await expect(locationField).toHaveText(PROJECT_A.path);

      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores: {
            config: { getState: () => { openProjectSettings: (projectPath: string, projectName: string, initialTab?: string) => void } };
          };
        }).__zustandStores;
        stores.config.getState().openProjectSettings('/mock/not-registered', 'Gone', 'general');
      });

      // The target moved, the panel stayed open on General, and the board did not move.
      await expect.poll(async () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores: { config: { getState: () => { projectSettingsPath: string | null; lastSettingsTab: string | null } } };
        }).__zustandStores;
        const { projectSettingsPath, lastSettingsTab } = stores.config.getState();
        return { projectSettingsPath, lastSettingsTab };
      })).toEqual({ projectSettingsPath: '/mock/not-registered', lastSettingsTab: 'general' });
      await expect(panel).toBeVisible();
      expect(await readCurrentProjectId(page)).toBe(PROJECT_A.id);

      // No row to edit means no card, and no stand-in row from the board project.
      await expect(locationField).toHaveCount(0);
      await expect(page.getByTestId('project-location-move')).toHaveCount(0);
      await expect(panel.getByText(PROJECT_A.path)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a target that matches no project row disables the Agent defaults instead of showing the board project', async () => {
    const { browser, page } = await launchTwoProjects();
    try {
      await openSettingsAgentTabViaGear(page);
      const panel = page.getByTestId('settings-panel');
      const agentInput = page.locator('input[data-testid="project-default-agent"]');
      const modelInput = page.locator('input[data-testid="project-default-model"]');
      const effortInput = page.locator('input[data-testid="project-default-effort"]');

      // Populated and editable first, so the empty and disabled state below is a real
      // change. The board project, A, is what a fallback would keep showing.
      await expect(modelInput).toHaveValue('opus');
      await expect(effortInput).toHaveValue('high');
      await expect(agentInput).toBeEnabled();

      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores: {
            config: { getState: () => { openProjectSettings: (projectPath: string, projectName: string, initialTab?: string) => void } };
          };
        }).__zustandStores;
        stores.config.getState().openProjectSettings('/mock/not-registered', 'Gone', 'agent');
      });

      // The target moved, the panel stayed open on Agent, and the board did not move.
      await expect.poll(async () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores: { config: { getState: () => { projectSettingsPath: string | null; lastSettingsTab: string | null } } };
        }).__zustandStores;
        const { projectSettingsPath, lastSettingsTab } = stores.config.getState();
        return { projectSettingsPath, lastSettingsTab };
      })).toEqual({ projectSettingsPath: '/mock/not-registered', lastSettingsTab: 'agent' });
      await expect(panel).toBeVisible();
      expect(await readCurrentProjectId(page)).toBe(PROJECT_A.id);

      // With no row to edit, the agent picker is locked and the model and effort read
      // empty, not A's opus and high. A pick here would otherwise land on the board project.
      await expect(agentInput).toBeDisabled();
      await expect(modelInput).toHaveValue('');
      await expect(effortInput).toHaveValue('');
      // And the board project's own row is untouched.
      expect(await readProjectRow(page, PROJECT_A.id)).toEqual({
        id: PROJECT_A.id, default_agent: 'claude', default_model: 'opus', default_effort: 'high',
      });
    } finally {
      await browser.close();
    }
  });
});
