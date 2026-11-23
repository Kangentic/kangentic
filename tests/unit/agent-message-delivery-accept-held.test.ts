/**
 * `acceptHeld` reaches the paste path's turn wait: `deliverAgentMessageAndWait`
 * hands it to `waitForTurnCompletion`, `deliverMessageToSession` forwards it
 * into `deliverAgentMessageAndWait`, and `pasteAgentMessageInBackground` hands
 * it to its own turn wait. The turn wait is mocked; only the options
 * it receives are asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  waitForTurnCompletion: vi.fn(async () => 'completed' as const),
}));

vi.mock('../../src/main/transition-engine/turn-completion', () => ({
  waitForTurnCompletion: hoisted.waitForTurnCompletion,
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: () => ({}) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => ({}) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({ resolveInjectionVerifier: () => null }));
vi.mock('../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: vi.fn() }));

import { deliverAgentMessageAndWait, pasteAgentMessageInBackground } from '../../src/main/automations/turn-end/agent-message-delivery';
import type { InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';
import { deliverMessageToSession } from '../../src/main/automations/turn-end/deliver-message';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const TASK_ID = 'task-held-0001';
const SESSION_ID = 'session-held-live';
const MULTI_LINE = 'The reviewer says:\n- fix the null check\n- add a test';

function makeContext(): IpcContext {
  return {
    sessionManager: {
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
      awaitAgentLaunched: vi.fn(async () => true),
    },
    terminalSubmit: {
      submitContent: vi.fn(async () => undefined),
    },
  } as unknown as IpcContext;
}

function lastTurnWaitOptions(): { acceptHeld?: boolean } {
  const calls = hoisted.waitForTurnCompletion.mock.calls as unknown as Array<[unknown, string, { acceptHeld?: boolean }]>;
  return calls[calls.length - 1][2];
}

describe('acceptHeld on the paste path', () => {
  beforeEach(() => {
    hoisted.waitForTurnCompletion.mockClear();
  });

  it('deliverAgentMessageAndWait passes acceptHeld true to the turn wait', async () => {
    await deliverAgentMessageAndWait(makeContext(), {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      signal: new AbortController().signal,
      turnWait: 'always',
      acceptHeld: true,
    });
    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
    expect(lastTurnWaitOptions().acceptHeld).toBe(true);
  });

  it('deliverAgentMessageAndWait leaves acceptHeld unset by default', async () => {
    await deliverAgentMessageAndWait(makeContext(), {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      signal: new AbortController().signal,
      turnWait: 'always',
    });
    expect(lastTurnWaitOptions().acceptHeld).toBeFalsy();
  });

  it('deliverMessageToSession forwards acceptHeld true down to the turn wait', async () => {
    await deliverMessageToSession(makeContext(), {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      signal: new AbortController().signal,
      acceptHeld: true,
    });
    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
    expect(lastTurnWaitOptions().acceptHeld).toBe(true);
  });

  // The release of held messages at a held turn end (`registerHeldMessageFlush`)
  // pastes through this path; without the option it would wait for the drain.
  it.each([
    ['passes acceptHeld true to the turn wait when asked', { acceptHeld: true }, true],
    ['leaves acceptHeld unset by default', {}, undefined],
  ])('pasteAgentMessageInBackground %s', async (_label, options, expected) => {
    const context = {
      sessionManager: {
        getSession: vi.fn((id: string) => ({ id, status: 'running' })),
        awaitInputReady: vi.fn(async () => true),
        awaitAgentLaunched: vi.fn(async () => true),
      },
      terminalSubmit: { submitContent: vi.fn(async () => undefined) },
      terminalSubmitScheduler: { hasPending: vi.fn(() => false) },
    } as unknown as IpcContext;
    const report = await new Promise<InjectionReport>((resolve) => {
      pasteAgentMessageInBackground(context, {
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        message: MULTI_LINE,
        onOutcome: resolve,
        ...options,
      });
    });

    expect(report.outcome).toBe('unconfirmed');
    expect(hoisted.waitForTurnCompletion).toHaveBeenCalledTimes(1);
    expect(lastTurnWaitOptions().acceptHeld).toBe(expected);
  });

  // A held message logged as `automation:<task>` read as a column automation.
  it.each([
    ['labels a held-message paste as one', { source: 'held-message' as const }, `held-message:${TASK_ID.slice(0, 8)}`],
    ['labels a paste with no source as an automation', {}, `automation:${TASK_ID.slice(0, 8)}`],
  ])('pasteAgentMessageInBackground %s', async (_label, options, expected) => {
    const submitContent = vi.fn(async () => undefined);
    const context = {
      sessionManager: {
        getSession: vi.fn((id: string) => ({ id, status: 'running' })),
        awaitInputReady: vi.fn(async () => true),
        awaitAgentLaunched: vi.fn(async () => true),
      },
      terminalSubmit: { submitContent },
      terminalSubmitScheduler: { hasPending: vi.fn(() => false) },
    } as unknown as IpcContext;
    await new Promise<InjectionReport>((resolve) => {
      pasteAgentMessageInBackground(context, {
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        message: MULTI_LINE,
        onOutcome: resolve,
        ...options,
      });
    });

    expect(submitContent).toHaveBeenCalledWith(SESSION_ID, MULTI_LINE, expect.objectContaining({ source: expected }));
  });

  it('deliverMessageToSession leaves acceptHeld unset when not given', async () => {
    await deliverMessageToSession(makeContext(), {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      message: MULTI_LINE,
      mode: 'immediate',
      verifier: null,
      signal: new AbortController().signal,
    });
    expect(lastTurnWaitOptions().acceptHeld).toBeFalsy();
  });
});
