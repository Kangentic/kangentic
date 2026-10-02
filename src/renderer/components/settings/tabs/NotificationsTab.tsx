import { Bell, MessageSquare } from 'lucide-react';
import type { AppConfig, NotificationConfig } from '../../../../shared/types';
import { INPUT_CLASS, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';

type NotifyEventKey = 'onAgentIdle' | 'onAgentCrash' | 'onPlanComplete' | 'onSpawnStalled';

type NotifyChannel = 'off' | 'desktop' | 'toast' | 'both';

/** Map desktop/toast booleans to a single channel choice. */
function notifyChannelValue(desktop: boolean, toast: boolean): NotifyChannel {
  if (desktop && toast) return 'both';
  if (desktop) return 'desktop';
  if (toast) return 'toast';
  return 'off';
}

/** Reusable row for a notification event, with a segmented Off / Desktop / Toast / Both choice. */
function NotifyChannelRow({ eventKey, config, searchId }: {
  eventKey: NotifyEventKey;
  config: NotificationConfig;
  searchId: string;
}) {
  const updateGlobal = useScopedUpdate('global');
  const value = notifyChannelValue(config.desktop[eventKey], config.toasts[eventKey]);
  const props = settingProps(searchId);
  return (
    <CardChoiceRow
      {...props}
      options={[
        { value: 'off', label: 'Off', testId: `notify-channel-${eventKey}-off` },
        { value: 'desktop', label: 'Desktop', testId: `notify-channel-${eventKey}-desktop` },
        { value: 'toast', label: 'Toast', testId: `notify-channel-${eventKey}-toast` },
        { value: 'both', label: 'Both', testId: `notify-channel-${eventKey}-both` },
      ]}
      value={value}
      onChange={(selected) => {
        const desktop = selected === 'both' || selected === 'desktop';
        const toast = selected === 'both' || selected === 'toast';
        updateGlobal({
          notifications: {
            desktop: { [eventKey]: desktop },
            toasts: { [eventKey]: toast },
          },
        });
      }}
      testId={`notify-channel-${eventKey}`}
    />
  );
}

export function NotificationsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<Bell size={16} />}
        label="Events"
        description="Where each kind of alert shows up."
        searchIds={['notifications.onAgentIdle', 'notifications.onAgentCrash', 'notifications.onPlanComplete', 'notifications.onSpawnStalled']}
      >
        <NotifyChannelRow
          eventKey="onAgentIdle"
          config={globalConfig.notifications}
          searchId="notifications.onAgentIdle"
        />
        <NotifyChannelRow
          eventKey="onAgentCrash"
          config={globalConfig.notifications}
          searchId="notifications.onAgentCrash"
        />
        <NotifyChannelRow
          eventKey="onPlanComplete"
          config={globalConfig.notifications}
          searchId="notifications.onPlanComplete"
        />
        <NotifyChannelRow
          eventKey="onSpawnStalled"
          config={globalConfig.notifications}
          searchId="notifications.onSpawnStalled"
        />
      </SettingsCard>

      <SettingsCard
        icon={<MessageSquare size={16} />}
        label="Toasts"
        description="How long toasts stay up and how many stack at once."
        searchIds={['notifications.toasts.durationSeconds', 'notifications.toasts.maxCount']}
      >
        <CardRow {...settingProps('notifications.toasts.durationSeconds')}>
          <input
            type="number"
            value={globalConfig.notifications.toasts.durationSeconds}
            onChange={(event) => updateGlobal({ notifications: { toasts: { durationSeconds: Number(event.target.value) } } })}
            min={1}
            max={30}
            className={INPUT_CLASS}
          />
        </CardRow>
        <CardRow {...settingProps('notifications.toasts.maxCount')}>
          <input
            type="number"
            value={globalConfig.notifications.toasts.maxCount}
            onChange={(event) => updateGlobal({ notifications: { toasts: { maxCount: Number(event.target.value) } } })}
            min={1}
            max={10}
            className={INPUT_CLASS}
          />
        </CardRow>
      </SettingsCard>
    </div>
  );
}
