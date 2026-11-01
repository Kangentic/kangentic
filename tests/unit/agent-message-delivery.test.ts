/**
 * The one decision every path that hands a column's message to a live agent
 * shares (`src/main/automations/turn-end/agent-message-delivery.ts`): a
 * one-line message, or a slash command, is typed as keystrokes through the
 * scheduler; a message with line breaks, or a long one, is pasted
 * (`submitContent`), because keystrokes flatten line breaks to spaces.
 *
 * The turn wait is mocked so each test decides when the agent's turn ends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnCompletionResult } from '../../src/main/transition-engine/turn-completion';
import type { InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';

const turnWaits = vi.hoisted(() => [] as Array<{
  sessionId: string;
  signal: AbortSignal | undefined;
  resolve: (result: TurnCompletionResult) => void;
}>);

vi.mock('../../src/main/transition-engine/turn-completion', () => ({
  waitForTurnCompletion: vi.fn((
    _sessionManager: unknown,
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ) => new Promise<TurnCompletionResult>((resolve) => {
    if (options.signal?.aborted) {
      resolve('aborted');
      return;
    }
    options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
    turnWaits.push({ sessionId, signal: options.signal, resolve });
  })),
}));

import {
  deliverAgentMessageAndWait,
  deliverAgentMessageInBackground,
  needsPaste,
  shouldPaste,
} from '../../src/main/automations/turn-end/agent-message-delivery';
import { supersedeMessageDeliveries } from '../../src/main/automations/turn-end/turn-end-passes';

const TASK_ID = 'task-paste-0001';
const SESSION_ID = 'session-live-1';
const MULTI_LINE = 'The reviewer says:\n- fix the null check\n- add a test';

function makeContext(sessionStatus: string | null = 'running') {
  return {
    sessionManager: {
      getSession: vi.fn((id: string) => (sessionStatus ? { id, status: sessionStatus } : undefined)),
      // At its input box, or an agent that draws none in the alternate screen.
      awaitInputReady: vi.fn(async () => true),
    },
    terminalSubmitScheduler: {
      scheduleKeystrokes: vi.fn(),
      hasPending: vi.fn(() => false),
    },
    terminalSubmit: {
      submitContent: vi.fn(async () => undefined),
    },
  };
}

/** Let the background paste's awaits run. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

/**
 * Pastes for one task are chained, so a paste a test left waiting would hold
 * up the next test's. End every wait and every tracked paste first.
 */
async function resetPastes(): Promise<void> {
  supersedeMessageDeliveries(TASK_ID);
  for (const wait of turnWaits) wait.resolve('aborted');
  await settle();
  turnWaits.length = 0;
  vi.clearAllMocks();
}

describe('shouldPaste', () => {
  it('pastes a message with line breaks or over 1,000 characters', () => {
    expect(shouldPaste(MULTI_LINE)).toBe(true);
    expect(shouldPaste('x'.repeat(1_001))).toBe(true);
    expect(needsPaste('x'.repeat(1_000))).toBe(false);
  });

  it('keeps a one-line message as keystrokes', () => {
    expect(shouldPaste('Review the diff and summarize it.')).toBe(false);
  });

  it('keeps a slash command as keystrokes even when it spans lines, so it still runs', () => {
    // `{{attachments}}` resolves to "\n/path...", so a column's
    // `/code-review {{attachments}}` reaches here with line breaks. Pasted, the
    // command would arrive as literal text and never run.
    expect(needsPaste('/code-review\n/mock/screenshot.png')).toBe(true);
    expect(shouldPaste('/code-review\n/mock/screenshot.png')).toBe(false);
    expect(shouldPaste('  /code-review\n/mock/screenshot.png')).toBe(false);
    expect(shouldPaste('/plugin:review now\nwith notes')).toBe(false);
  });

  it('pastes a multi-line reply that opens with a path: a path is not a slash command', () => {
    // An agent reply carried by {{agentReply}} can start with a file path.
    // Typed as keystrokes, its line breaks would be flattened to spaces.
    expect(shouldPaste('/src/main/workflows/workflow-step.ts is the file.\nIt moves the task on.')).toBe(true);
    expect(shouldPaste('/mock/screenshot.png\nshows the bug')).toBe(true);
  });
});

