import { useState } from 'react';
import { AppWindow, Bell, BellOff, MessageSquare } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { AppConfig, NotificationConfig, NotificationEventKey } from '../../../../shared/types';
import { NumberStepper } from '../../NumberStepper';
import { ToggleSwitch, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardTableHeads, CardTableRow, SettingTag } from '../settings-card';
import { settingProps } from '../settings-registry';
import { NotificationSoundPicker } from './NotificationSoundPicker';

/** One event: whether its toast and desktop notification fire, and what it sounds like. */
function NotifyChannelRow({ eventKey, config, searchId }: {
  eventKey: NotificationEventKey;
  config: NotificationConfig;
  searchId: string;
}) {
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  const [refusal, setRefusal] = useState<string | null>(null);
  const props = settingProps(searchId);
  const toast = config.toasts[eventKey];
  const desktop = config.desktop[eventKey];
  const eventName = props.label;
  return (
    <CardTableRow
      {...props}
      switches={[
        <ToggleSwitch
          key="toast"
          checked={toast}
          onChange={(checked) => updateGlobal({ notifications: { toasts: { [eventKey]: checked } } })}
          ariaLabel={t`${eventName} toast`}
          testId={`notify-channel-${eventKey}-toast`}
        />,
        <ToggleSwitch
          key="desktop"
          checked={desktop}
          onChange={(checked) => updateGlobal({ notifications: { desktop: { [eventKey]: checked } } })}
          ariaLabel={t`${eventName} desktop notification`}
          testId={`notify-channel-${eventKey}-desktop`}
        />,
      ]}
      side={(
        <NotificationSoundPicker
          eventKey={eventKey}
          eventName={eventName}
          config={config}
          disabled={!toast && !desktop}
          onRefused={setRefusal}
        />
      )}
      footer={refusal ? <div className="mt-1.5" data-testid={`notify-sound-refusal-${eventKey}`}><SettingTag>{refusal}</SettingTag></div> : undefined}
    />
  );
}

export function NotificationsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  const notifications = globalConfig.notifications;
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<BellOff size={16} />}
        {...settingProps('notifications.muted')}
        checked={notifications.muted}
        onChange={(muted) => updateGlobal({ notifications: { muted } })}
      />

      <SettingsCard
        icon={<Bell size={16} />}
        label={t`Events`}
        description={t`How you hear about each event.`}
        searchIds={['notifications.onAgentIdle', 'notifications.onAgentCrash', 'notifications.onPlanComplete', 'notifications.onWorkflowComplete', 'notifications.onWorkflowStalled', 'notifications.onSpawnStalled']}
      >
        <CardTableHeads
          label={t({ message: 'Event', context: 'notification table column' })}
          switchColumns={[
            t({ message: 'Toast', context: 'notification table column' }),
            t({ message: 'Desktop', context: 'notification table column' }),
          ]}
          side={t({ message: 'Sound', context: 'notification table column' })}
        />
        <NotifyChannelRow
          eventKey="onAgentIdle"
          config={notifications}
          searchId="notifications.onAgentIdle"
        />
        <NotifyChannelRow
          eventKey="onAgentCrash"
          config={notifications}
          searchId="notifications.onAgentCrash"
        />
        <NotifyChannelRow
          eventKey="onPlanComplete"
          config={notifications}
          searchId="notifications.onPlanComplete"
        />
        <NotifyChannelRow
          eventKey="onWorkflowComplete"
          config={notifications}
          searchId="notifications.onWorkflowComplete"
        />
        <NotifyChannelRow
          eventKey="onWorkflowStalled"
          config={notifications}
          searchId="notifications.onWorkflowStalled"
        />
        <NotifyChannelRow
          eventKey="onSpawnStalled"
          config={notifications}
          searchId="notifications.onSpawnStalled"
        />
      </SettingsCard>

      <SettingsCard
        icon={<AppWindow size={16} />}
        {...settingProps('notifications.appBadge')}
        checked={notifications.appBadge}
        onChange={(appBadge) => updateGlobal({ notifications: { appBadge } })}
      />

      <SettingsCard
        icon={<MessageSquare size={16} />}
        label={t`Toasts`}
        description={t`How many show at once, and for how long.`}
        searchIds={['notifications.toasts.maxCount', 'notifications.toasts.durationSeconds']}
      >
        <CardRow {...settingProps('notifications.toasts.maxCount')} inline>
          <NumberStepper
            value={notifications.toasts.maxCount}
            onChange={(maxCount) => updateGlobal({ notifications: { toasts: { maxCount } } })}
            min={1}
            max={10}
            ariaLabel={t`Maximum toasts on screen`}
            testId="notify-toast-max-count"
          />
        </CardRow>
        <CardRow {...settingProps('notifications.toasts.durationSeconds')} inline>
          <NumberStepper
            value={notifications.toasts.durationSeconds}
            onChange={(durationSeconds) => updateGlobal({ notifications: { toasts: { durationSeconds } } })}
            min={1}
            max={30}
            ariaLabel={t`How long toasts appear, in seconds`}
            testId="notify-toast-duration"
          />
        </CardRow>
      </SettingsCard>
    </div>
  );
}
