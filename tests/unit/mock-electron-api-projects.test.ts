/**
 * The mock bridge's project writes (tests/ui/mock-electron-api.js), evaluated in a `node:vm`
 * context with no browser.
 *
 * The mock is the UI tier's bridge and the web demo's runtime bridge, and these two behaviors
 * mirror main, so a drift in the mock misleads every spec and the demo that leans on them:
 *
 * - A new project is seeded from the most recently opened project's config through
 *   `pickOverridableSubset` (`getLastProjectDefaults` in the mock, `getLastProjectOverrides` in
 *   src/main/ipc/handlers/projects.ts). Cloning the whole config.json once leaked a previous
 *   project's `importSources` and `browser.defaultUrl` into every project created after it.
 *   `terminal.*` is global-only, so it is dropped even when a legacy override carries it.
 * - `projects.reorder` rewrites each project's `position` to its index in the id list.
 */
import { describe, expect, it } from 'vitest';
import { loadMockElectronApi, plain } from './helpers/load-mock-electron-api';

interface Project {
  id: string;
  name: string;
  position: number;
}

interface ProjectsBridge {
  projects: {
    openByPath(projectPath: string): Promise<Project>;
    list(): Promise<Project[]>;
    reorder(ids: string[]): Promise<void>;
  };
  config: {
    getProjectOverridesByPath(projectPath: string): Promise<Record<string, unknown> | null>;
  };
}

/** A mock whose most recently opened project holds `previousOverrides` as its config. */
function mockWithPreviousProject(
  previousPath: string,
  lastOpenedMsAgo: number,
  previousOverrides: Record<string, unknown>,
): ProjectsBridge {
  const { electronApi, preConfigure } = loadMockElectronApi<ProjectsBridge>();
  preConfigure((state) => {
    state.projects.push({
      id: 'proj-seed-isolation-previous',
      name: 'Previous project',
      path: previousPath,
      default_agent: 'claude',
      group_id: null,
      position: 99,
      last_opened: new Date(Date.now() - lastOpenedMsAgo).toISOString(),
      created_at: new Date(Date.now() - 3600000).toISOString(),
    });
    state.projectConfigs[previousPath] = previousOverrides;
  });
  return electronApi;
}

describe('mock projects: a new project is seeded from the last project, minus non-setting keys', () => {
  it('inherits the overridable settings but not importSources, browser or terminal', async () => {
    const bridge = mockWithPreviousProject('/mock/seed-isolation/previous-configured', 60000, {
      theme: 'forest',
      // A legacy per-project terminal override, from before terminal.* became global-only.
      terminal: { shell: 'pwsh.exe', fontSize: 14, cursorStyle: 'block' },
      agent: { permissionMode: 'acceptEdits' },
      git: { worktreesEnabled: true, defaultBaseBranch: 'develop' },
      // Keys that live in config.json but are not settings, so a new project must not clone them.
      importSources: [
        { id: 'e83c7746', source: 'azure_devops', label: 'Example org / Example project' },
        { id: '3a7f1bc2', source: 'github_issues', label: 'example/repo' },
      ],
      browser: { defaultUrl: 'http://example.test/', enabled: true },
    });

    await bridge.projects.openByPath('/mock/projects/SeedIsolationNoLeak');
    const seeded = plain(await bridge.config.getProjectOverridesByPath('/mock/projects/SeedIsolationNoLeak'));

    expect(seeded).not.toBeNull();
    expect(seeded).not.toHaveProperty('importSources');
    expect(seeded).not.toHaveProperty('browser');
    expect(seeded).not.toHaveProperty('terminal');
    expect(seeded).toMatchObject({
      theme: 'forest',
      agent: { permissionMode: 'acceptEdits' },
      git: { worktreesEnabled: true, defaultBaseBranch: 'develop' },
    });
  });

  it('falls through to the global defaults when the last project holds only non-overridable config', async () => {
    const bridge = mockWithPreviousProject('/mock/seed-isolation/import-only', 30000, {
      importSources: [{ id: '2759d127', source: 'github_issues', label: 'example/repo' }],
    });

    await bridge.projects.openByPath('/mock/projects/SeedIsolationFallThrough');
    const seeded = plain(await bridge.config.getProjectOverridesByPath('/mock/projects/SeedIsolationFallThrough'));

    // The seed is a settings-only blob from the global config, never the previous project's keys.
    // It is not empty: the previous project had nothing to inherit, so the global defaults fill in.
    expect(seeded).not.toBeNull();
    expect(Object.keys(seeded as Record<string, unknown>).length).toBeGreaterThan(0);
    expect(seeded).not.toHaveProperty('importSources');
    expect(seeded).not.toHaveProperty('browser');
    // Only the project-overridable settings: the theme keys, agent and git.
    const overridableKeys = ['theme', 'themeFollowsSystem', 'themeLight', 'themeDark', 'agent', 'git'];
    for (const key of Object.keys(seeded as Record<string, unknown>)) {
      expect(overridableKeys).toContain(key);
    }
  });
});

describe('mock projects: reorder', () => {
  it('rewrites positions to the index in the id list', async () => {
    const { electronApi: bridge } = loadMockElectronApi<ProjectsBridge>();
    // Each new project lands at position 0, so the list reads Gamma, Beta, Alpha.
    await bridge.projects.openByPath('/mock/projects/Alpha');
    await bridge.projects.openByPath('/mock/projects/Beta');
    await bridge.projects.openByPath('/mock/projects/Gamma');
    const before = plain(await bridge.projects.list());
    expect(before.map((project) => project.name)).toEqual(['Gamma', 'Beta', 'Alpha']);

    await bridge.projects.reorder([...before].reverse().map((project) => project.id));

    const after = plain(await bridge.projects.list());
    expect(after.map((project) => ({ name: project.name, position: project.position }))).toEqual([
      { name: 'Alpha', position: 0 },
      { name: 'Beta', position: 1 },
      { name: 'Gamma', position: 2 },
    ]);
  });
});
