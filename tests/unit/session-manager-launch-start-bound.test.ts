/**
 * Unit tests for the start bound of SessionManager's agent-absence sweep
 * (`armLaunchStartBound` / `checkPendingLaunchOutput`, DESKTOP-2E): the guards
 * on a read in flight, the `launchOutputChecks` lifecycle, the ceiling look,
 * the backoff, and a read or classifier that fails.
 *
 * The happy paths live in `session-manager-agent-absence.test.ts`. The mock
 * scaffolding is copied from there: SessionTelemetry is stubbed, ManagedSession
 * rows are seeded into the private registry, and `getLaunchOutput` is spied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => false,
  setShuttingDown: () => {},
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError: vi.fn(),
}));

let capturedCallbacks: {
  isAgentAbsenceCandidate?: (sessionId: string) => boolean;
} | null = null;
const requestAgentAbsenceCheck = vi.fn();

vi.mock('../../src/main/activity-engine/session-telemetry', () => {
  class MockSessionTelemetry {
    constructor(callbacks: typeof capturedCallbacks) {
      capturedCallbacks = callbacks;
    }
    get hasAgentAbsenceSweep(): boolean {
      return true;
    }
    readonly activityEngine = { markPtyChunk: (): void => {}, markPtyOutput: (): void => {} };
    removeSession(): void {}
    dispose(): void {}
    requestAgentAbsenceCheck(sessionId: string): void {
      requestAgentAbsenceCheck(sessionId);
    }
    cancelAgentAbsenceCheck(): void {}
  }
  return { SessionTelemetry: MockSessionTelemetry };
});

import { SessionManager } from '../../src/main/pty/session-manager';
import { resetLaunchReports } from '../../src/main/pty/agent-launch-report';
import { AGENT_START_CEILING_MS } from '../../src/main/pty/lifecycle/agent-output-tracker';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { AgentParser } from '../../src/shared/types';

/** Mirrors AGENT_SPAWN_GRACE_MS in session-manager.ts (module-private). */
const SPAWN_GRACE_MS = 30_000;
const NO_SUCH_FILE_OUTPUT = 'zsh: no such file or directory: /opt/claude\r\n';
const BAD_INTERPRETER_OUTPUT = 'bash: /opt/claude: /usr/bin/node: bad interpreter: No such file or directory\r\n';
const QUIET_OUTPUT = 'PS C:\\Users\\dev> ';

