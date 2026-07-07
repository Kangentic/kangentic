import { Bug, FileText, AlertTriangle, Activity } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { Code, Description, GroupHeading, ToggleRow } from './dev-tab-primitives';
import { DevToolsSections } from '../../../../devtools/renderer/DevToolsSections';

/**
 * Global developer / diagnostic settings. Lives below the shared-settings
 * separator in `AppSettingsPanel.APP_TABS`. Always visible to all users.
 * Dev-only sections (preview inspection bridge, eval) live in
 * `src/devtools/renderer/DevToolsSections.tsx` and are rendered here only
 * when `__KANGENTIC_DEV__` is true at compile time.
 *
 * Each setting renders as a tight toggle row + a single 1-2 sentence
 * description. The verbose explanations that used to live here moved to
 * `docs/configuration.md` and the MCP tool descriptions; this surface is
 * for skim + flip-toggle, not learn-everything-about-each-flag.
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

  return (
    <div className="space-y-3">
      <GroupHeading>Diagnostics</GroupHeading>

      <section className="space-y-2">
        <ToggleRow
          icon={Bug}
          title="Activity Engine Debug Overlay"
          subtitle="Floating panel with live state per session"
          checked={overlayEnabled}
          onChange={(value) => updateGlobal({ developer: { activityDebugOverlay: value } })}
        />
        <KbdHint prefix="Toggle anywhere with" keys={['Ctrl', 'Shift', 'D']} />
        <Description>
          Shows current activity, dominant reason, counters, and the last 10 transitions per session.
          The overlay polls every 2s while open. Independently, with this on the engine writes a
          per-session snapshot to <Code>.kangentic/debug/&lt;sessionId&gt;.json</Code> on every state
          change for post-mortem reads.
        </Description>
      </section>

      <section className="space-y-2">
        <ToggleRow
          icon={FileText}
          title="Persistent Console Logs"
          subtitle="Capture info / debug / log output to .kangentic/logs/"
          checked={persistConsoleLogsEnabled}
          onChange={(value) => updateGlobal({ developer: { persistConsoleLogs: value } })}
        />
        <Description>
          Errors and warnings are <strong>always</strong> persisted; this toggle additionally captures
          info / debug / log levels. NDJSON, one file per day at{' '}
          <Code>.kangentic/logs/&lt;YYYY-MM-DD&gt;.log</Code>. Read via <Code>kangentic_tail_logs</Code>.
          {__KANGENTIC_DEV__ && ' On by default in dev builds (npm start / /preview) - the write path is async, so it has no measurable performance cost.'}
        </Description>
      </section>

      <section className="space-y-2">
        <ToggleRow
          icon={AlertTriangle}
          title="Crash Reports"
          subtitle="Always on - captures fatal errors and crash stacks"
          checked
          disabled
          onChange={() => {}}
        />
        <Description>
          Every uncaught exception, unhandled rejection, render-process-gone event, and preload error
          writes one record to <Code>.kangentic/logs/crashes/&lt;ts&gt;.json</Code> with timestamp, kind,
          source-mapped stack, and version info. Read via <Code>kangentic_get_recent_crashes</Code>.
        </Description>
      </section>

      <section className="space-y-2">
        <ToggleRow
          icon={Activity}
          title="Record IPC Traffic"
          subtitle="Log every IPC call to .kangentic/logs/ipc-<date>.jsonl"
          checked={recordIpcTrafficEnabled}
          onChange={(value) => updateGlobal({ developer: { recordIpcTraffic: value } })}
        />
        <Description>
          Records channel, args, result, durationMs, and any thrown errors. Mutating channels
          (settings writes, MCP config, attachments) are stored as{' '}
          <Code>{'{ redacted: true, channel }'}</Code> to keep secrets out of disk logs. Non-trivial
          disk impact, so it is off by default - except in <Code>/preview</Code>, where it defaults
          on since that instance's data (including its logs) is wiped on close. Read via{' '}
          <Code>kangentic_get_ipc_log</Code>.
        </Description>
      </section>

      {__KANGENTIC_DEV__ && <DevToolsSections globalConfig={globalConfig} />}
    </div>
  );
}

function KbdHint({ prefix, keys }: { prefix: string; keys: string[] }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-muted px-1">
      <span>{prefix}</span>
      {keys.map((key, index) => (
        <span key={key} className="flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 bg-surface-raised border border-edge rounded text-[11px] font-mono">
            {key}
          </kbd>
          {index < keys.length - 1 && <span className="text-fg-disabled">+</span>}
        </span>
      ))}
    </div>
  );
}
