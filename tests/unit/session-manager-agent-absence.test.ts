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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// Capture the callbacks object SessionManager hands to `new SessionTelemetry(...)`.
// The stub carries only what the paths under test reach: a Command Terminal's
// end goes through remove(), which clears the session's telemetry, and its
// SessionEnd asks for an absence check.
let capturedCallbacks: {
  isAgentAbsenceCandidate?: (sessionId: string) => boolean;
  retireAgentlessSession?: (sessionId: string) => void;
  onEvent?: (sessionId: string, event: { ts: number; type: string; detail?: string }) => void;
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
import type { ManagedSession } from '../../src/main/pty/session-registry';

/** Mirrors AGENT_SPAWN_GRACE_MS in session-manager.ts (module-private). */
const SPAWN_GRACE_MS = 30_000;
/** Mirrors COMMAND_TERMINAL_AGENT_START_CEILING_MS in session-manager.ts. */
const START_CEILING_MS = 120_000;
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

  /** A fake IPty: only `pid` and `kill` are reached by kill(). */
  function fakePty(pid: number): ManagedSession['pty'] {
    return {
      pid,
      kill: () => { killedPtys.push(pid); },
    } as unknown as ManagedSession['pty'];
  }

  /**
   * Seed a ManagedSession directly into the private registry. spawn() cannot be
   * used: it needs a real PTY, and the fields under test (transient,
   * agentParser, startedAt) are exactly what a fixture must vary.
   *
   * The defaults describe a healthy, judgeable task agent: running, non-transient,
   * with an adapter, a live PTY, and well past its spawn grace.
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
      startedAt: new Date(Date.now() - (SPAWN_GRACE_MS + 5_000)).toISOString(),
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

  describe('isAgentAbsenceCandidate', () => {
    it('accepts a running, non-transient task agent past its spawn grace', () => {
      seedSession();
      expect(isCandidate()).toBe(true);
    });

    it('ACCEPTS a transient Command Terminal past its spawn grace once its agent started: C2 ends it when that agent exits', () => {
      // A Command Terminal types the project's agent CLI into its shell, the
      // same shape as a task session, so an empty tree means its agent is gone
      // and only a bare shell is left.
      seedSession({ transient: true, agentStartObservedAt: Date.now() - 20_000 });
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
      seedSession({ transient: true });
      expect(isCandidate()).toBe(false);
    });

    it('takes the agent\'s first alt-screen entry as evidence it started, which no shell emits', () => {
      seedSession({ transient: true, altScreenEnteredAt: Date.now() - 20_000 });
      expect(isCandidate()).toBe(true);
    });

    it('judges a Command Terminal with no evidence once the start ceiling has passed', () => {
      // A launch that failed (the CLI missing) and a PTY-only adapter both
      // report nothing; without the ceiling either would stay a bare shell.
      seedSession({ transient: true, startedAt: new Date(Date.now() - (START_CEILING_MS + 1)).toISOString() });
      expect(isCandidate()).toBe(true);
    });

    it('still refuses a Command Terminal with no evidence just short of the start ceiling', () => {
      // The lower side of the ceiling: START_CEILING_MS is hand-mirrored in this
      // file, so a test that only checks past it cannot notice the real ceiling
      // being lowered. The 1 s margin keeps real timers from flaking the check.
      seedSession({ transient: true, startedAt: new Date(Date.now() - (START_CEILING_MS - 1_000)).toISOString() });
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

    it('accepts once the grace has elapsed', () => {
      seedSession({
        startedAt: new Date(Date.now() - (SPAWN_GRACE_MS + 1)).toISOString(),
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
      const session = seedSession({ transient: true });
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

    it('never stamps start evidence on a task session', () => {
      const session = seedSession();

      sendAgentEvent('session_start');

      expect(session.agentStartObservedAt).toBeUndefined();
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
