import { AppWindow, Bot } from 'lucide-react';
import type { AppConfig, WindowLightDismiss } from '../../../../shared/types';
import { INPUT_CLASS, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardToggleRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';

export function BehaviorTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<Bot size={16} />}
        label="Sessions"
        description="How many agents run at once and what happens when idle."
        searchIds={['agent.maxConcurrentSessions', 'agent.queueOverflow', 'autoFocusIdleSession', 'agent.autoResumeSessionsOnRestart', 'agent.idleTimeoutMinutes', 'stopLeftoverProcesses']}
      >
        <CardRow {...settingProps('agent.maxConcurrentSessions')}>
          <input
            type="number"
            value={globalConfig.agent.maxConcurrentSessions}
            onChange={(event) => updateGlobal({ agent: { maxConcurrentSessions: Number(event.target.value) } })}
            min={1}
            className={INPUT_CLASS}
          />
        </CardRow>
        <CardChoiceRow
          {...settingProps('agent.queueOverflow')}
          options={[
            { value: 'queue', label: 'Queue' },
            { value: 'reject', label: 'Reject' },
          ]}
          value={globalConfig.agent.queueOverflow}
          onChange={(value) => updateGlobal({ agent: { queueOverflow: value } })}
          testId="queue-overflow-choice"
        />
        <CardToggleRow
          {...settingProps('autoFocusIdleSession')}
          checked={globalConfig.autoFocusIdleSession}
          onChange={(value) => updateGlobal({ autoFocusIdleSession: value })}
        />
        <CardToggleRow
          {...settingProps('agent.autoResumeSessionsOnRestart')}
          checked={globalConfig.agent.autoResumeSessionsOnRestart}
          onChange={(value) => updateGlobal({ agent: { autoResumeSessionsOnRestart: value } })}
        />
        <CardRow {...settingProps('agent.idleTimeoutMinutes')}>
          <input
            type="number"
            value={globalConfig.agent.idleTimeoutMinutes}
            onChange={(event) => updateGlobal({ agent: { idleTimeoutMinutes: Number(event.target.value) } })}
            min={0}
            max={120}
            className={INPUT_CLASS}
          />
        </CardRow>
        <CardToggleRow
          {...settingProps('stopLeftoverProcesses')}
          checked={globalConfig.stopLeftoverProcesses !== false}
          onChange={(value) => updateGlobal({ stopLeftoverProcesses: value })}
        />
      </SettingsCard>

      <SettingsCard
        icon={<AppWindow size={16} />}
        label="Windows"
        description="How task windows close and where they reopen."
        searchIds={['windowLightDismiss', 'restoreWindowPosition']}
      >
        {/* One word each, so the four fit beside the label; each option's
            tooltip says which window it closes. */}
        <CardChoiceRow<WindowLightDismiss>
          {...settingProps('windowLightDismiss')}
          options={[
            { value: 'off', label: 'Off', title: 'Clicking outside never closes a task window' },
            { value: 'single', label: 'Single', title: 'Closes a task window only when it is the only one open' },
            { value: 'focused', label: 'Focused', title: 'Closes the focused task window' },
            { value: 'all', label: 'All', title: 'Closes every open task window' },
          ]}
          value={globalConfig.windowLightDismiss}
          onChange={(value) => updateGlobal({ windowLightDismiss: value })}
          testId="window-light-dismiss-choice"
        />
        <CardToggleRow
          {...settingProps('restoreWindowPosition')}
          checked={globalConfig.restoreWindowPosition}
          onChange={(value) => updateGlobal({ restoreWindowPosition: value })}
        />
      </SettingsCard>
    </div>
  );
}
