import type { AutomationRunSummary } from '../../automations/automation-runner';
import { notifyAutomationFailure } from '../../automations/automation-run-outcome';
import type { Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Turn a run summary's failures into user-facing notices.
 *
 * The runner already wrote a row per execution, whatever happened; that is the
 * durable record and it is not optional. This is the other sink, the one that
 * interrupts, and it is deliberately thin: it names the automation and the
 * column, and `notifyAutomationFailure` decides whether this particular failure
 * is still inside its own cooldown.
 *
 * Lives here rather than in the runner because the runner is pure with respect
 * to Electron: it takes repositories and a context object and knows nothing
 * about a BrowserWindow. Keeping the push at the IPC layer is what lets the
 * runner's unit tests construct it with plain fakes.
 */
export function reportAutomationFailures(
  context: IpcContext,
  summary: AutomationRunSummary,
  task: Pick<Task, 'id' | 'title'>,
  projectId: string | null | undefined,
): void {
  if (summary.failures.length === 0) return;

  for (const failure of summary.failures) {
    notifyAutomationFailure({
      window: context.mainWindow,
      projectId,
      failure: {
        runId: failure.runId,
        automationId: failure.automationId,
        automationName: failure.name,
        // The outcome carries its own column, so a caller cannot pass the
        // wrong one: on exit the column is the SOURCE, on enter the
        // destination, and both call sites would have to get that right by
        // hand otherwise.
        columnName: failure.columnName,
        taskId: task.id,
        taskTitle: task.title,
        projectId: projectId ?? context.currentProjectId ?? '',
        status: 'failed',
        detail: failure.detail,
      },
    });
  }
}
