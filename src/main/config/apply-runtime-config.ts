import type { SessionManager } from '../pty/session-manager';
import type { ConfigManager } from './config-manager';
import { notifyDevtoolsRefresh } from '../../devtools/install';

/**
 * Push the effective config for `projectPath` into all in-memory services
 * that cache config-derived state. This is the SINGLE place to update when a
 * new runtime-effective setting is added - every IPC handler that mutates
 * config (`config:set`, `config:setProject`, `config:setProjectByPath`,
 * `config:syncDefaultToProjects`) and every project-open path calls this so
 * the running app never lags the config file on disk.
 *
 * Pass `null` for `projectPath` for project-agnostic global updates - the
 * effective config falls back to the global file in that case.
 */
export function applyRuntimeConfig(
  sessionManager: SessionManager,
  configManager: ConfigManager,
  projectPath: string | null,
): void {
  const effective = configManager.getEffectiveConfig(projectPath || undefined);
  sessionManager.setMaxConcurrent(effective.agent.maxConcurrentSessions);
  sessionManager.setShell(effective.terminal.shell);
  sessionManager.setIdleTimeout(effective.agent.idleTimeoutMinutes);

  // Hydrate the accumulator's known context windows from persisted metrics so
  // a parked/background card shows a correct percentage on the board without
  // ever needing to be opened this run. The window is a model+account
  // constant (not agent-specific), so this flattens across every agent's
  // discovered windows rather than branching on agent name.
  const contextWindowEntries: Array<{ modelId: string; contextWindowSize: number }> = [];
  for (const byModel of Object.values(effective.discoveredContextWindowsByAgent ?? {})) {
    for (const [modelId, contextWindowSize] of Object.entries(byModel)) {
      contextWindowEntries.push({ modelId, contextWindowSize });
    }
  }
  sessionManager.hydrateDiscoveredContextWindows(contextWindowEntries);

  // Dev-only: re-evaluate whether the localhost inspection bridge should
  // be running. This fires from PROJECT_OPEN (so the bridge starts after
  // the IPC context is live), CONFIG_SET (so toggling
  // `developer.previewInspectionServer` takes effect without restart), and
  // every other path that calls applyRuntimeConfig. Production builds drop
  // both the import and this call via __KANGENTIC_DEV__ dead-code
  // elimination.
  if (__KANGENTIC_DEV__) {
    notifyDevtoolsRefresh();
  }
}
