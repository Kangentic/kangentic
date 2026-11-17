/**
 * The failure notice for an On task exit message offers no Run again
 * (`reportAutomationFailures`, src/main/ipc/helpers/automation-failures.ts).
 *
 * `runAutomationAgain` refuses that row, because the task has left the column
 * whose agent the message was for. A button that can only answer "Couldn't run
 * again" is not offered: the push says so, and the renderer leaves it off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutomationRunFailure } from '../../src/shared/types';
import type { AutomationRunSummary } from '../../src/main/automations/automation-runner';
import { IPC } from '../../src/shared/ipc-channels';

import { reportAutomationFailures } from '../../src/main/ipc/helpers/automation-failures';

function summaryWith(failure: { automationId: string; type: string }): AutomationRunSummary {
  const outcome = {
    runId: `run-${failure.automationId}`,
    automationId: failure.automationId,
    name: 'Signed off',
    type: failure.type,
    columnName: 'Design',
    status: 'failed' as const,
    detail: 'The message could not be confirmed.',
  };
  return { outcomes: [outcome], failures: [outcome], startedAgent: false };
}

describe('reportAutomationFailures: Run again on an exit row', () => {
  let send: ReturnType<typeof vi.fn>;
  let context: never;

  beforeEach(() => {
    send = vi.fn();
    context = { mainWindow: { isDestroyed: () => false, webContents: { send } }, currentProjectId: null } as never;
  });

  /** Each case uses its own automation id: the notice is rationed per automation. */
  function pushed(): AutomationRunFailure {
    const call = send.mock.calls.find((entry) => entry[0] === IPC.AUTOMATION_RUN_FAILED);
    if (!call) throw new Error('no failure notice was pushed');
    return call[1] as AutomationRunFailure;
  }

  it('does not offer Run again for an exit message', () => {
    reportAutomationFailures(context, summaryWith({ automationId: 'row-exit-message', type: 'send_message' }), { id: 'task-1', title: 'T' }, 'proj-a', 'exit');

    // Red: the push carried no field, and the toast offered a re-run main refuses.
    expect(pushed().runAgainOffered).toBe(false);
  });

  it('offers it for an exit row that needs no agent', () => {
    reportAutomationFailures(context, summaryWith({ automationId: 'row-exit-script', type: 'run_script' }), { id: 'task-1', title: 'T' }, 'proj-a', 'exit');

    expect(pushed().runAgainOffered).toBeUndefined();
  });

  it('offers it for an enter message', () => {
    reportAutomationFailures(context, summaryWith({ automationId: 'row-enter-message', type: 'send_message' }), { id: 'task-1', title: 'T' }, 'proj-a', 'enter');

    expect(pushed().runAgainOffered).toBeUndefined();
  });
});
