/**
 * Unit test for the SESSION_KILL_TRANSIENT handler wiring
 * (src/main/ipc/handlers/transient-sessions.ts).
 *
 * The handler ends a Command Terminal through `SessionManager.endCommandTerminal`,
 * the same call a phone's `command-terminal` stop and the agent-absence sweep
 * make, so the three ends cannot drift. The teardown order itself (kill, capture
 * the exit, remove, delete the directory only after the exit) is pinned where it
 * now lives: tests/unit/session-manager-end-command-terminal.test.ts.
 *
 * What the handler adds is the refusal: this channel used to kill and remove
 * ANY session id it was given, a task's agent included. It now ends a Command
 * Terminal and nothing else.
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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
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

function createMockContext(outcome: 'ended' | 'not-found' | 'not-command-terminal') {
  return {
    sessionManager: {
      endCommandTerminal: vi.fn(() => outcome),
    },
  };
}

function getCapturedHandler(): (...args: unknown[]) => unknown {
  const handler = capturedHandlers.get(IPC.SESSION_KILL_TRANSIENT);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_KILL_TRANSIENT} was not registered`);
  return handler;
}

describe('SESSION_KILL_TRANSIENT handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
  });

  it('registers a handler for the channel', () => {
    registerTransientSessionHandlers(createMockContext('ended') as never);
    expect(capturedHandlers.has(IPC.SESSION_KILL_TRANSIENT)).toBe(true);
  });

  it('ends the terminal through SessionManager.endCommandTerminal, with the default grace', () => {
    const context = createMockContext('ended');
    registerTransientSessionHandlers(context as never);

    getCapturedHandler()(null, 'sess-1');

    expect(context.sessionManager.endCommandTerminal).toHaveBeenCalledTimes(1);
    expect(context.sessionManager.endCommandTerminal).toHaveBeenCalledWith('sess-1');
  });

  it('refuses a session that is not a Command Terminal', () => {
    // Red without the refusal: a renderer or a stale id could end a task's
    // agent through the Command Terminal channel.
    registerTransientSessionHandlers(createMockContext('not-command-terminal') as never);

    expect(() => getCapturedHandler()(null, 'task-session')).toThrow(/Not a Command Terminal/);
  });

  it('is a quiet no-op for an id with no live row, as it always was', () => {
    registerTransientSessionHandlers(createMockContext('not-found') as never);

    expect(() => getCapturedHandler()(null, 'sess-missing')).not.toThrow();
  });
});
