/**
 * Wiring test for SessionManager's `onBranchPushed` telemetry callback.
 *
 * SessionTelemetry reports the destination of an agent's own `git push`
 * through `callbacks.onBranchPushed`; SessionManager must turn that into a
 * `branch-pushed` event carrying the session id and the branch, which the IPC
 * listener records on the task. The callback is optional on the telemetry
 * side (only production wires it), so nothing but this test would notice the
 * production wiring going missing.
 *
 * Structure mirrors session-manager-agent-absence.test.ts: capture the
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
  onBranchPushed?: (sessionId: string, branch: string) => void;
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

describe('SessionManager branch-pushed wiring', () => {
  beforeEach(() => {
    capturedCallbacks = null;
  });

  it('turns the onBranchPushed telemetry callback into a branch-pushed event', () => {
    const manager = new SessionManager();
    const listener = vi.fn();
    manager.on('branch-pushed', listener);

    expect(capturedCallbacks?.onBranchPushed).toBeTypeOf('function');
    capturedCallbacks?.onBranchPushed?.('sess-1', 'feature/x');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('sess-1', 'feature/x');
  });
});
