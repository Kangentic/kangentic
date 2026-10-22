import { useRef, useState } from 'react';
import { CirclePause, Gauge, RotateCw, TriangleAlert } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow, CardTile } from '../settings-card';
import { settingProps } from '../settings-registry';
import { NumberStepper } from '../../NumberStepper';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { useToastStore } from '../../../stores/toast-store';
import { useConfigStore } from '../../../stores/config-store';

/**
 * Chromium rendering and app-wide motion, and when Kangentic pauses agents
 * that are waiting on the user (low memory, the idle timer): both are about
 * what the app costs the machine.
 *
 * Both rows arrived here rather than being invented here. Animations toggles
 * `.no-motion` on <html> but sat under Board > Window; graphics acceleration
 * is new, and Behavior (the only other candidate) is a bucket name rather
 * than a claim about what it holds.
 *
 * Memory's "Model acceleration" deliberately did NOT move here, even though
 * it is also a hardware choice: it is the other half of the same
 * speed-versus-accuracy decision as Search quality, and splitting that pair
 * to group the word "acceleration" would trade a real relationship for a
 * verbal one.
 */
export function PerformanceTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const turnedOffByApp =
    !globalConfig.graphicsAccelerationEnabled && globalConfig.graphicsAccelerationOffBy === 'app';
  // The value the user asked for, held until they confirm the restart. The
  // switch stays bound to the SAVED value, so Cancel snaps it back by simply
  // clearing this.
  const [pendingGraphicsAcceleration, setPendingGraphicsAcceleration] = useState<boolean | null>(null);
  // ConfirmDialog confirms on Enter, so a second press before the dialog
  // closes would ask main to save and restart twice.
  const restartInFlightRef = useRef(false);

  const confirmGraphicsRestart = async (enabled: boolean) => {
    if (restartInFlightRef.current) return;
    restartInFlightRef.current = true;
    try {
      await window.electronAPI.gpuHealth.setAccelerationAndRestart(enabled);
      // Main saved the setting and is quitting. Re-read it so the switch
      // shows the saved value for the moment the window is still up.
      void useConfigStore.getState().loadConfig();
    } catch (error) {
      // The toast says what to do; the reason goes to the log.
      console.error('Graphics acceleration restart failed:', error);
      useToastStore.getState().addToast({
        title: "Couldn't restart",
        message: 'Restart Kangentic to apply the change.',
        variant: 'error',
      });
    } finally {
      restartInFlightRef.current = false;
      setPendingGraphicsAcceleration(null);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<Gauge size={16} />}
        label="Rendering"
        description="Hardware rendering and motion across the whole app."
        searchIds={['graphicsAccelerationEnabled', 'animationsEnabled']}
      >
        {/* A toggle, not a two-option dropdown. The value is genuinely binary,
            and Animations below it is the same shape of setting - rendering one
            as a select and the other as a switch is the inconsistency a user
            notices first.

            It saves nothing on its own. The graphics mode is chosen before the
            app is ready and cannot change while it runs, so a change goes
            through the restart dialog below, and main saves it and restarts in
            one call. Whatever the user picks there becomes THEIR choice,
            including off (`graphicsAccelerationOffBy: 'user'`), which is what
            stops a later GPU failure overwriting it and hides the callout. */}
        <CardToggleRow
          {...settingProps('graphicsAccelerationEnabled')}
          checked={globalConfig.graphicsAccelerationEnabled}
          onChange={(value) => setPendingGraphicsAcceleration(value)}
        />

        {/* Shown only when KANGENTIC turned it off, never when the user did.
            One line, one state: no failure count, no date, no adapter. All
            three are evidence for us rather than guidance for the reader, and
            they go to Sentry instead (src/main/diagnostics/gpu-health.ts).
            "failures" rather than "graphics failures" because the row directly
            above already says Graphics acceleration. */}
        {turnedOffByApp && (
          <CardTile className="flex items-start gap-2.5" testId="graphics-acceleration-notice">
            <TriangleAlert size={16} className="text-warning mt-0.5 flex-shrink-0" />
            <p className="text-sm text-fg-muted">Kangentic turned this off after repeated failures.</p>
          </CardTile>
        )}

        <CardToggleRow
          {...settingProps('animationsEnabled')}
          checked={globalConfig.animationsEnabled}
          onChange={(value) => updateGlobal({ animationsEnabled: value })}
        />
      </SettingsCard>

      {/* Both pauses hold: a paused agent stays paused, across a restart too,
          until the user resumes it. Every platform: each reads its own memory
          signal (src/main/diagnostics/host-memory.ts), so the copy names none.
          The minutes are When idle's own value, so they share its tile on a
          second line rather than a row of their own, and show only while it
          is on. */}
      <SettingsCard
        icon={<CirclePause size={16} />}
        label="Pausing agents"
        description="When Kangentic pauses agents that are waiting on you."
        searchIds={['agent.pauseIdleAgentsOnLowMemory', 'agent.idleTimeoutEnabled', 'agent.idleTimeoutMinutes']}
        testId="settings-card-pausing-agents"
      >
        <CardToggleRow
          {...settingProps('agent.pauseIdleAgentsOnLowMemory')}
          checked={globalConfig.agent.pauseIdleAgentsOnLowMemory}
          onChange={(value) => updateGlobal({ agent: { pauseIdleAgentsOnLowMemory: value } })}
        />
        <CardToggleRow
          {...settingProps('agent.idleTimeoutEnabled')}
          checked={globalConfig.agent.idleTimeoutEnabled}
          onChange={(value) => updateGlobal({ agent: { idleTimeoutEnabled: value } })}
          attached={globalConfig.agent.idleTimeoutEnabled ? {
            label: settingProps('agent.idleTimeoutMinutes').label,
            searchId: 'agent.idleTimeoutMinutes',
            control: (
              <NumberStepper
                value={globalConfig.agent.idleTimeoutMinutes}
                onChange={(value) => updateGlobal({ agent: { idleTimeoutMinutes: value } })}
                min={1}
                max={240}
                ariaLabel={settingProps('agent.idleTimeoutMinutes').label}
                testId="idle-timeout-minutes"
              />
            ),
          } : undefined}
        />
      </SettingsCard>

      {pendingGraphicsAcceleration !== null && (
        <ConfirmDialog
          testId="graphics-restart-confirm"
          // A restart, not a warning, so not the default warning triangle.
          icon={<RotateCw size={16} className="text-accent-fg" />}
          title={pendingGraphicsAcceleration
            ? 'Restart with graphics acceleration?'
            : 'Restart without graphics acceleration?'}
          message="Kangentic restarts to apply this. Running agents are suspended and resume after the restart."
          confirmLabel="Restart now"
          onConfirm={() => { void confirmGraphicsRestart(pendingGraphicsAcceleration); }}
          onCancel={() => setPendingGraphicsAcceleration(null)}
        />
      )}
    </div>
  );
}
