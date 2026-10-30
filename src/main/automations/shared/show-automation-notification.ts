import type { NotificationInput } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import { showDesktopNotification } from '../../ipc/handlers/system';

/**
 * What `AutomationContext.showNotification` does, for every place that builds
 * one: the desktop notification, then the same Title and Body pushed to every
 * paired phone. A Notify me row is the user's own choice to be told, so
 * neither goes through the notification settings. The phone push is skipped
 * while the mobile bridge is off.
 *
 * The DesktopNotifier's own alerts (idle, crash) call `showDesktopNotification`
 * directly and do not come through here: they reach the phone through the
 * push notifier's own triggers, under the phone's own settings.
 */
export function showAutomationNotification(context: IpcContext, input: NotificationInput): void {
  showDesktopNotification(context, input);
  context.mobileBridgeService?.notifyAutomation({
    title: input.title,
    body: input.body,
    projectId: input.projectId,
    taskId: input.taskId,
  });
}
