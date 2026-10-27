import { PanelBottom, SquareStack } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';

type ContextBarKey = keyof AppConfig['contextBar'];

/**
 * The context bar's optional stats, in the order they sit in the bar. Model
 * and Effort are intentionally NOT toggleable: those pills double as the
 * in-place model/effort picker triggers (clicking them opens a popover whose
 * pick restarts the task's session with the new value). Hiding them via
 * a toggle would silently disable that feature, not just declutter the chrome,
 * so they stay a permanent fixture of the context bar.
 */
const CONTEXT_BAR_STATS: ContextBarKey[] = [
  'showShell', 'showVersion', 'showElapsed', 'showCost', 'showToolCalls',
  'showAgentActive', 'showTokens', 'showContextFraction', 'showProgressBar', 'showRateLimits',
];

export function TaskTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<SquareStack size={16} />}
        label={t`Cards`}
        description={t`How much each task card shows on the board.`}
        searchIds={['cardDensity', 'cardPreview', 'showTaskNumbers']}
      >
        <CardChoiceRow
          {...settingProps('cardDensity')}
          options={[
            { value: 'compact', label: t({ message: 'Compact', context: 'card density' }) },
            { value: 'default', label: t({ message: 'Default', context: 'card density' }) },
            { value: 'comfortable', label: t({ message: 'Comfortable', context: 'card density' }) },
          ]}
          value={globalConfig.cardDensity}
          onChange={(value) => updateGlobal({ cardDensity: value })}
          testId="card-density-choice"
        />
        {/* One word each, so the three fit beside the label; each option's
            tooltip says what the card prints. */}
        <CardChoiceRow<AppConfig['cardPreview']>
          {...settingProps('cardPreview')}
          options={[
            { value: 'agent-latest-message', label: t({ message: 'Latest', context: 'card preview' }), tip: t`The agent's newest message` },
            { value: 'agent-messages', label: t({ message: 'Recent', context: 'card preview' }), tip: t`The agent's recent messages, one line each` },
            { value: 'description', label: t({ message: 'Description', context: 'card preview' }), tip: t`The task's description` },
          ]}
          value={globalConfig.cardPreview}
          onChange={(value) => updateGlobal({ cardPreview: value })}
          testId="card-preview-choice"
        />
        <CardToggleRow
          {...settingProps('showTaskNumbers')}
          checked={globalConfig.showTaskNumbers}
          onChange={(value) => updateGlobal({ showTaskNumbers: value })}
        />
      </SettingsCard>

      <SettingsCard
        icon={<PanelBottom size={16} />}
        label={t`Context bar`}
        description={t`Which stats show in the bar under a task's terminal.`}
        searchIds={CONTEXT_BAR_STATS.map((key) => `contextBar.${key}`)}
      >
        {CONTEXT_BAR_STATS.map((key) => (
          <CardToggleRow
            key={key}
            {...settingProps(`contextBar.${key}`)}
            checked={globalConfig.contextBar[key]}
            onChange={(value) => updateGlobal({ contextBar: { [key]: value } })}
          />
        ))}
      </SettingsCard>
    </div>
  );
}
