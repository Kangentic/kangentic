/**
 * The app side of the low-memory pause (low-memory-agent-pauser.ts): the facts
 * it reads off the session manager, the guarded pause through the Pause
 * button's own path recorded as Kangentic's, and the push with the task and
 * project names resolved in main.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostMemorySample, Session } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  pauseTaskSession: vi.fn(),
  getProjectRepos: vi.fn(),
  hasPendingMessageDelivery: vi.fn((_taskId: string) => false),
  noteWorkflowTaskPaused: vi.fn(),
}));

vi.mock('../../src/main/workflows/workflow-recovery', () => ({ noteWorkflowTaskPaused: mocks.noteWorkflowTaskPaused }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: mocks.pauseTaskSession }));
vi.mock('../../src/main/ipc/helpers', () => ({ getProjectRepos: mocks.getProjectRepos }));
vi.mock('../../src/main/automations/turn-end/turn-end-passes', () => ({
  hasPendingMessageDelivery: mocks.hasPendingMessageDelivery,
}));

import {
  buildAgentPausedEvent,
  collectIdleAgentFacts,
  createLowMemoryAgentPauser,
  simulateLowMemorySample,
} from '../../src/main/diagnostics/low-memory-agent-pauser';
import { IPC } from '../../src/shared/ipc-channels';

const GB = 1024 * 1024 * 1024;
const PARKED_AT = Date.now() - 20 * 60_000;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    status: 'running',
    startedAt: '2026-10-21T00:00:00.000Z',
    exitCode: null,
    agentName: 'claude',
    isolatedSwimlaneId: null,
    transient: false,
    workflowId: null,
    commandTerminalSlot: null,
    commandTerminalBranch: null,
    commandTerminalLabel: null,
    ...overrides,
  };
}

function makeContext(options: { enabled?: boolean; summaries?: ReturnType<typeof summary>[] } = {}) {
  return {
    sessionManager: {
      listManagedSummaries: vi.fn(() => options.summaries ?? [summary()]),
      getActivityCache: vi.fn((): Record<string, string> => ({ 'sess-1': 'idle' })),
      getActivityReasonsCache: vi.fn((): Record<string, unknown> => ({ 'sess-1': { kind: 'idle', since: PARKED_AT } })),
      getFocusedSessions: vi.fn(() => new Set<string>()),
      getPendingDraft: vi.fn((): string | null => null),
      getOpenWork: vi.fn((): { toolCalls: unknown[]; backgroundShells: unknown[]; backgroundSubagents: unknown[] } => ({
        toolCalls: [],
        backgroundShells: [],
        backgroundSubagents: [],
      })),
    },
    terminalSubmitScheduler: { hasPending: vi.fn(() => false) },
    configManager: { load: vi.fn(() => ({ agent: { pauseIdleAgentsOnLowMemory: options.enabled ?? true } })) },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', name: 'kangentic' })) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  };
}

function lowWindowsSample(): HostMemorySample {
  return {
    ts: '2026-10-21T00:00:00.000Z',
    platform: 'win32',
    commitLimitBytes: 64 * GB,
    commitRemainingBytes: 100 * 1024 * 1024,
    physicalTotalBytes: 32 * GB,
    physicalFreeBytes: 1 * GB,
    physicalAvailableBytes: null,
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

describe('collectIdleAgentFacts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads each live session\'s wait, activity, draft, focus and pending work', () => {
    const context = makeContext();
    context.sessionManager.getPendingDraft.mockReturnValue('half a sentence');
    context.sessionManager.getFocusedSessions.mockReturnValue(new Set(['sess-1']));
    context.terminalSubmitScheduler.hasPending.mockReturnValue(true);
    mocks.hasPendingMessageDelivery.mockReturnValue(true);

    const [facts] = collectIdleAgentFacts(context as never);

    expect(facts).toEqual({
      sessionId: 'sess-1',
      taskId: 'task-1',
      projectId: 'proj-1',
      status: 'running',
      transient: false,
      workflowId: null,
      activity: 'idle',
      waitingSince: PARKED_AT,
      hasDraft: true,
      focused: true,
      hasPendingSubmit: true,
      hasPendingDelivery: true,
      hasOpenBackgroundWork: false,
      inWorkingWait: false,
    });
    mocks.hasPendingMessageDelivery.mockReturnValue(false);
  });

  it('reads background work from the hook events: a held shell or a subagent past its turn end', () => {
    const context = makeContext();
    context.sessionManager.getOpenWork.mockReturnValue({
      toolCalls: [],
      backgroundShells: [{ id: 'gate', command: 'pnpm verify', since: PARKED_AT }],
      backgroundSubagents: [],
    });

    expect(collectIdleAgentFacts(context as never)[0].hasOpenBackgroundWork).toBe(true);
  });

  it('counts a whitespace-only draft as no draft', () => {
    const context = makeContext();
    context.sessionManager.getPendingDraft.mockReturnValue('   ');

    expect(collectIdleAgentFacts(context as never)[0].hasDraft).toBe(false);
  });

  it('measures the wait on a permission prompt from the moment the agent parked', () => {
    const context = makeContext();
    // Distinct from PARKED_AT, so the value can only come from this reason.
    const promptedAt = PARKED_AT - 5_000;
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-1': 'permission' });
    context.sessionManager.getActivityReasonsCache.mockReturnValue({ 'sess-1': { kind: 'permission', since: promptedAt } });

    const [facts] = collectIdleAgentFacts(context as never);

    expect(facts.waitingSince).toBe(promptedAt);
    expect(facts.activity).toBe('permission');
  });

  it('has no wait for a working agent', () => {
    const context = makeContext();
    context.sessionManager.getActivityReasonsCache.mockReturnValue({ 'sess-1': { kind: 'thinking' } });

    expect(collectIdleAgentFacts(context as never)[0].waitingSince).toBeNull();
  });
});

describe('createLowMemoryAgentPauser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pauses through the Pause button\'s path as Kangentic\'s own pause, and pushes the names', async () => {
    const context = makeContext();
    mocks.pauseTaskSession.mockResolvedValue('paused');
    mocks.getProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => ({ id: 'task-1', title: 'Fix login redirect' })) } });

    createLowMemoryAgentPauser(() => context as never).onSample(lowWindowsSample());
    await settle();

    expect(mocks.pauseTaskSession).toHaveBeenCalledWith(context, 'task-1', expect.objectContaining({
      projectId: 'proj-1',
      // Its own source, so a restart can still tell a memory pause apart.
      suspendedBy: 'low_memory',
      stillEligible: expect.any(Function),
    }));
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(
      IPC.HOST_MEMORY_AGENT_PAUSED,
      expect.objectContaining({ taskId: 'task-1', projectId: 'proj-1', taskTitle: 'Fix login redirect', projectName: 'kangentic' }),
    );
  });

  it('re-checks the agent under the lock: it declines once the agent went back to work', async () => {
    const context = makeContext();
    mocks.pauseTaskSession.mockResolvedValue('declined');

    createLowMemoryAgentPauser(() => context as never).onSample(lowWindowsSample());
    await settle();
    const { stillEligible } = mocks.pauseTaskSession.mock.calls[0][2] as { stillEligible: (session: Session) => boolean };
    const liveSession = { id: 'sess-1' } as Session;

    expect(stillEligible(liveSession)).toBe(true);
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-1': 'thinking' });
    expect(stillEligible(liveSession)).toBe(false);
    // A resume or move put the task on a different session meanwhile.
    context.sessionManager.getActivityCache.mockReturnValue({ 'sess-1': 'idle' });
    expect(stillEligible({ id: 'sess-other' } as Session)).toBe(false);
    // A declined pause tells the renderer nothing.
    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  // A running workflow task under recovery has nobody left to nudge it once its
  // agent is paused, so its recovery stops and the user is told. That notice is
  // main's own (a desktop notification and the phone), so it does not wait on
  // the renderer window, which may already be destroyed.
  describe('a pause that lands on a workflow task', () => {
    it('stops the task\'s recovery and tells the renderer, with the window open', async () => {
      const context = makeContext();
      mocks.pauseTaskSession.mockResolvedValue('paused');
      mocks.getProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => ({ id: 'task-1', title: 'Fix login redirect' })) } });

      createLowMemoryAgentPauser(() => context as never).onSample(lowWindowsSample());
      await settle();

      expect(mocks.noteWorkflowTaskPaused).toHaveBeenCalledTimes(1);
      expect(mocks.noteWorkflowTaskPaused).toHaveBeenCalledWith(context, 'task-1');
      expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.HOST_MEMORY_AGENT_PAUSED, expect.anything());
    });

    it('stops the task\'s recovery with the window destroyed, and sends the renderer nothing', async () => {
      const context = makeContext();
      context.mainWindow.isDestroyed.mockReturnValue(true);
      mocks.pauseTaskSession.mockResolvedValue('paused');
      mocks.getProjectRepos.mockReturnValue({ tasks: { getById: vi.fn(() => ({ id: 'task-1', title: 'Fix login redirect' })) } });

      createLowMemoryAgentPauser(() => context as never).onSample(lowWindowsSample());
      await settle();

      expect(mocks.pauseTaskSession).toHaveBeenCalledTimes(1);
      expect(mocks.noteWorkflowTaskPaused).toHaveBeenCalledTimes(1);
      expect(mocks.noteWorkflowTaskPaused).toHaveBeenCalledWith(context, 'task-1');
      expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('leaves the task\'s recovery alone when the pause was declined', async () => {
      const context = makeContext();
      mocks.pauseTaskSession.mockResolvedValue('declined');

      createLowMemoryAgentPauser(() => context as never).onSample(lowWindowsSample());
      await settle();

      expect(mocks.pauseTaskSession).toHaveBeenCalledTimes(1);
      expect(mocks.noteWorkflowTaskPaused).not.toHaveBeenCalled();
    });
  });

  it('pauses nothing with the setting off', async () => {
    const context = makeContext({ enabled: false });

    createLowMemoryAgentPauser(() => context as never).onSample(lowWindowsSample());
    await settle();

    expect(mocks.pauseTaskSession).not.toHaveBeenCalled();
  });

  it('pauses nothing before the IPC context exists', async () => {
    createLowMemoryAgentPauser(() => null).onSample(lowWindowsSample());
    await settle();

    expect(mocks.pauseTaskSession).not.toHaveBeenCalled();
  });
});

describe('buildAgentPausedEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still counts the pause when the task cannot be read', () => {
    const context = makeContext();
    mocks.getProjectRepos.mockImplementation(() => {
      throw new Error('project closed');
    });

    const event = buildAgentPausedEvent(context as never, {
      facts: collectIdleAgentFacts(context as never)[0],
      pausedAt: Date.parse('2026-10-21T12:00:00.000Z'),
      waitedMs: 1_200_000,
    });

    expect(event).toEqual({
      pausedAt: '2026-10-21T12:00:00.000Z',
      taskId: 'task-1',
      projectId: 'proj-1',
      taskTitle: null,
      projectName: 'kangentic',
      waitedMs: 1_200_000,
    });
  });
});

describe('simulateLowMemorySample', () => {
  it('forces each platform\'s own reading low', () => {
    expect(simulateLowMemorySample(lowWindowsSample()).commitRemainingBytes).toBe(0);

    const linux = simulateLowMemorySample({
      ...lowWindowsSample(),
      platform: 'linux',
      commitLimitBytes: null,
      commitRemainingBytes: null,
      physicalAvailableBytes: 8 * GB,
      swapTotalBytes: 4 * GB,
      swapFreeBytes: 4 * GB,
    });
    expect(linux.physicalAvailableBytes).toBe(0);
    expect(linux.swapFreeBytes).toBe(0);
    expect(linux.commitRemainingBytes).toBeNull();

    const mac = simulateLowMemorySample({
      ...lowWindowsSample(),
      platform: 'darwin',
      commitLimitBytes: null,
      commitRemainingBytes: null,
      memoryPressureLevel: 1,
    });
    expect(mac.memoryPressureLevel).toBe(4);
  });
});
