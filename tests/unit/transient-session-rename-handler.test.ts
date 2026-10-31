/**
 * Unit test for the SESSION_RENAME_TRANSIENT handler wiring
 * (src/main/ipc/handlers/transient-sessions.ts).
 *
 * The user renames a Command Terminal from its header, its ... menu or its rail
 * row. `SessionManager.renameCommandTerminal` is tested on its own
 * (tests/unit/session-manager-command-terminal-label.test.ts), so this file is
 * what proves the `ipcMain.handle` registration exists, forwards the session id
 * and the name in that order, hands back whether the name changed, and passes a
 * clear through as null rather than whatever non-string arrived.
 *
 * Mocking pattern follows tests/unit/transient-session-set-branch-handler.test.ts.
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

vi.mock('../../src/main/git/git-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git/git-client')>()),
  gitAt: vi.fn(() => ({
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
  sessionManager: { renameCommandTerminal: ReturnType<typeof vi.fn> };
}

function createMockContext(): MockContext {
  return {
    currentProjectId: 'proj-1',
    projectRepo: { getById: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn() },
    mcpServerHandle: null,
    sessionManager: {
      renameCommandTerminal: vi.fn(() => true),
    },
  };
}

function getCapturedHandler(): (...args: unknown[]) => unknown {
  const handler = capturedHandlers.get(IPC.SESSION_RENAME_TRANSIENT);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_RENAME_TRANSIENT} was not registered`);
  return handler;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_RENAME_TRANSIENT handler', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    context = createMockContext();
    registerTransientSessionHandlers(context as never);
  });

  it('registers a handler for the channel', () => {
    expect(capturedHandlers.has(IPC.SESSION_RENAME_TRANSIENT)).toBe(true);
  });

  it('forwards (sessionId, name) to sessionManager.renameCommandTerminal and returns its answer', () => {
    const handler = getCapturedHandler();

    expect(handler(null, 'sess-1', 'Auth refactor')).toBe(true);

    expect(context.sessionManager.renameCommandTerminal).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.renameCommandTerminal).toHaveBeenCalledWith('sess-1', 'Auth refactor');
  });

  it('passes a clear, or anything that is not a string, through as null', () => {
    const handler = getCapturedHandler();

    handler(null, 'sess-1', null);
    handler(null, 'sess-1', 42);

    expect(context.sessionManager.renameCommandTerminal).toHaveBeenNthCalledWith(1, 'sess-1', null);
    expect(context.sessionManager.renameCommandTerminal).toHaveBeenNthCalledWith(2, 'sess-1', null);
  });
});
