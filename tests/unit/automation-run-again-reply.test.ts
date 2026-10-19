/**
 * Run again (`runAutomationAgain`, src/main/ipc/helpers/automation-run-again.ts)
 * on a turn-end row reads the task session's latest final message and hands it
 * to the runner, so a re-run judges its Text match or Condition against the same
 * text a turn end does. Before this a re-run passed no reply at all: a Text
 * match read nothing and an Agent evaluation was asked about no message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutomationTrigger } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  trigger: 'turn_end' as AutomationTrigger,
  finalLine: 'Verdict: Ready' as string | null,
  sessionId: 'session-live-1' as string | null,
  /** The task's session once the lock is held, when a queued move changed it. */
  sessionIdInLock: undefined as string | null | undefined,
  taskReads: 0,
  reply: { text: 'The review is done.\n\nVerdict: Ready', uuid: 'reply-1', ts: 0 } as { text: string; uuid: string; ts: number } | null,
  readFinalReply: vi.fn(),
  /** The retrieval worker call the REAL reader makes, for the one test that lets it run. */
  retrievalCall: vi.fn(),
  executeSingleAutomation: vi.fn(),
}));

vi.mock('../../src/main/automations/turn-end/final-reply-reader', () => ({
  readSessionFinalReply: hoisted.readFinalReply,
}));
// What the real reader reaches when a test lets it run (see the `since` test below).
vi.mock('../../src/main/retrieval/retrieval-client', () => ({ retrievalClient: { call: hoisted.retrievalCall } }));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn(), list: vi.fn(() => []) } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId = vi.fn(() => ({ session_type: 'claude_agent', agent_session_id: 'agent-session-live-1', cwd: '/mock/worktree' }));
  },
}));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(() => vi.fn()),
  clearSpawnProgress: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({ reportAutoCommandOutcome: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  resolveInjectionVerifier: vi.fn(() => null),
  createTransitionEngine: vi.fn(() => ({ executeSingleAutomation: hoisted.executeSingleAutomation })),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    automations: {
      listAll: vi.fn(() => [{
        id: 'row-move',
        swimlane_id: 'lane-review',
        type: 'move_to_column',
        trigger: hoisted.trigger,
        config: {},
        condition: null,
        final_line: hoisted.finalLine,
      }]),
    },
    swimlanes: { getById: vi.fn(() => ({ id: 'lane-review', name: 'Code Review' })) },
    tasks: {
      getById: vi.fn(() => {
        hoisted.taskReads += 1;
        // The first read is before the lock; any later one is inside it.
        const inLock = hoisted.taskReads > 1 && hoisted.sessionIdInLock !== undefined;
        // In the row's own column, which a Move to column re-run requires.
        return {
          id: 'task-rerun-0002',
          title: 'My Task',
          agent: 'claude',
          swimlane_id: 'lane-review',
          session_id: inLock ? hoisted.sessionIdInLock : hoisted.sessionId,
        };
      }),
    },
    automationRuns: {},
    attachments: {},
  })),
}));

import { runAutomationAgain } from '../../src/main/ipc/helpers/automation-run-again';

function makeContext() {
  return {
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', path: '/mock/project' })) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: { getSession: vi.fn() },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), hasPending: vi.fn(() => false) },
    terminalSubmit: { submitContent: vi.fn(async () => undefined) },
  };
}

/** The `agentReply` the runner was handed on the one re-run. */
function agentReplyPassed(): unknown {
  const [, , , options] = hoisted.executeSingleAutomation.mock.calls[0] as [unknown, unknown, unknown, { agentReply?: unknown }];
  return options.agentReply;
}

