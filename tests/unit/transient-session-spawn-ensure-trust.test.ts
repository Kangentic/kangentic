/**
 * Unit test for the SESSION_SPAWN_TRANSIENT handler's pre-spawn ensureTrust
 * call (src/main/ipc/handlers/transient-sessions.ts).
 *
 * The Command Terminal is the likeliest maximized pane, so per
 * .claude/rules/spawn-entry-point-parity.md it is exactly where Claude's
 * fullscreen diff panel would otherwise reopen if the pre-spawn
 * `ensureTrust` (which also closes the diff panel - see
 * src/main/agent/adapters/claude/diff-panel.ts) is skipped or races
 * `buildCommand`.
 *
 * The only existing guard for this line is a STATIC TEXT SCAN in
 * spawn-entry-point-parity.test.ts: it merely proves that a non-comment
 * `ensureTrust(` line appears earlier in the file than `buildCommand(`. That
 * scan stays GREEN for real regressions the scan cannot see:
 *   - the `await` is dropped (fire-and-forget), letting buildCommand / spawn
 *     race the global-config write,
 *   - the call moves into a branch that never executes at handler-call time,
 *   - the wrong argument (e.g. a worktree path instead of projectRoot) is
 *     passed.
 *
 * This test drives the REAL handler function and pins the runtime contract:
 * ensureTrust is called exactly once, with the project root, and its promise
 * RESOLVES before buildCommand runs (caught via a deferred promise - a
 * dropped `await` would let buildCommand fire while ensureTrust is still
 * pending).
 *
 * Mocking pattern follows tests/unit/session-inject-settings-handler.test.ts
 * (same file under test, same capturedHandlers + mocked IpcContext shape).
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

const gitRevparseMock = vi.fn(async () => 'main\n');
const gitCheckoutMock = vi.fn(async () => undefined);
const gitMergeMock = vi.fn(async () => undefined);
vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    revparse: gitRevparseMock,
    checkout: gitCheckoutMock,
    merge: gitMergeMock,
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
  sessionManager: { spawn: ReturnType<typeof vi.fn> };
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
    },
  };
}

/** A promise plus its resolver, exposed so the test controls exactly when it settles. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function callSpawnHandler(context: MockContext, input: SpawnTransientSessionInput): Promise<unknown> {
  const handler = capturedHandlers.get(IPC.SESSION_SPAWN_TRANSIENT);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_SPAWN_TRANSIENT} was not registered`);
  return handler(null, input);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_SPAWN_TRANSIENT handler: ensureTrust runs before buildCommand', () => {
  let context: MockContext;
  let ensureTrustDeferred: ReturnType<typeof createDeferred<void>>;
  let ensureTrustMock: ReturnType<typeof vi.fn>;
  let buildCommandMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    gitRevparseMock.mockResolvedValue('main\n');
    gitCheckoutMock.mockResolvedValue(undefined);
    gitMergeMock.mockResolvedValue(undefined);

    ensureTrustDeferred = createDeferred<void>();
    ensureTrustMock = vi.fn(() => ensureTrustDeferred.promise);
    buildCommandMock = vi.fn(() => 'claude');

    mockAgentRegistryGetOrThrow.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      detect: vi.fn(async () => ({ found: true, path: '/mock/claude', version: '1.0.0' })),
      ensureTrust: ensureTrustMock,
      buildCommand: buildCommandMock,
    });

    context = createMockContext();
    registerTransientSessionHandlers(context as never);
  });

  it('calls ensureTrust(projectRoot) exactly once and does not call buildCommand until it resolves', async () => {
    const resultPromise = callSpawnHandler(context, {
      projectId: 'proj-1',
      slot: 'slot-1',
    });

    // Let the handler run every await that precedes ensureTrust (CLI detect,
    // fetchIfStale, the revparse/checkout/merge sequence) without pinning a
    // specific microtask count, which would be brittle. A generous timeout
    // guards against event-loop starvation under a loaded machine (this repo
    // has a documented flake class from worker contention).
    await vi.waitFor(
      () => {
        expect(ensureTrustMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    // Load-bearing assertion: while ensureTrust's promise is still pending,
    // buildCommand must NOT have run. A dropped `await` on ensureTrust would
    // let buildCommand fire immediately here instead of waiting.
    expect(buildCommandMock).not.toHaveBeenCalled();

    ensureTrustDeferred.resolve();
    await resultPromise;

    expect(ensureTrustMock).toHaveBeenCalledTimes(1);
    expect(ensureTrustMock).toHaveBeenCalledWith(PROJECT_ROOT);
    expect(buildCommandMock).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.spawn).toHaveBeenCalledTimes(1);
  });
});
