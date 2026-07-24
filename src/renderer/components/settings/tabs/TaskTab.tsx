import type { AppConfig } from '../../../../shared/types';
import { SectionHeader, SettingRow, SettingToggleRow, Select, CompactToggleList, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function TaskTab({ globalConfig }: { globalConfig: AppConfig }) {
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
      <SettingToggleRow
        {...settingProps('showTaskNumbers')}
        checked={globalConfig.showTaskNumbers}
        onChange={(value) => updateGlobal({ showTaskNumbers: value })}
      />

      <SectionHeader
        label="Context Bar"
        searchIds={[
          'contextBar.showShell', 'contextBar.showVersion', 'contextBar.showElapsed',
          'contextBar.showCost', 'contextBar.showToolCalls', 'contextBar.showAgentActive', 'contextBar.showTokens',
          'contextBar.showContextFraction', 'contextBar.showProgressBar', 'contextBar.showRateLimits',
        ]}
      />
      {/*
        Model and Effort are intentionally NOT toggleable. Those pills double
        as the in-place model/effort picker triggers (clicking them opens a
        popover that lets the user switch models/effort live without restarting
        the session). Hiding them via toggle would silently disable that
        feature, not just declutter the chrome - so they stay a permanent
        fixture of the context bar.
      */}
      <CompactToggleList items={[
        { label: 'Shell Name', description: 'Detected shell name', checked: globalConfig.contextBar.showShell, onChange: (value) => updateGlobal({ contextBar: { showShell: value } }), searchId: 'contextBar.showShell' },
        { label: 'Version', description: 'Agent CLI version', checked: globalConfig.contextBar.showVersion, onChange: (value) => updateGlobal({ contextBar: { showVersion: value } }), searchId: 'contextBar.showVersion' },
        { label: 'Elapsed Time', description: 'Ticking session duration', checked: globalConfig.contextBar.showElapsed, onChange: (value) => updateGlobal({ contextBar: { showElapsed: value } }), searchId: 'contextBar.showElapsed' },
        { label: 'Cost', description: 'Session API cost', checked: globalConfig.contextBar.showCost, onChange: (value) => updateGlobal({ contextBar: { showCost: value } }), searchId: 'contextBar.showCost' },
        { label: 'Tool Calls', description: 'Cumulative tool invocations', checked: globalConfig.contextBar.showToolCalls, onChange: (value) => updateGlobal({ contextBar: { showToolCalls: value } }), searchId: 'contextBar.showToolCalls' },
        { label: 'Agent Active', description: 'Agent active time', checked: globalConfig.contextBar.showAgentActive, onChange: (value) => updateGlobal({ contextBar: { showAgentActive: value } }), searchId: 'contextBar.showAgentActive' },
        { label: 'Token Counts', description: 'Input / output totals', checked: globalConfig.contextBar.showTokens, onChange: (value) => updateGlobal({ contextBar: { showTokens: value } }), searchId: 'contextBar.showTokens' },
        { label: 'Context Window', description: 'Used / total tokens', checked: globalConfig.contextBar.showContextFraction, onChange: (value) => updateGlobal({ contextBar: { showContextFraction: value } }), searchId: 'contextBar.showContextFraction' },
        { label: 'Progress Bar', description: 'Usage bar and percentage', checked: globalConfig.contextBar.showProgressBar, onChange: (value) => updateGlobal({ contextBar: { showProgressBar: value } }), searchId: 'contextBar.showProgressBar' },
        { label: 'Rate Limits', description: 'Claude 5h / weekly quota bars', checked: globalConfig.contextBar.showRateLimits, onChange: (value) => updateGlobal({ contextBar: { showRateLimits: value } }), searchId: 'contextBar.showRateLimits' },
      ]} />
    </>
  );
}
