/**
 * Unit test for the SESSION_SET_TRANSIENT_LABEL handler wiring
 * (src/main/ipc/handlers/transient-sessions.ts).
 *
 * Every other test touching this feature exercises one side of the IPC boundary
 * in isolation: tests/unit/session-manager-command-terminal-label.test.ts drives
 * `SessionManager.setCommandTerminalLabel` directly (no IPC involved), and
 * tests/unit/transient-session-label.test.ts drives the renderer's mirror call
 * against a hand-rolled `window.electronAPI.sessions.setTransientLabel` stub (no
 * real preload or handler involved). Neither proves the actual `ipcMain.handle`
 * registration exists or that it forwards its two arguments in the right order.
 *
 * That gap matters because the renderer's call site is fire-and-forget
 * (`void window.electronAPI.sessions.setTransientLabel(...).catch(() => {})` in
 * transient-session-slice.ts): an unregistered channel or a swapped argument
 * order would silently lose every derived Command Terminal name after a reload,
 * with no throw, no toast, and no failing test anywhere else in the suite.
 *
 * Mocking pattern follows tests/unit/transient-session-spawn-ensure-trust.test.ts
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
  sessionManager: { setCommandTerminalLabel: ReturnType<typeof vi.fn> };
}

function createMockContext(): MockContext {
  return {
    currentProjectId: 'proj-1',
    projectRepo: { getById: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn() },
    mcpServerHandle: null,
    sessionManager: {
      setCommandTerminalLabel: vi.fn(),
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
    // Red without this: registerTransientSessionHandlers running at all (every
    // other test in the describe block below) does not prove THIS channel was
    // among the handles it registered.
    expect(capturedHandlers.has(IPC.SESSION_SET_TRANSIENT_LABEL)).toBe(true);
  });

  it('forwards (sessionId, label) to sessionManager.setCommandTerminalLabel in that order', () => {
    const handler = getCapturedHandler();

    handler(null, 'sess-1', 'Fix the parser');

    // Positional, not toHaveBeenCalledWith on a swapped pair: this is exactly
    // the mistake this test exists to catch, since the two arguments are both
    // plain strings and a swap would compile and pass any type check.
    expect(context.sessionManager.setCommandTerminalLabel).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.setCommandTerminalLabel).toHaveBeenCalledWith('sess-1', 'Fix the parser');
  });

  it('does not throw when the manager call itself has no return value', () => {
    // ipcMain.handle callbacks may return void; the renderer's call site awaits
    // the invoke promise but discards the resolved value, so nothing depends on
    // this handler returning anything - only on it not throwing.
    const handler = getCapturedHandler();
    expect(() => handler(null, 'sess-2', 'Another name')).not.toThrow();
  });
});
