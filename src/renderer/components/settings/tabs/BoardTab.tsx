import type { AppConfig } from '../../../../shared/types';
import { SectionHeader, SettingRow, SettingToggleRow, Select, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function BoardTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SettingRow {...settingProps('cardDensity')}>
        <Select
          value={globalConfig.cardDensity}
          onChange={(event) => updateGlobal({ cardDensity: event.target.value as AppConfig['cardDensity'] })}
        >
          <option value="compact">Compact</option>
          <option value="default">Default</option>
          <option value="comfortable">Comfortable</option>
        </Select>
      </SettingRow>
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
      <SettingToggleRow
        {...settingProps('showTaskNumbers')}
        checked={globalConfig.showTaskNumbers}
        onChange={(value) => updateGlobal({ showTaskNumbers: value })}
      />

      <SectionHeader label="Config Sync" searchIds={['skipBoardConfigConfirm']} />
      <SettingToggleRow
        {...settingProps('skipBoardConfigConfirm')}
        checked={globalConfig.skipBoardConfigConfirm}
        onChange={(value) => updateGlobal({ skipBoardConfigConfirm: value })}
      />

      <SectionHeader
        label="Window"
        searchIds={['terminalPanelVisible', 'statusBarVisible', 'animationsEnabled']}
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
      <SettingToggleRow
        {...settingProps('animationsEnabled')}
        checked={globalConfig.animationsEnabled}
        onChange={(value) => updateGlobal({ animationsEnabled: value })}
      />
    </>
  );
}
