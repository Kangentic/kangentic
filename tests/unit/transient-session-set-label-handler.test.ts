/**
 * Unit test for the SESSION_SET_TRANSIENT_LABEL handler wiring
 * (src/main/ipc/handlers/transient-sessions.ts).
 *
 * A rename in the Command Terminal's header or rail is the user's name for the
 * terminal. The handler writes it to the registry row, which is what every
 * surface reads its name from, and then to the terminal's Earlier record, so a
 * resume comes back under it. The two sides are tested on their own elsewhere
 * (tests/unit/session-manager-command-terminal-label.test.ts drives
 * `renameCommandTerminalLabel`; tests/unit/command-terminal-history.test.ts
 * drives `renameLabel`), so this file proves the registration exists, forwards
 * its arguments in order, clears on a blank name, and leaves the record alone
 * when the row refused the rename.
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
  sessionManager: { renameCommandTerminalLabel: ReturnType<typeof vi.fn> };
  commandTerminalHistory: { renameLabel: ReturnType<typeof vi.fn> };
}

function createMockContext(): MockContext {
  return {
    currentProjectId: 'proj-1',
    projectRepo: { getById: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn() },
    mcpServerHandle: null,
    sessionManager: {
      renameCommandTerminalLabel: vi.fn(() => true),
    },
    commandTerminalHistory: {
      renameLabel: vi.fn(),
    },
  };
}

function getCapturedHandler(): (...args: unknown[]) => unknown {
  const handler = capturedHandlers.get(IPC.SESSION_SET_TRANSIENT_LABEL);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_SET_TRANSIENT_LABEL} was not registered`);
  return handler;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_SET_TRANSIENT_LABEL handler', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    context = createMockContext();
    registerTransientSessionHandlers(context as never);
  });

  it('registers a handler for the channel', () => {
    expect(capturedHandlers.has(IPC.SESSION_SET_TRANSIENT_LABEL)).toBe(true);
  });

  it('renames the row, then the Earlier record, with (sessionId, label) in that order', () => {
    getCapturedHandler()(null, 'sess-1', '  Parser work  ');

    expect(context.sessionManager.renameCommandTerminalLabel).toHaveBeenCalledWith('sess-1', '  Parser work  ');
    expect(context.commandTerminalHistory.renameLabel).toHaveBeenCalledWith('sess-1', 'Parser work');
    expect(context.sessionManager.renameCommandTerminalLabel.mock.invocationCallOrder[0])
      .toBeLessThan(context.commandTerminalHistory.renameLabel.mock.invocationCallOrder[0]);
  });

  it('clears the Earlier record on a blank name', () => {
    getCapturedHandler()(null, 'sess-1', '   ');
    expect(context.commandTerminalHistory.renameLabel).toHaveBeenCalledWith('sess-1', null);
  });

  it('leaves the Earlier record alone when the row refused the rename', () => {
    // An unchanged name, a task agent, or a terminal that already ended.
    context.sessionManager.renameCommandTerminalLabel.mockReturnValue(false);
    getCapturedHandler()(null, 'sess-1', 'Parser work');
    expect(context.commandTerminalHistory.renameLabel).not.toHaveBeenCalled();
  });
});
