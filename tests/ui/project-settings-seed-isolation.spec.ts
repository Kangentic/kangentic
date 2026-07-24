/**
 * UI-tier regression guard for the per-project import-source leak.
 *
 * History: new projects were seeded by cloning the most-recently-opened
 * project's ENTIRE .kangentic/config.json via getLastProjectDefaults() in the
 * mock. That file also holds project-specific data - notably `importSources`
 * and `browser.defaultUrl` - so every project created after a configured one
 * inherited those project-specific fields.
 *
 * The fix routes seeding through pickOverridableSubset() in both the real
 * backend (src/main/config/config-manager.ts) and the mock
 * (tests/ui/mock-electron-api.js). This spec exercises the mock's
 * getLastProjectDefaults() fall-through with the renderer in the loop,
 * confirming that:
 *
 *   1. A previously configured project whose config.json contains
 *      importSources + browser does NOT leak those fields into a new project.
 *   2. The overridable settings (theme, agent.permissionMode, git) ARE
 *      carried over correctly, and terminal.* (global-only, never
 *      overridable) is dropped even when present in the source project.
 *   3. When the most-recently-opened project has ONLY non-overridable keys,
 *      getLastProjectDefaults falls through to the global defaults.
 *
 * Tier: UI (headless Chromium + mock-electron-api). No real Electron, no PTY.
 * Rationale: the seeding logic lives in the mock's getLastProjectDefaults(),
 * which can be exercised fully through the renderer's project-create IPC call
 * without a real Electron main process.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared browser instance - one Chromium launch for the whole spec file.
// ---------------------------------------------------------------------------

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
});

test.afterAll(async () => {
  await browser?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the stored overrides for a project path from the mock's projectConfigs.
 * Returns null when no overrides have been saved for the path.
 */
async function readOverridesForPath(projectPath: string): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (path) => {
    return window.electronAPI.config.getProjectOverridesByPath(path);
  }, projectPath);
}

// ---------------------------------------------------------------------------
// Scenario 1: previous project has settings + non-overridable keys
// Expectation: settings carry over; non-overridable keys are dropped
// ---------------------------------------------------------------------------

test('new project inherits settings but not importSources or browser from previous project', async () => {
  const previousProjectPath = '/mock/seed-isolation/previous-configured';
  const newProjectName = `SeedIsolation-NoLeak-${Date.now()}`;
  const newProjectPath = '/mock/projects/' + newProjectName;

  // Pre-configure: inject a "previous" project into the mock's in-memory state
  // with a config that mirrors the real TWC-Website leak scenario - legit
  // overridable settings alongside importSources and browser.defaultUrl.
  await page.evaluate((previousPath) => {
    window.__mockPreConfigure(function (state) {
      var previousProject = {
        id: 'proj-seed-isolation-prev-' + Date.now(),
        name: 'Previous Configured Project',
        path: previousPath,
        default_agent: 'claude',
        group_id: null,
        position: 99,
        last_opened: new Date(Date.now() - 60000).toISOString(), // 1 min ago
        created_at: new Date(Date.now() - 3600000).toISOString(),
      };
      state.projects.push(previousProject);
      // Store overrides that include non-overridable keys alongside real settings.
      state.projectConfigs[previousPath] = {
        theme: 'forest',
        // Legacy per-project terminal override (predates terminal.* becoming
        // global-only) - must be dropped by pickOverridableSubset, never
        // cloned into the new project.
        terminal: { shell: 'pwsh.exe', fontSize: 14, cursorStyle: 'block' },
        agent: { permissionMode: 'acceptEdits' },
        git: { worktreesEnabled: true, defaultBaseBranch: 'develop' },
        // Non-overridable keys that must be dropped by pickOverridableSubset:
        importSources: [
          { id: 'e83c7746', source: 'azure_devops', label: 'OCC / OCC-OKIES/2026-06' },
          { id: '3a7f1bc2', source: 'github_issues', label: 'Kangentic/kangentic' },
        ],
        browser: { defaultUrl: 'http://troyweb.com/', enabled: true },
      };
    });
  }, previousProjectPath);

  // Create the new project through the UI (triggers getLastProjectDefaults).
  await createProject(page, newProjectName);

  // Read back the overrides that were seeded into the new project.
  const seededOverrides = await readOverridesForPath(newProjectPath);

  expect(seededOverrides).not.toBeNull();

  // Non-overridable fields must be absent.
  expect(seededOverrides).not.toHaveProperty('importSources');
  expect(seededOverrides).not.toHaveProperty('browser');
  // terminal.* is global-only, never project-overridable - dropped even
  // though the source project's config had it.
  expect(seededOverrides).not.toHaveProperty('terminal');

  // The overridable settings from the previous project must be present.
  expect((seededOverrides as Record<string, unknown>).theme).toBe('forest');
  const agent = (seededOverrides as Record<string, unknown>).agent as Record<string, unknown>;
  expect(agent?.permissionMode).toBe('acceptEdits');
  const git = (seededOverrides as Record<string, unknown>).git as Record<string, unknown>;
  expect(git?.worktreesEnabled).toBe(true);
  expect(git?.defaultBaseBranch).toBe('develop');
});

// ---------------------------------------------------------------------------
// Scenario 2: most-recent project has ONLY non-overridable keys
// Expectation: falls through to global defaults (no importSources/browser)
// ---------------------------------------------------------------------------

test('falls through to global defaults when most-recent project has only non-overridable config', async () => {
  const importOnlyProjectPath = '/mock/seed-isolation/import-only';
  const newProjectName = `SeedIsolation-FallThrough-${Date.now()}`;
  const newProjectPath = '/mock/projects/' + newProjectName;

  // Pre-configure: a project whose config has ONLY importSources - the
  // overridable subset is empty, so the mock must skip it and fall back.
  await page.evaluate((importOnlyPath) => {
    window.__mockPreConfigure(function (state) {
      var importOnlyProject = {
        id: 'proj-seed-isolation-import-only-' + Date.now(),
        name: 'Import-Only Project',
        path: importOnlyPath,
        default_agent: 'claude',
        group_id: null,
        position: 98,
        // Make it the most recently opened so it would be picked first if the
        // guard was missing. The newly created project's last_opened will be
        // "now()" which is later, but it is excluded via excludePath.
        last_opened: new Date(Date.now() - 30000).toISOString(),
        created_at: new Date(Date.now() - 7200000).toISOString(),
      };
      state.projects.push(importOnlyProject);
      state.projectConfigs[importOnlyPath] = {
        importSources: [
          { id: '2759d127', source: 'github_issues', label: 'Kangentic/kangentic' },
        ],
      };
    });
  }, importOnlyProjectPath);

  // Create the new project via the UI.
  await createProject(page, newProjectName);

  const seededOverrides = await readOverridesForPath(newProjectPath);

  // Non-overridable keys must never appear in the seed, even as a fallback.
  expect(seededOverrides).not.toHaveProperty('importSources');
  expect(seededOverrides).not.toHaveProperty('browser');

  // The seed came from global defaults, which must not include importSources.
  // (The global default in the mock does not have importSources or browser.)
  // We cannot assert exact values since the global config may vary, but we
  // can confirm the seeded object is a plain settings-only blob.
  if (seededOverrides !== null) {
    const keys = Object.keys(seededOverrides);
    for (const key of keys) {
      // Only overridable setting keys are permitted. terminal.* is
      // global-only, never project-overridable.
      const overridableKeys = ['theme', 'agent', 'git'];
      expect(overridableKeys).toContain(key);
    }
  }
});
