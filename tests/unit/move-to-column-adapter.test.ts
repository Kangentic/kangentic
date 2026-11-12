/**
 * The Move to column adapter's hand-off to the move path (#804): the row's run id
 * rides to the move, so the message's delivery can rewrite that run's detail, and
 * the detail it returns says the message waits only when there is one.
 */
import { describe, it, expect, vi } from 'vitest';
import { moveToColumnAdapter } from '../../src/main/automations/adapters/move-to-column';
import { moveMessagePendingDetail } from '../../src/main/automations/turn-end/move-message-outcome';
import type { AutomationContext } from '../../src/main/automations/shared/automation-adapter';

function makeContext(): { context: AutomationContext; moveTask: ReturnType<typeof vi.fn> } {
  const moveTask = vi.fn(async () => ({ columnName: 'Testing' }));
  const context = {
    moveTask,
    runId: 'run-adapter-1',
    automationName: 'Send on to Testing',
    signal: new AbortController().signal,
  } as unknown as AutomationContext;
  return { context, moveTask };
}

describe('moveToColumnAdapter.execute', () => {
  it('passes its run id to the move and reports the message as waiting', async () => {
    const { context, moveTask } = makeContext();

    const result = await moveToColumnAdapter.execute({ targetColumn: 'Testing', message: 'Please test it.' }, context);

    // Red without `runId: context.runId`: the delivery could not rewrite this run's detail.
    expect(moveTask).toHaveBeenCalledWith({
      column: 'Testing',
      message: 'Please test it.',
      reason: 'Send on to Testing',
      runId: 'run-adapter-1',
    });
    expect(result.detail).toBe(moveMessagePendingDetail('Testing'));
  });

  it('reports a plain move when there is no message', async () => {
    const { context, moveTask } = makeContext();

    const result = await moveToColumnAdapter.execute({ targetColumn: 'Testing', message: '   ' }, context);

    expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ message: null, runId: 'run-adapter-1' }));
    expect(result.detail).toBe('Moved to Testing.');
  });
});
