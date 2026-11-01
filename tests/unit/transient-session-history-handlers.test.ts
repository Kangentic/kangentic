/**
 * Unit test for the COMMAND_TERMINAL_HISTORY_RENAME, _REMOVE and _SEARCH handler
 * wiring (src/main/ipc/handlers/transient-sessions.ts).
 *
 * `CommandTerminalHistory` is tested on its own (command-terminal-history.test.ts),
 * so this file proves the `ipcMain.handle` registrations: a payload of the wrong
 * type is refused before the history is touched, a project that names no project
 * changes nothing, a clear reaches `rename` as null, and the arguments reach the
 * history in order.
 *
 * Mocking pattern follows tests/unit/transient-session-rename-handler.test.ts.
 *
 * Red-green, from toggling transient-sessions.ts and restoring it:
 *  - drop the `typeof name` check in the rename handler: the non-string name test fails.
 *  - drop the `projectRepo.getById` check in a handler: its unknown-project test fails.
 *  - swap the arguments of the `rename`, `remove` or `searchText` call: its delegation test fails.
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

import { registerTransientSessionHandlers } from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';

interface MockContext {
  currentProjectId: string | null;
  projectRepo: { getById: ReturnType<typeof vi.fn> };
  configManager: { getEffectiveConfig: ReturnType<typeof vi.fn> };
  mcpServerHandle: null;
  sessionManager: Record<string, never>;
  commandTerminalHistory: {
    rename: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    searchText: ReturnType<typeof vi.fn>;
  };
}

const SEARCH_NOTHING = { indexingOff: false, hits: [] };

function createMockContext(): MockContext {
  return {
    currentProjectId: 'proj-1',
    // A project the desktop knows: only 'proj-1' resolves.
    projectRepo: { getById: vi.fn((projectId: string) => (projectId === 'proj-1' ? { id: 'proj-1' } : undefined)) },
    configManager: { getEffectiveConfig: vi.fn() },
    mcpServerHandle: null,
    sessionManager: {},
    commandTerminalHistory: {
      rename: vi.fn(() => true),
      remove: vi.fn(() => true),
      searchText: vi.fn(async () => ({ indexingOff: false, hits: [{ agentSessionId: 'conversation-1' }] })),
    },
  };
}

function getCapturedHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`Handler for ${channel} was not registered`);
  return handler;
}

describe('command terminal history handlers', () => {
  let context: MockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
    context = createMockContext();
    registerTransientSessionHandlers(context as never);
  });

  it('registers a handler for each channel', () => {
    expect(capturedHandlers.has(IPC.COMMAND_TERMINAL_HISTORY_RENAME)).toBe(true);
    expect(capturedHandlers.has(IPC.COMMAND_TERMINAL_HISTORY_REMOVE)).toBe(true);
    expect(capturedHandlers.has(IPC.COMMAND_TERMINAL_HISTORY_SEARCH)).toBe(true);
  });

  describe('COMMAND_TERMINAL_HISTORY_RENAME', () => {
    it('forwards (projectId, agentSessionId, name) to the history in that order and returns its answer', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_RENAME);

      expect(handler(null, 'proj-1', 'conversation-1', 'Auth refactor')).toBe(true);

      expect(context.commandTerminalHistory.rename).toHaveBeenCalledTimes(1);
      expect(context.commandTerminalHistory.rename).toHaveBeenCalledWith('proj-1', 'conversation-1', 'Auth refactor');
    });

    it('returns the history refusal as false', () => {
      context.commandTerminalHistory.rename.mockReturnValue(false);
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_RENAME);

      expect(handler(null, 'proj-1', 'conversation-1', 'Auth refactor')).toBe(false);
    });

    it('passes a clear through as null', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_RENAME);

      handler(null, 'proj-1', 'conversation-1', null);

      expect(context.commandTerminalHistory.rename).toHaveBeenCalledWith('proj-1', 'conversation-1', null);
    });

    it('refuses a non-string project or conversation id, and a name that is neither a string nor null', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_RENAME);

      // Read as a clear, a non-string name would wipe the name and turn the namer off for good.
      expect(handler(null, 'proj-1', 'conversation-1', 42)).toBe(false);
      expect(handler(null, 'proj-1', 'conversation-1', undefined)).toBe(false);
      expect(handler(null, 'proj-1', 'conversation-1', { name: 'x' })).toBe(false);
      expect(handler(null, 7, 'conversation-1', 'Auth refactor')).toBe(false);
      expect(handler(null, null, 'conversation-1', 'Auth refactor')).toBe(false);
      expect(handler(null, 'proj-1', 7, 'Auth refactor')).toBe(false);
      expect(handler(null, 'proj-1', undefined, 'Auth refactor')).toBe(false);

      expect(context.commandTerminalHistory.rename).not.toHaveBeenCalled();
    });

    it('refuses a project that names no project, without calling the history', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_RENAME);

      expect(handler(null, 'proj-unknown', 'conversation-1', 'Auth refactor')).toBe(false);

      expect(context.projectRepo.getById).toHaveBeenCalledWith('proj-unknown');
      expect(context.commandTerminalHistory.rename).not.toHaveBeenCalled();
    });

    it('answers false when the history is not running', () => {
      (context as { commandTerminalHistory?: unknown }).commandTerminalHistory = undefined;
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_RENAME);

      expect(handler(null, 'proj-1', 'conversation-1', 'Auth refactor')).toBe(false);
    });
  });

  describe('COMMAND_TERMINAL_HISTORY_REMOVE', () => {
    it('forwards (projectId, agentSessionId) to the history in that order and returns its answer', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_REMOVE);

      expect(handler(null, 'proj-1', 'conversation-1')).toBe(true);

      expect(context.commandTerminalHistory.remove).toHaveBeenCalledTimes(1);
      expect(context.commandTerminalHistory.remove).toHaveBeenCalledWith('proj-1', 'conversation-1');
    });

    it('returns the history refusal as false', () => {
      context.commandTerminalHistory.remove.mockReturnValue(false);
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_REMOVE);

      expect(handler(null, 'proj-1', 'conversation-1')).toBe(false);
    });

    it('refuses a non-string project or conversation id, without calling the history', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_REMOVE);

      expect(handler(null, 7, 'conversation-1')).toBe(false);
      expect(handler(null, undefined, 'conversation-1')).toBe(false);
      expect(handler(null, 'proj-1', 7)).toBe(false);
      expect(handler(null, 'proj-1', null)).toBe(false);

      expect(context.commandTerminalHistory.remove).not.toHaveBeenCalled();
    });

    it('refuses a project that names no project, without calling the history', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_REMOVE);

      expect(handler(null, 'proj-unknown', 'conversation-1')).toBe(false);

      expect(context.projectRepo.getById).toHaveBeenCalledWith('proj-unknown');
      expect(context.commandTerminalHistory.remove).not.toHaveBeenCalled();
    });

    it('answers false when the history is not running', () => {
      (context as { commandTerminalHistory?: unknown }).commandTerminalHistory = undefined;
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_REMOVE);

      expect(handler(null, 'proj-1', 'conversation-1')).toBe(false);
    });
  });

  describe('COMMAND_TERMINAL_HISTORY_SEARCH', () => {
    it('forwards (projectId, query) to the history in that order and returns its answer', async () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_SEARCH);

      await expect(handler(null, 'proj-1', 'needle')).resolves.toEqual({
        indexingOff: false,
        hits: [{ agentSessionId: 'conversation-1' }],
      });

      expect(context.commandTerminalHistory.searchText).toHaveBeenCalledTimes(1);
      expect(context.commandTerminalHistory.searchText).toHaveBeenCalledWith('proj-1', 'needle');
    });

    it('answers no hits, without calling the history, for a non-string project id or query', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_SEARCH);

      expect(handler(null, 7, 'needle')).toEqual(SEARCH_NOTHING);
      expect(handler(null, undefined, 'needle')).toEqual(SEARCH_NOTHING);
      expect(handler(null, 'proj-1', 7)).toEqual(SEARCH_NOTHING);
      expect(handler(null, 'proj-1', null)).toEqual(SEARCH_NOTHING);

      expect(context.commandTerminalHistory.searchText).not.toHaveBeenCalled();
    });

    it('answers no hits, without calling the history, for a project that names no project', () => {
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_SEARCH);

      expect(handler(null, 'proj-unknown', 'needle')).toEqual(SEARCH_NOTHING);

      expect(context.projectRepo.getById).toHaveBeenCalledWith('proj-unknown');
      expect(context.commandTerminalHistory.searchText).not.toHaveBeenCalled();
    });

    it('answers no hits when the history is not running', () => {
      (context as { commandTerminalHistory?: unknown }).commandTerminalHistory = undefined;
      const handler = getCapturedHandler(IPC.COMMAND_TERMINAL_HISTORY_SEARCH);

      expect(handler(null, 'proj-1', 'needle')).toEqual(SEARCH_NOTHING);
    });
  });
});