describe('runAutomationAgain: the reply a turn-end row is judged against', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.trigger = 'turn_end';
    hoisted.finalLine = 'Verdict: Ready';
    hoisted.sessionId = 'session-live-1';
    hoisted.sessionIdInLock = undefined;
    hoisted.taskReads = 0;
    hoisted.reply = { text: 'The review is done.\n\nVerdict: Ready', uuid: 'reply-1', ts: 0 };
    hoisted.readFinalReply.mockImplementation(async () => hoisted.reply);
    hoisted.retrievalCall.mockImplementation(async () => hoisted.reply);
    hoisted.executeSingleAutomation.mockImplementation(async () => ({
      outcomes: [{ runId: 'run-1', name: 'On to Testing', columnName: 'Code Review', status: 'succeeded', detail: 'Moved.' }],
    }));
  });

  it("reads the task session's latest final message and passes it as agentReply", async () => {
    const result = await runAutomationAgain(makeContext() as never, 'proj-test', 'task-rerun-0002', 'row-move');

    expect(result.ok).toBe(true);
    expect(hoisted.readFinalReply).toHaveBeenCalledWith({ sessionId: 'session-live-1' }, expect.anything());
    expect(agentReplyPassed()).toBe('The review is done.\n\nVerdict: Ready');
  });

  it('asks the retrieval worker for the latest reply with no anchor, since a re-run is no turn to start from', async () => {
    // The tests above stub the reader whole, so none of them reaches the worker
    // call. Let the real reader run for this one: the anchor a turn end reads
    // from is the turn's own, and a re-run judges the latest reply whatever
    // turn wrote it, so `since` must reach the worker as null.
    const finalReplyReader = await vi.importActual<typeof import('../../src/main/automations/turn-end/final-reply-reader')>(
      '../../src/main/automations/turn-end/final-reply-reader',
    );
    hoisted.readFinalReply.mockImplementation(finalReplyReader.readSessionFinalReply);

    const result = await runAutomationAgain(makeContext() as never, 'proj-test', 'task-rerun-0002', 'row-move');

    expect(result.ok).toBe(true);
    expect(hoisted.retrievalCall).toHaveBeenCalledTimes(1);
    expect(hoisted.retrievalCall).toHaveBeenCalledWith(
      'transcript.finalReply',
      expect.objectContaining({ since: null }),
      expect.anything(),
    );
    // The reply that worker call returned is the one the row is judged against.
    expect(agentReplyPassed()).toBe('The review is done.\n\nVerdict: Ready');
  });

  it('passes null, not undefined, when the read finds nothing, so the row is judged as a turn end with no message', async () => {
    hoisted.reply = null;

    await runAutomationAgain(makeContext() as never, 'proj-test', 'task-rerun-0002', 'row-move');

    expect(agentReplyPassed()).toBeNull();
  });

  it('passes null without reading when the task has no session', async () => {
    hoisted.sessionId = null;

    await runAutomationAgain(makeContext() as never, 'proj-test', 'task-rerun-0002', 'row-move');

    expect(hoisted.readFinalReply).not.toHaveBeenCalled();
    expect(agentReplyPassed()).toBeNull();
  });

  it('reads nothing for a turn-end row that never looks at the message, and passes null', async () => {
    hoisted.finalLine = null;

    await runAutomationAgain(makeContext() as never, 'proj-test', 'task-rerun-0002', 'row-move');

    expect(hoisted.readFinalReply).not.toHaveBeenCalled();
    expect(agentReplyPassed()).toBeNull();
  });

  it('passes null when a move queued ahead of the re-run replaced the session the message came from', async () => {
    hoisted.sessionIdInLock = 'session-after-move';

    await runAutomationAgain(makeContext() as never, 'proj-test', 'task-rerun-0002', 'row-move');

    expect(hoisted.readFinalReply).toHaveBeenCalledWith({ sessionId: 'session-live-1' }, expect.anything());
    expect(agentReplyPassed()).toBeNull();
  });

  it.each(['enter', 'exit'] as const)('reads nothing for an %s row, which has no final message to judge', async (trigger) => {
    hoisted.trigger = trigger;

    await runAutomationAgain(makeContext() as never, 'proj-test', 'task-rerun-0002', 'row-move');

    expect(hoisted.readFinalReply).not.toHaveBeenCalled();
    expect(agentReplyPassed()).toBeUndefined();
  });
});
