import { Bug } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow, SettingTag } from '../settings-card';
import { settingProps } from '../settings-registry';
import { effectiveCombo } from '../../../../shared/keybindings';
import { formatCombo } from '../../../utils/keybindings';
import { DevToolsSections } from '../../../../devtools/renderer/DevToolsSections';

/**
 * Global developer / diagnostic settings. Lives below the shared-settings
 * separator in `AppSettingsPanel.APP_TABS`. Always visible to all users.
 * Dev-only sections (preview inspection bridge, eval) live in
 * `src/devtools/renderer/DevToolsSections.tsx` and are rendered here only
 * when `__KANGENTIC_DEV__` is true at compile time.
 *
 * One card of switches, each explained in its info tooltip. The verbose
 * explanations live in `docs/configuration.md` and the MCP tool descriptions;
 * this surface is for skim + flip-toggle, not learn-everything-about-each-flag.
 */
export function DeveloperTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const developerConfig = globalConfig.developer ?? {};
  const overlayEnabled = developerConfig.activityDebugOverlay === true;
  // Defaults ON in any dev build when the user has never touched the toggle
  // (mirrors the Inspection Bridge / Allow Unsafe Operations default in
  // DevToolsSections.tsx). `??` only falls through on null/undefined, so an
  // explicit stored `false` is respected. Off (both `??` operands false) in
  // production builds. Mirror of `safeReadDeveloperFlag` in src/main/index.ts
  // so the displayed toggle state matches the actual persistence behavior.
  const persistConsoleLogsEnabled = developerConfig.persistConsoleLogs ?? __KANGENTIC_DEV__;
  // Narrower than persistConsoleLogs: the IPC recorder has a real disk-I/O cost,
  // so it defaults on only for the ephemeral /preview instance (wiped on close,
  // bounding growth), not the long-running npm start dogfooding session.
  const recordIpcTrafficEnabled =
    developerConfig.recordIpcTraffic ?? (__KANGENTIC_DEV__ && window.electronAPI.dev?.isEphemeralPreview === true);
  // Read from the registry, so it says Cmd on macOS and follows a rebind.
  const overlayCombo = effectiveCombo('debug.toggleOverlay', globalConfig.hotkeyOverrides);

  return (
    <div className="space-y-4" data-testid="developer-tab">
      <SettingsCard
        icon={<Bug size={16} />}
        label="Diagnostics"
        description="Debug overlays and logs for diagnosing sessions."
        searchIds={['developer.activityDebugOverlay', 'developer.persistConsoleLogs', 'developer.crashReports', 'developer.recordIpcTraffic']}
      >
        <CardToggleRow
          {...settingProps('developer.activityDebugOverlay')}
          labelTrailing={overlayCombo ? <SettingTag>{formatCombo(overlayCombo)}</SettingTag> : undefined}
          checked={overlayEnabled}
          onChange={(value) => updateGlobal({ developer: { activityDebugOverlay: value } })}
        />
        <CardToggleRow
          {...settingProps('developer.persistConsoleLogs')}
          checked={persistConsoleLogsEnabled}
          onChange={(value) => updateGlobal({ developer: { persistConsoleLogs: value } })}
        />
        <CardToggleRow
          {...settingProps('developer.crashReports')}
          checked
          disabled
          onChange={() => {}}
        />
        <CardToggleRow
          {...settingProps('developer.recordIpcTraffic')}
          checked={recordIpcTrafficEnabled}
          onChange={(value) => updateGlobal({ developer: { recordIpcTraffic: value } })}
        />
      </SettingsCard>

      {__KANGENTIC_DEV__ && <DevToolsSections globalConfig={globalConfig} />}
    </div>
  );
}
