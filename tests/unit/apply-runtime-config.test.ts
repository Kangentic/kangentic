/**
 * Regression guard: applyRuntimeConfig must push every config-derived
 * runtime setting into the SessionManager so on-disk config and in-memory
 * state never drift.
 *
 * History: per-project config saves (CONFIG_SET_PROJECT) used to skip
 * setShell/setMaxConcurrent/setIdleTimeout entirely - changing the shell in
 * project settings silently required a project reopen to take effect. This
 * test pins the contract: every setter must fire on every effective-config
 * apply.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyRuntimeConfig } from '../../src/main/config/apply-runtime-config';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { ConfigManager } from '../../src/main/config/config-manager';
import type { AppConfig } from '../../src/shared/types';

function makeSessionManager() {
  return {
    setMaxConcurrent: vi.fn(),
    setShell: vi.fn(),
    setIdleTimeout: vi.fn(),
    hydrateDiscoveredContextWindows: vi.fn(),
  } as unknown as SessionManager & {
    setMaxConcurrent: ReturnType<typeof vi.fn>;
    setShell: ReturnType<typeof vi.fn>;
    setIdleTimeout: ReturnType<typeof vi.fn>;
    hydrateDiscoveredContextWindows: ReturnType<typeof vi.fn>;
  };
}

function makeConfigManager(effective: Partial<AppConfig>) {
  return {
    getEffectiveConfig: vi.fn(() => effective as AppConfig),
  } as unknown as ConfigManager & {
    getEffectiveConfig: ReturnType<typeof vi.fn>;
  };
}

describe('applyRuntimeConfig', () => {
  it('pushes every cached runtime setting into SessionManager', () => {
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager({
      agent: { maxConcurrentSessions: 5, idleTimeoutMinutes: 42 },
      terminal: { shell: '/usr/bin/fish' },
    } as Partial<AppConfig>);

    applyRuntimeConfig(sessionManager, configManager, '/some/project');

    expect(configManager.getEffectiveConfig).toHaveBeenCalledWith('/some/project');
    expect(sessionManager.setMaxConcurrent).toHaveBeenCalledWith(5);
    expect(sessionManager.setShell).toHaveBeenCalledWith('/usr/bin/fish');
    expect(sessionManager.setIdleTimeout).toHaveBeenCalledWith(42);
  });

  it('falls back to global effective config when projectPath is null', () => {
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager({
      agent: { maxConcurrentSessions: 3, idleTimeoutMinutes: 15 },
      terminal: { shell: null },
    } as Partial<AppConfig>);

    applyRuntimeConfig(sessionManager, configManager, null);

    // Null projectPath becomes undefined for getEffectiveConfig, which then
    // returns the global config without any project overrides applied.
    expect(configManager.getEffectiveConfig).toHaveBeenCalledWith(undefined);
    expect(sessionManager.setShell).toHaveBeenCalledWith(null);
  });

  it('flattens discoveredContextWindowsByAgent across agents and hydrates SessionManager', () => {
    // Pins the config -> SessionManager flatten contract: the persisted
    // per-agent map (agent -> baseModelId -> window) becomes a flat entry
    // list, with no agent-name branching (agent-adapters-boundary.md).
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager({
      agent: { maxConcurrentSessions: 5, idleTimeoutMinutes: 42 },
      terminal: { shell: '/usr/bin/fish' },
      discoveredContextWindowsByAgent: {
        claude: { 'claude-opus-4-8': 1_000_000, 'claude-sonnet-4-5': 200_000 },
        codex: { 'gpt-5.3-codex': 258_400 },
      },
    } as Partial<AppConfig>);

    applyRuntimeConfig(sessionManager, configManager, '/some/project');

    expect(sessionManager.hydrateDiscoveredContextWindows).toHaveBeenCalledWith([
      { modelId: 'claude-opus-4-8', contextWindowSize: 1_000_000 },
      { modelId: 'claude-sonnet-4-5', contextWindowSize: 200_000 },
      { modelId: 'gpt-5.3-codex', contextWindowSize: 258_400 },
    ]);
  });

  it('hydrates an empty list when discoveredContextWindowsByAgent is absent', () => {
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager({
      agent: { maxConcurrentSessions: 5, idleTimeoutMinutes: 42 },
      terminal: { shell: '/usr/bin/fish' },
    } as Partial<AppConfig>);

    applyRuntimeConfig(sessionManager, configManager, '/some/project');

    expect(sessionManager.hydrateDiscoveredContextWindows).toHaveBeenCalledWith([]);
  });
});
