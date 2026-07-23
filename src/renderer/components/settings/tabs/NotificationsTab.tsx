import type { AppConfig, NotificationConfig } from '../../../../shared/types';
import { SectionHeader, SettingRow, Select, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

type NotifyEventKey = 'onAgentIdle' | 'onPlanComplete' | 'onSpawnStalled';

/** Map desktop/toast booleans to a single dropdown value. */
function notifyChannelValue(desktop: boolean, toast: boolean): string {
  if (desktop && toast) return 'both';
  if (desktop) return 'desktop';
  if (toast) return 'toast';
  return 'off';
}

/** Reusable row for a notification event with a Desktop/Toast channel dropdown. */
function NotifyChannelRow({ eventKey, config, searchId }: {
  eventKey: NotifyEventKey;
  config: NotificationConfig;
  searchId: string;
}) {
  const updateGlobal = useScopedUpdate('global');
  const value = notifyChannelValue(config.desktop[eventKey], config.toasts[eventKey]);
  const props = settingProps(searchId);
  return (
    <SettingRow {...props}>
      <Select
        value={value}
        onChange={(event) => {
          const selected = event.target.value;
          const desktop = selected === 'both' || selected === 'desktop';
          const toast = selected === 'both' || selected === 'toast';
          updateGlobal({
            notifications: {
              desktop: { [eventKey]: desktop },
              toasts: { [eventKey]: toast },
            },
          });
        }}
      >
        <option value="off">Off</option>
        <option value="desktop">Desktop only</option>
        <option value="toast">Toast only</option>
        <option value="both">Both</option>
      </Select>
    </SettingRow>
  );
}

export function NotificationsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  return (
    <>
      <SectionHeader
        label="Events"
        searchIds={['notifications.onAgentIdle', 'notifications.onPlanComplete', 'notifications.onSpawnStalled']}
      />
      <NotifyChannelRow
        eventKey="onAgentIdle"
        config={globalConfig.notifications}
        searchId="notifications.onAgentIdle"
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

      <SectionHeader
        label="Delivery"
        searchIds={['notifications.toasts.durationSeconds', 'notifications.toasts.maxCount']}
      />
      <SettingRow {...settingProps('notifications.toasts.durationSeconds')}>
        <input
          type="number"
          value={globalConfig.notifications.toasts.durationSeconds}
          onChange={(event) => updateGlobal({ notifications: { toasts: { durationSeconds: Number(event.target.value) } } })}
          min={1}
          max={30}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('notifications.toasts.maxCount')}>
        <input
          type="number"
          value={globalConfig.notifications.toasts.maxCount}
          onChange={(event) => updateGlobal({ notifications: { toasts: { maxCount: Number(event.target.value) } } })}
          min={1}
          max={10}
          className={INPUT_CLASS}
        />
      </SettingRow>
    </>
  );
}
