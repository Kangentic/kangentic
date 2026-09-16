/**
 * The send_message adapter's REPORTED outcome, which is not the same on the two
 * triggers and must not claim to be.
 *
 * The run log is where someone answers "did my agent actually get this", so the
 * word it records is load-bearing. On exit the engine awaits the keystroke burst
 * and reaches the adapter's return only once it has gone out. On enter it cannot
 * await: Phase 3 holds the task lock across the whole enter group, and a
 * deferred message waits for the agent's current turn to end, so awaiting would
 * hold that lock for as long as the scheduler's own ladder runs.
 *
 * Reporting the same word for both is not a wording nit, it is the exact bug
 * this feature already shipped once: the exit path recorded `succeeded` /
 * "Delivered" in ONE millisecond while the agent received the burst's leading
 * Ctrl+U and nothing else, because the row reported what was SCHEDULED rather
 * than what happened.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { sendMessageAdapter } from '../../src/main/automations/adapters/send-message';
import type { AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { AutomationTrigger, Task } from '../../src/shared/types';

function makeContext(trigger: AutomationTrigger, delivered: string[]): AutomationContext {
  return {
    task: { id: 'task-1', title: 'A task', session_id: 'session-1' } as Task,
    column: { name: 'Executing' },
    trigger,
    cwd: os.tmpdir(),
    projectId: 'project-1',
    templateVars: { title: 'A task' },
    signal: new AbortController().signal,
    runId: 'run-1',
    deliverToAgent: async (message: string) => { delivered.push(message); },
    // The adapter reads none of the rest; the cast keeps the fake to what it uses.
  } as unknown as AutomationContext;
}

describe('send_message adapter', () => {
  it('reports Delivered on exit, where the engine awaited the burst', async () => {
    const delivered: string[] = [];
    const result = await sendMessageAdapter.execute({ message: '/review' }, makeContext('exit', delivered));

    expect(delivered).toEqual(['/review']);
    expect(result.detail).toBe('Delivered');
  });

  it('reports Sent on enter, where delivery was only scheduled', async () => {
    const delivered: string[] = [];
    const result = await sendMessageAdapter.execute({ message: '/review' }, makeContext('enter', delivered));

    expect(delivered).toEqual(['/review']);
    // Not "Delivered". Nothing has confirmed the keystrokes at this point.
    expect(result.detail).toBe('Sent');
  });

  it('does not call the agent at all for a row with no message yet', async () => {
    // The picker adds a row before it has one, and a user can save a draft they
    // meant to come back to. That is not a failure and must not reach the agent.
    const delivered: string[] = [];
    const result = await sendMessageAdapter.execute({}, makeContext('enter', delivered));

    expect(delivered).toEqual([]);
    expect(result.detail).toBe('No message to send.');
  });

  it('reads the legacy send_command payload key', async () => {
    const delivered: string[] = [];
    await sendMessageAdapter.execute({ command: '/legacy' }, makeContext('exit', delivered));

    expect(delivered).toEqual(['/legacy']);
  });
});
