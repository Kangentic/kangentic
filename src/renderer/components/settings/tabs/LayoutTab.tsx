import type { AppConfig } from '../../../../shared/types';
import { SettingRow, Select, ToggleSwitch, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function LayoutTab({ globalConfig }: { globalConfig: AppConfig }) {
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
      <SettingRow {...settingProps('terminalPanelVisible')}>
        <ToggleSwitch
          checked={globalConfig.terminalPanelVisible !== false}
          onChange={(value) => updateGlobal({ terminalPanelVisible: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('statusBarVisible')}>
        <ToggleSwitch
          checked={globalConfig.statusBarVisible !== false}
          onChange={(value) => updateGlobal({ statusBarVisible: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('showBoardSearch')}>
        <ToggleSwitch
          checked={globalConfig.showBoardSearch}
          onChange={(value) => updateGlobal({ showBoardSearch: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('restoreWindowPosition')}>
        <ToggleSwitch
          checked={globalConfig.restoreWindowPosition}
          onChange={(value) => updateGlobal({ restoreWindowPosition: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('animationsEnabled')}>
        <ToggleSwitch
          checked={globalConfig.animationsEnabled}
          onChange={(value) => updateGlobal({ animationsEnabled: value })}
        />
      </SettingRow>
    </>
  );
}
