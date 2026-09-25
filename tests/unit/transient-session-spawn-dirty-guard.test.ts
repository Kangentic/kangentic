/**
 * Unit tests for the SESSION_SPAWN_TRANSIENT handler's checkout policy
 * (src/main/ipc/handlers/transient-sessions.ts).
 *
 * A Command Terminal's cold spawn checks out the project's default base branch
 * with no user gesture behind it beyond opening a terminal, and a plain
 * `git checkout` carries non-conflicting uncommitted changes onto that branch
 * silently. The handler therefore STAYS PUT when the tree has modifications to
 * tracked files and no branch was picked explicitly, reports it through the
 * same `checkoutError` the renderer already toasts, and skips the ff-merge that
 * would otherwise fast-forward the wrong branch. An explicit picker choice keeps
 * git's own behavior. The target itself resolves the board-shared default
 * ahead of the config default (resolveProjectDefaultBaseBranch), the same chain
 * the renderer's pill and every task spawn use.
 *
 * Mocking pattern follows transient-session-spawn-ensure-trust.test.ts (same
 * handler, same capturedHandlers + mocked IpcContext shape).
 *
 * Red-green: dropping the tracked-changes probe fails the stay-put case;
 * running the merge on the stay-put path fails the no-merge assertion; reading
 * `config.git.defaultBaseBranch` directly fails the board-default case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-transient-task-id') }));

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

interface MockStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

const gitRevparseMock = vi.fn(async () => 'main\n');
const gitStatusMock = vi.fn(async (): Promise<{ files: MockStatusFile[] }> => ({ files: [] }));
const gitCheckoutMock = vi.fn(async () => undefined);
const gitMergeMock = vi.fn(async () => undefined);
vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    revparse: gitRevparseMock,
    status: gitStatusMock,
    checkout: gitCheckoutMock,
    merge: gitMergeMock,
  })),
}));

// Hoisted: the factory below reads it at module-mock time, before a plain
// module-level const would be initialized (the simple-git mock above gets away
// with plain consts only because its references sit inside a lazily-called
// arrow function).
const { fetchIfStaleMock } = vi.hoisted(() => ({
  fetchIfStaleMock: vi.fn(async (_git: unknown, _projectPath: string, branch: string) => `origin/${branch}`),
}));
vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: fetchIfStaleMock,
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

interface SpawnResult {
  session: { id: string };
  branch: string;
  checkoutError?: string;
}

interface MockContext {
  currentProjectId: string | null;
  projectRepo: { getById: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  boardConfigManager: { getDefaultBaseBranchForPath: ReturnType<typeof vi.fn> };
  mcpServerHandle: null;
  sessionManager: { spawn: ReturnType<typeof vi.fn>; getShell: ReturnType<typeof vi.fn> };
}

function createMockContext(options?: { boardDefault?: string; configDefault?: string }): MockContext {
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
        git: { worktreesEnabled: false, defaultBaseBranch: options?.configDefault ?? 'main' },
        mcpServer: { enabled: false },
      })),
    },
    boardConfigManager: {
      getDefaultBaseBranchForPath: vi.fn(() => options?.boardDefault),
    },
    mcpServerHandle: null,
    sessionManager: {
      spawn: vi.fn(async () => ({ id: 'session-1' })),
      getShell: vi.fn(async () => 'bash'),
    },
  };
}

async function callSpawnHandler(input: SpawnTransientSessionInput): Promise<SpawnResult> {
  const handler = capturedHandlers.get(IPC.SESSION_SPAWN_TRANSIENT);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_SPAWN_TRANSIENT} was not registered`);
  return (await handler(null, input)) as SpawnResult;
}

/** Register the handler against a fresh context; returns that context. */
function registerWith(options?: { boardDefault?: string; configDefault?: string }): MockContext {
  const context = createMockContext(options);
  registerTransientSessionHandlers(context as never);
  return context;
}

const TRACKED_MODIFICATION: MockStatusFile = { path: 'src/index.ts', index: ' ', working_dir: 'M' };
const UNTRACKED_FILE: MockStatusFile = { path: 'scratch.txt', index: '?', working_dir: '?' };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_SPAWN_TRANSIENT handler: cold-spawn checkout policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    gitRevparseMock.mockResolvedValue('main\n');
    gitStatusMock.mockResolvedValue({ files: [] });
    mockAgentRegistryGetOrThrow.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      detect: vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '1.0.0' })),
      ensureTrust: vi.fn(async () => {}),
      buildCommand: vi.fn(() => 'claude'),
    });
  });

  it('stays on the current branch, skips the ff-merge, and says so when tracked files are modified and no branch was picked', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('feature/wip\n');
    gitStatusMock.mockResolvedValue({ files: [TRACKED_MODIFICATION, UNTRACKED_FILE] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(gitCheckoutMock).not.toHaveBeenCalled();
    // The merge target is origin/main; running it while HEAD is feature/wip
    // would fast-forward the wrong branch.
    expect(gitMergeMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('feature/wip');
    expect(result.checkoutError).toBe(
      'Staying on "feature/wip": the working tree has uncommitted changes, so this terminal did not switch to "main".',
    );
    // The spawn still happens: the terminal is useful on the branch it is on.
    expect(gitStatusMock).toHaveBeenCalledTimes(1);
  });

  it('checks out the default when the only changes are untracked files', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('feature/wip\n');
    gitStatusMock.mockResolvedValue({ files: [UNTRACKED_FILE] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(gitCheckoutMock).toHaveBeenCalledWith('main');
    expect(gitMergeMock).toHaveBeenCalledWith(['origin/main', '--ff-only']);
    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
  });

  it('never probes the tree, and checks out anyway, when the branch was picked explicitly', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('feature/wip\n');
    gitStatusMock.mockResolvedValue({ files: [TRACKED_MODIFICATION] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1', branch: 'develop' });

    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitCheckoutMock).toHaveBeenCalledWith('develop');
    expect(result.branch).toBe('develop');
    expect(result.checkoutError).toBeUndefined();
  });

  it('never probes the tree when HEAD is already on the target', async () => {
    registerWith();
    gitRevparseMock.mockResolvedValue('main\n');
    gitStatusMock.mockResolvedValue({ files: [TRACKED_MODIFICATION] });

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(gitStatusMock).not.toHaveBeenCalled();
    expect(gitCheckoutMock).not.toHaveBeenCalled();
    expect(result.branch).toBe('main');
    expect(result.checkoutError).toBeUndefined();
  });

  it('resolves the target from the board-shared default ahead of the config default', async () => {
    const context = registerWith({ boardDefault: 'develop', configDefault: 'main' });
    gitRevparseMock.mockResolvedValue('main\n');

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(context.boardConfigManager.getDefaultBaseBranchForPath).toHaveBeenCalledWith(PROJECT_ROOT);
    expect(fetchIfStaleMock).toHaveBeenCalledWith(expect.anything(), PROJECT_ROOT, 'develop');
    expect(gitCheckoutMock).toHaveBeenCalledWith('develop');
    expect(result.branch).toBe('develop');
  });

  it('falls back to the config default, then main, when no board default is set', async () => {
    registerWith({ configDefault: 'trunk' });
    gitRevparseMock.mockResolvedValue('trunk\n');

    const result = await callSpawnHandler({ projectId: 'proj-1', slot: 'slot-1' });

    expect(fetchIfStaleMock).toHaveBeenCalledWith(expect.anything(), PROJECT_ROOT, 'trunk');
    expect(result.branch).toBe('trunk');
  });
});
