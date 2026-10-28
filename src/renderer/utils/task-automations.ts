import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { Task } from '../../shared/types';
import { useBoardStore } from '../stores/board-store';
import { useProjectStore } from '../stores/project-store';
import { useToastStore } from '../stores/toast-store';
import { describeIpcError, asSentence } from '../lib/ipc-error';
import { openTaskFromNotification } from './open-task-from-notification';
import { resyncBoardAfterMonitorWrite } from '../components/monitor/resync-board-after-monitor-write';

/**
 * Pause or resume a task's automations, the one write behind every place that
 * offers it: the board card's menu, the Agent Monitor's row menu, the Workflows
 * canvas card's menu and the inspector's Resume.
 *
 * A task of the open project writes through the board store, so its card gains
 * or loses its strip without a board reload. A task of another project writes
 * to the IPC, stamped with that project, and the resync drops that project's
 * warm snapshot; in the detached monitor no project is open, so every task
 * takes that path, and main tells the main window.
 *
 * A failure says so in a toast whose card opens the task. Resolves whether the
 * write landed, so a caller can refresh what it shows.
 */
export async function toggleTaskAutomations(
  task: Pick<Task, 'id' | 'title' | 'automations_disabled'>,
  projectId: string | null,
): Promise<boolean> {
  const pause = !task.automations_disabled;
  const input = { id: task.id, automations_disabled: pause };
  const openProjectId = useProjectStore.getState().currentProject?.id ?? null;
  try {
    if (projectId === null || projectId === openProjectId) {
      await useBoardStore.getState().updateTask(input);
    } else {
      try {
        await window.electronAPI.tasks.update(input, projectId);
      } finally {
        resyncBoardAfterMonitorWrite(projectId);
      }
    }
    return true;
  } catch (error) {
    const taskTitle = task.title;
    const reason = asSentence(describeIpcError(error));
    const toastProjectId = projectId ?? openProjectId;
    useToastStore.getState().addToast({
      title: pause ? i18n._(msg`Couldn't pause automations`) : i18n._(msg`Couldn't resume automations`),
      message: `"${taskTitle}": ${reason}`,
      variant: 'warning',
      onOpen: toastProjectId !== null ? () => openTaskFromNotification(toastProjectId, task.id) : undefined,
    });
    return false;
  }
}
