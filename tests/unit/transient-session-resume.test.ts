/**
 * A Command Terminal resuming an earlier conversation
 * (`startCommandTerminal` with `resumeAgentSessionId`,
 * src/main/ipc/handlers/transient-sessions.ts), driven through the real
 * SESSION_SPAWN_TRANSIENT handler. Harness shape follows
 * transient-session-spawn-ensure-trust.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

// The real target resolution, run as on Windows with a distro's facts already
// read, so a CLI in a distro resolves on any OS without calling wsl.exe. An
// adapter that declares no WSL support (every one but the ones a case opts in)
// resolves no target, as before. `isSameCliPlace` stays the real one: it is
// what the resume check under test calls.
vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  return {
    ...original,
    resolveCliTarget: (cliPath: string | null | undefined, adapterSupportsWsl: boolean) =>
      original.resolveCliTarget(cliPath, adapterSupportsWsl, {
        platform: 'win32',
        resolveFacts: async (distro: string) => ({
          distro,
          homeLinux: '/home/dev',
          homeUnc: `\\\\wsl.localhost\\${distro}\\home\\dev`,
          uncRoot: `\\\\wsl.localhost\\${distro}`,
          interactivePath: '/usr/bin',
          env: {},
          networkingMode: 'nat' as const,
        }),
      }),
  };
});

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
import { serializeCliTarget } from '../../src/main/agent/shared/cli-target';
import type { SpawnTransientSessionInput } from '../../src/shared/types';

const PROJECT_ROOT = 'C:/Users/dev/proj';

/**
 * `distro` installs the adapter's CLI in that WSL distro: it declares WSL
 * support and detects at the distro's own path, which resolves a target.
 * Without it the CLI is on this machine and resolves none.
 */
function makeAdapter(name: string, options: { resumable: boolean; distro?: string }) {
  return {
    name,
    displayName: name,
    supportsCallerSessionId: options.resumable,
    ...(options.distro ? { supportsWslCli: true } : {}),
    detect: vi.fn(async () => ({
      found: true,
      path: options.distro ? `\\\\wsl.localhost\\${options.distro}\\home\\dev\\.local\\bin\\${name}` : `/mock/${name}`,
      version: '1.0.0',
    })),
    ensureTrust: vi.fn(async () => undefined),
    buildCommand: vi.fn(() => name),
  };
}

/** A history row's `cli_target` for a CLI that ran in `distro`, as the session layer writes it. */
function storedDistroTarget(distro: string): string {
  const serialized = serializeCliTarget({
    kind: 'wsl',
    distro,
    homeLinux: '/home/dev',
    homeUnc: `\\\\wsl.localhost\\${distro}\\home\\dev`,
    uncRoot: `\\\\wsl.localhost\\${distro}`,
  });
  if (!serialized) throw new Error('serializeCliTarget gave no JSON for a distro target');
  return serialized;
}