describe('SessionManager start bound', () => {
  let manager: SessionManager;

  beforeEach(() => {
    capturedCallbacks = null;
    requestAgentAbsenceCheck.mockClear();
    resetLaunchReports();
    manager = new SessionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function getRegistry(): { set(id: string, session: ManagedSession): void; get(id: string): ManagedSession | undefined } {
    return (manager as unknown as {
      registry: { set(id: string, session: ManagedSession): void; get(id: string): ManagedSession | undefined };
    }).registry;
  }

  /** Seeded `elapsedMs` past spawn, with output already seen, so it awaits its start inside the bound. */
  function seedSession(overrides: Partial<ManagedSession> = {}, elapsedMs = SPAWN_GRACE_MS + 4_000): ManagedSession {
    const base: ManagedSession = {
      id: 'session-1',
      taskId: 'task-1',
      projectId: 'project-1',
      pty: { pid: 4242, kill: () => {}, sealUserInput: () => {} } as unknown as ManagedSession['pty'],
      status: 'running',
      shell: 'pwsh',
      cwd: '/mock/project-cwd',
      startedAt: new Date(Date.now() - elapsedMs).toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
      agentParser: {} as unknown as ManagedSession['agentParser'],
      reportsAgentStart: true,
      firstOutputAt: Date.now() - elapsedMs + 1_000,
      ...overrides,
    };
    getRegistry().set(base.id, base);
    return base;
  }

  function isCandidate(sessionId = 'session-1'): boolean {
    const callback = capturedCallbacks?.isAgentAbsenceCandidate;
    if (!callback) throw new Error('isAgentAbsenceCandidate was not captured');
    return callback(sessionId);
  }

  function outputSeen(sessionId = 'session-1'): void {
    (manager as unknown as { handleHostEvent(event: { type: 'outputSeen'; sessionId: string; chunks: number }): void })
      .handleHostEvent({ type: 'outputSeen', sessionId, chunks: 1 });
  }

  function armStartBound(sessionId = 'session-1'): void {
    (manager as unknown as { armLaunchStartBound(id: string): void }).armLaunchStartBound(sessionId);
  }

  /** A read the test resolves by hand. */
  function deferredReads(): { answers: Array<(text: string) => void>; read: ReturnType<typeof vi.spyOn> } {
    const answers: Array<(text: string) => void> = [];
    const read = vi.spyOn(manager, 'getLaunchOutput').mockImplementation(
      () => new Promise<string>((resolve) => { answers.push(resolve); }),
    );
    return { answers, read };
  }

  describe('a read in flight that is overtaken', () => {
    it('stamps nothing when the registry row was replaced before the read resolved', async () => {
      vi.useFakeTimers();
      const original = seedSession();
      const { answers } = deferredReads();

      outputSeen();
      const replacement = seedSession();
      answers[0](NO_SUCH_FILE_OUTPUT);
      await vi.advanceTimersByTimeAsync(0);

      expect(original.launchFailureIdentifiedAt).toBeUndefined();
      expect(replacement.launchFailureIdentifiedAt).toBeUndefined();
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('stamps nothing when the agent showed it ran before the read resolved', async () => {
      vi.useFakeTimers();
      const session = seedSession();
      const { answers } = deferredReads();

      outputSeen();
      session.agentStartObservedAt = Date.now();
      answers[0](NO_SUCH_FILE_OUTPUT);
      await vi.advanceTimersByTimeAsync(0);

      expect(session.launchFailureIdentifiedAt).toBeUndefined();
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });
  });

  describe('the launchOutputChecks lifecycle', () => {
    it('reads again for a fresh outputSeen once the cooldown ended with no output during the read', async () => {
      vi.useFakeTimers();
      seedSession();
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue(QUIET_OUTPUT);

      outputSeen();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);

      // Inside the cooldown the entry is still held: no new read.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read).toHaveBeenCalledTimes(1);

      // After the cooldown (2 s inside the first seconds past the grace) nothing was owed.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(read).toHaveBeenCalledTimes(1);

      outputSeen();
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('reads nothing for output seen while the session has evidence, and reads once evidence is cleared', async () => {
      vi.useFakeTimers();
      const session = seedSession({ agentStartObservedAt: Date.now() });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue(QUIET_OUTPUT);

      outputSeen();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).not.toHaveBeenCalled();

      session.agentStartObservedAt = undefined;
      outputSeen();
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe('the ceiling look', () => {
    async function armAndPassGrace(session: ManagedSession): Promise<void> {
      vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue(QUIET_OUTPUT);
      armStartBound(session.id);
      await vi.advanceTimersByTimeAsync(SPAWN_GRACE_MS);
    }

    it('asks the sweep to look for a still-running launch with no evidence (control)', async () => {
      vi.useFakeTimers();
      const session = seedSession({}, 0);
      await armAndPassGrace(session);

      await vi.advanceTimersByTimeAsync(AGENT_START_CEILING_MS - SPAWN_GRACE_MS);

      expect(requestAgentAbsenceCheck).toHaveBeenCalledWith('session-1');
    });

    it('asks nothing for a session that exited before the ceiling', async () => {
      vi.useFakeTimers();
      const session = seedSession({}, 0);
      await armAndPassGrace(session);
      session.status = 'exited';

      await vi.advanceTimersByTimeAsync(AGENT_START_CEILING_MS - SPAWN_GRACE_MS);

      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('asks nothing for a session that lost its pty before the ceiling', async () => {
      vi.useFakeTimers();
      const session = seedSession({}, 0);
      await armAndPassGrace(session);
      session.pty = null;

      await vi.advanceTimersByTimeAsync(AGENT_START_CEILING_MS - SPAWN_GRACE_MS);

      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('asks nothing for a session whose registry row was replaced before the ceiling', async () => {
      vi.useFakeTimers();
      const session = seedSession({}, 0);
      await armAndPassGrace(session);
      seedSession({}, 0);

      await vi.advanceTimersByTimeAsync(AGENT_START_CEILING_MS - SPAWN_GRACE_MS);

      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });
  });

  describe('output classes through the start bound', () => {
    it('marks a launch whose output is a bad interpreter line a candidate at the grace', async () => {
      vi.useFakeTimers();
      seedSession({}, 0);
      vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue(BAD_INTERPRETER_OUTPUT);

      armStartBound();
      await vi.advanceTimersByTimeAsync(SPAWN_GRACE_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(isCandidate()).toBe(true);
      expect(requestAgentAbsenceCheck).toHaveBeenCalledWith('session-1');
    });
  });

  describe('a read or a classifier that fails', () => {
    const throwingParsers: Array<{ label: string; parser: AgentParser; overrides: Partial<ManagedSession> }> = [
      {
        label: 'namesMissingConversation',
        parser: {
          namesMissingConversation: () => { throw new Error('classifier exploded'); },
        } as unknown as AgentParser,
        overrides: { resuming: true, agentSessionId: 'conversation-1' },
      },
      {
        label: 'identifyUserSetupFailure',
        parser: {
          identifyUserSetupFailure: () => { throw new Error('classifier exploded'); },
        } as unknown as AgentParser,
        overrides: {},
      },
    ];

    it.each(throwingParsers)('logs a $label that throws, judges nothing, and reads again after the cooldown', async ({ parser, overrides }) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seedSession({ agentParser: parser, ...overrides });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue(QUIET_OUTPUT);

      outputSeen();
      await vi.advanceTimersByTimeAsync(0);

      expect(read).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[START_BOUND] Launch output check failed'), 'classifier exploded');
      expect(isCandidate()).toBe(false);
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_500);
      outputSeen();
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('logs a read that rejects, judges nothing, and reads again after the cooldown', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seedSession();
      const read = vi.spyOn(manager, 'getLaunchOutput').mockRejectedValue(new Error('host unreachable'));

      outputSeen();
      await vi.advanceTimersByTimeAsync(0);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[START_BOUND] Launch output check failed'), 'host unreachable');
      expect(isCandidate()).toBe(false);
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_500);
      outputSeen();
      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  describe('the backoff', () => {
    it('waits half the time past the grace before a re-read for output that landed during a read', async () => {
      vi.useFakeTimers();
      // 70 s after spawn, 40 s past the grace: the cooldown is (70_000 - 30_000) / 2 = 20 s.
      seedSession({}, 70_000);
      const { answers, read } = deferredReads();

      outputSeen();
      outputSeen();
      expect(read).toHaveBeenCalledTimes(1);

      answers[0](QUIET_OUTPUT);
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(17_000);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });
});
