/**
 * SessionManager's answer to "can this session be heard from right now" (#913). A session on an SSH
 * host sends no hook and no output while its host's link is down, so the activity watchdog and the
 * idle timeout wait for it. Only a link event changes that; a session on another host, and one on this
 * computer, are never held. When the link returns the time it was down is wiped from the idle and
 * liveness clocks of that host's running sessions.
 *
 * The real `SessionTelemetry` is replaced by a stub that captures the callbacks SessionManager hands it,
 * the way session-manager-report-terminated-shells.test.ts does. What the engine does with the answers is
 * pinned in remote-link-activity-hold.test.ts.
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
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

interface CapturedCallbacks {
  isActivityHeld?: (sessionId: string) => boolean;
  isIdleTimeoutExempt?: (sessionId: string) => boolean;
}

let capturedCallbacks: CapturedCallbacks | null = null;
const noteLinkRestored = vi.fn();

vi.mock('../../src/main/activity-engine/session-telemetry', () => {
  class MockSessionTelemetry {
    constructor(callbacks: CapturedCallbacks) {
      capturedCallbacks = callbacks;
    }
    noteLinkRestored(sessionIds: Iterable<string>) {
      noteLinkRestored([...sessionIds]);
    }
  }
  return { SessionTelemetry: MockSessionTelemetry };
});

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession } from '../../src/main/pty/session-registry';

type LinkState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

describe('SessionManager holds a session whose host link is down', () => {
  let manager: SessionManager;

  beforeEach(() => {
    capturedCallbacks = null;
    noteLinkRestored.mockClear();
    manager = new SessionManager();
  });

  function seedSession(id: string, overrides: Partial<ManagedSession>): void {
    const registry = (manager as unknown as { registry: { set(id: string, session: ManagedSession): void } }).registry;
    registry.set(id, {
      id,
      taskId: `task-${id}`,
      projectId: 'project-1',
      pty: null,
      status: 'running',
      shell: '',
      cwd: '/mock/project-cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
      ...overrides,
    });
  }

  function linkEvent(hostId: string, state: LinkState): void {
    (manager as unknown as { handleHostEvent(event: unknown): void }).handleHostEvent({
      type: 'remoteLink', hostId, state, detail: null,
    });
  }

  function callbacks(): Required<CapturedCallbacks> {
    if (!capturedCallbacks?.isActivityHeld || !capturedCallbacks.isIdleTimeoutExempt) throw new Error('callbacks were not captured');
    return capturedCallbacks as Required<CapturedCallbacks>;
  }

  it('holds the watchdog and exempts the idle timeout for a session on a host while its link is down', () => {
    seedSession('remote-a', { hostId: 'host-a' });
    seedSession('local', {});
    expect(callbacks().isActivityHeld('remote-a')).toBe(false);

    linkEvent('host-a', 'reconnecting');

    expect(callbacks().isActivityHeld('remote-a')).toBe(true);
    expect(callbacks().isIdleTimeoutExempt('remote-a')).toBe(true);
    expect(callbacks().isActivityHeld('local')).toBe(false);
    expect(callbacks().isIdleTimeoutExempt('local')).toBe(false);
  });

  it('never holds a session on another host', () => {
    seedSession('remote-b', { hostId: 'host-b' });

    linkEvent('host-a', 'reconnecting');

    expect(callbacks().isActivityHeld('remote-b')).toBe(false);
    expect(callbacks().isIdleTimeoutExempt('remote-b')).toBe(false);
  });

  it('lets go, and wipes the outage from the clocks of that host\'s running sessions only, when the link returns', () => {
    seedSession('remote-a', { hostId: 'host-a' });
    seedSession('remote-a-ended', { hostId: 'host-a', status: 'exited' });
    seedSession('remote-b', { hostId: 'host-b' });
    linkEvent('host-a', 'reconnecting');
    linkEvent('host-b', 'reconnecting');

    linkEvent('host-a', 'connected');

    expect(callbacks().isActivityHeld('remote-a')).toBe(false);
    expect(callbacks().isActivityHeld('remote-b')).toBe(true);
    expect(noteLinkRestored).toHaveBeenCalledTimes(1);
    expect(noteLinkRestored).toHaveBeenCalledWith(['remote-a']);
  });

  it('does nothing for a first connection, which no drop came before', () => {
    seedSession('remote-a', { hostId: 'host-a' });

    linkEvent('host-a', 'connected');

    expect(noteLinkRestored).not.toHaveBeenCalled();
    expect(callbacks().isActivityHeld('remote-a')).toBe(false);
  });
});
