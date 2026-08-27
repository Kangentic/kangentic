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
 * probe; neither suite sees the other's half, so a bug in this resolution -
 * most importantly a MISSING transient exclusion, which would retire every
 * Command Terminal the moment it opened - would otherwise slip through both.
 *
 * The structure mirrors `session-manager-report-terminated-shells.test.ts`:
 * capture the callbacks object SessionManager hands to `new SessionTelemetry`
 * and drive it directly against a hand-seeded registry entry, so no real PTY,
 * OS probe, or spawn is needed.
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
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// Capture the callbacks object SessionManager hands to `new SessionTelemetry(...)`.
// A minimal capturing stub is sufficient: no test here calls a SessionManager
// method that reaches into `this.telemetry`.
let capturedCallbacks: {
  isAgentAbsenceCandidate?: (sessionId: string) => boolean;
  retireAgentlessSession?: (sessionId: string) => void;
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

/** Mirrors AGENT_SPAWN_GRACE_MS in session-manager.ts (module-private). */
const SPAWN_GRACE_MS = 30_000;

describe('SessionManager agent-absence wiring', () => {
  let manager: SessionManager;
  let killedPtys: number[];

  beforeEach(() => {
    capturedCallbacks = null;
    killedPtys = [];
    manager = new SessionManager();
  });

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

    it('REFUSES a transient Command Terminal, which is a bare shell by design', () => {
      // The highest-cost false positive in the design: a Command Terminal is
      // registered with the watcher exactly like a task agent and legitimately
      // has nothing under it, so without this arm the sweep would kill every one
      // of them the moment it opened.
      seedSession({ transient: true });
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
      for (const shell of ['wsl -d Ubuntu', 'wsl.exe -d Ubuntu', 'WSL -d Debian'] as const) {
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

    it('never kills a transient Command Terminal', () => {
      const session = seedSession({ transient: true });

      retire();

      expect(session.overrideExitCode).toBeUndefined();
      expect(killedPtys).toEqual([]);
      expect(session.pty).not.toBeNull();
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
      seedSession({ transient: true });
      const changed: string[] = [];
      manager.on('session-changed', (id: string) => { changed.push(id); });

      retire();

      expect(changed).toEqual([]);
    });
  });
});
