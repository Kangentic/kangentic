import type { AppConfig, WindowLightDismiss } from '../../../../shared/types';
import { SectionHeader, SettingRow, SettingToggleRow, Select, INPUT_CLASS, useScopedUpdate } from '../shared';
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
      <SettingToggleRow
        {...settingProps('autoFocusIdleSession')}
        checked={globalConfig.autoFocusIdleSession}
        onChange={(value) => updateGlobal({ autoFocusIdleSession: value })}
      />
      <SettingToggleRow
        {...settingProps('agent.autoResumeSessionsOnRestart')}
        checked={globalConfig.agent.autoResumeSessionsOnRestart}
        onChange={(value) => updateGlobal({ agent: { autoResumeSessionsOnRestart: value } })}
      />

      <SectionHeader label="Task Windows" searchIds={['windowLightDismiss']} />
      <SettingRow {...settingProps('windowLightDismiss')}>
        <Select
          value={globalConfig.windowLightDismiss}
          onChange={(event) => updateGlobal({ windowLightDismiss: event.target.value as WindowLightDismiss })}
        >
          <option value="off">Off</option>
          <option value="single">Single Window</option>
          <option value="focused">Focused Window</option>
          <option value="all">All Windows</option>
        </Select>
      </SettingRow>
    </>
  );
}
