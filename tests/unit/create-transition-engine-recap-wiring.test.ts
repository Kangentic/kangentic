/**
 * What `createTransitionEngine` (src/main/ipc/helpers/agent-spawn.ts) hands the
 * engine for an expired conversation: the board half of the wiring.
 *
 * The engine builds the recap from `services.recapSources` and tells the
 * renderer through `services.onConversationExpired`. Both are optional on the
 * engine, and each one absent fails silently: with no sources the recap carries
 * the task alone, and with no notice the user is never told the conversation was
 * replaced. The engine's own tests inject both, so only a test of the factory
 * proves the board path supplies them.
 *
 * - `recapSources` is `createExpiredRecapSources(projectId)` for the project the
 *   engine was built for, and a NEW set per engine: the set latches "the worker
 *   did not answer" for its own lifetime, so a set shared across engines would
 *   leave every later spawn without a summary or a tail.
 * - `onConversationExpired` pushes the notice through `notifyConversationExpired`
 *   with the same IPC context. `notify-conversation-expired.test.ts` pins that
 *   function's own guards and its `IPC.TASK_CONVERSATION_EXPIRED` push.
 *
 * `TransitionEngine` is replaced by a class that records its constructor
 * arguments, so the services object is read exactly as the real engine receives
 * it. The factory for the recap sources is a spy: its own behavior is
 * `expired-recap-sources.test.ts`.
 *
 * Red-green: drop the `recapSources` line and the first test fails; build the
 * sources once at module scope and the per-engine test fails; pass another id
 * and the project test fails; drop the `onConversationExpired` line, or pass a
 * different context to the notifier, and the notice tests fail. Drop the
 * `readStartHead` line and the start HEAD reader tests fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TransitionEngineServices } from '../../src/main/transition-engine/transition-engine';
import type { ExpiredConversationRecapSources } from '../../src/main/agent/shared/expired-conversation-recap';
import type { ConversationExpiredNotice } from '../../src/shared/types';

const engineConstructions = vi.hoisted(() => ({ argumentLists: [] as unknown[][] }));
const mockCreateExpiredRecapSources = vi.hoisted(() => vi.fn());
const mockNotifyConversationExpired = vi.hoisted(() => vi.fn());
const mockReadWorktreeHead = vi.hoisted(() => vi.fn());

// Same avoidance strategy as agent-spawn-expired-withhold.test.ts: the engine and
// the agent registry are stubbed so the module loads without pulling in
// SessionManager -> node-pty and every agent adapter.
vi.mock('../../src/main/transition-engine/transition-engine', () => ({
  TransitionEngine: class {
    constructor(...constructorArguments: unknown[]) {
      engineConstructions.argumentLists.push(constructorArguments);
    }
  },
}));
vi.mock('../../src/main/transition-engine/expired-recap-sources', () => ({
  createExpiredRecapSources: mockCreateExpiredRecapSources,
}));
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHead: mockReadWorktreeHead,
  readCommitsSince: vi.fn(),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class {
    insert = vi.fn(() => ({ id: 'handoff-1' }));
    updateToSession = vi.fn();
  },
}));
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', () => ({
  deliverAgentMessageInBackground: vi.fn(),
}));
vi.mock('../../src/main/dev-ports/dev-port-allocator', () => ({
  getDevPortForTask: vi.fn(() => null),
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById = vi.fn(() => undefined);
  },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({})),
}));
vi.mock('../../src/main/ipc/helpers/task-git', () => ({
  ensureTaskWorktree: vi.fn(),
  ensureTaskBranchCheckout: vi.fn(),
  notifySpawnBlocked: vi.fn(),
  notifyConversationExpired: mockNotifyConversationExpired,
}));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, run: () => unknown) => run()),
}));

import { createTransitionEngine } from '../../src/main/ipc/helpers/agent-spawn';

const PROJECT_ID = 'project-9';

/** A recap source set the test can tell apart from any other by identity. */
function makeRecapSources(): ExpiredConversationRecapSources {
  return {
    readTaskSummary: vi.fn(async () => null),
    readConversationTail: vi.fn(async () => null),
    readGitState: vi.fn(async () => null),
  };
}

