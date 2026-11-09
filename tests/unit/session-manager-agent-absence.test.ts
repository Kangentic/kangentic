/**
 * Unit tests for SessionManager's agent-absence closures
 * (`isAgentAbsenceCandidate` / `retireAgentlessSession`, wired into
 * SessionTelemetry's constructor callbacks and consumed by the bg-shell
 * watcher's agent-absence sweep).
 *
 * A session's PTY root is the SHELL - Kangentic spawns a shell and writes the
 * agent CLI command to its stdin - so the agent CLI is a DESCENDANT. When it
 * exits on its own (a user `/exit`, a crash, a launch that failed) the shell
 * survives, the PTY never fires onExit, and nothing marks the session finished:
 * the record stays `running`, the status bar counts a phantom agent, and the
 * bottom panel keeps a tab (`derivePanelSessions` filters on
 * `status === 'running'`).
 *
 * The watcher decides only what the PROCESS TREE says. Every session-shaped arm
 * of the decision lives in SessionManager, which is what these tests cover.
 * `tests/unit/bg-shell-watcher.test.ts` covers the tree side against a fake
 * probe; neither suite sees the other's half, so a bug in this resolution
 * would otherwise slip through both.
 *
 * A Command Terminal IS judged (C2): it runs the project's agent CLI under its
 * shell exactly as a task does, and when that agent exits the terminal ends
 * outright (`endCommandTerminal`), so no bare shell is left for a phone to type
 * into. Its own SessionEnd hook asks the sweep to look at once and waives the
 * spawn grace; the process tree still decides.
 *
 * The structure mirrors `session-manager-report-terminated-shells.test.ts`:
 * capture the callbacks object SessionManager hands to `new SessionTelemetry`
 * and drive it directly against a hand-seeded registry entry, so no real PTY,
 * OS probe, or spawn is needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

// A quit in progress, switched per test (reset in beforeEach).
const shutdown = vi.hoisted(() => ({ active: false }));
vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => shutdown.active,
  setShuttingDown: () => { shutdown.active = true; },
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

// Capture the callbacks object SessionManager hands to `new SessionTelemetry(...)`.
// The stub carries only what the paths under test reach: a Command Terminal's
// end goes through remove(), which clears the session's telemetry, and its
// SessionEnd asks for an absence check.
let capturedCallbacks: {
  isAgentAbsenceCandidate?: (sessionId: string) => boolean;
  retireAgentlessSession?: (sessionId: string) => void;
  onEvent?: (sessionId: string, event: { ts: number; type: string; detail?: string }) => void;
  onAgentSessionId?: (sessionId: string, agentReportedId: string, options?: { conversationMoved?: boolean }) => void;
} | null = null;
const requestAgentAbsenceCheck = vi.fn();
const cancelAgentAbsenceCheck = vi.fn();
/** Whether the bg-shell watcher (and so the sweep) runs; see SessionTelemetry.hasAgentAbsenceSweep. */
const sweep = { available: true };

