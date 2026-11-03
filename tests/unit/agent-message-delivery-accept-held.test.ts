/**
 * `acceptHeld` reaches the paste path's turn wait: `deliverAgentMessageAndWait`
 * hands it to `waitForTurnCompletion`, and `deliverMessageToSession` forwards it
 * into `deliverAgentMessageAndWait`. The turn wait is mocked; only the options
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

import { deliverAgentMessageAndWait } from '../../src/main/automations/turn-end/agent-message-delivery';
import { deliverMessageToSession } from '../../src/main/automations/turn-end/deliver-message';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const TASK_ID = 'task-held-0001';
const SESSION_ID = 'session-held-live';
const MULTI_LINE = 'The reviewer says:\n- fix the null check\n- add a test';

function makeContext(): IpcContext {
  return {
    sessionManager: {
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
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
