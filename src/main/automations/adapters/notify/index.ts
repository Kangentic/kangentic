import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationConfig } from '../../../../shared/types';
import { describeAutomation } from '../../../../shared/automation-describe';
import type { AutomationAdapter } from '../../shared/automation-adapter';

/**
 * Notify me. A desktop notification when a task enters or leaves a column.
 *
 * An agent board is the thing you walk away from, which is why this exists at
 * all: the interesting moment is usually one you are not watching. It goes
 * through the same `showNotification` path `DesktopNotifier` uses, so it
 * inherits click-to-open-the-task and the app's notification settings rather
 * than inventing a second notification channel beside them.
 *
 * No timeout and no retry: it cannot hang and it cannot fail transiently.
 */
export const notifyAdapter: AutomationAdapter = {
  id: 'notify',
  manifest: AUTOMATION_MANIFEST.notify,

  // Delegated so the row sentence has ONE definition: the renderer draws it
  // on every row in Board setup and cannot import this file.
  describe(config: AutomationConfig): string {
    return describeAutomation('notify', config);
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