function createContext(history: Record<string, { agent_name: string; label: string | null; cli_target?: string | null }>, options: { alreadyOpen?: boolean; transcriptGone?: boolean } = {}) {
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
      emit: vi.fn(),
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

  // A conversation is kept in the home of the place its CLI ran in. A CLI path
  // moved into, out of, or between distros since then would be handed a
  // `--resume` it cannot find. Red-green: dropping the `isSameCliPlace` check
  // lets each refusal below through to a spawn; comparing the stored JSON text
  // to the target (a string against an object) refuses the same-place cases.
  describe('where the conversation ran', () => {
    it.each([
      ['a conversation that ran in a distro, now on a CLI on this machine', { cli_target: storedDistroTarget('Ubuntu') }, undefined],
      ['a conversation from this machine (cli_target null), now on a CLI in a distro', { cli_target: null }, 'Ubuntu'],
      ['a conversation from before cli_target was kept, now on a CLI in a distro', {}, 'Ubuntu'],
      ['a conversation that ran in one distro, now on a CLI in another', { cli_target: storedDistroTarget('Ubuntu') }, 'Debian'],
    ])('refuses %s with conversation-gone, releases the claim and spawns nothing', async (_name, place, cliDistro) => {
      const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null, ...place } });
      adapters.set('claude', makeAdapter('claude', { resumable: true, distro: cliDistro }));

      await expect(spawn(context, { projectId: 'proj-1', slot: 'slot-2', resumeAgentSessionId: 'conversation-a' }))
        .rejects.toMatchObject({ name: 'CommandTerminalStartError', code: 'conversation-gone' });

      // Claimed before the check, so the refusal has to hand it back.
      expect(context.commandTerminalHistory.claimResume).toHaveBeenCalledWith('proj-1', 'conversation-a');
      expect(context.commandTerminalHistory.settleResume).toHaveBeenCalledWith('proj-1', 'conversation-a', null);
      expect(adapters.get('claude')!.buildCommand).not.toHaveBeenCalled();
      expect(context.sessionManager.spawn).not.toHaveBeenCalled();
    });

    it.each([
      ['Ubuntu', 'Ubuntu'],
      ['Ubuntu', 'ubuntu'],
    ])('resumes a conversation that ran in %s on a CLI in %s, in that distro\'s shell', async (storedDistro, cliDistro) => {
      const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null, cli_target: storedDistroTarget(storedDistro) } });
      adapters.set('claude', makeAdapter('claude', { resumable: true, distro: cliDistro }));

      await spawn(context, { projectId: 'proj-1', slot: 'slot-2', resumeAgentSessionId: 'conversation-a' });

      expect(adapters.get('claude')!.buildCommand).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'conversation-a',
        resume: true,
        cliTarget: expect.objectContaining({ kind: 'wsl', distro: cliDistro }),
      }));
      expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
        agentSessionId: 'conversation-a',
        resuming: true,
        shell: `wsl -d ${cliDistro}`,
      }));
      expect(context.commandTerminalHistory.settleResume).toHaveBeenCalledWith('proj-1', 'conversation-a', 'session-1');
    });

    it('resumes a conversation from this machine (cli_target null) on a CLI on this machine', async () => {
      const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null, cli_target: null } });

      await spawn(context, { projectId: 'proj-1', slot: 'slot-2', resumeAgentSessionId: 'conversation-a' });

      expect(adapters.get('claude')!.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'conversation-a', resume: true }));
      expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'conversation-a', resuming: true }));
    });

    it('does not check the place for a start that resumes nothing', async () => {
      // A fresh start on a CLI in a distro has no earlier conversation to be elsewhere.
      const context = createContext({});
      adapters.set('codex', makeAdapter('codex', { resumable: true, distro: 'Ubuntu' }));

      await spawn(context, { projectId: 'proj-1', slot: 'slot-1' });

      expect(context.sessionManager.spawn).toHaveBeenCalled();
    });
  });
});