describe('deliverAgentMessageInBackground', () => {
  beforeEach(resetPastes);

  it('schedules a one-line message as keystrokes, exactly as before', () => {
    const context = makeContext();
    const onOutcome = vi.fn();
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: '/standup',
      mode: 'deferred',
      verifier: null,
      freshlySpawned: true,
      onOutcome,
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      TASK_ID,
      SESSION_ID,
      [{ text: '/standup', verify: 'submitted' }],
      { freshlySpawned: true, verifier: null, mode: 'deferred', onOutcome },
    );
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(turnWaits).toHaveLength(0);
  });

  it('pastes a multi-line message once the turn ends and the scheduler is done with the task', async () => {
    const context = makeContext();
    // A keystroke burst scheduled ahead of the paste is still pending at the
    // first turn end, so the paste waits for the next one.
    context.terminalSubmitScheduler.hasPending.mockReturnValueOnce(true).mockReturnValue(false);
    const reports: InjectionReport[] = [];
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      onOutcome: (report) => reports.push(report),
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    await settle();
    expect(turnWaits).toHaveLength(1);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();

    turnWaits[0].resolve('completed');
    await settle();
    // Red: dropping the `hasPending` check pastes here, over the burst.
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(turnWaits).toHaveLength(2);

    turnWaits[1].resolve('completed');
    await settle();
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledWith(
      SESSION_ID,
      MULTI_LINE,
      // `automated: true` makes the paste wait for the automated-keys guard, so
      // it never lands in the middle of a person's typing. Red: dropping it
      // from the background path's submitContent call.
      expect.objectContaining({ signal: expect.any(AbortSignal), automated: true }),
    );
    await settle();
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe('unconfirmed');
    expect(reports[0].commands).toEqual([MULTI_LINE]);
  });

  it('waits for the agent to reach its input box before the turn wait, so a screen it shows first never takes the paste', async () => {
    const context = makeContext();
    // Claude at its approval of a new project MCP server: drawn before the alternate screen.
    let reachInputBox: (atInput: boolean) => void = () => {};
    context.sessionManager.awaitInputReady.mockImplementationOnce(() => new Promise<boolean>((resolve) => { reachInputBox = resolve; }));
    const reports: InjectionReport[] = [];
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      onOutcome: (report) => reports.push(report),
    });
    await settle();
    expect(context.sessionManager.awaitInputReady).toHaveBeenCalledWith(SESSION_ID, expect.any(Number), expect.any(AbortSignal));
    // Red: without the gate the turn wait starts here, and the stale-thinking
    // reclaim would end it with the screen still up.
    expect(turnWaits).toHaveLength(0);

    reachInputBox(true);
    await settle();
    expect(turnWaits).toHaveLength(1);
    turnWaits[0].resolve('completed');
    await settle();
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1);
  });

  it('reports a paste failed, writing nothing, when the agent never reaches its input box', async () => {
    const context = makeContext();
    context.sessionManager.awaitInputReady.mockResolvedValueOnce(false);
    const reports: InjectionReport[] = [];
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      onOutcome: (report) => reports.push(report),
    });
    await settle();

    expect(turnWaits).toHaveLength(0);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(reports.map((report) => report.outcome)).toEqual(['failed']);
    expect(reports[0].textReachedAgent).toBe(false);
  });

  it('a move out of the column cancels a paste still waiting for the turn, and reports it cancelled', async () => {
    const context = makeContext();
    const reports: InjectionReport[] = [];
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      onOutcome: (report) => reports.push(report),
    });
    await settle();
    expect(turnWaits).toHaveLength(1);

    supersedeMessageDeliveries(TASK_ID);
    await settle();

    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(reports.map((report) => report.outcome)).toEqual(['cancelled']);
  });

  it('two pastes for one task run one after the other, never at once, and neither cancels the other', async () => {
    const context = makeContext();
    let finishFirstPaste: () => void = () => undefined;
    context.terminalSubmit.submitContent.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => { finishFirstPaste = () => resolve(undefined); }),
    );
    const onOutcome = vi.fn();
    for (const message of ['first\nmessage', 'second\nmessage']) {
      deliverAgentMessageInBackground(context as never, {
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        message,
        mode: 'immediate',
        verifier: null,
        onOutcome,
      });
    }
    await settle();
    // Red: without the chain both waits start now, both see the same turn
    // end, and both pastes write at once.
    expect(turnWaits).toHaveLength(1);

    turnWaits[0].resolve('completed');
    await settle();
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmit.submitContent.mock.calls[0][1]).toBe('first\nmessage');
    // The second waits for the first paste itself, not just its turn.
    expect(turnWaits).toHaveLength(1);

    finishFirstPaste();
    await settle();
    expect(turnWaits).toHaveLength(2);
    expect(turnWaits[1].signal?.aborted).toBe(false);
    turnWaits[1].resolve('completed');
    await settle();
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledTimes(2);
    expect(context.terminalSubmit.submitContent.mock.calls[1][1]).toBe('second\nmessage');
    expect(onOutcome.mock.calls.map((call) => (call[0] as InjectionReport).outcome)).toEqual(['unconfirmed', 'unconfirmed']);
  });

  it('a move cancels a paste still queued behind another, and reports it cancelled', async () => {
    const context = makeContext();
    const reports: InjectionReport[] = [];
    for (const message of ['first\nmessage', 'second\nmessage']) {
      deliverAgentMessageInBackground(context as never, {
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        message,
        mode: 'immediate',
        verifier: null,
        onOutcome: (report) => reports.push(report),
      });
    }
    await settle();
    expect(turnWaits).toHaveLength(1);

    supersedeMessageDeliveries(TASK_ID);
    await settle();

    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(reports.map((report) => report.outcome)).toEqual(['cancelled', 'cancelled']);
  });

  it('fails at once, without waiting, when the session is already gone', async () => {
    const context = makeContext(null);
    const reports: InjectionReport[] = [];
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      onOutcome: (report) => reports.push(report),
    });
    await settle();

    expect(turnWaits).toHaveLength(0);
    expect(reports.map((report) => report.outcome)).toEqual(['failed']);
    // Nothing was written, so a held message carried by it goes back on hold.
    expect(reports[0].textReachedAgent).toBe(false);
  });

  it('says nothing reached the agent for a paste superseded or failed before it wrote', async () => {
    const context = makeContext();
    const reports: InjectionReport[] = [];
    for (const message of ['superseded\nmessage', 'exited\nmessage']) {
      deliverAgentMessageInBackground(context as never, {
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        message,
        mode: 'immediate',
        verifier: null,
        onOutcome: (report) => reports.push(report),
      });
    }
    await settle();
    turnWaits[0].resolve('exited');
    await settle();
    supersedeMessageDeliveries(TASK_ID);
    await settle();

    expect(reports.map((report) => [report.outcome, report.textReachedAgent])).toEqual([
      ['failed', false],
      ['cancelled', false],
    ]);
  });

  it('leaves the flag off once the paste began writing, where a failure may have landed part of it', async () => {
    const context = makeContext();
    context.terminalSubmit.submitContent.mockRejectedValueOnce(new Error('no submission evidence'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reports: InjectionReport[] = [];
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      onOutcome: (report) => reports.push(report),
    });
    await settle();
    turnWaits[0].resolve('completed');
    await settle();

    expect(reports.map((report) => report.outcome)).toEqual(['failed']);
    expect(reports[0].textReachedAgent).toBeUndefined();
    consoleErrorSpy.mockRestore();
  });
});

