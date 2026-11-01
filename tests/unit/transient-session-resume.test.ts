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

  // `/bg` moves a terminal's conversation into the agent CLI's own background
  // session, which a quit leaves running. A resume beside it would put a second
  // process on the conversation, so it is stopped first, on the agent's files
  // alone, and the resume names the id a `--resume` reaches.
  describe("a conversation in the agent CLI's own background session", () => {
    function withBackgroundSupport(options: { inBackground: boolean; resolvesTo?: string }, order: string[] = []) {
      const claude = makeAdapter('claude', { resumable: true });
      Object.assign(claude, {
        // The row is the background session itself when the files show one.
        backgroundSessionOf: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) => {
          order.push('check');
          return options.inBackground ? agentSessionId : null;
        }),
        stopBackgroundSession: vi.fn(async () => { order.push('stop'); return true; }),
        resolveResumableSessionId: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) => {
          order.push('resolve');
          return options.resolvesTo ?? agentSessionId;
        }),
      });
      claude.ensureTrust.mockImplementation(async () => { order.push('trust'); });
      adapters.set('claude', claude);
      return claude as typeof claude & {
        backgroundSessionOf: ReturnType<typeof vi.fn>;
        stopBackgroundSession: ReturnType<typeof vi.fn>;
        resolveResumableSessionId: ReturnType<typeof vi.fn>;
      };
    }

    it('stops it before the spawn and resumes the conversation it continued, claiming that one too', async () => {
      const order: string[] = [];
      const claude = withBackgroundSupport({ inBackground: true, resolvesTo: 'conversation-before-bg' }, order);
      const context = createContext({ 'conversation-a': { agent_name: 'claude', label: 'Fix the flaky drag test' } });

      await spawn(context, { projectId: 'proj-1', slot: 'slot-2', resumeAgentSessionId: 'conversation-a' });

      expect(claude.backgroundSessionOf).toHaveBeenCalledWith({ agentSessionId: 'conversation-a', cwd: PROJECT_ROOT, place: null });
      expect(claude.stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: 'conversation-a', cliPath: '/mock/claude' });
      // Settled before anything is built for the spawn.
      expect(order).toEqual(['check', 'stop', 'resolve', 'trust']);
      expect(claude.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'conversation-before-bg', resume: true }));
      expect(context.sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'conversation-before-bg', resuming: true }));
      expect(context.commandTerminalHistory.claimResume).toHaveBeenCalledWith('proj-1', 'conversation-a');
      expect(context.commandTerminalHistory.claimResume).toHaveBeenCalledWith('proj-1', 'conversation-before-bg');
      expect(context.commandTerminalHistory.settleResume).toHaveBeenCalledWith('proj-1', 'conversation-a', 'session-1');
      expect(context.commandTerminalHistory.settleResume).toHaveBeenCalledWith('proj-1', 'conversation-before-bg', 'session-1');
    });

    it('runs no CLI for a conversation that never moved into one', async () => {
      const claude = withBackgroundSupport({ inBackground: false, resolvesTo: 'conversation-before-bg' });
      const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null } });

      await spawn(context, { projectId: 'proj-1', resumeAgentSessionId: 'conversation-a' });

      expect(claude.backgroundSessionOf).toHaveBeenCalled();
      expect(claude.stopBackgroundSession).not.toHaveBeenCalled();
      expect(claude.resolveResumableSessionId).not.toHaveBeenCalled();
      expect(claude.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'conversation-a', resume: true }));
      expect(context.commandTerminalHistory.claimResume).toHaveBeenCalledTimes(1);
    });

    it('leaves the background session the row moved into running while a live terminal holds it, and resumes the row', async () => {
      const claude = withBackgroundSupport({ inBackground: false });
      claude.backgroundSessionOf.mockImplementation(async () => 'background-held-live');
      const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null } });
      context.sessionManager.listSessions.mockReturnValue([{ id: 'terminal-1', agentSessionId: 'background-held-live', status: 'running' }] as never);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await spawn(context, { projectId: 'proj-1', resumeAgentSessionId: 'conversation-a' });

      expect(claude.stopBackgroundSession).not.toHaveBeenCalled();
      expect(claude.resolveResumableSessionId).not.toHaveBeenCalled();
      expect(claude.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'conversation-a', resume: true }));
      logSpy.mockRestore();
    });

    it('refuses with conversation-open when another terminal holds the conversation it continued, and hands both claims back', async () => {
      withBackgroundSupport({ inBackground: true, resolvesTo: 'conversation-before-bg' });
      const context = createContext({ 'conversation-a': { agent_name: 'claude', label: null } });
      context.commandTerminalHistory.claimResume.mockImplementation((_projectId: string, agentSessionId: string) => agentSessionId === 'conversation-a');

      await expect(spawn(context, { projectId: 'proj-1', resumeAgentSessionId: 'conversation-a' }))
        .rejects.toMatchObject({ code: 'conversation-open' });

      expect(context.sessionManager.spawn).not.toHaveBeenCalled();
      expect(context.commandTerminalHistory.settleResume).toHaveBeenCalledWith('proj-1', 'conversation-a', null);
      expect(context.commandTerminalHistory.settleResume).not.toHaveBeenCalledWith('proj-1', 'conversation-before-bg', expect.anything());
    });
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
