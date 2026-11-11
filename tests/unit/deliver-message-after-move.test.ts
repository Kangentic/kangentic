/**
 * `deliverMessageAfterMove` (src/main/automations/turn-end/deliver-message.ts):
 * a Move to column row's message, or `kangentic_move_task`'s, for the agent
 * where the task lands. Where no agent runs there it used to be logged and
 * dropped; it is now held for the task's next agent (src/main/held-messages).
 *
 * #804: a resumed session whose CLI kept painting never went quiet, the wait
 * timed out, and the message was dropped with no word while the run said it
 * was sent. Every way the message ends is now logged, held or recorded on the
 * row's run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PROJECT_ID = 'proj-1';
const TASK_ID = 'task-moved';
const RUN_ID = 'run-move-1';
const MESSAGE = 'The review found two issues.';

const hoisted = vi.hoisted(() => ({
  waitForTurnCompletion: vi.fn<(...callArguments: unknown[]) => Promise<string>>(async () => 'completed'),
  deliverAgentMessageAndWait: vi.fn<(...callArguments: unknown[]) => Promise<undefined>>(async () => undefined),
  holdTaskMessage: vi.fn<(...callArguments: unknown[]) => unknown>(() => ({ status: 'held', displayId: 7, rowId: 'held-1' })),
  workflowStepApplies: vi.fn(() => false),
  updateDetail: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: () => ({
    tasks: { getById: () => ({ id: TASK_ID, agent: 'claude', workflow_id: null, workflow_project_id: null }) },
    automationRuns: { updateDetail: hoisted.updateDetail },
  }),
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({ resolveInjectionVerifier: () => null }));
vi.mock('../../src/main/transition-engine/turn-completion', () => ({ waitForTurnCompletion: hoisted.waitForTurnCompletion }));
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({
  deliverAgentMessageAndWait: hoisted.deliverAgentMessageAndWait,
}));
vi.mock('../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: hoisted.holdTaskMessage }));
vi.mock('../../src/main/workflows/workflow-step', () => ({ workflowStepApplies: hoisted.workflowStepApplies }));

const { deliverMessageAfterMove } = await import('../../src/main/automations/turn-end/deliver-message');
const { supersedeTurnEndWork, takeMoveFollowUpMessage, hasMoveFollowUp } = await import('../../src/main/automations/turn-end/turn-end-passes');

function makeContext(live: { id: string; writable: boolean } | null) {
  const current = { live };
  return {
    current,
    context: {
      sessionManager: {
        findLiveSessionByTaskId: vi.fn(() => (current.live ? { id: current.live.id } : undefined)),
        isWritable: vi.fn((sessionId: string) => current.live?.id === sessionId && current.live.writable),
      },
    } as never,
  };
}

const LIVE = { id: 'live-session', writable: true };

async function run(context: never, options: { withRun?: boolean } = {}): Promise<void> {
  const delivery = deliverMessageAfterMove(
    context, PROJECT_ID, TASK_ID, 'Blocked', MESSAGE,
    options.withRun === false ? undefined : RUN_ID,
  );
  await vi.advanceTimersByTimeAsync(3_000);
  await delivery;
}

/** A turn wait that parks until the test settles it. */
function parkTurnWait(): { settle: (outcome: string) => void } {
  const parked = { settle: (_outcome: string): void => undefined };
  hoisted.waitForTurnCompletion.mockImplementation(
    () => new Promise<string>((resolve) => { parked.settle = resolve; }),
  );
  return parked;
}

function recordedDetail(): string | undefined {
  const call = hoisted.updateDetail.mock.calls.at(-1);
  expect(call?.[0]).toBe(RUN_ID);
  return call?.[1] as string | undefined;
}

