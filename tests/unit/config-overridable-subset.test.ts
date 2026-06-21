/**
 * Regression guard for the per-project import-source leak.
 *
 * History: new projects were seeded by cloning the most-recently-opened
 * project's ENTIRE `.kangentic/config.json` (getLastProjectOverrides returned
 * the raw overrides). That config file also holds project-specific data that is
 * not a "setting" - notably `importSources` and `browser.defaultUrl` - so every
 * project created after a configured one inherited that project's import sources.
 *
 * The fix routes both new-project seeding and the global-defaults snapshot
 * through pickOverridableSubset(), the single definition of "what counts as a
 * project setting". This test pins that only the overridable settings survive
 * and that non-setting keys (importSources, browser, ...) are dropped.
 *
 * KEEP IN SYNC with pickOverridableSubset() in tests/ui/mock-electron-api.js
 */
import { describe, it, expect } from 'vitest';
import { pickOverridableSubset } from '../../src/main/config/config-manager';

describe('pickOverridableSubset', () => {
  it('drops importSources and browser while keeping the setting keys', () => {
    // Mirrors a real leaked config (TWC-Website): legit settings alongside the
    // project-specific importSources array and a per-project browser URL.
    const source = {
      theme: 'forest',
      terminal: { shell: 'pwsh.exe', fontSize: 14, scrollbackLines: 5000 },
      agent: { permissionMode: 'acceptEdits' },
      git: { worktreesEnabled: true, defaultBaseBranch: 'develop' },
      browser: { defaultUrl: 'http://troyweb.com/' },
      importSources: [
        { id: 'e83c7746', source: 'azure_devops', label: 'OCC / OCC-OKIES/2026-06' },
      ],
    } as unknown as Parameters<typeof pickOverridableSubset>[0];

    const result = pickOverridableSubset(source) as Record<string, unknown>;

    expect(result).not.toHaveProperty('importSources');
    expect(result).not.toHaveProperty('browser');
    expect(result.theme).toBe('forest');
    expect(result.terminal).toEqual({ shell: 'pwsh.exe', fontSize: 14, scrollbackLines: 5000 });
    expect(result.agent).toEqual({ permissionMode: 'acceptEdits' });
    expect(result.git).toEqual({ worktreesEnabled: true, defaultBaseBranch: 'develop' });
  });

  it('returns {} when the source has only non-overridable keys', () => {
    // A project whose config holds ONLY importSources must not become the seed
    // source - getLastProjectOverrides relies on an empty result to fall through.
    const source = {
      importSources: [{ id: '2759d127', source: 'github_issues', label: 'Kangentic/kangentic' }],
    } as unknown as Parameters<typeof pickOverridableSubset>[0];

    expect(pickOverridableSubset(source)).toEqual({});
  });

  it('tolerates a sparse source and omits empty nested objects', () => {
    const result = pickOverridableSubset({ theme: 'ember' } as Parameters<typeof pickOverridableSubset>[0]);

    // Only the defined leaf survives; terminal/agent/git are dropped entirely
    // rather than written as empty objects.
    expect(result).toEqual({ theme: 'ember' });
  });

  it('preserves the full overridable key set when every setting is present', () => {
    const fullConfig = {
      theme: 'ocean',
      terminal: {
        shell: 'bash',
        fontSize: 13,
        fontFamily: 'Consolas',
        scrollbackLines: 1000,
        cursorStyle: 'block',
      },
      agent: { permissionMode: 'plan' },
      git: {
        worktreesEnabled: false,
        autoCleanup: true,
        defaultBaseBranch: 'main',
        copyFiles: ['.env'],
        initScript: null,
        linkNodeModules: false,
        prRefreshIntervalMinutes: 10,
      },
    } as unknown as Parameters<typeof pickOverridableSubset>[0];

    expect(pickOverridableSubset(fullConfig)).toEqual({
      theme: 'ocean',
      terminal: {
        shell: 'bash',
        fontSize: 13,
        fontFamily: 'Consolas',
        scrollbackLines: 1000,
        cursorStyle: 'block',
      },
      agent: { permissionMode: 'plan' },
      git: {
        worktreesEnabled: false,
        autoCleanup: true,
        defaultBaseBranch: 'main',
        copyFiles: ['.env'],
        initScript: null,
        linkNodeModules: false,
        prRefreshIntervalMinutes: 10,
      },
    });
  });
});
