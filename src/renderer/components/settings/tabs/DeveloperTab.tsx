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
        searchIds={['developer.activityDebugOverlay']}
      >
        <CardToggleRow
          {...settingProps('developer.activityDebugOverlay')}
          description={
            'A floating panel with each session\'s current activity, dominant reason, counters and last '
            + '10 transitions, polled every 2s. With it on, the engine also writes a snapshot to '
            + '.kangentic/debug/<sessionId>.json on every state change.'
          }
          labelTrailing={overlayCombo ? <SettingTag>{formatCombo(overlayCombo)}</SettingTag> : undefined}
          checked={overlayEnabled}
          onChange={(value) => updateGlobal({ developer: { activityDebugOverlay: value } })}
        />
        <CardToggleRow
          label="Persistent console logs"
          description={
            'Errors and warnings are always saved; this also captures info, debug and log output, as NDJSON, '
            + 'to .kangentic/logs/<YYYY-MM-DD>.log. Read it with kangentic_tail_logs.'
            + (__KANGENTIC_DEV__ ? ' On by default in dev builds; the write path is async, so it costs nothing measurable.' : '')
          }
          checked={persistConsoleLogsEnabled}
          onChange={(value) => updateGlobal({ developer: { persistConsoleLogs: value } })}
        />
        <CardToggleRow
          label="Crash reports"
          description={
            'Always on. Every uncaught exception, unhandled rejection, renderer or GPU crash and preload error '
            + 'writes a record with its source-mapped stack to .kangentic/logs/crashes/. Read them with '
            + 'kangentic_get_recent_crashes.'
          }
          checked
          disabled
          onChange={() => {}}
        />
        <CardToggleRow
          label="Record IPC traffic"
          description={
            'Logs every IPC call\'s channel, arguments, result and duration to .kangentic/logs/ipc-<date>.jsonl, '
            + 'with mutating channels redacted. Off by default except in /preview, whose logs are wiped on close. '
            + 'Read it with kangentic_get_ipc_log.'
          }
          checked={recordIpcTrafficEnabled}
          onChange={(value) => updateGlobal({ developer: { recordIpcTraffic: value } })}
        />
      </SettingsCard>

      {__KANGENTIC_DEV__ && <DevToolsSections globalConfig={globalConfig} />}
    </div>
  );
}
