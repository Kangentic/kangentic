import { LayoutGrid, RefreshCw } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardToggleRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';

export function BoardTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <div className="space-y-4">
      {/* Animations used to sit here. It moved to Performance: it toggles
          `.no-motion` on <html> (config-store.ts), so it was never board
          chrome, and it belongs beside graphics acceleration. */}
      <SettingsCard
        icon={<LayoutGrid size={16} />}
        label="Board layout"
        description="Column width and which panels show around the board."
        searchIds={['columnWidth', 'terminalPanelVisible', 'statusBarVisible']}
      >
        <CardChoiceRow
          {...settingProps('columnWidth')}
          options={[
            { value: 'narrow', label: 'Narrow' },
            { value: 'default', label: 'Default' },
            { value: 'wide', label: 'Wide' },
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
        label="Config sync"
        description="How changes to the shared board config are applied."
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
