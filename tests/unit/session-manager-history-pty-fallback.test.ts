/**
 * Wiring test for SessionManager's two `sessionHistory.suppressesPtyFallback`
 * sites (task #859).
 *
 * A `hooks_and_pty` agent keeps the PTY tracker as its fallback until a
 * structured source proves it flows. A session history file normally is that
 * proof (Kimi's wire.jsonl carries the agent's turns), but Codex's rollout
 * carries only part of the picture beside hooks that may never fire, so it
 * opts out with `suppressesPtyFallback: false` and the tracker must survive it.
 * SessionManager reads the flag in two places, both built when it constructs
 * its `SessionHistoryReader`:
 *
 *   onEvents:         ingestEvents(id, events, { suppressesPtyTracker: <flag !== false> })
 *   onFirstTelemetry: suppressPty(id) only for hooks_and_pty AND flag !== false
 *
 * session-telemetry-activity-decisions.test.ts pins what the telemetry does
 * with the option, and kimi-wire-telemetry.test.ts re-implements the
 * `onFirstTelemetry` gate by hand. Nothing else crosses SessionManager's own
 * lines, so a flipped condition there would pass both.
 *
 * Structure: build the real SessionManager (real SessionTelemetry), wrap
 * `SessionHistoryReader` only to capture the callbacks object SessionManager
 * hands it, seed a registry row carrying the adapter under test, and drive the
 * captured callbacks the way the reader does after a parse.
 *
 * Red-green: in session-manager.ts, replace the `onEvents` option with
 * `suppressesPtyTracker: true` and the "no suppression" cases go red; drop
 * `&& this.historySuppressesPtyFallback(sessionId)` from `onFirstTelemetry`
 * and the opt-out case goes red.
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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// Keep the real reader (SessionManager's other paths still construct and use it)
// and record the callbacks object it is built with.
let capturedHistoryCallbacks: SessionHistoryReaderCallbacks | null = null;

vi.mock('../../src/main/pty/readers/session-history-reader', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/pty/readers/session-history-reader')>();
  class CapturingSessionHistoryReader extends original.SessionHistoryReader {
    constructor(callbacks: SessionHistoryReaderCallbacks) {
      super(callbacks);
      capturedHistoryCallbacks = callbacks;
    }
  }
  return { ...original, SessionHistoryReader: CapturingSessionHistoryReader };
});

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { SessionHistoryReaderCallbacks } from '../../src/main/pty/readers/session-history-reader';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { AgentParser, SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'session-1';
/** Longer than the PTY tracker's 3s silence threshold, shorter than every watchdog below. */
const PAST_PTY_SILENCE_MS = 5_000;

/**
 * The slice of an adapter SessionManager and the telemetry read for these
 * decisions: the activity kind and the history file's opt-out flag.
 */
function makeParser(
  activityKind: 'hooks_and_pty' | 'pty',
  suppressesPtyFallback: boolean | undefined,
): AgentParser {
  return {
    runtime: {
      activity: { kind: activityKind },
      reportsTurnEnd: false,
      sessionHistory: { suppressesPtyFallback },
    },
  } as unknown as AgentParser;
}

