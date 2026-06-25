import type { ConfigManager } from '../config/config-manager';

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
 * Read the global browser-automation policy. Defaults: everything on except
 * eval (off) and the localhost-navigation restriction (off, i.e. any http(s)
 * is allowed). A stored value always wins. Never throws.
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
  return {
    enabled: stored?.enabled ?? true,
    allowInteraction: stored?.allowInteraction ?? true,
    allowNavigation: stored?.allowNavigation ?? true,
    allowEval: stored?.allowEval ?? false,
    restrictNavigationToLocalhost: stored?.restrictNavigationToLocalhost ?? false,
  };
}