describe('startCommandTerminal: the conversation a fresh start opens', () => {
  // A CLI that cannot take an id Kangentic chose but can create an empty chat
  // (Cursor's session screen) gets one created before launch. The launch opens
  // it, the session row carries it from the start, and an `agent-session-id`
  // is announced once the row exists, because the print stream will not report
  // an id the chat already has. Earlier conversations record a session when it
  // reports its id, so without that announcement this terminal is never
  // recorded.
  //
  // Red-green:
  // - Dropping the `emit` after the spawn fails the first case.
  // - Dropping `agentSessionId` from the spawn input (conversationSessionFields)
  //   or `{ sessionId, resume: false }` from the command options
  //   (conversationCommandOptions) fails the first case.
  // - Dropping `resume ||` from the guard before the helper makes a resume ask
  //   for a chat (and hand the CLI the new id instead of the resumed one).
  // - Dropping `|| adapter.supportsCallerSessionId` makes the helper mint an id
  //   for a CLI that reports its own after launch, which fails the caller-id case.
  // - Skipping the helper's reportsLaunchSessionId gate fails the print-launch case.
  function makeChatAdapter(
    name: string,
    options: { supportsCallerSessionId?: boolean; reportsLaunchSession?: boolean; chat?: string | null } = {},
  ) {
    const chat = options.chat === undefined ? 'chat-created' : options.chat;
    return {
      ...makeAdapter(name, { resumable: options.supportsCallerSessionId === true }),
      createSessionId: vi.fn(async (_cliPath: string, _workingDirectory: string): Promise<string | null> => chat),
      reportsLaunchSessionId: vi.fn((_launch: { permissionMode: string; nonInteractive?: boolean }): boolean => options.reportsLaunchSession === true),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    adapters.clear();
  });

  it('creates a chat at the project root, opens it fresh, seeds it on the row, and announces it once the row exists', async () => {
    const adapter = makeChatAdapter('codex');
    adapters.set('codex', adapter);
    const context = createContext({});

    await spawn(context, { projectId: 'proj-1', slot: 'slot-1' });

    expect(adapter.createSessionId).toHaveBeenCalledTimes(1);
    expect(adapter.createSessionId).toHaveBeenCalledWith('/mock/codex', PROJECT_ROOT);
    // The launch is asked with the resolved permission mode and no
    // nonInteractive flag: a Command Terminal is always the session screen.
    expect(adapter.reportsLaunchSessionId).toHaveBeenCalledTimes(1);
    const launch = adapter.reportsLaunchSessionId.mock.calls[0][0];
    expect(launch.permissionMode).toBe('default');
    expect(launch.nonInteractive).toBeUndefined();

    expect(adapter.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-created', resume: false }));
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'chat-created' }));
    // A fresh chat is not a resumed, already-used terminal.
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ resuming: true }));
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ hasUserInput: true }));

    expect(context.sessionManager.emit).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.emit).toHaveBeenCalledWith('agent-session-id', 'session-1', 'mock-transient-task-id', 'proj-1', 'chat-created');

    // The chat exists before the command that opens it is built, and the id is
    // announced only after the spawn put the row in the registry.
    expect(adapter.createSessionId.mock.invocationCallOrder[0]).toBeLessThan(adapter.buildCommand.mock.invocationCallOrder[0]);
    expect(context.sessionManager.spawn.mock.invocationCallOrder[0]).toBeLessThan(context.sessionManager.emit.mock.invocationCallOrder[0]);
  });

  it('announces nothing for a shell that did not start', async () => {
    adapters.set('codex', makeChatAdapter('codex'));
    const context = createContext({});
    context.sessionManager.spawn.mockResolvedValueOnce({ id: 'session-1', status: 'exited' });

    await expect(spawn(context, { projectId: 'proj-1', slot: 'slot-1' })).rejects.toMatchObject({ code: 'spawn-failed' });

    expect(context.sessionManager.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['the launch reports its own id', { reportsLaunchSession: true }, 0],
    ['the CLI could not create a chat', { chat: null }, 1],
  ])('opens no conversation, seeds no id and announces nothing when %s', async (_name, options, chatRequests) => {
    const adapter = makeChatAdapter('codex', options);
    adapters.set('codex', adapter);
    const context = createContext({});

    await spawn(context, { projectId: 'proj-1', slot: 'slot-1' });

    expect(adapter.createSessionId).toHaveBeenCalledTimes(chatRequests);
    expect(adapter.buildCommand).toHaveBeenCalledWith(expect.not.objectContaining({ sessionId: expect.anything() }));
    expect(adapter.buildCommand).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }));
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ agentSessionId: expect.anything() }));
    expect(context.sessionManager.emit).not.toHaveBeenCalled();
  });

  it('never asks a CLI that accepts a chosen id for a chat: it reports its own id after launch, as before', async () => {
    const adapter = makeChatAdapter('codex', { supportsCallerSessionId: true });
    adapters.set('codex', adapter);
    const context = createContext({});

    await spawn(context, { projectId: 'proj-1', slot: 'slot-1' });

    expect(adapter.createSessionId).not.toHaveBeenCalled();
    expect(adapter.buildCommand).toHaveBeenCalledWith(expect.not.objectContaining({ sessionId: expect.anything() }));
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ agentSessionId: expect.anything() }));
    expect(context.sessionManager.emit).not.toHaveBeenCalled();
  });

  it('resumes the earlier conversation without creating a chat, and announces nothing extra', async () => {
    // A createSessionId adapter counts as resumable by id.
    const adapter = makeChatAdapter('cursor');
    adapters.set('cursor', adapter);
    const context = createContext({ 'conversation-a': { agent_name: 'cursor', label: null } });

    await spawn(context, { projectId: 'proj-1', slot: 'slot-2', resumeAgentSessionId: 'conversation-a' });

    expect(adapter.createSessionId).not.toHaveBeenCalled();
    expect(adapter.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'conversation-a', resume: true }));
    expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'conversation-a',
      resuming: true,
      hasUserInput: true,
    }));
    expect(context.sessionManager.emit).not.toHaveBeenCalled();
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
