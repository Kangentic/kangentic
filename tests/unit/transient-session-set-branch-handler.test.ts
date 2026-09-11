/**
 * Unit test for the SESSION_SET_TRANSIENT_BRANCH handler wiring
 * (src/main/ipc/handlers/transient-sessions.ts).
 *
 * The renderer re-derives a Command Terminal's branch from live HEAD and mirrors
 * it to main fire-and-forget, exactly like the label. As with the label, the two
 * sides are tested in isolation elsewhere (tests/unit/session-manager-command-
 * terminal-branch.test.ts drives `SessionManager.setCommandTerminalBranch`;
 * tests/unit/transient-session-branch.test.ts drives the renderer's refresh
 * against a stubbed `window.electronAPI`), so this file is what proves the
 * `ipcMain.handle` registration exists and forwards its two string arguments
 * in the right order. A swap would compile, pass every type check, and lose
 * the mirrored branch silently.
 *
 * Mocking pattern follows tests/unit/transient-session-set-label-handler.test.ts.
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

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    revparse: vi.fn(async () => 'main\n'),
    status: vi.fn(async () => ({ files: [] })),
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

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTransientSessionHandlers } from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockContext {
  currentProjectId: string | null;
  projectRepo: { getById: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  mcpServerHandle: null;
  sessionManager: { setCommandTerminalBranch: ReturnType<typeof vi.fn> };
}

function createMockContext(): MockContext {
  return {
    currentProjectId: 'proj-1',
    projectRepo: { getById: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn() },
    mcpServerHandle: null,
    sessionManager: {
      setCommandTerminalBranch: vi.fn(),
    },
  };
}

function getCapturedHandler(): (...args: unknown[]) => unknown {
  const handler = capturedHandlers.get(IPC.SESSION_SET_TRANSIENT_BRANCH);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_SET_TRANSIENT_BRANCH} was not registered`);
  return handler;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_SET_TRANSIENT_BRANCH handler', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    context = createMockContext();
    registerTransientSessionHandlers(context as never);
  });

  it('registers a handler for the channel', () => {
    expect(capturedHandlers.has(IPC.SESSION_SET_TRANSIENT_BRANCH)).toBe(true);
  });

  it('forwards (sessionId, branch) to sessionManager.setCommandTerminalBranch in that order', () => {
    const handler = getCapturedHandler();

    handler(null, 'sess-1', 'feature/auth');

    expect(context.sessionManager.setCommandTerminalBranch).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.setCommandTerminalBranch).toHaveBeenCalledWith('sess-1', 'feature/auth');
  });

  it('does not throw when the manager call itself has no return value', () => {
    const handler = getCapturedHandler();
    expect(() => handler(null, 'sess-2', 'main')).not.toThrow();
  });
});
