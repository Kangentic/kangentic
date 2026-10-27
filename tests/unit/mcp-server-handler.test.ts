/**
 * The MCP_SERVER_CHECK_CONNECTION handler (`registerMcpServerHandlers` in
 * src/main/ipc/handlers/mcp-server.ts): the Settings > MCP Server "Test
 * connection" row, and the same check an agent session's start runs through
 * `McpConnectionWatch`.
 *
 * The check itself (`checkMcpConnection`) has its own suite
 * (mcp-connection-check.test.ts). What only the handler decides is pinned here:
 *   - whether a stopped WSL distro is started: only for a check the user asked
 *     for (`explicit: true`), never for the bare call or `explicit: false`;
 *   - which distros are checked: the effective config's `agent.cliPaths` of the
 *     open project, through `wslDistrosOfCliPaths`, for the agents that can run
 *     from WSL;
 *   - that it never throws: a check that cannot run answers as a failure with
 *     its error.
 *
 * Strategy: capture the `ipcMain.handle` callback (as agent-list-handler.test.ts
 * does) and call it directly. `checkMcpConnection` is replaced by a spy and
 * `wslDistrosOfCliPaths` stays real, so the distro list is the real mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { McpConnectionCheck } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { McpConnectionCheckInput } from '../../src/main/agent/mcp-connection-check';

const { capturedHandlers, mockCheckMcpConnection, watchInstances, mockStartFailure, supportsWslByAgent } = vi.hoisted(() => ({
  capturedHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockCheckMcpConnection: vi.fn(async (_input: unknown): Promise<unknown> => ({ connected: true })),
  watchInstances: [] as Array<{ options: Record<string, (...args: never[]) => unknown>; start: () => void }>,
  mockStartFailure: vi.fn((): string | null => null),
  // Which agents the registry says can run from a WSL distro.
  supportsWslByAgent: new Map<string, boolean>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

// The real mapping from CLI paths to distros; only the check itself is a spy.
vi.mock('../../src/main/agent/mcp-connection-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/mcp-connection-check')>();
  return { ...actual, checkMcpConnection: (input: unknown) => mockCheckMcpConnection(input) };
});

vi.mock('../../src/main/agent/mcp-server-start-failure', () => ({
  mcpServerStartFailure: () => mockStartFailure(),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (agentName: string) => (supportsWslByAgent.has(agentName) ? { supportsWslCli: supportsWslByAgent.get(agentName) } : undefined),
  },
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));

// The real watch subscribes to the session manager; here it only records how
// the handler built it.
vi.mock('../../src/main/ipc/helpers/mcp-connection-watch', () => ({
  McpConnectionWatch: class {
    start = vi.fn();
    constructor(public options: Record<string, (...args: never[]) => unknown>) {
      watchInstances.push(this);
    }
  },
}));

import { registerMcpServerHandlers } from '../../src/main/ipc/handlers/mcp-server';

const WSL_UBUNTU_CLAUDE = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';
const WSL_DEBIAN_CODEX = '\\\\wsl.localhost\\Debian\\usr\\local\\bin\\codex';
const WSL_FEDORA_GEMINI = '\\\\wsl.localhost\\Fedora\\usr\\bin\\gemini';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

function fakePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
}

interface FakeContext {
  mcpServerHandle: unknown;
  currentProjectId: string | null;
  currentProjectPath: string | null;
  configManager: {
    getEffectiveConfig: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };
}

function makeContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    mcpServerHandle: { baseUrl: 'http://127.0.0.1:4100/mcp', token: 'token', urlForProject: vi.fn(), close: vi.fn() },
    currentProjectId: 'project-1',
    currentProjectPath: '/mock/project',
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ agent: { cliPaths: {} } })),
      // The global config names a different distro, so a handler that read it
      // instead of the effective config would check Fedora.
      load: vi.fn(() => ({ agent: { cliPaths: { gemini: WSL_FEDORA_GEMINI } }, mcpServer: { enabled: true } })),
    },
    ...overrides,
  };
}

function registerHandler(context: FakeContext): (...args: unknown[]) => Promise<McpConnectionCheck> {
  registerMcpServerHandlers(context as unknown as IpcContext);
  const handler = capturedHandlers.get(IPC.MCP_SERVER_CHECK_CONNECTION);
  if (!handler) throw new Error('the MCP_SERVER_CHECK_CONNECTION handler was not registered');
  // The real signature is (event, options?); pass a placeholder event.
  return (...args: unknown[]) => handler(undefined, ...args) as Promise<McpConnectionCheck>;
}

/** The input the last `checkMcpConnection` call received. */
function lastCheckInput(): McpConnectionCheckInput {
  const calls = mockCheckMcpConnection.mock.calls;
  return calls[calls.length - 1][0] as McpConnectionCheckInput;
}

beforeEach(() => {
  capturedHandlers.clear();
  watchInstances.length = 0;
  supportsWslByAgent.clear();
  mockCheckMcpConnection.mockReset();
  mockCheckMcpConnection.mockResolvedValue({ connected: true });
  mockStartFailure.mockReset();
  mockStartFailure.mockReturnValue(null);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
});

describe('MCP_SERVER_CHECK_CONNECTION: whether a stopped distro is started', () => {
  it.each([
    ['no argument', undefined],
    ['{ explicit: false }', { explicit: false }],
    ['an options object without explicit', {}],
  ])('does not start a stopped distro for %s', async (_label, options) => {
    const invoke = registerHandler(makeContext());

    expect(await invoke(options)).toEqual({ connected: true });

    expect(mockCheckMcpConnection).toHaveBeenCalledTimes(1);
    expect(lastCheckInput().startStoppedDistros).toBe(false);
  });

  it('starts a stopped distro for a check the user asked for ({ explicit: true })', async () => {
    const invoke = registerHandler(makeContext());

    await invoke({ explicit: true });

    expect(lastCheckInput().startStoppedDistros).toBe(true);
  });
});

