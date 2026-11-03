/**
 * SESSION_KILL_TRANSIENT with `{ respawn: true }` (src/main/ipc/handlers/transient-sessions.ts)
 * over the real Command Terminal browser cleanup.
 *
 * A respawn (branch switch, resume in place) keeps the slot's Browser pane
 * through the removal it causes. The mark is forgotten as soon as the end
 * returns, whatever the outcome, so a mark no removal spent never keeps the
 * browser through a later end of the same id.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: vi.fn() }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { getOrThrow: vi.fn() } }));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { getByTaskId: vi.fn(() => []), markDeliberateClose: vi.fn() },
}));
vi.mock('../../src/main/browser/browser-lane-manager', () => ({ destroyLanesForTask: vi.fn(() => 0) }));
vi.mock('../../src/main/browser/browser-url-store', () => ({ browserUrlStore: { clear: vi.fn() } }));
vi.mock('../../src/main/browser/command-terminal-browser-store', () => ({ commandTerminalBrowserStore: { clear: vi.fn() } }));
vi.mock('../../src/main/browser/viewport-override', () => ({ releaseViewportOverridesForSession: vi.fn(async () => undefined) }));
vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: { has: vi.fn(() => false), close: vi.fn() },
}));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/projects/app' })),
}));

import { registerTransientSessionHandlers } from '../../src/main/ipc/handlers/transient-sessions';
import { installCommandTerminalBrowserCleanup, RESPAWN_SETTLE_MS } from '../../src/main/ipc/helpers/command-terminal-browser';
import { destroyLanesForTask } from '../../src/main/browser/browser-lane-manager';
import { commandTerminalBrowserOwner } from '../../src/shared/browser-owner';
import { IPC } from '../../src/shared/ipc-channels';
import type { Session } from '../../src/shared/types';

const OWNER = commandTerminalBrowserOwner('proj-1', 'slot-3');

function terminalSession(id: string): Session {
  return {
    id,
    taskId: 'synthetic-tag',
    projectId: 'proj-1',
    pid: null,
    status: 'running',
    shell: 'bash',
    cwd: '/projects/app',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: true,
    commandTerminalSlot: 'slot-3',
  } as Session;
}

type EndOutcome = 'ended' | 'not-found' | 'not-command-terminal' | 'throw';

describe('SESSION_KILL_TRANSIENT respawn mark', () => {
  let sessionManager: EventEmitter & {
    endCommandTerminal: ReturnType<typeof vi.fn>;
    findLiveCommandTerminalSession: ReturnType<typeof vi.fn>;
  };
  let outcome: EndOutcome;

  function kill(sessionId: string, options?: unknown): unknown {
    const handler = capturedHandlers.get(IPC.SESSION_KILL_TRANSIENT);
    if (!handler) throw new Error('handler not registered');
    return handler(null, sessionId, options);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    capturedHandlers.clear();
    outcome = 'ended';
    sessionManager = Object.assign(new EventEmitter(), {
      // Emits the removal synchronously, as the real end does.
      endCommandTerminal: vi.fn((sessionId: string) => {
        if (outcome === 'ended') sessionManager.emit('session-removed', sessionId, terminalSession(sessionId));
        if (outcome === 'throw') throw new Error('kill failed');
        return outcome;
      }),
      findLiveCommandTerminalSession: vi.fn(() => ({ id: 'next' })),
    });
    const context = { sessionManager, mainWindow: { isDestroyed: () => false } };
    installCommandTerminalBrowserCleanup(context as never);
    registerTransientSessionHandlers(context as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps the browser through the removal a respawn kill causes', () => {
    kill('terminal-a', { respawn: true });
    expect(destroyLanesForTask).not.toHaveBeenCalled();
  });

  it('ends the browser for a plain kill', () => {
    kill('terminal-a');
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });

  it.each([
    ['true-ish string', 'true'],
    ['number', 1],
    ['object', {}],
  ])('does not mark for a non-boolean respawn value (%s)', (_name, value) => {
    kill('terminal-a', { respawn: value });
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });

  it('forgets the mark when the id had no live row, so a later removal of it ends the browser', () => {
    outcome = 'not-found';
    kill('terminal-a', { respawn: true });
    expect(destroyLanesForTask).not.toHaveBeenCalled();

    sessionManager.emit('session-removed', 'terminal-a', terminalSession('terminal-a'));
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });

  it('forgets the mark when the end throws, so a later removal of it ends the browser', () => {
    outcome = 'throw';
    expect(() => kill('terminal-a', { respawn: true })).toThrow(/kill failed/);

    sessionManager.emit('session-removed', 'terminal-a', terminalSession('terminal-a'));
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });

  it('forgets the mark when the session is not a Command Terminal', () => {
    outcome = 'not-command-terminal';
    expect(() => kill('terminal-a', { respawn: true })).toThrow(/Not a Command Terminal/);

    sessionManager.emit('session-removed', 'terminal-a', terminalSession('terminal-a'));
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });

  it('still ends the browser if the respawn never starts a new terminal', () => {
    sessionManager.findLiveCommandTerminalSession.mockReturnValue(undefined);
    kill('terminal-a', { respawn: true });
    vi.advanceTimersByTime(RESPAWN_SETTLE_MS);
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });
});
