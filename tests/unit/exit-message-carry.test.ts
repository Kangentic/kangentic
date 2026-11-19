/**
 * An exit row's message on a move that restarts or yields the agent is carried
 * to the resume and held once the session is suspended (kangentic.com #145).
 * What is lost if this breaks: a run that says "Held" for a message that was
 * never held, a message typed into a session about to be cut off, or a failed
 * hold that nobody hears about.
 *
 * Modules are re-imported per test (`vi.resetModules`) because the module's
 * reporter latches a key once per run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MOVE_MESSAGE_MAX_CHARS } from '../../src/main/agent/commands/move-message-limit';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const heldMessagesControl = vi.hoisted(() => ({
  holdTaskMessage: vi.fn(),
}));
vi.mock('../../src/main/held-messages/held-messages', () => ({
  holdTaskMessage: heldMessagesControl.holdTaskMessage,
}));

type CarryModule = typeof import('../../src/main/ipc/helpers/exit-message-carry');

const COLUMN_NAME = 'Planning';
const PROJECT_ID = 'project-carry';
const TASK_ID = 'task-carry-0001-extra';

let carryModule: CarryModule;

beforeEach(async () => {
  vi.resetModules();
  reportHandledError.mockReset();
  heldMessagesControl.holdTaskMessage.mockReset();
  heldMessagesControl.holdTaskMessage.mockReturnValue({ status: 'held', displayId: 1, rowId: 'held-1' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  carryModule = await import('../../src/main/ipc/helpers/exit-message-carry');
});

const RESTART_DETAIL = `Held: moving to ${COLUMN_NAME} restarts the agent to change its effort, so the message goes in its resume prompt.`;
const YIELD_DETAIL = `Held: ${COLUMN_NAME} is full, so the agent waits there, and the message goes in its resume prompt.`;
const RESTART_FAILED_HELD_DETAIL = `Held: the restart for ${COLUMN_NAME} did not finish, so the message goes to the agent still running after its turn, or else to the task's next agent.`;

describe('carryExitMessage', () => {
  it.each([
    ['restart', { kind: 'restart' as const, reason: 'effort' as const }, RESTART_DETAIL],
    ['yield', { kind: 'yield' as const }, YIELD_DETAIL],
  ])('carries a message of exactly the limit for a %s and returns the held detail', (_label, fate, expectedDetail) => {
    const carried: Array<{ message: string; runId: string }> = [];
    const message = 'x'.repeat(MOVE_MESSAGE_MAX_CHARS);

    const detail = carryModule.carryExitMessage(carried, { message, runId: 'run-1', fate, columnName: COLUMN_NAME });

    expect(detail).toBe(expectedDetail);
    expect(carried).toEqual([{ message, runId: 'run-1' }]);
  });

  it('refuses a message one character over the limit, and carries nothing', async () => {
    const { RefusalError } = await import('../../src/shared/refusal');
    const carried: Array<{ message: string; runId: string }> = [];
    const message = 'x'.repeat(MOVE_MESSAGE_MAX_CHARS + 1);

    let thrown: unknown;
    try {
      carryModule.carryExitMessage(carried, {
        message,
        runId: 'run-1',
        fate: { kind: 'restart', reason: 'effort' },
        columnName: COLUMN_NAME,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RefusalError);
    expect((thrown as Error).message).toBe(
      `Not delivered: moving to ${COLUMN_NAME} restarts the agent, and a message carried to its resume can be at most 20000 characters. This one is 20001.`,
    );
    expect(carried).toEqual([]);
  });
});

describe('holdCarriedExitMessages', () => {
  function run(
    carried: Array<{ message: string; runId: string }>,
    options: { restartFailed?: boolean; updateDetail?: ReturnType<typeof vi.fn> } = {},
  ) {
    const updateDetail = options.updateDetail ?? vi.fn();
    carryModule.holdCarriedExitMessages({} as never, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      columnName: COLUMN_NAME,
      carried,
      automationRuns: { updateDetail },
      restartFailed: options.restartFailed,
    });
    return updateDetail;
  }

  it('a successful hold rewrites nothing, and passes the project, task and message', () => {
    const updateDetail = run([{ message: 'Signed off', runId: 'run-1' }]);

    expect(heldMessagesControl.holdTaskMessage).toHaveBeenCalledWith({}, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'Signed off' });
    expect(updateDetail).not.toHaveBeenCalled();
  });

  it('a successful hold after a failed restart rewrites the run to say the restart did not finish', () => {
    const updateDetail = run([{ message: 'Signed off', runId: 'run-1' }], { restartFailed: true });

    expect(updateDetail).toHaveBeenCalledTimes(1);
    expect(updateDetail).toHaveBeenCalledWith('run-1', RESTART_FAILED_HELD_DETAIL);
  });

  it('a refused hold rewrites the run to Not delivered, naming the refusal', () => {
    heldMessagesControl.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'The task is gone.' });

    const updateDetail = run([{ message: 'Signed off', runId: 'run-1' }]);

    expect(updateDetail).toHaveBeenCalledWith(
      'run-1',
      `Not delivered: moving to ${COLUMN_NAME} restarted the agent, and the message could not be held for it: The task is gone.`,
    );
  });

  it('a refused hold after a failed restart says the restart did not finish', () => {
    heldMessagesControl.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'The task is gone.' });

    const updateDetail = run([{ message: 'Signed off', runId: 'run-1' }], { restartFailed: true });

    expect(updateDetail).toHaveBeenCalledWith(
      'run-1',
      `Not delivered: the restart for ${COLUMN_NAME} did not finish, and the message could not be held: The task is gone.`,
    );
  });

  it('a hold that throws is written to the run like a refusal, with the error message as the failure', () => {
    heldMessagesControl.holdTaskMessage.mockImplementation(() => { throw new Error('database is locked'); });

    const updateDetail = run([{ message: 'Signed off', runId: 'run-1' }]);

    expect(updateDetail).toHaveBeenCalledWith(
      'run-1',
      `Not delivered: moving to ${COLUMN_NAME} restarted the agent, and the message could not be held for it: database is locked`,
    );
  });

  it('a hold that throws a non-Error value uses its string form', () => {
    heldMessagesControl.holdTaskMessage.mockImplementation(() => { throw 'plain text failure'; });

    const updateDetail = run([{ message: 'Signed off', runId: 'run-1' }]);

    expect(updateDetail).toHaveBeenCalledWith(
      'run-1',
      `Not delivered: moving to ${COLUMN_NAME} restarted the agent, and the message could not be held for it: plain text failure`,
    );
  });

  it('an updateDetail that throws is swallowed, and later messages are still held', () => {
    heldMessagesControl.holdTaskMessage
      .mockReturnValueOnce({ status: 'refused', error: 'The task is gone.' })
      .mockReturnValue({ status: 'held', displayId: 1, rowId: 'held-2' });
    const updateDetail = vi.fn(() => { throw new Error('run row is gone'); });
    const carried = [
      { message: 'first', runId: 'run-1' },
      { message: 'second', runId: 'run-2' },
    ];

    expect(() => run(carried, { updateDetail })).not.toThrow();

    expect(updateDetail).toHaveBeenCalledTimes(1);
    expect(heldMessagesControl.holdTaskMessage).toHaveBeenCalledTimes(2);
  });

  it('holds oldest first', () => {
    run([
      { message: 'first', runId: 'run-1' },
      { message: 'second', runId: 'run-2' },
      { message: 'third', runId: 'run-3' },
    ]);

    expect(heldMessagesControl.holdTaskMessage.mock.calls.map((call) => (call[1] as { message: string }).message)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('empties the array, so a second call holds nothing', () => {
    const carried = [{ message: 'first', runId: 'run-1' }];

    run(carried);
    run(carried);

    expect(carried).toEqual([]);
    expect(heldMessagesControl.holdTaskMessage).toHaveBeenCalledTimes(1);
  });

  it('a mixed list rewrites only the run whose hold was refused', () => {
    heldMessagesControl.holdTaskMessage
      .mockReturnValueOnce({ status: 'held', displayId: 1, rowId: 'held-1' })
      .mockReturnValueOnce({ status: 'refused', error: 'Too many held messages.' });

    const updateDetail = run([
      { message: 'first', runId: 'run-1' },
      { message: 'second', runId: 'run-2' },
    ]);

    expect(updateDetail).toHaveBeenCalledTimes(1);
    expect(updateDetail).toHaveBeenCalledWith('run-2', expect.stringContaining('Too many held messages.'));
  });
});

// A defect in the hold or the record write used to be a console line only. The
// report carries a fixed message and short tags, never the message text or the
// column name a user wrote.
describe('exit message carry error reports', () => {
  const SECRET_MESSAGE = 'SECRET-MESSAGE-TEXT-9d41';
  const SECRET_COLUMN = 'SECRET-COLUMN-NAME-77aa';

  function runWith(updateDetail: ReturnType<typeof vi.fn>): void {
    carryModule.holdCarriedExitMessages({} as never, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      columnName: SECRET_COLUMN,
      carried: [{ message: SECRET_MESSAGE, runId: 'run-1' }],
      automationRuns: { updateDetail },
    });
  }

  it('a hold that throws a TypeError reports under exit_message_carry, stage hold, with no user text', () => {
    heldMessagesControl.holdTaskMessage.mockImplementation(() => { throw new TypeError('hold defect'); });

    runWith(vi.fn());

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [sentError, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(tags).toMatchObject({ source: 'exit_message_carry', stage: 'hold', error_name: 'TypeError' });
    expect(sentError.message).toBe('Handled exit_message_carry failure: TypeError');
    const everythingSent = JSON.stringify(reportHandledError.mock.calls) + String(sentError.stack);
    expect(everythingSent).not.toContain(SECRET_MESSAGE);
    expect(everythingSent).not.toContain(SECRET_COLUMN);
  });

  it('an updateDetail that throws a TypeError reports under stage record, with no user text', () => {
    heldMessagesControl.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'The task is gone.' });

    runWith(vi.fn(() => { throw new TypeError('record defect'); }));

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const tags = reportHandledError.mock.calls[0][1] as Record<string, string>;
    expect(tags).toMatchObject({ source: 'exit_message_carry', stage: 'record', error_name: 'TypeError' });
    const everythingSent = JSON.stringify(reportHandledError.mock.calls);
    expect(everythingSent).not.toContain(SECRET_MESSAGE);
    expect(everythingSent).not.toContain(SECRET_COLUMN);
  });

  it('a refusal reports nothing, since it is an answer and not a defect', () => {
    heldMessagesControl.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'The task is gone.' });

    runWith(vi.fn());

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
