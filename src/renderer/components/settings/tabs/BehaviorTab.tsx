import type { AppConfig } from '../../../../shared/types';
import { SectionHeader, SettingRow, Select, ToggleSwitch, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function BehaviorTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SectionHeader
        label="Session Limits"
        searchIds={['agent.maxConcurrentSessions', 'agent.queueOverflow']}
      />
      <SettingRow {...settingProps('agent.maxConcurrentSessions')}>
        <input
          type="number"
          value={globalConfig.agent.maxConcurrentSessions}
          onChange={(event) => updateGlobal({ agent: { maxConcurrentSessions: Number(event.target.value) } })}
          min={1}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('agent.queueOverflow')}>
        <Select
          value={globalConfig.agent.queueOverflow}
          onChange={(event) => updateGlobal({ agent: { queueOverflow: event.target.value as 'queue' | 'reject' } })}
        >
          <option value="queue">Queue</option>
          <option value="reject">Reject</option>
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('autoFocusIdleSession')}>
        <ToggleSwitch
          checked={globalConfig.autoFocusIdleSession}
          onChange={(value) => updateGlobal({ autoFocusIdleSession: value })}
        />
      </SettingRow>
      <SettingRow {...settingProps('agent.autoResumeSessionsOnRestart')}>
        <ToggleSwitch
          checked={globalConfig.agent.autoResumeSessionsOnRestart}
          onChange={(value) => updateGlobal({ agent: { autoResumeSessionsOnRestart: value } })}
        />
      </SettingRow>
    </>
  );
}
