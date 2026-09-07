/**
 * Wiring test: the SESSION_SPAWN_TRANSIENT handler
 * (src/main/ipc/handlers/transient-sessions.ts) resolves the shim launch for
 * the PTY shell before building the Command Terminal's command.
 *
 * On Windows an npm-installed CLI resolves to its `.cmd` shim, which a
 * PowerShell or Git Bash host launches through cmd.exe (#353). The Command
 * Terminal carries no prompt, so nothing is truncated here, but its head must
 * match what task spawns use: resolveShimLaunch
 * (src/main/agent/shared/shim-launch.ts) swaps in the sibling shim the host
 * can run, and the handler now also passes that shell to the builder so
 * quoting matches the shell the PTY types into.
 *
 * Mocking pattern follows transient-session-spawn-ensure-trust.test.ts (same
 * handler, same capturedHandlers + mocked IpcContext shape), with the helper
 * mocked at its leaf path and a pass-through default.
 *
 * Red-green: building from `detection.path` instead of `launch.agentPath`
 * fails the swap test; dropping `shell` from commandOptions fails the shell
 * test; moving the resolve call above ensureTrust fails the ordering test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const CMD_HEAD = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.CMD';
const PS1_SIBLING = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

const resolveShimLaunchMock = vi.hoisted(() =>
  vi.fn(async (input: { agentPath: string; shell: string | undefined; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
);

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: resolveShimLaunchMock,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

// The handler calls fs.mkdirSync to create the session's status/events
// directory. Mocked to avoid a real filesystem write for a path built from
// this test's fake project root.
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-transient-task-id') }));

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    revparse: vi.fn(async () => 'main\n'),
    checkout: vi.fn(async () => undefined),
    merge: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: vi.fn(async () => 'origin/main'),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
}));

vi.mock('../../src/shared/git-utils', () => ({
  resolveProjectRoot: vi.fn((projectPath: string) => projectPath),
}));

const mockAgentRegistryGetOrThrow = vi.fn();
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: (name: string) => mockAgentRegistryGetOrThrow(name),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTransientSessionHandlers } from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';
import type { SpawnTransientSessionInput } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = 'C:/Users/dev/proj';

interface MockContext {
  currentProjectId: string | null;
  projectRepo: { getById: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  mcpServerHandle: null;
  sessionManager: { spawn: ReturnType<typeof vi.fn>; getShell: ReturnType<typeof vi.fn> };
}

function createMockContext(): MockContext {
  return {
    currentProjectId: 'proj-1',
    projectRepo: {
      getById: vi.fn(() => ({
        id: 'proj-1',
        path: PROJECT_ROOT,
        default_agent: 'claude',
        default_model: null,
        default_effort: null,
      })),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { cliPaths: {}, permissionMode: 'default' },
        git: { worktreesEnabled: false, defaultBaseBranch: 'main' },
        mcpServer: { enabled: false },
      })),
    },
    mcpServerHandle: null,
    sessionManager: {
      spawn: vi.fn(async () => ({ id: 'session-1' })),
      getShell: vi.fn(async () => PWSH),
    },
  };
}

async function callSpawnHandler(context: MockContext, input: SpawnTransientSessionInput): Promise<unknown> {
  const handler = capturedHandlers.get(IPC.SESSION_SPAWN_TRANSIENT);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_SPAWN_TRANSIENT} was not registered`);
  return handler(null, input);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_SPAWN_TRANSIENT handler: Windows .cmd shim launch resolution wiring', () => {
  let context: MockContext;
  let ensureTrustMock: ReturnType<typeof vi.fn>;
  let buildCommandMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();

    ensureTrustMock = vi.fn(async () => {});
    buildCommandMock = vi.fn(() => 'claude');

    mockAgentRegistryGetOrThrow.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      detect: vi.fn(async () => ({ found: true, path: CMD_HEAD, version: '1.0.0' })),
      ensureTrust: ensureTrustMock,
      buildCommand: buildCommandMock,
    });

    context = createMockContext();
    registerTransientSessionHandlers(context as never);
  });

  it('fetches the session shell and hands it to resolveShimLaunch with the detected path and no prompt', async () => {
    await callSpawnHandler(context, { projectId: 'proj-1', slot: 'slot-1' });

    expect(context.sessionManager.getShell).toHaveBeenCalledTimes(1);
    expect(resolveShimLaunchMock).toHaveBeenCalledTimes(1);
    expect(resolveShimLaunchMock).toHaveBeenCalledWith({ agentPath: CMD_HEAD, shell: PWSH, prompt: undefined });
  });

  it('builds the command from the resolved head and passes the shell to the builder', async () => {
    resolveShimLaunchMock.mockResolvedValueOnce({ agentPath: PS1_SIBLING, prompt: undefined, strategy: 'ps1-sibling' });

    await callSpawnHandler(context, { projectId: 'proj-1', slot: 'slot-1' });

    expect(buildCommandMock).toHaveBeenCalledTimes(1);
    expect(buildCommandMock.mock.calls[0][0]).toMatchObject({ agentPath: PS1_SIBLING, shell: PWSH });
    expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });

  it('resolves after ensureTrust and before buildCommand', async () => {
    await callSpawnHandler(context, { projectId: 'proj-1', slot: 'slot-1' });

    const ensureTrustOrder = ensureTrustMock.mock.invocationCallOrder[0];
    const resolveOrder = resolveShimLaunchMock.mock.invocationCallOrder[0];
    const buildOrder = buildCommandMock.mock.invocationCallOrder[0];
    expect(ensureTrustOrder).toBeLessThan(resolveOrder);
    expect(resolveOrder).toBeLessThan(buildOrder);
  });
});
