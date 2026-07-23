import type { AppConfig } from '../../../../shared/types';
import { SettingRow, SettingToggleRow, Select, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function ChangesTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
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
