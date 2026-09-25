/**
 * Executing unit tests for startHardShutdownFailsafe (src/main/shutdown.ts).
 *
 * tests/unit/before-quit-drain-wiring.test.ts pins that src/main/index.ts contains the literal
 * source text `startHardShutdownFailsafe(() => recordRunExit('failsafe'))`, but it is a
 * static source-text scan by design (see that file's own header) - it never imports
 * startHardShutdownFailsafe, never trips the timer, and never checks that the callback ran.
 * This file drives the real function on fake timers instead, so a deleted or throwing
 * `onFired?.()` call inside startHardShutdownFailsafe would actually fail a test.
 *
 * Importing anything from shutdown.ts evaluates its whole module graph, which reaches
 * better-sqlite3 (src/main/db/database.ts) at module scope. The mocks below are the same
 * set shutdown-history-wiring.test.ts uses to load that graph safely under vitest; this file
 * never calls syncShutdownCleanup, so it does not need to assert through them.
 *
 * process.platform is pinned to 'linux' for every test (Object.defineProperty, restored in
 * afterEach) rather than left to the host OS, per .claude/rules/cross-platform-parity.md: this
 * suite must behave identically on a Windows dev machine and CI's Linux runner. That routes
 * every test through the process.kill(-pid, 'SIGKILL') branch, which is mocked below; process.exit
 * is mocked on both branches, so it doubles as the platform-independent "the kill proceeded"
 * signal regardless of which branch a given test takes.
 *
 * Tier: Unit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (must appear before any import of the modules they mock)
// ---------------------------------------------------------------------------

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeAll: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => null);
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    updateStatus = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    update = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    recordSessionUsage = vi.fn();
    updateGitStats = vi.fn();
  },
}));

vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyAllLanes: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks)
// ---------------------------------------------------------------------------

import { startHardShutdownFailsafe } from '../../src/main/shutdown';

// The failsafe deadline (HARD_SHUTDOWN_DEADLINE_MS in shutdown.ts) is not exported, and this
// suite intentionally does not pin its exact value - that is a separate concern from what this
// file covers. Advancing well past any deadline in that neighborhood is enough to prove the
// timer trips and the callback fires; it does not claim to prove the deadline is exactly 6000ms.
const FAILSAFE_ADVANCE_MS = 20_000;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('startHardShutdownFailsafe', () => {
  const originalPlatform = process.platform;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let processKillSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setPlatform('linux');
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform(originalPlatform);
    processExitSpy.mockRestore();
    processKillSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('fires the onFired callback once the failsafe timer trips', () => {
    const onFired = vi.fn();

    startHardShutdownFailsafe(onFired);
    expect(onFired).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FAILSAFE_ADVANCE_MS);

    expect(onFired).toHaveBeenCalledTimes(1);
  });

  it('runs onFired BEFORE the kill, so the exit record lands before the process dies', () => {
    const callOrder: string[] = [];
    const onFired = vi.fn(() => {
      callOrder.push('onFired');
    });
    processExitSpy.mockImplementation(() => {
      callOrder.push('processExit');
      return undefined as never;
    });

    startHardShutdownFailsafe(onFired);
    vi.advanceTimersByTime(FAILSAFE_ADVANCE_MS);

    expect(callOrder).toEqual(['onFired', 'processExit']);
  });

  it('still proceeds to kill the process when onFired throws, with nothing escaping', () => {
    const onFired = vi.fn(() => {
      throw new Error('recordRunExit failed');
    });

    startHardShutdownFailsafe(onFired);

    expect(() => {
      vi.advanceTimersByTime(FAILSAFE_ADVANCE_MS);
    }).not.toThrow();

    expect(onFired).toHaveBeenCalledTimes(1);
    expect(processKillSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('does not throw when called with no callback at all', () => {
    expect(() => {
      startHardShutdownFailsafe();
    }).not.toThrow();

    expect(() => {
      vi.advanceTimersByTime(FAILSAFE_ADVANCE_MS);
    }).not.toThrow();

    // The kill still proceeds with no callback to run - it was never conditional on one.
    expect(processExitSpy).toHaveBeenCalledTimes(1);
  });
});