/** The IPC context the factory reads at construction. Only its identity matters here. */
function makeContext() {
  return {
    sessionManager: {},
    terminalSubmit: {},
    configManager: { getEffectiveConfig: vi.fn() },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    projectRepo: { getById: vi.fn(() => undefined) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  };
}

/** Build an engine for a project and return the services object the engine constructor received. */
function buildEngineServices(
  context: ReturnType<typeof makeContext>,
  projectId: string = PROJECT_ID,
): TransitionEngineServices {
  createTransitionEngine(
    context as never, {} as never, {} as never, {} as never, {} as never, {} as never, projectId, '/mock/project',
  );
  const constructorArguments = engineConstructions.argumentLists.at(-1);
  // The engine's ninth constructor argument is its services (transition-engine.ts).
  return constructorArguments![8] as TransitionEngineServices;
}

beforeEach(() => {
  engineConstructions.argumentLists.length = 0;
  mockCreateExpiredRecapSources.mockReset();
  mockCreateExpiredRecapSources.mockImplementation(() => makeRecapSources());
  mockNotifyConversationExpired.mockReset();
  mockReadWorktreeHead.mockReset();
  mockReadWorktreeHead.mockResolvedValue({ branch: 'task-branch', sha: 'abc1234' });
});

describe('createTransitionEngine: the recap sources', () => {
  it('hands the engine recap sources that read the old conversation and the branch', () => {
    const services = buildEngineServices(makeContext());

    expect(services.recapSources).toBeDefined();
    expect(typeof services.recapSources!.readConversationTail).toBe('function');
    expect(typeof services.recapSources!.readGitState).toBe('function');
  });

  it('builds them for the project the engine was created for', () => {
    const sources = makeRecapSources();
    mockCreateExpiredRecapSources.mockReturnValue(sources);

    const services = buildEngineServices(makeContext(), 'project-other');

    expect(mockCreateExpiredRecapSources).toHaveBeenCalledTimes(1);
    expect(mockCreateExpiredRecapSources).toHaveBeenCalledWith('project-other');
    expect(services.recapSources).toBe(sources);
  });

  it('builds a new set for each engine, so one spawn\'s timed-out worker read does not silence the next spawn\'s', () => {
    const first = buildEngineServices(makeContext());
    const second = buildEngineServices(makeContext());

    expect(mockCreateExpiredRecapSources).toHaveBeenCalledTimes(2);
    expect(second.recapSources).not.toBe(first.recapSources);
  });
});

// The engine records `sessions.start_head_sha` for an isolated destination lane
// through `services.readStartHead` (transition-engine.test.ts pins that side with a
// stub). With no supplier here, every isolated session silently records no start
// HEAD and its return recap lists no commits.
describe('createTransitionEngine: the start HEAD reader', () => {
  it('hands the engine a reader that resolves the head sha of the cwd it is given', async () => {
    const services = buildEngineServices(makeContext());

    expect(typeof services.readStartHead).toBe('function');
    await expect(services.readStartHead!('/mock/worktree')).resolves.toBe('abc1234');
    expect(mockReadWorktreeHead).toHaveBeenCalledTimes(1);
    expect(mockReadWorktreeHead).toHaveBeenCalledWith('/mock/worktree');
  });

  it('resolves null when the cwd has no readable head', async () => {
    mockReadWorktreeHead.mockResolvedValue({ branch: null, sha: null });
    const services = buildEngineServices(makeContext());

    await expect(services.readStartHead!('/mock/not-a-repo')).resolves.toBeNull();
  });
});

describe('createTransitionEngine: the conversation-expired notice', () => {
  const NOTICE: ConversationExpiredNotice = {
    projectId: PROJECT_ID,
    taskId: 'task-1',
    taskTitle: 'Resume me',
    lastActiveAt: '2026-07-01T09:30:00.000Z',
  };

  it('hands the engine a notifier that is not called until a conversation expires', () => {
    const services = buildEngineServices(makeContext());

    expect(typeof services.onConversationExpired).toBe('function');
    expect(mockNotifyConversationExpired).not.toHaveBeenCalled();
  });

  it('pushes the notice, unchanged, through notifyConversationExpired with the IPC context it was built with', () => {
    const context = makeContext();
    const services = buildEngineServices(context);

    services.onConversationExpired!(NOTICE);

    expect(mockNotifyConversationExpired).toHaveBeenCalledTimes(1);
    expect(mockNotifyConversationExpired.mock.calls[0][0]).toBe(context);
    expect(mockNotifyConversationExpired.mock.calls[0][1]).toBe(NOTICE);
  });

  it('keeps each engine\'s notifier on its own context', () => {
    const firstContext = makeContext();
    const secondContext = makeContext();
    const first = buildEngineServices(firstContext);
    buildEngineServices(secondContext);

    first.onConversationExpired!(NOTICE);

    expect(mockNotifyConversationExpired.mock.calls[0][0]).toBe(firstContext);
  });
});
