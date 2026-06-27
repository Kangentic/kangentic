import type { AppConfig } from '../../../../shared/types';
import { SectionHeader, SettingRow, SettingToggleRow, Select, useScopedUpdate } from '../shared';
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
      <SettingToggleRow
        {...settingProps('showTaskNumbers')}
        checked={globalConfig.showTaskNumbers}
        onChange={(value) => updateGlobal({ showTaskNumbers: value })}
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
        {...settingProps('restoreWindowPosition')}
        checked={globalConfig.restoreWindowPosition}
        onChange={(value) => updateGlobal({ restoreWindowPosition: value })}
      />
      <SettingToggleRow
        {...settingProps('animationsEnabled')}
        checked={globalConfig.animationsEnabled}
        onChange={(value) => updateGlobal({ animationsEnabled: value })}
      />

      <SectionHeader label="Diff" searchIds={['diffViewMode', 'diffDefaultScope', 'diffIgnoreWhitespace', 'diffCollapseUnchanged', 'diffFileSort', 'diffFlatList']} />
      <SettingRow {...settingProps('diffViewMode')}>
        <Select
          value={globalConfig.diffViewMode}
          onChange={(event) => updateGlobal({ diffViewMode: event.target.value as AppConfig['diffViewMode'] })}
        >
          <option value="split">Side by side</option>
          <option value="inline">Inline</option>
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('diffDefaultScope')}>
        <Select
          value={globalConfig.diffDefaultScope}
          onChange={(event) => updateGlobal({ diffDefaultScope: event.target.value as AppConfig['diffDefaultScope'] })}
        >
          <option value="working">Working</option>
          <option value="staged">Staged</option>
          <option value="branch">Branch</option>
        </Select>
      </SettingRow>
      <SettingToggleRow
        {...settingProps('diffIgnoreWhitespace')}
        checked={globalConfig.diffIgnoreWhitespace}
        onChange={(value) => updateGlobal({ diffIgnoreWhitespace: value })}
      />
      <SettingToggleRow
        {...settingProps('diffCollapseUnchanged')}
        checked={globalConfig.diffCollapseUnchanged}
        onChange={(value) => updateGlobal({ diffCollapseUnchanged: value })}
      />
      <SettingRow {...settingProps('diffFileSort')}>
        <Select
          value={globalConfig.diffFileSort}
          onChange={(event) => updateGlobal({ diffFileSort: event.target.value as AppConfig['diffFileSort'] })}
        >
          <option value="name">Name</option>
          <option value="status">Status</option>
          <option value="size">Size</option>
        </Select>
      </SettingRow>
      <SettingToggleRow
        {...settingProps('diffFlatList')}
        checked={globalConfig.diffFlatList}
        onChange={(value) => updateGlobal({ diffFlatList: value })}
      />
    </>
  );
}
