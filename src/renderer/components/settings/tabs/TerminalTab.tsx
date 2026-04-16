import type { AppConfig } from '../../../../shared/types';
import { DEFAULT_CONFIG } from '../../../../shared/types';
import { SectionHeader, SettingRow, Select, CompactToggleList, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function TerminalTab({ config, globalConfig, shells }: {
  config: AppConfig;
  globalConfig: AppConfig;
  shells: Array<{ name: string; path: string }>;
}) {
  const updateProject = useScopedUpdate('project');
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SettingRow {...settingProps('terminal.shell')}>
        <Select
          value={config.terminal.shell || ''}
          onChange={(event) => updateProject({ terminal: { shell: event.target.value || null } })}
        >
          <option value="">Auto-detect</option>
          {shells.map((shell) => (
            <option key={shell.path} value={shell.path}>{shell.name}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('terminal.fontSize')}>
        <input
          type="number"
          value={config.terminal.fontSize ?? DEFAULT_CONFIG.terminal.fontSize}
          onChange={(event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value);
            if (!Number.isNaN(value)) updateProject({ terminal: { fontSize: value } });
          }}
          min={8}
          max={32}
          placeholder={String(DEFAULT_CONFIG.terminal.fontSize)}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.fontFamily')}>
        <input
          type="text"
          value={config.terminal.fontFamily ?? ''}
          onChange={(event) => updateProject({ terminal: { fontFamily: event.target.value } })}
          placeholder={DEFAULT_CONFIG.terminal.fontFamily}
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.scrollbackLines')}>
        <input
          type="number"
          value={config.terminal.scrollbackLines ?? DEFAULT_CONFIG.terminal.scrollbackLines}
          onChange={(event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value);
            if (!Number.isNaN(value)) updateProject({ terminal: { scrollbackLines: value } });
          }}
          min={1000}
          max={100000}
          step={1000}
          placeholder={String(DEFAULT_CONFIG.terminal.scrollbackLines)}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.cursorStyle')}>
        <Select
          value={config.terminal.cursorStyle}
          onChange={(event) => updateProject({ terminal: { cursorStyle: event.target.value as 'block' | 'underline' | 'bar' } })}
        >
          <option value="block">Block</option>
          <option value="underline">Underline</option>
          <option value="bar">Bar</option>
        </Select>
      </SettingRow>

      <SectionHeader
        label="Context Bar"
        searchIds={[
          'contextBar.showShell', 'contextBar.showVersion', 'contextBar.showModel',
          'contextBar.showCost', 'contextBar.showTokens', 'contextBar.showContextFraction',
          'contextBar.showProgressBar', 'contextBar.showRateLimits',
        ]}
      />
      <CompactToggleList items={[
        { label: 'Shell', description: 'Detected shell name', checked: globalConfig.contextBar.showShell, onChange: (value) => updateGlobal({ contextBar: { showShell: value } }), searchId: 'contextBar.showShell' },
        { label: 'Version', description: 'Agent CLI version', checked: globalConfig.contextBar.showVersion, onChange: (value) => updateGlobal({ contextBar: { showVersion: value } }), searchId: 'contextBar.showVersion' },
        { label: 'Model', description: 'Active model name', checked: globalConfig.contextBar.showModel, onChange: (value) => updateGlobal({ contextBar: { showModel: value } }), searchId: 'contextBar.showModel' },
        { label: 'Cost', description: 'Session API cost', checked: globalConfig.contextBar.showCost, onChange: (value) => updateGlobal({ contextBar: { showCost: value } }), searchId: 'contextBar.showCost' },
        { label: 'Token Counts', description: 'Input / output totals', checked: globalConfig.contextBar.showTokens, onChange: (value) => updateGlobal({ contextBar: { showTokens: value } }), searchId: 'contextBar.showTokens' },
        { label: 'Context Window', description: 'Used / total tokens', checked: globalConfig.contextBar.showContextFraction, onChange: (value) => updateGlobal({ contextBar: { showContextFraction: value } }), searchId: 'contextBar.showContextFraction' },
        { label: 'Progress Bar', description: 'Usage bar and percentage', checked: globalConfig.contextBar.showProgressBar, onChange: (value) => updateGlobal({ contextBar: { showProgressBar: value } }), searchId: 'contextBar.showProgressBar' },
        { label: 'Rate Limits', description: 'Claude 5h / weekly quota bars', checked: globalConfig.contextBar.showRateLimits, onChange: (value) => updateGlobal({ contextBar: { showRateLimits: value } }), searchId: 'contextBar.showRateLimits' },
      ]} />
    </>
  );
}