vi.mock('../../src/main/activity-engine/session-telemetry', () => {
  class MockSessionTelemetry {
    constructor(callbacks: typeof capturedCallbacks) {
      capturedCallbacks = callbacks;
    }
    get hasAgentAbsenceSweep(): boolean {
      return sweep.available;
    }
    // The host's `outputSeen` marks the engine; the start bound reads the output after.
    readonly activityEngine = { markPtyChunk: (): void => {}, markPtyOutput: (): void => {} };
    removeSession(): void {}
    // SessionManager.dispose() disposes its telemetry first.
    dispose(): void {}
    requestAgentAbsenceCheck(sessionId: string): void {
      requestAgentAbsenceCheck(sessionId);
    }
    cancelAgentAbsenceCheck(sessionId: string): void {
      cancelAgentAbsenceCheck(sessionId);
    }
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
/**
 * Past the grace, short of the start ceiling: where the sweep judged install
 * A's launches before the start bound (DESKTOP-2E).
 */
const insideStartBound = (): string => new Date(Date.now() - (SPAWN_GRACE_MS + 4_000)).toISOString();
/** Mirrors COMMAND_TERMINAL_AGENT_END_SETTLE_MS in session-manager.ts. */
const END_SETTLE_MS = 5_000;

describe('SessionManager agent-absence wiring', () => {
  let manager: SessionManager;
  let killedPtys: number[];

  beforeEach(() => {
    capturedCallbacks = null;
    killedPtys = [];
    requestAgentAbsenceCheck.mockClear();
    cancelAgentAbsenceCheck.mockClear();
    sweep.available = true;
    shutdown.active = false;
    resetLaunchReports();
    manager = new SessionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function sendAgentEvent(type: string, sessionId = 'session-1'): void {
    const callback = capturedCallbacks?.onEvent;
    if (!callback) throw new Error('onEvent was not captured');
    callback(sessionId, { ts: Date.now(), type });
  }

  /** A fake PTY handle: only `pid`, `kill` and `sealUserInput` are reached by kill(). */
  function fakePty(pid: number): ManagedSession['pty'] {
    return {
      pid,
      kill: () => { killedPtys.push(pid); },
      sealUserInput: () => {},
    } as unknown as ManagedSession['pty'];
  }

  /**
   * Seed a ManagedSession directly into the private registry. spawn() cannot be
   * used: it needs a real PTY, and the fields under test (transient,
   * agentParser, startedAt) are exactly what a fixture must vary.
   *
   * The defaults describe a judgeable task agent: running, non-transient, with
   * an adapter, a live PTY, and past the start ceiling, so the sweep judges it
   * whether or not it ever showed its agent ran. Inside the ceiling a launch with
   * no such sign is judged only once its output names a cause (the start bound).
   */
  function seedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
    const registry = (manager as unknown as {
      registry: { set(id: string, session: ManagedSession): void };
    }).registry;
    const base: ManagedSession = {
      id: 'session-1',
      taskId: 'task-1',
      projectId: 'project-1',
      pty: fakePty(4242),
      status: 'running',
      shell: 'pwsh',
      cwd: '/mock/project-cwd',
      startedAt: new Date(Date.now() - (AGENT_START_CEILING_MS + 5_000)).toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
      // Presence is what matters, not the contents: it means "an agent CLI was
      // supposed to be running under this PTY".
      agentParser: {} as unknown as ManagedSession['agentParser'],
      ...overrides,
    };
    registry.set(base.id, base);
    return base;
  }

  function isCandidate(sessionId = 'session-1'): boolean {
    const callback = capturedCallbacks?.isAgentAbsenceCandidate;
    if (!callback) throw new Error('isAgentAbsenceCandidate was not captured');
    return callback(sessionId);
  }

  function retire(sessionId = 'session-1'): void {
    const callback = capturedCallbacks?.retireAgentlessSession;
    if (!callback) throw new Error('retireAgentlessSession was not captured');
    callback(sessionId);
  }

  describe('a launch that ended before its agent showed it ran', () => {
    const ABANDON_MS = 15_000;

    function ended(session: ManagedSession, exit: { exitCode?: number; signal?: number | null; intentional: boolean }): void {
      (manager as unknown as {
        noteLaunchEnded(row: ManagedSession, ending: { exitCode: number; signal: number | null; intentional: boolean }): void;
      }).noteLaunchEnded(session, { exitCode: exit.exitCode ?? 1, signal: exit.signal ?? null, intentional: exit.intentional });
    }

    function sentTags(): Record<string, string> {
      return reportHandledError.mock.calls[0][1] as Record<string, string>;
    }

    beforeEach(() => {
      reportHandledError.mockClear();
    });

    it('reports a shell that exited on its own, with its code', () => {
      ended(seedSession({ reportsAgentStart: true }), { exitCode: 1, intentional: false });
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(sentTags()).toMatchObject({ stage: 'shell_exit', exit_code: '1', exit_signal: 'none' });
    });

    it('reports the signal of a shell one killed, which reads as code 0 alone', () => {
      ended(seedSession({ reportsAgentStart: true }), { exitCode: 0, signal: 9, intentional: false });
      expect(sentTags()).toMatchObject({ stage: 'shell_exit', exit_code: '0', exit_signal: '9' });
    });

    it('reports a shell that died in its startup files for an adapter that reports no start', () => {
      // Its silence proves nothing, but the shell died before the typed line ran.
      ended(seedSession({ reportsAgentStart: false }), { exitCode: 1, intentional: false });
      expect(sentTags()).toMatchObject({ stage: 'shell_exit' });
    });

    it('stays quiet for such an adapter once the typed line ran', () => {
      ended(seedSession({ reportsAgentStart: false, agentOutputAt: Date.now() }), { intentional: false });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('stays quiet for a shell with no agent', () => {
      ended(seedSession({ agentParser: undefined }), { intentional: false });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'SessionStart', overrides: { agentStartObservedAt: 1 } },
      { label: 'alt screen', overrides: { altScreenEnteredAt: 1 } },
      { label: 'any hook', overrides: { agentHookObservedAt: 1 } },
      { label: 'an agent session id', overrides: { agentIdReportedAt: 1 } },
    ])('stays quiet once the agent showed $label', ({ overrides }) => {
      ended(seedSession({ reportsAgentStart: true, ...overrides }), { intentional: false });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('leaves a host loss to its own report', () => {
      ended(seedSession({ reportsAgentStart: true }), { exitCode: -2, intentional: false });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('leaves out a hidden agent, which was never the task\'s', () => {
      const session = seedSession({ reportsAgentStart: true });
      (manager as unknown as { hiddenUntilAdopted: Set<string> }).hiddenUntilAdopted.add('session-1');
      ended(session, { intentional: false });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('does not count a quick Stop as a failure', () => {
      const session = seedSession({
        reportsAgentStart: true,
        startedAt: new Date(Date.now() - (ABANDON_MS - 1_000)).toISOString(),
      });
      ended(session, { intentional: true });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports a kill past the threshold as a person giving up', () => {
      const session = seedSession({
        reportsAgentStart: true,
        startedAt: new Date(Date.now() - (ABANDON_MS + 1_000)).toISOString(),
      });
      ended(session, { intentional: true });
      expect(sentTags()).toMatchObject({ stage: 'abandoned', ended_by: 'kill' });
    });

    it('reports a pause past the threshold as a person giving up', () => {
      const session = seedSession({
        reportsAgentStart: true,
        status: 'suspended',
        startedAt: new Date(Date.now() - (ABANDON_MS + 1_000)).toISOString(),
      });
      ended(session, { intentional: true });
      expect(sentTags()).toMatchObject({ stage: 'abandoned', ended_by: 'pause' });
    });

    it('does not read a stop of an adapter that reports no start as anything', () => {
      ended(seedSession({ reportsAgentStart: false }), { intentional: true });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('reports the pause the sweep asked for only the once', () => {
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      const session = seedSession({ reportsAgentStart: true });
      retire();
      ended(session, { intentional: true });
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(sentTags()).toMatchObject({ stage: 'never_started' });
    });

    it('lists what a quit is about to end, for the next launch to report', () => {
      seedSession({ reportsAgentStart: true, id: 'gave-up', agentName: 'claude' });
      seedSession({ reportsAgentStart: true, id: 'quick', startedAt: new Date(Date.now() - 1_000).toISOString() });
      seedSession({ reportsAgentStart: true, id: 'ran', agentStartObservedAt: 1 });
      seedSession({ reportsAgentStart: false, id: 'silent' });
      const launches = manager.abandonedLaunchTags();
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ agent: 'claude', ended_by: 'quit', output_class: 'not_read' });
    });
  });

  describe('launch-failure wiring that real events and a quit reach', () => {
    beforeEach(() => {
      reportHandledError.mockClear();
    });

    function hide(sessionId = 'session-1'): void {
      (manager as unknown as { hiddenUntilAdopted: Set<string> }).hiddenUntilAdopted.add(sessionId);
    }

    it('stamps the id the agent reported and says the agent ran, so a silent hook does not earn a retry', async () => {
      const session = seedSession({ reportsAgentStart: true, startPath: 'board' });
      const agentRan = vi.fn();
      manager.on('agent-ran', agentRan);
      expect(await manager.mayRetryLaunch('session-1')).toBe(true);

      capturedCallbacks?.onAgentSessionId?.('session-1', 'agent-uuid');

      expect(typeof session.agentIdReportedAt).toBe('number');
      expect(agentRan).toHaveBeenCalledTimes(1);
      expect(manager.agentStartPending('session-1')).toBe(false);
      expect(await manager.mayRetryLaunch('session-1')).toBe(false);
    });

    it('spends no retry on a line the shell refused as too long: the same line gets the same answer', async () => {
      const session = seedSession({ reportsAgentStart: true, startPath: 'board' });
      session.launchOutputRead = Promise.resolve('line_too_long');

      expect(await manager.mayRetryLaunch('session-1')).toBe(false);
    });

    it('keeps the retry for a conversation the CLI could not find, which starts fresh once marked', async () => {
      const session = seedSession({ reportsAgentStart: true, startPath: 'resume' });
      session.launchOutputRead = Promise.resolve('conversation_missing');

      expect(await manager.mayRetryLaunch('session-1')).toBe(true);
    });

    it('stamps the first alt-screen entry and says the agent ran once', () => {
      const session = seedSession({ reportsAgentStart: true });
      const agentRan = vi.fn();
      manager.on('agent-ran', agentRan);
      const hostEvent = (inAltScreen: boolean): void => {
        (manager as unknown as { handleHostEvent(event: unknown): void })
          .handleHostEvent({ type: 'altScreen', sessionId: 'session-1', inAltScreen });
      };

      hostEvent(false);
      expect(session.altScreenEnteredAt).toBeUndefined();
      expect(agentRan).not.toHaveBeenCalled();

      hostEvent(true);
      expect(typeof session.altScreenEnteredAt).toBe('number');
      expect(agentRan).toHaveBeenCalledTimes(1);

      hostEvent(true);
      expect(agentRan).toHaveBeenCalledTimes(1);
    });

    it('reports an agent that exited at start once, however often it is told', () => {
      seedSession({ reportsAgentStart: true });
      manager.noteAgentExitedAtStart('session-1');
      manager.noteAgentExitedAtStart('session-1');
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect((reportHandledError.mock.calls[0][0] as Error).name).toBe('AgentLaunchAgentExitedError');
    });

    it('does not double a launch already reported', () => {
      seedSession({ reportsAgentStart: true });
      retire();
      manager.noteAgentExitedAtStart('session-1');
      expect(reportHandledError).toHaveBeenCalledTimes(1);
    });

    it('reports nothing for a launch ending during a quit', () => {
      shutdown.active = true;
      const session = seedSession({ reportsAgentStart: true });
      (manager as unknown as {
        noteLaunchEnded(row: ManagedSession, ending: { exitCode: number; signal: number | null; intentional: boolean }): void;
      }).noteLaunchEnded(session, { exitCode: 1, signal: null, intentional: false });
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('lets no retry spawn once a quit has begun', async () => {
      seedSession({ reportsAgentStart: true, startPath: 'board' });
      shutdown.active = true;
      expect(await manager.mayRetryLaunch('session-1')).toBe(false);
    });

    it('leaves out of the quit list a suspended session, one already reported, and a hidden one', () => {
      const longAgo = new Date(Date.now() - 60_000).toISOString();
      seedSession({ id: 'kept', reportsAgentStart: true, startedAt: longAgo });
      seedSession({ id: 'suspended', reportsAgentStart: true, startedAt: longAgo, status: 'suspended' });
      seedSession({ id: 'noted', reportsAgentStart: true, startedAt: longAgo, launchFailureNoted: true });
      seedSession({ id: 'hidden', reportsAgentStart: true, startedAt: longAgo });
      hide('hidden');
      const launches = manager.abandonedLaunchTags();
      expect(launches).toHaveLength(1);
    });
  });

  describe('whether a failed launch may retry', () => {
    it('says yes with no sign the agent ran', async () => {
      seedSession({ reportsAgentStart: true, startPath: 'board' });
      expect(await manager.mayRetryLaunch('session-1')).toBe(true);
    });

    it.each([
      { outputClass: 'login_required' as const },
      { outputClass: 'bad_configuration' as const },
    ])('says no for $outputClass, which a second launch cannot fix', async ({ outputClass }) => {
      seedSession({ reportsAgentStart: true, startPath: 'board', launchOutputRead: Promise.resolve(outputClass) });
      expect(await manager.mayRetryLaunch('session-1')).toBe(false);
    });

    it.each([
      { outputClass: 'other' as const },
      { outputClass: 'command_not_found' as const },
      { outputClass: 'unknown_option' as const },
      { outputClass: 'not_read' as const },
      { outputClass: 'unreadable' as const },
    ])('says yes for $outputClass, which may be ours', async ({ outputClass }) => {
      seedSession({ reportsAgentStart: true, startPath: 'board', launchOutputRead: Promise.resolve(outputClass) });
      expect(await manager.mayRetryLaunch('session-1')).toBe(true);
    });

    it('waits for the output read before it answers', async () => {
      let finishRead!: (outputClass: 'login_required') => void;
      const launchOutputRead = new Promise<'login_required'>((resolve) => { finishRead = resolve; });
      seedSession({ reportsAgentStart: true, startPath: 'board', launchOutputRead });
      const answer = manager.mayRetryLaunch('session-1');
      finishRead('login_required');
      expect(await answer).toBe(false);
    });

    it.each([
      { label: 'a retry, which is never retried', overrides: { startPath: 'retry' as const } },
      { label: 'a late start hook', overrides: { agentStartObservedAt: 1 } },
      { label: 'any other hook', overrides: { agentHookObservedAt: 1 } },
      { label: 'a first frame', overrides: { altScreenEnteredAt: 1 } },
      { label: 'a session id the agent gave', overrides: { agentIdReportedAt: 1 } },
      { label: 'an adapter whose silence proves nothing', overrides: { reportsAgentStart: false } },
    ])('says no for $label', async ({ overrides }) => {
      seedSession({ reportsAgentStart: true, startPath: 'board', ...overrides });
      expect(await manager.mayRetryLaunch('session-1')).toBe(false);
    });

    it('says no for a session that is gone', async () => {
      expect(await manager.mayRetryLaunch('session-1')).toBe(false);
    });
  });

  describe('whether a launch still owes a sign its agent ran', () => {
    it('is pending for an adapter that reports its start, until the agent shows it', () => {
      seedSession({ reportsAgentStart: true });
      const agentRan = vi.fn();
      manager.on('agent-ran', agentRan);
      expect(manager.agentStartPending('session-1')).toBe(true);

      sendAgentEvent('prompt');

      expect(agentRan).toHaveBeenCalledTimes(1);
      expect(agentRan).toHaveBeenCalledWith('session-1');
      expect(manager.agentStartPending('session-1')).toBe(false);
    });

    it('says so once, however many hooks land', () => {
      seedSession({ reportsAgentStart: true });
      const agentRan = vi.fn();
      manager.on('agent-ran', agentRan);

      sendAgentEvent('prompt');
      sendAgentEvent('tool_start');

      expect(agentRan).toHaveBeenCalledTimes(1);
    });

    it('is never pending for an adapter whose silence proves nothing, or a session that is gone', () => {
      seedSession({ reportsAgentStart: false });
      expect(manager.agentStartPending('session-1')).toBe(false);
      expect(manager.agentStartPending('no-such-session')).toBe(false);
    });

    it('answers what the report found, for the notice', async () => {
      seedSession({ reportsAgentStart: true, launchOutputRead: Promise.resolve('login_required') });
      expect(await manager.launchOutputClass('session-1')).toBe('login_required');
      expect(await manager.launchOutputClass('no-such-session')).toBeUndefined();
    });
  });

  describe('a retry that worked', () => {
    beforeEach(() => {
      reportHandledError.mockClear();
    });

    it('reports the recovery on its first sign, once', () => {
      seedSession({ reportsAgentStart: true, startPath: 'retry' });
      sendAgentEvent('session_start');
      sendAgentEvent('prompt');
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect((reportHandledError.mock.calls[0][0] as Error).name).toBe('AgentLaunchRecoveredError');
    });

    it('stays quiet for a launch that was no retry', () => {
      seedSession({ reportsAgentStart: true, startPath: 'board' });
      sendAgentEvent('session_start');
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('takes no synthesized SessionEnd for a sign the agent ran', () => {
      const session = seedSession({ reportsAgentStart: true, startPath: 'retry' });
      sendAgentEvent('session_end');
      expect(session.agentHookObservedAt).toBeUndefined();
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('a shell the sweep cannot judge', () => {
    function armCheck(sessionId = 'session-1'): void {
      (manager as unknown as { armUnjudgedLaunchCheck(id: string): void }).armUnjudgedLaunchCheck(sessionId);
    }

    beforeEach(() => {
      reportHandledError.mockClear();
      vi.useFakeTimers();
    });

    it('reports a launch that showed nothing by the ceiling, and pauses nothing', () => {
      sweep.available = false;
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      seedSession({ reportsAgentStart: true });
      armCheck();
      vi.advanceTimersByTime(AGENT_START_CEILING_MS);
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ stage: 'never_started', judge: 'timer' });
      expect(neverStarted).not.toHaveBeenCalled();
    });

    it('reports a WSL shell, which the sweep never judges', () => {
      seedSession({ reportsAgentStart: true, shell: 'wsl -d Ubuntu' });
      armCheck();
      vi.advanceTimersByTime(AGENT_START_CEILING_MS);
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ judge: 'timer', shell: 'other' });
    });

    it('stays quiet once the agent showed it ran', () => {
      sweep.available = false;
      const session = seedSession({ reportsAgentStart: true });
      armCheck();
      session.agentStartObservedAt = Date.now();
      vi.advanceTimersByTime(AGENT_START_CEILING_MS);
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'killed', undo: (session: ManagedSession) => { session.status = 'exited'; session.pty = null; } },
      { label: 'suspended', undo: (session: ManagedSession) => { session.status = 'suspended'; } },
      { label: 'removed', undo: () => { (manager as unknown as { registry: { delete(id: string): boolean } }).registry.delete('session-1'); } },
      { label: 'hidden until adopted', undo: () => { (manager as unknown as { hiddenUntilAdopted: Set<string> }).hiddenUntilAdopted.add('session-1'); } },
    ])('reports nothing for a session $label before the ceiling', ({ undo }) => {
      sweep.available = false;
      const session = seedSession({ reportsAgentStart: true });
      armCheck();
      undo(session);
      vi.advanceTimersByTime(AGENT_START_CEILING_MS);
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('arms nothing where the sweep can judge', () => {
      seedSession({ reportsAgentStart: true });
      armCheck();
      vi.advanceTimersByTime(AGENT_START_CEILING_MS);
      expect(reportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('a launch that never started', () => {
    beforeEach(() => {
      reportHandledError.mockClear();
    });

    it('reports a shell\'s own failure for an adapter that reports no start, and retires as usual', async () => {
      const session = seedSession({ firstOutputAt: Date.now() });
      vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('$ aider\r\nzsh: command not found: aider\r\n$ ');
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      retire();
      await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
      expect(reportHandledError.mock.calls[0][1]).toMatchObject({ stage: 'never_started', output_class: 'command_not_found' });
      expect(neverStarted).not.toHaveBeenCalled();
      expect(session.status).toBe('exited');
    });

    it('reports a task session retired with no sign its agent started, once', () => {
      seedSession({ reportsAgentStart: true });
      retire();
      retire();
      expect(reportHandledError).toHaveBeenCalledTimes(1);
    });

    it('reports a Command Terminal retired at the ceiling', () => {
      seedSession({
        transient: true,
        reportsAgentStart: true,
        startedAt: new Date(Date.now() - (AGENT_START_CEILING_MS + 1)).toISOString(),
      });
      retire();
      expect(reportHandledError).toHaveBeenCalledTimes(1);
    });

    it('does not report a task session whose agent sent SessionStart and left', () => {
      // A task session's evidence had no stamp before this report: a plain
      // `/exit` would read as a launch that never started.
      seedSession({ reportsAgentStart: true });
      sendAgentEvent('session_start');
      retire();
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('does not report an adapter that reports no start', () => {
      seedSession();
      retire();
      expect(reportHandledError).not.toHaveBeenCalled();
    });

    it('hands a task to its pause instead of retiring it, so its Resume stands', () => {
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      const session = seedSession({ reportsAgentStart: true });

      retire();

      expect(neverStarted).toHaveBeenCalledTimes(1);
      expect(neverStarted.mock.calls[0][0]).toBe('session-1');
      expect(session.status).toBe('running');
      expect(session.overrideExitCode).toBeUndefined();
      expect(killedPtys).toEqual([]);
    });

    it('retires the row when the listener calls it again after a pause that did not land, reporting once', () => {
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      const session = seedSession({ reportsAgentStart: true });

      retire();
      retire();

      expect(neverStarted).toHaveBeenCalledTimes(1);
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(session.status).toBe('exited');
      expect(killedPtys).toEqual([4242]);
    });

    it('retires a session hidden until adopted instead of announcing it to a pause nobody may learn of', () => {
      // `emit` returns false for a hidden session, so the listener never hears
      // of it and the retire must fall through to the kill, or it stays a
      // running phantom.
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      const session = seedSession({ reportsAgentStart: true });
      (manager as unknown as { hiddenUntilAdopted: Set<string> }).hiddenUntilAdopted.add('session-1');

      retire();

      expect(neverStarted).not.toHaveBeenCalled();
      expect(session.status).toBe('exited');
      expect(killedPtys).toEqual([4242]);
    });

    it('ends a Command Terminal as before, with no pause', () => {
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      seedSession({
        transient: true,
        reportsAgentStart: true,
        startedAt: new Date(Date.now() - (AGENT_START_CEILING_MS + 1)).toISOString(),
      });

      retire();

      expect(neverStarted).not.toHaveBeenCalled();
      expect(killedPtys).toEqual([4242]);
    });

    it('keeps the exited row a workflow\'s agent restarts from', () => {
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      const session = seedSession({ transient: true, workflowId: 'workflow-1', taskId: 'workflow-1', reportsAgentStart: true });

      retire();

      expect(neverStarted).not.toHaveBeenCalled();
      expect(session.status).toBe('exited');
    });
  });

  describe('a board launch\'s start bound (DESKTOP-2E)', () => {
    const namesMiss = {
      namesMissingConversation: (output: string, id: string) => output.includes(`No conversation found with session ID: ${id}`),
    } as unknown as AgentParser;

    function outputSeen(sessionId = 'session-1'): void {
      (manager as unknown as { handleHostEvent(event: { type: 'outputSeen'; sessionId: string; chunks: number }): void })
        .handleHostEvent({ type: 'outputSeen', sessionId, chunks: 1 });
    }

    function armStartBound(sessionId = 'session-1'): void {
      (manager as unknown as { armLaunchStartBound(id: string): void }).armLaunchStartBound(sessionId);
    }

    beforeEach(() => {
      reportHandledError.mockClear();
    });

    it('does not judge a task whose shell is still starting its agent, past the grace and short of the ceiling', () => {
      // Install A: a Windows PowerShell whose profile ran past 30 s. The line
      // ran once the shell got to it (measured late, never lost), but the sweep
      // had already paused the task and spent its retry.
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      const session = seedSession({ reportsAgentStart: true, startedAt: insideStartBound(), firstOutputAt: Date.now() - (SPAWN_GRACE_MS + 3_000) });

      expect(isCandidate()).toBe(false);
      retire();

      expect(neverStarted).not.toHaveBeenCalled();
      expect(reportHandledError).not.toHaveBeenCalled();
      expect(session.status).toBe('running');
      expect(killedPtys).toEqual([]);
    });

    it('judges the same launch once the start ceiling has passed, as before', () => {
      const neverStarted = vi.fn();
      manager.on('agent-never-started', neverStarted);
      seedSession({ reportsAgentStart: true, startedAt: new Date(Date.now() - (AGENT_START_CEILING_MS + 1)).toISOString() });

      expect(isCandidate()).toBe(true);
      retire();

      expect(neverStarted).toHaveBeenCalledTimes(1);
      expect(reportHandledError).toHaveBeenCalledTimes(1);
    });

    it.each([
      { outputClass: 'no_such_file', output: '$ claude\r\nzsh: no such file or directory: /opt/claude\r\n$ ', overrides: {} },
      { outputClass: 'line_too_long', output: 'C:\\project>cls & claude\r\nThe input line is too long.\r\n', overrides: {} },
      {
        outputClass: 'conversation_missing',
        output: 'No conversation found with session ID: conversation-1\r\nPS C:\\project> ',
        overrides: { agentParser: namesMiss, resuming: true, agentSessionId: 'conversation-1' },
      },
    ])('judges a launch whose output names $outputClass at the grace, and asks the sweep to look now', async ({ output, overrides }) => {
      const session = seedSession({ reportsAgentStart: true, startedAt: insideStartBound(), firstOutputAt: Date.now() - (SPAWN_GRACE_MS + 3_000), ...overrides });
      vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue(output);

      outputSeen();

      await vi.waitFor(() => expect(isCandidate()).toBe(true));
      expect(requestAgentAbsenceCheck).toHaveBeenCalledWith('session-1');
      // A look, not a report: the sweep reports once, when it judges.
      expect(reportHandledError).not.toHaveBeenCalled();
      expect(session.launchFailureNoted).toBeUndefined();
    });

    it('keeps waiting on output that names no cause', async () => {
      seedSession({ reportsAgentStart: true, startedAt: insideStartBound(), firstOutputAt: Date.now() - (SPAWN_GRACE_MS + 3_000) });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('Loading personal and system profiles took 31204ms.\r\nPS C:\\project> ');

      outputSeen();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(isCandidate()).toBe(false);
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('reads one output at a time, and reads again for output that landed during a read', async () => {
      vi.useFakeTimers();
      seedSession({ reportsAgentStart: true, startedAt: insideStartBound(), firstOutputAt: Date.now() - (SPAWN_GRACE_MS + 3_000) });
      const answers: Array<(text: string) => void> = [];
      const read = vi.spyOn(manager, 'getLaunchOutput').mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));

      outputSeen();
      outputSeen();
      outputSeen();
      expect(read).toHaveBeenCalledTimes(1);

      answers[0]('PS C:\\project> ');
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('reads nothing inside the grace, where the agent has not had its chance', () => {
      seedSession({ reportsAgentStart: true, startedAt: new Date(Date.now() - 2_000).toISOString(), firstOutputAt: Date.now() - 1_900 });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('zsh: no such file or directory: /opt/claude\r\n');

      outputSeen();

      expect(read).not.toHaveBeenCalled();
    });

    it('reads nothing for a launch whose agent already showed it ran', () => {
      seedSession({ reportsAgentStart: true, startedAt: insideStartBound(), firstOutputAt: Date.now() - (SPAWN_GRACE_MS + 3_000), agentStartObservedAt: Date.now() - 30_000 });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('zsh: no such file or directory: /opt/claude\r\n');

      outputSeen();

      expect(read).not.toHaveBeenCalled();
    });

    it('reads the output at the grace, and asks the sweep to look at the ceiling, for a launch that shows nothing', async () => {
      vi.useFakeTimers();
      seedSession({ reportsAgentStart: true, startedAt: new Date().toISOString(), firstOutputAt: Date.now() });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('PS C:\\project> ');

      armStartBound();
      await vi.advanceTimersByTimeAsync(SPAWN_GRACE_MS - 1);
      expect(read).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(AGENT_START_CEILING_MS - SPAWN_GRACE_MS);
      expect(requestAgentAbsenceCheck).toHaveBeenCalledWith('session-1');
      expect(isCandidate()).toBe(true);
    });

    it('still reads at the grace when its timer fires before the clock reaches it', async () => {
      // Node starts a timer from the loop's cached time, so it can fire with
      // Date.now() a few ms short of its target. This read is the only one
      // that sees failure output printed early and never followed by more.
      vi.useFakeTimers();
      seedSession({ reportsAgentStart: true, startedAt: new Date().toISOString(), firstOutputAt: Date.now() });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('zsh: no such file or directory: /opt/claude\r\n');

      armStartBound();
      // Set the clock back without firing anything, so the timer fires 5 ms early.
      vi.setSystemTime(Date.now() - 5);
      await vi.advanceTimersByTimeAsync(SPAWN_GRACE_MS);
      await vi.advanceTimersByTimeAsync(5);

      expect(read).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(isCandidate()).toBe(true));
    });

    it('asks nothing at the ceiling for a launch whose agent ran', async () => {
      vi.useFakeTimers();
      const session = seedSession({ reportsAgentStart: true, startedAt: new Date().toISOString(), firstOutputAt: Date.now() });
      vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('PS C:\\project> ');

      armStartBound();
      await vi.advanceTimersByTimeAsync(10_000);
      session.agentStartObservedAt = Date.now();
      await vi.advanceTimersByTimeAsync(AGENT_START_CEILING_MS);

      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('arms nothing where the sweep cannot judge, which the unjudged-launch timer covers', async () => {
      vi.useFakeTimers();
      seedSession({ reportsAgentStart: true, shell: 'wsl -d Ubuntu', startedAt: new Date().toISOString(), firstOutputAt: Date.now() });
      const read = vi.spyOn(manager, 'getLaunchOutput').mockResolvedValue('zsh: no such file or directory: /opt/claude\r\n');

      armStartBound();
      await vi.advanceTimersByTimeAsync(AGENT_START_CEILING_MS);

      expect(read).not.toHaveBeenCalled();
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });
  });

  describe('isAgentAbsenceCandidate', () => {
    it('accepts a running, non-transient task agent past its spawn grace once its agent ran', () => {
      seedSession({ startedAt: insideStartBound(), agentStartObservedAt: Date.now() - 20_000 });
      expect(isCandidate()).toBe(true);
    });

    it('accepts a task agent with no sign it ran once the start ceiling has passed', () => {
      seedSession();
      expect(isCandidate()).toBe(true);
    });

    it('judges a workflow\'s own agent like a task\'s: past its grace once a hook shows it ran', () => {
      // Transient too, but no Command Terminal. The start bound covers every
      // launch, so a hook is what lets it be judged short of the ceiling.
      seedSession({ transient: true, workflowId: 'workflow-1', taskId: 'workflow-1', startedAt: insideStartBound(), agentHookObservedAt: Date.now() });
      expect(isCandidate()).toBe(true);
    });

    it('ACCEPTS a transient Command Terminal past its spawn grace once its agent started: C2 ends it when that agent exits', () => {
      // A Command Terminal types the project's agent CLI into its shell, the
      // same shape as a task session, so an empty tree means its agent is gone
      // and only a bare shell is left.
      seedSession({ transient: true, startedAt: insideStartBound(), agentStartObservedAt: Date.now() - 20_000 });
      expect(isCandidate()).toBe(true);
    });

    it('still refuses a Command Terminal inside its spawn grace while its agent has said nothing', () => {
      seedSession({ transient: true, startedAt: new Date(Date.now() - 1_000).toISOString() });
      expect(isCandidate()).toBe(false);
    });

    it('refuses a Command Terminal past its grace with no evidence its agent started', () => {
      // A shell slower than the grace to reach the agent command shows the
      // same empty tree as an agent that exited. A task would keep a resumable
      // row; a terminal would be ended outright, losing nothing yet but the
      // agent the user is waiting for.
      seedSession({ transient: true, startedAt: insideStartBound() });
      expect(isCandidate()).toBe(false);
    });

    it('takes the agent\'s first alt-screen entry as evidence it started, which no shell emits', () => {
      seedSession({ transient: true, startedAt: insideStartBound(), altScreenEnteredAt: Date.now() - 20_000 });
      expect(isCandidate()).toBe(true);
    });

    it('judges a Command Terminal with no evidence once the start ceiling has passed', () => {
      // A launch that failed (the CLI missing) and a PTY-only adapter both
      // report nothing; without the ceiling either would stay a bare shell.
      seedSession({ transient: true, startedAt: new Date(Date.now() - (AGENT_START_CEILING_MS + 1)).toISOString() });
      expect(isCandidate()).toBe(true);
    });

    it.each([
      { label: 'a Command Terminal', overrides: { transient: true } },
      { label: 'a task', overrides: {} },
    ])('still refuses $label with no evidence just short of the start ceiling', ({ overrides }) => {
      // The lower side of the ceiling. The 1 s margin keeps real timers from
      // flaking the check.
      seedSession({ ...overrides, startedAt: new Date(Date.now() - (AGENT_START_CEILING_MS - 1_000)).toISOString() });
      expect(isCandidate()).toBe(false);
    });

    it('keeps the start evidence a floor above the grace, never in place of it', () => {
      // The evidence gate only adds a condition: a terminal whose agent
      // started inside the grace is judged no earlier than before.
      seedSession({ transient: true, startedAt: new Date(Date.now() - 1_000).toISOString(), agentStartObservedAt: Date.now() });
      expect(isCandidate()).toBe(false);
    });

    it('waives the spawn grace for a Command Terminal whose agent reported its own end', () => {
      // A `/exit` inside the first 30 s: the agent demonstrably ran, so the
      // grace (for an agent that has not started yet) no longer applies.
      seedSession({ transient: true, startedAt: new Date(Date.now() - 1_000).toISOString(), agentEndSignaledAt: Date.now() });
      expect(isCandidate()).toBe(true);
    });

    it('never waives the grace for a task session, whatever its stamp says', () => {
      seedSession({ startedAt: new Date(Date.now() - 1_000).toISOString(), agentEndSignaledAt: Date.now() });
      expect(isCandidate()).toBe(false);
    });

    it('refuses a session with no agent adapter (run_script, bare shell)', () => {
      // Nothing was ever meant to run an agent CLI under this PTY, so an empty
      // process tree is the expected steady state, not a fault.
      seedSession({ agentParser: undefined });
      expect(isCandidate()).toBe(false);
    });

    it('REFUSES a WSL session, whose agent is never a Win32 descendant of the PTY root', () => {
      // The sweep's whole premise is "the agent is a descendant of pty.pid".
      // Under WSL the root is `wsl.exe` and the agent is not a Win32 child of
      // it - a distro-native CLI lives in another PID namespace, and the
      // interop path Kangentic uses launches the Windows binary through WSL's
      // binfmt host. The Windows probe reads `Win32_Process`, so a HEALTHY WSL
      // agent shows an empty descendant set and every other guard passes.
      // Without this arm the sweep force-kills live WSL sessions.
      for (const shell of ['wsl -d Ubuntu', 'wsl.exe -d Ubuntu', 'WSL -d Debian', 'wsl', 'wsl.exe'] as const) {
        seedSession({ shell });
        expect(isCandidate()).toBe(false);
      }
      // Guard the guard: the exclusion must be scoped to the WSL spec form and
      // must not swallow an ordinary shell that merely starts with the letters.
      seedSession({ shell: 'pwsh' });
      expect(isCandidate()).toBe(true);
    });

    it('refuses a session that is not running', () => {
      for (const status of ['queued', 'suspended', 'exited'] as const) {
        seedSession({ status });
        expect(isCandidate()).toBe(false);
      }
    });

    it('refuses a session with no live PTY', () => {
      // No live tree to judge, and a session whose PTY already exited is not a
      // phantom - it is just exited.
      seedSession({ pty: null });
      expect(isCandidate()).toBe(false);
    });

    it('refuses a session still inside its spawn grace', () => {
      // The shell starts FIRST and the CLI command is written to its stdin
      // ~100ms later, so "no agent yet" is genuinely expected here.
      seedSession({ startedAt: new Date(Date.now() - 1_000).toISOString() });
      expect(isCandidate()).toBe(false);
    });

    it('accepts once the grace has elapsed, for an agent that showed it ran', () => {
      seedSession({
        startedAt: new Date(Date.now() - (SPAWN_GRACE_MS + 1)).toISOString(),
        agentIdReportedAt: Date.now(),
      });
      expect(isCandidate()).toBe(true);
    });

    it('refuses a session with an unparseable startedAt rather than assuming it is old', () => {
      seedSession({ startedAt: 'not-a-timestamp' });
      expect(isCandidate()).toBe(false);
    });

    it('refuses an unknown session id without throwing', () => {
      expect(isCandidate('does-not-exist')).toBe(false);
    });
  });

  describe('retireAgentlessSession', () => {
    it('forces exit code 0, tags the exit intentional, and kills the leftover shell', () => {
      const session = seedSession();

      retire();

      // 0, not the OS code: a force-kill reports abnormally on every platform,
      // and SessionRepository.getInterruptedExited resumes exactly those on the
      // next launch - which would resurrect the conversation the user ended.
      expect(session.overrideExitCode).toBe(0);
      // Suppresses the renderer's false "Session crashed" toast: the agent's own
      // exit was the event, Kangentic is only noticing it late.
      expect(session.intentionalExit).toBe(true);
      expect(killedPtys).toEqual([4242]);
      expect(session.pty).toBeNull();
    });

    it('re-checks the guard, so a session suspended during the async gap is untouched', () => {
      // The watcher decides asynchronously; by the time this runs the session
      // may already have been suspended or killed.
      const session = seedSession({ status: 'suspended' });

      retire();

      expect(session.overrideExitCode).toBeUndefined();
      expect(session.intentionalExit).toBeUndefined();
      expect(killedPtys).toEqual([]);
      expect(session.pty).not.toBeNull();
    });

    it('ENDS a transient Command Terminal: kills its shell and removes the row, with no exited stamp or exit-code override', () => {
      const session = seedSession({ transient: true, agentStartObservedAt: Date.now() - 20_000 });
      const removed: string[] = [];
      const changed: string[] = [];
      manager.on('session-removed', (id: string) => { removed.push(id); });
      manager.on('session-changed', (id: string) => { changed.push(id); });

      retire();

      expect(killedPtys).toEqual([4242]);
      expect(session.intentionalExit).toBe(true);
      expect(session.overrideExitCode).toBeUndefined();
      // The removal is the only announcement: no exited status was stamped
      // and pushed before it.
      expect(session.status).toBe('running');
      expect(changed).toEqual([]);
      expect(removed).toEqual(['session-1']);
      expect(manager.getSession('session-1')).toBeUndefined();
    });

    it('retires a workflow\'s own agent like a task\'s: its exited row stays, for the Workflows pane to read', () => {
      // The pane notices a resume that failed from this exited row and starts
      // the agent over; ending it as a Command Terminal would remove the row.
      const session = seedSession({ transient: true, workflowId: 'workflow-1', taskId: 'workflow-1' });
      const removed: string[] = [];
      manager.on('session-removed', (id: string) => { removed.push(id); });

      retire();

      expect(killedPtys).toEqual([4242]);
      expect(session.overrideExitCode).toBe(0);
      expect(removed).toEqual([]);
      expect(manager.getSession('session-1')).toBeDefined();
    });

    it('is a no-op for an unknown session id', () => {
      expect(() => retire('does-not-exist')).not.toThrow();
      expect(killedPtys).toEqual([]);
    });

    /**
     * Regression guard for a gap a live preview caught and the rest of this
     * suite could not: main and the DB were both correct (`exited`, code 0)
     * while the BOARD kept counting the agent and the bottom panel kept its
     * tab - the two symptoms the sweep exists to remove.
     *
     * Cause: the renderer's SESSION_EXIT handler returns early on an
     * INTENTIONAL exit (App.tsx), because it cannot distinguish a suspend from
     * a hard end without racing the suspended status push, so it never runs its
     * own `updateSessionStatus`. Both `derivePanelSessions` and the agent count
     * read the renderer store, so they stayed on the stale `running`.
     *
     * `session-changed` is the authoritative channel (broadcast as
     * SESSION_STATUS) and carries a resolved status, so it has no such
     * ambiguity. Emitting it is what actually clears the phantom.
     */
    it('emits session-changed carrying the resolved exited status, so the board stops counting it', () => {
      const session = seedSession();
      const changed: Array<{ id: string; status: string; exitCode: number | null }> = [];
      manager.on('session-changed', (id: string, payload: { status: string; exitCode: number | null }) => {
        changed.push({ id, status: payload.status, exitCode: payload.exitCode });
      });

      retire();

      expect(changed).toEqual([
        { id: 'session-1', status: 'exited', exitCode: 0 },
      ]);
      expect(session.status).toBe('exited');
    });

    it('does not announce a status change for a session it refused to retire', () => {
      seedSession({ status: 'suspended' });
      const changed: string[] = [];
      manager.on('session-changed', (id: string) => { changed.push(id); });

      retire();

      expect(changed).toEqual([]);
    });

    it('announces a Command Terminal\'s end as a removal, never as an exited status', () => {
      // The renderer closes the terminal's window, and a phone gets
      // session-ended, on the removal; an exited row would leave both behind.
      seedSession({ transient: true, agentStartObservedAt: Date.now() - 20_000 });
      const order: string[] = [];
      manager.on('agent-absent', (id: string) => { order.push(`agent-absent:${id}`); });
      manager.on('session-changed', (id: string) => { order.push(`session-changed:${id}`); });
      manager.on('session-removed', (id: string) => { order.push(`session-removed:${id}`); });

      retire();

      expect(order).toEqual(['agent-absent:session-1', 'session-removed:session-1']);
    });

    /**
     * The kill below tags the exit intentional, and the exit listener rightly
     * reads an intentional exit as carrying no failure. So an agent that ended
     * at boot with its own account of why (Claude's "No conversation found
     * with session ID" on a `--resume` whose transcript is gone) reached the
     * user as a card that went quiet. The retirement announces the absence
     * FIRST, while the session is still `running` and its ring still holds
     * the CLI's last words, so the IPC layer can ask the adapter to read them.
     */
    it('emits agent-absent before the kill, so the CLI\'s last words can be read', () => {
      seedSession();
      const order: string[] = [];
      manager.on('agent-absent', (id: string, payload: { id: string; status: string }) => {
        order.push(`agent-absent:${id}:${payload.status}`);
      });
      manager.on('session-changed', (id: string) => { order.push(`session-changed:${id}`); });

      retire();

      expect(order).toEqual(['agent-absent:session-1:running', 'session-changed:session-1']);
    });

    it('does not announce an absence for a session it refused to retire', () => {
      seedSession({ status: 'suspended' });
      const absent: string[] = [];
      manager.on('agent-absent', (id: string) => { absent.push(id); });

      retire();

      expect(absent).toEqual([]);
    });
  });

  describe('a Command Terminal agent\'s own end (the /exit fast path)', () => {
    it('a SessionEnd stamps the terminal and asks the sweep to look now', () => {
      const session = seedSession({ transient: true });

      sendAgentEvent('session_end');

      expect(typeof session.agentEndSignaledAt).toBe('number');
      expect(requestAgentAbsenceCheck).toHaveBeenCalledWith('session-1');
    });

    it('a SessionStart clears the stamp, as /clear sends both with the agent still running', () => {
      const session = seedSession({ transient: true, startedAt: new Date(Date.now() - 1_000).toISOString() });

      sendAgentEvent('session_end');
      sendAgentEvent('session_start');

      expect(session.agentEndSignaledAt).toBeNull();
      // Back inside the grace: nothing waives it any more.
      expect(isCandidate()).toBe(false);
      // And the fast looks the SessionEnd asked for are withdrawn: each one
      // lists every process on the machine to find a live agent.
      expect(cancelAgentAbsenceCheck).toHaveBeenCalledWith('session-1');
    });

    it('ignores a task session\'s SessionEnd: its row only needs the ordinary sweep', () => {
      const session = seedSession();

      sendAgentEvent('session_end');

      expect(session.agentEndSignaledAt).toBeUndefined();
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('ignores a workflow agent\'s SessionEnd too: it is transient, but no Command Terminal', () => {
      const session = seedSession({ transient: true, workflowId: 'workflow-1', taskId: 'workflow-1' });

      sendAgentEvent('session_end');

      expect(session.agentEndSignaledAt).toBeUndefined();
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('ignores the synthetic SessionEnd a kill emits for a terminal with no live PTY', () => {
      const session = seedSession({ transient: true, pty: null });

      sendAgentEvent('session_end');

      expect(session.agentEndSignaledAt).toBeUndefined();
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
    });

    it('still forwards every event to listeners', () => {
      seedSession({ transient: true });
      const forwarded: string[] = [];
      manager.on('event', (_id: string, event: { type: string }) => { forwarded.push(event.type); });

      sendAgentEvent('session_end');
      sendAgentEvent('prompt');

      expect(forwarded).toEqual(['session_end', 'prompt']);
    });

    it('a first SessionStart stamps the start evidence once, and a /clear keeps it', () => {
      // Fake timers so the clock moves between the two SessionStarts. On real
      // timers both Date.now() reads usually share a millisecond, and a stamp
      // that was overwritten instead of kept would still compare equal.
      vi.useFakeTimers();
      const session = seedSession({ transient: true, startedAt: insideStartBound() });
      expect(isCandidate()).toBe(false);

      sendAgentEvent('session_start');
      const firstStart = session.agentStartObservedAt;

      expect(typeof firstStart).toBe('number');
      expect(isCandidate()).toBe(true);

      vi.advanceTimersByTime(5_000);
      sendAgentEvent('session_end');
      sendAgentEvent('session_start');

      expect(session.agentStartObservedAt).toBe(firstStart);
    });

    it('stamps start evidence on a task session too, and the grace still holds it', () => {
      const session = seedSession({ startedAt: new Date(Date.now() - 1_000).toISOString() });

      sendAgentEvent('session_start');

      expect(typeof session.agentStartObservedAt).toBe('number');
      expect(isCandidate()).toBe(false);
    });
  });

  describe('the end settle, where the process tree cannot judge (a WSL shell, or the watcher off)', () => {
    /**
     * Seed a terminal whose agent started and is mature (spawned over a minute
     * ago, so a kill is not deferred for the boot canary). Fake timers go on
     * first: the settle timer and the seeded clock must share them.
     */
    function seedMatureTerminal(overrides: Partial<ManagedSession> = {}): ManagedSession {
      return seedSession({
        transient: true,
        startedAt: new Date(Date.now() - 90_000).toISOString(),
        agentStartObservedAt: Date.now() - 80_000,
        ...overrides,
      });
    }

    /** How many end settle timers are armed (the private map, not the fake clock). */
    function settleTimerCount(): number {
      return (manager as unknown as { agentEndSettleTimers: Map<string, unknown> }).agentEndSettleTimers.size;
    }

    function recordEnd(): { removed: string[]; absent: string[] } {
      const removed: string[] = [];
      const absent: string[] = [];
      manager.on('session-removed', (id: string) => { removed.push(id); });
      manager.on('agent-absent', (id: string) => { absent.push(id); });
      return { removed, absent };
    }

    it('ends a WSL terminal when no SessionStart follows its agent\'s SessionEnd within the settle', () => {
      vi.useFakeTimers();
      seedMatureTerminal({ shell: 'wsl -d Ubuntu' });
      const { removed, absent } = recordEnd();
      const killSpy = vi.spyOn(manager, 'kill');

      sendAgentEvent('session_end');
      // The sweep never judges a WSL shell, so it is not asked to look.
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
      vi.advanceTimersByTime(END_SETTLE_MS - 1);
      expect(removed).toEqual([]);

      vi.advanceTimersByTime(1);

      expect(absent).toEqual(['session-1']);
      expect(removed).toEqual(['session-1']);
      expect(manager.getSession('session-1')).toBeUndefined();
      // Nothing saw the agent's process gone, so kill() decides on its own
      // whether the exit sequence and its grace are owed.
      expect(killSpy).toHaveBeenNthCalledWith(1, 'session-1', undefined);
      expect(killedPtys).toEqual([4242]);
    });

    it('keeps the terminal when a SessionStart lands inside the settle, as a /clear sends', () => {
      vi.useFakeTimers();
      const session = seedMatureTerminal({ shell: 'wsl -d Ubuntu' });
      const { removed } = recordEnd();

      sendAgentEvent('session_end');
      vi.advanceTimersByTime(END_SETTLE_MS / 2);
      sendAgentEvent('session_start');
      vi.advanceTimersByTime(END_SETTLE_MS * 3);

      expect(removed).toEqual([]);
      expect(session.agentEndSignaledAt).toBeNull();
      expect(manager.getSession('session-1')).toBeDefined();
    });

    it('ends a terminal on any shell when the watcher, and so the sweep, is off', () => {
      vi.useFakeTimers();
      sweep.available = false;
      seedMatureTerminal();
      const { removed } = recordEnd();

      sendAgentEvent('session_end');
      vi.advanceTimersByTime(END_SETTLE_MS);

      expect(removed).toEqual(['session-1']);
    });

    it('leaves the end to the process tree wherever the sweep can judge', () => {
      vi.useFakeTimers();
      seedMatureTerminal();
      const { removed } = recordEnd();

      sendAgentEvent('session_end');
      vi.advanceTimersByTime(END_SETTLE_MS * 3);

      expect(requestAgentAbsenceCheck).toHaveBeenCalledWith('session-1');
      expect(removed).toEqual([]);
    });

    it('does nothing when the terminal was stopped during the settle', () => {
      vi.useFakeTimers();
      seedMatureTerminal({ shell: 'wsl -d Ubuntu' });
      const { removed, absent } = recordEnd();

      sendAgentEvent('session_end');
      expect(settleTimerCount()).toBe(1);
      manager.endCommandTerminal('session-1');
      // The removal itself cancels the settle. The private map is read instead
      // of the fake clock's timer count because endCommandTerminal's awaitExit
      // arms a safety timeout of its own.
      expect(settleTimerCount()).toBe(0);
      vi.advanceTimersByTime(END_SETTLE_MS);

      // The Stop's own removal, and no second end.
      expect(removed).toEqual(['session-1']);
      expect(absent).toEqual([]);
    });

    it('restarts the settle on a second SessionEnd, so the latest one decides when the terminal ends', () => {
      vi.useFakeTimers();
      seedMatureTerminal({ shell: 'wsl -d Ubuntu' });
      const { removed } = recordEnd();

      sendAgentEvent('session_end');
      vi.advanceTimersByTime(3_000);
      sendAgentEvent('session_end');
      // 5.5 s after the first SessionEnd: its timer would have run out by now.
      vi.advanceTimersByTime(2_500);
      expect(removed).toEqual([]);
      expect(settleTimerCount()).toBe(1);

      // 5 s after the second.
      vi.advanceTimersByTime(2_500);
      expect(removed).toEqual(['session-1']);
    });

    it('cancels a pending settle when the manager is disposed', () => {
      vi.useFakeTimers();
      seedMatureTerminal({ shell: 'wsl -d Ubuntu' });
      const { removed, absent } = recordEnd();

      sendAgentEvent('session_end');
      expect(settleTimerCount()).toBe(1);
      manager.dispose();
      expect(settleTimerCount()).toBe(0);
      vi.advanceTimersByTime(END_SETTLE_MS * 2);

      // dispose() never touches the registry, and the settle must not end a
      // terminal in the middle of a quit.
      expect(absent).toEqual([]);
      expect(removed).toEqual([]);
      expect(manager.getSession('session-1')).toBeDefined();
    });

    it.each(['wsl', 'wsl.exe'])('ends a terminal on a bare %s shell through the settle, as the sweep cannot judge it', (shell) => {
      vi.useFakeTimers();
      seedMatureTerminal({ shell });
      const { removed } = recordEnd();

      sendAgentEvent('session_end');
      expect(requestAgentAbsenceCheck).not.toHaveBeenCalled();
      vi.advanceTimersByTime(END_SETTLE_MS);

      expect(removed).toEqual(['session-1']);
    });

    it('does nothing when the terminal stopped running during the settle', () => {
      vi.useFakeTimers();
      const session = seedMatureTerminal({ shell: 'wsl -d Ubuntu' });
      const { removed } = recordEnd();

      sendAgentEvent('session_end');
      session.status = 'suspended';
      vi.advanceTimersByTime(END_SETTLE_MS);

      expect(removed).toEqual([]);
    });

    it('arms nothing for a task session\'s SessionEnd', () => {
      vi.useFakeTimers();
      seedSession({ shell: 'wsl -d Ubuntu', startedAt: new Date(Date.now() - 90_000).toISOString() });
      const { removed } = recordEnd();

      sendAgentEvent('session_end');
      vi.advanceTimersByTime(END_SETTLE_MS * 3);

      expect(removed).toEqual([]);
      expect(manager.getSession('session-1')).toBeDefined();
    });
  });
});
