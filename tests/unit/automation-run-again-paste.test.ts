/**
 * Run again (`runAutomationAgain`, src/main/ipc/helpers/automation-run-again.ts)
 * re-runs one Send message row against the task's live agent. A message with
 * line breaks is pasted once the agent's turn ends, and a one-line message
 * stays on the keystroke scheduler, the same as on every other path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutoCommandMode } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  turnWaits: [] as Array<{ sessionId: string; resolve: (result: 'completed') => void }>,
  rowMessage: '',
}));

vi.mock('../../src/main/transition-engine/turn-completion', () => ({
  waitForTurnCompletion: vi.fn((_sessionManager: unknown, sessionId: string) =>
    new Promise<'completed'>((resolve) => { hoisted.turnWaits.push({ sessionId, resolve }); })),
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(() => vi.fn()),
  clearSpawnProgress: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({ reportAutoCommandOutcome: vi.fn() }));
// The runner, reduced to the one call that matters here: the row hands its
// message to `deliverToAgent`.
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  resolveInjectionVerifier: vi.fn(() => null),
  createTransitionEngine: vi.fn(() => ({
    executeSingleAutomation: vi.fn(async (
      _task: unknown,
      _column: unknown,
      _automation: unknown,
      runOptions: { signal: AbortSignal; deliverToAgent: (message: string, mode: AutoCommandMode, signal: AbortSignal) => Promise<void> },
    ) => {
      await runOptions.deliverToAgent(hoisted.rowMessage, 'immediate', runOptions.signal);
      return { outcomes: [{ runId: 'run-1', name: 'Message', columnName: 'Review', status: 'succeeded', detail: 'Sent' }] };
    }),
  })),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    automations: {
      listAll: vi.fn(() => [{ id: 'row-message', swimlane_id: 'lane-review', type: 'send_message', config: {} }]),
    },
    swimlanes: { getById: vi.fn(() => ({ id: 'lane-review', name: 'Review' })) },
    tasks: { getById: vi.fn(() => ({ id: 'task-rerun-0001', title: 'My Task', agent: 'claude', session_id: 'session-live-1' })) },
    automationRuns: {},
    attachments: {},
  })),
}));

import { runAutomationAgain } from '../../src/main/ipc/helpers/automation-run-again';

function makeContext() {
  return {
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', path: '/mock/project' })) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: {
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
      awaitInputReady: vi.fn(async () => true),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), hasPending: vi.fn(() => false) },
    terminalSubmit: { submitContent: vi.fn(async () => undefined) },
  };
}

/** Let the background paste's awaits run. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

describe('runAutomationAgain: Send message delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.turnWaits.length = 0;
  });

  it('pastes a multi-line message once the agent turn ends', async () => {
    hoisted.rowMessage = 'Address the review:\n- rename the helper\n- add the test';
    const context = makeContext();

    const result = await runAutomationAgain(context as never, 'proj-test', 'task-rerun-0001', 'row-message');

    expect(result.ok).toBe(true);
    // Red: the old keystroke scheduling lands here.
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    await settle();
    expect(hoisted.turnWaits.map((wait) => wait.sessionId)).toEqual(['session-live-1']);

    hoisted.turnWaits[0].resolve('completed');
    await settle();
    expect(context.terminalSubmit.submitContent).toHaveBeenCalledWith(
      'session-live-1',
      hoisted.rowMessage,
      expect.anything(),
    );
  });

  it('keeps a one-line message on the keystroke scheduler', async () => {
    hoisted.rowMessage = '/code-review';
    const context = makeContext();

    await runAutomationAgain(context as never, 'proj-test', 'task-rerun-0001', 'row-message');
    await settle();

    expect(context.terminalSubmitScheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      'task-rerun-0001',
      'session-live-1',
      [{ text: '/code-review', verify: 'submitted' }],
      expect.objectContaining({ mode: 'immediate' }),
    );
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
    expect(hoisted.turnWaits).toHaveLength(0);
  });
});
