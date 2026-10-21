/**
 * Wiring test for SessionManager's `requestSuspend` telemetry callback, which
 * the idle-timeout sweep calls just before it reports the timeout.
 *
 * A task's agent must NOT be suspended here. The 'idle-timeout' listener
 * (ipc/handlers/sessions.ts) pauses it through `pauseTaskSession`, which
 * writes the paused record before the PTY goes down. Suspending here first
 * flipped the registry with the record still `running`, so a quit in the gap
 * resumed the agent on the next launch, breaking "paused until you resume it".
 * A Command Terminal and a workflow's own agent have no task record, so they
 * are still suspended here.
 *
 * Structure mirrors session-manager-branch-pushed-wiring.test.ts: capture the
 * callbacks object SessionManager hands to `new SessionTelemetry` and drive it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

let capturedCallbacks: {
  requestSuspend?: (sessionId: string) => void;
} | null = null;

vi.mock('../../src/main/activity-engine/session-telemetry', () => {
  class MockSessionTelemetry {
    constructor(callbacks: typeof capturedCallbacks) {
      capturedCallbacks = callbacks;
    }
  }
  return { SessionTelemetry: MockSessionTelemetry };
});

import { SessionManager } from '../../src/main/pty/session-manager';

interface RegistryAccess {
  registry: { set: (id: string, session: Record<string, unknown>) => void };
}

describe('SessionManager idle-sweep suspend wiring', () => {
  let manager: SessionManager;
  let suspendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedCallbacks = null;
    manager = new SessionManager();
    suspendSpy = vi.spyOn(manager, 'suspend').mockResolvedValue(undefined);
  });

  function register(id: string, fields: Record<string, unknown>): void {
    (manager as unknown as RegistryAccess).registry.set(id, {
      id, status: 'running', transient: false, workflowId: null, ...fields,
    });
  }

  it('leaves a task\'s agent for the idle-timeout listener to pause, record first', () => {
    register('sess-task', { taskId: 'task-1' });

    capturedCallbacks?.requestSuspend?.('sess-task');

    expect(suspendSpy).not.toHaveBeenCalled();
  });

  it('suspends a Command Terminal, which has no task record to write', () => {
    register('sess-terminal', { taskId: 'terminal-1', transient: true });

    capturedCallbacks?.requestSuspend?.('sess-terminal');

    expect(suspendSpy).toHaveBeenCalledWith('sess-terminal');
  });

  it('suspends a workflow\'s own agent, which has no task record to write', () => {
    register('sess-workflow', { taskId: 'wf-1', transient: true, workflowId: 'wf-1' });

    capturedCallbacks?.requestSuspend?.('sess-workflow');

    expect(suspendSpy).toHaveBeenCalledWith('sess-workflow');
  });
});
