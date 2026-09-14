/**
 * Unit tests for SessionManager's `reportRejectedPermissionTools` closure
 * (session-manager.ts, wired into SessionTelemetry's constructor callbacks,
 * task #640).
 *
 * The closure itself is a thin resolver:
 *
 *   reportRejectedPermissionTools: (sessionId, toolIds, sinceMs) => {
 *     const session = this.registry.get(sessionId);
 *     if (!session?.agentSessionId) return [];
 *     return session.agentParser?.runtime?.permissionPrompts
 *       ?.reportRejectedPromptTools?.({ cwd: session.cwd, agentSessionId: session.agentSessionId, toolIds, sinceMs }) ?? [];
 *   }
 *
 * None of the existing coverage exercises this exact closure:
 *   - claude-permission-rejection-transcript.test.ts covers the underlying
 *     Claude transcript-tailing function directly (no SessionManager).
 *   - session-telemetry-permission-rejection-poll.test.ts covers
 *     SessionTelemetry's own poll arm/disarm with an inline stub supplied by
 *     the test, not SessionManager's real callback.
 *
 * So a bug specifically in SessionManager's session-id -> {cwd,
 * agentSessionId, toolIds, sinceMs} resolution (e.g. two fields transposed -
 * cwd and agentSessionId are both plain strings, so TypeScript would not
 * catch a swap) would slip through every existing test. These tests close
 * that gap by capturing the real callback SessionManager constructs and
 * driving it directly against a registry entry, without needing a real PTY
 * spawn - mirroring the sibling
 * `tests/unit/session-manager-report-terminated-shells.test.ts` (task #386),
 * which documents the same gap class for its own closure.
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

// Capture the callbacks object SessionManager hands to `new SessionTelemetry(...)`
// without needing to satisfy the real class's full method surface - this test
// never calls any other SessionManager method that would reach into
// `this.telemetry`, so a minimal capturing stub is sufficient and does not
// duplicate SessionTelemetry's own internal logic.
let capturedCallbacks: {
  reportRejectedPermissionTools?: (sessionId: string, toolIds: string[], sinceMs: number) => string[];
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

describe('SessionManager reportRejectedPermissionTools wiring (task #640)', () => {
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

  function getCallback(): (sessionId: string, toolIds: string[], sinceMs: number) => string[] {
    const callback = capturedCallbacks?.reportRejectedPermissionTools;
    if (!callback) throw new Error('reportRejectedPermissionTools was not captured');
    return callback;
  }

  it('forwards exactly {cwd, agentSessionId, toolIds, sinceMs} (not transposed) and returns the adapter result verbatim', () => {
    const reportRejectedPromptTools = vi.fn(() => ['toolu_rejected']);
    seedSession({
      cwd: '/mock/project-cwd',
      agentSessionId: 'agent-session-id-xyz',
      agentParser: {
        runtime: {
          permissionPrompts: { reportRejectedPromptTools },
        },
      } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['toolu_rejected', 'toolu_pending'], 1_694_000_000_000);

    expect(reportRejectedPromptTools).toHaveBeenCalledWith({
      cwd: '/mock/project-cwd',
      agentSessionId: 'agent-session-id-xyz',
      toolIds: ['toolu_rejected', 'toolu_pending'],
      sinceMs: 1_694_000_000_000,
    });
    expect(result).toEqual(['toolu_rejected']);
  });

  it('returns [] and never calls the adapter when agentSessionId has not been captured yet', () => {
    const reportRejectedPromptTools = vi.fn(() => ['toolu_rejected']);
    seedSession({
      agentSessionId: null,
      agentParser: {
        runtime: {
          permissionPrompts: { reportRejectedPromptTools },
        },
      } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['toolu_rejected'], 0);

    expect(reportRejectedPromptTools).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('returns [] for an unknown sessionId without throwing', () => {
    const result = getCallback()('does-not-exist', ['toolu_rejected'], 0);
    expect(result).toEqual([]);
  });

  it('returns [] when the adapter has no permissionPrompts capability at all', () => {
    seedSession({
      agentSessionId: 'agent-session-id-xyz',
      agentParser: { runtime: {} } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['toolu_rejected'], 0);

    expect(result).toEqual([]);
  });

  it('returns [] when the adapter declares permissionPrompts but no reportRejectedPromptTools method', () => {
    seedSession({
      agentSessionId: 'agent-session-id-xyz',
      agentParser: {
        runtime: {
          permissionPrompts: {},
        },
      } as unknown as ManagedSession['agentParser'],
    });

    const result = getCallback()('session-1', ['toolu_rejected'], 0);

    expect(result).toEqual([]);
  });
});
