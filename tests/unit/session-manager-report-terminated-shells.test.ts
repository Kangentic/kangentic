/**
 * Unit tests for SessionManager's `reportTerminatedBackgroundShells` closure
 * (session-manager.ts, wired into SessionTelemetry's constructor callbacks).
 *
 * Task #386 added this callback so the bg-shell watcher can ask "has this
 * NAMED, PID-less shell's terminal <task-notification> appeared in the
 * agent's durable transcript yet?" The closure itself is a thin resolver:
 *
 *   reportTerminatedBackgroundShells: (sessionId, shellIds) => {
 *     const session = this.registry.get(sessionId);
 *     if (!session?.agentSessionId) return [];
 *     return session.agentParser?.runtime?.backgroundShells
 *       ?.reportTerminatedShells?.({ cwd: session.cwd, agentSessionId: session.agentSessionId, shellIds }) ?? [];
 *   }
 *
 * None of the existing coverage exercises this exact closure:
 *   - claude-background-shell-transcript.test.ts covers the underlying
 *     Claude transcript-tailing function directly (no SessionManager).
 *   - bg-shell-watcher.test.ts covers BgShellWatcher calling a STUBBED
 *     `reportTerminatedShellsFromTranscript` callback.
 *   - session-telemetry-wiring.test.ts covers SessionTelemetry's own
 *     forwarding (`callbacks.reportTerminatedBackgroundShells?.(...)  ?? []`)
 *     with an inline stub supplied by the test, not SessionManager's real one.
 *
 * So a bug specifically in SessionManager's session-id -> {cwd,
 * agentSessionId} resolution (e.g. the two fields transposed - both are
 * plain strings, so TypeScript would not catch a swap) would slip through
 * every existing test. These tests close that gap by capturing the real
 * callback SessionManager constructs and driving it directly against a
 * registry entry, without needing a real PTY spawn or OS process probe
 * (which SessionManager does not expose a test seam to inject anyway - see
 * the sibling `resolveBackgroundShellOutputFile` callback, which has no
 * direct test either for the same reason).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// node-pty must be mocked before importing SessionManager.
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// Capture the callbacks object SessionManager hands to `new SessionTelemetry(...)`
// without needing to satisfy the real class's full method surface - this test
// never calls any other SessionManager method that would reach into
// `this.telemetry`, so a minimal capturing stub is sufficient and does not
// duplicate SessionTelemetry's own internal logic.
let capturedCallbacks: {
  reportTerminatedBackgroundShells?: (sessionId: string, shellIds: string[]) => string[];
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
import type { ManagedSession } from '../../src/main/pty/session-registry';

describe('SessionManager reportTerminatedBackgroundShells wiring (task #386)', () => {
  let manager: SessionManager;

  beforeEach(() => {
    capturedCallbacks = null;
    manager = new SessionManager();
  });

  /** Directly inject a ManagedSession into SessionManager's private registry,
   *  bypassing spawn() entirely - spawn() never sets `agentSessionId` on the
   *  ManagedSession object at construction time (it is only set later, by
   *  the onAgentSessionId capture callback), so building the fixture by hand
   *  is the only way to exercise a session with a KNOWN agentSessionId. */
  function seedSession(overrides: Partial<ManagedSession>): void {
    const registry = (manager as unknown as {
      registry: { set(id: string, session: ManagedSession): void };
    }).registry;
    const base: ManagedSession = {
      id: 'session-1',
      taskId: 'task-1',
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
    };
    registry.set(base.id, base);
  }

  function getCallback(): (sessionId: string, shellIds: string[]) => string[] {
    const callback = capturedCallbacks?.reportTerminatedBackgroundShells;
    if (!callback) throw new Error('reportTerminatedBackgroundShells was not captured');
    return callback;
  }

  it('forwards the session\'s own cwd and agentSessionId (not transposed) and shellIds through', () => {
    const reportTerminatedShells = vi.fn(() => ['shell-a']);
    seedSession({
      cwd: '/mock/project-cwd',
      agentSessionId: 'agent-session-id-xyz',
      agentParser: {
        runtime: {
          backgroundShells: { resolveOutputFile: () => null, reportTerminatedShells },
        },
      } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['shell-a', 'shell-b']);

    expect(reportTerminatedShells).toHaveBeenCalledWith({
      cwd: '/mock/project-cwd',
      agentSessionId: 'agent-session-id-xyz',
      shellIds: ['shell-a', 'shell-b'],
    });
    expect(result).toEqual(['shell-a']);
  });

  it('returns [] and never calls the adapter when agentSessionId has not been captured yet', () => {
    const reportTerminatedShells = vi.fn(() => ['shell-a']);
    seedSession({
      agentSessionId: null,
      agentParser: {
        runtime: {
          backgroundShells: { resolveOutputFile: () => null, reportTerminatedShells },
        },
      } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['shell-a']);

    expect(reportTerminatedShells).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('returns [] for an unknown sessionId without throwing', () => {
    const result = getCallback()('does-not-exist', ['shell-a']);
    expect(result).toEqual([]);
  });

  it('returns [] when the adapter has no backgroundShells capability at all', () => {
    seedSession({
      agentSessionId: 'agent-session-id-xyz',
      agentParser: { runtime: {} } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['shell-a']);

    expect(result).toEqual([]);
  });

  it('returns [] when the adapter has backgroundShells but no reportTerminatedShells method', () => {
    seedSession({
      agentSessionId: 'agent-session-id-xyz',
      agentParser: {
        runtime: {
          backgroundShells: { resolveOutputFile: () => null },
        },
      } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['shell-a']);

    expect(result).toEqual([]);
  });
});
