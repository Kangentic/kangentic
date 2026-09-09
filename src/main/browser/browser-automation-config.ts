import type { ConfigManager } from '../config/config-manager';
import type { AppConfig } from '../../shared/types';

/**
 * Resolved (defaults applied) snapshot of the global `AppConfig.browserAutomation`
 * policy. Read live at each MCP tool call so a Settings toggle takes effect
 * immediately, mirroring how the dev inspection bridge live-reads its eval gate.
 */
export interface ResolvedBrowserAutomationConfig {
  enabled: boolean;
  allowInteraction: boolean;
  allowNavigation: boolean;
  allowEval: boolean;
  restrictNavigationToLocalhost: boolean;
}

/**
 * Apply the defaults to a stored `browserAutomation` block. Defaults:
 * everything on except eval (off) and the localhost-navigation restriction
 * (off, i.e. any http(s) is allowed). A stored value always wins. These
 * defaults live here and NOT in DEFAULT_CONFIG, so this pure resolver is the
 * single source for them: the MCP gate reads it through
 * readBrowserAutomationConfig, and the settings_snapshot analytics event
 * reads it directly to decide what counts as a deviation.
 */
export function resolveBrowserAutomationConfig(
  stored: AppConfig['browserAutomation'] | undefined,
): ResolvedBrowserAutomationConfig {
  return {
    enabled: stored?.enabled ?? true,
    allowInteraction: stored?.allowInteraction ?? true,
    allowNavigation: stored?.allowNavigation ?? true,
    allowEval: stored?.allowEval ?? false,
    restrictNavigationToLocalhost: stored?.restrictNavigationToLocalhost ?? false,
  };
}

/**
 * Read the global browser-automation policy with defaults applied. Never
 * throws.
 */
export function readBrowserAutomationConfig(
  configManager: ConfigManager,
): ResolvedBrowserAutomationConfig {
  let stored: ReturnType<ConfigManager['load']>['browserAutomation'];
  try {
    stored = configManager.load().browserAutomation;
  } catch {
    stored = undefined;
  }
  return resolveBrowserAutomationConfig(stored);
}
