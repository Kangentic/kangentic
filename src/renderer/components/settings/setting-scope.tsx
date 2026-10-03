import { createContext, useCallback, useContext } from 'react';
import type { AppConfig, DeepPartial } from '../../../shared/types';

/**
 * Determines how a setting is saved:
 *
 * - `'project'` -- Saved to project overrides (per-project config).
 * - `'global'` -- Saved to the global config (shared across all projects).
 */
export type SettingScope = 'global' | 'project';

interface SettingsPanelContextValue {
  /** Dispatch a config update. Scope determines the target:
   *  - `'project'` -> saves to the override file of the project the panel is
   *    editing, or of `projectPath` when given (see `updateProjectOverride`).
   *  - `'global'` -> saves to the global config, and ignores `projectPath`. */
  updateSetting: (partial: DeepPartial<AppConfig>, scope: SettingScope, projectPath?: string) => void;
}

const SettingsPanelContext = createContext<SettingsPanelContextValue>({
  updateSetting: () => {},
});

export const SettingsPanelProvider = SettingsPanelContext.Provider;

/** Returns a scoped update handler. Call with a config partial to dispatch
 *  to the correct handler automatically. A project-scoped handler that awaits
 *  before it writes passes the project's path, captured at the gesture. */
export function useScopedUpdate(scope: SettingScope) {
  const { updateSetting } = useContext(SettingsPanelContext);
  return useCallback(
    (partial: DeepPartial<AppConfig>, projectPath?: string) => updateSetting(partial, scope, projectPath),
    [updateSetting, scope],
  );
}
