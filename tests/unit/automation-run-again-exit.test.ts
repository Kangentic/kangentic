/**
 * Run again (`runAutomationAgain`, src/main/ipc/helpers/automation-run-again.ts)
 * never re-sends an On task exit message.
 *
 * Run again works on the task as it is now, and by then the task has left the
 * row's column. For a failed Design "Signed off" exit message, Run again would
 * have typed it into the agent the next column started, in the middle of its
 * plan. Nothing records which session the
 * failed run was for, so the row is refused outright. An exit row that needs no
 * agent (a script, a webhook) still runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutoCommandMode } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  executed: [] as string[],
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(() => vi.fn()),
  clearSpawnProgress: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({ reportAutoCommandOutcome: vi.fn() }));
// The runner, reduced to what matters here: a row that runs hands a message to
// `deliverToAgent` when it is a message, and records that it ran.
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  resolveInjectionVerifier: vi.fn(() => null),
  createTransitionEngine: vi.fn(() => ({
    executeSingleAutomation: vi.fn(async (
      _task: unknown,
      _column: unknown,
      automation: { id: string; type: string },
      runOptions: { signal: AbortSignal; deliverToAgent: (message: string, mode: AutoCommandMode, signal: AbortSignal) => Promise<void> },
    ) => {
      hoisted.executed.push(automation.id);
      if (automation.type === 'send_message') await runOptions.deliverToAgent('Signed off', 'immediate', runOptions.signal);
      return { outcomes: [{ runId: 'run-1', name: automation.id, columnName: 'Design', status: 'succeeded', detail: 'Ran' }] };
    }),
  })),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    automations: {
      listAll: vi.fn(() => [
        { id: 'row-exit-message', swimlane_id: 'lane-design', type: 'send_message', trigger: 'exit', config: {} },
        { id: 'row-exit-script', swimlane_id: 'lane-design', type: 'run_script', trigger: 'exit', config: {} },
      ]),
    },
    swimlanes: { getById: vi.fn(() => ({ id: 'lane-design', name: 'Design' })) },
    // The task has left Design for Planning, whose own agent now holds the session.
    tasks: {
      getById: vi.fn(() => ({
        id: 'task-rerun-exit', title: 'My Task', agent: 'claude', swimlane_id: 'lane-planning', session_id: 'session-planning',
      })),
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
    sessionManager: {
      getSession: vi.fn((id: string) => ({ id, status: 'running' })),
      awaitInputReady: vi.fn(async () => true),
      isAgentLaunching: vi.fn(() => false),
      awaitAgentLaunched: vi.fn(async () => true),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn(), hasPending: vi.fn(() => false) },
    terminalSubmit: { submitContent: vi.fn(async () => undefined) },
  };
}

describe('runAutomationAgain: an On task exit row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.executed.length = 0;
  });

  it('refuses an exit message with a reason, and the next column\'s agent is sent nothing', async () => {
    const context = makeContext();

    const result = await runAutomationAgain(context as never, 'proj-test', 'task-rerun-exit', 'row-exit-message');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Design');
    // Red: the row ran against the task's current session, the Planning agent.
    expect(hoisted.executed).toEqual([]);
    expect(context.terminalSubmitScheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(context.terminalSubmit.submitContent).not.toHaveBeenCalled();
  });

  it('still runs an exit row that needs no agent', async () => {
    const context = makeContext();

    const result = await runAutomationAgain(context as never, 'proj-test', 'task-rerun-exit', 'row-exit-script');

    expect(result.ok).toBe(true);
    expect(hoisted.executed).toEqual(['row-exit-script']);
  });
});
