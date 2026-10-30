/**
 * `deliverMessageAfterMove` (src/main/automations/turn-end/deliver-message.ts):
 * a Move to column row's message, or `kangentic_move_task`'s, for the agent
 * where the task lands. Where no agent runs there it used to be logged and
 * dropped; it is now held for the task's next agent (src/main/held-messages).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PROJECT_ID = 'proj-1';
const TASK_ID = 'task-moved';

const hoisted = vi.hoisted(() => ({
  waitForTurnCompletion: vi.fn<(...callArguments: unknown[]) => Promise<string>>(async () => 'completed'),
  deliverAgentMessageAndWait: vi.fn(async () => undefined),
  holdTaskMessage: vi.fn<(...callArguments: unknown[]) => unknown>(() => ({ status: 'held', displayId: 7, rowId: 'held-1' })),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: () => ({ tasks: { getById: () => ({ id: TASK_ID, agent: 'claude' }) } }),
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({ resolveInjectionVerifier: () => null }));
vi.mock('../../src/main/transition-engine/turn-completion', () => ({ waitForTurnCompletion: hoisted.waitForTurnCompletion }));
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({
  deliverAgentMessageAndWait: hoisted.deliverAgentMessageAndWait,
}));
vi.mock('../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: hoisted.holdTaskMessage }));

const { deliverMessageAfterMove } = await import('../../src/main/automations/turn-end/deliver-message');
const { supersedeTurnEndWork } = await import('../../src/main/automations/turn-end/turn-end-passes');

function makeContext(live: { id: string; writable: boolean } | null) {
  return {
    sessionManager: {
      findLiveSessionByTaskId: vi.fn(() => (live ? { id: live.id } : undefined)),
      isWritable: vi.fn((sessionId: string) => live?.id === sessionId && live.writable),
    },
  } as never;
}

async function run(context: never): Promise<void> {
  const delivery = deliverMessageAfterMove(context, PROJECT_ID, TASK_ID, 'Blocked', 'The review found two issues.');
  await vi.advanceTimersByTimeAsync(3_000);
  await delivery;
}

describe('deliverMessageAfterMove', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.waitForTurnCompletion.mockReset();
    hoisted.waitForTurnCompletion.mockResolvedValue('completed');
    hoisted.deliverAgentMessageAndWait.mockReset();
    hoisted.holdTaskMessage.mockReset();
    hoisted.holdTaskMessage.mockReturnValue({ status: 'held', displayId: 7, rowId: 'held-1' });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
  });

  it('holds the message when the column it moved to runs no agent', async () => {
    const context = makeContext(null);

    await run(context);

    // Red before held messages: logged and dropped.
    expect(hoisted.holdTaskMessage).toHaveBeenCalledWith(context, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      message: 'The review found two issues.',
    });
    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
  });

  it('holds it while the task\'s agent is still queued, with no PTY to type into', async () => {
    await run(makeContext({ id: 'queued-session', writable: false }));

    expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
  });

  it('hands it to a running agent once its turn ends, as before', async () => {
    await run(makeContext({ id: 'live-session', writable: true }));

    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
    expect(hoisted.deliverAgentMessageAndWait).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: 'live-session',
      message: 'The review found two issues.',
    }));
  });

  it('holds it when the agent exits before its turn ends', async () => {
    hoisted.waitForTurnCompletion.mockResolvedValue('exited');

    await run(makeContext({ id: 'live-session', writable: true }));

    expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
  });

  it('holds nothing when the move was superseded while the agent exited', async () => {
    // A later move cancels this delivery (`supersedeTurnEndWork`). The exit
    // that follows is the later move ending the session, not the destination
    // being left without an agent, so holding the message here would give a
    // message meant for the column the task left to the next agent in the
    // column it is in now.
    let settleTurnWait: (outcome: string) => void = () => undefined;
    hoisted.waitForTurnCompletion.mockImplementation(
      () => new Promise<string>((resolve) => { settleTurnWait = resolve; }),
    );

    const delivery = deliverMessageAfterMove(
      makeContext({ id: 'live-session', writable: true }),
      PROJECT_ID,
      TASK_ID,
      'Blocked',
      'The review found two issues.',
    );
    await vi.advanceTimersByTimeAsync(3_000);
    // Parked on the turn wait, past the settle delay: superseding earlier would
    // return at the first abort check and prove nothing about the exit branch.
    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);

    supersedeTurnEndWork(TASK_ID);
    const turnWaitOptions = hoisted.waitForTurnCompletion.mock.calls[0][2] as { signal: AbortSignal };
    expect(turnWaitOptions.signal.aborted).toBe(true);
    settleTurnWait('exited');
    await delivery;

    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
  });

  it('logs and drops a message the task refuses to hold (a move into Done)', async () => {
    hoisted.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'Task #7 is in Done, where no agent runs.' });

    await expect(run(makeContext(null))).resolves.toBeUndefined();

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('it is not held'));
  });
});