describe('deliverMessageAfterMove', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.waitForTurnCompletion.mockReset();
    hoisted.waitForTurnCompletion.mockResolvedValue('completed');
    hoisted.deliverAgentMessageAndWait.mockReset();
    hoisted.deliverAgentMessageAndWait.mockResolvedValue(undefined);
    hoisted.holdTaskMessage.mockReset();
    hoisted.holdTaskMessage.mockReturnValue({ status: 'held', displayId: 7, rowId: 'held-1' });
    hoisted.workflowStepApplies.mockReset();
    hoisted.workflowStepApplies.mockReturnValue(false);
    hoisted.updateDetail.mockReset();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('holds the message when the column it moved to runs no agent', async () => {
    const { context } = makeContext(null);

    await run(context);

    // Red before held messages: logged and dropped.
    expect(hoisted.holdTaskMessage).toHaveBeenCalledWith(context, {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      message: MESSAGE,
    });
    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
    expect(recordedDetail()).toContain('held for the task\'s next agent');
  });

  it('holds it while the task\'s agent is still queued, with no PTY to type into', async () => {
    await run(makeContext({ id: 'queued-session', writable: false }).context);

    expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.waitForTurnCompletion).not.toHaveBeenCalled();
  });

  it('hands it to a running agent once its turn ends, and records that it arrived', async () => {
    await run(makeContext(LIVE).context);

    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
    expect(hoisted.deliverAgentMessageAndWait).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: 'live-session',
      message: MESSAGE,
    }));
    // Red before #804: the run kept "with a message" from move time, whatever happened.
    expect(recordedDetail()).toBe('Moved to Blocked, with a message the agent there received.');
  });

  it('gives up on quiet for an idle agent whose terminal keeps painting, on both waits', async () => {
    await run(makeContext(LIVE).context);

    // Red before #804: no give-up, so a CLI repainting its status line held the
    // message for the whole hour and it was dropped.
    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledWith(
      expect.anything(),
      'live-session',
      expect.objectContaining({ idleWithoutQuietMs: 120_000, acceptHeld: false }),
    );
    expect(hoisted.deliverAgentMessageAndWait).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idleWithoutQuietMs: 120_000, acceptHeld: false }),
    );
  });

  it('takes a turn held only by background work for a running workflow\'s task', async () => {
    hoisted.workflowStepApplies.mockReturnValue(true);

    await run(makeContext(LIVE).context);

    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledWith(
      expect.anything(),
      'live-session',
      expect.objectContaining({ acceptHeld: true }),
    );
    expect(hoisted.deliverAgentMessageAndWait).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acceptHeld: true }),
    );
  });

  it('holds it when the agent exits before its turn ends', async () => {
    hoisted.waitForTurnCompletion.mockResolvedValue('exited');

    await run(makeContext(LIVE).context);

    expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
  });

  it('holds it when the agent\'s turn does not end within the wait', async () => {
    hoisted.waitForTurnCompletion.mockResolvedValue('timeout');

    await run(makeContext(LIVE).context);

    // Red before #804: `if (settled !== 'completed') return;` dropped it silently.
    expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('did not end its turn'));
    expect(recordedDetail()).toContain('held for the task\'s next agent');
  });

  it('holds nothing when the move was superseded while the agent exited, and says so', async () => {
    // A later move cancels this delivery (`supersedeTurnEndWork`). The exit
    // that follows is the later move ending the session, not the destination
    // being left without an agent, so holding the message here would give a
    // message meant for the column the task left to the next agent in the
    // column it is in now.
    const parked = parkTurnWait();

    const delivery = deliverMessageAfterMove(makeContext(LIVE).context, PROJECT_ID, TASK_ID, 'Blocked', MESSAGE, RUN_ID);
    await vi.advanceTimersByTimeAsync(3_000);
    // Parked on the turn wait, past the settle delay: superseding earlier would
    // return at the first abort check and prove nothing about the exit branch.
    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);

    supersedeTurnEndWork(TASK_ID);
    const turnWaitOptions = hoisted.waitForTurnCompletion.mock.calls[0][2] as { signal: AbortSignal };
    expect(turnWaitOptions.signal.aborted).toBe(true);
    parked.settle('exited');
    await delivery;

    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
    // Red before #804: a superseded message ended with no log and no record.
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('the task moved on first'));
    expect(recordedDetail()).toContain('because the task moved on first');
  });

  it('lets workflow recovery take a waiting message, and then records and delivers nothing itself', async () => {
    const parked = parkTurnWait();
    const delivery = deliverMessageAfterMove(makeContext(LIVE).context, PROJECT_ID, TASK_ID, 'Blocked', MESSAGE, RUN_ID);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(hasMoveFollowUp(TASK_ID)).toBe(true);

    const taken = takeMoveFollowUpMessage(TASK_ID);
    expect(taken?.message).toBe(MESSAGE);
    expect(hasMoveFollowUp(TASK_ID)).toBe(false);
    parked.settle('aborted');
    await delivery;

    expect(hoisted.deliverAgentMessageAndWait).not.toHaveBeenCalled();
    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
    expect(hoisted.updateDetail).not.toHaveBeenCalled();

    // The taker reports the outcome through the follow-up's own run.
    taken?.report({ kind: 'handed-to-recovery' });
    expect(recordedDetail()).toBe('Moved to Blocked; workflow recovery sent its message in place of a nudge.');
  });

  it('holds it when the session ends under a delivery that fails', async () => {
    const { context, current } = makeContext(LIVE);
    hoisted.deliverAgentMessageAndWait.mockImplementation(async () => {
      current.live = null;
      throw new Error('The session was no longer running.');
    });

    await run(context);

    expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
  });

  it('records the error when a delivery fails with the agent still there', async () => {
    hoisted.deliverAgentMessageAndWait.mockRejectedValue(new Error('The paste failed.'));

    await run(makeContext(LIVE).context);

    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
    expect(recordedDetail()).toBe('Moved to Blocked; its message was not delivered: The paste failed.');
  });

  it('logs and records a message the task refuses to hold (a move into Done)', async () => {
    hoisted.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'Task #7 is in Done, where no agent runs.' });

    await expect(run(makeContext(null).context)).resolves.toBeUndefined();

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('is not held'));
    expect(recordedDetail()).toContain('could not be held: Task #7 is in Done');
  });

  it('writes no run detail for a move with no run (kangentic_move_task)', async () => {
    await run(makeContext(LIVE).context, { withRun: false });

    expect(hoisted.deliverAgentMessageAndWait).toHaveBeenCalledTimes(1);
    expect(hoisted.updateDetail).not.toHaveBeenCalled();
  });
});
