/**
 * Unit tests for src/main/ipc/helpers/exit-message-delivery.ts.
 *
 * `deliverExitMessage` schedules one keystroke message on the terminal-submit
 * scheduler and returns a promise that settles from the scheduler's outcome
 * report, not from the scheduling call. The runner awaits it, so how the
 * promise settles is what the run row records. The scheduler is a stub here:
 * these tests hand the helper the reports the real scheduler would produce
 * (`terminal-submit-scheduler.test.ts` pins when it produces each).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  deliverExitMessage,
  EXIT_BUDGET_ABORT_REASON,
} from '../../src/main/ipc/helpers/exit-message-delivery';
import { KeysReachedPermissionPromptError } from '../../src/main/pty/automated-keys-guard';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { InjectionReport, ScheduleKeystrokesOptions } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { InjectionCommand, CommandVerifier } from '../../src/main/pty/terminal-submit';

const TASK_ID = 'task-1';
const SESSION_ID = 'session-1';
const MESSAGE = 'Review the diff';

function makeReport(overrides: Partial<InjectionReport> = {}): InjectionReport {
  return {
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    commands: [MESSAGE],
    outcome: 'confirmed',
    unconfirmedCommands: [],
    discardedDraft: null,
    interruptedTurn: false,
    escalated: false,
    ...overrides,
  };
}

/** A context whose scheduler records the call, so a test can deliver a report by hand. */
function makeContext(): {
  context: IpcContext;
  scheduledCommands: () => ReadonlyArray<InjectionCommand>;
  scheduledOptions: () => ScheduleKeystrokesOptions;
  reportOutcome: (report: InjectionReport) => void;
} {
  const scheduleKeystrokes = vi.fn<
    (taskId: string, sessionId: string, commands: ReadonlyArray<InjectionCommand>, options: ScheduleKeystrokesOptions) => void
  >();
  const context = { terminalSubmitScheduler: { scheduleKeystrokes } } as unknown as IpcContext;
  const lastCall = (): Parameters<typeof scheduleKeystrokes> => {
    const call = scheduleKeystrokes.mock.calls.at(-1);
    if (!call) throw new Error('the message was never scheduled');
    return call;
  };
  return {
    context,
    scheduledCommands: () => lastCall()[2],
    scheduledOptions: () => lastCall()[3],
    reportOutcome: (report) => {
      const onOutcome = lastCall()[3].onOutcome;
      if (!onOutcome) throw new Error('the scheduler was given no onOutcome');
      onOutcome(report);
    },
  };
}

describe('deliverExitMessage', () => {
  it('schedules the message as one verifiable keystroke command with the caller\'s mode and verifier', () => {
    const { context, scheduledCommands, scheduledOptions } = makeContext();
    const verifier: CommandVerifier = async () => true;

    void deliverExitMessage(context, TASK_ID, SESSION_ID, MESSAGE, 'deferred', verifier, new AbortController().signal);

    expect(scheduledCommands()).toEqual([{ text: MESSAGE, verify: 'submitted' }]);
    expect(scheduledOptions()).toMatchObject({ mode: 'deferred', verifier });
  });

  it('rejects with KeysReachedPermissionPromptError when the burst reached a permission prompt', async () => {
    // The Enter may have answered a prompt the app had not heard of, so the row
    // must record that, not a generic failure: the report carries the
    // scheduler's own reason text, and falling through to the outcome branch
    // below would surface that text as a plain Error.
    const { context, reportOutcome } = makeContext();
    const delivery = deliverExitMessage(context, TASK_ID, SESSION_ID, MESSAGE, 'immediate', null, new AbortController().signal);
    const rejection = expect(delivery).rejects.toBeInstanceOf(KeysReachedPermissionPromptError);

    reportOutcome(makeReport({
      outcome: 'failed',
      unconfirmedCommands: [MESSAGE],
      reason: 'An Enter reached a permission prompt, so it may have answered it.',
      reachedPermissionPrompt: true,
    }));

    await rejection;
    await expect(delivery).rejects.toMatchObject({
      name: 'KeysReachedPermissionPromptError',
      message: 'The keys reached a permission prompt, so they may have answered it.',
    });
  });

  it.each<{ outcome: InjectionReport['outcome'] }>([
    { outcome: 'confirmed' },
    // Eleven of twelve adapters have no submission verifier, so "could not be
    // checked" must not fail the row.
    { outcome: 'unconfirmed' },
  ])('resolves for a $outcome delivery', async ({ outcome }) => {
    const { context, reportOutcome } = makeContext();
    const delivery = deliverExitMessage(context, TASK_ID, SESSION_ID, MESSAGE, 'immediate', null, new AbortController().signal);

    reportOutcome(makeReport({ outcome }));

    await expect(delivery).resolves.toBeUndefined();
  });

  it('rejects with the report\'s reason for a failed delivery', async () => {
    const { context, reportOutcome } = makeContext();
    const delivery = deliverExitMessage(context, TASK_ID, SESSION_ID, MESSAGE, 'immediate', null, new AbortController().signal);
    const rejection = expect(delivery).rejects.toThrow('Not sent: a permission prompt is open.');

    reportOutcome(makeReport({ outcome: 'failed', reason: 'Not sent: a permission prompt is open.' }));

    await rejection;
    await expect(delivery).rejects.not.toBeInstanceOf(KeysReachedPermissionPromptError);
  });

  it('names the outcome when a failed or cancelled delivery gave no reason', async () => {
    const { context, reportOutcome } = makeContext();
    const delivery = deliverExitMessage(context, TASK_ID, SESSION_ID, MESSAGE, 'immediate', null, new AbortController().signal);
    const rejection = expect(delivery).rejects.toThrow('The message was cancelled.');

    reportOutcome(makeReport({ outcome: 'cancelled' }));

    await rejection;
  });

  it('rejects with the abort reason when the signal fires before the burst reports, and ignores a late report', async () => {
    const { context, reportOutcome } = makeContext();
    const controller = new AbortController();
    const delivery = deliverExitMessage(context, TASK_ID, SESSION_ID, MESSAGE, 'immediate', null, controller.signal);
    const rejection = expect(delivery).rejects.toThrow(EXIT_BUDGET_ABORT_REASON);

    controller.abort();
    // The first settlement wins: the burst finishing after the budget ran out
    // does not turn the rejection into a success.
    reportOutcome(makeReport({ outcome: 'confirmed' }));

    await rejection;
  });

  it('says a caller\'s own reason when its signal fires', async () => {
    const { context } = makeContext();
    const controller = new AbortController();
    const delivery = deliverExitMessage(
      context, TASK_ID, SESSION_ID, MESSAGE, 'immediate', null, controller.signal, 'The turn-end step was superseded.',
    );
    const rejection = expect(delivery).rejects.toThrow('The turn-end step was superseded.');

    controller.abort();

    await rejection;
  });
});
