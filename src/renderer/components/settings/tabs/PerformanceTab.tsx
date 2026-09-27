import { Gauge, TriangleAlert } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow, CardTile } from '../settings-card';
import { settingProps } from '../settings-registry';

/**
 * Chromium rendering and app-wide motion.
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
            notices first. */}
        <CardToggleRow
          {...settingProps('graphicsAccelerationEnabled')}
          checked={globalConfig.graphicsAccelerationEnabled}
          onChange={(value) =>
            updateGlobal({
              graphicsAccelerationEnabled: value,
              // Whatever the user picks is now THEIR choice, including turning
              // it off themselves. That is what stops a later GPU failure
              // overwriting it, and what hides the callout below.
              graphicsAccelerationOffBy: value ? null : 'user',
            })
          }
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
    </div>
  );
}
