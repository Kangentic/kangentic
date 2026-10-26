/**
 * A Command Terminal resuming an earlier conversation
 * (`startCommandTerminal` with `resumeAgentSessionId`,
 * src/main/ipc/handlers/transient-sessions.ts), driven through the real
 * SESSION_SPAWN_TRANSIENT handler. Harness shape follows
 * transient-session-spawn-ensure-trust.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn(), rmSync: vi.fn() } }));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-transient-task-id') }));

const gitRevparseMock = vi.fn(async () => 'feature/drag\n');
const gitCheckoutMock = vi.fn(async () => undefined);
vi.mock('../../src/main/git/git-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git/git-client')>()),
  gitAt: vi.fn(() => ({
    revparse: gitRevparseMock,
    status: vi.fn(async () => ({ files: [] })),
    checkout: gitCheckoutMock,
    merge: vi.fn(async () => undefined),
  })),
}));

const fetchIfStaleMock = vi.fn(async () => 'origin/main');
vi.mock('../../src/main/git/fetch-throttle', () => ({ fetchIfStale: () => fetchIfStaleMock() }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: vi.fn() }));
vi.mock('../../src/shared/git-utils', () => ({ resolveProjectRoot: vi.fn((projectPath: string) => projectPath) }));

const adapters = new Map<string, Record<string, unknown>>();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (name: string) => adapters.get(name),
    getOrThrow: (name: string) => {
      const adapter = adapters.get(name);
      if (!adapter) throw new Error(`no adapter ${name}`);
      return adapter;
    },
  },
}));

import { registerTransientSessionHandlers } from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';
import type { SpawnTransientSessionInput } from '../../src/shared/types';

const PROJECT_ROOT = 'C:/Users/dev/proj';

function makeAdapter(name: string, options: { resumable: boolean }) {
  return {
    name,
    displayName: name,
    supportsCallerSessionId: options.resumable,
    detect: vi.fn(async () => ({ found: true, path: `/mock/${name}`, version: '1.0.0' })),
    ensureTrust: vi.fn(async () => undefined),
    buildCommand: vi.fn(() => name),
  };
}

function createContext(history: Record<string, { agent_name: string; label: string | null }>, options: { alreadyOpen?: boolean; transcriptGone?: boolean } = {}) {
  return {
    currentProjectId: 'proj-1',
    projectRepo: {
      getById: vi.fn(() => ({ id: 'proj-1', path: PROJECT_ROOT, default_agent: 'codex', default_model: null, default_effort: null })),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { cliPaths: {}, permissionMode: 'default' },
        git: { worktreesEnabled: false, defaultBaseBranch: 'main' },
        mcpServer: { enabled: false },
      })),
    },
    boardConfigManager: { getDefaultBaseBranchForPath: vi.fn(() => undefined) },
    mcpServerHandle: null,
    commandTerminalHistory: {
      find: vi.fn((_projectId: string, agentSessionId: string) => {
        const row = history[agentSessionId];
        return row ? { agent_session_id: agentSessionId, cwd: PROJECT_ROOT, ...row } : null;
      }),
      conversationAvailable: vi.fn(async () => options.transcriptGone !== true),
      claimResume: vi.fn(() => options.alreadyOpen !== true),
      settleResume: vi.fn(),
      list: vi.fn(async () => [{ agentSessionId: 'conversation-a' }]),
    },
    sessionManager: {
      spawn: vi.fn(async () => ({ id: 'session-1', status: 'running' })),
      getShell: vi.fn(async () => 'bash'),
      listSessions: vi.fn(() => []),
      setCommandTerminalLabel: vi.fn(() => true),
      endCommandTerminal: vi.fn(),
    },
  };
}

async function spawn(context: ReturnType<typeof createContext>, input: SpawnTransientSessionInput): Promise<unknown> {
  registerTransientSessionHandlers(context as never);
  const handler = capturedHandlers.get(IPC.SESSION_SPAWN_TRANSIENT)!;
  return handler(null, input);
}

describe('startCommandTerminal: resuming an earlier conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    adapters.clear();
    adapters.set('claude', makeAdapter('claude', { resumable: true }));
    adapters.set('codex', makeAdapter('codex', { resumable: true }));
    adapters.set('aider', makeAdapter('aider', { resumable: false }));
  });

  it("runs the conversation's own agent through its resume, keeps the name, and never checks out", async () => {
    const context = createContext({ 'conversation-a': { agent_name: 'claude', label: 'Fix the flaky drag test' } });
    const result = await spawn(context, { projectId: 'proj-1', slot: 'slot-2', resumeAgentSessionId: 'conversation-a' });

    const claude = adapters.get('claude')!;
    expect(claude.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'conversation-a', resume: true }));
    expect(adapters.get('codex')!.buildCommand).not.toHaveBeenCalled();
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'conversation-a',
      resuming: true,
      hasUserInput: true,
      commandTerminalSlot: 'slot-2',
      commandTerminalBranch: 'feature/drag',
    }));
    expect(context.sessionManager.setCommandTerminalLabel).toHaveBeenCalledWith('session-1', 'Fix the flaky drag test');
    expect(fetchIfStaleMock).not.toHaveBeenCalled();
    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ slot: 'slot-2', branch: 'feature/drag' });
    // The conversation is claimed before the spawn and handed to its terminal after.
    expect(context.commandTerminalHistory.claimResume).toHaveBeenCalledWith('proj-1', 'conversation-a');
    expect(context.commandTerminalHistory.settleResume).toHaveBeenCalledWith('proj-1', 'conversation-a', 'session-1');
  });

  it('refuses a conversation another terminal holds with conversation-open and spawns nothing', async () => {
    const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null } }, { alreadyOpen: true });
    await expect(spawn(context, { projectId: 'proj-1', resumeAgentSessionId: 'conversation-a' }))
      .rejects.toMatchObject({ code: 'conversation-open' });
    expect(context.sessionManager.spawn).not.toHaveBeenCalled();
    expect(context.commandTerminalHistory.settleResume).not.toHaveBeenCalled();
  });

  it('frees the claim when the resumed shell does not start', async () => {
    const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null } });
    context.sessionManager.spawn.mockResolvedValueOnce({ id: 'session-1', status: 'exited' });
    await expect(spawn(context, { projectId: 'proj-1', resumeAgentSessionId: 'conversation-a' }))
      .rejects.toMatchObject({ code: 'spawn-failed' });
    expect(context.commandTerminalHistory.settleResume).toHaveBeenCalledWith('proj-1', 'conversation-a', null);
  });

  it('starts fresh on the project default when no resume is asked for', async () => {
    const context = createContext({});
    await spawn(context, { projectId: 'proj-1', slot: 'slot-1' });
    const codex = adapters.get('codex')!;
    expect(codex.buildCommand).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }));
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ hasUserInput: true }));
    expect(context.sessionManager.setCommandTerminalLabel).not.toHaveBeenCalled();
  });

  it.each([
    ['a conversation with no record', {}],
    ["one whose agent cannot resume by id", { 'conversation-a': { agent_name: 'aider', label: null } }],
  ])('refuses %s with conversation-gone and spawns nothing', async (_name, history) => {
    const context = createContext(history);
    await expect(spawn(context, { projectId: 'proj-1', resumeAgentSessionId: 'conversation-a' }))
      .rejects.toMatchObject({ code: 'conversation-gone' });
    expect(context.sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('refuses a conversation whose transcript the agent purged since the list with conversation-gone, before claiming it', async () => {
    const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null } }, { transcriptGone: true });
    await expect(spawn(context, { projectId: 'proj-1', resumeAgentSessionId: 'conversation-a' }))
      .rejects.toMatchObject({ code: 'conversation-gone' });
    expect(context.commandTerminalHistory.conversationAvailable).toHaveBeenCalledWith(expect.objectContaining({ agent_session_id: 'conversation-a' }));
    expect(context.commandTerminalHistory.claimResume).not.toHaveBeenCalled();
    expect(context.sessionManager.spawn).not.toHaveBeenCalled();
  });
});

describe('commandTerminalHistory:list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
  });

  function list(context: ReturnType<typeof createContext>, projectId: unknown): unknown {
    registerTransientSessionHandlers(context as never);
    return capturedHandlers.get(IPC.COMMAND_TERMINAL_HISTORY_LIST)!(null, projectId);
  }

  it("lists a known project's earlier conversations", async () => {
    const context = createContext({});
    await expect(list(context, 'proj-1')).resolves.toEqual([{ agentSessionId: 'conversation-a' }]);
    expect(context.commandTerminalHistory.list).toHaveBeenCalledWith('proj-1');
  });

  it.each([
    ['an id that names no project', 'proj-unknown'],
    ['a non-string id', 42],
  ])('answers %s with an empty list and never reads a database for it', (_name, projectId) => {
    const context = createContext({});
    context.projectRepo.getById.mockImplementation(((id: string) => (id === 'proj-1' ? { id: 'proj-1', path: PROJECT_ROOT, default_agent: 'codex', default_model: null, default_effort: null } : undefined)) as never);
    expect(list(context, projectId)).toEqual([]);
    expect(context.commandTerminalHistory.list).not.toHaveBeenCalled();
  });
});
