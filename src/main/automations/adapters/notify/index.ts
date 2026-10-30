import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationConfig } from '../../../../shared/types';
import { describeAutomation } from '../../../../shared/automation-describe';
import { englishI18n } from '../../../../shared/i18n/english';
import type { AutomationAdapter } from '../../shared/automation-adapter';

/**
 * Notify me. A notification on the desktop and every paired phone when a task
 * enters or leaves a column, or its agent ends a turn.
 *
 * An agent board is the thing you walk away from, which is why this exists at
 * all: the interesting moment is usually one you are not watching. The
 * desktop half goes through the same `showDesktopNotification` path
 * `DesktopNotifier` uses, so it inherits click-to-open-the-task; the phone half
 * is a push with this row's own Title and Body, which opens the task when
 * tapped (`showAutomationNotification`). Neither reads the notification
 * settings: the row itself is the user's choice to be told.
 *
 * No timeout and no retry: it cannot hang, and a push that fails is the push
 * notifier's to log.
 */
export const notifyAdapter: AutomationAdapter = {
  id: 'notify',
  manifest: AUTOMATION_MANIFEST.notify,

  // Delegated so the row sentence has ONE definition: the renderer draws it
  // on every row in Board setup and cannot import this file.
  describe(config: AutomationConfig): string {
    // The run log's line, which an agent reads: English.
    return describeAutomation('notify', config, englishI18n);
  },

  async execute(config, context) {
    // Falling back to the task title and the column name rather than refusing:
    // an empty field here has an obvious right answer, and a notification that
    // does not fire is exactly the failure this type exists to prevent.
    const title = (config.title ?? '').trim() || context.task.title;
    const body = (config.body ?? '').trim() || context.column.name;

    context.showNotification({
      title,
      body,
      projectId: context.projectId,
      taskId: context.task.id,
    });

    return { detail: 'Shown' };
  },
};
