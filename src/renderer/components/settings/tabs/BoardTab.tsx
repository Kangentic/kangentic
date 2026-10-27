import { LayoutGrid, RefreshCw } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';

export function BoardTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  return (
    <div className="space-y-4">
      {/* Animations used to sit here. It moved to Performance: it toggles
          `.no-motion` on <html> (config-store.ts), so it was never board
          chrome, and it belongs beside graphics acceleration. */}
      <SettingsCard
        icon={<LayoutGrid size={16} />}
        label={t`Board layout`}
        description={t`Column width and which panels show around the board.`}
        searchIds={['columnWidth', 'terminalPanelVisible', 'statusBarVisible']}
      >
        <CardChoiceRow
          {...settingProps('columnWidth')}
          options={[
            { value: 'narrow', label: t({ message: 'Narrow', context: 'column width' }) },
            { value: 'default', label: t({ message: 'Default', context: 'column width' }) },
            { value: 'wide', label: t({ message: 'Wide', context: 'column width' }) },
          ]}
          value={globalConfig.columnWidth}
          onChange={(value) => updateGlobal({ columnWidth: value })}
          testId="column-width-choice"
        />
        <CardToggleRow
          {...settingProps('terminalPanelVisible')}
          checked={globalConfig.terminalPanelVisible !== false}
          onChange={(value) => updateGlobal({ terminalPanelVisible: value })}
        />
        <CardToggleRow
          {...settingProps('statusBarVisible')}
          checked={globalConfig.statusBarVisible !== false}
          onChange={(value) => updateGlobal({ statusBarVisible: value })}
        />
      </SettingsCard>

      <SettingsCard
        icon={<RefreshCw size={16} />}
        label={t`Config sync`}
        description={t`How changes to the shared board config are applied.`}
        searchIds={['skipBoardConfigConfirm']}
      >
        <CardToggleRow
          {...settingProps('skipBoardConfigConfirm')}
          checked={globalConfig.skipBoardConfigConfirm}
          onChange={(value) => updateGlobal({ skipBoardConfigConfirm: value })}
        />
      </SettingsCard>
    </div>
  );
}