describe('SessionManager session-history PTY fallback gate', () => {
  let manager: SessionManager;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    // Faked before the manager exists so every timer it and its telemetry create is fake.
    vi.useFakeTimers();
    capturedHistoryCallbacks = null;
    manager = new SessionManager({
      activityEngineOptions: {
        idleStabilityWindowMs: 0,
        staleThinkingTimeoutMs: 600_000,
        staleAfterHeartbeatForcedMs: 600_000,
        bgShellEscapeHatchMs: 600_000,
      },
    });
    telemetry = (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Seed a running registry row carrying `parser`, and start the telemetry's
   * tracking for it. spawn() needs a real PTY, and the adapter on the row is
   * exactly what these cases vary.
   */
  function seedSession(parser: AgentParser): void {
    const registry = (manager as unknown as {
      registry: { set(id: string, session: ManagedSession): void };
    }).registry;
    registry.set(SESSION_ID, {
      id: SESSION_ID,
      taskId: 'task-1',
      projectId: 'project-1',
      pty: null,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/project-cwd',
      commandCwd: '/mock/project-cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: [],
      agentParser: parser,
    });
    telemetry.initSession(SESSION_ID, parser);
  }

  function historyCallbacks(): SessionHistoryReaderCallbacks {
    if (!capturedHistoryCallbacks) throw new Error('SessionManager did not build a SessionHistoryReader');
    return capturedHistoryCallbacks;
  }

  const promptEvent: SessionEvent = { ts: 1, type: EventType.Prompt };

  describe('for a hooks_and_pty adapter whose history file opts out (Codex rollout)', () => {
    beforeEach(() => {
      seedSession(makeParser('hooks_and_pty', false));
    });

    it('ingests history events without letting them suppress the PTY tracker', () => {
      const ingestSpy = vi.spyOn(telemetry, 'ingestEvents');

      historyCallbacks().onEvents(SESSION_ID, [promptEvent]);

      expect(ingestSpy).toHaveBeenCalledTimes(1);
      expect(ingestSpy).toHaveBeenCalledWith(SESSION_ID, [promptEvent], { suppressesPtyTracker: false });
    });

    it('does not suppress the PTY tracker on the first history read', () => {
      const suppressSpy = vi.spyOn(telemetry, 'suppressPty');

      historyCallbacks().onFirstTelemetry(SESSION_ID);

      expect(suppressSpy).not.toHaveBeenCalled();
    });

    it('still reads PTY silence as idle after a prompt event and the first read', () => {
      historyCallbacks().onEvents(SESSION_ID, [promptEvent]);
      historyCallbacks().onFirstTelemetry(SESSION_ID);
      expect(telemetry.getActivityCache()[SESSION_ID]).toBe('thinking');

      telemetry.notifyPtyData(SESSION_ID);
      vi.advanceTimersByTime(PAST_PTY_SILENCE_MS);

      expect(telemetry.getActivityCache()[SESSION_ID]).toBe('idle');
    });
  });

  // The flag omitted is the default for a file that carries the agent's turns
  // (Kimi's wire.jsonl), and `true` says the same thing out loud.
  describe.each([
    { label: 'omits the flag', flag: undefined },
    { label: 'sets the flag to true', flag: true },
  ])('for a hooks_and_pty adapter whose history file $label', ({ flag }) => {
    beforeEach(() => {
      seedSession(makeParser('hooks_and_pty', flag));
    });

    it('ingests history events so they suppress the PTY tracker', () => {
      const ingestSpy = vi.spyOn(telemetry, 'ingestEvents');

      historyCallbacks().onEvents(SESSION_ID, [promptEvent]);

      expect(ingestSpy).toHaveBeenCalledWith(SESSION_ID, [promptEvent], { suppressesPtyTracker: true });
    });

    it('suppresses the PTY tracker on the first history read', () => {
      const suppressSpy = vi.spyOn(telemetry, 'suppressPty');

      historyCallbacks().onFirstTelemetry(SESSION_ID);

      expect(suppressSpy).toHaveBeenCalledTimes(1);
      expect(suppressSpy).toHaveBeenCalledWith(SESSION_ID);
    });

    it('stops reading PTY silence as idle once a prompt event and the first read land', () => {
      historyCallbacks().onEvents(SESSION_ID, [promptEvent]);
      historyCallbacks().onFirstTelemetry(SESSION_ID);

      telemetry.notifyPtyData(SESSION_ID);
      vi.advanceTimersByTime(PAST_PTY_SILENCE_MS);

      // The structured source owns activity now, so silence says nothing.
      expect(telemetry.getActivityCache()[SESSION_ID]).toBe('thinking');
    });
  });

  // A pure PTY adapter's history file supplies usage, not real-time activity,
  // so its silence timer must keep running whatever the flag says.
  it('never suppresses the PTY tracker on the first read of a pure pty adapter', () => {
    seedSession(makeParser('pty', undefined));
    const suppressSpy = vi.spyOn(telemetry, 'suppressPty');

    historyCallbacks().onFirstTelemetry(SESSION_ID);

    expect(suppressSpy).not.toHaveBeenCalled();
  });
});
