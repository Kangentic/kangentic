import type { AppConfig } from '../../../../shared/types';
import { SectionHeader, SettingRow, SettingToggleRow, Select, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function BoardTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SettingRow {...settingProps('columnWidth')}>
        <Select
          value={globalConfig.columnWidth}
          onChange={(event) => updateGlobal({ columnWidth: event.target.value as AppConfig['columnWidth'] })}
        >
          <option value="narrow">Narrow</option>
          <option value="default">Default</option>
          <option value="wide">Wide</option>
        </Select>
      </SettingRow>

      <SectionHeader label="Config Sync" searchIds={['skipBoardConfigConfirm']} />
      <SettingToggleRow
        {...settingProps('skipBoardConfigConfirm')}
        checked={globalConfig.skipBoardConfigConfirm}
        onChange={(value) => updateGlobal({ skipBoardConfigConfirm: value })}
      />

      {/* Animations used to sit here. It moved to Performance: it toggles
          `.no-motion` on <html> (config-store.ts), so it was never board
          chrome, and it belongs beside graphics acceleration. */}
      <SectionHeader
        label="Window"
        searchIds={['terminalPanelVisible', 'statusBarVisible']}
      />
      <SettingToggleRow
        {...settingProps('terminalPanelVisible')}
        checked={globalConfig.terminalPanelVisible !== false}
        onChange={(value) => updateGlobal({ terminalPanelVisible: value })}
      />
      <SettingToggleRow
        {...settingProps('statusBarVisible')}
        checked={globalConfig.statusBarVisible !== false}
        onChange={(value) => updateGlobal({ statusBarVisible: value })}
      />
    </>
  );
}