describe('deliverAgentMessageAndWait', () => {
  beforeEach(resetPastes);

  it('keeps a one-line message on the awaited keystroke path', async () => {
    const context = makeContext();
    context.terminalSubmitScheduler.scheduleKeystrokes.mockImplementation((
      _taskId: string,
      _sessionId: string,
      _commands: unknown,
      options: { onOutcome: (report: Partial<InjectionReport>) => void },
    ) => options.onOutcome({ outcome: 'confirmed' }));

    await deliverAgentMessageAndWait(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: 'Wrap up and summarize.',
      mode: 'immediate',
      verifier: null,
      signal: new AbortController().signal,
      turnWait: 'when-deferred',
    });

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('on exit, an immediate multi-line message is pasted now, handed the run signal, and awaited', async () => {
    const context = makeContext();
    let finishPaste: () => void = () => undefined;
    context.terminalSubmit.submitContent.mockImplementation(
      () => new Promise<undefined>((resolve) => { finishPaste = () => resolve(undefined); }),
    );
    const runController = new AbortController();
    let delivered = false;
    const delivery = deliverAgentMessageAndWait(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      signal: runController.signal,
      turnWait: 'when-deferred',
    }).then(() => { delivered = true; });

    await settle();
    expect(turnWaits).toHaveLength(0);
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledWith(
      SESSION_ID,
      MULTI_LINE,
      // Red: dropping `automated: true` from the awaited path's submitContent call.
      expect.objectContaining({ signal: runController.signal, automated: true }),
    );
    expect(delivered).toBe(false);

    finishPaste();
    await delivery;
    expect(delivered).toBe(true);
  });

  it('at a turn end, waits behind a background paste for the same task, bounded by its own signal', async () => {
    const context = makeContext();
    deliverAgentMessageInBackground(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: 'enter row\nmessage',
      mode: 'immediate',
      verifier: null,
      onOutcome: vi.fn(),
    });
    await settle();
    expect(turnWaits).toHaveLength(1);

    const runController = new AbortController();
    const delivery = deliverAgentMessageAndWait(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      signal: runController.signal,
      turnWait: 'always',
      abortReason: 'stopped',
    });
    await settle();
    // Queued behind the enter paste: no turn wait of its own yet.
    expect(turnWaits).toHaveLength(1);

    runController.abort();
    await expect(delivery).rejects.toThrow('stopped');
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('on exit, a deferred multi-line message waits for the turn, and the run signal stops it', async () => {
    const context = makeContext();
    const runController = new AbortController();
    const delivery = deliverAgentMessageAndWait(context as never, {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'deferred',
      verifier: null,
      signal: runController.signal,
      turnWait: 'when-deferred',
    });
    await settle();
    expect(turnWaits).toHaveLength(1);
    expect(turnWaits[0].signal).toBe(runController.signal);

    runController.abort();
    await expect(delivery).rejects.toThrow('The message was not delivered before the exit budget ran out.');
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });
});