describe('MCP_SERVER_CHECK_CONNECTION: what it checks', () => {
  it('hands the check the server handle, the start failure and the open project', async () => {
    const context = makeContext();
    mockStartFailure.mockReturnValue('listen EADDRINUSE: address already in use 127.0.0.1');
    const invoke = registerHandler(context);

    await invoke();

    const input = lastCheckInput();
    expect(input.handle).toBe(context.mcpServerHandle);
    expect(input.startFailure).toBe('listen EADDRINUSE: address already in use 127.0.0.1');
    expect(input.projectId).toBe('project-1');
  });

  it('reads the server handle and the project at the time of the call, not when the handler was registered', async () => {
    const context = makeContext({ mcpServerHandle: null, currentProjectId: null });
    const invoke = registerHandler(context);
    const laterHandle = { baseUrl: 'http://127.0.0.1:4200/mcp', token: 'later', urlForProject: vi.fn(), close: vi.fn() };
    context.mcpServerHandle = laterHandle;
    context.currentProjectId = 'project-2';

    await invoke();

    expect(lastCheckInput().handle).toBe(laterHandle);
    expect(lastCheckInput().projectId).toBe('project-2');
  });

  it('checks the distros the open project\'s effective CLI paths point into, for the agents that can run from WSL', async () => {
    fakePlatform('win32');
    supportsWslByAgent.set('claude', true);
    supportsWslByAgent.set('codex', true);
    // An agent that cannot run from WSL never names a distro, whatever its path says.
    supportsWslByAgent.set('gemini', false);
    const context = makeContext();
    context.configManager.getEffectiveConfig.mockReturnValue({
      agent: {
        cliPaths: {
          claude: WSL_UBUNTU_CLAUDE,
          codex: WSL_DEBIAN_CODEX,
          gemini: WSL_FEDORA_GEMINI,
          aider: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\aider.cmd',
          // Not in the registry at all.
          mystery: '\\\\wsl.localhost\\Arch\\usr\\bin\\mystery',
        },
      },
    });
    const invoke = registerHandler(context);

    await invoke();

    expect(lastCheckInput().distros).toEqual(['Ubuntu', 'Debian']);
  });

  it('reads the effective config of the open project, and of none when no project is open', async () => {
    const withProject = makeContext();
    await registerHandler(withProject)();
    expect(withProject.configManager.getEffectiveConfig).toHaveBeenCalledWith('/mock/project');

    capturedHandlers.clear();
    const withoutProject = makeContext({ currentProjectPath: null, currentProjectId: null });
    await registerHandler(withoutProject)();
    expect(withoutProject.configManager.getEffectiveConfig).toHaveBeenCalledWith(undefined);
    expect(lastCheckInput().projectId).toBeNull();
  });

  it('checks no distro for a project whose CLI paths name none', async () => {
    fakePlatform('win32');
    supportsWslByAgent.set('claude', true);
    const context = makeContext();
    context.configManager.getEffectiveConfig.mockReturnValue({ agent: { cliPaths: { claude: 'C:\\Users\\dev\\.local\\bin\\claude.exe' } } });
    const invoke = registerHandler(context);

    await invoke();

    expect(lastCheckInput().distros).toEqual([]);
  });
});

describe('MCP_SERVER_CHECK_CONNECTION: never throws', () => {
  it('answers a failed check as { connected: false, error } with the failure\'s message', async () => {
    mockCheckMcpConnection.mockRejectedValue(new Error('wsl.exe gave no answer in 30 s.'));
    const invoke = registerHandler(makeContext());

    expect(await invoke({ explicit: true })).toEqual({ connected: false, error: 'wsl.exe gave no answer in 30 s.' });
  });

  it('answers a non-Error failure with its text', async () => {
    mockCheckMcpConnection.mockRejectedValue('a raw string rejection');
    const invoke = registerHandler(makeContext());

    expect(await invoke()).toEqual({ connected: false, error: 'a raw string rejection' });
  });

  it('answers a config that cannot be read the same way, without running the check', async () => {
    const context = makeContext();
    context.configManager.getEffectiveConfig.mockImplementation(() => { throw new Error('config.json is unreadable'); });
    const invoke = registerHandler(context);

    expect(await invoke()).toEqual({ connected: false, error: 'config.json is unreadable' });
    expect(mockCheckMcpConnection).not.toHaveBeenCalled();
  });

  it('returns the check\'s own answer untouched when it succeeds or fails on its own terms', async () => {
    const invoke = registerHandler(makeContext());
    mockCheckMcpConnection.mockResolvedValueOnce({ connected: false, error: 'HTTP 401 from http://127.0.0.1:4100/mcp/project-1' });

    expect(await invoke()).toEqual({ connected: false, error: 'HTTP 401 from http://127.0.0.1:4100/mcp/project-1' });
    expect(await invoke()).toEqual({ connected: true });
  });
});

describe('the connection watch the handler also starts', () => {
  it('starts one watch, and its check starts a stopped distro: a session is running in it', async () => {
    const context = makeContext();
    registerHandler(context);

    expect(watchInstances).toHaveLength(1);
    expect(watchInstances[0].start).toHaveBeenCalledTimes(1);

    const check = watchInstances[0].options.check as unknown as (projectId: string, distros: readonly string[]) => Promise<unknown>;
    mockStartFailure.mockReturnValue(null);
    await check('project-9', ['Ubuntu']);

    expect(lastCheckInput()).toMatchObject({
      handle: context.mcpServerHandle,
      projectId: 'project-9',
      distros: ['Ubuntu'],
      startStoppedDistros: true,
    });
  });
});
