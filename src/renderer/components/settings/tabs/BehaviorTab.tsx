import { AppWindow, Bot, Link2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AppConfig, LinkClickTarget, WindowLightDismiss } from '../../../../shared/types';
import { IS_MAC } from '../../../utils/keybindings';
import { INPUT_CLASS, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardToggleRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';

export function BehaviorTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<Bot size={16} />}
        label={t`Sessions`}
        description={t`How many agents run at once and what happens when idle.`}
        searchIds={['agent.maxConcurrentSessions', 'autoFocusIdleSession', 'agent.autoResumeSessionsOnRestart', 'stopLeftoverProcesses']}
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
        <CardToggleRow
          {...settingProps('stopLeftoverProcesses')}
          checked={globalConfig.stopLeftoverProcesses !== false}
          onChange={(value) => updateGlobal({ stopLeftoverProcesses: value })}
        />
      </SettingsCard>

      <SettingsCard
        icon={<AppWindow size={16} />}
        label={t({ message: 'Windows', context: 'task windows' })}
        description={t`How task windows close and where they reopen.`}
        searchIds={['windowLightDismiss', 'restoreWindowPosition']}
      >
        {/* One word each, so the four fit beside the label; each option's
            tooltip says which window it closes. */}
        <CardChoiceRow<WindowLightDismiss>
          {...settingProps('windowLightDismiss')}
          options={[
            { value: 'off', label: t({ message: 'Off', context: 'close on outside click' }), tip: t`Clicking outside never closes a task window` },
            { value: 'single', label: t({ message: 'Single', context: 'close on outside click' }), tip: t`Closes a task window only when it is the only one open` },
            { value: 'focused', label: t({ message: 'Focused', context: 'close on outside click' }), tip: t`Closes the focused task window` },
            { value: 'all', label: t({ message: 'All', context: 'close on outside click' }), tip: t`Closes every open task window` },
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

      {/* Both browsers stay one click away everywhere: this only picks which
          one a plain click opens. No hotkey, so nothing in the Hotkeys tab. */}
      <SettingsCard
        icon={<Link2 size={16} />}
        label={t({ message: 'Links', context: 'settings card' })}
        description={IS_MAC
          ? t`Which browser a click opens. Cmd+Click opens the other.`
          : t`Which browser a click opens. Ctrl+Click opens the other.`}
        searchIds={['linkClickTarget']}
      >
        <CardChoiceRow<LinkClickTarget>
          {...settingProps('linkClickTarget')}
          options={[
            { value: 'default', label: t({ message: 'Default browser', context: 'click opens links in' }), tip: t`Your system's default browser` },
            { value: 'kangentic', label: t({ message: 'Kangentic browser', context: 'click opens links in' }), tip: t`The browser beside the task's terminal` },
          ]}
          value={globalConfig.linkClickTarget ?? 'default'}
          onChange={(value) => updateGlobal({ linkClickTarget: value })}
          testId="link-click-target-choice"
        />
      </SettingsCard>
    </div>
  );
}
